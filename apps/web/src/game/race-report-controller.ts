import { authoredRaceReport, buildRaceReportEvidence, raceReportInputFingerprint, RaceReportResponseSchema,
  type RaceReportInput, type RaceReportRequest } from '@sky/shared';
import type { RaceCreationRecord } from './race-creation-history';
import type { PracticeRace } from './practice-race';
import { raceReportInput } from './race-report-input';
import { requestRaceReport, type RaceReportClient } from './race-report-client';

export type RaceIncidentReportView=Readonly<{
  status:'pending'|'complete'|'unavailable';headline:string;highlights:readonly string[];
  finding:string;source:'authored'|'mock'|'ai';message?:string;
}>;
type Job={input:RaceReportInput;mode:'mock'|'live';attemptId?:string;done:boolean;controller:AbortController;local:boolean};

/** Per-event reporting has no simulation clock and is independent of voice-attempt lifetime. */
export class RaceReportController {
  private listeners=new Set<()=>void>();
  private views:Readonly<Record<string,RaceIncidentReportView>>={};
  private jobs=new Map<string,Job>();
  private active?:Job;
  private serial=0;
  private runId='';
  private mode:'mock'|'live'='mock';
  private consent=false;
  private paused=true;
  private voiceBusy=false;
  constructor(private client:RaceReportClient=requestRaceReport,private uuid:()=>string=()=>crypto.randomUUID()) {}
  getSnapshot=()=>this.views;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  get liveRequestPending(){return this.active?.mode==='live';}
  private emit(id:string,view:RaceIncidentReportView){this.views={...this.views,[id]:view};this.listeners.forEach(listener=>listener());}
  reset() {
    this.serial++;
    for(const job of this.jobs.values())job.controller.abort();
    this.jobs.clear();this.active=undefined;this.views={};this.paused=true;this.voiceBusy=false;this.consent=false;this.runId='';
    this.listeners.forEach(listener=>listener());
  }
  begin(mode:'mock'|'live',consent:boolean) {
    this.reset();this.mode=mode;this.consent=consent;this.runId=this.uuid();this.paused=false;
  }
  pause() {
    this.paused=true;
    for(const [id,job] of this.jobs)if(!job.done) {
      job.done=true;job.controller.abort();
      this.emit(id,{...this.views[id],status:'unavailable',message:'Report cancelled by pause. The recorded facts remain available.'});
    }
  }
  resume(){this.paused=false;this.pump();}
  dispose(){this.reset();this.listeners.clear();}
  observe(records:readonly RaceCreationRecord[],racers:PracticeRace['racers'],voiceBusy:boolean) {
    this.voiceBusy=voiceBusy;
    if(!this.runId||this.paused)return;
    for(const record of records) {
      if(this.views[record.instanceId]||!['expired','discarded'].includes(record.status))continue;
      const input=raceReportInput(record,racers,this.runId);
      if(!input) {
        this.emit(record.instanceId,{status:'unavailable',source:'authored',headline:'INSPECTION FILE RETAINED',
          highlights:['The recorded outcome is available in inspection details.'],finding:'The department requires legible paperwork.'});
        continue;
      }
      const report=authoredRaceReport(input),evidence=buildRaceReportEvidence(input);
      // Prepared no-voice drills and replay fixtures must never enter a provider path,
      // even if live reporting was selected before choosing Play without voice.
      const local=record.source==='fixture'||record.source==='prepared';
      const eligible=record.status==='expired'&&(this.mode==='mock'||this.consent||local);
      this.emit(record.instanceId,{status:eligible?'pending':'complete',source:'authored',headline:report.headline,
        highlights:report.evidenceIds.map(id=>evidence.find(fact=>fact.id===id)!.text),finding:report.finding,
        ...(eligible?{message:'The department is preparing its findings.'}:{})});
      if(eligible) {
        const mode=local?'mock':this.mode;
        this.jobs.set(record.instanceId,{input,mode,done:false,controller:new AbortController(),local,
          ...(mode==='live'?{attemptId:this.uuid()}: {})});
      }
    }
    this.pump();
  }
  private pump() {
    if(this.paused||this.voiceBusy||this.active)return;
    const job=[...this.jobs.values()].find(item=>!item.done);
    if(!job)return;
    this.active=job;
    void this.run(job,this.serial);
  }
  private async run(job:Job,serial:number) {
    const id=job.input.creationId;
    const current=()=>serial===this.serial&&!job.done&&!job.controller.signal.aborted&&this.jobs.get(id)===job;
    try {
      const inputFingerprint=await raceReportInputFingerprint(job.input);
      if(!current())return;
      const request:RaceReportRequest={input:job.input,inputFingerprint,mode:job.mode,
        ...(job.attemptId?{paidAttempt:{id:job.attemptId,confirmed:true}}:{})};
      const raw=job.local?{runId:job.input.runId,creationId:id,inputFingerprint,attemptId:null,report:authoredRaceReport(job.input)}
        :await this.client(request,job.controller.signal);
      if(!current())return;
      const response=RaceReportResponseSchema.parse(raw);
      if(response.runId!==job.input.runId||response.creationId!==id||response.inputFingerprint!==inputFingerprint||
        response.attemptId!==(job.attemptId??null))throw new Error('The incident report did not match this event.');
      const evidence=buildRaceReportEvidence(job.input);
      const highlights=response.report.evidenceIds.map(evidenceId=>{
        const fact=evidence.find(item=>item.id===evidenceId);
        if(!fact)throw new Error('The incident report cited an unknown fact.');
        return fact.text;
      });
      if(new Set(response.report.evidenceIds).size!==response.report.evidenceIds.length)throw new Error('The incident report repeated a fact.');
      this.emit(id,{status:'complete',source:job.mode==='live'?'ai':'mock',
        headline:response.report.headline,highlights,finding:response.report.finding});
    } catch {
      if(current())this.emit(id,{...this.views[id],status:'unavailable',
        message:'The AI finding is unavailable. The recorded facts remain available.'});
    } finally {
      job.done=true;
      if(this.active===job)this.active=undefined;
      if(serial===this.serial)this.pump();
    }
  }
}
