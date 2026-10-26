'use strict';
const {schools,categories}=require('./deep-options.json');
const GRADES=['大一','大二','大三','大四','大五（医学）','研0','研一','研二','研三','博士'];
const MAJORS=['人文社科类','经济管理类','理学类','工学类','医学类','艺术体育类','其他'];
const GOALS=['学习搭子','饭搭子','运动搭子','游戏搭子','聊天搭子','综合交友'];
const LEVELS=['完全小白','云玩家','入门','一般般','精通'],FREQ=['每日','每周','每月','每学期','没要求'];
const DISPLAY=['基础背景','个人特质','兴趣爱好','自我介绍','照片'];
function validate(d){
 if(!d||typeof d!=='object'||Array.isArray(d))throw Error('问卷格式无效');const out={};
 const select=(k,opts,required=false)=>{const v=d[k];if(v==null||v===''){if(required)throw Error('请填写 '+k);return;}if(!opts.includes(v))throw Error('请检查 '+k);out[k]=v;};
 const list=(k,opts,defaults=[])=>{const v=d[k]??defaults;if(!Array.isArray(v)||v.length>opts.length||new Set(v).size!==v.length||v.some(x=>!opts.includes(x)))throw Error('请检查 '+k);out[k]=v.includes('不限')?['不限']:v;};
 const text=(k,max)=>{if(d[k]==null)return;if(typeof d[k]!=='string'||d[k].length>max)throw Error('请检查 '+k);out[k]=d[k].trim();};
 select('sex',['男','女'],true);select('grade',GRADES,true);select('major',MAJORS);select('school',Object.keys(schools),true);select('own_campus',schools[out.school]);
 list('sex_prefer',['男','女','不限']);list('grade_prefer',[...GRADES,'不限']);list('major_prefer',[...MAJORS,'不限']);
 select('expect_quick',['不限','广州所有校区','大学城所有校区']);list('expect_schools',Object.keys(schools));out.expect_school_campuses={};
 const m=d.expect_school_campuses||{};if(typeof m!=='object'||Array.isArray(m))throw Error('校区要求格式无效');
 for(const name of out.expect_schools){const values=m[name]||[];if(!Array.isArray(values)||values.length>schools[name].length||values.some(x=>!schools[name].includes(x)))throw Error('请检查期望校区');out.expect_school_campuses[name]=[...new Set(values)];}
 select('online_offline',['线上为主','线下为主','都行']);select('friend_goal',GOALS,true);select('mbti',['不确定',...['I','E'].flatMap(a=>['N','S'].flatMap(b=>['T','F'].flatMap(c=>['J','P'].map(e=>a+b+c+e))))]);
 for(let i=1;i<=6;i++){for(const side of ['self','expect']){const k=`personality_${side}_${i}`;if(d[k]!=null){if(!Number.isInteger(d[k])||d[k]<1||d[k]>5)throw Error('性格评分必须为 1–5');out[k]=d[k];}}const k=`personality_expect_${i}_no_pref`;if(d[k]!=null&&typeof d[k]!=='boolean')throw Error('请检查性格偏好');out[k]=d[k]===true;}
 out.interests=[];if(d.interests!=null){if(!Array.isArray(d.interests)||d.interests.length>3)throw Error('最多填写三个兴趣');for(const x of d.interests){if(!categories.includes(x.category)||out.interests.some(y=>y.category===x.category))throw Error('兴趣类别无效或重复');const subs=x.subcategories||[];if(!Array.isArray(subs)||subs.length>3||subs.some(s=>typeof s!=='string'||!s.trim()||s.length>40))throw Error('每个兴趣最多三个细分项，每项不超过40字');if(x.skillLevel&&!LEVELS.includes(x.skillLevel)||x.frequency&&!FREQ.includes(x.frequency))throw Error('请检查兴趣熟练度和频率');const want=x.skillLevelExpect||[];if(!Array.isArray(want)||want.length>6||want.some(v=>![...LEVELS,'没要求'].includes(v)))throw Error('请检查期望熟练度');out.interests.push({category:x.category,subcategories:[...new Set(subs.map(s=>s.trim()))],skillLevel:x.skillLevel||'',skillLevelExpect:want.includes('没要求')?['没要求']:[...new Set(want)],frequency:x.frequency||''});}}
 for(const k of ['self_description','ideal_friend','special_request'])text(k,1000);text('hometown',40);list('display_self',DISPLAY);
 const photos=d.photos||[];if(!Array.isArray(photos)||photos.length>6||photos.some(p=>typeof p!=='string'||p.length>500000||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p)))throw Error('请上传最多6张有效图片');out.photos=photos;
 const contacts=d.contact_entries||[];if(!Array.isArray(contacts)||contacts.length>5||contacts.some(x=>!['微信','QQ','小红书','邮箱','其他'].includes(x.method)||typeof x.value!=='string'||!x.value.trim()||x.value.length>100))throw Error('请检查联系方式');out.contact_entries=contacts.map(x=>({method:x.method,value:x.value.trim()}));
 return out;
}
const permits=(arr,v)=>!arr.length||arr.includes('不限')||arr.includes(v);
function locationAllows(a,b){if(a.expect_quick==='不限')return true;const explicit=a.expect_schools.includes(b.school)&&(!a.expect_school_campuses[b.school]?.length||a.expect_school_campuses[b.school].includes(b.own_campus));const quick=a.expect_quick==='广州所有校区'?b.own_campus?.startsWith('广州'):a.expect_quick==='大学城所有校区'?b.own_campus?.includes('大学城'):false;return !a.expect_quick&&!a.expect_schools.length||!!explicit||!!quick;}
function directional(a,b){
 let total=0,weight=0;const add=(v,w)=>{if(v!=null){total+=v*w;weight+=w;}};
 if(a.interests.length&&b.interests.length){let n=0,den=0;a.interests.forEach((x,i)=>{const rank=3-i,y=b.interests.find(z=>z.category===x.category);den+=rank;if(!y)return;let v=.5;if(x.subcategories.length&&y.subcategories.length)v+=.25*x.subcategories.filter(z=>y.subcategories.includes(z)).length/new Set([...x.subcategories,...y.subcategories]).size;else v+=.125;if(!x.skillLevelExpect.length||x.skillLevelExpect.includes('没要求'))v+=.125;else if(y.skillLevel&&x.skillLevelExpect.includes(y.skillLevel))v+=.125;if(x.frequency&&y.frequency){v+=.125*(x.frequency==='没要求'||y.frequency==='没要求'?1:1-Math.abs(FREQ.indexOf(x.frequency)-FREQ.indexOf(y.frequency))/3);}n+=rank*v;});add(n/den,45);}
 const traits=[];for(let i=1;i<=6;i++)if(!a[`personality_expect_${i}_no_pref`]&&a[`personality_expect_${i}`]!=null&&b[`personality_self_${i}`]!=null)traits.push(1-Math.abs(a[`personality_expect_${i}`]-b[`personality_self_${i}`])/4);if(traits.length)add(traits.reduce((a,b)=>a+b,0)/traits.length,35);
 add(a.friend_goal===b.friend_goal?1:a.friend_goal==='综合交友'||b.friend_goal==='综合交友'?.7:.2,10);
 if(a.online_offline&&b.online_offline)add(a.online_offline===b.online_offline?1:a.online_offline==='都行'||b.online_offline==='都行'?.8:0,10);
 return {score:weight?100*total/weight:0,coverage:weight};
}
function evaluate(a,b){for(const [x,y]of [[a,b],[b,a]])if(!permits(x.sex_prefer,y.sex)||!permits(x.grade_prefer,y.grade)||!permits(x.major_prefer,y.major)||!locationAllows(x,y))return null;
 const ab=directional(a,b),ba=directional(b,a);return {score:Math.round((ab.score+ba.score)/2),ab:Math.round(ab.score),ba:Math.round(ba.score),coverage:[ab.coverage,ba.coverage]};
}
function publicData(a){const show=new Set(a.display_self.length?a.display_self:DISPLAY),r={};if(show.has('基础背景'))for(const k of ['sex','school','own_campus','grade','major','hometown'])r[k]=a[k];if(show.has('个人特质'))r.mbti=a.mbti;if(show.has('兴趣爱好'))r.interests=a.interests.map(x=>({category:x.category,subcategories:x.subcategories}));if(show.has('自我介绍'))r.bio=a.self_description||'';if(show.has('照片'))r.photos=a.photos;return r;}
module.exports={validate,evaluate,publicData};
