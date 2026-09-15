import {
  authoredRaceReport, buildRaceReportEvidence, canonicalRaceReportInputs, raceReportInputFingerprint,
  RaceReportRequestSchema, RaceReportResponseSchema, validateRaceReportContent,
  type RaceReportInput, type RaceReportRequest,
} from '@sky/shared';
import type { PracticeRace } from './practice-race';
import type { RaceCreationRecord } from './race-creation-history';
import { raceReportInput, type RaceReportLineup } from './race-report-input';
import { requestRaceReport, type RaceReportClient } from './race-report-client';

export type RaceIncidentReportView = Readonly<{
  status: 'provisional' | 'pending' | 'complete' | 'unavailable';
  headline: string;
  highlights: readonly string[];
  finding: string;
  source: 'authored' | 'mock' | 'ai';
  message?: string;
}>;
type ReportViews = Readonly<Record<string, RaceIncidentReportView>>;
type Job = {
  inputs: RaceReportInput[];
  signature: string;
  attemptId?: string;
  controller: AbortController;
  serial: number;
};
const unavailableMessage = 'The AI finding is unavailable. The recorded facts remain available.';
const terminal = (record: RaceCreationRecord) => record.status === 'expired' || record.status === 'discarded';

function authoredView(record: RaceCreationRecord, input: RaceReportInput | undefined, provisional: boolean): RaceIncidentReportView {
  if (input) {
    const report = authoredRaceReport(input), evidence = buildRaceReportEvidence(input);
    return {
      status: provisional ? 'provisional' : 'complete', source: 'authored', headline: report.headline,
      highlights: report.evidenceIds.map(id => evidence.find(fact => fact.id === id)!.text), finding: report.finding,
    };
  }
  const open = !terminal(record);
  const fact = record.status === 'active' ? 'The drill is still active. Its recorded results can still change.'
    : record.status === 'collectible' ? 'Waiting for a racer to collect it. It has not affected the race yet.'
      : record.status === 'ready' ? 'Created and waiting for course space. It has not entered the race yet.'
        : 'The recorded outcome is available in inspection details.';
  return {
    status: provisional || open ? 'provisional' : 'unavailable', source: 'authored',
    headline: open ? 'INSPECTION STILL IN PROGRESS' : 'INSPECTION FILE RETAINED', highlights: [fact],
    finding: open ? 'The paperwork remains open. Please avoid spilling anything on it.' : 'The department requires legible paperwork.',
  };
}

/** One batch belongs to a run's results, independently of the voice attempt and viewer. */
export class RaceReportController {
  private readonly listeners = new Set<() => void>();
  private views: ReportViews = {};
  private serial = 0;
  private runId = '';
  private mode: 'mock' | 'live' = 'mock';
  private consent = false;
  private attemptId?: string;
  private paused = true;
  private submitted = false;
  private signature?: string;
  private active?: Job;
  private lineup?: RaceReportLineup;

  constructor(private readonly client: RaceReportClient = requestRaceReport,
    private readonly uuid: () => string = () => crypto.randomUUID()) {}

  getSnapshot = (): ReportViews => this.views;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  get liveRequestPending() { return this.mode === 'live' && this.active !== undefined; }

  private publish(views: ReportViews) {
    if (JSON.stringify(views) === JSON.stringify(this.views)) return;
    this.views = views;
    this.listeners.forEach(listener => listener());
  }
  private freezeLineup(racers: RaceReportLineup) {
    this.lineup = racers.map(({id, model}) => ({id, model}));
  }
  reset() {
    this.serial++;
    this.active?.controller.abort();
    this.active = undefined;
    this.runId = '';
    this.attemptId = undefined;
    this.lineup = undefined;
    this.consent = false;
    this.submitted = false;
    this.signature = undefined;
    this.paused = true;
    this.publish({});
  }
  begin(mode: 'mock' | 'live', consent: boolean, racers?: RaceReportLineup) {
    this.reset();
    this.mode = mode;
    this.consent = mode === 'live' && consent;
    this.runId = this.uuid();
    if (this.consent) this.attemptId = this.uuid();
    if (racers) this.freezeLineup(racers);
    this.paused = false;
  }
  /** An in-progress run can revoke reporting, but cannot grant itself new authorization. */
  setConsent(consent: boolean) {
    if (consent) return;
    this.consent = false;
    if (this.active) this.cancel('The report was cancelled. The recorded facts remain available.');
    this.attemptId = undefined;
  }
  pause() {
    this.paused = true;
    this.cancel('Report cancelled by pause. The recorded facts remain available.');
  }
  resume() { this.paused = false; }
  dispose() { this.reset(); this.listeners.clear(); }

  private cancel(message: string) {
    const job = this.active;
    if (!job) return;
    job.controller.abort();
    this.active = undefined;
    const next = {...this.views};
    for (const input of job.inputs) {
      const view = next[input.creationId];
      if (view) next[input.creationId] = {...view, source: 'authored', status: 'unavailable', message};
    }
    this.publish(next);
  }

  observe(records: readonly RaceCreationRecord[], racers: PracticeRace['racers'], voiceBusy: boolean) {
    if (!this.runId || this.paused) return;
    if (!this.lineup) this.freezeLineup(racers);
    const lineup = this.lineup!;
    const finished = lineup.length === 4 && racers.length === 4 &&
      new Set(racers.map(racer => racer.id)).size === 4 &&
      lineup.every(person => racers.some(racer => racer.id === person.id && racer.finishTime !== undefined));
    const inputs: RaceReportInput[] = [];
    const voiceRecords = records.filter(record => record.source === 'voice');
    const next: Record<string, RaceIncidentReportView> = {};
    for (const record of records) {
      const input = raceReportInput(record, lineup, this.runId);
      next[record.instanceId] = authoredView(record, input, !finished);
      if (input && record.source === 'voice') inputs.push(input);
      if (finished && input && record.source !== 'voice') next[record.instanceId] = {...next[record.instanceId], source: 'mock'};
    }
    const finalized = voiceRecords.length > 0 && voiceRecords.length <= 2 &&
      voiceRecords.every(terminal) && inputs.length === voiceRecords.length;
    let signature: string | undefined;
    if (finalized) {
      try { signature = canonicalRaceReportInputs(inputs); } catch { /* Keep authored facts for invalid batches. */ }
    }

    if (this.submitted) {
      // Any change to the finalized batch invalidates the whole response, including a
      // second creation appearing after dispatch. Never repair it with another call.
      const changed = !finished || voiceBusy || signature !== this.signature;
      if (changed) this.cancel('The race results changed. The recorded facts remain available.');
      for (const record of voiceRecords) {
        const previous = this.views[record.instanceId];
        if (changed) next[record.instanceId] = {...next[record.instanceId], status: 'unavailable',
          message: 'The race results changed. The recorded facts remain available.'};
        else if (previous) next[record.instanceId] = previous;
      }
      this.publish(next);
      return;
    }

    this.publish(next);
    if (!finished || voiceBusy || !finalized || signature === undefined || (this.mode === 'live' && !this.consent)) return;
    // Mark before fingerprinting or awaiting transport: duplicate observers and viewer
    // mounts cannot allocate a second request, even while crypto is still pending.
    this.submitted = true;
    this.signature = signature;
    const job: Job = {inputs, signature, controller: new AbortController(), serial: this.serial,
      ...(this.mode === 'live' ? {attemptId: this.attemptId} : {})};
    this.active = job;
    const pending = {...this.views};
    for (const input of inputs) pending[input.creationId] = {...pending[input.creationId], status: 'pending'};
    this.publish(pending);
    void this.run(job);
  }

  private async run(job: Job) {
    const current = () => this.active === job && job.serial === this.serial && !job.controller.signal.aborted;
    try {
      const inputFingerprint = await raceReportInputFingerprint(job.inputs);
      if (!current()) return;
      const request: RaceReportRequest = RaceReportRequestSchema.parse({inputs: job.inputs, inputFingerprint, mode: this.mode,
        ...(job.attemptId ? {paidAttempt: {id: job.attemptId, confirmed: true}} : {})});
      const raw = await this.client(request, job.controller.signal);
      if (!current()) return;
      const response = RaceReportResponseSchema.parse(raw);
      if (response.runId !== this.runId || response.inputFingerprint !== inputFingerprint ||
        response.attemptId !== (job.attemptId ?? null)) throw new Error('The report does not belong to these race results.');
      const content = validateRaceReportContent(job.inputs, {items: response.items});
      const next = {...this.views};
      // Validate every item before publishing any generated text.
      for (const item of content.items) {
        const input = job.inputs.find(input => input.creationId === item.creationId)!;
        const evidence = buildRaceReportEvidence(input);
        next[item.creationId] = {status: 'complete', source: this.mode === 'live' ? 'ai' : 'mock',
          headline: item.headline, finding: item.finding,
          highlights: item.evidenceIds.map(id => evidence.find(fact => fact.id === id)!.text)};
      }
      this.publish(next);
    } catch {
      if (current()) {
        const next = {...this.views};
        for (const input of job.inputs) next[input.creationId] = {...next[input.creationId], status: 'unavailable', message: unavailableMessage};
        this.publish(next);
      }
    } finally {
      if (this.active === job) this.active = undefined;
    }
  }
}
