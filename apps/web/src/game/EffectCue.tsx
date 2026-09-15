import { RaceAlert } from './RaceAlerts';
import { encounterKind, type EventVector, type RaceEventSnapshot } from '@sky/shared';
import type { ReactNode } from 'react';
import { effectFeedback } from './effect-feedback';

const symbols:Record<ReturnType<typeof encounterKind>,ReactNode>={
  stampede:<path d="m3 7 9 7-9 7m12-14 9 7-9 7m12-14 9 7-9 7"/>,
  rapids:<path d="M2 6c7-8 11 8 18 0s11 8 18 0M2 14c7-8 11 8 18 0s11 8 18 0M2 22c7-8 11 8 18 0s11 8 18 0"/>,
  pinball:<><circle cx="22" cy="14" r="10"/><path d="m2 5 10 9L2 23m26-13-6 4 6 4"/></>,
  buddy:<><circle cx="7" cy="14" r="5"/><circle cx="33" cy="14" r="5"/><path d="m12 14 4-4 8 8 4-4"/></>,
  orbit:<><ellipse cx="20" cy="14" rx="17" ry="10"/><circle cx="20" cy="14" r="3"/><path d="m31 2 6 5-7 2"/></>,
  reconstruction:<><path d="M3 3h20v15H3zM11 10h20v15H11"/><path d="m31 6 6 4-6 4"/></>,
  observation:<><path d="M2 14S9 3 20 3s18 11 18 11-7 11-18 11S2 14 2 14Z"/><circle cx="20" cy="14" r="5"/></>,
  gravityWell:<><ellipse cx="20" cy="14" rx="17" ry="10"/><circle cx="20" cy="14" r="3"/><path d="m3 6 5 2-1 6m30 8-5-2 1-6"/></>,
  debrisShower:<><path d="m5 2 7 5-3 7-7-4zM26 3l8 4-2 8-8-3zM16 16l7 4-3 6-8-4z"/></>,
  repulsionBurst:<><circle cx="20" cy="14" r="4"/><path d="M10 6a13 13 0 0 0 0 16m20-16a13 13 0 0 1 0 16M3 2a20 20 0 0 0 0 24M37 2a20 20 0 0 1 0 24"/></>,
  protectiveZone:<><path d="M20 2 34 7v8c0 5-7 9-14 11C13 24 6 20 6 15V7z"/><path d="m13 14 5 5 10-10"/></>,
};

export function EffectCue({event,position,steeringKeys}:{event:RaceEventSnapshot;position:EventVector;steeringKeys:string}) {
  const feedback=effectFeedback(event,position);
  if(!feedback||!event.instance)return null;
  const {tone,title,detail,status,meter,controls}=feedback,kind=encounterKind(event.instance.spec);
  const action=controls?.action==='release-steering'?'Release ':'Steer ';
  return <RaceAlert><div className={'effect-cue '+kind}>
    <div className="effect-cue-heading">
      <svg viewBox="0 0 40 28" aria-hidden="true">{symbols[kind]}</svg>
      <strong role="status" aria-atomic="true">{title}</strong>
      <span className="effect-cue-time" role="timer" aria-label="Time remaining">{Math.ceil(event.remainingSeconds)} s</span>
    </div>
    <p aria-live={kind==='buddy'?'polite':undefined}>{detail}</p>
    {controls&&<div className="effect-control-hint">
      <kbd>{action}{steeringKeys}</kbd>
      {status&&<span className={'effect-status '+tone} role="status" aria-atomic="true"
        aria-label={status+'. '+action+steeringKeys}>{status}</span>}
    </div>}
    {meter&&<div className="effect-meter">
      <div className="effect-meter-label"><span>{meter.label}</span>{meter.value===null&&<span>Inactive</span>}</div>
      {meter.value===null
        ?<span className="effect-meter-inactive" role="img" aria-label={meter.label+': inactive'}/>
        :<meter aria-label={meter.label} min={0} max={1} value={meter.value}/>}
    </div>}
  </div></RaceAlert>;
}
