import {
  RACE_EVENT_LIMITS, SAFETY_DRILL_LIMITS,
  type DrillActor, type DrillCurrent, type DrillSnapshot, type EventVector,
  type RaceEventEffect, type RaceEventSnapshot, type SafetyDrillRecipe,
} from '@sky/shared';
import { closestDrillPoint } from '../race-events/drill-runtime';
import { length, subtract } from '../race-events/math';
import { observationFeedback } from './observation-feedback';

export type EffectFeedback = {
  tone:'warning'|'neutral'|'danger'|'benefit';
  title:string;
  detail:string;
  status?:string;
  meter?:{label:string;value:number|null};
  controls?:{action:'steer'|'release-steering';detail:string};
};

const steer=(detail:string):NonNullable<EffectFeedback['controls']>=>({action:'steer',detail});
const clampFraction=(value:number)=>Math.max(0,Math.min(1,value));
const currentPriority:Record<DrillCurrent['kind'],number>={eddy:0,fast:1,flow:2};
const containsCapsule=(position:EventVector,capsule:{from:EventVector;to:EventVector;radius:number})=>
  length(subtract(position,closestDrillPoint(position,capsule.from,capsule.to)))<=capsule.radius;

/** A cue's approach range only selects useful text; it never changes contact or force bounds. */
function nearbyActor(position:EventVector,actor:DrillActor) {
  return length(subtract(position,actor.position))<=SAFETY_DRILL_LIMITS.approachRadius
    ||(actor.telegraph!==undefined&&containsCapsule(position,{...actor.telegraph,radius:actor.radius+RACE_EVENT_LIMITS.racerRadius}));
}
function echoAhead(position:EventVector,actor:DrillActor) {
  const ahead=position[1]-actor.position[1];
  return actor.kind==='echo'&&ahead>=-actor.radius&&ahead<=SAFETY_DRILL_LIMITS.bandLengthMeters
    &&Math.hypot(position[0]-actor.position[0],position[2]-actor.position[2])<=SAFETY_DRILL_LIMITS.approachRadius;
}

function stampedeFeedback(recipe:Extract<SafetyDrillRecipe,{family:'stampede'}>,drill:DrillSnapshot|undefined,position:EventVector):EffectFeedback {
  const actors=drill?.actors??[],nearby=actors.filter(actor=>nearbyActor(position,actor));
  const warning=(drill?.warningSeconds??0)>0;
  const action:Record<typeof recipe.reaction,Pick<EffectFeedback,'title'|'detail'|'controls'>>={
    charge:{title:'CHARGING HERD',detail:'Approach to bait a charge. Once its direction is marked, dodge the line and body.',controls:steer('Dodge after the warning')},
    scatter:{title:'SCATTERING HERD',detail:'Nearby bodies warn, then scatter along fixed paths. Avoid the bodies and follow the opening.',controls:steer('Find the gap between bodies')},
    steady:recipe.formation==='convoy'
      ?{title:'CONVOY',detail:'The convoy descends together. Steer around its bodies to avoid being knocked away.',controls:steer('Pass between the convoy bodies')}
      :{title:'STAMPEDE',detail:'Bodies cross the course and knock you away on contact. Steer through the spaces between them.',controls:steer('Aim between the bodies')},
  };
  const base={...action[recipe.reaction],detail:action[recipe.reaction].detail
    +(recipe.modifier==='draft'?' Cyan wakes speed your descent; follow them clear of the bodies.':'')};
  if(!warning&&recipe.reaction==='charge'&&nearby.some(actor=>actor.state==='warning'&&actor.telegraph))return {
    ...base,tone:'warning',status:'Charge committed · dodge',
  };
  if(!warning&&recipe.reaction==='charge'&&nearby.some(actor=>actor.state==='charging'))return {
    ...base,tone:'danger',status:'Charge nearby · dodge',
  };
  if(!warning&&recipe.modifier==='draft'&&actors.some(actor=>actor.state!=='warning'&&actor.wake&&containsCapsule(position,actor.wake)))return {
    ...base,tone:'benefit',status:'In the wake · faster fall',
  };
  if(!warning&&recipe.reaction==='scatter'&&nearby.some(actor=>actor.state==='scattering'))return {
    ...base,tone:'neutral',status:'Gap opening',
  };
  if(!warning&&recipe.reaction==='scatter'&&nearby.some(actor=>actor.state==='warning'&&actor.telegraph))return {
    ...base,tone:'warning',status:'Scattering soon · clear paths',
  };
  return {...base,tone:warning?'warning':'neutral',status:warning?'Herd incoming':'Watch the bodies'};
}

function rapidsFeedback(recipe:Extract<SafetyDrillRecipe,{family:'rapids'}>,drill:DrillSnapshot|undefined,position:EventVector):EffectFeedback {
  const warning=(drill?.warningSeconds??0)>0;
  const base={title:'SKY RAPIDS',
    detail:(recipe.layout==='forked'?'Choose the wide flow or the narrow fast branch. Follow your chosen current.':
      recipe.layout==='alternating'?'Switch lanes with the alternating current and follow its bends.':'Enter the current and follow its bends.')
      +(recipe.flow==='pulsing'?' Its push rises and falls in pulses.':'')
      +(recipe.modifier==='eddies'?' Green eddies slow your fall.':''),
    controls:steer('Follow the flowing current')};
  // Match the runtime's single winning capsule, including overlap and id priority.
  const current=drill?.currents.filter(current=>containsCapsule(position,current))
    .sort((a,b)=>currentPriority[a.kind]-currentPriority[b.kind]||a.id-b.id)[0];
  if(!warning&&current&&current.strength>0) {
    const cues:Record<DrillCurrent['kind'],Pick<EffectFeedback,'tone'|'status'>>={
      eddy:{tone:'warning',status:'Eddy · slower fall'},
      fast:{tone:'benefit',status:'Fast current'},
      flow:{tone:'benefit',status:'In the flow'},
    };
    return {...base,...cues[current.kind]};
  }
  return {...base,tone:warning?'warning':'neutral',status:warning?'Currents incoming':'Find the flow'};
}

function v4Feedback(recipe:SafetyDrillRecipe,event:RaceEventSnapshot,position:EventVector,racerId:string):EffectFeedback|null {
  const drill=event.drill,warning=(drill?.warningSeconds??0)>0;
  switch(recipe.family) {
    case 'stampede': return stampedeFeedback(recipe,drill,position);
    case 'rapids': return rapidsFeedback(recipe,drill,position);
    case 'pinball': return {
      tone:warning?'warning':'neutral',title:'PINBALL',status:warning?'Bumpers incoming':'Aim the bounce',
      detail:recipe.bounce==='springy'?'Bumper contact launches you outward. Aim an edge for a sideways bounce, then steer toward open space.':'Bumpers redirect your approach. Aim your contact, then steer toward open space after a rebound.',
      controls:steer('Aim your contact or take a gap'),
    };
    case 'buddy': {
      const tether=drill?.tethers?.find(tether=>tether.racerIds.includes(racerId));
      // Pulses and zero crossings update only the meter, keeping the guidance stable.
      return {
        tone:'neutral',title:'BUDDY TETHER',
        detail:tether?'Stay close to your buddy to reduce the pull.':'No tether attached. Keep racing.',
        controls:steer(tether?'Stay near your buddy':'Steer freely'),
        meter:{label:'TETHER PULL',value:!warning&&tether?.active?clampFraction(tether.tension):0},
      };
    }
    case 'orbit': {
      const field=drill?.orbits?.find(field=>field.active
        &&Math.hypot(position[0]-field.position[0],position[2]-field.position[2])<=field.radius
        &&Math.abs(position[1]-field.position[1])<=field.height/2);
      // Field membership is visible; a racer's capture/release state is not in this snapshot.
      return {tone:warning||field?'warning':'neutral',title:'ORBIT FIELD',
        status:field?'Inside the ring':warning?'Orbit field incoming':'Outside the ring',
        detail:'The ring can bend your route. Steer outward to leave it; any capture also releases after a short orbit.',
        controls:steer('Steer outward to leave the ring')};
    }
    case 'reconstruction': {
      const ahead=drill?.actors.filter(actor=>echoAhead(position,actor))??[];
      const forming=ahead.some(actor=>actor.state==='warning');
      return {tone:warning||forming?'warning':'neutral',title:'INCIDENT RECONSTRUCTION',
        status:forming?'Copies forming ahead':ahead.length?'Solid copies ahead':warning?'Reconstruction incoming':'Watch for copies',
        detail:'Copies of '+(recipe.pattern==='mirror'?'mirrored ':'')+'recent paths form ahead. They are harmless until solidifying, then stay fixed. Change lanes to avoid them.',
        controls:steer('Dodge the copies ahead')};
    }
    case 'observation': {
      const cue=observationFeedback(event,racerId);
      if(!cue)return null;
      const local=drill?.observations?.[racerId];
      const tone:Record<typeof cue.state,EffectFeedback['tone']>={warning:'warning',clear:'neutral',resting:'benefit',watched:'warning',moving:'danger',penalty:'danger',protected:'benefit'};
      // A recent outcome can take cue priority while the next red warning is already visible.
      const release=cue.watching||cue.state==='warning'||Boolean(local?.warning)||warning;
      const course=release?'hold course':'steer';
      const status:Record<typeof cue.state,string>={
        warning:'Red incoming · hold course',clear:'Outside cones · steer',resting:'Blue light · steer',
        watched:'Red light · hold course',moving:'Sideways drift · release keys',
        penalty:'Penalty shove · '+course,
        protected:(local&&local.cooldownSeconds>0&&local.penaltyBlocked?'Penalty blocked':'Protected')+' · '+course,
      };
      return {tone:tone[cue.state],title:'INSPECTION',status:status[cue.state],
        detail:'Red: release steering; let drift settle. Steer in blue or outside cones.',
        meter:{label:'SIDEWAYS EXPOSURE',value:cue.state==='moving'||cue.state==='watched'?clampFraction(cue.exposureFraction):null},
        controls:release?{action:'release-steering',detail:'Fall straight · let drift settle'}:steer('Steer in blue or outside cones')};
    }
    default: {const unsupported:never=recipe;throw new Error('Unsupported safety drill: '+unsupported);}
  }
}

function v3Feedback(effect:RaceEventEffect,event:RaceEventSnapshot,position:EventVector):EffectFeedback {
  const distance=length(subtract(position,event.position));
  switch(effect.type) {
    case 'gravityWell': return {
      tone:distance<effect.radiusMeters?'warning':'neutral',title:'GRAVITY VORTEX',
      status:distance<effect.radiusMeters?'Inside the vortex':'Outside the vortex',
      detail:'The vortex pulls sideways into a broad orbit. Keep steering toward open lanes as you fall.',
      controls:steer('Steer toward open lanes')};
    case 'protectiveZone': return {
      tone:distance<=effect.radiusMeters?'benefit':'neutral',title:'SAFE SLIPSTREAM',
      status:distance<=effect.radiusMeters?'Inside · protected':'Outside · enter for protection',
      detail:'Stay inside for obstacle protection'+(effect.descentAcceleration>0?' and faster descent':'')+'. Weapons still work; steer toward your next pickup.',
      controls:steer('Stay in the field for protection')};
    case 'repulsionBurst': return {
      tone:'warning',title:'SHOCKWAVE',status:'Recover after the wave',
      detail:'The expanding wave pushes each racer outward once. If it reaches you, steer back toward an open lane.',controls:steer('Correct sideways drift')};
    case 'debrisShower': {
      const incoming=event.debris.some(particle=>particle.collidable&&particle.position[1]>=position[1]
        &&particle.position[1]-position[1]<=SAFETY_DRILL_LIMITS.approachRadius
        &&Math.hypot(position[0]-particle.position[0],position[2]-particle.position[2])<=RACE_EVENT_LIMITS.debrisRadius+RACE_EVENT_LIMITS.racerRadius+4);
      return {tone:incoming?'danger':'warning',title:'DEBRIS WAVES',status:incoming?'Rocks overhead · change lanes':'Watch for large rocks',
        detail:'Large rocks keep their launch direction. Change lanes to dodge; small fragments are harmless.',controls:steer('Dodge the large rocks')};
    }
    default: {const unsupported:never=effect;throw new Error('Unsupported race event: '+unsupported);}
  }
}

/** Read-only guidance: no timing, movement writes, or claims based on cumulative impacts. */
export function effectFeedback(event:RaceEventSnapshot,position:EventVector,racerId='0'):EffectFeedback|null {
  if(event.phase!=='active'||!event.instance)return null;
  const spec=event.instance.spec;
  return spec.version===4?v4Feedback(spec.drill,event,position,racerId):v3Feedback(spec.effect,event,position);
}
