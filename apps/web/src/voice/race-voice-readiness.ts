import type { loadPipelineProfiles } from '../generation/pipeline-client';
import type { RecorderSnapshot } from './recorder';

type PipelineProfiles = Awaited<ReturnType<typeof loadPipelineProfiles>>;

export type VoiceReadiness = {ready: boolean; message: string};

export function paidVoiceAvailable(profiles?: PipelineProfiles): boolean {
  return Boolean(profiles?.transcription?.available && profiles.liveUsage.enabled &&
    !profiles.liveUsage.busy && profiles.liveUsage.attemptsRemaining > 0);
}

export function raceVoiceReadiness({enabled, microphone, profiles, profileId, error}: {
  enabled: boolean;
  microphone: Pick<RecorderSnapshot, 'ready' | 'phase'>;
  profiles?: PipelineProfiles;
  profileId: string;
  error: string;
}): VoiceReadiness {
  const blocked = (message: string): VoiceReadiness => ({ready: false, message});
  if (!enabled) return blocked('Voice creation is off for this run.');
  if (!microphone.ready || microphone.phase === 'preparing' || microphone.phase === 'error') {
    return blocked(microphone.phase === 'preparing' ? 'Checking microphone permission…' : 'Enable your microphone in setup or the pause menu to race with voice.');
  }
  if (error) return blocked(error);
  if (!profiles) return blocked('Checking creation availability…');
  const profile = profiles.profiles.find(item => item.id === profileId);
  if (!profile?.available) return blocked('This creation mode is unavailable. Choose another mode or play without voice.');
  if (profile.mode === 'live') {
    if (!profiles.transcription?.available || !profiles.liveUsage.enabled) return blocked('Live voice is unavailable. Choose Prepared hazard or play without voice.');
    if (profiles.liveUsage.busy) return blocked('Another AI attempt is running. Refresh availability in a moment.');
    if (profiles.liveUsage.attemptsRemaining <= 0) return blocked('No paid attempts remain. Choose Prepared hazard or play without voice.');
  }
  return {ready: true, message: profile.mode === 'live'
    ? 'Ready. Collect the yellow star, then hold Space to speak.'
    : 'Ready for Prepared hazard. Your speech will not be interpreted.'};
}
