/* admin-shell.js — FancyU 管理后台统一外壳。
   宽屏：顶栏 + 横向栏目。窄屏：当前栏目按钮打开分组抽屉，表格按卡片阅读。
   用法：在 <body> 内放 <div data-admin-shell></div>。
   导航项顺序须与 admin.html 的 switchTab 保持一致。 */
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
    { key: 'graph',     label: '匹配拓扑',     href: '/admin/match-graph' },
    { key: 'users',     label: '用户列表',     href: '/admin#users' },
    { key: 'reports',   label: '举报',         href: '/admin#reports' },
    { key: 'assistant', label: 'AI助手',       href: '/admin#assistant' }
  ];
  var GROUPS = [
    { label: '运营', keys: ['stats', 'users', 'reports', 'assistant'] },
    { label: '配对', keys: ['weekly', 'deep', 'buddy', 'graph'] },
    { label: '内容', keys: ['survey', 'notice', 'pay'] }
  ];
  var PANEL = { stats: 1, users: 1, reports: 1, assistant: 1 };
  var mountEl = null;

  function pathName() { return location.pathname.replace(/\.html$/, '').replace(/\/+$/, ''); }
  function isAdminHome() { var p = pathName(); return p === '/admin' || p === ''; }
  function narrow() { return window.matchMedia('(max-width: 840px)').matches; }

  function activeKey() {
    var p = pathName();
    if (/\/admin\/survey$/.test(p)) return 'survey';
    if (/\/admin\/notice$/.test(p)) return 'notice';
    if (/\/admin\/match-graph$/.test(p)) return 'graph';
    if (/\/admin\/pay$/.test(p)) return 'pay';
    if (/\/admin\/weekly$/.test(p)) return 'weekly';
    if (/\/admin\/buddy$/.test(p)) return 'buddy';
    if (/\/admin\/deep$/.test(p)) return 'deep';
    if (/\/admin\/reports$/.test(p)) return 'reports';
    var h = (location.hash || '').replace('#', '');
    return PANEL[h] ? h : 'stats';
  }

  function labelOf(key) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].key === key) return TABS[i].label;
    return '管理后台';
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

  window.adminShellLogout = function () {
    if (typeof window.adminLogout === 'function') { window.adminLogout(); return; }
    try { localStorage.removeItem('adminToken'); } catch (e) {}
    location.href = '/admin';
  };

  function tabHTML(t, active) {
    var cls = 'tab' + (active ? ' active' : '');
    if (PANEL[t.key] && isAdminHome()) {
      return '<div class="' + cls + '" data-tab="' + t.key + '" role="tab" tabindex="0">' + esc(t.label) + '</div>';
    }
    return '<a class="' + cls + '" href="' + t.href + '">' + esc(t.label) + '</a>';
  }

  function groupHTML(active) {
    return GROUPS.map(function (g) {
      var items = g.keys.map(function (key) {
        for (var i = 0; i < TABS.length; i++) if (TABS[i].key === key) return tabHTML(TABS[i], key === active);
        return '';
      }).join('');
      return '<section class="admin-nav-group"><h2>' + esc(g.label) + '</h2>' + items + '</section>';
    }).join('');
  }

  function closeNav() {
    if (!mountEl) return;
    var nav = mountEl.querySelector('.admin-nav');
    var opener = mountEl.querySelector('.nav-open');
    if (nav) nav.hidden = true;
    if (opener) opener.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('admin-nav-open');
  }

  function openNav() {
    if (!mountEl || !narrow()) return;
    var nav = mountEl.querySelector('.admin-nav');
    var opener = mountEl.querySelector('.nav-open');
    if (!nav) return;
    nav.hidden = false;
    if (opener) opener.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('admin-nav-open');
    var closeBtn = nav.querySelector('.nav-close');
    if (closeBtn) closeBtn.focus();
  }

  function mark(key) {
    if (!mountEl) return;
    var current = mountEl.querySelector('.nav-current');
    if (current) current.textContent = labelOf(key || activeKey());
    closeNav();
  }

  function stampLabels(root) {
    var scope = root || document;
    scope.querySelectorAll('table').forEach(function (table) {
      var heads = Array.prototype.map.call(table.querySelectorAll('thead th'), function (th) {
        return (th.textContent || '').replace(/\s+/g, ' ').trim();
      });
      if (!heads.length) return;
      table.querySelectorAll('tbody tr').forEach(function (tr) {
        Array.prototype.forEach.call(tr.children, function (td, i) {
          if (!td || td.tagName !== 'TD') return;
          if (td.hasAttribute('colspan') || td.classList.contains('empty-row')) return;
          if (!td.getAttribute('data-label') && heads[i]) td.setAttribute('data-label', heads[i]);
        });
      });
    });
  }

  function render(mount) {
    mountEl = mount;
    var active = activeKey();
    mount.innerHTML =
      '<div class="topbar">' +
        '<button type="button" class="nav-open" aria-expanded="false" aria-controls="adminNav">' +
          '<span class="nav-kicker">栏目</span><strong class="nav-current">' + esc(labelOf(active)) + '</strong>' +
        '</button>' +
        '<h1 class="topbar-title">FancyU 管理后台</h1>' +
        '<div class="right"><span id="adminName"></span>' +
          '<a class="site-return" href="/profile">用户界面</a>' +
          '<button type="button" class="logout-btn" onclick="adminShellLogout()">退出</button>' +
        '</div></div>' +
      '<div class="tabs" role="tablist">' + TABS.map(function (t) { return tabHTML(t, t.key === active); }).join('') + '</div>' +
      '<div class="admin-nav" id="adminNav" hidden>' +
        '<button type="button" class="admin-nav-backdrop" aria-label="关闭栏目"></button>' +
        '<div class="admin-nav-sheet" role="dialog" aria-modal="true" aria-label="选择栏目">' +
          '<div class="admin-nav-head"><strong>选择栏目</strong><button type="button" class="nav-close">关闭</button></div>' +
          groupHTML(active) +
        '</div></div>';

    var nameEl = mount.querySelector('#adminName');
    if (nameEl) nameEl.textContent = userName() || '管理员';

    mount.querySelector('.nav-open').addEventListener('click', openNav);
    mount.querySelector('.nav-close').addEventListener('click', closeNav);
    mount.querySelector('.admin-nav-backdrop').addEventListener('click', closeNav);
    mount.querySelectorAll('.tab[data-tab]').forEach(function (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () {
        closeNav();
        if (typeof window.switchTab === 'function') window.switchTab(el.dataset.tab);
        else location.href = '/admin#' + el.dataset.tab;
      });
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        el.click();
      });
    });
    mount.querySelectorAll('.admin-nav a.tab').forEach(function (el) {
      el.addEventListener('click', closeNav);
    });
  }

  window.AdminShell = { TABS: TABS, render: render, activeKey: activeKey, mark: mark, stampLabels: stampLabels };

  function init() {
    var mount = document.querySelector('[data-admin-shell]');
    if (!mount) return false;
    render(mount);
    stampLabels(document);
    return true;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeNav();
  });

  if (!init()) document.addEventListener('DOMContentLoaded', init);
  else document.addEventListener('DOMContentLoaded', function () { stampLabels(document); });

  if (window.MutationObserver && document.body) {
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        stampLabels(document);
      });
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
