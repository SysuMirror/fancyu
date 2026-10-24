'use strict';
const fs = require('fs');
const path = require('path');
const { CAMPUSES, GENDERS, GRADES, dayKey, ageAt, validateSettings, compatible, score } = require('./daily-rules');
const json = x => typeof x === 'string' ? JSON.parse(x) : x;
const sqlTime = d => d.toISOString().slice(0,19).replace('T',' ');
const plusDays = (d,n) => new Date(d.getTime()+n*86400000);

module.exports = function registerDaily(app,{ getPool, authMiddleware, adminAuthMiddleware, prepare = async()=>{}, observe = async()=>{}, invalidateWeekly=async()=>{},banWeekly=async()=>{}, now = () => new Date() }) {
    let ready;
    function ensureSchema() {
        if(!ready) ready=(async()=>{ const pool=await getPool();
            await prepare(pool);
            for(const sql of fs.readFileSync(path.join(__dirname,'daily-schema.sql'),'utf8').split(';').map(x=>x.trim()).filter(Boolean)) await pool.query(sql);
        })().catch(e=>{ready=null;throw e;});
        return ready;
    }
    async function transaction(fn) {
        await ensureSchema(); const pool=await getPool(),c=await pool.getConnection();
        try { await c.beginTransaction(); await c.query('SELECT id FROM daily_mutex WHERE id=1 FOR UPDATE');
            const time=now();
            await c.execute("UPDATE daily_pairs SET status='expired',low_wechat=NULL,high_wechat=NULL WHERE status='pending' AND expires_at<=?",[sqlTime(time)]);
            const result=await fn(c,time); await c.commit();return result;
        }catch(e){await c.rollback();throw e;}finally{c.release();}
    }
    const error = (code,message) => Object.assign(new Error(message),{status:code});
    const route = fn => async(req,res)=>{res.setHeader('Cache-Control','no-store');try{const data=await transaction((c,time)=>fn(req,c,time));res.json({code:200,...data});}catch(e){console.error('Daily:',e.status||e.code||e.name);res.status(e.status||503).json({code:e.status||503,msg:e.status?e.message:'配对服务暂时不可用，请稍后重试'});}};
    async function account(c,id) {
        const [rows]=await c.execute(`SELECT a.id,a.username,a.email,v.verified_at,s.enabled,s.banned,s.settings,
            p.profile_id FROM accounts a LEFT JOIN verified_students v ON v.account_id=a.id AND v.email=a.email
            LEFT JOIN daily_settings s ON s.account_id=a.id LEFT JOIN account_profiles p ON p.account_id=a.id WHERE a.id=?`,[id]);
        const a=rows[0];if(a?.settings)a.settings=json(a.settings);return a;
    }
    const eligible = a => !!(a?.verified_at && a.enabled && !a.banned && a.profile_id && a.settings?.single_adult_student && a.settings?.display_consent);
    async function requireVerified(c,id) {
        const a=await account(c,id);if(!a)throw error(401,'账号已失效，请重新登录');
        if(!a.verified_at)throw error(403,'请先验证学生邮箱');if(a.banned)throw error(403,'账号暂不能参与配对，请联系管理员');return a;
    }
    async function blocked(c,a,b) {
        const [r]=await c.execute('SELECT owner_id FROM daily_blocks WHERE (owner_id=? AND target_id=?) OR (owner_id=? AND target_id=?) LIMIT 1',[a,b,b,a]);return !!r.length;
    }
    async function weeklyConflict(c,a,b,time) {
        const [friendTables]=await c.query("SHOW TABLES LIKE 'friend_card_pairs'");
        if(friendTables.length){const [f]=await c.execute("SELECT id FROM friend_card_pairs WHERE ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?)) AND ((status='pending' AND week_key=?) OR status='connected' OR (a_agreed=1 AND b_agreed=1) OR created_at>?) LIMIT 1",[a,b,b,a,require('./friends-rules').weekKey(time),sqlTime(plusDays(time,-30))]);if(f.length)return true;}
        const [tables]=await c.query("SHOW TABLES LIKE 'weekly_match_pairs'");
        if(tables.length){const [w]=await c.execute("SELECT id FROM weekly_match_pairs WHERE ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?)) AND ((status='pending' AND expires_at>?) OR connected_at IS NOT NULL OR cooldown_until>?) LIMIT 1",[a,b,b,a,sqlTime(time),sqlTime(time)]);if(w.length)return true;}
        const [r]=await c.execute(`SELECT id FROM match_history WHERE ((account_id=? AND match_account_id=?) OR (account_id=? AND match_account_id=?))
            AND (contact_exchanged=1 OR created_at>?) LIMIT 1`,[a,b,b,a,sqlTime(plusDays(time,-3))]);return !!r.length;
    }
    async function pairVisible(c,p,id,time) {
        const other=p.low_id===id?p.high_id:p.low_id;
        const a=await account(c,id),b=await account(c,other);
        if(!a?.verified_at||!b?.verified_at||a.banned||b.banned||await blocked(c,id,other))return false;
        if(p.status==='connected')return true;
        return p.status==='pending'&&eligible(a)&&eligible(b)&&compatible(a.settings,b.settings,time)&&!await weeklyConflict(c,id,other,time);
    }
    async function publicCard(c,p,id,time) {
        if(!await pairVisible(c,p,id,time))return null;
        const other=p.low_id===id?p.high_id:p.low_id;
        const person=await account(c,other);
        const [rows]=await c.execute('SELECT profile_id,avatar,bio,tags,photos FROM account_profiles WHERE account_id=?',[other]);
        if(!rows.length)return null;
        const profile=rows[0], settings=person.settings;
        const [mine]=await c.execute('SELECT tags FROM account_profiles WHERE account_id=?',[id]);
        const common=(json(mine[0]?.tags)||[]).filter(x=>(json(profile.tags)||[]).includes(x)).slice(0,3);
        return {pair_id:p.id,status:p.status,my_choice:p.low_id===id?p.low_choice:p.high_choice,
            expires_at:p.status==='pending'? new Date(p.expires_at+'Z').toISOString():null,
            person:{id:profile.profile_id,avatar:profile.avatar,bio:profile.bio,tags:json(profile.tags),photos:json(profile.photos),
                age:ageAt(settings.birth_date,time),campus:settings.campus,grade:settings.grade,...(settings.show_gender?{gender:settings.gender}:{})},
            reason:common.length?'共同兴趣：'+common.join('、'):'双方的年龄、校区和性别偏好均符合',
            ...(p.status==='connected'?{wechat:p.low_id===id?p.high_wechat:p.low_wechat}: {})};
    }
    async function pairFor(c,id,pairId) {
        if(!Number.isSafeInteger(Number(pairId))||Number(pairId)<1)throw error(400,'配对编号无效');
        const [rows]=await c.execute(`SELECT p.*,DATE_FORMAT(p.expires_at,'%Y-%m-%dT%H:%i:%s') AS expires_at FROM daily_pairs p
            JOIN daily_days d ON d.pair_id=p.id AND d.account_id=? WHERE p.id=? AND (p.low_id=? OR p.high_id=?) LIMIT 1`,[id,pairId,id,id]);
        if(!rows.length)throw error(404,'这段配对已结束或不可访问');return rows[0];
    }
    app.get('/daily/state',authMiddleware,route(async(req,c,time)=>{
        const id=req.account.account_id,a=await account(c,id);
        if(!a)throw error(401,'请重新登录');
        const [days]=await c.execute('SELECT pair_id FROM daily_days WHERE account_id=? AND day_key=?',[id,dayKey(time)]);
        const [rows]=await c.execute(`SELECT DISTINCT p.*,DATE_FORMAT(p.expires_at,'%Y-%m-%dT%H:%i:%s') AS expires_at FROM daily_pairs p
            JOIN daily_days d ON d.pair_id=p.id AND d.account_id=? WHERE (p.low_id=? OR p.high_id=?) AND p.status IN ('pending','connected') ORDER BY p.id DESC`,[id,id,id]);
        const cards=[];if(a.verified_at&&!a.banned)for(const p of rows){const card=await publicCard(c,p,id,time);if(card)cards.push(card);}
        const [blocks]=await c.execute('SELECT target_id FROM daily_blocks WHERE owner_id=?',[id]);
        const [profile]=await c.execute('SELECT profile_id,avatar,bio,tags,photos FROM account_profiles WHERE account_id=?',[id]);
        return {date:dayKey(time),verified:!!a.verified_at,enabled:!!a.enabled,banned:!!a.banned,settings:a.settings||null,
            profile_ready:!!a.profile_id,preview:profile.length?{...profile[0],tags:json(profile[0].tags),photos:json(profile[0].photos)}:null,
            today_used:!!days.length,today_pair:days[0]?.pair_id||null,cards,blocks:blocks.map(x=>({target_id:x.target_id})),
            dictionaries:{campuses:CAMPUSES,genders:GENDERS,grades:GRADES}};
    }));
    app.put('/daily/settings',authMiddleware,route(async(req,c,time)=>{
        const id=req.account.account_id;const a=await requireVerified(c,id);
        if(!a.profile_id)throw error(400,'请先在我的主页保存主页 ID');
        let settings;try{settings=validateSettings(req.body,time);}catch(e){throw error(400,e.message);}
        await c.execute(`INSERT INTO daily_settings(account_id,enabled,settings,consent_version,updated_at) VALUES (?,1,?,'daily-v1',?)
            ON DUPLICATE KEY UPDATE enabled=1,settings=VALUES(settings),consent_version='daily-v1',updated_at=VALUES(updated_at)`,[id,JSON.stringify(settings),sqlTime(time)]);
        // Preferences/consent edits invalidate outstanding invitations rather than silently changing them.
        await c.execute("UPDATE daily_pairs SET status='cancelled',low_wechat=NULL,high_wechat=NULL WHERE (low_id=? OR high_id=?) AND status='pending'",[id,id]);
        return {msg:'已开启日常配对。资料修改后，旧的待处理邀请已结束；今日已用名额不重置。'};
    }));
    app.post('/daily/pause',authMiddleware,route(async(req,c)=>{
        const id=req.account.account_id;await c.execute('UPDATE daily_settings SET enabled=0 WHERE account_id=?',[id]);
        await c.execute("UPDATE daily_pairs SET status='cancelled',low_wechat=NULL,high_wechat=NULL WHERE (low_id=? OR high_id=?) AND status='pending'",[id,id]);
        return {msg:'已暂停日常配对，待处理邀请已结束，已有连接保留'};
    }));
    app.post('/daily/today',authMiddleware,route(async(req,c,time)=>{
        const id=req.account.account_id,a=await requireVerified(c,id);
        if(!eligible(a))throw error(400,'请先完善资料并开启日常配对');
        const day=dayKey(time);const [used]=await c.execute('SELECT pair_id FROM daily_days WHERE account_id=? AND day_key=?',[id,day]);
        if(used.length)return {msg:'今天的推荐已生成，请查看今日推荐',pair_id:used[0].pair_id};
        const [candidates]=await c.execute(`SELECT s.account_id,s.settings,p.tags,
            (SELECT COUNT(*) FROM daily_days d JOIN daily_pairs r ON r.id=d.pair_id WHERE (r.low_id=s.account_id OR r.high_id=s.account_id) AND d.account_id<>s.account_id AND d.day_key>=?) AS exposure
            FROM daily_settings s JOIN accounts a ON a.id=s.account_id JOIN verified_students v ON v.account_id=a.id AND v.email=a.email
            JOIN account_profiles p ON p.account_id=a.id WHERE s.enabled=1 AND s.banned=0 AND s.account_id<>?`,[dayKey(plusDays(time,-7)),id]);
        const [myRows]=await c.execute('SELECT tags FROM account_profiles WHERE account_id=?',[id]);const myTags=json(myRows[0]?.tags)||[];
        const choices=[];
        for(const row of candidates){
            const other=row.account_id,b=json(row.settings);if(!compatible(a.settings,b,time)||await blocked(c,id,other)||await weeklyConflict(c,id,other,time))continue;
            const low=Math.min(id,other),high=Math.max(id,other);
            const [past]=await c.execute("SELECT *,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%sZ') AS created_utc,cooldown_until>? AS cooling FROM daily_pairs WHERE low_id=? AND high_id=? ORDER BY id DESC",[sqlTime(time),low,high]);
            if(past.some(p=>['connected','closed','blocked'].includes(p.status)||p.cooling))continue;
            const pending=past.find(p=>p.status==='pending');
            if(pending){const [seen]=await c.execute('SELECT account_id FROM daily_days WHERE account_id=? AND pair_id=? LIMIT 1',[id,pending.id]);if(seen.length)continue;}
            // Never re-show cancelled/expired relations within the same 14-day window.
            if(!pending&&past.length&&new Date(past[0].created_utc).getTime()>time.getTime()-14*86400000)continue;
            choices.push({id:other,pending,priority:pending&&((id===low?pending.high_choice:pending.low_choice)==='like')?1:0,score:score(a.settings,b,myTags,json(row.tags)||[]),exposure:Number(row.exposure),tie:Math.random()});
        }
        choices.sort((a,b)=>b.priority-a.priority||b.score-a.score||a.exposure-b.exposure||a.tie-b.tie);
        if(!choices.length){await observe(c,{mode:'daily',accountId:id,unit:day,outcome:'empty',time});return {msg:'今天暂时没有合适的推荐，可稍后再来；不会占用今日名额',empty:true};}
        const choice=choices[0];let pairId=choice.pending?.id;
        if(!pairId){const [r]=await c.execute('INSERT INTO daily_pairs(low_id,high_id,created_at,expires_at) VALUES (?,?,?,?)',[Math.min(id,choice.id),Math.max(id,choice.id),sqlTime(time),sqlTime(plusDays(time,14))]);pairId=r.insertId;}
        await c.execute('INSERT INTO daily_days(account_id,day_key,pair_id) VALUES (?,?,?)',[id,day,pairId]);
        await observe(c,{mode:'daily',accountId:id,unit:day,outcome:'recommended',pairId,time});
        return {pair_id:pairId,msg:'今日推荐已准备好'};
    }));
    app.post('/daily/pairs/:id/respond',authMiddleware,route(async(req,c,time)=>{
        const id=req.account.account_id;await requireVerified(c,id);const p=await pairFor(c,id,req.params.id);
        if(!await pairVisible(c,p,id,time))throw error(409,'这段配对已结束或不可访问');
        if(p.status==='connected')return {msg:'你们已经建立连接'};
        const side=p.low_id===id?'low':'high',otherSide=side==='low'?'high':'low';
        if(p[side+'_choice']!=='pending')return {msg:'你的选择已记录，无需重复提交'};
        const {choice,wechat,consent}=req.body||{};
        if(!['like','skip'].includes(choice))throw error(400,'请选择想认识或跳过');
        if(choice==='skip'){
            await c.execute(`UPDATE daily_pairs SET ${side}_choice='skip',status='skipped',cooldown_until=?,low_wechat=NULL,high_wechat=NULL WHERE id=?`,[sqlTime(plusDays(time,30)),p.id]);
            return {msg:'已跳过，今天不再补配'};
        }
        if(consent!==true||typeof wechat!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{5,31}$/.test(wechat))throw error(400,'请填写有效微信号（6–32 位字母、数字、_、-），并授权双方确认后展示');
        await c.execute(`UPDATE daily_pairs SET ${side}_choice='like',${side}_wechat=? WHERE id=?`,[wechat,p.id]);
        if(p[otherSide+'_choice']==='like'){
            await c.execute("UPDATE daily_pairs SET status='connected',connected_at=? WHERE id=?",[sqlTime(time),p.id]);
            return {msg:'你们都想认识对方！请在我的连接查看联系方式'};
        }
        return {msg:'你的心意已记录；双方都愿意认识后才会展示微信'};
    }));
    app.post('/daily/pairs/:id/close',authMiddleware,route(async(req,c)=>{
        const p=await pairFor(c,req.account.account_id,req.params.id);
        await c.execute("UPDATE daily_pairs SET status='closed',low_wechat=NULL,high_wechat=NULL WHERE id=? AND status='connected'",[p.id]);
        return {msg:'连接已关闭，平台停止展示联系方式；无法收回对方已保存的信息'};
    }));
    app.post('/daily/pairs/:id/block',authMiddleware,route(async(req,c,time)=>{
        const id=req.account.account_id,p=await pairFor(c,id,req.params.id),other=p.low_id===id?p.high_id:p.low_id;
        await c.execute('INSERT IGNORE INTO daily_blocks(owner_id,target_id,created_at) VALUES (?,?,?)',[id,other,sqlTime(time)]);
        await invalidateWeekly(c,id,other);
        await c.execute("UPDATE daily_pairs SET status='blocked',low_wechat=NULL,high_wechat=NULL WHERE low_id=? AND high_id=? AND status IN ('pending','connected')",[Math.min(id,other),Math.max(id,other)]);
        await c.execute('DELETE FROM match_history WHERE (account_id=? AND match_account_id=?) OR (account_id=? AND match_account_id=?)',[id,other,other,id]);
        return {msg:'已屏蔽，双方不能再访问资料或联系方式'};
    }));
    app.delete('/daily/blocks/:id',authMiddleware,route(async(req,c)=>{
        if(!Number.isSafeInteger(Number(req.params.id))||Number(req.params.id)<1)throw error(400,'屏蔽编号无效');
        // Revoke friendship pairs before removing the shared block, so old access cannot revive.
        const [friendTables]=await c.query("SHOW TABLES LIKE 'friend_card_pairs'");
        if(friendTables.length)await c.execute("UPDATE friend_card_pairs SET status='blocked',a_wechat=NULL,b_wechat=NULL WHERE ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?)) AND status IN ('pending','connected')",[req.account.account_id,req.params.id,req.params.id,req.account.account_id]);
        await invalidateWeekly(c,req.account.account_id,Number(req.params.id));
        await c.execute('DELETE FROM daily_blocks WHERE owner_id=? AND target_id=?',[req.account.account_id,req.params.id]);
        // Keep old relationships ended. They are not restored on unblock.
        await c.execute("UPDATE daily_pairs SET status='cancelled' WHERE low_id=? AND high_id=? AND status='blocked'",[Math.min(req.account.account_id,Number(req.params.id)),Math.max(req.account.account_id,Number(req.params.id))]);
        return {msg:'屏蔽已解除，旧连接和邀请不会恢复'};
    }));
    app.post('/daily/pairs/:id/report',authMiddleware,route(async(req,c,time)=>{
        const p=await pairFor(c,req.account.account_id,req.params.id),reason=req.body?.reason;
        if(typeof reason!=='string'||reason.trim().length<2||reason.length>500)throw error(400,'请填写 2–500 字举报说明');
        const other=p.low_id===req.account.account_id?p.high_id:p.low_id;
        await c.execute(`INSERT INTO complaints(reporter_account_id,target_type,target_id,reason,description,status) VALUES (?,'user',?,?,?,'pending')`,[req.account.account_id,String(other),'日常配对举报',reason.trim()]);
        return {msg:'举报已提交至运营后台'};
    }));
    app.post('/admin/daily/accounts/:id/ban',adminAuthMiddleware,route(async(req,c)=>{
        const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw error(400,'账号无效');
        await banWeekly(c,id);await c.execute('UPDATE daily_settings SET banned=1,enabled=0 WHERE account_id=?',[id]);
        await c.execute("UPDATE daily_pairs SET status='cancelled',low_wechat=NULL,high_wechat=NULL WHERE (low_id=? OR high_id=?) AND status IN ('pending','connected')",[id,id]);
        return {msg:'已停止该账号参与日常配对并撤销连接访问'};
    }));
    return {ensureSchema,transaction,blocked,
        async weeklyGuard(c,a,b,time){const [r]=await c.execute(`SELECT id FROM daily_pairs WHERE low_id=? AND high_id=? AND (status IN ('pending','connected','closed') OR cooldown_until>?) LIMIT 1`,[Math.min(a,b),Math.max(a,b),sqlTime(time)]);return r.length>0||await blocked(c,a,b)||await weeklyConflict(c,a,b,time);}
    };
};
