import OpenAI, { toFile } from 'openai';
import { setTimeout as delay } from 'node:timers/promises';
import { AUDIO_MIME_TYPES, AUDIO_UPLOAD_LIMIT_BYTES, TRANSCRIPTION_DEADLINE_MS, GenerationRequestSchema, type TranscriptResult } from '@sky/shared';
import { PipelineFailure } from '../generation/pipeline-errors.js';
import { translateProviderError } from '../generation/provider-errors.js';

export type AudioClip = {bytes:Uint8Array;mimeType:string};
export interface TranscriptionProvider {
  model:string;
  transcribe(audio:AudioClip,signal:AbortSignal,mockText?:string):Promise<unknown>;
}
export function validateAudio(audio:AudioClip) {
  if (!audio.bytes.length || audio.bytes.length>AUDIO_UPLOAD_LIMIT_BYTES || !AUDIO_MIME_TYPES.includes(audio.mimeType as typeof AUDIO_MIME_TYPES[number])) {
    throw new PipelineFailure('INVALID_AUDIO','Use one nonempty WebM, MP4, or WAV recording, up to 1 MiB.');
  }
  const b=Buffer.from(audio.bytes);
  const valid=audio.mimeType==='audio/webm' ? b.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))
    : audio.mimeType==='audio/mp4' ? b.subarray(4,8).equals(Buffer.from('ftyp'))
    : b.subarray(0,4).equals(Buffer.from('RIFF')) && b.subarray(8,12).equals(Buffer.from('WAVE'));
  if (!valid) throw new PipelineFailure('INVALID_AUDIO','The recording does not match its audio format.');
}
export const mockTranscriptionProvider:TranscriptionProvider = {
  model:'mock-transcription',
  async transcribe(_audio,signal,mockText) {await delay(250,undefined,{signal});return mockText ?? 'giant rubber duck';},
};
export function openAITranscription(apiKey:string,model='gpt-transcribe',fetchImpl?:typeof fetch):TranscriptionProvider {
  if (!['gpt-transcribe','gpt-4o-mini-transcribe','gpt-4o-transcribe'].includes(model)) throw new Error('TRANSCRIPTION_MODEL must be gpt-transcribe, gpt-4o-mini-transcribe, or gpt-4o-transcribe.');
  const client=new OpenAI({apiKey,baseURL:'https://api.openai.com/v1',logLevel:'off',maxRetries:0,fetch:fetchImpl});
  return {model,async transcribe(audio,signal) {
    const extension=audio.mimeType==='audio/webm' ? 'webm' : audio.mimeType==='audio/mp4' ? 'mp4' : 'wav';
    const file=await toFile(audio.bytes,'recording.'+extension,{type:audio.mimeType});
    const request={file,model,response_format:'json' as const};
    try {
      const response=await client.audio.transcriptions.create(request,{
        signal,maxRetries:0,body:{...request,...(model==='gpt-transcribe' ? {languages:['en']} : {language:'en'})},
      });
      return response.text;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw translateProviderError(error,model);
    }
  }};
}
// Independent from the generation budget. The abort race also covers injected providers.
export async function transcribeClip(provider:TranscriptionProvider,audio:AudioClip,signal:AbortSignal,mockText?:string,budgetMs=TRANSCRIPTION_DEADLINE_MS):Promise<TranscriptResult> {
  const started=performance.now(), controller=new AbortController();
  const cancel=() => controller.abort(signal.reason);
  signal.addEventListener('abort',cancel,{once:true});
  if (signal.aborted) cancel();
  const timeout=() => controller.abort(new PipelineFailure('TRANSCRIPTION_TIMEOUT','Speech transcription exceeded its time budget. No retry was made.'));
  const timer=setTimeout(timeout,budgetMs);
  let rejectAbort:(reason:unknown)=>void=()=>{};
  const abort=()=>rejectAbort(controller.signal.reason);
  try {
    controller.signal.throwIfAborted();
    const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;controller.signal.addEventListener('abort',abort,{once:true});});
    const raw=await Promise.race([provider.transcribe(audio,controller.signal,mockText),aborted]);
    if (performance.now()-started>=budgetMs) timeout();
    controller.signal.throwIfAborted();
    const transcript=GenerationRequestSchema.safeParse({text:raw});
    if (!transcript.success) throw new PipelineFailure('INVALID_TRANSCRIPT','Speech must contain one to ten words, at most 200 characters. Nothing was generated.');
    return {text:transcript.data.text,metric:{model:provider.model,durationMs:Math.round(performance.now()-started)}};
  } finally {
    clearTimeout(timer);signal.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',abort);
  }
}
