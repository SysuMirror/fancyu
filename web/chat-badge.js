/* 聊天未读徽标 + 未读数统一来源。
 * 页面若同时引入 tabbar.js，由本脚本独占 30s 轮询（tabbar 只监听事件），
 * 避免两个脚本各起一个 setInterval 打同一个 /api/account/chat。 */
(() => {
  window.__fancyuBadgeProvider = true;
  const links = [...document.querySelectorAll('[data-chat-link]')];
  let busy = false;
  function publish(unread) {
    for (const badge of document.querySelectorAll('[data-chat-badge]')) badge.textContent = unread ? ' (' + unread + ')' : '';
    try { localStorage.setItem('tabbarUnread', String(unread)); } catch (e) {}
    window.dispatchEvent(new CustomEvent('fancyu:unread', { detail: { unread } }));
  }
  async function update() {
    const token = localStorage.getItem('token');
    for (const link of links) link.hidden = !token;
    if (!token || document.hidden || busy) return;
    busy = true;
    try {
      const r = await fetch('/api/account/chat', { headers: { Authorization: 'Bearer ' + token } });
      const j = await r.json();
      if (r.ok && j.code === 200) publish(j.unread | 0);
    } catch (e) { /* 静默：徽标失败不影响主流程 */ }
    finally { busy = false; }
  }
  update();
  setInterval(update, 30000);
  window.addEventListener('focus', update);
})();
