const assert=require('assert/strict'),mysql=require('mysql2/promise'),crypto=require('crypto');
const create=require('../admin-analytics');
(async()=>{const pool=mysql.createPool({host:process.env.MYSQL_HOST,port:process.env.MYSQL_PORT,user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE});const a=create({getPool:async()=>pool});const ids=[];try{
 assert.equal(create.dateRange({start:'2026-10-21',end:'2026-10-21'},new Date('2026-10-22T00:00:00Z')).from,'2026-10-20 16:00:00');assert.throws(()=>create.dateRange({start:'2026-02-30'}));assert.equal(create.percent(0,0),null);
 const range=create.dateRange(),before=await a.summary(range);const prefix='overview_'+crypto.randomBytes(5).toString('hex');for(let i=0;i<2;i++){const [r]=await pool.execute('INSERT INTO accounts(email,username,password_hash) VALUES (?,?,?)',[prefix+i+'@example.invalid',prefix+i,'test-not-login']);ids.push(r.insertId);}
 for(const [x,y]of [[ids[0],ids[1]],[ids[1],ids[0]]])await pool.execute("INSERT INTO match_history(account_id,match_account_id,survey_type,match_round,contact_exchanged,created_at) VALUES (?,?,'love',999999,1,UTC_TIMESTAMP())",[x,y]);
 const unit='test-unit';await a.observe(pool,{mode:'daily',accountId:ids[0],unit,outcome:'empty'});await a.observe(pool,{mode:'daily',accountId:ids[0],unit,outcome:'empty'});await a.observe(pool,{mode:'daily',accountId:ids[0],unit,outcome:'recommended',pairId:999999});await a.observe(pool,{mode:'daily',accountId:ids[0],unit,outcome:'empty'});
 const after=await a.summary(range);assert.equal(after.totals.accounts,before.totals.accounts+2);assert.equal(after.modes.find(x=>x.key==='weekly').pairs,before.modes.find(x=>x.key==='weekly').pairs+1);assert.equal(after.modes.find(x=>x.key==='weekly').connected,before.modes.find(x=>x.key==='weekly').connected+1);
 const [r]=await pool.execute('SELECT outcome FROM recommendation_observations WHERE account_id=?',[ids[0]]);assert.equal(r.length,1);assert.equal(r[0].outcome,'recommended');assert.equal(after.trend.length,30);assert.ok(!JSON.stringify(after).includes(prefix));
 // 本批新增面板：key 存在、日期序列补零、且只出聚合（不含任何联系方式/正文）
 assert.equal(after.activity_trend.length,30);for(const row of after.activity_trend){assert.deepEqual(Object.keys(row).sort(),['day','logins','senders']);assert.equal(typeof row.logins,'number');assert.equal(typeof row.senders,'number');}
 for(const k of ['messages','senders','conversations','exchanges'])assert.equal(typeof after.chat_ops[k],'number');
 assert.ok(Array.isArray(after.chat_ops.by_mode));for(const row of after.chat_ops.by_mode)assert.deepEqual(Object.keys(row).sort(),['conversations','messages','mode','senders']);
 assert.equal(after.report_ops.pending_total,before.totals.pending_reports);assert.ok(Array.isArray(after.report_ops.by_status));assert.ok(Array.isArray(after.report_ops.top_targets));
 for(const row of after.report_ops.top_targets)for(const k of Object.keys(row))assert.ok(['target_id','username','count'].includes(k));
 for(const k of ['total_accounts','with_invite_code','invited_accounts','active_inviters','period_registered','period_invited','period_organic'])assert.equal(typeof after.invite[k],'number');
 assert.equal(after.invite.trend.length,30);for(const row of after.invite.trend)assert.deepEqual(Object.keys(row).sort(),['day','invited','organic']);
 assert.ok(Array.isArray(after.invite.top_inviters));for(const row of after.invite.top_inviters)for(const k of Object.keys(row))assert.ok(['account_id','username','count'].includes(k));
 // 聚合口径：趋势/聊天面板里不允许出现邮箱之类长文本；举报/邀请榜单只允许「编号 + 用户名 + 计数」
 const walk=(v,fn)=>{if(Array.isArray(v))return v.forEach(x=>walk(x,fn));if(v&&typeof v==='object')return Object.values(v).forEach(x=>walk(x,fn));fn(v);};
 for(const blob of [after.activity_trend,after.chat_ops])walk(blob,v=>{if(typeof v==='string')assert.ok(v.length<=20&&!v.includes('@')&&!v.includes(':'),'aggregate panel leaked a free-text field');});
 for(const row of [...after.report_ops.top_targets,...after.invite.top_inviters])for(const k of Object.keys(row))assert.ok(['target_id','username','account_id','count'].includes(k),'top list leaked a contact field');
 console.log('PASS: real database aggregation, bilateral result deduplication, timezone/date validation, zero denominator, recommendation deduplication, aggregate-only response, new panels (activity/chat/report/invite) structured and aggregate-only.');
 }finally{for(const id of ids){await pool.execute('DELETE FROM match_history WHERE account_id=? OR match_account_id=?',[id,id]);await pool.execute('DELETE FROM accounts WHERE id=?',[id]);}await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
