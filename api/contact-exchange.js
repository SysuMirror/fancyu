'use strict';
// 交换微信的唯一权威来源是 user_chat_exchange（聊天页写入）。
// 旧的 a_wechat/b_wechat 列被所有写路径置 NULL，只在缺失时作兜底。
async function exchangeState(c,{mode,pairId,id,other,legacy=null}){
 const state={mine:false,other:false,exchanged:false,wechat:null};
 const [tables]=await c.query("SHOW TABLES LIKE 'user_chat_exchange'");
 if(tables.length){
  const [rows]=await c.execute('SELECT account_id,wechat FROM user_chat_exchange WHERE mode=? AND pair_id=?',[mode,pairId]);
  const m=rows.find(x=>x.account_id===id),o=rows.find(x=>x.account_id===other);
  state.mine=!!m;state.other=!!o;
  if(m&&o){state.exchanged=true;state.wechat=o.wechat;return state;}
 }
 if(legacy){state.exchanged=true;state.wechat=legacy;}
 return state;
}
module.exports={exchangeState};
