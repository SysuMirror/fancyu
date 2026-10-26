'use strict';
const {weekKey}=require('./friends-rules');
exports.pairs=async(c,time)=>{const [tables]=await c.query("SHOW TABLES LIKE 'deep_pairs'");if(!tables.length)return [];const since=new Date(+time-30*86400000).toISOString().slice(0,19).replace('T',' ');const [rows]=await c.execute("SELECT a_id a,b_id b FROM deep_pairs WHERE (status='pending' AND week_key=?) OR status='connected' OR (a_agreed=1 AND b_agreed=1) OR created_at>?",[weekKey(time),since]);return rows;};
exports.invalidate=async(c,a,b)=>{const [tables]=await c.query("SHOW TABLES LIKE 'deep_pairs'");if(tables.length)await c.execute("UPDATE deep_pairs SET status='blocked',a_wechat=NULL,b_wechat=NULL WHERE ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?)) AND status IN ('pending','connected')",[a,b,b,a]);};
