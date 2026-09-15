import { mockContentGuard } from './generation/content-guard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appearanceToRecipe, proceduralFixtures, PipelineEventSchema, PipelineProfilesSchema, type PipelineRequest } from '@sky/shared';
import { buildApp } from './app.js';
import { buildPipeline } from './generation/pipeline-bootstrap.js';
import { pipelineProfiles } from './generation/pipeline-config.js';
import { CreationPipeline } from './generation/pipeline.js';
import { LiveAttempts } from './generation/live-attempts.js';
import { PipelineFailure } from './generation/pipeline-errors.js';
import type { StageTransport } from './generation/stage-transport.js';

const secret = 'test-only-key-never-send';
const fixture = proceduralFixtures.find(item => item.prompt === 'red rocket with fins')!;
const request = ():PipelineRequest => ({text:fixture.prompt,profileId:'sol-astra',geometryMode:'primitives',paidAttempt:{id:randomUUID(),confirmed:true}});
const responseFor:StageTransport['run'] = async request => ({data:request.stage === 'design' ? fixture.design : appearanceToRecipe(fixture.appearance)});
function livePipeline(run:StageTransport['run'] = responseFor, maxAttempts = 3, enabled = true) {
  return new CreationPipeline(pipelineProfiles({OPENAI_API_KEY:secret},true),{live:{run},mock:{run:responseFor}},undefined,{enabled,maxAttempts},undefined,{mock:mockContentGuard,live:mockContentGuard});
}
const code = (expected:string) => (error:unknown) => error instanceof PipelineFailure && error.code === expected;

test('key presence and inherited enable flags cannot enable paid generation', async () => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {networkCalls++;throw new Error('Network forbidden in test');};
  const pipeline = buildPipeline({OPENAI_API_KEY:secret,ENABLE_LIVE_GENERATION:'true',ALLOW_LIVE_GENERATION:'true'});
  const app = buildApp({pipeline});
  try {
    const profiles = await app.inject({method:'GET',url:'/api/lab/profiles'});
    const publicData = PipelineProfilesSchema.parse(profiles.json());
    assert.ok(publicData.profiles.filter(profile => profile.mode === 'live').every(profile => !profile.available));
    assert.equal(publicData.liveUsage.enabled,false);
    assert.equal(profiles.body.includes(secret),false);
    await app.inject({method:'GET',url:'/api/health'});
    await assert.rejects(pipeline.run(request()),code('LIVE_DISABLED'));
    const direct = await app.inject({method:'POST',url:'/api/lab/creations',payload:request()});
    assert.equal(direct.statusCode,403);
    assert.equal(direct.json().error.code,'LIVE_DISABLED');
    assert.equal(networkCalls,0);
    assert.equal(pipeline.liveUsage.attemptsUsed,0);
  } finally {await app.close();globalThis.fetch=original;}
});

test('pipeline gate stays off even if a caller supplies an available live profile and transport', async () => {
  let calls = 0;
  const pipeline = livePipeline(async () => {calls++;throw new Error('Must not run');},3,false);
  await assert.rejects(pipeline.run(request()),code('LIVE_DISABLED'));
  assert.equal(calls,0);
});

test('live mode without a key remains unavailable, and the allowance is bounded', async () => {
  const pipeline = buildPipeline({},true);
  await assert.rejects(pipeline.run(request()),code('NOT_CONFIGURED'));
  assert.equal(pipeline.liveUsage.attemptsUsed,0);
  for (const value of ['0','501','NaN','1.5','']) assert.throws(() => buildPipeline({LIVE_MAX_ATTEMPTS:value}),/LIVE_MAX_ATTEMPTS/);
  assert.equal(buildPipeline({LIVE_MAX_ATTEMPTS:'1'}).liveUsage.maxAttempts,1);
  assert.equal(buildPipeline({LIVE_MAX_ATTEMPTS:'500'}).liveUsage.maxAttempts,500);
});

test('one explicit attempt dispatches exactly two calls and rejects a replay without spending again', async () => {
  let calls = 0;
  const pipeline = livePipeline(async input => {calls++;return responseFor(input);});
  const input = request();
  const spec = await pipeline.run(input);
  assert.equal(spec.displayName,'Red rocket');
  assert.equal(calls,2);
  assert.deepEqual(pipeline.liveUsage,{enabled:true,maxAttempts:3,attemptsUsed:1,attemptsRemaining:2,busy:false});
  await assert.rejects(pipeline.run(input),code('DUPLICATE_ATTEMPT'));
  assert.equal(calls,2);
});

test('missing or malformed dispatch metadata is blocked before dispatch; early cancellation costs no allowance', async () => {
  let calls = 0;
  const pipeline = livePipeline(async input => {calls++;return responseFor(input);});
  await assert.rejects(pipeline.run({...request(),paidAttempt:undefined}),code('CONSENT_REQUIRED'));
  await assert.rejects(pipeline.run({...request(),paidAttempt:{id:'invalid',confirmed:true}}),code('INVALID_REQUEST'));
  const controller = new AbortController();controller.abort();
  await assert.rejects(pipeline.run(request(),{signal:controller.signal}),code('CANCELLED'));
  assert.equal(calls,0);assert.equal(pipeline.liveUsage.attemptsUsed,0);
});

test('concurrent tabs and profiles share a single live slot; cancelled dispatched work consumes an attempt', async () => {
  let dispatched!:() => void;
  const started = new Promise<void>(resolve => {dispatched=resolve;});
  let calls = 0;
  const pipeline = livePipeline(async () => {calls++;dispatched();return new Promise(() => {});});
  const controller = new AbortController(), input = request();
  const running = pipeline.run(input,{signal:controller.signal});
  const finished = assert.rejects(running,code('CANCELLED'));
  await started;
  assert.equal(pipeline.liveUsage.busy,true);
  await assert.rejects(pipeline.run(input),code('DUPLICATE_ATTEMPT'));
  await assert.rejects(pipeline.run({...request(),profileId:'sol-sol'}),code('LIVE_BUSY'));
  assert.equal(calls,1);
  controller.abort();await finished;
  assert.equal(pipeline.liveUsage.busy,false);
  assert.equal(pipeline.liveUsage.attemptsUsed,1);
  await assert.rejects(pipeline.run(input),code('DUPLICATE_ATTEMPT'));
});

test('failed provider calls exhaust the shared allowance without refunds, retries, or leaking secrets', async () => {
  let calls = 0;
  const pipeline = livePipeline(async () => {calls++;throw new Error(secret);});
  const app = buildApp({pipeline});
  try {
    for (const profileId of ['sol-astra','sol-sol','configured']) {
      const response = await app.inject({method:'POST',url:'/api/lab/creations',payload:{...request(),profileId}});
      assert.equal(response.statusCode,200);
      assert.equal(response.body.includes(secret),false);
      const terminal = PipelineEventSchema.parse(JSON.parse(response.body.trim().split('\n').at(-1)!));
      assert.ok(terminal.type === 'failed' && terminal.error.code === 'PROVIDER_ERROR');
    }
    await assert.rejects(pipeline.run(request()),code('LIVE_LIMIT_REACHED'));
    assert.equal(calls,3);
    assert.equal(pipeline.liveUsage.attemptsRemaining,0);
    const mock = await pipeline.run({...request(),profileId:'mock',paidAttempt:undefined});
    assert.equal(mock.displayName,'Red rocket');
    assert.equal(calls,3);assert.equal(pipeline.liveUsage.attemptsUsed,3);
  } finally {await app.close();}
});

test('HTTP boundary rejects unconfirmed, malformed, and foreign-origin paid requests', async () => {
  let calls = 0;
  const pipeline = livePipeline(async input => {calls++;return responseFor(input);});
  const app = buildApp({pipeline});
  try {
    for (const payload of [{...request(),paidAttempt:undefined},{...request(),paidAttempt:{id:randomUUID(),confirmed:false}}]) {
      const response = await app.inject({method:'POST',url:'/api/lab/creations',payload});
      assert.equal(response.statusCode,400);
    }
    for (const origin of ['https://untrusted.example','http://localhost:5173/path','http://user@localhost:5173',
      'http://localhost:5173?query','http://localhost:5173#fragment','null']) {
      const foreign = await app.inject({method:'POST',url:'/api/lab/creations',headers:{origin},payload:request()});
      assert.equal(foreign.statusCode,403,origin);
    }
    assert.equal(calls,0);
    const confirmed = await app.inject({method:'POST',url:'/api/lab/creations',headers:{origin:'http://localhost:5173'},payload:request()});
    assert.equal(confirmed.statusCode,200);assert.equal(calls,2);
    const status = PipelineProfilesSchema.parse((await app.inject({method:'GET',url:'/api/lab/profiles'})).json());
    assert.equal(status.liveUsage.attemptsRemaining,2);
  } finally {await app.close();}
});

test('500-attempt allowance and duplicate IDs belong to one in-memory instance', () => {
  const attempts=new LiveAttempts({enabled:true,maxAttempts:500});
  const first=request();
  attempts.acquire(first)();
  for (let i=1;i<500;i++) attempts.acquire(request())();
  assert.equal(attempts.status.attemptsRemaining,0);
  assert.throws(()=>attempts.acquire(first),code('DUPLICATE_ATTEMPT'));
  assert.throws(()=>attempts.acquire(request()),code('LIVE_LIMIT_REACHED'));
  const anotherInstance=new LiveAttempts({enabled:true,maxAttempts:500});
  anotherInstance.acquire(first)();
  assert.equal(anotherInstance.status.attemptsRemaining,499);
});


test('report admission shares the allowance and permits only one batch per run', () => {
  const gate=new LiveAttempts({enabled:true,maxAttempts:4});
  const runId=randomUUID(), first={runId,inputFingerprint:'a'.repeat(64)};
  const attempt=request();
  const release=gate.acquire(attempt,first);
  assert.equal(gate.status.busy,true);
  assert.throws(()=>gate.acquire(request(),first),code('DUPLICATE_ATTEMPT'));
  assert.throws(()=>gate.acquire(request(),{runId:randomUUID(),inputFingerprint:'b'.repeat(64)}),code('LIVE_BUSY'));
  release();
  const changed={...first,inputFingerprint:'c'.repeat(64)};
  assert.throws(()=>gate.acquire(attempt,changed),code('DUPLICATE_ATTEMPT'));
  assert.throws(()=>gate.acquire(request(),changed),code('DUPLICATE_ATTEMPT'));
  const releaseVoice=gate.acquire(request());
  release(); // A previously released attempt must not unlock a newer owner's slot.
  assert.equal(gate.status.busy,true);
  releaseVoice();
  gate.acquire(request(),{runId:randomUUID(),inputFingerprint:'d'.repeat(64)})();
  gate.acquire(request(),{runId:randomUUID(),inputFingerprint:'e'.repeat(64)})();
  assert.equal(gate.status.attemptsRemaining,0);
  assert.throws(()=>gate.acquire(request(),{runId:randomUUID(),inputFingerprint:'f'.repeat(64)}),code('LIVE_LIMIT_REACHED'));
  assert.equal(gate.status.busy,false);
});

test('an injected admission instance is the pipeline gate without another allowance', async () => {
  const gate=new LiveAttempts({enabled:true,maxAttempts:1});
  const pipeline=new CreationPipeline(pipelineProfiles({OPENAI_API_KEY:secret},true),
    {mock:{run:responseFor},live:{run:responseFor}},undefined,undefined,undefined,
    {mock:mockContentGuard,live:mockContentGuard},gate);
  assert.equal(pipeline.admissionGate,gate);
  gate.acquire(request(),{runId:randomUUID(),inputFingerprint:'a'.repeat(64)})();
  await assert.rejects(pipeline.run(request()),code('LIVE_LIMIT_REACHED'));
  assert.equal(pipeline.liveUsage.attemptsUsed,1);
});
