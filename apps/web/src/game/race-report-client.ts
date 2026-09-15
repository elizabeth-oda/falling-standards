import { PipelineErrorSchema, RaceReportRequestSchema, RaceReportResponseSchema, RaceReportStatusSchema,
  type RaceReportRequest, type RaceReportResponse } from '@sky/shared';

export type RaceReportClient=(request:RaceReportRequest,signal:AbortSignal)=>Promise<RaceReportResponse>;

/** Bound reads as well as parsed fields, including error bodies. */
async function readJson(response:Response,signal:AbortSignal,limit=8192):Promise<unknown> {
  if(!response.body)throw new Error('The incident report response was empty.');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let size=0,text='';
  try {
    while(true) {
      signal.throwIfAborted();
      const chunk=await reader.read();
      signal.throwIfAborted();
      if(chunk.done)break;
      size+=chunk.value.byteLength;
      if(size>limit)throw new Error('The incident report response was too large.');
      text+=decoder.decode(chunk.value,{stream:true});
    }
    text+=decoder.decode();
    return JSON.parse(text);
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function loadRaceReportStatus(signal:AbortSignal) {
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(5000)]);
  const response=await fetch('/api/race-reports/status',{signal:bounded});
  if(!response.ok)throw new Error('Incident reporting is unavailable.');
  return RaceReportStatusSchema.parse(await readJson(response,bounded));
}
export const requestRaceReport:RaceReportClient=async(request,signal)=>{
  const parsed=RaceReportRequestSchema.parse(request),body=JSON.stringify(parsed);
  if(new TextEncoder().encode(body).byteLength>4096)throw new Error('The incident report request was too large.');
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
  const response=await fetch('/api/race-reports',{method:'POST',headers:{'Content-Type':'application/json'},body,signal:bounded});
  const data=await readJson(response,bounded);
  if(!response.ok) {
    const error=PipelineErrorSchema.safeParse(data&&typeof data==='object'&&'error' in data?data.error:undefined);
    throw new Error(error.success?error.data.message:'Incident reporting is unavailable.');
  }
  bounded.throwIfAborted();
  return RaceReportResponseSchema.parse(data);
};
