'use strict';
const campuses=['广州南校园','广州东校园','广州北校园','深圳校区','珠海校区'];
const grades={'大一':['本科',1],'大二':['本科',2],'大三':['本科',3],'大四':['本科',4],'大五（医学）':['本科',5],'研一':['硕士',1],'研二':['硕士',2],'研三':['硕士',3]};
const academic=require('../web/academic-fields');
// 家乡地区：两份问卷都用省份名，恋爱问卷多一个「海外」，交友问卷多一个「国外」，互不换算
const provinces=new Set('北京 天津 上海 重庆 河北 山西 辽宁 吉林 黑龙江 江苏 浙江 安徽 福建 江西 山东 河南 湖北 湖南 广东 海南 四川 贵州 云南 陕西 甘肃 青海 内蒙古 广西 西藏 宁夏 新疆 香港 澳门 台湾'.split(' '));
const deepProvinces=new Set([...provinces,'国外']);
// 兴趣：交友问卷按「大类」勾选，恋爱问卷第 47 题是固定选项，只能按语义近似换算
const deepToLoveInterests={
 '球类运动':'羽毛球 / 网球','田径类运动':'跑步','棋类':'桌游','健身健美':'健身',
 '乐器':'乐器 / 音乐创作','书法':'画画 / 手作','绘画':'画画 / 手作','阅读':'阅读',
 '摄影':'摄影','电影':'电影 / 剧集','纪录片':'电影 / 剧集','电视剧':'电影 / 剧集',
 '娱乐圈':'综艺','舞蹈':'跳舞','美食(吃）':'探店美食','烹饪':'做饭 / 烘焙',
 '手游':'电竞 / 网游','端游':'电竞 / 网游','主机':'主机 / 单机游戏','桌游':'桌游',
 '旅游':'短途旅行','ACG':'动漫','手工':'画画 / 手作','博客':'播客'
};
const loveToDeepInterests={
 '跑步':'田径类运动','健身':'健身健美','羽毛球 / 网球':'球类运动','篮球 / 足球':'球类运动',
 '游泳':'其他运动','骑行':'其他运动','爬山徒步':'其他运动','飞盘 / 滑板':'其他运动',
 '跳舞':'舞蹈','探店美食':'美食(吃）','城市漫步':'旅游','看展 / 逛博物馆':'娱乐活动',
 '演唱会 / Livehouse':'音乐','短途旅行':'旅游','露营':'旅游','剧本杀 / 密室':'娱乐活动',
 '桌游':'桌游','唱K':'音乐','阅读':'阅读','写作':'博客','画画 / 手作':'绘画','摄影':'摄影',
 '乐器 / 音乐创作':'乐器','做饭 / 烘焙':'烹饪','咖啡 / 茶':'美食(吃）','电影 / 剧集':'电影',
 '动漫':'ACG','主机 / 单机游戏':'主机','电竞 / 网游':'端游','综艺':'娱乐圈','播客':'博客',
 '历史 / 社科':'阅读','自然科学':'阅读'
};
// 交友兴趣（含细分项）→ 恋爱第 47 题选项，最多 6 项
function loveInterests(list){
 if(!Array.isArray(list))return [];
 const out=[];
 for(const x of list){
  const category=x&&x.category;if(!category)continue;
  let value=deepToLoveInterests[category];
  if(category==='球类运动'){
   const subs=(x.subcategories||[]).join(' ');
   if(/篮|足/.test(subs))value='篮球 / 足球';
   else if(/羽|网|乒乓/.test(subs))value='羽毛球 / 网球';
  }
  if(value&&!out.includes(value))out.push(value);
  if(out.length>=6)break;
 }
 return out;
}
// 恋爱第 47 题选项 → 交友兴趣大类，最多 3 项（交友问卷上限）
function deepInterests(list){
 if(!Array.isArray(list))return [];
 const out=[];
 for(const value of list){
  const category=loveToDeepInterests[value];
  if(category&&!out.some(x=>x.category===category))out.push({category,subcategories:[],skillLevel:'',skillLevelExpect:['没要求'],frequency:''});
  if(out.length>=3)break;
 }
 return out;
}
// 交友问卷 sex_prefer（男/女/不限）→ 恋爱第 2 题（男/女 多选）
function sexPreferToLove(value){
 if(!Array.isArray(value)||!value.length)return null;
 if(value.includes('不限'))return ['男','女'];
 const picked=value.filter(x=>x==='男'||x==='女');
 return picked.length?picked:null;
}
// 恋爱第 2 题 → 交友问卷 sex_prefer
function loveToSexPrefer(value){
 if(!Array.isArray(value)||!value.length)return null;
 const picked=value.filter(x=>x==='男'||x==='女');
 return picked.length?picked:null;
}
function defaults(mode,l,d,buddy){
 const out={},ownSex=x=>['男','女'].includes(x)?x:undefined;
 const buddySex=({'男生':'男','女生':'女'})[buddy];
 if(mode==='love'){
  if(academic.categories.includes(d.major_category)&&d.major_detail)out['9']=d.major_category+' · '+d.major_detail;
  out['1']=ownSex(d.sex)||buddySex;
  const grade=grades[d.grade];
  if(grade)out['5']={degree:grade[0],year:grade[1]};
  if(d.grade==='博士')out['5']={degree:'博士'};
  if(campuses.includes(d.own_campus))out['7']=d.own_campus;
  const sexPrefer=sexPreferToLove(d.sex_prefer);
  if(sexPrefer)out['2']=sexPrefer;
  if(provinces.has(d.hometown))out['11']={province:d.hometown,city:''};
  const wantCampuses=(d.expect_school_campuses&&d.expect_school_campuses['中山大学']||[]).filter(x=>campuses.includes(x));
  if(wantCampuses.length)out['8']=[...new Set(wantCampuses)];
  const interests=loveInterests(d.interests);
  if(interests.length)out['47']=interests;
 }else if(mode==='deep'){
  out.sex=ownSex(l['1'])||buddySex;
  const g=l['5'];
  if(g?.degree==='博士')out.grade='博士';
  else if(g)out.grade=Object.keys(grades).find(k=>k!=='大五（医学）'&&grades[k][0]===g.degree&&grades[k][1]===g.year);
  if(campuses.includes(l['7']))out.own_campus=l['7'];
  const profile=academic.unpack(l['9']);
  if(profile.major_detail)Object.assign(out,profile);
  out.school=academic.school;
  const sexPrefer=loveToSexPrefer(l['2']);
  if(sexPrefer)out.sex_prefer=sexPrefer;
  const province=l['11']?.province;
  if(typeof province==='string'&&deepProvinces.has(province.trim()))out.hometown=province.trim();
  const wantCampuses=(Array.isArray(l['8'])?l['8']:[]).filter(x=>campuses.includes(x));
  if(wantCampuses.length){out.expect_schools=['中山大学'];out.expect_school_campuses={'中山大学':[...new Set(wantCampuses)]};}
  const interests=deepInterests(l['47']);
  if(interests.length)out.interests=interests;
 }else{
  const sex=ownSex(d.sex)||ownSex(l['1']);
  if(!buddy&&sex)out.gender=sex+'生';
  const campus=[d.own_campus,l['7']].find(x=>campuses.includes(x));
  if(campus)out.campus=campus.replace('校园','校');
 }
 return out;
}
async function forAccount(c,id,mode){
 try{
  const [[row]]=await c.execute('SELECT w.answers love,d.data deep,s.gender buddy FROM accounts a LEFT JOIN weekly_questionnaires w ON w.account_id=a.id LEFT JOIN deep_surveys d ON d.account_id=a.id LEFT JOIN friend_card_settings s ON s.account_id=a.id WHERE a.id=?',[id]);
  const parse=x=>(typeof x==='string'?JSON.parse(x):x)||{};
  return defaults(mode,parse(row?.love),parse(row?.deep),row?.buddy);
 }catch(e){console.warn('Survey prefill unavailable',e.code||e.name);return {};}
}
module.exports={defaults,forAccount};
