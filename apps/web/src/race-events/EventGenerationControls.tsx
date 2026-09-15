import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  safetyDrillFixtures, safetyDrillLabel, safetyDrillInstruction, PipelineRequestSchema, type PipelineRequest, type VoiceRequest,
  type SafetyDrillSpec, type SafetyDrillDesign, type SafetyDrillPipelineEvent, type StageMetric,
} from '@sky/shared';
import { loadPipelineProfiles } from '../generation/pipeline-client';
import { MicrophoneRecorder } from '../voice/recorder';
import { RecorderControls } from '../voice/RecorderControls';
import { safetyDrillClient } from './drill-client';
import { RaceEventRequestError } from './encounter-client';

type Attempt={controller:AbortController;request:PipelineRequest;started:number;submitted:boolean};
export function EventGenerationControls({onCreation,onBusy,fixturePrompt}:{onCreation:(spec:SafetyDrillSpec)=>void;onBusy:(busy:boolean)=>void;fixturePrompt:string}) {
  const [profiles,setProfiles]=useState<Awaited<ReturnType<typeof loadPipelineProfiles>>>();
  const [refresh,setRefresh]=useState(0),[profileId,setProfileId]=useState('mock');
  const [text,setText]=useState(fixturePrompt),[source,setSource]=useState<'text'|'voice'>('text');
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState('Load a local fixture, or submit one generation attempt.');
  const [profileError,setProfileError]=useState(''),[transcript,setTranscript]=useState('');
  const [metrics,setMetrics]=useState<StageMetric[]>([]),[elapsed,setElapsed]=useState(0);
  const [design,setDesign]=useState<SafetyDrillDesign>();
  const [recorder]=useState(()=>new MicrophoneRecorder());
  const mic=useSyncExternalStore(recorder.subscribe,recorder.getSnapshot);
  const active=useRef<Attempt|undefined>(undefined);
  const profile=profiles?.profiles.find(item=>item.id===profileId),live=profile?.mode==='live';
  const available=Boolean(profile?.available&&(!live||(profiles?.liveUsage.enabled&&!profiles.liveUsage.busy&&profiles.liveUsage.attemptsRemaining>0))&&
    (source==='text'||(!live||profiles?.transcription?.available)));
  useEffect(()=>{
    const controller=new AbortController();
    void loadPipelineProfiles(controller.signal).then(value=>{if(!controller.signal.aborted){setProfiles(value);setProfileError('');}})
      .catch(()=>{if(!controller.signal.aborted){setProfiles(undefined);setProfileError('Server unavailable. Local fixtures and replay still work.');}});
    return()=>controller.abort();
  },[refresh]);
  useEffect(()=>{setDesign(undefined);},[profileId,text,source]);
  useEffect(()=>{setText(fixturePrompt);setDesign(undefined);},[fixturePrompt]);
  useEffect(()=>()=>{const attempt=active.current;active.current=undefined;attempt?.controller.abort();recorder.cancel();},[recorder]);
  useEffect(()=>{
    if(!busy)return;
    const timer=setInterval(()=>{if(active.current)setElapsed((performance.now()-active.current.started)/1000);},100);
    return()=>clearInterval(timer);
  },[busy]);
  const finish=(attempt:Attempt,message:string,spec?:SafetyDrillSpec)=>{
    if(active.current!==attempt)return;
    active.current=undefined;recorder.cancel();setBusy(false);onBusy(false);setStatus(message);
    setElapsed((performance.now()-attempt.started)/1000);setRefresh(value=>value+1);
    if(spec)onCreation(spec);
  };
  const cancel=()=>{
    const attempt=active.current;
    if(attempt){attempt.controller.abort();finish(attempt,'Attempt cancelled. No automatic retry.');}
    else recorder.cancel();
  };
  useEffect(()=>{
    // Permission dialogs/focus changes may interrupt capture; submitted work may finish in the background.
    const interrupt=()=>{if(active.current&&!active.current.submitted)cancel();};
    const hidden=()=>{if(document.hidden)interrupt();};
    window.addEventListener('blur',interrupt);document.addEventListener('visibilitychange',hidden);
    return()=>{window.removeEventListener('blur',interrupt);document.removeEventListener('visibilitychange',hidden);};
  });
  const progress=(attempt:Attempt,event:SafetyDrillPipelineEvent)=>{
    if(active.current!==attempt)return;
    if(event.type==='stage')setStatus({design:'Planning the reported hazard…',geometry:'Building the object…',validation:'Checking the drill recipe and geometry…'}[event.stage]);
    if(event.type==='design'){setMetrics([event.metric]);setDesign(event.design);}
    if(event.type==='geometry')setMetrics(previous=>[...previous.filter(item=>item.stage!=='geometry'),event.metric]);
    if(event.type==='complete'||event.type==='failed')setMetrics(event.metrics);
  };
  const begin=():Attempt|undefined=>{
    if(active.current||!available)return;
    const parsed=PipelineRequestSchema.safeParse({text:source==='voice'&&live?'recorded speech':text,profileId,geometryMode:'primitives',
      ...(live?{paidAttempt:{id:crypto.randomUUID(),confirmed:true}}:{})});
    if(!parsed.success){setStatus('Use one to ten words, at most 200 characters.');return;}
    const attempt:Attempt={controller:new AbortController(),request:parsed.data,started:performance.now(),submitted:source==='text'};
    active.current=attempt;setBusy(true);onBusy(true);setMetrics([]);setDesign(undefined);setTranscript('');setElapsed(0);return attempt;
  };
  const generate=async()=>{
    const attempt=begin();if(!attempt)return;setStatus('Preparing the safety drill…');
    try {const spec=await safetyDrillClient.generate(attempt.request,attempt.controller.signal,event=>progress(attempt,event));
      finish(attempt,'Drill ready. Run the rehearsal to trigger it.',spec);
    } catch(error){finish(attempt,error instanceof Error?error.message:'Event generation failed.');}
  };
  const release=async()=>{
    const attempt=active.current;if(!attempt||attempt.submitted)return;attempt.submitted=true;
    try {
      const recording=await recorder.stop();if(active.current!==attempt)return;
      setStatus('Transcribing…');
      const request:Omit<VoiceRequest,'captureMs'>={profileId:attempt.request.profileId,geometryMode:'primitives',paidAttempt:attempt.request.paidAttempt,
        ...(!attempt.request.paidAttempt?{mockText:attempt.request.text}:{})};
      const spec=await safetyDrillClient.generateVoice(recording,request,attempt.controller.signal,event=>{
        if(active.current!==attempt)return;
        if(event.type==='transcript')setTranscript(event.result.text);
        if(event.type==='generation')progress(attempt,event.event);
      });
      finish(attempt,'Drill ready. Run the rehearsal to trigger it.',spec);
    } catch(error){
      if(active.current===attempt&&error instanceof RaceEventRequestError&&error.detail.code==='REFUSED')setTranscript('');
      finish(attempt,error instanceof Error?error.message:'Voice event generation failed.');
    }
  };
  const record=async()=>{
    if(!mic.ready)return;const attempt=begin();if(!attempt)return;setStatus('Preparing microphone…');
    try {await recorder.start(()=>{void release();},error=>finish(attempt,error.message));
      if(active.current===attempt)setStatus('Recording… release to submit.');
    } catch(error){finish(attempt,error instanceof Error?error.message:'Could not record.');}
  };
  return <section className="event-generation voice-lab">
    <h2>Report a hazard</h2>
    <label>Input<select className="lab-input" aria-label="Event input source" value={source} disabled={busy} onChange={event=>setSource(event.target.value as typeof source)}>
      <option value="text">Text</option><option value="voice">Voice</option></select></label>
    <label>Pipeline profile<select className="lab-input" aria-label="Event pipeline profile" value={profileId} disabled={busy} onChange={event=>setProfileId(event.target.value)}>
      {profiles?.profiles.map(item=><option key={item.id} value={item.id}>{item.label}{item.available?'':' · unavailable'}</option>)}
    </select></label>
    {profile&&<p>Design: {profile.design.model} / {profile.design.reasoning}<br/>Geometry: {profile.geometry.model} / {profile.geometry.reasoning}</p>}
    {(source==='text'||!live)&&<>
      <label>Example<select className="lab-input" aria-label="Event example" disabled={busy} value={safetyDrillFixtures.some(item=>item.prompt===text)?text:''} onChange={event=>setText(event.target.value)}>
        <option value="" disabled>Custom idea</option>{safetyDrillFixtures.map(item=><option key={item.prompt}>{item.prompt}</option>)}
      </select></label>
      {source==='text'&&<label>Your hazard and behavior · 10 words maximum<input className="lab-input" aria-label="Event prompt" maxLength={200} value={text} disabled={busy} onChange={event=>setText(event.target.value)}/></label>}
    </>}
    {!live&&<p className="voice-mode-notice">Mock mode interprets the supported examples{source==='voice'?' as a simulated transcript, regardless of what you say':''}. No AI calls.</p>}
    {live&&<div className="paid-attempt"><p>Up to {source==='voice'?3:2} paid calls. Failed or cancelled dispatched calls may incur charges. {profiles?.liveUsage.attemptsRemaining} / {profiles?.liveUsage.maxAttempts} attempts remaining.</p>
    </div>}
    {source==='text'?<button className="generate" disabled={busy||!available} onClick={()=>{void generate();}}>{live?'Generate safety drill':'Run mock drill pipeline'}</button>:
      <RecorderControls recorder={recorder} mode={live?'live':'mock'} setupDisabled={busy} disabled={busy?!['preparing','recording'].includes(mic.phase):!available}
        onStart={()=>{void record();}} onFinish={()=>{void release();}} onCancel={()=>{if(!active.current?.submitted)cancel();}}/>}
    {busy&&<button onClick={cancel}>Cancel attempt</button>}
    <p role="status">{status}</p>{transcript&&<p>{live?'Heard':'Simulated transcript'}: “{transcript}”</p>}
    {design&&<p aria-label="Selected drill behavior"><strong>{safetyDrillLabel(design.drill)}</strong><br/>{safetyDrillInstruction(design.drill)}</p>}
    <p>Total: {elapsed.toFixed(1)} s · generation budget: 30 s{source==='voice'?' · separate 10 s transcription budget · 8 s recording maximum':''}</p>
    {metrics.map(metric=><p key={metric.stage}>{metric.stage}: {(metric.durationMs/1000).toFixed(2)} s · {metric.model}<br/>
      {metric.usage?`${metric.usage.inputTokens} input / ${metric.usage.outputTokens} output tokens`:'Token usage unavailable'}</p>)}
    {profileError&&<p role="alert">{profileError}</p>}
    <button disabled={busy} onClick={()=>setRefresh(value=>value+1)}>Refresh profiles</button>
  </section>;
}
