'use strict';
// 管理侧：发布 / 编辑「通知 或 问卷调研」→ 可选推送到提醒、可选主页卡片 → 人群 + 定时 → 回收统计与导出。
//
//  - 每个写操作在业务提交之后落 admin_audit_log（detail 只放 id/计数/状态，绝不放正文/题目/答案）；
//  - 统计与导出只出「用户名 + 计数」，不含邮箱与联系方式；CSV 走 csvCell 做公式注入防护。
const { csvCell } = require('./admin-users');
const store = require('./announce-store');

const COLS = `a.id,a.kind,a.title,a.summary,a.body,a.link,a.questions,a.audience,a.audience_meta,
 a.channel_reminder,a.channel_home,a.status,a.revision,a.created_by,
 DATE_FORMAT(a.start_at,'%Y-%m-%dT%H:%i:%sZ') start_at,
 DATE_FORMAT(a.end_at,'%Y-%m-%dT%H:%i:%sZ') end_at,
 DATE_FORMAT(a.published_at,'%Y-%m-%dT%H:%i:%sZ') published_at,
 DATE_FORMAT(a.notified_at,'%Y-%m-%dT%H:%i:%sZ') notified_at,
 DATE_FORMAT(a.created_at,'%Y-%m-%dT%H:%i:%sZ') created_at,
 DATE_FORMAT(a.updated_at,'%Y-%m-%dT%H:%i:%sZ') updated_at`;

module.exports = function (app, { getPool, adminAuthMiddleware, audit }) {
  const ok = (status, msg) => { const e = Error(msg); e.status = status; return e; };

  const route = fn => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.params.id !== undefined && !/^\d+$/.test(req.params.id)) return res.status(400).json({ code: 400, msg: '编号无效' });
    try {
      await store.ensureSchema(getPool);
      const out = await fn(req, res);
      if (res.headersSent || out === undefined) return;
      res.json(Object.assign({ code: 200 }, out));
    } catch (e) {
      console.error('Admin announcements:', e.status || e.code || e.name);
      if (!res.headersSent) res.status(e.status || 503).json({ code: e.status || 503, msg: e.status ? e.message : '操作失败，请稍后重试' });
    }
  };
  const auditIt = (req, action, id, detail, good = true) => audit.write(req.admin, {
    action, target_type: 'announcement', target_id: id === null || id === undefined ? null : String(id),
    method: req.method, path: req.originalUrl, status_code: good ? 200 : 400,
    detail, ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || null
  });
  const shape = r => ({ ...r,
    id: Number(r.id), revision: Number(r.revision),
    channel_reminder: !!Number(r.channel_reminder), channel_home: !!Number(r.channel_home),
    questions: store.parseJSON(r.questions), audience_meta: store.parseJSON(r.audience_meta),
    audience_count: r.audience_count === undefined ? undefined : Number(r.audience_count),
    response_count: r.response_count === undefined ? undefined : Number(r.response_count) });
  const loadRaw = async (pool, id) => {
    const [rows] = await pool.query(`SELECT ${COLS},(SELECT COUNT(*) FROM announcement_responses r WHERE r.announcement_id=a.id) response_count FROM announcements a WHERE a.id=?`, [id]);
    return rows[0] ? shape(rows[0]) : null;
  };

  /* ---------- 批次下拉（人群=本周配对报名者时用） ---------- */
  app.get('/admin/announcements/batches', adminAuthMiddleware, route(async () => {
    const open = require('./weekly-match-rules').openBatch().key;
    let recent = [];
    try {
      const [rows] = await (await getPool()).query('SELECT batch_key FROM weekly_match_batches ORDER BY batch_key DESC LIMIT 12');
      recent = rows.map(r => r.batch_key);
    } catch (e) { /* 表不存在时只用当前批次 */ }
    if (recent[0] !== open) recent = [open, ...recent.filter(k => k !== open)];
    return { open, batches: recent.slice(0, 13) };
  }));

  /* ---------- 列表 ---------- */
  app.get('/admin/announcements', adminAuthMiddleware, route(async req => {
    const where = [], args = [];
    if (['draft', 'published', 'archived'].includes(req.query.status)) { where.push('a.status=?'); args.push(req.query.status); }
    if (['notice', 'survey'].includes(req.query.kind)) { where.push('a.kind=?'); args.push(req.query.kind); }
    const [rows] = await (await getPool()).query(`SELECT ${COLS},
        (SELECT COUNT(*) FROM announcement_audience aa WHERE aa.announcement_id=a.id) audience_count,
        (SELECT COUNT(*) FROM announcement_responses r WHERE r.announcement_id=a.id) response_count
      FROM announcements a ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 200`, args);
    return { announcements: rows.map(shape) };
  }));

  /* ---------- 详情 ---------- */
  app.get('/admin/announcements/:id', adminAuthMiddleware, route(async req => {
    const a = await loadRaw(await getPool(), Number(req.params.id));
    if (!a) throw ok(404, '公告不存在');
    const [[{ audience_count }]] = await (await getPool()).execute('SELECT COUNT(*) audience_count FROM announcement_audience WHERE announcement_id=?', [a.id]);
    return { announcement: { ...a, audience_count: Number(audience_count) } };
  }));

  /* ---------- 新建草稿 ---------- */
  app.post('/admin/announcements', adminAuthMiddleware, route(async req => {
    const d = store.validateDraft(req.body);
    const pool = await getPool();
    const createdBy = audit.adminKey(req.admin);
    const createdById = req.admin && req.admin.admin_account_id != null ? Number(req.admin.admin_account_id) : null;
    const [r] = await pool.execute(`INSERT INTO announcements(kind,title,summary,body,link,questions,audience,audience_meta,channel_reminder,channel_home,start_at,end_at,status,created_by,created_by_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,
      [d.kind, d.title, d.summary, d.body, d.link, d.questions ? JSON.stringify(d.questions) : null, d.audience,
       d.audience_meta ? JSON.stringify(d.audience_meta) : null, d.channel_reminder, d.channel_home, d.start_at, d.end_at, createdBy, createdById]);
    auditIt(req, 'announcement.create', r.insertId, { kind: d.kind, audience: d.audience, channels: [d.channel_reminder ? 'reminder' : null, d.channel_home ? 'home' : null].filter(Boolean), questions: d.questions ? d.questions.length : 0 });
    return { msg: '草稿已保存', id: r.insertId };
  }));

  /* ---------- 修改 ---------- */
  app.put('/admin/announcements/:id', adminAuthMiddleware, route(async req => {
    const pool = await getPool();
    const ex = await loadRaw(pool, Number(req.params.id));
    if (!ex) throw ok(404, '公告不存在');
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const merged = {
      kind: 'kind' in b ? b.kind : ex.kind,
      title: 'title' in b ? b.title : ex.title,
      summary: 'summary' in b ? b.summary : ex.summary,
      body: 'body' in b ? b.body : ex.body,
      link: 'link' in b ? b.link : ex.link,
      questions: 'questions' in b ? b.questions : ex.questions,
      audience: 'audience' in b ? b.audience : ex.audience,
      audience_meta: 'audience_meta' in b ? b.audience_meta : ex.audience_meta,
      channel_reminder: 'channel_reminder' in b ? b.channel_reminder : ex.channel_reminder,
      channel_home: 'channel_home' in b ? b.channel_home : ex.channel_home,
      start_at: 'start_at' in b ? b.start_at : ex.start_at,
      end_at: 'end_at' in b ? b.end_at : ex.end_at,
    };
    // 已发布/已归档：人群、题型与生效时间一律以库里的为准（快照与回收率已经绑定），只允许改文案/渠道/失效时间
    if (ex.status !== 'draft') {
      for (const k of ['kind', 'questions', 'audience', 'audience_meta', 'start_at']) merged[k] = ex[k];
    }
    // 已有人作答时，改题目会作废旧答案（值对不上新选项）
    const qNow = JSON.stringify(merged.questions || null), qOld = JSON.stringify(ex.questions || null);
    if (qNow !== qOld && ex.response_count > 0 && !(b.force === true)) {
      throw ok(400, '已有 ' + ex.response_count + ' 份回答，修改题目会让旧答案失效；如确需修改请加 force');
    }
    const d = store.validateDraft(merged);
    await pool.execute(`UPDATE announcements SET kind=?,title=?,summary=?,body=?,link=?,questions=?,audience=?,audience_meta=?,channel_reminder=?,channel_home=?,start_at=?,end_at=? WHERE id=?`,
      [d.kind, d.title, d.summary, d.body, d.link, d.questions ? JSON.stringify(d.questions) : null, d.audience,
       d.audience_meta ? JSON.stringify(d.audience_meta) : null, d.channel_reminder, d.channel_home, d.start_at, d.end_at, ex.id]);
    auditIt(req, 'announcement.update', ex.id, { status: ex.status, questions_changed: qNow !== qOld, response_count: ex.response_count, forced: b.force === true });
    return { msg: '已保存' };
  }));

  /* ---------- 发布 ---------- */
  app.post('/admin/announcements/:id/publish', adminAuthMiddleware, route(async req => {
    const pool = await getPool();
    const ex = await loadRaw(pool, Number(req.params.id));
    if (!ex) throw ok(404, '公告不存在');
    if (ex.status === 'archived') throw ok(400, '已归档的内容不能再次发布');
    const d = store.validateDraft({ ...ex, questions: ex.questions, audience_meta: ex.audience_meta });   // 发布前再校验一次
    await pool.execute("UPDATE announcements SET status='published', published_at=COALESCE(published_at,UTC_TIMESTAMP()) WHERE id=?", [ex.id]);
    const n = await deliver(pool, ex.id);
    const [[{ audience_count }]] = await pool.execute('SELECT COUNT(*) audience_count FROM announcement_audience WHERE announcement_id=?', [ex.id]);
    auditIt(req, 'announcement.publish', ex.id, { kind: d.kind, audience: d.audience, audience_count: Number(audience_count), notified: n, scheduled: !!(d.start_at && new Date(d.start_at) > new Date()) });
    return { msg: n ? '已发布并推送' : '已发布（尚未到生效时间）', audience_count: Number(audience_count), notified: n };
  }));

  /* ---------- 重新推送（revision+1 → dedup 变化 → 重新送达） ---------- */
  app.post('/admin/announcements/:id/republish', adminAuthMiddleware, route(async req => {
    const pool = await getPool();
    const ex = await loadRaw(pool, Number(req.params.id));
    if (!ex) throw ok(404, '公告不存在');
    if (ex.status !== 'published') throw ok(400, '只有已发布的内容可以重新推送');
    await pool.execute('UPDATE announcements SET revision=revision+1 WHERE id=?', [ex.id]);
    const n = await deliver(pool, ex.id);
    auditIt(req, 'announcement.republish', ex.id, { revision: ex.revision + 1, notified: n });
    return { msg: n ? '已重新推送' : '已重置（尚未到生效时间）', revision: ex.revision + 1, notified: n };
  }));

  /* ---------- 归档 / 删除 ---------- */
  app.post('/admin/announcements/:id/archive', adminAuthMiddleware, route(async req => {
    const pool = await getPool();
    const ex = await loadRaw(pool, Number(req.params.id));
    if (!ex) throw ok(404, '公告不存在');
    await pool.execute("UPDATE announcements SET status='archived' WHERE id=?", [ex.id]);
    auditIt(req, 'announcement.archive', ex.id, { from: ex.status });
    return { msg: '已归档' };
  }));
  app.delete('/admin/announcements/:id', adminAuthMiddleware, route(async req => {
    const pool = await getPool();
    const ex = await loadRaw(pool, Number(req.params.id));
    if (!ex) throw ok(404, '公告不存在');
    if (ex.status !== 'draft') throw ok(400, '只有草稿可以删除；已发布的内容请改用归档');
    await pool.execute('DELETE FROM announcements WHERE id=?', [ex.id]);
    auditIt(req, 'announcement.delete', ex.id, { kind: ex.kind });
    return { msg: '草稿已删除' };
  }));

  /* ---------- 回收统计 ---------- */
  app.get('/admin/announcements/:id/stats', adminAuthMiddleware, route(async req => {
    const pool = await getPool();
    const s = await store.aggregateStats(pool, Number(req.params.id));
    return { stats: s, non_responders: await store.nonResponders(pool, Number(req.params.id), 500) };
  }));

  /* ---------- 导出 CSV（responses / non_responders） ---------- */
  app.get('/admin/announcements/:id/export', adminAuthMiddleware, route(async (req, res) => {
    const id = Number(req.params.id), pool = await getPool();
    const [rows] = await pool.execute('SELECT id,title,questions FROM announcements WHERE id=?', [id]);
    if (!rows.length) throw ok(404, '公告不存在');
    const type = req.query.type === 'non_responders' ? 'non_responders' : 'responses';
    const questions = store.parseJSON(rows[0].questions) || [];
    const lines = [];
    if (type === 'non_responders') {
      lines.push(csvCell('用户名'));
      for (const u of await store.nonResponders(pool, id, 20000)) lines.push(csvCell(u));
    } else {
      const [rs] = await pool.query(`SELECT a.username,r.answers,DATE_FORMAT(r.submitted_at,'%Y-%m-%d %H:%i:%s') submitted_at
        FROM announcement_responses r JOIN accounts a ON a.id=r.account_id WHERE r.announcement_id=? ORDER BY r.id LIMIT 20000`, [id]);
      lines.push([csvCell('用户名'), csvCell('提交时间'), ...questions.map(q => csvCell(q.title))].join(','));
      for (const r of rs) {
        const ans = store.parseJSON(r.answers) || {};
        const cells = [csvCell(r.username), csvCell(r.submitted_at)];
        for (const q of questions) cells.push(csvCell(cellText(q, ans[q.id])));
        lines.push(cells.join(','));
      }
    }
    auditIt(req, 'announcement.export', id, { type, rows: lines.length - 1 });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="announcement-${id}-${type}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  }));

  /* 把某条公告投递出去：先按当前人群快照，只有「在展示时间内」才真正写通知（否则留给定时 tick） */
  async function deliver(pool, id) {
    await store.snapshotAudience(pool, id);
    const [w] = await pool.execute('SELECT (start_at IS NULL OR start_at<=UTC_TIMESTAMP()) started,(end_at IS NULL OR end_at>=UTC_TIMESTAMP()) not_ended FROM announcements WHERE id=?', [id]);
    if (!Number(w[0].started) || !Number(w[0].not_ended)) return 0;
    return store.fanout(pool, id);
  }
  function cellText(q, v) {
    if (v === undefined || v === null || v === '') return '';
    if (q.type === 'single') { const o = (q.options || []).find(x => x.value === v); return o ? o.label : String(v); }
    if (q.type === 'multi') return (Array.isArray(v) ? v : [v]).map(x => { const o = (q.options || []).find(y => y.value === x); return o ? o.label : x; }).join('、');
    return String(v);
  }

  return { COLS };
};
