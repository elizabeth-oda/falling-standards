import { RaceAlert, RaceAlertDock, RaceAlertProvider } from './RaceAlerts';
import { LaunchScreen } from '../launch/LaunchScreen';
import { RaceCreations } from './RaceCreations';
import { RaceReportController } from './race-report-controller';
import { loadRaceReportStatus } from './race-report-client';
import type { RaceReportStatus } from '@sky/shared';
import { MusicControls, useGameMusic } from './GameMusic';
import { Preview } from '../pages/CharacterPage';
import { CHARACTERS, DEFAULT_CHARACTER_ANGLE } from './characters';
import type { DinosaurCharacter, GregPose } from './GregModel';
import { raceEventFixtures, safetyDrillFixtures } from '@sky/shared';
import { RaceEventRuntime } from '../race-events/runtime';
import { RACE_CREATION_PICKUP_RADIUS } from './race-event-config';
import { RaceEventReport } from './RaceEventReport';
import { RaceCreationHud } from './RaceCreationVisuals';
import { RaceMicrophoneSetup, RaceVoiceControls, useRaceVoice } from '../voice/RaceVoiceControls';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Canvas } from '@react-three/fiber';
import { PracticeRace } from './practice-race';
import { ITEM_NAMES } from './race-course';
import { RaceScene, defaultBindings, initialRaceHud, type RaceRuntime } from './RaceScene';
import { RaceOverlay } from './RaceOverlay';
import { RaceBriefing, RaceSetup, type RaceSetupStep } from './RaceSetup';
import { BRAKE_SPEED } from './freefall-controller';
import './movement-test.css';
import './race-hud.css';

const defaults = defaultBindings;
type Action = keyof typeof defaults;
const names: Record<Action, string> = {left: 'Left', right: 'Right', forward: 'Forward', backward: 'Back', brake: 'Air brake', look: 'Look up', use: 'Use item', boost:'Boost', dodge:'Dodge'};
type Bindings = typeof defaults;
type Runtime = RaceRuntime;
const label = (code: string) => code.replace(/^Key/, '').replace(/^Digit/, '');
const interactingWithUi = (target: EventTarget | null) => target instanceof HTMLElement &&
  (target.isContentEditable || target.closest('button, a, input, select, textarea, summary, .race-alert-dock') !== null);
const initialHud = initialRaceHud;

export function MovementTest() {
  const [screen,setScreen]=useState<'title'|'selection'|'viewer'|'setup'|'race'|'countdown'>('title');
  const [inspected,setInspected]=useState<DinosaurCharacter>('greg');
  const person=CHARACTERS.find(character=>character.id===inspected)!;
  const employee=String(CHARACTERS.indexOf(person)+1).padStart(3,'0');
  const [countdown,setCountdown]=useState(3);
  const [settings,setSettings]=useState(false);
  const [setupStep,setSetupStep]=useState<RaceSetupStep>('briefing');
  const screenRef=useRef(screen);screenRef.current=screen;
  const settingsRef=useRef(settings);settingsRef.current=settings;
  const [angle,setAngle]=useState(DEFAULT_CHARACTER_ANGLE),[zoom,setZoom]=useState(8);
  const [pose,setPose]=useState<GregPose>('Stand'),[previewPaused,setPreviewPaused]=useState(false),[take,setTake]=useState(0);
  const [race]=useState(()=>new PracticeRace(true,Math.random,new RaceEventRuntime({pickupContactRadius:RACE_CREATION_PICKUP_RADIUS})));
  const voice=useRaceVoice(race);
  const [reportController]=useState(()=>new RaceReportController());
  const incidentReports=useSyncExternalStore(reportController.subscribe,reportController.getSnapshot);
  const [reportConsent,setReportConsent]=useState(false);
  const [reportStatus,setReportStatus]=useState<RaceReportStatus>();
  useEffect(()=>{
    const controller=new AbortController();
    void loadRaceReportStatus(controller.signal).then(status=>{
      if(!controller.signal.aborted)setReportStatus(status);
    }).catch(()=>{if(!controller.signal.aborted)setReportStatus(undefined);});
    return()=>controller.abort();
  },[voice.profiles]);
  useEffect(()=>{setReportConsent(false);},[voice.profileId]);
  useEffect(()=>{
    voice.host.paidReportPending=()=>reportController.liveRequestPending;
    return()=>{voice.host.paidReportPending=undefined;reportController.dispose();};
  },[voice.host,reportController]);
  const reportSettings={reportConsent,onReportConsentChange:setReportConsent,reportLive:!!voice.live,
    reportAvailable:!!reportStatus?.available&&(reportStatus.liveUsage.attemptsRemaining>0)};

  const microphone=voice.microphone;
  const readiness=voice.getReadiness();
  const voiceBlockedReason=readiness.ready?'':readiness.message;
  const voiceBlocked=useRef(voiceBlockedReason);voiceBlocked.current=voiceBlockedReason;
  const [voiceInputNotice,setVoiceInputNotice]=useState({id:0,text:'',phase:''});
  const voiceActions=useRef(voice);voiceActions.current=voice;
  const [runtime] = useState<Runtime>(() => ({race, voice:voice.host, keys: new Set(), paused: true, bindings: {...defaults}, clock: 0, generation: 0, fireRequested: false, dodgeRequested:false}));
  const [paused, setPaused] = useState(true);
  const [fixtureNotice,setFixtureNotice]=useState('');
  const [quickFixture,setQuickFixture]=useState(true);
  const [hud, setHud] = useState(initialHud);
  const music = useGameMusic({
    track: screen==='race' ? (hud.finish!==null ? 'results' : 'race') : screen==='countdown' ? 'race' : 'menu',
    paused: screen==='race'&&paused,
    recording: microphone.phase==='preparing'||microphone.phase==='recording',
  });
  const [bindings, setBindings] = useState<Bindings>({...defaults});
  const steeringHelp=`${label(bindings.forward)} / ${label(bindings.left)} / ${label(bindings.backward)} / ${label(bindings.right)} to steer · hold ${label(bindings.brake)} to brake`;
  const actionHelp=`${label(bindings.boost)} boost (needs fuel) · ${label(bindings.dodge)} dodge · ${label(bindings.use)} use item · hold ${label(bindings.look)} to look up · Esc pause`;
  const [binding, setBinding] = useState<Action | null>(null);
  const [notice, setNotice] = useState('');
  const pause = useCallback((value: boolean) => {
    runtime.paused = value;
    if (value) {reportController.pause();runtime.voice?.pause();}
    else {reportController.resume();runtime.voice?.start();}
    runtime.keys.clear(); runtime.fireRequested=false;runtime.dodgeRequested=false; runtime.target=undefined;
    runtime.race.racers[0].controller.braking = false;
    setPaused(value);
    setHud(current => ({...current, brake: false}));
  }, [runtime,reportController]);
  const reset = () => {
    pause(true);
    reportController.reset();setReportConsent(false);
    runtime.race.reset();voiceActions.current.reset(); runtime.clock = 0; runtime.generation++;
    setHud(initialHud);setFixtureNotice('');setVoiceInputNotice(current=>({id:current.id+1,text:'',phase:''}));
  };

  const startCountdown=useCallback(()=>{
    runtime.race.selectCharacter(inspected);
    reportController.begin(voiceActions.current.live?'live':'mock',reportConsent);
    setHud({...initialHud,standings:runtime.race.standings()});
    // Starting a prepared run must keep its loaded fixture and voice setup.
    setSettings(false);setBinding(null);setCountdown(3);setScreen('countdown');
  },[runtime,inspected,reportController,reportConsent]);
  const prepareRun=()=>{reset();setSetupStep('briefing');setSettings(false);setBinding(null);setScreen('setup');};
  const startPreparedRun=(withVoice:boolean)=>{
    if(screenRef.current!=='setup'||runtime.race.elapsed!==0)return false;
    if(withVoice&&!voice.getReadiness().ready)return false;
    if(!withVoice)voice.skipForRun();
    startCountdown();
    return true;
  };
  const returnToPersonnel=()=>{
    pause(true);voice.recorder.cancel();setScreen('selection');setSettings(false);setBinding(null);
    setPose('Stand');setPreviewPaused(false);setTake(value=>value+1);
  };
  useEffect(()=>{
    if(screen!=='countdown')return;
    const timer=window.setTimeout(()=>{
      if(countdown>1)setCountdown(value=>value-1);
      else{setScreen('race');pause(false);}
    },1000);
    return ()=>window.clearTimeout(timer);
  },[screen,countdown,pause]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (binding) {
        event.preventDefault();
        if (event.repeat) return;
        if (event.code === 'Escape') { setBinding(null); return; }
        if (!/^Key[A-Z]$/.test(event.code)) { setNotice('Choose a letter key. Escape cancels.'); return; }

        if (Object.entries(runtime.bindings).some(([action, code]) => action !== binding && code === event.code)) {
          setNotice('That key is already assigned. Choose another letter.'); return;
        }
        runtime.bindings = {...runtime.bindings, [binding]: event.code};
        setBindings(runtime.bindings);
        setBinding(null);
        setNotice('Binding updated for this session.');
        return;
      }
      if(screenRef.current!=='race'||settingsRef.current)return;
      if (event.code === 'Escape' && !event.repeat) {
        event.preventDefault(); if(runtime.paused&&runtime.race.elapsed===0)startCountdown();else pause(!runtime.paused); return;
      }
      if (interactingWithUi(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.code==='Space') {
        event.preventDefault();
        if (!runtime.paused&&!event.repeat) {
          const phase=voiceActions.current.host.loop.getSnapshot().phase;
          const reason=!voiceActions.current.enabled?'Voice creation is off for this run.'
            :phase==='available'?'Collect an Inspection Request (yellow star) first.'
            :phase==='prompted'?voiceBlocked.current
            :['failed','missed','ended','activated'].includes(phase)?voiceActions.current.host.nextOpportunityMessage:'';
          setVoiceInputNotice(current=>({id:current.id+1,text:reason,phase}));
          voiceActions.current.start();
        }
        return;
      }
      if (Object.values(runtime.bindings).includes(event.code)) {
        event.preventDefault();
        if (!runtime.paused) {
          runtime.keys.add(event.code);
          if(event.code===runtime.bindings.use&&!event.repeat)runtime.fireRequested=true;
          if(event.code===runtime.bindings.dodge&&!event.repeat)runtime.dodgeRequested=true;
        }
      }
    };
    const up = (event: KeyboardEvent) => { runtime.keys.delete(event.code);if(event.code==='Space')voiceActions.current.finish(); };
    const blur = () => {
      // Browser permission dialogs can take focus during setup. Only an actual
      // race pause or a hidden page should release its pending/prepared input.
      if(screenRef.current!=='race'&&screenRef.current!=='countdown'&&!document.hidden)return;
      if(!document.hidden&&screenRef.current==='race'&&runtime.paused&&voiceActions.current.recorder.getSnapshot().phase==='preparing')return;
      pause(true);
      if(screenRef.current==='countdown')setScreen('race');
    };
    const visibility = () => { if (document.hidden) blur(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
      runtime.keys.clear(); runtime.fireRequested=false;runtime.dodgeRequested=false; runtime.target=undefined;
      runtime.paused = true;
    };
  }, [runtime, binding, pause, startCountdown]);

  useEffect(()=>{
    if(screen!=='race'||paused)return;
    const voiceBusy=['prompted','preparing','recording','transcribing','generating','ready'].includes(voice.host.loop.getSnapshot().phase);
    reportController.observe(voice.host.creations,race.racers,voiceBusy);
  },[screen,paused,hud.time,hud.allFinished,voice.state.phase,voice.host,race,reportController]);

  return <RaceAlertProvider>
    {screen==='title' ? <LaunchScreen onCommence={()=>setScreen('selection')} music={music}/> : <section className="movement-test">
    <div className="movement-layout">
      <div className={'movement-stage packaged-game '+(screen!=='race'?'personnel-menu':'')}>
        <div className="in-game-toolbar">
          <button className="training-home" onClick={()=>{pause(true);voice.recorder.cancel();setSettings(false);setScreen('title');}}>⚠ FALLING STANDARDS</button>
          <div>
            {screen==='race'?<><button onClick={()=>{if(runtime.paused&&runtime.race.elapsed===0)startCountdown();else pause(!runtime.paused);}} disabled={binding!==null||settings}>{paused?'Resume':'Pause'}</button><button onClick={prepareRun}>Restart</button></>:null}
            <button aria-pressed={screen==='selection'} onClick={returnToPersonnel}>Personnel</button>
            <button aria-pressed={screen==='viewer'} onClick={()=>{pause(true);voice.recorder.cancel();setScreen('viewer');setSettings(false);setBinding(null);}}>Inspect personnel</button>
            <button aria-pressed={settings} onClick={()=>{pause(true);if(screen==='countdown')setScreen('race');setSettings(value=>!value);setBinding(null);}}>Settings</button>
            {import.meta.env.DEV&&<a href="#/dev/generation">Generation lab</a>}
          </div>
        </div>
        <div className="in-game-display">
        <Canvas camera={{position: [0,32,0], up: [0,0,-1], fov: 65, far: 5000}} fallback={<p>WebGL is unavailable. Enable hardware acceleration to run this test.</p>}>
          {screen==='race'||screen==='countdown'?<RaceScene runtime={runtime} report={setHud}/>:<Preview character={inspected} key={screen+inspected+take} angle={screen==='selection'?DEFAULT_CHARACTER_ANGLE:angle} zoom={zoom} pose={screen==='selection'?(person.introPose??'Stand'):pose} paused={screen==='selection'?false:previewPaused} loop={screen==='selection'||pose==='Checklist'||pose==='Diagnostics'||pose==='Equipment check'} chase={false} inGame/>}
        </Canvas>
        {(screen==='selection'||screen==='viewer')&&!settings&&<div className="in-game-personnel">
          <span className="safety-label">{screen==='viewer'?'EQUIPMENT INSPECTION':'MANDATORY ATTENDANCE'}</span>
          <h1>{screen==='viewer'?'Inspect personnel':'Select personnel'}</h1>
          <h2>{person.name} <small>{employee} / {person.department}</small></h2>
          <p>{person.personality}</p>
          <div className="in-game-roster">{CHARACTERS.map(character=><button key={character.id} disabled={!character.model} aria-pressed={character.id===person.id} onClick={()=>{if(character.model){setInspected(character.model);setAngle(DEFAULT_CHARACTER_ANGLE);setPose(character.introPose??'Stand');setPreviewPaused(false);setTake(value=>value+1);}}}>
            <strong>{character.name}</strong><span>{character.species}</span><small>{screen==='viewer'&&character.id===person.id?'INSPECTING':character.id===person.id?'SELECTED':character.model?'PLAYABLE':'AWAITING EQUIPMENT'}</small>
          </button>)}</div>
          {screen==='viewer'&&<div className="in-game-inspection">
            <label>Rotate<input aria-label="Rotate character" type="range" min="-180" max="180" value={angle} onChange={event=>setAngle(Number(event.target.value))}/></label>
            {screen==='viewer'&&<label>Zoom<input aria-label="Character preview zoom" type="range" min="5" max="12" step=".1" value={zoom} onChange={event=>setZoom(Number(event.target.value))}/></label>}
            <label>Procedure<select aria-label="Character procedure" value={pose} onChange={event=>{setPose(event.target.value as GregPose);setPreviewPaused(false);setTake(value=>value+1);}}>
              {(screen==='viewer'?['Stand','Dive','Reach','Brake','Bank left','Bank right','Impact',...(inspected==='linda'?['Checklist']:inspected==='steve'?['Diagnostics']:inspected==='susan'?['Equipment check']:[])]:['Stand','Reach']).map(value=><option key={value}>{value}</option>)}
            </select></label>
            {screen==='viewer'&&<div><button aria-pressed={previewPaused} onClick={()=>setPreviewPaused(value=>!value)}>{previewPaused?'Play':'Pause preview'}</button><button onClick={()=>{setPreviewPaused(false);setTake(value=>value+1);}}>Replay</button></div>}
          </div>}
          <p>{steeringHelp}<br/>{actionHelp}</p>
          <button className="begin-exercise" onClick={prepareRun}>{'Begin as '+person.name+' →'}</button>
          <small>Attendance is not optional.</small>
        </div>}
        {screen==='setup'&&!settings&&<RaceSetup voice={voice} {...reportSettings} step={setupStep} onStepChange={setSetupStep} steeringHelp={steeringHelp} actionHelp={actionHelp}
          controls={{steering:[bindings.forward,bindings.left,bindings.backward,bindings.right].map(label),boost:label(bindings.boost),use:label(bindings.use)}}
          onStart={()=>startPreparedRun(true)} onSkipVoice={()=>startPreparedRun(false)} onBack={returnToPersonnel}/>}
        {screen==='countdown'&&<div className="exercise-start-screen" role="status" aria-live="polite" aria-atomic="true">
          <span className="safety-caution">⚠ STAND BY</span>
          <h1>EXERCISE COMMENCING IN...</h1>
          <strong key={countdown} className="exercise-start-number">{countdown}</strong>
          <p>{steeringHelp}<br/>{actionHelp}</p>
          <button onClick={returnToPersonnel}>Return to personnel</button>
        </div>}
        {screen==='race'&&<>
        <div className="movement-status">{paused ? 'PAUSED' : hud.look ? 'LOOKING UP' : hud.finish !== null ? 'LANDED' : hud.brake ? 'AIR BRAKE ACTIVE' : 'FREEFALL'}<span>{hud.speed.toFixed(0)} m/s · {Math.ceil(hud.remaining)} m to finish</span></div>
        <div className="race-place">{hud.place} / 4 <small>POSITION</small></div>
        <RaceOverlay hud={hud} paused={paused} useKey={label(bindings.use)} boostKey={label(bindings.boost)} dodgeKey={label(bindings.dodge)}/>
        {!paused && hud.finish === null && hud.remaining <= 100 && <RaceAlert><div className="race-countdown">{Math.ceil(hud.remaining)} m<br/><small>PREPARE FOR LANDING</small></div></RaceAlert>}
        {!paused && hud.finish !== null && <div className="race-result"><strong>EXERCISE COMPLETE · {hud.place} / 4</strong><span>{hud.incidents===0?'Safety inspection: exemplary preparedness.':'Safety inspection: '+hud.incidents+(hud.incidents===1?' incident.':' incidents.')+' Refresher training assigned.'}</span><span>{hud.finish.toFixed(2)} seconds · {hud.allFinished ? 'Everyone landed.' : 'Watch the others land…'}</span><button onClick={prepareRun}>Race again</button><RaceCreations creations={voice.host.creations} racers={race.racers} reports={incidentReports}/></div>}
        <RaceCreationHud enabled={voice.enabled} key={voice.host.runId} host={voice.host} paused={paused} finished={hud.finish!==null} marker={hud.creationMarker} steeringKeys={[bindings.forward,bindings.left,bindings.backward,bindings.right].map(label).join(' / ')} live={!!voice.live} mockText={voice.mockText} blockedReason={voiceBlockedReason} inputNotice={voiceInputNotice} microphone={microphone}/>
        {paused && !settings && <div className="movement-pause"><span className="safety-caution">⚠ CAUTION</span><h2>Mandatory fall protection training</h2><p>{label(bindings.forward)}{label(bindings.left)}{label(bindings.backward)}{label(bindings.right)} to steer · hold {label(bindings.brake)} to brake</p>
          <p>{voice.enabled?<>Collect ★, then hold Space to report a hazard.<br/>Pausing during a voice attempt cancels it.</>:<>Prepared safety drill · no voice required.<br/>Fly through the glowing halo to activate it. Any racer can trigger it.</>}</p>
          {voice.enabled&&<RaceMicrophoneSetup voice={voice}/>}
          <button disabled={binding !== null} onClick={event => {event.currentTarget.blur(); if(runtime.race.elapsed===0)startCountdown();else pause(false);}}>Begin / resume exercise</button>
          <small>Escape resumes · leaving this window pauses</small></div>}
        </>}
      {settings&&<div className="race-dashboard in-game-settings" role="dialog" aria-label="Game settings">
        <div className="settings-heading"><h2>Game settings</h2><button onClick={()=>{setSettings(false);setBinding(null);}}>Close settings</button></div>
        <MusicControls music={music}/>
        {import.meta.env.DEV&&<RaceEventReport host={voice.host} canReplay={paused||race.finished} onReplay={()=>{
          const spec=voice.host.report?.instance?.spec;if(!spec)return;
          reset();voice.host.loadFixture(spec,true);setScreen('race');setFixtureNotice(spec.displayName+' is 30 m ahead. Resume to replay without API calls.');
        }}/>}
        <details className="race-detail"><summary>How to play</summary><RaceBriefing steeringHelp={steeringHelp} actionHelp={actionHelp}/></details>
        {import.meta.env.DEV&&<details className="race-detail">
          <summary>Voice setup <small>{microphone.ready?'Microphone ready':'Enable microphone before racing'}</small></summary>
          <RaceVoiceControls voice={voice} paused={paused} {...reportSettings}/>
        </details>}
        {import.meta.env.DEV&&<details className="race-detail">
          <summary>Safety drills & legacy fixtures <small>Local gameplay test · no API calls</small></summary>
          <p>Restart and choose an event while paused. Any racer can activate it.</p>
          <label><input type="checkbox" checked={quickFixture} disabled={!paused||race.elapsed!==0||!!voice.host.creation} onChange={event=>setQuickFixture(event.target.checked)}/>Quick encounter · spawn 30 m ahead</label>
          <div className="event-fixture-buttons">{[...safetyDrillFixtures,...raceEventFixtures].map(fixture=><button key={fixture.prompt}
            disabled={!paused||race.elapsed!==0||!!voice.host.creation}
            onClick={()=>{try{voice.host.loadFixture(fixture.spec,quickFixture);setScreen('race');setFixtureNotice(fixture.spec.displayName+(quickFixture?' is 30 m ahead.':' is waiting ahead in the course.')+' Resume to race.');}
              catch(error){setFixtureNotice(error instanceof Error?error.message:'Could not place fixture.');}}}>
            {fixture.spec.displayName}
          </button>)}</div>
          <p role="status">{fixtureNotice}</p>
        </details>}
        {import.meta.env.DEV&&<details className="race-detail">
          <summary>Ordinary item practice <small>Equip safety equipment while paused</small></summary>
          <p>Pause an unfinished race, equip an item, then close settings and resume to use it.</p>
          <div className="event-fixture-buttons">{(['parachute','bubbleWrap','airCanister'] as const).map(item=><button key={item}
            disabled={!paused||screen!=='race'||hud.finish!==null}
            onClick={()=>{race.racers[0].item=item;setHud(current=>({...current,itemKey:item,item:ITEM_NAMES[item]}));}}>
            Equip {ITEM_NAMES[item]}
          </button>)}</div>
        </details>}
        <details className="race-detail">
          <summary>Controls <small>Steering, items &amp; key bindings</small></summary>
          <p>Click a key to rebind. Changes last for this session.</p>
          <div className="movement-bindings">{(Object.keys(defaults) as Action[]).map(action=>
            <button key={action} aria-label={`Rebind ${names[action]}`} onClick={()=>{pause(true);setBinding(action);setNotice('Press a letter key. Escape cancels.');}}>
              <span>{names[action]}</span><kbd>{binding===action?'…':label(bindings[action])}</kbd>
            </button>)}</div>
          <p role="status">{notice}</p>
          <p>Hold Space after collecting the star. Release to submit.<br/>{label(bindings.dodge)} dodges · 15-second cooldown.</p>
        </details>
        {import.meta.env.DEV&&<details className="race-detail">
          <summary>Race details <small>Stats &amp; pickup tips</small></summary>
          <p>{hud.time.toFixed(1)} s elapsed · 72 × 72 m lane<br/>X {hud.x.toFixed(1)} m · Z {hud.z.toFixed(1)} m</p>
          <p>Brake target: {BRAKE_SPEED} m/s · Steering: 20 m/s</p>
          <p>{hud.effects||'No active effects'}</p>
          <p>Spare parachutes are more common near the back, air canisters in the middle, and bubble wrap in first. Gold pipe rings give double boost fuel.</p>
        </details>}
      </div>}
        </div>
        {screen==='race'&&<RaceAlertDock/>}
      </div>
    </div>
  </section>}
  </RaceAlertProvider>;
}
