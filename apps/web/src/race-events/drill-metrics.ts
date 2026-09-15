import type { DrillImpact, SafetyDrillRecipe } from '@sky/shared';

export function drillMetricSummary(family:SafetyDrillRecipe['family'],impact:DrillImpact,racerId?:string):string {
  const count=(record:Record<string,number>={})=>racerId===undefined?Object.values(record).reduce((sum,value)=>sum+value,0):(Object.hasOwn(record,racerId)?record[racerId]:0);
  switch(family) {
    case 'stampede': return `${count(impact.collisions)} equipment contacts · ${count(impact.blockedCollisions)} blocked · ${count(impact.draftSeconds).toFixed(1)} s drafting`;
    case 'rapids': return `${count(impact.currentSeconds).toFixed(1)} s riding currents`;
    case 'pinball': return `${count(impact.bounces)} bumper bounces`;
    case 'buddy': return `${count(impact.tetherSeconds).toFixed(1)} s under buddy tension`;
    case 'orbit': return `${count(impact.orbitSeconds).toFixed(1)} s orbiting · ${count(impact.orbitReleases)} slingshot exits`;
    case 'reconstruction': return `${count(impact.collisions)} echo contacts · ${count(impact.blockedCollisions)} blocked`;
    case 'observation': return `${count(impact.observationFlags)} movement flags · ${count(impact.blockedObservations)} intercepted by protection`;
    default: {const unsupported:never=family;throw new Error(`Missing drill metrics: ${unsupported}`);}
  }
}
