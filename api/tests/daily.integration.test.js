'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto');
test('daily matching quotas, mutual consent, access revocation, expiry, verification and cleanup',{skip:process.env.DAILY_INTEGRATION_TEST!=='1'},async()=>{
 const express=require('express'),mysql=require('mysql2/promise'),bcrypt=require('bcryptjs');
 const pool=mysql.createPool({host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT||3306),user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE,connectionLimit:5,timezone:'Z'});
 const run='dt'+crypto.randomBytes(5).toString('hex'),ids=[],emails=[],sent=[];let server,time=new Date('2026-09-27T08:00:00Z');
 // Restrict the recommendation query to fixture accounts without changing production logic.
 const fixturePool={query:(...args)=>pool.query(...args),getConnection:async()=>{const c=await pool.getConnection(),execute=c.execute.bind(c);c.execute=(sql,params)=>{
    if(sql.includes('FROM daily_settings s JOIN accounts a'))sql+=' AND s.account_id IN ('+ids.map(()=>'?').join(',')+')',params=[...params,...ids];return execute(sql,params);
 };const release=c.release.bind(c);c.release=()=>{c.execute=execute;release();};return c;}};
 const app=express();app.use(express.json({limit:'4mb'}));
 const auth=(req,res,next)=>{const id=Number(req.headers.authorization?.replace('Bearer ',''));if(!ids.includes(id))return res.status(401).json({code:401});req.account={account_id:id};next();};
 const daily=require('../daily')(app,{getPool:async()=>fixturePool,authMiddleware:auth,adminAuthMiddleware:(req,res,next)=>req.headers['x-test-admin']==='yes'?next():res.status(401).json({code:401}),now:()=>time});
 const secure=require('../secure-auth')(app,{getPool:async()=>pool,generateToken:a=>'test-'+a.id,authMiddleware:auth,transporter:{sendMail:async m=>sent.push(m)},emailConfigured:true,from:'test@example.invalid',ensureSchema:daily.ensureSchema,secret:crypto.randomBytes(32).toString('hex')});
 const {CAMPUSES}=require('../daily-rules');
 const settings={birth_date:'2004-01-01',gender:'非二元',show_gender:false,campus:CAMPUSES[3],grade:'大三',genders:['非二元'],campuses:[CAMPUSES[3]],min_age:18,max_age:30,schedule:'不固定',pace:'慢慢熟悉',single_adult_student:true,display_consent:true};
 async function request(i,path,method='GET',body,headers={}){const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{Authorization:'Bearer '+(ids[i]||0),'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json()};}
 const state=i=>request(i,'/daily/state');
 const draw=i=>request(i,'/daily/today','POST',{});
 const respond=(i,pair,choice='like')=>request(i,'/daily/pairs/'+pair+'/respond','POST',{choice,wechat:'test_wechat_'+i,consent:true});
 async function clearRelations(){for(const id of ids){await pool.execute('DELETE FROM daily_days WHERE account_id=?',[id]);await pool.execute('DELETE FROM daily_pairs WHERE low_id=? OR high_id=?',[id,id]);await pool.execute('DELETE FROM daily_blocks WHERE owner_id=? OR target_id=?',[id,id]);await pool.execute('DELETE FROM match_history WHERE account_id=? OR match_account_id=?',[id,id]);}await pool.query('UPDATE daily_settings SET enabled=1,banned=0 WHERE account_id IN ('+ids.map(()=>'?').join(',')+')',ids);time=new Date('2026-09-27T08:00:00Z');}
 try{
  await daily.ensureSchema();
  for(let i=0;i<4;i++){const email=run+i+'@mail2.sysu.edu.cn';emails.push(email);const [r]=await pool.execute('INSERT INTO accounts(email,username,password_hash) VALUES (?,?,?)',[email,run+i,await bcrypt.hash('secure_test_password',4)]);ids.push(r.insertId);
   await pool.execute('INSERT INTO account_profiles(account_id,profile_id,avatar,bio,tags,photos) VALUES (?,?,?, ?,?,?)',[r.insertId,run+i,'','真实简介','["摄影"]','[]']);}
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  assert.equal((await state(-1)).status,401);assert.equal((await state(0)).verified,false);
  assert.equal((await request(0,'/daily/settings','PUT',settings)).status,403);
  assert.equal((await request(0,'/account/login','POST',{login:emails[0],password:'wrong'})).status,401);
  assert.equal((await request(0,'/account/login','POST',{login:emails[0],password:'secure_test_password'})).status,200);
  assert.equal((await request(0,'/daily/verification/send','POST',{})).status,200);
  assert.equal((await request(0,'/daily/verification/send','POST',{})).status,429);
  const code=sent[0].text.match(/\d{6}/)[0];
  assert.equal((await request(0,'/daily/verification/confirm','POST',{code:'000000'})).status,400);
  assert.equal((await request(0,'/daily/verification/confirm','POST',{code})).status,200);
  assert.equal((await request(0,'/daily/verification/confirm','POST',{code})).status,400);
  for(let i=1;i<3;i++)await pool.execute('INSERT INTO verified_students(account_id,email,verified_at) VALUES (?,?,UTC_TIMESTAMP())',[ids[i],emails[i]]);
  for(let i=0;i<3;i++)assert.equal((await request(i,'/daily/settings','PUT',settings)).status,200);
  await pool.execute('UPDATE daily_settings SET enabled=0 WHERE account_id=?',[ids[2]]);
  const results=await Promise.all(Array.from({length:8},()=>draw(0)));assert.ok(results.every(r=>r.status===200));assert.equal(new Set(results.map(r=>r.pair_id)).size,1);const pair=results[0].pair_id;
  const first=await state(0);assert.equal(first.today_used,true);assert.equal(first.cards.length,1);assert.equal(first.cards[0].person.id,run+'1');
  assert.equal(first.cards[0].person.email,undefined);assert.equal(first.cards[0].person.birth_date,undefined);assert.equal(first.cards[0].person.gender,undefined);assert.equal(first.cards[0].wechat,undefined);
  assert.equal((await state(1)).cards.length,0);assert.equal((await respond(1,pair)).status,404);assert.equal((await respond(2,pair)).status,404);
  assert.equal((await respond(0,pair)).status,200);assert.equal((await state(0)).cards[0].wechat,undefined);
  assert.equal((await draw(1)).pair_id,pair);assert.equal((await state(1)).cards[0].my_choice,'pending');assert.equal((await state(1)).cards[0].other_choice,undefined);
  assert.equal((await request(1,'/daily/pairs/'+pair+'/respond','POST',{choice:'like',wechat:'test_wechat_1',consent:false})).status,400);
  await respond(1,pair);assert.equal((await state(0)).cards[0].wechat,'test_wechat_1');assert.equal((await state(1)).cards[0].wechat,'test_wechat_0');
  assert.equal(await daily.transaction((c,t)=>daily.weeklyGuard(c,ids[0],ids[1],t)),true);
  await pool.execute('UPDATE account_profiles SET bio=?,photos=? WHERE account_id=?',['更新后的简介','[]',ids[1]]);assert.equal((await state(0)).cards[0].person.bio,'更新后的简介');
  await request(0,'/daily/pause','POST',{});assert.equal((await state(0)).cards[0].status,'connected');
  await request(0,'/daily/pairs/'+pair+'/report','POST',{reason:'测试举报，请忽略'});
  const [reports]=await pool.execute('SELECT id FROM complaints WHERE reporter_account_id=?',[ids[0]]);assert.equal(reports.length,1);
  await request(0,'/daily/pairs/'+pair+'/block','POST',{});assert.equal((await state(0)).cards.length,0);assert.equal((await state(1)).cards.length,0);assert.equal((await respond(1,pair)).status,409);
  await request(0,'/daily/blocks/'+ids[1],'DELETE');assert.equal((await state(1)).cards.length,0);
  // A skip is idempotent, retains the daily quota and enforces a full 30-day cooldown.
  await clearRelations();await pool.execute('UPDATE daily_settings SET enabled=0 WHERE account_id=?',[ids[2]]);
  const skipped=(await draw(0)).pair_id;await respond(0,skipped,'skip');assert.equal((await draw(0)).pair_id,skipped);time=new Date('2026-09-28T08:00:00Z');assert.equal((await draw(0)).empty,true);assert.equal((await state(0)).today_used,false);
  time=new Date('2026-10-28T08:00:00Z');assert.ok((await draw(0)).pair_id);
  // Mutual hard preferences are rechecked on write and revoke pending access.
  await clearRelations();await pool.execute('UPDATE daily_settings SET enabled=0 WHERE account_id=?',[ids[2]]);
  const changed=(await draw(0)).pair_id;await request(1,'/daily/settings','PUT',{...settings,genders:['男']});assert.equal((await state(0)).cards.length,0);assert.equal((await respond(0,changed)).status,409);
  await request(1,'/daily/settings','PUT',settings);await clearRelations();await pool.execute('UPDATE daily_settings SET enabled=0 WHERE account_id=?',[ids[2]]);
  const expired=(await draw(0)).pair_id;time=new Date('2026-10-12T08:00:00Z');assert.equal((await state(0)).cards.length,0);assert.equal((await respond(0,expired)).status,409);
  // Beijing midnight changes quota; no candidate does not consume it.
  await clearRelations();time=new Date('2026-09-27T15:59:59Z');await draw(0);time=new Date('2026-09-27T16:00:00Z');assert.equal((await state(0)).today_used,false);assert.ok((await draw(0)).pair_id);
  await clearRelations();await pool.execute('UPDATE daily_settings SET enabled=0 WHERE account_id=?',[ids[2]]);
  await pool.execute("INSERT INTO match_history(account_id,match_account_id,survey_type,match_round,match_data,contact_exchanged) VALUES (?,?,'love',1,'{}',1)",[ids[0],ids[1]]);assert.equal((await draw(0)).empty,true);
  await clearRelations();const banPair=(await draw(0)).pair_id;const other=(await state(0)).cards[0].person.id.endsWith('1')?1:2;
  assert.equal((await request(0,'/admin/daily/accounts/'+ids[other]+'/ban','POST',{})).status,401);
  assert.equal((await request(0,'/admin/daily/accounts/'+ids[other]+'/ban','POST',{}, {'x-test-admin':'yes'})).status,200);assert.equal((await state(0)).cards.length,0);assert.equal((await respond(0,banPair)).status,409);
  await pool.execute('DELETE FROM accounts WHERE id=?',[ids[0]]);assert.equal((await state(0)).status,401);
 }finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  for(const id of ids){await pool.execute('DELETE FROM complaints WHERE reporter_account_id=?',[id]);await pool.execute('DELETE FROM match_history WHERE account_id=? OR match_account_id=?',[id,id]);await pool.execute('DELETE FROM accounts WHERE id=?',[id]);}
  for(const email of emails)await pool.execute('DELETE FROM secure_email_codes WHERE email=?',[email]);await pool.end();
 }
});
