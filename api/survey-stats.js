'use strict';
// 管理端答案分布统计：按 kind 聚合已保存问卷的答案（应用层聚合，行数为几百量级）。
// weekly → weekly_questionnaires.answers；deep → deep_surveys.data；buddy → friend_cards.data（v 对象）。
// 答案按选项中文文案存储；scale 存数字 1–7；填写型（text 等）只返回已填写人数。
const store = require('./survey-schema');
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
const optVals = a => (a || []).map(v => (v && typeof v === 'object' ? (v.value !== undefined ? v.value : v.label) : v));
const zeroed = list => { const c = {}; for (const v of list) c[String(v)] = 0; return c; };
const bump = (c, k) => { c[String(k)] = (c[String(k)] || 0) + 1; };

function weeklyAggregate(schema, rows) {
  const out = [];
  for (const q of schema.questions || []) {
    const id = String(q.id);
    const isChoice = ['radio', 'multi', 'scale'].includes(q.type);
    const counts = isChoice ? zeroed(q.type === 'scale' ? (q.options || []).map(String) : (q.options || [])) : null;
    let answered = 0;
    for (const r of rows) {
      const v = r.answers ? r.answers[id] : undefined;
      if (v === undefined || v === null || v === '') continue;
      answered++;
      if (q.type === 'radio' || q.type === 'scale') bump(counts, v);
      else if (q.type === 'multi' && Array.isArray(v)) for (const x of v) bump(counts, x);
    }
    out.push({ id, title: q.title, type: q.type, answered, counts });
  }
  return out;
}

function deepAggregate(schema, rows) {
  const items = [];
  (schema.cards || []).forEach(cards => (cards || []).forEach(c => (c.items || []).forEach(it => items.push(it))));
  const out = [];
  for (const it of items) {
    const choice = ['options', 'tags'].includes(it.type);
    const list = choice ? optVals(it.options) : it.type === 'select' && !it.fromSchools ? optVals(it.groups ? Object.values(it.groups).flat() : it.options) : null;
    const counts = list ? zeroed(list) : null;
    let answered = 0;
    for (const r of rows) {
      const v = r.data ? r.data[it.key] : undefined;
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      answered++;
      if (list && typeof v === 'string') bump(counts, v);
      else if (list && Array.isArray(v)) for (const x of v) bump(counts, x);
    }
    out.push({ id: it.key, title: it.label || it.key, type: it.type, answered, counts });
  }
  return out;
}

function buddyAggregate(schema, rows) {
  const out = [];
  const seen = new Set();
  const add = f => {
    if (!f || !f.key || seen.has(f.key)) return;
    seen.add(f.key);
    out.push({ id: f.key, title: f.label || f.key, type: f.text ? 'text' : f.multi ? 'multi' : 'radio', field: f });
  };
  for (const t of Object.values(schema.TYPES || {})) { add(t.main); (t.extra || []).forEach(add); }
  (schema.COMMON || []).forEach(add);
  for (const q of out) {
    const counts = q.field.text ? null : zeroed(q.field.opts || []);
    let answered = 0;
    for (const r of rows) {
      const v = r.v ? r.v[q.id] : undefined;
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      answered++;
      if (counts) { if (Array.isArray(v)) for (const x of v) bump(counts, x); else bump(counts, v); }
    }
    q.answered = answered; q.counts = counts; delete q.field;
  }
  return out;
}

function aggregate(kind, schema, rows) {
  if (kind === 'weekly') return weeklyAggregate(schema, rows);
  if (kind === 'deep') return deepAggregate(schema, rows);
  if (kind === 'buddy') return buddyAggregate(schema, rows);
  throw Error('未知问卷类型 ' + kind);
}

module.exports = function (app, { getPool, adminAuthMiddleware }) {
  const h = fn => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await fn(req, res, await getPool()); }
    catch (e) { console.error('Survey stats:', e.code || e.name); res.status(503).json({ code: 503, msg: '统计暂不可用，请稍后重试' }); }
  };
  app.get('/admin/survey-stats/:kind', adminAuthMiddleware, h(async (req, res, p) => {
    const kind = req.params.kind;
    let schema; try { schema = store.current(kind); } catch (e) { return res.status(404).json({ code: 404, msg: e.message }); }
    let rows, total;
    if (kind === 'weekly') {
      const [r] = await p.query('SELECT answers FROM weekly_questionnaires');
      rows = r.map(x => ({ answers: json(x.answers) })); total = rows.length;
    } else if (kind === 'deep') {
      const [r] = await p.query('SELECT data FROM deep_surveys');
      rows = r.map(x => ({ data: json(x.data) })); total = rows.length;
    } else {
      const [r] = await p.query('SELECT data FROM friend_cards WHERE deleted=0');
      rows = r.map(x => ({ v: json(x.data) || {} })); total = rows.length;
    }
    res.json({ code: 200, kind, total, questions: aggregate(kind, schema, rows) });
  }));
  return { aggregate };
};
module.exports.aggregate = aggregate;
