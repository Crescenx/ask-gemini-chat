import {nativeRequest} from './sync.js';

export async function checkUpdate(chrome,{installed=false,request=nativeRequest}={}){
  try{
    const result=await request(chrome,{version:1,type:'revision'});
    if(result?.version!==1||!/^[a-f0-9]{64}$/.test(result.revision??''))return;
    const {loadedRevision,candidateRevision}=await chrome.storage.local.get(['loadedRevision','candidateRevision']);
    if(installed||!loadedRevision){
      await chrome.storage.local.set({loadedRevision:result.revision,candidateRevision:null});
    }else if(result.revision===loadedRevision){
      await chrome.storage.local.set({candidateRevision:null});
    }else if(result.revision===candidateRevision){
      // Two consecutive observations avoid reloading halfway through git pull.
      chrome.runtime.reload();
    }else await chrome.storage.local.set({candidateRevision:result.revision});
  }catch{ /* A missing/older bridge must not break login synchronization. */ }
}
