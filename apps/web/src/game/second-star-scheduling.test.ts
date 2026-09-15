import test from 'node:test';
import assert from 'node:assert/strict';
import { safetyDrillFixtures, type RaceEncounter } from '@sky/shared';
import { PracticeRace, FINISH_DEPTH } from './practice-race';
import { RaceEventHost } from './race-event-host';
import { RACE_CREATION_PICKUP_RADIUS } from './race-event-config';
import { RaceEventRuntime } from '../race-events/runtime';

const dt=1/120;
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const hippos=safetyDrillFixtures.find(item=>item.spec.drill.family==='stampede')!.spec;

/** Empty-course integration run with real movement, capture timing, and generation timing. */
function fullRun(boost=false,starRandom:()=>number=()=>.5) {
  const race=new PracticeRace(false,()=>.42,new RaceEventRuntime({pickupContactRadius:RACE_CREATION_PICKUP_RADIUS}));
  let captureStarted=0,captureCount=0,boostGranted=false;
  const requests:Array<{signal:AbortSignal;resolve:(spec:RaceEncounter)=>void;reject:(error:Error)=>void;started:number}>=[];
  const captureDurations:number[]=[];
  const offered:Array<{elapsed:number;depth:number;lead:number;fallSpeed:number}>=[];
  const activated=new Set<string>();
  const host=new RaceEventHost(race,{
    kind:'audio',async start(){captureStarted=race.elapsed;captureCount++;},
    async stop(){const captureMs=Math.round((race.elapsed-captureStarted)*1000);captureDurations.push(captureMs);return {blob:new Blob(['mock audio']),captureMs};},cancel(){},
  },{async generateAudio(_,options){
    options.onProgress?.('generating','Creating mock drill');
    return new Promise((resolve,reject)=>requests.push({signal:options.signal,resolve,reject,started:race.elapsed}));
  }},starRandom);
  host.start();
  const step=()=>{
    const from=race.snapshot(race.racers[0]).position;
    if(boost&&!boostGranted&&-from[1]>=2000){race.racers[0].boostFuel=4;boostGranted=true;}
    race.step(dt,{x:0,z:0},false,boost);
    host.step(dt,from,race.snapshot(race.racers[0]).position);
    const event=race.events!.getSnapshot();
    if(event.phase==='active')activated.add(event.instance!.instanceId);
    if(host.getSnapshot().secondStar==='offered'&&offered.length===0){
      const player=race.snapshot(race.racers[0]);
      assert.ok(host.voice);offered.push({elapsed:race.elapsed,depth:-host.voice.position[1],lead:player.position[1]-host.voice.position[1],fallSpeed:player.fallSpeed});
    }
  };
  const seconds=(duration:number)=>{for(let tick=0;tick<Math.round(duration/dt);tick++)step();};
  const until=(condition:()=>boolean,label:string)=>{
    for(let tick=0;tick<20000&&!condition()&&race.racers[0].finishTime===undefined;tick++)step();
    assert.ok(condition(),label+' before landing');
  };
  const record=async()=>{
    seconds(1);host.loop.startRecording();await flush();
    assert.equal(host.loop.getSnapshot().phase,'recording');seconds(8);
    const pending=host.loop.finishRecording();await flush();
    assert.ok(requests.length>0,'request dispatched after the full recording');
    return {pending,request:requests.at(-1)!};
  };
  return {race,host,requests,offered,activated,captureDurations,seconds,until,record,captureCount:()=>captureCount};
}

for(const boost of [false,true])for(const outcome of ['success','failure','timeout'] as const){
  test('a full '+(boost?'boosted':'normal-speed')+' run offers and collects the second star after first '+outcome,async()=>{
    const game=fullRun(boost);
    game.until(()=>game.host.loop.getSnapshot().phase==='prompted','natural first-star pickup');
    assert.ok(game.race.elapsed>7,'first-star travel consumes real gameplay time');
    const first=await game.record();
    game.seconds(outcome==='timeout'?30:1.6);
    if(outcome==='success')first.request.resolve(hippos);
    else first.request.reject(new Error(outcome==='timeout'?'Generation deadline exceeded.':'Simulated provider failure.'));
    await first.pending;await flush();
    if(outcome==='success'){
      game.until(()=>game.activated.size===1,'natural swept contact with the first generated drill');
      assert.equal(game.race.events!.getSnapshot().instance!.spec.version,4);
      game.until(()=>game.race.events!.getSnapshot().phase==='expired','first effect expiration');
    }else assert.equal(game.host.loop.getSnapshot().phase,'failed');
    assert.equal(game.offered.length,0,'first outcome must not schedule an early second star');
    game.until(()=>game.offered.length===1,'independent second-star reveal');
    const offer=game.offered[0];
    assert.ok(Math.abs(offer.depth-FINISH_DEPTH*.65)<1e-8);assert.ok(offer.depth>=FINISH_DEPTH*.6&&offer.depth<=FINISH_DEPTH*.7);
    assert.ok(offer.elapsed>60,'success or failure must not move the second star back to the first encounter');
    assert.ok(offer.lead>=(boost?230:119)&&offer.lead<=(boost?240:120));
    if(boost)assert.ok(offer.fallSpeed>59,'reveal is verified during a real fuel-funded boost');
    assert.equal(game.requests.length,1,'revealing the star must not dispatch another request');
    game.until(()=>game.host.attemptNumber===2,'natural second-star pickup');
    assert.equal(game.host.loop.getSnapshot().phase,'prompted');
    assert.equal(game.host.getSnapshot().secondStar,'consumed');
    const second=await game.record();game.seconds(1.6);second.request.resolve(hippos);await second.pending;await flush();
    assert.notEqual(first.request.signal,second.request.signal);
    game.until(()=>game.host.loop.getSnapshot().phase==='spawned','second creation placement');
    assert.equal(game.host.creation!.spec.id,hippos.id);
    game.until(()=>game.race.racers[0].finishTime!==undefined,'normal landing');
    assert.equal(game.requests.length,2);assert.equal(game.captureCount(),2);
    assert.deepEqual(game.captureDurations,[8000,8000]);
    assert.equal(game.offered.length,1);assert.equal(game.host.voice,undefined);
    game.host.dispose();
  });
}

test('missing the first yellow star still gives the authored second opportunity through real movement',()=>{
  const game=fullRun();
  // Steer away before reaching the first star using the same movement input as
  // gameplay, then resume a straight fall; do not report a synthetic miss.
  for(let tick=0;tick<120;tick++){
    const from=game.race.snapshot(game.race.racers[0]).position;
    game.race.step(dt,{x:1,z:0},false);
    game.host.step(dt,from,game.race.snapshot(game.race.racers[0]).position);
  }
  game.until(()=>game.host.loop.getSnapshot().phase==='missed','first-star miss');
  game.until(()=>game.offered.length===1,'second-star reveal after a missed first star');
  game.until(()=>game.host.attemptNumber===2,'natural second-star pickup');
  assert.equal(game.host.loop.getSnapshot().phase,'prompted');
  assert.equal(game.requests.length,0);assert.equal(game.captureCount(),0);game.host.dispose();
});

for(const random of [0,.5,1-Number.EPSILON])test('independent second-star placement remains in its authored 60-70% band for random '+random,()=>{
  const game=fullRun(false,()=>random);
  game.until(()=>game.host.loop.getSnapshot().phase==='prompted','first-star pickup');
  game.host.pause();
  game.until(()=>game.offered.length===1,'second-star reveal');
  const depth=game.offered[0].depth;
  assert.ok(depth>=FINISH_DEPTH*.6&&depth<=FINISH_DEPTH*.7);
  assert.ok(Math.abs(depth-FINISH_DEPTH*(.6+.1*random))<1e-8);
  assert.equal(game.requests.length,0);game.host.dispose();
});
