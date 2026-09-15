import { legacyFormat, eventFormat, drillFormat, type GenerationFormat, type GenerationProgress, type VoiceProgress } from './generation-formats.js';
import { randomUUID } from 'node:crypto';
import { LiveAttempts, type LivePolicy } from './live-attempts.js';
import {
  PIPELINE_DEADLINE_MS, DESIGN_BUDGET_MS, PipelineRequestSchema, type GeneratedCreation, type PipelineEvent, type PipelineProfile,
  type PipelineRequest, type PipelineStage, type StageConfig, type StageMetric,
  VoiceRequestSchema, type VoiceRequest, type VoiceEvent, type TranscriptResult,
  type RaceEventCreation, type RaceEventPipelineEvent, type RaceEventVoiceEvent,
  type SafetyDrillSpec, type SafetyDrillPipelineEvent, type SafetyDrillVoiceEvent,
} from '@sky/shared';
import { GEOMETRY_INSTRUCTIONS, GEOMETRY_JSON_SCHEMA, RECIPE_INSTRUCTIONS, RECIPE_JSON_SCHEMA } from './model-schemas.js';
import { validateVisualOutput } from './visual-output.js';
import { PipelineFailure, safePipelineError } from './pipeline-errors.js';
import { mockTranscriptionProvider, transcribeClip, validateAudio, type AudioClip, type TranscriptionProvider } from '../voice/transcription.js';
import type { StageTransport } from './stage-transport.js';
import { mockContentGuard, screenContent, type ContentGuards } from './content-guard.js';

type GenerationOptions<Event> = {signal?:AbortSignal;emit?:(event:Event)=>void};
type VoiceOptions<Event> = GenerationOptions<Event> & {transcriptionBudgetMs?:number};
export type PipelineOptions = GenerationOptions<PipelineEvent>;
export class CreationPipeline {
  private readonly liveAttempts:LiveAttempts;
  readonly liveEnabled:boolean;
  get admissionGate() {return this.liveAttempts;}
  get liveUsage() {return this.liveAttempts.status;}
  constructor(readonly profiles:PipelineProfile[], private transports:{mock:StageTransport;live?:StageTransport},
    private budgets = {totalMs:PIPELINE_DEADLINE_MS,designMs:DESIGN_BUDGET_MS}, livePolicy?:LivePolicy,
    private speech:{mock:TranscriptionProvider;live?:TranscriptionProvider} = {mock:mockTranscriptionProvider},
    private guards:ContentGuards = {mock:mockContentGuard},admissionGate?:LiveAttempts) {
    this.liveAttempts = admissionGate ?? new LiveAttempts(livePolicy);
    this.liveEnabled = this.liveAttempts.status.enabled;
  }
  get transcriptionStatus() {return {model:this.speech.live?.model ?? 'gpt-transcribe',available:this.liveEnabled && Boolean(this.speech.live)};}
  private profileFor(profileId:string) {
    const profile=this.profiles.find(item=>item.id===profileId);
    if (!profile) throw new PipelineFailure('INVALID_REQUEST','Unknown pipeline profile.');
    if (profile.mode==='live' && !this.liveEnabled) throw new PipelineFailure('LIVE_DISABLED','Paid generation is disabled. Start bun run dev:live to opt in.');
    if (!profile.available) throw new PipelineFailure('NOT_CONFIGURED',profile.unavailableReason ?? 'The provider is not configured.');
    if (!this.transports[profile.mode]) throw new PipelineFailure('NOT_CONFIGURED','The generation provider is not configured.');
    if (!this.guards[profile.mode]) throw new PipelineFailure('NOT_CONFIGURED','Content screening is not configured.');
    return profile;
  }
  private async withAttempt<T>(request:Pick<PipelineRequest,'paidAttempt'>,profile:PipelineProfile,signal:AbortSignal|undefined,work:()=>Promise<T>):Promise<T> {
    if (signal?.aborted) throw new PipelineFailure('CANCELLED','Attempt cancelled.');
    const release=profile.mode==='live' ? this.liveAttempts.acquire(request) : undefined;
    try {return await work();} finally {release?.();}
  }
  run(request:PipelineRequest,options:PipelineOptions={}):Promise<GeneratedCreation> {
    return this.runFormat(request,options,legacyFormat);
  }
  runEvent(request:PipelineRequest,options:GenerationOptions<RaceEventPipelineEvent>={}):Promise<RaceEventCreation> {
    return this.runFormat(request,options,eventFormat);
  }
  runDrill(request:PipelineRequest,options:GenerationOptions<SafetyDrillPipelineEvent>={}):Promise<SafetyDrillSpec> {
    return this.runFormat(request,options,drillFormat);
  }
  private async runFormat<D extends {visualBrief:string},S>(request:PipelineRequest,
    options:GenerationOptions<GenerationProgress<D,S>>,format:GenerationFormat<D,S>):Promise<S> {
    let started=false;
    try {
      const parsed=PipelineRequestSchema.safeParse(request);
      if (!parsed.success) throw new PipelineFailure('INVALID_REQUEST','Use one to ten words and select an available pipeline profile.');
      const profile=this.profileFor(parsed.data.profileId);
      return await this.withAttempt(parsed.data,profile,options.signal,()=>{
        started=true;return this.generateStages(parsed.data,options,format);
      });
    } catch (error) {
      const safe=safePipelineError(error);
      if (!started) options.emit?.({type:'failed',stage:'design',error:safe,elapsedMs:0,metrics:[]});
      throw new PipelineFailure(safe.code,safe.message,safe.provider);
    }
  }
  runVoice(audio:AudioClip,request:VoiceRequest,options:VoiceOptions<VoiceEvent>&{transcribeOnly?:boolean}={}):Promise<{result:TranscriptResult;spec?:GeneratedCreation}> {
    return this.runVoiceFormat(audio,request,options,legacyFormat);
  }
  runVoiceEvent(audio:AudioClip,request:VoiceRequest,options:VoiceOptions<RaceEventVoiceEvent>={}):Promise<{result:TranscriptResult;spec?:RaceEventCreation}> {
    return this.runVoiceFormat(audio,request,options,eventFormat);
  }
  runVoiceDrill(audio:AudioClip,request:VoiceRequest,options:VoiceOptions<SafetyDrillVoiceEvent>={}):Promise<{result:TranscriptResult;spec?:SafetyDrillSpec}> {
    return this.runVoiceFormat(audio,request,options,drillFormat);
  }
  private async runVoiceFormat<D extends {visualBrief:string},S>(audio:AudioClip,request:VoiceRequest,
    options:VoiceOptions<VoiceProgress<D,S>>&{transcribeOnly?:boolean},format:GenerationFormat<D,S>):Promise<{result:TranscriptResult;spec?:S}> {
    const started=performance.now();
    const signal=options.signal ?? new AbortController().signal;
    try {
      const parsed=VoiceRequestSchema.safeParse(request);
      if (!parsed.success) throw new PipelineFailure('INVALID_REQUEST','Invalid voice request metadata.');
      validateAudio(audio);
      const profile=this.profileFor(parsed.data.profileId);
      const provider=this.speech[profile.mode];
      if (!provider) throw new PipelineFailure('NOT_CONFIGURED','Speech transcription is not configured.');
      return await this.withAttempt(parsed.data,profile,signal,async()=>{
        options.emit?.({type:'transcribing'});
        const result=await transcribeClip(provider,audio,signal,profile.mode==='mock' ? parsed.data.mockText : undefined,options.transcriptionBudgetMs);
        signal.throwIfAborted();
        // The standalone transcription tool does not generate an asset. Creation
        // transcripts are held until the generation input guard approves them.
        if (options.transcribeOnly) {
          options.emit?.({type:'transcript',result});
          return {result};
        }
        const spec=await this.generateStages({text:result.text,profileId:profile.id,geometryMode:parsed.data.geometryMode},
          {signal,emit:event=>options.emit?.({type:'generation',event})},format,
          ()=>options.emit?.({type:'transcript',result}));
        signal.throwIfAborted();
        options.emit?.({type:'complete',result,spec,elapsedMs:Math.round(performance.now()-started)});
        return {result,spec};
      });
    } catch (error) {
      const safe=signal.aborted ? {code:'CANCELLED' as const,message:'Attempt cancelled.'} : safePipelineError(error);
      options.emit?.({type:'failed',error:safe,elapsedMs:Math.round(performance.now()-started)});
      throw new PipelineFailure(safe.code,safe.message,safe.provider);
    }
  }
  private async generateStages<D extends {visualBrief:string},S>(request:PipelineRequest,
    options:GenerationOptions<GenerationProgress<D,S>>,format:GenerationFormat<D,S>,onInputApproved?:()=>void):Promise<S> {
    const started = performance.now();
    const elapsed = () => Math.max(0,Math.round(performance.now()-started));
    let stage:PipelineStage = 'design';
    const metrics:StageMetric[] = [];
    const emit = options.emit ?? (() => {});
    const overall = new AbortController();
    const cancel = () => overall.abort(new PipelineFailure('CANCELLED','Attempt cancelled.'));
    options.signal?.addEventListener('abort',cancel,{once:true});
    if (options.signal?.aborted) cancel();
    const deadlineFailure = () => new PipelineFailure('TIMEOUT',
      'The shared '+(this.budgets.totalMs/1000)+'s generation deadline was reached during '+stage+'. '+
      (stage==='geometry' ? 'Design used '+((metrics.find(item=>item.stage==='design')?.durationMs??0)/1000).toFixed(2)+'s; geometry received the remaining time. ' : '')+
      'No automatic retry was made.');
    const totalTimer = setTimeout(() => overall.abort(deadlineFailure()),this.budgets.totalMs);
    const ensureActive = () => {
      if (performance.now()-started >= this.budgets.totalMs && !overall.signal.aborted) overall.abort(deadlineFailure());
      overall.signal.throwIfAborted();
    };
    try {
      const parsedRequest = PipelineRequestSchema.safeParse(request);
      if (!parsedRequest.success) throw new PipelineFailure('INVALID_REQUEST','Use one to ten words and select an available pipeline profile.');
      const geometryMode = parsedRequest.data.geometryMode ?? 'mesh';
      const profile = this.profileFor(parsedRequest.data.profileId);
      const guard = this.guards[profile.mode];
      if (!guard) throw new PipelineFailure('NOT_CONFIGURED','Content screening is not configured.');
      const transport = this.transports[profile.mode];
      if (!transport) throw new PipelineFailure('NOT_CONFIGURED','The live provider is not configured.');
      const call = async (config:StageConfig,instructions:string,input:string,schema:Record<string,unknown>) => {
        ensureActive();
        const currentStage = stage as 'design'|'geometry';
        emit({type:'stage',stage,elapsedMs:elapsed()});
        const controller = new AbortController();
        const forward = () => controller.abort(overall.signal.reason);
        overall.signal.addEventListener('abort',forward,{once:true});
        if (overall.signal.aborted) forward();
        const remaining = this.budgets.totalMs-(performance.now()-started);
        const budget = currentStage === 'design' ? Math.min(this.budgets.designMs,remaining) : remaining;
        const stageDeadlineFailure = () => currentStage==='geometry' ? deadlineFailure()
          : new PipelineFailure('TIMEOUT','Design exceeded its '+(budget/1000).toFixed(2)+'s time budget. No automatic retry was made.');
        const timer = setTimeout(() => controller.abort(stageDeadlineFailure()),Math.max(0,budget));
        let rejectAbort:(reason:unknown)=>void = () => {};
        const abortListener = () => rejectAbort(controller.signal.reason);
        const stageStarted = performance.now();
        try {
          controller.signal.throwIfAborted();
          // Race enforces the deadline even when a test/provider ignores AbortSignal.
          const aborted = new Promise<never>((_,reject) => {rejectAbort=reject;controller.signal.addEventListener('abort',abortListener,{once:true});});
          const response = await Promise.race([transport.run({product:format.kind,stage:currentStage,geometryMode,config,instructions,input,schema,signal:controller.signal}),aborted]);
          ensureActive();
          if (performance.now()-stageStarted >= budget) throw stageDeadlineFailure();
          const metric:StageMetric = {stage:currentStage,model:config.model,durationMs:Math.round(performance.now()-stageStarted),...(response.usage ? {usage:response.usage} : {})};
          metrics.push(metric);
          return {response,metric};
        } catch (error) {
          if (!metrics.some(item => item.stage === currentStage)) metrics.push({stage:currentStage,model:config.model,durationMs:Math.round(performance.now()-stageStarted)});
          throw error;
        } finally {
          clearTimeout(timer); overall.signal.removeEventListener('abort',forward);
          controller.signal.removeEventListener('abort',abortListener);
        }
      };
      ensureActive();
      await screenContent(guard,[parsedRequest.data.text],overall.signal);
      ensureActive();
      onInputApproved?.();
      const designed = await call(profile.design,format.instructions(geometryMode),parsedRequest.data.text,format.schema);
      const design = format.readDesign(designed.response.data);
      if (!design) throw new PipelineFailure('INVALID_DESIGN','Design did not contain a valid visual brief and supported gameplay recipe.');
      await screenContent(guard,format.contentTexts(design),overall.signal);
      ensureActive();
      emit({type:'design',design,metric:designed.metric});
      stage = 'geometry';
      // Deliberately hand off only appearance data, never the effect or original prompt.
      const geometry = await call(profile.geometry,geometryMode === 'primitives' ? RECIPE_INSTRUCTIONS : GEOMETRY_INSTRUCTIONS,design.visualBrief,geometryMode === 'primitives' ? RECIPE_JSON_SCHEMA : GEOMETRY_JSON_SCHEMA);
      emit({type:'geometry',metric:geometry.metric});
      stage = 'validation';
      emit({type:'stage',stage,elapsedMs:elapsed()});
      const appearance = validateVisualOutput(geometry.response.data,geometryMode);
      const spec = format.assemble(randomUUID(),design,appearance);
      ensureActive();
      emit({type:'complete',spec,elapsedMs:elapsed(),metrics});
      return spec;
    } catch (error) {
      const safe = safePipelineError(error);
      emit({type:'failed',stage,error:safe,elapsedMs:elapsed(),metrics});
      throw new PipelineFailure(safe.code,safe.message,safe.provider);
    } finally {
      clearTimeout(totalTimer); options.signal?.removeEventListener('abort',cancel);
    }
  }
}
