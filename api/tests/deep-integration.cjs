const assert=require('assert/strict'),mysql=require('mysql2/promise'),crypto=require('crypto'),express=require('express');
(async()=>{
 const real=mysql.createPool({host:process.env.MYSQL_HOST,port:process.env.MYSQL_PORT,user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE,connectionLimit:8});
 const prefix='buddytest_'+crypto.randomBytes(5).toString('hex')+'_';
 const names=['accounts','account_profiles','verified_students','secure_email_codes','daily_mutex','daily_settings','daily_pairs','daily_days','daily_blocks','complaints','account_preferences','match_history','friend_card_settings','friend_cards','friend_card_pairs','friend_card_weeks','friend_account_weeks','weekly_match_pairs','weekly_match_bans','buddy_batches','buddy_entries','deep_surveys','deep_batches','deep_entries','deep_pairs','deep_slots','friend_survey'];
 const re=new RegExp('\\b('+names.join('|')+')\\b','g'),sql=s=>s.replace(re,x=>prefix+x);
 const wrap=c=>({query:(s,a)=>c.query(sql(s),a),execute:(s,a)=>c.execute(sql(s),a),beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release()});
 const db={...wrap(real),getConnection:async()=>wrap(await real.getConnection())};let server;
 try{
  for(const name of ['accounts','account_preferences','match_history','complaints','weekly_match_bans','weekly_match_pairs','friend_survey','friend_card_pairs'])await real.query('CREATE TABLE `'+prefix+name+'` LIKE `'+name+'`');
  let clock=new Date('2026-10-27T12:00:00Z');const app=express(),ids=[];app.use(express.json());const {fixture}=require('./deep-rules.test');
  const auth=(req,res,next)=>{const id=Number(req.headers['x-fixture']);if(!ids.includes(id))return res.status(401).json({code:401});req.account={account_id:id};next();};
  const admin=(req,res,next)=>{if(req.headers['x-admin']!=='yes')return res.status(401).json({code:401});req.admin={username:'fixture'};next();};
  const daily=require('../daily')(app,{getPool:async()=>db,authMiddleware:auth,adminAuthMiddleware:admin,now:()=>clock});
  const source=require('fs').readFileSync(require('path').join(__dirname,'../index.js'),'utf8');const start=source.indexOf('async function saveFriendSurveyData'),end=source.indexOf('// ==================== 发送邮件',start);
  const saveLegacy=Function('containsSensitiveWords','cleanDisplaySelf','crypto','getPool',source.slice(start,end)+';return saveFriendSurveyData;')(()=>false,x=>JSON.stringify(x),crypto,async()=>db);
  const deep=require('../deep-match')(app,{getPool:async()=>db,authMiddleware:auth,adminAuthMiddleware:admin,daily,saveLegacy,now:()=>clock});await deep.ensureSchema();
  for(let i=0;i<6;i++){const email='deep'+i+'@example.invalid';const [r]=await db.execute('INSERT INTO accounts(email,username,password_hash) VALUES (?,?,?)',[email,'deep'+i,'not-real']);ids.push(r.insertId);if(i!==5)await db.execute('INSERT INTO verified_students(account_id,email,verified_at) VALUES (?,?,?)',[r.insertId,email,'2026-10-27 10:00:00']);await db.execute('INSERT INTO account_preferences(account_id,join_friend_matching) VALUES (?,0)',[r.insertId]);}
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  async function api(path,i=0,method='GET',body,adm=false){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','x-fixture':String(ids[i]||0),...(adm?{'x-admin':'yes'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {http:r.status,...await r.json()};}
  const root='/account/deep-match',toggle='/account/toggle-friend-matching',ad='/admin/deep-batches/2026-10-26';
  assert.equal((await api('/admin/deep-batches')).http,401);assert.equal((await api(toggle,0,'POST',{join_friend_matching:true})).http,400);
  for(let i=0;i<6;i++){const f=fixture();f.display_self=['兴趣爱好'];const saved=await api('/account/deep-survey',i,'PUT',f);assert.equal(saved.http,200,JSON.stringify(saved));}
  assert.equal((await api(toggle,5,'POST',{join_friend_matching:true})).http,403);
  for(let i=0;i<5;i++)assert.equal((await api(toggle,i,'POST',{join_friend_matching:true})).http,200);
  const loaded=await api('/account/deep-survey');assert.deepEqual(loaded.data.sex_prefer,['不限']);assert.equal(loaded.data.personality_self_1,3);assert.equal(loaded.data.contact_entries[0].method,'微信');assert.equal((await db.query('SELECT COUNT(*) n FROM friend_survey'))[0][0].n,6);
  assert.equal((await api(ad+'/preview',0,'POST',{},true)).http,409);clock=new Date('2026-10-28T12:00:00Z');await deep.tick();let b=(await api('/admin/deep-batches',0,'GET',null,true)).batches.find(x=>x.batch_key==='2026-10-26');assert.equal(b.stats.pairs,2);assert.equal((await api(root)).pairs.length,0);
  await api(ad+'/approve',0,'POST',{revision:b.revision},true);assert.equal((await api(ad+'/publish',0,'POST',{},true)).http,409);
  // Actual survey update after cutoff withdraws the participant and updates next week.
  const changed=fixture();changed.self_description='new';await api('/account/deep-survey',4,'PUT',changed);
  const e=(await api(root,4)).schedule.entries;assert.equal(e.find(x=>x.batch_key==='2026-10-26').active,0);assert.equal(e.find(x=>x.batch_key==='2026-11-02').active,1);
  clock=new Date('2026-10-29T12:00:00Z');assert.equal((await api(ad+'/publish',0,'POST',{},true)).needs_review,true);b=(await api('/admin/deep-batches',0,'GET',null,true)).batches.find(x=>x.batch_key==='2026-10-26');await api(ad+'/approve',0,'POST',{revision:b.revision},true);await deep.tick();
  const [pairs]=await db.query('SELECT * FROM deep_pairs');assert.equal(pairs.length,2);await deep.tick();assert.equal((await db.query('SELECT COUNT(*) n FROM deep_pairs'))[0][0].n,2);
  const p=pairs[0],a=ids.indexOf(p.a_id),z=ids.indexOf(p.b_id);let view=(await api(root,a)).pairs[0];assert.deepEqual(Object.keys(view.person).sort(),['interests','name']);assert.ok(!JSON.stringify(view).includes('fixture_contact'));assert.equal(view.wechat,undefined);
  assert.equal((await api(root+'/pairs/'+p.id+'/respond',4,'POST',{choice:'skip'})).http,404);
  await api(root+'/pairs/'+p.id+'/respond',a,'POST',{choice:'like',wechat:'fixture_one',consent:true});assert.equal((await api(root,z)).pairs[0].wechat,undefined);await api(root+'/pairs/'+p.id+'/respond',z,'POST',{choice:'like',wechat:'fixture_two',consent:true});assert.equal((await api(root,a)).pairs[0].wechat,'fixture_two');
  const privacy=fixture();privacy.display_self=['基础背景'];await api('/account/deep-survey',z,'PUT',privacy);const revised=(await api(root,a)).pairs[0];assert.equal(revised.person.interests,undefined);assert.equal(revised.person.school,'中山大学');
  await api(toggle,a,'POST',{join_friend_matching:false});assert.equal((await api(root,a)).pairs[0].status,'connected');await api(root+'/pairs/'+p.id+'/block',a,'POST',{});assert.equal((await api(root,z)).pairs.length,0);
  assert.equal(await daily.transaction(c=>daily.weeklyGuard(c,pairs[1].a_id,pairs[1].b_id,clock)),true);
  clock=new Date('2026-11-01T16:00:00Z');await deep.tick();assert.equal((await api(root,ids.indexOf(pairs[1].a_id))).pairs.length,0);
  console.log('PASS: actual legacy+complete JSON save, eligibility, preferences, cutoff withdrawal, admin approval, automatic publication, unique quota, field-level privacy, mutual contact consent, pause/block, cross-mode exclusion, expiry.');
 }finally{if(server)await new Promise(r=>server.close(r));const c=await real.getConnection();try{await c.query('SET FOREIGN_KEY_CHECKS=0');for(const name of [...names].reverse())await c.query('DROP TABLE IF EXISTS `'+prefix+name+'`');await c.query('SET FOREIGN_KEY_CHECKS=1');}finally{c.release();await real.end();}}
})().catch(e=>{console.error(e);process.exitCode=1;});
