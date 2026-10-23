import crypto from 'node:crypto';
import mime from 'mime-types';
import {SessionAuth} from './web-auth.mjs';
import {ARGON,frames,generation,protocolError} from './web-protocol.mjs';
import {httpFetch} from './http-fetch.mjs';

const ROOT='https://gemini.google.com';
export class WebAPI {
  constructor({auth=new SessionAuth({file:process.env.GEMINI_SESSION_FILE}),fetchImpl=httpFetch}={}){
    this.auth=auth;this.fetch=fetchImpl;this.requests=new Map();
  }
  async init(){this.session=await this.auth.ensure();return {transport:'curl-http',model:ARGON,browserRequired:false};}
  async request(url,options={},timeout=20000){
    const cookie=new URL(url).origin===ROOT?Object.entries(this.session.cookies).map(([k,v])=>k+'='+v).join('; '):undefined;
    const r=await this.fetch(url,{...options,redirect:'error',signal:timeout===null?undefined:AbortSignal.timeout(timeout),headers:{accept:'*/*','origin':ROOT,'referer':ROOT+'/app','sec-fetch-mode':'cors','sec-fetch-dest':'empty','sec-fetch-site':cookie?'same-origin':'cross-site',...(cookie?{cookie}:{}),...options.headers}});
    if(!r.ok){await r.body?.cancel().catch(()=>{});throw Error('HTTP_'+r.status);}
    return r;
  }
  async upload(files){
    this.session=await this.auth.ensure();
    const refs=[];
    for(const f of files){
      const type=mime.lookup(f.name)||'application/octet-stream';
      let upload;
      if(f.path) upload={uploadFile:{path:f.path,name:f.name,type}};
      else {
        if(!(f.bytes instanceof Uint8Array))throw Error('INVALID_FILE');
        const form=new FormData();form.append('file',new Blob([f.bytes],{type}),f.name);
        upload={body:form};
      }
      const r=await this.request('https://content-push.googleapis.com/upload',{method:'POST',headers:{'X-Tenant-Id':'bard-storage','Push-ID':this.session.pushId},...upload},null);
      const id=await r.text();if(!id.startsWith('/contrib_service/'))throw Error('UPLOAD_INVALID_REFERENCE');
      refs.push([[id,type.startsWith('image/')?1:3,null,type],f.name,null,null,null,null,null,null,[0]]);
    }
    return refs;
  }
  /** @param {{id?: string, prompt: string, metadata?: any[], files?: any[], operationFlag?: number, temporary?: boolean}} input */
  async start({id=crypto.randomUUID(),prompt,metadata=['','',''],files=[],operationFlag,temporary=false}){
    if(typeof prompt!=='string'||!prompt.length)throw Error('INVALID_PROMPT');
    if(typeof temporary!=='boolean')throw Error('INVALID_CHAT_MODE');
    if(operationFlag!==undefined&&![2,5].includes(operationFlag))throw Error('INVALID_OPERATION_FLAG');
    const input={id,prompt,metadata,files,temporary,...(operationFlag===undefined?{}:{operationFlag})},signature=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'),prior=this.requests.get(id);
    if(prior){if(prior.signature!==signature)throw Error('REQUEST_ID_CONFLICT');return id;}
    const state={signature,raw:'',receivedChars:0,done:false,status:null,startedAt:Date.now()};this.requests.set(id,state);
    state.task=this.generate(input,state).catch(e=>{state.error=e.name==='TimeoutError'?'GENERATION_TIMEOUT':/^[A-Z][A-Z_0-9: ]*$/.test(e.message)?e.message:'TRANSPORT_ERROR';}).finally(()=>{state.done=true;state.elapsedMs=Date.now()-state.startedAt;});
    return id;
  }
  async generate(input,state){
    state.stage='authentication';
    this.session=await this.auth.ensure();
    const body=Array(97).fill(null);
    body[0]=[input.prompt,0,null,input.files.length?input.files:null,null,null,0];body[1]=['en'];body[2]=[...input.metadata,null,null,null,null,null,null,''];
    // Sending a locally generated attestation caused generic error answers; omission is supported.
    body[6]=[0];body[7]=1;body[10]=1;body[11]=0;body[17]=[[0]];body[18]=0;body[27]=1;body[30]=[4];body[41]=[1];body[53]=0;body[59]=input.id;body[61]=[];body[68]=1;body[79]=8;body[80]=1;body[91]=0;body[96]=0;
    if(input.operationFlag!==undefined)body[72]=input.operationFlag;
    if(input.temporary)body[45]=1;
    const query=new URLSearchParams({bl:this.session.build,'f.sid':this.session.sessionId,hl:'en',_reqid:String(crypto.randomInt(100000,1000000)),rt:'c'});
    const modelHeader=[1,null,null,null,ARGON,null,null,0,[4,5,6,8],null,null,1,null,null,8,1,crypto.randomUUID()];
    const headers={'content-type':'application/x-www-form-urlencoded;charset=UTF-8','x-same-domain':'1','x-goog-authuser':'0','x-goog-ext-73010989-jspb':'[0]','x-goog-ext-73010990-jspb':'[0,0,0]','x-goog-ext-525001261-jspb':JSON.stringify(modelHeader),'x-goog-ext-525005358-jspb':JSON.stringify([input.id,1])};
    state.stage='generation';
    const r=await this.request(ROOT+'/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?'+query,{method:'POST',headers,body:new URLSearchParams({at:this.session.accessToken,'f.req':JSON.stringify([null,JSON.stringify(body)])})},null);
    state.status=r.status;
    const reader=r.body.getReader(),decoder=new TextDecoder();
    let pending=[];
    const accept=line=>{
      if(!line.startsWith('['))return;
      const raw=line+'\n';
      let parsed;
      try{parsed=frames(raw);state.response=generation(raw,state.response);}
      catch{throw Error('INVALID_STREAM_FRAME');}
      state.rejection??=protocolError(raw);
      for(const frame of parsed){
        if(frame[0]==='wrb.fr'&&typeof frame[2]==='string'){
          const model=JSON.parse(frame[2])?.[39];
          if(typeof model==='string'&&/^[a-f0-9]{16}$/.test(model))state.model=model;
        }
      }
      // Each upstream frame repeats the answer; retain the latest snapshot, not the whole replay.
      state.raw=raw;
    };
    try{
      for(;;){
        const {value,done}=await reader.read();
        const text=done?decoder.decode():decoder.decode(value,{stream:true});
        state.receivedChars+=text.length;
        let start=0,newline;
        while((newline=text.indexOf('\n',start))>=0){
          pending.push(text.slice(start,newline));accept(pending.join(''));pending=[];start=newline+1;
        }
        if(start<text.length)pending.push(text.slice(start));
        if(done){if(pending.length)accept(pending.join(''));state.exhausted=true;break;}
      }
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  async poll(id){const state=this.requests.get(id);if(!state)throw Error('REQUEST_UNKNOWN');const {signature,task,...result}=state;return result;}
  release(id){if(this.requests.get(id)?.done)this.requests.delete(id);}
  /** @param {string} cid @param {number} limit @param {string|null} cursor */
  async history(cid,limit=20,cursor=null){
    if(!/^c_[a-f0-9]+$/.test(cid))throw Error('INVALID_CONVERSATION');
    if(!Number.isSafeInteger(limit)||limit<1)throw Error('INVALID_HISTORY_LIMIT');
    if(cursor!==null&&typeof cursor!=='string')throw Error('INVALID_HISTORY_CURSOR');
    return this.rpc('hNvQHb',[cid,limit,cursor,1,[1],[4],null,1]);
  }
  async rpc(method,payload){
    if(!['hNvQHb','KDNZr','kOWVAe'].includes(method))throw Error('UNSUPPORTED_RPC');
    this.session=await this.auth.ensure();
    const query=new URLSearchParams({rpcids:method,bl:this.session.build,'f.sid':this.session.sessionId,hl:'en',rt:'c'});
    for(let attempt=0;;attempt++){
      try{
        const r=await this.request(ROOT+'/_/BardChatUi/data/batchexecute?'+query,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8','x-same-domain':'1'},body:new URLSearchParams({at:this.session.accessToken,'f.req':JSON.stringify([[[method,JSON.stringify(payload),null,'generic']]])})});
        return await r.text();
      }catch(error){
        // History is read-only; fork/select and generation must never be replayed here.
        if(method!=='hNvQHb'||attempt||!(error.message==='HTTP_TRANSPORT_ERROR'||error.name==='TimeoutError'))throw error;
      }
    }
  }
}
