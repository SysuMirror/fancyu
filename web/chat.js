/* chat.js —— FancyU 站内聊天
   依赖：auth-session.js 已注入 token；campus-ui.css 提供视觉 token。 */
(() => {
'use strict';

const token = localStorage.getItem('token');
if (!token) { location.replace('/login?redirect=/chat'); return; }

/* ---------- 常量与工具 ---------- */
const $ = id => document.getElementById(id);
const LABELS = { love: '恋爱配对', deep: '深度交友', buddy: '约个搭子' };
const BASES = { love: 'weekly-match', deep: 'deep-match', buddy: 'friends' };
const MAX_LEN = 2000;
const COARSE = matchMedia('(pointer:coarse)');
const NARROW = matchMedia('(max-width:700px)');
const isMobile = () => COARSE.matches || NARROW.matches;
const pad = n => String(n).padStart(2, '0');
const hm = d => pad(d.getHours()) + ':' + pad(d.getMinutes());
const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
  && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dayLabel = d => {
  const now = new Date();
  if (sameDay(d, now)) return '今天';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return '昨天';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
};
const relTime = d => {
  const now = new Date();
  if (now - d < 60000) return '刚刚';
  if (sameDay(d, now)) return hm(d);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return '昨天 ' + hm(d);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm(d);
};
const fullTime = d => d.toLocaleString('zh-CN');

/* ---------- 状态 ---------- */
let current = null;            // 当前会话 {mode,pair_id,name,...}
let rooms = [];                // 会话列表数据
let msgs = [];                 // 当前会话已加载消息（按 id 升序）
const msgsById = new Map();    // id -> message
let pendingMsgs = [];          // 乐观发送中的消息 [{client_id, body, failed}]
let otherLastRead = 0;         // 对方已读到的消息 id
let hasMoreOlder = false;
let exchangeState = {};
let ws = null, wsRetry = 0, userClosed = false, wasOffline = false, everConnected = false;
let refreshTimer = null, fetching = false, again = false;
let lastRead = 0, initial = true;
let reportTarget = null;       // 待举报的消息 id
let confirmAction = null;      // 待确认的动作（block/close）

/* ---------- toast 与标题 ---------- */
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 4000);
}
function updateTitle(unread) {
  document.title = unread > 0 ? `(${unread}) FancyU 消息` : '站内聊天 · FancyU';
}

/* ---------- API ---------- */
async function api(path = '', method = 'GET', body) {
  const r = await fetch('/api/account/chat' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const j = await r.json();
  if (r.status === 401) {
    userClosed = true; ws?.close();
    location.replace('/login?redirect=/chat');
    throw Error('请重新登录');
  }
  if (!r.ok || j.code !== 200) throw Object.assign(Error(j.msg || '读取失败'), { status: r.status });
  return j;
}
const key = r => r.mode + '/' + r.pair_id;
const prefix = () => '/' + key(current);

/* ---------- 轻量实时通道：在线 / 正在输入（纯提示，失败静默） ---------- */
let joinedKey = null;          // 我已经「进」了哪个房间（服务端据此判断在线）
let peerOnline = null;         // true / false / null(未知)
let peerTypingUntil = 0, typingSentAt = 0, typingClearTimer = null;
function wsSend(obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) { /* 通道不可用就算了 */ } }
function roomKeyArgs(k) { const i = k.indexOf('/'); return { mode: k.slice(0, i), pair_id: Number(k.slice(i + 1)) }; }
function paintPresence() {
  const el = $('presence'); if (!el) return;
  if (!current || !joinedKey || document.body.dataset.view !== 'room') { el.hidden = true; return; }
  const typing = Date.now() < peerTypingUntil;
  const text = typing ? '对方正在输入…'
    : peerOnline === true ? '对方在线'
    : peerOnline === false ? '对方当前不在线' : '';
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('typing', typing);
  el.classList.toggle('online', !typing && peerOnline === true);
  el.classList.toggle('offline', !typing && peerOnline === false);
}
function joinRoom(room) {
  if (!room) return;
  const k = key(room);
  if (joinedKey === k) return;
  leaveRoom();
  joinedKey = k; peerOnline = null; peerTypingUntil = 0;
  wsSend({ type: 'presence', mode: room.mode, pair_id: room.pair_id, online: true });
  paintPresence();
}
function leaveRoom() {
  if (!joinedKey) return;
  wsSend({ type: 'presence', ...roomKeyArgs(joinedKey), online: false });
  joinedKey = null; peerOnline = null; peerTypingUntil = 0;
  paintPresence();
}
function pingTyping() {
  if (!joinedKey || !current) return;
  const now = Date.now();
  if (now - typingSentAt < 3000) return;   // 3 秒内不重复上报，避免每键一包
  typingSentAt = now;
  wsSend({ type: 'typing', ...roomKeyArgs(joinedKey) });
}
function peerTyping() {
  peerTypingUntil = Date.now() + 4000;
  paintPresence();
  clearTimeout(typingClearTimer);
  typingClearTimer = setTimeout(paintPresence, 4200);
}

/* ---------- 破冰话题（只在空白会话里出现） ---------- */
let iceKey = null, iceRound = 0;
function useTopic(text) {
  const t = $('message'); if (!t || t.disabled) return;
  t.value = text; autoGrow(); updateCounter(); t.focus();
}
function renderIcebreakers(topics, round) {
  const box = $('icebreakers'); if (!box) return;
  box.replaceChildren();
  const head = document.createElement('div');
  head.className = 'ice-head';
  const title = document.createElement('strong');
  title.textContent = '第一次开口？试试这些';
  const swap = document.createElement('button');
  swap.type = 'button'; swap.className = 'text-button'; swap.textContent = '换一批';
  swap.onclick = () => { iceRound = (round + 1) % 10; loadIcebreakers(iceRound); };
  head.append(title, swap);
  const list = document.createElement('div');
  list.className = 'ice-list';
  for (const t of topics) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ice-topic'; b.textContent = t;
    b.onclick = () => useTopic(t);
    list.append(b);
  }
  box.append(head, list);
  box.hidden = false;
  iceKey = current ? key(current) : null;
}
async function loadIcebreakers(round) {
  const box = $('icebreakers'); if (!box || !current) return;
  const selected = key(current);
  try {
    const j = await api(prefix() + '/icebreakers?round=' + round);
    if (!current || key(current) !== selected || msgs.length) return;
    if (!j.topics || !j.topics.length) { box.hidden = true; return; }
    renderIcebreakers(j.topics, j.round || 0);
  } catch (e) { box.hidden = true; }   // 话题只是锦上添花，拿不到就不显示
}
function maybeIcebreakers() {
  const box = $('icebreakers'); if (!box) return;
  if (!current || msgs.length) { box.hidden = true; return; }
  if (iceKey === key(current)) { box.hidden = false; return; }
  box.hidden = true;                   // 先藏起，拿到话题再显示，避免闪烁
  loadIcebreakers(iceRound);
}

/* ---------- 搜索聊天记录 ---------- */
let searchTimer = null, searchSeq = 0;
function clearSearch() {
  const box = $('searchResults'), input = $('chatSearch');
  if (box) { box.replaceChildren(); box.hidden = true; }
  if (input) input.value = '';
  $('rooms').hidden = false;
  $('archived').hidden = !$('archived').querySelector('.room');
}
function renderSearchResults(j) {
  const box = $('searchResults'); if (!box) return;
  box.replaceChildren();
  if (!j.results.length) {
    const p = document.createElement('p');
    p.className = 'muted search-empty';
    p.textContent = '没有找到相关消息。';
    box.append(p);
  } else {
    const hint = document.createElement('p');
    hint.className = 'muted search-empty';
    hint.textContent = '共 ' + j.count + ' 条，点一条跳到该会话。';
    box.append(hint);
  }
  for (const r of j.results) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'search-hit';
    const head = document.createElement('span');
    head.className = 'search-hit-head';
    head.textContent = (r.name || '对方') + ' · ' + (LABELS[r.mode] || r.mode);
    const snip = document.createElement('span');
    snip.className = 'search-hit-snippet';
    snip.textContent = (r.mine ? '我：' : '') + (r.snippet || '');
    const t = document.createElement('time');
    t.className = 'search-hit-time';
    t.textContent = relTime(new Date(r.created_at));
    b.append(head, snip, t);
    b.onclick = () => {
      const k = r.mode + '/' + r.pair_id;
      const room = rooms.find(x => key(x) === k) || { mode: r.mode, pair_id: r.pair_id, name: r.name };
      clearSearch();
      select(room);
    };
    box.append(b);
  }
  box.hidden = false;
  $('rooms').hidden = true;
  $('archived').hidden = true;
}
async function runSearch(q) {
  const seq = ++searchSeq;
  const box = $('searchResults');
  try {
    const j = await api('/search?q=' + encodeURIComponent(q));
    if (seq !== searchSeq) return;      // 已经输入了更新的词，丢弃旧结果
    renderSearchResults(j);
  } catch (e) {
    if (seq !== searchSeq) return;
    box.replaceChildren();
    const p = document.createElement('p');
    p.className = 'error search-empty';
    p.textContent = e.message;
    box.append(p);
    box.hidden = false;
    $('rooms').hidden = true;
  }
}
$('chatSearch').addEventListener('input', () => {
  const q = $('chatSearch').value.trim();
  clearTimeout(searchTimer);
  if (!q) { searchSeq++; clearSearch(); return; }
  searchTimer = setTimeout(() => runSearch(q), 300);
});
$('chatSearch').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); searchSeq++; clearSearch(); }
});

/* ---------- 会话列表：增量更新 ---------- */
const roomEls = new Map(); // key -> {el, name, mode, preview, badge}

function buildRoomEl(room) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'room';
  const name = document.createElement('span');
  name.className = 'room-name';
  const mode = document.createElement('span');
  mode.className = 'room-mode';
  name.append(document.createTextNode(room.name), mode);
  const preview = document.createElement('span');
  preview.className = 'room-preview';
  const badge = document.createElement('span');
  badge.className = 'badge';
  el.append(name, preview, badge);
  el.onclick = () => select(room);
  return { el, name: name.firstChild, mode, preview, badge };
}
function updateRoomEl(entry, room) {
  entry.name.textContent = room.name;
  entry.mode.textContent = ' · ' + (LABELS[room.mode] || room.mode);
  entry.preview.textContent = room.last_preview || '还没有消息，打个招呼吧';
  entry.badge.textContent = room.unread ? String(room.unread) : '';
  entry.badge.hidden = !room.unread;
  entry.el.classList.toggle('active', !!current && key(room) === key(current));
}
async function loadRooms() {
  const j = await api();
  rooms = j.rooms;
  $('unread').textContent = j.unread ? '(' + j.unread + ')' : '';
  updateTitle(j.unread);
  const box = $('rooms');
  const seen = new Set();
  rooms.forEach((room, i) => {
    const k = key(room);
    seen.add(k);
    let entry = roomEls.get(k);
    if (!entry) { entry = buildRoomEl(room); roomEls.set(k, entry); }
    updateRoomEl(entry, room);
    // 保证排序：以「下一个会话的元素」为锚点插入，新会话自然落到队尾
    const next = rooms[i + 1] && roomEls.get(key(rooms[i + 1]));
    if (next) box.insertBefore(entry.el, next.el); else box.append(entry.el);
  });
  for (const [k, entry] of roomEls) {
    if (!seen.has(k)) { entry.el.remove(); roomEls.delete(k); }
  }
  box.querySelector('.room-empty')?.remove();
  if (!rooms.length) {
    const p = document.createElement('p');
    p.className = 'room-empty';
    p.textContent = '暂无会话。配对双方同意后即可开始聊天。';
    box.append(p);
  }
  renderArchived(j.archived);
  if (current && !rooms.some(r => key(r) === key(current))) {
    disable('连接已结束、被屏蔽或当前不可访问。');
    return;
  }
  if (initial) {
    initial = false;
    const u = new URLSearchParams(location.search);
    const wanted = rooms.find(r => r.mode === u.get('mode') && String(r.pair_id) === u.get('pair'));
    if (wanted || rooms[0]) await select(wanted || rooms[0]);
  }
}

/* ---------- 历史连接（只读归档） ---------- */
function renderArchived(list) {
  const box = $('archived');
  if (!box) return;
  box.replaceChildren();
  if (!list || !list.length) { box.hidden = true; return; }
  const h = document.createElement('h2');
  h.textContent = '历史连接';
  const hint = document.createElement('p');
  hint.className = 'muted room-hint';
  hint.textContent = '已结束的连接只作记录，不能再聊天。';
  box.append(h, hint);
  for (const a of list) {
    const el = document.createElement('div');
    el.className = 'room archived';
    const name = document.createElement('span');
    name.className = 'room-name';
    const mode = document.createElement('span');
    mode.className = 'room-mode';
    mode.textContent = ' · ' + (LABELS[a.mode] || a.mode);
    name.append(document.createTextNode(a.name || '对方'), mode);
    const preview = document.createElement('span');
    preview.className = 'room-preview';
    preview.textContent = (a.reason || '已结束') + (a.ended_at ? ' · ' + new Date(a.ended_at).toLocaleDateString('zh-CN') : '');
    el.append(name, preview);
    box.append(el);
  }
  box.hidden = false;
}

/* ---------- 会话切换 ---------- */
function setView(view) { document.body.dataset.view = view; }
async function select(room) {
  current = room;
  lastRead = 0; otherLastRead = 0; hasMoreOlder = false;
  msgs = []; msgsById.clear(); pendingMsgs = [];
  $('message').value = ''; autoGrow(); updateCounter();
  $('name').textContent = room.name;
  $('mode').textContent = LABELS[room.mode] || room.mode;
  renderPeer(null);
  for (const id of ['exchange', 'block', 'closeRoom', 'hideRoom']) $(id).hidden = false;
  $('message').disabled = $('send').disabled = false;
  $('notice').textContent = '';
  joinRoom(room);
  setView('room');
  paintPresence();
  history.replaceState(null, '', '?mode=' + room.mode + '&pair=' + room.pair_id);
  for (const entry of roomEls.values()) entry.el.classList.remove('active');
  roomEls.get(key(room))?.el.classList.add('active');
  await refresh(true);
}
function disable(text) {
  leaveRoom();
  current = null;
  msgs = []; msgsById.clear(); pendingMsgs = [];
  renderAll();
  $('icebreakers').hidden = true;
  $('name').textContent = '会话不可用';
  $('mode').textContent = '';
  $('exchangeStatus').hidden = true;
  renderPeer(null);
  for (const id of ['exchange', 'block', 'closeRoom', 'hideRoom', 'older']) $(id).hidden = true;
  $('message').disabled = $('send').disabled = true;
  setView('list');
  $('notice').textContent = text;
}

/* ---------- 对方资料卡（会话内展示，来自三线 publicData） ---------- */
function renderPeer(peer) {
  const box = $('peer');
  if (!box) return;
  box.replaceChildren();
  if (!peer) { box.hidden = true; return; }
  const avatar = document.createElement('span');
  avatar.className = 'peer-avatar';
  avatar.textContent = (peer.name || '友').slice(0, 1);
  if (peer.avatar) {
    const im = document.createElement('img');
    im.alt = ''; im.loading = 'lazy';
    im.setAttribute('data-auth-img', peer.avatar);
    avatar.append(im);
  }
  const info = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = peer.name || '';
  info.append(name);
  const facts = [peer.campus, peer.college, peer.hometown].filter(Boolean).join(' · ');
  const line = peer.bio || (peer.tags && peer.tags.length ? peer.tags.join(' · ') : peer.interests) || '';
  const note = [facts, line].filter(Boolean).join('；');
  if (note) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = note;
    info.append(p);
  }
  box.append(avatar, info);
  box.hidden = false;
  if (window.fancyuAuthImages) window.fancyuAuthImages(box);
}

/* ---------- 消息渲染（分组 + 日期分隔 + 相对时间） ---------- */
function renderAll() {
  const area = $('messages');
  const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80 || !msgs.length;
  const frag = document.createDocumentFragment();
  const all = [
    ...msgs,
    ...pendingMsgs.map(p => ({ ...p, mine: true, pending: true, failed: p.failed }))
  ];
  if (!all.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = current ? '你们的校园故事，从这里开始。' : '选择一个会话开始聊天。';
    frag.append(p);
  }
  let prev = null;
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    const d = m.created_at ? new Date(m.created_at) : new Date();
    const newDay = !prev || !sameDay(new Date(prev.created_at || Date.now()), d);
    if (newDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = dayLabel(d);
      frag.append(sep);
    }
    const groupStart = newDay || !prev || prev.mine !== m.mine;
    const next = all[i + 1];
    const groupEnd = !next || next.mine !== m.mine
      || !sameDay(d, next.created_at ? new Date(next.created_at) : new Date());
    frag.append(buildMsgEl(m, d, groupStart, groupEnd));
    prev = m;
  }
  area.replaceChildren(frag);
  $('older').hidden = !(hasMoreOlder && msgs.length);
  if (atBottom) area.scrollTop = area.scrollHeight;
}
function buildMsgEl(m, d, groupStart, groupEnd) {
  const el = document.createElement('div');
  el.className = 'msg' + (m.mine ? ' mine' : '')
    + (groupStart ? ' group-start' : '')
    + (m.pending ? ' pending' : '') + (m.failed ? ' failed' : '');
  if (m.id) el.dataset.id = m.id;

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = m.mine ? '我' : (current?.name || '友').slice(0, 1);

  const body = document.createElement('div');
  body.className = 'msg-body';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.recalled) {
    bubble.classList.add('recalled');
    bubble.textContent = m.mine ? '你撤回了一条消息' : '对方撤回了一条消息';
  } else if (m.image) {
    const im = document.createElement('img');
    im.className = 'bubble-image';
    im.alt = '图片消息';
    im.loading = 'lazy';
    im.setAttribute('data-auth-img', m.image);
    bubble.append(im);
    if (m.body) {
      const t = document.createElement('p');
      t.className = 'bubble-text';
      t.textContent = m.body;
      bubble.append(t);
    }
  } else {
    bubble.textContent = m.body;
  }
  body.append(bubble);

  if (groupEnd) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = relTime(d);
    time.title = fullTime(d);
    meta.append(time);
    if (m.mine && m.id) {
      const read = document.createElement('span');
      read.className = 'read';
      read.textContent = m.id <= otherLastRead ? '已读' : '未读';
      meta.append(read);
    }
    if (m.mine && m.id && !m.recalled && !m.pending && (Date.now() - d.getTime() < 120000)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'recall-message';
      btn.textContent = '撤回';
      btn.onclick = () => recall(m.id);
      meta.append(btn);
    }
    if (m.failed) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry-btn';
      retry.textContent = '重试';
      retry.onclick = () => retryPending(m.client_id);
      meta.append(retry);
    } else if (!m.mine && m.id) {
      const report = document.createElement('button');
      report.type = 'button';
      report.className = 'report-message';
      report.textContent = '举报';
      report.onclick = () => openReport(m.id);
      meta.append(report);
    }
    body.append(meta);
  }
  el.append(avatar, body);
  return el;
}

/* ---------- 拉取与已读 ---------- */
async function markRead() {
  if (!current || document.hidden || !document.hasFocus() || !msgs.length) return;
  const area = $('messages');
  if (area.scrollHeight - area.scrollTop - area.clientHeight > 80) return;
  const last = msgs[msgs.length - 1].id;
  if (last <= lastRead) return;
  const selected = key(current);
  await api(prefix() + '/read', 'POST', { last_id: last });
  if (current && key(current) === selected) lastRead = last;
}
async function refresh(reset = false) {
  if (!current) return;
  if (fetching) { again = true; return; }
  fetching = true;
  const selected = key(current);
  try {
    const last = msgs.length ? msgs[msgs.length - 1].id : null;
    const j = await api('/' + selected + (last && !reset ? '?after=' + last : ''));
    if (!current || key(current) !== selected) return;
    for (const m of j.messages) {
      if (!msgsById.has(m.id)) {
        msgsById.set(m.id, m);
        msgs.push(m);
      }
      // 乐观消息落库后移除对应 pending
      const idx = pendingMsgs.findIndex(p => p.client_id === m.client_id);
      if (idx >= 0) pendingMsgs.splice(idx, 1);
    }
    msgs.sort((a, b) => a.id - b.id);
    if (j.other_last_read !== undefined) otherLastRead = Number(j.other_last_read) || otherLastRead;
    if (reset || !msgs.length) hasMoreOlder = !!j.more;
    renderPeer(j.peer);
    showExchange(j.exchange);
    renderAll();
    maybeIcebreakers();
    await markRead();
  } catch (e) {
    if ([403, 404, 409].includes(e.status)) disable(e.message);
    else $('notice').textContent = e.message;
  } finally {
    fetching = false;
    if (again) { again = false; queueMicrotask(() => refresh()); }
  }
}

/* ---------- 查看更早消息 ---------- */
$('older').onclick = async () => {
  if (!current || !msgs.length) return;
  const selected = key(current), area = $('messages');
  const height = area.scrollHeight;
  try {
    const j = await api(prefix() + '?before=' + msgs[0].id);
    if (!current || key(current) !== selected) return;
    for (const m of j.messages) {
      if (!msgsById.has(m.id)) { msgsById.set(m.id, m); msgs.push(m); }
    }
    msgs.sort((a, b) => a.id - b.id);
    hasMoreOlder = !!j.more;
    renderAll();
    area.scrollTop += area.scrollHeight - height; // 保持视口位置
  } catch (e) { $('notice').textContent = e.message; }
};

async function recall(id) {
  if (!current) return;
  try {
    const j = await api(prefix() + '/messages/' + id + '/recall', 'POST', {});
    const m = msgsById.get(id);
    if (m) { m.recalled = true; m.body = ''; m.image = null; }
    renderAll();
    toast(j.msg || '已撤回');
  } catch (e) { toast(e.message); }
}

/* ---------- 图片消息 ---------- */
const MAX_IMAGE = 5 * 1024 * 1024;
$('pickImage').onclick = () => { if (current) $('imageFile').click(); };
$('imageFile').onchange = () => {
  const f = $('imageFile').files[0];
  $('imageFile').value = '';
  if (f) uploadImage(f);
};
async function uploadImage(file) {
  if (!current) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast('只支持 JPEG / PNG / WebP 图片'); return; }
  if (file.size > MAX_IMAGE) { toast('图片过大（上限 5MB）'); return; }
  const selected = key(current);
  $('notice').textContent = '正在上传图片…';
  try {
    const r = await fetch('/api/account/uploads?scope=chat&mode=' + encodeURIComponent(current.mode)
      + '&pair_id=' + current.pair_id, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': file.type },
      body: file
    });
    const j = await r.json();
    if (!r.ok || j.code !== 200) throw Error(j.msg || '图片上传失败');
    $('notice').textContent = '';
    const note = $('message').value.trim();
    if (note) { $('message').value = ''; autoGrow(); updateCounter(); }
    if (!current || key(current) !== selected) return;
    await sendImage(j.id, note);
  } catch (e) { $('notice').textContent = e.message; }
}
async function sendImage(imageId, body) {
  if (!current) return;
  const selected = key(current);
  $('notice').textContent = '';
  try {
    const j = await api(prefix() + '/messages', 'POST', { body, client_id: crypto.randomUUID(), image_id: imageId });
    if (!current || key(current) !== selected) return;
    if (!msgsById.has(j.id)) {
      const m = { id: j.id, body: body || '', image: '/api/account/uploads/' + imageId, mine: true, created_at: new Date().toISOString() };
      msgsById.set(j.id, m); msgs.push(m); msgs.sort((a, b) => a.id - b.id);
    }
    renderAll();
    $('messages').scrollTop = $('messages').scrollHeight;
    await markRead();
  } catch (e) { $('notice').textContent = e.message; }
}

/* ---------- 乐观发送 ---------- */
function autoGrow() {
  const t = $('message');
  t.style.height = 'auto';
  t.style.height = Math.min(160, Math.max(44, t.scrollHeight)) + 'px';
}
function updateCounter() {
  const n = $('message').value.length;
  const el = $('charCount');
  el.hidden = n < MAX_LEN - 200;
  el.textContent = n + ' / ' + MAX_LEN;
}
async function send() {
  const body = $('message').value.trim();
  if (!body || !current) return;
  const client_id = crypto.randomUUID();
  pendingMsgs.push({ client_id, body, created_at: new Date().toISOString() });
  $('icebreakers').hidden = true;   // 已经开口了，破冰话题退场
  renderAll();
  $('messages').scrollTop = $('messages').scrollHeight;
  if ($('message').value.trim() === body) $('message').value = '';
  autoGrow(); updateCounter();
  await deliver(client_id, body);
}
async function deliver(client_id, body) {
  const selected = key(current);
  try {
    const j = await api(prefix() + '/messages', 'POST', { body, client_id });
    if (!current || key(current) !== selected) return;
    const idx = pendingMsgs.findIndex(p => p.client_id === client_id);
    if (idx >= 0) pendingMsgs.splice(idx, 1);
    if (!msgsById.has(j.id)) {
      const m = { id: j.id, body, mine: true, created_at: new Date().toISOString(), client_id };
      msgsById.set(j.id, m); msgs.push(m); msgs.sort((a, b) => a.id - b.id);
    }
    $('notice').textContent = '';
    renderAll();
    $('messages').scrollTop = $('messages').scrollHeight;
    await markRead();
  } catch (e) {
    const p = pendingMsgs.find(x => x.client_id === client_id);
    if (p) { p.failed = true; renderAll(); }
    $('notice').textContent = e.message + '；内容已保留，可点「重试」。';
  }
}
async function retryPending(client_id) {
  const p = pendingMsgs.find(x => x.client_id === client_id);
  if (!p || !current) return;
  p.failed = false;
  renderAll();
  await deliver(client_id, p.body);
}

/* ---------- 输入交互 ---------- */
$('composer').onsubmit = e => { e.preventDefault(); send(); };
$('message').addEventListener('input', () => { autoGrow(); updateCounter(); pingTyping(); });
$('message').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (isMobile()) return; // 移动端：Enter 换行，发送交给按钮
  e.preventDefault();
  $('composer').requestSubmit();
});

/* ---------- 交换联系方式 ---------- */
function showExchange(s) {
  exchangeState = s;
  const box = $('exchangeStatus');
  box.replaceChildren();
  box.hidden = false;
  box.textContent = s.exchanged ? '双方已同意交换，对方' + (s.channel || '微信') + '：' + (s.value || '')
    : s.requested ? '你已申请交换联系方式，等待对方同意。'
    : s.incoming ? '对方申请交换联系方式，你可以自愿选择是否接受。'
    : '可以先聊一聊，双方愿意后再交换联系方式。';
  $('exchange').hidden = !!s.exchanged;
  $('exchange').textContent = s.incoming ? '同意并填写联系方式' : s.requested ? '修改申请' : '申请交换联系方式';
  if (s.requested && !s.exchanged) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '撤回申请';
    b.onclick = async () => {
      try { await api(prefix() + '/exchange', 'DELETE'); await refresh(); toast('申请已撤回'); }
      catch (e) { toast(e.message); }
    };
    box.append(b);
  }
}
$('exchange').onclick = () => {
  $('exchangeChannel').value = exchangeState?.mine_channel || '微信';
  $('wechat').value = ''; $('consent').checked = false;
  syncExchangeField();
  $('exchangeDialog').showModal();
};
function syncExchangeField() {
  const ch = $('exchangeChannel').value;
  $('wechatLabel').textContent = ch === '微信' ? '你的微信号' : '你的' + ch;
  $('wechatHint').hidden = ch !== '微信';
  $('wechat').placeholder = ch === '微信' ? '6–32 位字母数字' : '可填 1–100 字，例如账号或邮箱';
}
$('exchangeChannel').onchange = syncExchangeField;
$('cancelExchange').onclick = () => $('exchangeDialog').close();
$('exchangeForm').onsubmit = async e => {
  e.preventDefault();
  if (!current) return;
  const button = $('confirmExchange');
  const channel = $('exchangeChannel').value, value = $('wechat').value.trim();
  if (!value) { toast('请填写' + (channel === '微信' ? '微信号' : channel)); return; }
  if (channel === '微信' && !/^[A-Za-z0-9][A-Za-z0-9_-]{5,31}$/.test(value)) { toast('请填写 6–32 位有效微信号'); return; }
  button.disabled = true;
  try {
    const j = await api(prefix() + '/exchange', 'POST',
      { channel, value, consent: $('consent').checked });
    $('exchangeDialog').close();
    await refresh();
    toast(j.msg || '已提交');
  } catch (err) { toast(err.message); }
  finally { button.disabled = false; }
};

/* ---------- 举报（页内 dialog） ---------- */
function openReport(messageId) {
  reportTarget = messageId;
  $('reportReason').value = '';
  $('reportDialog').showModal();
}
$('cancelReport').onclick = $('dismissReport').onclick = () => $('reportDialog').close();
$('reportForm').onsubmit = async e => {
  e.preventDefault();
  if (!current || !reportTarget) return;
  const button = $('confirmReport');
  button.disabled = true;
  try {
    const j = await api(prefix() + '/report', 'POST',
      { message_id: reportTarget, reason: $('reportReason').value.trim() });
    $('reportDialog').close();
    toast(j.msg || '举报已提交');
  } catch (err) { toast(err.message); }
  finally { button.disabled = false; }
};

/* ---------- 屏蔽 / 结束（页内确认 dialog） ---------- */
function askConfirm(title, text, action) {
  confirmAction = action;
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmDialog').showModal();
}
$('cancelConfirm').onclick = $('dismissConfirm').onclick = () => { confirmAction = null; $('confirmDialog').close(); };
$('confirmForm').onsubmit = async e => {
  e.preventDefault();
  const action = confirmAction;
  confirmAction = null;
  $('confirmDialog').close();
  if (!action || !current) return;
  if (action === 'hide') {
    try {
      const j = await api(prefix(), 'DELETE');
      await loadRooms();
      setView('list');
      toast(j.msg || '已隐藏');
    } catch (err) { toast(err.message); }
    return;
  }
  try {
    const r = await fetch('/api/account/' + BASES[current.mode] + '/pairs/' + current.pair_id + '/' + action, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{}'
    });
    const j = await r.json();
    if (!r.ok || j.code !== 200) throw Error(j.msg);
    disable(j.msg);
    await loadRooms();
    toast(j.msg);
  } catch (err) { toast(err.message); }
};
$('hideRoom').onclick = () => askConfirm('隐藏会话',
  '仅从你的列表中移除；对方发来新消息后会重新出现。确认隐藏吗？', 'hide');
$('closeRoom').onclick = () => askConfirm('结束会话',
  '结束后不能继续发送或查看此会话，确认结束吗？', 'close');
$('block').onclick = () => askConfirm('屏蔽对方',
  '屏蔽后停止聊天和资料访问，确认屏蔽吗？', 'block');

/* ---------- 实时连接（WS + 指数退避）与轮询兜底 ---------- */
function schedule() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!document.hidden) {
      loadRooms().catch(e => toast(e.message));
      refresh();
    }
  }, 200);
}
function setOffline(off) {
  // 只有「连上过再断」才亮黄条；部分入口不支持 WS 升级，靠轮询兜底，不打扰用户
  $('offlineBar').hidden = !(off && everConnected);
  $('connection').textContent = off ? '连接恢复中，消息自动补收' : '实时连接已开启';
  if (off && everConnected) wasOffline = true;
}
function connect() {
  if (userClosed) return;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://')
    + location.host + '/api/chat/socket');
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
  ws.onmessage = e => {
    try {
      const j = JSON.parse(e.data);
      if (j.type === 'ready') {
        wsRetry = 0; everConnected = true; setOffline(false);
        if (wasOffline) { wasOffline = false; toast('已恢复实时连接'); }
        // 断线重连后服务器不知道我在哪个房间，重报一次在线
        if (joinedKey) { peerOnline = null; wsSend({ type: 'presence', ...roomKeyArgs(joinedKey), online: true }); paintPresence(); }
        schedule();
      }
      if (j.type === 'refresh') schedule();
      if (j.type === 'presence-self' && joinedKey && j.key === joinedKey) {
        peerOnline = !!j.peer_online; paintPresence();     // 对方早就开着会话时，这次快照才看得到
      }
      if (j.type === 'presence' && joinedKey && j.key === joinedKey) {
        peerOnline = !!j.online;
        if (!j.online) peerTypingUntil = 0;
        paintPresence();
      }
      if (j.type === 'typing' && joinedKey && j.key === joinedKey) peerTyping();
    } catch { /* 忽略非 JSON 帧 */ }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (userClosed) return;
    setOffline(true);
    setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(wsRetry++, 5)) + Math.random() * 500);
  };
}

/* ---------- 生命周期 ---------- */
function roomsFailed(msg) {
  const box = $('rooms');
  if (!box || box.querySelector('.room-entry, .room-empty')) return;
  const p = document.createElement('p');
  p.className = 'room-empty';
  p.textContent = msg;
  box.append(p);
}
$('backToList').onclick = () => { setView('list'); leaveRoom(); };
setInterval(() => {
  if (!document.hidden) {
    loadRooms().catch(() => {});
    refresh();
  }
}, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
window.addEventListener('focus', () => { markRead().catch(() => {}); schedule(); });
$('messages').addEventListener('scroll', () => markRead().catch(() => {}));
window.addEventListener('pagehide', () => { userClosed = true; ws?.close(); });

setView('list');
loadRooms().catch(e => { $('notice').textContent = e.message; toast(e.message); roomsFailed('会话列表读取失败，请稍后重试。'); });
connect();
})();
