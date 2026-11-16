/* FancyU · 中意你 —— Service Worker
 *
 * 只做三件事：离线兜底、静态资源缓存、Web Push 通知展示。
 * 绝不缓存任何带身份的数据（/api/ 等一律直接放行）。
 *
 * 退出机制：访问 /sw.js?kill（浏览器打开即可）会让本 SW 自我注销并清空缓存，
 * 免得万一要回退版本时，用户的浏览器还一直跑着旧 SW。
 */
const VERSION = 'fancyu-v1';
const SHELL = ['/offline', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/favicon.svg'];
// 命中这些前缀的请求一律不拦截（有身份/实时/接口数据）
const BYPASS = ['/api/', '/account/', '/admin/', '/oauth/', '/llm/', '/socket.io/', '/health'];
const OFFLINE = '/offline';

self.addEventListener('install', e => {
    self.skipWaiting();
    e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => null)))));
});

self.addEventListener('activate', e => {
    e.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

// 自我注销：/sw.js?kill
if (new URL(self.location.href).searchParams.has('kill')) {
    self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', e => e.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
        await self.registration.unregister();
        const cs = await self.clients.matchAll({ type: 'window' });
        cs.forEach(c => c.navigate(c.url));
    })()));
}

function bypass(url) {
    return BYPASS.some(p => url.pathname === p.slice(0, -1) || url.pathname.startsWith(p));
}

self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (bypass(url)) return;

    // 导航请求：网络优先，断网时给离线页
    if (req.mode === 'navigate') {
        e.respondWith((async () => {
            try {
                const res = await fetch(req);
                return res;
            } catch (err) {
                const c = await caches.open(VERSION);
                return (await c.match(req, { ignoreSearch: true })) || (await c.match(OFFLINE)) || Response.error();
            }
        })());
        return;
    }

    // 静态资源：先给缓存再后台更新（stale-while-revalidate）
    const cacheable = /\.(css|js|png|jpe?g|svg|webp|ico|woff2?|webmanifest)$/.test(url.pathname) || url.pathname === '/manifest.webmanifest';
    if (!cacheable) return;
    e.respondWith((async () => {
        const c = await caches.open(VERSION);
        const hit = await c.match(req, { ignoreSearch: true });
        const net = fetch(req).then(res => { if (res && res.ok && res.type === 'basic') c.put(req, res.clone()); return res; }).catch(() => null);
        return hit || (await net) || Response.error();
    })());
});

/* ---------------- Web Push ---------------- */
self.addEventListener('push', e => {
    let data = {};
    try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: 'FancyU · 中意你', body: e.data ? e.data.text() : '' }; }
    const url = data.url || '/notifications';
    e.waitUntil((async () => {
        // 用户此刻就停在该页面：不弹系统通知，避免刷屏（站内已实时显示）
        try {
            const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            const cur = new URL(self.location.origin + url);
            if (cs.some(c => c.visibilityState === 'visible' && new URL(c.url).pathname === cur.pathname)) return;
        } catch (err) { /* 判断失败时照常通知 */ }
        await self.registration.showNotification(data.title || 'FancyU · 中意你', {
            body: data.body || '',
            icon: '/icon-192.png',
            badge: '/icon-96.png',
            tag: data.tag || (data.kind ? data.kind + ':' + (data.id || '') : 'fancyu'),
            data: { url },
            renotify: false
        });
    })());
});

self.addEventListener('notificationclick', e => {
    e.notification.close();
    const url = (e.notification.data && e.notification.data.url) || '/notifications';
    e.waitUntil((async () => {
        const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of cs) {
            if (new URL(c.url).origin === self.location.origin && 'focus' in c) { await c.focus(); if ('navigate' in c) await c.navigate(url); return; }
        }
        if (self.clients.openWindow) await self.clients.openWindow(url);
    })());
});
