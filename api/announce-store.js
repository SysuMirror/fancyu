'use strict';
// 管理员发布的「通知 / 问卷调研」——纯逻辑层（用户侧 / 管理侧两个路由模块共用，避免循环 require）。
//
//  - 一个实体两种形态：announcements.kind = 'notice' | 'survey'（调研只多带一个 questions JSON）；
//  - 人群在「发布时刻」快照进 announcement_audience → 未答名单精确、投递幂等（INSERT IGNORE）；
//  - 投递零新增管道：直接把行写进既有 user_notifications，Web Push 仍由 notify 的 60s drain 负责；
//  - 时间一律 UTC；比较用 UTC_TIMESTAMP()。
const fs = require('fs');
const path = require('path');

const Q_TYPES = ['single', 'multi', 'rating', 'text'];
const KIND_OK = ['notice', 'survey'];
const AUDIENCE_OK = ['all', 'verified', 'weekly_match', 'custom'];
const MAX_QUESTIONS = 30;
const MAX_OPTIONS = 30;
const MAX_CUSTOM_USERS = 200;
const CHUNK = 500;
// 与 user_notifications 的列宽一致（超出会被 MySQL 截断或报错，这里主动裁剪）
const N_TITLE = 80, N_BODY = 300, N_LINK = 200, N_DEDUP = 120;
const MAX_ROWS = 20000;

const fail = (status, msg) => { throw Object.assign(Error(msg), { status }); };
const str = (v, n) => (v === undefined || v === null ? '' : String(v)).slice(0, n);
const stamp = d => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
function parseJSON(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}
let _rules;
const rules = () => (_rules || (_rules = require('./weekly-match-rules')));

/* ---------- 建表（幂等；模块级缓存，与 notify.js 同款） ---------- */
let ready;
function ensureSchema(getPool) {
  if (!ready) ready = (async () => {
    const p = await getPool();
    for (const sql of fs.readFileSync(path.join(__dirname, 'announce-schema.sql'), 'utf8').split(';').map(x => x.trim()).filter(Boolean)) await p.query(sql);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

/* ---------- 草稿校验 ---------- */
function ts(v, field) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) fail(400, field + '时间格式无效');
  return stamp(d);
}
function validateQuestions(list) {
  if (!Array.isArray(list) || !list.length) fail(400, '问卷至少需要一个题目');
  if (list.length > MAX_QUESTIONS) fail(400, '题目最多 ' + MAX_QUESTIONS + ' 个');
  const out = [], seen = new Set();
  list.forEach((raw, i) => {
    const q = raw && typeof raw === 'object' ? raw : {};
    const id = str(q.id, 24).trim() || ('q' + (i + 1));
    if (!/^[A-Za-z0-9_]{1,24}$/.test(id)) fail(400, '第 ' + (i + 1) + ' 题的编号不合法');
    if (seen.has(id)) fail(400, '题目编号重复：' + id);
    seen.add(id);
    const type = Q_TYPES.includes(q.type) ? q.type : null;
    if (!type) fail(400, '第 ' + (i + 1) + ' 题的题型无效');
    const title = str(q.title, 200).trim();
    if (!title) fail(400, '第 ' + (i + 1) + ' 题缺少题干');
    const item = { id, type, title, required: !!q.required };
    if (type === 'single' || type === 'multi') {
      const opts = Array.isArray(q.options) ? q.options : [];
      if (opts.length < 2) fail(400, '第 ' + (i + 1) + ' 题至少需要两个选项');
      if (opts.length > MAX_OPTIONS) fail(400, '第 ' + (i + 1) + ' 题选项最多 ' + MAX_OPTIONS + ' 个');
      const ov = new Set();
      item.options = opts.map((o, j) => {
        const oo = o && typeof o === 'object' ? o : {};
        const value = str(oo.value, 40).trim() || ('o' + (j + 1));
        if (!/^[A-Za-z0-9_\-]{1,40}$/.test(value)) fail(400, '第 ' + (i + 1) + ' 题的选项值不合法');
        if (ov.has(value)) fail(400, '第 ' + (i + 1) + ' 题的选项值重复');
        ov.add(value);
        return { value, label: str(oo.label, 80).trim() || value };
      });
      if (type === 'multi') {
        let max = Number(q.max);
        if (!Number.isSafeInteger(max) || max < 1) max = item.options.length;
        item.max = Math.min(max, item.options.length);
      }
    } else if (type === 'rating') {
      let max = Number(q.max);
      if (!Number.isSafeInteger(max) || max < 2 || max > 10) max = 5;
      item.max = max;
    } else {
      let maxLen = Number(q.maxLen);
      if (!Number.isSafeInteger(maxLen) || maxLen < 1 || maxLen > 2000) maxLen = 500;
      item.maxLen = maxLen;
    }
    out.push(item);
  });
  return out;
}
function validateDraft(input) {
  const b = input && typeof input === 'object' ? input : {};
  const kind = KIND_OK.includes(b.kind) ? b.kind : null;
  if (!kind) fail(400, '请选择类型（通知 / 问卷调研）');

  const title = str(b.title, 120).trim();
  if (!title) fail(400, '请填写标题');
  const summary = str(b.summary, 300).trim();
  const body = str(b.body, 20000);
  if (kind === 'notice' && !body.trim()) fail(400, '通知正文不能为空');

  const link = str(b.link, 200).trim();
  if (link && !/^\/(?!\/)/.test(link)) fail(400, '跳转链接只能是站内地址（以单个斜杠开头）');

  const audience = AUDIENCE_OK.includes(b.audience) ? b.audience : null;
  if (!audience) fail(400, '送达对象无效');
  const meta = {};
  if (audience === 'custom') {
    const list = Array.isArray(b.audience_meta && b.audience_meta.usernames) ? b.audience_meta.usernames : [];
    const usernames = [...new Set(list.map(x => str(x, 64).trim()).filter(Boolean))];
    if (!usernames.length) fail(400, '指定人群至少要填一个用户名');
    if (usernames.length > MAX_CUSTOM_USERS) fail(400, '指定人群最多 ' + MAX_CUSTOM_USERS + ' 个用户名');
    meta.usernames = usernames;
  } else if (audience === 'weekly_match') {
    const batch = str(b.audience_meta && b.audience_meta.batch_key, 10).trim();
    if (!batch) fail(400, '请选择配对批次');
    try { rules().batchTimes(batch); } catch (e) { fail(400, '批次日期无效'); }
    meta.batch_key = batch;
  }

  const channel_reminder = b.channel_reminder ? 1 : 0;
  const channel_home = b.channel_home ? 1 : 0;
  if (!channel_reminder && !channel_home) fail(400, '请至少选择一个渠道（推送到提醒 / 主页展示）');

  const start_at = ts(b.start_at, '生效');
  const end_at = ts(b.end_at, '失效');
  if (start_at && end_at && start_at >= end_at) fail(400, '失效时间必须晚于生效时间');

  let questions = null;
  if (kind === 'survey') questions = validateQuestions(b.questions);
  else if (Array.isArray(b.questions) && b.questions.length) fail(400, '通知不能包含题目');

  return { kind, title, summary, body, link, questions, audience,
    audience_meta: Object.keys(meta).length ? meta : null,
    channel_reminder, channel_home, start_at, end_at };
}

/* ---------- 答案校验 ---------- */
function validateAnswers(questions, input) {
  const qs = Array.isArray(questions) ? questions : [];
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const q of qs) {
    const raw = src[q.id];
    const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length);
    if (q.type === 'single') {
      if (empty) { if (q.required) fail(400, '「' + q.title + '」是必答题'); continue; }
      const v = str(raw, 40);
      if (!q.options.some(o => o.value === v)) fail(400, '「' + q.title + '」的选项无效');
      out[q.id] = v;
    } else if (q.type === 'multi') {
      if (empty) { if (q.required) fail(400, '「' + q.title + '」是必答题'); continue; }
      const vals = [...new Set((Array.isArray(raw) ? raw : [raw]).map(x => str(x, 40)).filter(Boolean))];
      const cap = q.max || q.options.length;
      if (vals.length > cap) fail(400, '「' + q.title + '」最多选择 ' + cap + ' 项');
      for (const v of vals) if (!q.options.some(o => o.value === v)) fail(400, '「' + q.title + '」的选项无效');
      out[q.id] = vals;
    } else if (q.type === 'rating') {
      if (empty) { if (q.required) fail(400, '「' + q.title + '」是必答题'); continue; }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > q.max) fail(400, '「' + q.title + '」需要 1–' + q.max + ' 的整数评分');
      out[q.id] = n;
    } else {
      const cap = q.maxLen || 500;
      const v = str(raw, cap + 1).trim();
      if (v.length > cap) fail(400, '「' + q.title + '」最多 ' + cap + ' 字');
      if (!v) { if (q.required) fail(400, '「' + q.title + '」是必答题'); continue; }
      out[q.id] = v;
    }
  }
  return out;
}

/* ---------- 人群解析 / 快照 ---------- */
async function resolveAudience(pool, ann) {
  const meta = parseJSON(ann.audience_meta) || {};
  let rows;
  if (ann.audience === 'custom') {
    const names = Array.isArray(meta.usernames) ? meta.usernames.slice(0, MAX_CUSTOM_USERS) : [];
    if (!names.length) return [];
    const ph = names.map(() => '?').join(',');
    [rows] = await pool.query(`SELECT id FROM accounts WHERE username IN (${ph})`, names);
  } else if (ann.audience === 'verified') {
    [rows] = await pool.query('SELECT a.id FROM accounts a JOIN verified_students v ON v.account_id=a.id AND v.email=a.email WHERE COALESCE(a.banned,0)=0');
  } else if (ann.audience === 'weekly_match') {
    const key = str(meta.batch_key, 10);
    if (!key) return [];
    [rows] = await pool.query('SELECT e.account_id id FROM weekly_match_enrollments e JOIN accounts a ON a.id=e.account_id WHERE e.batch_key=? AND e.active=1 AND COALESCE(a.banned,0)=0', [key]);
  } else {
    [rows] = await pool.query('SELECT id FROM accounts WHERE COALESCE(banned,0)=0');
  }
  return rows.map(r => Number(r.id));
}
async function snapshotAudience(pool, id) {
  const [rows] = await pool.execute('SELECT audience,audience_meta FROM announcements WHERE id=?', [id]);
  if (!rows.length) fail(404, '公告不存在');
  const ids = await resolveAudience(pool, rows[0]);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const args = [];
    for (const a of part) args.push(id, a);
    await pool.query(`INSERT IGNORE INTO announcement_audience(announcement_id,account_id) VALUES ${part.map(() => '(?,?)').join(',')}`, args);
  }
  return ids.length;
}

/* ---------- 投递（写 user_notifications；Web Push 由 notify 的 drain 负责） ---------- */
async function fanout(pool, id) {
  const [rows] = await pool.execute('SELECT id,kind,title,summary,link,revision,channel_reminder FROM announcements WHERE id=?', [id]);
  if (!rows.length) fail(404, '公告不存在');
  const a = rows[0];
  await snapshotAudience(pool, id);
  let sent = 0;
  if (Number(a.channel_reminder)) {
    const [aud] = await pool.query('SELECT account_id FROM announcement_audience WHERE announcement_id=?', [id]);
    const ids = aud.map(r => Number(r.account_id));
    const title = str(a.title, N_TITLE);
    const body = str(a.summary || (a.kind === 'survey' ? '有一份问卷调研等你填写' : ''), N_BODY);
    const link = str(a.link || (a.kind === 'survey' ? '/app-survey?id=' + id : '/notifications'), N_LINK);
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const part = ids.slice(i, i + CHUNK);
        const args = [];
        for (const acc of part) args.push(acc, 'notice', title, body, link, str(`announcement:${id}:r${a.revision}:${acc}`, N_DEDUP));
        await pool.query(`INSERT IGNORE INTO user_notifications(account_id,kind,title,body,link,dedup_key) VALUES ${part.map(() => '(?,?,?,?,?,?)').join(',')}`, args);
        sent += part.length;
      }
    } catch (e) {
      // 通知只是辅助通道：通知表缺失/约束异常不能阻断发布（与 notify.record 同款口径）
      if (!/doesn't exist|no such table|Unknown table/i.test(e.message || '')) throw e;
    }
  }
  await pool.execute('UPDATE announcements SET notified_at=UTC_TIMESTAMP() WHERE id=?', [id]);
  return sent;
}

/* ---------- 统计 ---------- */
const answersOf = r => parseJSON(r.answers) || {};
async function aggregateStats(pool, id) {
  const [rows] = await pool.execute('SELECT id,kind,title,questions FROM announcements WHERE id=?', [id]);
  if (!rows.length) fail(404, '公告不存在');
  const ann = rows[0];
  const questions = parseJSON(ann.questions) || [];
  const [[{ audience_count }]] = await pool.execute('SELECT COUNT(*) audience_count FROM announcement_audience WHERE announcement_id=?', [id]);
  const [[{ response_count }]] = await pool.execute('SELECT COUNT(*) response_count FROM announcement_responses WHERE announcement_id=?', [id]);
  const [res] = await pool.query(`SELECT r.account_id,a.username,r.answers,r.submitted_at FROM announcement_responses r JOIN accounts a ON a.id=r.account_id WHERE r.announcement_id=? ORDER BY r.id LIMIT ${MAX_ROWS}`, [id]);

  const question_stats = questions.map(q => {
    const stat = { id: q.id, type: q.type, title: q.title, required: !!q.required };
    if (q.type === 'single' || q.type === 'multi') {
      const counts = new Map(q.options.map(o => [o.value, 0]));
      let total = 0;
      for (const r of res) {
        const v = answersOf(r)[q.id];
        let hit = false;
        const list = q.type === 'multi' ? (Array.isArray(v) ? v : []) : (typeof v === 'string' ? [v] : []);
        for (const x of list) if (counts.has(x)) { counts.set(x, counts.get(x) + 1); hit = true; }
        if (hit) total++;
      }
      stat.total = total;
      stat.buckets = q.options.map(o => ({ value: o.value, label: o.label, count: counts.get(o.value) }));
    } else if (q.type === 'rating') {
      const counts = new Map();
      for (let i = 1; i <= q.max; i++) counts.set(i, 0);
      let total = 0, sum = 0;
      for (const r of res) { const n = Number(answersOf(r)[q.id]); if (counts.has(n)) { counts.set(n, counts.get(n) + 1); total++; sum += n; } }
      stat.total = total;
      stat.average = total ? Math.round(sum / total * 100) / 100 : null;
      stat.buckets = [...counts.keys()].map(v => ({ value: v, label: v + ' 分', count: counts.get(v) }));
    } else {
      const texts = [];
      for (const r of res) { const t = answersOf(r)[q.id]; if (typeof t === 'string' && t.trim()) texts.push({ username: r.username, text: t.slice(0, 500) }); }
      stat.total = texts.length;
      stat.texts = texts.slice(0, 200);
    }
    return stat;
  });
  return { kind: ann.kind, title: ann.title, questions, question_stats,
    audience_count: Number(audience_count), response_count: Number(response_count) };
}
async function nonResponders(pool, id, limit = MAX_ROWS) {
  const n = Math.min(Math.max(1, Number(limit) || MAX_ROWS), MAX_ROWS);
  const [rows] = await pool.query(`SELECT a.username FROM announcement_audience aa JOIN accounts a ON a.id=aa.account_id
    LEFT JOIN announcement_responses r ON r.announcement_id=aa.announcement_id AND r.account_id=aa.account_id
    WHERE aa.announcement_id=? AND r.id IS NULL ORDER BY a.username LIMIT ${n}`, [id]);
  return rows.map(r => r.username);
}

/* ---------- 用户侧查询 ---------- */
async function cards(pool, accountId, limit = 10) {
  const n = Math.min(Math.max(1, Number(limit) || 10), 20);
  const [rows] = await pool.query(`SELECT a.id,a.kind,a.title,a.summary,a.link,a.end_at,a.published_at,
      EXISTS(SELECT 1 FROM announcement_responses r WHERE r.announcement_id=a.id AND r.account_id=?) AS responded
    FROM announcements a JOIN announcement_audience aa ON aa.announcement_id=a.id AND aa.account_id=?
    WHERE a.status='published' AND a.channel_home=1
      AND (a.start_at IS NULL OR a.start_at<=UTC_TIMESTAMP())
      AND (a.end_at IS NULL OR a.end_at>=UTC_TIMESTAMP())
    ORDER BY a.published_at DESC, a.id DESC LIMIT ${n}`, [accountId, accountId]);
  return rows.map(r => ({ id: Number(r.id), kind: r.kind, title: r.title, summary: r.summary,
    link: r.link, end_at: r.end_at, published_at: r.published_at, responded: !!Number(r.responded) }));
}
async function detailFor(pool, accountId, id) {
  const [rows] = await pool.query(`SELECT a.id,a.kind,a.title,a.summary,a.body,a.link,a.questions,a.end_at,a.published_at,a.status,
      (SELECT COUNT(*) FROM announcement_audience aa WHERE aa.announcement_id=a.id AND aa.account_id=?) AS in_audience
    FROM announcements a WHERE a.id=?`, [accountId, id]);
  const a = rows[0];
  if (!a) fail(404, '内容不存在或已下线');
  if (a.status !== 'published') fail(404, '内容不存在或已下线');
  if (!Number(a.in_audience)) fail(403, '该内容不面向你开放');
  const [w] = await pool.query(`SELECT (start_at IS NULL OR start_at<=UTC_TIMESTAMP()) AS started,
      (end_at IS NULL OR end_at>=UTC_TIMESTAMP()) AS not_ended FROM announcements WHERE id=?`, [id]);
  if (!Number(w[0].started) || !Number(w[0].not_ended)) fail(409, '内容不在展示时间内');
  const [mine] = await pool.execute('SELECT answers,submitted_at FROM announcement_responses WHERE announcement_id=? AND account_id=?', [id, accountId]);
  return { id: Number(a.id), kind: a.kind, title: a.title, summary: a.summary, body: a.body,
    link: a.link, end_at: a.end_at, published_at: a.published_at,
    questions: parseJSON(a.questions) || [], responded: !!mine.length,
    my_answers: mine.length ? (parseJSON(mine[0].answers) || {}) : null,
    submitted_at: mine.length ? mine[0].submitted_at : null };
}

module.exports = {
  KIND_OK, AUDIENCE_OK, Q_TYPES, MAX_QUESTIONS, MAX_OPTIONS, MAX_CUSTOM_USERS,
  ensureSchema, validateDraft, validateQuestions, validateAnswers, parseJSON,
  resolveAudience, snapshotAudience, fanout, aggregateStats, nonResponders, cards, detailFor,
  chunk: CHUNK,
};
