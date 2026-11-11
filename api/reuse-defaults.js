'use strict';
const campuses=['广州南校园','广州东校园','广州北校园','深圳校区','珠海校区'];
const grades={'大一':['本科',1],'大二':['本科',2],'大三':['本科',3],'大四':['本科',4],'大五（医学）':['本科',5],'研一':['硕士',1],'研二':['硕士',2],'研三':['硕士',3]};
const majors={'文学':'人文社科类','历史学':'人文社科类','哲学':'人文社科类','法学':'人文社科类','教育学':'人文社科类','经济学':'经济管理类','管理学':'经济管理类','理学':'理学类','工学':'工学类','医学':'医学类','艺术学':'艺术体育类'};
function defaults(mode,l,d,buddy){
 const out={}, ownSex=x=>['男','女'].includes(x)?x:undefined;
 const buddySex=({'男生':'男','女生':'女'})[buddy];
 if(mode==='love'){
  out['1']=ownSex(d.sex)||buddySex;
  const grade=grades[d.grade];
  if(grade)out['5']={degree:grade[0],year:grade[1]};
  if(d.grade==='博士')out['5']={degree:'博士'};
  if(campuses.includes(d.own_campus))out['7']=d.own_campus;
 }else if(mode==='deep'){
  out.sex=ownSex(l['1'])||buddySex;
  const g=l['5'];
  if(g?.degree==='博士')out.grade='博士';
  else if(g)out.grade=Object.keys(grades).find(k=>k!=='大五（医学）'&&grades[k][0]===g.degree&&grades[k][1]===g.year);
  if(campuses.includes(l['7']))out.own_campus=l['7'];
  out.major=majors[String(l['9']||'').split(' · ')[0]];
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
