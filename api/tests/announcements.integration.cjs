// 「公告 / 问卷调研」集成测试（需要真实库：MYSQL_* 环境变量，与其它 *integration.cjs 相同）。
// 只新建自建测试账号 + 自建公告行，结束前全部清理；不触碰任何真实用户数据。
const assert = require('assert/strict'), mysql = require('mysql2/promise'), crypto = require('crypto');
const store = require('../announce-store');
const { csvCell } = require('../admin-users');

(async () => {
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE
  });
  const prefix = 'announce_it_' + crypto.randomBytes(5).toString('hex');
  const accIds = [], annIds = [];
  try {
    /* 1) ensureSchema 幂等：连续两次都不得抛错，且三张表都存在 */
    await store.ensureSchema(async () => pool);
    await store.ensureSchema(async () => pool);
    for (const t of ['announcements', 'announcement_audience', 'announcement_responses']) {
      const [r] = await pool.execute('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?', [t]);
      assert.equal(Number(r[0].n), 1, '缺少表 ' + t);
    }
    for (const c of ['kind', 'questions', 'audience', 'audience_meta', 'channel_reminder', 'channel_home', 'start_at', 'end_at', 'status', 'revision', 'notified_at']) {
      const [r] = await pool.execute('SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', ['announcements', c]);
      assert.equal(Number(r[0].n), 1, 'announcements 缺列 ' + c);
    }

    /* 2) 自建账号：两个已验证学生（verified_students 与 accounts.email 对齐），一个未验证 */
    const mk = async (tag, verified) => {
      const email = prefix + tag + '@mail2.sysu.edu.cn';
      const [r] = await pool.execute('INSERT INTO accounts(email,username,password_hash) VALUES (?,?,?)', [email, prefix + tag, 'test-not-login']);
      accIds.push(r.insertId);
      if (verified) await pool.execute('INSERT INTO verified_students(account_id,email,verified_at) VALUES (?,?,UTC_TIMESTAMP())', [r.insertId, email]);
      return r.insertId;
    };
    const a1 = await mk('a1', true), a2 = await mk('a2', true), a3 = await mk('a3', false);

    /* 3) 人群解析：verified 只应命中自建里已验证的两个；custom 只认显式用户名 */
    const verifiedIds = (await store.resolveAudience(pool, { audience: 'verified', audience_meta: null })).map(Number);
    assert.equal(verifiedIds.includes(a1), true, 'verified 未包含自建已验证账号 a1');
    assert.equal(verifiedIds.includes(a2), true, 'verified 未包含自建已验证账号 a2');
    assert.equal(verifiedIds.includes(a3), false, 'verified 误包含未验证账号 a3');
    const customIds = (await store.resolveAudience(pool, { audience: 'custom', audience_meta: { usernames: [prefix + 'a1', 'no_such_user_' + prefix] } })).map(Number);
    assert.deepEqual(customIds, [a1], 'custom 应只解析出显式列出的账号，忽略不存在的用户名');

    /* 4) 建调研 + 快照人群 → 4 种题型分布（含零填充） */
    const questions = [
      { id: 'q1', type: 'single', title: 'single问', required: true, options: [{ value: 'o1', label: 'A' }, { value: 'o2', label: 'B' }, { value: 'o3', label: 'C' }] },
      { id: 'q2', type: 'multi', title: 'multi问', required: false, options: [{ value: 'm1', label: '甲' }, { value: 'm2', label: '乙' }, { value: 'm3', label: '丙' }], max: 2 },
      { id: 'q3', type: 'rating', title: 'rating问', required: true, max: 5 },
      { id: 'q4', type: 'text', title: 'text问', required: false, maxLen: 200 }
    ];
    const [ins] = await pool.execute(`INSERT INTO announcements(kind,title,summary,body,questions,audience,audience_meta,channel_reminder,channel_home,status,published_at,created_by)
      VALUES ('survey',?,?,'',?,'custom',?,0,0,'published',UTC_TIMESTAMP(),?)`,
      [prefix + ' 调研', '摘要', JSON.stringify(questions), JSON.stringify({ usernames: [prefix + 'a1', prefix + 'a2', prefix + 'a3'] }), prefix]);
    const annId = ins.insertId; annIds.push(annId);
    const n = await store.snapshotAudience(pool, annId);
    assert.equal(n, 3, '快照人群应为 3 人');
    assert.equal(await store.snapshotAudience(pool, annId), 0, '重复快照必须幂等（INSERT IGNORE）');

    // 两份回答：a1 全答，a2 只答单选（其余补零），a3 不答
    await pool.execute('INSERT INTO announcement_responses(announcement_id,account_id,answers) VALUES (?,?,?)', [annId, a1, JSON.stringify({ q1: 'o1', q2: ['m1', 'm2'], q3: 4, q4: '很好' })]);
    await pool.execute('INSERT INTO announcement_responses(announcement_id,account_id,answers) VALUES (?,?,?)', [annId, a2, JSON.stringify({ q1: 'o1' })]);

    const s = await store.aggregateStats(pool, annId);
    assert.equal(s.audience_count, 3, 'audience_count 应为 3');
    assert.equal(s.response_count, 2, 'response_count 应为 2');
    const by = id => s.question_stats.find(q => q.id === id);
    assert.deepEqual(by('q1').buckets.map(b => b.count), [2, 0, 0], 'q1 分布 + 零填充');
    assert.deepEqual(by('q2').buckets.map(b => b.count), [1, 1, 0], 'q2 多选分布 + 零填充');
    assert.equal(by('q2').total, 1, 'q2 作答人数应为 1');
    assert.deepEqual(by('q3').buckets.map(b => b.count), [0, 0, 0, 1, 0], 'q3 评分分布 1..5 + 零填充');
    assert.equal(by('q3').average, 4, 'q3 平均分应为 4');
    assert.equal(by('q4').texts.length, 1, 'q4 简答应有一条');
    assert.equal(by('q4').texts[0].username, prefix + 'a1', 'q4 简答应带用户名');

    /* 5) 未答名单只出未答者用户名（a3），不含已答者 */
    const nr = await store.nonResponders(pool, annId, 100);
    assert.deepEqual(nr, [prefix + 'a3'], '未答名单应只有 a3');

    /* 6) 答案校验：非法选项 / 超 max / 必答缺失 全部拦下 */
    assert.throws(() => store.validateAnswers(questions, { q1: 'o1', q2: ['m1', 'm2', 'm3'], q3: 3 }), /最多|max/i, 'multi 超上限应报错');
    assert.throws(() => store.validateAnswers(questions, { q1: 'nope', q3: 3 }), /选项|无效/i, '非法选项应报错');
    assert.throws(() => store.validateAnswers(questions, { q1: 'o1' }), /必答|缺少/i, '缺必答题应报错');
    const ok = store.validateAnswers(questions, { q1: 'o1', q2: ['m1'], q3: 5, q4: 'x' });
    assert.deepEqual(ok, { q1: 'o1', q2: ['m1'], q3: 5, q4: 'x' }, '合法答案应原样通过');

    /* 7) csvCell 公式注入防护 */
    assert.equal(csvCell('=cmd|calc'), "'=cmd|calc", 'csvCell 必须拦 = 开头的公式注入');
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('@x'), "'@x");
    assert.equal(csvCell('a"b,c'), '"a""b,c"', 'csvCell 引号/逗号转义');

    /* 8) 卡片查询：channel_home=0 不应出现在首页卡片 */
    const cards = await store.cards(pool, a1, 10);
    assert.equal(cards.some(c => c.id === annId), false, 'channel_home=0 的内容不应进首页卡片');

    console.log('announcements.integration: all assertions passed');
  } finally {
    try {
      for (const id of annIds) {
        await pool.execute('DELETE FROM announcement_responses WHERE announcement_id=?', [id]);
        await pool.execute('DELETE FROM announcement_audience WHERE announcement_id=?', [id]);
        await pool.execute('DELETE FROM announcements WHERE id=?', [id]);
      }
      for (const id of accIds) {
        await pool.execute('DELETE FROM verified_students WHERE account_id=?', [id]);
        await pool.execute('DELETE FROM accounts WHERE id=?', [id]);
      }
    } catch (e) { console.error('cleanup:', e.code || e.message); }
    await pool.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
