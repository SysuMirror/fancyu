'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const web = path.join(root, 'web');
const viewMod = require('../web/admin-overview.js');

function rate(n) { return { rate: n, numerator: n, denominator: 100, waiting: 0 }; }
const keys = ['survey', 'coverage', 'agreement', 'chat', 'continuation', 'retention'];
function coreRow(mode) {
  const row = { mode: mode, revision_fills: 1 };
  keys.forEach(function (k, i) { row[k] = rate(10 + i); });
  return row;
}
const total = {};
keys.forEach(function (k, i) { total[k] = rate(21 + i); });
const fixture = {
  generated_at: '2026-11-17T00:00:00Z',
  range: { start: '2026-11-01', end: '2026-11-04' },
  totals: { accounts: 40, verified: 30, verification_rate: 75, weekly_surveys: 8, friend_surveys: 6, cards: 12, pending_reports: 1 },
  period: { registrations: 6, verifications: 3, reports: 1, blocks: 0 },
  modes: [
    { name: '每周恋爱', active: 9, pairs: 4, connected: 1, exchange_rate: 25, skipped: 0, algorithm: 'weekly-v2' },
    { name: '深度交友', active: 7, pairs: 2, connected: 1, exchange_rate: 50, skipped: null, algorithm: 'deep-v1' },
    { name: '约个搭子', active: 5, pairs: 17, connected: 0, exchange_rate: 0, skipped: 1, algorithm: 'buddy-v1' }
  ],
  active: { quick_cards: 3 },
  pause: { quick_cards: 1 },
  trend: [
    { day: '2026-11-01', registrations: 0, verifications: 0, pairs: 0 },
    { day: '2026-11-02', registrations: 4, verifications: 0, pairs: 0 },
    { day: '2026-11-03', registrations: 0, verifications: 0, pairs: 17 },
    { day: '2026-11-04', registrations: 2, verifications: 3, pairs: 5 }
  ],
  core_metrics: {
    total: total,
    rows: [coreRow('love'), coreRow('deep'), coreRow('buddy')],
    started_at: '2026-10-01T00:00:00Z',
    excluded_accounts: 2
  },
  observation_started_at: '2026-10-01T00:00:00Z',
  observations: [],
  card_types: [],
  reports: [],
  statuses: { quick: [] },
  survey_versions: []
};

const view = viewMod.overviewView(fixture);
assert.deepEqual(view.series.registrations, [0, 4, 0, 2]);
assert.deepEqual(view.series.verifications, [0, 0, 0, 3]);
assert.deepEqual(view.series.pairs, fixture.trend.map(function (r) { return r.pairs; }));
assert.equal(view.series.registrations[0], 0);
assert.equal(view.series.registrations[2], 0);
assert.equal(view.series.pairs[2], 17);
assert.equal(view.days.length, 4);
assert.equal(view.days[2].day, '2026-11-03');

const html = view.html;
assert.match(html, /data-series="registrations"/);
assert.match(html, /data-series="verifications"/);
assert.match(html, /data-series="pairs"/);
assert.match(html, /data-day="2026-11-03"[^>]*data-registrations="0"[^>]*data-pairs="17"/);
assert.match(html, /<td>2026-11-03<\/td><td>0<\/td><td>0<\/td><td>17<\/td>/);
assert.match(html, /<td>2026-11-01<\/td><td>0<\/td><td>0<\/td><td>0<\/td>/);
for (const label of ['问卷完成率', '配对覆盖率', '双方同意率', '双向开聊率', '持续交流率', '次周参与率']) {
  assert.ok(html.includes(label), label);
}
for (const name of ['恋爱配对', '深度交友', '约个搭子', '每周恋爱']) assert.ok(html.includes(name), name);
assert.ok(html.includes('不能视为恋爱成功率'));
assert.ok(html.includes('不随日期筛选变化'));
assert.ok(html.includes('所选日期内的新增记录'));
const trendAt = html.indexOf('id="ovTrend"');
const notesAt = html.indexOf('id="ovNotes"');
const coreAt = html.indexOf('id="ovCore"');
assert.ok(coreAt >= 0 && trendAt > coreAt && notesAt > trendAt);
assert.ok(html.indexOf('统计口径、观察期与历史数据说明') > trendAt);
assert.ok(html.indexOf('不能视为恋爱成功率') < trendAt);

const csv = viewMod.overviewCsv(fixture);
assert.ok(csv.includes('新增注册'));
assert.ok(csv.includes('验证记录'));
assert.ok(csv.includes('配对数'));
assert.ok(csv.includes('2026-11-03'));
assert.ok(csv.includes('17'));
assert.ok(csv.includes('注册账号'));
assert.ok(csv.includes('每周恋爱'));
for (const blob of [html, csv]) {
  assert.equal(blob.includes('password'), false);
  assert.equal(blob.includes('@mail'), false);
  assert.equal(blob.includes('微信'), false);
  assert.equal(blob.includes('https://'), false);
  assert.equal(blob.includes('.jpg'), false);
}

const src = fs.readFileSync(path.join(web, 'admin-overview.js'), 'utf8');
assert.match(src, /近 7 天/);
assert.match(src, /近 30 天/);
assert.match(src, /近 90 天/);
assert.match(src, /导出汇总 CSV/);
const adminHtml = fs.readFileSync(path.join(web, 'admin.html'), 'utf8');
assert.match(adminHtml, /type="password"/);
assert.match(adminHtml, /id="loginBtn"/);
assert.match(adminHtml, /管理后台/);
const shell = fs.readFileSync(path.join(web, 'admin-shell.js'), 'utf8');
for (const label of ['数据统计', '深度交友批次', '搭子配对批次', '每周配对批次', '支付定价', '问卷管理', '用户列表', '聊天举报', 'AI助手']) {
  assert.ok(shell.includes(label), label);
}
assert.match(adminHtml, /id="searchInput"/);
assert.match(adminHtml, /id="filterSex"/);
const css = fs.readFileSync(path.join(web, 'admin-overview.css'), 'utf8');
assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.match(css, /animation:\s*none/);
assert.match(css, /transition:\s*none/);
const route = fs.readFileSync(path.join(root, 'api', 'admin-analytics.js'), 'utf8');
assert.match(route, /app\.get\('\/admin\/overview',adminAuthMiddleware/);
assert.ok(fs.existsSync(path.join(root, 'api', 'tests', 'profile-removal.cjs')));
assert.match(fs.readFileSync(path.join(root, 'api', 'tests', 'profile-removal.cjs'), 'utf8'), /\/api\/admin\/overview/);

function el() {
  return { src: '', appendChild() {}, setAttribute() {}, addEventListener() {} };
}
const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Promise: Promise,
  Date: Date,
  URLSearchParams: URLSearchParams,
  document: {
    readyState: 'complete',
    head: { appendChild() {} },
    createElement() { return el(); },
    getElementById() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
  },
  navigator: { userAgent: 'Mozilla/5.0' },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  fetch() { return Promise.resolve({ ok: false, status: 401, json: async function () { return {}; } }); },
  addEventListener() {}
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'admin-overview.js' });
assert.equal(sandbox.module, undefined);
assert.equal(sandbox.require, undefined);
assert.equal(sandbox.exports, undefined);
assert.equal(typeof sandbox.overviewView, 'function');
const painted = sandbox.overviewView(fixture);
assert.match(painted.html, /data-series="verifications"/);
assert.match(painted.html, /data-series="pairs"/);
assert.match(painted.html, /<td>17<\/td>/);
assert.deepEqual(painted.series.pairs, [0, 0, 17, 5]);

console.log('series', JSON.stringify(view.series));
console.log('pairs-only day', view.days[2].day, view.days[2].registrations, view.days[2].pairs);
console.log('core before trend before notes', coreAt < trendAt && trendAt < notesAt);
console.log('csv columns', csv.includes('新增注册') && csv.includes('验证记录') && csv.includes('配对数'));
console.log('vm overviewView pairs', painted.series.pairs.join(','));
console.log('PASS: three-series trend, core rates, current vs period, csv, logged-out admin shell');
