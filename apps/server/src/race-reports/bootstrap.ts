import type { CreationPipeline } from '../generation/pipeline.js';
import { resolveAPIKey } from '../generation/pipeline-config.js';
import { openAIContentGuard } from '../generation/content-guard.js';
import { openAIRaceReportTransport } from './transport.js';
import { RaceReportService } from './service.js';

export function buildRaceReports(env:NodeJS.ProcessEnv,pipeline:CreationPipeline):RaceReportService {
  const config=pipeline.profiles.find(profile=>profile.id==='configured')?.design
    ?? pipeline.profiles.find(profile=>profile.mode==='live')?.design
    ?? {model:'gpt-5.6-sol',reasoning:'low' as const,maxOutputTokens:1200};
  const apiKey=resolveAPIKey(env);
  const live=pipeline.liveEnabled&&apiKey?{transport:openAIRaceReportTransport(apiKey),guard:openAIContentGuard(apiKey)}:undefined;
  return new RaceReportService(pipeline.admissionGate,{...config,maxOutputTokens:1200},live);
}
