import test from 'node:test';
import assert from 'node:assert/strict';
import {startSessionKeepalive} from './session-keepalive.mjs';

function harness(auth){
  let job,ms,cancelled=false;
  const notices=[];
  const stop=startSessionKeepalive(auth,{
    notify:code=>notices.push(code),
    schedule:(fn,wait)=>{job=fn;ms=wait;return {unref(){}};},
    cancel:()=>{cancelled=true;},
  });
  return {stop,notices,run:()=>job(),get ms(){return ms;},get cancelled(){return cancelled;}};
}
test('idle maintenance starts immediately, repeats at ten minutes and stops',async()=>{
  let calls=0;
  const h=harness({ensure:async()=>{calls++;}});
  assert.equal(h.ms,0);
  await h.run();assert.equal(calls,1);assert.equal(h.ms,600000);
  await h.run();assert.equal(calls,2);assert.deepEqual(h.notices,[]);
  await h.stop();assert(h.cancelled);
});
test('transient failures back off silently and success resets the delay',async()=>{
  let fail=true;
  const h=harness({ensure:async()=>{if(fail)throw Object.assign(Error(),{code:'NETWORK_ERROR'});}});
  await h.run();assert.equal(h.ms,60000);
  await h.run();assert.equal(h.ms,120000);
  for(let i=0;i<8;i++)await h.run();
  assert.equal(h.ms,3600000);assert.deepEqual(h.notices,[]);
  fail=false;await h.run();assert.equal(h.ms,600000);
  fail=true;await h.run();assert.equal(h.ms,60000);
  await h.stop();
});
test('revocation notifies once, polls only disk, and resumes after login',async()=>{
  let calls=0,state='login_required';
  const h=harness({
    load:async()=>({state}),
    ensure:async()=>{calls++;if(state!=='ready')throw Object.assign(Error(),{code:'LOGIN_REQUIRED'});},
  });
  await h.run();await h.run();await h.run();
  assert.equal(calls,1);assert.equal(h.ms,60000);assert.deepEqual(h.notices,['LOGIN_REQUIRED']);
  state='ready';await h.run();assert.equal(calls,2);assert.deepEqual(h.notices,['LOGIN_REQUIRED','ready']);
  await h.stop();
});
test('shutdown drains in-flight refresh without scheduling another timer',async()=>{
  let resolve,schedules=0;
  let job;
  const stop=startSessionKeepalive({ensure:()=>new Promise(r=>{resolve=r;})},{schedule:fn=>{schedules++;job=fn;return {};},cancel:()=>{}});
  const running=job();
  let drained=false;const stopping=stop().then(()=>{drained=true;});
  await Promise.resolve();assert.equal(drained,false);
  resolve();await running;await stopping;assert.equal(schedules,1);
});
