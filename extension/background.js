import {syncLogin,relevantCookie,statusText} from './sync.js';
import {checkUpdate} from './update.js';

const ALARM='gemini-login-sync';
const UPDATE_ALARM='gemini-extension-update';
async function updateCheck(installed=false){
  // Finish any login synchronization before reloading this worker.
  await navigator.locks.request(ALARM,()=>checkUpdate(chrome,{installed}));
}
async function synchronize(){
  return navigator.locks.request(ALARM,async()=>{
    await chrome.storage.session.set({status:{connection:'checking',state:'checking'}});
    const status=await syncLogin(chrome);
    await chrome.storage.session.set({status});
    await chrome.action.setBadgeText({text:status.state==='ready'?'OK':'!'});
    await chrome.action.setBadgeBackgroundColor({color:status.state==='ready'?'#166534':'#92400e'});
    await chrome.action.setTitle({title:statusText(status)});
    await chrome.alarms.create(ALARM,{delayInMinutes:status.state==='ready'?10:1});
    return status;
  });
}

async function run(){
  try{return await synchronize();}
  catch{
    const status={connection:'unknown',state:'error',code:'LOCAL_ERROR',checkedAt:Date.now()};
    await chrome.storage.session.set({status});
    await chrome.alarms.create(ALARM,{delayInMinutes:1});
    return status;
  }
}
chrome.runtime.onInstalled.addListener(()=>{void updateCheck(true);void run();});
chrome.runtime.onStartup.addListener(()=>{void run();});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)void run();});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===UPDATE_ALARM)void updateCheck();});
chrome.cookies.onChanged.addListener(({cookie})=>{if(relevantCookie(cookie))void run();});
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(sender.id!==chrome.runtime.id||message?.type!=='sync')return;
  void (async()=>{sendResponse(await run());})();
  return true;
});
// Alarms may be lost across browser restarts; keep retrying even with no popup open.
async function ensureAlarm(){
  if(!await chrome.alarms.get(ALARM))await chrome.alarms.create(ALARM,{delayInMinutes:1});
  if(!await chrome.alarms.get(UPDATE_ALARM))await chrome.alarms.create(UPDATE_ALARM,{periodInMinutes:1});
}
void ensureAlarm();
