'use strict';
// 用户侧：首页卡片 / 站内详情 / 问卷提交；以及「定时公告到点自动投递」的 60s tick。
//
// 投递本身在 announce-store.fanout（写 user_notifications），这里只负责到点触发。
module.exports = function (app, { getPool, authMiddleware, store }) {
  const route = fn => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await store.ensureSchema(getPool);
      res.json(Object.assign({ code: 200 }, await fn(req)));
    } catch (e) {
      console.error('Announce:', e.status || e.code || e.name);
      if (!res.headersSent) res.status(e.status || 503).json({ code: e.status || 503, msg: e.status ? e.message : '服务暂时不可用，请稍后重试' });
    }
  };
  const badId = () => { const e = Error('编号无效'); e.status = 400; return e; };
  const notFound = () => { const e = Error('内容不存在或已下线'); e.status = 404; return e; };

  // 首页卡片位：只返回「已发布 + 主页展示 + 在展示时间内 + 我在名册里」的内容
  app.get('/account/announcements', authMiddleware, route(async req => ({
    announcements: await store.cards(await getPool(), req.account.account_id, req.query.limit)
  })));

  // 详情（通知=标题+正文；问卷=题干+我自己的答案，绝不返回他人答案）
  app.get('/account/announcements/:id', authMiddleware, route(async req => {
    if (!/^\d+$/.test(req.params.id)) throw badId();
    return { announcement: await store.detailFor(await getPool(), req.account.account_id, Number(req.params.id)) };
  }));

  // 提交 / 修改答案：只能改，不会重复计（UNIQUE(announcement_id,account_id)）
  app.post('/account/announcements/:id/answers', authMiddleware, route(async req => {
    if (!/^\d+$/.test(req.params.id)) throw badId();
    const id = Number(req.params.id), acc = req.account.account_id;
    const pool = await getPool();
    const [rows] = await pool.execute("SELECT id,kind,questions,status,channel_home,(start_at IS NULL OR start_at<=UTC_TIMESTAMP()) started,(end_at IS NULL OR end_at>=UTC_TIMESTAMP()) not_ended FROM announcements WHERE id=?", [id]);
    const a = rows[0];
    if (!a || a.status !== 'published') throw notFound();
    if (a.kind !== 'survey') { const e = Error('这是通知，不需要填写'); e.status = 400; throw e; }
    if (!Number(a.started) || !Number(a.not_ended)) { const e = Error('该问卷不在填写时间内'); e.status = 409; throw e; }
    const [[member]] = await pool.execute('SELECT COUNT(*) n FROM announcement_audience WHERE announcement_id=? AND account_id=?', [id, acc]);
    if (!Number(member.n)) { const e = Error('该问卷不面向你开放'); e.status = 403; throw e; }
    const questions = store.parseJSON(a.questions) || [];
    const answers = store.validateAnswers(questions, req.body && req.body.answers);
    await pool.execute(`INSERT INTO announcement_responses(announcement_id,account_id,answers,submitted_at) VALUES (?,?,?,UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE answers=VALUES(answers),submitted_at=VALUES(submitted_at)`, [id, acc, JSON.stringify(answers)]);
    return { msg: '已提交，可随时回来修改', answered: Object.keys(answers).length };
  }));

  /* ---------- 定时投递：到点把「已发布但尚未投递」的内容 fanout 出去 ---------- */
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      await store.ensureSchema(getPool);
      const pool = await getPool();
      const [due] = await pool.query(`SELECT id FROM announcements
        WHERE status='published' AND channel_reminder=1 AND notified_at IS NULL
          AND (start_at IS NULL OR start_at<=UTC_TIMESTAMP())
          AND (end_at IS NULL OR end_at>=UTC_TIMESTAMP())
        ORDER BY id LIMIT 20`);
      for (const r of due) {
        try {
          const n = await store.fanout(pool, Number(r.id));
          if (n) console.log('[announce] 定时投递 #' + r.id + ' → ' + n + ' 人');
        } catch (e) { console.error('[announce] fanout #' + r.id + ':', e.status || e.code || e.name); }
      }
    } catch (e) { console.error('Announce scheduler:', e.status || e.code || e.name); }
    finally { running = false; }
  }
  function start() {
    const t = setInterval(() => tick(), 60000); t.unref();
    const f = setTimeout(() => tick(), 12000); f.unref();
    return () => { clearInterval(t); clearTimeout(f); };
  }

  return { start, tick };
};
