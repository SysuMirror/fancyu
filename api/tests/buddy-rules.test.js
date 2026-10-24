'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {score,compatible,validateCard}=require('../friends-rules');
const {TYPES,COMMON}=require('../../web/friends-schema');
test('all seven types have symmetric bounded scores and identical cards rank highest',()=>{
 for(const [type,t]of Object.entries(TYPES)){
  const v={};for(const f of [t.main,...t.extra,...COMMON.filter(f=>!t.online||!['campus','cross'].includes(f.key))])v[f.key]=f.text?'Test game':f.multi?[f.opts[0]]:f.opts[0];
  v.gender='不限';if(type==='sport')v.want=['都行'];
  const a={...validateCard({type,v}),account_id:1,gender:'男生'},b={...structuredClone(a),account_id:2};
  assert.equal(compatible(a,b),true);assert.equal(score(a,b),100);
  b.v.freq='长期固定';assert.ok(score(a,b)<100);assert.equal(score(a,b),score(b,a));assert.ok(score(a,b)>=0);
 }
});
test('hard filters remain mutual; normalized game name is compatible',()=>{
 const a={account_id:1,gender:'男生',type:'game',v:{item:' ＡＢＣ ',level:'一般',mic:'开麦',time:['周末晚上'],gender:'不限',freq:'每周'}};
 const b={...structuredClone(a),account_id:2};b.v.item='abc';assert.ok(compatible(a,b));b.v.mic='不开麦';assert.equal(compatible(a,b),false);b.v.mic='都行';b.v.gender='女生';assert.equal(compatible(a,b),false);
});
