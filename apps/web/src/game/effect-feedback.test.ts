import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RACE_EVENT_LIMITS, SAFETY_DRILL_LIMITS, raceEventFixtures, safetyDrillFixtures,
  type DrillActor, type DrillCurrent, type DrillSnapshot, type EventRacer,
  type EventVector, type RaceEncounter, type RaceEventSnapshot, type SafetyDrillRecipe, type SafetyDrillSpec,
} from '@sky/shared';
import { SafetyDrillRuntime } from '../race-events/drill-runtime';
import { BUDDY_LIMITS } from '../race-events/buddy-drill';
import { effectFeedback, type EffectFeedback } from './effect-feedback';

const origin:EventVector=[0,0,0];
const racers:EventRacer[]=[
  {id:'0',position:origin,velocity:[0,-30,0],finished:false},
  {id:'1',position:[16,0,0],velocity:[0,-30,0],finished:false},
];
const recipe=(family:SafetyDrillRecipe['family'])=>safetyDrillFixtures.find(item=>item.spec.drill.family===family)!.spec;
function snapshot(spec:RaceEncounter,drill?:DrillSnapshot):RaceEventSnapshot {
  return {phase:'active',instance:{instanceId:'feedback',creatorId:'0',spec,position:origin,seed:1},position:origin,
    elapsedSeconds:2,remainingSeconds:8,radius:0,debris:[],affectedRacerIds:[],drill};
}
const drill=(fields:Partial<DrillSnapshot>={}):DrillSnapshot=>({actors:[],currents:[],warningSeconds:0,...fields});
const actor=(fields:Partial<DrillActor>={}):DrillActor=>({id:0,position:[0,-12,0],radius:2.2,velocity:[0,0,0],state:'moving',...fields});
function current(kind:DrillCurrent['kind'],id=0):DrillCurrent {
  return {id,bandId:0,pathId:0,position:[0,-5,0],from:[0,0,0],to:[0,-10,0],radius:4,direction:kind==='eddy'?[0,1,0]:[0,-1,0],kind,strength:20};
}

function assertStablePresentation(cues:EffectFeedback[],message:string) {
  const presentation=(cue:EffectFeedback)=>({title:cue.title,detail:cue.detail,controls:cue.controls,meterLabel:cue.meter?.label});
  for(const cue of cues)assert.deepEqual(presentation(cue),presentation(cues[0]),message);
}

test('every free drill and legacy effect explains an action before any impact',()=>{
  for(const item of safetyDrillFixtures) {
    const runtime=new SafetyDrillRuntime(item.spec.drill,1,racers);
    const event=snapshot(item.spec,runtime.getSnapshot());
    assert.equal(event.impact,undefined);
    const cue=effectFeedback(event,origin);
    assert.ok(cue,item.spec.id);
    assert.ok(cue.title.length&&cue.detail.length,item.spec.id);
    assert.ok(cue.controls,item.spec.id);
    assert.equal(cue.tone,item.spec.drill.family==='buddy'?'neutral':'warning',item.spec.id);
    runtime.prepareStep(2,1/120,racers);
    const active=effectFeedback(snapshot(item.spec,runtime.getSnapshot()),origin);
    assert.ok(active,item.spec.id);
    if(item.spec.drill.family!=='observation')assertStablePresentation([cue,active],item.spec.id+' keeps its instruction after the initial warning');
  }
  for(const item of raceEventFixtures) {
    const cue=effectFeedback(snapshot(item.spec),origin);
    assert.ok(cue?.title&&cue.detail&&cue.controls,item.spec.id);
  }
});

test('inactive, missing, reset and expired events never retain instructions',()=>{
  const event=snapshot(recipe('pinball'),drill());
  for(const phase of ['empty','collectible','expired'] as const)assert.equal(effectFeedback({...event,phase},origin),null);
  assert.equal(effectFeedback({...event,instance:undefined},origin),null);
});

test('charge status uses nearby committed telegraphs while the card keeps its instruction',()=>{
  const spec=recipe('stampede');
  const local=actor({state:'warning',telegraph:{from:[0,-12,0],to:[0,8,0]}});
  const read=(state:DrillSnapshot)=>effectFeedback(snapshot(spec,state),origin)!;
  const committed=read(drill({actors:[local]}));
  assert.match(committed.status!,/Charge committed/);
  assert.doesNotMatch(committed.detail,/aim(?:ed|ing) at you/i);
  const far=actor({state:'warning',position:[0,-1000,0],telegraph:{from:[0,-1000,0],to:[0,-980,0]}});
  const distant=read(drill({actors:[far]})),unmarked=read(drill({actors:[actor({state:'warning'})]}));
  assert.match(distant.status!,/Watch the bodies/);
  assert.match(unmarked.status!,/Watch the bodies/);
  const charging=read(drill({actors:[{...local,state:'charging'}]}));
  assert.equal(charging.tone,'danger');
  assert.match(charging.status!,/Charge nearby/);
  const incoming=read(drill({actors:[local],warningSeconds:0.5}));
  assert.match(incoming.status!,/Herd incoming/);
  assertStablePresentation([committed,distant,unmarked,charging,incoming],'charge warnings change only the status');
});

test('scatter status follows warning and opening without replacing the card or claiming another racer reaction',()=>{
  const spec=safetyDrillFixtures.find(item=>item.spec.drill.family==='stampede'&&item.spec.drill.reaction==='scatter')!.spec;
  const warning=actor({state:'warning',telegraph:{from:[0,-12,0],to:[20,-12,0]}});
  const before=effectFeedback(snapshot(spec,drill()),origin)!;
  const marked=effectFeedback(snapshot(spec,drill({actors:[warning]})),origin)!;
  const opening=effectFeedback(snapshot(spec,drill({actors:[{...warning,state:'scattering'}]})),origin)!;
  assert.match(marked.status!,/Scattering soon/);
  assert.match(opening.status!,/Gap opening/);
  assert.match(before.detail,/warn, then scatter/);
  assertStablePresentation([before,marked,opening],'scatter timing belongs in the status');
});

test('draft feedback follows exact wake capsules including end caps without changing guidance at the boundary',()=>{
  const spec=safetyDrillFixtures.find(item=>item.spec.drill.family==='stampede'&&item.spec.drill.modifier==='draft')!.spec;
  const wake={from:[0,0,0] as const,to:[0,-10,0] as const,position:[0,-5,0] as const,radius:4};
  const body=actor({wake});
  const event=snapshot(spec,drill({actors:[body]})),cues:EffectFeedback[]=[];
  for(const point of [[4,-5,0],[0,4,0],[0,-14,0]] as const) {
    const cue=effectFeedback(event,point)!;cues.push(cue);
    assert.equal(cue.tone,'benefit');
    assert.match(cue.status!,/In the wake/);
  }
  for(const point of [[4.01,-5,0],[0,4.01,0],[0,-14.01,0]] as const) {
    const cue=effectFeedback(event,point)!;cues.push(cue);
    assert.equal(cue.tone,'neutral');
  }
  const harmless=effectFeedback(snapshot(spec,drill({actors:[{...body,state:'warning'}]})),origin)!;
  const incoming=effectFeedback(snapshot(spec,drill({actors:[body],warningSeconds:0.1})),origin)!;
  assert.equal(harmless.tone,'neutral');
  assert.equal(incoming.tone,'warning');
  assertStablePresentation([...cues,harmless,incoming],'wake entry and exit keep the route advice');
});

test('rapids keep route advice across capsule bounds, eddy-fast-flow priority, and actual nonzero force',()=>{
  const spec=recipe('rapids'),flow=current('flow',0),fast=current('fast',1),eddy=current('eddy',2),cues:EffectFeedback[]=[];
  const feedback=(currents:DrillCurrent[],point:EventVector=origin)=>{
    const cue=effectFeedback(snapshot(spec,drill({currents})),point)!;cues.push(cue);return cue;
  };
  assert.match(feedback([flow,fast,eddy]).status!,/Eddy/);
  assert.match(feedback([flow,fast]).status!,/Fast current/);
  assert.match(feedback([flow]).status!,/In the flow/);
  assert.equal(feedback([flow],[0,4,0]).tone,'benefit');
  assert.equal(feedback([flow],[0,4.001,0]).tone,'neutral');
  assert.equal(feedback([flow],[4.001,-5,0]).tone,'neutral');
  assert.equal(feedback([{...flow,to:flow.from}],origin).tone,'benefit','zero-length segment has spherical bounds');
  assert.equal(feedback([{...flow,strength:0}]).tone,'neutral');
  assert.equal(feedback([{...eddy,strength:0},fast]).tone,'neutral','a lower priority overlapping current is not independently applied');
  assert.equal(feedback([{...flow,strength:0},{...flow,id:4}]).tone,'neutral','same kind chooses the lowest id');
  const incoming=effectFeedback(snapshot(spec,drill({currents:[flow],warningSeconds:1})),origin)!;
  assert.equal(incoming.tone,'warning');
  assert.match(incoming.status!,/Currents incoming/);
  assertStablePresentation([...cues,incoming],'entering and leaving currents only changes the status');
});

test('both pinball recipes keep their bounce instruction when the initial warning ends',()=>{
  const base=recipe('pinball');
  if(base.drill.family!=='pinball')throw new Error('Expected pinball fixture');
  for(const bounce of ['springy','ricochet'] as const) {
    const spec:SafetyDrillSpec={...base,drill:{...base.drill,bounce}};
    const warning=effectFeedback(snapshot(spec,drill({warningSeconds:0.5})),origin)!;
    const active=effectFeedback(snapshot(spec,drill({actors:[actor()]})),origin)!;
    assertStablePresentation([warning,active],bounce+' pinball');
    assert.equal(warning.tone,'warning');
    assert.equal(active.tone,'neutral');
  }
});

test('buddy guidance stays stable through warning, elastic and pulsing pull, slack and permanent release',()=>{
  const base=recipe('buddy');
  if(base.drill.family!=='buddy')throw new Error('Expected buddy fixture');
  const paired={tone:'neutral',title:'BUDDY TETHER',detail:'Stay close to your buddy to reduce the pull.',
    controls:{action:'steer',detail:'Stay near your buddy'}};
  const unpaired={...paired,detail:'No tether attached. Keep racing.',controls:{action:'steer',detail:'Steer freely'},
    meter:{label:'TETHER PULL',value:0}};
  const checkPaired=(cue:ReturnType<typeof effectFeedback>,value:number)=>
    assert.deepEqual(cue,{...paired,meter:{label:'TETHER PULL',value}});
  for(const tether of ['elastic','pulsing'] as const) {
    const spec:SafetyDrillSpec={...base,drill:{...base.drill,tether}};
    const runtime=new SafetyDrillRuntime(spec.drill,1,racers);
    const read=()=>effectFeedback(snapshot(spec,runtime.getSnapshot()),origin)!;
    checkPaired(read(),0);
    const tightAge=SAFETY_DRILL_LIMITS.warningSeconds+BUDDY_LIMITS.pulseSlack+0.1;
    runtime.prepareStep(tightAge,1/120,racers);
    const pull=runtime.getSnapshot().tethers![0].tension;
    assert.ok(pull>0&&pull<=1,'separated buddies really pull in both recipes');
    checkPaired(read(),pull);
    assert.deepEqual(effectFeedback(snapshot(spec,runtime.getSnapshot()),origin,'unpaired'),unpaired);
    runtime.prepareStep(tightAge+0.1,1/120,[racers[0],{...racers[1],position:[4,0,0]}]);
    assert.equal(runtime.getSnapshot().tethers![0].active,true,'zero pull can occur while the tether is active');
    checkPaired(read(),0);
    const nextPulse=SAFETY_DRILL_LIMITS.warningSeconds+BUDDY_LIMITS.pulsePeriod;
    if(tether==='pulsing') {
      runtime.prepareStep(nextPulse+BUDDY_LIMITS.pulseSlack/2,1/120,racers);
      assert.equal(runtime.getSnapshot().tethers![0].active,false,'the real pulsing runtime enters slack');
      checkPaired(read(),0);
      runtime.prepareStep(nextPulse+BUDDY_LIMITS.pulseSlack+0.1,1/120,racers);
      assert.equal(runtime.getSnapshot().tethers![0].active,true,'the next pulse tightens again');
      checkPaired(read(),pull);
    }
    const releaseAge=nextPulse+BUDDY_LIMITS.pulseSlack+0.2;
    runtime.prepareStep(releaseAge,1/120,[racers[0],{...racers[1],finished:true}]);
    assert.deepEqual(read(),unpaired);
    runtime.prepareStep(releaseAge+0.1,1/120,racers);
    assert.deepEqual(read(),unpaired,'a released buddy never reattaches');
  }
  const tether={id:0,racerIds:['0','1'] as const,from:origin,to:[16,0,0] as const,restLength:8,tension:1.01,active:true};
  const read=(state:DrillSnapshot)=>effectFeedback(snapshot(base,state),origin);
  checkPaired(read(drill({tethers:[tether]})),1);
  checkPaired(read(drill({tethers:[{...tether,tension:-0.01}]})),0);
  checkPaired(read(drill({tethers:[{...tether,active:false}]})),0);
  checkPaired(read(drill({tethers:[tether],warningSeconds:0.1})),0);
});

test('orbit presence uses a finite active cylinder while the escape instruction stays stable',()=>{
  const spec=recipe('orbit'),field={id:0,position:origin,radius:20,coreRadius:4,height:180,direction:1 as const,active:true};
  const event=snapshot(spec,drill({orbits:[field]})),cues:EffectFeedback[]=[];
  for(const point of [[20,0,0],[0,90,0],[0,-90,0],origin] as const) {
    const cue=effectFeedback(event,point)!;cues.push(cue);assert.match(cue.status!,/Inside/);
  }
  for(const point of [[20.001,0,0],[0,90.001,0],[0,-90.001,0]] as const) {
    const cue=effectFeedback(event,point)!;cues.push(cue);assert.match(cue.status!,/Outside/);
  }
  const inactive=effectFeedback(snapshot(spec,drill({orbits:[{...field,active:false}]})),origin)!;
  assert.match(inactive.status!,/Outside/);
  assert.match(inactive.detail,/Steer outward/);
  assertStablePresentation([...cues,inactive],'field membership cannot replace the escape instruction');
  for(const cue of cues)assert.doesNotMatch(cue.status!,/captured|released/i,'the snapshot does not expose capture or release');
});

test('reconstruction keeps frozen-copy guidance while status distinguishes relevant forming and solid copies',()=>{
  const spec=recipe('reconstruction'),copy=actor({kind:'echo',state:'warning',position:[0,-70,0]}),cues:EffectFeedback[]=[];
  const feedback=(actors:DrillActor[])=>{
    const cue=effectFeedback(snapshot(spec,drill({actors})),origin)!;cues.push(cue);return cue;
  };
  const forming=feedback([copy]);
  assert.match(forming.status!,/Copies forming ahead/);
  assert.match(forming.detail,/stay fixed/);
  assert.match(feedback([{...copy,state:'moving'}]).status!,/Solid copies ahead/);
  for(const position of [[0,100,0],[0,-SAFETY_DRILL_LIMITS.bandLengthMeters-1,0],[SAFETY_DRILL_LIMITS.approachRadius+1,-70,0]] as const)
    assert.match(feedback([{...copy,position}]).status!,/Watch for copies/);
  assertStablePresentation(cues,'forming and solid copies use one avoidance instruction');
});

test('inspection preserves its rule and meter slot while measured exposure and steering cues update immediately',()=>{
  const local={watching:true,warning:false,moving:true,exposureFraction:0.63,cooldownSeconds:0,protected:false,penaltyBlocked:false};
  const event=snapshot(recipe('observation'),drill({observations:{'0':local}})),cues:EffectFeedback[]=[];
  const read=(state=local,warningSeconds=0)=>{
    const cue=effectFeedback({...event,drill:drill({observations:{'0':state},warningSeconds})},origin)!;
    cues.push(cue);return cue;
  };
  const moving=read();
  assert.equal(moving.tone,'danger');
  assert.deepEqual(moving.meter,{label:'SIDEWAYS EXPOSURE',value:0.63});
  assert.equal(moving.controls!.action,'release-steering');
  assert.match(moving.status!,/Sideways drift/);
  for(const state of [{...local,protected:true},{...local,cooldownSeconds:1},{...local,cooldownSeconds:1,penaltyBlocked:true}]) {
    const cue=read(state);
    assert.equal(cue.meter!.value,null,'protection and cooldown retain an explicitly inactive meter');
    assert.equal(cue.controls!.action,'release-steering');
    assert.match(cue.status!,/hold course/);
  }
  const steady=read({...local,moving:false,exposureFraction:0});
  assert.equal(steady.tone,'warning');
  assert.equal(steady.meter!.value,0,'zero measured exposure remains distinct from an inactive meter');
  assert.match(steady.status!,/Red light · hold course/);
  const outside=read({...local,watching:false});
  assert.equal(outside.meter!.value,null);
  assert.equal(outside.controls!.action,'steer');
  assert.match(outside.status!,/Outside cones · steer/);
  const resting=effectFeedback({...event,drill:drill({observations:{'0':{...local,watching:false}},observers:[{
    id:0,position:origin,direction:[0,-1,0],range:85,cosHalfAngle:Math.cos(Math.PI/6),watching:false,warning:false,
  }]})},origin)!;
  cues.push(resting);
  assert.equal(resting.meter!.value,null);
  assert.equal(resting.controls!.action,'steer');
  assert.match(resting.status!,/Blue light · steer/);
  for(const warning of [read({...local,watching:false,warning:true}),read({...local,watching:false},0.1)]) {
    assert.equal(warning.meter!.value,null);
    assert.equal(warning.controls!.action,'release-steering');
    assert.match(warning.status!,/Red incoming · hold course/);
  }
  assert.equal(read({...local,exposureFraction:1.01}).meter!.value,1);
  assert.equal(read({...local,exposureFraction:-0.01}).meter!.value,0);
  for(const cue of cues) {
    assert.equal(cue.title,moving.title,'inspection never swaps its heading');
    assert.equal(cue.detail,moving.detail,'inspection never swaps its rule');
    assert.equal(cue.meter!.label,'SIDEWAYS EXPOSURE','inspection never removes or relabels its meter');
    assert.deepEqual(cue.controls,cue.controls!.action==='steer'?outside.controls:moving.controls);
  }
});

test('inspection releases steering for an upcoming red light even when a recent outcome has status priority',()=>{
  const spec=recipe('observation');
  for(const penaltyBlocked of [false,true]) {
    const local={watching:false,warning:false,moving:false,exposureFraction:0,cooldownSeconds:1,protected:false,penaltyBlocked};
    const read=(warning:boolean,warningSeconds=0)=>effectFeedback(snapshot(spec,drill({
      observations:{'0':{...local,warning}},warningSeconds,
    })),origin)!;
    const outside=read(false);
    assert.equal(outside.controls!.action,'steer');
    assert.match(outside.status!,/ · steer$/);
    for(const warning of [read(true),read(false,0.1)]) {
      assert.equal(warning.controls!.action,'release-steering','the next warning must beat the prior cooldown for control advice');
      assert.match(warning.status!,/ · hold course$/);
      assert.match(warning.status!,penaltyBlocked?/Penalty blocked/:/Penalty shove/);
      assert.equal(warning.meter!.value,null,'a cooldown must not look like freshly measured zero exposure');
      assert.equal(warning.title,outside.title);
      assert.equal(warning.detail,outside.detail);
    }
  }
});

test('legacy field boundaries and visible collidable rocks update status without replacing their instructions',()=>{
  const legacy=(type:typeof raceEventFixtures[number]['spec']['effect']['type'])=>raceEventFixtures.find(item=>item.spec.effect.type===type)!.spec;
  const gravity=legacy('gravityWell'),safe=legacy('protectiveZone');
  assert.equal(gravity.effect.type,'gravityWell');
  assert.equal(safe.effect.type,'protectiveZone');
  if(gravity.effect.type!=='gravityWell'||safe.effect.type!=='protectiveZone')throw new Error('Expected field fixtures');
  const center:EventVector=[10,25,0];
  const gravityInside=effectFeedback({...snapshot(gravity),position:center},center)!;
  const gravityOutside=effectFeedback({...snapshot(gravity),position:center},[10+gravity.effect.radiusMeters,25,0])!;
  assert.match(gravityInside.status!,/Inside/);
  assert.match(gravityOutside.status!,/Outside/);
  assertStablePresentation([gravityInside,gravityOutside],'vortex boundary crossing');
  const protectedCue=effectFeedback({...snapshot(safe),position:center},[10,25+safe.effect.radiusMeters,0])!;
  const exposedCue=effectFeedback({...snapshot(safe),position:center},[10,25+safe.effect.radiusMeters+0.01,0])!;
  assert.equal(protectedCue.tone,'benefit');
  assert.equal(exposedCue.tone,'neutral');
  assertStablePresentation([protectedCue,exposedCue],'slipstream boundary crossing');
  const noBoost={...safe,effect:{...safe.effect,descentAcceleration:0}};
  assert.doesNotMatch(effectFeedback(snapshot(noBoost),origin)!.detail,/faster/);
  const debris=snapshot(legacy('debrisShower')),cues:EffectFeedback[]=[];
  const readDebris=()=>{const cue=effectFeedback(debris,origin)!;cues.push(cue);return cue;};
  debris.debris=[{id:0,position:[0,24,0],collidable:false}];
  assert.equal(readDebris().tone,'warning');
  debris.debris=[{...debris.debris[0],collidable:true}];
  const overhead=readDebris();
  assert.equal(overhead.tone,'danger');
  assert.match(overhead.status!,/Rocks overhead/);
  debris.debris=[{...debris.debris[0],position:[0,-10,0]}];
  assert.equal(readDebris().tone,'warning');
  debris.debris=[{...debris.debris[0],position:[RACE_EVENT_LIMITS.debrisRadius+RACE_EVENT_LIMITS.racerRadius+4.01,20,0]}];
  assert.equal(readDebris().tone,'warning');
  assertStablePresentation(cues,'debris threat proximity');
  const shockwave=snapshot(legacy('repulsionBurst'));
  assertStablePresentation([effectFeedback(shockwave,origin)!,effectFeedback({...shockwave,elapsedSeconds:4,radius:20},[24,0,0])!],
    'shockwave expansion keeps recovery advice');
});

test('cumulative impacts cannot produce stale hits, rewards, drafting, pull or escape claims',()=>{
  for(const item of [...safetyDrillFixtures,...raceEventFixtures]) {
    const event=snapshot(item.spec,drill());
    const before=effectFeedback(event,origin);
    event.affectedRacerIds=['0'];
    event.impact={participants:['0'],affectedRacerIds:['0'],impulseCounts:{'0':4},debrisHits:{'0':3},blockedDebrisHits:{'0':2},obstacleBlocks:{'0':8},
      drill:{collisions:{'0':4},blockedCollisions:{'0':3},draftSeconds:{'0':2},currentSeconds:{'0':3},reactions:7,
        bounces:{'0':3},tetherSeconds:{'0':5},orbitSeconds:{'0':3},orbitReleases:{'0':2},observationFlags:{'0':2},blockedObservations:{'0':1}}};
    assert.deepEqual(effectFeedback(event,origin),before,item.spec.id);
  }
});

test('a steady convoy without draft explains descent instead of crossing traffic',()=>{
  const spec=recipe('stampede');
  const convoy={...spec,drill:{family:'stampede',formation:'convoy',direction:'right',reaction:'steady',modifier:'none'} as const};
  const cue=effectFeedback(snapshot(convoy,drill()),origin)!;
  assert.match(cue.title,/CONVOY/);
  assert.match(cue.detail,/descends together/);
  assert.doesNotMatch(cue.detail,/cross the course|Cyan wake/);
});
