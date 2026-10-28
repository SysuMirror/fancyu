'use strict';
const fs = require('fs');
const path = require('path');
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
    async function blocked(c,a,b) {
        const [r]=await c.execute('SELECT owner_id FROM daily_blocks WHERE (owner_id=? AND target_id=?) OR (owner_id=? AND target_id=?) LIMIT 1',[a,b,b,a]);return !!r.length;
    }
    async function weeklyConflict(c,a,b,time) {
        if((await require('./deep-conflicts').pairs(c,time)).some(p=>(p.a===a&&p.b===b)||(p.a===b&&p.b===a)))return true;
        const [friendTables]=await c.query("SHOW TABLES LIKE 'friend_card_pairs'");
        if(friendTables.length){const [f]=await c.execute("SELECT id FROM friend_card_pairs WHERE ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?)) AND ((status='pending' AND week_key=?) OR status='connected' OR (a_agreed=1 AND b_agreed=1) OR created_at>?) LIMIT 1",[a,b,b,a,require('./friends-rules').weekKey(time),sqlTime(plusDays(time,-30))]);if(f.length)return true;}
        const [tables]=await c.query("SHOW TABLES LIKE 'weekly_match_pairs'");
        if(tables.length){const [w]=await c.execute("SELECT id FROM weekly_match_pairs WHERE ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?)) AND ((status='pending' AND expires_at>?) OR connected_at IS NOT NULL OR cooldown_until>?) LIMIT 1",[a,b,b,a,sqlTime(time),sqlTime(time)]);if(w.length)return true;}
        const [r]=await c.execute(`SELECT id FROM match_history WHERE ((account_id=? AND match_account_id=?) OR (account_id=? AND match_account_id=?))
            AND (contact_exchanged=1 OR created_at>?) LIMIT 1`,[a,b,b,a,sqlTime(plusDays(time,-3))]);return !!r.length;
    }
    return {ensureSchema,transaction,blocked,
        async weeklyGuard(c,a,b,time){const [r]=await c.execute(`SELECT id FROM daily_pairs WHERE low_id=? AND high_id=? AND (status IN ('connected','closed') OR cooldown_until>?) LIMIT 1`,[Math.min(a,b),Math.max(a,b),sqlTime(time)]);return r.length>0||await blocked(c,a,b)||await weeklyConflict(c,a,b,time);}
    };
};
