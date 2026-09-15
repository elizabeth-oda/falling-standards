import {
  compileSafetyDrill, SAFETY_DRILL_LIMITS, RACE_EVENT_LIMITS,
  type SafetyDrillRecipe, type EventVector, type EventRacer, type RacerSegment,
  type RacerEventInput, type DrillActor, type DrillCurrent, type DrillSnapshot, type DrillImpact,
} from '@sky/shared';
import { PinballDrill } from './pinball-drill';
import { BuddyDrill } from './buddy-drill';
import { OrbitDrill } from './orbit-drill';
import { ReconstructionDrill } from './reconstruction-drill';
import { ObservationDrill } from './observation-drill';
import { createDrillBands, inDrillCourse, increment, midpoint, emptyDrillImpact, emptyStepInputs, type DrillMechanic, type DrillBand } from './drill-mechanics';
import { add, subtract, scale, length, direction, clampLength, contactTime, seededRandom, dot } from './math';

type StampedeRecipe = Extract<SafetyDrillRecipe, {family:'stampede'}>;
type RapidsRecipe = Extract<SafetyDrillRecipe, {family:'rapids'}>;
type Actor = {
  id:number;origin:EventVector;position:EventVector;previous:EventVector;velocity:EventVector;
  sign:number;row:number;
  reaction?:{startsAt:number;origin:EventVector;velocity:EventVector;state:'charging'|'scattering'};
};
type Band = DrillBand;
const currentPriority:Record<DrillCurrent['kind'],number>={eddy:0,fast:1,flow:2};
function unsupportedBehavior(_recipe:never):never {
  throw new Error('Safety drill behavior has no runtime implementation.');
}

/** Closest point on a capsule's centre segment. */
export function closestDrillPoint(point:EventVector,from:EventVector,to:EventVector):EventVector {
  const delta=subtract(to,from),squared=dot(delta,delta);
  const t=squared===0?0:Math.max(0,Math.min(1,dot(subtract(point,from),delta)/squared));
  return add(from,scale(delta,t));
}

/** A subordinate simulation: the race runtime supplies its existing fixed tick and swept contacts. */
class CourseDrill implements DrillMechanic {
  private readonly config;
  private readonly recipe:StampedeRecipe|RapidsRecipe;
  private readonly actors:Actor[]=[];
  private readonly currents:DrillCurrent[]=[];
  private readonly hit=new Set<string>();
  private readonly report=emptyDrillImpact();
  private age=0;

  constructor(recipe:StampedeRecipe|RapidsRecipe,seed:number,racers:readonly EventRacer[]) {
    this.config=SAFETY_DRILL_LIMITS;
    this.recipe=recipe;
    const random=seededRandom(seed);
    const bands=createDrillBands(racers);
    switch(this.recipe.family) {
      case 'stampede':
        for(const band of bands)this.createHerd(this.recipe,band,random);
        break;
      case 'rapids':
        for(const band of bands)this.createRapids(this.recipe,band,random);
        break;
      default: unsupportedBehavior(this.recipe);
    }
  }

  private createHerd(recipe:StampedeRecipe,band:Band,random:()=>number) {
    for(let index=0;index<this.config.actorCount&&this.actors.length<this.config.maxActors;index++) {
      const row=Math.floor(index/4),column=index%4;
      const sign=recipe.direction==='left'?-1:recipe.direction==='right'?1:(row%2?1:-1);
      const split=recipe.formation==='split';
      const x=recipe.formation==='convoy'?(column-1.5)*8:split?(column-1.5)*6+2:-sign*(14+random()*6);
      const z=recipe.formation==='convoy'?(row%2?5:-5):split?0:(column-1.5)*11;
      const origin=inDrillCourse(add(band.origin,[x,-row*this.config.bandLengthMeters/2,z]),this.config.actorRadius);
      this.actors.push({id:this.actors.length,origin,position:origin,previous:origin,velocity:[0,0,0],sign,row});
    }
  }

  private createRapids(recipe:RapidsRecipe,band:Band,random:()=>number) {
    const phase=random()*Math.PI*0.6;
    const branches=recipe.layout==='forked'?2:1;
    for(let path=0;path<branches;path++) {
      const points:EventVector[]=[];
      for(let station=0;station<=7;station++) {
        const t=station/7;
        let x:number,z:number;
        if(recipe.layout==='forked') {
          x=Math.sin(t*Math.PI)*(path===0?12:-17);
          z=Math.sin(t*Math.PI*2)*(path===0?4:7);
        } else {
          x=Math.sin(t*Math.PI*2+phase)*(recipe.layout==='alternating'?19:13);
          z=Math.sin(t*Math.PI+phase)*8;
        }
        points.push(inDrillCourse(add(band.origin,[x,-t*this.config.bandLengthMeters,z]),this.config.currentRadius));
      }
      for(let index=0;index<points.length-1;index++) {
        const from=points[index],to=points[index+1];
        this.currents.push({id:this.currents.length,bandId:band.id,pathId:path,from,to,position:midpoint(from,to),
          radius:path===1?this.config.currentRadius*0.64:this.config.currentRadius,
          direction:direction(subtract(to,from)),kind:path===1?'fast':'flow',strength:0});
      }
    }
    if(recipe.modifier==='eddies')for(const t of [0.3,0.7]) {
      const position=inDrillCourse(add(band.origin,[-21,-t*this.config.bandLengthMeters,-7]),this.config.currentRadius);
      this.currents.push({id:this.currents.length,bandId:band.id,pathId:2,position,
        from:add(position,[0,5,0]),to:add(position,[0,-5,0]),radius:this.config.currentRadius,
        direction:[0,1,0],kind:'eddy',strength:0});
    }
    if(this.currents.length>this.config.maxCurrents)throw new Error('Safety drill exceeded its authored current budget.');
  }

  private actorState(actor:Actor):DrillActor['state'] {
    if(this.age<this.config.warningSeconds||(actor.reaction&&this.age<actor.reaction.startsAt))return 'warning';
    if(actor.reaction)return actor.reaction.state;
    return 'moving';
  }

  private moveActors(recipe:StampedeRecipe,racers:readonly EventRacer[]) {
    const time=Math.max(0,this.age-this.config.warningSeconds);
    for(const actor of this.actors) {
      actor.previous=actor.position;
      if(actor.reaction) {
        const reaction=actor.reaction;
        actor.position=add(reaction.origin,scale(reaction.velocity,Math.max(0,this.age-reaction.startsAt)));
        actor.velocity=this.age<reaction.startsAt?[0,0,0]:reaction.velocity;
        continue;
      }
      if(recipe.formation==='convoy') {
        const lateral=Math.sin(time*0.55+actor.row)*4*actor.sign;
        actor.position=add(actor.origin,[lateral,-this.config.convoySpeed*time,0]);
        actor.velocity=[Math.cos(time*0.55+actor.row)*2.2*actor.sign,-this.config.convoySpeed,0];
      } else {
        const amplitude=recipe.formation==='split'?6:22;
        const phase=time*this.config.crossingSpeed/amplitude;
        const displacement=Math.sin(phase)*amplitude*actor.sign;
        actor.position=add(actor.origin,[displacement,0,0]);
        actor.velocity=[Math.cos(phase)*this.config.crossingSpeed*actor.sign,0,0];
      }
      if(this.age<this.config.warningSeconds){actor.velocity=[0,0,0];continue;}
      if(recipe.reaction==='steady')continue;
      const approached=[...racers].filter(racer=>!racer.finished&&length(subtract(racer.position,actor.position))<=this.config.approachRadius)
        .sort((a,b)=>length(subtract(a.position,actor.position))-length(subtract(b.position,actor.position))||a.id.localeCompare(b.id))[0];
      if(!approached)continue;
      const startsAt=this.age+this.config.reactionWarningSeconds;
      switch(recipe.reaction) {
        case 'charge': {
          // Lock the anticipated point once. Steering after this warning can bait and dodge the charge.
          const target=add(approached.position,scale(clampLength(approached.velocity,60),this.config.reactionWarningSeconds+0.25));
          const velocity=scale(direction(subtract(target,actor.position)),this.config.chargeSpeed);
          actor.reaction={startsAt,origin:actor.position,velocity,state:'charging'};
          break;
        }
        case 'scatter': {
          const away=subtract(actor.position,approached.position);
          const lateral:EventVector=[Math.abs(away[0])<0.1?(actor.id%2?1:-1):away[0],0,away[2]*0.25];
          const velocity=scale(direction(lateral),this.config.scatterSpeed);
          actor.reaction={startsAt,origin:actor.position,velocity,state:'scattering'};
          break;
        }
        default: unsupportedBehavior(recipe.reaction);
      }
      actor.velocity=[0,0,0];this.report.reactions++;
    }
  }

  private actorSnapshot(actor:Actor):DrillActor {
    const state=this.actorState(actor);
    let wake:DrillActor['wake'];
    if(this.recipe.family==='stampede'&&this.recipe.modifier==='draft'&&state!=='warning') {
      const trail=scale(direction(actor.velocity),-1);
      const from=add(actor.position,add(scale(trail,5),[0,3,0]));
      const to=add(actor.position,add(scale(trail,18),[0,10,0]));
      wake={from,to,position:midpoint(from,to),radius:this.config.wakeRadius};
    }
    const telegraph=state==='warning'&&actor.reaction
      ?{from:actor.reaction.origin,to:add(actor.reaction.origin,scale(actor.reaction.velocity,0.75))}:undefined;
    return {id:actor.id,position:actor.position,radius:this.config.actorRadius,velocity:actor.velocity,state,wake,telegraph};
  }

  private currentStrength(current:DrillCurrent):number {
    if(this.age<this.config.warningSeconds)return 0;
    const strength=current.kind==='eddy'?this.config.eddyAcceleration:current.kind==='fast'?this.config.fastAcceleration:this.config.currentAcceleration;
    const pulse=this.recipe.family==='rapids'&&this.recipe.flow==='pulsing'?0.35+0.65*Math.sin(this.age*2.2+current.bandId)**2:1;
    return strength*pulse;
  }

  private applyDraft(racer:EventRacer,actors:readonly DrillActor[],input:RacerEventInput,dt:number) {
    const drafting=actors.some(actor=>actor.wake&&this.contains(racer.position,actor.wake));
    if(!drafting)return;
    input.acceleration=[0,-this.config.draftAcceleration,0];
    increment(this.report.draftSeconds,racer.id,dt);
  }

  private applyCurrent(racer:EventRacer,input:RacerEventInput,dt:number) {
    // Overlapping bands/segments never multiply forces. Eddies override their adjoining fast flow.
    const current=this.currents.filter(current=>this.contains(racer.position,current))
      .sort((a,b)=>currentPriority[a.kind]-currentPriority[b.kind]||a.id-b.id)[0];
    if(!current)return;
    input.acceleration=clampLength(scale(current.direction,this.currentStrength(current)),RACE_EVENT_LIMITS.maxAcceleration);
    increment(this.report.currentSeconds,racer.id,dt);
  }

  private contains(point:EventVector,capsule:Pick<DrillCurrent,'from'|'to'|'radius'>):boolean {
    return length(subtract(point,closestDrillPoint(point,capsule.from,capsule.to)))<=capsule.radius;
  }

  prepareStep(age:number,dt:number,racers:readonly EventRacer[]):Record<string,RacerEventInput> {
    this.age=Math.min(age,this.config.durationSeconds);
    const inputs=emptyStepInputs(racers);
    const eligible=this.age<this.config.warningSeconds?[]:racers.filter(racer=>!racer.finished);
    switch(this.recipe.family) {
      case 'stampede': {
        this.moveActors(this.recipe,racers);
        const actors=this.actors.map(actor=>this.actorSnapshot(actor));
        for(const racer of eligible)this.applyDraft(racer,actors,inputs[racer.id],dt);
        break;
      }
      case 'rapids':
        for(const racer of eligible)this.applyCurrent(racer,inputs[racer.id],dt);
        break;
      default: unsupportedBehavior(this.recipe);
    }
    return inputs;
  }

  resolveContacts(segments:readonly RacerSegment[],racers:readonly EventRacer[]):Map<string,EventVector> {
    const pending=new Map<string,EventVector>();
    if(this.age<this.config.warningSeconds)return pending;
    const byId=new Map(racers.map(racer=>[racer.id,racer]));
    for(const actor of this.actors) {
      if(this.actorState(actor)==='warning')continue;
      for(const segment of segments) {
        const racer=byId.get(segment.id),key=JSON.stringify([actor.id,segment.id]);
        if(!racer||racer.finished||this.hit.has(key))continue;
        const t=contactTime(subtract(segment.from,actor.previous),subtract(segment.to,actor.position),[0,0,0],this.config.actorRadius+RACE_EVENT_LIMITS.racerRadius);
        if(t===undefined||t>(segment.endFraction??1))continue;
        this.hit.add(key);
        if(racer.protected){increment(this.report.blockedCollisions,racer.id);continue;}
        const side=subtract(segment.to,actor.position);
        const kick=scale(direction([Math.abs(side[0])<0.1?actor.sign:side[0],1.2,side[2]*0.4]),this.config.collisionImpulse);
        pending.set(racer.id,clampLength(add(pending.get(racer.id)??[0,0,0],kick),RACE_EVENT_LIMITS.maxVelocityDelta));
        increment(this.report.collisions,racer.id);
      }
    }
    return pending;
  }

  getSnapshot():DrillSnapshot {
    return {actors:this.actors.map(actor=>this.actorSnapshot(actor)),currents:this.currents.map(current=>({...current,strength:this.currentStrength(current)})),
      warningSeconds:Math.max(0,this.config.warningSeconds-this.age)};
  }
  getImpact():DrillImpact {
    return {collisions:{...this.report.collisions},blockedCollisions:{...this.report.blockedCollisions},
      draftSeconds:{...this.report.draftSeconds},currentSeconds:{...this.report.currentSeconds},reactions:this.report.reactions};
  }
}

/** Explicit family dispatch; every mechanic shares collection, timing and the existing race clock. */
export class SafetyDrillRuntime implements DrillMechanic {
  private readonly mechanic:DrillMechanic;
  constructor(input:unknown,seed:number,racers:readonly EventRacer[]) {
    const recipe=compileSafetyDrill(input).recipe;
    switch(recipe.family) {
      case 'stampede': case 'rapids': this.mechanic=new CourseDrill(recipe,seed,racers);break;
      case 'pinball': this.mechanic=new PinballDrill(recipe,seed,racers);break;
      case 'buddy': this.mechanic=new BuddyDrill(recipe,seed,racers);break;
      case 'orbit': this.mechanic=new OrbitDrill(recipe,seed,racers);break;
      case 'reconstruction': this.mechanic=new ReconstructionDrill(recipe,seed,racers);break;
      case 'observation': this.mechanic=new ObservationDrill(recipe,seed,racers);break;
      default: unsupportedBehavior(recipe);
    }
  }
  prepareStep(age:number,dt:number,racers:readonly EventRacer[]) {return this.mechanic.prepareStep(age,dt,racers);}
  resolveContacts(segments:readonly RacerSegment[],racers:readonly EventRacer[]) {return this.mechanic.resolveContacts(segments,racers);}
  getSnapshot() {return this.mechanic.getSnapshot();}
  getImpact() {return this.mechanic.getImpact();}
}
