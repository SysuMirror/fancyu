'use strict';
// 后台「匹配拓扑图」——全站关系网叠加视图（谁和谁配过）。只读、admin-only、无审计、无副作用。
//
//  · 四条来源各查一次「最近 N 天、最近 limit 条」：weekly_match_pairs(love) / deep_pairs(deep)
//    / friend_card_pairs(buddy) / match_history(history，历史导入，单独一色)；
//  · 表不存在（未部署该线）直接跳过，不报错；
//  · 上限写死：边 ≤ limit(默认 2000 / 硬顶 5000)，节点 ≤ 800；超出如实回 truncated；
//  · 节点只出 username / avatar（后台本来就可见），**不下发问卷答案、邮箱、联系方式**。
const mp = require('./match-pin');

const LINE_TABLES = {
  love: { table: 'weekly_match_pairs', a: 'a_id', b: 'b_id', week: 'batch_key', on: "status<>'cancelled'" },
  deep: { table: 'deep_pairs', a: 'a_id', b: 'b_id', week: 'week_key', on: "status<>'cancelled'" },
  buddy: { table: 'friend_card_pairs', a: 'a_id', b: 'b_id', week: 'week_key', on: "status<>'cancelled'" },
  history: { table: 'match_history', a: 'account_id', b: 'match_account_id', week: null, on: '1=1' }
};
const cap = (v, lo, hi, dflt) => { const n = Number(v); return Number.isSafeInteger(n) && n >= lo && n <= hi ? n : dflt; };

module.exports = function (app, { getPool, adminAuthMiddleware }) {
  const cache = mp.createCache();
  async function hasTable(pool, name) { const [r] = await pool.query('SHOW TABLES LIKE ?', [name]); return r.length > 0; }

  async function overlay(pool, { line, days, limit }) {
    const want = Object.keys(LINE_TABLES).filter(k => LINE_TABLES[k] && (line === 'all' || line === k));
    const edges = [], lines = {};
    for (const k of want) {
      const t = LINE_TABLES[k];
      if (!await hasTable(pool, t.table)) { lines[k] = 0; continue; }
      const cols = [`${t.a} a`, `${t.b} b`, 'created_at', t.week ? `${t.week} week` : 'NULL week'];
      const [rows] = await pool.query(`SELECT ${cols.join(',')} FROM ${t.table} WHERE ${t.on} AND created_at>=DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${days} DAY) ORDER BY created_at DESC LIMIT ${limit}`);
      lines[k] = rows.length;
      for (const r of rows) {
        const a = Number(r.a), b = Number(r.b);
        if (!a || !b || a === b) continue;
        edges.push({ a, b, line: k, week: r.week || null, at: r.created_at });
      }
    }
    edges.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    const cut = edges.slice(0, limit);
    const ids = [...new Set(cut.flatMap(e => [e.a, e.b]))];
    const names = await mp.loadNodes(pool, ids.slice(0, 800));
    const nodes = [...names].map(([id, n]) => ({ id, aid: id, username: n.username, avatar: n.avatar }));
    const byLine = {};
    for (const e of cut) byLine[e.line] = (byLine[e.line] || 0) + 1;
    return {
      line, days, nodes, edges: cut,
      lines: byLine, counts: lines,
      truncated: { edges: edges.length > cut.length, omitted: Math.max(0, edges.length - cut.length), nodes: ids.length > 800 }
    };
  }

  app.get('/admin/match-graph', adminAuthMiddleware, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const line = ['all', 'love', 'deep', 'buddy', 'history'].includes(req.query.line) ? req.query.line : 'all';
    const days = cap(req.query.days, 1, 365, 60);
    const limit = cap(req.query.limit, 1, 5000, 2000);
    try {
      const ck = `overlay:${line}:${days}:${limit}`;
      let out = cache.get(ck);
      if (!out) { out = await overlay(await getPool(), { line, days, limit }); cache.set(ck, out); }
      res.json({ code: 200, ...out });
    } catch (e) {
      console.error('Match graph:', e.status || e.code || e.name);
      res.status(503).json({ code: 503, msg: '拓扑图暂不可用，请稍后重试' });
    }
  });
};
