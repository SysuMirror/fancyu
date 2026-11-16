'use strict';
// 交换联系方式的唯一权威来源是 user_chat_exchange（聊天页写入）。
// 2026-11 起该表多了 channel 列（微信/QQ/小红书/邮箱/其他），旧行默认微信。
// 旧的 a_wechat/b_wechat 列被所有写路径置 NULL，只在缺失时作兜底。
async function exchangeState(c,{mode,pairId,id,other,legacy=null}){
 const state={mine:false,other:false,exchanged:false,wechat:null,channel:null,value:null};
 const [tables]=await c.query("SHOW TABLES LIKE 'user_chat_exchange'");
 if(tables.length){
  let rows=[];
  try{const r=await c.execute('SELECT account_id,wechat,channel FROM user_chat_exchange WHERE mode=? AND pair_id=?',[mode,pairId]);rows=r[0];}
  catch(e){const r=await c.execute('SELECT account_id,wechat FROM user_chat_exchange WHERE mode=? AND pair_id=?',[mode,pairId]);rows=r[0];}
  const m=rows.find(x=>x.account_id===id),o=rows.find(x=>x.account_id===other);
  state.mine=!!m;state.other=!!o;
  if(m&&o){state.exchanged=true;state.channel=o.channel||'微信';state.value=o.wechat;state.wechat=(o.channel||'微信')==='微信'?o.wechat:null;return state;}
 }
 if(legacy){state.exchanged=true;state.channel='微信';state.value=legacy;state.wechat=legacy;}
 return state;
}
module.exports={exchangeState};
