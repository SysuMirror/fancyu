'use strict';
const {validateCard,compatible,score}=require('./friends-rules');
const solve=require('./buddy-solver');
const parse=x=>typeof x==='string'?JSON.parse(x):x;
const stamp=d=>d.toISOString().slice(0,19).replace('T',' ');
const pairKey=(a,b)=>[Math.min(a,b),Math.max(a,b)].join(':');
const fail=(status,msg)=>{throw Object.assign(Error(msg),{status});};
module.exports=async function recommend(c,card,week,time,solver=solve){
 const [rows]=await c.execute(`SELECT c.id,c.account_id,c.type,c.data,s.gender FROM friend_cards c JOIN accounts a ON a.id=c.account_id JOIN verified_students v ON v.account_id=a.id AND v.email=a.email LEFT JOIN friend_card_settings s ON s.account_id=a.id LEFT JOIN daily_settings d ON d.account_id=a.id WHERE c.enabled=1 AND c.deleted=0 AND COALESCE(d.banned,0)=0 AND NOT EXISTS(SELECT 1 FROM friend_account_weeks w WHERE w.account_id=c.account_id AND w.week_key=?) ORDER BY c.id`,[week]);
 const bans=new Set();const [banTables]=await c.query("SHOW TABLES LIKE 'weekly_match_bans'");if(banTables.length){const [bs]=await c.query('SELECT account_id FROM weekly_match_bans');for(const b of bs)bans.add(b.account_id);}
 const people=[];for(const r of rows.filter(r=>!bans.has(r.account_id))){try{people.push({id:r.id,account_id:r.account_id,...validateCard({type:r.type,v:parse(r.data)}),gender:r.gender||'不透露'});}catch{}}
 if(people.length>500)fail(409,'当前参与卡片超过算法容量，请稍后再试，本周额度未扣除');
 const blocked=new Set();
 for(const [sql,args]of [
  ['SELECT owner_id a,target_id b FROM daily_blocks',[]],
  ["SELECT a_id a,b_id b FROM friend_card_pairs WHERE week_key=? OR status='connected' OR (a_agreed=1 AND b_agreed=1) OR created_at>?",[week,stamp(new Date(+time-30*86400000))]],
  ["SELECT low_id a,high_id b FROM daily_pairs WHERE status IN ('pending','connected','closed','blocked') OR cooldown_until>?",[stamp(time)]],
  ['SELECT account_id a,match_account_id b FROM match_history WHERE contact_exchanged=1 OR created_at>?',[stamp(new Date(+time-72*3600000))]]
 ]){const [pairs]=await c.execute(sql,args);for(const p of pairs)blocked.add(pairKey(p.a,p.b));}
 const [tables]=await c.query("SHOW TABLES LIKE 'weekly_match_pairs'");if(tables.length){const [pairs]=await c.execute("SELECT a_id a,b_id b FROM weekly_match_pairs WHERE (status='pending' AND expires_at>?) OR connected_at IS NOT NULL OR cooldown_until>?",[stamp(time),stamp(time)]);for(const p of pairs)blocked.add(pairKey(p.a,p.b));}
 const requested=people.findIndex(p=>p.id===card.id);if(requested<0)return null;
 const edges=[],adj=people.map(()=>[]),owners=new Map();for(const p of people)if(!owners.has(p.account_id))owners.set(p.account_id,owners.size);
 for(let a=0;a<people.length;a++)for(let b=a+1;b<people.length;b++){const x=people[a],y=people[b];if((x.account_id===card.account_id&&x.id!==card.id)||(y.account_id===card.account_id&&y.id!==card.id))continue;if(blocked.has(pairKey(x.account_id,y.account_id))||!compatible(x,y))continue;edges.push({a,b,owners:pairKey(owners.get(x.account_id),owners.get(y.account_id)),score:score(x,y)});adj[a].push(b);adj[b].push(a);}
 if(!adj[requested].length)return null;
 // Account-pair constraints can link otherwise disjoint card components, so
 // solve the full graph, including all categories, as one constrained problem.
 if(edges.length>20000)fail(409,'当前候选组合超过算法容量，请稍后再试，本周额度未扣除');
 const chosen=await solver({n:people.length,edges,requested,accounts:people.map(p=>owners.get(p.account_id))});
 const valid=new Set(edges.map(e=>pairKey(e.a,e.b))),used=new Set(),ownerPairs=new Set(),usedAccounts=new Set();let other=null;
 for(const p of chosen){if(!Array.isArray(p)||p.length!==2)throw Error('invalid_buddy_solution');const [a,b]=p;if(!valid.has(pairKey(a,b))||used.has(a)||used.has(b))throw Error('invalid_buddy_solution');const k=pairKey(people[a].account_id,people[b].account_id);if(ownerPairs.has(k)||usedAccounts.has(people[a].account_id)||usedAccounts.has(people[b].account_id))throw Error('duplicate_buddy_owners');used.add(a);used.add(b);ownerPairs.add(k);usedAccounts.add(people[a].account_id);usedAccounts.add(people[b].account_id);if(a===requested||b===requested)other=people[a===requested?b:a];}
 return other;
};
