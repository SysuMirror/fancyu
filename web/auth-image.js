/**
 * 私有图片（头像 / 聊天图片）前端加载器。
 *
 * 这些资源走 /api/account/*，需要 Bearer token；<img src> 不会带 Authorization 头，
 * 所以统一改成：元素上写 data-auth-img="路径"，由这里 fetch → blob → objectURL 后回填 src。
 * 加载失败（无头像 / 无权限 / 会话结束）时直接移除该元素，不留破图。
 */
(() => {
    'use strict';
    if (window.fancyuAuthImages) return;

    const cache = new Map();

    function token() {
        try { return localStorage.getItem('token') || ''; } catch (e) { return ''; }
    }

    async function load(el) {
        const url = el.getAttribute('data-auth-img');
        if (!url || el.dataset.authImgLoaded) return;
        el.dataset.authImgLoaded = '1';
        try {
            let objectUrl = cache.get(url);
            if (!objectUrl) {
                const t = token();
                const res = await fetch(url, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
                if (!res.ok) throw new Error('image ' + res.status);
                objectUrl = URL.createObjectURL(await res.blob());
                cache.set(url, objectUrl);
            }
            el.src = objectUrl;
            el.removeAttribute('data-auth-img');
        } catch (e) {
            if (el.parentNode) el.parentNode.removeChild(el);
        }
    }

    function scan(root) {
        const scope = root && root.querySelectorAll ? root : document;
        const list = [];
        if (scope.nodeType === 1 && scope.matches && scope.matches('[data-auth-img]')) list.push(scope);
        for (const el of scope.querySelectorAll('[data-auth-img]')) list.push(el);
        for (const el of list) load(el);
    }

    window.fancyuAuthImages = scan;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan());
    else scan();
    new MutationObserver(() => scan()).observe(document.documentElement, { childList: true, subtree: true });
})();
