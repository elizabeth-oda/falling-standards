import { encounterDurationSeconds, RaceReportInputSchema, type RaceReportInput } from '@sky/shared';
import type { RaceCreationRecord } from './race-creation-history';
import type { PracticeRace } from './practice-race';

export type RaceReportLineup = readonly Pick<PracticeRace['racers'][number], 'id' | 'model'>[];

/** Final landing can end an active effect before its authored duration elapses. */
export function raceReportOutcome(record: RaceCreationRecord): RaceReportInput['outcome'] {
  const snapshot = record.snapshot, triggered = snapshot?.triggererId !== undefined;
  const reason = snapshot?.expirationReason;
  if (record.status === 'discarded') return 'discarded';
  if (triggered && reason === 'complete' && snapshot.elapsedSeconds >= encounterDurationSeconds(record.spec) - 1e-8) return 'complete';
  if (!triggered && reason === 'passed') return 'passed';
  if (!triggered && reason === 'lifetime') return 'lifetime';
  return 'interrupted';
}
/** Freeze only declarative outcomes; never send meshes, audio, or transcripts. */
export function raceReportInput(record:RaceCreationRecord,racers:RaceReportLineup,runId:string):RaceReportInput|undefined {
  if(record.status!=='expired'&&record.status!=='discarded')return;
  const snapshot=record.snapshot, impact=snapshot?.impact, drill=impact?.drill;
  const triggered=snapshot?.triggererId!==undefined;
  const outcome=raceReportOutcome(record);
  const list=racers.map(racer=>{
    const id=String(racer.id);
    const value=(counts:Record<string,number>|undefined)=>counts?.[id]??0;
    const spec=record.spec;
    let metrics:Record<string,number>;
    if(spec.version===4) {
      switch(spec.drill.family) {
        case 'stampede': metrics={collisions:value(drill?.collisions),blockedCollisions:value(drill?.blockedCollisions),...(spec.drill.modifier==='draft'?{draftSeconds:value(drill?.draftSeconds)}:{})};break;
        case 'rapids':metrics={currentSeconds:value(drill?.currentSeconds)};break;
        case 'pinball':metrics={bounces:value(drill?.bounces)};break;
        case 'buddy':metrics={tetherSeconds:value(drill?.tetherSeconds)};break;
        case 'orbit':metrics={orbitSeconds:value(drill?.orbitSeconds),orbitReleases:value(drill?.orbitReleases)};break;
        case 'reconstruction':metrics={collisions:value(drill?.collisions),blockedCollisions:value(drill?.blockedCollisions)};break;
        case 'observation':metrics={observationFlags:value(drill?.observationFlags),blockedObservations:value(drill?.blockedObservations)};break;
      }
    } else {
      switch(spec.effect.type) {
        case 'repulsionBurst':metrics={impulseCounts:value(impact?.impulseCounts)};break;
        case 'debrisShower':metrics={debrisHits:value(impact?.debrisHits),blockedDebrisHits:value(impact?.blockedDebrisHits)};break;
        case 'protectiveZone':metrics={obstacleBlocks:value(impact?.obstacleBlocks)};break;
        case 'gravityWell':metrics={};break;
      }
    }
    return {racerId:id,characterId:racer.model,metrics,
      ...(spec.version===3?{affected:impact?.affectedRacerIds.includes(id)??false}:{})};
  });
  const spec=record.spec;
  const parsed=RaceReportInputSchema.safeParse({
    runId,creationId:record.instanceId,displayName:spec.displayName,
    encounter:spec.version===4?{version:4,drill:spec.drill}:{version:3,effect:spec.effect},
    outcome,creatorId:snapshot?.instance?.creatorId??'0',
    ...(triggered?{triggererId:snapshot.triggererId}:{}),racers:list,
    ...(spec.version===4&&(spec.drill.family==='reconstruction'||(spec.drill.family==='stampede'&&spec.drill.reaction!=='steady'))?{reactions:drill?.reactions??0}:{}),
  });
  return parsed.success?parsed.data:undefined;
}
