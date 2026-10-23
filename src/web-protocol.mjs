export const ARGON='95a4c0abcba24364';

// Protocol payloads are single JSON lines; numeric length lines are framing only.
export function frames(raw){
  const lines=raw.split('\n'),out=[];
  for(let i=0;i<lines.length;i++){
    if(!lines[i].startsWith('['))continue;
    try{out.push(...JSON.parse(lines[i]));}catch(e){if(i!==lines.length-1)throw e;}
  }
  return out;
}
export function historyTurns(raw){
  const out=[];
  for(const f of frames(raw)){
    if(f[0]!=='wrb.fr'||f[1]!=='hNvQHb'||typeof f[2]!=='string')continue;
    for(const turn of JSON.parse(f[2])?.[0]??[]){
      const c=turn?.[3]?.[0]?.[0];
      if(c)out.push({prompt:turn?.[2]?.[0]?.[0],text:c?.[1]?.[0]??'',metadata:[...turn[0].slice(0,2),c[0]],complete:c?.[8]?.[0]===2,model:turn?.[3]?.[14]});
    }
  }
  return out;
}
export function protocolError(raw){
  for(const f of frames(raw)){
    if(f[0]==='wrb.fr'&&f[5])return {rpcCode:f[5][0],code:f[5]?.[2]?.[0]?.[1]?.[0]??null};
  }
  return null;
}
export function generation(raw,previous){
  let result=previous?{...previous}:{text:'',metadata:null,complete:false};
  for(const frame of frames(raw)){
    if(frame[0]!=='wrb.fr'||typeof frame[2]!=='string')continue;
    const body=JSON.parse(frame[2]);
    if(body?.[1]?.[0]){
      if(result.metadata&&(body[1][0]!==result.metadata[0]||body[1][1]!==result.metadata[1]))result={text:'',metadata:null,complete:false};
      result.metadata=[...body[1].slice(0,2),result.metadata?.[2]??''];
    }
    const candidate=body?.[4]?.[0];
    if(candidate){
      if(candidate[0]&&candidate[0]!==result.metadata?.[2])result.text='';
      if(typeof candidate[1]?.[0]==='string')result.text=candidate[1][0];
      if(candidate[0]&&result.metadata)result.metadata=[...result.metadata.slice(0,2),candidate[0]];
      result.complete=candidate[8]?.[0]===2;
    }
  }
  return result;
}
