import { mockContentGuard } from './generation/content-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appearanceToRecipe, proceduralFixtures, VoiceEventSchema, TranscriptResultSchema, type VoiceRequest } from '@sky/shared';
import { CreationPipeline } from './generation/pipeline.js';
import { pipelineProfiles } from './generation/pipeline-config.js';
import { PipelineFailure } from './generation/pipeline-errors.js';
import { openAITransport } from './generation/stage-transport.js';
import { openAITranscription, type TranscriptionProvider } from './voice/transcription.js';
import { buildApp } from './app.js';
import { buildPipeline } from './generation/pipeline-bootstrap.js';
const fixture=proceduralFixtures[0];
const audio={bytes:Buffer.from('RIFF1234WAVEaudio'),mimeType:'audio/wav'};
const request=():VoiceRequest=>({profileId:'sol-astra',geometryMode:'primitives',captureMs:1000,paidAttempt:{id:randomUUID(),confirmed:true}});
function harness(speech:TranscriptionProvider['transcribe']=async()=>fixture.prompt) {
  let geometryCalls=0,speechCalls=0;
  const pipeline=new CreationPipeline(pipelineProfiles({OPENAI_API_KEY:'test-fake-key'},true),{
    mock:{run:async()=>{throw new Error('Unexpected mock');}},
    live:{run:async request=>{geometryCalls++;return {data:request.stage==='design'?fixture.design:appearanceToRecipe(fixture.appearance)};}},
  },undefined,{enabled:true,maxAttempts:3},{mock:{model:'mock',transcribe:speech},live:{model:'test-transcription',transcribe:async(...args)=>{speechCalls++;return speech(...args);}}},{mock:mockContentGuard,live:mockContentGuard});
  return {pipeline,counts:()=>({geometryCalls,speechCalls})};
}
const failure=(code:string)=>(error:unknown)=>error instanceof PipelineFailure&&error.code===code;
async function upload(options:unknown,bytes:Uint8Array=audio.bytes,extra=false) {
  const body=new FormData();body.append('options',JSON.stringify(options));body.append('audio',new Blob([bytes as BlobPart],{type:'audio/wav'}),'recording.wav');
  if(extra)body.append('extra','forbidden');
  const request=new Request('http://localhost',{method:'POST',body});
  return {headers:{'content-type':request.headers.get('content-type')!},payload:Buffer.from(await request.arrayBuffer())};
}
test('speech + design + geometry share one allowance and reject replay',async()=>{
  const {pipeline,counts}=harness();const input=request();const events:unknown[]=[];
  const result=await pipeline.runVoice(audio,input,{emit:event=>events.push(event)});
  assert.equal(result.result.text,fixture.prompt);assert.equal(result.spec?.displayName,fixture.spec.displayName);
  assert.deepEqual(counts(),{speechCalls:1,geometryCalls:2});assert.equal(pipeline.liveUsage.attemptsUsed,1);assert.equal(pipeline.liveUsage.busy,false);
  events.forEach(event=>VoiceEventSchema.parse(event));
  await assert.rejects(pipeline.runVoice(audio,input),failure('DUPLICATE_ATTEMPT'));assert.equal(counts().speechCalls,1);
});
test('speech-only testing never dispatches geometry',async()=>{
  const {pipeline,counts}=harness();const result=await pipeline.runVoice(audio,request(),{transcribeOnly:true});
  TranscriptResultSchema.parse(result.result);assert.equal(result.spec,undefined);
  assert.deepEqual(counts(),{speechCalls:1,geometryCalls:0});assert.equal(pipeline.liveUsage.attemptsUsed,1);
});
test('invalid audio/consent is free; invalid transcripts consume a single attempt without generation',async()=>{
  for(const transcript of ['','one two three four five six seven eight nine ten eleven']){
    const {pipeline,counts}=harness(async()=>transcript);
    await assert.rejects(pipeline.runVoice({...audio,bytes:new Uint8Array()},request()),failure('INVALID_AUDIO'));
    await assert.rejects(pipeline.runVoice(audio,{...request(),paidAttempt:undefined}),failure('CONSENT_REQUIRED'));
    assert.equal(pipeline.liveUsage.attemptsUsed,0);
    await assert.rejects(pipeline.runVoice(audio,request()),failure('INVALID_TRANSCRIPT'));
    assert.equal(pipeline.liveUsage.attemptsUsed,1);assert.deepEqual(counts(),{speechCalls:1,geometryCalls:0});
  }
});
test('audio signatures require exact bytes before a paid attempt is admitted',async()=>{
  const {pipeline,counts}=harness();
  const clips=[
    {bytes:Buffer.from('RIFF1234WAVEaudio'),mimeType:'audio/wav',offsets:[0,8]},
    {bytes:Buffer.from('1234ftypaudio'),mimeType:'audio/mp4',offsets:[4]},
    {bytes:Buffer.from([0x1a,0x45,0xdf,0xa3,0]),mimeType:'audio/webm',offsets:[0]},
  ];
  for (const {bytes,mimeType,offsets} of clips) {
    for (const offset of offsets) {
      const corrupted=Buffer.from(bytes);
      corrupted[offset]^=0x80;
      await assert.rejects(pipeline.runVoice({bytes:corrupted,mimeType},request()),failure('INVALID_AUDIO'));
    }
    await assert.rejects(pipeline.runVoice({bytes:bytes.subarray(0,3),mimeType},request()),failure('INVALID_AUDIO'));
  }
  assert.deepEqual(counts(),{speechCalls:0,geometryCalls:0});
  assert.equal(pipeline.liveUsage.attemptsUsed,0);
  for (const clip of clips) await pipeline.runVoice(clip,request(),{transcribeOnly:true});
  assert.deepEqual(counts(),{speechCalls:3,geometryCalls:0});
});
test('speech cancellation and deadline abort active work and release the global slot',async()=>{
  for(const cancelled of [false,true]){
    let dispatch!:()=>void;const started=new Promise<void>(resolve=>{dispatch=resolve;});let signal:AbortSignal|undefined;
    const {pipeline,counts}=harness(async(_audio,value)=>{signal=value;dispatch();return new Promise(()=>{});});
    const controller=new AbortController();
    const running=pipeline.runVoice(audio,request(),{signal:controller.signal,transcriptionBudgetMs:cancelled?1000:20});
    const rejected=assert.rejects(running,failure(cancelled?'CANCELLED':'TRANSCRIPTION_TIMEOUT'));
    await started;
    await assert.rejects(pipeline.run({profileId:'sol-astra',paidAttempt:{id:randomUUID(),confirmed:true},text:fixture.prompt}),failure('LIVE_BUSY'));
    if(cancelled)controller.abort();
    await rejected;assert.ok(signal?.aborted);assert.equal(pipeline.liveUsage.busy,false);assert.equal(counts().geometryCalls,0);
  }
});
test('voice HTTP accepts bounded multipart, keeps JSON limits, and rejects foreign/oversized uploads without dispatch',async()=>{
  const {pipeline,counts}=harness();const app=buildApp({pipeline});
  try {
    const options=request();
    const foreign=await upload(options);
    const foreignResponse=await app.inject({method:'POST',url:'/api/voice/creations',...foreign,headers:{...foreign.headers,origin:'https://untrusted.example'}});
    assert.equal(foreignResponse.statusCode,403);
    for(const data of [await upload(options,new Uint8Array(1_048_577)),await upload(options,audio.bytes,true)]){
      const response=await app.inject({method:'POST',url:'/api/voice/creations',...data});assert.equal(response.statusCode,400);
    }
    const json=await app.inject({method:'POST',url:'/api/lab/creations',payload:{text:'x'.repeat(5000),profileId:'mock'}});assert.equal(json.statusCode,400);
    assert.equal(counts().speechCalls,0);
    const success=await app.inject({method:'POST',url:'/api/voice/creations',...await upload(request())});
    assert.equal(success.statusCode,200);
    const events=success.body.trim().split('\n').map(line=>VoiceEventSchema.parse(JSON.parse(line)));
    assert.equal(events.at(-1)?.type,'complete');assert.equal(pipeline.liveUsage.attemptsUsed,1);
  } finally {await app.close();}
});
test('actual SDK speech and generation use intercepted fetch, English hints, and exactly three requests',async()=>{
  const fixture=proceduralFixtures.find(item=>item.prompt==='red rocket with fins')!;
  let calls=0;
  const fakeFetch:typeof fetch=async(url,init)=>{
    if(String(url)==='data:,')return new Response(''); // SDK's local FormData capability probe.
    calls++;assert.equal(new Headers(init?.headers).get('authorization'),'Bearer test-private-credential');
    if(String(url).endsWith('/audio/transcriptions')){
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get('model'),'gpt-transcribe');
      assert.equal(init.body.get('languages[]'),'en');
      return new Response(JSON.stringify({text:fixture.prompt}),{headers:{'content-type':'application/json'}});
    }
    assert.equal(String(url),'https://api.openai.com/v1/responses');
    const body=JSON.parse(String(init?.body));
    const data=body.text.format.name.startsWith('design')?fixture.design:appearanceToRecipe(fixture.appearance);
    return new Response(JSON.stringify({object:'response',id:'resp_test',status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(data)}]}]}),{headers:{'content-type':'application/json'}});
  };
  const speech=openAITranscription('test-private-credential','gpt-transcribe',fakeFetch);
  const transport=openAITransport('test-private-credential',fakeFetch);
  const pipeline=new CreationPipeline(pipelineProfiles({OPENAI_API_KEY:'test-private-credential'},true),{mock:transport,live:transport},undefined,{enabled:true,maxAttempts:3},{mock:speech,live:speech},{mock:mockContentGuard,live:mockContentGuard});
  const result=await pipeline.runVoice(audio,{...request(),mockText:'giant rubber duck'});
  assert.equal(result.result.text,'red rocket with fins');assert.equal(result.spec?.displayName,fixture.spec.displayName);assert.equal(calls,3);assert.equal(pipeline.liveUsage.attemptsUsed,1);
});

test('speech SDK failures are sanitized and never retry or dispatch generation',async()=>{
  let calls=0;
  const speech=openAITranscription('test-credential','gpt-transcribe',async(url)=>{
    if(String(url)==='data:,')return new Response('');
    calls++;
    return new Response(JSON.stringify({error:{message:'private provider detail and test-credential',type:'server_error',code:'server_error'}}),{
      status:500,headers:{'content-type':'application/json','x-request-id':'req_0123456789abcdef'},
    });
  });
  const {pipeline,counts}=harness(speech.transcribe);
  const events:unknown[]=[];
  await assert.rejects(pipeline.runVoice(audio,request(),{emit:event=>events.push(event)}),failure('PROVIDER_UNAVAILABLE'));
  assert.equal(calls,1);assert.equal(counts().geometryCalls,0);assert.equal(pipeline.liveUsage.busy,false);
  const serialized=JSON.stringify(events);
  assert.ok(!serialized.includes('test-credential'));assert.ok(!serialized.includes('private provider detail'));
  assert.ok(serialized.includes('req_0123456789abcdef'));
});
test('generation receives its own deadline after transcription completes',async()=>{
  const speech:TranscriptionProvider={model:'test-speech',async transcribe(){await new Promise(resolve=>setTimeout(resolve,120));return fixture.prompt;}};
  const transport={run:async (request:Parameters<import('./generation/stage-transport.js').StageTransport['run']>[0])=>({data:request.stage==='design'?fixture.design:appearanceToRecipe(fixture.appearance)})};
  const pipeline=new CreationPipeline(pipelineProfiles({},false),{mock:transport},{totalMs:100,designMs:80},undefined,{mock:speech});
  const result=await pipeline.runVoice(audio,{profileId:'mock',geometryMode:'primitives',captureMs:1000},{transcriptionBudgetMs:1000});
  assert.ok(result.spec);assert.ok(result.result.metric.durationMs>=100);
});
test('closing the HTTP voice stream cancels transcription and releases the paid slot',async()=>{
  let dispatch!:()=>void,stopped!:()=>void;
  const started=new Promise<void>(resolve=>{dispatch=resolve;});
  const aborted=new Promise<void>(resolve=>{stopped=resolve;});
  const {pipeline,counts}=harness(async(_audio,signal)=>{
    signal.addEventListener('abort',stopped,{once:true});dispatch();return new Promise(()=>{});
  });
  const app=buildApp({pipeline});
  try {
    const url=await app.listen({port:0,host:'127.0.0.1'});
    const data=await upload(request());const controller=new AbortController();
    const response=fetch(url+'/api/voice/creations',{method:'POST',headers:data.headers,body:data.payload,signal:controller.signal}).catch(()=>undefined);
    await started;controller.abort();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([aborted,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Disconnect did not abort speech')),1000);})]);}
    finally{clearTimeout(timer);}
    await response;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(counts().geometryCalls,0);assert.equal(pipeline.liveUsage.busy,false);assert.equal(pipeline.liveUsage.attemptsUsed,1);
  } finally {await app.close();}
});

test('mock voice uses the selected simulated transcript and fixture instead of always choosing the duck',async()=>{
  const pipeline=buildPipeline({},false);
  const result=await pipeline.runVoice(audio,{profileId:'mock',geometryMode:'primitives',captureMs:1000,mockText:'red rocket with fins'});
  assert.equal(result.result.text,'red rocket with fins');
  assert.equal(result.result.metric.model,'mock-transcription');
  assert.equal(result.spec?.displayName,proceduralFixtures.find(item=>item.prompt==='red rocket with fins')!.spec.displayName);
  assert.equal(pipeline.liveUsage.attemptsUsed,0);
});
