/* admin-shell.js — FancyU 管理后台统一外壳（顶栏 + 9 项导航）。
   用法：在 <body> 内放 <div data-admin-shell></div>（内容之上），脚本渲染与 /admin 同款的
   顶栏（标题 / 管理员名 / 退出）与导航行，并按当前路径高亮对应 tab。
   在 /admin 页上，面板 tab（数据统计/用户列表/AI助手）走其 switchTab；在其他页则退化为
   回到 /admin#key 的链接。导航项顺序须与 admin.html 保持一致（改动时两处同步）。 */
(function () {
  'use strict';
  var TABS = [
    { key: 'stats',     label: '数据统计',     href: '/admin' },
    { key: 'deep',      label: '深度交友批次', href: '/admin/deep' },
    { key: 'buddy',     label: '搭子配对批次', href: '/admin/buddy' },
    { key: 'weekly',    label: '每周配对批次', href: '/admin/weekly' },
    { key: 'pay',       label: '支付定价',     href: '/admin/pay' },
    { key: 'survey',    label: '问卷管理',     href: '/admin/survey' },
    { key: 'notice',    label: '公告与问卷',   href: '/admin/notice' },
    { key: 'users',     label: '用户列表',     href: '/admin#users' },
    { key: 'reports',   label: '举报',         href: '/admin#reports' },
    { key: 'assistant', label: 'AI助手',       href: '/admin#assistant' }
  ];
  // /admin 内的面板 tab（需调用其 switchTab，而非跳转）
  var PANEL = { stats: 1, users: 1, reports: 1, assistant: 1 };

  function pathName() { return location.pathname.replace(/\.html$/, '').replace(/\/+$/, ''); }
  function isAdminHome() { var p = pathName(); return p === '/admin' || p === ''; }

  function activeKey() {
    var p = pathName();
    if (/\/admin\/survey$/.test(p)) return 'survey';
    if (/\/admin\/notice$/.test(p)) return 'notice';
    if (/\/admin\/pay$/.test(p)) return 'pay';
    if (/\/admin\/weekly$/.test(p)) return 'weekly';
    if (/\/admin\/buddy$/.test(p)) return 'buddy';
    if (/\/admin\/deep$/.test(p)) return 'deep';
    if (/\/admin\/reports$/.test(p)) return 'reports';
    var h = (location.hash || '').replace('#', '');
    return PANEL[h] ? h : 'stats';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function userName() {
    try {
      var t = localStorage.getItem('adminToken');
      if (!t) return '';
      var payload = JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))));
      return payload.username || '';
    } catch (e) { return ''; }
  }

  // 退出：优先用页面自己的 adminLogout（/admin 上会同时切回登录页），否则清 token 回 /admin
  window.adminShellLogout = function () {
    if (typeof window.adminLogout === 'function') { window.adminLogout(); return; }
    try { localStorage.removeItem('adminToken'); } catch (e) {}
    location.href = '/admin';
  };

  function tabHTML(t, active) {
    var cls = 'tab' + (active ? ' active' : '');
    if (PANEL[t.key] && isAdminHome()) {
      return '<div class="' + cls + '" data-tab="' + t.key + '">' + esc(t.label) + '</div>';
    }
    return '<a class="' + cls + '" href="' + t.href + '">' + esc(t.label) + '</a>';
  }

  function render(mount) {
    var active = activeKey();
    mount.innerHTML =
      '<div class="topbar"><h1>FancyU 管理后台</h1>' +
        '<div class="right"><span id="adminName"></span>' +
        '<button type="button" onclick="adminShellLogout()">退出</button>' +
        '</div></div>' +
      '<div class="tabs" role="tablist">' + TABS.map(function (t) { return tabHTML(t, t.key === active); }).join('') + '</div>';

    var nameEl = mount.querySelector('#adminName');
    if (nameEl) nameEl.textContent = userName() || '管理员';

    mount.querySelectorAll('.tab[data-tab]').forEach(function (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () {
        if (typeof window.switchTab === 'function') window.switchTab(el.dataset.tab);
        else location.href = '/admin#' + el.dataset.tab;
      });
    });
  }

  window.AdminShell = { TABS: TABS, render: render, activeKey: activeKey };

  function init() {
    var mount = document.querySelector('[data-admin-shell]');
    if (mount) { render(mount); return true; }
    return false;
  }
  // 挂载点若已存在则同步渲染（/admin 用同步 <script> 以便其页脚脚本能读到 #adminName）；
  // 否则等 DOM 就绪（子页用 defer）。
  if (!init()) document.addEventListener('DOMContentLoaded', init);
})();
