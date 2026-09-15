import { RaceEncounterSchema, SafetyDrillSpecSchema, mockSafetyDrillForText, mockRaceEventForText, encounterDurationSeconds, type SafetyDrillSpec, type RaceEncounter, type RaceEventSnapshot, type RaceEventPort, type VoicePickup } from '@sky/shared';
import { CreationAttempt } from './creation-attempt';
import { PracticeRace, ITEM_PICKUP_RADIUS, LANE_HALF_WIDTH } from './practice-race';
import { BRAKE_SPEED } from './freefall-controller';
import { RACE_CREATION_PICKUP_RADIUS, CREATION_REVEAL_DELAY_SECONDS, raceEventSpawnPosition, raceCreationTimeRemaining, raceVoiceTimeRequired, raceVoiceStarLeadMeters, raceSecondVoiceStarDepth, raceSecondVoiceTimeRequired } from './race-event-config';
import { obstaclePose, segmentSphere } from './race-course';
import type { Position } from './player-controller';
import type { PromptCapture } from '../voice/types';
import type { AudioCreationClient } from '../voice/voice-client';
import { RaceCreationHistory } from './race-creation-history';

/** Course-owned placement. Never delete obstacles as a side effect of generation. */
export function eventPlacement(race:PracticeRace,durationSeconds=10,includeLaneFallback=false):{position:Position;pickupLifetimeSeconds:number} {
  const player=race.snapshot(race.racers[0]);
  const desired=raceEventSpawnPosition(player.position,player.fallSpeed,durationSeconds);
  const offsets=[[0,0],[-10,0],[10,0],[0,-10],[0,10],[-10,-10],[10,10],[-10,10],[10,-10]];
  const candidates=offsets.map(([x,z]):Position=>[
    Math.max(-LANE_HALF_WIDTH+RACE_CREATION_PICKUP_RADIUS,Math.min(LANE_HALF_WIDTH-RACE_CREATION_PICKUP_RADIUS,desired[0]+x)),desired[1],
    Math.max(-LANE_HALF_WIDTH+RACE_CREATION_PICKUP_RADIUS,Math.min(LANE_HALF_WIDTH-RACE_CREATION_PICKUP_RADIUS,desired[2]+z)),
  ]);
  // Prepared runs must also fit crowded starting rows. Keep the usual depth,
  // pickup bounds, and obstacle clearance; search the wider lane only as fallback.
  if(includeLaneFallback) {
    const edge=LANE_HALF_WIDTH-RACE_CREATION_PICKUP_RADIUS;
    for(const x of [-edge,0,edge])for(const z of [-edge,0,edge])candidates.push([x,desired[1],z]);
  }
  const position=candidates.find(candidate=>race.obstacles.every(obstacle=>{
    if(!obstacle.active)return true;
    const p=obstaclePose(obstacle,race.elapsed).position;
    return Math.abs(p[1]-candidate[1])>(obstacle.kind==='duct'?30:12)||
      Math.hypot(p[0]-candidate[0],p[2]-candidate[2])>(obstacle.kind==='duct'?19:10);
  }));
  if(!position)throw new Error('No clear, reachable space for this creation.');
  const longestLead=Math.max(0,...race.racers.filter(r=>r.finishTime===undefined).map(r=>race.snapshot(r).position[1]-position[1]));
  return {position,pickupLifetimeSeconds:Math.min(600,Math.max(30,Math.ceil(longestLead/BRAKE_SPEED)+30))};
}

export type RaceVoiceOpportunitySnapshot = Readonly<{
  secondStar:'scheduled'|'offered'|'collected'|'consumed'|'missed'|'discarded';
  message:string;
}>;

/** Schedules voice opportunities and placement; never moves racers or resets a shared event between attempts. */
export class RaceEventHost {
  readonly loop:CreationAttempt<RaceEncounter>;
  voice?:VoicePickup;
  private spawnSerial=0;
  runId=0;
  attemptNumber=1;
  private voiceNumber:1|2=1;
  private secondStarDepth=0;
  private opportunitiesClosed=false;
  /** Hold a saved second grant until the shared paid slot is released. */
  paidReportPending?:()=>boolean;
  private opportunity:RaceVoiceOpportunitySnapshot={secondStar:'scheduled',message:''};
  private readonly opportunityListeners=new Set<()=>void>();
  getSnapshot=()=>this.opportunity;
  subscribe=(listener:()=>void)=>{this.opportunityListeners.add(listener);return()=>{this.opportunityListeners.delete(listener);};};
  private updateSecondStar(secondStar:RaceVoiceOpportunitySnapshot['secondStar'],message:string) {
    this.opportunity={secondStar,message};this.opportunityListeners.forEach(listener=>listener());
  }
  get opportunitiesRemaining() {
    return !this.opportunitiesClosed&&['scheduled','offered','collected'].includes(this.opportunity.secondStar)?1:0;
  }
  get nextOpportunityMessage() {
    if(this.loop.getSnapshot().phase==='ended')return this.loop.getSnapshot().message;
    return this.opportunity.message||'No more voice stars this run.';
  }
  requestBlockedReason(stage:'star'|'recording'|'submission'='recording'):string|undefined {
    const player=this.race.racers[0];
    if(player.finishTime!==undefined)return 'You have landed. No new creation can be requested.';
    if(stage==='star')return;
    const {position,fallSpeed}=this.race.snapshot(player);
    if(this.attemptNumber===2) {
      if(stage==='submission'&&raceCreationTimeRemaining(position,fallSpeed)<raceSecondVoiceTimeRequired())
        return 'Too close to landing to place another creation. Nothing was submitted.';
      return;
    }
    if(raceCreationTimeRemaining(position,fallSpeed)<raceVoiceTimeRequired(stage))return 'Not enough race remains to create and collect another object.';
  }
  private lastEvent?:RaceEventSnapshot;
  private readonly history=new RaceCreationHistory();
  private readonly unsubscribeAttempt:()=>void;
  get creations() { return this.history.creations; }
  private readonly events:RaceEventPort;
  get report():RaceEventSnapshot|undefined {
    const current=this.race.finalEventSnapshot??this.events.getSnapshot();
    return current.instance?current:this.lastEvent;
  }
  private remember(current=this.race.finalEventSnapshot??this.events.getSnapshot()) {
    this.history.observe(current,this.race.finished);
    // Retain the latest result separately for the existing development replay.
    if(current.instance)this.lastEvent={...current,debris:[],drill:undefined};
    else if(this.race.finished&&this.lastEvent)this.lastEvent={...this.lastEvent,phase:'expired',remainingSeconds:0,expirationReason:'complete'};
  }
  constructor(readonly race:PracticeRace,private readonly capture:PromptCapture,client?:AudioCreationClient<RaceEncounter>,private readonly starRandom:()=>number=Math.random) {
    if(!race.events)throw new Error('Race event runtime is required.');
    this.events=race.events;
    this.loop=new CreationAttempt({async generate({text}) {
      const fixture=mockSafetyDrillForText(text) ?? mockRaceEventForText(text);
      return fixture?{ok:true,spec:fixture.spec}:{ok:false,error:{message:'Choose a prepared safety-drill prompt.'}};
    }},capture,{
      parse:value=>RaceEncounterSchema.parse(value),
      spawnCreation:(id,spec)=>{
        this.history.add(id,spec,'voice',this.attemptNumber);
        // Check even while queued: speed changes must not leave a ready result
        // waiting until the finish, or replace an event other racers still use.
        if(this.creation||this.loop.getSnapshot().phaseSeconds<CREATION_REVEAL_DELAY_SECONDS){
          const player=this.race.snapshot(this.race.racers[0]);
          raceEventSpawnPosition(player.position,player.fallSpeed,encounterDurationSeconds(spec));
          return 'queued';
        }
        this.spawn(spec,id);
      },
      checkRequest:stage=>this.requestBlockedReason(stage),
      // The runtime has already resolved the shared contact and owns activation.
      activate:()=>{},
    },client);
    this.unsubscribeAttempt=this.loop.subscribe(()=>{
      const state=this.loop.getSnapshot();
      if(state.phase==='failed'||state.phase==='ended')this.history.discardReady(state.message);
      if(state.phase==='failed'&&this.attemptNumber===2&&this.opportunity.secondStar==='consumed')
        this.updateSecondStar('discarded',state.message);
    });
    this.reset();
  }
  get creation() {
    const state=this.events.getSnapshot();
    return state.instance&&(state.phase==='collectible'||state.phase==='active')
      ?{instanceId:state.instance.instanceId,spec:state.instance.spec,position:[...state.position] as Position}:undefined;
  }
  spawn(spec:RaceEncounter,instanceId:string,quick=false) {
    if(this.race.racers[0].finishTime!==undefined)throw new Error('Race finished before generation completed.');
    const player=this.race.snapshot(this.race.racers[0]);
    const placement=quick?{position:[player.position[0],player.position[1]-30,player.position[2]] as Position,pickupLifetimeSeconds:60}:eventPlacement(this.race,encounterDurationSeconds(spec));
    this.spawnAt(spec,instanceId,placement);
  }
  private spawnAt(spec:RaceEncounter,instanceId:string,placement:ReturnType<typeof eventPlacement>) {
    // Separate deterministic stream: debris never consumes the inventory/rival RNG.
    const seed=Math.imul(++this.spawnSerial,2654435761)>>>0;
    this.remember();
    this.events.spawn({instanceId,creatorId:'0',spec,seed,...placement});this.remember();
  }
  loadFixture(spec:RaceEncounter,quick=false) {
    // Called only by the development fixture panel while paused, before starting.
    this.opportunitiesClosed=true;this.updateSecondStar('discarded','Voice stars are off for this fixture run.');
    this.loop.end('Local event fixture loaded. No microphone or API calls.');this.voice=undefined;
    const instanceId='fixture-'+this.loop.getSnapshot().session;
    this.spawn(spec,instanceId,quick);
    this.history.add(instanceId,this.events.getSnapshot().instance!.spec,'fixture');this.remember();
  }
  /** A no-voice run still gets one prepared drill through normal shared contact. */
  loadPreparedDrill(spec:SafetyDrillSpec) {
    const prepared=SafetyDrillSpecSchema.parse(spec);
    this.checkBeforeRun();
    const placement=eventPlacement(this.race,encounterDurationSeconds(prepared),true);
    this.disableForRun();
    const instanceId='prepared-'+this.runId;
    this.spawnAt(prepared,instanceId,placement);
    this.history.add(instanceId,prepared,'prepared');this.remember();
  }
  reset() {
    this.remember();
    if(this.lastEvent&&this.lastEvent.phase!=='expired')this.lastEvent={...this.lastEvent,phase:'expired',remainingSeconds:0,expirationReason:'reset'};
    this.history.clear();
    this.runId++;this.attemptNumber=1;this.voiceNumber=1;this.opportunitiesClosed=false;
    this.secondStarDepth=raceSecondVoiceStarDepth(this.starRandom());
    this.loop.reset();this.race.eventBridge!.reset();this.spawnSerial=0;
    const player=this.race.snapshot(this.race.racers[0]);
    this.voice={kind:'voice',instanceId:'voice-'+this.runId+'-1',position:[player.position[0],-180,player.position[2]]};
    this.updateSecondStar('scheduled','A second yellow star appears at 60-70% of the course.');
  }
  private checkBeforeRun() {
    if (this.race.elapsed !== 0 || this.loop.getSnapshot().running || this.creation || this.race.racers[0].finishTime !== undefined) {
      throw new Error('Voice can only be disabled before the race.');
    }
  }
  disableForRun() {
    this.checkBeforeRun();
    this.voice = undefined;this.opportunitiesClosed=true;
    this.updateSecondStar('discarded','Voice creation is off for this run.');
    this.loop.end('Voice creation is off for this run.');
  }
  start(){this.loop.start();}
  pause(){
    if(this.opportunity.secondStar==='collected')this.updateSecondStar('discarded','Saved second request cancelled by pause.');
    this.loop.cancelRecording();
    // Prepared input also needs releasing when no voice attempt is active.
    this.capture.cancel();
  }
  dispose(){
    this.opportunitiesClosed=true;this.voice=undefined;
    this.updateSecondStar('discarded','Run ended. Saved voice requests were discarded.');
    this.unsubscribeAttempt();this.loop.dispose();this.history.clear();this.race.eventBridge!.reset();
  }
  private offerSecondStar(to:Position) {
    if(this.opportunitiesClosed||this.opportunity.secondStar!=='scheduled'||!this.loop.getSnapshot().running)return;
    const {position:[x,,z],fallSpeed}=this.race.snapshot(this.race.racers[0]);
    if(-to[1]<this.secondStarDepth-raceVoiceStarLeadMeters(fallSpeed))return;
    this.voiceNumber=2;
    this.voice={kind:'voice',instanceId:'voice-'+this.runId+'-2',position:[x,-this.secondStarDepth,z]};
    this.updateSecondStar('offered','Second yellow star ahead. Collect it for another request.');
  }
  private collectOrMissVoice(from:Position,to:Position) {
    if(!this.voice)return;
    if(segmentSphere(from,to,this.voice.position,ITEM_PICKUP_RADIUS)) {
      this.voice=undefined;
      if(this.voiceNumber===1)this.loop.collectVoice();
      else this.updateSecondStar('collected','Second request saved. Waiting for the current voice request to finish.');
    } else if(to[1]<this.voice.position[1]-5) {
      this.voice=undefined;
      if(this.voiceNumber===1)this.loop.missVoice();
      else this.updateSecondStar('missed','Second yellow star missed. No more voice stars this run.');
    }
  }
  private startSavedGrant() {
    if(this.opportunitiesClosed||this.opportunity.secondStar!=='collected'||!this.loop.getSnapshot().running)return;
    // Voice work must settle first, including placement of a ready first result.
    // A spawned first object and its active effect remain entirely runtime-owned.
    if(!['spawned','activated','missed','failed'].includes(this.loop.getSnapshot().phase))return;
    if(this.paidReportPending?.()) {
      if(this.opportunity.message!=='Second request saved. Waiting for the incident report to finish.')
        this.updateSecondStar('collected','Second request saved. Waiting for the incident report to finish.');
      return;
    }
    this.attemptNumber=2;
    this.updateSecondStar('consumed','');
    this.loop.rearm();this.loop.start();this.loop.collectVoice();
  }
  step(dt:number,from:Position,to:Position) {
    const event=this.events.getSnapshot();
    this.remember(this.race.finalEventSnapshot??event);
    if(event.instance&&event.phase==='active')this.loop.collectCreation(event.instance.instanceId);
    if(event.instance&&event.phase==='expired')this.loop.missCreation(event.instance.instanceId);
    if(this.race.racers[0].finishTime!==undefined) {
      const pending=['prompted','preparing','recording','transcribing','generating','ready'].includes(this.loop.getSnapshot().phase);
      if(['scheduled','offered','collected'].includes(this.opportunity.secondStar)||(this.attemptNumber===2&&pending))
        this.updateSecondStar('discarded','You landed before the second request could be completed.');
      if(this.loop.getSnapshot().running)this.loop.end('You landed. Shared events remain for the racers still falling.');
      this.voice=undefined;this.opportunitiesClosed=true;return;
    }
    if(this.voiceNumber===1&&this.voice&&this.loop.getSnapshot().phase!=='available')this.voice=undefined;
    this.loop.placeReadyCreation();
    // Resolve the first pickup before revealing a second one, including swept crossings.
    if(this.voiceNumber===1)this.collectOrMissVoice(from,to);
    this.offerSecondStar(to);
    if(this.voiceNumber===2)this.collectOrMissVoice(from,to);
    this.loop.advanceTime(dt);
    this.startSavedGrant();
  }
}
