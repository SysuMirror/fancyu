/* FancyU · 中意你 —— 通知中心页面 */
(() => {
  'use strict';
  const token = localStorage.getItem('token');
  if (!token) { location.replace('/login?redirect=' + encodeURIComponent('/notifications')); return; }
  const $ = id => document.getElementById(id);
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KIND = { match: { icon: '💛', label: '配对结果' }, chat: { icon: '💬', label: '新消息' }, exchange: { icon: '🤝', label: '联系方式' }, deadline: { icon: '⏰', label: '待回应' }, batch: { icon: '📢', label: '批次进度' }, notice: { icon: '📣', label: '公告通知' } };
  const date = x => new Date(x).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  let list = [], more = false, busy = false;

  async function api(path, method, body) {
    const r = await fetch('/api/account/notifications' + path, { method: method || 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.code !== 200) throw Error(j.msg || '请求失败');
    return j;
  }
  function toast(s) { const t = $('toast'); t.textContent = s; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 6000); }

  function item(n) {
    const k = KIND[n.kind] || KIND.match;
    // link 一律是站内 clean URL（登录回跳白名单已覆盖），不接受外部地址
    const href = n.link && n.link.startsWith('/') && !n.link.startsWith('//') ? n.link : '';
    return `<div class="notif ${n.read ? '' : 'unread'}" data-id="${n.id}"><span class="notif-icon" aria-hidden="true">${k.icon}</span><div class="notif-body"><b>${esc(n.title)}</b>${n.body ? `<p>${esc(n.body)}</p>` : ''}<div class="notif-meta"><span class="muted small">${esc(k.label)}</span><time datetime="${esc(n.created_at)}">${date(n.created_at)}</time>${href ? `<a class="notif-link" href="${esc(href)}" data-goto="${n.id}">查看 →</a>` : ''}</div></div></div>`;
  }
  function render() {
    $('list').innerHTML = list.length ? list.map(item).join('') : '<p class="muted">暂时没有通知。配对结果、新消息与截止提醒会出现在这里。</p>';
    $('more').hidden = !more;
  }
  async function load(before) {
    const j = await api((before ? '?before=' + before : ''));
    list = before ? list.concat(j.notifications) : j.notifications;
    more = j.more;
    render();
  }
  async function markRead(ids) { if (!ids.length) return; try { await api('/read', 'POST', { ids }); } catch (e) { /* 已读失败不阻塞跳转 */ } }

  /* 推送开关。脚本或环境跑不起来时，指向页面上的安装指引。 */
  function hideInstallNeed() {
    const note = $('pushNeedInstall');
    if (note) note.hidden = true;
  }
  function pointAtInstallGuide() {
    const note = $('pushNeedInstall');
    if (note) note.hidden = false;
    const guide = $('installGuide');
    if (!guide) return;
    guide.hidden = false;
    const panels = [...guide.querySelectorAll('[data-install-panel]')];
    if (panels.some(p => !p.hidden)) return;
    let name = 'manual';
    try {
      const state = window.fancyuInstall && window.fancyuInstall.flags && window.fancyuInstall.flags();
      if (state === 'ios-steps' || state === 'prompt') name = state;
    } catch (e) { /* 指引脚本缺失时用手动步骤 */ }
    panels.forEach(p => { p.hidden = p.getAttribute('data-install-panel') !== name; });
  }
  function setSwitch(btn, on, enabled) {
    btn.checked = !!on;
    btn.disabled = !enabled;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.dataset.mode = on ? 'off' : 'on';
  }
  async function paintPush() {
    const btn = $('pushToggle'), state = $('pushState');
    if (!window.fancyuPush) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { paintPush(); }, { once: true });
        return;
      }
      setSwitch(btn, false, false);
      state.textContent = '请先按下面的安装指引安装，再从图标打开。';
      pointAtInstallGuide();
      return;
    }
    const s = await window.fancyuPush.status();
    if (!s.supported) {
      setSwitch(btn, false, false);
      state.textContent = '请先按下面的安装指引安装，再从图标打开。';
      pointAtInstallGuide();
      return;
    }
    hideInstallNeed();
    if (s.subscribed) {
      setSwitch(btn, true, true);
      state.textContent = '已开启：配对结果、新消息与截止提醒会推送到这台设备。';
    } else if (s.permission === 'denied') {
      setSwitch(btn, false, false);
      state.textContent = '浏览器已拒绝通知权限，可在浏览器的网站设置里重新允许。';
    } else {
      setSwitch(btn, false, true);
      state.textContent = '打开后，离开网站也能收到配对发布、新消息与截止提醒。';
    }
  }

  $('pushToggle').addEventListener('change', async () => {
    const btn = $('pushToggle');
    if (!window.fancyuPush) { setSwitch(btn, false, false); pointAtInstallGuide(); return; }
    if (busy) { btn.checked = btn.dataset.mode === 'off'; return; }
    const turnOn = btn.checked;
    busy = true; btn.disabled = true;
    try {
      if (!turnOn) { await window.fancyuPush.disable(); toast('已关闭系统通知'); }
      else { await window.fancyuPush.enable(); toast('已开启，刚才那一下就是通知'); }
    } catch (e) {
      btn.checked = !turnOn;
      toast(e.message);
    } finally { busy = false; await paintPush(); }
  });

  $('readAll').addEventListener('click', async () => {
    if (busy || !list.some(n => !n.read)) return;
    busy = true;
    try { await api('/read-all', 'POST', {}); list = list.map(n => ({ ...n, read: true })); render(); toast('已全部标为已读'); }
    catch (e) { toast(e.message); } finally { busy = false; }
  });

  $('more').addEventListener('click', async () => {
    if (busy || !list.length) return;
    busy = true;
    try { await load(list[list.length - 1].id); } catch (e) { toast(e.message); } finally { busy = false; }
  });

  $('list').addEventListener('click', e => {
    const a = e.target.closest('[data-goto]');
    if (!a) return;
    const id = Number(a.dataset.goto);
    markRead([id]);                       // 不 await：点击就直接跳走
    list = list.map(n => (n.id === id ? { ...n, read: true } : n));
  });

  /* 通知偏好：只影响「浏览器推送」，站内通知中心照记 */
  async function loadPrefs() {
    const box = $('prefs');
    if (!box) return;
    try {
      const r = await fetch('/api/account/notification-prefs', { headers: { Authorization: 'Bearer ' + token } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.code !== 200) throw Error(j.msg || '读取失败');
      box.innerHTML = '';
      for (const p of j.prefs || []) {
        const k = KIND[p.kind] || KIND.match;
        const row = document.createElement('label');
        row.className = 'pref-row';
        const text = document.createElement('span');
        text.className = 'pref-text';
        text.textContent = k.icon + ' ' + k.label;
        const sw = document.createElement('input');
        sw.type = 'checkbox'; sw.checked = !!p.enabled; sw.dataset.kind = p.kind;
        sw.addEventListener('change', savePrefs);
        row.append(text, sw);
        box.append(row);
      }
      if (!box.children.length) box.innerHTML = '<p class="muted">没有可设置的通知类别。</p>';
    } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
  }
  let savingPrefs = false;
  async function savePrefs() {
    if (savingPrefs) return;
    savingPrefs = true;
    const prefs = [...document.querySelectorAll('#prefs input[data-kind]')].map(i => ({ kind: i.dataset.kind, enabled: i.checked }));
    try {
      const r = await fetch('/api/account/notification-prefs', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefs }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.code !== 200) throw Error(j.msg || '保存失败');
      toast('通知偏好已保存');
    } catch (e) { toast(e.message); }
    finally { savingPrefs = false; }
  }

  /* 从推送打开本页时，把目标会话/页面带上：/notifications?to=/chat?... */
  loadPrefs();
  paintPush();
  load().catch(e => { $('list').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; });
  setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 60000);
})();
