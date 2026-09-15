import { buildApp } from './app.js';
import { buildPipeline } from './generation/pipeline-bootstrap.js';
import { resolveAPIKey } from './generation/pipeline-config.js';
import { buildRaceReports } from './race-reports/bootstrap.js';

export function buildHostedApp(env:NodeJS.ProcessEnv = process.env) {
  // Keys alone cannot enable spending. Previews always stay mock-only.
  const liveEnabled = env.VERCEL_ENV === 'production' && env.HOSTED_LIVE_ENABLED === 'true';
  let origin:string|undefined;
  if (liveEnabled) {
    if (!resolveAPIKey(env) || !env.APP_ORIGIN) {
      throw new Error('Hosted live mode requires the provider key and APP_ORIGIN.');
    }
    const parsed = new URL(env.APP_ORIGIN);
    if (parsed.protocol !== 'https:' || parsed.origin !== env.APP_ORIGIN) {
      throw new Error('APP_ORIGIN must be the exact HTTPS origin, without a trailing slash or path.');
    }
    origin = parsed.origin;
  }
  // This allowance belongs to this instance only; cold starts/redeployments reset it.
  const pipeline = buildPipeline({...env,LIVE_MAX_ATTEMPTS:env.LIVE_MAX_ATTEMPTS ?? '500'},liveEnabled);
  if (!liveEnabled) for (const profile of pipeline.profiles) {
    if (profile.mode === 'live') profile.unavailableReason = 'Paid generation is disabled on this deployment.';
  }
  return buildApp({pipeline,reports:buildRaceReports(env,pipeline),allowedOrigin:value=>origin !== undefined && value === origin});
}
