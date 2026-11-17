'use strict';

function fail(status, msg) { throw Object.assign(Error(msg), { status }); }

function idsOf(pair, mode) {
  if (!pair) return [];
  if (mode === 'love') return [Number(pair.a), Number(pair.b)];
  return [Number(pair.a_id), Number(pair.b_id)];
}

function samePair(pair, mode, a, b) {
  const [x, y] = idsOf(pair, mode);
  return (x === a && y === b) || (x === b && y === a);
}

function touches(pair, mode, a, b) {
  const [x, y] = idsOf(pair, mode);
  return x === a || x === b || y === a || y === b;
}

function pairKey(a, b) { return [Math.min(a, b), Math.max(a, b)].join(':'); }

function adjustPreviewPlan({ plan, mode, op, left, right, pool, blocked, makePair, choose }) {
  if (!['love', 'deep', 'buddy'].includes(mode)) fail(400, '配对方式无效');
  if (!['add', 'remove'].includes(op)) fail(400, '请选择指定或移出');
  const a = Number(left), b = Number(right);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) fail(400, '请填写两边的用户');
  if (a === b) fail(400, '不能把同一个人配成一对');
  const rows = Array.isArray(plan) ? plan.slice() : [];
  if (op === 'remove') {
    const next = rows.filter(function (p) { return !samePair(p, mode, a, b); });
    if (next.length === rows.length) fail(404, '名单里没有这对');
    return { plan: next, displaced: [], added: null };
  }
  const people = Array.isArray(pool) ? pool : [];
  const chosen = typeof choose === 'function' ? choose(people, a, b) : [people.find(function (p) { return Number(p.account_id) === a; }), people.find(function (p) { return Number(p.account_id) === b; })];
  if (!chosen || !chosen[0] || !chosen[1]) fail(409, '这两人里有人不在本批可配对名单中');
  const blockedSet = blocked instanceof Set ? blocked : new Set(blocked || []);
  if (blockedSet.has(pairKey(a, b))) fail(409, '这两人已有屏蔽、连接或冷却，不能指定');
  if (rows.some(function (p) { return samePair(p, mode, a, b); })) fail(409, '这对已经在名单上');
  const displaced = [];
  const kept = [];
  rows.forEach(function (row) {
    if (!touches(row, mode, a, b)) { kept.push(row); return; }
    idsOf(row, mode).forEach(function (id) { if (id !== a && id !== b) displaced.push(id); });
  });
  const added = makePair(chosen[0], chosen[1]);
  kept.push(added);
  return { plan: kept, displaced: displaced, added: added };
}

function recount(stats, mode, plan) {
  const next = Object.assign({}, stats || {});
  const rows = Array.isArray(plan) ? plan : [];
  const scores = rows.map(function (p) { return p.score; }).filter(function (v) { return v != null && v !== '' && Number.isFinite(Number(v)); }).map(Number);
  next.pairs = rows.length;
  next.manual = rows.filter(function (p) { return p.manual; }).length;
  if (mode === 'love') {
    next.mean_score = scores.length ? Math.round(scores.reduce(function (n, x) { return n + x; }, 0) / scores.length * 100) / 100 : null;
    next.preferred = rows.filter(function (p) { return p.preferred; }).length;
    next.supplement = rows.length - next.preferred;
    const people = Number(next.eligible);
    if (Number.isFinite(people)) next.unmatched = people - rows.length * 2;
  } else {
    next.mean_score = scores.length ? Math.round(scores.reduce(function (n, x) { return n + x; }, 0) / scores.length) : null;
    const matched = new Set(rows.flatMap(function (p) { return [Number(p.a_id), Number(p.b_id)]; }));
    next.matched_users = matched.size;
    const users = Number(next.users);
    if (Number.isFinite(users)) next.unmatched = users - matched.size;
  }
  return next;
}

async function resolveAccount(c, token) {
  const raw = String(token == null ? '' : token).trim();
  if (!raw || raw.length > 64) fail(400, '请填写用户名或账号编号');
  const [byName] = await c.execute('SELECT id, username FROM accounts WHERE username=? LIMIT 2', [raw]);
  if (byName.length > 1) fail(400, '这个用户名对应了多个账号');
  if (byName.length === 1) return { id: Number(byName[0].id), username: byName[0].username };
  if (/^[1-9][0-9]{0,9}$/.test(raw)) {
    const [byId] = await c.execute('SELECT id, username FROM accounts WHERE id=? LIMIT 1', [Number(raw)]);
    if (byId.length) return { id: Number(byId[0].id), username: byId[0].username };
  }
  fail(404, '找不到这个用户');
}

async function loadNames(c, ids) {
  const unique = [...new Set((ids || []).map(Number).filter(function (n) { return Number.isInteger(n) && n > 0; }))];
  if (!unique.length) return new Map();
  const [rows] = await c.execute('SELECT id, username FROM accounts WHERE id IN (' + unique.map(function () { return '?'; }).join(',') + ')', unique);
  return new Map(rows.map(function (r) { return [Number(r.id), r.username]; }));
}

function rosterRows(plan, mode, names) {
  const map = names instanceof Map ? names : new Map();
  return (plan || []).map(function (p) {
    const [a, b] = idsOf(p, mode);
    return {
      a: { id: a, name: map.get(a) || ('#' + a) },
      b: { id: b, name: map.get(b) || ('#' + b) },
      manual: !!p.manual,
      score: p.score == null || p.score === '' ? null : p.score
    };
  });
}

async function applyPlanEdit(c, opt) {
  opt = opt || {};
  if (opt.status === 'published') fail(409, '已发布的名单不能改');
  if (opt.status !== 'preview') fail(409, '请先生成预览，再调整名单');
  if (opt.expiresAt != null && opt.time >= opt.expiresAt) fail(409, '本批已过期');
  const body = opt.body || {};
  if (body.revision != null && body.revision !== '' && Number(body.revision) !== Number(opt.revision)) fail(409, '预览已变化，请刷新');
  const stats = opt.stats || {};
  if (opt.fingerprintKey) {
    if (!stats[opt.fingerprintKey] || stats[opt.fingerprintKey] !== opt.fingerprint) fail(409, '资格或关系已变化，请先重算预览');
  }
  const left = await resolveAccount(c, body.a);
  const right = await resolveAccount(c, body.b);
  const edited = adjustPreviewPlan({
    plan: opt.plan, mode: opt.mode, op: body.op, left: left.id, right: right.id,
    pool: opt.pool, blocked: opt.blocked, makePair: opt.makePair, choose: opt.choose
  });
  const nextStats = recount(stats, opt.mode, edited.plan);
  const names = await loadNames(c, edited.displaced);
  const displacedNames = edited.displaced.map(function (id) { return names.get(id) || ('#' + id); });
  let msg;
  if (body.op === 'remove') msg = '已从本批名单移出。请重新确认后再发布。';
  else if (displacedNames.length) msg = '已指定这对，并拆开了原来的配对：' + displacedNames.join('、') + ' 本批轮空。请重新确认后再发布。';
  else msg = '已指定这对。请重新确认后再发布。';
  if (body.op === 'add' && edited.added && (edited.added.score == null || edited.added.score === '')) msg += '算法没有给这对打分，发布后仍会进入名单。';
  return { plan: edited.plan, stats: nextStats, msg: msg };
}

module.exports = { adjustPreviewPlan, recount, idsOf, rosterRows, loadNames, resolveAccount, applyPlanEdit };
