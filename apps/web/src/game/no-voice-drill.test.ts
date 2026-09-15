import test from 'node:test';
import assert from 'node:assert/strict';
import { safetyDrillFixtures, type SafetyDrillSpec } from '@sky/shared';
import { RaceEventRuntime } from '../race-events/runtime';
import { MAX_EXTERNAL_SPEED, TERMINAL_SPEED } from './freefall-controller';
import { PracticeRace, FINISH_DEPTH, LANE_HALF_WIDTH } from './practice-race';
import { RaceEventHost, eventPlacement } from './race-event-host';
import { RACE_CREATION_PICKUP_RADIUS, raceEventSpawnPosition } from './race-event-config';

const dt=1/120;
const prepared=safetyDrillFixtures.find(fixture=>fixture.spec.drill.family==='rapids')!.spec;
function setup(course=false,seed=0.42) {
  const runtime=new RaceEventRuntime({pickupContactRadius:RACE_CREATION_PICKUP_RADIUS});
  const race=new PracticeRace(course,()=>seed,runtime);
  // Isolate the human's natural fall through the prepared pickup and river.
  if(!course)for(const rival of race.racers.slice(1))rival.finishTime=0;
  let captures=0,requests=0,cancellations=0;
  const host=new RaceEventHost(race,{
    kind:'audio',async start(){captures++;},async stop(){return {blob:new Blob(['fake clip']),captureMs:500};},cancel(){cancellations++;},
  },{async generateAudio(){requests++;return prepared;}},()=>0.5);
  const step=()=>{
    const from=race.snapshot(race.racers[0]).position;
    race.step(dt,{x:0,z:0},false);
    host.step(dt,from,race.snapshot(race.racers[0]).position);
  };
  const activate=()=>{
    for(let tick=0;tick<1500&&runtime.getSnapshot().phase==='collectible';tick++)step();
    assert.equal(runtime.getSnapshot().phase,'active','normal falling must reach the prepared pickup');
    assert.equal(runtime.getSnapshot().triggererId,'0');
  };
  return {host,race,runtime,step,activate,captures:()=>captures,requests:()=>requests,cancellations:()=>cancellations};
}

test('a prepared no-voice drill uses normal placement, activates once, and changes real movement within its bounds',()=>{
  const game=setup(),player=game.race.racers[0];
  const before=game.race.snapshot(player);
  player.item='bubbleWrap';player.boostFuel=2;
  game.host.loadPreparedDrill(prepared);
  const spawned=game.runtime.getSnapshot();
  assert.equal(spawned.phase,'collectible');
  assert.deepEqual(spawned.position,raceEventSpawnPosition(before.position,before.fallSpeed,10));
  assert.ok(before.position[1]-spawned.position[1]>30,'prepared play must not use the 30 m development shortcut');
  assert.ok(spawned.instance!.pickupLifetimeSeconds!>=30&&spawned.instance!.pickupLifetimeSeconds!<=600);
  assert.equal(game.host.voice,undefined);assert.equal(game.host.opportunitiesRemaining,0);
  assert.equal(game.host.creations[0].source,'prepared');assert.equal(game.host.creations[0].attemptNumber,undefined);
  assert.equal(game.host.creations[0].status,'collectible');
  game.host.pause();assert.deepEqual(game.runtime.getSnapshot(),spawned,'pausing must preserve the placed drill');
  game.host.start();game.host.loop.collectVoice();game.host.loop.startRecording();
  game.activate();
  const active=game.runtime.getSnapshot();
  game.host.pause();assert.deepEqual(game.runtime.getSnapshot(),active,'pausing must preserve the active drill');
  game.host.start();
  let maximumFallSpeed=0;
  for(let tick=0;tick<1500&&game.runtime.getSnapshot().phase==='active';tick++){
    game.step();
    maximumFallSpeed=Math.max(maximumFallSpeed,game.race.snapshot(player).fallSpeed);
    assert.ok(player.controller.getWorldVelocity().every(Number.isFinite));
  }
  assert.equal(game.runtime.getSnapshot().phase,'expired');
  assert.ok(maximumFallSpeed>TERMINAL_SPEED+1,'the prepared current must accelerate the real player');
  assert.ok(maximumFallSpeed<=TERMINAL_SPEED+MAX_EXTERNAL_SPEED);
  const result=game.host.creations[0];
  assert.equal(result.status,'expired');assert.equal(result.snapshot?.triggererId,'0');
  assert.ok(result.snapshot!.impact!.drill!.currentSeconds['0']>0);
  assert.equal(player.item,'bubbleWrap');assert.equal(player.boostFuel,2,'the drill must not replace ordinary inventory or fuel');
  assert.equal(result.snapshot?.drill,undefined);assert.deepEqual(result.snapshot?.debris,[]);
  // Continue beyond the second voice-star window: this is exactly one prepared encounter.
  for(let tick=0;tick<20000&&-game.race.snapshot(player).position[1]<FINISH_DEPTH*0.71;tick++)game.step();
  assert.ok(-game.race.snapshot(player).position[1]>=FINISH_DEPTH*0.71);
  assert.equal(game.host.voice,undefined);assert.equal(game.host.creation,undefined);
  assert.equal(game.host.creations.length,1);assert.equal(game.host.creations[0],result);
  assert.equal(game.host.loop.getSnapshot().phase,'ended');
  assert.equal(game.captures(),0);assert.equal(game.requests(),0);game.host.dispose();
});

test('prepared selection rejects invalid data before changing voice or event state',()=>{
  const game=setup(),voice=game.host.voice,state=game.host.loop.getSnapshot();
  const invalid:SafetyDrillSpec={...prepared,id:''};
  assert.throws(()=>game.host.loadPreparedDrill(invalid));
  assert.equal(game.host.voice,voice);assert.equal(game.host.loop.getSnapshot(),state);
  assert.equal(game.runtime.getSnapshot().phase,'empty');assert.equal(game.host.creations.length,0);
  game.host.dispose();
});

test('duplicate prepared selection and selection after starting cannot replace a run encounter',()=>{
  const game=setup();game.host.loadPreparedDrill(prepared);
  const original=game.runtime.getSnapshot();
  assert.throws(()=>game.host.loadPreparedDrill(safetyDrillFixtures[0].spec),/before the race/);
  assert.deepEqual(game.runtime.getSnapshot(),original);assert.equal(game.host.creations.length,1);
  game.race.reset();game.host.reset();game.host.start();
  assert.throws(()=>game.host.loadPreparedDrill(prepared),/before the race/);
  assert.equal(game.runtime.getSnapshot().phase,'empty');assert.ok(game.host.voice);
  game.step();game.host.pause();
  assert.throws(()=>game.host.loadPreparedDrill(prepared),/before the race/);
  assert.equal(game.runtime.getSnapshot().phase,'empty');assert.equal(game.host.creations.length,0);
  game.host.dispose();
});

for(const phase of ['collectible','active'] as const)for(const action of ['reset','dispose'] as const)
  test(action+' clears the '+phase+' prepared drill and its run history',()=>{
    const game=setup();game.host.loadPreparedDrill(prepared);
    if(phase==='active')game.activate();
    assert.equal(game.runtime.getSnapshot().phase,phase);
    if(action==='reset'){game.race.reset();game.host.reset();}
    else game.host.dispose();
    assert.equal(game.runtime.getSnapshot().phase,'empty');assert.equal(game.host.creation,undefined);
    assert.equal(game.host.creations.length,0);
    if(action==='reset'){
      assert.ok(game.host.voice);assert.equal(game.host.loop.getSnapshot().phase,'available');
      game.host.start();game.step();assert.equal(game.runtime.getSnapshot().phase,'empty');
      game.host.dispose();
    }
    assert.equal(game.captures(),0);assert.equal(game.requests(),0);
  });

test('the authored blocked seed still starts a prepared drill at normal depth without changing obstacles or voice placement',()=>{
  const game=setup(true,23935/4294967296);
  const obstacles=structuredClone(game.race.obstacles);
  assert.throws(()=>eventPlacement(game.race),/No clear, reachable space/,'this seed blocks all normal player-relative candidates');
  game.host.loadPreparedDrill(prepared);
  const event=game.runtime.getSnapshot(),position=event.position;
  assert.equal(event.phase,'collectible');assert.equal(position[1],-240);
  assert.ok(Math.abs(position[0])+RACE_CREATION_PICKUP_RADIUS<=LANE_HALF_WIDTH);
  assert.ok(Math.abs(position[2])+RACE_CREATION_PICKUP_RADIUS<=LANE_HALF_WIDTH);
  assert.ok(game.race.obstacles.every(obstacle=>
    Math.abs(obstacle.position[1]-position[1])>(obstacle.kind==='duct'?30:12)||
    Math.hypot(obstacle.position[0]-position[0],obstacle.position[2]-position[2])>(obstacle.kind==='duct'?19:10)),
  'the fallback keeps the authored obstacle clearance');
  assert.deepEqual(game.race.obstacles,obstacles);
  assert.equal(game.race.elapsed,0);assert.equal(game.host.voice,undefined);
  assert.equal(game.host.loop.getSnapshot().phase,'ended');
  assert.equal(game.host.creations.length,1);assert.equal(game.host.creations[0].source,'prepared');
  assert.equal(game.captures(),0);assert.equal(game.requests(),0);game.host.dispose();
});

test('a fully obstructed prepared placement fails without changing setup or releasing prepared input',()=>{
  const game=setup();
  for(let x=-36;x<=36;x+=6)for(let z=-36;z<=36;z+=6)game.race.obstacles.push({
    id:game.race.obstacles.length,kind:'crate',position:[x,-240,z],rotation:[0,0,0],active:true,hitAt:-1,
  });
  const state=game.host.loop.getSnapshot(),voice=game.host.voice,opportunity=game.host.getSnapshot();
  const obstacles=structuredClone(game.race.obstacles),cancellations=game.cancellations();
  assert.throws(()=>game.host.loadPreparedDrill(prepared),/No clear, reachable space/);
  assert.equal(game.host.loop.getSnapshot(),state);assert.equal(game.host.voice,voice);
  assert.equal(game.host.getSnapshot(),opportunity);assert.equal(game.host.opportunitiesRemaining,1);
  assert.equal(game.cancellations(),cancellations);
  assert.equal(game.runtime.getSnapshot().phase,'empty');assert.equal(game.host.creations.length,0);
  assert.deepEqual(game.race.obstacles,obstacles);
  assert.equal(game.captures(),0);assert.equal(game.requests(),0);
  game.race.obstacles=[];game.host.loadPreparedDrill(prepared);
  assert.equal(game.runtime.getSnapshot().phase,'collectible','setup remains usable after a placement failure');
  game.host.dispose();
});
