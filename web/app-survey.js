/* app-survey.js — 用户侧：管理员发布的「公告」详情 / 「问卷调研」答题页（?id=）。
   只读取自己的答案；提交走 POST /api/account/announcements/:id/answers（可反复修改）。 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = (() => { try { return localStorage.getItem('token') || ''; } catch (e) { return ''; } })();
  const id = new URLSearchParams(location.search).get('id') || '';
  const selfPath = '/app-survey' + (location.search || '');
  const answers = {};           // {qid: value | [values] | number | string}
  let questions = [], busy = false;

  if (!token) { location.replace('/login?redirect=' + encodeURIComponent(selfPath)); return; }
  if (!/^\d+$/.test(id)) { msg('err', '链接无效，请从通知中心或首页卡片进入。'); return; }

  function msg(kind, text) {
    const el = $('msg');
    el.className = kind || '';
    el.textContent = text;
    el.hidden = !text;
  }
  function date(x) {
    if (!x) return '';
    const d = new Date(String(x).replace(' ', 'T') + (String(x).endsWith('Z') ? '' : 'Z'));
    if (isNaN(d)) return '';
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  // 正文/题干里若含站内链接，保持可点；其余纯文本 —— 用 esc 后只把 http(s)/站内 URL 变成链接
  function richText(s) {
    return esc(s).replace(/(https?:\/\/[^\s<]+|\/(?!\/)[A-Za-z0-9_\-/?=&%.#]*)/g, m =>
      '<a href="' + m.replace(/&amp;/g, '&') + '" target="_blank" rel="noopener">' + m + '</a>');
  }

  async function api(path, method, body) {
    const r = await fetch('/api/account/announcements' + path, {
      method: method || 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.code !== 200) { const e = Error(j.msg || '请求失败'); e.status = r.status; throw e; }
    return j;
  }

  /* ---------------- 题目渲染 ---------------- */
  function qBlock(q, i) {
    const req = q.required ? '<span class="req">必答</span>' : '<span class="hint" style="margin:0 0 0 6px">选填</span>';
    let hint = '', inner = '';
    if (q.type === 'single' || q.type === 'multi') {
      hint = q.type === 'multi' ? '<p class="hint">可多选' + (q.max ? '，最多 ' + q.max + ' 项' : '') + '</p>' : '';
      inner = '<div class="opts">' + (q.options || []).map(o =>
        '<label class="opt"><input type="' + (q.type === 'multi' ? 'checkbox' : 'radio') + '" name="' + esc(q.id) + '" value="' + esc(o.value) + '"><span>' + esc(o.label) + '</span></label>').join('') + '</div>';
    } else if (q.type === 'rating') {
      const max = Math.min(Math.max(2, Number(q.max) || 5), 10);
      hint = '<p class="hint">1 = 最低 / 最少，' + max + ' = 最高 / 最多</p>';
      inner = '<div class="rating" data-q="' + esc(q.id) + '" role="radiogroup" aria-label="' + esc(q.title) + '">' +
        Array.from({ length: max }, (_, k) => '<button type="button" class="r" data-v="' + (k + 1) + '" aria-pressed="false">' + (k + 1) + '</button>').join('') + '</div>';
    } else {
      const maxLen = Math.min(Math.max(10, Number(q.maxLen) || 500), 2000);
      hint = '<p class="hint">最多 ' + maxLen + ' 字</p>';
      inner = '<textarea class="ans" data-q="' + esc(q.id) + '" maxlength="' + maxLen + '" rows="4"></textarea>';
    }
    return '<div class="q" data-i="' + i + '" data-qid="' + esc(q.id) + '"><p class="qt">' + (i + 1) + '. ' + esc(q.title) + req + '</p>' + hint + inner + '</div>';
  }

  function buildForm() {
    $('questions').innerHTML = questions.map(qBlock).join('');
    const form = $('form');
    form.hidden = false;
    $('plainActions').hidden = true;

    // 回填
    const mine = window.__mine || {};
    questions.forEach(q => {
      const v = mine[q.id];
      const row = form.querySelector('.q[data-qid="' + q.id.replace(/"/g, '\\"') + '"]');
      if (!row || v == null) return;
      if (q.type === 'single' || q.type === 'multi') {
        const vals = q.type === 'multi' ? (Array.isArray(v) ? v : [v]) : [v];
        row.querySelectorAll('input').forEach(inp => { if (vals.indexOf(inp.value) >= 0) { inp.checked = true; inp.closest('.opt').classList.add('checked'); } });
      } else if (q.type === 'rating') {
        row.querySelectorAll('button.r').forEach(b => { if (Number(b.dataset.v) === Number(v)) { b.classList.add('on'); b.setAttribute('aria-pressed', 'true'); } });
      } else {
        const ta = row.querySelector('textarea');
        if (ta) ta.value = String(v);
      }
    });

    form.addEventListener('change', e => {
      const opt = e.target.closest && e.target.closest('.opt');
      if (!opt) return;
      if (e.target.type === 'radio') form.querySelectorAll('input[name="' + e.target.name + '"]').forEach(i => i.closest('.opt').classList.toggle('checked', i.checked));
      else opt.classList.toggle('checked', e.target.checked);
    });
    form.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('button.r');
      if (!b) return;
      const grp = b.closest('.rating');
      grp.querySelectorAll('button.r').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
      b.classList.add('on'); b.setAttribute('aria-pressed', 'true');
    });
    form.addEventListener('submit', submit);
  }

  function collect() {
    const out = {};
    questions.forEach(q => {
      const row = document.querySelector('.q[data-qid="' + q.id.replace(/"/g, '\\"') + '"]');
      if (!row) return;
      if (q.type === 'single') {
        const c = row.querySelector('input:checked'); if (c) out[q.id] = c.value;
      } else if (q.type === 'multi') {
        const vs = [...row.querySelectorAll('input:checked')].map(i => i.value); if (vs.length) out[q.id] = vs;
      } else if (q.type === 'rating') {
        const on = row.querySelector('button.r.on'); if (on) out[q.id] = Number(on.dataset.v);
      } else {
        const ta = row.querySelector('textarea'); if (ta && ta.value.trim()) out[q.id] = ta.value.trim();
      }
    });
    return out;
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    const btn = $('submit'); btn.disabled = true; btn.textContent = '提交中…';
    try {
      const r = await api('/' + id + '/answers', 'POST', { answers: collect() });
      msg('ok', (r.msg || '已提交') + '（本页可以直接修改后再次提交）');
      btn.textContent = '重新提交';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      msg('err', err.message || '提交失败，请稍后重试');
      if (err.status === 401) location.replace('/login?redirect=' + encodeURIComponent(selfPath));
    } finally { busy = false; btn.disabled = false; }
  }

  /* ---------------- 入口 ---------------- */
  api('/' + id).then(({ announcement: a }) => {
    $('kind').textContent = a.kind === 'survey' ? '问卷调研' : '公告';
    $('title').textContent = a.title || '';
    $('meta').textContent = (a.published_at ? '发布于 ' + date(a.published_at) : '') + (a.end_at ? ' · 截止 ' + date(a.end_at) : '');
    $('wrap').hidden = false;
    if (a.kind === 'survey') {
      questions = Array.isArray(a.questions) ? a.questions : [];
      window.__mine = a.my_answers || {};
      $('body').innerHTML = a.summary ? richText(a.summary) : '';
      $('body').hidden = !a.summary;
      $('meta').textContent += a.responded ? ' · 你已提交过，可修改' : '';
      if (!questions.length) { msg('err', '这份问卷暂时没有题目。'); return; }
      msg('', '');
      buildForm();
    } else {
      $('body').innerHTML = richText(a.body || a.summary || '');
      $('body').hidden = false;
      $('plainActions').hidden = false;
      const link = String(a.link || '').trim();
      if (link.charAt(0) === '/' && link.charAt(1) !== '/') {
        const a2 = document.createElement('a');
        a2.className = 'link';
        a2.href = link; a2.textContent = '查看详情 →';
        a2.style.cssText = 'display:inline-flex;align-items:center;min-height:44px;font-weight:600;text-decoration:underline;color:var(--green,#006b3c)';
        $('plainActions').insertBefore(a2, $('plainActions').firstChild);
      }
      msg('', '');
    }
  }).catch(err => {
    if (err.status === 401) { location.replace('/login?redirect=' + encodeURIComponent(selfPath)); return; }
    msg('err', err.message || '读取失败');
    const back = document.createElement('p');
    back.innerHTML = '<a href="/notifications">← 返回通知中心</a>';
    $('msg').after(back);
  });
})();
