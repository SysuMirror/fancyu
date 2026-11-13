(() => {
  const token = localStorage.getItem('adminToken');
  if (!token) { location.replace('/admin'); return; }
  const app = document.getElementById('app'), ordersEl = document.getElementById('orders'), statsEl = document.getElementById('stats');
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yuan = c => '¥' + (Number(c || 0) / 100).toFixed(2);
  const dt = x => x ? new Date(x).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
  const form = document.getElementById('item-form');
  let busy = false;

  function message(s) { const t = document.getElementById('toast'); t.textContent = s; t.hidden = false; clearTimeout(message.t); message.t = setTimeout(() => t.hidden = true, 6000); }

  async function api(path, body) {
    const r = await fetch('/api/pay/admin' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (r.status === 401) { localStorage.removeItem('adminToken'); location.replace('/admin'); throw Error('请重新登录'); }
    const j = await r.json();
    if (!r.ok || j.code !== 200) throw Error(j.msg || '请求失败');
    return j;
  }

  function renderStats(s) {
    const cell = (label, v) => `<div class="stat"><div class="v">${v}</div><div class="l">${label}</div></div>`;
    const conv = s.total.orders ? Math.round(s.total.paid / s.total.orders * 100) : 0;
    statsEl.innerHTML =
      cell('今日成交额', yuan(s.today.amount_cents)) +
      cell('今日订单', s.today.paid + ' / ' + s.today.orders) +
      cell('累计成交额', yuan(s.total.amount_cents)) +
      cell('累计订单', s.total.paid + ' / ' + s.total.orders) +
      cell('成交率', conv + '%') +
      cell('在售商品', s.active_items);
  }

  async function load() {
    const [items, ords, stats] = await Promise.all([api('/items'), api('/orders?limit=30'), api('/stats')]);
    renderStats(stats);

    app.innerHTML = '<section class="card"><h2>商品与价格</h2>' + (items.items.map(it => `
      <div class="row" data-key="${esc(it.item_key)}">
        <div><b>${esc(it.title)}</b> <small class="muted">${esc(it.item_key)}</small>
          <div class="muted">${yuan(it.amount_cents)} · ${it.is_active ? '上架中' : '已下架'}${it.duration_days ? ' · ' + it.duration_days + '天有效' : ' · 永久'} ${it.description ? '· ' + esc(it.description) : ''}</div></div>
        <div class="actions">
          <button data-act="edit">改价</button>
          ${it.is_active ? '<button data-act="off">下架</button>' : ''}
        </div>
      </div>`).join('') || '<p class="muted">还没有商品。用下方表单新增一个，例如 vip_30d / 会员 30 天 / 9.90。</p>') + '</section>';

    ordersEl.innerHTML = (ords.orders || []).map(o => `
      <div class="row"><div><b>${esc(o.subject || o.item_key)}</b> <small class="muted">${esc(o.out_trade_no)}</small>
        <div class="muted">${yuan(o.amount_cents)} · ${esc(o.username || '-')} · ${o.status === 'paid' ? '已支付 ' + dt(o.paid_at) : '待支付'} · ${dt(o.created_at)}</div></div></div>`
    ).join('') || '<p class="muted">暂无订单。</p>';
  }

  app.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]'); if (!btn || busy) return;
    const key = btn.closest('.row').dataset.key; busy = true; btn.disabled = true;
    try {
      if (btn.dataset.act === 'off') {
        const _ok = window.uiConfirm ? await uiConfirm({ title: '下架商品', body: '下架 ' + key + '？用户将无法再下单。', okText: '下架', danger: true }) : confirm('下架 ' + key + '？用户将无法再下单。');
        if (!_ok) return;
        message((await api('/items/' + encodeURIComponent(key) + '/delete', {})).msg);
        await load();
      } else {
        const j = await api('/items');
        const it = j.items.find(x => x.item_key === key);
        form.item_key.value = it.item_key; form.title.value = it.title;
        form.amount_yuan.value = (it.amount_cents / 100).toFixed(2);
        form.duration_days.value = it.duration_days || '';
        form.description.value = it.description || ''; form.is_active.checked = !!it.is_active;
        window.scrollTo(0, document.body.scrollHeight);
      }
    } catch (err) { message(err.message); } finally { busy = false; btn.disabled = false; }
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const amount_cents = Math.round(parseFloat(form.amount_yuan.value) * 100);
    if (!Number.isInteger(amount_cents) || amount_cents < 1) { message('价格无效'); return; }
    const dd = form.duration_days.value.trim();
    try {
      const j = await api('/items', {
        item_key: form.item_key.value.trim(), title: form.title.value.trim(),
        amount_cents, description: form.description.value.trim(), is_active: form.is_active.checked,
        duration_days: dd === '' ? null : parseInt(dd, 10)
      });
      message(j.msg); await load();
    } catch (err) { message(err.message); }
  });

  document.getElementById('refresh').onclick = () => load().catch(e => message(e.message));
  load().catch(e => app.innerHTML = '<p class="error">' + esc(e.message) + '</p>');
})();
