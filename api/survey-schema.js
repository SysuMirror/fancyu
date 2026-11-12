'use strict';
// 问卷 schema 后台化：survey_schemas 表 + 进程内存缓存；文件版作为种子与兜底。
// current(kind) 同步取当前 schema（匹配/校验逻辑都是同步的），save() 后立即更新内存。
const SEEDS = {
  weekly: () => require('../web/weekly-schema'),
  buddy: () => require('../web/friends-schema'),
  deep: () => require('../web/deep-schema')
};
const mem = {};
for (const kind of Object.keys(SEEDS)) {
  const s = SEEDS[kind]();
  mem[kind] = { version: String(s.version || '1.0'), schema: s };
}
let boot = null;
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);

async function init(getPool) {
  if (boot) return boot;
  boot = (async () => {
    const pool = await getPool();
    await pool.query(`CREATE TABLE IF NOT EXISTS survey_schemas (
      kind VARCHAR(16) PRIMARY KEY, version VARCHAR(16) NOT NULL, \`schema\` JSON NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const [rows] = await pool.query('SELECT kind, version, `schema` FROM survey_schemas');
    for (const r of rows) mem[r.kind] = { version: r.version, schema: json(r.schema) };
  })().catch(e => { boot = null; console.error('survey-schema init:', e.message); throw e; });
  return boot;
}

function current(kind) {
  if (kind === 'deep-options') { const d = current('deep'); return { schools: d.schools, categories: d.interests.categories }; } // 兼容旧引用：由 deep 派生
  if (!mem[kind]) throw Error('未知问卷类型 ' + kind); return mem[kind].schema;
}
function snapshot(kind) {
  if (kind === 'deep-options') { const d = snapshot('deep'); return { kind, version: d.version, schema: current('deep-options') }; }
  if (!mem[kind]) throw Error('未知问卷类型 ' + kind); const m = mem[kind]; return { kind, version: m.version, schema: m.schema };
}
function bump(v) { const m = /^(\d+)\.(\d+)$/.exec(String(v)); return m ? m[1] + '.' + (Number(m[2]) + 1) : String(v) + '.' + Date.now().toString(36); }

// ===== 结构校验 =====
const WEEKLY_TYPES = ['radio', 'multi', 'scale', 'month', 'age', 'education', 'college', 'number', 'height', 'hometown', 'text'];
// weekly-match-rules 的硬过滤/方向计分依赖这些题号：不可删除、不可改类型；改选项需 force。
const WEEKLY_LOCKED = new Set(['1','2','3','4','5','6','7','8','10a','10b','11','12','13','17a','17b','18','19','20','21','22','23','24a','24b','25','27a','27b','28a','28b','29a','29b','30','31','32','33','40','41','42a','42b','43','44','45','46','47','48a','48b']);
// 选项数组「已有项被改动/删除」才需要 force；纯追加是安全的。
const optsChanged = (before, after) => Array.isArray(before) && (!Array.isArray(after) || before.some(v => !after.includes(v)));

function checkWeekly(next, prev, force) {
  const problems = [];
  if (!Array.isArray(next.sections) || !next.sections.length || next.sections.some(s => typeof s !== 'string' || !s.trim())) problems.push('分区列表需为非空字符串数组');
  if (typeof next.longTerm !== 'string' || !next.longTerm.trim()) problems.push('longTerm（长期恋爱选项文案）不能为空');
  if (!Array.isArray(next.questions) || !next.questions.length) problems.push('题目列表不能为空');
  const byId = {};
  (next.questions || []).forEach((q, i) => {
    if (!q || typeof q !== 'object') return problems.push('第 ' + (i + 1) + ' 个题目不是对象');
    if (!/^\d+[ab]?$/.test(String(q.id))) problems.push('题号 ' + q.id + ' 不合法（应为数字，可带 a/b）');
    if (byId[q.id]) problems.push('题号 ' + q.id + ' 重复');
    byId[q.id] = q;
    if (!q.title || typeof q.title !== 'string') problems.push('题 ' + q.id + ' 缺少题干');
    if (!WEEKLY_TYPES.includes(q.type)) problems.push('题 ' + q.id + ' 类型不合法：' + q.type);
    if (!Array.isArray(q.options)) problems.push('题 ' + q.id + ' options 需为数组');
    if (q.type === 'multi' && (!Number.isInteger(q.min) || !Number.isInteger(q.max) || q.min < 1 || q.max < q.min)) problems.push('题 ' + q.id + ' min/max 不合法');
    if (!Number.isInteger(q.section) || q.section < 0 || q.section >= (next.sections || []).length) problems.push('题 ' + q.id + ' section 越界');
    if (q.type === 'scale' && (q.options || []).length < 2) problems.push('题 ' + q.id + ' 量表至少需要 2 个选项');
  });
  const prevById = Object.fromEntries((prev.questions || []).map(q => [q.id, q]));
  for (const id of WEEKLY_LOCKED) {
    const after = byId[id], before = prevById[id];
    if (!after) { problems.push('题 ' + id + ' 被匹配逻辑依赖，不能删除'); continue; }
    if (before && after.type !== before.type) problems.push('题 ' + id + ' 被匹配逻辑依赖，不能改类型');
    if (before && optsChanged(before.options, after.options) && !force) problems.push('题 ' + id + ' 的选项被匹配逻辑依赖，修改需勾选「我已了解影响」');
  }
  for (const q of prev.questions || []) {
    if (WEEKLY_LOCKED.has(q.id)) continue;
    const after = byId[q.id];
    if (!after && !force) problems.push('删除题 ' + q.id + ' 需勾选「我已了解影响」');
    if (after && optsChanged(q.options, after.options) && !force) problems.push('题 ' + q.id + ' 修改了已有选项，需勾选「我已了解影响」');
  }
  if (next.weights != null) {
    if (typeof next.weights !== 'object' || Array.isArray(next.weights) ||
        Object.entries(next.weights).some(([k, v]) => !/^\d+$/.test(k) || !(v >= 0 && v <= 5)))
      problems.push('weights 需为「题组号 → 0–5 数值」的对象');
  }
  return problems;
}

function checkBuddy(next, prev, force) {
  const problems = [];
  if (!next.TYPES || typeof next.TYPES !== 'object' || !Object.keys(next.TYPES).length) problems.push('TYPES 需为非空对象');
  if (!Array.isArray(next.COMMON)) problems.push('COMMON 需为数组');
  if (!Number.isInteger(next.MAX) || next.MAX < 1 || next.MAX > 20) problems.push('MAX 需为 1–20 的整数');
  const fields = s => [...Object.values(s.TYPES || {}).flatMap(t => [t.main, ...(t.extra || [])]), ...(s.COMMON || [])];
  for (const f of fields(next)) {
    if (!f || !f.key || !f.label) problems.push('字段缺少 key/label');
    if (!f.text && !Array.isArray(f.opts)) problems.push('字段 ' + (f.key || '?') + ' 缺少选项列表');
  }
  for (const [key, t] of Object.entries(next.TYPES || {})) {
    if (!t.name) problems.push('类型 ' + key + ' 缺少名称');
    if (!t.main || !t.main.key) problems.push('类型 ' + key + ' 缺少主选项');
  }
  // 删除类型 / 改已有选项内容需 force（旧卡片与匹配逻辑都按文案存储）
  for (const [key, before] of Object.entries(prev.TYPES || {})) {
    const after = (next.TYPES || {})[key];
    if (!after && !force) problems.push('删除搭子类型「' + (before.name || key) + '」需勾选「我已了解影响」');
    if (after) {
      if (optsChanged(before.main?.opts, after.main?.opts) && !force) problems.push('「' + before.name + '」主选项改动需勾选「我已了解影响」');
      for (const bf of before.extra || []) { const af = (after.extra || []).find(x => x.key === bf.key); if (optsChanged(bf.opts, af?.opts) && !force) problems.push('「' + before.name + '」' + bf.label + '选项改动需勾选「我已了解影响」'); }
    }
  }
  for (const bf of prev.COMMON || []) {
    const af = (next.COMMON || []).find(x => x.key === bf.key);
    if (!af && !force) problems.push('删除公共字段「' + bf.label + '」需勾选「我已了解影响」');
    if (af && optsChanged(bf.opts, af.opts) && !force) problems.push('公共字段「' + bf.label + '」选项改动需勾选「我已了解影响」');
  }
  return problems;
}

// ===== 深度交友问卷（全量 schema）=====
// deep-rules 的校验/匹配依赖这些字段 key：不可删除；选项改动需 force。题干/提示文案可自由改。
const DEEP_TYPES = ['options', 'tags', 'select', 'text', 'textarea', 'major', 'campus', 'expect-campus', 'personality', 'interests', 'photos', 'contacts'];
const DEEP_LOCKED = new Set(['sex', 'sex_prefer', 'grade', 'grade_prefer', 'major_category', 'major_detail', 'major_prefer', 'hometown', 'school', 'own_campus', 'expect_quick', 'expect_schools', 'expect_school_campuses', 'online_offline', 'mbti', 'personality', 'friend_goal', 'interests', 'self_description', 'ideal_friend', 'special_request', 'photos', 'display_self', 'contact_entries']);
const optValues = a => (a || []).map(v => (typeof v === 'object' && v !== null ? v.value : v));

function checkDeep(next, prev, force) {
  const problems = [];
  if (!Array.isArray(next.steps) || !next.steps.length || next.steps.length > 12 || next.steps.some(s => typeof s !== 'string' || !s.trim())) problems.push('steps 需为 1–12 个非空步骤名');
  if (!next.schools || typeof next.schools !== 'object' || Array.isArray(next.schools)) problems.push('schools 需为「学校 → 校区数组」对象');
  for (const [school, campuses] of Object.entries(next.schools || {})) {
    if (!Array.isArray(campuses) || !campuses.length || campuses.some(c => typeof c !== 'string' || !c.trim())) problems.push('学校「' + school + '」校区列表需为非空字符串数组');
  }
  if (!Array.isArray(next.cards) || next.cards.length !== (next.steps || []).length) problems.push('cards 需与 steps 一一对应（每步一个卡片数组）');
  const seen = {};
  (next.cards || []).forEach((cards, si) => {
    if (!Array.isArray(cards)) return problems.push('第 ' + (si + 1) + ' 步的 cards 需为数组');
    cards.forEach((c, ci) => {
      const where = '第 ' + (si + 1) + ' 步卡片 ' + (ci + 1);
      if (!c || typeof c !== 'object' || typeof c.label !== 'string' || !c.label.trim()) return problems.push(where + ' 缺少 label');
      if (!Array.isArray(c.items)) return problems.push(where + ' items 需为数组');
      c.items.forEach(it => {
        if (!it || typeof it.key !== 'string' || !it.key.trim()) return problems.push(where + ' 有字段缺少 key');
        if (seen[it.key]) return problems.push('字段 key 重复：' + it.key);
        seen[it.key] = it;
        if (!DEEP_TYPES.includes(it.type)) return problems.push('字段 ' + it.key + ' 类型不合法：' + it.type);
        if (['options', 'tags', 'select'].includes(it.type)) {
          const list = it.groups ? Object.values(it.groups).flat() : it.options;
          if (it.type === 'select' && it.fromSchools) { if (it.options || it.groups) problems.push('字段 ' + it.key + ' fromSchools 与 options/groups 互斥'); return; }
          if (!Array.isArray(list) || !list.length) return problems.push('字段 ' + it.key + ' 缺少选项列表');
          const vals = optValues(list);
          if (vals.some(v => typeof v !== 'string' || !v.trim()) || new Set(vals).size !== vals.length) problems.push('字段 ' + it.key + ' 选项需为非空且不重复');
        }
        if (it.max != null && !Number.isInteger(it.max)) problems.push('字段 ' + it.key + ' max 需为整数');
      });
    });
  });
  if (!Array.isArray(next.personality) || !next.personality.length || next.personality.length > 12) problems.push('personality 需为 1–12 个滑块维度');
  next.personality?.forEach((p, i) => {
    for (const k of ['title', 'self', 'left', 'right']) if (typeof p?.[k] !== 'string' || !p[k].trim()) problems.push('性格维度 ' + (i + 1) + ' 缺少 ' + k);
  });
  const itc = next.interests;
  if (!itc || typeof itc !== 'object') problems.push('interests 配置缺失');
  else {
    if (!Array.isArray(itc.categories) || !itc.categories.length || new Set(itc.categories).size !== itc.categories.length) problems.push('兴趣大类需为非空且不重复的数组');
    if (itc.subcategories && (typeof itc.subcategories !== 'object' || Array.isArray(itc.subcategories) || Object.values(itc.subcategories).some(a => !Array.isArray(a)))) problems.push('subcategories 需为「大类 → 数组」对象');
    for (const k of ['skillLevels', 'freq']) {
      if (!Array.isArray(itc[k]) || !itc[k].length || new Set(itc[k]).size !== itc[k].length) problems.push('interests.' + k + ' 需为非空且不重复的数组');
    }
    if (Array.isArray(itc.freq) && !itc.freq.includes('没要求')) problems.push('interests.freq 必须包含「没要求」（匹配逻辑依赖）');
  }
  if (!next.photos || !Number.isInteger(next.photos.max) || next.photos.max < 1 || next.photos.max > 6) problems.push('photos.max 需为 1–6 的整数');
  if (!next.contacts || !Array.isArray(next.contacts.methods) || !next.contacts.methods.length || new Set(next.contacts.methods).size !== next.contacts.methods.length) problems.push('contacts.methods 需为非空且不重复的数组');

  // ===== 变更语义（对照 prev）=====
  const prevItems = {};
  (prev.cards || []).forEach(cards => (cards || []).forEach(c => (c.items || []).forEach(it => { prevItems[it.key] = it; })));
  for (const [key, after] of Object.entries(seen)) {
    const before = prevItems[key];
    if (!before) { if (!force) problems.push('新增字段「' + key + '」需勾选「我已了解影响」（确认匹配逻辑兼容）'); continue; }
    if (DEEP_LOCKED.has(key) && after.type !== before.type) problems.push('字段「' + key + '」被匹配逻辑依赖，不能改类型');
    const bo = before.groups ? Object.values(before.groups).flat() : before.options, ao = after.groups ? Object.values(after.groups).flat() : after.options;
    if (optsChanged(optValues(bo), optValues(ao)) && !force) problems.push('字段「' + key + '」修改了已有选项，需勾选「我已了解影响」');
  }
  for (const key of Object.keys(prevItems)) {
    if (DEEP_LOCKED.has(key)) { if (!seen[key]) problems.push('字段「' + key + '」被匹配逻辑依赖，不能删除'); continue; }
    if (!seen[key] && !force) problems.push('删除字段「' + key + '」需勾选「我已了解影响」');
  }
  for (const [school, before] of Object.entries(prev.schools || {})) {
    const after = (next.schools || {})[school];
    if (!after && !force) problems.push('删除学校「' + school + '」需勾选「我已了解影响」');
    if (after && optsChanged(before, after) && !force) problems.push('学校「' + school + '」校区改动需勾选「我已了解影响」');
  }
  const pic = prev.interests || {};
  if (optsChanged(pic.categories, itc?.categories) && !force) problems.push('兴趣大类改动需勾选「我已了解影响」');
  if (optsChanged(pic.skillLevels, itc?.skillLevels) && !force) problems.push('熟练度选项改动需勾选「我已了解影响」（匹配按文案计分）');
  if (optsChanged(pic.freq, itc?.freq) && !force) problems.push('交流频次选项改动需勾选「我已了解影响」（匹配按顺序计分）');
  if (optsChanged((prev.contacts || {}).methods, next.contacts?.methods) && !force) problems.push('联系方式类型改动需勾选「我已了解影响」');
  // deep 匹配维度权重（deep-rules 计分用）：可选；缺省沿用代码内默认值。
  if (next.weights != null) {
    const DIMS = ['interests', 'personality', 'friend_goal', 'online_offline', 'grade_prefer', 'major_prefer'];
    if (typeof next.weights !== 'object' || Array.isArray(next.weights) ||
        Object.entries(next.weights).some(([k, v]) => !DIMS.includes(k) || typeof v !== 'number' || !(v >= 0 && v <= 100)))
      problems.push('weights 需为「匹配维度（interests/personality/friend_goal/online_offline/grade_prefer/major_prefer）→ 0–100 数值」的对象');
  }
  return problems;
}

async function save(getPool, kind, next, force) {
  if (!mem[kind]) throw Error('未知问卷类型 ' + kind);
  if (!next || typeof next !== 'object') throw Error('schema 不能为空');
  const prev = mem[kind].schema;
  const problems = kind === 'weekly' ? checkWeekly(next, prev, force)
    : kind === 'buddy' ? checkBuddy(next, prev, force)
    : kind === 'deep' ? checkDeep(next, prev, force)
    : ['未知问卷类型 ' + kind];
  if (problems.length) { const e = Error(problems.join('；')); e.problems = problems; throw e; }
  const version = bump(mem[kind].version);
  const pool = await getPool();
  await pool.execute('INSERT INTO survey_schemas(kind,version,`schema`) VALUES (?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),`schema`=VALUES(`schema`)', [kind, version, JSON.stringify(next)]);
  mem[kind] = { version, schema: next };
  return { version };
}

module.exports = { init, current, snapshot, save, kinds: Object.keys(SEEDS), WEEKLY_LOCKED, DEEP_LOCKED };
