import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CreationSpec, GeometryMode, LiveUsage, PipelineEvent, PipelineProfile, PipelineErrorData, TranscriptResult, VoiceEvent, VoiceRequest } from '@sky/shared';
import { PIPELINE_DEADLINE_MS } from '@sky/shared';
import { attemptMetrics, type LabAttempt } from '../generation/lab-history';
import { MicrophoneRecorder } from './recorder';
import { RecorderControls } from './RecorderControls';
import { requestVoice, VoiceRequestError } from './voice-client';

type Attempt={id:number;controller:AbortController;started:number;captureMs:number;profile:PipelineProfile;mode:'create'|'transcribe-only';
  request:Omit<VoiceRequest,'captureMs'>;events:PipelineEvent[];voiceEvents:VoiceEvent[];result?:TranscriptResult;spec?:CreationSpec;error?:PipelineErrorData;transcriptionModel:string;uploading:boolean};
export function VoiceLabPanel({profile,geometryMode,mockText,liveUsage,transcription,onBusy,onComplete,onAttempt,onRefresh,onUseText}:{
  profile?:PipelineProfile;geometryMode:GeometryMode;mockText:string;liveUsage?:LiveUsage;transcription?:{model:string;available:boolean};
  onBusy:(busy:boolean)=>void;onComplete:(spec:CreationSpec)=>void;onAttempt:(attempt:LabAttempt)=>void;onRefresh:()=>void;onUseText:(text:string)=>void;
}) {
  const [recorder]=useState(()=>new MicrophoneRecorder());
  const mic=useSyncExternalStore(recorder.subscribe,recorder.getSnapshot);
  const [mode,setMode]=useState<'create'|'transcribe-only'>('create');
  const [busy,setBusy]=useState(false);
  const [events,setEvents]=useState<PipelineEvent[]>([]);
  const [failure,setFailure]=useState<PipelineErrorData>();
  const [status,setStatus]=useState('Enable your microphone, then hold to speak.');
  const [result,setResult]=useState<TranscriptResult>(),[elapsed,setElapsed]=useState(0),[captureMs,setCaptureMs]=useState(0);
  const active=useRef<Attempt|undefined>(undefined),serial=useRef(0);
  const live=profile?.mode==='live';
  const generationTerminal=events.find(event=>event.type==='complete'||event.type==='failed');
  const paidAvailable=Boolean(liveUsage?.enabled&&!liveUsage.busy&&liveUsage.attemptsRemaining>0&&transcription?.available);
  const canStart=Boolean(profile?.available)&&mic.ready&&(!live||paidAvailable);
  useEffect(()=>()=>{
    serial.current++;
    const attempt=active.current;active.current=undefined;
    attempt?.controller.abort(new Error('Voice page closed.'));recorder.cancel();
  },[recorder]);
  useEffect(()=>{
    if(!busy)return;
    const timer=setInterval(()=>{if(active.current)setElapsed(performance.now()-active.current.started);},100);
    return()=>clearInterval(timer);
  },[busy]);
  const commit=(attempt:Attempt,outcome:LabAttempt['outcome'],message:string)=>{
    if(active.current!==attempt)return;
    active.current=undefined;recorder.cancel();setBusy(false);onBusy(false);setStatus(message);
    const duration=performance.now()-attempt.started;setElapsed(duration);
    onAttempt({id:attempt.id,prompt:attempt.result?.text??(attempt.profile.mode==='mock'?(attempt.request.mockText??'Simulated speech'):'Recorded speech'),
      geometryMode:attempt.request.geometryMode??'primitives',profile:attempt.profile,outcome,message,elapsedMs:duration,
      spec:attempt.spec,events:attempt.events,recognition:'unrated',inputSource:'voice',
      voice:{mode:attempt.mode,captureMs:attempt.captureMs,transcriptionModel:attempt.transcriptionModel,transcription:attempt.result,error:attempt.error,events:attempt.voiceEvents}});
    onRefresh();
  };
  const cancel=(reason='cancelled by you')=>{
    const attempt=active.current;
    if(attempt){
      const message='Voice attempt cancelled: '+reason+'. No retry will run.';
      attempt.controller.abort(new Error(message));commit(attempt,'cancelled',message);
    }
    else recorder.cancel();
  };
  const cancelCapture=(reason:string)=>{
    // Once release starts submission, focus changes must not abort paid work.
    if(active.current&&!active.current.uploading)cancel(reason);
  };
  useEffect(()=>{
    const blur=()=>cancelCapture('browser window lost focus during recording');
    const hidden=()=>{if(document.hidden)cancelCapture('tab hidden during recording');};
    window.addEventListener('blur',blur);document.addEventListener('visibilitychange',hidden);
    return()=>{window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',hidden);};
  });
  const finish=async()=>{
    const attempt=active.current;if(!attempt||attempt.uploading)return;
    attempt.uploading=true;
    try {
      const recording=await recorder.stop();
      if(active.current!==attempt)return;
      attempt.captureMs=recording.captureMs;setCaptureMs(recording.captureMs);setStatus('Transcribing…');
      const response=await requestVoice(recording,attempt.request,attempt.controller.signal,{transcribeOnly:attempt.mode==='transcribe-only',onEvent:event=>{
        if(active.current!==attempt)return;
        attempt.voiceEvents.push(event);
        if(event.type==='transcript'){attempt.result=event.result;setResult(event.result);setStatus('Transcript accepted. Generating…');}
        if(event.type==='generation'){
          attempt.events.push(event.event);setEvents([...attempt.events]);
          if(event.event.type==='stage')setStatus({design:'Designing…',geometry:'Building creation…',validation:'Validating…'}[event.event.stage]);
        }
      }});
      if(active.current!==attempt)return;
      attempt.result=response.result;attempt.spec=response.spec;setResult(response.result);
      if(response.spec)onComplete(response.spec);
      commit(attempt,response.spec?'ready':'transcribed',response.spec?'Ready: one creation, one effect.':'Transcription complete. No asset generation was requested.');
    } catch(error){
      if(active.current===attempt){
        if(error instanceof VoiceRequestError){
          attempt.error=error.detail;setFailure(error.detail);
          if(error.detail.code==='REFUSED')setResult(undefined);
        }
        commit(attempt,attempt.controller.signal.aborted?'cancelled':'failed',error instanceof Error?error.message:'Voice request failed.');
      }
    }
  };
  const start=async()=>{
    if(active.current||!canStart||!profile)return;
    const attempt:Attempt={id:++serial.current,controller:new AbortController(),started:performance.now(),captureMs:0,profile,mode,
      transcriptionModel:live?(transcription?.model??'unavailable'):'mock-transcription',
      request:{profileId:profile.id,geometryMode,...(!live?{mockText}:{}),...(live?{paidAttempt:{id:crypto.randomUUID(),confirmed:true as const}}:{})},events:[],voiceEvents:[],uploading:false};
    active.current=attempt;setBusy(true);onBusy(true);setResult(undefined);setEvents([]);setFailure(undefined);setElapsed(0);setCaptureMs(0);setStatus('Preparing microphone…');
    try {
      await recorder.start(()=>{void finish();},error=>commit(attempt,'failed',error.message));
      if(active.current===attempt)setStatus('Recording… release to submit.');
    }
    catch(error){if(active.current===attempt)commit(attempt,'failed',error instanceof Error?error.message:'Could not record.');}
  };
  return <section className="voice-lab">
    <label>Voice test<select className="lab-input" aria-label="Voice test mode" disabled={busy} value={mode} onChange={event=>setMode(event.target.value as typeof mode)}>
      <option value="create">Speak and create</option><option value="transcribe-only">Transcribe only</option>
    </select></label>
    {live?<p>Speech model: {transcription?.model??'Unavailable'}</p>:<div className="voice-mode-notice" role="note">
      <strong>Mock mode · speech recognition is off</strong>
      <p>This attempt uses “{mockText}” as its simulated transcript, regardless of what you say. No AI calls.</p>
      <p>{liveUsage?.enabled?'To recognize your voice, select a live Pipeline profile above.':'To recognize your voice, start bun run dev:live and select a live Pipeline profile.'}</p>
    </div>}
    {live&&<>
      <p>{mode==='create'?'Up to 3 paid API calls: speech, design, geometry.':'One paid speech API call. No generation.'} Failed or cancelled dispatched attempts may incur charges.</p>
      <p>{liveUsage?.attemptsRemaining??0} / {liveUsage?.maxAttempts??3} paid attempts remaining this server start.</p>
    </>}
    <RecorderControls recorder={recorder} mode={live?'live':'mock'} disabled={busy?!['recording','preparing'].includes(mic.phase):!canStart} setupDisabled={busy}
      onStart={()=>{void start();}} onFinish={()=>{void finish();}} onCancel={()=>cancelCapture('recording gesture interrupted')}/>
    {busy&&<button type="button" onClick={()=>cancel()}>Cancel voice attempt</button>}
    <p role="status">{status}</p>
    {failure?.provider&&<p role="note">Model: {failure.provider.model}
      {failure.provider.httpStatus!==undefined&&<> · HTTP {failure.provider.httpStatus}</>}
      {failure.provider.code&&<> · {failure.provider.code}</>}
      {failure.provider.requestId&&<> · Request ID: {failure.provider.requestId}</>}
    </p>}
    {attemptMetrics(events).map(metric=><p key={metric.stage}>{metric.stage}: {(metric.durationMs/1000).toFixed(2)} s · {metric.model}<br/>
      {metric.usage?metric.usage.inputTokens+' input / '+metric.usage.outputTokens+' output tokens'+(metric.usage.reasoningTokens===undefined?'':' ('+metric.usage.reasoningTokens+' reasoning)'):'Token usage unavailable'}</p>)}
    {failure?.code==='TIMEOUT'&&result&&<p role="note">Transcription completed; the timeout was in generation. Try Procedural parts with Sol direct · no reasoning for the next deliberate attempt. Its speed and visual quality still need testing.</p>}
    {generationTerminal&&<p>Generation: {(generationTerminal.elapsedMs/1000).toFixed(2)} s / {PIPELINE_DEADLINE_MS/1000} s shared by design and geometry.</p>}
    <p>Total: {(elapsed/1000).toFixed(1)} s · Capture: {(captureMs/1000).toFixed(1)} s</p>
    {result&&<><p>{result.metric.model==='mock-transcription'?'Simulated transcript':'Heard'}: “{result.text}” · {result.text.split(/\s+/).length}/10 words</p>
      <p>Transcription: {(result.metric.durationMs/1000).toFixed(2)} s · {result.metric.model}</p>
      <button type="button" disabled={busy} onClick={()=>onUseText(result.text)}>Use transcript as typed input</button></>}
    <small>Release submits automatically. Recording: up to 8 s; transcription: up to 10 s; generation: up to 30 s.</small>
  </section>;
}
