import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { safetyDrillFixtures, type VoiceRequest } from '@sky/shared';
import { RaceEventHost } from '../game/race-event-host';
import { RACE_VOICE_ATTEMPTS } from '../game/race-event-config';
import { RaceReportSettings, type RaceReportSettingsProps } from '../game/RaceReportSettings';
import type { PracticeRace } from '../game/practice-race';
import { loadPipelineProfiles } from '../generation/pipeline-client';
import { MicrophoneRecorder } from './recorder';
import { createAudioSafetyDrillClient } from './safety-drill-voice-client';
import { RecorderControls } from './RecorderControls';
import { paidVoiceAvailable, raceVoiceReadiness } from './race-voice-readiness';

type Configuration=Omit<VoiceRequest,'captureMs'>;
export function useRaceVoice(race:PracticeRace) {
  const [recorder]=useState(()=>new MicrophoneRecorder(undefined,undefined,undefined,{retainPreparedStream:true}));
  const [profileId,setSelectedProfileId]=useState('mock'),[mockText,setSelectedMockText]=useState(safetyDrillFixtures[0].prompt);
  const [enabled,setEnabled]=useState(true);
  const [paidAttemptsRemaining,setPaidAttemptsRemaining]=useState(RACE_VOICE_ATTEMPTS),[refresh,setRefresh]=useState(0);
  const paidRemaining=useRef(RACE_VOICE_ATTEMPTS);
  const [profiles,setProfiles]=useState<Awaited<ReturnType<typeof loadPipelineProfiles>>>();
  const [error,setError]=useState('');
  const attempt=useRef<Configuration>({profileId:'mock',geometryMode:'primitives',mockText});
  const [host]=useState(()=>new RaceEventHost(race,recorder,createAudioSafetyDrillClient(()=>attempt.current)));
  const state=useSyncExternalStore(host.loop.subscribe,host.loop.getSnapshot);
  const opportunity=useSyncExternalStore(host.subscribe,host.getSnapshot);
  const microphone=useSyncExternalStore(recorder.subscribe,recorder.getSnapshot);
  const profile=profiles?.profiles.find(item=>item.id===profileId);
  const live=profile?.mode==='live';
  const paidAvailable=paidVoiceAvailable(profiles);
  const getReadiness=()=>{
    const readiness=raceVoiceReadiness({enabled,microphone:recorder.getSnapshot(),profiles,profileId,error});
    const blocked=host.loop.getSnapshot().phase==='prompted'?host.requestBlockedReason():undefined;
    if (blocked) return {ready:false,message:blocked};
    if (readiness.ready && live && paidRemaining.current === 0) return {ready:false,message:'Both voice attempts have been used for this run.'};
    return readiness;
  };
  const setProfileId=(id:string)=>{setSelectedProfileId(id);};
  const setMockText=(text:string)=>{setSelectedMockText(text);};
  useEffect(()=>{
    const controller=new AbortController();
    void loadPipelineProfiles(controller.signal).then(data=>{if(!controller.signal.aborted){setProfiles(data);setError('');}})
      .catch(()=>{if(!controller.signal.aborted){setProfiles(undefined);setError('Cannot connect to voice creation. Refresh availability or play without voice.');}});
    return()=>controller.abort();
  },[refresh]);
  useEffect(()=>{host.reset();return()=>host.dispose();},[host]);
  useEffect(()=>{if(['ready','spawned','failed','ended'].includes(state.phase))setRefresh(value=>value+1);},[state.phase]);
  const start=()=>{
    if (host.loop.getSnapshot().phase!=='prompted'||!getReadiness().ready) return;
    attempt.current={profileId,geometryMode:'primitives',...(!live?{mockText}:{}),...(live?{paidAttempt:{id:crypto.randomUUID(),confirmed:true as const}}:{})};
    if(live){paidRemaining.current--;setPaidAttemptsRemaining(paidRemaining.current);}
    host.loop.startRecording();
  };
  const reset=()=>{setEnabled(true);paidRemaining.current=RACE_VOICE_ATTEMPTS;setPaidAttemptsRemaining(RACE_VOICE_ATTEMPTS);attempt.current={profileId:'mock',geometryMode:'primitives',mockText};host.reset();};
  const skipForRun=()=>{
    const prepared=safetyDrillFixtures.find(fixture=>fixture.prompt===mockText)??safetyDrillFixtures[0];
    host.loadPreparedDrill(prepared.spec);setEnabled(false);paidRemaining.current=0;setPaidAttemptsRemaining(0);
  };
  return {host,recorder,microphone,enabled,getReadiness,skipForRun,profileId,setProfileId,mockText,setMockText,paidAttemptsRemaining,profiles,error,profile,live,paidAvailable,state,opportunity,
    start,finish:()=>{void host.loop.finishRecording();},cancel:()=>host.loop.cancelRecording(),reset,refresh:()=>setRefresh(value=>value+1)};
}
export type RaceVoiceController = ReturnType<typeof useRaceVoice>;

export function RaceVoiceControls({voice,paused,...reportSettings}:RaceReportSettingsProps & {voice:RaceVoiceController;paused:boolean}) {
  const configuring=paused&&voice.enabled&&voice.host.race.elapsed===0;
  const active=['preparing','recording','transcribing','generating','ready'].includes(voice.state.phase);
  const canHold=!paused&&(['recording','preparing'].includes(voice.state.phase)||
    (voice.state.phase==='prompted'&&voice.getReadiness().ready));
  return <section className="race-voice">
    <h2>Hazard reporting</h2>
    <p>Collect an Inspection Request (yellow star), then report a hazard in ten words or fewer. Describe what it does, or let the department infer it. Hold Space; release submits. Any racer can start the shared drill. Two yellow stars per run; the second is 60–70% down the course. A slow creation may arrive too late to use before landing.</p>
    <label>Voice profile<select aria-label="Race voice profile" value={voice.profileId} disabled={!configuring} onChange={event=>voice.setProfileId(event.target.value)}>
      {voice.profiles?.profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.label}{profile.available?'':' · unavailable'}</option>)}
    </select></label>
    {!voice.live&&<label>Simulated transcript<select aria-label="Race simulated transcript" disabled={!configuring} value={voice.mockText} onChange={event=>voice.setMockText(event.target.value)}>
      {safetyDrillFixtures.map(({prompt})=><option key={prompt}>{prompt}</option>)}
    </select></label>}
    {voice.live?<p>Live: speech → design → geometry. Up to 2 voice attempts / 6 paid API calls per run.</p>:<div className="voice-mode-notice" role="note">
      <strong>Mock mode · speech recognition is off</strong>
      <p>This attempt uses “{voice.mockText}”, regardless of what you say. No AI calls.</p>
      <p>{voice.profiles?.liveUsage.enabled?'For real speech, select a live Voice profile before starting the race.':'Live speech is unavailable. Choose Mock mode or play without voice.'}{!configuring?' Restart the race to change its profile.':''}</p>
    </div>}
    <RaceReportSettings {...reportSettings} disabled={!configuring}/>
    {voice.profiles&&<p>{voice.profiles.liveUsage.attemptsRemaining} / {voice.profiles.liveUsage.maxAttempts} paid attempts remaining.</p>}
    {voice.error&&<p role="alert">{voice.error}</p>}
    {voice.profile?.unavailableReason&&<p>{voice.profile.unavailableReason}</p>}
    <RecorderControls recorder={voice.recorder} mode={voice.live?'live':'mock'} disabled={!canHold} setupDisabled={!paused||active} onStart={voice.start} onFinish={voice.finish} onCancel={voice.cancel}/>
    <p role="status">Star {voice.host.attemptNumber} / {RACE_VOICE_ATTEMPTS} · {voice.state.message}</p>
    {voice.opportunity.message&&voice.opportunity.message!==voice.state.message&&['offered','collected','missed','discarded'].includes(voice.opportunity.secondStar)&&<p role="status">★ {voice.opportunity.message}</p>}
    {voice.live&&<p>{voice.paidAttemptsRemaining} paid voice attempts allowed for this run.</p>}
    {voice.state.transcript&&<p>{voice.live?'Heard':'Simulated transcript'}: “{voice.state.transcript}”</p>}
    {active&&<button onClick={voice.cancel}>Cancel voice attempt</button>}
    <button onClick={voice.refresh} disabled={active}>Refresh voice profiles</button>
    <small>8 s recording · 10 s transcription · 30 s generation. Pausing cancels an active attempt and a saved second request.</small>
  </section>;
}

/** Device preparation is available before a run and after pausing releases it. */
export function RaceMicrophoneSetup({voice}: {voice: RaceVoiceController}) {
  const {microphone} = voice;
  const preparing = microphone.phase === 'preparing';
  return <div className="race-microphone-check">
      <button disabled={preparing} onClick={() => {void voice.recorder.prepare();}}>
        {preparing ? 'Checking microphone…' : microphone.ready && microphone.phase !== 'error' ? 'Check microphone again' : 'Enable microphone'}
      </button>
      <p role="status">{microphone.message}</p>
      <p className="race-microphone-lifecycle">Your microphone stays open for this run. Recording starts only when you hold Space. Pausing, restarting, leaving, or finishing releases it. Enabling it does not call AI.</p>
    </div>;
}

/** Player-facing setup; model configuration and diagnostics stay in RaceVoiceControls. */
export function RaceVoiceSetup({voice, ...reportSettings}: RaceReportSettingsProps & {voice: RaceVoiceController}) {
  const {microphone} = voice;
  const liveProfile = voice.profiles?.profiles.find(profile => profile.mode === 'live' && profile.available);
  const liveEnabled = Boolean(liveProfile && voice.profiles?.transcription?.available && voice.profiles.liveUsage.enabled);
  const preparing = microphone.phase === 'preparing';
  const availabilityError = voice.error || voice.profile?.unavailableReason;
  const needsRefresh = Boolean(availabilityError || (voice.live && voice.profiles?.liveUsage.busy));
  return <section className="race-voice-setup" aria-label="Hazard reporting setup">
    <div className="race-voice-setup-grid">
      <section className="race-voice-card race-voice-mode-card" aria-labelledby="voice-mode-title">
        <h2 id="voice-mode-title">Choose a hazard mode</h2>
        <label>Creation mode
          <select aria-label="Creation mode" value={voice.live ? 'live' : 'mock'} disabled={preparing} onChange={event => {
            voice.setProfileId(event.target.value === 'live' && liveProfile ? liveProfile.id : 'mock');
          }}>
            <option value="mock">Prepared hazard</option>
            <option value="live" disabled={!liveEnabled}>Live AI{liveEnabled ? '' : ' · unavailable'}</option>
          </select>
        </label>
        {voice.live ? <>
          <p>Describe a hazard and what it does. AI creates its appearance and a shared drill.</p>
          <p className="race-voice-example">Try “Nervous hippos scatter when approached.”</p>
          <p className="race-voice-cost">Live AI uses up to two attempts / six paid API calls per run. Failed or cancelled requests may still cost credits.</p>
          <p>{voice.profiles?.liveUsage.attemptsRemaining ?? 0} paid attempts remaining.</p>
        </> : <>
          <div className="voice-mode-notice" role="note">
            <strong>Speech recognition is off.</strong>
            <p>Uses this prepared hazard, regardless of what you say. No AI calls.</p>
            <p className="race-prepared-prompt">“{voice.mockText}”</p>
          </div>
          <details className="race-voice-details">
            <summary>Change prepared hazard</summary>
            <label>Prepared prompt
              <select aria-label="Prepared prompt" value={voice.mockText} disabled={preparing} onChange={event => voice.setMockText(event.target.value)}>
                {safetyDrillFixtures.map(({prompt}) => <option key={prompt}>{prompt}</option>)}
              </select>
            </label>
          </details>
          {!liveEnabled && <p className="race-voice-availability">Live AI is unavailable for this session.</p>}
        </>}
      </section>
      <section className="race-voice-card race-voice-microphone-card" aria-labelledby="voice-microphone-title">
        <h2 id="voice-microphone-title">Enable your microphone</h2>
        <RaceMicrophoneSetup voice={voice}/>
      </section>
    </div>
    <RaceReportSettings {...reportSettings} disabled={preparing}/>
    {needsRefresh && <div className="race-voice-error">
      {availabilityError && <p role="alert">{availabilityError}</p>}
      <button disabled={preparing} onClick={voice.refresh}>Refresh availability</button>
    </div>}
    <details className="race-voice-details">
      <summary>Voice details</summary>
      <p>Desktop Chrome / Edge · English · 8 seconds of recording maximum.</p>
      <p>Transcription has a 10-second limit; creation has a 30-second limit. Keep racing while your hazard is prepared. A slow creation may arrive too late to use before landing.</p>
      <p>The second yellow star appears 60–70% down the course, whether the first request succeeds or fails. Pausing cancels an active attempt and a saved second request.</p>
      {!needsRefresh && <button disabled={preparing} onClick={voice.refresh}>Refresh availability</button>}
    </details>
  </section>;
}
