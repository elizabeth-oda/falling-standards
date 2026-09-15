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
    phase: 'expired', position: [0, -100, 0], elapsedSeconds: 8, remainingSeconds: 0,
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
  assert.match(active, /Provisional — event still open/);
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

test('paid report consent defaults off, is separate from voice, and describes event-end timing', () => {
  const html = renderToStaticMarkup(createElement(RaceReportSettings, {
    reportLive: true, reportAvailable: true, onReportConsentChange() {},
  }));
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /checked=/);
  assert.match(html, /when each event ends/);
  assert.match(html, /Up to 2 additional paid calls per run, separate from voice creation/);
  const mock = renderToStaticMarkup(createElement(RaceReportSettings, {onReportConsentChange() {}}));
  assert.doesNotMatch(mock, /type="checkbox"/);
  assert.match(mock, /free, prepared findings in Mock mode/);
});
