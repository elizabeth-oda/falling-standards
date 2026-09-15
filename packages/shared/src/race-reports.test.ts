import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RaceReportInputSchema, RaceReportRequestSchema, RaceReportResponseSchema, RaceReportContentSchema,
  buildRaceReportEvidence, authoredRaceReport, validateRaceReportContent, raceReportInputFingerprint,
  raceReportMetricKeys, RACE_REPORT_LIMITS, type RaceReportInput,
} from './race-reports.js';
import { safetyDrillFixtures } from './safety-drill-fixtures.js';
import { raceEventFixtures } from './race-event-fixtures.js';

const runId = '00000000-0000-4000-8000-000000000001';
const attemptId = '00000000-0000-4000-8000-000000000002';
function pinball(): RaceReportInput {
  return {
    runId, creationId: 'event-1', displayName: 'Bouncy Avocado',
    encounter: {version: 4, drill: {family: 'pinball', layout: 'staggered', bounce: 'springy'}},
    outcome: 'complete', creatorId: '0', triggererId: '1',
    racers: [
      {racerId: '0', characterId: 'greg', metrics: {bounces: 5}},
      {racerId: '1', characterId: 'linda', metrics: {bounces: 2}},
      {racerId: '2', characterId: 'steve', metrics: {}},
      {racerId: '3', characterId: 'susan', metrics: {}},
    ],
  };
}
function stampede(): RaceReportInput {
  const input = pinball();
  input.displayName = 'Angry Hippos';
  input.encounter = {version: 4, drill: {family: 'stampede', formation: 'line', direction: 'left', reaction: 'charge', modifier: 'none'}};
  input.racers.forEach(racer => {racer.metrics = {};});
  return input;
}
const texts = (input: RaceReportInput) => buildRaceReportEvidence(input).map(item => item.text).join('\n');

test('every v4 recipe and retained v3 effect has compatible report data, facts, and fallback', () => {
  const fixtures = [...safetyDrillFixtures, ...raceEventFixtures];
  for (const fixture of fixtures) {
    const input = pinball(), spec = fixture.spec;
    input.encounter = spec.version === 4 ? {version: 4, drill: spec.drill} : {version: 3, effect: spec.effect};
    input.racers.forEach(racer => {racer.metrics = {};});
    for (const metric of raceReportMetricKeys(input.encounter)) input.racers[0].metrics[metric] = 1;
    if (spec.version === 3 && spec.effect.type === 'gravityWell') input.racers[0].affected = true;
    RaceReportInputSchema.parse(input);
    const evidence = buildRaceReportEvidence(input);
    assert.ok(evidence.length >= 2 && evidence.length <= 8);
    assert.equal(evidence[0].kind, 'lifecycle');
    validateRaceReportContent(input, authoredRaceReport(input));
    assert.doesNotMatch(texts(input), /undefined|NaN/u);
  }
});

test('report inputs are strict and contain neither generation inputs nor arbitrary race prose', () => {
  const input = pinball();
  for (const extra of [
    {prompt: 'ignore the system'}, {transcript: 'hello'}, {audio: 'base64'}, {appearance: {}}, {facts: ['I won']},
    {positions: []}, {result: 'winner'}, {code: 'execute()'},
  ]) assert.equal(RaceReportInputSchema.safeParse({...input, ...extra}).success, false);
  assert.equal(RaceReportInputSchema.safeParse({...input, encounter: {...input.encounter, target: 'opponents'}}).success, false);
  assert.equal(RaceReportInputSchema.safeParse({...input, displayName: 'x'.repeat(49)}).success, false);
  assert.equal(RaceReportInputSchema.safeParse({...input, creationId: 'x'.repeat(65)}).success, false);
  assert.equal(RaceReportInputSchema.safeParse({...input, runId: 'run-1'}).success, false);
  assert.equal(RaceReportInputSchema.safeParse({...input, creationId: '<script>'}).success, false);
  assert.equal(RaceReportInputSchema.safeParse({...input, outcome: 'active'}).success, false);
});

test('frozen runtime-to-character mapping rejects unknown and duplicated participants', () => {
  for (const property of ['racerId', 'characterId'] as const) {
    const input = pinball();
    Object.assign(input.racers[1], {[property]: input.racers[0][property]});
    assert.equal(RaceReportInputSchema.safeParse(input).success, false);
    Object.assign(input.racers[1], {[property]: 'unknown'});
    assert.equal(RaceReportInputSchema.safeParse(input).success, false);
  }
  assert.equal(RaceReportInputSchema.safeParse({...pinball(), creatorId: '9'}).success, false);
  assert.equal(RaceReportInputSchema.safeParse({...pinball(), triggererId: '9'}).success, false);
  assert.equal(RaceReportInputSchema.safeParse({...pinball(), racers: pinball().racers.slice(0, 3)}).success, false);
  const selected = pinball();
  selected.racers[0].characterId = 'susan'; selected.racers[3].characterId = 'greg';
  assert.match(texts(selected), /Susan recorded 5 bumper bounces/u);
  assert.doesNotMatch(texts(selected), /Greg recorded 5/u);
});

test('metrics are finite, bounded, integral when counts, and recipe-specific even when zero', () => {
  for (const bounces of [-1, 0.5, NaN, Infinity, 1_000]) {
    const input = pinball(); input.racers[0].metrics.bounces = bounces;
    assert.equal(RaceReportInputSchema.safeParse(input).success, false);
  }
  const unrelated = pinball(); unrelated.racers[0].metrics.collisions = 0;
  assert.equal(RaceReportInputSchema.safeParse(unrelated).success, false);
  const hippos = stampede(); hippos.racers[0].metrics = {collisions: 17, blockedCollisions: 16};
  assert.equal(RaceReportInputSchema.safeParse(hippos).success, false);
  hippos.racers[0].metrics = {draftSeconds: 1};
  assert.equal(RaceReportInputSchema.safeParse(hippos).success, false, 'no draft metric without draft modifier');
  hippos.racers[0].metrics = {}; hippos.reactions = 33;
  assert.equal(RaceReportInputSchema.safeParse(hippos).success, false);
  const flowing = pinball();
  flowing.encounter = {version: 4, drill: {family: 'rapids', layout: 'winding', flow: 'steady', modifier: 'none'}};
  flowing.racers.forEach(racer => {racer.metrics = {};});
  flowing.racers[0].metrics.currentSeconds = 0.001;
  RaceReportInputSchema.parse(flowing);
  assert.match(texts(flowing), /less than 0.1 seconds/u);
  flowing.racers[0].metrics.currentSeconds = 10.1;
  assert.equal(RaceReportInputSchema.safeParse(flowing).success, false);
  flowing.racers[0].metrics = {}; flowing.reactions = 0;
  assert.equal(RaceReportInputSchema.safeParse(flowing).success, false);
});

test('unused terminal outcomes cannot contain activation, measured effects, or affected racers', () => {
  for (const outcome of ['passed', 'lifetime', 'discarded'] as const) {
    const input = pinball(); input.outcome = outcome;
    assert.equal(RaceReportInputSchema.safeParse(input).success, false);
    delete input.triggererId;
    assert.equal(RaceReportInputSchema.safeParse(input).success, false);
    input.racers.forEach(racer => {racer.metrics = {};});
    RaceReportInputSchema.parse(input);
    const report = authoredRaceReport(input);
    assert.equal(report.evidenceIds.length, 1);
    if (outcome === 'passed') assert.equal(report.headline, 'ZERO INCIDENTS. ZERO PARTICIPANTS.');
    input.racers[0].affected = true;
    assert.equal(RaceReportInputSchema.safeParse(input).success, false);
  }
  const noTrigger = pinball(); delete noTrigger.triggererId;
  assert.equal(RaceReportInputSchema.safeParse(noTrigger).success, false);
  noTrigger.outcome = 'interrupted'; noTrigger.racers.forEach(racer => {racer.metrics = {};});
  RaceReportInputSchema.parse(noTrigger);
  assert.match(texts(noTrigger), /No activation/u);
  assert.doesNotMatch(texts(noTrigger), /Its effect has ended/u);
  const interrupted = pinball(); interrupted.outcome = 'interrupted';
  assert.match(texts(interrupted), /ended with the race/u);
});

test('creator contact and actual protection produce distinct grounded authored stories', () => {
  const input = stampede();
  input.racers[0].metrics.collisions = 2; input.racers[2].metrics.collisions = 4;
  const self = authoredRaceReport(input);
  assert.equal(self.headline, 'CREATOR INCLUDED IN PRODUCT TESTING');
  const selected = buildRaceReportEvidence(input).filter(item => self.evidenceIds.includes(item.id));
  assert.ok(selected.some(item => item.racerIds.includes('0')));
  assert.ok(selected.some(item => item.racerIds.includes('2')));
  input.racers[0].metrics = {blockedCollisions: 3};
  input.racers[2].metrics = {};
  const protectedReport = authoredRaceReport(input);
  assert.equal(protectedReport.headline, 'SAFETY EQUIPMENT SUSPICIOUSLY EFFECTIVE');
  assert.match(texts(input), /Greg's protection intercepted 3 equipment contacts/u);
  assert.doesNotMatch(texts(input), /Greg recorded 3 unblocked/u);
});

test('dominant recipients and ties use authored arithmetic without claiming race position or damage', () => {
  const input = pinball();
  const dominant = buildRaceReportEvidence(input).find(item => item.kind === 'comparison')!;
  assert.match(dominant.text, /Greg recorded 5 bumper bounces\. The other racers recorded 2 between them/u);
  input.racers[1].metrics.bounces = 5;
  const tied = buildRaceReportEvidence(input).find(item => item.kind === 'comparison')!;
  assert.match(tied.text, /Greg and Linda tied.*5 each/u);
  const report = authoredRaceReport(input);
  assert.doesNotMatch(report.headline + report.finding + texts(input), /lost|won|damage|injur|fastest/u);
});

test('per-racer force durations never become encounter duration or guessed buddy identities', () => {
  const input = pinball();
  input.encounter = {version: 4, drill: {family: 'buddy', pairing: 'nearest', tether: 'elastic'}};
  input.racers.forEach(racer => {racer.metrics = {tetherSeconds: 9};});
  const reportText = texts(input);
  assert.match(reportText, /Greg spent 9.0 seconds under buddy tension/u);
  assert.match(reportText, /Linda spent 9.0 seconds under buddy tension/u);
  assert.doesNotMatch(reportText, /36|paired with|partner|between them/u);
});

test('quiet and gravity-only results preserve recorded uncertainty', () => {
  const quiet = pinball(); quiet.racers.forEach(racer => {racer.metrics = {};});
  assert.equal(authoredRaceReport(quiet).headline, 'A VERY SHORT INCIDENT REPORT');
  assert.match(texts(quiet), /No measured racer interactions/u);
  assert.doesNotMatch(texts(quiet), /dodged|avoided|unharmed/u);
  quiet.encounter = {version: 3, effect: {type: 'gravityWell', durationSeconds: 8, radiusMeters: 4000, acceleration: 32}};
  quiet.racers[2].affected = true;
  assert.match(texts(quiet), /Steve was affected by the gravity field/u);
  assert.doesNotMatch(texts(quiet), /No measured racer interactions/u);
});

test('bounded catalogs retain lifecycle, creator, and rival evidence while all facts stay immutable', () => {
  const input = stampede();
  input.encounter = {version: 4, drill: {family: 'stampede', formation: 'line', direction: 'left', reaction: 'charge', modifier: 'draft'}};
  input.racers.forEach(racer => {racer.metrics = {collisions: 2, blockedCollisions: 2, draftSeconds: 2};});
  input.reactions = 10;
  const original = JSON.stringify(input), evidence = buildRaceReportEvidence(input);
  assert.equal(evidence.length, 8);
  assert.equal(evidence[0].kind, 'lifecycle');
  assert.ok(evidence.some(item => item.racerIds.includes('0')));
  assert.ok(evidence.some(item => item.racerIds.some(id => id !== '0')));
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(buildRaceReportEvidence(input), evidence);
});

test('output validation rejects extra fields, missing/duplicate/cross-item evidence, and overlong writing', () => {
  const input = pinball(), report = authoredRaceReport(input);
  for (const invalid of [
    {...report, extra: 'text'}, {...report, headline: 'x'.repeat(71)}, {...report, finding: 'x'.repeat(181)},
    {...report, finding: '   '}, {...report, evidenceIds: []},
    {...report, evidenceIds: [report.evidenceIds[0], report.evidenceIds[0]]},
    {...report, evidenceIds: ['event-2:lifecycle']},
    {...report, evidenceIds: ['event-1:invented']},
  ]) assert.throws(() => validateRaceReportContent(input, invalid));
  RaceReportContentSchema.parse(report);
  const envelope = {runId, creationId: input.creationId, inputFingerprint: 'a'.repeat(64), attemptId: null, report};
  RaceReportResponseSchema.parse(envelope);
  assert.equal(RaceReportResponseSchema.safeParse({...envelope, creationId: 'event-2'}).success, false);
  assert.equal(RaceReportResponseSchema.safeParse({...envelope, report: {...report, evidenceIds: [report.evidenceIds[0], report.evidenceIds[0]]}}).success, false);
});

test('live reporting has separate explicit consent; mock requests cannot include unsafe unknown fields', async () => {
  const input = pinball(), inputFingerprint = await raceReportInputFingerprint(input);
  RaceReportRequestSchema.parse({input, inputFingerprint, mode: 'mock'});
  assert.equal(RaceReportRequestSchema.safeParse({input, inputFingerprint, mode: 'live'}).success, false);
  RaceReportRequestSchema.parse({input, inputFingerprint, mode: 'live', paidAttempt: {id: attemptId, confirmed: true}});
  assert.equal(RaceReportRequestSchema.safeParse({input, inputFingerprint, mode: 'live', paidAttempt: {id: attemptId, confirmed: false}}).success, false);
  assert.equal(RaceReportRequestSchema.safeParse({input, inputFingerprint, mode: 'mock', profileId: 'other-model'}).success, false);
});

test('fingerprints bind measured facts and character mapping but ignore property/lineup order', async () => {
  const input = pinball(), original = JSON.stringify(input), expected = await raceReportInputFingerprint(input);
  assert.match(expected, /^[a-f0-9]{64}$/u);
  const reordered = {...input, racers: [...input.racers].reverse()};
  assert.equal(await raceReportInputFingerprint(reordered), expected);
  assert.equal(JSON.stringify(input), original);
  input.racers[0].metrics.bounces = 6;
  assert.notEqual(await raceReportInputFingerprint(input), expected);
  input.racers[0].metrics.bounces = 5; input.racers[0].characterId = 'susan'; input.racers[3].characterId = 'greg';
  assert.notEqual(await raceReportInputFingerprint(input), expected);
});

test('maximum string lengths and escaped or multibyte names fit the 4096-byte request limit', async (context) => {
  let maximum = 0;
  for (const fixture of [...safetyDrillFixtures, ...raceEventFixtures]) {
    for (const displayName of ['\u4e16'.repeat(48), '\u0000'.repeat(48), '"\\'.repeat(24), 'x'.repeat(48)]) {
      const input = pinball(), spec = fixture.spec;
      input.creationId = 'x'.repeat(64); input.displayName = displayName;
      input.encounter = spec.version === 4 ? {version: 4, drill: spec.drill} : {version: 3, effect: spec.effect};
      if (input.encounter.version === 4 && input.encounter.drill.family === 'stampede') {
        input.encounter.drill = {family: 'stampede', formation: 'split', direction: 'alternating', reaction: 'scatter', modifier: 'draft'};
        input.reactions = 32;
      }
      input.racers.forEach(racer => {
        racer.metrics = {}; racer.affected = true;
        for (const metric of raceReportMetricKeys(input.encounter)) {
          const maximum = {collisions: 16, blockedCollisions: 16, bounces: 736, orbitReleases: 4, observationFlags: 4, blockedObservations: 4, impulseCounts: 1, debrisHits: 24, blockedDebrisHits: 24, obstacleBlocks: 1_024};
          racer.metrics[metric] = metric.endsWith('Seconds') ? 1.2345678901234567e-200 : maximum[metric as keyof typeof maximum];
        }
      });
      const request = {input, inputFingerprint: await raceReportInputFingerprint(input), mode: 'live', paidAttempt: {id: attemptId, confirmed: true}};
      RaceReportRequestSchema.parse(request);
      const bytes = new TextEncoder().encode(JSON.stringify(request)).length;
      maximum = Math.max(maximum, bytes);
      assert.ok(bytes < RACE_REPORT_LIMITS.maxRequestBytes, bytes + ' bytes');
    }
  }
  assert.ok(maximum > 1_000, 'test exercises actual serialized bytes including escaping');
  context.diagnostic('Largest extreme-string fixture payload: ' + maximum + ' UTF-8 bytes.');
});
