import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { proceduralFixtures, type CreationSpec, type VoiceRequest } from '@sky/shared';
import type { LabAttempt } from '../generation/lab-history';

// Exercise the component's real event wiring with hook, recorder, and request
// adapters. No browser microphone, provider transport, or paid request is used.
const code=ts.transpileModule(readFileSync(new URL('./VoiceLabPanel.tsx',import.meta.url),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
type Element={type:unknown;props:Record<string,unknown>};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup(){
  const hooks:unknown[]=[],effects:Array<()=>void|(()=>void)>=[];
  let cursor=0,mounted=false;
  const slot=(initial:()=>unknown)=>{const index=cursor++;if(!(index in hooks))hooks[index]=initial();return index;};
  const React={
    useState(initial:unknown){
      const index=slot(()=>typeof initial==='function'?initial():initial);
      return [hooks[index],(next:unknown)=>{hooks[index]=typeof next==='function'?next(hooks[index]):next;}];
    },
    useRef(initial:unknown){return hooks[slot(()=>({current:initial}))];},
    useSyncExternalStore(_subscribe:unknown,snapshot:()=>unknown){return snapshot();},
    useEffect(effect:()=>void|(()=>void)){if(!mounted)effects.push(effect);},
  };
  let recorderCancels=0,requestCount=0,signal:AbortSignal|undefined;
  class Recorder{
    getSnapshot=()=>({ready:true,phase:'ready'});
    subscribe=()=>()=>{};
    cancel(){recorderCancels++;}
    async start(){}
    async stop(){return {blob:new Blob(['fake audio']),captureMs:1900};}
  }
  const window=new EventTarget(),document=Object.assign(new EventTarget(),{hidden:false});
  const RecorderControls=()=>null;
  const jsx=(type:unknown,props:Record<string,unknown>)=>({type,props});
  const attempts:LabAttempt[]=[],completed:CreationSpec[]=[],requests:Array<Omit<VoiceRequest,'captureMs'>>=[];
  const result={text:'A rotten apple with worms.',metric:{model:'mock-transcription',durationMs:1570}};
  let resolveRequest!:(value:{result:typeof result;spec:CreationSpec})=>void;
  const response=new Promise<{result:typeof result;spec:CreationSpec}>(resolve=>{resolveRequest=resolve;});
  const modules:Record<string,unknown>={
    react:React,'react/jsx-runtime':{jsx,jsxs:jsx},
    '@sky/shared':{PIPELINE_DEADLINE_MS:30000},
    '../generation/lab-history':{attemptMetrics:()=>[]},
    './recorder':{MicrophoneRecorder:Recorder},'./RecorderControls':{RecorderControls},
    './voice-client':{
      VoiceRequestError:class extends Error{},
      requestVoice:(_audio:unknown,request:Omit<VoiceRequest,'captureMs'>,requestSignal:AbortSignal)=>{
        requests.push(request);requestCount++;signal=requestSignal;return response;
      },
    },
  };
  const sandbox={exports:{} as {VoiceLabPanel:(props:unknown)=>unknown},
    require:(id:string)=>{assert.ok(id in modules,'Unexpected import: '+id);return modules[id];},
    window,document,AbortController,performance,crypto:globalThis.crypto,setInterval,clearInterval};
  runInNewContext(code,sandbox);
  const render=()=>{cursor=0;return sandbox.exports.VoiceLabPanel({
    profile:{id:'fake-live',mode:'live',available:true},geometryMode:'primitives',
    liveUsage:{enabled:true,busy:false,attemptsRemaining:3,maxAttempts:3},transcription:{model:'fake-speech',available:true},
    onBusy(){},onRefresh(){},onAttempt:(attempt:LabAttempt)=>attempts.push(attempt),
    onComplete:(spec:CreationSpec)=>completed.push(spec),
  });};
  function find(node:unknown,predicate:(element:Element)=>boolean):Element|undefined{
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node))return node.map(child=>find(child,predicate)).find(Boolean);
    const element=node as Element;
    return predicate(element)?element:find(element.props?.children,predicate);
  }
  assert.equal(find(render(),element=>element.props?.type==='checkbox'),undefined);
  const cleanups=effects.map(effect=>effect());mounted=true;
  const controls=()=>find(render(),element=>element.type===RecorderControls)!;
  const interrupt=(kind:string)=>{
    if(kind==='blur')window.dispatchEvent(new Event('blur'));
    else if(kind==='hidden'){document.hidden=true;document.dispatchEvent(new Event('visibilitychange'));}
    else (controls().props.onCancel as ()=>void)();
  };
  return {
    attempts,completed,requests,interrupt,signal:()=>signal,requestCount:()=>requestCount,recorderCancels:()=>recorderCancels,
    async start(){(controls().props.onStart as ()=>void)();await flush();},
    async submit(){(controls().props.onFinish as ()=>void)();await flush();},
    async complete(){resolveRequest({result,spec:proceduralFixtures[0].spec});await flush();},
    cancel(){const button=find(render(),element=>element.type==='button'&&element.props.children==='Cancel voice attempt')!;
      (button.props.onClick as ()=>void)();},
    unmount(){cleanups.forEach(cleanup=>cleanup?.());},
  };
}

for(const kind of ['blur','hidden','pointer']){
  test(kind+' interrupts capture and records its reason without dispatch',async()=>{
    const ui=setup();await ui.start();ui.interrupt(kind);
    assert.equal(ui.requestCount(),0);assert.equal(ui.attempts.length,1);
    assert.equal(ui.attempts[0].outcome,'cancelled');
    assert.match(ui.attempts[0].message,kind==='blur'?/lost focus/:kind==='hidden'?/tab hidden/:/gesture interrupted/);
    assert.ok(ui.recorderCancels()>0);ui.unmount();
  });
  test(kind+' after release preserves the submitted request and accepts its result',async()=>{
    const ui=setup();await ui.start();await ui.submit();ui.interrupt(kind);
    assert.equal(ui.signal()?.aborted,false);assert.equal(ui.attempts.length,0);
    await ui.complete();
    assert.equal(ui.requestCount(),1);assert.equal(ui.attempts[0].outcome,'ready');
    assert.equal(ui.completed.length,1);ui.unmount();
  });
}
test('explicit cancellation still aborts submitted work and discards late results',async()=>{
  const ui=setup();await ui.start();await ui.submit();ui.cancel();
  assert.equal(ui.signal()?.aborted,true);assert.equal(ui.attempts[0].outcome,'cancelled');
  assert.match(ui.attempts[0].message,/cancelled by you/);
  await ui.complete();assert.equal(ui.completed.length,0);assert.equal(ui.attempts.length,1);
  assert.equal(ui.requestCount(),1);ui.unmount();
});
test('leaving the voice page aborts submitted work and ignores late completion',async()=>{
  const ui=setup();await ui.start();await ui.submit();ui.unmount();
  assert.equal(ui.signal()?.aborted,true);assert.match(ui.signal()?.reason.message,/page closed/);
  await ui.complete();assert.equal(ui.completed.length,0);assert.equal(ui.attempts.length,0);
});

test('live voice needs no checkbox and adds fresh paid metadata only on deliberate submissions',async()=>{
  const ui=setup();
  assert.equal(ui.requestCount(),0);
  await ui.start();assert.equal(ui.requestCount(),0);
  await ui.submit();await ui.submit();
  assert.equal(ui.requestCount(),1);
  assert.equal(ui.requests[0].paidAttempt?.confirmed,true);
  assert.match(ui.requests[0].paidAttempt?.id??'',/^[0-9a-f-]{36}$/);
  await ui.complete();
  await ui.start();await ui.submit();
  assert.equal(ui.requestCount(),2);
  assert.notEqual(ui.requests[0].paidAttempt?.id,ui.requests[1].paidAttempt?.id);
  ui.unmount();
});
