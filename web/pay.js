(() => {
  const itemsEl = document.getElementById('items');
  const paycard = document.getElementById('paycard');
  const entsEl = document.getElementById('ents');
  const ordersEl = document.getElementById('orders');
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yuan = c => '¥' + (Number(c || 0) / 100).toFixed(2);
  const dt = x => x ? new Date(x).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
  const token = () => localStorage.getItem('token');
  let pollTimer = null;

  async function api(path, opts = {}) {
    const r = await fetch('/api' + path, {
      method: opts.body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token() ? { 'Authorization': 'Bearer ' + token() } : {}) },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {})
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { location.href = 'login.html?redirect=pay.html'; throw Error('请先登录'); }
    if (!r.ok || j.code !== 200) throw Error(j.msg || '请求失败');
    return j;
  }

  async function loadItems() {
    try {
      const j = await api('/pay/items');
      itemsEl.innerHTML = j.items.map(it => `
        <div class="item"><div><div class="t">${esc(it.title)}</div>${it.description ? '<div class="d">' + esc(it.description) + '</div>' : ''}</div>
        <div><span class="price">${yuan(it.amount_cents)}</span><button class="primary" data-key="${esc(it.key)}">立即支付</button></div></div>`
      ).join('') || '<p class="muted">暂无可购买的商品。</p>';
    } catch (e) { itemsEl.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
  }

  async function loadEntitlements() {
    try {
      const j = await api('/pay/entitlements');
      entsEl.innerHTML = (j.entitlements || []).map(x =>
        `<span class="badge${x.valid ? '' : ' expired'}">${esc(x.title || x.item_key)}${x.resource_id ? ' · ' + esc(x.resource_id) : ''}${x.expires_at ? ' · 至 ' + esc(dt(x.expires_at).split(' ')[0]) : ' · 永久'}${x.valid ? '' : ' · 已过期'}</span>`).join('') || '<span class="muted">暂无权益。</span>';
    } catch (e) { entsEl.textContent = ''; }
  }

  async function loadOrders() {
    try {
      const j = await api('/pay/orders?limit=20');
      ordersEl.innerHTML = (j.orders || []).map(o => `
        <div class="item"><div><div class="t">${esc(o.subject || o.item_key)}</div>
          <div class="d">${esc(o.out_trade_no)} · ${esc(dt(o.created_at))}</div></div>
        <div><span class="price">${yuan(o.amount_cents)}</span>${o.status === 'paid' ? '<span class="badge">已支付</span>' : '<span class="muted">待支付</span>'}</div></div>`
      ).join('') || '<p class="muted">还没有订单。</p>';
    } catch (e) { ordersEl.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
  }

  async function startPay(itemKey, btn) {
    btn.disabled = true;
    try {
      const j = await api('/pay/create', { body: { item_key: itemKey } });
      const link = j.scheme_url || j.short_url;
      paycard.hidden = false;
      paycard.innerHTML = `<div class="paybox fu-paybox">
        <div class="t">${esc(j.subject)} · <span class="price">${yuan(j.amount_cents)}</span></div>
        <div class="muted">订单号 ${esc(j.out_trade_no)}</div>
        ${link ? `<a href="${esc(link)}">打开微信小程序支付</a>` : '<p class="err">未能生成支付入口</p>'}
        <div class="muted" id="pstatus">等待支付…（在小程序内完成付款后本页自动刷新）</div>
      </div>`;
      poll(j.out_trade_no);
    } catch (e) {
      paycard.hidden = false;
      paycard.innerHTML = '<p class="err">' + esc(e.message) + '</p>';
    } finally { btn.disabled = false; }
  }

  function poll(outTradeNo) {
    clearInterval(pollTimer);
    let n = 0;
    pollTimer = setInterval(async () => {
      n++;
      try {
        const j = await api('/pay/order/' + encodeURIComponent(outTradeNo));
        if (j.order.paid) {
          clearInterval(pollTimer);
          const s = document.getElementById('pstatus');
          if (s) s.outerHTML = '<div class="ok">✓ 支付成功，权益已发放</div>';
          loadEntitlements(); loadOrders();
        }
      } catch (e) { /* 继续轮询 */ }
      if (n > 150) clearInterval(pollTimer); // ~10 分钟
    }, 4000);
  }

  itemsEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-key]'); if (!b) return;
    startPay(b.dataset.key, b);
  });

  loadItems();
  loadEntitlements();
  loadOrders();
})();
