import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable,PassThrough} from 'node:stream';
import {nativeFrame,readNativeMessage,handleExtensionMessage} from './extension-bridge.mjs';
import {AuthError} from './web-auth.mjs';
import {syncLogin,nativeRequest,relevantCookie,statusText} from '../extension/sync.js';
import {checkUpdate} from '../extension/update.js';

test('native framing handles fragmented UTF-8 and responds before stdin closes',async()=>{
  const value={version:1,type:'sync',text:'同步'},frame=nativeFrame(value);
  assert.deepEqual(await readNativeMessage(Readable.from([...frame].map(b=>Buffer.from([b])))),value);
  const input=new PassThrough();
  const result=readNativeMessage(input);input.write(frame);
  assert.deepEqual(await result,value);
  await assert.rejects(readNativeMessage(Readable.from([frame.subarray(0,-1)])),/INVALID_MESSAGE/);
  await assert.rejects(readNativeMessage(Readable.from([Buffer.alloc(4)])),/INVALID_MESSAGE/);
  const invalid=nativeFrame('bad');invalid.fill(120,4);
  await assert.rejects(readNativeMessage(Readable.from([invalid])),/INVALID_MESSAGE/);
});

test('bridge rejects invalid commands and sanitizes auth results and exceptions',async()=>{
  const cookies=[{name:'__Secure-1PSID',value:'secret'}];
  const auth={syncBrowser:async value=>{assert.deepEqual(value,cookies);return {cookies,account:'private'};}};
  const result=await handleExtensionMessage(auth,{version:1,type:'sync',cookies});
  assert.equal(result.state,'ready');assert(!JSON.stringify(result).includes('secret'));assert(!('account' in result));
  for(const message of [{},{version:1,type:'execute'},{version:1,type:'sync',cookies:{}}])assert.equal((await handleExtensionMessage(auth,message)).code,'INVALID_MESSAGE');
  auth.syncBrowser=async()=>{throw new AuthError('ACCOUNT_MISMATCH');};
  assert.equal((await handleExtensionMessage(auth,{version:1,type:'sync',cookies})).code,'ACCOUNT_MISMATCH');
  auth.ensure=async()=>{throw Error('secret');};
  assert.equal((await handleExtensionMessage(auth,{version:1,type:'status'})).code,'LOCAL_ERROR');
});

test('extension sends only Gemini auth cookies and separates bridge errors from login errors',async()=>{
  const selected={name:'__Secure-1PSID',value:'secret',domain:'.google.com'};
  const chrome={cookies:{getAll:async()=>[selected,{name:'unrelated',value:'private'}, {...selected,domain:'evil.invalid'}, {...selected,partitionKey:{topLevelSite:'https://example.com'}}]}};
  let request;
  const ready=await syncLogin(chrome,async(c,m)=>{request=m;return {version:1,connection:'connected',state:'ready',checkedAt:123,cookies:'must-not-persist'};});
  assert.deepEqual(request.cookies,[selected]);assert(!JSON.stringify(ready).includes('persist'));
  const offline=await syncLogin(chrome,async()=>{throw Error('local-path');});
  assert.equal(offline.connection,'disconnected');assert.equal(offline.code,'BRIDGE_UNAVAILABLE');
  const mismatch=await syncLogin(chrome,async()=>({version:1,connection:'connected',state:'error',code:'ACCOUNT_MISMATCH',checkedAt:123}));
  assert.equal(mismatch.connection,'connected');assert.match(statusText(mismatch),/原会话已保留/);
  assert.equal((await syncLogin(chrome,async()=>({state:'ready'}))).code,'BRIDGE_PROTOCOL_ERROR');
  chrome.cookies.getAll=async()=>[];
  await syncLogin(chrome,async(c,m)=>{assert.deepEqual(m.cookies,[]);return {version:1,connection:'connected',state:'error',code:'MISSING_1PSID',checkedAt:123};});
  assert.equal(relevantCookie({...selected,domain:'.evil.google.com'}),false);
});

function event(){const listeners=[];return {addListener:fn=>listeners.push(fn),fire:(...args)=>listeners.forEach(fn=>fn(...args))};}
test('native connection closes after response and a dropped connection is retryable',async()=>{
  let port;
  const chrome={runtime:{connectNative:()=>{
    port={onMessage:event(),onDisconnect:event(),postMessage:()=>{},disconnect:()=>{port.closed=true;port.onDisconnect.fire();}};
    return port;
  }}};
  const first=nativeRequest(chrome,{type:'sync'});
  port.onDisconnect.fire();await assert.rejects(first,/BRIDGE_UNAVAILABLE/);
  const second=nativeRequest(chrome,{type:'sync'});
  port.onMessage.fire({state:'ready'});
  assert.deepEqual(await second,{state:'ready'});assert(port.closed);
});

test('worker automatically syncs on startup and cookie changes, retries disconnects and restores alarms',async()=>{
  const original=globalThis.chrome;
  let status,alarm,requests=0,offline=false;
  const alarms=new Map();
  const cookie={name:'__Secure-1PSID',value:'secret',domain:'.google.com'};
  const chrome={
    runtime:{id:'test',onInstalled:event(),onStartup:event(),onMessage:event(),connectNative:()=>{
      const port={onMessage:event(),onDisconnect:event(),disconnect:()=>{},postMessage:()=>{
        requests++;queueMicrotask(()=>offline?port.onDisconnect.fire():port.onMessage.fire({version:1,connection:'connected',state:'ready',checkedAt:Date.now()}));
      }};return port;
    }},
    cookies:{getAll:async()=>[cookie],onChanged:event()},
    storage:{session:{set:async value=>{status=value.status;}}},
    alarms:{get:async name=>alarms.get(name),create:async(name,options)=>{alarms.set(name,{name,...options});if(name==='gemini-login-sync')alarm={name,...options};},onAlarm:event()},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
  };
  const wait=async predicate=>{
    for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}
    assert.fail('worker did not settle');
  };
  try{
    globalThis.chrome=chrome;
    await import('../extension/background.js?worker-test');
    await wait(()=>alarm);assert.equal(alarm.delayInMinutes,1);
    chrome.runtime.onStartup.fire();await wait(()=>status?.state==='ready'&&alarm.delayInMinutes===10);
    assert.equal(requests,1);assert(!JSON.stringify(status).includes('secret'));
    chrome.cookies.onChanged.fire({cookie:{...cookie,name:'unrelated'}});
    await new Promise(r=>setTimeout(r,10));assert.equal(requests,1);
    offline=true;chrome.cookies.onChanged.fire({cookie});
    await wait(()=>status?.connection==='disconnected'&&alarm.delayInMinutes===1);
    offline=false;chrome.alarms.onAlarm.fire({name:'gemini-login-sync'});
    await wait(()=>status?.state==='ready'&&alarm.delayInMinutes===10);
    assert.equal(requests,3);
    alarm=undefined;alarms.clear();
    await import('../extension/background.js?worker-restarted');
    await wait(()=>alarm);assert.equal(alarm.delayInMinutes,1);assert.equal(status.state,'ready');
  }finally{if(original===undefined)delete globalThis.chrome;else globalThis.chrome=original;}
});

test('auto update survives worker suspension, waits for stable files and resets after reload',async()=>{
  const saved={};let reloads=0,revision='a'.repeat(64);
  const chrome={storage:{local:{get:async()=>({...saved}),set:async value=>Object.assign(saved,value)}},runtime:{reload:()=>reloads++}};
  const request=async()=>({version:1,revision});
  await checkUpdate(chrome,{installed:true,request});
  assert.equal(saved.loadedRevision,revision);
  revision='b'.repeat(64);await checkUpdate(chrome,{request});assert.equal(reloads,0);
  revision='c'.repeat(64);await checkUpdate(chrome,{request});assert.equal(reloads,0);
  // Another invocation reads durable state instead of a worker-global baseline.
  await checkUpdate(chrome,{request});assert.equal(reloads,1);
  await checkUpdate(chrome,{installed:true,request});
  await checkUpdate(chrome,{request});assert.equal(reloads,1);
  await checkUpdate(chrome,{request:async()=>{throw Error('offline');}});assert.equal(reloads,1);
  await checkUpdate(chrome,{request:async()=>({version:1,state:'error',code:'INVALID_MESSAGE'})});assert.equal(reloads,1);
});

test('revision checks do not require a login or call Google',async()=>{
  const result=await handleExtensionMessage({ensure:()=>assert.fail('should not authenticate')},{version:1,type:'revision'});
  assert.match(result.revision,/^[a-f0-9]{64}$/);
});
