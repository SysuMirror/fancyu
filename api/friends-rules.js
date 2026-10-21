'use strict';
const {TYPES,COMMON,MAX}=require('../web/friends-schema');
function weekKey(date=new Date()) {
 const d=new Date(date.getTime()+8*3600000);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return d.toISOString().slice(0,10);
}
function validateCard(input){
 if(!input||!Object.hasOwn(TYPES,input.type))throw Error('请选择有效搭子类别');
 const t=TYPES[input.type],v={};
 for(const f of [t.main,...t.extra,...COMMON.filter(f=>!t.online||!['campus','cross'].includes(f.key))]){
  const x=input.v?.[f.key];
  if(f.text){if(typeof x!=='string'||!x.trim()||x.trim().length>40)throw Error(f.label+'需填写 1–40 字');v[f.key]=x.trim();}
  else if(f.multi){if(!Array.isArray(x)||!x.length||x.length>f.opts.length||new Set(x).size!==x.length||x.some(y=>!f.opts.includes(y))||x.includes('都行')&&x.length>1)throw Error('请检查'+f.label);v[f.key]=x;}
  else{if(!f.opts.includes(x))throw Error('请填写'+f.label);v[f.key]=x;}
 }
 return {type:input.type,v};
}
function overlap(a,b){return a.some(x=>b.includes(x));}
function compatible(a,b){
 if(a.account_id===b.account_id||a.type!==b.type)return false;
 const x=a.v,y=b.v,t=TYPES[a.type];
 if(!overlap(x.time,y.time))return false;
 if((x.gender!=='不限'&&x.gender!==b.gender)||(y.gender!=='不限'&&y.gender!==a.gender))return false;
 if(!t.online&&x.campus!==y.campus&&(x.cross==='只要本校区'||y.cross==='只要本校区'))return false;
 const item=s=>s.normalize('NFKC').toLowerCase().replace(/\s+/g,'');
 if(x.item!=='都行'&&y.item!=='都行'&&item(x.item)!==item(y.item))return false;
 if(a.type==='sport'&&(!x.want.includes('都行')&&!x.want.includes(y.level)||!y.want.includes('都行')&&!y.want.includes(x.level)))return false;
 if(a.type==='game'&&x.mic!=='都行'&&y.mic!=='都行'&&x.mic!==y.mic)return false;
 return true;
}
function score(a,b){
 let n=a.v.time.filter(x=>b.v.time.includes(x)).length*3;
 for(const f of [...TYPES[a.type].extra,{key:'freq'}]){const x=a.v[f.key],y=b.v[f.key];if(Array.isArray(x)&&Array.isArray(y))n+=x.filter(v=>y.includes(v)).length;else if(x===y)n+=2;}
 return n;
}
module.exports={weekKey,validateCard,compatible,score,MAX};
