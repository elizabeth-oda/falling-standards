import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { safetyDrillFixtures } from '@sky/shared';
import { RaceCreationOutcome } from './RaceCreationOutcome';
import { RaceReportSettings } from './RaceReportSettings';
import type { RaceCreationRecord } from './race-creation-history';
import type { RaceIncidentReportView } from './race-report-controller';

const spec = safetyDrillFixtures.find(fixture => fixture.spec.drill.family === 'pinball')!.spec;
const racers = [{id: 0, name: 'Susan'}, {id: 1, name: 'Greg'}, {id: 2, name: 'Linda'}, {id: 3, name: 'Steve'}];
const creation: RaceCreationRecord = {
  instanceId: 'pinball-1', source: 'voice', status: 'expired', spec,
  snapshot: {
    phase: 'expired', position: [0, -100, 0], elapsedSeconds: 10, remainingSeconds: 0,
    radius: 10, debris: [], affectedRacerIds: [], triggererId: '2', expirationReason: 'complete',
    impact: {participants: ['0', '1', '2', '3'], affectedRacerIds: ['0', '1'], impulseCounts: {}, debrisHits: {},
      blockedDebrisHits: {}, obstacleBlocks: {}, drill: {
        collisions: {}, blockedCollisions: {}, draftSeconds: {}, currentSeconds: {}, reactions: 0,
        bounces: {'0': 5, '1': 2},
      }},
  },
};
const fallback: RaceIncidentReportView = {
  status: 'pending', source: 'authored', headline: 'REPEAT CONTACT HAS BEEN NOTED',
  highlights: ['You bounced off the equipment 5 times.', 'Greg recorded 2 bumper bounces.'],
  finding: 'This now qualifies as a working relationship.',
};
const render = (report?: RaceIncidentReportView, record = creation) => renderToStaticMarkup(createElement(RaceCreationOutcome, {creation: record, racers, report}));

test('pending and unavailable reports retain their canonical facts and authored finding', () => {
  const pending = render(fallback);
  for (const fact of fallback.highlights) assert.ok(pending.includes(fact));
  assert.ok(pending.includes(fallback.finding));
  assert.match(pending, /The department is preparing its findings/);
  assert.doesNotMatch(pending, /AI-written finding|Provisional/);
  const failed = render({...fallback, status: 'unavailable'});
  assert.ok(failed.includes(fallback.finding));
  assert.match(failed, /AI finding unavailable/);
  assert.doesNotMatch(failed, /preparing its findings/);
});

test('completed AI copy is escaped plain text and keeps independent inspection details', () => {
  const html = render({...fallback, source: 'ai', status: 'complete',
    headline: '<img src=x onerror=alert(1)>', finding: '<script>bad()</script>'});
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /AI-written finding/);
  assert.match(html, /<details class="race-incident-details"><summary>Inspection details<\/summary>/);
  assert.match(html, /Linda activated it/);
  assert.match(html, /<dt>You<\/dt><dd>5 bumper bounces/);
  assert.match(html, /<dt>Greg<\/dt><dd>2 bumper bounces/);
  assert.match(html, /<dt>Steve<\/dt><dd>0 bumper bounces/);
});

test('an event remains provisional while active, and unused outcomes retain the actual reason', () => {
  const active = render(undefined, {...creation, status: 'active', snapshot: {...creation.snapshot!, phase: 'active'}});
  assert.match(active, /Provisional — racers still on course/);
  assert.match(active, /results can still change/);
  assert.doesNotMatch(active, /The effect finished/);
  const unused = render(undefined, {...creation, snapshot: {...creation.snapshot!, triggererId: undefined, expirationReason: 'passed'}});
  assert.match(unused, /ZERO INCIDENTS. ZERO PARTICIPANTS/);
  assert.match(unused, /Every racer passed it without collecting it/);
  assert.doesNotMatch(unused, /bumper bounces|activated it/);
});

test('free mock findings are clearly identified without a paid AI claim', () => {
  const html = render({...fallback, status: 'complete', source: 'mock'});
  assert.match(html, /Free simulated finding/);
  assert.doesNotMatch(html, /AI-written finding|preparing its findings/);
});

test('paid report consent defaults off, is separate from voice, and describes full-race timing', () => {
  const html = renderToStaticMarkup(createElement(RaceReportSettings, {
    checked: false, live: true, available: true, onChange() {},
  }));
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /checked=/);
  assert.match(html, /after the race/);
  assert.match(html, /1 additional paid call/);
  const mock = renderToStaticMarkup(createElement(RaceReportSettings, {checked: false, live: false, available: false, onChange() {}}));
  assert.doesNotMatch(mock, /type="checkbox"/);
  assert.match(mock, /free, prepared findings/);
});

test('an expired earlier item remains provisional until the rest of the race finishes', () => {
  const html = render({...fallback, status: 'provisional'});
  assert.match(html, /Provisional — racers still on course/);
  assert.ok(html.includes(fallback.finding));
  assert.doesNotMatch(html, /preparing its findings/);
});

test('inspection details retain interrupted activity and the cumulative number of path echoes', () => {
  const truncated = render(undefined, {...creation, snapshot: {...creation.snapshot!, elapsedSeconds: 0.5}});
  assert.match(truncated, /recorded activity ended before the effect completed/);
  assert.doesNotMatch(truncated, /The effect finished/);
  const echoSpec = safetyDrillFixtures.find(item => item.spec.drill.family === 'reconstruction')!.spec;
  const echoes = render(undefined, {...creation, spec: echoSpec, snapshot: {...creation.snapshot!,
    impact: {...creation.snapshot!.impact!, drill: {...creation.snapshot!.impact!.drill!, reactions: 7}}}});
  assert.match(echoes, /<dt>Path echoes created<\/dt><dd>7<\/dd>/);
});
