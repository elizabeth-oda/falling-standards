import React from 'react';
import type { RaceCreationRecord } from './race-creation-history';
import type { RaceIncidentReportView } from './race-report-controller';
import { drillAssessment } from './drill-feedback';
import { drillMetricSummary } from '../race-events/drill-metrics';

export type CreationRacerName = {id: string | number; name: string};
const total = (counts: Record<string, number> = {}) => Object.values(counts).reduce((sum, value) => sum + value, 0);

function lifecycleText(creation: RaceCreationRecord) {
  if (creation.snapshot?.triggererId !== undefined) return creation.status === 'active'
    ? 'The drill is still active. Its results can still change.' : 'The effect finished.';
  if (creation.status === 'ready') return 'Created and waiting for the shared course space. It has not entered the race yet.';
  if (creation.status === 'discarded') return 'Created, but not placed before the attempt ended. It did not affect the race.';
  if (creation.status === 'collectible') return 'Waiting for a racer to collect it. It has not affected the race yet.';
  if (creation.snapshot?.expirationReason === 'passed') return 'Every racer passed it without collecting it. It did not activate.';
  if (creation.snapshot?.expirationReason === 'lifetime') return 'The pickup expired before anyone collected it. It did not activate.';
  return 'No activation was recorded. It did not affect the race.';
}

/** Presentation reads saved facts only. Opening or rerendering never starts a request. */
export function RaceCreationOutcome({creation, racers, report}: {
  creation: RaceCreationRecord;
  racers: readonly CreationRacerName[];
  report?: RaceIncidentReportView;
}) {
  const {snapshot, spec} = creation;
  const impact = snapshot?.impact;
  const racerName = (id: string) => id === '0' ? 'You' : racers.find(racer => String(racer.id) === id)?.name ?? 'A racer';
  const triggererId = snapshot?.triggererId;
  const status = lifecycleText(creation);
  const provisional = ['ready', 'collectible', 'active'].includes(creation.status);
  const unused = triggererId === undefined;
  const headline = report?.headline ?? (provisional ? 'INSPECTION STILL IN PROGRESS'
    : unused ? 'ZERO INCIDENTS. ZERO PARTICIPANTS.' : 'EQUIPMENT RETURNED WITH NOTES');
  const highlights = report?.highlights ?? [status];
  const finding = report?.finding ?? (provisional ? 'The paperwork remains open. Please avoid spilling anything on it.'
    : unused ? 'Excellent safety record. Insufficient sample size.' : 'The department has received the equipment and several questions.');
  const assessment = drillAssessment(snapshot);
  const metrics: {label: string; value: string | number}[] = [];
  if (triggererId !== undefined && impact) {
    if (spec.version === 4 && impact.drill) {
      metrics.push({label: 'Drill totals', value: drillMetricSummary(spec.drill.family, impact.drill)});
      if (spec.drill.family === 'stampede' && spec.drill.reaction !== 'steady') metrics.push({label: 'Herd reactions', value: impact.drill.reactions});
    } else if (spec.version === 3) {
      if (spec.effect.type === 'repulsionBurst') metrics.push({label: 'Pushes delivered', value: total(impact.impulseCounts)});
      if (spec.effect.type === 'debrisShower') {
        metrics.push({label: 'Debris hits', value: total(impact.debrisHits)});
        metrics.push({label: 'Debris hits blocked', value: total(impact.blockedDebrisHits)});
      }
      if (spec.effect.type === 'protectiveZone') metrics.push({label: 'Obstacle hits blocked', value: total(impact.obstacleBlocks)});
    }
  }
  const perRacer = (id: string) => {
    if (!impact) return '';
    if (spec.version === 4 && impact.drill) return drillMetricSummary(spec.drill.family, impact.drill, id);
    if (spec.version === 3) {
      switch (spec.effect.type) {
        case 'repulsionBurst': return `${impact.impulseCounts[id] ?? 0} pushes delivered`;
        case 'debrisShower': return `${impact.debrisHits[id] ?? 0} debris hits · ${impact.blockedDebrisHits[id] ?? 0} blocked`;
        case 'protectiveZone': return `${impact.obstacleBlocks[id] ?? 0} obstacle hits blocked`;
      }
    }
    return '';
  };
  return <section className="race-creation-outcome" aria-label="Incident report">
    <span className="race-incident-label">INCIDENT REPORT</span>
    <h4 className="race-incident-headline">{headline}</h4>
    {provisional && <p className="race-incident-status">Provisional — event still open</p>}
    <div className="race-incident-facts">{highlights.map((highlight, index) => <p key={index}>{highlight}</p>)}</div>
    <div className="race-incident-finding"><b>Departmental finding</b><p>{finding}</p>
      {report?.source === 'ai' && <small>AI-written finding</small>}
      {report?.source === 'mock' && <small>Free simulated finding</small>}
    </div>
    <div className="race-incident-request-status" role="status" aria-live="polite">
      {report?.status === 'pending' && <p>The department is preparing its findings.</p>}
      {report?.status === 'unavailable' && <p>{report.message ?? 'AI finding unavailable. The authored report remains on file.'}</p>}
    </div>
    <details className="race-incident-details">
      <summary>Inspection details</summary>
      <p>{status}</p>
      {creation.status === 'discarded' && creation.discardReason && <p>{creation.discardReason}</p>}
      {triggererId !== undefined && <>
        <p><b>{triggererId === '0' ? 'You activated it.' : `${racerName(triggererId)} activated it.`}</b></p>
        {spec.version === 3 && spec.effect.type === 'gravityWell' && <p>{impact?.affectedRacerIds.length
          ? 'Gravity acted on ' + impact.affectedRacerIds.map(id => id === '0' ? 'you' : racerName(id)).join(', ') + '.'
          : 'No gravity effects were recorded.'}</p>}
        {metrics.length > 0 && <>
          <dl className="race-creation-metrics">{metrics.map(metric => <div key={metric.label}>
            <dt>{metric.label}</dt><dd>{metric.value}</dd>
          </div>)}</dl>
          <small>Totals across all racers. Seconds add each racer's exposure; they are not the event's elapsed time.</small>
          <dl className="race-incident-racers">{racers.map(racer => <div key={racer.id}>
            <dt>{racerName(String(racer.id))}</dt><dd>{perRacer(String(racer.id))}</dd>
          </div>)}</dl>
        </>}
        {assessment && <p className="race-creation-assessment"><b>Your inspection</b>{assessment}</p>}
      </>}
    </details>
  </section>;
}
