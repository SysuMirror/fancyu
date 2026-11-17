/* 管理员入口只在确认身份后显示。不是管理员时链接保持 hidden。 */
(function () {
  'use strict';
  function nodes() { return document.querySelectorAll('[data-admin-entry]'); }
  function show(on) {
    nodes().forEach(function (el) { el.hidden = !on; });
  }
  async function enter(e) {
    var el = e.currentTarget;
    if (!el || el.hidden) return;
    e.preventDefault();
    var token = '';
    try { token = localStorage.getItem('token') || ''; } catch (err) { token = ''; }
    if (!token) return;
    el.setAttribute('aria-busy', 'true');
    try {
      var r = await fetch('/api/account/admin-entry', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
      var j = await r.json().catch(function () { return {}; });
      if (r.ok && j.code === 200 && j.token) {
        localStorage.setItem('adminToken', j.token);
        location.href = '/admin';
        return;
      }
    } catch (err) { /* 进不去就留在当前页 */ }
    el.removeAttribute('aria-busy');
  }
  nodes().forEach(function (el) { el.addEventListener('click', enter); });
  window.fancyuShowAdminEntry = show;
})();
