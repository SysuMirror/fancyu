'use strict';
// Only identifiers, dates and counters belong here. Never record questionnaire or message content.
const fs=require('fs'),path=require('path');
const ready=new WeakMap();
const MODES=['love','deep','buddy'];
const DAY=86400000;
const stamp=d=>new Date(d).toISOString().slice(0,23).replace('T',' ');
const time=x=>x instanceof Date?+x:Date.parse(String(x).replace(' ','T')+(/Z$|[+]\d\d:\d\d$/.test(String(x))?'':'Z'));
const nextWeek=k=>new Date(Date.parse(k+'T00:00:00Z')+7*DAY).toISOString().slice(0,10);
const ratio=(n,d,waiting=0)=>({numerator:n,denominator:d,rate:d?Math.round(n/d*1000)/10:null,waiting});
async function ensureSchema(p){
 if(!ready.has(p))ready.set(p,(async()=>{for(const sql of fs.readFileSync(path.join(__dirname,'core-metrics-schema.sql'),'utf8').split(';').map(s=>s.trim()).filter(Boolean))await p.query(sql);
 await p.query("INSERT IGNORE INTO analytics_metadata(name,started_at) VALUES ('core_metrics_v1',UTC_TIMESTAMP())");
 // The explicitly created chat demonstration account must not count as real product traffic.
 await p.query("INSERT IGNORE INTO core_metric_exclusions(account_id) SELECT id FROM accounts WHERE username='聊天测试_78e720'");
 })().catch(e=>{ready.delete(p);throw e;}));
 return ready.get(p);
}
async function completeSurvey(c,mode,id){
 await c.execute('UPDATE core_survey_funnels SET completed_at=COALESCE(completed_at,UTC_TIMESTAMP(3)) WHERE mode=? AND account_id=?',[mode,id]);
}
function registerSurveyRoutes(app,{getPool,authMiddleware}){
 app.post('/account/metrics/survey-start',authMiddleware,async(req,res)=>{
  res.setHeader('Cache-Control','no-store');const mode=req.body?.mode;
  if(!['love','deep'].includes(mode))return res.status(400).json({code:400,msg:'问卷类型无效'});
  try{const p=await getPool();await ensureSchema(p);
   // 带 step 的是「进入分区」漏斗事件：只记 core_survey_steps，不碰 started/completed 语义。
   if(req.body?.step!==undefined){
    const step=String(req.body.step);
    if(!/^\d{1,2}$/.test(step))return res.status(400).json({code:400,msg:'问卷进度无效'});
    await p.execute('INSERT IGNORE INTO core_survey_steps(mode,account_id,step,first_at) VALUES (?,?,?,UTC_TIMESTAMP(3))',[mode,req.account.account_id,step]);
    return res.json({code:200});
   }
   const table=mode==='love'?'weekly_questionnaires':'deep_surveys';
   await p.execute(`INSERT IGNORE INTO core_survey_funnels(mode,account_id,started_at,is_revision) SELECT ?,?,UTC_TIMESTAMP(3),EXISTS(SELECT 1 FROM ${table} WHERE account_id=?)`,[mode,req.account.account_id,req.account.account_id]);
   res.json({code:200});
  }catch(e){console.error('Metrics start:',e.code||e.name);res.status(503).json({code:503,msg:'统计暂不可用'});}
 });
}
// Called inside the publication transaction, including batches with zero pairs.
async function publication(c,{mode,key,algorithm,ids,matched,time:at}){
 await c.execute('INSERT INTO core_metric_batches(mode,batch_key,published_at,algorithm) VALUES (?,?,?,?)',[mode,key,stamp(at),algorithm]);
 const matchedIds=new Set(matched);
 for(const id of new Set(ids))await c.execute('INSERT INTO core_metric_participants(mode,batch_key,account_id,matched) VALUES (?,?,?,?)',[mode,key,id,matchedIds.has(id)?1:0]);
}
function calculate({surveys,batches,participants,pairs,days,excluded=[],started_at},range,now=Date.now()){
 const exclude=new Set(excluded.map(Number)),from=time(range.from),until=time(range.until);
 const inRange=x=>time(x)>=from&&time(x)<until;
 const batchKey=b=>b.mode+':'+b.batch_key;
 const allBatches=new Map(batches.map(b=>[batchKey(b),b]));
 const safeParticipants=participants.filter(p=>!exclude.has(Number(p.account_id)));
 const safePairs=pairs.filter(p=>!exclude.has(Number(p.a_id))&&!exclude.has(Number(p.b_id)));
 const daily=new Map();for(const d of days){const k=d.mode+':'+d.pair_id;if(!daily.has(k))daily.set(k,[]);daily.get(k).push(d);}
 const rows=MODES.map(mode=>{
  const ss=surveys.filter(s=>s.mode===mode&&!Number(s.is_revision)&&!exclude.has(Number(s.account_id))&&inRange(s.started_at));
  // First fill cohorts have a 7-day completion window. Immature samples are shown separately.
  const sm=ss.filter(s=>now>=time(s.started_at)+7*DAY);
  const survey=mode==='buddy'?null:ratio(sm.filter(s=>s.completed_at&&time(s.completed_at)<time(s.started_at)+7*DAY).length,sm.length,ss.length-sm.length);
  const selected=batches.filter(b=>b.mode===mode&&inRange(b.published_at));
  const keys=new Set(selected.map(batchKey));
  const ps=safeParticipants.filter(p=>keys.has(batchKey(p)));
  const pp=safePairs.filter(p=>p.mode===mode&&inRange(p.published_at));
  const agreed=pp.filter(p=>Number(p.agreed));
  const opened=agreed.filter(p=>p.first_a&&p.first_b);
  const matured=opened.filter(p=>now>=Math.min(time(p.first_a),time(p.first_b))+7*DAY);
  const ongoing=matured.filter(p=>{
   const start=Math.min(time(p.first_a),time(p.first_b));
   return (daily.get(mode+':'+p.id)||[]).filter(d=>time(d.a_at)>=start&&time(d.b_at)>=start&&time(d.a_at)<start+7*DAY&&time(d.b_at)<start+7*DAY).length>=2;
  });
  const eligibleRetention=ps.filter(p=>allBatches.has(mode+':'+nextWeek(p.batch_key)));
  const membership=new Set(safeParticipants.map(p=>batchKey(p)+':'+p.account_id));
  const retained=eligibleRetention.filter(p=>membership.has(mode+':'+nextWeek(p.batch_key)+':'+p.account_id));
  return {mode,survey,coverage:ratio(ps.filter(p=>Number(p.matched)).length,ps.length),agreement:ratio(agreed.length,pp.length),chat:ratio(opened.length,agreed.length),continuation:ratio(ongoing.length,matured.length,opened.length-matured.length),retention:ratio(retained.length,eligibleRetention.length,ps.length-eligibleRetention.length),batches:selected.length,revision_fills:surveys.filter(s=>s.mode===mode&&Number(s.is_revision)&&!exclude.has(Number(s.account_id))&&inRange(s.started_at)).length};
 });
 const total={};for(const k of ['survey','coverage','agreement','chat','continuation','retention']){const rs=rows.map(r=>r[k]).filter(Boolean);total[k]=ratio(rs.reduce((n,r)=>n+r.numerator,0),rs.reduce((n,r)=>n+r.denominator,0),rs.reduce((n,r)=>n+r.waiting,0));}
 return {started_at,rows,total,definition_version:'core-v1',excluded_accounts:exclude.size};
}
// 漏斗：按 step 的到达人数（进入问卷 → 各分区 → 完成），随日期范围统计。
async function funnel(c,range){
 const q=async(sql,args=[])=>{const [r]=await c.execute(sql,args);return r;};
 const steps=await q('SELECT mode,step,COUNT(DISTINCT account_id) n FROM core_survey_steps WHERE first_at>=? AND first_at<? GROUP BY mode,step',[range.from,range.until]);
 const base=await q('SELECT mode,COUNT(*) started,COALESCE(SUM(completed_at IS NOT NULL),0) completed FROM core_survey_funnels WHERE started_at>=? AND started_at<? GROUP BY mode',[range.from,range.until]);
 const out={};for(const b of base)out[b.mode]={started:Number(b.started),completed:Number(b.completed),steps:[]};
 for(const s of steps){(out[s.mode]||(out[s.mode]={started:0,completed:0,steps:[]})).steps.push({step:s.step,count:Number(s.n)});}
 for(const m of Object.values(out))m.steps.sort((a,b)=>Number(a.step)-Number(b.step));
 return out;
}
async function summary(c,range){
 const q=async(sql,args=[])=>{const [r]=await c.execute(sql,args);return r;};
 const [meta]=await q("SELECT DATE_FORMAT(started_at,'%Y-%m-%dT%H:%i:%sZ') started_at FROM analytics_metadata WHERE name='core_metrics_v1'");
 const surveys=await q('SELECT mode,account_id,started_at,completed_at,is_revision FROM core_survey_funnels WHERE started_at>=? AND started_at<?',[range.from,range.until]);
 // Bounded cohorts; include following weeks even when outside the selected date range.
 const batches=await q('SELECT mode,batch_key,published_at FROM core_metric_batches WHERE published_at>=? AND published_at<DATE_ADD(?,INTERVAL 14 DAY)',[range.from,range.until]);
 const participants=await q('SELECT p.* FROM core_metric_participants p JOIN core_metric_batches b ON b.mode=p.mode AND b.batch_key=p.batch_key WHERE b.published_at>=? AND b.published_at<DATE_ADD(?,INTERVAL 14 DAY)',[range.from,range.until]);
 const pairs=[],days=[];
 for(const [mode,table,batchTable,key,agreed] of [
  ['love','weekly_match_pairs','weekly_match_batches','batch_key',"p.connected_at IS NOT NULL OR (p.a_choice='like' AND p.b_choice='like')"],
  ['deep','deep_pairs','deep_batches','week_key','p.a_agreed=1 AND p.b_agreed=1'],
  ['buddy','friend_card_pairs','buddy_batches','week_key','p.a_agreed=1 AND p.b_agreed=1']]){
  // Join the actual published batch: previews and manually created demo pairs are not releases.
  pairs.push(...await q(`SELECT ? mode,p.id,p.a_id,p.b_id,b.published_at,(${agreed}) agreed,
   (SELECT MIN(m.created_at) FROM user_chat_messages m WHERE m.mode=? AND m.pair_id=p.id AND m.sender_id=p.a_id) first_a,
   (SELECT MIN(m.created_at) FROM user_chat_messages m WHERE m.mode=? AND m.pair_id=p.id AND m.sender_id=p.b_id) first_b
   FROM ${table} p JOIN ${batchTable} b ON b.batch_key=p.${key} AND b.status='published'
   WHERE b.published_at>=? AND b.published_at<?`,[mode,mode,mode,range.from,range.until]));
  days.push(...await q(`SELECT ? mode,p.id pair_id,DATE(DATE_ADD(m.created_at,INTERVAL 8 HOUR)) day,
   MIN(CASE WHEN m.sender_id=p.a_id THEN m.created_at END) a_at,MIN(CASE WHEN m.sender_id=p.b_id THEN m.created_at END) b_at
   FROM ${table} p JOIN ${batchTable} b ON b.batch_key=p.${key} AND b.status='published'
   JOIN user_chat_messages m ON m.mode=? AND m.pair_id=p.id AND m.sender_id IN (p.a_id,p.b_id)
   WHERE b.published_at>=? AND b.published_at<? GROUP BY p.id,DATE(DATE_ADD(m.created_at,INTERVAL 8 HOUR))
   HAVING a_at IS NOT NULL AND b_at IS NOT NULL`,[mode,mode,range.from,range.until]));
 }
 const excluded=(await q('SELECT account_id FROM core_metric_exclusions')).map(r=>r.account_id);
 return calculate({surveys,batches,participants,pairs,days,excluded,started_at:meta?.started_at||null},range);
}
module.exports={ensureSchema,completeSurvey,registerSurveyRoutes,publication,summary,funnel,calculate};
