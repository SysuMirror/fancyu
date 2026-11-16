/* match-graph.js — 管理后台「匹配拓扑图」：
   ① 单批候选拓扑（候选边 + 计划内配对高亮 + 手工指定）② 全站关系网叠加视图。
   全部手绘 SVG（本仓库无图形库）：确定性聚类播种 + 网格近似斥力的力导向布局，
   大图自动裁剪（每点 top-K / 阈值 / 邻域 k 跳 / 只看孤立点），支持缩放平移与 PNG/JSON 导出。 */
(() => {
  'use strict';
  const token = localStorage.getItem('adminToken');
  if (!token) { location.replace('/admin'); return; }

  const $ = id => document.getElementById(id);
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 线路 → 管理接口前缀（love 的批次接口叫 weekly-batches）
  const LINES = {
    love: { name: '每周恋爱', api: 'weekly-batches' },
    deep: { name: '深度交友', api: 'deep-batches' },
    buddy: { name: '约个搭子', api: 'buddy-batches' },
    history: { name: '历史导入', api: null }
  };
  const COLOR = { love: '#d9534f', deep: '#3b6ea5', buddy: '#2f9e6f', history: '#8a7fd0' };

  const st = {
    mode: 'batch', line: 'love', key: '', batches: [],
    oline: 'all', days: 60,
    nodes: [], edges: [], plan: [], status: '', revision: 0, canPin: false, stats: null, dropped: [],
    view: { nodes: [], edges: [] }, pos: new Map(),
    zoom: { k: 1, x: 0, y: 0 },
    selA: null, selB: null, focus: null, timer: null, running: false
  };

  function message(s) { const t = $('toast'); t.textContent = s; t.hidden = false; clearTimeout(message.t); message.t = setTimeout(() => { t.hidden = true; }, 6000); }

  async function api(path, method, body) {
    const r = await fetch(path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body !== undefined && body !== null ? { body: JSON.stringify(body) } : {})
    });
    if (r.status === 401) { localStorage.removeItem('adminToken'); location.replace('/admin'); throw Error('请重新登录'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.code !== 200) throw Error(j.msg || '请求失败');
    return j;
  }
  const batchAPI = () => '/api/admin/' + LINES[st.line].api;
  // 分数归一化：love 的候选边是 scoreInt(0..10000)，deep/buddy 是 score(0..100)——统一到 0..100
  // 才能让「最低分」滑杆与 top-K 排序在三条线上口径一致。
  function pct(e) {
    const v = Number(e && e.score != null ? e.score : e);
    if (!isFinite(v)) return 0;
    return Math.max(0, Math.min(100, v > 100 ? v / 100 : v));
  }

  /* ---------- 取数 ---------- */
  async function loadBatches() {
    const j = await api(batchAPI());
    st.batches = (j.batches || []).slice(0, 30);
    const sel = $('batch');
    sel.innerHTML = st.batches.map(b => '<option value="' + esc(b.batch_key) + '">' + esc(b.batch_key) + ' · ' + esc(b.status) + ' · r' + (b.revision || 0) + '</option>').join('');
    if (!st.batches.some(b => b.batch_key === st.key)) st.key = st.batches.length ? st.batches[0].batch_key : '';
    sel.value = st.key;
    $('graphMeta').textContent = st.batches.length ? '' : '该线路还没有批次。';
  }
  async function loadGraph() {
    if (st.mode === 'overlay') {
      const j = await api('/api/admin/match-graph/overlay?line=' + encodeURIComponent(st.oline) + '&days=' + st.days);
      st.nodes = j.nodes || []; st.edges = j.edges || []; st.plan = []; st.status = ''; st.canPin = false;
      st.revision = 0; st.stats = null; st.dropped = [];
      st.truncated = j.truncated;
      $('graphMeta').textContent = '全站关系网：' + (j.edges || []).length + ' 条边 / ' + (j.nodes || []).length + ' 个点' +
        (j.truncated && j.truncated.edges ? '（已截断，省略 ' + j.truncated.omitted + ' 条）' : '');
      return;
    }
    if (!st.key) { st.nodes = []; st.edges = []; st.plan = []; $('graphMeta').textContent = '请选择批次。'; return; }
    const j = await api(batchAPI() + '/' + encodeURIComponent(st.key) + '/graph');
    st.nodes = j.nodes || []; st.edges = j.edges || []; st.plan = j.plan || [];
    st.status = j.status || ''; st.revision = j.revision || 0; st.canPin = !!j.canPin;
    st.stats = j.stats || null; st.dropped = j.manual_dropped || []; st.truncated = j.truncated;
    $('graphMeta').textContent = st.key + ' · ' + st.status + ' · rev ' + st.revision + ' · ' +
      st.nodes.length + ' 点 / ' + st.edges.length + ' 边 / 计划 ' + st.plan.length + ' 对' +
      (j.truncated && j.truncated.omitted ? '（已裁剪 ' + j.truncated.omitted + ' 条边）' : '');
  }

  /* ---------- 视图过滤（大图自动裁剪） ---------- */
  function computeView() {
    const thr = Number($('thr').value) || 0, topk = Number($('topk').value) || 0;
    const q = ($('q').value || '').trim().toLowerCase();
    const orphan = $('orphan').checked, hop = Number($('hop').value) || 0;
    const byId = new Map(st.nodes.map(n => [n.id, n]));
    let edges = st.edges.filter(e => pct(e) >= thr);
    if (q) { const hit = new Set(st.nodes.filter(n => String(n.username || '').toLowerCase().includes(q)).map(n => n.id)); edges = edges.filter(e => hit.has(e.a) && hit.has(e.b)); }
    if (topk > 0) {
      const bucket = new Map();
      for (const e of edges) { for (const id of [e.a, e.b]) { if (!bucket.has(id)) bucket.set(id, []); bucket.get(id).push(e); } }
      const keep = new Set();
      for (const [, list] of bucket) { list.sort((x, y) => pct(y) - pct(x)); for (const e of list.slice(0, topk)) keep.add(e.a + ':' + e.b); }
      edges = edges.filter(e => keep.has(e.a + ':' + e.b));
    }
    if (orphan) {
      const deg = new Set(); for (const e of edges) { deg.add(e.a); deg.add(e.b); }
      const stay = new Set(st.nodes.filter(n => n.matched || !deg.has(n.id)).map(n => n.id));
      edges = edges.filter(e => stay.has(e.a) && stay.has(e.b));
      return { nodes: st.nodes.filter(n => stay.has(n.id)), edges };
    }
    if (hop > 0 && st.selA != null && byId.has(st.selA)) {
      const keep = new Set([st.selA]); let frontier = [st.selA];
      for (let k = 0; k < hop; k++) {
        const next = [];
        for (const e of edges) { if (frontier.includes(e.a) && !keep.has(e.b)) { keep.add(e.b); next.push(e.b); } if (frontier.includes(e.b) && !keep.has(e.a)) { keep.add(e.a); next.push(e.a); } }
        frontier = next;
      }
      return { nodes: st.nodes.filter(n => keep.has(n.id)), edges: edges.filter(e => keep.has(e.a) && keep.has(e.b)) };
    }
    const used = new Set(); for (const e of edges) { used.add(e.a); used.add(e.b); }
    return { nodes: st.nodes.filter(n => used.has(n.id) || !edges.length), edges };
  }

  /* ---------- 布局：确定性聚类播种 + 网格近似斥力 ---------- */
  function layout(view, W, H) {
    const idx = new Map(view.nodes.map((n, i) => [n.id, i])), P = [];
    const groups = new Map();
    view.nodes.forEach(n => { const k = n.campus || n.college || '未分组'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); });
    const keys = [...groups.keys()], R = Math.min(W, H) * 0.33;
    keys.forEach((k, ci) => {
      const ang = keys.length ? ci / keys.length * Math.PI * 2 : 0;
      const cx = W / 2 + Math.cos(ang) * R * 0.8, cy = H / 2 + Math.sin(ang) * R * 0.8;
      const arr = groups.get(k);
      arr.forEach((n, i) => {
        const t = (i + 1) / (arr.length + 1) * Math.PI * 2, rr = 16 + arr.length * 1.2;
        P[idx.get(n.id)] = { x: cx + Math.cos(t) * rr, y: cy + Math.sin(t) * rr };
      });
    });
    const E = view.edges.map(e => ({ i: idx.get(e.a), j: idx.get(e.b), score: pct(e) })).filter(e => e.i != null && e.j != null);
    const cell = 60;
    for (let it = 0; it < 250; it++) {
      const alpha = 1 - it / 250, f = P.map(() => ({ x: 0, y: 0 })), grid = new Map();
      P.forEach((p, i) => { const k = (p.x / cell | 0) + ':' + (p.y / cell | 0); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
      P.forEach((p, i) => {
        const gx = p.x / cell | 0, gy = p.y / cell | 0;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const arr = grid.get((gx + dx) + ':' + (gy + dy)); if (!arr) continue;
          for (const j of arr) {
            if (j === i) continue;
            const ddx = p.x - P[j].x, ddy = p.y - P[j].y, d2 = ddx * ddx + ddy * ddy || 0.01, d = Math.sqrt(d2);
            const f0 = Math.min(1500 / d2, 9); f[i].x += ddx / d * f0; f[i].y += ddy / d * f0;
          }
        }
      });
      for (const e of E) {
        const p = P[e.i], q = P[e.j], dx = q.x - p.x, dy = q.y - p.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f0 = (d - (95 - e.score * 0.6)) * 0.02;
        f[e.i].x += dx / d * f0; f[e.i].y += dy / d * f0; f[e.j].x -= dx / d * f0; f[e.j].y -= dy / d * f0;
      }
      let moved = 0;
      P.forEach((p, i) => {
        f[i].x += (W / 2 - p.x) * 0.005; f[i].y += (H / 2 - p.y) * 0.005;
        p.x = Math.max(18, Math.min(W - 18, p.x + f[i].x * alpha)); p.y = Math.max(18, Math.min(H - 18, p.y + f[i].y * alpha));
        moved += Math.abs(f[i].x) + Math.abs(f[i].y);
      });
      if (moved < 0.5) break;
    }
    st.pos = new Map(view.nodes.map((n, i) => [n.id, P[i]]));
  }

  /* ---------- 绘制 ---------- */
  function size() { const box = $('canvas').getBoundingClientRect(); return { W: Math.max(320, box.width | 0), H: Math.max(280, box.height | 0) }; }
  const onEdge = id => st.plan.some(p => p.a_id === id || p.b_id === id);
  function manualSet() { const s = new Set(); for (const p of st.plan) if (p.manual) { s.add(p.a_id + ':' + p.b_id); s.add(p.b_id + ':' + p.a_id); } return s; }

  function render(recompute = true) {
    const { W, H } = size();
    const view = computeView(); st.view = view;
    if (recompute) layout(view, W, H);
    const byId = new Map(view.nodes.map(n => [n.id, n]));
    const planSet = new Set(st.plan.flatMap(p => [p.a_id + ':' + p.b_id, p.b_id + ':' + p.a_id]));
    const manSet = manualSet();
    const z = st.zoom;
    let eh = '', nh = '';
    for (const e of view.edges) {
      const a = st.pos.get(e.a), b = st.pos.get(e.b); if (!a || !b) continue;
      const isPlan = planSet.has(e.a + ':' + e.b), isMan = manSet.has(e.a + ':' + e.b);
      const color = isMan ? '#f0a020' : isPlan ? '#e0663a' : (COLOR[e.line] || '#9aa4b2');
      const w = isMan ? 2.6 : isPlan ? 2.2 : (0.8 + pct(e) / 100 * 2.2);   // 分数越高越粗（0.8–3.0）
      eh += '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) +
        '" stroke="' + color + '" stroke-width="' + w + '"' + (isMan ? ' stroke-dasharray="5 3"' : '') + ' stroke-opacity="' + (isPlan || isMan ? 1 : .45) + '"/>';
    }
    for (const n of view.nodes) {
      const p = st.pos.get(n.id); if (!p) continue;
      const sel = (n.id === st.selA || n.id === st.selB), hit = !!n._hit;
      const r = sel ? 8 : hit ? 7 : 5, color = (COLOR[st.line] || '#5b6b7f');
      nh += '<g class="mg-node" data-id="' + n.id + '" transform="translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')">' +
        '<circle r="' + (r + 6) + '" fill="transparent"/>' +
        '<circle r="' + r + '" fill="' + (n.matched ? color : '#ffffff') + '" stroke="' + color + '" stroke-width="' + (sel ? 3 : 2) + '"/>' +
        (sel || hit || z.k > 1.6 ? '<text y="-12" text-anchor="middle">' + esc(n.username) + '</text>' : '') +
        '</g>';
    }
    $('graph').setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    $('graph').innerHTML = '<g id="world" transform="translate(' + z.x + ',' + z.y + ') scale(' + z.k + ')"><g id="gedges">' + eh + '</g><g id="gnodes">' + nh + '</g></g>';
    const tot = st.nodes.length, te = st.edges.length;
    $('clip').textContent = '显示 ' + view.nodes.length + '/' + tot + ' 点、' + view.edges.length + '/' + te + ' 边' +
      (st.truncated && st.truncated.omitted ? '（服务端已裁剪 ' + st.truncated.omitted + ' 条）' : '');
    if (st.dropped && st.dropped.length) $('clip').textContent += ' · 手工指定被丢弃 ' + st.dropped.length + ' 条';
    $('gnodes').addEventListener('click', e => {
      const g = e.target.closest('g.mg-node'); if (!g) return; select(Number(g.dataset.id));
    });
    drawSide();
  }
  function drawSide() {
    const pins = st.plan.filter(p => p.manual);
    $('pinN').textContent = String(pins.length);
    $('pins').innerHTML = pins.length ? pins.map(p =>
      '<div class="mg-pin"><b>' + esc(name(p.a_id)) + '</b> ↔ <b>' + esc(name(p.b_id)) + '</b>' +
      (p.by ? '<span class="muted small">by ' + esc(p.by) + '</span>' : '') +
      '<button type="button" class="mg-mini" data-pin="' + p.a_id + ':' + p.b_id + '">撤销</button></div>').join('')
      : '<p class="muted small">还没有手工指定。选中两个点后点「指定配对」。</p>';
    $('pins').querySelectorAll('[data-pin]').forEach(b => b.addEventListener('click', () => unpin(b.dataset.pin)));
    const det = $('detail');
    if (st.selA == null) { det.innerHTML = '<p class="muted small">点一个点看详情；再点第二个点即可指定配对。</p>'; }
    else {
      const n = st.nodes.find(x => x.id === st.selA) || {};
      const deg = st.edges.filter(e => e.a === n.id || e.b === n.id).length;
      const mate = st.plan.filter(p => p.a_id === n.id || p.b_id === n.id).map(p => (p.a_id === n.id ? p.b_id : p.a_id));
      const btw = st.selB != null ? st.edges.find(e => (e.a === n.id && e.b === st.selB) || (e.b === n.id && e.a === st.selB)) : null;
      const neigh = st.mode === 'overlay'
        ? [...new Set(st.edges.filter(e => e.a === n.id || e.b === n.id).map(e => (e.a === n.id ? e.b : e.a)))].slice(0, 8).map(name) : [];
      det.innerHTML = '<div class="mg-id"><span class="mg-dot" style="background:' + (n.matched ? (COLOR[st.line] || '#5b6b7f') : '#fff') + ';border-color:' + (COLOR[st.line] || '#5b6b7f') + '"></span>' +
        '<b>' + esc(n.username || ('#' + n.id)) + '</b></div>' +
        '<div class="muted small">账号 ' + n.id + (n.campus ? ' · ' + esc(n.campus) : '') + (n.college ? ' · ' + esc(n.college) : '') + '</div>' +
        '<div class="muted small">候选度数 ' + deg + ' · ' + (mate.length ? '计划搭档 ' + mate.map(esc).join('、') : '本批未匹配') + '</div>' +
        (btw ? '<div class="muted small">与 B 的合分 ' + Math.round(pct(btw)) + ' / 100</div>' : '') +
        (neigh.length ? '<div class="muted small">配过：' + neigh.map(esc).join('、') + '</div>' : '') +
        '<div class="mg-sel"><button type="button" class="mg-mini" id="setA">设为 A</button><button type="button" class="mg-mini" id="setB">设为 B</button></div>';
      const a = $('setA'), bb = $('setB');
      if (a) a.addEventListener('click', () => { st.selA = n.id; st.selB = st.selB === n.id ? null : st.selB; render(false); });
      if (bb) bb.addEventListener('click', () => { st.selB = n.id; if (st.selA === n.id) st.selA = null; pinBox(); render(false); });
    }
    pinBox();
  }
  function name(id) { const n = st.nodes.find(x => x.id === id); return n ? n.username : ('#' + id); }
  function pinBox() {
    const box = $('pairBox');
    if (st.mode !== 'batch' || st.selA == null || st.selB == null) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<h3>指定配对</h3><p class="muted small">' + esc(name(st.selA)) + ' ↔ ' + esc(name(st.selB)) + '</p>' +
      '<p class="muted small">当前 ' + esc(st.key) + ' 处于 ' + esc(st.status || '—') + (st.canPin ? '：可指定。' : '：只有预览中的批次能修改计划。') + '</p>' +
      '<button type="button" id="doPin"' + (st.canPin ? '' : ' disabled') + '>指定配对</button> ' +
      '<button type="button" class="mg-mini" id="doUnpin">撤销这对</button>';
    const p = $('doPin'); if (p) p.addEventListener('click', doPin);
    const u = $('doUnpin'); if (u) u.addEventListener('click', doUnpin);
  }
  function select(id) { if (st.selA == null) st.selA = id; else if (st.selB == null && id !== st.selA) st.selB = id; else { st.selA = id; st.selB = null; } render(false); }

  /* ---------- 写操作 ---------- */
  async function doPin() {
    if (!st.canPin) { message('只有预览中的批次才能指定配对'); return; }
    const removed = st.plan.filter(p => !p.manual && (p.a_id === st.selA || p.b_id === st.selA || p.a_id === st.selB || p.b_id === st.selB));
    const body = removed.length ? ('将从原搭档上移除：' + removed.map(p => name(p.a_id) + ' ↔ ' + name(p.b_id)).join('；') + '。确定？') : '确定指定这两人配对？';
    if (window.uiConfirm) { if (!await uiConfirm({ title: '指定配对', body, okText: '指定' })) return; } else if (!confirm(body)) return;
    try {
      const j = await api(batchAPI() + '/' + encodeURIComponent(st.key) + '/manual-pair', 'POST', { a_id: st.selA, b_id: st.selB });
      message(j.msg || '已指定'); st.selB = null;
      await loadGraph(); render();
    } catch (e) { message(e.message); }
  }
  async function unpin(pair) {
    const [a_id, b_id] = pair.split(':').map(Number);
    if (window.uiConfirm) { if (!await uiConfirm({ title: '撤销指定配对', body: '撤销后需重新确认预览。确定？', okText: '撤销', danger: true })) return; } else if (!confirm('撤销这条指定配对？')) return;
    try { const j = await api(batchAPI() + '/' + encodeURIComponent(st.key) + '/manual-pair/remove', 'POST', { a_id, b_id }); message(j.msg || '已撤销'); await loadGraph(); render(); }
    catch (e) { message(e.message); }
  }
  async function doUnpin() { if (st.selA == null || st.selB == null) return; unpin(st.selA + ':' + st.selB); }

  /* ---------- 导出 ---------- */
  function download(blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function currentPayload() {
    const byId = new Map(st.nodes.map(n => [n.id, n]));
    return {
      mode: st.mode, line: st.mode === 'overlay' ? st.oline : st.line, key: st.mode === 'overlay' ? null : st.key,
      status: st.status, revision: st.revision,
      view: { nodes: st.view.nodes.length, edges: st.view.edges.length },
      nodes: st.view.nodes.map(n => ({ id: n.id, username: n.username, campus: n.campus || null, matched: !!n.matched })),
      edges: st.view.edges.map(e => ({ a: e.a, b: e.b, line: e.line || st.line, score: e.score == null ? null : e.score, scorePct: e.score == null ? null : Math.round(pct(e)) })),
      plan: st.plan.map(p => ({ a_id: p.a_id, b_id: p.b_id, manual: !!p.manual }))
    };
  }
  function exportJSON() { download(new Blob([JSON.stringify(currentPayload(), null, 2)], { type: 'application/json' }), 'match-graph-' + (st.key || st.oline) + '.json'); message('已导出 JSON'); }
  function exportPNG() {
    const src = $('graph'), { W, H } = size();
    const clone = src.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', W); clone.setAttribute('height', H);
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = 'text{font:11px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;fill:#333}line{stroke-linecap:round}';
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', W); bg.setAttribute('height', H); bg.setAttribute('fill', '#ffffff');
    clone.insertBefore(bg, clone.firstChild); clone.insertBefore(style, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = W * 2; cv.height = H * 2;
      const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.setTransform(2, 0, 0, 2, 0, 0); ctx.drawImage(img, 0, 0);
      cv.toBlob(b => { if (b) { download(b, 'match-graph-' + (st.key || st.oline) + '.png'); message('已导出 PNG'); } else message('导出 PNG 失败'); }, 'image/png');
    };
    img.onerror = () => message('导出 PNG 失败');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  }

  /* ---------- 交互 ---------- */
  function applyZoom() { const w = $('world'); if (w) w.setAttribute('transform', 'translate(' + st.zoom.x + ',' + st.zoom.y + ') scale(' + st.zoom.k + ')'); }
  function bind() {
    document.querySelectorAll('.mg-mode').forEach(b => b.addEventListener('click', async () => {
      st.mode = b.dataset.mode;
      document.querySelectorAll('.mg-mode').forEach(x => x.classList.toggle('on', x === b));
      $('batchCtl').hidden = st.mode !== 'batch'; $('overlayCtl').hidden = st.mode !== 'overlay';
      try { if (st.mode === 'batch') { await loadBatches(); await loadGraph(); } else await loadGraph(); render(); }
      catch (e) { message(e.message); }
    }));
    $('line').addEventListener('change', async () => { st.line = $('line').value; st.selA = st.selB = null; try { await loadBatches(); await loadGraph(); render(); } catch (e) { message(e.message); } });
    $('batch').addEventListener('change', async () => { st.key = $('batch').value; st.selA = st.selB = null; try { await loadGraph(); render(); } catch (e) { message(e.message); } });
    $('oline').addEventListener('change', async () => { st.oline = $('oline').value; try { await loadGraph(); render(); } catch (e) { message(e.message); } });
    $('days').addEventListener('change', async () => { st.days = Number($('days').value) || 60; try { await loadGraph(); render(); } catch (e) { message(e.message); } });
    document.querySelectorAll('#thr,#topk').forEach(el => el.addEventListener('input', () => {
      $('thrV').textContent = $('thr').value; $('topkV').textContent = $('topk').value;
      clearTimeout(st.timer); st.timer = setTimeout(() => render(), 120);
    }));
    $('q').addEventListener('input', () => { clearTimeout(st.timer); st.timer = setTimeout(() => render(), 200); });
    $('orphan').addEventListener('change', () => render());
    $('hop').addEventListener('change', () => render());
    $('refresh').addEventListener('click', async () => { try { if (st.mode === 'batch') await loadBatches(); await loadGraph(); st.selA = st.selB = null; render(); } catch (e) { message(e.message); } });
    $('exp-json').addEventListener('click', exportJSON);
    $('exp-png').addEventListener('click', exportPNG);
    $('zin').addEventListener('click', () => { st.zoom.k = Math.min(4, st.zoom.k * 1.25); applyZoom(); });
    $('zout').addEventListener('click', () => { st.zoom.k = Math.max(.3, st.zoom.k / 1.25); applyZoom(); });
    $('zreset').addEventListener('click', () => { st.zoom = { k: 1, x: 0, y: 0 }; render(); });
    // 缩放：滚轮 + 双指
    const svg = $('graph');
    svg.addEventListener('wheel', e => { e.preventDefault(); st.zoom.k = Math.max(.3, Math.min(4, st.zoom.k * (e.deltaY < 0 ? 1.12 : 0.89))); applyZoom(); }, { passive: false });
    let drag = null;
    svg.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, ox: st.zoom.x, oy: st.zoom.y }; svg.setPointerCapture(e.pointerId); });
    svg.addEventListener('pointermove', e => { if (!drag) return; const moved = Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y); if (moved < 4) return; st.zoom.x = drag.ox + (e.clientX - drag.x); st.zoom.y = drag.oy + (e.clientY - drag.y); applyZoom(); });
    svg.addEventListener('pointerup', () => { drag = null; });
    svg.addEventListener('pointercancel', () => { drag = null; });
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => render(), 200); });
  }

  (async () => {
    bind();
    try { await loadBatches(); await loadGraph(); render(); }
    catch (e) { $('graphMeta').textContent = ''; message(e.message); }
  })();
})();
