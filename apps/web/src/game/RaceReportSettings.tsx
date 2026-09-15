import React from 'react';

export type RaceReportSettingsProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  live: boolean;
  available: boolean;
  runStarted?: boolean;
};

export function RaceReportSettings({checked, onChange, live, available, runStarted = false}: RaceReportSettingsProps) {
  return <section className="race-report-settings" aria-label="Incident report settings">
    {live ? <>
      <label>
        <input type="checkbox" checked={checked} disabled={!checked && (!available || runStarted)}
          onChange={event => onChange(event.target.checked)}/>
        Include an AI incident report after the race — 1 additional paid call
      </label>
      <small>One request covers both creations after everyone lands. Failed or cancelled requests may still cost credits. Recorded facts and a prepared finding are always available.</small>
      {!available && <small>AI incident reports are unavailable for this session.</small>}
    </> : <p>Incident reports use free, prepared findings.</p>}
  </section>;
}
