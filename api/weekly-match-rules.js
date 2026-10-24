'use strict';
const schema=require('../web/weekly-schema');
const {validate}=require('./weekly-validation');
const VERSION='weekly-love-v1';
const WEIGHTS={'12':4,'13':2,'17':3,'18':3,'19':2,'20':2,'21':2,'22':1,'23':2,'24':2,'25':.5,'28':2,'29':1,'30':.5,'31':2,'32':4,'33':3,'40':3,'41':3,'42':2,'43':1,'44':2,'45':2,'46':2,'47':3,'48':1};
const OPTIONS=Object.fromEntries(schema.questions.map(q=>[q.id,q.options]));
const ordinal=(id,a,b)=>1-Math.abs(OPTIONS[id].indexOf(a)-OPTIONS[id].indexOf(b))/(OPTIONS[id].length-1);
const similar=(a,b)=>1-Math.abs(a-b)/6;
const intersection=(a,b)=>a.filter(x=>b.includes(x));
const overlap=(a,b)=>intersection(a,b).length/new Set([...a,...b]).size;
function age(birth,now){const ym=new Date(now.getTime()+28800000).toISOString().slice(0,7);return Number(ym.slice(0,4))-Number(birth.slice(0,4))-(ym.slice(5)<birth.slice(5)?1:0);}
function batchTimes(key){if(typeof key!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(key))throw Error('批次日期无效');const monday=new Date(key+'T00:00:00+08:00');if(isNaN(monday)||new Date(monday.getTime()+28800000).toISOString().slice(0,10)!==key||new Date(monday.getTime()+28800000).getUTCDay()!==1)throw Error('批次必须是周一日期');return {key,cutoff:new Date(+monday+2*86400000+20*3600000),release:new Date(+monday+3*86400000+20*3600000),expires:new Date(+monday+6*86400000+20*3600000)};}
function openBatch(now=new Date()){const bj=new Date(+now+28800000);bj.setUTCDate(bj.getUTCDate()-(bj.getUTCDay()+6)%7);let b=batchTimes(bj.toISOString().slice(0,10));if(now>=b.cutoff){bj.setUTCDate(bj.getUTCDate()+7);b=batchTimes(bj.toISOString().slice(0,10));}return b;}
function hard(a,b,now){
 const accepts=(x,y)=>{
  if(!x['2'].includes(y['1']))return false;const ax=age(x['3'],now),ay=age(y['3'],now),pref=x['4'];
  if(ax<18||ay<18||!pref.unlimited&&(ay>ax+pref.older||ay<ax-pref.younger))return false;
  if(!x['6'].includes('没有特殊要求')&&!x['6'].includes(y['5'].degree))return false;
  if(!x['8'].includes(y['7']))return false;
  if(x['10b']&&(y['10a']===undefined||y['10a']<x['10b'].min||y['10a']>x['10b'].max))return false;
  const smoke=OPTIONS['27a'].indexOf(y['27a']),accept=OPTIONS['27b'].indexOf(x['27b']);if(smoke>accept)return false;
  if(x['29a']==='是'&&y['29b']===OPTIONS['29b'][0])return false;
  return true;
 };
 const goals=[OPTIONS['12'].indexOf(a['12']),OPTIONS['12'].indexOf(b['12'])];
 return !(goals.includes(0)&&goals.includes(2))&&accepts(a,b)&&accepts(b,a);
}
function directional(a,b,stars){const values={};
 for(const id of ['19','20','22','25','40','41','44','45','46'])values[id]=similar(a[id],b[id]);
 for(const id of ['18','23','30','32','33'])values[id]=ordinal(id,a[id],b[id]);
 values['12']=a['12']===b['12']?1:([a['12'],b['12']].includes(schema.longTerm)?.5:.7);
 if(a['13']!==undefined&&b['13']!==undefined){const x=a['13'],y=b['13'];values['13']=x==='还没想好'||y==='还没想好'?.5:x!==y?.3:x===OPTIONS['13'][2]&&a['11'].province!==b['11'].province?.3:1;}
 for(const id of ['17','42'])if(a[id+'b']!=='没有要求')values[id]=similar(a[id+'b'],b[id+'a']);
 values['21']=a['21']===b['21']?1:.5;
 values['24']=b['24a']>=a['24a']?1:1-(a['24a']-b['24a'])/6*(7-a['24b'])/6;
 values['28']=[[1,.2,0],[1,1,.3],[1,1,1]][OPTIONS['28b'].indexOf(a['28b'])][OPTIONS['28a'].indexOf(b['28a'])];
 values['29']=ordinal('29b',a['29b'],b['29b']);values['31']=overlap(a['31'],b['31']);
 const x=OPTIONS['43'].indexOf(a['43']),y=OPTIONS['43'].indexOf(b['43']);values['43']=x===1||y===1||x!==y?1:x===0?.9:.7;
 values['47']=overlap(a['47'],b['47']);values['48']=intersection(a['48b'],b['48a']).length/3;
 let sum=0,den=0;for(const [id,s]of Object.entries(values)){const w=WEIGHTS[id]*(stars.includes(id)?2:1);sum+=w*s;den+=w;}
 return {score:100*sum/den,coverage:Object.keys(values).length};
}
function evaluate(left,right,now=new Date()){
 const a=validate(left,now),b=validate(right,now);if(!hard(a.answers,b.answers,now))return null;
 const ab=directional(a.answers,b.answers,a.important),ba=directional(b.answers,a.answers,b.important),mean=(ab.score+ba.score)/2;
 const common=intersection(a.answers['47'],b.answers['47']).filter(x=>x!=='对运动完全不感兴趣');
 const reasons=[];if(common.length)reasons.push('共同兴趣：'+common.slice(0,3).join('、'));if(a.answers['7']===b.answers['7'])reasons.push('都在'+a.answers['7']);const weekend=intersection(a.answers['31'],b.answers['31']);if(weekend.length)reasons.push('周末都喜欢：'+weekend[0]);
 return {ab:ab.score,ba:ba.score,score:mean,scoreInt:Math.round(mean*100),preferred:ab.score>=60&&ba.score>=60&&mean>=65,coverage:[ab.coverage,ba.coverage],reasons:reasons.slice(0,3)};
}
module.exports={VERSION,WEIGHTS,evaluate,hard,directional,age,batchTimes,openBatch};
