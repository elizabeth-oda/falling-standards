import type { FastifyInstance } from 'fastify';
import { RaceReportRequestSchema } from '@sky/shared';
import { isLocalOrigin } from '../generation/local-origin.js';
import { safePipelineError } from '../generation/pipeline-errors.js';
import type { RaceReportService } from './service.js';

export function registerRaceReportRoutes(app:FastifyInstance,reports:RaceReportService,allowedOrigin=isLocalOrigin) {
  app.get('/api/race-reports/status',async(_request,reply)=>{
    reply.header('Cache-Control','no-store');return reports.status;
  });
  app.post('/api/race-reports',{bodyLimit:4096},async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    const parsed=RaceReportRequestSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:{code:'INVALID_REQUEST',message:'Provide a valid completed-event report request.'}});
    if(parsed.data.mode==='live'&&!allowedOrigin(request.headers.origin))
      return reply.code(403).send({error:{code:'INVALID_REQUEST',message:'Paid requests must originate from the configured game site.'}});
    const controller=new AbortController();
    const disconnect=()=>{if(!reply.raw.writableEnded)controller.abort();};
    reply.raw.on('close',disconnect);request.raw.on('error',disconnect);
    try {return await reports.run(parsed.data,{signal:controller.signal});}
    catch(error) {
      const safe=safePipelineError(error);
      const status=safe.code==='INVALID_REQUEST'||safe.code==='CONSENT_REQUIRED'?400
        :safe.code==='LIVE_DISABLED'?403
        :safe.code==='LIVE_BUSY'||safe.code==='DUPLICATE_ATTEMPT'||safe.code==='CANCELLED'?409
        :safe.code==='LIVE_LIMIT_REACHED'?429
        :safe.code==='NOT_CONFIGURED'?503
        :safe.code==='TIMEOUT'?504:502;
      return reply.code(status).send({error:safe});
    } finally {reply.raw.off('close',disconnect);request.raw.off('error',disconnect);}
  });
}
