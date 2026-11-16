'use strict';
// 资料完善度引导：把「下一步该做什么」摊开给用户看，别让人注册完就迷路。
// 每一项都单独 try/catch —— 某个模块的表还没建时，只算这项未完成，不能整页 500。
module.exports = function (app, { getPool, authMiddleware }) {
    // 每项：key / 文案 / 完成判据（返回 true/false 的查询）/ 去哪补
    const ITEMS = [
        { key: 'verified', label: '验证学生邮箱', hint: '验证后才能参与配对', link: '/verify-student',
          sql: 'SELECT 1 FROM verified_students WHERE account_id=? LIMIT 1' },
        { key: 'avatar', label: '设置头像', hint: '有头像的人更容易被回应', link: '/profile',
          sql: "SELECT 1 FROM account_profiles WHERE account_id=? AND avatar<>'' LIMIT 1" },
        { key: 'bio', label: '写一句个人简介', hint: '20–100 字，说说你自己', link: '/profile',
          sql: "SELECT 1 FROM account_profiles WHERE account_id=? AND bio<>'' LIMIT 1" },
        { key: 'love', label: '填写每周恋爱问卷', hint: '填完才能进入每周配对', link: '/survey',
          sql: 'SELECT 1 FROM weekly_match_enrollments WHERE account_id=? AND active=1 LIMIT 1' },
        { key: 'deep', label: '填写深度交友问卷', hint: '更认真地认识一个人', link: '/deep',
          sql: 'SELECT 1 FROM deep_surveys WHERE account_id=? LIMIT 1' },
        { key: 'buddy', label: '发布一张搭子卡', hint: '找饭搭子、自习搭子也很快', link: '/friends',
          sql: 'SELECT 1 FROM friend_cards WHERE account_id=? AND deleted=0 LIMIT 1' }
    ];

    app.get('/account/profile-guide', authMiddleware, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            const id = req.account.account_id, p = await getPool(), items = [];
            for (const it of ITEMS) {
                let done = false;
                try { const [r] = await p.execute(it.sql, [id]); done = r.length > 0; }
                catch (e) { done = false; }
                items.push({ key: it.key, label: it.label, hint: it.hint, link: it.link, done });
            }
            const done = items.filter(x => x.done).length;
            res.json({ code: 200, done, total: items.length, percent: Math.round(done * 100 / items.length), items,
                       next: (items.find(x => !x.done) || {}).key || null });
        } catch (e) {
            res.status(e.status || 503).json({ code: e.status || 503, msg: '资料检查暂时不可用，请稍后重试' });
        }
    });

    return { ITEMS };
};
