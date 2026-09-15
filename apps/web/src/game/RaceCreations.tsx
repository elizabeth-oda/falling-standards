import { encounterInstruction, encounterLabel, type RaceEncounter } from '@sky/shared';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { PerspectiveCamera, type Group } from 'three';
import { PowerUpModel } from '../components/PowerUpModel';
import { fitModelToDiameter } from '../race-events/model-presentation';
import type { RaceCreationRecord } from './race-creation-history';
import type { RaceIncidentReportView } from './race-report-controller';
import { RaceCreationOutcome, type CreationRacerName } from './RaceCreationOutcome';
import './race-creations.css';

type Props = {
  creations: readonly RaceCreationRecord[];
  racers: readonly CreationRacerName[];
  reports?: Readonly<Record<string, RaceIncidentReportView>>;
};
type View = {rotation: number; tilt: number; zoom: number};
const initialView: View = {rotation: -25, tilt: 10, zoom: 100};
const wrapAngle = (angle: number) => ((angle + 180) % 360 + 360) % 360 - 180;
const creationsTitle = (creations: readonly RaceCreationRecord[]) => creations.length > 0 && creations.every(creation => creation.source === 'prepared') ? 'Prepared drill' : 'Your creations';

function CreationModel({spec, view}: {spec: RaceEncounter; view: View}) {
  const content = useRef<Group>(null);
  const {camera, size, invalidate} = useThree();
  useLayoutEffect(() => {
    if (content.current) fitModelToDiameter(content.current, 2.8);
    invalidate();
  }, [spec, invalidate]);
  useLayoutEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return;
    const verticalFov = camera.fov * Math.PI / 180;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * size.width / Math.max(size.height, 1));
    const distance = 1.55 / Math.sin(Math.min(verticalFov, horizontalFov) / 2);
    camera.position.set(0, 0, distance * 100 / view.zoom);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, size.width, size.height, view.zoom, invalidate]);
  return <>
    <color attach="background" args={['#203b49']}/>
    <ambientLight intensity={1.2}/>
    <directionalLight position={[-4, 5, 6]} intensity={2.2}/>
    <directionalLight position={[4, 1, -3]} intensity={1.3} color="#a6e4ee"/>
    <group rotation={[view.tilt * Math.PI / 180, view.rotation * Math.PI / 180, 0]}>
      <group ref={content}><PowerUpModel spec={spec}/></group>
    </group>
  </>;
}

function CreationDialog({creations, racers, reports, onClose}: Props & {onClose: () => void}) {
  const modal = useRef<HTMLDialogElement>(null);
  const previouslyFocused = useRef(document.activeElement);
  const titleId = useId(), helpId = useId();
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<View>(initialView);
  const drag = useRef<{pointerId: number; x: number; y: number; rotation: number; tilt: number} | null>(null);
  const creation = creations[Math.min(selected, creations.length - 1)];
  useEffect(() => {
    const dialog = modal.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      const previous = previouslyFocused.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, rotation: view.rotation, tilt: view.tilt};
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setView(current => ({...current, rotation: Math.round(wrapAngle(start.rotation + (event.clientX - start.x) * .5)),
      tilt: Math.round(Math.max(-65, Math.min(65, start.tilt + (event.clientY - start.y) * .4)))}));
  };
  return createPortal(<dialog ref={modal} className="race-creations-dialog" aria-labelledby={titleId}
    onCancel={event => {event.preventDefault(); onClose();}}
    onClick={event => {if (event.target === event.currentTarget) onClose();}}
    onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
    <div className="race-creations-heading">
      <div><span>DEPARTMENT OF WORKPLACE SAFETY</span><h2 id={titleId}>{creationsTitle(creations)}</h2></div>
      <button autoFocus type="button" onClick={onClose}>Close viewer <span aria-hidden="true">&times;</span></button>
    </div>
    {creation ? <div className="race-creations-content">
      <nav className="race-creation-selector" aria-label="Choose a creation">{creations.map((item, index) =>
        <button type="button" key={item.instanceId} aria-pressed={index === selected} onClick={() => {setSelected(index); setView(initialView); drag.current = null;}}>
          <span>{String(index + 1).padStart(2, '0')}</span>{item.spec.displayName}
        </button>)}</nav>
      <div className="race-creation-layout">
        <section className="race-creation-inspection" aria-label={'Inspect ' + creation.spec.displayName}>
          <div className="race-creation-model" onPointerDown={beginDrag} onPointerMove={moveDrag}
            onPointerUp={() => {drag.current = null;}} onPointerCancel={() => {drag.current = null;}}
            onLostPointerCapture={() => {drag.current = null;}} role="img" aria-label={'3D model of ' + creation.spec.displayName} aria-describedby={helpId}>
            <Canvas key={creation.instanceId} frameloop="demand" dpr={[1, 1.5]} camera={{position: [0, 0, 5], fov: 45, near: .1, far: 100}}
              fallback={<p className="race-creation-fallback">3D preview requires WebGL. The creation's description and race results are available alongside.</p>}>
              <CreationModel spec={creation.spec} view={view}/>
            </Canvas>
            <span className="race-creation-model-tag" aria-hidden="true">EQUIPMENT INSPECTION</span>
          </div>
          <p id={helpId} className="race-creation-help">Drag to turn the model, or use the controls below.</p>
          <div className="race-creation-controls">
            <label>Rotate <output>{view.rotation}&deg;</output><input aria-label="Rotate creation" type="range" min="-180" max="180" value={view.rotation} onChange={event => setView(current => ({...current, rotation: Number(event.target.value)}))}/></label>
            <label>Tilt <output>{view.tilt}&deg;</output><input aria-label="Tilt creation" type="range" min="-65" max="65" value={view.tilt} onChange={event => setView(current => ({...current, tilt: Number(event.target.value)}))}/></label>
            <label>Zoom <output>{view.zoom}%</output><input aria-label="Creation zoom" type="range" min="75" max="160" value={view.zoom} onChange={event => setView(current => ({...current, zoom: Number(event.target.value)}))}/></label>
            <button type="button" onClick={() => setView(initialView)}>Reset view</button>
          </div>
        </section>
        <div className="race-creation-file">
          <span className="race-creation-file-label">{creation.source === 'prepared' ? 'PREPARED SAFETY DRILL' : creation.source === 'fixture' ? 'PRACTICE FIXTURE' : 'CREATION ' + (creation.attemptNumber ?? selected + 1)}</span>
          <h3>{creation.spec.displayName}</h3>
          <section className="race-creation-effect" aria-label="Creation effect"><h4>{encounterLabel(creation.spec)}</h4><p>{encounterInstruction(creation.spec)}</p></section>
          <RaceCreationOutcome key={creation.instanceId} creation={creation} racers={racers} report={reports?.[creation.instanceId]}/>
        </div>
      </div>
    </div> : <div className="race-creations-empty">
      <span aria-hidden="true">&#9733;</span><h3>No creations this time</h3>
      <p>Complete a voice creation after collecting an Inspection Request during a race. Its model and race results will appear here after landing.</p>
    </div>}
    <div className="race-creations-footer">{creation ? 'Saved for this race. Starting a new race clears these creations.' : 'The inspectors have filed a very short report.'}</div>
  </dialog>, document.body);
}

/** In-memory results only. Opening the viewer never records audio or runs generation. */
export function RaceCreations({creations, racers, reports}: Props) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="race-creations-open" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      {creationsTitle(creations)}{creations.length > 0 && ' (' + creations.length + ')'}
    </button>
    {open && <CreationDialog creations={creations} racers={racers} reports={reports} onClose={() => setOpen(false)}/>}
  </>;
}

