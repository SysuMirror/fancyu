/**
 * FancyU · 中意你 —— 通知铃铛（自含样式，页面引入本脚本即可）。
 *
 * 有页面 header 时把铃铛插进 header（不遮挡内容）；没有 header 的页面退化成一个悬浮按钮。
 * 未登录不显示。30s 轮询未读数，页面重新可见时立即刷新。
 */
(() => {
    'use strict';
    const TOKEN = () => { try { return localStorage.getItem('token') || ''; } catch (e) { return ''; } };
    const STYLE =
        '.fancyu-bell{position:relative;display:inline-flex;align-items:center;gap:4px;padding:4px 6px;border-radius:10px;' +
        'color:inherit;text-decoration:none;font-size:15px;line-height:1;background:none;border:0;cursor:pointer}' +
        '.fancyu-bell:hover{background:#073b3210}' +
        '.fancyu-bell-badge{position:absolute;top:-2px;right:-2px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;' +
        'background:#a6372d;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center}' +
        '.fancyu-bell-floating{position:fixed;top:calc(8px + env(safe-area-inset-top));right:8px;z-index:55;width:38px;height:38px;' +
        'justify-content:center;background:#faf9f5f2;border:1px solid #dedfd6;box-shadow:0 2px 10px #073b3214;backdrop-filter:blur(8px)}';

    let busy = false;

    function paint(n) {
        const b = document.querySelector('.fancyu-bell-badge');
        if (!b) return;
        if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.hidden = false; } else b.hidden = true;
    }

    function mount() {
        if (document.querySelector('.fancyu-bell') || !TOKEN()) return;
        const st = document.createElement('style');
        st.textContent = STYLE;
        document.head.appendChild(st);
        const a = document.createElement('a');
        a.className = 'fancyu-bell';
        a.href = '/notifications';
        a.setAttribute('aria-label', '通知中心');
        a.title = '通知中心';
        a.innerHTML = '<span aria-hidden="true">🔔</span><span class="fancyu-bell-badge" hidden></span>';
        const header = document.querySelector('header');
        if (header) header.appendChild(a);
        else { a.classList.add('fancyu-bell-floating'); document.body.appendChild(a); }
    }

    async function update() {
        if (!TOKEN() || document.hidden || busy) return;
        busy = true;
        try {
            const r = await fetch('/api/account/notifications/unread-count', { headers: { Authorization: 'Bearer ' + TOKEN() } });
            const j = await r.json();
            if (r.ok && j.code === 200) paint(Number(j.unread) || 0);
        } catch (e) { /* 网络问题静默 */ } finally { busy = false; }
    }

    function boot() { mount(); update(); setInterval(() => { mount(); update(); }, 30000); window.addEventListener('focus', update); document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); }); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
