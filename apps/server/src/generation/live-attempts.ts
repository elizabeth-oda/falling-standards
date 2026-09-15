import type { LiveUsage, PipelineRequest } from '@sky/shared';
import { PipelineFailure } from './pipeline-errors.js';

export type LivePolicy = {enabled:boolean; maxAttempts:number};
export type ReportAdmission = {runId:string;inputFingerprint:string};
// One gate per server instance. Tabs/profiles on that instance share it; other instances do not.
export class LiveAttempts {
  private used = new Set<string>();
  private busy = false;
  private reportsByRun = new Map<string,{attemptId:string;inputFingerprint:string}>();
  constructor(private policy:LivePolicy = {enabled:false,maxAttempts:3}) {
    if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 500) {
      throw new Error('LIVE_MAX_ATTEMPTS must be an integer from 1 to 500');
    }
  }
  get status():LiveUsage {
    return {enabled:this.policy.enabled,maxAttempts:this.policy.maxAttempts,attemptsUsed:this.used.size,
      attemptsRemaining:this.policy.maxAttempts-this.used.size,busy:this.busy};
  }
  acquire(request:Pick<PipelineRequest,'paidAttempt'>,report?:ReportAdmission):() => void {
    if (!this.policy.enabled) throw new PipelineFailure('LIVE_DISABLED','Paid generation is disabled. Start bun run dev:live to opt in.');
    if (!request.paidAttempt?.confirmed) throw new PipelineFailure('CONSENT_REQUIRED','Paid attempt metadata is required before generating.');
    const id = request.paidAttempt.id;
    if (this.used.has(id)) throw new PipelineFailure('DUPLICATE_ATTEMPT','This paid attempt was already dispatched. It will not run again.');
    if (report && this.reportsByRun.has(report.runId)) throw new PipelineFailure('DUPLICATE_ATTEMPT','This run already dispatched its incident reports. It will not run again.');
    if (this.busy) throw new PipelineFailure('LIVE_BUSY','Another paid attempt is running. Wait for it to finish.');
    if (this.used.size >= this.policy.maxAttempts) throw new PipelineFailure('LIVE_LIMIT_REACHED','The paid allowance for this server instance is exhausted.');
    // Reserve synchronously before dispatch, including attempts that later fail or cancel.
    this.used.add(id);
    // Retain only admission metadata. Every entry consumes the same bounded allowance.
    if (report) this.reportsByRun.set(report.runId,{attemptId:id,inputFingerprint:report.inputFingerprint});
    this.busy = true;
    let released=false;
    return () => {if (!released) {released=true;this.busy=false;}};
  }
}
