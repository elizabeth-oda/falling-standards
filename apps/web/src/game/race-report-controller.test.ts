import test from 'node:test';
import assert from 'node:assert/strict';
import { authoredRaceReport, safetyDrillFixtures, type RaceReportRequest, type RaceReportResponse } from '@sky/shared';
import { emptyDrillImpact } from '../race-events/drill-mechanics';
import { RaceEventRuntime } from '../race-events/runtime';
import { PracticeRace } from './practice-race';
import { RaceReportController } from './race-report-controller';
import { raceReportInput } from './race-report-input';
import type { RaceCreationRecord } from './race-creation-history';

const fixture = safetyDrillFixtures.find(item => item.spec.drill.family === 'pinball')!.spec;
function record(id = 'event-1', status: RaceCreationRecord['status'] = 'expired', bounces = 5): RaceCreationRecord {
  const runtime = new RaceEventRuntime();
  runtime.spawn({instanceId: id, creatorId: '0', spec: fixture, seed: 12, position: [0, -100, 0]});
  const snapshot = runtime.getSnapshot();
  return {instanceId: id, spec: fixture, source: 'voice', status, snapshot: {...snapshot,
    phase: status === 'active' ? 'active' : 'expired', elapsedSeconds: status === 'active' ? 0 : 10, triggererId: '1',
    expirationReason: status === 'active' ? undefined : 'complete',
    impact: {...snapshot.impact!, drill: {...emptyDrillImpact(), bounces: {'0': bounces, '1': 2}}}}};
}
const race = () => new PracticeRace(false);
const finish = (game: PracticeRace) => game.racers.forEach(racer => { racer.finishTime = 10; });
const discarded = (id = 'second'): RaceCreationRecord => ({instanceId: id, spec: fixture, source: 'voice', status: 'discarded'});
const reply = (request: RaceReportRequest): RaceReportResponse => ({runId: request.inputs[0].runId,
  inputFingerprint: request.inputFingerprint, attemptId: request.paidAttempt?.id ?? null,
  items: request.inputs.map(input => ({creationId: input.creationId, ...authoredRaceReport(input)}))});
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'expected report state to settle');
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  const calls: Array<{request: RaceReportRequest; signal: AbortSignal;
    resolve: (response: RaceReportResponse) => void; reject: (error: Error) => void}> = [];
  const controller = new RaceReportController((request, signal) => new Promise((resolve, reject) => calls.push({request, signal, resolve, reject})));
  return {controller, calls};
}

test('reports wait for all racers, final creation snapshots and voice cleanup, then batch the entire run once', async () => {
  const {controller, calls} = deferred(), game = race();
  controller.begin('live', true, game.racers);
  controller.observe([record('first', 'active')], game.racers, false);
  assert.equal(controller.getSnapshot().first.status, 'provisional');
  game.racers[0].finishTime = 8;
  controller.observe([record('first')], game.racers, false);
  assert.equal(controller.getSnapshot().first.status, 'provisional', 'expired earlier events remain provisional while rivals race');
  assert.match(controller.getSnapshot().first.highlights.join(' '), /5/);
  assert.equal(calls.length, 0);
  finish(game);
  controller.observe([record('first'), {...discarded(), status: 'ready'}], game.racers, false);
  await flush(); assert.equal(calls.length, 0, 'wait until the final creation is retained as discarded');
  const records = [record('first'), discarded()];
  controller.observe(records, game.racers, true);
  await flush(); assert.equal(calls.length, 0, 'voice cleanup must finish before report work begins');
  controller.observe(records, game.racers, false);
  for (let i = 0; i < 10; i++) controller.observe([...records].reverse(), game.racers, false);
  await until(() => calls.length === 1);
  assert.deepEqual(calls[0].request.inputs.map(input => input.creationId), ['first', 'second']);
  assert.equal(calls[0].request.inputs[1].outcome, 'discarded');
  assert.notEqual(calls[0].request.inputs[0].runId, calls[0].request.paidAttempt?.id);
  assert.equal(controller.getSnapshot().first.status, 'pending');
  assert.equal(controller.getSnapshot().second.status, 'pending');
  calls[0].resolve(reply(calls[0].request));
  await until(() => controller.getSnapshot().second.status === 'complete');
  assert.equal(controller.getSnapshot().first.source, 'ai');
  for (let i = 0; i < 10; i++) controller.observe(records, game.racers, false);
  assert.equal(calls.length, 1, 'dialog-equivalent reads and repeated effects never resubmit');
  controller.dispose();
});

test('mock reports are deterministic and batched without paid metadata', async () => {
  const {controller, calls} = deferred(), game = race();
  controller.begin('mock', false); finish(game);
  controller.observe([record(), discarded()], game.racers, false);
  await until(() => calls.length === 1);
  assert.equal(calls[0].request.mode, 'mock');
  assert.equal(calls[0].request.paidAttempt, undefined);
  calls[0].resolve(reply(calls[0].request));
  await until(() => controller.getSnapshot()['event-1'].status === 'complete');
  assert.equal(controller.getSnapshot()['event-1'].source, 'mock');
  controller.dispose();
});

test('unconsented live runs, empty runs, fixtures and prepared drills never call the client', async () => {
  for (const source of ['voice', 'fixture', 'prepared'] as const) {
    const {controller, calls} = deferred(), game = race();
    controller.begin('live', source !== 'voice', game.racers); finish(game);
    controller.observe([], game.racers, false);
    controller.observe([{...record(), source}], game.racers, false);
    await flush();
    assert.equal(calls.length, 0, source);
    assert.equal(controller.getSnapshot()['event-1'].status, 'complete');
    assert.equal(controller.getSnapshot()['event-1'].source, source === 'voice' ? 'authored' : 'mock');
    controller.dispose();
  }
});

test('mixed fixture and voice histories include only voice creations in the report request', async () => {
  const {controller, calls} = deferred(), game = race();
  controller.begin('live', true); finish(game);
  controller.observe([record(), {...record('prepared'), source: 'prepared'}], game.racers, false);
  await until(() => calls.length === 1);
  assert.deepEqual(calls[0].request.inputs.map(input => input.creationId), ['event-1']);
  assert.equal(controller.getSnapshot().prepared.source, 'mock');
  calls[0].resolve(reply(calls[0].request));
  await until(() => controller.getSnapshot()['event-1'].status === 'complete');
  controller.dispose();
});

test('report consent can be revoked before dispatch and cannot be restored inside the same run', async () => {
  const {controller, calls} = deferred(), game = race();
  controller.begin('live', true); controller.observe([record()], game.racers, false);
  controller.setConsent(false); controller.setConsent(true); finish(game);
  controller.observe([record()], game.racers, false);
  await flush(); assert.equal(calls.length, 0);
  controller.dispose();
});

for (const action of ['pause', 'revoke'] as const) test(action + ' aborts the whole pending batch without a retry', async () => {
  const {controller, calls} = deferred(), game = race();
  controller.begin('live', true); finish(game);
  const records = [record(), discarded()];
  controller.observe(records, game.racers, false);
  await until(() => calls.length === 1);
  if (action === 'pause') controller.pause(); else controller.setConsent(false);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(controller.liveRequestPending, false);
  controller.resume();
  calls[0].resolve(reply(calls[0].request));
  await flush();
  controller.observe(records, game.racers, false);
  assert.equal(controller.getSnapshot()['event-1'].status, 'unavailable');
  assert.equal(controller.getSnapshot().second.status, 'unavailable');
  assert.equal(calls.length, 1);
  controller.dispose();
});

test('pause during fingerprinting prevents dispatch, and normal in-race pause does not consume reporting', async () => {
  const {controller, calls} = deferred(), game = race();
  controller.begin('live', true); controller.pause(); controller.resume(); finish(game);
  controller.observe([record()], game.racers, false); controller.pause(); controller.resume();
  await flush(); controller.observe([record()], game.racers, false);
  await flush(); assert.equal(calls.length, 0);
  assert.equal(controller.getSnapshot()['event-1'].status, 'unavailable');
  controller.dispose();
});

test('reset and disposal reject late responses while a new run gets distinct run and attempt IDs', async () => {
  const {controller, calls} = deferred(), game = race(); finish(game);
  controller.begin('live', true); controller.observe([record()], game.racers, false);
  await until(() => calls.length === 1);
  controller.reset(); assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(controller.getSnapshot(), {});
  controller.begin('live', true); controller.observe([record()], game.racers, false);
  await until(() => calls.length === 2);
  assert.notEqual(calls[0].request.inputs[0].runId, calls[1].request.inputs[0].runId);
  assert.notEqual(calls[0].request.paidAttempt?.id, calls[1].request.paidAttempt?.id);
  calls[0].resolve(reply(calls[0].request)); await flush();
  assert.equal(controller.getSnapshot()['event-1'].status, 'pending');
  calls[1].resolve(reply(calls[0].request));
  await until(() => controller.getSnapshot()['event-1'].status === 'unavailable');
  controller.dispose(); assert.deepEqual(controller.getSnapshot(), {});
});

test('changed final counters or added creations invalidate the whole batch and never submit replacements', async () => {
  for (const change of ['counter', 'added'] as const) {
    const {controller, calls} = deferred(), game = race(); finish(game);
    controller.begin('live', true); controller.observe([record()], game.racers, false);
    await until(() => calls.length === 1);
    const changed = change === 'counter' ? [record('event-1', 'expired', 9)] : [record(), discarded()];
    controller.observe(changed, game.racers, false);
    assert.equal(calls[0].signal.aborted, true);
    calls[0].resolve(reply(calls[0].request)); await flush();
    assert.equal(controller.getSnapshot()['event-1'].status, 'unavailable');
    if (change === 'counter') assert.match(controller.getSnapshot()['event-1'].highlights.join(' '), /9/);
    controller.observe(changed, game.racers, false);
    assert.equal(calls.length, 1);
    controller.dispose();
  }
});

for (const failure of ['unknown-evidence', 'cross-item', 'duplicate-evidence', 'missing-item', 'duplicate-item', 'foreign-item',
  'run', 'attempt', 'fingerprint', 'provider'] as const) test('invalid response ' + failure + ' leaves the whole batch authored', async () => {
  const {controller, calls} = deferred(), game = race(); finish(game);
  controller.begin('live', true); controller.observe([record(), discarded()], game.racers, false);
  await until(() => calls.length === 1);
  const result = reply(calls[0].request);
  result.items[0].headline = 'SHOULD NEVER BE DISPLAYED';
  if (failure === 'provider') calls[0].reject(new Error('private provider detail'));
  else {
    if (failure === 'unknown-evidence') result.items[1].evidenceIds = ['second:unknown'];
    if (failure === 'cross-item') result.items[1].evidenceIds = result.items[0].evidenceIds;
    if (failure === 'duplicate-evidence') result.items[1].evidenceIds = [result.items[1].evidenceIds[0], result.items[1].evidenceIds[0]];
    if (failure === 'missing-item') result.items.pop();
    if (failure === 'duplicate-item') result.items[1] = result.items[0];
    if (failure === 'foreign-item') result.items[1].creationId = 'foreign';
    if (failure === 'run') result.runId = crypto.randomUUID();
    if (failure === 'attempt') result.attemptId = crypto.randomUUID();
    if (failure === 'fingerprint') result.inputFingerprint = 'a'.repeat(64);
    calls[0].resolve(result);
  }
  await until(() => controller.getSnapshot().second.status === 'unavailable');
  assert.equal(controller.getSnapshot()['event-1'].source, 'authored');
  assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /private provider|SHOULD NEVER BE DISPLAYED|unknown/);
  controller.observe([record(), discarded()], game.racers, false);
  assert.equal(calls.length, 1); controller.dispose();
});

test('the personnel mapping freezes at run start and input omits private and generated payloads', async () => {
  const {controller, calls} = deferred(), game = race();
  game.selectCharacter('susan'); controller.begin('live', true, game.racers);
  game.selectCharacter('greg'); finish(game);
  controller.observe([record()], game.racers, false);
  await until(() => calls.length === 1);
  const input = calls[0].request.inputs[0];
  assert.deepEqual(input.racers.map(racer => racer.characterId), ['susan', 'greg', 'linda', 'steve']);
  assert.doesNotMatch(JSON.stringify(input), /appearance|vertices|transcript|audio|position/);
  calls[0].resolve(reply(calls[0].request)); await until(() => controller.getSnapshot()['event-1'].status === 'complete');
  controller.dispose();
  assert.equal(raceReportInput(record('active', 'active'), game.racers, crypto.randomUUID()), undefined);
});

test('reconstruction forwards measured echo counts to report evidence', () => {
  const spec = safetyDrillFixtures.find(item => item.spec.drill.family === 'reconstruction')!.spec;
  const creation = record('echoes'), snapshot = creation.snapshot!;
  const input = raceReportInput({...creation, spec, snapshot: {...snapshot, impact: {...snapshot.impact!,
    drill: {...emptyDrillImpact(), reactions: 9}}}}, race().racers, crypto.randomUUID());
  assert.ok(input); assert.equal(input.reactions, 9);
});

test('a final landing before the effect duration is recorded as interrupted, not completed', () => {
  const creation = record();
  const input = raceReportInput({...creation, snapshot: {...creation.snapshot!, elapsedSeconds: 0.5}}, race().racers, crypto.randomUUID());
  assert.ok(input); assert.equal(input.outcome, 'interrupted');
  assert.equal(raceReportInput(creation, race().racers, crypto.randomUUID())?.outcome, 'complete');
});
