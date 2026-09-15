import { useEffect, useRef } from 'react';
import { safetyDrillFixtures } from '@sky/shared';
import { RaceVoiceSetup, type RaceVoiceController } from '../voice/RaceVoiceControls';

export function RaceBriefing({steeringHelp, actionHelp}: {steeringHelp: string; actionHelp: string}) {
  return <>
    <p>Race three rivals to the finish. Steer around obstacles.</p>
    <p>Striped boxes hold safety equipment: launch a <strong>Spare Parachute</strong> to slow a rival, use <strong>Bubble Wrap</strong> for five seconds of protection, or discharge an <strong>Emergency Air Canister</strong> for two seconds of fuel-free boost. Braking cancels the canister.</p>
    <ol className="race-briefing-steps">
      <li><strong>Collect an Inspection Request (yellow star).</strong> With voice enabled, two stars appear along the course, each granting one attempt. The second is 60–70% through, regardless of the first attempt’s outcome.</li>
      <li><strong>Hold Space and speak.</strong> Report a hazard and what it does in 10 words or fewer. Release to submit; recording stops after 8 seconds.</li>
      <li><strong>Keep racing.</strong> Your object appears ahead if there is time to use it before landing.</li>
      <li><strong>Fly through its glowing halo.</strong> The first racer to reach it starts a shared safety drill. Bait charges, find gaps, or ride currents; everyone participates, including you.</li>
    </ol>
    <p>Playing without voice starts with a prepared safety drill ahead in the course. Fly through its glowing halo to activate it; any racer can start it.</p>
    <p className="race-essential-controls">{steeringHelp}</p>
    <details><summary>All controls</summary><p>{actionHelp}</p></details>
  </>;
}

export type RaceSetupStep = 'briefing' | 'voice';

export function RaceSetup({voice, step, onStepChange, controls, steeringHelp, actionHelp, onStart, onSkipVoice, onBack}: {
  voice: RaceVoiceController;
  step: RaceSetupStep;
  onStepChange: (step: RaceSetupStep) => void;
  controls: {steering: readonly string[]; boost: string; use: string};
  steeringHelp: string;
  actionHelp: string;
  onStart: () => boolean;
  onSkipVoice: () => boolean;
  onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const readiness = voice.getReadiness();
  const preparedDrill = (safetyDrillFixtures.find(fixture => fixture.prompt === voice.mockText) ?? safetyDrillFixtures[0]).spec;
  useEffect(() => { heading.current?.focus(); }, [step]);
  const backToBriefing = () => {
    voice.recorder.cancel();
    onStepChange('briefing');
  };
  return <section className="race-setup" data-step={step} aria-labelledby="race-setup-title">
    <div className="race-setup-content">
      <div className="race-setup-heading">
        <button type="button" onClick={step === 'voice' ? backToBriefing : onBack}>
          {step === 'voice' ? '← Back to briefing' : '← Change personnel'}
        </button>
        <span className="eyebrow">PRE-FLIGHT BRIEFING</span>
      </div>
      <h1 ref={heading} id="race-setup-title" tabIndex={-1}>
        {step === 'briefing' ? 'Ready to race?' : 'Set up hazard reporting'}
      </h1>
      {step === 'briefing' ? <>
        <p className="race-setup-lead">Race three rivals to the finish. Dodge the obstacles.</p>
        <div className="race-control-cards" aria-label="Essential race controls">
          <div className="race-control-card">
            <div className="race-control-keys">{controls.steering.map(key => <kbd key={key}>{key}</kbd>)}</div>
            <strong>Steer</strong>
          </div>
          <div className="race-control-card">
            <div className="race-control-keys"><kbd>{controls.boost}</kbd></div>
            <strong>Boost</strong><small>Needs fuel</small>
          </div>
          <div className="race-control-card">
            <div className="race-control-keys"><kbd>{controls.use}</kbd></div>
            <strong>Use item</strong>
          </div>
        </div>
        <details className="race-setup-all-controls">
          <summary>All controls</summary><p>{steeringHelp}</p><p>{actionHelp}</p>
        </details>
        <div className="race-setup-launch-options">
          <div>
            <button type="button" className="begin-exercise" onClick={onSkipVoice}>Race without voice →</button>
            <p>Prepared drill. No microphone or AI calls.</p>
          </div>
          <div>
            <button type="button" onClick={() => onStepChange('voice')}>Set up hazard reporting →</button>
            <p>Optional · Prepared hazard or Live AI.</p>
          </div>
        </div>
        <p className="race-setup-prepared-note">Prepared drill: <strong>{preparedDrill.displayName}</strong>. Fly through its glowing halo to start the shared drill. No yellow stars.</p>
      </> : <>
        <ol className="race-voice-steps" aria-label="How hazard reporting works">
          <li><strong>Collect a yellow star</strong><span>Two stars. One attempt each.</span></li>
          <li><strong>Hold Space and speak</strong><span>Up to 10 words · Release to submit · 8 s max</span></li>
          <li><strong>Fly through the halo</strong><span>The first racer starts the drill for everyone.</span></li>
        </ol>
        <RaceVoiceSetup voice={voice}/>
        <div className="race-setup-actions">
          <p id="race-setup-readiness" role="status">{readiness.message}</p>
          <div>
            <button type="button" className="begin-exercise" disabled={!readiness.ready}
              aria-describedby="race-setup-readiness" onClick={onStart}>
              {voice.live ? 'Start with Live AI →' : 'Start with prepared hazard →'}
            </button>
            <button type="button" onClick={onSkipVoice}>Race without voice</button>
          </div>
        </div>
      </>}
    </div>
  </section>;
}
