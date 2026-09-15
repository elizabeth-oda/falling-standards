import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  RaceReportInputSchema, RaceReportResponseSchema, RaceReportStatusSchema,
  authoredRaceReport, raceReportInputFingerprint, proceduralFixtures, appearanceToRecipe,
  type RaceReportInput, type RaceReportRequest,
} from '@sky/shared';
import { buildApp } from './app.js';
import { buildHostedApp } from './hosted.js';
import { pipelineProfiles } from './generation/pipeline-config.js';
import { CreationPipeline } from './generation/pipeline.js';
import { LiveAttempts } from './generation/live-attempts.js';
import { PipelineFailure } from './generation/pipeline-errors.js';
import { mockContentGuard, type ContentGuard } from './generation/content-guard.js';
import { RaceReportService } from './race-reports/service.js';
import { openAIRaceReportTransport, RACE_REPORT_FORMAT, type RaceReportTransport } from './race-reports/transport.js';

const config={model:'test-report',reasoning:'low' as const,maxOutputTokens:1200};
const input=(runId:string=randomUUID(),creationId='event-1'):RaceReportInput=>RaceReportInputSchema.parse({
  runId,creationId,displayName:'Bouncy Avocado',
  encounter:{version:4,drill:{family:'pinball',layout:'staggered',bounce:'springy'}},
  outcome:'complete',creatorId:'0',triggererId:'1',
  racers:[
    {racerId:'0',characterId:'greg',metrics:{bounces:5}},
    {racerId:'1',characterId:'linda',metrics:{bounces:2}},
    {racerId:'2',characterId:'steve',metrics:{bounces:0}},
    {racerId:'3',characterId:'susan',metrics:{bounces:0}},
  ],
});
const authoredBatch=(values:RaceReportInput[])=>({items:values.map(value=>({creationId:value.creationId,...authoredRaceReport(value)}))});
async function request(value:RaceReportInput|RaceReportInput[]=input(),mode:'mock'|'live'='live'):Promise<RaceReportRequest> {
  const inputs=Array.isArray(value)?value:[value];
  return {inputs,inputFingerprint:await raceReportInputFingerprint(inputs),mode,
    ...(mode==='live'?{paidAttempt:{id:randomUUID(),confirmed:true as const}}:{})};
}
const hasCode=(expected:string)=>(error:unknown)=>error instanceof PipelineFailure&&error.code===expected;
function harness(transport:RaceReportTransport={run:async request=>authoredBatch(request.items.map(item=>item.input))},
  guard:ContentGuard=mockContentGuard,enabled=true,maxAttempts=6,
  budgets?:{totalMs:number;generationMs:number;screeningMs:number}) {
  const fixture=proceduralFixtures[0];
  const gate=new LiveAttempts({enabled,maxAttempts});
  const pipeline=new CreationPipeline(pipelineProfiles({OPENAI_API_KEY:'test-report-key'},enabled),
    {mock:{run:async request=>({data:request.stage==='design'?fixture.design:appearanceToRecipe(fixture.appearance)})},
      live:{run:async request=>({data:request.stage==='design'?fixture.design:appearanceToRecipe(fixture.appearance)})}},
    undefined,undefined,{mock:{model:'mock',transcribe:async()=>fixture.prompt},
      live:{model:'test-speech',transcribe:async()=>fixture.prompt}},{mock:mockContentGuard,live:mockContentGuard},gate);
  return {gate,pipeline,reports:new RaceReportService(gate,config,{transport,guard},budgets)};
}

test('both creations use one batch generation and two guards while sharing one allowance entry',async()=>{
  const checks:string[][]=[];
  let calls=0;
  const state=harness({run:async modelRequest=>{
    calls++;
    assert.equal(modelRequest.config.maxOutputTokens,1200);
    assert.ok(modelRequest.items.every(item=>item.evidence.length>=1&&item.evidence.length<=8));
    return authoredBatch(modelRequest.items.map(item=>item.input));
  }},{check:async texts=>{checks.push([...texts]);return 'allow';}});
  const first=input(),second=input(first.runId,'event-2');
  const sent=await request([first,second]);
  const result=RaceReportResponseSchema.parse(await state.reports.run(sent));
  assert.equal(calls,1);assert.equal(checks.length,2);
  assert.deepEqual(checks[0],sent.inputs.map(item=>item.displayName));
  assert.deepEqual(checks[1],result.items.flatMap(item=>[item.headline,item.finding]));
  assert.equal(result.runId,sent.inputs[0].runId);assert.deepEqual(result.items.map(item=>item.creationId),sent.inputs.map(item=>item.creationId));
  assert.equal(result.attemptId,sent.paidAttempt?.id);assert.equal(result.inputFingerprint,sent.inputFingerprint);
  assert.equal(state.pipeline.liveUsage.attemptsUsed,1);assert.equal(state.pipeline.liveUsage.busy,false);
});

test('mock reports never invoke a supplied transport or guard and consume no allowance',async()=>{
  let calls=0;
  const state=harness({run:async()=>{calls++;throw new Error('No dispatch');}},
    {check:async()=>{calls++;throw new Error('No screening');}});
  const sent=await request(input(),'mock');
  const result=await state.reports.run(sent);
  assert.deepEqual(result.items,authoredBatch(sent.inputs).items);
  assert.equal(result.attemptId,null);assert.equal(calls,0);assert.equal(state.gate.status.attemptsUsed,0);
});

test('one report admission per run rejects new attempts, changed inputs, and second-item requests',async()=>{
  let calls=0;
  const state=harness({run:async req=>{calls++;return authoredBatch(req.items.map(item=>item.input));}});
  const first=await request();
  await state.reports.run(first);
  await assert.rejects(state.reports.run(await request(first.inputs)),hasCode('DUPLICATE_ATTEMPT'));
  const changed=input(first.inputs[0].runId,first.inputs[0].creationId);
  changed.displayName='Changed Avocado';
  await assert.rejects(state.reports.run({...await request(changed),paidAttempt:first.paidAttempt}),hasCode('DUPLICATE_ATTEMPT'));
  await assert.rejects(state.reports.run(await request(input(first.inputs[0].runId,'event-2'))),hasCode('DUPLICATE_ATTEMPT'));
  const next=await request();
  await assert.rejects(state.reports.run({...next,paidAttempt:first.paidAttempt}),hasCode('DUPLICATE_ATTEMPT'));
  await state.reports.run(next);
  assert.equal(calls,2);assert.equal(state.gate.status.attemptsUsed,2);
});

test('invalid input, mismatched fingerprint, missing consent, and early abort are free',async()=>{
  let calls=0;
  const state=harness({run:async req=>{calls++;return authoredBatch(req.items.map(item=>item.input));}});
  const sent=await request();
  await assert.rejects(state.reports.run({...sent,inputFingerprint:'0'.repeat(64)}),hasCode('INVALID_REQUEST'));
  await assert.rejects(state.reports.run({...sent,paidAttempt:undefined}),hasCode('INVALID_REQUEST'));
  const controller=new AbortController();controller.abort();
  await assert.rejects(state.reports.run(sent,{signal:controller.signal}),hasCode('CANCELLED'));
  const invalid={...sent,inputs:[{...sent.inputs[0],unexpected:'untrusted'}]};
  await assert.rejects(state.reports.run(invalid),hasCode('INVALID_REQUEST'));
  assert.equal(calls,0);assert.equal(state.gate.status.attemptsUsed,0);
});

test('a report holds the actual creation gate until dispatched cancellation, without refunds',async()=>{
  let announce!:()=>void;
  const dispatched=new Promise<void>(resolve=>{announce=resolve;});
  const state=harness({run:async()=>{announce();return new Promise(()=>{});}});
  const sent=await request(),controller=new AbortController();
  const running=state.reports.run(sent,{signal:controller.signal});
  const rejected=assert.rejects(running,hasCode('CANCELLED'));
  await dispatched;
  const fixture=proceduralFixtures[0];
  await assert.rejects(state.pipeline.run({text:fixture.prompt,profileId:'configured',geometryMode:'primitives',
    paidAttempt:{id:randomUUID(),confirmed:true}}),hasCode('LIVE_BUSY'));
  await assert.rejects(state.pipeline.runVoice({bytes:Buffer.from('RIFF1234WAVEaudio'),mimeType:'audio/wav'},
    {profileId:'configured',geometryMode:'primitives',captureMs:1000,paidAttempt:{id:randomUUID(),confirmed:true}}),hasCode('LIVE_BUSY'));
  assert.equal(state.gate.status.attemptsUsed,1);
  controller.abort();await rejected;
  assert.equal(state.gate.status.busy,false);
  await assert.rejects(state.reports.run(await request(sent.inputs)),hasCode('DUPLICATE_ATTEMPT'));
});

test('busy or exhausted creation admission never dispatches or queues a report',async()=>{
  let calls=0;
  const state=harness({run:async req=>{calls++;return authoredBatch(req.items.map(item=>item.input));}},mockContentGuard,true,1);
  const release=state.gate.acquire({paidAttempt:{id:randomUUID(),confirmed:true}});
  await assert.rejects(state.reports.run(await request()),hasCode('LIVE_BUSY'));
  assert.equal(calls,0);
  release();
  await assert.rejects(state.reports.run(await request()),hasCode('LIVE_LIMIT_REACHED'));
  assert.equal(calls,0);assert.equal(state.gate.status.attemptsUsed,1);
});

test('stalled generation and guard adapters obey deadlines without a retry',async()=>{
  let calls=0;
  const state=harness({run:async()=>{calls++;return new Promise(()=>{});}},mockContentGuard,true,3,
    {totalMs:100,generationMs:30,screeningMs:20});
  await assert.rejects(state.reports.run(await request()),hasCode('TIMEOUT'));
  assert.equal(calls,1);assert.equal(state.gate.status.attemptsUsed,1);assert.equal(state.gate.status.busy,false);
  const stalled=harness({run:async req=>{calls++;return authoredBatch(req.items.map(item=>item.input));}},
    {check:async()=>new Promise(()=>{})},true,3,{totalMs:60,generationMs:30,screeningMs:10});
  await assert.rejects(stalled.reports.run(await request()),hasCode('PROVIDER_UNAVAILABLE'));
  assert.equal(calls,1);assert.equal(stalled.gate.status.busy,false);
});

test('malformed batches and missing, foreign, duplicate, or cross-item evidence fail closed',async()=>{
  const first=input(),second=input(first.runId,'event-2');
  const valid=authoredBatch([first,second]);
  const badReports=[
    {items:[]},
    {items:[valid.items[0]]},
    {items:[valid.items[0],valid.items[0]]},
    {items:[{...valid.items[0],creationId:'unknown'},valid.items[1]]},
    {items:[{...valid.items[0],evidenceIds:[valid.items[1].evidenceIds[0]]},valid.items[1]]},
    {items:[{...valid.items[0],evidenceIds:[valid.items[0].evidenceIds[0],valid.items[0].evidenceIds[0]]},valid.items[1]]},
    {items:[{...valid.items[0],evidenceIds:[]},valid.items[1]]},
    {items:[{...valid.items[0],headline:'x'.repeat(71)},valid.items[1]]},
    {items:[{...valid.items[0],finding:'x'.repeat(181)},valid.items[1]]},
    {items:[{...valid.items[0],extra:'field'},valid.items[1]]},
    {...valid,extra:'field'},
  ];
  for(const output of badReports) {
    let checks=0,calls=0;
    const state=harness({run:async()=>{calls++;return output;}},{check:async()=>{checks++;return 'allow';}});
    await assert.rejects(state.reports.run(await request([first,second])),hasCode('INVALID_DESIGN'));
    assert.equal(calls,1);assert.equal(checks,1);assert.equal(state.gate.status.attemptsUsed,1);
  }
});

test('input and output content screening both consume the attempt and never repair the report',async()=>{
  for(const blockOn of [1,2]) {
    let checks=0,calls=0;
    const state=harness({run:async req=>{calls++;return authoredBatch(req.items.map(item=>item.input));}},
      {check:async()=>++checks===blockOn?'block':'allow'});
    await assert.rejects(state.reports.run(await request()),hasCode('REFUSED'));
    assert.equal(calls,blockOn-1);assert.equal(state.gate.status.attemptsUsed,1);assert.equal(state.gate.status.busy,false);
  }
});

test('report HTTP boundaries enforce origin, consent, bytes, identity, and sanitized errors',async()=>{
  let calls=0;
  const state=harness({run:async()=>{calls++;throw new Error('test-secret-provider-body');}});
  const app=buildApp({pipeline:state.pipeline,reports:state.reports});
  const post=(payload:object,origin='http://localhost:5173')=>app.inject({method:'POST',url:'/api/race-reports',headers:{origin},payload});
  try {
    const status=await app.inject({method:'GET',url:'/api/race-reports/status'});
    assert.equal(status.headers['cache-control'],'no-store');
    assert.equal(RaceReportStatusSchema.parse(status.json()).available,true);
    const sent=await request();
    for (const origin of ['https://foreign.example','http://localhost:5173/path','http://user@localhost:5173',
      'http://localhost:5173?query','http://localhost:5173#fragment','null'])
      assert.equal((await post(sent,origin)).statusCode,403,origin);
    assert.equal((await post({...sent,paidAttempt:undefined})).statusCode,400);
    assert.equal((await post({...sent,inputFingerprint:'0'.repeat(64)})).statusCode,400);
    assert.equal((await post({...sent,inputs:[{...sent.inputs[0],displayName:'x'.repeat(5000)}]})).statusCode,400);
    assert.equal(calls,0);
    const failed=await post(sent);
    assert.equal(failed.statusCode,502);assert.equal(failed.json().error.code,'PROVIDER_ERROR');
    assert.equal(failed.body.includes('test-secret'),false);
    assert.equal((await post({...sent,paidAttempt:{id:randomUUID(),confirmed:true}})).statusCode,409);
    assert.equal(calls,1);
  } finally {await app.close();}
});

test('default and hosted previews expose only free reporting and production keeps its exact origin',async()=>{
  const original=globalThis.fetch;
  let network=0;
  globalThis.fetch=async()=>{network++;throw new Error('Network forbidden');};
  const apps=[
    buildApp(),
    buildHostedApp({VERCEL_ENV:'preview',HOSTED_LIVE_ENABLED:'true',OPENAI_API_KEY:'fake-key',APP_ORIGIN:'https://game.example'}),
    buildHostedApp({VERCEL_ENV:'production',HOSTED_LIVE_ENABLED:'true',OPENAI_API_KEY:'fake-key',APP_ORIGIN:'https://game.example'}),
  ];
  try {
    for(const [index,app] of apps.entries()) {
      const status=RaceReportStatusSchema.parse((await app.inject({method:'GET',url:'/api/race-reports/status'})).json());
      assert.equal(status.available,index===2);
      await app.inject({method:'GET',url:'/api/health'});
      const sent=await request();
      const rejected=await app.inject({method:'POST',url:'/api/race-reports',payload:sent,
        headers:{origin:index===2?'https://foreign.example':'http://localhost:5173'}});
      assert.equal(rejected.statusCode,403);
      const mock=await app.inject({method:'POST',url:'/api/race-reports',payload:await request(input(),'mock')});
      assert.equal(mock.statusCode,200);
    }
    assert.equal(network,0);
  } finally {for(const app of apps)await app.close();globalThis.fetch=original;}
});

test('app rejects a second independently injected report allowance',()=>{
  const state=harness();
  const other=new RaceReportService(new LiveAttempts({enabled:true,maxAttempts:3}),config);
  assert.throws(()=>buildApp({pipeline:state.pipeline,reports:other}),/same live admission gate/);
});

test('report Responses request is schema-derived, capped, tool-free, and non-stored',async()=>{
  let calls=0;
  const sent=input();
  const report=authoredBatch([sent]);
  const transport=openAIRaceReportTransport('test-fake-key',async(_url,init)=>{
    calls++;
    const body=JSON.parse(String(init?.body));
    assert.equal(body.store,false);assert.equal(body.max_output_tokens,1200);
    assert.equal(body.tools,undefined);assert.equal(body.text.format.strict,true);
    assert.deepEqual(body.text.format.schema,RACE_REPORT_FORMAT.schema);
    assert.equal(body.input.includes('audio'),false);
    return new Response(JSON.stringify({id:'resp_test',object:'response',status:'completed',output:[
      {type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(report)}]},
    ]}),{headers:{'content-type':'application/json'}});
  });
  const state=harness(transport);
  assert.deepEqual((await state.reports.run(await request(sent))).items,report.items);
  assert.equal(calls,1);
});

test('SDK refusals, incomplete output, malformed JSON, and provider failures never retry',async()=>{
  const cases=[
    {status:200,body:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'No'}]}]},code:'REFUSED'},
    {status:200,body:{status:'incomplete',output:[]},code:'INCOMPLETE'},
    {status:200,body:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'not json'}]}]},code:'INVALID_DESIGN'},
    {status:500,body:{error:{message:'test-provider-secret',type:'server_error',code:'server_error'}},code:'PROVIDER_UNAVAILABLE'},
  ];
  for(const item of cases) {
    let calls=0;
    const transport=openAIRaceReportTransport('test-fake-key',async()=>{
      calls++;return new Response(JSON.stringify({id:'resp_test',object:'response',...item.body}),
        {status:item.status,headers:{'content-type':'application/json'}});
    });
    const state=harness(transport);
    await assert.rejects(state.reports.run(await request()),hasCode(item.code));
    assert.equal(calls,1);assert.equal(state.gate.status.attemptsUsed,1);assert.equal(state.gate.status.busy,false);
  }
});


test('a report consumes capacity from the same allowance used by full voice generation',async()=>{
  const state=harness(undefined,undefined,true,2);
  const fixture=proceduralFixtures[0];
  const result=await state.pipeline.runVoice({bytes:Buffer.from('RIFF1234WAVEaudio'),mimeType:'audio/wav'},
    {profileId:'configured',geometryMode:'primitives',captureMs:1000,paidAttempt:{id:randomUUID(),confirmed:true}});
  assert.equal(result.spec?.displayName,fixture.spec.displayName);
  await state.reports.run(await request());
  assert.equal(state.pipeline.liveUsage.attemptsUsed,2);
  await assert.rejects(state.pipeline.runVoice({bytes:Buffer.from('RIFF1234WAVEaudio'),mimeType:'audio/wav'},
    {profileId:'configured',geometryMode:'primitives',captureMs:1000,paidAttempt:{id:randomUUID(),confirmed:true}}),hasCode('LIVE_LIMIT_REACHED'));
});

test('closing an HTTP report cancels generation and releases the shared slot without refund',async()=>{
  let announce!:()=>void,announceAbort!:()=>void;
  const started=new Promise<void>(resolve=>{announce=resolve;});
  const aborted=new Promise<void>(resolve=>{announceAbort=resolve;});
  const state=harness({run:async req=>{
    req.signal.addEventListener('abort',announceAbort,{once:true});announce();return new Promise(()=>{});
  }});
  const app=buildApp({pipeline:state.pipeline,reports:state.reports});
  const controller=new AbortController();
  try {
    const address=await app.listen({host:'127.0.0.1',port:0});
    const running=fetch(address+'/api/race-reports',{method:'POST',signal:controller.signal,
      headers:{'Content-Type':'application/json',Origin:'http://localhost:5173'},body:JSON.stringify(await request())});
    const rejected=assert.rejects(running);
    await started;controller.abort();await rejected;await aborted;
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(state.gate.status.busy,false);assert.equal(state.gate.status.attemptsUsed,1);
  } finally {controller.abort();app.server.closeAllConnections();await app.close();}
});


test('total report deadline clips later stages and prevents any expired stage from dispatching',async()=>{
  let generations=0;
  const zero=harness({run:async req=>{generations++;return authoredBatch(req.items.map(item=>item.input));}},
    {check:async()=>{throw new Error('An expired screening stage must not start');}},true,3,
    {totalMs:100,generationMs:50,screeningMs:0});
  await assert.rejects(zero.reports.run(await request()),hasCode('TIMEOUT'));
  assert.equal(generations,0);assert.equal(zero.gate.status.attemptsUsed,1);assert.equal(zero.gate.status.busy,false);
  const total=harness({run:async()=>{generations++;return new Promise(()=>{});}},mockContentGuard,true,3,
    {totalMs:20,generationMs:100,screeningMs:100});
  await assert.rejects(total.reports.run(await request()),hasCode('TIMEOUT'));
  assert.equal(generations,1);assert.equal(total.gate.status.busy,false);
});
