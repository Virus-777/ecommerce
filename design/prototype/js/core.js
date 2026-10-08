/* ==========================================================================
   Marketly prototype core: screen registry, component helpers, layouts.
   Screens are plain functions returning HTML strings built from these helpers.
   Each helper maps 1:1 to a future React component (see design/README.md).
   ========================================================================== */
window.UI = (function () {
  'use strict';

  /* ---------------- Screen catalogue (canonical order) ---------------- */
  // Every page from the plan. The viewer flags any id here that has no screen yet.
  const AREAS = [
    { id: 'theme', name: 'Theme', icon: 'palette' },
    { id: 'store', name: 'Customer Store', icon: 'shopping-bag' },
    { id: 'seller', name: 'Seller Center', icon: 'store' },
    { id: 'admin', name: 'Admin Center', icon: 'shield' },
    { id: 'ops', name: 'Operations', icon: 'clipboard-list' },
  ];
  const CATALOGUE = {
    theme: [
      ['Design system', ['theme/foundations', 'theme/components', 'theme/patterns']],
    ],
    store: [
      ['Shopping', ['store/home', 'store/categories', 'store/category', 'store/search', 'store/search-empty', 'store/product', 'store/offers', 'store/brand', 'store/seller', 'store/official', 'store/deals', 'store/collection', 'store/not-found']],
      ['Purchase', ['store/cart', 'store/checkout', 'store/checkout-review-changes', 'store/payment-result', 'store/confirmation']],
      ['Sign in', ['auth/sign-in', 'auth/register', 'auth/recover', 'auth/guest-orders']],
      ['My account', ['account/overview', 'account/orders', 'account/order', 'account/tracking', 'account/cancel', 'account/returns', 'account/return-new', 'account/return', 'account/messages', 'account/notifications', 'account/addresses', 'account/profile', 'account/security', 'account/payment-methods', 'account/review', 'account/reviews', 'account/wishlist', 'account/coupons']],
      ['Help and policies', ['help/center', 'help/article', 'help/contact', 'help/order-problem', 'help/cases', 'help/case', 'info/policy', 'info/about']],
      ['Seller entry', ['sell/landing', 'sell/apply', 'sell/status']],
      ['Advertising', ['ads/opening', 'ads/popup', 'ads/formats']],
    ],
    seller: [
      ['Getting started', ['seller/setup']],
      ['Seller Center', ['seller/dashboard', 'seller/products', 'seller/catalog-match', 'seller/product-new', 'seller/offer', 'seller/inventory', 'seller/bulk-update', 'seller/orders', 'seller/order', 'seller/shipping', 'seller/returns', 'seller/return', 'seller/finance', 'seller/statement', 'seller/marketing', 'seller/ad-request', 'seller/customers', 'seller/reports', 'seller/performance', 'seller/store', 'seller/staff', 'seller/notifications', 'seller/help']],
    ],
    admin: [
      ['Overview', ['admin/dashboard', 'admin/inbox']],
      ['Commerce', ['admin/orders', 'admin/order', 'admin/returns']],
      ['Catalog', ['admin/catalog', 'admin/product-review', 'admin/categories', 'admin/reviews']],
      ['Official store', ['admin/official', 'admin/purchasing']],
      ['Sellers', ['admin/sellers', 'admin/seller-application', 'admin/seller']],
      ['Shipping', ['admin/shipping']],
      ['Finance', ['admin/finance', 'admin/payouts']],
      ['Customers and service', ['admin/customers', 'admin/cases', 'admin/case', 'admin/trust']],
      ['Marketing and content', ['admin/promotions', 'admin/promotion-new', 'admin/content', 'admin/help-content']],
      ['Advertisements', ['admin/ads', 'admin/ad-campaign', 'admin/ad-assets', 'admin/ad-placements']],
      ['Reports and settings', ['admin/reports', 'admin/staff', 'admin/settings', 'admin/notifications', 'admin/audit']],
    ],
    ops: [
      ['Work queues', ['ops/queues', 'ops/inventory', 'ops/receiving', 'ops/pick-pack', 'ops/dispatch', 'ops/return-inspection', 'ops/finance-checks']],
    ],
  };

  const screens = {};
  function register(def) { screens[def.id] = def; }
  function areaOf(id) {
    const p = id.split('/')[0];
    if (['store', 'auth', 'account', 'help', 'info', 'sell', 'ads'].includes(p)) return 'store';
    return p;
  }

  /* ---------------- Primitives ---------------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n) => Number(n).toLocaleString('en-US');
  const go = (id, state) => '#/' + id + (state ? '@' + encodeURIComponent(state) : '');
  const icon = (name, cls) => `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ''} aria-hidden="true"></i>`;
  const join = (arr, fn) => (arr || []).map(fn).join('');
  const css = (() => { const done = new Set(); return (key, text) => { if (done.has(key)) return; done.add(key); const s = document.createElement('style'); s.dataset.screenCss = key; s.textContent = text; document.head.appendChild(s); }; })();

  const LOGO_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="9" fill="var(--brand)"/><path d="M7 12.5 9 7.5h14l2 5" fill="none" stroke="var(--on-brand)" stroke-width="2" stroke-linejoin="round"/><path d="M7 12.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" fill="none" stroke="var(--on-brand)" stroke-width="2" stroke-linecap="round"/><path d="M9.5 16.5v8h13v-8" fill="none" stroke="var(--on-brand)" stroke-width="2" stroke-linejoin="round"/><path d="M14 24.5v-4h4v4" fill="none" stroke="var(--on-brand)" stroke-width="2" stroke-linejoin="round"/></svg>`;
  const BRAND = 'Marketly';
  const logo = (area) => `<a class="logo" href="${go('store/home')}">${LOGO_SVG}<span>${BRAND}</span>${area ? `<span class="area">${area}</span>` : ''}</a>`;

  /* ---------------- Buttons ---------------- */
  // btn('Add to cart', { v:'primary'|'secondary'|'soft'|'ghost'|'danger'|'danger-soft'|'deal'|'link', size:'sm'|'lg', icon, iconR, href, block, label (for icon-only), disabled })
  function btn(label, o = {}) {
    const cls = ['btn', 'btn-' + (o.v || 'primary')];
    if (o.size) cls.push('btn-' + o.size);
    if (o.block) cls.push('btn-block');
    if (!label) cls.push('btn-icon');
    if (o.cls) cls.push(o.cls);
    const inner = (o.icon ? icon(o.icon) : '') + (label ? `<span>${label}</span>` : '') + (o.iconR ? icon(o.iconR) : '');
    const aria = !label ? ` aria-label="${esc(o.label || o.icon)}"` : '';
    if (o.href) return `<a class="${cls.join(' ')}" href="${o.href}"${aria}>${inner}</a>`;
    return `<button type="button" class="${cls.join(' ')}"${aria}${o.disabled ? ' disabled' : ''}>${inner}</button>`;
  }
  const iconBtn = (name, label, o = {}) => `${o.href ? `<a class="icon-btn" href="${o.href}"` : '<button type="button" class="icon-btn"'} aria-label="${esc(label)}">${icon(name)}${o.count ? `<span class="dot-count">${o.count}</span>` : ''}${o.href ? '</a>' : '</button>'}`;

  /* ---------------- Badges & status ---------------- */
  const badge = (text, tone, ic) => `<span class="badge${tone ? ' t-' + tone : ''}">${ic ? icon(ic) : ''}${text}</span>`;
  // Every status model in the plan maps to one tone. Unknown → neutral.
  const STATUS = {
    // Product review & publication
    'Draft': '', 'Submitted': 'info', 'Changes requested': 'warning', 'Approved': 'success', 'Rejected': 'danger',
    'Active': 'success', 'Hidden': '', 'Suspended': 'danger',
    // Seller account
    'Applied': 'info', 'Information required': 'warning', 'Under review': 'info', 'Restricted': 'warning', 'Closed': '',
    // Stock groups
    'Available': 'success', 'Reserved': 'info', 'Incoming': '', 'Damaged': 'danger', 'Held': 'warning', 'Returned': 'warning',
    'In stock': 'success', 'Low stock': 'warning', 'Out of stock': 'danger',
    // Payment
    'Accepted': 'success', 'Pending': 'warning', 'Failed': 'danger', 'Refunded': '', 'Partly refunded': '', 'Checking': 'warning', 'Authorized': 'info', 'Captured': 'success',
    // Order & item
    'New': 'brand', 'Confirmed': 'info', 'Preparing': 'info', 'Delayed': 'warning', 'Shipped': 'info', 'In transit': 'info', 'Out for delivery': 'info',
    'Delivered': 'success', 'Partly delivered': 'warning', 'Cancelled': '', 'Partly cancelled': '', 'Completed': 'success', 'Overdue': 'danger', 'Delivery failed': 'danger', 'Lost': 'danger',
    'Cancellation requested': 'warning',
    // Returns & refunds
    'Return requested': 'warning', 'Return approved': 'info', 'Return in transit': 'info', 'Inspecting': 'info', 'Requested': 'info', 'Processing': 'info', 'Sent': 'success',
    // Payouts & balances
    'Paid': 'success', 'Scheduled': 'info', 'On hold': 'warning', 'Negative': 'danger', 'Matched': 'success', 'Mismatch': 'danger', 'Chargeback': 'danger', 'Disputed': 'danger',
    // Cases
    'Open': 'info', 'Waiting on customer': 'warning', 'Waiting on seller': 'warning', 'Escalated': 'danger', 'Resolved': 'success', 'Reopened': 'warning', 'Appealed': 'warning', 'Decision made': 'success',
    // Campaigns & content
    'Live': 'success', 'Paused': 'warning', 'Ending soon': 'warning', 'Finished': '', 'Archived': '', 'Published': 'success', 'Unpublished': '', 'Expired': '', 'In review': 'info',
    // Misc
    'On time': 'success', 'Late': 'danger', 'Due today': 'warning', 'Verified': 'info', 'Invited': 'info', 'Disabled': '',
  };
  const status = (s, tone) => { const t = tone !== undefined ? tone : (STATUS[s] ?? ''); return `<span class="badge${t ? ' t-' + t : ''}">${s}</span>`; };
  const statusTone = (s) => STATUS[s] ?? '';
  const sponsored = (label = 'Sponsored') => `<span class="sponsored">${icon('info', 'ic-sm')}${label}</span>`;

  /* ---------------- Media ---------------- */
  const img = (ic, tint, cls = '') => `<div class="imgph ${cls}" style="--tint:${tint || 'var(--img-1)'}">${icon(ic)}</div>`;
  const pimg = (p, cls = '') => img(p.icon, p.tint, cls);
  const avatar = (name, cls = '') => `<span class="avatar ${cls}" aria-hidden="true">${esc(String(name).split(' ').map((w) => w[0]).slice(0, 2).join(''))}</span>`;
  const logoTile = (s, cls = '') => `<span class="logo-tile ${cls}" style="--tint:${s.tint}" aria-hidden="true">${esc(s.initials)}</span>`;

  /* ---------------- Commerce ---------------- */
  function price(amount, was, o = {}) {
    const sale = was && was > amount;
    const off = sale ? Math.round((1 - amount / was) * 100) : 0;
    return `<span class="price${o.lg ? ' lg' : ''}"><span class="now${sale ? ' sale' : ''}">${o.from ? '<span class="from">from</span>' : ''}${money(amount)}</span>${sale ? `<span class="was">${money(was)}</span>${o.noOff ? '' : `<span class="off">${off}% off</span>`}` : ''}</span>`;
  }
  const stars = (r, count) => `<span class="stars"><span class="s" aria-hidden="true">★</span><span class="val">${r.toFixed(1)}</span>${count !== undefined ? `<span>(${num(count)})</span>` : ''}<span class="sr-only"> out of 5</span></span>`;
  const stars5 = (r, size = 16) => `<span class="stars5" style="--r:${(r / 5) * 100}%;font-size:${size}px" role="img" aria-label="${r} out of 5 stars">★★★★★</span>`;
  function sellerBadge(s, compact) {
    if (s.official) return badge(compact ? 'Official' : 'Official Store', 'brand', 'badge-check');
    if (s.verified) return badge(compact ? 'Verified' : 'Verified seller', 'info', 'shield-check');
    return '';
  }
  const sellerLine = (sid, o = {}) => { const s = window.D.sellers[sid]; return `<span class="seller-line">Sold by <a href="${s.official ? go('store/official') : go('store/seller')}"><b>${esc(s.name)}</b></a>${o.badge === false ? '' : sellerBadge(s, true)}</span>`; };
  const shipLine = (text, ic = 'truck') => `<span class="ship-line">${icon(ic)}<span>${text}</span></span>`;

  // Product card. o: { sponsored, compact, showSeller, deal }
  function productCard(p, o = {}) {
    const D = window.D;
    const s = D.sellers[p.seller];
    const off = p.was ? Math.round((1 - p.price / p.was) * 100) : 0;
    return `<article class="pcard">
      <div style="position:relative">
        <a href="${go('store/product')}" aria-label="${esc(p.name)}">${pimg(p)}</a>
        <div class="tags">${off ? badge(`−${off}%`, 'deal') : ''}${s.official && !o.compact ? badge('Official', 'brand') : ''}</div>
        <button type="button" class="fav" aria-label="Save ${esc(p.name)} to wishlist">${icon('heart')}</button>
      </div>
      ${o.sponsored ? sponsored() : ''}
      <a class="name" href="${go('store/product')}">${esc(p.name)}</a>
      ${stars(p.rating, p.reviews)}
      ${price(p.price, p.was, { from: p.offers > 1 && o.from, noOff: true })}
      <div class="meta">${p.free ? `<span>${icon('truck', 'ic-sm')} Free delivery ${p.delivery}</span>` : `<span>Delivery ${p.delivery}</span>`}</div>
      ${o.showSeller ? `<div class="meta">${sellerLine(p.seller, { badge: false })}</div>` : ''}
    </article>`;
  }
  const qty = (n = 1, cls = '') => `<span class="qty ${cls}"><button type="button" aria-label="Decrease quantity">${icon('minus', 'ic-sm')}</button><span>${n}</span><button type="button" aria-label="Increase quantity">${icon('plus', 'ic-sm')}</button></span>`;
  const countdown = (h, m, s) => `<span class="countdown" role="timer" aria-label="Ends in ${h} hours ${m} minutes"><span>${h}</span>:<span>${m}</span>:<span>${s}</span></span>`;
  const meter = (pct, tone) => `<div class="meter${tone ? ' t-' + tone : ''}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>`;

  /* ---------------- Structure ---------------- */
  // card({ title, sub, actions, body, foot, pad, cls, flush })
  function card(o) {
    if (typeof o === 'string') return `<div class="card pad">${o}</div>`;
    const head = o.title ? `<div class="card-head"><div class="stack gap-0"><h3 class="h4">${o.title}</h3>${o.sub ? `<span class="xs muted">${o.sub}</span>` : ''}</div>${o.actions ? `<div class="row gap-2">${o.actions}</div>` : ''}</div>` : '';
    const body = o.flush ? (o.body || '') : `<div class="card-body">${o.body || ''}</div>`;
    return `<section class="card ${o.cls || ''}">${head}${body}${o.foot ? `<div class="card-foot">${o.foot}</div>` : ''}</section>`;
  }
  const crumbs = (items) => `<nav class="crumbs" aria-label="Breadcrumb">${items.map((c, i) => (i ? icon('chevron-right') : '') + (c.href ? `<a href="${c.href}">${c.label}</a>` : `<span>${c.label || c}</span>`)).join('')}</nav>`;
  // pageHead(title, { sub, actions, crumbs, eyebrow }) — back-office page title row
  const pageHead = (title, o = {}) => `<div class="page-head"><div class="t">${o.crumbs ? crumbs(o.crumbs) : ''}${o.eyebrow ? `<span class="eyebrow">${o.eyebrow}</span>` : ''}<h1 class="h1">${title}</h1>${o.sub ? `<p class="sub small">${o.sub}</p>` : ''}</div>${o.actions ? `<div class="actions">${o.actions}</div>` : ''}</div>`;
  const sectionHead = (title, o = {}) => `<div class="row between base"><h2 class="${o.display ? 'display d-lg' : 'h2'}">${title}</h2>${o.link ? `<a class="small strong" href="${o.href || '#'}">${o.link} ${icon('arrow-right', 'ic-sm')}</a>` : ''}</div>`;
  // tabs([{label,count,href}|string], activeIndexOrLabel)
  const tabs = (items, active = 0) => `<div class="tabs" role="tablist">${items.map((t, i) => { const it = typeof t === 'string' ? { label: t } : t; const on = active === i || active === it.label; return `<a class="tab${on ? ' is-active' : ''}" role="tab" aria-selected="${on}" href="${it.href || 'javascript:void 0'}">${it.icon ? icon(it.icon, 'ic-sm') : ''}${it.label}${it.count !== undefined ? `<span class="count">${it.count}</span>` : ''}</a>`; }).join('')}</div>`;
  const seg = (items, active = 0) => `<div class="seg" role="group">${items.map((t, i) => { const it = typeof t === 'string' ? { label: t } : t; const on = active === i || active === it.label; return `<${it.href ? `a href="${it.href}"` : 'button type="button"'} class="${on ? 'is-active' : ''}" aria-pressed="${on}">${it.icon ? icon(it.icon, 'ic-sm') : ''}${it.label}</${it.href ? 'a' : 'button'}>`; }).join('')}</div>`;
  const chips = (items, active = -1) => `<div class="hscroll gap-2" style="--gap:8px">${items.map((t, i) => { const it = typeof t === 'string' ? { label: t } : t; const on = active === i || active === it.label || it.active; return `<a class="chip${on ? ' is-active' : ''}" href="${it.href || 'javascript:void 0'}">${it.icon ? icon(it.icon) : ''}${it.label}${it.x ? icon('x', 'ic-sm') : ''}</a>`; }).join('')}</div>`;
  // steps(['Cart','Delivery','Payment'], currentIndex)
  const steps = (items, cur = 0) => `<ol class="steps" aria-label="Progress">${items.map((s, i) => `${i ? '<li class="bar" aria-hidden="true"></li>' : ''}<li class="step ${i < cur ? 'is-done' : i === cur ? 'is-current' : ''}"${i === cur ? ' aria-current="step"' : ''}><span class="n">${i < cur ? icon('check', 'ic-sm') : i + 1}</span>${s}</li>`).join('')}</ol>`;
  // track(['Ordered','Shipped','Out for delivery','Delivered'], doneCount, {warnAt})
  const track = (labels, done, o = {}) => `<div class="stack gap-2"><div class="track" style="--n:${labels.length}">${labels.map((l, i) => `<span class="seg-bar ${i < done ? (o.tone === 'warning' && i === done - 1 ? 'is-warn' : o.tone === 'danger' && i === done - 1 ? 'is-danger' : 'is-done') : ''}"></span>`).join('')}</div><div class="track-labels" style="--n:${labels.length}">${labels.map((l, i) => `<span class="${i === done - 1 ? 'is-current' : ''}">${l}</span>`).join('')}</div></div>`;
  // timeline([{t, d, state:'done'|'current'|'warn'|'danger'|'', body}])
  const timeline = (evs) => `<ol class="timeline">${evs.map((e) => `<li class="ev ${e.state ? 'is-' + e.state : ''}"><span class="dot" aria-hidden="true"></span><div class="stack gap-1"><span class="t">${e.t}</span>${e.d ? `<span class="d">${e.d}</span>` : ''}${e.body ? `<div class="small sub">${e.body}</div>` : ''}</div></li>`).join('')}</ol>`;
  const kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const sumRow = (k, v, cls = '') => `<div class="sum-row ${cls}"><span>${k}</span><span>${v}</span></div>`;
  // stat(label, value, { delta:'+12%', dir:'up'|'down', note, icon })
  const stat = (label, value, o = {}) => `<div class="stat"><span class="k">${o.icon ? icon(o.icon, 'ic-sm') : ''}${label}</span><span class="v">${value}</span>${o.delta || o.note ? `<span class="d ${o.dir || ''}">${o.delta ? (o.dir === 'down' ? '▼ ' : o.dir === 'up' ? '▲ ' : '') + o.delta : ''}${o.delta && o.note ? ' · ' : ''}${o.note || ''}</span>` : ''}</div>`;
  const queueTile = (n, label, o = {}) => `<a class="queue-tile${o.tone ? ' t-' + o.tone : ''}" href="${o.href || '#'}"><span class="qn">${n}</span><span class="stack gap-0 grow"><span class="small strong">${label}</span>${o.sub ? `<span class="xs muted">${o.sub}</span>` : ''}</span>${icon('chevron-right', 'ic-sm')}</a>`;
  const alert = (tone, title, body, ic) => { const icons = { info: 'info', success: 'circle-check', warning: 'triangle-alert', danger: 'circle-alert', brand: 'sparkles' }; return `<div class="alert t-${tone}" role="${tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}">${icon(ic || icons[tone] || 'info')}<div class="stack gap-1 grow">${title ? `<span class="alert-title">${title}</span>` : ''}${body ? `<span>${body}</span>` : ''}</div></div>`; };
  const empty = (ic, title, body, action) => `<div class="empty"><span class="ring">${icon(ic)}</span><h3 class="h3">${title}</h3>${body ? `<p class="small muted" style="max-width:42ch">${body}</p>` : ''}${action || ''}</div>`;
  // Lists page differently per platform: numbered pages on the website (tablet/desktop),
  // infinite scroll ("lazy loading") in the Android app (phone). One call renders both.
  // o.grid → skeleton product cards; o.end → end-of-list state.
  const lazyLoad = (o = {}) => {
    if (o.end) return `<div class="lazy-load only-phone is-end" role="status">${icon('circle-check', 'ic-sm')}<span>You've reached the end</span></div>`;
    const sk = o.grid
      ? `<div class="sk-grid" aria-hidden="true">${'<div class="sk-card"><span class="sk sk-img"></span><span class="sk sk-line"></span><span class="sk sk-line short"></span></div>'.repeat(2)}</div>`
      : `<div class="sk-list" aria-hidden="true">${'<div class="sk-row"><span class="sk sk-thumb"></span><span class="sk-lines"><span class="sk sk-line"></span><span class="sk sk-line short"></span></span></div>'.repeat(2)}</div>`;
    return `<div class="lazy-load only-phone" role="status" aria-live="polite">${sk}<span class="lazy-note"><span class="spinner" aria-hidden="true"></span>Loading more</span></div>`;
  };
  const pager = (cur = 1, total = 8, o = {}) => { const nums = total <= 5 ? Array.from({ length: total }, (_, i) => i + 1) : [1, 2, 3, '…', total]; return lazyLoad(o) + `<nav class="pager no-phone" aria-label="Pagination"><a href="javascript:void 0" aria-label="Previous page">${icon('chevron-left', 'ic-sm')}</a>${nums.map((n) => n === '…' ? '<span>…</span>' : `<a class="${n === cur ? 'is-active' : ''}" href="javascript:void 0"${n === cur ? ' aria-current="page"' : ''}>${n}</a>`).join('')}<a href="javascript:void 0" aria-label="Next page">${icon('chevron-right', 'ic-sm')}</a></nav>`; };
  const deadline = (text, tone = 'ok') => `<span class="deadline t-${tone}">${icon(tone === 'danger' ? 'alarm-clock' : 'clock')}${text}</span>`;

  /* ---------------- Tables ---------------- */
  // table(['Order', {label:'Total', cls:'r'}], [[cell, cell], ...], { select:true, rowCls:[...] })
  function table(cols, rows, o = {}) {
    const th = cols.map((c) => { const it = typeof c === 'string' ? { label: c } : c; return `<th class="${it.cls || ''}" scope="col">${it.label}</th>`; }).join('');
    const tr = rows.map((r, i) => `<tr class="${(o.rowCls && o.rowCls[i]) || ''}">${o.select ? `<td style="width:36px"><input type="checkbox" aria-label="Select row"${o.checked && o.checked.includes(i) ? ' checked' : ''}></td>` : ''}${r.map((cell, j) => { const c = cols[j]; const cls = c && typeof c !== 'string' ? c.cls || '' : ''; return `<td class="${cls}">${cell}</td>`; }).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table class="table"><thead><tr>${o.select ? '<th style="width:36px"><input type="checkbox" aria-label="Select all"></th>' : ''}${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  }
  const searchIn = (placeholder, id = 'q') => `<label class="search-in" for="${id}">${icon('search', 'ic-sm')}<input id="${id}" type="search" placeholder="${esc(placeholder)}"></label>`;

  /* ---------------- Forms ---------------- */
  let uid = 0;
  const nextId = (p = 'f') => p + '-' + (++uid);
  // field('Email', input('email', ...), { hint, error, opt })
  const field = (label, control, o = {}) => { const m = control.match(/id="([^"]+)"/); const id = m ? m[1] : ''; return `<div class="field"><label class="label"${id ? ` for="${id}"` : ''}>${label}${o.opt ? ' <span class="opt">(optional)</span>' : ''}</label>${control}${o.error ? `<span class="error-text">${icon('circle-alert', 'ic-sm')}${o.error}</span>` : o.hint ? `<span class="hint">${o.hint}</span>` : ''}</div>`; };
  const input = (id, value = '', o = {}) => o.prefix || o.suffix || o.icon
    ? `<span class="input-group">${o.icon ? icon(o.icon, 'ic-sm') : ''}${o.prefix ? `<span class="affix">${o.prefix}</span>` : ''}<input class="input" id="${id}" type="${o.type || 'text'}" value="${esc(value)}" placeholder="${esc(o.placeholder || '')}"${o.readonly ? ' readonly' : ''}>${o.suffix ? `<span class="affix">${o.suffix}</span>` : ''}</span>`
    : `<input class="input${o.error ? ' is-error' : ''}" id="${id}" type="${o.type || 'text'}" value="${esc(value)}" placeholder="${esc(o.placeholder || '')}"${o.readonly ? ' readonly' : ''}${o.error ? ' aria-invalid="true"' : ''}>`;
  const select = (id, options, value) => `<select class="select" id="${id}">${options.map((op) => `<option${op === value ? ' selected' : ''}>${esc(op)}</option>`).join('')}</select>`;
  const textarea = (id, value = '', placeholder = '') => `<textarea class="textarea" id="${id}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`;
  const check = (id, label, checked) => `<label class="check" for="${id}"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}><span>${label}</span></label>`;
  const radio = (name, id, label, checked) => `<label class="check" for="${id}"><input type="radio" name="${name}" id="${id}"${checked ? ' checked' : ''}><span>${label}</span></label>`;
  const toggle = (id, label, checked) => `<label class="switch" for="${id}"><input type="checkbox" role="switch" id="${id}"${checked ? ' checked' : ''}><span class="small">${label}</span></label>`;
  // optCard(name, id, titleHtml, bodyHtml, selected) — radio card
  const optCard = (name, id, title, body, selected, o = {}) => `<label class="opt-card${selected ? ' is-selected' : ''}${o.disabled ? ' is-disabled' : ''}" for="${id}"><input type="radio" name="${name}" id="${id}"${selected ? ' checked' : ''}${o.disabled ? ' disabled' : ''}><span class="stack gap-1 grow">${title}${body ? `<span class="small sub">${body}</span>` : ''}</span>${o.right ? `<span class="none">${o.right}</span>` : ''}</label>`;
  const dropzone = (title = 'Drag photos here or browse', hint = 'JPG or PNG, up to 10 MB each') => `<div class="dropzone">${icon('image-plus', 'ic-lg')}<span class="small strong" style="color:var(--text)">${title}</span><span class="xs">${hint}</span>${btn('Browse files', { v: 'secondary', size: 'sm' })}</div>`;

  /* ---------------- Overlays ---------------- */
  // modal({ title, body, foot, size:'lg' })
  const modal = (o) => `<div class="overlay" role="presentation"><div class="modal ${o.size || ''}" role="dialog" aria-modal="true" aria-label="${esc(o.title || 'Dialog')}"><div class="grabber" aria-hidden="true"></div>${o.title ? `<div class="modal-head"><h2 class="h3">${o.title}</h2>${iconBtn('x', 'Close')}</div>` : ''}<div class="modal-body">${o.body}</div>${o.foot ? `<div class="modal-foot">${o.foot}</div>` : ''}</div></div>`;
  const drawer = (o) => `<div class="overlay" role="presentation" style="align-items:stretch;justify-content:flex-end;padding:0"><aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(o.title)}"><div class="modal-head"><h2 class="h3">${o.title}</h2>${iconBtn('x', 'Close')}</div><div class="modal-body">${o.body}</div>${o.foot ? `<div class="modal-foot">${o.foot}</div>` : ''}</aside></div>`;

  /* ---------------- Charts (SVG, drawn to scale, hover tooltips) ---------------- */
  function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
  // lineChart({ labels, series:[{name, data}], height, fmt, area })
  function lineChart(o) {
    const W = 640, H = o.height || 220, L = 40, R = 16, T = 12, B = 26;
    const all = o.series.flatMap((s) => s.data);
    const stepV = niceMax(Math.max(...all) * 1.05 / 4);
    const max = Math.ceil(Math.max(...all) * 1.05 / stepV) * stepV;
    const n = o.labels.length;
    const x = (i) => L + (i * (W - L - R)) / (n - 1);
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const fmt = o.fmt || ((v) => v);
    const ticks = []; for (let t = 0; t <= max + 1e-9; t += stepV) ticks.push(t);
    let g = ticks.map((t) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('');
    const every = Math.ceil(n / 7);
    g += o.labels.map((l, i) => (i % every === 0 || i === n - 1) ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${l}</text>` : '').join('');
    o.series.forEach((s, si) => {
      const pts = s.data.map((v, i) => `${x(i)},${y(v)}`).join(' ');
      if (o.area && si === 0) g += `<polygon class="a1" points="${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}"/>`;
      g += `<polyline class="s${si + 1}" points="${pts}"/><circle class="end${si + 1}" cx="${x(n - 1)}" cy="${y(s.data[n - 1])}" r="4.5"/>`;
    });
    const colW = (W - L - R) / (n - 1);
    g += o.labels.map((l, i) => {
      const tipW = 150, tx = Math.min(Math.max(x(i) - tipW / 2, L), W - R - tipW);
      const lines = o.series.map((s) => `${s.name}: ${fmt(s.data[i])}`);
      return `<g class="hov"><rect class="hit" x="${x(i) - colW / 2}" y="${T}" width="${colW}" height="${H - T - B}"/><g class="tip"><line x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}" stroke="var(--border-strong)"/><rect x="${tx}" y="${T}" width="${tipW}" height="${18 + lines.length * 16}" rx="6"/><text x="${tx + 10}" y="${T + 16}">${l}</text>${lines.map((t, k) => `<text x="${tx + 10}" y="${T + 32 + k * 16}">${t}</text>`).join('')}</g></g>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || 'Line chart')}">${g}</svg>`;
  }
  // barChart({ labels, data, height, fmt, s2 }) — single series vertical bars
  function barChart(o) {
    const W = 640, H = o.height || 200, L = 40, R = 8, T = 12, B = 26;
    const n = o.labels.length, max = niceMax(Math.max(...o.data) * 1.05);
    const bw = ((W - L - R) / n) * 0.62, step = (W - L - R) / n;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const fmt = o.fmt || ((v) => v);
    let g = [0, 0.5, 1].map((t) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(max * t)}" y2="${y(max * t)}"/><text x="${L - 8}" y="${y(max * t) + 4}" text-anchor="end">${fmt(max * t)}</text>`).join('');
    g += o.data.map((v, i) => {
      const cx = L + step * i + step / 2, top = y(v), h = y(0) - top, r = Math.min(4, h);
      const path = `M${cx - bw / 2},${y(0)} V${top + r} q0,-${r} ${r},-${r} H${cx + bw / 2 - r} q${r},0 ${r},${r} V${y(0)} Z`;
      return `<g class="hov"><path class="${o.s2 ? 'b2' : 'b1'} bar-hl" d="${path}"/><rect class="hit" x="${cx - step / 2}" y="${T}" width="${step}" height="${H - T - B}"/><text x="${cx}" y="${H - 6}" text-anchor="middle">${o.labels[i]}</text><g class="tip"><rect x="${cx - 40}" y="${Math.max(top - 30, 0)}" width="80" height="22" rx="6"/><text x="${cx}" y="${Math.max(top - 30, 0) + 15}" text-anchor="middle">${fmt(v)}</text></g></g>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label || 'Bar chart')}">${g}</svg>`;
  }
  const sparkline = (data, cls = 's1') => { const W = 120, H = 32, max = Math.max(...data), min = Math.min(...data); const x = (i) => (i * W) / (data.length - 1); const y = (v) => 3 + (H - 6) * (1 - (v - min) / (max - min || 1)); return `<svg class="chart" viewBox="0 0 ${W} ${H}" style="width:${W}px;height:${H}px" aria-hidden="true"><polyline class="${cls}" points="${data.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/><circle class="end${cls.slice(1)}" cx="${x(data.length - 1)}" cy="${y(data[data.length - 1])}" r="3"/></svg>`; };
  const legend = (items) => `<div class="legend">${items.map((t, i) => `<span><i class="l${i + 1}"></i>${t}</span>`).join('')}</div>`;
  const splitBar = (a, b) => `<div class="splitbar" role="img" aria-label="${a}% and ${b}%"><i class="l1" style="width:${a}%"></i><i class="l2" style="width:${b}%"></i></div>`;

  /* ==================== STORE LAYOUT ==================== */
  const STORE_NAV = [
    { key: 'categories', label: 'All categories', icon: 'menu', href: go('store/categories') },
    { key: 'deals', label: 'Deals', icon: 'tag', href: go('store/deals'), deal: true },
    { key: 'official', label: 'Official Store', icon: 'badge-check', href: go('store/official') },
    { key: 'new', label: 'New arrivals', href: go('store/collection', 'New arrivals') },
    { key: 'best', label: 'Best sellers', href: go('store/collection', 'Best sellers') },
    { key: 'brands', label: 'Brands', href: go('store/brand') },
  ];
  function storeHeader(o = {}) {
    const D = window.D;
    const signedIn = o.signedIn !== false;
    return `<header class="store-header${o.appbar ? ' no-phone' : ''}">
      <div class="container">
        <div class="bar">
          ${logo()}
          <button type="button" class="deliver only-desktop btn-ghost" style="border:0;background:none;text-align:left;cursor:pointer;padding:4px 8px;border-radius:var(--r-md)"><span>${icon('map-pin', 'ic-sm')} Deliver to</span><b>Portland 97205</b></button>
          <form class="search no-phone" role="search" onsubmit="return false"><label for="hdr-q" class="sr-only">Search Marketly</label>${icon('search', 'ic-sm')}<input id="hdr-q" type="search" placeholder="Search products, brands and sellers" value="${esc(o.q || '')}"><button type="submit" class="go" aria-label="Search">${icon('arrow-right')}</button></form>
          <span class="grow only-phone"></span>
          ${signedIn ? `<a class="acct no-phone" href="${go('account/overview')}"><span>Hello, ${D.customer.first}</span><b>Account</b></a>` : `<a class="acct no-phone" href="${go('auth/sign-in')}"><span>Hello</span><b>Sign in</b></a>`}
          <a class="acct only-desktop" href="${go('account/orders')}"><span>Returns</span><b>&amp; Orders</b></a>
          ${iconBtn('bell', 'Notifications', { href: go('account/notifications'), count: signedIn ? 3 : 0 })}
          <a class="cart-btn no-phone" href="${go('store/cart')}">${icon('shopping-cart')}<span>Cart</span><span class="n">4</span></a>
          <span class="only-phone">${iconBtn('shopping-cart', 'Cart, 4 items', { href: go('store/cart'), count: 4 })}</span>
        </div>
        <form class="search only-phone mobile-search" role="search" onsubmit="return false" style="display:flex;height:44px"><label for="hdr-mq" class="sr-only">Search Marketly</label>${icon('search', 'ic-sm')}<input id="hdr-mq" type="search" placeholder="Search Marketly" value="${esc(o.q || '')}">${iconBtn('scan-line', 'Scan a barcode')}</form>
      </div>
      <div class="no-phone" style="border-top:1px solid var(--border)"><div class="container"><nav class="store-nav" aria-label="Shop">
        ${STORE_NAV.map((n) => `<a href="${n.href}" class="${o.nav === n.key ? 'is-active' : ''}${n.deal ? ' deal' : ''}">${n.icon ? icon(n.icon, 'ic-sm') : ''}${n.label}</a>`).join('')}
        <span class="spacer"></span>
        <a href="${go('sell/landing')}">${icon('store', 'ic-sm')}Sell on ${BRAND}</a>
        <a href="${go('help/center')}">${icon('life-buoy', 'ic-sm')}Help</a>
      </nav></div></div>
    </header>`;
  }
  const appbar = (title, o = {}) => `<div class="appbar">${iconBtn('arrow-left', 'Back', { href: o.back || go('store/home') })}<span class="title">${title}</span>${o.actions || ''}</div>`;
  function storeFooter() {
    // Website only. The phone layout is the Android app, which has no footer: its links live in the Account tab.
    return `<footer class="store-footer no-phone"><div class="container">
      <div class="cols">
        <div class="stack gap-3">${logo()}<p class="small muted" style="max-width:34ch">One store for our own products and approved independent sellers. Every item shows who sells it, when it arrives and how returns work.</p>
          <div class="stack gap-1 small"><span>${icon('headset', 'ic-sm')} Support: 1-800-555-0136</span><span class="muted">Mon–Sat, 8 AM–8 PM PT</span></div></div>
        <div><h4>Shop</h4><ul><li><a href="${go('store/categories')}">All categories</a></li><li><a href="${go('store/deals')}">Deals</a></li><li><a href="${go('store/official')}">Official Store</a></li><li><a href="${go('store/collection', 'New arrivals')}">New arrivals</a></li><li><a href="${go('store/brand')}">Brands</a></li></ul></div>
        <div><h4>Help</h4><ul><li><a href="${go('help/center')}">Help Center</a></li><li><a href="${go('account/orders')}">Track an order</a></li><li><a href="${go('account/returns')}">Returns and refunds</a></li><li><a href="${go('help/contact')}">Contact us</a></li><li><a href="${go('auth/guest-orders')}">Guest order lookup</a></li></ul></div>
        <div><h4>Policies</h4><ul><li><a href="${go('info/policy', 'Shipping')}">Shipping</a></li><li><a href="${go('info/policy', 'Returns')}">Returns</a></li><li><a href="${go('info/policy', 'Privacy')}">Privacy</a></li><li><a href="${go('info/policy', 'Purchase terms')}">Purchase terms</a></li><li><a href="${go('info/policy', 'Seller rules')}">Seller rules</a></li></ul></div>
        <div><h4>Sell with us</h4><ul><li><a href="${go('sell/landing')}">Sell on ${BRAND}</a></li><li><a href="${go('sell/landing')}">Seller requirements</a></li><li><a href="${go('sell/landing')}">Fees</a></li><li><a href="${go('seller/dashboard')}">Seller Center</a></li><li><a href="${go('info/about')}">About us</a></li></ul></div>
      </div>
      <div class="legal"><span>© 2026 ${BRAND}, Inc. Prices in USD. Service region: United States.</span><span>Policies show their effective date. Orders keep the terms accepted at purchase.</span></div>
    </div></footer>`;
  }
  const TABS = [
    { key: 'home', label: 'Home', icon: 'house', href: go('store/home') },
    { key: 'categories', label: 'Categories', icon: 'layout-grid', href: go('store/categories') },
    { key: 'deals', label: 'Deals', icon: 'tag', href: go('store/deals') },
    { key: 'cart', label: 'Cart', icon: 'shopping-cart', href: go('store/cart'), count: 4 },
    { key: 'account', label: 'Account', icon: 'user-round', href: go('account/overview') },
  ];
  const tabbar = (active) => `<nav class="tabbar" aria-label="App">${TABS.map((t) => `<a href="${t.href}" class="${active === t.key ? 'is-active' : ''}"${active === t.key ? ' aria-current="page"' : ''}>${icon(t.icon)}${t.count ? `<span class="dot-count">${t.count}</span>` : ''}<span>${t.label}</span></a>`).join('')}</nav>`;

  // storeLayout(contentHtml, { nav, tab, appbar:{title, back, actions}, actionBar, footer:false, tabbar:false, promo:false, signedIn, q })
  function storeLayout(content, o = {}) {
    const showTabbar = o.tabbar !== false && !o.actionBar;
    return `<div class="store">
      ${o.promo === false ? '' : `<div class="store-promo no-phone">Free delivery on Official Store orders over $35 · 30-day returns on most items · <a href="${go('info/policy', 'Shipping')}">Delivery details</a></div>`}
      ${storeHeader(o)}
      ${o.appbar ? `<div class="only-phone">${appbar(o.appbar.title, o.appbar)}</div>` : ''}
      <main class="store-main">${content}</main>
      ${o.footer === false ? '' : storeFooter()}
      ${o.actionBar ? `<div class="action-bar">${o.actionBar}</div>` : ''}
      ${showTabbar ? tabbar(o.tab) : ''}
    </div>`;
  }
  // checkoutLayout(content, { step }) — minimal chrome during checkout
  function checkoutLayout(content, o = {}) {
    return `<div class="store">
      <header class="checkout-header"><div class="container"><div class="bar">${logo()}<span class="row gap-2 small sub">${icon('lock', 'ic-sm')}<span class="no-phone">Secure checkout</span></span><a class="small strong" href="${go('help/center')}">Help</a></div></div></header>
      <main class="store-main">${content}</main>
    </div>`;
  }
  const ACCOUNT_NAV = [
    { grp: 'Purchases' },
    { key: 'overview', label: 'Overview', icon: 'layout-dashboard', id: 'account/overview' },
    { key: 'orders', label: 'Orders', icon: 'package', id: 'account/orders' },
    { key: 'returns', label: 'Returns and refunds', icon: 'undo-2', id: 'account/returns' },
    { key: 'cases', label: 'Support cases', icon: 'life-buoy', id: 'help/cases' },
    { key: 'messages', label: 'Messages', icon: 'message-square', id: 'account/messages', count: 2 },
    { key: 'notifications', label: 'Notifications', icon: 'bell', id: 'account/notifications', count: 3 },
    { key: 'reviews', label: 'Reviews and feedback', icon: 'star', id: 'account/reviews' },
    { grp: 'Saved' },
    { key: 'wishlist', label: 'Wishlist and alerts', icon: 'heart', id: 'account/wishlist' },
    { key: 'coupons', label: 'Coupons and credit', icon: 'ticket-percent', id: 'account/coupons' },
    { grp: 'Settings' },
    { key: 'profile', label: 'Profile', icon: 'user-round', id: 'account/profile' },
    { key: 'addresses', label: 'Addresses', icon: 'map-pin', id: 'account/addresses' },
    { key: 'payment', label: 'Payment methods', icon: 'credit-card', id: 'account/payment-methods' },
    { key: 'security', label: 'Sign-in and security', icon: 'shield-check', id: 'account/security' },
  ];
  const accountNav = (active) => `<nav class="side-nav" aria-label="Account">${ACCOUNT_NAV.map((n) => n.grp ? `<span class="grp">${n.grp}</span>` : `<a href="${go(n.id)}" class="${active === n.key ? 'is-active' : ''}">${icon(n.icon)}<span>${n.label}</span>${n.count ? `<span class="count">${n.count}</span>` : ''}</a>`).join('')}</nav>`;
  // accountLayout(content, { active, title, back }) — desktop: left menu; phone: app bar + content
  function accountLayout(content, o = {}) {
    const D = window.D;
    const aside = `<aside class="only-desktop stack gap-4"><div class="row gap-3">${avatar(D.customer.name, 'lg')}<div class="stack gap-0"><span class="strong">${D.customer.name}</span><span class="xs muted">Member since ${D.customer.since}</span></div></div>${accountNav(o.active)}</aside>`;
    return storeLayout(`<div class="container page"><div class="split aside-left">${aside}<div class="stack gap-5" style="min-width:0">${content}</div></div></div>`, { tab: 'account', appbar: o.title ? { title: o.title, back: o.back || go('account/overview') } : null, footer: o.footer, actionBar: o.actionBar });
  }

  /* ==================== BACK-OFFICE LAYOUT ==================== */
  const SELLER_NAV = [
    { key: 'setup', label: 'Setup guide', icon: 'list-checks', id: 'seller/setup' },
    { key: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', id: 'seller/dashboard' },
    { key: 'products', label: 'Products and offers', icon: 'package', id: 'seller/products' },
    { key: 'inventory', label: 'Inventory', icon: 'boxes', id: 'seller/inventory', count: 3 },
    { key: 'orders', label: 'Orders', icon: 'shopping-bag', id: 'seller/orders', count: 4, hot: true },
    { key: 'shipping', label: 'Shipping', icon: 'truck', id: 'seller/shipping' },
    { key: 'returns', label: 'Returns and cases', icon: 'undo-2', id: 'seller/returns', count: 2 },
    { key: 'finance', label: 'Finance', icon: 'wallet', id: 'seller/finance' },
    { key: 'marketing', label: 'Marketing and ads', icon: 'megaphone', id: 'seller/marketing' },
    { key: 'customers', label: 'Customers', icon: 'message-square', id: 'seller/customers', count: 5 },
    { key: 'reports', label: 'Reports', icon: 'chart-column', id: 'seller/reports' },
    { key: 'performance', label: 'Account health', icon: 'gauge', id: 'seller/performance' },
    { key: 'store', label: 'Store and settings', icon: 'store', id: 'seller/store' },
    { key: 'notifications', label: 'Notifications', icon: 'bell', id: 'seller/notifications', count: 4 },
    { key: 'help', label: 'Help and support', icon: 'life-buoy', id: 'seller/help' },
  ];
  const ADMIN_NAV = [
    { key: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', id: 'admin/dashboard' },
    { key: 'inbox', label: 'Notifications', icon: 'bell', id: 'admin/inbox', count: 9, hot: true },
    { grp: 'Commerce' },
    { key: 'orders', label: 'Orders', icon: 'shopping-bag', id: 'admin/orders' },
    { key: 'returns', label: 'Returns and refunds', icon: 'undo-2', id: 'admin/returns', count: 14 },
    { key: 'shipping', label: 'Shipping', icon: 'truck', id: 'admin/shipping' },
    { grp: 'Catalog' },
    { key: 'catalog', label: 'Products', icon: 'package', id: 'admin/catalog' },
    { key: 'review', label: 'Review queue', icon: 'list-checks', id: 'admin/product-review', count: 23 },
    { key: 'categories', label: 'Categories and brands', icon: 'folder-tree', id: 'admin/categories' },
    { key: 'reviews', label: 'Reviews and Q&A', icon: 'star', id: 'admin/reviews', count: 6 },
    { grp: 'Official store' },
    { key: 'official', label: 'Offers and trading', icon: 'badge-check', id: 'admin/official' },
    { key: 'purchasing', label: 'Suppliers and purchasing', icon: 'factory', id: 'admin/purchasing' },
    { grp: 'Sellers' },
    { key: 'sellers', label: 'Sellers', icon: 'store', id: 'admin/sellers' },
    { key: 'applications', label: 'Applications', icon: 'file-check', id: 'admin/seller-application', count: 7 },
    { grp: 'Finance' },
    { key: 'finance', label: 'Payments and fees', icon: 'landmark', id: 'admin/finance' },
    { key: 'payouts', label: 'Payouts', icon: 'wallet', id: 'admin/payouts', count: 2, hot: true },
    { grp: 'Customers and service' },
    { key: 'customers', label: 'Customers', icon: 'users', id: 'admin/customers' },
    { key: 'cases', label: 'Cases and disputes', icon: 'life-buoy', id: 'admin/cases', count: 31 },
    { key: 'trust', label: 'Trust and risk', icon: 'shield-alert', id: 'admin/trust', count: 4, hot: true },
    { grp: 'Marketing and content' },
    { key: 'promotions', label: 'Promotions and coupons', icon: 'ticket-percent', id: 'admin/promotions' },
    { key: 'content', label: 'Homepage and pages', icon: 'layout-template', id: 'admin/content' },
    { key: 'help-content', label: 'Help and policies', icon: 'book-open', id: 'admin/help-content' },
    { key: 'ads', label: 'Advertisements', icon: 'megaphone', id: 'admin/ads' },
    { key: 'ad-assets', label: 'Ad creative library', icon: 'images', id: 'admin/ad-assets' },
    { grp: 'Reports and settings' },
    { key: 'reports', label: 'Reports', icon: 'chart-column', id: 'admin/reports' },
    { key: 'staff', label: 'Staff and roles', icon: 'user-cog', id: 'admin/staff' },
    { key: 'settings', label: 'Settings', icon: 'settings', id: 'admin/settings' },
    { key: 'notifications', label: 'Notifications', icon: 'bell-ring', id: 'admin/notifications' },
    { key: 'audit', label: 'Action history', icon: 'history', id: 'admin/audit' },
  ];
  const OPS_NAV = [
    { key: 'queues', label: 'My work queues', icon: 'inbox', id: 'ops/queues', count: 18, hot: true },
    { grp: 'Inventory and warehouse' },
    { key: 'inventory', label: 'Stock', icon: 'boxes', id: 'ops/inventory' },
    { key: 'receiving', label: 'Receiving', icon: 'package-open', id: 'ops/receiving', count: 3 },
    { key: 'pick-pack', label: 'Pick and pack', icon: 'scan-barcode', id: 'ops/pick-pack', count: 27 },
    { grp: 'Shipping' },
    { key: 'dispatch', label: 'Dispatch and exceptions', icon: 'truck', id: 'ops/dispatch', count: 9, hot: true },
    { grp: 'Returns' },
    { key: 'return-inspection', label: 'Return inspection', icon: 'search-check', id: 'ops/return-inspection', count: 5 },
    { grp: 'Finance' },
    { key: 'finance-checks', label: 'Daily finance checks', icon: 'scale', id: 'ops/finance-checks', count: 3 },
    { grp: 'Admin Center' },
    { key: 'admin', label: 'Back to Admin Center', icon: 'arrow-left', id: 'admin/dashboard' },
  ];
  const navLinks = (items, active) => items.map((n) => n.grp ? `<span class="grp">${n.grp}</span>` : `<a href="${go(n.id)}" class="${active === n.key ? 'is-active' : ''}"${active === n.key ? ' aria-current="page"' : ''}>${icon(n.icon)}<span>${n.label}</span>${n.count ? `<span class="count${n.hot ? ' hot' : ''}">${n.count}</span>` : ''}</a>`).join('');
  const mobileNav = (items, active) => `<nav class="bo-mnav" aria-label="Sections">${items.filter((n) => !n.grp).map((n) => `<a href="${go(n.id)}" class="${active === n.key ? 'is-active' : ''}">${icon(n.icon)}${n.label}</a>`).join('')}</nav>`;

  // boLayout(content, { area:'seller'|'admin'|'ops', active })
  function boLayout(content, o = {}) {
    const area = o.area || 'admin';
    const items = area === 'seller' ? SELLER_NAV : area === 'ops' ? OPS_NAV : ADMIN_NAV;
    const label = area === 'seller' ? 'Seller Center' : area === 'ops' ? 'Operations' : 'Admin Center';
    const user = area === 'seller' ? { name: 'Avery Stone', role: 'Owner · Northwind Audio' } : area === 'ops' ? { name: 'Theo Grant', role: 'Order & Shipping Manager' } : { name: 'Riley Chen', role: 'Platform Administrator' };
    const opsLink = area === 'admin' ? `<span class="grp">Operations Center</span><a href="${go('ops/queues')}">${icon('clipboard-list')}<span>Work queues</span><span class="count hot">18</span></a>` : '';
    const topLeft = area === 'seller'
      ? `<button type="button" class="row gap-2 nowrap" style="border:0;background:none;cursor:pointer;padding:4px 6px;border-radius:var(--r-md)" aria-label="Switch store"><span class="logo-tile" style="width:32px;height:32px;font-size:13px;--tint:var(--img-2)">NA</span><span class="stack gap-0 no-phone" style="text-align:left"><span class="small strong">Northwind Audio</span><span class="xs" style="color:var(--success)">● Approved · selling</span></span>${icon('chevrons-up-down', 'ic-sm')}</button>`
      : `<span class="row gap-2 nowrap small strong no-phone">${badge(area === 'ops' ? 'Operations' : 'Admin', area === 'ops' ? 'info' : 'solid')}<span class="muted">US · USD · PT</span></span>`;
    return `<div class="bo">
      <aside class="bo-side"><div class="brand">${logo(label)}</div><nav aria-label="${label}">${navLinks(items, o.active)}${opsLink}</nav>
        <div class="me">${avatar(user.name)}<div class="stack gap-0" style="min-width:0"><span class="strong truncate">${user.name}</span><span class="xs muted truncate">${user.role}</span></div></div></aside>
      <div class="bo-main">
        <header class="bo-top"><div class="bar">
          <span class="no-desktop">${iconBtn('menu', 'Open menu')}</span>
          <span class="no-desktop only-phone">${LOGO_SVG.replace('<svg', '<svg style="width:28px;height:28px"')}</span>
          ${topLeft}
          <label class="search no-phone" for="bo-q">${icon('search', 'ic-sm')}<input id="bo-q" type="search" placeholder="${area === 'seller' ? 'Search orders, products, SKUs' : 'Search orders, sellers, products, customers'}"><span class="kbd">/</span></label>
          <span class="grow"></span>
          <span class="only-phone">${iconBtn('search', 'Search')}</span>
          ${iconBtn('circle-help', 'Help', { href: go(area === 'seller' ? 'seller/help' : 'help/center') })}
          ${iconBtn('bell', 'Notifications', { count: area === 'seller' ? 4 : 9, href: go(area === 'seller' ? 'seller/notifications' : 'admin/inbox') })}
          <span class="no-phone">${avatar(user.name)}</span>
        </div>${mobileNav(items.concat(area === 'admin' ? [{ key: 'ops', label: 'Work queues', icon: 'clipboard-list', id: 'ops/queues' }] : []), o.active)}</header>
        <main class="bo-content">${content}</main>
      </div>
    </div>`;
  }
  const sellerLayout = (content, active) => boLayout(content, { area: 'seller', active });
  const adminLayout = (content, active) => boLayout(content, { area: 'admin', active });
  const opsLayout = (content, active) => boLayout(content, { area: 'ops', active });

  return {
    // registry
    AREAS, CATALOGUE, screens, register, areaOf, BRAND,
    // primitives
    esc, money, num, go, icon, join, css, logo, LOGO_SVG,
    btn, iconBtn, badge, status, statusTone, STATUS, sponsored,
    img, pimg, avatar, logoTile,
    price, stars, stars5, sellerBadge, sellerLine, shipLine, productCard, qty, countdown, meter,
    card, crumbs, pageHead, sectionHead, tabs, seg, chips, steps, track, timeline, kv, sumRow, stat, queueTile, alert, empty, pager, lazyLoad, deadline,
    table, searchIn, nextId, field, input, select, textarea, check, radio, toggle, optCard, dropzone,
    modal, drawer,
    lineChart, barChart, sparkline, legend, splitBar,
    // layouts
    storeLayout, checkoutLayout, accountLayout, accountNav, storeHeader, storeFooter, tabbar, appbar,
    boLayout, sellerLayout, adminLayout, opsLayout, SELLER_NAV, ADMIN_NAV, OPS_NAV, ACCOUNT_NAV,
  };
})();
