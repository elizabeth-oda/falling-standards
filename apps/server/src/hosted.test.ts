import { mockContentGuard } from './generation/content-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PipelineProfilesSchema, proceduralFixtures, appearanceToRecipe } from '@sky/shared';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from './app.js';
import { buildHostedApp } from './hosted.js';
import { CreationPipeline } from './generation/pipeline.js';
import { pipelineProfiles } from './generation/pipeline-config.js';

const env = {VERCEL_ENV:'production',HOSTED_LIVE_ENABLED:'true',APP_ORIGIN:'https://game.example',
  OPENAI_API_KEY:'fake-provider-secret'};
const paidAttempt = () => ({id:randomUUID(),confirmed:true as const});
const input = () => ({text:'red rocket with fins',profileId:'sol-astra',geometryMode:'primitives' as const,paidAttempt:paidAttempt()});

test('hosted builds stay mock-only without explicit production enablement; health never calls a provider',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('Unexpected network');};
  try {
    for (const settings of [{},{...env,VERCEL_ENV:'preview'},{...env,VERCEL_ENV:'development'},{...env,HOSTED_LIVE_ENABLED:'false'}]) {
      const app=buildHostedApp(settings);
      try {
        assert.equal((await app.inject('/api/health')).json().mode,'mock');
        const profiles=PipelineProfilesSchema.parse((await app.inject('/api/lab/profiles')).json());
        assert.equal(profiles.liveUsage.enabled,false);
        assert.equal(profiles.liveUsage.maxAttempts,500);
        assert.ok(profiles.profiles.filter(p=>p.mode==='live').every(p=>!p.available));
        const mock=await app.inject({method:'POST',url:'/api/lab/events',payload:{...input(),text:'hungry purple planet',profileId:'mock'}});
        assert.equal(JSON.parse(mock.body.trim().split('\n').at(-1)!).type,'complete');
      } finally {await app.close();}
    }
    assert.equal(calls,0);
  } finally {globalThis.fetch=original;}
});

test('hosted live configuration requires a provider key and one exact HTTPS origin',()=>{
  for (const field of ['OPENAI_API_KEY','APP_ORIGIN']) {
    assert.throws(()=>buildHostedApp({...env,[field]:''}));
  }
  for (const origin of ['http://game.example','https://game.example/','https://game.example/path','https://user:pass@game.example']) {
    assert.throws(()=>buildHostedApp({...env,APP_ORIGIN:origin}),/APP_ORIGIN/);
  }
});

test('hosted typed and voice requests reject missing/foreign origins without provider calls',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('Unexpected network');};
  const app=buildHostedApp(env);
  try {
    assert.equal((await app.inject('/api/health')).json().mode,'live');
    for (const origin of [undefined,'http://localhost:5173','https://game.example.evil','https://other.vercel.app']) {
      const headers=origin ? {origin} : {};
      const text=await app.inject({method:'POST',url:'/api/lab/events',headers,payload:input()});
      assert.equal(text.statusCode,403);
      const body=new FormData();
      body.append('options',JSON.stringify({profileId:'sol-astra',captureMs:1000,paidAttempt:paidAttempt()}));
      body.append('audio',new Blob(['RIFF1234WAVEaudio'],{type:'audio/wav'}),'clip.wav');
      const request=new Request('https://game.example',{method:'POST',body});
      const voice=await app.inject({method:'POST',url:'/api/voice/events',headers:{...headers,'content-type':request.headers.get('content-type')!},payload:Buffer.from(await request.arrayBuffer())});
      assert.equal(voice.statusCode,403);
    }
    const profilesResponse=await app.inject('/api/lab/profiles');
    const profiles=PipelineProfilesSchema.parse(profilesResponse.json());
    assert.deepEqual(profiles.liveUsage,{enabled:true,maxAttempts:500,attemptsUsed:0,attemptsRemaining:500,busy:false});
    assert.equal(profiles.transcription?.available,true);
    assert.ok(!profilesResponse.body.includes(env.OPENAI_API_KEY));
    assert.equal(calls,0);
  } finally {await app.close();globalThis.fetch=original;}
});

test('hosted allowance can be explicitly lowered',async()=>{
  const app=buildHostedApp({...env,LIVE_MAX_ATTEMPTS:'10'});
  try {
    const profiles=PipelineProfilesSchema.parse((await app.inject('/api/lab/profiles')).json());
    assert.equal(profiles.liveUsage.maxAttempts,10);
  } finally {await app.close();}
});

test('the in-memory slot stays reserved across both generation stages',async()=>{
  const fixture=proceduralFixtures.find(item=>item.prompt==='red rocket with fins')!;
  const pipeline:CreationPipeline=new CreationPipeline(pipelineProfiles(env,true),{mock:{run:async()=>{throw new Error('Unexpected mock');}},live:{run:async request=>{
    assert.equal(pipeline.liveUsage.busy,true);
    return {data:request.stage==='design'?fixture.design:appearanceToRecipe(fixture.appearance)};
  }}},undefined,{enabled:true,maxAttempts:100},undefined,{mock:mockContentGuard,live:mockContentGuard});
  await pipeline.run(input());
  assert.equal(pipeline.liveUsage.busy,false);
  assert.equal(pipeline.liveUsage.attemptsRemaining,99);
});

test('HTTP progress streams before generation finishes and disconnect cancels work', {timeout:5000},async t=>{
  let upstreamSignal:AbortSignal|undefined;
  const pipeline=new CreationPipeline(pipelineProfiles(env,true),{
    mock:{run:async()=>{throw new Error('Unexpected mock');}},
    live:{run:async request=>{upstreamSignal=request.signal;return new Promise(()=>{});}},
  },undefined,{enabled:true,maxAttempts:100},undefined,{mock:mockContentGuard,live:mockContentGuard});
  const app=buildApp({pipeline,allowedOrigin:origin=>origin===env.APP_ORIGIN});
  const controller=new AbortController();
  try {
    const address=await app.listen({host:'127.0.0.1',port:0});
    const response=await fetch(address+'/api/lab/creations',{method:'POST',headers:{'Content-Type':'application/json',Origin:env.APP_ORIGIN},body:JSON.stringify(input()),signal:AbortSignal.any([controller.signal,t.signal])});
    const reader=response.body!.getReader();
    const first=await reader.read();
    assert.match(new TextDecoder().decode(first.value),/"stage":"design"/);
    assert.equal(upstreamSignal?.aborted,false);
    await reader.cancel();controller.abort();
    for (let i=0;i<100 && pipeline.liveUsage.busy;i++) await delay(10);
    assert.equal(upstreamSignal?.aborted,true);
    assert.equal(pipeline.liveUsage.busy,false,'Disconnect must release the attempt');
    assert.equal(pipeline.liveUsage.attemptsUsed,1);
  } finally {controller.abort();app.server.closeAllConnections();await app.close();}
});
