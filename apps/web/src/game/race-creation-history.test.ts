import test from 'node:test';
import assert from 'node:assert/strict';
import { raceEventFixtures, safetyDrillFixtures, type RaceEncounter } from '@sky/shared';
import { RaceEventRuntime } from '../race-events/runtime';
import { FreefallController } from './freefall-controller';
import { PracticeRace, FINISH_DEPTH } from './practice-race';
import { RaceEventHost } from './race-event-host';
import { RACE_CREATION_PICKUP_RADIUS, raceVoiceStarLeadMeters } from './race-event-config';

const dt = 1 / 120;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const drill = safetyDrillFixtures[0].spec;
const sun = raceEventFixtures.find(fixture => fixture.spec.effect.type === 'repulsionBurst')!.spec;

function setup() {
  const runtime = new RaceEventRuntime({ pickupContactRadius: RACE_CREATION_PICKUP_RADIUS });
  const race = new PracticeRace(false, () => 0.42, runtime);
  const requests: Array<{ resolve: (spec: RaceEncounter) => void; signal: AbortSignal }> = [];
  const host = new RaceEventHost(race, {
    kind: 'audio', async start() {},
    async stop() { return { blob: new Blob(['fake audio']), captureMs: 500 }; }, cancel() {},
  }, {
    generateAudio: async (_, options) => {
      options.onProgress('generating', 'Creating…', 'private test transcript');
      return new Promise(resolve => requests.push({ resolve, signal: options.signal }));
    },
  }, () => 0.5);
  host.start();
  const step = (seconds = dt) => {
    for (let tick = 0; tick < Math.round(seconds / dt); tick++) {
      const from = race.snapshot(race.racers[0]).position;
      race.step(dt, { x: 0, z: 0 }, false);
      host.step(dt, from, race.snapshot(race.racers[0]).position);
    }
  };
  const place = (id: number, x: number, depth: number, z = 0) => {
    const racer = race.racers[id];
    racer.controller = new FreefallController(36, x, z);
    racer.controller.setFallSpeed(30);
    racer.controller.step(depth / 30, { x: 0, z: 0 }, { fallSpeedMultiplier: 1 });
    racer.decision = Infinity; racer.nextUse = Infinity; racer.target = [x, z];
  };
  // These tests isolate inspection-history ownership. Full-run star timing is
  // covered separately; move only the player to the deterministic reveal point.
  const revealSecondStar = () => {
    place(0, 0, FINISH_DEPTH * 0.65 - raceVoiceStarLeadMeters(30) + 1);
    step();
    assert.ok(host.voice, 'the second star is offered at its authored course position');
    assert.ok(Math.abs(host.voice.position[1] + FINISH_DEPTH * 0.65) < 1e-8);
    assert.equal(host.attemptNumber, 1, 'an offer does not rearm or replace the first attempt');
  };
  const request = async () => {
    assert.ok(host.voice, 'a fresh voice star is required');
    const [x, y, z] = host.voice.position;
    host.step(dt, [x, y + 4, z], [x, y - 4, z]);
    host.loop.startRecording(); await flush();
    const pending = host.loop.finishRecording(); await flush();
    return { pending, ...requests.at(-1)! };
  };
  const generate = async (spec: RaceEncounter, reveal = true) => {
    const pending = await request(); pending.resolve(spec); await pending.pending;
    if (reveal) step(2.1);
  };
  const trigger = (id = 1) => {
    const [x, y, z] = host.creation!.position;
    place(id, x, -y - RACE_CREATION_PICKUP_RADIUS + 0.1, z); step();
    assert.equal(runtime.getSnapshot().triggererId, String(id));
  };
  return { host, runtime, race, step, place, revealSecondStar, request, generate, trigger };
}

test('both authored creations retain their own validated model and cumulative results after slot replacement', async () => {
  const game = setup();
  await game.generate(drill);
  assert.equal(game.host.creations[0].status, 'collectible');
  game.trigger(); game.step(10.1);
  const first = game.host.creations[0];
  assert.equal(first.status, 'expired');
  assert.equal(first.snapshot?.triggererId, '1');
  assert.deepEqual(first.snapshot?.impact, game.runtime.getSnapshot().impact);
  assert.equal(first.snapshot?.drill, undefined);
  assert.deepEqual(first.snapshot?.debris, []);
  game.revealSecondStar();
  await game.generate(sun); game.trigger(); game.step(3);
  assert.equal(game.host.attemptNumber, 2);
  const records = game.host.creations;
  assert.equal(records.length, 2);
  assert.equal(records[0], first, 'replacing the runtime must leave the first inspection record intact');
  assert.notEqual(records[0].instanceId, records[1].instanceId);
  assert.deepEqual(records.map(record => record.attemptNumber), [1, 2]);
  assert.deepEqual(records.map(record => record.spec), [drill, sun]);
  assert.ok(Object.keys(records[1].snapshot!.impact!.impulseCounts).length > 0);
  assert.equal(JSON.stringify(records).includes('private test transcript'), false);
  assert.equal(JSON.stringify(records).includes('fake audio'), false);
  game.host.dispose();
});

test('an uncollected creation stays inspectable with its actual passed outcome and no invented impacts', async () => {
  const game = setup(); await game.generate(sun);
  const [, y] = game.host.creation!.position;
  game.race.racers.forEach(racer => game.place(racer.id, 34, -y + 25, 34)); game.step();
  const record = game.host.creations[0];
  assert.equal(record.status, 'expired');
  assert.equal(record.snapshot?.expirationReason, 'passed');
  assert.equal(record.snapshot?.triggererId, undefined);
  assert.deepEqual(record.snapshot?.impact?.affectedRacerIds, []);
  assert.deepEqual(record.snapshot?.impact?.impulseCounts, {});
  assert.deepEqual(record.spec, sun);
  game.host.dispose();
});

test('landing preserves a shared creation and later rival activation updates its inspection record', async () => {
  const game = setup(); await game.generate(sun);
  game.race.racers[0].finishTime = game.race.elapsed; game.step();
  assert.equal(game.host.creations[0].status, 'collectible');
  assert.equal(game.host.loop.getSnapshot().phase, 'ended');
  game.trigger(1); game.step(0.2);
  assert.equal(game.host.creations[0].status, 'active');
  assert.equal(game.host.creations[0].snapshot?.triggererId, '1');
  assert.ok(game.host.creations[0].snapshot?.impact?.affectedRacerIds.includes('1'));
  const impacts = game.host.creations[0].snapshot!.impact;
  game.race.racers.slice(1).forEach(racer => game.place(racer.id, 0, FINISH_DEPTH - 0.05));
  game.step();
  assert.equal(game.race.finished, true);
  assert.equal(game.runtime.getSnapshot().phase, 'empty');
  assert.equal(game.host.creations[0].status, 'expired');
  assert.equal(game.host.creations[0].snapshot?.expirationReason, 'complete');
  assert.deepEqual(game.host.creations[0].snapshot?.impact, impacts);
  game.host.dispose();
});

for (const action of ['pause', 'finish'] as const) test(action + ' retains a generated but undispatched creation as discarded', async () => {
  const game = setup(); await game.generate(drill, false);
  assert.equal(game.host.creations[0].status, 'ready');
  assert.equal(game.host.creations[0].snapshot, undefined);
  if (action === 'pause') game.host.pause();
  else { game.race.racers[0].finishTime = game.race.elapsed; game.step(); }
  assert.equal(game.host.creations[0].status, 'discarded');
  assert.match(game.host.creations[0].discardReason!, action === 'pause' ? /cancelled/i : /landed/i);
  assert.deepEqual(game.host.creations[0].spec, drill);
  assert.equal(game.host.creations[0].snapshot, undefined);
  game.host.loop.placeReadyCreation(); assert.equal(game.host.creation, undefined);
  game.host.dispose();
});

test('a queued second result is retained honestly without replacing the first record or an occupied event', async () => {
  const game = setup(); await game.generate(drill); game.trigger(); game.step(10.1);
  const first = game.host.creations[0];
  game.revealSecondStar();
  game.host.spawn(drill, 'occupied-slot'); game.trigger();
  await game.generate(sun);
  assert.equal(game.host.attemptNumber, 2);
  assert.equal(game.host.loop.getSnapshot().phase, 'ready');
  game.race.racers[0].finishTime = game.race.elapsed; game.step();
  assert.equal(game.host.creations.length, 2);
  assert.equal(game.host.creations[0], first);
  assert.equal(game.host.creations[1].status, 'discarded');
  assert.equal(game.host.creations[1].snapshot, undefined);
  assert.equal(game.host.creation?.instanceId, 'occupied-slot');
  game.host.dispose();
});

test('new runs and disposal clear inspection history while the existing last-result replay survives reset', async () => {
  const game = setup(); await game.generate(drill); game.trigger(); game.step(1);
  const previousReport = game.host.report!;
  game.race.reset(); game.host.reset();
  assert.equal(game.host.creations.length, 0);
  assert.equal(game.host.report?.instance?.spec.id, previousReport.instance?.spec.id);
  game.host.loadFixture(sun, true);
  assert.equal(game.host.creations.length, 1);
  assert.equal(game.host.creations[0].source, 'fixture');
  assert.equal(game.host.creations[0].attemptNumber, undefined);
  assert.equal(game.host.creations[0].status, 'collectible');
  game.trigger(); game.step(10.1); game.host.loadFixture(drill, true);
  assert.equal(game.host.creations.length, 1, 'development fixtures replace their single inspection preview');
  assert.equal(game.host.creations[0].spec.id, drill.id);
  game.host.dispose(); assert.equal(game.host.creations.length, 0);
});

test('a stale result arriving after reset cannot enter the next run history', async () => {
  const game = setup(); const pending = await game.request();
  game.race.reset(); game.host.reset(); game.host.start();
  pending.resolve(drill); await pending.pending; game.step(3);
  assert.equal(pending.signal.aborted, true);
  assert.equal(game.host.creations.length, 0);
  assert.equal(game.host.creation, undefined);
  game.host.dispose();
});

test('the final landing tick retains activation before clearing the runtime', () => {
  const game = setup();
  game.host.loadFixture(sun, true);
  const instance = game.runtime.getSnapshot().instance!;
  game.runtime.reset();
  game.runtime.spawn({ ...instance, position: [0, -FINISH_DEPTH, 0] });
  game.race.racers.slice(1).forEach(racer => { racer.finishTime = 0; });
  game.place(0, 0, FINISH_DEPTH - 0.05);
  game.step();
  assert.equal(game.race.finished, true);
  assert.equal(game.runtime.getSnapshot().phase, 'empty');
  assert.equal(game.host.creations[0].snapshot?.triggererId, '0');
  assert.equal(game.host.creations[0].snapshot?.expirationReason, 'complete');
  assert.deepEqual(game.host.report, game.host.creations[0].snapshot);
  assert.ok(game.race.racers.every(racer => !racer.eventObstacleProtection));
  game.race.reset();
  assert.equal(game.race.finalEventSnapshot, undefined);
  game.host.reset();
  assert.equal(game.host.creations.length, 0);
  game.host.dispose();
});
