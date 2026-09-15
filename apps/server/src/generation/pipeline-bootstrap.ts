import { mockTranscriptionProvider, openAITranscription } from '../voice/transcription.js';
import { pipelineProfiles, resolveAPIKey } from './pipeline-config.js';
import { mockContentGuard, openAIContentGuard } from './content-guard.js';
import { CreationPipeline } from './pipeline.js';
import { LiveAttempts } from './live-attempts.js';
import { mockStageTransport, openAITransport } from './stage-transport.js';
export function buildPipeline(env:NodeJS.ProcessEnv = process.env, liveEnabled = false) {
  const apiKey = resolveAPIKey(env);
  const maxAttempts = env.LIVE_MAX_ATTEMPTS === undefined ? 3 : Number(env.LIVE_MAX_ATTEMPTS);
  const admissionGate = new LiveAttempts({enabled:liveEnabled,maxAttempts});
  return new CreationPipeline(pipelineProfiles(env,liveEnabled),{
    mock:mockStageTransport,
    ...(liveEnabled && apiKey ? {live:openAITransport(apiKey)} : {}),
  },undefined,{enabled:liveEnabled,maxAttempts},{mock:mockTranscriptionProvider,
    ...(liveEnabled && apiKey ? {live:openAITranscription(apiKey,env.TRANSCRIPTION_MODEL ?? 'gpt-transcribe')} : {}),
  },{mock:mockContentGuard,
    ...(liveEnabled && apiKey ? {live:openAIContentGuard(apiKey)} : {}),
  },admissionGate);
}
