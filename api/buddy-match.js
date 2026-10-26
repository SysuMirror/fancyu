'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {validateCard,compatible,score,weekKey}=require('./friends-rules');
const {batchTimes,openBatch}=require('./weekly-match-rules');
const solve=require('./buddy-solver');
const json=x=>typeof x==='string'?JSON.parse(x):x;
const stamp=d=>d.toISOString().slice(0,19).replace('T',' ');
const key=(a,b)=>[Math.min(a,b),Math.max(a,b)].join(':');
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const fail=(status,msg)=>{throw Object.assign(Error(msg),{status});};
module.exports=function(app,{getPool,authMiddleware,adminAuthMiddleware,daily,friends,now=()=>new Date(),solver=solve,observe=async()=>{}}){
 let ready,running=false;
 function ensureSchema(){if(!ready)ready=(async()=>{await friends.ensureSchema();const db=await getPool();for(const s of fs.readFileSync(path.join(__dirname,'buddy-schema.sql'),'utf8').split(';').map(x=>x.trim()).filter(Boolean))await db.query(s);})().catch(e=>{ready=null;throw e;});return ready;}
 async function cards(c){
  const [rows]=await c.query(`SELECT c.id,c.account_id,c.type,c.data,s.gender FROM friend_cards c JOIN accounts a ON a.id=c.account_id JOIN verified_students v ON v.account_id=a.id AND v.email=a.email LEFT JOIN daily_settings d ON d.account_id=a.id LEFT JOIN friend_card_settings s ON s.account_id=a.id WHERE c.enabled=1 AND c.deleted=0 AND COALESCE(d.banned,0)=0 ORDER BY c.id`);
  const banned=new Set();const [bt]=await c.query("SHOW TABLES LIKE 'weekly_match_bans'");if(bt.length){const [bs]=await c.query('SELECT account_id FROM weekly_match_bans');for(const b of bs)banned.add(b.account_id);}
  const result=[];for(const r of rows.filter(r=>!banned.has(r.account_id))){try{const clean=validateCard({type:r.type,v:json(r.data)});result.push({id:r.id,account_id:r.account_id,...clean,gender:r.gender||'不透露'});}catch{}}
  return result;
 }
 async function sync(c,time){
  const next=openBatch(time),current=await cards(c);await c.execute('INSERT IGNORE INTO buddy_batches(batch_key) VALUES (?)',[next.key]);
  const [batches]=await c.query("SELECT batch_key FROM buddy_batches WHERE status IN ('open','preview') ORDER BY batch_key");
  const live=new Map(current.map(x=>[x.id,x]));
  for(const b of batches){const times=batchTimes(b.batch_key);
   if(time<times.cutoff){await c.execute('UPDATE buddy_entries SET active=0 WHERE batch_key=?',[b.batch_key]);for(const p of current)await c.execute('INSERT INTO buddy_entries(batch_key,card_id,account_id,snapshot,active) VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE snapshot=VALUES(snapshot),active=1',[b.batch_key,p.id,p.account_id,JSON.stringify(p)]);}
   else {const [entries]=await c.execute('SELECT card_id,snapshot FROM buddy_entries WHERE batch_key=? AND active=1',[b.batch_key]);for(const e of entries){const p=live.get(e.card_id);if(!p||canonical(p)!==canonical(json(e.snapshot)))await c.execute('UPDATE buddy_entries SET active=0 WHERE batch_key=? AND card_id=?',[b.batch_key,e.card_id]);}}
  }
 }
 async function conflicts(c,time){const set=new Set();for(const p of await require('./deep-conflicts').pairs(c,time))set.add(key(p.a,p.b));
  for(const [sql,args]of [
   ['SELECT owner_id a,target_id b FROM daily_blocks',[]],
   ["SELECT a_id a,b_id b FROM friend_card_pairs WHERE week_key=? OR status='connected' OR (a_agreed=1 AND b_agreed=1) OR created_at>?",[weekKey(time),stamp(new Date(+time-30*86400000))]],
   ["SELECT low_id a,high_id b FROM daily_pairs WHERE status IN ('pending','connected','closed','blocked') OR cooldown_until>?",[stamp(time)]],
   ['SELECT account_id a,match_account_id b FROM match_history WHERE contact_exchanged=1 OR created_at>?',[stamp(new Date(+time-72*3600000))]]
  ]){const [rows]=await c.execute(sql,args);for(const p of rows)set.add(key(p.a,p.b));}
  const [tables]=await c.query("SHOW TABLES LIKE 'weekly_match_pairs'");if(tables.length){const [rows]=await c.execute("SELECT a_id a,b_id b FROM weekly_match_pairs WHERE (status='pending' AND expires_at>?) OR connected_at IS NOT NULL OR cooldown_until>?",[stamp(time),stamp(time)]);for(const p of rows)set.add(key(p.a,p.b));}return set;
 }
 async function pool(c,b,time){
  const [entries]=await c.execute('SELECT e.snapshot FROM buddy_entries e WHERE e.batch_key=? AND e.active=1 AND NOT EXISTS(SELECT 1 FROM friend_account_weeks w WHERE w.week_key=e.batch_key AND w.account_id=e.account_id) ORDER BY e.card_id',[b.batch_key]);
  const people=entries.map(e=>json(e.snapshot)),blocked=await conflicts(c,time),edges=[];
  if(people.length>500)fail(409,'本批超过 500 张卡，请先扩容，未发布近似结果');
  const ownerIds=new Map();for(const p of people)if(!ownerIds.has(p.account_id))ownerIds.set(p.account_id,ownerIds.size);
  for(let a=0;a<people.length;a++)for(let b=a+1;b<people.length;b++){const x=people[a],y=people[b];if(!blocked.has(key(x.account_id,y.account_id))&&compatible(x,y))edges.push({a,b,owners:key(ownerIds.get(x.account_id),ownerIds.get(y.account_id)),score:score(x,y)});}
  if(edges.length>20000)fail(409,'本批候选组合超过容量，请先扩容');
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({people,edges})).digest('hex');return {people,edges,fingerprint,accounts:people.map(p=>ownerIds.get(p.account_id))};
 }
 async function batch(c,id){try{batchTimes(id);}catch{fail(400,'批次编号无效');}const [r]=await c.execute('SELECT * FROM buddy_batches WHERE batch_key=?',[id]);if(!r.length)fail(404,'批次不存在');return r[0];}
 async function build(c,b,time){
  const t=batchTimes(b.batch_key);if(b.algorithm!=='buddy-v4-weekly')fail(409,'批次算法版本不一致');if(b.status==='published')fail(409,'已发布批次不能重算');if(time<t.cutoff||time>=t.expires)fail(409,'请在周三截止后、周日 20:00 前生成预览');
  const {people,edges,fingerprint,accounts}=await pool(c,b,time),chosen=await solver({n:people.length,edges,accounts});
  const map=new Map(edges.map(e=>[key(e.a,e.b),e])),used=new Set(),owners=new Set(),usedAccounts=new Set();
  const plan=chosen.map(([a,b])=>{const e=map.get(key(a,b));if(!e||used.has(a)||used.has(b)||owners.has(e.owners)||usedAccounts.has(accounts[a])||usedAccounts.has(accounts[b]))throw Error('invalid_buddy_plan');used.add(a);used.add(b);owners.add(e.owners);usedAccounts.add(accounts[a]);usedAccounts.add(accounts[b]);return {a:people[a].id,b:people[b].id,a_id:people[a].account_id,b_id:people[b].account_id,score:e.score};});
  const degree=new Set(edges.flatMap(e=>[e.a,e.b])),matchedUsers=new Set(plan.flatMap(p=>[p.a_id,p.b_id]));
  const stats={eligible:people.length,users:new Set(people.map(p=>p.account_id)).size,with_candidates:degree.size,no_candidates:people.length-degree.size,pairs:plan.length,matched_users:matchedUsers.size,unmatched:new Set(people.map(p=>p.account_id)).size-matchedUsers.size,mean_score:plan.length?Math.round(plan.reduce((n,p)=>n+p.score,0)/plan.length):null,fingerprint};
  await c.execute("UPDATE buddy_batches SET status='preview',plan=?,stats=?,revision=revision+1,approved_revision=NULL,approved_by=NULL,last_error=NULL WHERE batch_key=?",[JSON.stringify(plan),JSON.stringify(stats),b.batch_key]);return {stats,msg:'预览已生成，等待管理员确认'};
 }
 async function publish(c,b,time){
  if(b.status==='published')return {msg:'本批已发布'};const t=batchTimes(b.batch_key);
  if(time<t.release||time>=t.expires)fail(409,'请在周四 20:00 至周日 20:00 之间发布');if(b.status!=='preview'||b.approved_revision!==b.revision)fail(409,'请先确认当前预览');
  const current=await pool(c,b,time);if(current.fingerprint!==json(b.stats)?.fingerprint){await build(c,b,time);return {needs_review:true,msg:'卡片或关系已变化，已重算，请再次确认'};}
  const plan=json(b.plan);for(const p of plan){const [r]=await c.execute('INSERT INTO friend_card_pairs(a_card,b_card,a_id,b_id,week_key,created_at) VALUES (?,?,?,?,?,?)',[p.a,p.b,p.a_id,p.b_id,b.batch_key,stamp(time)]);await c.execute('INSERT INTO friend_account_weeks(account_id,week_key,pair_id) VALUES (?,?,?),(?,?,?)',[p.a_id,b.batch_key,r.insertId,p.b_id,b.batch_key,r.insertId]);for(const id of [p.a_id,p.b_id])await observe(c,{mode:'quick',accountId:id,unit:b.batch_key,outcome:'recommended',pairId:r.insertId,time});await c.execute('INSERT INTO friend_card_weeks(card_id,week_key,pair_id) VALUES (?,?,?),(?,?,?)',[p.a,b.batch_key,r.insertId,p.b,b.batch_key,r.insertId]);}
  const matched=new Set(plan.flatMap(p=>[p.a_id,p.b_id]));for(const id of new Set(current.people.map(p=>p.account_id)))if(!matched.has(id))await observe(c,{mode:'quick',accountId:id,unit:b.batch_key,outcome:'empty',time});
  await c.execute("UPDATE buddy_batches SET status='published',published_at=?,last_error=NULL WHERE batch_key=?",[stamp(time),b.batch_key]);return {pairs:plan.length,msg:'本周搭子已发布'};
 }
 async function tx(fn){await ensureSchema();return daily.transaction(async c=>{const time=now();await sync(c,time);return fn(c,time);});}
 const route=fn=>async(req,res)=>{res.setHeader('Cache-Control','no-store');try{res.json({code:200,...await tx((c,t)=>fn(req,c,t))});}catch(e){console.error('Buddy:',e.status||e.code||e.name);res.status(e.status||503).json({code:e.status||503,msg:e.status?e.message:'搭子配对暂不可用，请稍后重试'});}};
 async function state(c,time,id){const b=await batch(c,openBatch(time).key),t=batchTimes(b.batch_key);const [entries]=await c.execute('SELECT e.card_id,e.batch_key,e.active,b.status,EXISTS(SELECT 1 FROM friend_account_weeks w WHERE w.account_id=e.account_id AND w.week_key=e.batch_key) assigned FROM buddy_entries e JOIN buddy_batches b ON b.batch_key=e.batch_key WHERE e.account_id=? ORDER BY e.batch_key DESC LIMIT 24',[id]);return {registration:{key:b.batch_key,cutoff:t.cutoff.toISOString(),release:t.release.toISOString()},entries:entries.map(e=>({...e,status:e.status==='published'?'published':e.status==='missed'?'missed':'waiting'}))};}
 app.get('/admin/buddy-batches',adminAuthMiddleware,route(async(req,c)=>{const [rows]=await c.query('SELECT * FROM buddy_batches ORDER BY batch_key DESC LIMIT 30');return {batches:rows.map(r=>{const t=batchTimes(r.batch_key);return {batch_key:r.batch_key,status:r.status,algorithm:r.algorithm,revision:r.revision,approved_revision:r.approved_revision,last_error:r.last_error,stats:json(r.stats),cutoff:t.cutoff.toISOString(),release:t.release.toISOString(),published:r.published_at};})};}));
 app.post('/admin/buddy-batches/:key/preview',adminAuthMiddleware,route(async(req,c,t)=>build(c,await batch(c,req.params.key),t)));
 app.post('/admin/buddy-batches/:key/approve',adminAuthMiddleware,route(async(req,c,t)=>{const b=await batch(c,req.params.key);if(b.status!=='preview'||req.body?.revision!==b.revision||t>=batchTimes(b.batch_key).expires)fail(409,'预览已变化或过期，请刷新');await c.execute('UPDATE buddy_batches SET approved_revision=revision,approved_by=? WHERE batch_key=?',[req.admin.username||'admin',b.batch_key]);return {msg:'已确认，周四 20:00 到时发布'};}));
 app.post('/admin/buddy-batches/:key/publish',adminAuthMiddleware,route(async(req,c,t)=>publish(c,await batch(c,req.params.key),t)));
 async function tick(){if(running)return;running=true;try{await tx(async(c,time)=>{const [rows]=await c.query("SELECT batch_key FROM buddy_batches WHERE status IN ('open','preview') ORDER BY batch_key");for(const r of rows){let b=await batch(c,r.batch_key);const t=batchTimes(b.batch_key);if(time>=t.expires){await c.execute("UPDATE buddy_batches SET status='missed',plan=NULL WHERE batch_key=?",[b.batch_key]);continue;}if(time<t.cutoff)continue;if(b.status==='open'){await build(c,b,time);b=await batch(c,b.batch_key);}if(b.status==='preview'&&b.approved_revision===b.revision&&time>=t.release)await publish(c,b,time);}});}catch(e){console.error('Buddy scheduler:',e.status||e.code||e.name);try{const p=await getPool();await p.query("UPDATE buddy_batches SET last_error='processing_failed' WHERE status IN ('open','preview')");}catch{}}finally{running=false;}}
 function start(){const t=setInterval(tick,60000),f=setTimeout(tick,5000);t.unref();f.unref();return()=>{clearInterval(t);clearTimeout(f);};}
 return {ensureSchema,sync,state,tx,tick,start};
};
