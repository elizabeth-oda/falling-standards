import { z } from 'zod';
import { LiveUsageSchema, PipelineRequestSchema } from './pipeline.js';
import { RaceEventEffectSchema, RACE_EVENT_LIMITS } from './race-events.js';
import { SafetyDrillRecipeSchema, SAFETY_DRILL_LIMITS } from './safety-drills.js';
import { PowerUpSpecSchema } from './schema.js';

export const RACE_REPORT_LIMITS = Object.freeze({
  maxRequestBytes: 4_096, maxEvidence: 8, maxReportsPerRun: 2,
  serverDeadlineMs: 12_000, clientDeadlineMs: 15_000,
});
export const RACE_REPORT_CHARACTER_NAMES = Object.freeze({greg: 'Greg', linda: 'Linda', steve: 'Steve', susan: 'Susan'});
export const RaceReportCharacterIdSchema = z.enum(['greg', 'linda', 'steve', 'susan']);
export const RaceReportRacerIdSchema = z.enum(['0', '1', '2', '3']);
export type RaceReportCharacterId = z.infer<typeof RaceReportCharacterIdSchema>;
export type RaceReportRacerId = z.infer<typeof RaceReportRacerIdSchema>;
const creationId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/u);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const count = (max: number) => z.number().finite().int().nonnegative().max(max);
// One duration per racer per tick, with one maximum event tick of rounding tolerance.
const seconds = z.number().finite().nonnegative().max(SAFETY_DRILL_LIMITS.durationSeconds + RACE_EVENT_LIMITS.maxStepSeconds);
export const RaceReportMetricsSchema = z.object({
  collisions: count(128).optional(), blockedCollisions: count(128).optional(),
  draftSeconds: seconds.optional(), currentSeconds: seconds.optional(),
  // A bumper may be revisited after its 0.45-second cooldown, across up to 32 actors.
  bounces: count(SAFETY_DRILL_LIMITS.maxActors * Math.ceil(SAFETY_DRILL_LIMITS.durationSeconds / 0.45)).optional(),
  tetherSeconds: seconds.optional(), orbitSeconds: seconds.optional(),
  orbitReleases: count(SAFETY_DRILL_LIMITS.maxOrbits).optional(),
  observationFlags: count(8).optional(), blockedObservations: count(8).optional(),
  impulseCounts: count(1).optional(), debrisHits: count(48).optional(), blockedDebrisHits: count(48).optional(),
  obstacleBlocks: count(1_024).optional(),
}).strict();
export type RaceReportMetrics = z.infer<typeof RaceReportMetricsSchema>;
export type RaceReportMetric = keyof RaceReportMetrics;
export const RaceReportEncounterSchema = z.discriminatedUnion('version', [
  z.object({version: z.literal(4), drill: SafetyDrillRecipeSchema}).strict(),
  z.object({version: z.literal(3), effect: RaceEventEffectSchema}).strict(),
]);
export type RaceReportEncounter = z.infer<typeof RaceReportEncounterSchema>;

/** Only meaningful counters for this particular recipe cross the report boundary. */
export function raceReportMetricKeys(encounter: RaceReportEncounter): readonly RaceReportMetric[] {
  if (encounter.version === 3) {
    switch (encounter.effect.type) {
      case 'gravityWell': return [];
      case 'repulsionBurst': return ['impulseCounts'];
      case 'debrisShower': return ['debrisHits', 'blockedDebrisHits'];
      case 'protectiveZone': return ['obstacleBlocks'];
    }
  }
  switch (encounter.drill.family) {
    case 'stampede': return encounter.drill.modifier === 'draft'
      ? ['collisions', 'blockedCollisions', 'draftSeconds'] : ['collisions', 'blockedCollisions'];
    case 'rapids': return ['currentSeconds'];
    case 'pinball': return ['bounces'];
    case 'buddy': return ['tetherSeconds'];
    case 'orbit': return ['orbitSeconds', 'orbitReleases'];
    case 'reconstruction': return ['collisions', 'blockedCollisions'];
    case 'observation': return ['observationFlags', 'blockedObservations'];
  }
}

const ReportInputObjectSchema = z.object({
  runId: z.string().uuid(), creationId, displayName: PowerUpSpecSchema.shape.displayName,
  encounter: RaceReportEncounterSchema,
  outcome: z.enum(['complete', 'passed', 'lifetime', 'discarded', 'interrupted']),
  creatorId: RaceReportRacerIdSchema, triggererId: RaceReportRacerIdSchema.optional(),
  racers: z.array(z.object({
    racerId: RaceReportRacerIdSchema, characterId: RaceReportCharacterIdSchema,
    affected: z.boolean().optional(), metrics: RaceReportMetricsSchema,
  }).strict()).length(4),
  reactions: count(128).optional(),
}).strict();

export const RaceReportInputSchema = ReportInputObjectSchema.superRefine((input, context) => {
  const issue = (message: string, path: (string | number)[] = []) => context.addIssue({code: z.ZodIssueCode.custom, message, path});
  if (new Set(input.racers.map(racer => racer.racerId)).size !== 4) issue('Racer IDs must be unique.', ['racers']);
  if (new Set(input.racers.map(racer => racer.characterId)).size !== 4) issue('Character IDs must be unique.', ['racers']);
  const knownIds = new Set(input.racers.map(racer => racer.racerId));
  if (!knownIds.has(input.creatorId)) issue('Unknown creator.', ['creatorId']);
  if (input.triggererId !== undefined && !knownIds.has(input.triggererId)) issue('Unknown triggerer.', ['triggererId']);
  if (input.outcome === 'complete' && input.triggererId === undefined) issue('A completed effect needs its triggerer.', ['triggererId']);
  if (input.outcome !== 'complete' && input.outcome !== 'interrupted' && input.triggererId !== undefined) {
    issue('An unused outcome cannot have a triggerer.', ['triggererId']);
  }
  const allowed = new Set<string>(raceReportMetricKeys(input.encounter));
  input.racers.forEach((racer, index) => {
    const path = ['racers', index, 'metrics'];
    for (const [key, value] of Object.entries(racer.metrics)) {
      if (!allowed.has(key)) issue('Metric does not belong to this encounter.', [...path, key]);
      if (input.triggererId === undefined && value !== 0) issue('Unactivated creations cannot have recorded effects.', [...path, key]);
    }
    if (input.triggererId === undefined && racer.affected) issue('Unactivated creations cannot affect racers.', ['racers', index, 'affected']);
    const metrics = racer.metrics;
    if (input.encounter.version === 4) {
      const contactLimit = input.encounter.drill.family === 'stampede' ? SAFETY_DRILL_LIMITS.maxActors : 128;
      if ((metrics.collisions ?? 0) + (metrics.blockedCollisions ?? 0) > contactLimit) issue('Too many combined equipment contacts.', path);
      if ((metrics.observationFlags ?? 0) + (metrics.blockedObservations ?? 0) > 8) issue('Too many combined observation penalties.', path);
    } else if (input.encounter.effect.type === 'debrisShower' &&
      (metrics.debrisHits ?? 0) + (metrics.blockedDebrisHits ?? 0) > input.encounter.effect.collidableCount) {
      issue('Debris contacts exceed the collidable particle count.', path);
    }
  });
  if (input.reactions !== undefined) {
    const drill = input.encounter.version === 4 ? input.encounter.drill : undefined;
    if (!drill || (drill.family !== 'reconstruction' && !(drill.family === 'stampede' && drill.reaction !== 'steady'))) {
      issue('Reactions do not belong to this encounter.', ['reactions']);
    }
    if (drill?.family === 'stampede' && input.reactions > SAFETY_DRILL_LIMITS.maxActors) issue('Too many herd reactions.', ['reactions']);
    if (input.triggererId === undefined && input.reactions !== 0) issue('Unactivated creations cannot record reactions.', ['reactions']);
  }
});
export type RaceReportInput = z.infer<typeof RaceReportInputSchema>;

export const RaceReportRequestSchema = z.object({
  input: RaceReportInputSchema, inputFingerprint: fingerprint,
  mode: z.enum(['mock', 'live']), paidAttempt: PipelineRequestSchema.shape.paidAttempt,
}).strict().superRefine((request, context) => {
  if (request.mode === 'live' && !request.paidAttempt) context.addIssue({code: z.ZodIssueCode.custom, message: 'Live reports require separate consent.', path: ['paidAttempt']});
  if (new TextEncoder().encode(JSON.stringify(request)).length > RACE_REPORT_LIMITS.maxRequestBytes) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Report request exceeds its UTF-8 byte limit.'});
  }
});
export type RaceReportRequest = z.infer<typeof RaceReportRequestSchema>;

/** This structural schema also derives the provider's Structured Outputs schema. */
export const RaceReportContentSchema = z.object({
  headline: z.string().min(1).max(70).regex(/\S/u), finding: z.string().min(1).max(180).regex(/\S/u),
  evidenceIds: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u)).min(1).max(2),
}).strict();
export type RaceReportContent = z.infer<typeof RaceReportContentSchema>;
export const RaceReportResponseSchema = z.object({
  runId: z.string().uuid(), creationId, inputFingerprint: fingerprint,
  attemptId: z.string().uuid().nullable(), report: RaceReportContentSchema,
}).strict().superRefine((response, context) => {
  if (new Set(response.report.evidenceIds).size !== response.report.evidenceIds.length) context.addIssue({code: z.ZodIssueCode.custom, message: 'Evidence IDs must be unique.', path: ['report', 'evidenceIds']});
  if (response.report.evidenceIds.some(id => !id.startsWith(response.creationId + ':'))) context.addIssue({code: z.ZodIssueCode.custom, message: 'Evidence belongs to another creation.', path: ['report', 'evidenceIds']});
});
export type RaceReportResponse = z.infer<typeof RaceReportResponseSchema>;
export const RaceReportStatusSchema = z.object({
  liveEnabled: z.boolean(), available: z.boolean(), unavailableReason: z.string().min(1).max(180).optional(),
  liveUsage: LiveUsageSchema, deadlineMs: z.literal(12_000),
}).strict();
export type RaceReportStatus = z.infer<typeof RaceReportStatusSchema>;

export type RaceReportEvidence = Readonly<{
  id: string; kind: 'lifecycle' | 'contact' | 'protection' | 'movement' | 'inspection' | 'comparison' | 'reaction' | 'quiet' | 'exposure';
  text: string; racerIds: readonly RaceReportRacerId[]; metric?: RaceReportMetric; value?: number;
}>;
const plural = (value: number, singular: string, multiple = singular + 's') => value === 1 ? singular : multiple;
const duration = (value: number) => value < 0.1 ? 'less than 0.1 seconds' : value.toFixed(1) + ' seconds';
const totalMetric = (input: RaceReportInput, metric: RaceReportMetric) => input.racers.reduce((sum, racer) => sum + (racer.metrics[metric] ?? 0), 0);
const metricLabels: Record<RaceReportMetric, string> = {
  collisions: 'unblocked equipment contacts', blockedCollisions: 'protected equipment contacts', draftSeconds: 'drafting seconds',
  currentSeconds: 'current-riding seconds', bounces: 'bumper bounces', tetherSeconds: 'seconds under buddy tension',
  orbitSeconds: 'orbiting seconds', orbitReleases: 'slingshot exits', observationFlags: 'movement penalties',
  blockedObservations: 'intercepted inspection penalties', impulseCounts: 'shockwave pushes', debrisHits: 'unblocked debris hits',
  blockedDebrisHits: 'intercepted debris hits', obstacleBlocks: 'blocked obstacle hits',
};
function metricText(metric: RaceReportMetric, value: number, name: string, echo: boolean): string {
  const equipment = echo ? 'echo' : 'equipment';
  switch (metric) {
    case 'collisions': return name + ' recorded ' + value + ' unblocked ' + equipment + ' ' + plural(value, 'contact') + '.';
    case 'blockedCollisions': return name + "'s protection intercepted " + value + ' ' + equipment + ' ' + plural(value, 'contact') + '.';
    case 'draftSeconds': return name + ' spent ' + duration(value) + ' drafting behind moving equipment.';
    case 'currentSeconds': return name + ' spent ' + duration(value) + ' riding currents.';
    case 'bounces': return name + ' recorded ' + value + ' bumper ' + plural(value, 'bounce') + '.';
    case 'tetherSeconds': return name + ' spent ' + duration(value) + ' under buddy tension.';
    case 'orbitSeconds': return name + ' spent ' + duration(value) + ' orbiting.';
    case 'orbitReleases': return name + ' made ' + value + ' slingshot ' + plural(value, 'exit') + '.';
    case 'observationFlags': return name + ' received ' + value + ' movement ' + plural(value, 'penalty', 'penalties') + ' during inspection.';
    case 'blockedObservations': return name + "'s protection intercepted " + value + ' inspection ' + plural(value, 'penalty', 'penalties') + '.';
    case 'impulseCounts': return name + ' received ' + value + ' shockwave ' + plural(value, 'push', 'pushes') + '.';
    case 'debrisHits': return name + ' recorded ' + value + ' unblocked debris ' + plural(value, 'hit') + '.';
    case 'blockedDebrisHits': return name + "'s protection intercepted " + value + ' debris ' + plural(value, 'hit') + '.';
    case 'obstacleBlocks': return name + "'s event protection blocked " + value + ' obstacle ' + plural(value, 'hit') + '.';
  }
}
function metricKind(metric: RaceReportMetric): RaceReportEvidence['kind'] {
  switch (metric) {
    case 'blockedCollisions': case 'blockedObservations': case 'blockedDebrisHits': case 'obstacleBlocks': return 'protection';
    case 'collisions': case 'debrisHits': return 'contact';
    case 'observationFlags': return 'inspection';
    default: return 'movement';
  }
}

/** Canonical text only: client-authored prose and generated geometry never enter the catalog. */
export function buildRaceReportEvidence(value: RaceReportInput): readonly RaceReportEvidence[] {
  const input = RaceReportInputSchema.parse(value);
  const racers = [...input.racers].sort((a, b) => a.racerId.localeCompare(b.racerId));
  const name = (id: RaceReportRacerId) => RACE_REPORT_CHARACTER_NAMES[racers.find(racer => racer.racerId === id)!.characterId];
  const id = (suffix: string) => input.creationId + ':' + suffix;
  let lifecycle: string;
  switch (input.outcome) {
    case 'passed': lifecycle = 'Every racer passed ' + input.displayName + ' without collecting it. It never activated.'; break;
    case 'lifetime': lifecycle = input.displayName + ' expired before anyone collected it. It never activated.'; break;
    case 'discarded': lifecycle = input.displayName + ' was created but never placed on the course.'; break;
    case 'complete': lifecycle = name(input.triggererId!) + ' activated ' + input.displayName + '. Its effect has ended.'; break;
    case 'interrupted': lifecycle = input.triggererId === undefined
      ? 'No activation of ' + input.displayName + ' was recorded before the race ended.'
      : name(input.triggererId) + ' activated ' + input.displayName + '. Its recorded activity ended with the race.'; break;
  }
  const result: RaceReportEvidence[] = [{id: id('lifecycle'), kind: 'lifecycle', text: lifecycle,
    racerIds: input.triggererId === undefined ? [] : [input.triggererId]}];
  if (input.triggererId === undefined) return result;
  const echo = input.encounter.version === 4 && input.encounter.drill.family === 'reconstruction';
  const metrics = raceReportMetricKeys(input.encounter);
  const candidates: (RaceReportEvidence & {priority: number})[] = [];
  for (const racer of racers) for (const metric of metrics) {
    const value = racer.metrics[metric] ?? 0;
    if (value <= 0) continue;
    const kind = metricKind(metric);
    candidates.push({id: id('racer:' + racer.racerId + ':' + metric), kind, metric, value,
      text: metricText(metric, value, name(racer.racerId), echo), racerIds: [racer.racerId],
      priority: (racer.racerId === input.creatorId ? 50 : 0) + (kind === 'protection' ? 20 : 0) + Math.min(value, 15)});
  }
  // Comparisons include ties and other-racer totals; the model does no arithmetic.
  for (const metric of metrics.filter(metric => !metric.endsWith('Seconds'))) {
    const total = totalMetric(input, metric);
    const maximum = Math.max(...racers.map(racer => racer.metrics[metric] ?? 0));
    if (maximum < 2) continue;
    const leaders = racers.filter(racer => racer.metrics[metric] === maximum);
    if (leaders.length === 1 && maximum > total - maximum) {
      const leader = leaders[0];
      candidates.push({id: id('comparison:' + metric), kind: 'comparison', metric, value: maximum, racerIds: [leader.racerId], priority: 70,
        text: metricText(metric, maximum, name(leader.racerId), echo) + ' The other racers recorded ' + (total - maximum) + ' between them.'});
    } else if (leaders.length > 1) {
      candidates.push({id: id('comparison:' + metric), kind: 'comparison', metric, value: maximum, racerIds: leaders.map(racer => racer.racerId), priority: 55,
        text: leaders.map(racer => name(racer.racerId)).join(' and ') + ' tied for the most recorded ' + (echo && metric === 'collisions' ? 'unblocked echo contacts' : echo && metric === 'blockedCollisions' ? 'protected echo contacts' : metricLabels[metric]) + ' at ' + maximum + ' each.'});
    }
  }
  if ((input.reactions ?? 0) > 0) candidates.push({id: id('reactions'), kind: 'reaction', value: input.reactions,
    text: input.reactions + (echo ? ' path echoes were created.' : ' herd reactions were recorded.'), racerIds: [], priority: 5});
  if (input.encounter.version === 3 && input.encounter.effect.type === 'gravityWell') {
    for (const racer of racers.filter(racer => racer.affected)) candidates.push({id: id('racer:' + racer.racerId + ':exposure'), kind: 'exposure',
      text: name(racer.racerId) + ' was affected by the gravity field.', racerIds: [racer.racerId], priority: racer.racerId === input.creatorId ? 50 : 10});
  }
  if (candidates.length === 0) {
    result.push({id: id('quiet'), kind: 'quiet', racerIds: [],
      text: input.encounter.version === 3 && input.encounter.effect.type === 'protectiveZone'
        ? 'No obstacle hits were recorded as blocked by this event.'
        : 'No measured racer interactions were recorded.'});
    return result;
  }
  candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const selected = candidates.slice(0, RACE_REPORT_LIMITS.maxEvidence - 1);
  const rival = candidates.find(candidate => candidate.racerIds.some(racerId => racerId !== input.creatorId));
  if (rival && !selected.some(candidate => candidate.racerIds.some(racerId => racerId !== input.creatorId))) selected[selected.length - 1] = rival;
  return [...result, ...selected.map(({priority: _priority, ...evidence}) => evidence)];
}

/** Reference validation stays separate from the provider's structural output schema. */
export function validateRaceReportContent(input: RaceReportInput, value: unknown): RaceReportContent {
  const report = RaceReportContentSchema.parse(value);
  const ids = new Set(buildRaceReportEvidence(input).map(evidence => evidence.id));
  if (new Set(report.evidenceIds).size !== report.evidenceIds.length || report.evidenceIds.some(id => !ids.has(id))) {
    throw new z.ZodError([{code: z.ZodIssueCode.custom, path: ['evidenceIds'], message: 'Report evidence must uniquely reference this creation.'}]);
  }
  return report;
}

/** Free, reproducible framing used immediately, in fixtures, and after a failed AI attempt. */
export function authoredRaceReport(value: RaceReportInput): RaceReportContent {
  const input = RaceReportInputSchema.parse(value), evidence = buildRaceReportEvidence(input);
  const finish = (headline: string, finding: string, selected: readonly RaceReportEvidence[]) =>
    validateRaceReportContent(input, {headline, finding, evidenceIds: selected.slice(0, 2).map(item => item.id)});
  if (input.triggererId === undefined) {
    if (input.outcome === 'passed') return finish('ZERO INCIDENTS. ZERO PARTICIPANTS.', 'Excellent safety record. Insufficient sample size.', evidence);
    if (input.outcome === 'lifetime') return finish('EQUIPMENT AWAITED AN AUDIENCE', 'The appointment expired. The paperwork did not.', evidence);
    if (input.outcome === 'discarded') return finish('APPROVED FOR DESK USE', 'Field testing has been replaced with shelf testing.', evidence);
    return finish('ACTIVATION NOT ON FILE', 'The department declines to speculate without the appropriate form.', evidence);
  }
  const recorded = evidence.filter(item => item.kind !== 'lifecycle');
  const creatorContact = recorded.find(item => item.racerIds.includes(input.creatorId) && (item.kind === 'contact' || item.kind === 'inspection'));
  if (creatorContact) return finish('CREATOR INCLUDED IN PRODUCT TESTING', 'Staff who request equipment remain subject to equipment.',
    [creatorContact, ...recorded.filter(item => item !== creatorContact && !item.racerIds.includes(input.creatorId))]);
  const protectedResult = recorded.find(item => item.kind === 'protection');
  if (protectedResult) return finish('SAFETY EQUIPMENT SUSPICIOUSLY EFFECTIVE', 'A successful safety outcome. We are reviewing how this happened.',
    [protectedResult, ...recorded.filter(item => item !== protectedResult && item.kind !== 'comparison')]);
  if (recorded[0]?.kind === 'quiet') return finish('A VERY SHORT INCIDENT REPORT', 'The department accepts this unusually manageable amount of paperwork.', recorded);
  const family = input.encounter.version === 4 ? input.encounter.drill.family : input.encounter.effect.type;
  const framing: Record<typeof family, readonly [string, string]> = {
    stampede: ['EQUIPMENT FEEDBACK RECEIVED', 'Please submit future equipment feedback in writing.'],
    rapids: ['CURRENT POLICY UNDER REVIEW', 'Following the flow does not constitute reading the procedure.'],
    pinball: ['TRAVEL EXPENSE CLAIM REJECTED', 'Recorded ricochets do not constitute a business trip.'],
    buddy: ['MANDATORY TEAMWORK RECORDED', 'Individual credit is unavailable. The team has been informed.'],
    orbit: ['CIRCULAR PROGRESS ACKNOWLEDGED', 'The department recognizes movement. It cannot confirm progress.'],
    reconstruction: ['PREVIOUS INCIDENTS REISSUED', 'The department regrets the need to duplicate this paperwork.'],
    observation: ['MOVEMENT REQUIRES AUTHORIZATION', 'Please obtain permission before the next unplanned direction.'],
    gravityWell: ['CIRCULAR PROGRESS ACKNOWLEDGED', 'The department recognizes movement. It cannot confirm progress.'],
    repulsionBurst: ['PERSONAL SPACE REASSIGNED', 'The new seating arrangement takes effect immediately.'],
    debrisShower: ['UNSCHEDULED EQUIPMENT DELIVERY', 'Delivery confirmation has been forwarded to the wrong department.'],
    protectiveZone: ['SAFETY EQUIPMENT SUSPICIOUSLY EFFECTIVE', 'A successful safety outcome. We are reviewing how this happened.'],
  };
  const [headline, finding] = framing[family];
  const first = recorded[0];
  const second = recorded.find(item => item !== first && !item.racerIds.some(id => first?.racerIds.includes(id)));
  return finish(headline, finding, first ? [first, ...(second ? [second] : [])] : evidence);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => JSON.stringify(key) + ':' + canonicalJson(entry)).join(',') + '}';
}
/** Canonical identity is independent of key/lineup ordering, never an authenticity claim. */
export async function raceReportInputFingerprint(value: RaceReportInput): Promise<string> {
  const input = RaceReportInputSchema.parse(value);
  input.racers.sort((a, b) => a.racerId.localeCompare(b.racerId));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(input)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
