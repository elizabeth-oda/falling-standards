import { PIPELINE_DEADLINE_MS, PipelineEventSchema, PipelineErrorSchema, PipelineProfilesSchema, PipelineRequestSchema, type PipelineEvent, type PipelineRequest } from '@sky/shared';
export async function loadPipelineProfiles(signal:AbortSignal) {
  const response = await fetch('/api/lab/profiles',{signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
  if (!response.ok) throw new Error('Could not load pipeline profiles.');
  return PipelineProfilesSchema.parse(await response.json());
}
// Allow five seconds for delivery of the final server event after its deadline.
const CLIENT_DELIVERY_GRACE_MS = 5_000;

export async function runLabPipeline(request:PipelineRequest,signal:AbortSignal,onEvent:(event:PipelineEvent)=>void) {
  const input = PipelineRequestSchema.parse(request);
  const response = await fetch('/api/lab/creations',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),
    signal:AbortSignal.any([signal,AbortSignal.timeout(PIPELINE_DEADLINE_MS + CLIENT_DELIVERY_GRACE_MS)]),
  });
  if (!response.ok) {
    const body:unknown = await response.json().catch(() => undefined);
    const error = PipelineErrorSchema.safeParse(
      body && typeof body === 'object' && 'error' in body ? body.error : undefined,
    );
    throw new Error(error.success ? error.data.message : 'The server rejected the pipeline request.');
  }
  await readEventStream(response,PipelineEventSchema.parse,onEvent,event=>event.type==='complete'||event.type==='failed');
}

export async function readEventStream<T>(response:Response,parse:(data:unknown)=>T,onEvent:(event:T)=>void,isTerminal:(event:T)=>boolean) {
  if (!response.body) throw new Error('Streaming response unavailable.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let buffer = '', terminal = false, totalBytes = 0;
  const consume = (line:string) => {
    if (!line.trim()) return;
    if (terminal) throw new Error('Unexpected data after pipeline completion.');
    const event = parse(JSON.parse(line));
    terminal = isTerminal(event);
    onEvent(event);
  };
  try {
    while (true) {
      const {value,done} = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > 512000) throw new Error('Pipeline response exceeded its size limit.');
      buffer += decoder.decode(value,{stream:true});
      let newline:number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0,newline)); buffer = buffer.slice(newline+1);
      }
    }
    buffer += decoder.decode(); consume(buffer);
    if (!terminal) throw new Error('Connection ended before the pipeline completed.');
  } finally {await reader.cancel().catch(() => {});reader.releaseLock();}
}
