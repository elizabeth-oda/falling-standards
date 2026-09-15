import test from 'node:test';
import assert from 'node:assert/strict';
import { authoredRaceReport, safetyDrillFixtures, type RaceReportRequest, type RaceReportResponse } from '@sky/shared';
import { emptyDrillImpact } from '../race-events/drill-mechanics';
import { RaceEventRuntime } from '../race-events/runtime';
import { PracticeRace } from './practice-race';
import { RaceReportController } from './race-report-controller';
import { raceReportInput } from './race-report-input';
import type { RaceCreationRecord } from './race-creation-history';

const fixture=safetyDrillFixtures.find(item=>item.spec.drill.family==='pinball')!.spec;
function record(id='event-1',status:RaceCreationRecord['status']='expired'):RaceCreationRecord {
  const runtime=new RaceEventRuntime();
  runtime.spawn({instanceId:id,creatorId:'0',spec:fixture,seed:12,position:[0,-100,0]});
  const snapshot=runtime.getSnapshot();
  return {instanceId:id,spec:fixture,source:'voice',status,snapshot:{...snapshot,phase:status==='active'?'active':'expired',
    triggererId:'1',expirationReason:status==='active'?undefined:'complete',
    impact:{...snapshot.impact!,drill:{...emptyDrillImpact(),bounces:{'0':5,'1':2}}}}};
}
const race=()=>new PracticeRace(false);
const reply=(request:RaceReportRequest):RaceReportResponse=>({runId:request.input.runId,creationId:request.input.creationId,
  inputFingerprint:request.inputFingerprint,attemptId:request.paidAttempt?.id??null,report:authoredRaceReport(request.input)});
async function until(predicate:()=>boolean) {
  for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(predicate(),'expected report state to settle');
}
function deferred() {
  const calls:Array<{request:RaceReportRequest;signal:AbortSignal;resolve:(response:RaceReportResponse)=>void;reject:(error:Error)=>void}>=[];
  const controller=new RaceReportController((request,signal)=>new Promise((resolve,reject)=>calls.push({request,signal,resolve,reject})));
  return {controller,calls};
}

test('an event dispatches before the race ends, once per event and with a distinct paid attempt',async()=>{
  const {controller,calls}=deferred(),game=race();
  controller.begin('live',true);
  controller.observe([record('first','active')],game.racers,false);
  assert.equal(calls.length,0);
  controller.observe([record('first')],game.racers,false);
  await until(()=>calls.length===1);
  assert.equal(game.finished,false);
  assert.equal(calls[0].request.input.creationId,'first');
  for(let i=0;i<5;i++)controller.observe([record('first')],game.racers,false);
  assert.equal(calls.length,1);
  calls[0].resolve(reply(calls[0].request));
  await until(()=>controller.getSnapshot().first.status==='complete');
  controller.observe([record('first'),record('second')],game.racers,false);
  await until(()=>calls.length===2);
  assert.equal(calls[1].request.input.runId,calls[0].request.input.runId);
  assert.notEqual(calls[1].request.paidAttempt?.id,calls[0].request.paidAttempt?.id);
  calls[1].resolve(reply(calls[1].request));
  await until(()=>controller.getSnapshot().second.status==='complete');
  assert.equal(controller.getSnapshot().first.source,'ai');
  assert.match(controller.getSnapshot().first.highlights.join(' '),/5/);
  controller.dispose();
});

test('voice work defers first report submission; queued reports serialize and pausing never retries',async()=>{
  const {controller,calls}=deferred(),game=race();
  controller.begin('live',true);
  controller.observe([record()],game.racers,true);
  assert.equal(calls.length,0);
  assert.equal(controller.getSnapshot()['event-1'].status,'pending');
  controller.observe([record(),record('event-2')],game.racers,false);
  await until(()=>calls.length===1);
  assert.equal(controller.liveRequestPending,true);
  controller.pause();
  assert.equal(calls[0].signal.aborted,true);
  controller.resume();
  calls[0].resolve(reply(calls[0].request));
  await until(()=>!controller.liveRequestPending);
  controller.observe([record(),record('event-2')],game.racers,false);
  assert.equal(calls.length,1);
  assert.equal(controller.getSnapshot()['event-1'].status,'unavailable');
  assert.equal(controller.getSnapshot()['event-2'].status,'unavailable');
  controller.dispose();
});

test('no live consent and discarded creations retain authored reports without calls; fixtures and no-voice drills stay local',async()=>{
  const {controller,calls}=deferred(),game=race();
  controller.begin('live',false);
  controller.observe([record()],game.racers,false);
  assert.equal(controller.getSnapshot()['event-1'].source,'authored');
  assert.equal(controller.getSnapshot()['event-1'].status,'complete');
  assert.equal(calls.length,0);
  controller.begin('live',true);
  controller.observe([{instanceId:'discarded',spec:fixture,source:'voice',status:'discarded'}],game.racers,false);
  assert.equal(calls.length,0);
  assert.equal(controller.getSnapshot().discarded.status,'complete');
  for(const source of ['fixture','prepared'] as const) {
    controller.observe([{...record(source),source}],game.racers,false);
    assert.equal(controller.liveRequestPending,false);
    await until(()=>controller.getSnapshot()[source].status==='complete');
    assert.equal(controller.getSnapshot()[source].source,'mock');
    assert.equal(calls.length,0,'No provider/client calls for '+source+' with live mode and report consent selected');
  }
  controller.dispose();
});

test('reset rejects late results and old run identities, while a fresh run can report again',async()=>{
  const {controller,calls}=deferred(),game=race();
  controller.begin('live',true);controller.observe([record()],game.racers,false);
  await until(()=>calls.length===1);
  controller.reset();
  assert.equal(calls[0].signal.aborted,true);
  controller.begin('live',true);controller.observe([record()],game.racers,false);
  await until(()=>calls.length===2);
  assert.notEqual(calls[0].request.input.runId,calls[1].request.input.runId);
  calls[0].resolve(reply(calls[0].request));
  calls[1].resolve(reply(calls[0].request));
  await until(()=>controller.getSnapshot()['event-1'].status==='unavailable');
  assert.equal(controller.getSnapshot()['event-1'].source,'authored');
  controller.observe([record()],game.racers,false);
  assert.equal(calls.length,2);
  controller.dispose();
});

test('bad evidence and failed responses keep factual fallback without resubmission',async()=>{
  for(const failure of ['unknown-evidence','provider'] as const) {
    const {controller,calls}=deferred(),game=race();
    controller.begin('live',true);controller.observe([record()],game.racers,false);
    await until(()=>calls.length===1);
    if(failure==='provider')calls[0].reject(new Error('private provider detail'));
    else {
      const result=reply(calls[0].request);
      calls[0].resolve({...result,report:{...result.report,evidenceIds:['other-event.fact']}});
    }
    await until(()=>controller.getSnapshot()['event-1'].status==='unavailable');
    assert.doesNotMatch(JSON.stringify(controller.getSnapshot()),/private provider detail|other-event/);
    controller.observe([record()],game.racers,false);
    assert.equal(calls.length,1);
    controller.dispose();
  }
});

test('input freezes the selected personnel mapping and excludes private/generated payloads',()=>{
  const game=race();game.selectCharacter('susan');
  const input=raceReportInput(record(),game.racers,crypto.randomUUID())!;
  assert.ok(input);
  assert.deepEqual(input.racers.map(racer=>racer.characterId),['susan','greg','linda','steve']);
  assert.equal(input.racers[0].racerId,'0');
  assert.doesNotMatch(JSON.stringify(input),/appearance|vertices|transcript|audio|position/);
  assert.equal(raceReportInput(record('active','active'),game.racers,crypto.randomUUID()),undefined);
});


test('reconstruction forwards the measured echo count to its report evidence',()=>{
  const spec=safetyDrillFixtures.find(item=>item.spec.drill.family==='reconstruction')!.spec;
  const creation=record('echoes');
  const snapshot=creation.snapshot!;
  const input=raceReportInput({...creation,spec,snapshot:{...snapshot,impact:{...snapshot.impact!,
    drill:{...emptyDrillImpact(),reactions:9}}}},race().racers,crypto.randomUUID());
  assert.ok(input);
  assert.equal(input.reactions,9);
});
