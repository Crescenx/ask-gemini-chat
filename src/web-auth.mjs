import fs from 'node:fs/promises';
import {sessionFile} from './config.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {httpFetch} from './http-fetch.mjs';

const APP='https://gemini.google.com/app';
const ROTATE='https://accounts.google.com/RotateCookies';
const allowed=new Set(['__Secure-1PSID','__Secure-1PSIDTS']);
export class AuthError extends Error { constructor(code){super(code);this.code=code;} }

export function importCookies(value){
  const input=Array.isArray(value)?value:Array.isArray(value?.cookies)?value.cookies:Object.entries(value?.cookies??value??{}).map(([name,value])=>({name,value}));
  const cookies={};
  for(const item of input){
    if(!allowed.has(item.name))continue;
    if(item.domain&&!['.google.com','google.com','gemini.google.com'].includes(item.domain))continue;
    if(typeof item.value!=='string'||!item.value.length||/[\x00-\x20\x7f;]/.test(item.value)||item.value.length>8192)throw new AuthError('INVALID_COOKIE');
    if(cookies[item.name]&&cookies[item.name]!==item.value)throw new AuthError('AMBIGUOUS_COOKIES');
    cookies[item.name]=item.value;
  }
  if(!cookies['__Secure-1PSID'])throw new AuthError('MISSING_1PSID');
  return cookies;
}

function bootstrap(html){
  const get=key=>{
    const match=html.match(new RegExp('"'+key+'":\\s*("(?:[^"\\\\]|\\\\.)*")'));
    return match?JSON.parse(match[1]):null;
  };
  const accessToken=get('SNlM0e'),identity=get('oPEP7c');
  if(!accessToken||!identity)throw new AuthError('LOGIN_REQUIRED');
  return {accessToken,account:crypto.createHash('sha256').update(identity).digest('hex'),build:get('cfb2h'),sessionId:get('FdrFJe'),pushId:get('qKIAYe')};
}

async function atomicSave(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  const handle=await fs.open(temp,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
  await fs.rename(temp,file);
}

export class SessionAuth {
  constructor({file=sessionFile,fetchImpl=httpFetch,now=Date.now}={}){this.file=file;this.fetch=fetchImpl;this.now=now;}
  async exclusive(operation){
    await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
    const lockFile=this.file+'.lock.sqlite';
    const handle=await fs.open(lockFile,'a',0o600);await handle.close();
    const db=new DatabaseSync(lockFile);
    const deadline=Date.now()+90000;
    try{
      // SQLite releases this cross-process lock even if a refresher crashes.
      for(;;){
        try{db.exec('BEGIN IMMEDIATE');break;}
        catch(error){
          if(error.errcode!==5)throw error;
          if(Date.now()>=deadline)throw new AuthError('SESSION_BUSY');
          await delay(50);
        }
      }
      return await operation();
    }finally{db.close();}
  }
  async load(){
    try{return JSON.parse(await fs.readFile(this.file,'utf8'));}
    catch(e){if(e.code==='ENOENT')throw new AuthError('LOGIN_REQUIRED');throw e;}
  }
  async request(url,cookies,options={}){
    let response;
    try{response=await this.fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(30000),headers:{...options.headers,cookie:Object.entries(cookies).map(([k,v])=>k+'='+v).join('; '),'referer':APP}});}
    catch(error){throw new AuthError(error.message==='HTTP_TRANSPORT_UNAVAILABLE'?error.message:'NETWORK_ERROR');}
    for(const line of response.headers.getSetCookie()){
      const [pair,...attrs]=line.split(';'),index=pair.indexOf('='),name=pair.slice(0,index),value=pair.slice(index+1);
      if(!allowed.has(name))continue;
      if(!value||attrs.some(s=>/^\s*max-age\s*=\s*0\s*$/i.test(s)))delete cookies[name];
      else if(!/[\x00-\x20\x7f;]/.test(value))cookies[name]=value;
    }
    if(response.status===401||(response.status>=300&&response.status<400))throw new AuthError('LOGIN_REQUIRED');
    if(response.status===429)throw new AuthError('RATE_LIMITED');
    if(!response.ok)throw new AuthError('HTTP_'+response.status);
    return response;
  }
  async rotate(cookies){
    await (await this.request(ROTATE,cookies,{method:'POST',headers:{'content-type':'application/json','origin':'https://accounts.google.com'},body:'[000,"-0000000000000000000"]'})).text();
  }
  async validate(cookies){return bootstrap(await (await this.request(APP,cookies)).text());}
  async import(value){
    return this.exclusive(()=>this._import(value));
  }
  async _import(value){
    let previous;try{previous=await this.load();}catch(e){if(e.code!=='LOGIN_REQUIRED')throw e;}
    const cookies=importCookies(value);let session,rotated=false;
    try{session=await this.validate(cookies);}catch(e){
      if(e.code!=='LOGIN_REQUIRED')throw e;
      await this.rotate(cookies);rotated=true;session=await this.validate(cookies);
    }
    if(previous?.account&&previous.account!==session.account)throw new AuthError('ACCOUNT_MISMATCH');
    await atomicSave(this.file,{version:1,account:session.account,cookies,validatedAt:this.now(),refreshedAt:rotated?this.now():0,state:'ready'});
    return {state:'ready',account:session.account};
  }
  async ensure({refresh=false}={}){
    // Sharing this promise also prevents concurrent rotations within one client.
    if(this.pending)return this.pending;
    this.pending=this.exclusive(()=>this._ensure(refresh));
    try{return await this.pending;}finally{this.pending=null;}
  }
  async _ensure(refresh){
    const stored=await this.load();
    if(!stored.cookies?.['__Secure-1PSID'])throw new AuthError('LOGIN_REQUIRED');
    const cookies=importCookies(stored.cookies);
    let rotated=false;
    try{
      if(refresh||this.now()-(stored.refreshedAt??0)>=600000){await this.rotate(cookies);rotated=true;}
      let session;
      try{session=await this.validate(cookies);}catch(e){
        if(e.code!=='LOGIN_REQUIRED'||rotated)throw e;
        await this.rotate(cookies);rotated=true;session=await this.validate(cookies);
      }
      if(session.account!==stored.account)throw new AuthError('ACCOUNT_MISMATCH');
      await atomicSave(this.file,{...stored,cookies,state:'ready',validatedAt:this.now(),refreshedAt:rotated?this.now():stored.refreshedAt});
      return {...session,cookies};
    }catch(e){
      if(e.code==='LOGIN_REQUIRED')await atomicSave(this.file,{...stored,cookies,state:'login_required'});
      if(e.code==='ACCOUNT_MISMATCH')await atomicSave(this.file,{...stored,state:'login_required'});
      throw e;
    }
  }
  async status(){
    try{const session=await this.ensure();return {state:'ready',account:session.account};}
    catch(e){if(e instanceof AuthError)return {state:e.code==='LOGIN_REQUIRED'?'login_required':'error',code:e.code};throw e;}
  }
}
