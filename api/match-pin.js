'use strict';
// 「匹配拓扑图 + 管理员指定配对」共用逻辑层（love / deep / buddy 三条线共享）。
//
//  - 图谱与 build()/pool() 同源（候选边现算，不落库），只下发后台本来就可见的展示字段
//    （用户名 / 头像 / 校区 / 院系 / 分数 / 状态），**绝不下发问卷答案、邮箱、联系方式**；
//  - 人工 pin 只写进当前批次的 plan JSON：不建 pair 行、不发通知、**不改指纹**；
//  - build() 重算（自动预览、以及 publish 的 needs_review 分支）会整体覆盖 plan，所以
//    用 reapplyPins() 按 account_id 重新定位并重跑守卫（人不在池 / 中途出现屏蔽 / 已不合规
//    → 丢弃），丢弃项一律记进 stats.manual_dropped，绝不静默。
//
// 三线的 plan 元素语义不同（这是本功能最容易写错的地方）：
//   love  = {a:账号id, b:账号id, ...evaluate 展开}          （a/b 就是 account_id）
//   deep  = {a:people[i].id, b:people[j].id, a_id, b_id, score}（people[i].id == account_id）
//   buddy = {a:people[i].id(card id), b:..., a_id, b_id, score}（people[i].id 是 card id）
// ⇒ 一律用 `item.a_id ?? item.a` 归一成 account_id 来定位，绝不复用旧值当新 a/b。

const fail = (status, msg) => { throw Object.assign(Error(msg), { status }); };
const pairKey = (a, b) => [Math.min(a, b), Math.max(a, b)].join(':');
const positiveInt = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };

/* ---------- 节点展示信息（后台本来就可见的那部分） ---------- */
// 单查询取用户名 + 头像（避免每人一次 execute）；表缺失时退化为只有用户名。
async function loadNodes(c, ids) {
  const map = new Map();
  const list = [...new Set(ids.map(Number).filter(Boolean))];
  if (!list.length) return map;
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500), ph = part.map(() => '?').join(',');
    let rows;
    try {
      [rows] = await c.query(`SELECT a.id,a.username,(SELECT u.id FROM user_uploads u WHERE u.account_id=a.id AND u.scope='avatar' ORDER BY u.id DESC LIMIT 1) av FROM accounts a WHERE a.id IN (${ph})`, part);
    } catch (e) {
      [rows] = await c.query(`SELECT a.id,a.username FROM accounts a WHERE a.id IN (${ph})`, part);
    }
    for (const r of rows) map.set(Number(r.id), { username: r.username || ('#' + r.id), avatar: r.av ? '/api/account/avatar/' + r.id + '?v=' + r.av : '' });
  }
  return map;
}

/* ---------- 图响应装配 ---------- */
// 只透出计数类 stats 与已归一化的 plan（{a,b,a_id,b_id,manual}）；边超过上限按分数降序截断并如实标注。
function graphPayload({ key, line, status, revision, nodes, edges, plan, stats, edgeCap = 20000, nodeCap = 800 }) {
  let list = Array.isArray(edges) ? edges : [], omitted = 0, nodesOut = Array.isArray(nodes) ? nodes : [];
  if (list.length > edgeCap) { list = list.slice().sort((x, y) => (Number(y.score) || 0) - (Number(x.score) || 0)).slice(0, edgeCap); omitted = edges.length - edgeCap; }
  let nodesTruncated = 0;
  if (nodesOut.length > nodeCap) { nodesTruncated = nodesOut.length - nodeCap; nodesOut = nodesOut.slice(0, nodeCap); }
  const kept = new Set(nodesOut.map(n => n.id));
  if (nodesTruncated) list = list.filter(e => kept.has(e.a) && kept.has(e.b));
  return {
    key, line, status, revision: Number(revision) || 0,
    nodes: nodesOut, edges: list,
    plan: (Array.isArray(plan) ? plan : []).map(p => ({ a: p.a, b: p.b, a_id: p.a_id ?? p.a, b_id: p.b_id ?? p.b, manual: !!p.manual, by: p.by || null, score: Number(p.score) || 0 })),
    stats: stats || null,
    truncated: { edges: !!omitted, nodes: !!nodesTruncated, omitted },
    manual_dropped: (stats && stats.manual_dropped) || [],
    canPin: status === 'preview'
  };
}

/* ---------- 人工 pin 的收集 / 应用 / 撤销 ---------- */
// 把上一版 plan 里 manual:true 的项归一成 {a_id,b_id,by}
function collectPins(plan) {
  const out = [];
  for (const p of Array.isArray(plan) ? plan : []) {
    if (!p || !p.manual) continue;
    const a_id = positiveInt(p.a_id ?? p.a), b_id = positiveInt(p.b_id ?? p.b);
    if (a_id && b_id && a_id !== b_id) out.push({ a_id, b_id, by: p.by || null });
  }
  return out;
}
// 把一条 pin 写进 plan：先剔除任何碰到这两人的项（自动或人工），再 append。
function applyPin({ plan, i, j, ad, a_id, b_id, sc, by }) {
  const src = Array.isArray(plan) ? plan : [];
  const kept = src.filter(p => !ad.owns(p, a_id) && !ad.owns(p, b_id));
  const removed = src.length - kept.length;
  kept.push({ ...ad.item(i, j, sc), manual: true, by: by || null });
  return { plan: kept, removed };
}
// 与 applyPin 同款过滤（不追加），用于「撤销指定配对」
function dropPin({ plan, ad, a_id, b_id }) {
  const src = Array.isArray(plan) ? plan : [];
  const kept = src.filter(p => !(p && p.manual && ad.owns(p, a_id) && ad.owns(p, b_id)));
  return { plan: kept, removed: src.length - kept.length };
}
// build() 重算后重放 pin：按 account_id 从**新池**里重新定位并重跑守卫。
// ad = { people, owns(item,accountId), score(i,j)->非空对象|null, item(i,j,sc)->plan 元素 }
function reapplyPins({ plan, pins, ad }) {
  let out = Array.isArray(plan) ? plan.slice() : [];
  const dropped = [];
  const at = new Map();
  ad.people.forEach((p, i) => { if (!at.has(p.account_id)) at.set(p.account_id, i); });
  for (const pin of pins) {
    const i = at.get(pin.a_id), j = at.get(pin.b_id);
    if (i === undefined || j === undefined) { dropped.push({ a_id: pin.a_id, b_id: pin.b_id, reason: 'not_in_pool' }); continue; }
    if (ad.blocked && ad.blocked.has(pairKey(pin.a_id, pin.b_id))) { dropped.push({ a_id: pin.a_id, b_id: pin.b_id, reason: 'blocked' }); continue; }
    const sc = ad.score(i, j);
    if (sc == null) { dropped.push({ a_id: pin.a_id, b_id: pin.b_id, reason: 'infeasible' }); continue; }
    out = applyPin({ plan: out, i, j, ad, a_id: pin.a_id, b_id: pin.b_id, sc, by: pin.by }).plan;
  }
  return { plan: out, dropped };
}
// 重算统计（pairs / matched_users / unmatched / mean_score），并按需重算 preferred/supplement；
// **指纹不动**（池没变，publish 的闸必须仍然通过）。
function refreshStats(stats, plan, { poolUsers, manual, dropped, meanRound = 'int' }) {
  const s = stats || {};
  const pairs = Array.isArray(plan) ? plan : [];
  const matched = new Set();
  for (const p of pairs) { matched.add(p.a_id ?? p.a); matched.add(p.b_id ?? p.b); }
  s.pairs = pairs.length;
  s.matched_users = matched.size;
  s.unmatched = Math.max(0, Number(poolUsers) - matched.size);
  s.mean_score = pairs.length ? (meanRound === 'frac'
    ? Math.round(pairs.reduce((n, p) => n + (Number(p.score) || 0), 0) / pairs.length * 100) / 100
    : Math.round(pairs.reduce((n, p) => n + (Number(p.score) || 0), 0) / pairs.length)) : null;
  if (pairs.every(p => typeof p.preferred === 'boolean')) { s.preferred = pairs.filter(p => p.preferred).length; s.supplement = pairs.filter(p => !p.preferred).length; }
  s.manual = manual;
  s.manual_dropped = dropped || [];
  return s;
}

/* ---------- 只读图缓存（模块内，key = line:batch:revision，≤8 条 / TTL 60s） ---------- */
function createCache(ttl = 60000, max = 8) {
  const store = new Map();
  return {
    get(k) { const e = store.get(k); if (!e) return null; if (Date.now() - e.t > ttl) { store.delete(k); return null; } return e.v; },
    set(k, v) { if (store.size >= max) store.delete(store.keys().next().value); store.set(k, { t: Date.now(), v }); }
  };
}

module.exports = { fail, pairKey, positiveInt, loadNodes, graphPayload, collectPins, applyPin, dropPin, reapplyPins, refreshStats, createCache };
