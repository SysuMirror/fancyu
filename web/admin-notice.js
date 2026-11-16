/* admin-notice.js — 管理后台「公告与问卷」：发布通知 / 问卷调研、选渠道（提醒 / 主页）、
   选人群与定时，并查看回收统计与导出。所有接口在 /api/admin/announcements 下。 */
(() => {
  'use strict';
  const token = localStorage.getItem('adminToken');
  if (!token) { location.replace('/admin'); return; }

  const $ = id => document.getElementById(id);
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const Q_TYPES = { single: '单选', multi: '多选', rating: '评分', text: '简答' };
  const AUD = { all: '全部用户', verified: '已验证学生', weekly_match: '批次报名者', custom: '指定用户名' };
  const STATUS = { draft: '草稿', published: '已发布', archived: '已归档' };
  let busy = false, list = [], cur = null, qs = [], batches = [];

  function message(s) { const t = $('toast'); t.textContent = s; t.hidden = false; clearTimeout(message.t); message.t = setTimeout(() => { t.hidden = true; }, 6000); }

  async function api(path, method, body) {
    const r = await fetch('/api/admin/announcements' + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body !== undefined && body !== null ? { body: JSON.stringify(body) } : {})
    });
    if (r.status === 401) { localStorage.removeItem('adminToken'); location.replace('/admin'); throw Error('请重新登录'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.code !== 200) throw Error(j.msg || '请求失败');
    return j;
  }

  /* ---------- 时间：datetime-local（北京）↔ UTC ISO ---------- */
  const beijingInput = iso => {
    if (!iso) return '';
    const d = new Date(String(iso).replace(' ', 'T') + (/[Zz]|[+-]\d\d:?\d\d$/.test(String(iso)) ? '' : 'Z'));
    if (isNaN(d)) return '';
    return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16);
  };
  const toUTC = v => { const s = String(v || '').trim(); if (!s) return null; const d = new Date(s + ':00+08:00'); return isNaN(d) ? null : d.toISOString(); };
  const dt = x => { if (!x) return '—'; const d = new Date(String(x).replace(' ', 'T') + (/[Zz]|[+-]\d\d:?\d\d$/.test(String(x)) ? '' : 'Z')); return isNaN(d) ? '—' : d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };

  /* ---------- 列表 ---------- */
  function rowHTML(a) {
    const win = a.start_at || a.end_at ? dt(a.start_at) + ' → ' + dt(a.end_at) : '立即生效';
    const pct = a.audience_count ? Math.round(a.response_count / a.audience_count * 100) : 0;
    return '<div class="an-item' + (cur && cur.id === a.id ? ' on' : '') + '" data-id="' + a.id + '" tabindex="0" role="button">' +
      '<div class="an-item-top"><span class="an-badge kind-' + a.kind + '">' + (a.kind === 'survey' ? '问卷' : '通知') + '</span>' +
      '<span class="an-badge st-' + a.status + '">' + (STATUS[a.status] || a.status) + '</span>' +
      (a.channel_reminder ? '<span class="an-badge ch">提醒</span>' : '') + (a.channel_home ? '<span class="an-badge ch">主页</span>' : '') + '</div>' +
      '<b>' + esc(a.title) + '</b>' +
      '<div class="muted small">' + esc(AUD[a.audience] || a.audience) + ' · ' + esc(win) + '</div>' +
      '<div class="muted small">送达 ' + a.audience_count + ' · 回收 ' + a.response_count + (a.kind === 'survey' && a.audience_count ? '（' + pct + '%）' : '') + (a.revision > 1 ? ' · 第 ' + a.revision + ' 次推送' : '') + '</div>' +
      '</div>';
  }
  async function loadList() {
    const j = await api('');
    list = j.announcements || [];
    $('list').innerHTML = list.length ? list.map(rowHTML).join('') : '<p class="muted">还没有发布过内容。点右上角「新建」。</p>';
    $('list').querySelectorAll('.an-item').forEach(el => {
      el.addEventListener('click', () => open(Number(el.dataset.id)).catch(e => message(e.message)));
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(Number(el.dataset.id)).catch(x => message(x.message)); } });
    });
  }

  /* ---------- 题目构建器 ---------- */
  function blankQ(i) { return { id: 'q' + (i + 1), type: 'single', title: '', required: true, options: [{ value: 'o1', label: '' }, { value: 'o2', label: '' }] }; }
  function qHTML(q, i) {
    let body = '';
    if (q.type === 'single' || q.type === 'multi') {
      body = (q.options || []).map(o =>
        '<div class="an-opt q-opt" data-v="' + esc(o.value) + '"><input value="' + esc(o.label) + '" maxlength="80" placeholder="选项文案">' +
        '<button type="button" class="an-x" data-act="opt-del" aria-label="删除选项">×</button></div>').join('') +
        '<button type="button" class="an-mini" data-act="opt-add">+ 选项</button>' +
        (q.type === 'multi' ? '<label class="inline an-max">最多可选<input type="number" class="q-max" min="1" max="30" value="' + (q.max || '') + '" placeholder="不限"></label>' : '');
    } else if (q.type === 'rating') {
      body = '<label class="inline">满分 <input type="number" class="q-rmax" min="2" max="10" value="' + (q.max || 5) + '"></label>';
    } else {
      body = '<label class="inline">最多字数 <input type="number" class="q-len" min="10" max="2000" value="' + (q.maxLen || 500) + '"></label>';
    }
    return '<div class="an-q" data-i="' + i + '"><div class="an-q-top">' +
      '<span class="an-qnum">第 ' + (i + 1) + ' 题</span>' +
      '<input class="q-id" value="' + esc(q.id) + '" maxlength="24" style="max-width:110px" title="题目编号（答案按它保存，改动请谨慎）">' +
      '<select class="q-type">' + Object.keys(Q_TYPES).map(t => '<option value="' + t + '"' + (q.type === t ? ' selected' : '') + '>' + Q_TYPES[t] + '</option>').join('') + '</select>' +
      '<label class="inline"><input type="checkbox" class="q-req"' + (q.required ? ' checked' : '') + '> 必答</label>' +
      '<span class="an-spacer"></span>' +
      '<button type="button" class="an-mini" data-act="q-up" aria-label="上移">↑</button>' +
      '<button type="button" class="an-mini" data-act="q-down" aria-label="下移">↓</button>' +
      '<button type="button" class="an-x" data-act="q-del" aria-label="删除题目">×</button></div>' +
      '<input class="q-title" value="' + esc(q.title) + '" maxlength="200" placeholder="题干，如：你更喜欢哪种活动？">' + body + '</div>';
  }
  function renderQuestions() { $('questions').innerHTML = qs.map(qHTML).join(''); }
  function syncQuestions() {
    document.querySelectorAll('#questions .an-q').forEach(el => {
      const q = qs[Number(el.dataset.i)]; if (!q) return;
      q.id = (el.querySelector('.q-id').value || q.id).trim() || q.id;
      q.type = el.querySelector('.q-type').value;
      q.title = el.querySelector('.q-title').value;
      q.required = el.querySelector('.q-req').checked;
      if (q.type === 'single' || q.type === 'multi') {
        q.options = [...el.querySelectorAll('.q-opt')].map(o => ({ value: o.dataset.v, label: o.querySelector('input').value }));
        if (q.type === 'multi') q.max = Number(el.querySelector('.q-max') && el.querySelector('.q-max').value) || 0;
      } else if (q.type === 'rating') {
        // 切题型时 DOM 还是旧题型的控件，读不到就沿用原值（不能直接 .value，否则报错并中断重渲染）
        const box = el.querySelector('.q-rmax');
        q.max = box ? (Number(box.value) || 5) : (q.max || 5);
        delete q.options; delete q.maxLen;
      } else {
        const box = el.querySelector('.q-len');
        q.maxLen = box ? (Number(box.value) || 500) : (q.maxLen || 500);
        delete q.options; delete q.max;
      }
    });
  }
  $('questions').addEventListener('input', e => { if (e.target.classList.contains('q-id')) return; syncQuestions(); });
  $('questions').addEventListener('change', e => {
    if (e.target.classList.contains('q-type')) {
      syncQuestions();
      const q = qs[Number(e.target.closest('.an-q').dataset.i)];
      if (!q) return;
      if ((q.type === 'single' || q.type === 'multi') && !(q.options || []).length) q.options = [{ value: 'o1', label: '' }, { value: 'o2', label: '' }];
      delete q.maxLen;
      if (q.type === 'multi' && !q.max) q.max = 0;
      if (q.type === 'rating') q.max = q.max || 5;
      if (q.type === 'text') q.maxLen = q.maxLen || 500;
      renderQuestions();
      return;
    }
    syncQuestions();
  });
  $('questions').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const card = btn.closest('.an-q'), i = card ? Number(card.dataset.i) : -1, q = qs[i];
    syncQuestions();
    const act = btn.dataset.act;
    if (act === 'q-del') { qs.splice(i, 1); }
    else if (act === 'q-up' && i > 0) { qs.splice(i - 1, 0, qs.splice(i, 1)[0]); }
    else if (act === 'q-down' && i < qs.length - 1) { qs.splice(i + 1, 0, qs.splice(i, 1)[0]); }
    else if (act === 'opt-add') {
      const next = 'o' + ((q.options || []).reduce((m, o) => Math.max(m, Number(String(o.value).replace(/\D/g, '')) || 0), 0) + 1);
      (q.options = q.options || []).push({ value: next, label: '' });
    } else if (act === 'opt-del') {
      const v = btn.closest('.an-opt').dataset.v;
      q.options = (q.options || []).filter(o => o.value !== v);
    } else return;
    renderQuestions();
  });
  $('q-add').addEventListener('click', () => {
    if (busy) return;
    syncQuestions();
    if (qs.length >= 30) { message('题目最多 30 个'); return; }
    qs.push(blankQ(qs.length));
    renderQuestions();
  });

  /* ---------- 表单 ---------- */
  function audienceFields() {
    const a = $('f-audience').value;
    $('row-batch').hidden = a !== 'weekly_match';
    $('row-users').hidden = a !== 'custom';
  }
  function questionsVisible() {
    const kind = $('f-kind').value;
    $('q-wrap').hidden = kind !== 'survey';
    $('f-body').closest('.an-field').querySelector('textarea').placeholder = kind === 'survey' ? '可放调研说明（用户答题页会显示在题目上方）' : '公告正文';
  }
  $('f-audience').addEventListener('change', audienceFields);
  $('f-kind').addEventListener('change', () => { syncQuestions(); questionsVisible(); });

  function fillBatches() {
    const sel = $('f-batch');
    if (sel.tagName === 'SELECT') return;
    fetch('/api/admin/announcements/batches', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.json()).then(j => {
        if (!j || j.code !== 200 || !Array.isArray(j.batches) || !j.batches.length) return;
        batches = j.batches;
        const opts = batches.map(b => '<option value="' + esc(b) + '">' + esc(b) + (b === j.open ? '（本周）' : '') + '</option>').join('');
        $('row-batch').innerHTML = '<label class="an-field">配对批次<select id="f-batch">' + opts + '</select></label>';
      }).catch(() => {});
  }

  function resetForm(a) {
    cur = a || null;
    $('editor').hidden = false; $('empty').hidden = true;
    $('editorTitle').textContent = a ? (a.status === 'draft' ? '编辑草稿 #' + a.id : '内容 #' + a.id) : '新建内容';
    $('editorMeta').textContent = a ? ('状态：' + (STATUS[a.status] || a.status) + ' · 创建者：' + (a.created_by || '—') + ' · 创建于 ' + dt(a.created_at) + (a.kind === 'survey' ? ' · 回收 ' + a.response_count + ' / 送达 ' + a.audience_count : '')) : '尚未保存的草稿。保存后再发布。';
    $('f-kind').value = a ? a.kind : 'notice';
    $('f-audience').value = a ? a.audience : 'all';
    $('f-title').value = a ? a.title : '';
    $('f-summary').value = a ? (a.summary || '') : '';
    $('f-body').value = a ? (a.body || '') : '';
    $('f-link').value = a ? (a.link || '') : '';
    $('f-reminder').checked = a ? !!a.channel_reminder : true;
    $('f-home').checked = a ? !!a.channel_home : true;
    $('f-start').value = a ? beijingInput(a.start_at) : '';
    $('f-end').value = a ? beijingInput(a.end_at) : '';
    $('f-users').value = a && a.audience_meta && Array.isArray(a.audience_meta.usernames) ? a.audience_meta.usernames.join('\n') : '';
    qs = a && Array.isArray(a.questions) ? JSON.parse(JSON.stringify(a.questions)) : [];
    if (a && a.audience === 'weekly_match' && a.audience_meta && a.audience_meta.batch_key) { fillBatches(); setTimeout(() => { const s = $('f-batch'); if (s && s.tagName === 'SELECT') s.value = a.audience_meta.batch_key; }, 400); }
    if (!a) qs = [];
    renderQuestions();
    const st = a ? a.status : 'draft';
    $('save').textContent = st === 'draft' ? '保存草稿' : '保存文案/渠道';
    $('publish').hidden = st !== 'draft';
    $('republish').hidden = st !== 'published';
    $('archive').hidden = st === 'archived';
    $('del').hidden = st !== 'draft';
    audienceFields(); questionsVisible();
    $('formState').textContent = st === 'draft' ? '草稿可以任意修改；发布时再校验一次。' : '已发布：人群、题型与生效时间已锁定，只能改文案、渠道与失效时间。';
  }

  function collect() {
    syncQuestions();
    const a = $('f-audience').value;
    const meta = {};
    if (a === 'custom') meta.usernames = $('f-users').value.split(/[\n,，\s]+/).map(s => s.trim()).filter(Boolean);
    if (a === 'weekly_match') meta.batch_key = ($('f-batch') && $('f-batch').value || '').trim();
    const body = {
      kind: $('f-kind').value,
      title: $('f-title').value.trim(),
      summary: $('f-summary').value.trim(),
      body: $('f-body').value,
      link: $('f-link').value.trim(),
      audience: a,
      audience_meta: a === 'all' || a === 'verified' ? null : meta,
      channel_reminder: $('f-reminder').checked,
      channel_home: $('f-home').checked,
      start_at: toUTC($('f-start').value),
      end_at: toUTC($('f-end').value)
    };
    if (body.kind === 'survey') body.questions = qs.map(q => {
      const out = { id: q.id, type: q.type, title: (q.title || '').trim(), required: !!q.required };
      if (q.type === 'single' || q.type === 'multi') out.options = (q.options || []).filter(o => o.label.trim());
      if (q.type === 'multi' && Number(q.max) > 0) out.max = Number(q.max);
      if (q.type === 'rating') out.max = Number(q.max) || 5;
      if (q.type === 'text') out.maxLen = Number(q.maxLen) || 500;
      return out;
    });
    return body;
  }

  async function save() {
    if (busy) return;
    const body = collect();
    if (!body.title) { message('请填写标题'); return; }
    if (body.audience_meta && body.audience_meta.usernames && body.audience_meta.usernames.length > 200) { message('指定用户名最多 200 个'); return; }
    busy = true; $('save').disabled = true;
    try {
      if (cur && cur.id) { message((await api('/' + cur.id, 'PUT', body)).msg); await open(cur.id); }
      else { const j = await api('', 'POST', body); message(j.msg); await loadList(); await open(j.id); }
      await loadList();
    } catch (err) {
      if (/force/i.test(err.message)) {
        const go = window.uiConfirm ? await uiConfirm({ title: '已有回答，仍要改题目？', body: err.message, okText: '仍然修改', danger: true }) : confirm(err.message);
        if (go) { try { message((await api('/' + cur.id, 'PUT', Object.assign({}, body, { force: true }))).msg); await open(cur.id); await loadList(); } catch (e2) { message(e2.message); } }
      } else message(err.message);
    } finally { busy = false; $('save').disabled = false; }
  }

  async function act(verb, confirmText) {
    if (busy || !cur) return;
    if (confirmText) {
      const go = window.uiConfirm ? await uiConfirm({ title: confirmText.title, body: confirmText.body, okText: confirmText.okText, danger: !!confirmText.danger }) : confirm(confirmText.body);
      if (!go) return;
    }
    busy = true;
    try {
      if (verb === 'del') { message((await api('/' + cur.id, 'DELETE')).msg); cur = null; $('editor').hidden = true; $('empty').hidden = false; await loadList(); return; }
      const j = await api('/' + cur.id + '/' + verb, 'POST', {});
      message(j.msg);
      await open(cur.id); await loadList();
    } catch (err) { message(err.message); } finally { busy = false; }
  }

  /* ---------- 详情 + 统计 ---------- */
  async function open(id) {
    const j = await api('/' + id);
    resetForm(j.announcement);
    await loadStats(id, j.announcement);
    await loadList();
  }
  async function loadStats(id, a) {
    const wrap = $('statsWrap');
    if (!a || a.kind !== 'survey') { wrap.hidden = true; return; }
    wrap.hidden = false;
    try {
      const j = await api('/' + id + '/stats');
      const s = j.stats || {};
      const pct = s.audience_count ? Math.round(s.response_count / s.audience_count * 100) : 0;
      const cell = (l, v) => '<div class="stat"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>';
      $('statsCounts').innerHTML = cell('送达', s.audience_count || 0) + cell('回收', s.response_count || 0) + cell('回收率', pct + '%') + cell('未答', Math.max(0, (s.audience_count || 0) - (s.response_count || 0)));
      $('statsBody').innerHTML = (s.question_stats || []).map(q => {
        const head = '<div class="an-st"><b>' + esc(q.title || q.id) + '</b> <span class="muted small">' + (Q_TYPES[q.type] || q.type) + ' · 作答 ' + q.total + (q.average != null ? ' · 平均 ' + q.average : '') + '</span>';
        if (q.buckets) {
          const max = Math.max(1, ...q.buckets.map(b => b.count));
          return head + '<div class="an-bars">' + q.buckets.map(b =>
            '<div class="an-bar-row"><span class="an-bar-lb">' + esc(b.label) + '</span><span class="an-bar-track"><span class="an-bar-fill" style="width:' + Math.round(b.count / max * 100) + '%"></span></span><span class="an-bar-n">' + b.count + '</span></div>').join('') + '</div></div>';
        }
        const texts = q.texts || [];
        return head + (texts.length ? '<ul class="an-texts">' + texts.map(t => '<li><b>' + esc(t.username) + '</b>：' + esc(t.text) + '</li>').join('') + '</ul>' : '<p class="muted small">暂无简答。</p>') + '</div>';
      }).join('') || '<p class="muted">这份调研还没有题目。</p>';
      const nr = j.non_responders || [];
      $('statsBody').insertAdjacentHTML('beforeend', '<div class="an-st"><b>未答名单（' + nr.length + '）</b>' +
        (nr.length ? '<p class="muted small an-nr">' + nr.map(esc).join('、') + '</p>' : '<p class="muted small">全部已答。</p>') + '</div>');
    } catch (err) { $('statsBody').innerHTML = '<p class="error">' + esc(err.message) + '</p>'; }
  }

  async function exportCsv(type) {
    if (!cur) return;
    try {
      const r = await fetch('/api/admin/announcements/' + cur.id + '/export?type=' + type, { headers: { Authorization: 'Bearer ' + token } });
      if (r.status === 401) { localStorage.removeItem('adminToken'); location.replace('/admin'); return; }
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw Error(j.msg || '导出失败'); }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'announcement-' + cur.id + '-' + type + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) { message(err.message); }
  }

  /* ---------- 事件绑定 ---------- */
  $('form').addEventListener('submit', e => { e.preventDefault(); save(); });
  $('new').addEventListener('click', () => { if (busy) return; resetForm(null); $('f-title').focus(); });
  $('refresh').addEventListener('click', () => { loadList().catch(e => message(e.message)); });
  $('publish').addEventListener('click', () => act('publish', { title: '发布', body: '发布后立即按人群快照送达，并进入主页/提醒。确定？', okText: '发布' }));
  $('republish').addEventListener('click', () => act('republish', { title: '重新推送', body: '会给当前人群再发一次提醒（重复收到的人只多一条通知）。确定？', okText: '重新推送' }));
  $('archive').addEventListener('click', () => act('archive', { title: '归档', body: '归档后处处隐藏，统计仍保留。确定？', okText: '归档' }));
  $('del').addEventListener('click', () => act('del', { title: '删除草稿', body: '删除后不可恢复（只允许删草稿）。确定？', okText: '删除', danger: true }));
  $('exp-resp').addEventListener('click', () => exportCsv('responses'));
  $('exp-non').addEventListener('click', () => exportCsv('non_responders'));

  fillBatches();
  loadList().catch(e => { $('list').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; });
})();
