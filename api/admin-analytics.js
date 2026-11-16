'use strict';
const VERSIONS={quick:'buddy-v4-weekly'};
function dateRange(query={},now=new Date()){
 const today=new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
 const end=query.end||today,start=query.start||new Date(new Date(today+'T00:00:00Z').getTime()-29*86400000).toISOString().slice(0,10);
 const valid=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&!isNaN(Date.parse(x+'T00:00:00Z'))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
 if(!valid(start)||!valid(end)||end<start||end>today||(Date.parse(end)-Date.parse(start))/86400000>365)throw Error('请选择有效日期，最多查询 366 天，结束日期不能晚于今天');
 const begin=new Date(start+'T00:00:00+08:00'),finish=new Date(Date.parse(end+'T00:00:00+08:00')+86400000);
 const sql=d=>d.toISOString().slice(0,19).replace('T',' ');
 return {start,end,from:sql(begin),until:sql(finish),timezone:'Asia/Shanghai'};
}
function percent(a,b){return b?Math.round(Number(a)/Number(b)*1000)/10:null;}
module.exports=function({getPool}){
 let ready;
 function ensureSchema(){if(!ready)ready=(async()=>{const p=await getPool();await p.query(`CREATE TABLE IF NOT EXISTS recommendation_observations (
 mode VARCHAR(12) NOT NULL,account_id INT NOT NULL,unit_key VARCHAR(48) NOT NULL,algorithm_version VARCHAR(24) NOT NULL,
 outcome VARCHAR(16) NOT NULL,pair_id BIGINT NULL,first_at DATETIME NOT NULL,last_at DATETIME NOT NULL,
 PRIMARY KEY(mode,account_id,unit_key,algorithm_version),INDEX idx_time(first_at),
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
 await p.query(`CREATE TABLE IF NOT EXISTS analytics_metadata (name VARCHAR(40) PRIMARY KEY,started_at DATETIME NOT NULL) ENGINE=InnoDB`);
 await p.query("INSERT IGNORE INTO analytics_metadata(name,started_at) VALUES ('recommendations',UTC_TIMESTAMP())");
 await require('./core-metrics').ensureSchema(p);
 })().catch(e=>{ready=null;throw e;});return ready;}
 async function observe(c,{mode,accountId,unit,outcome,pairId=null,time=new Date()}){
  const at=time.toISOString().slice(0,19).replace('T',' ');
  await c.execute(`INSERT INTO recommendation_observations(mode,account_id,unit_key,algorithm_version,outcome,pair_id,first_at,last_at) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE outcome=IF(outcome='recommended',outcome,VALUES(outcome)),pair_id=COALESCE(pair_id,VALUES(pair_id)),last_at=VALUES(last_at)`,[mode,accountId,unit,VERSIONS[mode],outcome,pairId,at,at]);
 }
 async function summary(range,{readOnly=false}={}){
  if(!readOnly)await ensureSchema();const pool=await getPool(),c=await pool.getConnection();
  const q=async(sql,args=[])=>{const [r]=await c.execute(sql,args);return r;};
  const count=async(sql,args=[])=>Number((await q(sql,args))[0].n||0);
  const times=[range.from,range.until];
  try{await c.query("SET time_zone = '+00:00'");await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
   const totals={accounts:await count('SELECT COUNT(*) n FROM accounts'),verified:await count('SELECT COUNT(*) n FROM accounts a JOIN verified_students v ON v.account_id=a.id AND v.email=a.email'),weekly_surveys:await count('SELECT COUNT(*) n FROM weekly_questionnaires'),friend_surveys:await count('SELECT COUNT(DISTINCT f.account_id) n FROM deep_surveys f JOIN accounts a ON a.id=f.account_id'),cards:await count('SELECT COUNT(*) n FROM friend_cards WHERE deleted=0'),pending_reports:await count("SELECT COUNT(*) n FROM complaints WHERE status IN ('pending','processing')")};
   totals.verification_rate=percent(totals.verified,totals.accounts);
   const period={registrations:await count('SELECT COUNT(*) n FROM accounts WHERE created_at>=? AND created_at<?',times),verifications:await count('SELECT COUNT(*) n FROM verified_students v JOIN accounts a ON a.id=v.account_id AND a.email=v.email WHERE v.verified_at>=? AND v.verified_at<?',times),reports:await count('SELECT COUNT(*) n FROM complaints WHERE created_at>=? AND created_at<?',times),blocks:await count('SELECT COUNT(*) n FROM daily_blocks WHERE created_at>=? AND created_at<?',times)};
   const active={};
   for(const [key,field,table]of [['weekly','join_matching','weekly_questionnaires'],['deep','join_friend_matching','friend_survey']])active[key]=await count(`SELECT COUNT(*) n FROM accounts a JOIN verified_students v ON v.account_id=a.id AND v.email=a.email JOIN account_preferences p ON p.account_id=a.id WHERE p.${field}=1 AND EXISTS(SELECT 1 FROM ${table} s WHERE s.account_id=a.id)`);
   active.weekly=await count("SELECT COUNT(DISTINCT e.account_id) n FROM weekly_match_enrollments e JOIN weekly_match_batches b ON b.batch_key=e.batch_key JOIN accounts a ON a.id=e.account_id JOIN verified_students v ON v.account_id=a.id AND v.email=a.email LEFT JOIN daily_settings d ON d.account_id=a.id WHERE NOT EXISTS(SELECT 1 FROM weekly_match_bans ban WHERE ban.account_id=e.account_id) AND e.active=1 AND b.expires_at>UTC_TIMESTAMP() AND b.status<>'missed' AND COALESCE(d.banned,0)=0");
   active.quick=await count('SELECT COUNT(DISTINCT c.account_id) n FROM friend_cards c JOIN accounts a ON a.id=c.account_id JOIN verified_students v ON v.account_id=a.id AND v.email=a.email LEFT JOIN daily_settings d ON d.account_id=a.id WHERE c.enabled=1 AND c.deleted=0 AND COALESCE(d.banned,0)=0 AND NOT EXISTS(SELECT 1 FROM weekly_match_bans ban WHERE ban.account_id=c.account_id)');
   active.quick_cards=await count('SELECT COUNT(*) n FROM friend_cards c JOIN accounts a ON a.id=c.account_id JOIN verified_students v ON v.account_id=a.id AND v.email=a.email LEFT JOIN daily_settings d ON d.account_id=a.id WHERE c.enabled=1 AND c.deleted=0 AND COALESCE(d.banned,0)=0 AND NOT EXISTS(SELECT 1 FROM weekly_match_bans ban WHERE ban.account_id=c.account_id)');
   active.deep=await count("SELECT COUNT(*) n FROM deep_surveys s JOIN accounts a ON a.id=s.account_id JOIN verified_students v ON v.account_id=a.id AND v.email=a.email JOIN account_preferences p ON p.account_id=a.id LEFT JOIN daily_settings d ON d.account_id=a.id WHERE p.join_friend_matching=1 AND COALESCE(d.banned,0)=0 AND NOT EXISTS(SELECT 1 FROM weekly_match_bans b WHERE b.account_id=a.id)");
   const modes=[];
   // Legacy imports may store both directions: one unordered pair per round is one result.
   const legacy=`SELECT survey_type,match_round,LEAST(account_id,match_account_id) a,GREATEST(account_id,match_account_id) b,MIN(created_at) created_at,MAX(contact_exchanged) connected FROM match_history GROUP BY survey_type,match_round,LEAST(account_id,match_account_id),GREATEST(account_id,match_account_id) UNION ALL SELECT 'love',batch_key,a_id,b_id,created_at,EXISTS(SELECT 1 FROM user_chat_contact_events ce WHERE ce.mode='love' AND ce.pair_id=weekly_match_pairs.id) FROM weekly_match_pairs UNION ALL SELECT 'friend',week_key,a_id,b_id,created_at,EXISTS(SELECT 1 FROM user_chat_contact_events ce WHERE ce.mode='deep' AND ce.pair_id=deep_pairs.id) FROM deep_pairs`;
   for(const [key,type,name]of [['weekly','love','每周恋爱配对'],['deep','friend','深度交友']]){
    const [row]=await q(`SELECT COUNT(*) pairs,COALESCE(SUM(connected=1),0) connected FROM (${legacy}) m WHERE survey_type=? AND created_at>=? AND created_at<?`,[type,...times]);
    modes.push({key,name,active:active[key],pairs:Number(row.pairs),connected:Number(row.connected),skipped:null,paused:null,exchange_rate:percent(row.connected,row.pairs),algorithm:key==='weekly'?'weekly-love-v1（含历史导入）':'deep-v3-education-weight（含历史导入）'});
   }
   for(const [key,name,table,connected]of [['quick','快速交友','friend_card_pairs',"EXISTS(SELECT 1 FROM user_chat_contact_events ce WHERE ce.mode='buddy' AND ce.pair_id=friend_card_pairs.id)"]]){
    const [row]=await q(`SELECT COUNT(*) pairs,COALESCE(SUM(${connected}),0) connected,COALESCE(SUM(status='skipped'),0) skipped,COALESCE(SUM(status='pending'),0) pending FROM ${table} WHERE created_at>=? AND created_at<?`,times);
    modes.push({key,name,active:active[key],pairs:Number(row.pairs),connected:Number(row.connected),skipped:Number(row.skipped),pending:Number(row.pending),exchange_rate:percent(row.connected,row.pairs),algorithm:VERSIONS[key]});
   }
   const pause={quick_cards:await count('SELECT COUNT(*) n FROM friend_cards WHERE enabled=0 AND deleted=0')};
   const statuses={};for(const [key,table]of [['quick','friend_card_pairs']]){const expired=key==='daily'?"expires_at<=UTC_TIMESTAMP()":"week_key<DATE_FORMAT(DATE_SUB(DATE_ADD(UTC_TIMESTAMP(),INTERVAL 8 HOUR),INTERVAL WEEKDAY(DATE_ADD(UTC_TIMESTAMP(),INTERVAL 8 HOUR)) DAY),'%Y-%m-%d')";statuses[key]=(await q(`SELECT CASE WHEN status='pending' AND ${expired} THEN 'expired' ELSE status END effective_status,COUNT(*) count FROM ${table} WHERE created_at>=? AND created_at<? GROUP BY effective_status`,times)).map(r=>({status:r.effective_status,count:r.count}));}
   const rawTrend=await q(`SELECT day,SUM(registrations) registrations,SUM(verifications) verifications,SUM(pairs) pairs FROM (
    SELECT DATE_FORMAT(DATE_ADD(created_at,INTERVAL 8 HOUR),'%Y-%m-%d') day,COUNT(*) registrations,0 verifications,0 pairs FROM accounts WHERE created_at>=? AND created_at<? GROUP BY day
    UNION ALL SELECT DATE_FORMAT(DATE_ADD(v.verified_at,INTERVAL 8 HOUR),'%Y-%m-%d') day,0,COUNT(*),0 FROM verified_students v JOIN accounts a ON a.id=v.account_id AND a.email=v.email WHERE v.verified_at>=? AND v.verified_at<? GROUP BY day
    UNION ALL SELECT DATE_FORMAT(DATE_ADD(created_at,INTERVAL 8 HOUR),'%Y-%m-%d') day,0,0,COUNT(*) FROM friend_card_pairs WHERE created_at>=? AND created_at<? GROUP BY day
    UNION ALL SELECT DATE_FORMAT(DATE_ADD(created_at,INTERVAL 8 HOUR),'%Y-%m-%d') day,0,0,COUNT(*) FROM (${legacy}) m WHERE created_at>=? AND created_at<? GROUP BY day
   ) t GROUP BY day ORDER BY day`,[...times,...times,...times,...times]);
   const trend=[];for(let d=new Date(range.start+'T00:00:00Z');d.toISOString().slice(0,10)<=range.end;d.setUTCDate(d.getUTCDate()+1)){const day=d.toISOString().slice(0,10),r=rawTrend.find(x=>x.day===day);trend.push({day,registrations:Number(r?.registrations||0),verifications:Number(r?.verifications||0),pairs:Number(r?.pairs||0)});}
   const observations=await q(`SELECT o.mode,o.algorithm_version,COUNT(*) units,SUM(o.outcome='empty') empty_units,SUM(o.outcome='recommended') recommended_units,COUNT(DISTINCT o.pair_id) pairs,COUNT(DISTINCT CASE WHEN dp.connected_at IS NOT NULL OR EXISTS(SELECT 1 FROM user_chat_contact_events ce WHERE ce.mode='buddy' AND ce.pair_id=fp.id) THEN o.pair_id END) exchanged_pairs FROM recommendation_observations o LEFT JOIN daily_pairs dp ON o.mode='daily' AND dp.id=o.pair_id LEFT JOIN friend_card_pairs fp ON o.mode='quick' AND fp.id=o.pair_id WHERE o.mode='quick' AND o.first_at>=? AND o.first_at<? GROUP BY o.mode,o.algorithm_version`,times);
   for(const r of observations){for(const k of ['units','empty_units','recommended_units','pairs','exchanged_pairs'])r[k]=Number(r[k]);r.empty_rate=percent(r.empty_units,r.units);r.exchange_rate=percent(r.exchanged_pairs,r.pairs);}
   const card_types=await q('SELECT type,COUNT(*) cards,SUM(enabled=1) enabled FROM friend_cards WHERE deleted=0 GROUP BY type');
   const reports=await q('SELECT status,COUNT(*) count FROM complaints WHERE created_at>=? AND created_at<? GROUP BY status',times);
   const survey_versions=await q('SELECT version,COUNT(*) count FROM weekly_questionnaires GROUP BY version');
   // —— 本批新增面板（纯追加 key，不改既有 key 的口径）——
   // 日期序列一律按北京时区补零，缺日不虚构。
   const zeroFill=async(sql,args,keys)=>{const rows=await q(sql,args);const out=[];for(let d=new Date(range.start+'T00:00:00Z');d.toISOString().slice(0,10)<=range.end;d.setUTCDate(d.getUTCDate()+1)){const day=d.toISOString().slice(0,10),r=rows.find(x=>x.day===day)||{};const o={day};for(const k of keys)o[k]=Number(r[k]||0);out.push(o);}return out;};
   // 注册与活跃趋势：每日新增登录（last_login_at，依赖登录时写入）+ 每日活跃发信人
   const activity_trend=await zeroFill(`SELECT day,SUM(logins) logins,SUM(senders) senders FROM (
    SELECT DATE_FORMAT(DATE_ADD(last_login_at,INTERVAL 8 HOUR),'%Y-%m-%d') day,COUNT(*) logins,0 senders FROM accounts WHERE last_login_at>=? AND last_login_at<? GROUP BY day
    UNION ALL SELECT DATE_FORMAT(DATE_ADD(created_at,INTERVAL 8 HOUR),'%Y-%m-%d') day,0,COUNT(DISTINCT sender_id) FROM user_chat_messages WHERE deleted_at IS NULL AND created_at>=? AND created_at<? GROUP BY day
   ) t GROUP BY day ORDER BY day`,times,['logins','senders']);
   // 聊天运营：消息数 / 发信人数 / 会话数（mode+pair 去重）/ 联系方式交换数
   const chat_ops={
    messages:await count('SELECT COUNT(*) n FROM user_chat_messages WHERE deleted_at IS NULL AND created_at>=? AND created_at<?',times),
    senders:await count('SELECT COUNT(DISTINCT sender_id) n FROM user_chat_messages WHERE deleted_at IS NULL AND created_at>=? AND created_at<?',times),
    conversations:await count("SELECT COUNT(DISTINCT CONCAT(mode,':',pair_id)) n FROM user_chat_messages WHERE deleted_at IS NULL AND created_at>=? AND created_at<?",times),
    exchanges:await count('SELECT COUNT(*) n FROM user_chat_contact_events WHERE exchanged_at>=? AND exchanged_at<?',times)
   };
   chat_ops.by_mode=(await q('SELECT mode,COUNT(*) messages,COUNT(DISTINCT sender_id) senders,COUNT(DISTINCT CONCAT(mode,\':\',pair_id)) conversations FROM user_chat_messages WHERE deleted_at IS NULL AND created_at>=? AND created_at<? GROUP BY mode',times)).map(r=>({mode:r.mode,messages:Number(r.messages),senders:Number(r.senders),conversations:Number(r.conversations)}));
   chat_ops.avg_messages_per_conversation=chat_ops.conversations?Math.round(chat_ops.messages/chat_ops.conversations*10)/10:null;
   // 举报运营：按状态 / 处置时长（以 updated_at 近似完成时间）/ 被举报 Top10（只到用户名，不含联系方式）
   const report_ops={};
   report_ops.by_status=reports.map(r=>({status:r.status,count:Number(r.count)}));
   report_ops.pending_total=await count("SELECT COUNT(*) n FROM complaints WHERE status IN ('pending','processing')");
   {const [rt]=await q("SELECT COUNT(*) handled,ROUND(AVG(TIMESTAMPDIFF(MINUTE,created_at,updated_at)),1) avg_minutes,ROUND(MAX(TIMESTAMPDIFF(MINUTE,created_at,updated_at)),1) max_minutes FROM complaints WHERE status IN ('resolved','dismissed') AND updated_at>=? AND updated_at<?",times);
    const row=rt[0]||{};report_ops.handled=Number(row.handled||0);report_ops.avg_minutes=row.avg_minutes===null||row.avg_minutes===undefined?null:Number(row.avg_minutes);report_ops.max_minutes=row.max_minutes===null||row.max_minutes===undefined?null:Number(row.max_minutes);report_ops.duration_note='以 updated_at 近似处置完成时间';}
   report_ops.top_targets=(await q("SELECT c.target_id,COUNT(*) count,MAX(a.username) username FROM complaints c LEFT JOIN accounts a ON a.id=CAST(c.target_id AS UNSIGNED) WHERE c.target_type='user' AND c.created_at>=? AND c.created_at<? GROUP BY c.target_id ORDER BY count DESC LIMIT 10",times)).map(r=>({target_id:r.target_id,username:r.username||null,count:Number(r.count)}));
   // 邀请增长：汇总 / 本期新增（邀请 vs 自然）/ 被邀注册趋势 / Top 邀请人（不含联系方式）
   const [[invSum]]=await q('SELECT COUNT(*) accounts,COALESCE(SUM(invite_code IS NOT NULL),0) has_code,COALESCE(SUM(invited_by IS NOT NULL),0) invited,COUNT(DISTINCT invited_by) inviters FROM accounts');
   const [[invPeriod]]=await q('SELECT COUNT(*) registered,COALESCE(SUM(invited_by IS NOT NULL),0) invited_registered FROM accounts WHERE created_at>=? AND created_at<?',times);
   const invite={total_accounts:Number(invSum.accounts),with_invite_code:Number(invSum.has_code),invited_accounts:Number(invSum.invited),active_inviters:Number(invSum.inviters),period_registered:Number(invPeriod.registered),period_invited:Number(invPeriod.invited_registered)};
   invite.period_organic=invite.period_registered-invite.period_invited;
   invite.invited_share=percent(invite.period_invited,invite.period_registered);
   invite.trend=await zeroFill(`SELECT DATE_FORMAT(DATE_ADD(created_at,INTERVAL 8 HOUR),'%Y-%m-%d') day,COALESCE(SUM(invited_by IS NOT NULL),0) invited,COALESCE(SUM(invited_by IS NULL),0) organic FROM accounts WHERE created_at>=? AND created_at<? GROUP BY day`,times,['invited','organic']);
   invite.top_inviters=(await q('SELECT i.id,i.username,COUNT(*) count FROM accounts r JOIN accounts i ON i.id=r.invited_by WHERE r.created_at>=? AND r.created_at<? GROUP BY i.id,i.username ORDER BY count DESC LIMIT 10',times)).map(r=>({account_id:r.id,username:r.username||null,count:Number(r.count)}));
   const [meta]=await q("SELECT DATE_FORMAT(started_at,'%Y-%m-%dT%H:%i:%sZ') started_at FROM analytics_metadata WHERE name='recommendations'");
   const core_metrics=await require('./core-metrics').summary(c,range);
   const funnels=await require('./core-metrics').funnel(c,range);
   await c.commit();return {core_metrics,funnels,range:{start:range.start,end:range.end,timezone:range.timezone},generated_at:new Date().toISOString(),totals,period,modes,active,pause,statuses,trend,observations,card_types,reports,survey_versions,observation_started_at:meta.started_at,activity_trend,chat_ops,report_ops,invite};
  }catch(e){await c.rollback();throw e;}finally{c.release();}
 }
 function register(app,{adminAuthMiddleware,prepare,userIdentitySql}){
  app.get('/admin/overview',adminAuthMiddleware,async(req,res)=>{res.setHeader('Cache-Control','no-store');let range;try{range=dateRange(req.query);}catch(e){return res.status(400).json({code:400,msg:e.message});}
   try{await prepare();res.json({code:200,data:await summary(range)});}catch(e){console.error('Admin overview:',e.code||e.name);res.status(503).json({code:503,msg:'统计暂不可用，请稍后重试'});}
  });
  // 字段分布（校区/性别/期望性别…… 可自定义）：只出聚合，字段限 admin-users.js 的 GROUPABLE 白名单
  app.get('/admin/distribution',adminAuthMiddleware,async(req,res)=>{
   res.setHeader('Cache-Control','no-store');
   const users=require('./admin-users');
   const f=users.groupableField(req.query.field);
   if(!f)return res.status(400).json({code:400,msg:'该字段不支持分布统计'});
   let range;try{range=dateRange(req.query);}catch(e){return res.status(400).json({code:400,msg:e.message});}
   try{
    await prepare();
    const identity=typeof userIdentitySql==='function'?userIdentitySql():userIdentitySql;
    if(!identity)return res.status(503).json({code:503,msg:'统计暂不可用，请稍后重试'});
    const pool=await getPool();
    const RANGE=[range.from,range.until];
    const [[t]]=await pool.execute(`SELECT COUNT(*) n FROM ${identity} WHERE COALESCE(a.created_at,u.created_at)>=? AND COALESCE(a.created_at,u.created_at)<?`,RANGE);
    const total=Number(t.n||0);
    const rows=await pool.execute(`SELECT ${f.expr} AS v,COUNT(*) n FROM ${identity} WHERE COALESCE(a.created_at,u.created_at)>=? AND COALESCE(a.created_at,u.created_at)<? GROUP BY v ORDER BY n DESC LIMIT 51`,RANGE).then(([r])=>r);
    const [[d]]=await pool.execute(`SELECT COUNT(DISTINCT NULLIF(${f.expr},'')) d FROM ${identity} WHERE COALESCE(a.created_at,u.created_at)>=? AND COALESCE(a.created_at,u.created_at)<?`,RANGE);
    const fmt=v=>v===null||v===undefined||v===''?(f.type==='bool'?'否':'未填写'):(f.type==='bool'?(Number(v)?'是':'否'):String(v));
    const filled=rows.filter(r=>r.v!==null&&r.v!=='').slice(0,50);
    const buckets=filled.map(r=>({value:fmt(r.v),count:Number(r.n),pct:percent(Number(r.n),total)}));
    const unfilled=rows.filter(r=>r.v===null||r.v==='').reduce((s,r)=>s+Number(r.n),0);
    res.json({code:200,data:{field:f.key,label:f.label,type:f.type,total,buckets,unfilled,truncated:Number(d.d||0)>filled.length,range:{start:range.start,end:range.end,timezone:range.timezone},generated_at:new Date().toISOString()}});
   }catch(e){console.error('Admin distribution:',e.code||e.name);res.status(503).json({code:503,msg:'统计暂不可用，请稍后重试'});}
  });
  app.get('/admin/distribution/fields',adminAuthMiddleware,(req,res)=>{res.setHeader('Cache-Control','no-store');res.json({code:200,fields:require('./admin-users').groupableCatalog()});});
 }
 return {ensureSchema,observe,summary,register};
};
module.exports.dateRange=dateRange;
module.exports.percent=percent;
