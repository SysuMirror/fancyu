/**
 * FancyU · 中意你 —— PWA 装配脚本
 *
 * 1. 注册 Service Worker（离线兜底 + 静态缓存 + Web Push）；
 * 2. 暴露 window.fancyuPush 给「通知中心」页面，用按钮（用户手势）来申请推送授权并订阅。
 *
 * 说明：这里**不主动**弹授权框 —— 浏览器要求授权必须来自用户手势，
 * 而且无脑弹窗会被用户拒绝后再也申请不了。所以只在 notifications 页由按钮触发。
 */
(() => {
    'use strict';
    const SW_URL = '/sw.js?v=1';

    function token() { try { return localStorage.getItem('token') || ''; } catch (e) { return ''; } }
    function b64ToBytes(b64) {
        const pad = '='.repeat((4 - b64.length % 4) % 4);
        const s = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }
    async function api(path, opts = {}) {
        const t = token();
        const res = await fetch('/api/account' + path, {
            method: opts.method || 'GET',
            headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}, opts.headers || {}),
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || (j.code && j.code !== 200)) throw Object.assign(Error(j.msg || '操作失败'), { status: res.status });
        return j;
    }

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register(SW_URL).catch(() => { /* 注册失败不影响正常使用 */ });
        });
    }

    window.fancyuPush = {
        // 当前是否已订阅
        async status() {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { supported: false };
            try {
                const reg = await navigator.serviceWorker.ready;
                const sub = await reg.pushManager.getSubscription();
                return { supported: true, permission: Notification.permission, subscribed: !!sub };
            } catch (e) { return { supported: false }; }
        },
        // 申请授权 + 订阅（必须由用户点击触发）
        async enable() {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw Error('这个浏览器/环境不支持系统通知，站内通知仍可正常使用');
            const reg = await navigator.serviceWorker.ready;
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') throw Error(perm === 'denied' ? '通知权限被拒绝，可在浏览器设置里重新开启' : '没有获得通知权限');
            const { enabled, publicKey } = await api('/push/vapid');
            if (!enabled || !publicKey) throw Error('服务端尚未开启推送（缺少推送密钥）');
            let sub = await reg.pushManager.getSubscription();
            if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
            await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
            return true;
        },
        async disable() {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) return true;
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            if (sub) { try { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); } catch (e) {} await sub.unsubscribe(); }
            return true;
        }
    };
})();
