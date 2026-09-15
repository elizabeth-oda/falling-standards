import { SAFETY_DRILL_LIMITS, type EventRacer, type EventVector, type RacerSegment,
  type RacerEventInput, type DrillSnapshot, type DrillImpact, type DrillObserver } from '@sky/shared';
import { add, scale, subtract, dot } from './math';

/** A family is driven by the race's existing tick; it never owns movement or input. */
export interface DrillMechanic {
  prepareStep(age:number,dt:number,racers:readonly EventRacer[]):Record<string,RacerEventInput>;
  resolveContacts(segments:readonly RacerSegment[],racers:readonly EventRacer[]):Map<string,EventVector>;
  getSnapshot():DrillSnapshot;
  getImpact():DrillImpact;
}
export type DrillBand = {id:number;origin:EventVector};
export function increment(record:Record<string,number>,id:string,amount=1) {
  if(!Object.hasOwn(record,id))Object.defineProperty(record,id,{value:0,writable:true,enumerable:true,configurable:true});
  record[id]+=amount;
}
export const midpoint = (a:EventVector,b:EventVector):EventVector => scale(add(a,b),0.5);
export const emptyDrillImpact = ():Required<DrillImpact> => ({
  collisions:{},blockedCollisions:{},
  draftSeconds:{},currentSeconds:{},reactions:0,
  bounces:{},tetherSeconds:{},orbitSeconds:{},
  orbitReleases:{},observationFlags:{},blockedObservations:{},
});
export function emptyStepInputs(racers:readonly EventRacer[]):Record<string,RacerEventInput> {
  const inputs:Record<string,RacerEventInput>=Object.create(null);
  for(const racer of racers)inputs[racer.id]={acceleration:[0,0,0],velocityDelta:[0,0,0],obstacleProtection:false};
  return inputs;
}
export function inDrillCourse(position:EventVector,margin:number):EventVector {
  const edge=SAFETY_DRILL_LIMITS.laneHalfWidth-margin;
  return [Math.max(-edge,Math.min(edge,position[0])),position[1],Math.max(-edge,Math.min(edge,position[2]))];
}
/** Freeze shared bands once at activation, preserving the legacy placement and RNG order. */
export function createDrillBands(racers:readonly EventRacer[]):DrillBand[] {
  const groups:EventRacer[][]=[];
  for(const racer of [...racers].filter(racer=>!racer.finished).sort((a,b)=>b.position[1]-a.position[1]||a.id.localeCompare(b.id))) {
    const group=groups.find(group=>Math.abs(group[0].position[1]-racer.position[1])<SAFETY_DRILL_LIMITS.bandSpacing);
    if(group)group.push(racer);
    else if(groups.length<SAFETY_DRILL_LIMITS.maxBands)groups.push([racer]);
  }
  return groups.map((group,id)=>({id,origin:[
    Math.max(-12,Math.min(12,group.reduce((sum,racer)=>sum+racer.position[0],0)/group.length)),
    Math.min(...group.map(racer=>racer.position[1]))-SAFETY_DRILL_LIMITS.bandLeadMeters,
    Math.max(-10,Math.min(10,group.reduce((sum,racer)=>sum+racer.position[2],0)/group.length)),
  ]}));
}
/** Shared by the observer mechanic and rival planning; rendering uses these same cone bounds. */
export function insideObservationCone(point:EventVector,observer:DrillObserver):boolean {
  const offset=subtract(point,observer.position),axial=dot(offset,observer.direction);
  const radialSquared=Math.max(0,dot(offset,offset)-axial*axial);
  const tangentSquared=1/(observer.cosHalfAngle*observer.cosHalfAngle)-1;
  return axial>0 && axial<=observer.range && radialSquared<=axial*axial*tangentSquared;
}
