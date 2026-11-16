'use strict';
// 匹配拓扑图 + 管理员指定两人配对：三条线（love / deep / buddy）端到端集成测试。
//
// 隔离套路与被验证过的 weekly-match.integration.cjs 一致：所有 SQL 里的表名整体改写成带随机前缀的
// 影子表（`CREATE TABLE <prefix><t> LIKE <t>`），finally 里 DROP 影子表 = 全清，真表一行不动。
// ⚠️ 额外一道「泄漏闸」：改写后若 SQL 里仍残留没加前缀的表名，立刻抛错——漏一张表 = 那条 SQL 落到
//    生产真表；宁可当场炸掉也不许写脏。
const assert = require('assert/strict'), mysql = require('mysql2/promise'), crypto = require('crypto'), express = require('express');
const { fixture } = require('./weekly-match-rules.test');          // love 问卷 fixture（既有导出）
const { openBatch, batchTimes } = require('../weekly-match-rules');
const deepRules = require('../deep-rules');
const { TYPES, COMMON } = require('../../web/friends-schema');

// 本次可能走到的全部表 = `grep -rhoE "CREATE TABLE IF NOT EXISTS [a-z_]+" api/*.js api/*.sql` 的全集
// ∪ 由 schema.sql / 迁移创建、模块里只有 SELECT 的三张（accounts / users / friend_survey）∪ 聊天表
// （core-metrics 的漏斗会读 user_chat_messages）。多写几个无害：SHOW TABLES LIKE 会把不存在的滤掉。
const CANDIDATES = ['accounts', 'users', 'friend_survey', 'account_admin_roles', 'account_preferences', 'account_profiles',
  'admin_audit_log', 'admin_user_views', 'analytics_metadata', 'announcement_audience', 'announcement_responses', 'announcements',
  'buddy_batches', 'buddy_entries', 'buddy_match_feedback', 'chat_icebreaker_cache', 'chat_sessions', 'complaints',
  'core_metric_batches', 'core_metric_exclusions', 'core_metric_participants', 'core_survey_funnels', 'core_survey_steps',
  'daily_blocks', 'daily_days', 'daily_mutex', 'daily_pairs', 'daily_settings',
  'deep_batches', 'deep_drafts', 'deep_entries', 'deep_match_feedback', 'deep_pairs', 'deep_slots', 'deep_surveys',
  'friend_account_weeks', 'friend_card_pairs', 'friend_cards', 'friend_card_settings', 'friend_card_weeks',
  'match_history', 'pay_entitlements', 'pay_items', 'pay_orders', 'recommendation_observations', 'secure_email_codes', 'survey_schemas',
  'user_chat_contact_events', 'user_chat_exchange', 'user_chat_hidden', 'user_chat_messages', 'user_chat_meta', 'user_chat_reads', 'user_chat_reports',
  'user_notification_prefs', 'user_notifications', 'user_push_subscriptions', 'user_uploads', 'verified_students',
  'weekly_drafts', 'weekly_match_bans', 'weekly_match_batches', 'weekly_match_enrollments', 'weekly_match_feedback',
  'weekly_match_pairs', 'weekly_match_slots', 'weekly_questionnaires'];

const BATCH = '2027-01-04';                         // 故意挑不存在的周一：openBatch(2027-01-05 周二) = 2027-01-04
const T_TUE = new Date('2027-01-05T04:00:00Z');     // 报名期（< 周三 20:00 截止）
const T_FRI = new Date('2027-01-08T12:00:00Z');     // 预览/发布期（∈ [周四 20:00, 周日 20:00)）
let phase = 'init';

(async () => {
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT, user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE, connectionLimit: 8
  });
  const prefix = 'mgt_' + crypto.randomBytes(5).toString('hex') + '_';
  const names = [];
  for (const n of CANDIDATES) { const [r] = await pool.query('SHOW TABLES LIKE ?', [n]); if (r.length) names.push(n); }
  names.sort((a, b) => b.length - a.length);        // 长名优先，避免短名先把长名切碎
  const re = new RegExp('\\b(' + names.join('|') + ')\\b', 'g');
  const RX = [/\b(?:FROM|JOIN|INTO|REFERENCES)\s+`?([a-z_][a-z0-9_]*)`?/gi,
    /\b(?:CREATE|ALTER)\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([a-z_][a-z0-9_]*)`?/gi,
    /\bUPDATE\s+`?([a-z_][a-z0-9_]*)`?(?=\s+SET\b)/gi,
    /\bLIKE\s+'([a-z_][a-z0-9_]*)'/gi];
  const leaks = new Set();
  const sql = s => {
    const out = String(s).replace(re, x => prefix + x);
    for (const rx of RX) { rx.lastIndex = 0; let m; while ((m = rx.exec(out))) { const n = m[1]; if (!n.startsWith(prefix) && !/^(select|dual|values)$/i.test(n)) leaks.add(n); } }
    if (leaks.size) throw Error('TABLE LEAK（未改写 → 会落到生产真表）: ' + [...leaks].join(', '));
    return out;
  };
  const wrap = c => ({ query: (s, a) => c.query(sql(s), a), execute: (s, a) => c.execute(sql(s), a), beginTransaction: () => c.beginTransaction(), commit: () => c.commit(), rollback: () => c.rollback(), release: () => c.release() });
  const db = { ...wrap(pool), getConnection: async () => wrap(await pool.getConnection()) };
  const cnt = async t => Number((await db.execute('SELECT COUNT(*) n FROM ' + t))[0][0].n);
  const cntW = async (t, w, a) => Number((await db.execute('SELECT COUNT(*) n FROM ' + t + ' WHERE ' + w, a))[0][0].n);
  const rows = async (s, a) => (await db.execute(s, a))[0];

  let server;
  const realBefore = {};
  try {
    for (const t of ['weekly_match_pairs', 'weekly_match_slots', 'deep_pairs', 'deep_slots', 'friend_card_pairs', 'friend_card_weeks',
      'weekly_match_batches', 'deep_batches', 'buddy_batches', 'core_metric_batches', 'user_notifications'])
      realBefore[t] = Number((await pool.query('SELECT COUNT(*) n FROM `' + t + '`'))[0][0].n);

    phase = 'shadow-tables';
    for (const n of names) await pool.query('CREATE TABLE `' + prefix + n + '` LIKE `' + n + '`');

    phase = 'app';
    const app = express(); app.use(express.json());
    let clock = T_TUE;
    const ids = [];                                  // 0-5 love / 6-9 deep / 10-13 buddy
    const audits = [];
    const auth = (req, res, next) => { const id = Number(req.headers['x-fixture']); if (!ids.includes(id)) return res.status(401).json({ code: 401 }); req.account = { account_id: id }; next(); };
    const adm = (req, res, next) => { if (req.headers['x-admin'] !== 'fixture') return res.status(401).json({ code: 401 }); req.admin = { username: 'fixture' }; next(); };
    const audit = { write: async (who, e) => audits.push({ ...e, admin: who && who.username }) };
    const daily = require('../daily')(app, { getPool: async () => db, authMiddleware: auth, adminAuthMiddleware: adm, now: () => clock });
    const notify = require('../notify')(app, { getPool: async () => db, authMiddleware: auth, now: () => clock });
    const friends = require('../friends')(app, { getPool: async () => db, authMiddleware: auth, daily, studentVerification: { verified: async () => true }, now: () => clock });
    const weeklyStub = { ensureSchema: async () => {} };   // weekly_match 只在 ensureSchema 里用 weekly（影子表已建好）
    const wm = require('../weekly-match')(app, { getPool: async () => db, authMiddleware: auth, adminAuthMiddleware: adm, daily, weekly: weeklyStub, notify, now: () => clock, audit });
    const deep = require('../deep-match')(app, { getPool: async () => db, authMiddleware: auth, adminAuthMiddleware: adm, daily, notify, now: () => clock, audit });
    const buddy = require('../buddy-match')(app, { getPool: async () => db, authMiddleware: auth, adminAuthMiddleware: adm, daily, friends, notify, now: () => clock, audit });
    require('../match-graph')(app, { getPool: async () => db, adminAuthMiddleware: adm });
    await notify.ensureSchema(); await wm.ensureSchema(); await deep.ensureSchema(); await buddy.ensureSchema();

    server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    async function api(method, url, { body, account, admin } = {}) {
      const headers = { 'Content-Type': 'application/json' };
      if (account != null) headers['x-fixture'] = String(account);
      if (admin) headers['x-admin'] = 'fixture';
      const r = await fetch(base + url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { http: r.status, ...await r.json().catch(() => ({})) };
    }
    const get = (url, o) => api('GET', url, { admin: true, ...o });
    const post = (url, body, o) => api('POST', url, { body: body || {}, admin: true, ...o });

    phase = 'fixtures';
    async function mkAccount(i, tag) {
      const email = 'mgfixture_' + tag + i + '@example.invalid';
      const [r] = await db.execute('INSERT INTO accounts(email,username,password_hash) VALUES (?,?,?)', [email, 'mg_' + tag + i, 'not-real']);
      await db.execute('INSERT INTO verified_students(account_id,email,verified_at) VALUES (?,?,?)', [r.insertId, email, '2027-01-05 10:00:00']);
      ids.push(r.insertId); return r.insertId;
    }
    const snap = fixture();
    for (let i = 0; i < 6; i++) { const id = await mkAccount(i, 'love'); await db.execute('INSERT INTO weekly_questionnaires(account_id,version,answers,important) VALUES (?,?,?,?)', [id, '1.2', JSON.stringify(snap.answers), JSON.stringify(snap.important)]); }
    const deepIn = { sex: '男', sex_prefer: ['不限'], grade: '大三', school: '中山大学', own_campus: '广州海珠南校', major: '工学类', friend_goal: '综合交友', expect_quick: '不限', online_offline: '都行', interests: [{ category: '阅读', subcategories: ['小说'], skillLevel: '一般般', skillLevelExpect: ['没要求'], frequency: '每周' }], personality_self_1: 3, personality_expect_1: 3, contact_entries: [{ method: '微信', value: 'fixture_contact' }] };
    const deepClean = deepRules.validate(deepIn);
    assert.ok(deepClean, 'deep fixture 必须是合法问卷');
    for (let i = 0; i < 4; i++) { const id = await mkAccount(i, 'deep'); await db.execute('INSERT INTO deep_surveys(account_id,data) VALUES (?,?)', [id, JSON.stringify(deepClean)]); await db.execute('INSERT INTO account_preferences(account_id,join_friend_matching) VALUES (?,1)', [id]); }
    const cardV = (type => { const t = TYPES[type], v = {}; for (const f of [t.main, ...t.extra, ...COMMON.filter(f => !t.online || !['campus', 'cross'].includes(f.key))]) v[f.key] = f.text ? '测试游戏' : f.multi ? [f.opts[0]] : f.opts[0]; return v; })('sport');
    const cardIds = [];
    for (let i = 0; i < 4; i++) {
      const id = await mkAccount(i, 'buddy');
      await db.execute('INSERT INTO friend_card_settings(account_id,gender) VALUES (?,?)', [id, '男生']);
      const [c] = await db.execute('INSERT INTO friend_cards(account_id,slot,type,data,enabled) VALUES (?,?,?,?,1)', [id, 1, 'sport', JSON.stringify(cardV)]);
      cardIds.push(c.insertId);
    }
    const loveIds = ids.slice(0, 6), deepIds = ids.slice(6, 10), budIds = ids.slice(10, 14);
    assert.equal(ids.length, 14); assert.ok(cardIds[0] !== budIds[0], 'buddy 的 card id 必须与账号 id 不同，否则该组断言失去意义');
    assert.equal(openBatch(T_TUE).key, BATCH, '周二报名 → 本批 key');
    assert.equal(openBatch(T_FRI).key, '2027-01-11', '周三 20:00 截止后「报名窗口」已翻到下一批，但本批仍可预览/发布');
    assert.equal(batchTimes(BATCH).expires.toISOString(), '2027-01-10T12:00:00.000Z');

    /* ==================== love ==================== */
    phase = 'love.enroll';
    assert.equal((await api('POST', '/account/weekly-match/enroll', { body: { batch: BATCH } })).code, 401, '未登录不能报名');
    for (let i = 0; i < 6; i++) assert.equal((await api('POST', '/account/weekly-match/enroll', { body: { batch: BATCH }, account: loveIds[i] })).code, 200, '报名 ' + i);

    phase = 'love.graph.open';
    assert.equal((await api('GET', '/admin/match-graph/overlay')).http, 401, '全站关系网必须 admin-only');
    const ad = '/admin/weekly-batches/' + BATCH;
    assert.equal((await api('GET', ad + '/graph')).http, 401, '批次图必须 admin-only');
    assert.equal((await get('/admin/weekly-batches/2020-01-06/graph')).http, 404, '批次不存在');
    let g = await get(ad + '/graph');
    assert.equal(g.code, 200); assert.equal(g.line, 'love'); assert.equal(g.status, 'open'); assert.equal(g.canPin, false); assert.equal(g.revision, 0);
    assert.equal(g.nodes.length, 6); assert.equal(g.edges.length, 15, '同质问卷 → 全部 15 条候选边'); assert.equal(g.plan.length, 0);
    assert.ok(g.nodes.every(n => n.username && n.aid === n.id), '节点带用户名');
    assert.equal(JSON.stringify(g.nodes).includes('answers'), false, '绝不下发问卷答案');

    phase = 'love.gates';
    assert.equal((await post(ad + '/manual-pair', { a_id: loveIds[0], b_id: loveIds[1] })).http, 409, 'open 批次不能指定（先生成预览）');
    assert.equal((await post(ad + '/manual-pair', { a_id: loveIds[0], b_id: loveIds[0] })).http, 400, 'a_id===b_id');

    phase = 'love.preview';
    clock = T_FRI;
    assert.equal((await post(ad + '/preview')).code, 200);
    g = await get(ad + '/graph');
    assert.equal(g.status, 'preview'); assert.equal(g.canPin, true); assert.equal(g.plan.length, 3, '同质问卷 → 3 对');
    const rev0 = g.revision, P = g.plan;
    assert.ok(P.every(p => p.a_id === p.a && p.b_id === p.b), 'love：a/b 本身就是账号 id');

    phase = 'love.negatives';
    assert.equal((await post(ad + '/manual-pair', { a_id: P[0].a_id, b_id: deepIds[0] })).http, 400, '池外账号（deep 的人）');
    await db.execute('INSERT INTO daily_blocks(owner_id,target_id,created_at) VALUES (?,?,?)', [P[0].a_id, P[1].b_id, '2027-01-08 10:00:00']);
    assert.equal((await post(ad + '/manual-pair', { a_id: P[0].a_id, b_id: P[1].b_id })).http, 409, 'blocked 对不能指定');
    await db.execute('DELETE FROM daily_blocks WHERE owner_id=? AND target_id=?', [P[0].a_id, P[1].b_id]);

    phase = 'love.pin';
    let r = await post(ad + '/manual-pair', { a_id: P[0].a_id, b_id: P[1].b_id });
    assert.equal(r.code, 200); assert.equal(r.revision, rev0 + 1); assert.equal(r.plan_n, 2); assert.equal(r.manual_n, 1);
    assert.equal(r.removed.length, 2, '跨两条自动配对 → 顶掉两条');
    assert.equal(await cnt('weekly_match_pairs'), 0, '核心断言：指定配对不落 pair 行');
    assert.equal(await cnt('weekly_match_slots'), 0, '核心断言：不落 slot 行');
    assert.equal(await cnt('user_notifications'), 0, '核心断言：不发通知');
    g = await get(ad + '/graph');
    const pin = g.plan.filter(p => p.manual);
    assert.equal(pin.length, 1); assert.equal(pin[0].a_id, P[0].a_id); assert.equal(pin[0].b_id, P[1].b_id);
    assert.equal(pin[0].by, 'fixture'); assert.equal(g.stats.manual, 1); assert.deepEqual(g.manual_dropped, []);
    assert.equal(g.plan.length, 2);

    phase = 'love.remove';
    r = await post(ad + '/manual-pair/remove', { a_id: P[0].a_id, b_id: P[1].b_id });
    assert.equal(r.code, 200); assert.equal(r.manual_n, 0); assert.equal(r.plan_n, 1, '被顶掉的自动配对不会回来');
    assert.equal((await post(ad + '/manual-pair/remove', { a_id: P[0].a_id, b_id: P[1].b_id })).http, 404, '撤销一条不存在的指定');
    assert.equal((await post(ad + '/manual-pair/remove', { a_id: P[2].a_id, b_id: P[2].b_id })).http, 404, '自动配对不能靠 remove 撤销');

    phase = 'love.reapply';
    assert.equal((await post(ad + '/manual-pair', { a_id: P[0].a_id, b_id: P[1].b_id })).code, 200);
    assert.equal((await post(ad + '/preview')).code, 200, '重新预览 → build() 重算');
    g = await get(ad + '/graph');
    assert.equal(g.plan.filter(p => p.manual).length, 1, 'build() 重算后手工指定仍在（reapplyPins）');
    assert.equal(g.stats.manual, 1); assert.deepEqual(g.manual_dropped, []);

    phase = 'love.pool-change';
    await db.execute('UPDATE weekly_match_enrollments SET active=0 WHERE account_id=? AND batch_key=?', [P[0].a_id, BATCH]);
    assert.equal((await post(ad + '/preview')).code, 200);
    g = await get(ad + '/graph');
    assert.equal(g.stats.manual, 0); assert.equal(g.manual_dropped.length, 1, '人不在池 → 丢弃并如实记录');
    assert.equal(g.manual_dropped[0].a_id, P[0].a_id); assert.equal(g.manual_dropped[0].reason, 'not_in_pool');
    await db.execute('UPDATE weekly_match_enrollments SET active=1 WHERE account_id=? AND batch_key=?', [P[0].a_id, BATCH]);

    phase = 'love.publish';
    assert.equal((await post(ad + '/preview')).code, 200);
    r = await post(ad + '/manual-pair', { a_id: P[0].a_id, b_id: P[1].b_id });
    assert.equal(r.code, 200); assert.equal(r.plan_n, 2); assert.equal(r.manual_n, 1);
    const rev = (await get('/admin/weekly-batches')).batches.find(x => x.batch_key === BATCH).revision;
    assert.equal((await post(ad + '/approve', { revision: rev + 1 })).http, 409, 'revision 不符');
    assert.equal((await post(ad + '/approve', { revision: rev })).code, 200);
    const pub = await post(ad + '/publish');
    assert.equal(pub.code, 200); assert.equal(pub.pairs, 2);
    assert.equal(await cnt('weekly_match_pairs'), 2); assert.equal(await cnt('weekly_match_slots'), 4);
    assert.equal(await cntW('weekly_match_enrollments', 'batch_key=? AND assigned=1', [BATCH]), 4);
    assert.equal(await cntW('user_notifications', "link='/weekly-match'"), 4, '每对 2 条通知');
    assert.equal(await cntW('weekly_match_pairs', '(a_id=? AND b_id=?) OR (a_id=? AND b_id=?)', [P[0].a_id, P[1].b_id, P[1].b_id, P[0].a_id]), 1, '发布的正是被手工指定的那一对');
    assert.equal(await cntW('core_metric_batches', "mode='love' AND batch_key=?", [BATCH]), 1);
    assert.equal(await cntW('core_metric_participants', "mode='love' AND batch_key=?", [BATCH]), 6);
    assert.equal((await post(ad + '/manual-pair', { a_id: P[0].a_id, b_id: P[1].b_id })).http, 409, '已发布批次不能再改计划');
    g = await get(ad + '/graph'); assert.equal(g.canPin, false); assert.equal(g.status, 'published');

    /* ==================== deep ==================== */
    phase = 'deep.sync';
    clock = T_TUE;                                  // sync 只在 cutoff 之前写 entries
    assert.equal((await get('/admin/deep-batches')).code, 200);
    assert.equal(await cntW('deep_entries', 'batch_key=? AND active=1', [BATCH]), 4, 'T_TUE 触发 sync 写 deep_entries');
    clock = T_FRI;
    const dad = '/admin/deep-batches/' + BATCH;
    let dg = await get(dad + '/graph');
    assert.equal(dg.code, 200); assert.equal(dg.status, 'open'); assert.equal(dg.canPin, false);
    assert.equal(dg.nodes.length, 4); assert.equal(dg.edges.length, 6);
    phase = 'deep.pin';
    assert.equal((await post(dad + '/manual-pair', { a_id: deepIds[0], b_id: deepIds[1] })).http, 409, 'open 批次不能指定');
    assert.equal((await post(dad + '/preview')).code, 200);
    dg = await get(dad + '/graph');
    assert.equal(dg.canPin, true); assert.equal(dg.plan.length, 2); assert.equal(dg.nodes.length, 4);
    const D = dg.plan;
    assert.ok(D.every(p => p.a === p.a_id && p.b === p.b_id), 'deep：a 就是 account_id');
    assert.equal((await post(dad + '/manual-pair', { a_id: D[0].a_id, b_id: loveIds[0] })).http, 400, '池外账号');
    await db.execute('INSERT INTO daily_blocks(owner_id,target_id,created_at) VALUES (?,?,?)', [D[0].a_id, D[0].b_id, '2027-01-08 10:00:00']);
    assert.equal((await post(dad + '/manual-pair', { a_id: D[0].a_id, b_id: D[0].b_id })).http, 409, 'blocked 对');
    await db.execute('DELETE FROM daily_blocks WHERE owner_id=? AND target_id=?', [D[0].a_id, D[0].b_id]);
    r = await post(dad + '/manual-pair', { a_id: D[0].a_id, b_id: D[1].a_id });
    assert.equal(r.code, 200, 'DBG deep cross pin=' + JSON.stringify(r) + ' plan=' + JSON.stringify(D)); assert.equal(r.removed.length, 2); assert.equal(r.plan_n, 1); assert.equal(r.manual_n, 1);
    assert.equal(await cnt('deep_pairs'), 0); assert.equal(await cnt('deep_slots'), 0);
    dg = await get(dad + '/graph');
    assert.equal(dg.plan.length, 1); assert.equal(dg.plan[0].manual, true);
    assert.equal(dg.plan[0].a, D[0].a_id); assert.equal(dg.plan[0].b, D[1].a_id, 'pin 的 a/b 按 account_id 现场重定位');
    assert.equal((await post(dad + '/preview')).code, 200);
    dg = await get(dad + '/graph'); assert.equal(dg.plan.filter(p => p.manual).length, 1, 'build() 后 pin 仍在');
    assert.equal((await post(dad + '/manual-pair/remove', { a_id: D[0].a_id, b_id: D[1].a_id })).code, 200);
    assert.equal((await post(dad + '/manual-pair/remove', { a_id: D[0].a_id, b_id: D[1].a_id })).http, 404);
    assert.equal((await get(dad + '/graph')).plan.length, 0, '撤销后 plan 空（被顶掉的自动配对不会回来）');
    assert.equal((await post(dad + '/manual-pair', { a_id: D[0].a_id, b_id: D[1].a_id })).http, 409, 'plan 空 → 必须先生成预览');
    assert.equal((await post(dad + '/preview')).code, 200);
    r = await post(dad + '/manual-pair', { a_id: D[0].a_id, b_id: D[1].a_id });
    assert.equal(r.code, 200); assert.equal(r.plan_n, 1); assert.equal(r.manual_n, 1);
    phase = 'deep.publish';
    assert.equal((await post(dad + '/approve', { revision: (await get('/admin/deep-batches')).batches.find(x => x.batch_key === BATCH).revision })).code, 200);
    const dpub = await post(dad + '/publish');
    assert.equal(dpub.code, 200); assert.equal(dpub.pairs, 1);
    assert.equal(await cnt('deep_pairs'), 1); assert.equal(await cnt('deep_slots'), 2);
    assert.equal(await cntW('user_notifications', "link='/deep'"), 2);
    assert.equal(await cntW('deep_pairs', '(a_id=? AND b_id=?) OR (a_id=? AND b_id=?)', [D[0].a_id, D[1].a_id, D[1].a_id, D[0].a_id]), 1);
    assert.equal(await cntW('core_metric_batches', "mode='deep' AND batch_key=?", [BATCH]), 1);
    assert.equal(await cntW('core_metric_participants', "mode='deep' AND batch_key=?", [BATCH]), 4);

    /* ==================== buddy ==================== */
    phase = 'buddy.sync';
    clock = T_TUE;
    assert.equal((await get('/admin/buddy-batches')).code, 200);
    assert.equal(await cntW('buddy_entries', 'batch_key=? AND active=1', [BATCH]), 4, 'T_TUE 触发 sync 写 buddy_entries');
    clock = T_FRI;
    const bad = '/admin/buddy-batches/' + BATCH;
    let bg = await get(bad + '/graph');
    assert.equal(bg.code, 200); assert.equal(bg.status, 'open'); assert.equal(bg.nodes.length, 4); assert.equal(bg.edges.length, 6);
    phase = 'buddy.pin';
    assert.equal((await post(bad + '/manual-pair', { a_id: budIds[0], b_id: budIds[1] })).http, 409, 'open 批次不能指定');
    assert.equal((await post(bad + '/preview')).code, 200);
    bg = await get(bad + '/graph');
    assert.equal(bg.canPin, true); assert.equal(bg.plan.length, 2);
    const B = bg.plan;
    assert.ok(B.every(p => p.a !== p.a_id), 'buddy：a 是 card id，a_id 才是账号 id');
    assert.deepEqual([...new Set(B.flatMap(p => [p.a, p.b]))].sort((x, y) => x - y), [...cardIds].sort((x, y) => x - y), '边上的 id 全部是 card id');
    assert.equal((await post(bad + '/manual-pair', { a_id: B[0].a_id, b_id: loveIds[0] })).http, 400, '池外账号');
    // 跨配对（c1 ↔ c3）：顶掉两条自动配对，并证明 card id 按 account_id 现场重定位
    r = await post(bad + '/manual-pair', { a_id: B[0].a_id, b_id: B[1].a_id });
    assert.equal(r.code, 200); assert.equal(r.removed.length, 2); assert.equal(r.plan_n, 1); assert.equal(r.manual_n, 1);
    assert.equal(await cnt('friend_card_pairs'), 0); assert.equal(await cnt('friend_card_weeks'), 0); assert.equal(await cnt('friend_account_weeks'), 0);
    bg = await get(bad + '/graph');
    const bp = bg.plan.find(p => p.manual);
    assert.equal(bp.a_id, B[0].a_id); assert.equal(bp.b_id, B[1].a_id);
    assert.equal(bp.a, B[0].a, 'pin 的 a 必须是 c1 的 card id（现场定位，不能复用旧值）');
    assert.equal(bp.b, B[1].a);
    assert.equal((await post(bad + '/manual-pair/remove', { a_id: B[0].a_id, b_id: B[1].a_id })).code, 200);
    assert.equal((await post(bad + '/manual-pair/remove', { a_id: B[0].a_id, b_id: B[1].a_id })).http, 404);
    assert.equal((await post(bad + '/manual-pair', { a_id: B[0].a_id, b_id: B[1].a_id })).http, 409, 'plan 空 → 必须先生成预览');
    assert.equal((await post(bad + '/preview')).code, 200);
    // 最终态：把原自动配对本身改成手工指定（不扰动别人），发布仍是 2 对
    r = await post(bad + '/manual-pair', { a_id: B[0].a_id, b_id: B[0].b_id });
    assert.equal(r.code, 200); assert.equal(r.removed.length, 0, '指定的是同一条配对本身 → 其他人不受影响');
    assert.equal(r.plan_n, 2); assert.equal(r.manual_n, 1);
    bg = await get(bad + '/graph');
    const bp2 = bg.plan.find(p => p.manual);
    assert.equal(bp2.a_id, B[0].a_id); assert.equal(bp2.b_id, B[0].b_id);
    assert.equal(bp2.a, B[0].a); assert.equal(bp2.b, B[0].b);
    assert.equal((await post(bad + '/manual-pair', { a_id: B[0].a_id, b_id: B[0].b_id })).code, 200);
    assert.equal((await post(bad + '/preview')).code, 200, '重新预览（pin 重放）');
    bg = await get(bad + '/graph'); assert.equal(bg.plan.filter(p => p.manual).length, 1);
    phase = 'buddy.publish';
    assert.equal((await post(bad + '/approve', { revision: (await get('/admin/buddy-batches')).batches.find(x => x.batch_key === BATCH).revision })).code, 200);
    const bpub = await post(bad + '/publish');
    assert.equal(bpub.code, 200); assert.equal(bpub.pairs, 2);
    assert.equal(await cnt('friend_card_pairs'), 2); assert.equal(await cnt('friend_account_weeks'), 4); assert.equal(await cnt('friend_card_weeks'), 4);
    assert.equal(await cntW('user_notifications', "link='/friends'"), 4);
    assert.equal(await cntW('core_metric_batches', "mode='buddy' AND batch_key=?", [BATCH]), 1);
    const [cardRow] = await rows('SELECT a_card,b_card,a_id,b_id FROM friend_card_pairs WHERE (a_id=? AND b_id=?) OR (a_id=? AND b_id=?)', [B[0].a_id, B[0].b_id, B[0].b_id, B[0].a_id]);
    assert.equal(cardRow.a_card, B[0].a, 'publish 落库用的是 card id'); assert.equal(cardRow.b_card, B[0].b);
    assert.equal(cardRow.a_id, B[0].a_id);

    /* ============ 全站关系网（api/match-graph.js 只读叠加视图） ============ */
    phase = 'overlay';
    const ov = await get('/admin/match-graph/overlay?line=all&days=365&limit=2000');
    assert.equal(ov.code, 200); assert.equal(ov.edges.length, 5, 'love 2 + deep 1 + buddy 2');
    assert.equal(ov.lines.love, 2); assert.equal(ov.lines.deep, 1); assert.equal(ov.lines.buddy, 2);
    assert.equal(ov.nodes.length, 10, 'love 4 人 + deep 2 人 + buddy 4 人（去重）'); assert.ok(ov.nodes.every(n => n.username), '节点带用户名');
    assert.equal(JSON.stringify(ov).includes('password'), false);
    assert.equal((await get('/admin/match-graph/overlay?line=history&days=365')).edges.length, 0);
    const junk = await get('/admin/match-graph/overlay?line=bad&days=99999&limit=0');
    assert.equal(junk.code, 200, '非法参数不报错，回落默认值');
    assert.equal(junk.line, 'all'); assert.equal(junk.days, 60);
    assert.ok(Array.isArray(junk.edges) && junk.truncated && typeof junk.truncated.omitted === 'number');

    phase = 'audit';
    const mp = audits.filter(a => a.action === 'weekly_batch.manual_pair');
    assert.equal(mp.length, 3, 'love 成功指定 3 次 → 3 条审计（失败的不写）');
    assert.equal(mp[0].target_type, 'weekly_batch'); assert.equal(mp[0].target_id, BATCH); assert.equal(mp[0].status_code, 200);
    assert.equal(mp[0].admin, 'fixture'); assert.equal(mp[0].method, 'POST');
    assert.equal(mp[0].detail.a_id, P[0].a_id); assert.equal(mp[0].detail.b_id, P[1].b_id); assert.equal(mp[0].detail.removed, 2);
    assert.equal(audits.filter(a => a.action === 'weekly_batch.manual_pair.remove').length, 1);
    assert.equal(audits.filter(a => a.action === 'deep_batch.manual_pair').length, 2);
    assert.equal(audits.filter(a => a.action === 'deep_batch.manual_pair.remove').length, 1);
    // buddy 共 3 次成功的 manual-pair：跨配对 pin、把原自动配对改手工、幂等重放（409/400/404 均不写审计）
    assert.equal(audits.filter(a => a.action === 'buddy_batch.manual_pair').length, 3);
    assert.equal(audits.filter(a => a.action === 'buddy_batch.manual_pair.remove').length, 1);

    console.log('PASS: 三条线（love/deep/buddy）候选拓扑与 build()/pool() 同源；管理员指定配对只改 plan（revision+1、清 approve、零 pair/slot/通知）；跨 build 重放（reapplyPins）与池变动如实丢弃（manual_dropped）；负向 400/404/409；发布才落库 + 通知 + core-metrics；buddy 的 card id 解析；全站关系网叠加视图；审计。影子表隔离，生产真表一行未动。');
  } finally {
    if (server) await new Promise(r => server.close(r));
    const c = await pool.getConnection();
    try {
      await c.query('SET FOREIGN_KEY_CHECKS=0');
      for (const n of [...names].reverse()) {
        const t = prefix + n;
        if (!t.startsWith(prefix)) throw Error('Unsafe cleanup');
        await c.query('DROP TABLE IF EXISTS `' + t + '`');
      }
      await c.query('SET FOREIGN_KEY_CHECKS=1');
      const [left] = await c.query('SHOW TABLES LIKE ?', [prefix + '%']);
      assert.equal(left.length, 0, '影子表必须全部清掉');
      for (const [t, n] of Object.entries(realBefore)) {
        const [[now]] = await c.query('SELECT COUNT(*) c FROM `' + t + '`');
        assert.equal(Number(now.c), n, '生产真表 ' + t + ' 行数变了！');
      }
    } finally { c.release(); await pool.end(); }
  }
})().catch(e => { console.error('FAILED at phase [' + phase + ']'); console.error(e); process.exitCode = 1; });
