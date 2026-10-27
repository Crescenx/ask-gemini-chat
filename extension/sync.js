export const HOST='com.ask_gemini_chat.auth';
export const COOKIE_NAMES=['__Secure-1PSID','__Secure-1PSIDTS'];

export function relevantCookie(cookie){
  return COOKIE_NAMES.includes(cookie.name)&&['.google.com','google.com','gemini.google.com'].includes(cookie.domain)&&!cookie.partitionKey;
}

export function nativeRequest(chrome,message){
  return new Promise((resolve,reject)=>{
    const port=chrome.runtime.connectNative(HOST);
    let done=false;
    const finish=(error,result)=>{
      if(done)return;
      done=true;clearTimeout(timer);port.disconnect();
      if(error)reject(error);else resolve(result);
    };
    const timer=setTimeout(()=>finish(Error('BRIDGE_TIMEOUT')),180000);
    port.onMessage.addListener(result=>finish(null,result));
    port.onDisconnect.addListener(()=>{
      // Reading lastError prevents Chrome logging its potentially local-path-bearing message.
      void chrome.runtime.lastError;
      finish(Error('BRIDGE_UNAVAILABLE'));
    });
    try{port.postMessage(message);}catch{finish(Error('BRIDGE_UNAVAILABLE'));}
  });
}

export async function syncLogin(chrome,request=nativeRequest){
  let cookies;
  try{
    cookies=(await chrome.cookies.getAll({url:'https://gemini.google.com/app'}))
      .filter(relevantCookie).map(({name,value,domain})=>({name,value,domain}));
  }catch{
    return {connection:'unknown',state:'error',code:'COOKIE_ACCESS_FAILED',checkedAt:Date.now()};
  }
  try{
    const result=await request(chrome,{version:1,type:'sync',cookies});
    if(result?.version!==1||result.connection!=='connected'||!['ready','error'].includes(result.state)||!Number.isFinite(result.checkedAt))throw Error('BRIDGE_PROTOCOL_ERROR');
    // Only status crosses into extension storage; never cookies or account identifiers.
    return {connection:'connected',state:result.state,code:result.state==='error'?result.code:undefined,checkedAt:result.checkedAt};
  }catch(error){
    return {connection:'disconnected',state:'error',code:['BRIDGE_TIMEOUT','BRIDGE_PROTOCOL_ERROR'].includes(error.message)?error.message:'BRIDGE_UNAVAILABLE',checkedAt:Date.now()};
  }
}

export function statusText(status){
  if(!status||status.state==='checking')return '正在检查连接与登录…';
  if(status.state==='ready')return 'Gemini 登录已同步。';
  const messages={
    BRIDGE_UNAVAILABLE:'未连接本地程序。请检查本地桥接是否已配置，稍后会自动重试。',
    BRIDGE_TIMEOUT:'本地程序响应超时，稍后会自动重试。',
    BRIDGE_PROTOCOL_ERROR:'本地程序版本不兼容，请更新本地程序。',
    BRIDGE_ERROR:'本地桥接配置异常，请检查本地配置。',
    LOCAL_ERROR:'本地程序发生错误，请检查本地运行环境。',
    COOKIE_ACCESS_FAILED:'无法读取登录状态，请检查插件的网站访问权限。',
    MISSING_1PSID:'请在当前浏览器登录 Gemini，登录后会自动同步。',
    LOGIN_REQUIRED:'登录已失效，请打开 Gemini 完成登录，之后会自动同步。',
    ACCOUNT_MISMATCH:'浏览器账号与本地绑定账号不同。请切回原账号；原会话已保留。',
    NETWORK_ERROR:'暂时无法访问 Gemini。请检查网络，稍后会自动重试。',
    RATE_LIMITED:'Gemini 暂时限制请求，稍后会自动重试。',
    SESSION_BUSY:'另一个请求正在更新登录，稍后会自动重试。',
    HTTP_TRANSPORT_UNAVAILABLE:'本地 HTTP 运行环境不可用，请检查项目环境。',
    AMBIGUOUS_COOKIES:'检测到多个登录状态，请在单独的浏览器资料中使用目标账号。',
  };
  return messages[status.code]||'暂时无法验证登录，稍后会自动重试。';
}
