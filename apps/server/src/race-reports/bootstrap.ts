import { StageConfigSchema } from '@sky/shared';
import type { CreationPipeline } from '../generation/pipeline.js';
import { resolveAPIKey } from '../generation/pipeline-config.js';
import { openAIContentGuard } from '../generation/content-guard.js';
import { openAIRaceReportTransport } from './transport.js';
import { RaceReportService } from './service.js';

export function buildRaceReports(env:NodeJS.ProcessEnv,pipeline:CreationPipeline):RaceReportService {
  const defaults=pipeline.profiles.find(profile=>profile.id==='configured')?.design
    ?? pipeline.profiles.find(profile=>profile.mode==='live')?.design
    ?? {model:'gpt-5.6-sol',reasoning:'low' as const,maxOutputTokens:1200};
  const config=StageConfigSchema.parse({model:env.REPORT_MODEL??defaults.model,
    reasoning:env.REPORT_REASONING??defaults.reasoning,maxOutputTokens:1200});
  if (!['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna'].includes(config.model))
    throw new Error('REPORT_MODEL must be a supported generation model.');
  const apiKey=resolveAPIKey(env);
  const live=pipeline.liveEnabled&&apiKey?{transport:openAIRaceReportTransport(apiKey),guard:openAIContentGuard(apiKey)}:undefined;
  return new RaceReportService(pipeline.admissionGate,{...config,maxOutputTokens:1200},live);
}
