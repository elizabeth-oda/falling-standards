import { isLocalOrigin } from './local-origin.js';
import type { FastifyInstance } from 'fastify';
import { PIPELINE_DEADLINE_MS, DESIGN_BUDGET_MS, PipelineRequestSchema, type RaceEventPipelineEvent, type SafetyDrillPipelineEvent, type PipelineEvent } from '@sky/shared';
import type { CreationPipeline } from './pipeline.js';
export function registerLabRoutes(app:FastifyInstance,pipeline:CreationPipeline,allowedOrigin = isLocalOrigin) {
  app.get('/api/lab/profiles',async (_request,reply) => {
    reply.header('Cache-Control','no-store');
    return {transcription:pipeline.transcriptionStatus,profiles:pipeline.profiles,liveUsage:pipeline.liveUsage,
      deadlineMs:PIPELINE_DEADLINE_MS,designBudgetMs:DESIGN_BUDGET_MS};
  });
  const routes=[{path:'/api/lab/creations',mode:'legacy'},{path:'/api/lab/events',mode:'event'},{path:'/api/lab/drills',mode:'drill'}] as const;
  for(const {path,mode} of routes)app.post(path,async (request,reply) => {
    const parsed = PipelineRequestSchema.safeParse(request.body);
    const profile = parsed.success ? pipeline.profiles.find(item => item.id === parsed.data.profileId) : undefined;
    if (!parsed.success || !profile) return reply.code(400).send({error:{code:'INVALID_REQUEST',message:'Use one to ten words and select a known profile.'}});
    if (profile.mode === 'live' && !allowedOrigin(request.headers.origin)) return reply.code(403).send({error:{code:'INVALID_REQUEST',message:'Paid requests must originate from the configured game site.'}});
    if (profile.mode === 'live' && !pipeline.liveEnabled) return reply.code(403).send({error:{code:'LIVE_DISABLED',message:'Paid generation is disabled. Start bun run dev:live to opt in.'}});
    if (profile.mode === 'live' && !parsed.data.paidAttempt) return reply.code(400).send({error:{code:'CONSENT_REQUIRED',message:'Paid attempt metadata is required before generating.'}});
    if (!profile.available) return reply.code(503).send({error:{code:'NOT_CONFIGURED',message:profile.unavailableReason ?? 'Provider unavailable.'}});
    const controller = new AbortController();
    const disconnect = () => {if (!reply.raw.writableEnded) controller.abort();};
    reply.raw.on('close',disconnect);
    request.raw.on('error',disconnect);
    reply.hijack();
    reply.raw.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    const emit = (event:PipelineEvent|RaceEventPipelineEvent|SafetyDrillPipelineEvent) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(JSON.stringify(event)+'\n');
    };
    try {
      if(mode==='drill')await pipeline.runDrill(parsed.data,{signal:controller.signal,emit});
      else if(mode==='event')await pipeline.runEvent(parsed.data,{signal:controller.signal,emit});
      else await pipeline.run(parsed.data,{signal:controller.signal,emit});
    }
    catch {/* The pipeline has emitted one terminal failure event. */}
    finally {
      reply.raw.off('close',disconnect);request.raw.off('error',disconnect);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });
}
