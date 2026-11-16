'use strict';
// 管理后台「用户列表」字段白名单 + 筛选/排序编译器（纯函数，不接 app）。
//
// 约定：前端只提交 f_<field>__<op>=<value>（省略 __op 即 eq），
// 这里按白名单把字段映射成**参数化** SQL；未知字段/未知算子/非法值一律忽略
// （不抛错、不 500），以保证筛选器永远不会变成 SQL 注入入口。
// LIMIT/OFFSET 不在本模块生成，由调用方用已校验的整数拼接（与旧实现一致）。

const MAX_CONDS = 12;
const MAX_IN_VALUES = 50;
const MAX_VALUE_LEN = 200;

const OPS = { eq: '=', ne: '<>', gte: '>=', lte: '<=', gt: '>', lt: '<', contains: 'LIKE', in: 'IN' };

// ---- 派生表达式（同时被 WHERE 与 ORDER BY 使用；MySQL 的 WHERE 不能引用 SELECT 别名）----
const SUB_BUDDY_COUNT = '(SELECT COUNT(*) FROM friend_cards c WHERE c.account_id=a.id AND c.deleted=0)';
const SUB_LOVE_PAIRS = '(SELECT COUNT(*) FROM weekly_match_pairs p WHERE p.a_id=a.id OR p.b_id=a.id)';
const SUB_DEEP_PAIRS = '(SELECT COUNT(*) FROM deep_pairs p WHERE p.a_id=a.id OR p.b_id=a.id)';
const SUB_BUDDY_PAIRS = '(SELECT COUNT(*) FROM friend_card_pairs p WHERE p.a_id=a.id OR p.b_id=a.id)';
const EX_STUDENT_VERIFIED = 'EXISTS(SELECT 1 FROM verified_students v WHERE v.account_id=a.id)';
const EX_HAS_LOVE = 'EXISTS(SELECT 1 FROM weekly_questionnaires w WHERE w.account_id=a.id)';
const EX_HAS_DEEP = 'EXISTS(SELECT 1 FROM deep_surveys d WHERE d.account_id=a.id)';
const EX_HAS_LEGACY_DEEP = 'EXISTS(SELECT 1 FROM friend_survey f WHERE f.account_id=a.id)';
const EX_HAS_PROFILE = 'EXISTS(SELECT 1 FROM account_profiles pf WHERE pf.account_id=a.id)';
const EX_HAS_CHAT = 'EXISTS(SELECT 1 FROM user_chat_messages m WHERE m.sender_id=a.id AND m.deleted_at IS NULL)';
const EX_HAS_BUDDY = `(${SUB_BUDDY_COUNT} > 0)`;
const EX_HAS_LOVE_PAIR = `(${SUB_LOVE_PAIRS} > 0)`;
const EX_HAS_DEEP_PAIR = `(${SUB_DEEP_PAIRS} > 0)`;
const EX_HAS_BUDDY_PAIR = `(${SUB_BUDDY_PAIRS} > 0)`;

const COALESCE_CREATED = 'COALESCE(a.created_at,u.created_at)';
const COALESCE_NICKNAME = 'COALESCE(u.nickname,a.username)';
const COALESCE_EMAIL = 'COALESCE(a.email,u.email)';
const num = expr => `CAST(NULLIF(${expr},'') AS DECIMAL(10,2))`;

const S = (expr, label, ops) => ({ expr, label, type: 'str', ops: ops || ['eq', 'ne', 'in', 'contains'] });
const NUM = (expr, label) => ({ expr, label, type: 'num', ops: ['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'in'] });
const DATE = (expr, label) => ({ expr, label, type: 'date', ops: ['eq', 'ne', 'gte', 'lte', 'gt', 'lt'] });
const BOOL = (expr, label) => ({ expr, label, type: 'bool', ops: ['eq'] });

// 字段全集：users 表 79 列 + accounts + 派生列。key 即前端下拉的取值。
const FILTER_FIELDS = {
  // —— accounts ——
  email: S(COALESCE_EMAIL, '邮箱'),
  account_username: S('a.username', '账号名'),
  account_id: NUM('a.id', '账号 ID'),
  email_verified: BOOL('COALESCE(a.email_verified,0)', '邮箱验证'),
  student_verified: BOOL(EX_STUDENT_VERIFIED, '学邮验证'),
  school: S('COALESCE(a.school,u.school)', '学校'),
  join_matching: BOOL('COALESCE(a.join_matching,0)', '参与恋爱匹配'),
  join_friend_matching: BOOL('COALESCE((SELECT ap.join_friend_matching FROM account_preferences ap WHERE ap.account_id=a.id),0)', '参与深度交友'),
  invite_code: S('a.invite_code', '邀请码'),
  invited_by: NUM('a.invited_by', '邀请人账号 ID'),
  last_login_at: DATE('a.last_login_at', '最近登录'),
  created_at: DATE(COALESCE_CREATED, '注册时间'),

  // —— users 基础资料 ——
  serial_number: S('u.serial_number', '序列号'),
  nickname: S(COALESCE_NICKNAME, '昵称'),
  sex: S('u.sex', '性别'),
  sex_choice: S('u.sex_choice', '性别（选择）'),
  sex_prefer: S('u.sex_prefer', '期望性别'),
  grade: S('u.grade', '年级'),
  grade_prefer: S('u.grade_prefer', '期望年级'),
  campus: S('u.campus', '校区'),
  major: S('u.major', '专业'),
  prefer_major: S('u.prefer_major', '期望专业'),
  major_prefer: S('u.major_prefer', '专业偏好'),
  hometown: S('u.hometown', '家乡'),
  my_school: S('u.my_school', '我的学校'),
  school_prefer: S('u.school_prefer', '期望学校'),
  constellation: S('u.constellation', '星座'),
  constellation_prefer: S('u.constellation_prefer', '期望星座'),
  mbti: S('u.mbti', 'MBTI'),
  mbti_prefer: S('u.mbti_prefer', '期望 MBTI'),
  relationship_goal: S('u.relationship_goal', '恋爱目的'),
  friend_goal: S('u.friend_goal', '交友目的'),
  experience: S('u.experience', '恋爱经历'),
  ex_prefer: S('u.ex_prefer', '在意前任'),
  future_plan: S('u.future_plan', '未来规划'),
  online_offline: S('u.online_offline', '线上/线下'),
  body_type: S('u.body_type', '体型'),
  body_prefer: S('u.body_prefer', '期望体型'),
  fitness_level: S('u.fitness_level', '运动水平'),
  fitness_prefer: S('u.fitness_prefer', '期望运动水平'),
  survey_type: S('u.survey_type', '问卷类型'),
  self_description: S('u.self_description', '自我介绍'),
  ideal_description: S('u.ideal_description', '理想对象'),
  ideal_friend: S('u.ideal_friend', '理想朋友'),
  display_self: S('u.display_self', '展示信息'),
  special_request: S('u.special_request', '补充要求'),
  feedback: S('u.feedback', '反馈'),
  agree_topics: S('u.agree_topics', '同意的话题'),
  expect_quick: S('u.expect_quick', '期望节奏'),
  expect_schools: S('u.expect_schools', '期望学校（多）'),
  expect_school_campuses: S('u.expect_school_campuses', '期望校区（多）'),
  interest_custom: S('u.interest_custom', '自定义兴趣'),
  interests: S('u.interests', '兴趣'),
  q1_co_dependent: S('u.q1_co_dependent', 'Q1 黏人度'),
  q2_conflict: S('u.q2_conflict', 'Q2 冲突处理'),
  q3_ritual: S('u.q3_ritual', 'Q3 仪式感'),
  q4_consumption: S('u.q4_consumption', 'Q4 消费观'),
  q5_life_focus: S('u.q5_life_focus', 'Q5 生活重心'),
  q6_emotion: S('u.q6_emotion', 'Q6 情绪'),
  personality_self_1: S('u.personality_self_1', '性格（自评 1）'),
  personality_self_2: S('u.personality_self_2', '性格（自评 2）'),
  personality_self_3: S('u.personality_self_3', '性格（自评 3）'),
  personality_self_4: S('u.personality_self_4', '性格（自评 4）'),
  personality_self_5: S('u.personality_self_5', '性格（自评 5）'),
  personality_expect_1: S('u.personality_expect_1', '性格（期望 1）'),
  personality_expect_2: S('u.personality_expect_2', '性格（期望 2）'),
  personality_expect_3: S('u.personality_expect_3', '性格（期望 3）'),
  personality_expect_4: S('u.personality_expect_4', '性格（期望 4）'),
  personality_expect_5: S('u.personality_expect_5', '性格（期望 5）'),
  personality_expect_1_no_pref: BOOL('COALESCE(u.personality_expect_1_no_pref,0)', '性格期望 1 不限'),
  personality_expect_2_no_pref: BOOL('COALESCE(u.personality_expect_2_no_pref,0)', '性格期望 2 不限'),
  personality_expect_3_no_pref: BOOL('COALESCE(u.personality_expect_3_no_pref,0)', '性格期望 3 不限'),
  personality_expect_4_no_pref: BOOL('COALESCE(u.personality_expect_4_no_pref,0)', '性格期望 4 不限'),
  personality_expect_5_no_pref: BOOL('COALESCE(u.personality_expect_5_no_pref,0)', '性格期望 5 不限'),
  height: NUM(num('u.height'), '身高'),
  height_min: NUM(num('u.height_min'), '期望身高下限'),
  height_max: NUM(num('u.height_max'), '期望身高上限'),
  beauty_self: NUM(num('u.beauty_self'), '颜值自评'),
  beauty_prefer_min: NUM(num('u.beauty_prefer_min'), '期望颜值下限'),
  updated_at: DATE('u.updated_at', '资料更新时间'),

  // —— 联系方式（人工管理界面可筛；AI 路径另有更严的规则，二者互不影响）——
  contact_email: S('u.contact_email', '联系邮箱', ['eq', 'ne', 'contains']),
  contact_info: S('u.contact_info', '联系方式原文', ['eq', 'ne', 'contains']),
  wechat: S('u.contact_info', '微信（按联系方式原文匹配）', ['contains']),
  phone: S('u.contact_info', '手机（按联系方式原文匹配）', ['contains']),

  // —— 派生/活跃度 ——
  has_love: BOOL(EX_HAS_LOVE, '已填恋爱问卷'),
  has_deep: BOOL(EX_HAS_DEEP, '已填深度交友问卷'),
  has_legacy_deep: BOOL(EX_HAS_LEGACY_DEEP, '有历史深度问卷'),
  has_buddy_cards: BOOL(EX_HAS_BUDDY, '有搭子卡'),
  has_profile: BOOL(EX_HAS_PROFILE, '有个人主页'),
  has_login: BOOL('(a.last_login_at IS NOT NULL)', '登录过'),
  has_chat: BOOL(EX_HAS_CHAT, '发过消息'),
  has_love_pair: BOOL(EX_HAS_LOVE_PAIR, '有恋爱配对'),
  has_deep_pair: BOOL(EX_HAS_DEEP_PAIR, '有深度交友配对'),
  has_buddy_pair: BOOL(EX_HAS_BUDDY_PAIR, '有搭子配对'),
  buddy_count: NUM(SUB_BUDDY_COUNT, '搭子卡数量'),
  love_pair_count: NUM(SUB_LOVE_PAIRS, '恋爱配对数量'),
  deep_pair_count: NUM(SUB_DEEP_PAIRS, '深度交友配对数量'),
  buddy_pair_count: NUM(SUB_BUDDY_PAIRS, '搭子配对数量'),
};

// 排序白名单：key -> SQL 表达式（未知一律回落 created_at）
const SORT_MAP = {
  created_at: COALESCE_CREATED,
  updated_at: 'u.updated_at',
  nickname: COALESCE_NICKNAME,
  sex: 'u.sex',
  campus: 'u.campus',
  grade: 'u.grade',
  major: 'u.major',
  height: num('u.height'),
  email: COALESCE_EMAIL,
  account_id: 'a.id',
  last_login_at: 'a.last_login_at',
  email_verified: 'COALESCE(a.email_verified,0)',
  student_verified: EX_STUDENT_VERIFIED,
  has_love: EX_HAS_LOVE,
  has_deep: EX_HAS_DEEP,
  has_buddy_cards: EX_HAS_BUDDY,
  has_chat: EX_HAS_CHAT,
  buddy_count: SUB_BUDDY_COUNT,
  love_pair_count: SUB_LOVE_PAIRS,
  deep_pair_count: SUB_DEEP_PAIRS,
  buddy_pair_count: SUB_BUDDY_PAIRS,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const clampPageSize = v => Math.min(200, Math.max(1, parseInt(v, 10) || 20));
const clampPage = v => Math.max(1, parseInt(v, 10) || 1);

function parseBool(v) {
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return 1;
  if (['0', 'false', 'no', 'off'].includes(s)) return 0;
  return null;
}

function buildSort(sort, order) {
  const key = Object.hasOwn(SORT_MAP, String(sort)) ? String(sort) : 'created_at';
  const dir = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return { key, dir, expr: SORT_MAP[key] };
}

// 把一个 f_<field>__<op>=<value> 编译成 {sql, params}；不合法返回 null（静默忽略）。
function compileCondition(field, op, rawValue) {
  const meta = Object.hasOwn(FILTER_FIELDS, field) ? FILTER_FIELDS[field] : null;
  if (!meta) return null;
  const operator = op || 'eq';
  if (!meta.ops.includes(operator)) return null;
  let value = rawValue;
  if (Array.isArray(value)) value = value[value.length - 1];
  if (value === undefined || value === null) return null;
  value = String(value);
  if (!value.length || value.length > MAX_VALUE_LEN) return null;

  if (meta.type === 'bool') {
    const b = parseBool(value);
    if (b === null) return null;
    return { sql: `${meta.expr} = ?`, params: [b] };
  }
  if (meta.type === 'num') {
    if (operator === 'in') {
      const list = value.split(',').map(x => x.trim()).filter(Boolean).slice(0, MAX_IN_VALUES);
      const nums = list.map(Number).filter(Number.isFinite);
      if (!nums.length) return null;
      return { sql: `${meta.expr} IN (${nums.map(() => '?').join(',')})`, params: nums };
    }
    if (operator === 'contains') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return { sql: `${meta.expr} ${OPS[operator]} ?`, params: [n] };
  }
  if (meta.type === 'date') {
    if (!DATE_RE.test(value)) return null;
    let v = value.replace('T', ' ');
    // 只给日期的区间上界补到当天末尾，避免 "含当天" 变成 "含当天 00:00"
    if (DATE_ONLY_RE.test(v) && (operator === 'lte' || operator === 'gt' || operator === 'eq')) v += ' 23:59:59';
    return { sql: `${meta.expr} ${OPS[operator]} ?`, params: [v] };
  }
  // str
  if (operator === 'in') {
    const list = value.split(',').map(x => x.trim()).filter(Boolean).slice(0, MAX_IN_VALUES);
    if (!list.length) return null;
    return { sql: `${meta.expr} IN (${list.map(() => '?').join(',')})`, params: list };
  }
  if (operator === 'contains') return { sql: `${meta.expr} LIKE ?`, params: [`%${value}%`] };
  return { sql: `${meta.expr} ${OPS[operator]} ?`, params: [value] };
}

// 返回 {where:[], params:[], applied:[]}；where 恒含 '1=1'。
function buildFilters(query = {}) {
  const where = ['1=1'];
  const params = [];
  const applied = [];

  // —— 旧参数（保持兼容）——
  const { search, sex, campus, grade, join_matching } = query;
  if (search !== undefined && search !== '') {
    const s = `%${String(search).slice(0, 200)}%`;
    where.push('(COALESCE(u.nickname,a.username) LIKE ? OR u.serial_number LIKE ? OR COALESCE(a.email,u.email) LIKE ? OR u.contact_email LIKE ?)');
    params.push(s, s, s, s);
    applied.push('search');
  }
  for (const [k, expr] of [['sex', 'u.sex'], ['campus', 'u.campus'], ['grade', 'u.grade']]) {
    const v = query[k];
    if (v !== undefined && v !== '') { where.push(`${expr} = ?`); params.push(String(v).slice(0, 40)); applied.push(k); }
  }
  if (join_matching !== undefined && join_matching !== '') {
    const b = parseBool(join_matching);
    if (b !== null) { where.push('COALESCE(a.join_matching,0) = ?'); params.push(b); applied.push('join_matching'); }
  }

  // —— 通用筛选：f_<field>__<op>=<value> ——
  let conds = 0;
  for (const key of Object.keys(query)) {
    if (conds >= MAX_CONDS) break;
    if (!key.startsWith('f_')) continue;
    const rest = key.slice(2);
    const i = rest.lastIndexOf('__');           // 字段名本身含下划线，只能用最后一个 __ 分隔算子
    const field = i < 0 ? rest : rest.slice(0, i);
    const op = i < 0 ? undefined : rest.slice(i + 2);
    if (!/^[a-z0-9_]+$/.test(field) || (op !== undefined && !/^[a-z]+$/.test(op))) continue;
    const compiled = compileCondition(field, op, query[key]);
    if (!compiled) continue;
    where.push(compiled.sql);
    params.push(...compiled.params);
    applied.push(op ? `${field}__${op}` : field);
    conds++;
  }
  return { where, params, applied };
}

// 供前端「条件构造器」渲染的字段表。
function fieldCatalog() {
  return Object.entries(FILTER_FIELDS).map(([key, m]) => ({ key, label: m.label, type: m.type, ops: m.ops }));
}

// ---- 整表导出（服务端 CSV）----
// key 与 web/admin.html 的 USER_COLUMNS 对齐；值一律在这里派生，杜绝任意表达式。
// 依赖 USER_SELECT_SQL 的结果行（含 u.contact_info），经 extractContacts 后取 wechat/phone。
const EXPORT_COLUMNS = [
  { key: 'account_id', label: '账号ID' },
  { key: 'nickname', label: '昵称' },
  { key: 'account_username', label: '账号名' },
  { key: 'sex', label: '性别' },
  { key: 'campus', label: '校区' },
  { key: 'grade', label: '年级' },
  { key: 'major', label: '专业' },
  { key: 'school', label: '学校' },
  { key: 'height', label: '身高' },
  { key: 'mbti', label: 'MBTI' },
  { key: 'email', label: '邮箱' },
  { key: 'wechat', label: '微信' },
  { key: 'phone', label: '手机' },
  { key: 'student_verified', label: '学邮验证' },
  { key: 'email_verified', label: '邮箱验证' },
  { key: 'has_love', label: '恋爱问卷' },
  { key: 'has_deep', label: '深度交友问卷' },
  { key: 'buddy_count', label: '搭子卡' },
  { key: 'has_chat', label: '发过消息' },
  { key: 'love_pair_count', label: '恋爱配对' },
  { key: 'deep_pair_count', label: '深度配对' },
  { key: 'join_matching', label: '恋爱匹配' },
  { key: 'created_at', label: '注册时间' },
  { key: 'last_login_at', label: '最近登录' },
];
const EXPORT_KEYS = EXPORT_COLUMNS.map(c => c.key);
const yesno = v => (Number(v) ? '是' : '否');

// 值的唯一出处（row 已过 extractContacts）
function exportCell(key, row) {
  const r = row || {};
  switch (key) {
    case 'nickname': return r.nickname || r.account_username || '';
    case 'sex': return r.sex || '';
    case 'school': return r.school || r.account_school || r.my_school || '';
    case 'height': return r.height ? String(r.height) : '';
    case 'email': return r.email || r.contact_email || '';
    case 'student_verified': return r.student_verified ? '已验证' : '未验证';
    case 'email_verified': return r.email_verified == 1 ? '已验证' : '未验证';
    case 'has_love': return r.has_love ? '已填' : '未填';
    case 'has_deep': return r.has_deep ? '已填' : (r.has_legacy_deep ? '旧版' : '未填');
    case 'has_chat': return r.has_chat ? '是' : '否';
    case 'join_matching': return r.join_matching == 1 ? '参与' : '未参与';
    case 'created_at': return r.created_at ? String(r.created_at).slice(0, 19) : '';
    case 'last_login_at': return r.last_login_at ? String(r.last_login_at).slice(0, 19) : '';
    default: return r[key] === null || r[key] === undefined ? '' : String(r[key]);
  }
}

// cols= 白名单：只认 EXPORT_KEYS，保持 EXPORT_COLUMNS 的规范顺序；空值给全集。
function exportColumns(cols) {
  const list = String(cols || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return EXPORT_COLUMNS.slice();
  const picked = EXPORT_KEYS.filter(k => list.includes(k));
  return picked.length ? EXPORT_COLUMNS.filter(c => picked.includes(c.key)) : EXPORT_COLUMNS.slice();
}

// CSV 单元格：与 web/admin.html 同款公式注入防护
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  const guarded = /^[=+@\-\t\r]/.test(s) ? "'" + s : s;
  return /[",\r\n]/.test(guarded) ? '"' + guarded.replace(/"/g, '""') + '"' : guarded;
}

// ---- 分布统计（GET /admin/distribution）----
// 只允许 str/bool 且**不含联系方式**的字段；expr 直接复用 FILTER_FIELDS（静态表达式，无占位符）。
const GROUPABLE = {
  campus: '校区',
  sex: '性别',
  sex_prefer: '期望性别（取向）',
  sex_choice: '性别（选择）',
  grade: '年级',
  major: '专业',
  school: '学校',
  hometown: '家乡',
  constellation: '星座',
  mbti: 'MBTI',
  relationship_goal: '恋爱目的',
  friend_goal: '交友目的',
  experience: '恋爱经历',
  body_type: '体型',
  online_offline: '线上/线下',
  survey_type: '问卷类型',
  join_matching: '参与恋爱匹配',
  join_friend_matching: '参与深度交友',
  email_verified: '邮箱验证',
  student_verified: '学邮验证',
  has_love: '已填恋爱问卷',
  has_deep: '已填深度交友问卷',
  has_profile: '有个人主页',
  has_chat: '发过消息',
};

function groupableCatalog() {
  return Object.entries(GROUPABLE).map(([key, label]) => ({ key, label }));
}
// 返回 {expr,label}；未知字段返回 null（调用方 400）
function groupableField(key) {
  if (!Object.hasOwn(GROUPABLE, String(key))) return null;
  const m = FILTER_FIELDS[key];
  return { key, label: GROUPABLE[key], expr: m.expr, type: m.type };
}

// 把 users.contact_info（JSON [{type|method|label, value}] 或纯文本）拆成 wechat/phone。
// 只做展示派生，不改库、不参与筛选。
function extractContacts(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { wechat: '', phone: '', contacts: [] };
  const push = (label, value) => {
    if (!value) return;
    const l = String(label || '').toLowerCase();
    out.contacts.push({ label: String(label || '联系方式'), value: String(value) });
    if (/微信|wechat|wx/.test(l)) out.wechat = out.wechat || String(value);
    else if (/手机|电话|phone|tel|联系方式/.test(l) && /\d{5,}/.test(String(value))) out.phone = out.phone || String(value);
  };
  const raw = row.contact_info;
  let parsed = null;
  if (typeof raw === 'string' && raw.trim()) {
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    if (!parsed) {
      push('联系方式', raw.trim().slice(0, 200));
    }
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed.slice(0, 20)) {
      if (item && typeof item === 'object') push(item.type || item.method || item.label || item.name, item.value || item.content || item.text);
      else if (item) push('联系方式', item);
    }
  } else if (parsed && typeof parsed === 'object') {
    push('联系方式', parsed.value || parsed.text || JSON.stringify(parsed).slice(0, 200));
  }
  return Object.assign(row, out);
}

module.exports = {
  FILTER_FIELDS, SORT_MAP, fieldCatalog,
  buildFilters, buildSort, compileCondition,
  clampPageSize, clampPage, parseBool, extractContacts,
  EXPORT_COLUMNS, exportColumns, exportCell, csvCell,
  GROUPABLE, groupableCatalog, groupableField,
  MAX_CONDS, MAX_IN_VALUES,
};
