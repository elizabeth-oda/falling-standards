import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AUDIO_UPLOAD_LIMIT_BYTES, TRANSCRIPTION_DEADLINE_MS, VoiceRequestSchema, type RaceEventVoiceEvent, type SafetyDrillVoiceEvent, type VoiceEvent } from '@sky/shared';
import { PipelineFailure, safePipelineError } from '../generation/pipeline-errors.js';
import { isLocalOrigin } from '../generation/local-origin.js';
import type { CreationPipeline } from '../generation/pipeline.js';
import { validateAudio, type AudioClip } from './transcription.js';

async function readRecording(request:FastifyRequest) {
  let audio:AudioClip|undefined, metadata:unknown;
  if (!request.isMultipart()) throw new PipelineFailure('INVALID_AUDIO','Upload one audio recording and its options as multipart form data.');
  try {
    for await (const part of request.parts()) {
      if (part.type==='file') {
        if (part.fieldname!=='audio' || audio) throw new PipelineFailure('INVALID_AUDIO','Exactly one audio recording is required.');
        audio={bytes:await part.toBuffer(),mimeType:part.mimetype.split(';')[0]};
      } else {
        if (part.fieldname!=='options' || metadata!==undefined || part.valueTruncated || typeof part.value!=='string') throw new PipelineFailure('INVALID_REQUEST','Invalid voice request options.');
        metadata=JSON.parse(part.value);
      }
    }
  } catch (error) {
    if (error instanceof PipelineFailure) throw error;
    throw new PipelineFailure('INVALID_AUDIO','Invalid or oversized audio upload. Use one recording up to 1 MiB.');
  }
  const parsed=VoiceRequestSchema.safeParse(metadata);
  if (!parsed.success) throw new PipelineFailure('INVALID_REQUEST','Invalid voice request options.');
  if (!audio) throw new PipelineFailure('INVALID_AUDIO','An audio recording is required.');
  validateAudio(audio);
  return {audio,options:parsed.data};
}
export function registerVoiceRoutes(app:FastifyInstance,pipeline:CreationPipeline,allowedOrigin = isLocalOrigin) {
  app.register(async scope=>{
    await scope.register(multipart,{limits:{files:1,fields:1,parts:2,fieldSize:4096,fileSize:AUDIO_UPLOAD_LIMIT_BYTES,fieldNameSize:32}});
    const routes=[
      {path:'/api/voice/transcriptions',mode:'transcribe'},
      {path:'/api/voice/creations',mode:'legacy'},
      {path:'/api/voice/events',mode:'event'},
      {path:'/api/voice/drills',mode:'drill'},
    ] as const;
    for (const {path,mode} of routes) {
      const transcribeOnly=mode==='transcribe';
      scope.post(path,async(request,reply)=>{
        const started=performance.now(),controller=new AbortController();
        const disconnect=()=>{if (!reply.raw.writableEnded) controller.abort();};
        reply.raw.on('close',disconnect);
        request.raw.on('error',disconnect);
        // A stalled upload must not retain memory or open a provider request.
        const uploadTimer=setTimeout(()=>{controller.abort();request.raw.destroy();},TRANSCRIPTION_DEADLINE_MS);
        try {
          const {audio,options}=await readRecording(request);
          clearTimeout(uploadTimer);
          controller.signal.throwIfAborted();
          const transcriptionBudgetMs=TRANSCRIPTION_DEADLINE_MS-(performance.now()-started);
          if (transcriptionBudgetMs<=0) throw new PipelineFailure('TRANSCRIPTION_TIMEOUT','Audio upload exceeded the transcription budget.');
          const profile=pipeline.profiles.find(item=>item.id===options.profileId);
          if (!profile) throw new PipelineFailure('INVALID_REQUEST','Unknown pipeline profile.');
          if (profile.mode==='live' && !allowedOrigin(request.headers.origin)) return reply.code(403).send({error:{code:'INVALID_REQUEST',message:'Paid requests must originate from the configured game site.'}});
          if (profile.mode==='live' && !pipeline.liveEnabled) throw new PipelineFailure('LIVE_DISABLED','Paid generation is disabled. Start bun run dev:live to opt in.');
          if (profile.mode==='live' && !options.paidAttempt) throw new PipelineFailure('CONSENT_REQUIRED','Paid attempt metadata is required before submitting speech.');
          if (transcribeOnly) {
            const {result}=await pipeline.runVoice(audio,options,{signal:controller.signal,transcribeOnly:true,transcriptionBudgetMs});
            return reply.header('Cache-Control','no-store').send(result);
          }
          reply.hijack();
          reply.raw.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
          const emit=(event:VoiceEvent|RaceEventVoiceEvent|SafetyDrillVoiceEvent)=>{if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(JSON.stringify(event)+'\n');};
          try {
            if(mode==='drill')await pipeline.runVoiceDrill(audio,options,{signal:controller.signal,emit,transcriptionBudgetMs});
            else if(mode==='event')await pipeline.runVoiceEvent(audio,options,{signal:controller.signal,emit,transcriptionBudgetMs});
            else await pipeline.runVoice(audio,options,{signal:controller.signal,emit,transcriptionBudgetMs});
          }
          catch {/* The coordinator emitted a terminal failure. */}
          finally {if (!reply.raw.destroyed) reply.raw.end();}
        } catch (error) {
          const safe=safePipelineError(error);
          const status=safe.code==='LIVE_DISABLED' ? 403 : safe.code==='NOT_CONFIGURED' ? 503
            : ['LIVE_BUSY','DUPLICATE_ATTEMPT'].includes(safe.code) ? 409 : safe.code==='LIVE_LIMIT_REACHED' ? 429
            : ['INVALID_AUDIO','INVALID_REQUEST','INVALID_TRANSCRIPT','CONSENT_REQUIRED'].includes(safe.code) ? 400 : 502;
          if (!reply.raw.destroyed && !reply.sent) return reply.code(status).send({error:safe});
        } finally {clearTimeout(uploadTimer);reply.raw.off('close',disconnect);request.raw.off('error',disconnect);}
      });
    }
  });
}
