import test from 'node:test';
import assert from 'node:assert/strict';
import {generation} from './web-protocol.mjs';

const frame=(rid,candidate)=>JSON.stringify([['wrb.fr',null,JSON.stringify([null,['c_abc',rid],null,null,candidate?[candidate]:null])]])+'\n';
const candidate=(id,text,status)=>[id,[text],null,null,null,null,null,null,[status]];

test('generation completion follows the latest candidate, preserving metadata-only trailers',()=>{
  const complete=frame('r_1',candidate('rc_1','answer',2));
  assert.deepEqual(generation(complete+frame('r_1')),{text:'answer',metadata:['c_abc','r_1','rc_1'],complete:true});
  assert.equal(generation(complete+frame('r_1',candidate('rc_1','revised partial',1))).complete,false);
  const replacement=frame('r_1',candidate('rc_2','',1));
  assert.deepEqual(generation(complete+replacement),{text:'',metadata:['c_abc','r_1','rc_2'],complete:false});
  assert.deepEqual(generation(complete+frame('r_2')),{text:'',metadata:['c_abc','r_2',''],complete:false});
});
