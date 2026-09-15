import {
  RaceEncounterSchema, encounterDurationSeconds, RACE_EVENT_LIMITS as limits,
  type EventVector, type EventRacer, type EventSpawn, type EventStepInputs, type RacerSegment,
  type RacerEventInput, type RaceEventSnapshot, type RaceEventPort,
} from '@sky/shared';
import { SafetyDrillRuntime } from './drill-runtime';
import { add, subtract, scale, length, direction, clampLength, contactTime, seededRandom, finiteVector } from './math';

type Particle={id:number;origin:EventVector;velocity:EventVector;kick:EventVector;born:number;collidable:boolean};
const VORTEX_ORBIT_RADIUS = 12;
const VORTEX_TANGENTIAL_STRENGTH = 0.45;
const emptyInput=():RacerEventInput=>({acceleration:[0,0,0],velocityDelta:[0,0,0],obstacleProtection:false});

/** No DOM, rendering, networking, timers or movement writes. The host owns the clock. */
export class RaceEventRuntime implements RaceEventPort {
  private readonly pickupContactRadius:number;
  constructor(options:{pickupContactRadius?:number}={}) {
    const radius=options.pickupContactRadius??limits.collectibleRadius+limits.racerRadius;
    if(!Number.isFinite(radius)||radius<0.1||radius>limits.maxPickupContactRadius)throw new Error('Invalid pickup contact radius.');
    this.pickupContactRadius=radius;
  }
  private drill?:SafetyDrillRuntime;
  private pickupLifetime(){return this.instance?.pickupLifetimeSeconds??limits.collectibleLifetime;}
  private instance?:EventSpawn;
  private phase:RaceEventSnapshot['phase']='empty';
  private age=0;
  private previousAge=0;
  private drift:EventVector=[0,0,0];
  private triggerer?:string;
  private racers:EventRacer[]=[];
  private particles:Particle[]=[];
  private hit=new Set<string>();
  private affected=new Set<string>();
  private pending=new Map<string,EventVector>();
  private participants:string[]=[];
  private reached=new Set<string>();
  private impulseCounts=new Map<string,number>();
  private debrisHits=new Map<string,number>();
  private blockedDebrisHits=new Map<string,number>();
  private obstacleBlocks=new Map<string,number>();
  private blockedObstacles=new Set<string>();
  private waves=0;
  private markAffected(id:string){this.affected.add(id);this.reached.add(id);}
  private count(counts:Map<string,number>,id:string){counts.set(id,(counts.get(id)??0)+1);}
  recordObstacleBlock(racerId:string,obstacleId:number) {
    if(this.phase!=='active'||this.instance?.spec.version!==3||this.instance.spec.effect.type!=='protectiveZone')return;
    const key=JSON.stringify([racerId,obstacleId]);
    if(!this.blockedObstacles.has(key)){this.blockedObstacles.add(key);this.count(this.obstacleBlocks,racerId);}
  }
  private awaitingContacts=false;
  private expirationReason?:RaceEventSnapshot['expirationReason'];

  spawn(input:EventSpawn) {
    if(this.phase==='collectible'||this.phase==='active')throw new Error('An event creation is already present.');
    if(!input.instanceId||!input.creatorId||!finiteVector(input.position)||!Number.isInteger(input.seed)||input.seed<0||input.seed>0xffffffff)throw new Error('Invalid event spawn metadata.');
    if(input.pickupLifetimeSeconds!==undefined&&(!Number.isFinite(input.pickupLifetimeSeconds)||input.pickupLifetimeSeconds<1||input.pickupLifetimeSeconds>600))throw new Error('Invalid pickup lifetime.');
    const spec=RaceEncounterSchema.parse(input.spec);
    this.reset();this.instance={...input,spec,position:[...input.position]};this.phase='collectible';
  }
  reset() {
    this.instance=undefined;this.phase='empty';this.age=0;this.previousAge=0;this.drift=[0,0,0];
    this.triggerer=undefined;this.racers=[];this.particles=[];this.hit.clear();this.affected.clear();
    this.pending.clear();this.awaitingContacts=false;this.expirationReason=undefined;
    this.participants=[];this.reached.clear();this.impulseCounts.clear();this.debrisHits.clear();
    this.blockedDebrisHits.clear();this.obstacleBlocks.clear();this.blockedObstacles.clear();this.waves=0;this.drill=undefined;
  }
  private burstRadius(age:number,radius:number,duration:number) {
    // Expand quickly so falling racers cannot outrun the front.
    return radius*Math.min(1,age/Math.min(0.25,duration));
  }
  private center(age=this.age):EventVector {
    return this.instance?add(this.instance.position,scale(this.drift,age)):[0,0,0];
  }
  private particlePosition(particle:Particle,age=this.age):EventVector {
    return add(particle.origin,scale(particle.velocity,Math.max(0,age-particle.born)));
  }
  private expire(reason:NonNullable<RaceEventSnapshot['expirationReason']>) {
    this.phase='expired';this.expirationReason=reason;this.pending.clear();this.particles=[];this.affected.clear();
  }
  private activate(racerId:string) {
    this.phase='active';this.triggerer=racerId;this.age=0;this.previousAge=0;this.affected.clear();
    const spec=this.instance!.spec;
    this.participants=this.racers.map(racer=>racer.id);
    if(spec.version===4) {
      this.drill=new SafetyDrillRuntime(spec.drill,this.instance!.seed,this.racers);
      return;
    }
    const effect=spec.effect;
    // A burst stays at contact depth. Persistent fields descend at the pack's activation-time velocity.
    if(effect.type!=='repulsionBurst') {
      const average=this.racers.reduce((sum,racer)=>sum+racer.velocity[1],0)/Math.max(1,this.racers.length);
      this.drift=[0,Math.max(-limits.maxAnchorSpeed,Math.min(0,average)),0];
    }
    if(effect.type==='debrisShower')this.emitDebrisWave();
  }
  private sideDirection(id:string):EventVector {
    let hash=this.instance?.seed??0;
    for(const character of id)hash=(Math.imul(hash,31)+character.charCodeAt(0))>>>0;
    const angle=(hash%360)*Math.PI/180;
    return [Math.cos(angle),0,Math.sin(angle)];
  }
  private vortexForce(offset:EventVector,racerId:string,strength:number):EventVector {
    // A radial spring and tangential force create a broad orbit around the object.
    const lateral=Math.hypot(offset[0],offset[2]);
    const radial:EventVector=lateral>0.01
      ?[offset[0]/lateral,0,offset[2]/lateral]
      :this.sideDirection(racerId);
    const tangent:EventVector=[-radial[2],0,radial[0]];
    const radialStrength=Math.max(-1,Math.min(1,(VORTEX_ORBIT_RADIUS-lateral)/VORTEX_ORBIT_RADIUS))*strength;
    // Soften depth so widely separated racers still feel lateral motion.
    const verticalForce=-Math.max(-strength*0.25,Math.min(strength*0.25,offset[1]*0.08));
    return add(
      add(scale(radial,radialStrength),scale(tangent,strength*VORTEX_TANGENTIAL_STRENGTH)),
      [0,verticalForce,0],
    );
  }
  private burstImpulse(offset:EventVector,racerId:string,impulse:number):EventVector {
    const outward:[number,number,number]=[offset[0],Math.max(-10,Math.min(10,offset[1]*0.08)),offset[2]];
    if(Math.hypot(outward[0],outward[2])<4) {
      const side=this.sideDirection(racerId);
      outward[0]=side[0]*12;outward[2]=side[2]*12;
    }
    return scale(direction(outward),impulse);
  }
  private emitDebrisWave() {
    const spec=this.instance!.spec;
    if(spec.version!==3)return;
    const effect=spec.effect;
    if(effect.type!=='debrisShower'||!this.racers.length)return;
    const wave=this.waves++,random=seededRandom((this.instance!.seed+Math.imul(wave,2654435761))>>>0);
    // Three finite waves. Each racer's first rock aims at their current trajectory;
    // the rest cover nearby lanes. Rocks never home after launch, so steering dodges them.
    for(const collidable of [true,false]) {
      const total=collidable?effect.collidableCount:effect.visualCount;
      const first=Math.floor(total*wave/limits.debrisWaves),end=Math.floor(total*(wave+1)/limits.debrisWaves);
      for(let index=first;index<end;index++) {
        const local=index-first,racer=this.racers[local%this.racers.length];
        const aimed=collidable&&local<this.racers.length;
        const spread=collidable?5:18,angle=random()*Math.PI*2;
        const origin=add(racer.position,[aimed?0:(random()*2-1)*spread,24+(aimed?0:random()*8),aimed?0:(random()*2-1)*spread]);
        this.particles.push({id:collidable?index:effect.collidableCount+index,origin,born:this.age,collidable,
          velocity:add(racer.velocity,[0,-effect.speed,0]),
          kick:scale(direction([Math.cos(angle),-0.55,Math.sin(angle)]),effect.impulse)});
      }
    }
  }

  prepareStep(dt:number,racers:readonly EventRacer[]):EventStepInputs {
    if(!Number.isFinite(dt)||dt<=0||dt>limits.maxStepSeconds)throw new Error('Use a fixed event step in (0, 1/30] seconds.');
    if(this.awaitingContacts)throw new Error('Resolve contacts before preparing the next event tick.');
    const ids=new Set<string>();
    for(const racer of racers) {
      if(!racer.id||ids.has(racer.id)||!finiteVector(racer.position)||!finiteVector(racer.velocity))throw new Error('Invalid or duplicate racer snapshot.');
      ids.add(racer.id);
    }
    this.racers=racers.filter(racer=>!racer.finished).map(racer=>({...racer,position:[...racer.position],velocity:[...racer.velocity]}));
    this.awaitingContacts=true;this.affected.clear();
    const inputs:Record<string,RacerEventInput>=Object.create(null);
    for(const racer of this.racers) {
      inputs[racer.id]={...emptyInput(),velocityDelta:this.pending.get(racer.id)??[0,0,0]};
      if(length(inputs[racer.id].velocityDelta)>0){this.markAffected(racer.id);this.count(this.impulseCounts,racer.id);}
    }
    this.pending.clear();
    if(!this.instance||this.phase==='empty'||this.phase==='expired')return inputs;
    if(!this.racers.length){this.expire('complete');return inputs;}
    this.previousAge=this.age;this.age+=dt;
    if(this.phase==='collectible') {
      if(this.age>=this.pickupLifetime())this.expire('lifetime');
      return inputs;
    }
    if(this.instance.spec.version===4) {
      this.age=Math.min(this.age,encounterDurationSeconds(this.instance.spec));
      const drillInputs=this.drill!.prepareStep(this.age,dt,this.racers);
      for(const racer of this.racers) {
        const input=inputs[racer.id],drillInput=drillInputs[racer.id];
        input.acceleration=clampLength(drillInput.acceleration,limits.maxAcceleration);
        input.obstacleProtection ||= drillInput.obstacleProtection;
        if(length(drillInput.velocityDelta)>0) {
          input.velocityDelta=clampLength(add(input.velocityDelta,drillInput.velocityDelta),limits.maxVelocityDelta);
          this.markAffected(racer.id);this.count(this.impulseCounts,racer.id);
        }
        if(length(input.acceleration)>0||input.obstacleProtection)this.markAffected(racer.id);
      }
      return inputs;
    }
    const effect=this.instance.spec.effect;
    this.age=Math.min(this.age,effect.durationSeconds);
    if(effect.type==='debrisShower'&&this.waves<limits.debrisWaves&&this.age>=effect.durationSeconds*this.waves/limits.debrisWaves)this.emitDebrisWave();
    const center=this.center();
    for(const racer of this.racers) {
      const offset=subtract(racer.position,center),distance=length(offset),input=inputs[racer.id];
      if(effect.type==='gravityWell'&&distance<effect.radiusMeters) {
        const force=this.vortexForce(offset,racer.id,effect.acceleration);
        const attenuation=Math.max(0.5,1-distance/effect.radiusMeters);
        input.acceleration=clampLength(scale(force,attenuation),limits.maxAcceleration);
        this.markAffected(racer.id);
      }
      if(effect.type==='protectiveZone'&&distance<=effect.radiusMeters) {
        input.obstacleProtection=true;input.acceleration=[0,-effect.descentAcceleration,0];this.markAffected(racer.id);
      }
      if(effect.type==='repulsionBurst'&&!this.hit.has(racer.id)&&distance<=this.burstRadius(this.age,effect.radiusMeters,effect.durationSeconds)) {
        const impulse=this.burstImpulse(offset,racer.id,effect.impulse);
        input.velocityDelta=clampLength(add(input.velocityDelta,impulse),limits.maxVelocityDelta);
        this.hit.add(racer.id);this.markAffected(racer.id);this.count(this.impulseCounts,racer.id);
      }
    }
    return inputs;
  }
  resolveContacts(segments:readonly RacerSegment[]) {
    if(!this.awaitingContacts)throw new Error('Prepare the event tick before resolving contacts.');
    this.awaitingContacts=false;
    const byId=new Map(this.racers.map(racer=>[racer.id,racer]));
    const seen=new Set<string>();
    for(const segment of segments) {
      if(seen.has(segment.id)||!finiteVector(segment.from)||!finiteVector(segment.to)||(segment.endFraction!==undefined&&(!Number.isFinite(segment.endFraction)||segment.endFraction<0||segment.endFraction>1)))throw new Error('Invalid or duplicate movement segment.');
      seen.add(segment.id);
    }
    const active=segments.filter(segment=>byId.has(segment.id));
    if(!this.instance)return;
    if(this.phase==='collectible') {
      const contacts=active.flatMap(segment=>{
        const t=contactTime(segment.from,segment.to,this.instance!.position,this.pickupContactRadius);
        return t===undefined||t>(segment.endFraction??1)?[]:[{id:segment.id,t}];
      }).sort((a,b)=>a.t-b.t||(a.id<b.id?-1:a.id>b.id?1:0));
      if(contacts[0])this.activate(contacts[0].id);
      else if(this.racers.length&&this.racers.every(racer=>{
        const position=active.find(segment=>segment.id===racer.id)?.to??racer.position;
        return position[1]<this.instance!.position[1]-this.pickupContactRadius-5;
      }))this.expire('passed');
      return;
    }
    if(this.phase!=='active')return;
    if(this.instance.spec.version===4) {
      for(const [id,kick] of this.drill!.resolveContacts(active,this.racers)) {
        this.pending.set(id,clampLength(add(this.pending.get(id)??[0,0,0],kick),limits.maxVelocityDelta));
        this.reached.add(id);
      }
      if(this.age>=encounterDurationSeconds(this.instance.spec))this.expire('complete');
      return;
    }
    const effect=this.instance.spec.effect;
    if(effect.type==='debrisShower')for(const particle of this.particles) {
      if(!particle.collidable||this.age-particle.born>limits.debrisLifetime)continue;
      for(const segment of active) {
        const key=JSON.stringify([particle.id,segment.id]);
        if(this.hit.has(key))continue;
        const t=contactTime(subtract(segment.from,this.particlePosition(particle,this.previousAge)),
          subtract(segment.to,this.particlePosition(particle)),[0,0,0],limits.debrisRadius+limits.racerRadius);
        if(t===undefined||t>(segment.endFraction??1))continue;
        this.hit.add(key);
        if(byId.get(segment.id)?.protected){this.count(this.blockedDebrisHits,segment.id);continue;}
        this.pending.set(segment.id,clampLength(add(this.pending.get(segment.id)??[0,0,0],particle.kick),limits.maxVelocityDelta));
        this.count(this.debrisHits,segment.id);
      }
    }
    if(this.age>=effect.durationSeconds)this.expire('complete');
  }
  getSnapshot():RaceEventSnapshot {
    const active=this.phase==='active';
    const effect=this.instance?.spec.version===3?this.instance.spec.effect:undefined;
    const duration=this.instance?encounterDurationSeconds(this.instance.spec):0;
    return {phase:this.phase,instance:this.instance,triggererId:this.triggerer,position:this.center(),
      elapsedSeconds:this.age,remainingSeconds:this.phase==='collectible'?Math.max(0,this.pickupLifetime()-this.age):active?Math.max(0,duration-this.age):0,
      radius:active&&effect&&'radiusMeters'in effect?(effect.type==='repulsionBurst'?this.burstRadius(this.age,effect.radiusMeters,effect.durationSeconds):effect.radiusMeters):0,
      debris:active?this.particles.filter(particle=>this.age-particle.born<=limits.debrisLifetime).map(particle=>({id:particle.id,position:this.particlePosition(particle),collidable:particle.collidable})):[],
      affectedRacerIds:[...this.affected].sort(),expirationReason:this.expirationReason,
      drill:active?this.drill?.getSnapshot():undefined,
      impact:{participants:[...this.participants],affectedRacerIds:[...this.reached].sort(),
        impulseCounts:Object.fromEntries(this.impulseCounts),debrisHits:Object.fromEntries(this.debrisHits),
        blockedDebrisHits:Object.fromEntries(this.blockedDebrisHits),obstacleBlocks:Object.fromEntries(this.obstacleBlocks),
        drill:this.drill?.getImpact()}};
  }
}
