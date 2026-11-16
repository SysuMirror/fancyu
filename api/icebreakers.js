'use strict';
// 配对破冰话题：连接建立了但谁都不开口，是这类产品最常见的死局。
// 选题是确定性的（用 mode:pair_id:round 播种），同一会话同一轮看到的是同一批，
// 免得点一下刷一批、两边各看各的；「换一批」靠 round 递增。
const POOL = {
    love: [
        '你们第一次见面最想一起去中大的哪个角落？',
        '说说对方问卷里让你最有好感的一句话。',
        '如果只能带一样东西去孤岛，你会带什么？',
        '最近一次笑得停不下来是因为什么？',
        '你更相信一见钟情还是日久生情，为什么？',
        '分享一首你最近单曲循环的歌，说说理由。',
        '你们各自理想的周末是什么样子？',
        '大学里做过最冲动的一件事是什么？',
        '有没有一部电影/一本书让你改变过想法？',
        '你希望对方记住你的哪一点？',
        '聊聊你们共同认识的人或事，破个冰。',
        '如果现在可以立刻去一个地方旅行，去哪里？'
    ],
    deep: [
        '你最近在为什么事情花心思？',
        '过去一年你最大的变化是什么？',
        '什么话题能让你聊到停不下来？',
        '你怎么定义「聊得来」？',
        '你希望朋友在什么时候找你？',
        '你有没有一直想做但还没开始的事？',
        '说说你身上一个别人常误解的地方。',
        '最近一次被陌生人的善意打动是什么时候？',
        '你更享受独处还是热闹，为什么？',
        '如果给对方一个建议，会是什么？'
    ],
    buddy: [
        '你们想约的第一件事是什么？（饭 / 自习 / 运动）',
        '各自最方便的时间段是什么时候？',
        '校区和常待的地方说一下，方便约。',
        '你最近想学/想练的一件事是什么？',
        '有没有踩过雷的搭子经历，想避开的？',
        '吃饭口味偏好？有没有忌口？',
        '运动的话你一般在哪儿、什么时间？',
        '自习你喜欢图书馆还是教室，为什么？'
    ]
};
const COMMON = [
    '介绍一下你自己吧，一句话就行。',
    '打个招呼：你平时都在忙些什么？',
    '有什么想问对方的吗？随便聊。'
];

function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}
// 用 LCG 做可复现洗牌（同一个 seed 一定得到同一个顺序）
function pick(arr, n, seed) {
    const a = arr.slice();
    let s = seed >>> 0 || 1;
    for (let i = a.length - 1; i > 0; i--) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        const j = s % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
}

module.exports = function (app, { getPool, authMiddleware, access }) {
    app.get('/account/chat/:mode/:id/icebreakers', authMiddleware, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const id = req.account.account_id, mode = String(req.params.mode), pairId = Number(req.params.id);
        const round = Math.min(9, Math.max(0, Number(req.query.round) || 0));
        if (!Number.isSafeInteger(pairId) || pairId < 1) return res.status(400).json({ code: 400, msg: '编号无效' });
        const c = await (await getPool()).getConnection();
        try {
            // 走 chat 的 access()：不属于我 / 已结束 / 被封禁的会话一律拿不到话题
            await access(c, id, mode, pairId);
        } catch (e) {
            c.release();
            return res.status(e.status || 503).json({ code: e.status || 503, msg: e.status ? e.message : '暂时不可用，请稍后重试' });
        }
        try {
            const seed = hash(mode + ':' + pairId + ':' + round);
            const topics = pick(POOL[mode] || POOL.love, 3, seed).concat(pick(COMMON, 1, seed ^ 0x9e3779b9));
            res.json({ code: 200, mode, round, topics });
        } finally { c.release(); }
    });
    return {};
};
