'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { adjustPreviewPlan, recount, applyPlanEdit } = require('./admin-plan-edit');

const pool = [
  { account_id: 1, ref: 11 },
  { account_id: 2, ref: 22 },
  { account_id: 3, ref: 33 },
  { account_id: 4, ref: 44 }
];
const love = [
  { a: 1, b: 2, score: 70, preferred: true, reasons: ['都在南校园'] },
  { a: 3, b: 4, score: 40, preferred: false, reasons: [] }
];

const removed = adjustPreviewPlan({
  plan: love, mode: 'love', op: 'remove', left: 3, right: 4, pool: pool, blocked: new Set()
});
assert.deepEqual(removed.plan.map(function (p) { return [p.a, p.b]; }), [[1, 2]]);

const added = adjustPreviewPlan({
  plan: love, mode: 'love', op: 'add', left: 2, right: 3, pool: pool.map(function (p) { return { account_id: p.account_id }; }),
  blocked: new Set(),
  makePair: function (x, y) { return { a: x.account_id, b: y.account_id, score: null, preferred: false, reasons: [], manual: true }; }
});
assert.deepEqual(added.plan.map(function (p) { return [p.a, p.b]; }), [[2, 3]]);
assert.deepEqual(added.displaced.slice().sort(), [1, 4]);
assert.equal(added.plan.some(function (p) { return p.a === 1 || p.b === 4; }), false);
assert.equal(added.plan.find(function (p) { return p.a === 2 && p.b === 3; }).manual, true);
assert.equal(added.plan.find(function (p) { return p.a === 2; }).score, null);

assert.throws(function () {
  adjustPreviewPlan({ plan: added.plan, mode: 'love', op: 'add', left: 2, right: 3, pool: pool, blocked: new Set(), makePair: function () { return {}; } });
}, function (e) { return e.status === 409; });
assert.throws(function () {
  adjustPreviewPlan({ plan: love, mode: 'love', op: 'remove', left: 1, right: 3, pool: pool, blocked: new Set() });
}, function (e) { return e.status === 404; });
assert.throws(function () {
  adjustPreviewPlan({ plan: [], mode: 'love', op: 'add', left: 1, right: 1, pool: pool, blocked: new Set(), makePair: function () { return {}; } });
}, function (e) { return e.status === 400; });
assert.throws(function () {
  adjustPreviewPlan({ plan: [], mode: 'love', op: 'add', left: 1, right: 9, pool: pool, blocked: new Set(), makePair: function () { return {}; } });
}, function (e) { return e.status === 409; });
assert.throws(function () {
  adjustPreviewPlan({ plan: [], mode: 'love', op: 'add', left: 1, right: 2, pool: pool, blocked: new Set(['1:2']), makePair: function () { return {}; } });
}, function (e) { return e.status === 409; });

const buddy = adjustPreviewPlan({
  plan: [{ a: 11, b: 22, a_id: 1, b_id: 2, score: 80 }],
  mode: 'buddy', op: 'add', left: 1, right: 3, pool: pool.concat([{ account_id: 1, ref: 99 }]),
  blocked: [],
  choose: function (people, a, b) {
    return [people.find(function (p) { return p.account_id === a && p.ref === 99; }), people.find(function (p) { return p.account_id === b; })];
  },
  makePair: function (x, y) { return { a: x.ref, b: y.ref, a_id: x.account_id, b_id: y.account_id, score: 10, manual: true }; }
});
assert.deepEqual(buddy.plan.map(function (p) { return [p.a, p.b, p.a_id, p.b_id]; }), [[99, 33, 1, 3]]);
assert.deepEqual(buddy.displaced, [2]);

const stats = recount({ pool_fingerprint: 'keep', eligible: 4, users: 4, edges: 3 }, 'love', added.plan);
assert.equal(stats.pool_fingerprint, 'keep');
assert.equal(stats.pairs, 1);
assert.equal(stats.unmatched, 2);
assert.equal(stats.manual, 1);
assert.equal(stats.preferred, 0);
assert.equal(stats.mean_score, null);
const deepStats = recount({ fingerprint: 'fp', users: 4 }, 'deep', buddy.plan);
assert.equal(deepStats.fingerprint, 'fp');
assert.equal(deepStats.matched_users, 2);
assert.equal(deepStats.unmatched, 2);
assert.equal(deepStats.mean_score, 10);

const db = {
  async execute(sql, args) {
    const accounts = [{ id: 2, username: 'south' }, { id: 3, username: 'north' }, { id: 1, username: 'left' }];
    if (sql.includes('username=?')) return [accounts.filter(function (r) { return r.username === args[0]; })];
    if (sql.includes('WHERE id=?')) return [accounts.filter(function (r) { return r.id === args[0]; })];
    if (sql.includes(' IN (')) return [accounts.filter(function (r) { return args.includes(r.id); })];
    throw Error('unexpected sql');
  }
};
(async function () {
const edited = await applyPlanEdit(db, {
  status: 'preview', time: new Date('2026-10-28T12:00:00Z'), expiresAt: new Date('2026-11-02T12:00:00Z'),
  revision: 3, body: { op: 'add', a: 'south', b: 'north', revision: 3 },
  plan: love, stats: { pool_fingerprint: 'keep', eligible: 4 }, mode: 'love',
  pool: pool, blocked: new Set(), fingerprintKey: 'pool_fingerprint', fingerprint: 'keep',
  makePair: function (x, y) { return { a: x.account_id, b: y.account_id, score: null, preferred: false, reasons: [], manual: true }; }
});
assert.equal(edited.stats.pool_fingerprint, 'keep');
assert.equal(edited.stats.pairs, 1);
assert.match(edited.msg, /已指定这对/);
assert.match(edited.msg, /left/);
assert.match(edited.msg, /轮空/);
await assert.rejects(applyPlanEdit(db, { status: 'published', body: { op: 'remove', a: 'south', b: 'north' } }), function (e) { return e.status === 409; });
await assert.rejects(applyPlanEdit(db, {
  status: 'preview', time: new Date(), expiresAt: new Date(Date.now() + 86400000), revision: 3,
  body: { op: 'add', a: 'south', b: 'north', revision: 2 }, plan: [], stats: { pool_fingerprint: 'keep' }, mode: 'love', fingerprintKey: 'pool_fingerprint', fingerprint: 'keep'
}), function (e) { return e.status === 409; });

const blob = JSON.stringify(added) + JSON.stringify(buddy) + edited.msg;
assert.equal(blob.includes('password'), false);
assert.equal(blob.includes('@'), false);
assert.equal(blob.includes('微信'), false);

const root = path.join(__dirname);
for (const file of ['weekly-match.js', 'deep-match.js', 'buddy-match.js']) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(src.includes('applyPlanEdit'), file);
  assert.ok(src.includes('/plan\''), file);
}
const ui = fs.readFileSync(path.join(root, '../web/admin-batch.js'), 'utf8');
assert.ok(ui.includes('指定这两人'));
assert.ok(ui.includes('移出'));
assert.ok(ui.includes("data-action=\"plan\""));

console.log('PASS: preview plan add/remove, displacement, blocks, recount');
})().catch(function (e) { console.error(e); process.exitCode = 1; });
