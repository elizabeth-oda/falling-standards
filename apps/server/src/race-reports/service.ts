import {
  RaceReportRequestSchema, RaceReportResponseSchema, RaceReportStatusSchema,
  authoredRaceReport, buildRaceReportEvidence, raceReportInputFingerprint, validateRaceReportContent,
  type RaceReportRequest, type RaceReportResponse, type StageConfig,
} from '@sky/shared';
import { LiveAttempts } from '../generation/live-attempts.js';
import { screenContent, type ContentGuard } from '../generation/content-guard.js';
import { PipelineFailure, safePipelineError } from '../generation/pipeline-errors.js';
import type { RaceReportTransport } from './transport.js';

type Budgets = {totalMs:number;generationMs:number;screeningMs:number};
const defaults:Budgets = {totalMs:12_000,generationMs:7_000,screeningMs:2_500};

/** Own deadlines even when a provider/test adapter ignores AbortSignal. */
async function bounded<T>(work:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal,ms:number):Promise<T> {
  const controller = new AbortController();
  const cancel=()=>controller.abort(signal.reason);
  signal.addEventListener('abort',cancel,{once:true});
  if(signal.aborted)cancel();
  const failure=()=>new PipelineFailure('TIMEOUT','The incident report deadline was reached. No retry was made.');
  const timer=setTimeout(()=>controller.abort(failure()),Math.max(0,ms));
  const started=performance.now();
  let rejectAbort:(reason:unknown)=>void=()=>{};
  const abort=()=>rejectAbort(controller.signal.reason);
  try {
    const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;controller.signal.addEventListener('abort',abort,{once:true});});
    controller.signal.throwIfAborted();
    const result=await Promise.race([work(controller.signal),aborted]);
    controller.signal.throwIfAborted();
    if(performance.now()-started>=ms)throw failure();
    return result;
  } finally {
    clearTimeout(timer);signal.removeEventListener('abort',cancel);
    controller.signal.removeEventListener('abort',abort);
  }
}

/** Reports share creation admission but have their own post-event lifetime. */
export class RaceReportService {
  constructor(readonly admissionGate:LiveAttempts,private config:StageConfig,
    private live?:{transport:RaceReportTransport;guard:ContentGuard},private budgets:Budgets=defaults) {}
  get status() {
    const liveEnabled=this.admissionGate.status.enabled;
    const available=liveEnabled&&Boolean(this.live);
    return RaceReportStatusSchema.parse({liveEnabled,available,liveUsage:this.admissionGate.status,deadlineMs:12_000,
      ...(!available?{unavailableReason:liveEnabled?'The incident report provider is not configured.':'Paid incident reports are disabled.'}:{})});
  }
  async run(value:RaceReportRequest,options:{signal?:AbortSignal}={}):Promise<RaceReportResponse> {
    const parsed=RaceReportRequestSchema.safeParse(value);
    if(!parsed.success||Buffer.byteLength(JSON.stringify(parsed.data),'utf8')>4096)
      throw new PipelineFailure('INVALID_REQUEST','Provide a valid completed-event summary within the report size limit.');
    const request=parsed.data;
    const fingerprint=await raceReportInputFingerprint(request.input);
    if(fingerprint!==request.inputFingerprint)throw new PipelineFailure('INVALID_REQUEST','The incident report input fingerprint did not match.');
    if(options.signal?.aborted)throw new PipelineFailure('CANCELLED','Incident report cancelled.');
    const response=(report:ReturnType<typeof authoredRaceReport>)=>RaceReportResponseSchema.parse({
      runId:request.input.runId,creationId:request.input.creationId,inputFingerprint:fingerprint,
      attemptId:request.paidAttempt?.id??null,report,
    });
    // Mock reports are entirely authored; even supplied live credentials cannot dispatch.
    if(request.mode==='mock')return response(authoredRaceReport(request.input));
    if(!this.admissionGate.status.enabled)throw new PipelineFailure('LIVE_DISABLED','Paid incident reports are disabled.');
    if(!this.live)throw new PipelineFailure('NOT_CONFIGURED','The incident report provider is not configured.');
    const release=this.admissionGate.acquire(request,{runId:request.input.runId,creationId:request.input.creationId});
    const controller=new AbortController();
    const cancel=()=>controller.abort(new PipelineFailure('CANCELLED','Incident report cancelled.'));
    options.signal?.addEventListener('abort',cancel,{once:true});
    if(options.signal?.aborted)cancel();
    const started=performance.now();
    const remaining=()=>this.budgets.totalMs-(performance.now()-started);
    const live=this.live;
    try {
      return await bounded(async signal=>{
        const evidence=buildRaceReportEvidence(request.input);
        await screenContent(live.guard,[request.input.displayName],signal,Math.min(this.budgets.screeningMs,remaining()));
        signal.throwIfAborted();
        const output=await bounded(child=>live.transport.run({input:request.input,evidence,config:{...this.config,maxOutputTokens:1200},signal:child}),
          signal,Math.min(this.budgets.generationMs,remaining()));
        signal.throwIfAborted();
        let report:ReturnType<typeof authoredRaceReport>;
        try {report=validateRaceReportContent(request.input,output);}
        catch {throw new PipelineFailure('INVALID_DESIGN','The incident report contained invalid or unsupported evidence.');}
        await screenContent(live.guard,[report.headline,report.finding],signal,Math.min(this.budgets.screeningMs,remaining()));
        signal.throwIfAborted();
        return response(report);
      },controller.signal,this.budgets.totalMs);
    } catch(error) {
      const safe=controller.signal.aborted?{code:'CANCELLED' as const,message:'Incident report cancelled.'}:safePipelineError(error);
      throw new PipelineFailure(safe.code,safe.message,safe.provider);
    } finally {options.signal?.removeEventListener('abort',cancel);release();}
  }
}
