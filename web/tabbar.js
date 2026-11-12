/* FancyU 移动端底部导航（≤700px 显示）。自含样式，页面引入本脚本即可。 */
(function () {
  'use strict';
  var STYLE =
    '.tabbar{display:none}' +
    '@media (max-width:700px){' +
    '.tabbar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:60;justify-content:space-around;align-items:stretch;' +
    'background:#faf9f5f2;backdrop-filter:blur(10px);border-top:1px solid #dedfd6;box-shadow:0 -2px 12px #073b320a;' +
    'padding:4px 4px calc(4px + env(safe-area-inset-bottom))}' +
    'body.has-tabbar{padding-bottom:64px}' +
    '.tabbar a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:52px;' +
    'padding:4px 2px;color:#55726a;text-decoration:none;font-size:11px;line-height:1.2;border-radius:12px;position:relative}' +
    '.tabbar a svg{width:22px;height:22px}' +
    '.tabbar a.active{color:#265a48;font-weight:650}' +
    '.tabbar-badge{position:absolute;top:2px;right:calc(50% - 24px);min-width:17px;height:17px;padding:0 5px;border-radius:999px;' +
    'background:#a6372d;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center}' +
    '}';

  var TOKEN = function () { return localStorage.getItem('token') || ''; };
  var TABS = [
    { href: '/', label: '首页', match: function (p) { return p === '/' || p === '/index.html'; }, icon: '<path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1Z"/>' },
    { href: '/weekly-match', label: '配对', match: function (p) { return p.indexOf('/weekly-match') === 0 || p === '/survey'; }, icon: '<path d="M12 21s-7.5-4.6-9.3-9A5.4 5.4 0 0 1 12 6.3 5.4 5.4 0 0 1 21.3 12c-1.8 4.4-9.3 9-9.3 9Z"/>' },
    { href: '/chat', label: '消息', match: function (p) { return p.indexOf('/chat') === 0; }, icon: '<path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7l-5 4V6a2 2 0 0 1 2-2Z"/>', badge: true },
    { href: '/profile', label: '我的', match: function (p) { return p.indexOf('/profile') === 0 || p.indexOf('/dashboard') === 0; }, icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6Z"/>' }
  ];

  function renderBadge(n) {
    var b = document.getElementById('tabbarBadge');
    if (!b) return;
    if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.hidden = false; }
    else { b.hidden = true; }
  }

  function fetchUnread() {
    if (!TOKEN()) return;
    fetch('/api/account/chat', { headers: { Authorization: 'Bearer ' + TOKEN() } })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (d) {
        var rooms = (d && (d.rooms || d)) || [];
        var n = 0;
        for (var i = 0; i < rooms.length; i++) n += (rooms[i].unread || 0) | 0;
        try { localStorage.setItem('tabbarUnread', String(n)); } catch (e) {}
        renderBadge(n);
      })
      .catch(function () {});
  }

  function build() {
    if (document.getElementById('fancyTabbar')) return;
    if (!TOKEN()) return; // 未登录不显示导航
    var st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);
    var p = location.pathname;
    var nav = document.createElement('nav');
    nav.id = 'fancyTabbar';
    nav.className = 'tabbar';
    nav.setAttribute('aria-label', '主导航');
    TABS.forEach(function (t) {
      var a = document.createElement('a');
      a.href = t.href;
      if (t.match(p)) a.className = 'active';
      a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + t.icon + '</svg><span>' + t.label + '</span>' + (t.badge ? '<b id="tabbarBadge" class="tabbar-badge" hidden></b>' : '');
      nav.appendChild(a);
    });
    document.body.appendChild(nav);
    document.body.classList.add('has-tabbar');
    var cached = 0;
    try { cached = parseInt(localStorage.getItem('tabbarUnread') || '0', 10) || 0; } catch (e) {}
    renderBadge(cached);
    fetchUnread();
    setInterval(fetchUnread, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) fetchUnread(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
