(function(root){
'use strict';
const schemaOf=x=>x||(typeof module==='object'&&module.exports?require('./weekly-schema'):root.WeeklySchema);
function validate(body,now=new Date(),override){
 const schema=schemaOf(override);const campuses=schema.questions.find(q=>q.id==='7').options;
 const source=body?.answers;if(!source||typeof source!=='object'||Array.isArray(source))failWith(null,'请填写问卷');
 const answers={school:'中山大学'};
 const failWith=(id,message)=>{const e=Error(message);e.fields=[{id,message}];throw e;};
 const fail=q=>{failWith(q.id,'请检查第 '+q.id+' 题：'+q.title);};
 const text=(x,max)=>typeof x==='string'&&x.trim().length>0&&[...x.trim()].length<=max;
 const number=(x,min,max)=>Number.isInteger(x)&&x>=min&&x<=max;
 const active=source['12']===schema.longTerm;
 for(const q of schema.questions){if(q.conditional&&!active)continue;let v=source[q.id];
  if(q.optional&&(v===undefined||v===null||v===''))continue;
  if(q.type==='radio'||q.type==='scale'){if(!q.options.includes(v))fail(q);}
  if(q.type==='multi'){if(!Array.isArray(v)||new Set(v).size!==v.length||v.length<q.min||v.length>q.max||v.some(x=>!q.options.includes(x)))fail(q);
   if(q.id==='6'&&v.includes('没有特殊要求')&&v.length!==1)fail(q);
   if(q.id==='26'&&v.includes('无')&&v.length!==1)fail(q);
   if(q.id==='47'&&v.includes('对运动完全不感兴趣')&&v.some(x=>x!=='对运动完全不感兴趣'&&q.optionGroups[x]==='一起动起来'))fail(q);
  }
  if(q.type==='month'){if(typeof v!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(v))fail(q);const today=new Date(now.getTime()+28800000).toISOString().slice(0,7);const age=Number(today.slice(0,4))-Number(v.slice(0,4))-(today.slice(5)<v.slice(5)?1:0);if(age<18||age>100)failWith('3','第 3 题：仅限年满 18 岁参与，请检查出生年月');}
  if(q.type==='age'){if(!v||typeof v.unlimited!=='boolean')fail(q);v=v.unlimited?{unlimited:true}:{unlimited:false,older:v.older,younger:v.younger};if(!v.unlimited&&(!number(v.older,0,82)||!number(v.younger,0,82)))fail(q);}
  if(q.type==='education'){if(!v||!['本科','硕士','博士'].includes(v.degree)||!number(v.year,1,10))fail(q);v={degree:v.degree,year:v.year};}
  if(q.type==='college'){if(!text(v,80))fail(q);v=v.trim();}
  if(q.type==='number'&&!number(v,100,250))fail(q);
  if(q.type==='height'){if(!v||!number(v.min,100,250)||!number(v.max,100,250)||v.min>v.max)fail(q);v={min:v.min,max:v.max};}
  if(q.type==='hometown'){if(!v||!text(v.province,30)||!text(v.city,40))fail(q);v={province:v.province.trim(),city:v.city.trim()};}
  if(q.type==='text'){if(typeof v!=='string'||[...v.trim()].length>50)fail(q);v=v.trim();}
  answers[q.id]=v;
 }
 if(answers['26']?.includes('其他')){if(!text(source.diet_other,80))failWith('26','请补充第 26 题的其他饮食限制');answers.diet_other=source.diet_other.trim();}
 const stars=body.important;if(!Array.isArray(stars)||stars.length>5||new Set(stars).size!==stars.length)failWith(null,'最多可将 5 道题设为重要');
 const allowed=new Set(schema.questions.filter(q=>q.important&&(!q.conditional||active)).map(q=>q.group));
 const important=stars.filter(x=>!['15','16'].includes(x)&&(!['13','18'].includes(x)||active));
 if(important.some(x=>typeof x!=='string'||!allowed.has(x)))failWith(null,'包含不能设为重要的题目');
 const scales=schema.questions.filter(q=>q.type==='scale'&&Number.isInteger(answers[q.id])).map(q=>answers[q.id]);
 const uniform=scales.length>0&&Math.max(...[1,2,3,4,5,6,7].map(n=>scales.filter(x=>x===n).length))/scales.length>=.9;
 return {version:schema.version,answers,important,uniform};
}
if(typeof module==='object'&&module.exports)module.exports={validate};else root.WeeklyValidation={validate};
})(typeof window==='object'?window:globalThis);
