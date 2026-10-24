const assert=require('assert/strict'),mysql=require('mysql2/promise'),crypto=require('crypto'),express=require('express');
(async()=>{
 const real=mysql.createPool({host:process.env.MYSQL_HOST,port:process.env.MYSQL_PORT,user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE,connectionLimit:8});
 const prefix='buddytest_'+crypto.randomBytes(5).toString('hex')+'_';
 const names=['accounts','account_profiles','verified_students','secure_email_codes','daily_mutex','daily_settings','daily_pairs','daily_days','daily_blocks','complaints','account_preferences','match_history','friend_card_settings','friend_cards','friend_card_pairs','friend_card_weeks','friend_account_weeks','weekly_match_pairs','weekly_match_bans'];
 const re=new RegExp('\\b('+names.join('|')+')\\b','g'),sql=s=>s.replace(re,x=>prefix+x);
 const wrap=c=>({query:(s,a)=>c.query(sql(s),a),execute:(s,a)=>c.execute(sql(s),a),beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release()});
 const db={...wrap(real),getConnection:async()=>wrap(await real.getConnection())};let server;
 try{
  for(const name of ['accounts','account_preferences','match_history','complaints','weekly_match_bans','weekly_match_pairs'])await real.query('CREATE TABLE `'+prefix+name+'` LIKE `'+name+'`');
  const ids=[],app=express();app.use(express.json());let clock=new Date('2026-10-27T12:00:00Z');
  const auth=(req,res,next)=>{const id=Number(req.headers['x-fixture']);if(!ids.includes(id))return res.status(401).json({code:401});req.account={account_id:id};next();};
  const daily=require('../daily')(app,{getPool:async()=>db,authMiddleware:auth,adminAuthMiddleware:auth,now:()=>clock});
  const studentVerification={verified:async(c,id)=>{const [r]=await c.execute('SELECT account_id FROM verified_students WHERE account_id=?',[id]);return !!r.length;}};
  const friends=require('../friends')(app,{getPool:async()=>db,authMiddleware:auth,daily,studentVerification,now:()=>clock});await friends.ensureSchema();
  for(let i=0;i<8;i++){const email='buddy'+i+'@example.invalid';const [r]=await db.execute('INSERT INTO accounts(email,username,password_hash) VALUES (?,?,?)',[email,'buddy'+i,'not-real']);ids.push(r.insertId);if(i!==7)await db.execute('INSERT INTO verified_students(account_id,email,verified_at) VALUES (?,?,?)',[r.insertId,email,'2026-10-27 10:00:00']);}
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/account/friends';
  async function api(i,path='',method='GET',body){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','x-fixture':String(ids[i]||0)},...(body?{body:JSON.stringify(body)}:{})});return {http:r.status,...await r.json()};}
  const value={type:'game',v:{item:'fixture_game',level:'一般',mic:'都行',time:['周末晚上'],gender:'不限',freq:'每周'}};
  const cs=[];for(let i=0;i<8;i++)cs.push((await api(i,'/cards','POST',{...value,v:{...value.v,item:i<4?'fixture_game':i<6?'fixture_pair':'fixture_empty'}})).id);
  const second=(await api(0,'/cards','POST',value)).id;
  assert.equal((await api(7,'/cards/'+cs[7]+'/toggle','POST',{enabled:true})).http,403);
  assert.equal((await api(6,'/cards/'+cs[6]+'/recommend','POST')).empty,true);assert.equal((await api(6)).quota_used,false);
  assert.equal((await api(1,'/cards/'+cs[0]+'/recommend','POST')).http,404);
  const requests=await Promise.all(Array.from({length:8},(_,i)=>api(0,'/cards/'+(i%2?second:cs[0])+'/recommend','POST')));
  assert.ok(requests.every(x=>x.code===200));assert.equal(new Set(requests.map(x=>x.pair_id)).size,1);const pair=requests[0].pair_id;assert.ok(pair);
  const [first]=await db.execute('SELECT * FROM friend_card_pairs WHERE id=?',[pair]);const partner=ids.indexOf(first[0].b_id),rest=[1,2,3].filter(x=>x!==partner);
  assert.ok((await api(0)).cards.every(x=>x.used));assert.equal((await api(partner)).quota_used,true);
  const next=await api(rest[0],'/cards/'+cs[rest[0]]+'/recommend','POST');assert.ok(next.pair_id);const [[counts]]=await db.query('SELECT COUNT(*) n FROM friend_card_pairs');assert.equal(counts.n,2);
  const [quotas]=await db.query('SELECT account_id,COUNT(*) n FROM friend_account_weeks GROUP BY account_id');assert.equal(quotas.length,4);assert.ok(quotas.every(x=>x.n===1));
  assert.equal((await api(6,'/pairs/'+pair+'/respond','POST',{choice:'skip'})).http,404);
  assert.equal((await api(0,'/pairs/'+pair+'/respond','POST',{choice:'like',wechat:'fixture_one',consent:false})).http,400);
  await api(0,'/pairs/'+pair+'/respond','POST',{choice:'like',wechat:'fixture_one',consent:true});assert.equal((await api(partner)).pairs[0].wechat,undefined);
  await api(partner,'/pairs/'+pair+'/respond','POST',{choice:'like',wechat:'fixture_two',consent:true});assert.equal((await api(0)).pairs[0].wechat,'fixture_two');
  await api(0,'/cards/'+first[0].a_card+'/toggle','POST',{enabled:false});assert.equal((await api(0)).pairs[0].status,'connected');
  await api(partner,'/pairs/'+pair+'/block','POST');assert.equal((await api(0)).pairs.length,0);await api(partner,'/blocks/'+ids[0],'DELETE');assert.equal((await api(0)).pairs.length,0);
  await api(0,'/cards/'+cs[0],'DELETE');const recreated=await api(0,'/cards','POST',value);assert.equal(recreated.id,cs[0]);assert.equal((await api(0)).quota_used,true);assert.equal((await api(0,'/cards/'+recreated.id+'/recommend','POST')).pair_id,pair);
  // Shared restrictions and block list are applied before any quota is spent.
  await db.execute('INSERT INTO weekly_match_bans(account_id) VALUES (?)',[ids[5]]);assert.equal((await api(4,'/cards/'+cs[4]+'/recommend','POST')).empty,true);await db.execute('DELETE FROM weekly_match_bans WHERE account_id=?',[ids[5]]);
  await db.execute('INSERT INTO daily_blocks(owner_id,target_id,created_at) VALUES (?,?,?)',[ids[4],ids[5],'2026-10-27 12:00:00']);assert.equal((await api(4,'/cards/'+cs[4]+'/recommend','POST')).empty,true);await db.execute('DELETE FROM daily_blocks WHERE owner_id=?',[ids[4]]);
  await db.execute("INSERT INTO weekly_match_pairs(batch_key,a_id,b_id,reasons,score_data,created_at,expires_at) VALUES ('2026-10-26',?,?,'[]','{}','2026-10-27 10:00:00','2026-10-30 10:00:00')",[ids[4],ids[5]]);assert.equal((await api(4,'/cards/'+cs[4]+'/recommend','POST')).empty,true);await db.query('DELETE FROM weekly_match_pairs');
  await db.execute("INSERT INTO daily_pairs(low_id,high_id,created_at,expires_at) VALUES (?,?,'2026-10-27 10:00:00','2026-10-30 10:00:00')",[ids[4],ids[5]]);assert.equal((await api(4,'/cards/'+cs[4]+'/recommend','POST')).empty,true);await db.query('DELETE FROM daily_pairs');
  const newPair=await api(4,'/cards/'+cs[4]+'/recommend','POST');assert.ok(newPair.pair_id);
  assert.equal(await daily.transaction(c=>daily.weeklyGuard(c,ids[4],ids[5],clock)),true);
  // Migration backfills old per-card records without replacing existing quota.
  await db.execute('DELETE FROM friend_account_weeks WHERE account_id=?',[ids[4]]);const fs=require('fs'),path=require('path');const migration=fs.readFileSync(path.join(__dirname,'../friends-schema.sql'),'utf8').split(';').find(x=>x.includes('INSERT IGNORE INTO friend_account_weeks'));await db.query(migration);assert.equal((await api(4)).quota_used,true);
  clock=new Date('2026-11-01T16:00:00Z');assert.equal((await api(4)).pairs.length,0);assert.equal((await api(4)).quota_used,false);assert.equal((await api(4,'/cards/'+cs[4]+'/recommend','POST')).empty,true);
  console.log('PASS: isolated DB account quota across cards/concurrency, both-side consumption, migration, verification, bans, block, privacy, deletion/recreation, next-week reset and 30-day dedup.');
 }finally{if(server)await new Promise(r=>server.close(r));const c=await real.getConnection();try{await c.query('SET FOREIGN_KEY_CHECKS=0');for(const name of [...names].reverse())await c.query('DROP TABLE IF EXISTS `'+prefix+name+'`');await c.query('SET FOREIGN_KEY_CHECKS=1');}finally{c.release();await real.end();}}
})().catch(e=>{console.error(e);process.exitCode=1;});
