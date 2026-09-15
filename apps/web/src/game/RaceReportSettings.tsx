import React from 'react';
export type RaceReportSettingsProps = {
  reportConsent?: boolean;
  onReportConsentChange?: (confirmed: boolean) => void;
  reportAvailable?: boolean;
  reportLive?: boolean;
};

/** Separate, run-local consent; enabling voice never enables paid reporting. */
export function RaceReportSettings({reportConsent = false, onReportConsentChange,
  reportAvailable = false, reportLive = false, disabled = false}: RaceReportSettingsProps & {disabled?: boolean}) {
  if (!onReportConsentChange) return null;
  return <div className="race-report-settings">
    {reportLive ? <>
      <label className="voice-consent">
        <input type="checkbox" checked={reportConsent} disabled={disabled || (!reportAvailable && !reportConsent)}
          onChange={event => onReportConsentChange(event.target.checked)}/>
        Include an AI incident report when each event ends
      </label>
      <small>Up to 2 additional paid calls per run, separate from voice creation. Failed or cancelled reports may still cost credits. An authored report is always available.</small>
      {!reportAvailable && <small>AI incident reports are unavailable for this session.</small>}
    </> : <small>Incident reports use free, prepared findings in Mock mode.</small>}
  </div>;
}
