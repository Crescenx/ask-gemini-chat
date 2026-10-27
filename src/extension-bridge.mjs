import {endianness} from 'node:os';
import {AuthError} from './web-auth.mjs';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const nativeHostName='com.ask_gemini_chat.auth';
const little=endianness()==='LE';

export async function extensionRevision(directory=fileURLToPath(new URL('../extension',import.meta.url))){
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  // Do not reload while a checkout is incomplete or its entrypoints are missing.
  await readFile(join(directory,manifest.background.service_worker));
  await readFile(join(directory,manifest.action.default_popup));
  const hash=createHash('sha256');
  for(const name of (await readdir(directory)).filter(name=>/\.(?:json|js|css|html)$/.test(name)).sort()){
    hash.update(name).update(await readFile(join(directory,name)));
  }
  return hash.digest('hex');
}

export function nativeFrame(value){
  const body=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);
  if(little)header.writeUInt32LE(body.length);else header.writeUInt32BE(body.length);
  return Buffer.concat([header,body]);
}

// One request per native connection; respond without waiting for EOF.
export async function readNativeMessage(input){
  let buffer=Buffer.alloc(0),size;
  for await(const chunk of input){
    buffer=Buffer.concat([buffer,chunk]);
    if(size===undefined&&buffer.length>=4){
      size=little?buffer.readUInt32LE():buffer.readUInt32BE();
      // Chrome's native messaging protocol allows at most 64 MiB toward the host.
      if(!size||size>64*1024*1024)throw new AuthError('INVALID_MESSAGE');
    }
    if(size!==undefined&&buffer.length>=size+4){
      try{return JSON.parse(buffer.subarray(4,size+4));}catch{throw new AuthError('INVALID_MESSAGE');}
    }
  }
  throw new AuthError('INVALID_MESSAGE');
}

export async function handleExtensionMessage(auth,message){
  try{
    if(message?.version!==1||!['sync','status','revision'].includes(message.type))throw new AuthError('INVALID_MESSAGE');
    if(message.type==='revision')return {version:1,revision:await extensionRevision()};
    if(message.type==='sync'){
      if(!Array.isArray(message.cookies))throw new AuthError('INVALID_MESSAGE');
      await auth.syncBrowser(message.cookies);
    }else await auth.ensure();
    return {version:1,connection:'connected',state:'ready',checkedAt:Date.now()};
  }catch(error){
    const code=error instanceof AuthError?error.code:'LOCAL_ERROR';
    return {version:1,connection:'connected',state:'error',code,checkedAt:Date.now()};
  }
}
