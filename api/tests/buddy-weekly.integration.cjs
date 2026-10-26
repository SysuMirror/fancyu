const assert=require('assert/strict'),mysql=require('mysql2/promise'),crypto=require('crypto'),express=require('express');
(async()=>{
 const real=mysql.createPool({host:process.env.MYSQL_HOST,port:process.env.MYSQL_PORT,user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE,connectionLimit:8});
 const prefix='buddytest_'+crypto.randomBytes(5).toString('hex')+'_';
 const names=['deep_pairs','accounts','account_profiles','verified_students','secure_email_codes','daily_mutex','daily_settings','daily_pairs','daily_days','daily_blocks','complaints','account_preferences','match_history','friend_card_settings','friend_cards','friend_card_pairs','friend_card_weeks','friend_account_weeks','weekly_match_pairs','weekly_match_bans','buddy_batches','buddy_entries'];
 const re=new RegExp('\\b('+names.join('|')+')\\b','g'),sql=s=>s.replace(re,x=>prefix+x);
 const wrap=c=>({query:(s,a)=>c.query(sql(s),a),execute:(s,a)=>c.execute(sql(s),a),beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release()});
 const db={...wrap(real),getConnection:async()=>wrap(await real.getConnection())};let server;
 try{
  for(const name of ['accounts','account_preferences','match_history','complaints','weekly_match_bans','weekly_match_pairs'])await real.query('CREATE TABLE `'+prefix+name+'` LIKE `'+name+'`');
  const ids=[],app=express();app.use(express.json());let clock=new Date('2026-10-27T12:00:00Z');
  const auth=(req,res,next)=>{const id=Number(req.headers['x-fixture']);if(!ids.includes(id))return res.status(401).json({code:401});req.account={account_id:id};next();};
  const daily=require('../daily')(app,{getPool:async()=>db,authMiddleware:auth,adminAuthMiddleware:auth,now:()=>clock});
  const studentVerification={verified:async(c,id)=>{const [r]=await c.execute('SELECT account_id FROM verified_students WHERE account_id=?',[id]);return !!r.length;}};
  let buddy;const admin=(req,res,next)=>{if(req.headers['x-admin']!=='yes')return res.status(401).json({code:401});req.admin={username:'fixture'};next();};
  const friends=require('../friends')(app,{getPool:async()=>db,authMiddleware:auth,daily,studentVerification,now:()=>clock,getBuddy:()=>buddy});buddy=require('../buddy-match')(app,{getPool:async()=>db,authMiddleware:auth,adminAuthMiddleware:admin,daily,friends,now:()=>clock});await buddy.ensureSchema();
  for(let i=0;i<8;i++){const email='buddy'+i+'@example.invalid';const [r]=await db.execute('INSERT INTO accounts(email,username,password_hash) VALUES (?,?,?)',[email,'buddy'+i,'not-real']);ids.push(r.insertId);if(i!==7)await db.execute('INSERT INTO verified_students(account_id,email,verified_at) VALUES (?,?,?)',[r.insertId,email,'2026-10-27 10:00:00']);}
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/account/friends';
  async function api(i,path='',method='GET',body){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','x-fixture':String(ids[i]||0)},...(body?{body:JSON.stringify(body)}:{})});return {http:r.status,...await r.json()};}
  const value={type:'game',v:{item:'fixture_game',level:'一般',mic:'都行',time:['周末晚上'],gender:'不限',freq:'每周'}};

  const cs=[];for(let i=0;i<8;i++)cs.push((await api(i,'/cards','POST',{...value,v:{...value.v,item:'game_'+i,time:[i===6?'工作日白天':'周末晚上']}})).id);
  const extra=(await api(0,'/cards','POST',value)).id;
  async function adm(path='',body,auth=true){const r=await fetch(base.replace('/account/friends','/admin/buddy-batches')+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{'x-admin':'yes'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {http:r.status,...await r.json()};}
  const batch='2026-10-26',ad='/'+batch;
  assert.equal((await adm('',undefined,false)).http,401);
  assert.equal((await api(7,'/cards/'+cs[7]+'/toggle','POST',{enabled:true})).http,403);
  assert.equal((await api(0,'/cards/'+cs[0]+'/recommend','POST')).http,410);
  assert.equal((await api(0)).schedule.entries.filter(e=>e.active).length,2);
  assert.equal((await adm(ad+'/preview',{})).http,409);
  clock=new Date('2026-10-28T12:00:00Z');await buddy.tick();let list=await adm(),b=list.batches.find(b=>b.batch_key===batch);
  assert.equal(b.stats.users,7);assert.equal(b.stats.pairs,3);assert.equal(b.stats.unmatched,1);assert.equal((await api(0)).pairs.length,0);
  assert.equal((await adm(ad+'/approve',{revision:999})).http,409);await adm(ad+'/approve',{revision:b.revision});assert.equal((await adm(ad+'/publish',{})).http,409);
  // Pausing after cutoff withdraws the card from this batch permanently.
  await api(0,'/cards/'+extra+'/toggle','POST',{enabled:false});await api(0,'/cards/'+extra+'/toggle','POST',{enabled:true});
  let state=await api(0);assert.equal(state.schedule.entries.find(e=>e.batch_key===batch&&e.card_id===extra).active,0);
  assert.equal(state.schedule.entries.find(e=>e.batch_key==='2026-11-02'&&e.card_id===extra).active,1);
  clock=new Date('2026-10-29T12:00:00Z');assert.equal((await adm(ad+'/publish',{})).needs_review,true);
  list=await adm();b=list.batches.find(b=>b.batch_key===batch);assert.equal(b.approved_revision,null);await adm(ad+'/approve',{revision:b.revision});
  const [plans]=await db.execute('SELECT plan FROM buddy_batches WHERE batch_key=?',[batch]);const plan=typeof plans[0].plan==='string'?JSON.parse(plans[0].plan):plans[0].plan;
  await db.execute('INSERT INTO daily_blocks(owner_id,target_id,created_at) VALUES (?,?,?)',[plan[0].a_id,plan[0].b_id,'2026-10-29 12:00:00']);
  assert.equal((await adm(ad+'/publish',{})).needs_review,true);b=(await adm()).batches.find(b=>b.batch_key===batch);await adm(ad+'/approve',{revision:b.revision});
  const pubs=await Promise.all([adm(ad+'/publish',{}),adm(ad+'/publish',{})]);assert.ok(pubs.every(p=>p.code===200));
  const [pairs]=await db.query('SELECT * FROM friend_card_pairs');assert.equal(pairs.length,3);const [quotas]=await db.query('SELECT account_id,COUNT(*) n FROM friend_account_weeks GROUP BY account_id');assert.equal(quotas.length,6);assert.ok(quotas.every(x=>x.n===1));
  const p=pairs[0],a=ids.indexOf(p.a_id),bidx=ids.indexOf(p.b_id);assert.equal((await api(6,'/pairs/'+p.id+'/respond','POST',{choice:'skip'})).http,404);
  await api(a,'/pairs/'+p.id+'/respond','POST',{choice:'like',wechat:'fixture_one',consent:true});assert.equal((await api(bidx)).pairs.find(x=>x.id===p.id).wechat,undefined);
  await api(bidx,'/pairs/'+p.id+'/respond','POST',{choice:'like',wechat:'fixture_two',consent:true});assert.equal((await api(a)).pairs.find(x=>x.id===p.id).wechat,'fixture_two');
  assert.equal((await api(6)).schedule.entries.find(e=>e.batch_key===batch).status,'published');assert.equal((await api(6)).quota_used,false);
  await buddy.tick();assert.equal((await db.query('SELECT COUNT(*) n FROM friend_card_pairs'))[0][0].n,3);
  await api(a,'/pairs/'+p.id+'/block','POST');assert.equal((await api(bidx)).pairs.length,0);
  clock=new Date('2026-11-01T16:00:00Z');assert.equal((await api(ids.indexOf(pairs[1].a_id))).pairs.length,0);assert.equal((await api(a)).quota_used,false);
  clock=new Date('2026-11-04T12:00:00Z');await buddy.tick();let auto=(await adm()).batches.find(x=>x.batch_key==='2026-11-02');assert.equal(auto.status,'preview');await adm('/2026-11-02/approve',{revision:auto.revision});clock=new Date('2026-11-05T12:00:00Z');await buddy.tick();assert.equal((await adm()).batches.find(x=>x.batch_key==='2026-11-02').status,'published');await buddy.tick();const [unique]=await db.query('SELECT account_id,week_key,COUNT(*) n FROM friend_account_weeks GROUP BY account_id,week_key');assert.ok(unique.every(x=>x.n===1));
  clock=new Date('2026-11-11T12:00:00Z');await buddy.tick();clock=new Date('2026-11-15T12:00:00Z');await buddy.tick();assert.equal((await adm()).batches.find(x=>x.batch_key==='2026-11-09').status,'missed');
  console.log('PASS: weekly auto enrollment, cutoff withdrawal, project soft preference, account quota, admin approval, stale plan re-review, concurrent publication, no immediate endpoint, privacy, next-week reset.');
 }finally{if(server)await new Promise(r=>server.close(r));const c=await real.getConnection();try{await c.query('SET FOREIGN_KEY_CHECKS=0');for(const name of [...names].reverse())await c.query('DROP TABLE IF EXISTS `'+prefix+name+'`');await c.query('SET FOREIGN_KEY_CHECKS=1');}finally{c.release();await real.end();}}
})().catch(e=>{console.error(e);process.exitCode=1;});
