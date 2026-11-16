/* home-notices.js — 首页「公告 / 问卷调研」卡片位。
   自包含：不改 home.js，不发 token 时不渲染任何东西（未登录首页保持原样）。
   关闭态记在 localStorage 'fancyu-notice-dismissed'（公告 id 数组，上限 50）。 */
(() => {
  'use strict';
  const box = document.getElementById('noticeCards');
  if (!box) return;
  const token = (() => { try { return localStorage.getItem('token') || ''; } catch (e) { return ''; } })();
  if (!token) return;

  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAX_SHOW = 3, MAX_STORE = 50;
  const KEY = 'fancyu-notice-dismissed';

  function dismissed() {
    try {
      const a = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(a) ? a.map(Number).filter(n => Number.isFinite(n)) : [];
    } catch (e) { return []; }
  }
  function dismiss(id) {
    const a = dismissed().filter(n => n !== id);
    a.push(id);
    try { localStorage.setItem(KEY, JSON.stringify(a.slice(-MAX_STORE))); } catch (e) {}
  }

  // 站内 clean URL 才可点（与 notifications.js 同判据，拒 //）
  function safeHref(v) {
    const s = String(v || '').trim();
    return s.charAt(0) === '/' && s.charAt(1) !== '/' && s.charAt(1) !== '\\' ? s : '';
  }
  function hrefOf(n) {
    const own = safeHref(n.link);
    if (own) return own;
    return n.kind === 'survey' ? '/app-survey?id=' + encodeURIComponent(n.id) : '';
  }

  function cardHTML(n) {
    const href = hrefOf(n);
    const isSurvey = n.kind === 'survey';
    return '<article class="notice-card" data-id="' + n.id + '">' +
      '<span class="notice-kind">' + (isSurvey ? '问卷调研' : '公告') + '</span>' +
      '<button type="button" class="notice-close" data-close="' + n.id + '" aria-label="不再显示这条' + (isSurvey ? '问卷' : '公告') + '">×</button>' +
      '<h3>' + esc(n.title) + '</h3>' +
      (n.summary ? '<p>' + esc(n.summary) + '</p>' : '') +
      '<div class="notice-foot">' +
        (href ? '<a class="notice-link" href="' + esc(href) + '">' + (isSurvey ? (n.responded ? '查看我的回答 →' : '去填写 →') : '查看 →') + '</a>' : '') +
        (isSurvey && n.responded ? '<span class="notice-done">已提交，可修改</span>' : '') +
      '</div>' +
      '</article>';
  }

  function render(list) {
    const skip = dismissed();
    const show = list.filter(n => skip.indexOf(Number(n.id)) < 0).slice(0, MAX_SHOW);
    if (!show.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = show.map(cardHTML).join('');
    box.hidden = false;
  }

  box.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('[data-close]') : null;
    if (!b) return;
    e.preventDefault();
    const id = Number(b.dataset.close), card = b.closest('.notice-card');
    dismiss(id);
    if (card) card.remove();
    if (!box.querySelector('.notice-card')) { box.hidden = true; box.innerHTML = ''; }
  });

  fetch('/api/account/announcements', { headers: { Authorization: 'Bearer ' + token } })
    .then(r => r.json().catch(() => ({})))
    .then(j => { if (j && j.code === 200 && Array.isArray(j.announcements)) render(j.announcements); })
    .catch(() => { /* 首页装饰，失败静默 */ });
})();
