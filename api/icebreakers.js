'use strict';
// 配对破冰话题，两种：
//   ① 空白会话（谁都没开口）→ 静态 POOL。选题是确定性的（用 mode:pair_id:round 播种），
//      同一会话同一轮看到的是同一批，免得点一下刷一批、两边各看各的；「换一批」靠 round 递增。
//   ② 双方都开口之后 → AI 破冰助手（/icebreakers/llm）：按双方昵称 + 最近几条消息生成 3 条接得住的话题。
//      生成结果按 (mode,pair_id,round) 入库缓存，两边共用同一批，同一轮不重复调用模型；失败回落静态 POOL。
// 隐私：只有双方都在这个会话发过消息（access 已通过）才会生成；发往模型的只有双方昵称与最近 24 条消息，
//      先做联系方式脱敏（手机号/微信/QQ），不含问卷、联系方式、账号等信息。
const fs = require('fs'), path = require('path');
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
const MODE_NAME = { love: '恋爱配对', deep: '深度交友', buddy: '约个搭子' };
const MAX_ROUNDS = 5;          // 最多 5 批，够用且把模型调用量钉死
const KEEP_MSGS = 24;          // 送给模型的最近消息条数
const DAILY_CAP = 300;         // 全站每天最多生成次数（缓存里当日行数），超了直接给静态话题
const FAST_TIMEOUT_MS = 12000; // 关掉「思考」后的正常耗时（实测 3–4 秒）
const TIMEOUT_MS = 45000;      // 网关不认「关思考」参数时的退路（实测 12–25 秒，给足余量）

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
function staticTopics(mode, pairId, round) {
    const seed = hash(mode + ':' + pairId + ':' + round);
    return pick(POOL[mode] || POOL.love, 3, seed).concat(pick(COMMON, 1, seed ^ 0x9e3779b9));
}
// 联系方式不进模型：手机号、微信/QQ 号一律抹掉
function scrub(s) {
    return String(s || '')
        .replace(/1[3-9]\d{9}/g, '[号码已省略]')
        .replace(/(?:微信|wechat|weixin|vx|wx|qq)\s*(?:号|id)?\s*[:：]?\s*[A-Za-z0-9_\-]{4,}/gi, '[联系方式已省略]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

module.exports = function (app, { getPool, authMiddleware, access, now = () => new Date(), fetchImpl = fetch, env = {} }) {
    let ready;
    const inflight = new Map();   // mode:pair:round -> Promise，防止两边同时点导致重复调用
    function ensureSchema() {
        if (!ready) ready = (async () => {
            const p = await getPool();
            for (const sql of fs.readFileSync(path.join(__dirname, 'icebreakers-schema.sql'), 'utf8').split(';').map(x => x.trim()).filter(Boolean)) await p.query(sql);
        })().catch(e => { ready = null; throw e; });
        return ready;
    }

    // 双方都发过消息（撤回/空消息不算）
    async function bothSpoke(c, mode, pairId, p) {
        const [rows] = await c.execute(`SELECT sender_id,COUNT(*) n FROM user_chat_messages
            WHERE mode=? AND pair_id=? AND deleted_at IS NULL AND (body<>'' OR image_id IS NOT NULL) GROUP BY sender_id`, [mode, pairId]);
        const who = new Set(rows.filter(r => Number(r.n) > 0).map(r => Number(r.sender_id)));
        return who.has(Number(p.a_id)) && who.has(Number(p.b_id));
    }

    async function recentMessages(c, mode, pairId, id, peerName, myName) {
        const [rows] = await c.execute(`SELECT sender_id,body,image_id FROM user_chat_messages
            WHERE mode=? AND pair_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT ${KEEP_MSGS}`, [mode, pairId]);
        return rows.reverse().map(r => {
            const who = Number(r.sender_id) === Number(id) ? (myName || '我') : (peerName || '对方');
            const text = scrub(r.body) || (r.image_id ? '[图片]' : '');
            return text ? who + '：' + text : '';
        }).filter(Boolean);
    }

    async function budgetLeft(c) {
        const [[{ n }]] = await c.execute(`SELECT COUNT(*) n FROM chat_icebreaker_cache WHERE created_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY)`);
        return Number(n) < DAILY_CAP;
    }

    const SYSTEM = '你是校园交友平台的破冰助手。两位同学已经开口聊了几句，请给他们 3 条能自然接下去的话题。'
        + '要求：每条都写成一句可以直接发给对方的话（可以是问句），口语化、具体，不要写成标签或标题；'
        + '顺着他们已经聊到的内容往下走，不要重复他们已说过的信息；'
        + '不要谈钱、住址、外貌打分、隐私联系方式，也不要替任何一方表白或做承诺；'
        + '只输出 JSON，格式 {"topics":["话题1","话题2","话题3"]}，不要输出别的文字。';
    function userPrompt(mode, myName, a, lines) {
        return '场景：' + (MODE_NAME[mode] || '聊天') + '\n'
            + '我方昵称：' + (myName || '我') + '\n对方昵称：' + (a.name || '对方') + '\n'
            + '最近聊天记录（旧→新）：\n' + lines.join('\n');
    }
    function parseTopics(raw) {
        let plan;
        try { plan = JSON.parse(raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); } catch (e) { throw Error('parse'); }
        const topics = (Array.isArray(plan?.topics) ? plan.topics : [])
            .filter(t => typeof t === 'string' && t.trim())
            .map(t => scrub(t).slice(0, 60))
            .filter(t => t && t !== '[联系方式已省略]')
            .slice(0, 3);
        if (topics.length !== 3) throw Error('topics');
        return topics;
    }
    async function modelCall(mode, myName, a, lines, opt) {
        const headers = { 'Content-Type': 'application/json' };
        if (env.ADMIN_AI_KEY) headers.Authorization = 'Bearer ' + env.ADMIN_AI_KEY;
        const body = {
            model: env.ADMIN_AI_MODEL || 'qwen-3.8-flash',
            messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(mode, myName, a, lines) }],
            max_tokens: 300, temperature: 0.7, stream: false
        };
        if (opt.kwargs) body.chat_template_kwargs = opt.kwargs;
        const r = await fetchImpl(env.ADMIN_AI_URL, { method: 'POST', headers, signal: AbortSignal.timeout(opt.timeout), body: JSON.stringify(body) });
        if (!r.ok) throw Error('upstream');
        const j = await r.json();
        const raw = j.choices?.[0]?.message?.content;
        if (typeof raw !== 'string' || !raw.trim()) throw Error('empty');
        return parseTopics(raw);
    }
    // 先请求「关掉思考」（十几秒 → 三四秒）；网关不认这个参数时退回普通请求
    async function generate(mode, myName, a, lines) {
        try { return await modelCall(mode, myName, a, lines, { timeout: FAST_TIMEOUT_MS, kwargs: { enable_thinking: false } }); }
        catch (e) { return await modelCall(mode, myName, a, lines, { timeout: TIMEOUT_MS }); }
    }

    /* ---------- ① 空白会话：静态话题 ---------- */
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
            res.json({ code: 200, ready: true, source: 'static', mode, round, topics: staticTopics(mode, pairId, round) });
        } finally { c.release(); }
    });

    /* ---------- ② 双方都开口之后：AI 破冰助手 ---------- */
    app.get('/account/chat/:mode/:id/icebreakers/llm', authMiddleware, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const id = req.account.account_id, mode = String(req.params.mode), pairId = Number(req.params.id);
        const round = Math.min(MAX_ROUNDS - 1, Math.max(0, Number(req.query.round) || 0));
        const myName = req.account.username || '我';
        if (!Number.isSafeInteger(pairId) || pairId < 1) return res.status(400).json({ code: 400, msg: '编号无效' });
        const pool = await getPool();
        const c = await pool.getConnection();
        let a = null, lines = [], usable = false;
        try {
            await ensureSchema();
            a = await access(c, id, mode, pairId);
            // 触发条件：双方都发过消息。对方还没开口之前不生成，也不给入口。
            if (!await bothSpoke(c, mode, pairId, a.p)) return res.json({ code: 200, ready: false, source: 'none', round, topics: [] });
            // 命中缓存：双方共用同一批，同一轮不重复调用模型
            const [hit] = await c.execute('SELECT topics,source FROM chat_icebreaker_cache WHERE mode=? AND pair_id=? AND round=?', [mode, pairId, round]);
            if (hit.length) {
                let t = []; try { t = JSON.parse(hit[0].topics); } catch (e) { }
                if (Array.isArray(t) && t.length) return res.json({ code: 200, ready: true, source: hit[0].source || 'llm', round, topics: t });
            }
            lines = await recentMessages(c, mode, pairId, id, a.name, myName);
            usable = !!env.ADMIN_AI_URL && lines.length >= 2 && await budgetLeft(c);
        } catch (e) {
            if (e.status) return res.status(e.status).json({ code: e.status, msg: e.message });
            console.error('Icebreakers:', e.code || e.name);
            return res.json({ code: 200, ready: true, source: 'static', round, topics: staticTopics(mode, pairId, round) });
        } finally { c.release(); }   // 出网期间不占用连接池（池只有 10 条，模型要几秒到几十秒）

        const key = mode + ':' + pairId + ':' + round;
        let topics = null;
        if (usable) {
            let task = inflight.get(key);
            if (!task) { task = generate(mode, myName, a, lines); inflight.set(key, task); task.then(() => inflight.delete(key), () => inflight.delete(key)); }
            try { topics = await task; } catch (e) { console.error('Icebreakers:', e.code || e.name); }
        }
        if (topics && topics.length) {
            try {
                const sc = await pool.getConnection();
                try {
                    await sc.query('INSERT INTO chat_icebreaker_cache(mode,pair_id,round,topics,source) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE topics=VALUES(topics),source=VALUES(source)',
                        [mode, pairId, round, JSON.stringify(topics), 'llm']);
                } finally { sc.release(); }
            } catch (e) { /* 存缓存失败不影响本次结果 */ }
            return res.json({ code: 200, ready: true, source: 'llm', round, topics });
        }
        return res.json({ code: 200, ready: true, source: 'static', round, topics: staticTopics(mode, pairId, round) });
    });
    return {};
};
