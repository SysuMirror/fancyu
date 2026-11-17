'use strict';

function overviewNum(v) {
  var n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function overviewEsc(x) {
  return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function overviewPct(x) {
  return x === null || x === undefined ? '—' : x + '%';
}

function overviewList(v) {
  return Array.isArray(v) ? v : [];
}

var OVERVIEW_NAMES = {
  weekly: '每周恋爱配对', deep: '深度交友', quick: '快速交友', sport: '运动', study: '自习', meal: '饭搭子',
  movie: '电影', game: '游戏', trip: '逛街/旅游', show: '演出/展览', pending: '待确认', connected: '已连接',
  expired: '已过期', cancelled: '已撤回', skipped: '已跳过', closed: '已结束', blocked: '已屏蔽',
  processing: '处理中', resolved: '已处理', dismissed: '已驳回'
};

var CORE_LABELS = {
  survey: '问卷完成率', coverage: '配对覆盖率', agreement: '双方同意率',
  chat: '双向开聊率', continuation: '持续交流率', retention: '次周参与率'
};
var CORE_MODES = { love: '恋爱配对', deep: '深度交友', buddy: '约个搭子' };
var CORE_KEYS = ['survey', 'coverage', 'agreement', 'chat', 'continuation', 'retention'];

function overviewMetric(label, value) {
  return '<div class="ov-metric"><span>' + overviewEsc(label) + '</span><b>' + overviewEsc(value) + '</b></div>';
}

function overviewTable(headers, rows) {
  var head = headers.map(function (x) { return '<th>' + overviewEsc(x) + '</th>'; }).join('');
  var body = rows.length
    ? rows.map(function (r) {
      return '<tr>' + r.map(function (x) { return '<td>' + overviewEsc(x) + '</td>'; }).join('') + '</tr>';
    }).join('')
    : '<tr><td colspan="' + headers.length + '">当前范围暂无数据</td></tr>';
  return '<div class="ov-scroll"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

function overviewTrend(days) {
  var rows = overviewList(days).map(function (r) {
    return {
      day: String(r.day == null ? '' : r.day),
      registrations: overviewNum(r.registrations),
      verifications: overviewNum(r.verifications),
      pairs: overviewNum(r.pairs)
    };
  });
  var series = {
    registrations: rows.map(function (r) { return r.registrations; }),
    verifications: rows.map(function (r) { return r.verifications; }),
    pairs: rows.map(function (r) { return r.pairs; })
  };
  var peak = 0;
  rows.forEach(function (r) {
    peak = Math.max(peak, r.registrations, r.verifications, r.pairs);
  });
  return { rows: rows, series: series, peak: peak };
}

function overviewTrendHtml(model, range) {
  var peak = model.peak;
  function height(v) { return peak === 0 ? 0 : (v / peak * 100); }
  function col(name, value, title) {
    return '<i class="ov-col' + (value ? '' : ' is-zero') + '" data-series="' + name + '" style="height:' + height(value) + '%" title="' + overviewEsc(title) + '"></i>';
  }
  var days = model.rows.map(function (r) {
    return '<div class="ov-day" data-day="' + overviewEsc(r.day) + '" data-registrations="' + r.registrations + '" data-verifications="' + r.verifications + '" data-pairs="' + r.pairs + '">'
      + col('registrations', r.registrations, r.day + ' 注册 ' + r.registrations)
      + col('verifications', r.verifications, r.day + ' 验证 ' + r.verifications)
      + col('pairs', r.pairs, r.day + ' 配对 ' + r.pairs)
      + '</div>';
  }).join('');
  var start = range && range.start ? range.start : '';
  var end = range && range.end ? range.end : '';
  return '<section class="ov-box" id="ovTrend"><h3>每日注册、验证与配对</h3><p>三列放在同一天里比较。柱高按这段日期里最高的一项缩放，没有记录的一天就是 0。</p>'
    + '<div class="ov-legend"><span><i class="ov-swatch ov-swatch-reg"></i>注册</span><span><i class="ov-swatch ov-swatch-ver"></i>验证</span><span><i class="ov-swatch ov-swatch-pair"></i>生成配对</span></div>'
    + '<div class="ov-trend" role="img" aria-label="所选日期内每日注册、验证和生成配对数">' + days + '</div>'
    + '<div class="ov-axis"><span>' + overviewEsc(start) + '</span><span>最高 ' + peak + '</span><span>' + overviewEsc(end) + '</span></div>'
    + overviewTable(['日期', '注册', '验证', '生成配对（对）'], model.rows.map(function (r) {
      return [r.day, r.registrations, r.verifications, r.pairs];
    }))
    + '</section>';
}

function overviewCore(d) {
  if (!d) {
    return {
      head: '<section class="ov-box" id="ovCore"><h3>六项核心指标</h3><p>统计暂不可用，请刷新。</p></section>',
      notes: ''
    };
  }
  function value(r) {
    if (!r) return '不适用';
    return (r.rate === null ? '暂无可计算样本' : overviewPct(r.rate)) + '（' + r.numerator + ' / ' + r.denominator + '）' + (r.waiting ? ' · 待观察 ' + r.waiting : '');
  }
  var total = d.total || {};
  var head = '<section class="ov-box" id="ovCore"><h3>六项核心指标</h3><p>按三种配对方式分别统计；总览按样本加总，用户跨方式、跨周会重复计入。分子 / 分母见下表。</p><div class="ov-metrics">'
    + CORE_KEYS.map(function (k) {
      var cell = total[k] || {};
      return overviewMetric(CORE_LABELS[k], cell.rate === null || cell.rate === undefined ? '—' : overviewPct(cell.rate));
    }).join('')
    + '</div>'
    + overviewTable(['方式'].concat(CORE_KEYS.map(function (k) { return CORE_LABELS[k]; })), overviewList(d.rows).map(function (r) {
      return [CORE_MODES[r.mode] || r.mode].concat(CORE_KEYS.map(function (k) { return value(r[k]); }));
    }))
    + '</section>';
  var notes = '<details class="ov-core-notes"><summary>统计口径、观察期与历史数据说明</summary><ul>'
    + '<li>问卷完成率：首次填写开始后 7 天内成功提交的人数 / 已满 7 天的首次填写人数。输入或选择答案才计开始；仅打开页面不计。已保存问卷的再次编辑另计，不混入首次填写。尚未满 7 天列为待观察。</li>'
    + '<li>配对覆盖率：正式发布批次中获得推荐的人次 / 发布时有效参与人次。搭子多张卡按账号去重，只统计上线后有完整参与快照的批次。</li>'
    + '<li>双方同意率：已发布配对中曾经双方接受的对数 / 已发布对数；待回应配对也在分母，后续接受会更新结果。它不等于交换联系方式。</li>'
    + '<li>双向开聊率：双方都发过消息的对数 / 曾经双方同意的对数。不读取聊天正文，后续消息会更新结果。</li>'
    + '<li>持续交流率：首次消息后 7 天内，至少两个北京时间日期双方都发过消息的对数 / 已双向开聊且观察满 7 天的对数。未满 7 天列为待观察。</li>'
    + '<li>次周参与率：下一自然周仍有效参与的人次 / 下一周已有完整发布快照的本周有效参与人次。深度交友和搭子含自动续参与；未发布、漏发或缺快照的下一周不算流失。未采集暂停原因，不能推断是否已找到对象。</li>'
    + '</ul><p>开始采集：' + overviewEsc(d.started_at ? new Date(d.started_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知')
    + '。历史问卷开始时间不补造；同意和聊天指标由保留的正式批次及消息时间补算。注销删除会影响历史统计。已排除指定演示账号 ' + overviewEsc(d.excluded_accounts) + ' 个。</p><p>本期已保存问卷的编辑人数：'
    + overviewList(d.rows).filter(function (r) { return r.mode !== 'buddy'; }).map(function (r) { return (CORE_MODES[r.mode] || r.mode) + ' ' + r.revision_fills; }).join('；')
    + '。</p></details>';
  return { head: head, notes: notes };
}

function overviewView(d, opts) {
  d = d || {};
  var names = OVERVIEW_NAMES;
  var trend = overviewTrend(d.trend);
  var core = overviewCore(d.core_metrics);
  var totals = d.totals || {};
  var period = d.period || {};
  var active = d.active || {};
  var pause = d.pause || {};
  var range = d.range || {};
  var parts = [];
  parts.push(core.head);
  parts.push('<section class="ov-box" id="ovModes"><h3>三种配对方式</h3>'
    + overviewTable(['方式', '当前有效参与人数', '本期生成配对数', '其中已交换联系方式', '交换率', '已跳过', '运行方式'], overviewList(d.modes).map(function (m) {
      return [m.name, m.active, m.pairs, m.connected, overviewPct(m.exchange_rate), m.skipped === null || m.skipped === undefined ? '未记录' : m.skipped, m.algorithm];
    }))
    + '<p>有效参与：当前已验证、已填写所需资料并开启的用户；快速交友有 ' + overviewEsc(active.quick_cards) + ' 张开启且符合验证要求的卡。配对按“对”计数，每周导入的双向记录去重。交换率＝本期生成配对中，截至现在已交换联系方式的对数 ÷ 本期生成配对数；不能视为恋爱成功率。</p>'
    + '<p>当前暂停：搭子卡 ' + overviewEsc(pause.quick_cards) + ' 张。尚未统计暂停操作次数或暂停率。</p></section>');
  parts.push('<section class="ov-box" id="ovCurrent"><h3>当前平台概况</h3><p>以下为当前仍保留的数据，不随日期筛选变化。</p><div class="ov-metrics">'
    + overviewMetric('注册账号', totals.accounts)
    + overviewMetric('已验证学生', totals.verified)
    + overviewMetric('邮箱验证覆盖率', overviewPct(totals.verification_rate))
    + overviewMetric('新版恋爱问卷人数', totals.weekly_surveys)
    + overviewMetric('深度交友问卷人数', totals.friend_surveys)
    + overviewMetric('有效搭子卡（未删除）', totals.cards)
    + overviewMetric('待处理 / 处理中举报', totals.pending_reports)
    + '</div></section>');
  parts.push('<section class="ov-box" id="ovPeriod"><h3>所选日期内的新增记录</h3><div class="ov-metrics">'
    + overviewMetric('新增账号', period.registrations)
    + overviewMetric('验证记录', period.verifications)
    + overviewMetric('举报记录', period.reports)
    + overviewMetric('仍保留的屏蔽记录', period.blocks)
    + '</div><p>验证记录不等于本期注册用户的验证转化；解除屏蔽、注销及删除会影响保留数据统计。</p></section>');
  parts.push(overviewTrendHtml(trend, range));
  var weeklySections = opts && opts.weeklySections;
  var funnel = d.funnels && d.funnels.love;
  if (funnel) {
    var stepName = function (i) { return (weeklySections && weeklySections[Number(i)]) || ('分区 ' + (Number(i) + 1)); };
    var rate = function (n) { return funnel.started ? Math.round(n / funnel.started * 1000) / 10 : null; };
    parts.push('<section class="ov-box"><h3>每周恋爱问卷漏斗（所选日期）</h3><div class="ov-metrics">'
      + overviewMetric('进入问卷', funnel.started) + overviewMetric('完成提交', funnel.completed) + '</div>'
      + overviewTable(['步骤', '到达人数', '占进入比'], [['进入问卷', funnel.started, '100%']].concat(overviewList(funnel.steps).map(function (r) {
        return [stepName(r.step), r.count, overviewPct(rate(r.count))];
      })).concat([['完成提交', funnel.completed, overviewPct(rate(funnel.completed))]]))
      + '<p>按账号去重统计所选日期内首次到达各步骤的人数；「进入问卷」以首次交互计，「完成提交」以成功保存问卷计。步骤为问卷分区编号。历史数据未采集分区事件，早期批次会显示为空。</p></section>');
  }
  var observedAt = d.observation_started_at ? new Date(d.observation_started_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
  parts.push('<section class="ov-box"><h3>推荐覆盖与算法版本</h3><p>开始记录时间：' + overviewEsc(observedAt) + '。此前没有推荐尝试记录，不能推算历史无合适人选比例。</p>'
    + overviewTable(['方式', '算法版本', '尝试单元数', '已获得推荐', '仍无合适人选', '无候选占比', '关联配对已交换率'], overviewList(d.observations).map(function (r) {
      return [names[r.mode] || r.mode, r.algorithm_version, r.units, r.recommended_units, r.empty_units, overviewPct(r.empty_rate), overviewPct(r.exchange_rate)];
    }))
    + '<p>快速交友按“发起用户＋卡片＋周”去重，并按首次尝试日期归入筛选范围。重复刷新不增加样本，后来匹配成功会更新原记录；被动收到搭子推荐者不算发起尝试。</p></section>');
  parts.push('<div class="ov-split"><section class="ov-box"><h3>当前搭子卡类别</h3>'
    + overviewTable(['类别', '未删除卡片', '已开启开关'], overviewList(d.card_types).map(function (r) { return [names[r.type] || r.type, r.cards, r.enabled]; }))
    + '</section><section class="ov-box"><h3>所选日期内的举报状态</h3>'
    + overviewTable(['状态', '数量'], overviewList(d.reports).map(function (r) { return [r.status === 'pending' ? '待处理' : (names[r.status] || r.status), r.count]; }))
    + '<p>这里显示汇总数量，不包含举报内容和联系方式。</p></section></div>');
  var quick = (d.statuses && d.statuses.quick) || [];
  parts.push('<div class="ov-split"><section class="ov-box"><h3>快速交友 · 本期配对当前状态</h3>'
    + (quick.length ? quick.map(function (r) {
      return '<div class="ov-label"><span>' + overviewEsc(names[r.status] || r.status) + '</span><b>' + overviewEsc(r.count) + '</b></div>';
    }).join('') : '<p>暂无配对记录</p>')
    + '</section></div>');
  parts.push('<section class="ov-box" id="ovNotes"><h3>问卷版本与数据说明</h3>'
    + overviewTable(['当前保存的恋爱问卷版本', '人数'], overviewList(d.survey_versions).map(function (r) { return [r.version, r.count]; }))
    + '<p class="ov-note">页面浏览及通用按钮点击尚未采集；新增问卷漏斗和次周参与指标见上方六项核心指标，未采集的历史行为不作推算。此看板提供运营汇总，不展示个人问卷、照片或联系方式。</p>'
    + '<p>所有日期按北京时间。配对结果以当前保留记录为准；注销、删除和屏蔽清理可能改变历史汇总。旧每周配对未记录算法版本，不会自动归入新版本。问卷版本显示当前保存版本，不代表历史匹配时使用的版本。</p>'
    + core.notes
    + '</section>');
  return { series: trend.series, days: trend.rows, peak: trend.peak, html: parts.join('') };
}

function overviewCsv(d) {
  d = d || {};
  var names = OVERVIEW_NAMES;
  var rows = [['统计范围', (d.range && d.range.start) || '', (d.range && d.range.end) || '', '北京时间'], ['生成时间', d.generated_at], [], ['当前概况', '数值']];
  var labels = {
    accounts: '注册账号', verified: '已验证学生', weekly_surveys: '新版恋爱问卷人数', friend_surveys: '深度交友问卷人数',
    cards: '未删除搭子卡', pending_reports: '待处理举报', verification_rate: '验证覆盖率（%）'
  };
  Object.entries(d.totals || {}).forEach(function (pair) { rows.push([labels[pair[0]] || pair[0], pair[1]]); });
  var period = d.period || {};
  rows.push([], ['期间新增', '数量'], ['账号', period.registrations], ['验证记录', period.verifications], ['举报', period.reports], ['仍保留屏蔽', period.blocks]);
  rows.push([], ['模式', '当前有效参与人数', '本期配对数', '本期配对已交换数', '交换率百分比', '运行方式']);
  overviewList(d.modes).forEach(function (m) {
    rows.push([m.name, m.active, m.pairs, m.connected, m.exchange_rate == null ? '' : m.exchange_rate, m.algorithm]);
  });
  rows.push([], ['日期', '新增注册', '验证记录', '配对数']);
  overviewList(d.trend).forEach(function (r) { rows.push([r.day, r.registrations, r.verifications, r.pairs]); });
  rows.push([], ['推荐开始记录时间', d.observation_started_at], ['方式', '版本', '尝试单元', '获得推荐', '无候选', '无候选占比']);
  overviewList(d.observations).forEach(function (r) {
    rows.push([names[r.mode] || r.mode, r.algorithm_version, r.units, r.recommended_units, r.empty_units, r.empty_rate == null ? '' : r.empty_rate]);
  });
  rows.push([], ['搭子类别', '当前卡片', '开启开关']);
  overviewList(d.card_types).forEach(function (r) { rows.push([names[r.type] || r.type, r.cards, r.enabled]); });
  rows.push([], ['举报状态', '数量']);
  overviewList(d.reports).forEach(function (r) { rows.push([r.status === 'pending' ? '待处理' : (names[r.status] || r.status), r.count]); });
  rows.push([], ['方式', '配对状态', '数量']);
  overviewList((d.statuses && d.statuses.quick) || []).forEach(function (r) {
    rows.push([names.quick, names[r.status] || r.status, r.count]);
  });
  rows.push([], ['问卷版本', '当前人数']);
  overviewList(d.survey_versions).forEach(function (r) { rows.push([r.version, r.count]); });
  rows.push([], ['说明', '当前概况不受日期筛选影响；历史数据未完整采集；删除或注销会改变汇总；交换率仅指交换联系方式；双方同意和聊天指标请见核心指标。']);
  if (d.core_metrics) {
    rows.push([], ['六项核心指标', '方式', '指标', '分子', '分母', '百分比', '待观察样本']);
    overviewList(d.core_metrics.rows).forEach(function (r) {
      CORE_KEYS.forEach(function (k) {
        if (r[k]) rows.push(['core-v1', r.mode, k, r[k].numerator, r[k].denominator, r[k].rate == null ? '' : r[k].rate, r[k].waiting]);
      });
    });
    rows.push(['核心指标采集开始', d.core_metrics.started_at]);
  }
  function cell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return '\ufeff' + rows.map(function (r) { return r.map(cell).join(','); }).join('\r\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { overviewView: overviewView, overviewCsv: overviewCsv, overviewTrend: overviewTrend };
}

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.overviewView = overviewView;
  window.overviewCsv = overviewCsv;
  var latest = null, request = 0, weeklySections = null;
  try {
    if (typeof fetch === 'function') {
      var pending = fetch('/api/survey-schema/weekly');
      if (pending && typeof pending.then === 'function') {
        pending.then(function (r) { return r.json(); }).then(function (j) {
          if (j && j.code === 200 && j.schema) weeklySections = j.schema.sections;
        }).catch(function () {});
      }
    }
  } catch (e) {}
  function today() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
  function range(days) {
    var end = today();
    return { end: end, start: new Date(Date.parse(end + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10) };
  }
  var selected = range(30);
  function shell() {
    document.getElementById('operationsDashboard').innerHTML = '<div class="ov-box"><h2>运营数据看板</h2><div class="ov-tools"><label>开始日期<input type="date" id="ovStart" value="' + selected.start + '" max="' + today() + '"></label><label>结束日期<input type="date" id="ovEnd" value="' + selected.end + '" max="' + today() + '"></label><button class="ov-primary" id="ovRefresh">查询 / 刷新</button><button data-ov-days="7">近 7 天</button><button data-ov-days="30">近 30 天</button><button data-ov-days="90">近 90 天</button><button id="ovExport" disabled>导出汇总 CSV</button></div><p id="ovMessage" role="status">正在读取统计…</p></div><div id="ovContent"></div>';
    document.getElementById('ovRefresh').onclick = function () {
      selected = { start: document.getElementById('ovStart').value, end: document.getElementById('ovEnd').value };
      load();
    };
    document.querySelectorAll('[data-ov-days]').forEach(function (b) {
      b.onclick = function () { selected = range(Number(b.dataset.ovDays)); shell(); load(); };
    });
    document.getElementById('ovExport').onclick = download;
  }
  async function load() {
    var seq = ++request;
    latest = null;
    document.getElementById('ovExport').disabled = true;
    document.getElementById('ovContent').innerHTML = '';
    var msg = document.getElementById('ovMessage');
    msg.className = '';
    msg.textContent = '正在读取统计…';
    try {
      var response = await fetch('/api/admin/overview?' + new URLSearchParams(selected), { headers: getAdminHeaders() });
      var j = await response.json();
      if (seq !== request) return;
      if (response.status === 401) { adminLogout(); throw Error('管理员登录已过期，请重新登录'); }
      if (!response.ok || j.code !== 200) throw Error(j.msg || '读取失败');
      latest = j.data;
      document.getElementById('ovContent').innerHTML = overviewView(latest, { weeklySections: weeklySections }).html;
      document.getElementById('ovExport').disabled = false;
      msg.textContent = '北京时间 · 更新于 ' + new Date(latest.generated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    } catch (e) {
      if (seq === request) { msg.className = 'ov-error'; msg.textContent = e.message + '，可以点击查询重试。'; }
    }
  }
  function download() {
    if (!latest) return;
    var csv = overviewCsv(latest);
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'FancyU-运营汇总-' + latest.range.start + '-' + latest.range.end + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  window.loadOperationsStats = function () { shell(); return load(); };
  if (document.head && document.createElement) {
    var s = document.createElement('script');
    if (s) { s.src = '/school-email.js?v=2'; document.head.appendChild(s); }
  }
})();
