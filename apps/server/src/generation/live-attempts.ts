import type { LiveUsage, PipelineRequest } from '@sky/shared';
import { PipelineFailure } from './pipeline-errors.js';

export type LivePolicy = {enabled:boolean; maxAttempts:number};
export type ReportAdmission = {runId:string;creationId:string};
// One gate per server instance. Tabs/profiles on that instance share it; other instances do not.
export class LiveAttempts {
  private used = new Set<string>();
  private busy = false;
  private reportKeys = new Set<string>();
  private reportsPerRun = new Map<string,number>();
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
    const reportKey = report ? JSON.stringify([report.runId,report.creationId]) : undefined;
    if (reportKey && this.reportKeys.has(reportKey)) throw new PipelineFailure('DUPLICATE_ATTEMPT','This event report was already dispatched. It will not run again.');
    if (report && (this.reportsPerRun.get(report.runId) ?? 0) >= 2) throw new PipelineFailure('LIVE_LIMIT_REACHED','This run has already used its two event reports.');
    if (this.busy) throw new PipelineFailure('LIVE_BUSY','Another paid attempt is running. Wait for it to finish.');
    if (this.used.size >= this.policy.maxAttempts) throw new PipelineFailure('LIVE_LIMIT_REACHED','The paid allowance for this server instance is exhausted.');
    // Reserve synchronously before dispatch, including attempts that later fail or cancel.
    this.used.add(id);
    if (report && reportKey) {
      // Entries belong to admitted attempts and share the allowance bound.
      this.reportKeys.add(reportKey);
      this.reportsPerRun.set(report.runId,(this.reportsPerRun.get(report.runId) ?? 0)+1);
    }
    this.busy = true;
    return () => {this.busy = false;};
  }
}
