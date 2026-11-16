'use strict';
// 问卷 schema 的公开读取 + 后台管理路由。前端 fetch('/api/survey-schema/:kind')（/api 前缀已剥离）。
module.exports = function (app, { getPool, adminAuthMiddleware, audit }) {
  const store = require('./survey-schema');
  const h = fn => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await store.init(getPool); await fn(req, res); }
    catch (e) { res.status(e.problems ? 400 : 503).json({ code: e.problems ? 400 : 503, msg: e.message, problems: e.problems }); }
  };
  app.get('/survey-schema/:kind', h(async (req, res) => {
    try { res.json({ code: 200, ...store.snapshot(req.params.kind) }); }
    catch (e) { res.status(404).json({ code: 404, msg: e.message }); }
  }));
  app.get('/admin/survey-schemas', adminAuthMiddleware, h(async (req, res) =>
    res.json({ code: 200, kinds: store.kinds.map(k => ({ kind: k, name: ({ weekly: '每周恋爱问卷', buddy: '搭子卡片', deep: '深度交友问卷' })[k], version: store.snapshot(k).version })) })));
  app.get('/admin/survey-schema/:kind', adminAuthMiddleware, h(async (req, res) => {
    try { res.json({ code: 200, ...store.snapshot(req.params.kind), locked: [...(req.params.kind === 'deep' ? store.DEEP_LOCKED : req.params.kind === 'weekly' ? store.WEEKLY_LOCKED : [])] }); }
    catch (e) { res.status(404).json({ code: 404, msg: e.message }); }
  }));
  app.put('/admin/survey-schema/:kind', adminAuthMiddleware, h(async (req, res) => {
    const r = await store.save(getPool, req.params.kind, req.body.schema, req.body.force === true);
    if (audit && audit.write) audit.write(req.admin, { action: 'survey_schema.save', target_type: 'survey_schema', target_id: req.params.kind, method: req.method, path: req.originalUrl, status_code: 200, detail: { version: r.version, force: req.body.force === true } });
    res.json({ code: 200, ...r, msg: '已保存，新版本 ' + r.version });
  }));
};
