'use strict';
const store=require('./survey-schema');
const campusAliases={"广州海珠南校": "广州南校园", "广州越秀北校": "广州北校园", "广州天河东校": "广州东校园"};
const academic=require('../web/academic-fields');
// 选项列表全部来自后台 schema（/admin/survey 深度交友问卷 Tab）。
const S=()=>store.current('deep');
const items=()=>{const m={};for(const cards of S().cards)for(const c of cards)for(const it of c.items)m[it.key]=it;return m;};
const vals=it=>(it.groups?Object.values(it.groups).flat():it.options||[]).map(v=>typeof v==='object'?v.value:v);
// 这些 key 有专门的结构化校验，其余 options/tags/select 字段走通用校验。
const SPECIAL=new Set(['sex','grade','school','own_campus','sex_prefer','grade_prefer','major_category','major_detail','major_prefer','expect_quick','expect_schools','expect_school_campuses','online_offline','friend_goal','mbti','personality','interests','self_description','ideal_friend','special_request','hometown','photos','display_self','contact_entries']);
function validate(d){
 if(!d||typeof d!=='object'||Array.isArray(d))throw Error('问卷格式无效');const s=S(),IT=items();const {schools}=s;const LEVELS=s.interests.skillLevels,FREQ=s.interests.freq,GRADES=vals(IT.grade),MAJORS=vals(IT.major_prefer).filter(v=>v!=='不限'),GOALS=vals(IT.friend_goal),DISPLAY=vals(IT.display_self),METHODS=s.contacts.methods;
 d={...d,own_campus:campusAliases[d.own_campus]||d.own_campus,expect_school_campuses:Object.fromEntries(Object.entries(d.expect_school_campuses||{}).map(([k,v])=>[k,Array.isArray(v)?v.map(x=>campusAliases[x]||x):v]))};const out={};
 const select=(k,opts,required=false)=>{const v=d[k];if(v==null||v===''){if(required)throw Error('请填写 '+k);return;}if(!opts.includes(v))throw Error('请检查 '+k);out[k]=v;};
 const list=(k,opts,defaults=[])=>{const v=d[k]??defaults;if(!Array.isArray(v)||v.length>opts.length||new Set(v).size!==v.length||v.some(x=>!opts.includes(x)))throw Error('请检查 '+k);out[k]=v.includes('不限')?['不限']:v;};
 const text=(k,max)=>{if(d[k]==null)return;if(typeof d[k]!=='string'||d[k].length>max)throw Error('请检查 '+k);out[k]=d[k].trim();};
 select('sex',vals(IT.sex),true);select('grade',GRADES,true);select('major_category',academic.categories);text('major_detail',IT.major_detail?.max||60);
 if(out.major_category)out.major=academic.groups[out.major_category];else select('major',MAJORS);
 select('school',Object.keys(schools),true);select('own_campus',schools[out.school]);
 list('sex_prefer',vals(IT.sex_prefer));list('grade_prefer',[...GRADES,'不限']);list('major_prefer',[...MAJORS,'不限']);
 select('expect_quick',['不限','广州所有校区','大学城所有校区']);list('expect_schools',Object.keys(schools));out.expect_school_campuses={};
 const m=d.expect_school_campuses||{};if(typeof m!=='object'||Array.isArray(m))throw Error('校区要求格式无效');
 for(const name of out.expect_schools){const values=m[name]||[];if(!Array.isArray(values)||values.length>schools[name].length||values.some(x=>!schools[name].includes(x)))throw Error('请检查期望校区');out.expect_school_campuses[name]=[...new Set(values)];}
 select('online_offline',vals(IT.online_offline));select('friend_goal',GOALS,true);select('mbti',vals(IT.mbti));
 for(let i=1;i<=s.personality.length;i++){for(const side of ['self','expect']){const k=`personality_${side}_${i}`;if(d[k]!=null){if(!Number.isInteger(d[k])||d[k]<1||d[k]>5)throw Error('性格评分必须为 1–5');out[k]=d[k];}}const k=`personality_expect_${i}_no_pref`;if(d[k]!=null&&typeof d[k]!=='boolean')throw Error('请检查性格偏好');out[k]=d[k]===true;}
 out.interests=[];const cats=s.interests.categories;if(d.interests!=null){if(!Array.isArray(d.interests)||d.interests.length>3)throw Error('最多填写三个兴趣');for(const x of d.interests){if(!cats.includes(x.category)||out.interests.some(y=>y.category===x.category))throw Error('兴趣类别无效或重复');const subs=x.subcategories||[];if(!Array.isArray(subs)||subs.length>3||subs.some(v=>typeof v!=='string'||!v.trim()||v.length>40))throw Error('每个兴趣最多三个细分项，每项不超过40字');if(x.skillLevel&&!LEVELS.includes(x.skillLevel)||x.frequency&&!FREQ.includes(x.frequency))throw Error('请检查兴趣熟练度和频率');const want=x.skillLevelExpect||[];if(!Array.isArray(want)||want.length>6||want.some(v=>![...LEVELS,'没要求'].includes(v)))throw Error('请检查期望熟练度');out.interests.push({category:x.category,subcategories:[...new Set(subs.map(v=>v.trim()))],skillLevel:x.skillLevel||'',skillLevelExpect:want.includes('没要求')?['没要求']:[...new Set(want)],frequency:x.frequency||''});}}
 for(const k of ['self_description','ideal_friend','special_request'])text(k,1000);text('hometown',40);list('display_self',DISPLAY);
 const photos=d.photos||[];if(!Array.isArray(photos)||photos.length>s.photos.max||photos.some(p=>typeof p!=='string'||p.length>500000||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p)))throw Error('请上传最多'+s.photos.max+'张有效图片');out.photos=photos;
 const contacts=d.contact_entries||[];if(!Array.isArray(contacts)||contacts.length>5||contacts.some(x=>!METHODS.includes(x.method)||typeof x.value!=='string'||!x.value.trim()||x.value.length>100))throw Error('请检查联系方式');out.contact_entries=contacts.map(x=>({method:x.method,value:x.value.trim()}));
 // 后台新增的普通字段（options/tags/select）通用校验：值必须在选项内。
 for(const cards of s.cards)for(const c of cards)for(const it of c.items){
  if(SPECIAL.has(it.key)||out[it.key]!==undefined)continue;
  const opts=vals(it);
  if(it.type==='options'){select(it.key,opts,false);}
  else if(it.type==='tags'){list(it.key,opts);}
  else if(it.type==='select'){select(it.key,opts,false);}
 }
 return out;
}
const permits=(arr,v)=>!arr.length||arr.includes('不限')||arr.includes(v);
function locationAllows(a,b){if(a.expect_quick==='不限')return true;const explicit=a.expect_schools.includes(b.school)&&(!a.expect_school_campuses[b.school]?.length||a.expect_school_campuses[b.school].includes(b.own_campus));const quick=a.expect_quick==='广州所有校区'?b.own_campus?.startsWith('广州'):a.expect_quick==='大学城所有校区'?(b.own_campus?.includes('大学城')||(b.school==='中山大学'&&b.own_campus==='广州东校园')):false;return !a.expect_quick&&!a.expect_schools.length||!!explicit||!!quick;}
function directional(a,b){
 const FREQ=S().interests.freq;
 let total=0,weight=0;const add=(v,w)=>{if(v!=null){total+=v*w;weight+=w;}};
 if(a.interests.length&&b.interests.length){let n=0,den=0;a.interests.forEach((x,i)=>{const rank=3-i,y=b.interests.find(z=>z.category===x.category);den+=rank;if(!y)return;let v=.5;if(x.subcategories.length&&y.subcategories.length)v+=.25*x.subcategories.filter(z=>y.subcategories.includes(z)).length/new Set([...x.subcategories,...y.subcategories]).size;else v+=.125;if(!x.skillLevelExpect.length||x.skillLevelExpect.includes('没要求'))v+=.125;else if(y.skillLevel&&x.skillLevelExpect.includes(y.skillLevel))v+=.125;if(x.frequency&&y.frequency){v+=.125*(x.frequency==='没要求'||y.frequency==='没要求'?1:1-Math.abs(FREQ.indexOf(x.frequency)-FREQ.indexOf(y.frequency))/3);}n+=rank*v;});add(n/den,35);}
 const traits=[];const dims=S().personality.length;for(let i=1;i<=dims;i++)if(!a[`personality_expect_${i}_no_pref`]&&a[`personality_expect_${i}`]!=null&&b[`personality_self_${i}`]!=null)traits.push(1-Math.abs(a[`personality_expect_${i}`]-b[`personality_self_${i}`])/4);if(traits.length)add(traits.reduce((x,y)=>x+y,0)/traits.length,25);
 add(a.friend_goal===b.friend_goal?1:a.friend_goal==='综合交友'||b.friend_goal==='综合交友'?.7:.2,10);
 if(a.online_offline&&b.online_offline)add(a.online_offline===b.online_offline?1:a.online_offline==='都行'||b.online_offline==='都行'?.8:0,10);
 for(const [pref,actual] of [['grade_prefer','grade'],['major_prefer','major']])if(a[pref].length&&!a[pref].includes('不限')&&b[actual])add(a[pref].includes(b[actual])?1:0,10);
 return {score:weight?100*total/weight:0,coverage:weight};
}
function evaluate(a,b){for(const [x,y] of [[a,b],[b,a]])if(!permits(x.sex_prefer,y.sex)||!locationAllows(x,y))return null;
 const ab=directional(a,b),ba=directional(b,a);return {score:Math.round((ab.score+ba.score)/2),ab:Math.round(ab.score),ba:Math.round(ba.score),coverage:[ab.coverage,ba.coverage]};
}
function publicData(a){const show=new Set(a.display_self.length?a.display_self:DISPLAY()),r={};if(show.has('基础背景'))for(const k of ['sex','school','own_campus','grade','major','hometown'])r[k]=a[k];if(show.has('个人特质'))r.mbti=a.mbti;if(show.has('兴趣爱好'))r.interests=a.interests.map(x=>({category:x.category,subcategories:x.subcategories}));if(show.has('自我介绍'))r.bio=a.self_description||'';if(show.has('照片'))r.photos=a.photos;return r;}
module.exports={validate,evaluate,publicData};
