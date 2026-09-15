import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { safetyDrillFixtures, PipelineProfilesSchema, encounterLabel, encounterKind, encounterInstruction, type VoiceRequest } from '@sky/shared';
import { PracticeRace } from '../game/practice-race';
import { RaceEventRuntime } from '../race-events/runtime';
import { RaceEventHost, type RaceVoiceOpportunitySnapshot } from '../game/race-event-host';
import type { RaceCreationRecord } from '../game/race-creation-history';
import { RACE_VOICE_ATTEMPTS } from '../game/race-event-config';
import { drillAssessment } from '../game/drill-feedback';
import { paidVoiceAvailable, raceVoiceReadiness } from './race-voice-readiness';
import type { RaceVoiceController } from './RaceVoiceControls';

const stage = {model:'fake-model',reasoning:'low',maxOutputTokens:256};
const profiles = PipelineProfilesSchema.parse({
  profiles:[
    {id:'mock',label:'Mock',mode:'mock',available:true,design:stage,geometry:stage},
    {id:'fake-live',label:'Live',mode:'live',available:true,design:stage,geometry:stage},
  ],
  transcription:{model:'fake-speech',available:true},
  liveUsage:{enabled:true,busy:false,maxAttempts:3,attemptsUsed:0,attemptsRemaining:3},
  deadlineMs:30000,designBudgetMs:8000,
});
const ready = {enabled:true,microphone:{ready:true,phase:'ready' as const},profiles,profileId:'fake-live',error:''};

test('mock needs microphone readiness but never live availability', () => {
  const mock = {...ready,profileId:'mock',profiles:{...profiles,liveUsage:{...profiles.liveUsage,enabled:false}}};
  assert.equal(raceVoiceReadiness(mock).ready,true);
  for (const microphone of [{ready:false,phase:'idle'}, {ready:true,phase:'preparing'}, {ready:true,phase:'error'}] as const) {
    assert.equal(raceVoiceReadiness({...mock,microphone}).ready,false);
  }
});

test('live readiness needs a usable profile, microphone, transcription and capacity without a separate opt-in', () => {
  assert.equal(raceVoiceReadiness(ready).ready,true);
  for (const change of [
    {enabled:false}, {profiles:undefined}, {profileId:'missing'}, {error:'Connection failed'},
    {profiles:{...profiles,profiles:profiles.profiles.map(profile=>({...profile,available:false}))}},
    {profiles:{...profiles,transcription:undefined}},
    ...[{enabled:false},{busy:true},{attemptsRemaining:0}].map(change=>({profiles:{...profiles,liveUsage:{...profiles.liveUsage,...change}}})),
  ]) assert.equal(raceVoiceReadiness({...ready,...change}).ready,false,JSON.stringify(change));
  assert.equal(paidVoiceAvailable(undefined),false);
});

// Run the real voice hook, host, and readiness rules with fake React scheduling,
// microphone hardware, and provider transport. No browser permission or API call.
const code = ts.transpileModule(readFileSync(new URL('./RaceVoiceControls.tsx',import.meta.url),'utf8'), {
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
const flush = () => new Promise<void>(resolve=>setImmediate(resolve));
async function setup(profileAvailability: typeof profiles | null = profiles) {
  const hooks:unknown[] = [], effects:Array<()=>void|(()=>void)> = [];
  let cursor=0,mounted=false,captures=0,cancellations=0;
  const slot=(initial:()=>unknown)=>{const index=cursor++;if(!(index in hooks))hooks[index]=initial();return index;};
  const React={
    useState(initial:unknown) {
      const index=slot(()=>typeof initial==='function'?initial():initial);
      return [hooks[index],(next:unknown)=>{hooks[index]=typeof next==='function'?next(hooks[index]):next;}];
    },
    useRef(initial:unknown){return hooks[slot(()=>({current:initial}))];},
    useSyncExternalStore(_subscribe:unknown,snapshot:()=>unknown){return snapshot();},
    useEffect(effect:()=>void|(()=>void)){if(!mounted)effects.push(effect);},
  };
  class Recorder {
    readonly kind='audio';
    state={ready:false,phase:'idle',level:0,elapsedMs:0,message:'Enable microphone'};
    getSnapshot=()=>this.state;
    subscribe=()=>()=>{};
    prepare=async()=>{this.state={...this.state,ready:true,phase:'ready'};};
    cancel=()=>{cancellations++;};
    async start(){captures++;}
    async stop(){return {blob:new Blob(['fake clip']),captureMs:500};}
  }
  const requests:Array<Omit<VoiceRequest,'captureMs'>>=[];
  const modules:Record<string,unknown>={
    react:React,'react/jsx-runtime':{},'@sky/shared':{safetyDrillFixtures},
    '../game/RaceReportSettings':{},'../game/race-event-host':{RaceEventHost},'../game/race-event-config':{RACE_VOICE_ATTEMPTS},'./recorder':{MicrophoneRecorder:Recorder},
    '../generation/pipeline-client':{loadPipelineProfiles:async()=>{
      if(!profileAvailability)throw new Error('Profiles unavailable');
      return structuredClone(profileAvailability);
    }},
    './race-voice-readiness':{paidVoiceAvailable,raceVoiceReadiness},'./RecorderControls':{},
    './safety-drill-voice-client':{createAudioSafetyDrillClient:(getConfiguration:()=>Omit<VoiceRequest,'captureMs'>)=>({
      async generateAudio(){requests.push(getConfiguration());return safetyDrillFixtures[0].spec;},
    })},
  };
  const sandbox={exports:{} as {useRaceVoice:(race:PracticeRace)=>RaceVoiceController},
    require:(id:string)=>{assert.ok(id in modules,'Unexpected import: '+id);return modules[id];},
    AbortController,crypto:globalThis.crypto,
  };
  runInNewContext(code,sandbox);
  const race=new PracticeRace(false,()=>0.42,new RaceEventRuntime());
  const render=()=>{cursor=0;return sandbox.exports.useRaceVoice(race);};
  render();const cleanups=effects.map(effect=>effect());mounted=true;
  await flush();
  return {race,render,requests,captures:()=>captures,cancellations:()=>cancellations,close:()=>cleanups.forEach(cleanup=>cleanup?.())};
}

test('selecting live and checking permission dispatch nothing; an explicit recording uses a fresh attempt ID', async () => {
  const ui=await setup();
  let voice=ui.render();voice.reset();voice=ui.render();
  voice.setProfileId('fake-live');await voice.recorder.prepare();voice=ui.render();
  assert.equal(voice.getReadiness().ready,true);
  assert.equal(voice.paidAttemptsRemaining,RACE_VOICE_ATTEMPTS);
  assert.equal(ui.requests.length,0);assert.equal(ui.captures(),0);
  const session=voice.state.session;
  voice.host.start();voice=ui.render();
  assert.equal(voice.state.session,session);
  assert.equal(ui.requests.length,0);assert.equal(ui.captures(),0);
  voice.host.loop.collectVoice();voice=ui.render();voice.start();await flush();
  voice=ui.render();assert.equal(voice.paidAttemptsRemaining,1);
  await voice.host.loop.finishRecording();
  assert.equal(ui.captures(),1);assert.equal(ui.requests.length,1);
  assert.equal(ui.requests[0].profileId,'fake-live');assert.equal(ui.requests[0].paidAttempt?.confirmed,true);
  voice.start();assert.equal(ui.captures(),1);
  ui.race.reset();voice.reset();voice=ui.render();
  assert.equal(voice.paidAttemptsRemaining,RACE_VOICE_ATTEMPTS);assert.equal(voice.enabled,true);
  assert.equal(ui.captures(),1);assert.equal(ui.requests.length,1);
  voice.host.start();voice.host.loop.collectVoice();voice=ui.render();voice.start();await flush();
  await voice.host.loop.finishRecording();
  assert.equal(ui.requests.length,2);
  assert.notEqual(ui.requests[0].paidAttempt?.id,ui.requests[1].paidAttempt?.id);
  ui.close();
});

test('profile and prepared-prompt changes never capture or dispatch by themselves', async () => {
  const ui=await setup();let voice=ui.render();
  voice.setProfileId('fake-live');voice=ui.render();
  voice.setMockText(safetyDrillFixtures[1].prompt);voice=ui.render();
  assert.equal(voice.paidAttemptsRemaining,RACE_VOICE_ATTEMPTS);
  assert.equal(ui.requests.length,0);assert.equal(ui.captures(),0);ui.close();
});

for(const availability of ['live selected','unavailable'] as const)test('playing without voice loads the selected drill with '+availability+' profiles and never captures', async () => {
  const ui=await setup(availability==='unavailable'?null:profiles);let voice=ui.render();
  const selected=safetyDrillFixtures.find(fixture=>fixture.spec.drill.family==='rapids')!;
  voice.setProfileId('fake-live');voice.setMockText(selected.prompt);
  if(availability==='live selected')await voice.recorder.prepare();
  voice=ui.render();
  const cancellations=ui.cancellations();
  voice.skipForRun();voice=ui.render();
  assert.equal(voice.enabled,false);assert.equal(voice.host.voice,undefined);
  assert.equal(voice.paidAttemptsRemaining,0);assert.ok(ui.cancellations()>cancellations,'prepared microphone input is released');
  assert.deepEqual(voice.host.creation?.spec,selected.spec);
  assert.equal(voice.host.creations.length,1);assert.equal(voice.host.creations[0].source,'prepared');
  assert.equal(voice.host.creations[0].attemptNumber,undefined);
  assert.equal(voice.host.getSnapshot().secondStar,'discarded');
  voice.host.start();voice.host.loop.collectVoice();voice.start();
  for(let tick=0;tick<1800;tick++) {
    const from=ui.race.snapshot(ui.race.racers[0]).position;
    ui.race.step(1/120,{x:0,z:0},false);
    voice.host.step(1/120,from,ui.race.snapshot(ui.race.racers[0]).position);
  }
  assert.ok(ui.race.elapsed>10);assert.equal(ui.captures(),0);assert.equal(ui.requests.length,0);
  assert.ok(voice.host.creations[0].snapshot?.triggererId,'the prepared encounter can activate in a real race');
  assert.equal(voice.host.loop.getSnapshot().phase,'ended');assert.equal(voice.host.voice,undefined);
  ui.race.reset();voice.reset();voice=ui.render();
  assert.equal(voice.enabled,true);assert.ok(voice.host.voice);assert.equal(voice.paidAttemptsRemaining,RACE_VOICE_ATTEMPTS);
  assert.equal(voice.host.creation,undefined);assert.equal(voice.host.creations.length,0);
  ui.close();
});

test('an unknown prepared-prompt selection falls back to a supported drill without calling providers',async()=>{
  const ui=await setup(null);let voice=ui.render();
  voice.setMockText('not a prepared prompt');voice=ui.render();voice.skipForRun();voice=ui.render();
  assert.deepEqual(voice.host.creation?.spec,safetyDrillFixtures[0].spec);
  assert.equal(ui.captures(),0);assert.equal(ui.requests.length,0);ui.close();
});

test('voice cannot be disabled after the run starts or after a fixture is placed', async () => {
  const ui=await setup();const voice=ui.render();
  voice.host.start();assert.throws(()=>voice.host.disableForRun(),/before the race/);
  ui.race.reset();voice.reset();voice.host.loadFixture(safetyDrillFixtures[0].spec,true);
  assert.throws(()=>voice.host.disableForRun(),/before the race/);ui.close();
});

// Render only the HUD's state-derived copy; no renderer or browser is needed.
function hudSetup(phase='prompted') {
  const hudCode=ts.transpileModule(readFileSync(new URL('../game/RaceCreationVisuals.tsx',import.meta.url),'utf8'), {
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  const jsx=(type:unknown,props:unknown)=>({type,props});
  const modules:Record<string,unknown>={
    react:{useState:(initial:unknown)=>[initial,()=>{}],useEffect:()=>{},useSyncExternalStore:(_:unknown,get:()=>unknown)=>get()},
    'react/jsx-runtime':{jsx,jsxs:jsx},'@react-three/fiber':{},three:{},'@sky/shared':{encounterLabel,encounterKind,encounterInstruction},
    '../race-events/RaceEventRenderer':{},'./drill-feedback':{drillAssessment},'./EffectCue':{},
    './RaceAlerts':{RaceAlert:'race-alert'},
    './race-event-config':{RACE_VOICE_ATTEMPTS},'../components/PowerUpModel':{},
  };
  const sandbox={exports:{} as {RaceCreationHud:(props:unknown)=>unknown},
    require:(id:string)=>{assert.ok(id in modules,'Unexpected import: '+id);return modules[id];},
  };
  runInNewContext(hudCode,sandbox);
  let opportunity:RaceVoiceOpportunitySnapshot={secondStar:'scheduled',message:''};
  let event=new RaceEventRuntime().getSnapshot();
  const props={enabled:true,paused:false,finished:false,live:false,mockText:'angry orange sun',blockedReason:'',
    microphone:{phase:'ready',message:'Microphone ready.'},inputNotice:{id:1,text:'Collect the yellow star first.',phase:'available'},
    host:{loop:{subscribe:()=>()=>{},getSnapshot:()=>({phase})},attemptNumber:1,creations:[] as RaceCreationRecord[],
      subscribe:()=>()=>{},getSnapshot:()=>opportunity,
      race:{elapsed:0,racers:[],events:{getSnapshot:()=>event}}},
  };
  return {props,render:()=>JSON.stringify(sandbox.exports.RaceCreationHud(props)),
    setOpportunity:(next:RaceVoiceOpportunitySnapshot)=>{opportunity=next;},setEvent:(next:typeof event)=>{event=next;}};
}

test('a prepared no-voice pickup keeps its activation instructions visible without asking for speech',()=>{
  const ui=hudSetup('ended'),runtime=new RaceEventRuntime();
  const spec=safetyDrillFixtures[0].spec;
  runtime.spawn({instanceId:'prepared',creatorId:'0',spec,position:[0,-240,0],seed:42});
  ui.props.enabled=false;
  ui.props.host.creations=[{instanceId:'prepared',source:'prepared',spec,status:'collectible'}];
  ui.setEvent(runtime.getSnapshot());
  ui.setOpportunity({secondStar:'discarded',message:'Voice creation is off for this run.'});
  const rendered=ui.render();
  assert.match(rendered,/PREPARED DRILL/);assert.match(rendered,/Fly through the glowing halo/);
  assert.ok(rendered.includes(spec.displayName));assert.ok(rendered.includes(encounterInstruction(spec)));
  assert.doesNotMatch(rendered,/Hold Space|INSPECTION REQUEST|Voice creation is off|CREATED/);
});

test('microphone startup shows the current browser operation instead of a generic opening label', () => {
  const ui=hudSetup('preparing');
  ui.props.microphone.phase='preparing';
  for(const message of ['Opening microphone…','Starting audio recorder…','Starting microphone level meter…','Starting recording…']) {
    ui.props.microphone.message=message;
    assert.ok(ui.render().includes(message));
  }
  ui.props.microphone.phase='ready';
  assert.match(ui.render(),/Starting microphone/);
  assert.doesNotMatch(ui.render(),/Starting recording/);
});

test('a pre-pickup Space warning cannot override the collected-star prompt', () => {
  const ui=hudSetup();
  assert.match(ui.render(),/Hold Space/);assert.doesNotMatch(ui.render(),/Collect the yellow star first/);
  ui.props.inputNotice={id:2,text:'Enable your microphone.',phase:'prompted'};
  assert.match(ui.render(),/Enable your microphone/);
});

test('the second-star arrival is visible while the first creation is spawned or activated', () => {
  for(const phase of ['spawned','activated']) {
    const ui=hudSetup(phase);
    const message='Second yellow star ahead. Collect it for another request.';
    ui.setOpportunity({secondStar:'offered',message});
    assert.ok(ui.render().includes(message),phase+' must not silence the independent star cue');
    assert.match(ui.render(),/SECOND INSPECTION REQUEST/);
  }
});

test('a saved second-star grant stays visible while the first request generates', () => {
  const ui=hudSetup('generating');
  const message='Second request saved. Waiting for the current voice request to finish.';
  ui.setOpportunity({secondStar:'collected',message});
  assert.ok(ui.render().includes(message));
  assert.match(ui.render(),/Keep racing/);
});

test('a discarded second request remains visible at finish after the attempt ends', () => {
  const ui=hudSetup('ended');
  ui.props.finished=true;
  const message='You landed before the second request could be completed.';
  ui.setOpportunity({secondStar:'discarded',message});
  assert.ok(ui.render().includes(message));
  assert.match(ui.render(),/SECOND INSPECTION REQUEST/);
});

test('consumption, a missed star, and reset clear the previous second-star arrival cue', () => {
  const ui=hudSetup('activated');
  const arrival='Second yellow star ahead. Collect it for another request.';
  ui.setOpportunity({secondStar:'offered',message:arrival});
  assert.ok(ui.render().includes(arrival));
  for(const opportunity of [
    {secondStar:'consumed',message:''},
    {secondStar:'missed',message:'Second yellow star missed. No more voice stars this run.'},
    {secondStar:'scheduled',message:'A second yellow star appears at 60-70% of the course.'},
  ] satisfies RaceVoiceOpportunitySnapshot[]) {
    ui.setOpportunity(opportunity);
    assert.ok(!ui.render().includes(arrival),opportunity.secondStar+' must clear the arrival');
    if(opportunity.secondStar==='missed')assert.ok(ui.render().includes(opportunity.message));
  }
});

test('one live run permits two separately identified requests without opt-in or key-repeat duplicates', async () => {
  const ui=await setup();let voice=ui.render();
  voice.setProfileId('fake-live');await voice.recorder.prepare();voice=ui.render();
  voice.host.start();
  voice.host.loop.collectVoice();voice=ui.render();voice.start();voice.start();await flush();
  await voice.host.loop.finishRecording();
  assert.equal(ui.requests.length,1);
  // The race host rearms only the attempt; this isolates the defensive attempt cap from event scheduling.
  voice.host.loop.reset();voice.host.loop.start();voice.host.loop.collectVoice();
  voice=ui.render();voice.start();voice.start();await flush();await voice.host.loop.finishRecording();
  voice=ui.render();assert.equal(voice.paidAttemptsRemaining,0);
  assert.equal(ui.requests.length,2);assert.equal(ui.captures(),2);
  assert.notEqual(ui.requests[0].paidAttempt?.id,ui.requests[1].paidAttempt?.id);
  assert.ok(ui.requests.every(request=>request.paidAttempt?.confirmed));
  // Configuration changes do not replenish this run's used paid attempts.
  voice.setProfileId('mock');voice=ui.render();voice.setProfileId('fake-live');
  voice=ui.render();voice.setMockText(safetyDrillFixtures[1].prompt);voice=ui.render();
  assert.equal(voice.paidAttemptsRemaining,0);
  voice.host.loop.reset();voice.host.loop.start();voice.host.loop.collectVoice();
  voice=ui.render();voice.start();await flush();
  assert.equal(ui.requests.length,2);assert.equal(ui.captures(),2);ui.close();
});
