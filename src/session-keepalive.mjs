const INTERVAL=10*60*1000;

export function startSessionKeepalive(auth,{notify=(_state)=>{},schedule=setTimeout,cancel=clearTimeout}={}){
  let timer, running, stopped=false, failures=0, waiting=false;
  async function tick(){
    let next=INTERVAL;
    try{
      // After revocation, wait for an explicit login to replace the saved session.
      if(waiting){
        const stored=await auth.load().catch(error=>{
          if(error.code==='LOGIN_REQUIRED')return null;
          throw error;
        });
        if(stored?.state!=='ready'){next=60000;return;}
      }
      await auth.ensure();
      if(waiting)notify('ready');
      waiting=false;failures=0;
    }catch(error){
      if(['LOGIN_REQUIRED','ACCOUNT_MISMATCH'].includes(error.code)){
        if(!waiting)notify(error.code);
        waiting=true;next=60000;
      }else{
        next=Math.min(60000*2**Math.min(failures++,6),60*60*1000);
      }
    }finally{
      if(!stopped)arm(next);
    }
  }
  function arm(ms){timer=schedule(()=>{running=tick();return running;},ms);timer.unref?.();}
  arm(0);
  return async()=>{stopped=true;cancel(timer);await running;};
}
