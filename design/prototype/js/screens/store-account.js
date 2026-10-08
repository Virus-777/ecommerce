/* Customer Store · My account (plan ch. 7, 12, 13, 14, 17, 19) */
(function () {
  const U = UI;
  const D = window.D;
  const P = D.P;
  const S = D.sellers;
  const O = D.order;

  U.css('store-account', `
    @container app (max-width: 767.98px) { .acct-h1 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; } }
    .acct-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--sp-3); }
    .acct-head .acts { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .acct-tiles { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 768px) { .acct-tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .acct-tile { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4); border-radius: var(--r-lg); background: var(--surface); border: 1px solid var(--border); color: var(--text) !important; text-decoration: none !important; min-width: 0; }
    .acct-tile:hover { border-color: var(--border-strong); background: var(--surface-2); }
    .acct-tile .ic { width: 36px; height: 36px; border-radius: var(--r-md); background: var(--brand-soft); color: var(--brand-text); display: inline-flex; align-items: center; justify-content: center; }
    .acct-tile .n { font-size: var(--fs-2xl); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
    .acct-ohead { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-5); padding: var(--sp-3) var(--sp-4); background: var(--surface-2); border-bottom: 1px solid var(--border); border-radius: var(--r-lg) var(--r-lg) 0 0; font-size: var(--fs-sm); }
    @container app (min-width: 768px) { .acct-ohead { padding-inline: var(--sp-5); } }
    .acct-k { display: block; font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); font-weight: 700; }
    .acct-ohead .st { margin-left: auto; }
    .acct-pkg { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); }
    .acct-pkg > svg.lucide { color: var(--text-3); }
    .acct-thumbs { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .acct-item { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: var(--sp-3); align-items: start; padding-block: var(--sp-4); border-top: 1px solid var(--border); }
    .acct-item:first-child { border-top: 0; padding-top: 0; }
    .acct-item:last-child { padding-bottom: 0; }
    .acct-item .acts { grid-column: 2; display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .acct-split { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
    .acct-split > aside { display: grid; gap: var(--sp-4); grid-template-columns: minmax(0, 1fr); align-content: start; min-width: 0; }
    @container app (min-width: 768px) and (max-width: 1279.98px) { .acct-split > aside { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @container app (min-width: 1280px) { .acct-split { grid-template-columns: minmax(0, 1fr) 300px; } }
    .acct-ind { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .acct-ind { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .acct-ind > div { padding: var(--sp-3) var(--sp-4); border-radius: var(--r-md); background: var(--surface-2); display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
    .acct-ind .k { font-size: var(--fs-2xs); font-weight: 700; color: var(--text-3); display: flex; align-items: center; gap: 6px; text-transform: uppercase; letter-spacing: 0.06em; }
    .acct-seg-info { background: var(--info) !important; }
    .acct-pkgcard { border-left: 3px solid var(--border-strong); }
    .acct-pkgcard.t-success { border-left-color: var(--success); }
    .acct-pkgcard.t-info { border-left-color: var(--info); }
    .acct-pkgcard.t-warning { border-left-color: var(--warning); }
    .acct-qr { width: 148px; height: 148px; color: var(--text); background: var(--surface); padding: 8px; border-radius: var(--r-md); border: 1px solid var(--border); flex: none; display: block; }
    .acct-menu .menu-list { border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; background: var(--surface); }
    .acct-menu .menu-list > a > svg.lucide:last-child { color: var(--text-3); margin-left: auto; }
    .acct-count { margin-left: auto; font-size: var(--fs-2xs); font-weight: 700; padding: 2px 8px; border-radius: var(--r-pill); background: var(--brand-soft); color: var(--brand-text); }
    .acct-count + svg.lucide { margin-left: 0 !important; }
    .acct-menu .menu-list > a > .grow { flex: 1 1 auto; min-width: 0; }
    .acct-mrow { display: flex; align-items: center; gap: var(--sp-3); min-height: 56px; padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--surface); font-weight: 500; flex-wrap: wrap; }
    .acct-mrow > svg.lucide:first-child { color: var(--text-3); }
    .acct-mrow:last-child { border-bottom: 0; }
    .acct-signout { padding-top: var(--sp-2); }
    .acct-row { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); color: var(--text) !important; text-decoration: none !important; min-width: 0; }
    @container app (min-width: 768px) { .acct-row { padding-inline: var(--sp-5); } }
    .acct-row:last-child { border-bottom: 0; }
    a.acct-row:hover { background: var(--surface-2); }
    .acct-ic { width: 36px; height: 36px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--surface-2); color: var(--text-2); flex: none; }
    .acct-ic.t-warning { background: var(--warning-soft); color: var(--warning); }
    .acct-ic.t-info { background: var(--info-soft); color: var(--info); }
    .acct-ic.t-success { background: var(--success-soft); color: var(--success); }
    .acct-ic.t-danger { background: var(--danger-soft); color: var(--danger); }
    .acct-ic.t-brand { background: var(--brand-soft); color: var(--brand-text); }
    .acct-ic.t-deal { background: var(--deal-soft); color: var(--deal-text); }
    .acct-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--brand); flex: none; margin-top: 7px; }
    .acct-check { display: grid; grid-template-columns: 24px 56px minmax(0, 1fr); gap: var(--sp-3); align-items: start; padding: var(--sp-4); border-top: 1px solid var(--border); }
    .acct-check:first-child { border-top: 0; }
    .acct-check input { width: 18px; height: 18px; margin-top: 4px; accent-color: var(--brand); }
    .acct-check.is-off { background: var(--surface-2); }
    .acct-check .side { grid-column: 3; }
    @container app (min-width: 768px) { .acct-check { grid-template-columns: 24px 56px minmax(0, 1fr) auto; } .acct-check .side { grid-column: auto; text-align: right; } }
    .acct-eligible { border: 1px solid var(--brand); background: var(--brand-soft); border-radius: var(--r-lg); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
    .acct-mini-track { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
    .acct-mini-track span { height: 6px; border-radius: var(--r-pill); background: var(--surface-3); }
    .acct-mini-track .d { background: var(--success); } .acct-mini-track .i { background: var(--info); } .acct-mini-track .w { background: var(--warning); }
  `);

  /* ---------- Shared bits ---------- */
  const go = U.go;
  const money = U.money;
  const ref = (r, href) => href ? `<a class="mono strong" href="${href}">${r}</a>` : `<span class="mono">${r}</span>`;
  const head = (title, sub, actions) => `<div class="acct-head"><div class="stack gap-1"><h1 class="h1 acct-h1">${title}</h1>${sub ? `<p class="small sub">${sub}</p>` : ''}</div>${actions ? `<div class="acts">${actions}</div>` : ''}</div>`;
  const layout = (active, title, content, o = {}) => U.accountLayout(content, { active, title, back: o.back, actionBar: o.actionBar });
  const pname = (p) => `<a class="small strong" style="color:var(--text)" href="${go('store/product')}">${U.esc(p.name)}</a>`;
  const thumb = (p) => `<a href="${go('store/product')}" aria-label="${U.esc(p.name)}">${U.pimg(p, 'thumb')}</a>`;
  const sm = (label, href, o = {}) => U.btn(label, Object.assign({ v: 'secondary', size: 'sm', href }, o));
  const ic = (name, tone) => `<span class="acct-ic${tone ? ' t-' + tone : ''}">${U.icon(name, 'ic-sm')}</span>`;
  const sname = (sid) => S[sid].official ? 'Marketly Official' : S[sid].name;
  // Pseudo QR code for drop-off (deterministic so every render matches)
  function qr(seed) {
    const n = 25; let s = seed; let cells = '';
    const finder = (x, y, ox, oy) => { const dx = x - ox, dy = y - oy; if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return null; return dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4); };
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let on = finder(x, y, 0, 0); if (on === null) on = finder(x, y, n - 7, 0); if (on === null) on = finder(x, y, 0, n - 7);
      if (on === null) { if (x === 7 || y === 7 || (x === n - 8 && y < 8) || (y === n - 8 && x < 8)) on = false; else { s = (s * 9301 + 49297) % 233280; on = s / 233280 > 0.52; } }
      if (on) cells += `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>`;
    }
    return `<svg class="acct-qr" viewBox="0 0 ${n} ${n}" fill="currentColor" role="img" aria-label="Drop-off QR code for RT-260921-0457">${cells}</svg>`;
  }

  /* ---------- Sample records ---------- */
  // Coupon share is the WELCOME20 discount split across items by value (example rule).
  const share = (amount) => Math.round((O.discount * amount / O.subtotal) * 100) / 100;

  const ORDERS = [
    { ref: 'MK-261006-90127', date: 'Oct 6, 2026', total: 88.50, items: ['bottle', 'yogamat'], status: 'Preparing', pkgs: [{ seller: 'trailhead', status: 'Preparing', note: 'Ships by Fri, Oct 9' }], acts: ['view', 'cancel'] },
    { ref: 'MK-260914-48213', date: 'Sep 14, 2026', total: 513.98, items: ['aurora', 'pourover', 'ssd1tb', 'duvet'], status: 'Partly delivered', pkgs: [{ seller: 'official', status: 'Delivered', note: 'Delivered Sep 17' }, { seller: 'pixelport', status: 'In transit', note: 'Arrives Oct 9–10' }, { seller: 'casaverde', status: 'Delayed', note: 'Now due Oct 12' }], note: '1 return open: RT-260921-0457', acts: ['view', 'track', 'return'] },
    { ref: 'MK-260830-11764', date: 'Aug 30, 2026', total: 58.00, items: ['skillet'], status: 'Delivered', pkgs: [{ seller: 'official', status: 'Delivered', note: 'Delivered Sep 2' }], note: 'Return window closed Oct 2', acts: ['view', 'review', 'again'] },
    { ref: 'MK-260818-07352', date: 'Aug 18, 2026', total: 139.00, items: ['backpack'], status: 'Refunded', pkgs: [{ seller: 'trailhead', status: 'Delivered', note: 'Delivered Aug 21' }], note: 'Returned. Refund of $139.00 sent Sep 4 to Visa •••• 4417', acts: ['view', 'again'] },
    { ref: 'MK-260811-03309', date: 'Aug 11, 2026', total: 112.00, items: ['shoes'], status: 'Cancelled', pkgs: [{ seller: 'trailhead', status: 'Cancelled', note: 'Cancelled before shipping' }], note: 'You cancelled on Aug 11. Refund of $112.00 sent Aug 12.', acts: ['view', 'again'] },
  ];

  const RET_TONE = { Requested: 'info', Approved: 'success', 'Sent back': 'info', Received: 'info', Inspected: 'info', Refunded: 'success', Rejected: 'danger' };
  const retStatus = (s) => U.status(s, RET_TONE[s] ?? '');
  const REFUND_TONE = { Requested: 'info', 'Under review': 'info', Approved: 'success', Processing: 'info', Sent: 'success', Failed: 'danger' };
  const refundStatus = (s) => U.status(s, REFUND_TONE[s] ?? '');
  const RETURNS = [
    { ref: 'RT-261007-0533', p: 'speaker', seller: 'northwind', order: 'MK-260927-52240', opened: 'Oct 7', ret: 'Requested', refund: 'Requested', amount: 59.00, next: 'Northwind Audio responds by Fri, Oct 9, 5:00 PM PT. Marketly steps in if they miss it.', open: true },
    { ref: 'RT-260921-0457', p: 'pourover', seller: 'official', order: 'MK-260914-48213', opened: 'Sep 21', ret: 'Approved', refund: 'Requested', amount: 34.65, next: 'Drop it off at any UPS location by Thu, Oct 15. Use the QR code.', open: true, href: go('account/return') },
    { ref: 'RT-261002-0520', p: 'keyboard', seller: 'pixelport', order: 'MK-260920-33018', opened: 'Oct 2', ret: 'Received', refund: 'Processing', amount: 109.00, next: 'Nothing to do. The refund should reach your card by Oct 14.', open: true },
    { ref: 'RT-260823-0311', p: 'backpack', seller: 'trailhead', order: 'MK-260818-07352', opened: 'Aug 23', ret: 'Refunded', refund: 'Sent', amount: 139.00, next: 'Refund sent Sep 4 to Visa •••• 4417.', open: false },
    { ref: 'RT-260709-0144', p: 'sweater', seller: 'official', order: 'MK-260702-00418', opened: 'Jul 9', ret: 'Refunded', refund: 'Sent', amount: 84.00, next: 'Refund sent Jul 16 to Visa •••• 4417.', open: false },
  ];

  /* ==================================================================
     1. Overview (Account tab root)
     ================================================================== */
  const tile = (icn, n, label, sub, href) => `<a class="acct-tile" href="${href}"><span class="ic">${U.icon(icn, 'ic-sm')}</span><span class="n">${n}</span><span class="stack gap-0"><span class="small strong">${label}</span><span class="xs muted">${sub}</span></span></a>`;
  const itemSummary = (o) => {
    if (o.ref === O.ref) return `${U.badge('1 delivered', 'success')}${U.badge('1 return requested', 'warning')}${U.badge('2 in transit', 'info')}${U.badge('1 delayed', 'warning')}`;
    if (o.status === 'Preparing') return U.badge('2 preparing', 'info');
    if (o.status === 'Delivered') return U.badge('1 delivered', 'success');
    if (o.status === 'Refunded') return U.badge('1 returned and refunded', '');
    return U.badge('1 cancelled', '');
  };
  function menuList() {
    const groups = []; let cur = null;
    U.ACCOUNT_NAV.forEach((n) => { if (n.grp) { cur = { grp: n.grp, items: [] }; groups.push(cur); } else cur.items.push(n); });
    return `<nav class="acct-menu stack gap-4 no-desktop" aria-label="Account menu">
      ${groups.map((g) => `<div class="stack gap-2"><h2 class="eyebrow">${g.grp}</h2><div class="menu-list">${g.items.map((n) => `<a href="${go(n.id)}">${U.icon(n.icon)}<span>${n.label}</span>${n.count ? `<span class="acct-count">${n.count}</span>` : ''}${U.icon('chevron-right', 'ic-sm')}</a>`).join('')}</div></div>`).join('')}
      <div class="stack gap-2 no-phone"><h2 class="eyebrow">Help</h2><div class="menu-list">
        <a href="${go('help/center')}">${U.icon('circle-help')}<span>Help Center</span>${U.icon('chevron-right', 'ic-sm')}</a>
        <a href="${go('auth/sign-in')}">${U.icon('log-out')}<span>Sign out</span>${U.icon('chevron-right', 'ic-sm')}</a>
      </div></div>
      <div class="stack gap-4 only-phone">
      ${appGroup('Help and support', [
        ['circle-help', 'Help Center', 'help/center'],
        ['headset', 'Contact us', 'help/contact', 'Mon–Sat, 8 AM–8 PM PT'],
      ])}
      ${appGroup('Selling', [
        ['store', 'Sell on ' + U.BRAND, 'sell/landing', 'Requirements, fees and how to apply'],
        ['layout-dashboard', 'Seller Center', 'seller/dashboard', 'For approved sellers'],
      ])}
      ${appGroup('About and policies', [
        ['info', 'About ' + U.BRAND, 'info/about'],
        ['truck', 'Shipping policy', 'info/policy', null, 'Shipping'],
        ['undo-2', 'Returns policy', 'info/policy', null, 'Returns'],
        ['shield', 'Privacy', 'info/policy', null, 'Privacy'],
        ['file-text', 'Purchase terms', 'info/policy', null, 'Purchase terms'],
        ['scale', 'Seller rules', 'info/policy', null, 'Seller rules'],
      ])}
      <div class="stack gap-2"><h2 class="eyebrow">App settings</h2><div class="menu-list">
        <div class="acct-mrow">${U.icon('sun-moon')}<span class="grow">Appearance</span>${U.seg(['System', 'Light', 'Dark'], 0)}</div>
        <div class="acct-mrow" aria-disabled="true" style="color:var(--text-3)">${U.icon('bell-ring')}<span class="stack gap-0 grow"><span>Push notifications</span><span class="xs muted">Order updates on this device · Coming in a later release</span></span>${U.badge('Later', 'outline')}</div>
      </div></div>
      <div class="stack gap-3 acct-signout">
        ${U.btn('Sign out', { v: 'secondary', block: true, icon: 'log-out', href: go('auth/sign-in') })}
        <p class="xs muted center">${U.BRAND} for Android · version 1.0.0 (prototype)<br>© 2026 ${U.BRAND}, Inc.</p>
      </div>
      </div>
    </nav>`;
  }
  // Menu group for the Account tab. Rows: [icon, label, screen id, optional sub-label, optional state]
  function appGroup(title, rows) {
    return `<div class="stack gap-2"><h2 class="eyebrow">${title}</h2><div class="menu-list">${rows.map(([icn, label, id, sub, st]) => `<a href="${go(id, st)}">${U.icon(icn)}${sub ? `<span class="stack gap-0 grow"><span>${label}</span><span class="xs muted">${sub}</span></span>` : `<span class="grow">${label}</span>`}${U.icon('chevron-right', 'ic-sm')}</a>`).join('')}</div></div>`;
  }

  U.register({
    id: 'account/overview', title: 'Account overview', ref: 'Plan ch. 7, 17',
    notes: 'Account home: status tiles, recent orders with item-level summaries, open cases and returns. On phone and tablet this is the Account tab and carries the full account menu, since the side menu only shows on desktop.',
    render: () => layout('overview', null, `
      <div class="acct-head">
        <div class="row gap-3 nowrap">${U.avatar(D.customer.name, 'lg')}<div class="stack gap-0"><h1 class="h2">Hi, ${D.customer.first}</h1><span class="small sub">${D.customer.email} · Member since ${D.customer.since}</span></div></div>
        <div class="acts no-phone">${U.btn('Track a package', { v: 'secondary', size: 'sm', icon: 'truck', href: go('account/tracking') })}${U.btn('Start a return', { v: 'secondary', size: 'sm', icon: 'undo-2', href: go('account/return-new') })}</div>
      </div>

      <div class="acct-tiles">
        ${tile('package', 2, 'Orders in progress', '1 package delayed', go('account/orders', 'Orders'))}
        ${tile('undo-2', 3, 'Open returns', '1 needs drop-off', go('account/returns'))}
        ${tile('message-square', 2, 'Unread messages', 'Casa Verde, Support', go('account/messages'))}
        ${tile('wallet', money(15), 'Store credit', 'Use it at checkout', go('account/coupons'))}
      </div>

      ${U.alert('warning', 'Your duvet cover is delayed', `Casa Verde Home now expects to ship it by Sat, Oct 10 (arrives Mon, Oct 12). <a href="${go('account/order')}">See your options</a>: wait, cancel this item for a full refund, or follow support case <a class="mono" href="${go('help/case')}">CS-261005-3381</a>.`)}

      ${U.card({ title: 'Recent orders', actions: `<a class="small strong" href="${go('account/orders')}">All orders</a>`, flush: true, body: `<div>${ORDERS.slice(0, 3).map((o) => `
        <a class="acct-row" href="${go('account/order')}">
          <span class="acct-thumbs none">${o.items.slice(0, 3).map((id) => U.pimg(P[id], 'tiny')).join('')}</span>
          <span class="stack gap-1 grow">
            <span class="row gap-2 between"><span class="mono small strong">${o.ref}</span>${U.status(o.status)}</span>
            <span class="xs muted">Placed ${o.date} · ${money(o.total)} · ${o.pkgs.length} ${o.pkgs.length > 1 ? 'packages' : 'package'}</span>
            <span class="row gap-1">${itemSummary(o)}</span>
          </span>
        </a>`).join('')}</div>` })}

      <div class="grid lg2">
        ${U.card({ title: 'Open support cases', actions: `<a class="small strong" href="${go('help/cases')}">All cases</a>`, flush: true, body: `
          <a class="acct-row" href="${go('help/case')}">${ic('life-buoy', 'warning')}<span class="stack gap-1 grow"><span class="row between gap-2"><span class="small strong">Duvet cover hasn't shipped</span>${U.status('Waiting on seller')}</span><span class="xs muted"><span class="mono">CS-261005-3381</span> · Order <span class="mono">MK-260914-48213</span> · Casa Verde Home</span><span class="xs sub">Handled by Isabel C., Marketly Support. Next update by Fri, Oct 9, 12:00 PM PT.</span></span></a>` })}
        ${U.card({ title: 'Returns and refunds', actions: `<a class="small strong" href="${go('account/returns')}">All returns</a>`, flush: true, body: RETURNS.filter((r) => r.open).slice(0, 2).map((r) => `
          <a class="acct-row" href="${go('account/return')}">${U.pimg(P[r.p], 'tiny')}<span class="stack gap-1 grow"><span class="small strong truncate">${U.esc(P[r.p].name)}</span><span class="row gap-2 xs muted">Return ${retStatus(r.ret)} Refund ${refundStatus(r.refund)}</span></span></a>`).join('') })}
      </div>

      ${menuList()}
    `),
  });

  /* ==================================================================
     2. Orders
     ================================================================== */
  const orderActs = (o) => o.acts.map((a) => ({
    view: U.btn('View order', { v: 'primary', size: 'sm', href: go('account/order') }),
    track: sm('Track package', go('account/tracking'), { icon: 'truck' }),
    return: sm('Return items', go('account/return-new'), { icon: 'undo-2' }),
    cancel: sm('Cancel items', go('account/cancel')),
    review: sm('Write a review', go('account/review'), { icon: 'star' }),
    again: U.btn('Buy again', { v: 'ghost', size: 'sm', icon: 'rotate-ccw', href: go('store/product') }),
  }[a])).join('');
  const orderCard = (o) => {
    const nSellers = new Set(o.pkgs.map((k) => k.seller)).size;
    return `<article class="card">
      <div class="acct-ohead">
        <div><span class="acct-k">Order</span>${ref(o.ref, go('account/order'))}</div>
        <div><span class="acct-k">Placed</span>${o.date}</div>
        <div><span class="acct-k">Total</span><span class="num strong">${money(o.total)}</span></div>
        <div><span class="acct-k">Sellers</span>${nSellers} ${nSellers > 1 ? 'sellers' : 'seller'} · ${o.pkgs.length} ${o.pkgs.length > 1 ? 'packages' : 'package'}</div>
        <div class="st">${U.status(o.status)}</div>
      </div>
      <div class="card-body">
        <div class="row top between gap-4">
          <div class="stack gap-2 grow" style="min-width:240px">${o.pkgs.map((k, i) => `<div class="acct-pkg">${U.icon('package', 'ic-sm')}<span class="strong">${o.pkgs.length > 1 ? `Package ${i + 1}` : 'Package'}</span><span class="muted">${sname(k.seller)}</span>${U.status(k.status)}<span class="xs sub">${k.note}</span></div>`).join('')}</div>
          <div class="acct-thumbs">${o.items.map((id) => thumb(P[id])).join('')}</div>
        </div>
        ${o.note ? `<span class="xs sub">${o.note}</span>` : ''}
      </div>
      <div class="card-foot" style="justify-content:flex-start">${orderActs(o)}</div>
    </article>`;
  };

  U.register({
    id: 'account/orders', title: 'Orders', ref: 'Plan ch. 7',
    notes: 'Order history with search by order reference or product, date range and status filters. Each card shows sellers, packages and a status per package, so a mixed order reads as partly delivered rather than a single state.',
    states: ['Orders', 'No matches'],
    render: (state) => {
      const none = state === 'No matches';
      return layout('orders', 'Orders', `
        ${head('Orders', '23 orders since Aug 2026. Each order can have several sellers and packages.')}
        <div class="toolbar">
          <label class="search-in" for="ord-q">${U.icon('search', 'ic-sm')}<input id="ord-q" type="search" placeholder="Search by order number or product" value="${none ? 'standing desk' : ''}"></label>
          <label class="sr-only" for="ord-range">Date range</label>${U.select('ord-range', ['Last 3 months', 'Last 30 days', 'Last 6 months', '2026', 'All time'], none ? 'Last 30 days' : 'Last 3 months')}
        </div>
        ${U.tabs([{ label: 'All', count: none ? 0 : 23 }, { label: 'In progress', count: 2 }, { label: 'Delivered', count: 18 }, { label: 'Returns', count: 3 }, { label: 'Cancelled', count: 1 }], 0)}
        ${none ? `<div class="card">${U.empty('search-x', 'No orders match "standing desk"', 'Nothing in the last 30 days matches that search. Try the order number from your confirmation email, or widen the date range.', `<div class="row gap-2" style="justify-content:center">${U.btn('Clear filters', { href: go('account/orders', 'Orders') })}${U.btn('Look up a guest order', { v: 'secondary', href: go('auth/guest-orders') })}</div>`)}</div>`
        : `<div class="stack gap-4">${ORDERS.map(orderCard).join('')}</div>
        <div class="row between"><span class="small muted">Showing 1–5 of 23 orders</span>${U.pager(1, 5)}</div>`}
      `);
    },
  });

  /* ==================================================================
     3. Order detail
     ================================================================== */
  const itemActs = {
    aurora: [sm('Write a review', go('account/review'), { icon: 'star' }), sm('Return item', go('account/return-new'), { icon: 'undo-2' }), U.btn('Report a problem', { v: 'ghost', size: 'sm', href: go('help/order-problem') })],
    pourover: [sm('View return', go('account/return'), { icon: 'undo-2' }), U.btn('Report a problem', { v: 'ghost', size: 'sm', href: go('help/order-problem') })],
    ssd1tb: [sm('Track package', go('account/tracking'), { icon: 'truck' }), U.btn('Report a problem', { v: 'ghost', size: 'sm', href: go('help/order-problem') })],
    duvet: [sm('Cancel item', go('account/cancel'), { icon: 'x' }), U.btn('Report a problem', { v: 'ghost', size: 'sm', href: go('help/order-problem') })],
  };
  const itemNote = {
    aurora: 'Delivered Sep 17. Return by Sat, Oct 17.',
    pourover: `Return <a class="mono" href="${go('account/return')}">RT-260921-0457</a> approved. Drop off by Oct 15. Refund after inspection.`,
    ssd1tb: 'Shipped Oct 6. Can\'t be cancelled now. You can return it after delivery.',
    duvet: 'Not shipped yet. You can cancel it until Casa Verde ships it.',
  };
  const pkgTone = { Delivered: 'success', Shipped: 'info', Delayed: 'warning' };
  const pkgTrack = (g) => g.status === 'Delivered' ? U.track(['Confirmed', 'Shipped', 'In transit', 'Delivered'], 4)
    : g.status === 'Shipped' ? U.track(['Confirmed', 'Shipped', 'In transit', 'Delivered'], 3)
      : U.track(['Confirmed', 'Preparing', 'Shipped', 'Delivered'], 2, { tone: 'warning' });

  function packageCard(g) {
    const s = S[g.seller];
    const sub = g.tracking ? `${g.carrier} · <span class="mono">${g.tracking}</span>` : 'No tracking yet. The seller hasn\'t shipped this package.';
    return `<section class="card acct-pkgcard t-${pkgTone[g.status]}">
      <div class="card-head">
        <div class="row gap-3 nowrap" style="min-width:0">${U.logoTile(s)}<div class="stack gap-1" style="min-width:0"><span class="row gap-2"><h3 class="h4">${g.pkg}</h3>${U.status(g.status === 'Shipped' ? 'In transit' : g.status)}</span><span class="row gap-2 xs muted">Sold and shipped by <b class="sub">${sname(g.seller)}</b>${U.sellerBadge(s, true)}</span></div></div>
        <div class="stack gap-0 right"><span class="small strong">${g.eta}</span><span class="xs muted">${sub}</span></div>
      </div>
      <div class="card-body">
        ${pkgTrack(g)}
        ${g.status === 'Delayed' ? U.alert('warning', 'This package is late', `Casa Verde Home missed its dispatch date of Sep 18. New estimate: arrives Mon, Oct 12. If it hasn't shipped by Sat, Oct 10, Marketly support will cancel it for a full refund or arrange a replacement. Your case <a class="mono" href="${go('help/case')}">CS-261005-3381</a> is open, next update by Fri, Oct 9, 12:00 PM PT.`) : ''}
        <div>${g.items.map((it) => { const p = P[it.p]; return `
          <div class="acct-item">
            ${thumb(p)}
            <div class="stack gap-1">
              ${pname(p)}
              <span class="xs muted">${it.variant} · Qty ${it.qty} · <span class="num">${money(it.price * it.qty)}</span></span>
              <span class="row gap-2">${U.status(it.state)}<span class="xs sub">${itemNote[it.p]}</span></span>
            </div>
            <div class="acts">${itemActs[it.p].join('')}</div>
          </div>`; }).join('')}</div>
      </div>
      <div class="card-foot" style="justify-content:space-between">
        <span class="xs muted">${g.seller === 'official' ? 'Official Store item. Marketly handles returns.' : `${U.esc(s.name)} handles this package. Marketly support can step in.`}</span>
        <span class="row gap-2">${U.btn('Contact seller', { v: 'ghost', size: 'sm', icon: 'message-square', href: go('account/messages') })}${g.status === 'Delayed' ? U.btn('Get help with this package', { v: 'soft', size: 'sm', icon: 'life-buoy', href: go('help/case') }) : ''}</span>
      </div>
    </section>`;
  }

  U.register({
    id: 'account/order', title: 'Order details', ref: 'Plan ch. 7, 12, 14',
    notes: 'A mixed order: Official Store plus two sellers in three packages (acceptance scenario 1). Payment, delivery and return progress stay separate, and every item carries its own state and actions. The late package shows a revised date and a support escalation route (scenario 5).',
    render: () => {
      const ret = share(36);
      return layout('orders', 'Order details', `
        ${U.crumbs([{ label: 'Orders', href: go('account/orders') }, { label: O.ref }])}
        <div class="acct-head">
          <div class="stack gap-1"><h1 class="h1 acct-h1">Order <span class="mono">${O.ref}</span></h1><p class="small sub only-phone mono">${O.ref}</p><p class="small sub">Placed ${O.placed} PT · 4 items from 3 sellers · ${money(O.total)}</p></div>
          <div class="acts">${U.btn('Download receipt', { v: 'secondary', size: 'sm', icon: 'download' })}${U.btn('Get help', { v: 'soft', size: 'sm', icon: 'life-buoy', href: go('help/order-problem') })}</div>
        </div>

        <section class="card pad stack gap-4" aria-label="Order status">
          <div class="row between"><span class="row gap-2"><span class="small sub">Overall</span>${U.status(O.status)}</span><span class="xs muted">1 of 3 packages delivered · 1 return open</span></div>
          <div class="acct-ind">
            <div><span class="k">${U.icon('credit-card', 'ic-sm')}Payment</span><span class="row gap-2">${U.status('Accepted')}<span class="small strong num">${money(O.total)}</span></span><span class="xs sub">${O.payment} charged Sep 14. No refunds sent yet.</span></div>
            <div><span class="k">${U.icon('truck', 'ic-sm')}Delivery</span><span class="row gap-2">${U.status('Partly delivered')}</span><div class="acct-mini-track" role="img" aria-label="Package 1 delivered, package 2 in transit, package 3 delayed"><span class="d"></span><span class="i"></span><span class="w"></span></div><span class="xs sub">Delivered · In transit · Delayed</span></div>
            <div><span class="k">${U.icon('undo-2', 'ic-sm')}Returns and refunds</span><span class="row gap-2">${retStatus('Approved')}<span class="xs muted">1 item</span></span><span class="xs sub">Pour-over set, <a class="mono" href="${go('account/return')}">RT-260921-0457</a>. Refund of about ${money(36 - ret)} after inspection.</span></div>
          </div>
        </section>

        <div class="acct-split">
          <div class="stack gap-4">${O.groups.map(packageCard).join('')}</div>
          <aside>
            ${U.card({ title: 'Payment summary', body: `
              ${U.sumRow('Items (5)', money(O.subtotal))}
              ${U.sumRow(`Coupon <span class="mono">${O.coupon}</span>`, '−' + money(O.discount), 'discount')}
              ${U.sumRow('Shipping (3 packages)', 'Free')}
              ${U.sumRow('Sales tax (OR)', money(O.tax))}
              <hr>${U.sumRow('Order total', money(O.total), 'total')}
              ${U.sumRow('Paid with', O.payment)}
              <hr>${U.sumRow('Refunded so far', money(0))}
              ${U.sumRow('Expected refund, RT-260921-0457', money(36 - ret))}
              <span class="xs muted">Refunds return to the card you paid with. A partial refund only affects the items it covers.</span>` })}
            ${U.card({ title: 'Delivery address', body: `<address class="small" style="font-style:normal">${D.customer.addresses[0].name}<br>${D.customer.addresses[0].line1}<br>${D.customer.addresses[0].city}<br>${D.customer.addresses[0].phone}</address><span class="xs muted">To change where a package goes, contact the seller before it ships. Address book changes don't affect this order.</span>` })}
            ${U.card({ title: 'Documents', flush: true, body: `<div class="list pad">
              <a class="li" href="javascript:void 0">${U.icon('receipt', 'ic-sm')}<span class="grow small">Order receipt</span><span class="xs muted">PDF</span>${U.icon('download', 'ic-sm')}</a>
              <a class="li" href="javascript:void 0">${U.icon('file-text', 'ic-sm')}<span class="grow small">Invoice, Marketly Official</span><span class="xs muted">PDF</span>${U.icon('download', 'ic-sm')}</a>
              <a class="li" href="javascript:void 0">${U.icon('file-text', 'ic-sm')}<span class="grow small">Invoice, Pixel &amp; Port</span><span class="xs muted">PDF</span>${U.icon('download', 'ic-sm')}</a>
              <a class="li" href="javascript:void 0">${U.icon('file-text', 'ic-sm')}<span class="grow small">Invoice, Casa Verde Home</span><span class="xs muted">PDF</span>${U.icon('download', 'ic-sm')}</a></div>` })}
            ${U.card({ title: 'Need help with this order?', body: `<p class="small sub">Pick the item and tell us what happened. We'll bring in the seller if needed.</p>
              <div class="stack gap-2">${U.btn('Report a problem', { v: 'secondary', block: true, icon: 'circle-alert', href: go('help/order-problem') })}${U.btn('View case CS-261005-3381', { v: 'ghost', block: true, href: go('help/case') })}</div>` })}
          </aside>
        </div>
      `);
    },
  });

  /* ==================================================================
     4. Tracking
     ================================================================== */
  const G2 = O.groups[1];
  U.register({
    id: 'account/tracking', title: 'Track package', ref: 'Plan ch. 7, 12',
    notes: 'One package of a multi-seller order: carrier, tracking number, contents and estimate, with an event timeline. The failed-delivery state lists next steps (redelivery, pickup, return to seller) with their costs, as plan ch. 12 requires.',
    states: ['In transit', 'Delivery failed'],
    render: (state) => {
      const failed = state === 'Delivery failed';
      const events = failed ? [
        { t: 'Delivery attempted. Signature required, no one available', d: 'Fri, Oct 9, 2:14 PM · Portland, OR 97205', state: 'danger', body: 'USPS left a notice. The package is at the Portland Main Post Office.' },
        { t: 'Out for delivery', d: 'Fri, Oct 9, 7:58 AM · Portland, OR 97205', state: 'done' },
      ] : [
        { t: 'Arrived at USPS regional facility', d: 'Thu, Oct 8, 6:12 AM · Portland, OR', state: 'current', body: 'On schedule. Out for delivery Fri, Oct 9 or Sat, Oct 10.' },
      ];
      const all = events.concat([
        { t: 'Departed USPS facility', d: 'Wed, Oct 7, 9:40 PM · Denver, CO', state: 'done' },
        { t: 'Accepted at USPS origin facility', d: 'Tue, Oct 6, 5:05 PM · Austin, TX', state: 'done' },
        { t: 'Shipping label created by Pixel & Port', d: 'Tue, Oct 6, 11:22 AM', state: 'done' },
        { t: 'Order placed', d: 'Mon, Sep 14, 7:42 PM', state: 'done' },
      ]);
      return layout('orders', 'Track package', `
        ${U.crumbs([{ label: 'Orders', href: go('account/orders') }, { label: O.ref, href: go('account/order') }, { label: 'Package 2 of 3' }])}
        ${head('Track package', `Package 2 of 3 · Order <a class="mono" href="${go('account/order')}">${O.ref}</a>`)}
        ${failed ? U.alert('danger', 'Delivery failed. Choose what happens next by Fri, Oct 23', 'USPS couldn\'t deliver because this package needs a signature. Nothing has been lost. Pick an option below and we\'ll pass it to USPS and Pixel &amp; Port.') : ''}
        <div class="acct-split">
          <div class="stack gap-4">
            <section class="card pad stack gap-4">
              <div class="row between top">
                <div class="stack gap-1"><span class="eyebrow">${failed ? 'Delivery attempt failed' : 'Estimated delivery'}</span><span class="h2">${failed ? 'Waiting for your choice' : 'Fri, Oct 9 – Sat, Oct 10'}</span><span class="small sub">${failed ? 'Held at Portland Main Post Office until Fri, Oct 23' : 'By 8:00 PM · to Jordan Lee, Portland, OR 97205'}</span></div>
                ${U.status(failed ? 'Delivery failed' : 'In transit')}
              </div>
              ${U.track(['Shipped', 'In transit', 'Out for delivery', 'Delivered'], failed ? 3 : 2, failed ? { tone: 'danger' } : {})}
              <div class="grid md2" style="--gap:12px">
                <div class="panel stack gap-1"><span class="acct-k">Carrier</span><span class="small strong">${G2.carrier} Mail</span><a class="xs" href="javascript:void 0">Open on usps.com ${U.icon('external-link', 'ic-sm')}</a></div>
                <div class="panel stack gap-1"><span class="acct-k">Tracking number</span><span class="row gap-1 nowrap"><span class="mono small strong">${G2.tracking}</span>${U.iconBtn('copy', 'Copy tracking number')}</span></div>
              </div>
            </section>

            ${failed ? U.card({ title: 'Choose next step', sub: 'Example costs. Final costs follow the carrier and seller terms.', body: `
              <div class="stack gap-2" role="radiogroup" aria-label="Next step">
                ${U.optCard('fail', 'fail-redel', '<span class="strong">Schedule redelivery</span>', 'USPS tries again on Sat, Oct 10 or Mon, Oct 12. Someone 18+ must sign.', true, { right: '<span class="small strong">Free</span>' })}
                ${U.optCard('fail', 'fail-pickup', '<span class="strong">Pick it up at the post office</span>', 'Portland Main Post Office, 715 NW Hoyt St. Ready from Sat, Oct 10, 9:00 AM. Bring photo ID.', false, { right: '<span class="small strong">Free</span>' })}
                ${U.optCard('fail', 'fail-return', '<span class="strong">Send it back to Pixel &amp; Port</span>', 'You get a refund of $189.98 when it reaches the seller. If you don\'t choose by Oct 23, USPS returns it and the seller may deduct return shipping.', false, { right: '<span class="small strong">$0.00 now<br><span class="xs muted">$8.40 if auto-returned</span></span>' })}
              </div>
              ${U.field('Date for redelivery', U.select('fail-date', ['Sat, Oct 10', 'Mon, Oct 12'], 'Sat, Oct 10'))}`, foot: U.btn('Confirm redelivery', { icon: 'check' }) }) : ''}

            ${U.card({ title: 'Tracking history', sub: 'Times in Pacific Time. Updates come from USPS.', body: U.timeline(all) })}
          </div>
          <aside>
            ${U.card({ title: 'In this package', body: `${G2.items.map((it) => `<div class="row gap-3 nowrap top">${thumb(P[it.p])}<div class="stack gap-1">${pname(P[it.p])}<span class="xs muted">${it.variant} · Qty ${it.qty}</span>${U.sellerLine(G2.seller)}</div></div>`).join('')}
              <span class="xs muted">Ships from Austin, TX. Other items in this order travel in separate packages.</span>` })}
            ${U.card({ title: 'Other packages', flush: true, body: `<div class="list pad">
              <a class="li" href="${go('account/order')}"><span class="grow small">Package 1 · Marketly Official</span>${U.status('Delivered')}</a>
              <a class="li" href="${go('account/order')}"><span class="grow small">Package 3 · Casa Verde Home</span>${U.status('Delayed')}</a></div>` })}
            ${U.card({ title: 'Something wrong?', body: `<div class="stack gap-2">
              ${U.btn('Report missing or damaged', { v: 'secondary', block: true, icon: 'package-x', href: go('help/order-problem') })}
              ${U.btn('Contact Pixel & Port', { v: 'secondary', block: true, icon: 'message-square', href: go('account/messages') })}
              ${U.btn('Get help from Marketly', { v: 'ghost', block: true, icon: 'life-buoy', href: go('help/contact') })}</div>
              <span class="xs muted">If tracking shows delivered but you don't have it, wait until the end of the next day, then report it.</span>` })}
          </aside>
        </div>
      `);
    },
  });

  /* ==================================================================
     5. Cancel items
     ================================================================== */
  U.register({
    id: 'account/cancel', title: 'Cancel items', ref: 'Plan ch. 7, 12, 13',
    notes: 'Cancel only the eligible items of an order (acceptance scenario 4). Shipped and delivered items explain the return route instead, the refund preview shows the coupon share deducted, and the requested state shows the seller confirmation deadline and refund status.',
    states: ['Select items', 'Cancellation requested'],
    render: (state) => {
      const duvetShare = share(119);
      const refund = 119 - duvetShare;
      if (state === 'Cancellation requested') {
        return layout('orders', 'Cancellation requested', `
          ${U.crumbs([{ label: 'Orders', href: go('account/orders') }, { label: O.ref, href: go('account/order') }, { label: 'Cancel items' }])}
          ${head('Cancellation requested', `Order <span class="mono">${O.ref}</span> · requested Thu, Oct 8, 2:31 PM PT`)}
          ${U.alert('success', 'We sent your request to Casa Verde Home', 'Your other items are not affected. Package 2 is still on its way and your return for the pour-over set continues as before.')}
          <div class="acct-split">
            <div class="stack gap-4">
              ${U.card({ title: 'Item being cancelled', body: `<div class="row gap-3 nowrap top">${thumb(P.duvet)}<div class="stack gap-1 grow">${pname(P.duvet)}<span class="xs muted">Queen · Sage · Qty 1</span>${U.sellerLine('casaverde')}</div>${U.status('Cancellation requested')}</div>` })}
              ${U.card({ title: 'What happens next', body: U.timeline([
                { t: 'You requested the cancellation', d: 'Thu, Oct 8, 2:31 PM', state: 'done' },
                { t: 'Casa Verde Home confirms', d: 'By Fri, Oct 9, 5:00 PM PT', state: 'current', body: 'The item hasn\'t shipped, so the seller should confirm. If they don\'t reply in time, Marketly cancels it for you.' },
                { t: 'Refund is processed', d: 'Within 1 business day of confirmation', body: 'Refund status changes to Processing.' },
                { t: 'Refund sent to Visa •••• 4417', d: 'Status changes to Sent', body: 'Your bank usually shows it within 3–5 business days after it\'s sent.' },
              ]) })}
            </div>
            <aside>
              ${U.card({ title: 'Refund', body: `
                <div class="row between"><span class="small sub">Refund status</span>${refundStatus('Requested')}</div>
                ${U.sumRow('Duvet cover', money(119))}${U.sumRow('Coupon share (WELCOME20)', '−' + money(duvetShare))}${U.sumRow('Shipping', money(0))}
                <hr>${U.sumRow('Refund amount', money(refund), 'total')}
                ${U.sumRow('Goes to', O.payment)}
                <span class="xs muted">Requested means no money has moved yet. We'll notify you at each step.</span>` })}
              <div class="stack gap-2">${U.btn('Back to order', { block: true, href: go('account/order') })}${U.btn('Message Casa Verde Home', { v: 'secondary', block: true, icon: 'message-square', href: go('account/messages') })}</div>
              <span class="xs muted">If the seller ships before confirming, you can refuse the delivery or return it free of charge.</span>
            </aside>
          </div>
        `);
      }
      const row = (p, it, o) => `<div class="acct-check${o.off ? ' is-off' : ''}">
        <input type="checkbox" id="cx-${p.id}" aria-label="Cancel ${U.esc(p.name)}"${o.checked ? ' checked' : ''}${o.off ? ' disabled' : ''}>
        ${U.pimg(p, 'thumb')}
        <div class="stack gap-1"><label for="cx-${p.id}" class="small strong">${U.esc(p.name)}</label><span class="xs muted">${it.variant} · Qty ${it.qty} · ${sname(o.seller)}</span><span class="row gap-2">${U.status(it.state)}<span class="xs ${o.off ? 'sub' : 't-success-text strong'}">${o.why}</span></span>${o.link || ''}</div>
        <div class="side stack gap-0">${o.off ? '<span class="xs muted">Not eligible</span>' : `<span class="small strong num">${money(it.price * it.qty)}</span><span class="xs muted">Refund ${money(refund)}</span>`}</div>
      </div>`;
      const g = O.groups;
      const bar = `<span class="stack gap-0 grow"><span class="xs muted">Refund estimate</span><span class="strong num">${money(refund)}</span></span>${U.btn('Request cancellation', { href: go('account/cancel', 'Cancellation requested') })}`;
      return layout('orders', 'Cancel items', `
        ${U.crumbs([{ label: 'Orders', href: go('account/orders') }, { label: O.ref, href: go('account/order') }, { label: 'Cancel items' }])}
        ${head('Cancel items', `Order <span class="mono">${O.ref}</span> · choose only the items you want to cancel. Other items continue as normal.`)}
        ${U.alert('info', 'Cancellation cutoff: before the seller ships', 'You can cancel an item until its seller marks it shipped. After that, you can refuse delivery or return it once it arrives.')}
        <div class="acct-split">
          <div class="stack gap-4">
            <section class="card" aria-label="Items in this order">
              ${row(P.duvet, g[2].items[0], { seller: 'casaverde', checked: true, why: 'Not shipped yet. Free to cancel.' })}
              ${row(P.ssd1tb, g[1].items[0], { seller: 'pixelport', off: true, why: 'Already shipped. You can return it after delivery.', link: `<a class="xs strong" href="${go('account/tracking')}">Track package</a>` })}
              ${row(P.aurora, g[0].items[0], { seller: 'official', off: true, why: 'Delivered Sep 17. Return it instead, by Oct 17.', link: `<a class="xs strong" href="${go('account/return-new')}">Return item</a>` })}
              ${row(P.pourover, g[0].items[1], { seller: 'official', off: true, why: 'Return RT-260921-0457 is already open.', link: `<a class="xs strong" href="${go('account/return')}">View return</a>` })}
            </section>
            ${U.card({ title: 'Reason', body: `${U.field('Why are you cancelling?', U.select('cx-reason', ['Choose a reason', 'It\'s taking too long to arrive', 'I ordered by mistake', 'I found a better price', 'I no longer need it', 'Other'], 'It\'s taking too long to arrive'))}
              ${U.field('Anything to add for the seller', U.textarea('cx-note', '', 'For example: I need it before Oct 10.'), { opt: true })}` })}
          </div>
          <aside>
            ${U.card({ title: 'Refund preview', body: `
              ${U.sumRow('Duvet cover, Qty 1', money(119))}
              ${U.sumRow('Coupon share (WELCOME20)', '−' + money(duvetShare))}
              ${U.sumRow('Shipping refund', money(0))}
              <hr>${U.sumRow('Estimated refund', money(refund), 'total')}
              ${U.sumRow('Refund to', O.payment)}
              <span class="xs muted">Your $20.00 coupon is split across items by price, so the share for this item is deducted. Banks usually post refunds 3–5 business days after we send them.</span>` })}
            <div class="only-desktop stack gap-2">${U.btn('Request cancellation', { block: true, href: go('account/cancel', 'Cancellation requested') })}${U.btn('Keep my order', { v: 'ghost', block: true, href: go('account/order') })}</div>
            <span class="xs muted">Casa Verde Home has 1 business day to confirm. If they don't reply in time, Marketly cancels the item for you.</span>
          </aside>
        </div>
      `, { actionBar: bar });
    },
  });

  /* ==================================================================
     6. Returns and refunds list
     ================================================================== */
  const returnRow = (r) => {
    const p = P[r.p];
    return `<a class="acct-row" href="${go('account/return')}">
      ${U.pimg(p, 'thumb')}
      <span class="stack gap-2 grow">
        <span class="row between gap-2"><span class="mono small strong">${r.ref}</span><span class="xs muted">Opened ${r.opened} · Order <span class="mono">${r.order}</span></span></span>
        <span class="stack gap-0"><span class="small strong">${U.esc(p.name)}</span><span class="xs muted">${sname(r.seller)} · Refund ${money(r.amount)}</span></span>
        <span class="row gap-4">
          <span class="row gap-2"><span class="acct-k">Return</span>${retStatus(r.ret)}</span>
          <span class="row gap-2"><span class="acct-k">Refund</span>${refundStatus(r.refund)}</span>
        </span>
        <span class="row gap-2 nowrap xs sub top">${U.icon('arrow-right', 'ic-sm')}<span>${r.next}</span></span>
      </span>
    </a>`;
  };
  U.register({
    id: 'account/returns', title: 'Returns and refunds', ref: 'Plan ch. 7, 13, 14',
    notes: 'Every return shows the return status and the refund status side by side, so "Received" or "Approved" is never read as money arrived. Each row names the seller and the next step with its deadline.',
    render: () => layout('returns', 'Returns and refunds', `
      ${head('Returns and refunds', 'Return status tracks the item. Refund status tracks the money. They move separately.', U.btn('Start a return', { size: 'sm', icon: 'plus', href: go('account/return-new') }))}
      <div class="grid md3" style="--gap:12px">
        <div class="card pad">${U.stat('Open returns', '3', { note: '1 needs drop-off by Oct 15' })}</div>
        <div class="card pad">${U.stat('Refunds on the way', money(109), { note: 'RT-261002-0520 · Processing' })}</div>
        <div class="card pad">${U.stat('Refunded in 2026', money(223), { note: '2 completed returns' })}</div>
      </div>
      ${U.tabs([{ label: 'Open', count: 3 }, { label: 'Completed', count: 2 }, { label: 'All', count: 5 }], 0)}
      <section class="card">${RETURNS.filter((r) => r.open).map(returnRow).join('')}</section>
      <h2 class="h3">Completed</h2>
      <section class="card">${RETURNS.filter((r) => !r.open).map(returnRow).join('')}</section>
      ${U.card({ title: 'How refunds work', body: `<div class="grid md3" style="--gap:16px">
        <div class="stack gap-1"><span class="small strong">${U.icon('clock', 'ic-sm')} Timing</span><span class="xs sub">We send the refund after the item is received and inspected, usually within 2 business days. Banks take 3–5 business days more.</span></div>
        <div class="stack gap-1"><span class="small strong">${U.icon('credit-card', 'ic-sm')} Destination</span><span class="xs sub">Refunds go back to the original payment method unless you chose store credit.</span></div>
        <div class="stack gap-1"><span class="small strong">${U.icon('life-buoy', 'ic-sm')} If a seller doesn't respond</span><span class="xs sub">Marketly support steps in when a seller misses a deadline. <a href="${go('help/cases')}">See your cases</a>.</span></div>
      </div>` })}
    `),
  });

  /* ==================================================================
     7. New return request
     ================================================================== */
  const auroraShare = share(189);
  const auroraRefund = 189 - auroraShare;
  U.register({
    id: 'account/return-new', title: 'Request a return', ref: 'Plan ch. 13',
    notes: 'The five-step return journey from the customer side: item and quantity, reason with photos, then eligibility, deadline, destination, who pays return shipping and the remedy, all shown before submitting. The review step breaks the refund estimate into item, shipping and coupon share.',
    states: ['Choose items', 'Reason and remedy', 'Review'],
    render: (state) => {
      const step = state === 'Review' ? 2 : state === 'Reason and remedy' ? 1 : 0;
      const nextState = ['Reason and remedy', 'Review', null][step];
      const cta = step === 2 ? U.btn('Request return', { icon: 'check', href: go('account/return') }) : U.btn('Continue', { iconR: 'arrow-right', href: go('account/return-new', nextState) });
      const backBtn = step ? U.btn('Back', { v: 'ghost', href: go('account/return-new', ['Choose items', 'Reason and remedy'][step - 1]) }) : U.btn('Cancel', { v: 'ghost', href: go('account/order') });
      const g = O.groups;
      const itemRow = (p, it, o) => `<div class="acct-check${o.off ? ' is-off' : ''}">
        <input type="checkbox" id="rn-${p.id}" aria-label="Return ${U.esc(p.name)}"${o.checked ? ' checked' : ''}${o.off ? ' disabled' : ''}>
        ${U.pimg(p, 'thumb')}
        <div class="stack gap-1"><label for="rn-${p.id}" class="small strong">${U.esc(p.name)}</label><span class="xs muted">${it.variant} · ${money(it.price)} · ${sname(o.seller)}</span><span class="row gap-2">${U.status(it.state)}<span class="xs sub">${o.why}</span></span></div>
        <div class="side">${o.off ? '<span class="xs muted">Not available</span>' : `<div style="max-width:120px">${U.field('Quantity', U.select('rn-qty-' + p.id, ['1'], '1'))}</div>`}</div>
      </div>`;

      const eligibility = `<section class="acct-eligible" aria-label="Return eligibility">
        <div class="row gap-2">${U.icon('circle-check')}<span class="strong">This item can be returned</span></div>
        ${U.kv([
          ['Return by', 'Sat, Oct 17, 2026 <span class="xs muted">(30 days after delivery)</span>'],
          ['Ships back to', 'Marketly Returns, Reno, NV warehouse. Items from outside sellers go to the seller\'s return address, shown here before you submit.'],
          ['Return shipping', '<span class="t-success-text strong">Free</span> for a defective item. $7.99 is deducted for change-of-mind returns.'],
          ['Response', 'Marketly Official reviews within 1 business day.'],
        ])}
      </section>`;

      let body = '';
      if (step === 0) {
        body = `
          ${U.alert('info', 'Choose the items to return', 'Only delivered items can be returned. Items from different sellers become separate returns, each with its own label.')}
          <section class="card" aria-label="Delivered items">
            ${itemRow(P.aurora, g[0].items[0], { seller: 'official', checked: true, why: 'Return by Sat, Oct 17' })}
            ${itemRow(P.pourover, g[0].items[1], { seller: 'official', off: true, why: 'Return RT-260921-0457 already open' })}
            ${itemRow(P.ssd1tb, g[1].items[0], { seller: 'pixelport', off: true, why: 'Not delivered yet. You can return it after it arrives.' })}
            ${itemRow(P.duvet, g[2].items[0], { seller: 'casaverde', off: true, why: 'Not shipped yet. You can cancel it instead.' })}
          </section>
          <p class="xs muted">Order <a class="mono" href="${go('account/order')}">${O.ref}</a> · placed Sep 14. Want to return something from another order? <a href="${go('account/orders')}">Pick an order</a>.</p>`;
      } else if (step === 1) {
        body = `
          <div class="row gap-3 nowrap top card pad">${thumb(P.aurora)}<div class="stack gap-1">${pname(P.aurora)}<span class="xs muted">Midnight black · Qty 1 · ${money(189)}</span>${U.sellerLine('official')}</div></div>
          ${U.card({ title: 'What\'s wrong?', body: `
            ${U.field('Reason', U.select('rn-reason', ['Choose a reason', 'Defective or stopped working', 'Arrived damaged', 'Wrong item sent', 'Not as described', 'Changed my mind', 'Better price elsewhere'], 'Defective or stopped working'), { hint: 'Who pays return shipping depends on the reason.' })}
            ${U.field('Tell us more', U.textarea('rn-details', 'The left ear cup cuts out every few minutes over Bluetooth. Reset it twice, still happens. Wired mode works.'), { hint: 'Helps the reviewer decide faster.' })}
            <div class="field"><span class="label">Photos or video <span class="opt">(optional)</span></span>
              <div class="row gap-2">${U.img('image', 'var(--img-2)', 'thumb')}${U.img('image', 'var(--img-2)', 'thumb')}</div>
              ${U.dropzone('Add photos or a short video', 'JPG, PNG or MP4, up to 10 MB each')}</div>
            <div class="table-wrap"><table class="table"><thead><tr><th scope="col">Reason</th><th scope="col">Return shipping paid by</th></tr></thead><tbody>
              <tr><td>Defective, damaged, wrong item, not as described</td><td>Seller (free label)</td></tr>
              <tr><td>Changed my mind, better price</td><td>You ($7.99 deducted from refund)</td></tr>
            </tbody></table></div>
            <span class="xs muted">Example policy. Outside sellers can offer more generous terms.</span>` })}
          ${U.card({ title: 'What would you like?', body: `<div class="stack gap-2" role="radiogroup" aria-label="Remedy">
            ${U.optCard('rn-rem', 'rn-rem-refund', '<span class="strong">Refund to original payment</span>', `${O.payment}. Sent after inspection, then 3–5 business days at your bank.`, true)}
            ${U.optCard('rn-rem', 'rn-rem-repl', '<span class="strong">Replacement</span>', 'Same color, in stock. Ships once we scan your return at drop-off.', false)}
            ${U.optCard('rn-rem', 'rn-rem-credit', '<span class="strong">Marketly store credit</span>', 'Issued when we receive the item, usually 2 days sooner than a card refund.', false)}
          </div>` })}`;
      } else {
        body = `
          ${U.card({ title: 'Check your request', body: U.kv([
            ['Item', `${U.esc(P.aurora.name)}, Midnight black · Qty 1`],
            ['Sold by', 'Marketly Official'],
            ['Reason', 'Defective or stopped working'],
            ['Details', 'Left ear cup cuts out every few minutes over Bluetooth. 2 photos attached.'],
            ['You want', 'Refund to ' + O.payment],
            ['Send it back', 'UPS drop-off with a QR code, no printer needed. By Sat, Oct 17.'],
          ]) })}
          ${U.card({ title: 'Refund estimate', body: `
            ${U.sumRow('Item price', money(189))}
            ${U.sumRow('Original shipping', money(0))}
            ${U.sumRow('Coupon share (WELCOME20)', '−' + money(auroraShare))}
            ${U.sumRow('Return shipping', 'Free')}
            <hr>${U.sumRow('Estimated refund', money(auroraRefund), 'total')}
            <span class="xs muted">Estimate. The final amount is confirmed after inspection. The coupon was split across all items in the order by price.</span>` })}
          ${U.alert('info', 'After you submit', 'Marketly Official reviews within 1 business day. If approved, you get a drop-off QR code. Your refund starts only after the item is received and inspected.')}`;
      }

      return layout('returns', 'Request a return', `
        ${U.crumbs([{ label: 'Orders', href: go('account/orders') }, { label: O.ref, href: go('account/order') }, { label: 'Request a return' }])}
        ${head('Request a return', `Order <span class="mono">${O.ref}</span>`)}
        ${U.steps(['Items', 'Reason and remedy', 'Review'], step)}
        <div class="acct-split">
          <div class="stack gap-4">${body}
            <div class="row between only-desktop">${backBtn}${cta}</div>
          </div>
          <aside>${step === 0 ? U.card({ title: 'Return policy', body: `<ul class="ul small sub stack gap-1"><li>30 days from delivery for most items.</li><li>Official Store returns are free for defects and damage.</li><li>Refunds cover the item, its share of discounts and any shipping you paid.</li></ul><a class="small strong" href="${go('info/policy', 'Returns')}">Full returns policy</a>` }) : eligibility}</aside>
        </div>
      `, { actionBar: `${backBtn}<span class="grow"></span>${cta}` });
    },
  });

  /* ==================================================================
     8. Return detail
     ================================================================== */
  U.register({
    id: 'account/return', title: 'Return details', ref: 'Plan ch. 13, 14',
    notes: 'Return RT-260921-0457 with its own status track, drop-off instructions and return shipment tracking kept apart from the original delivery. Refund progress uses Requested, Under review, Approved, Processing, Sent, and says plainly that approval does not mean the money has arrived. The replacement state gives the new item its own shipment record and leaves the original order unchanged (plan ch. 13).',
    states: ['Approved: send it back', 'Refund sent', 'Replacement on the way'],
    render: (state) => {
      const repl = state === 'Replacement on the way';
      const done = state === 'Refund sent' || repl;
      const amt = 36 - share(36);
      const retLabels = ['Requested', 'Approved', 'Sent back', 'Received', 'Inspected', repl ? 'Replaced' : 'Refunded'];
      const refLabels = ['Requested', 'Under review', 'Approved', 'Processing', 'Sent'];
      return layout('returns', 'Return details', `
        ${U.crumbs([{ label: 'Returns and refunds', href: go('account/returns') }, { label: 'RT-260921-0457' }])}
        ${head(`Return <span class="mono">RT-260921-0457</span>`, `Order <a class="mono" href="${go('account/order')}">${O.ref}</a> · requested Mon, Sep 21`, U.btn('Get help', { v: 'soft', size: 'sm', icon: 'life-buoy', href: go('help/order-problem') }))}
        <section class="card pad stack gap-4">
          <div class="row gap-3 nowrap top">${thumb(P.pourover)}<div class="stack gap-1 grow">${pname(P.pourover)}<span class="xs muted">Cream · Qty 1 · Reason: arrived damaged, one cup chipped</span>${U.sellerLine('official')}</div></div>
          <div class="stack gap-2"><span class="row gap-2"><span class="acct-k">Return</span>${retStatus(repl ? 'Inspected' : done ? 'Refunded' : 'Approved')}${repl ? `<span class="xs muted">Remedy: replacement</span>` : ''}</span>${U.track(retLabels, done ? 6 : 2)}</div>
        </section>
        <div class="acct-split">
          <div class="stack gap-4">
            ${repl ? `${U.alert('success', 'Your replacement has shipped', `We received and inspected the chipped set, so a new one is on its way. You chose a replacement, so no refund is due. Order <a class="mono" href="${go('account/order')}">${O.ref}</a> stays as it was: same receipt, same total.`)}
            ${U.card({ title: 'Replacement shipment', sub: 'Its own shipment record, separate from your return and from the original delivery', body: `
              <div class="row gap-3 nowrap top">${thumb(P.pourover)}<div class="stack gap-1 grow">${pname(P.pourover)}<span class="xs muted">Cream · Qty 1 · Replacement for return RT-260921-0457 · No charge</span>${U.sellerLine('official')}</div>${U.status('In transit')}</div>
              <div class="grid md3" style="--gap:12px">
                <div class="panel stack gap-1"><span class="acct-k">Estimated delivery</span><span class="small strong">Fri, Oct 16</span><span class="xs muted">By 8:00 PM to Portland, OR 97205</span></div>
                <div class="panel stack gap-1"><span class="acct-k">Carrier</span><span class="small strong">UPS Ground</span><span class="xs muted">From Marketly Reno warehouse</span></div>
                <div class="panel stack gap-1"><span class="acct-k">Tracking number</span><span class="row gap-1 nowrap"><span class="mono small strong">1Z84E2W70392055102</span>${U.iconBtn('copy', 'Copy tracking number')}</span></div>
              </div>
              ${U.track(['Shipped', 'In transit', 'Out for delivery', 'Delivered'], 2)}
              ${U.timeline([
                { t: 'In transit', d: 'Wed, Oct 14, 4:18 AM · Medford, OR', state: 'current' },
                { t: 'Replacement shipped', d: 'Tue, Oct 13, 2:40 PM · Reno, NV', state: 'done', body: 'New package with its own label. Your return shipment and the original Package 1 keep their own records.' },
              ])}`, foot: `<span class="xs muted grow">If the replacement arrives damaged, report it from this page. It's covered by a new 30-day return window.</span>${U.btn('Report a problem', { v: 'ghost', size: 'sm', href: go('help/order-problem') })}` })}`
            : done ? U.alert('success', `Refund of ${money(amt)} sent on Wed, Oct 14`, `Sent to ${O.payment}. Most banks show it within 3–5 business days. If it isn't there by Oct 21, ask your bank about reference <span class="mono">74K2 9310 5521 0846</span>.`)
            : `${U.alert('info', 'Approved means you can send it back', 'Your refund hasn\'t been sent yet. It starts once we receive and inspect the item.')}
            ${U.card({ title: 'Send it back by Thu, Oct 15', sub: 'Prepaid by Marketly. No printer or box label needed.', body: `
              <div class="row gap-5 top">
                ${qr(260921)}
                <div class="stack gap-3 grow" style="min-width:220px">
                  <ol class="ol small sub stack gap-2">
                    <li>Pack the set in any box with padding. Include all cups and the dripper.</li>
                    <li>Take it to any UPS drop-off point. Nearest: The UPS Store, 1022 SW Morrison St, Portland (0.4 mi).</li>
                    <li>Show this QR code. The staff print the label and give you a receipt.</li>
                  </ol>
                  <div class="row gap-2">${U.btn('Email me the code', { v: 'secondary', size: 'sm', icon: 'mail' })}${U.btn('Print label instead', { v: 'ghost', size: 'sm', icon: 'printer' })}</div>
                  <span class="xs muted">Ships to Marketly Returns, 1180 Kleppe Ln, Sparks, NV 89431 (Reno warehouse).</span>
                </div>
              </div>` })}`}
            ${U.card({ title: 'Return shipment', sub: 'Separate from the original delivery', body: `
              <div class="row between"><span class="stack gap-0"><span class="small strong">UPS Ground · <span class="mono">1Z84E2W79014433610</span></span><span class="xs muted">From Portland, OR to Reno, NV</span></span>${done ? U.status('Delivered') : U.status('Waiting for drop-off', '')}</div>
              ${U.timeline(done ? [
                { t: 'Inspected. Damage confirmed', d: 'Tue, Oct 13, 10:05 AM · Marketly Reno', state: 'done', body: repl ? 'Chipped cup matches your photos. Replacement approved.' : 'Chipped cup matches your photos. Approved for a full refund.' },
                { t: 'Received at Marketly Reno warehouse', d: 'Mon, Oct 12, 3:40 PM', state: 'done' },
                { t: 'Dropped off at The UPS Store', d: 'Fri, Oct 9, 11:12 AM · Portland, OR', state: 'done' },
                { t: 'Return approved', d: 'Tue, Sep 22', state: 'done' },
              ] : [
                { t: 'Waiting for drop-off', d: 'Drop off by Thu, Oct 15', state: 'current', body: 'The label activates when UPS scans your QR code.' },
                { t: 'Return approved by Marketly Official', d: 'Tue, Sep 22, 9:30 AM', state: 'done' },
                { t: 'Return requested', d: 'Mon, Sep 21, 6:02 PM', state: 'done' },
              ])}` })}
          </div>
          <aside>
            ${repl ? U.card({ title: 'Remedy', body: `
              <div class="row between"><span class="small sub">You chose</span>${U.badge('Replacement', 'brand', 'refresh-cw')}</div>
              ${U.sumRow('Item returned', money(36))}
              ${U.sumRow('Replacement sent', 'Same item, no charge')}
              ${U.sumRow('Return shipping', 'Free')}
              <hr>${U.sumRow('Refund due', money(0), 'total')}
              <span class="xs muted">No refund is due because you're getting the same item again. Nothing changes on your card or on the original order.</span>` })
            + U.card({ title: 'Original order', body: `<div class="row between"><a class="mono small strong" href="${go('account/order')}">${O.ref}</a>${U.status('Partly delivered')}</div><span class="xs sub">Placed Sep 14 · ${money(O.total)} · unchanged. The pour-over set still shows there as delivered in Package 1, with this return linked to it.</span>` })
            : U.card({ title: 'Refund', body: `
              <div class="row between"><span class="small sub">Refund status</span>${refundStatus(done ? 'Sent' : 'Requested')}</div>
              ${U.track(refLabels, done ? 5 : 1)}
              <span class="xs sub">${done ? 'Sent means it left Marketly. Your bank posts it next.' : 'The refund moves to Under review when the item arrives. Approved still means the money hasn\'t been sent. Sent means it left Marketly.'}</span>
              <hr>
              ${U.sumRow('Item', money(36))}
              ${U.sumRow('Coupon share (WELCOME20)', '−' + money(share(36)))}
              ${U.sumRow('Return shipping', 'Free')}
              <hr>${U.sumRow(done ? 'Refunded' : 'Expected refund', money(amt), 'total')}
              ${U.sumRow('To', O.payment)}` })}
            ${U.card({ title: 'Questions about this return?', body: `<div class="stack gap-2">${U.btn('Message Marketly Official', { v: 'secondary', block: true, icon: 'message-square', href: go('account/messages') })}${U.btn('Open a support case', { v: 'ghost', block: true, icon: 'life-buoy', href: go('help/case') })}</div>` })}
          </aside>
        </div>
      `);
    },
  });

  /* ==================================================================
     9. Messages
     ================================================================== */
  const THREADS = [
    { who: 'Casa Verde Home', sid: 'casaverde', about: 'MK-260914-48213 · Linen duvet cover', last: 'The Sage color restock arrives tomorrow. We\'ll ship Saturday.', time: '9:20 AM', unread: true, active: true },
    { who: 'Marketly Support', support: true, about: 'Case CS-261005-3381 · Duvet delayed', last: 'We asked Casa Verde to ship by Oct 10 and will check back Friday.', time: 'Yesterday', unread: true },
    { who: 'Pixel & Port', sid: 'pixelport', about: 'MK-260914-48213 · Portable SSD', last: 'Shipped today with USPS Priority. Tracking is on your order page.', time: 'Oct 6' },
    { who: 'Northwind Audio', sid: 'northwind', about: 'RT-261007-0533 · Pocket speaker', last: 'Thanks, we\'re checking the photos and will reply by Friday.', time: 'Oct 7' },
    { who: 'Marketly Official', sid: 'official', about: 'RT-260921-0457 · Pour-over set', last: 'Sorry about the chipped cup. Your return is approved.', time: 'Sep 22' },
  ];
  U.register({
    id: 'account/messages', title: 'Messages', ref: 'Plan ch. 7, 17',
    notes: 'Private order conversations, each linked to an order, item, return or case, with sellers and Marketly Support in one inbox. Desktop shows inbox and thread side by side; phone opens straight into the thread. Promotions are kept out and live under notification preferences.',
    render: () => layout('messages', 'Casa Verde Home', `
      ${head('Messages', 'Conversations about your orders. Promotions never appear here.')}
      <section class="card" style="overflow:hidden">
        <div class="acct-msgs">
          <div class="inbox no-phone">
            <div class="toolbar" style="padding:var(--sp-3);border-bottom:1px solid var(--border)">${U.searchIn('Search messages', 'msg-q')}</div>
            ${THREADS.map((t) => `<a class="acct-row${t.active ? ' acct-active' : ''}" href="${go('account/messages')}"${t.active ? ' aria-current="true"' : ''}>
              ${t.support ? `<span class="logo-tile" style="width:36px;height:36px;font-size:13px;--tint:var(--brand-soft)" aria-hidden="true">${U.icon('life-buoy', 'ic-sm')}</span>` : U.logoTile(S[t.sid], 'acct-lt')}
              <span class="stack gap-0 grow">
                <span class="row between gap-2 nowrap"><span class="small truncate${t.unread ? ' bold' : ' strong'}">${U.esc(t.who)}</span><span class="xs muted nowrap">${t.time}</span></span>
                <span class="xs muted truncate">${t.about}</span>
                <span class="xs sub clamp-2">${U.esc(t.last)}</span>
              </span>
              ${t.unread ? '<span class="acct-dot" aria-hidden="true"></span><span class="sr-only">Unread</span>' : ''}
            </a>`).join('')}
          </div>
          <div class="stack gap-0" style="min-width:0">
            <div class="row gap-3 between" style="padding:var(--sp-3) var(--sp-4);border-bottom:1px solid var(--border)">
              <div class="row gap-3 nowrap" style="min-width:0">${U.logoTile(S.casaverde)}<div class="stack gap-0" style="min-width:0"><span class="row gap-2"><span class="strong">Casa Verde Home</span>${U.sellerBadge(S.casaverde, true)}</span><span class="xs muted">Usually replies within 4 hours · Sacramento, CA</span></div></div>
              <a class="small strong only-phone" href="${go('account/messages')}">All messages</a>
            </div>
            <a class="acct-row" href="${go('account/order')}" style="background:var(--surface-2)">${U.pimg(P.duvet, 'tiny')}<span class="stack gap-0 grow"><span class="xs muted">About order <span class="mono">${O.ref}</span> · Package 3 of 3</span><span class="small strong truncate">${U.esc(P.duvet.name)}</span></span>${U.status('Delayed')}</a>
            <div class="stack gap-3" style="padding:var(--sp-4);min-height:280px" aria-label="Conversation" role="log">
              <span class="acct-sys">Mon, Oct 5</span>
              <div class="acct-bubble me"><span>Hi, my duvet cover was due Sep 22 and still hasn't shipped. Can you tell me when it will?</span><span class="xs muted">You · 10:14 AM</span></div>
              <div class="acct-bubble"><span>Hi Jordan, sorry for the wait. Our supplier was late with the Sage color. We expect it this week.</span><span class="xs muted">Marisol, Casa Verde Home · 1:02 PM</span></div>
              <span class="acct-sys">Marketly Support joined from case CS-261005-3381 · Oct 7</span>
              <span class="acct-sys">Today</span>
              <div class="acct-bubble"><span>The Sage color restock arrives tomorrow. We'll ship Saturday, Oct 10 with UPS and you'll get tracking right away.</span><span class="row gap-2 xs muted">${U.icon('paperclip', 'ic-sm')}<a href="javascript:void 0">restock-confirmation.pdf</a></span><span class="xs muted">Marisol, Casa Verde Home · 9:20 AM</span></div>
            </div>
            <form class="acct-composer" onsubmit="return false">
              ${U.iconBtn('paperclip', 'Attach a photo or file')}
              <label class="sr-only" for="msg-text">Message to Casa Verde Home</label>
              <textarea class="textarea grow" id="msg-text" rows="1" placeholder="Write a message" style="min-height:44px"></textarea>
              ${U.btn('Send', { icon: 'send' })}
            </form>
            <p class="xs muted" style="padding:0 var(--sp-4) var(--sp-3)">Keep payments and contact details on Marketly. Support can read this thread if you open a case. Looking for offers? Manage promotions in <a href="${go('account/profile')}">notification preferences</a>.</p>
          </div>
        </div>
      </section>
    `),
  });
  U.css('store-account-msg', `
    .acct-msgs { display: grid; grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .acct-msgs { grid-template-columns: 300px minmax(0, 1fr); } .acct-msgs .inbox { border-right: 1px solid var(--border); } }
    .acct-msgs .inbox .acct-row { padding-inline: var(--sp-3); }
    .acct-msgs .logo-tile.acct-lt { width: 36px; height: 36px; font-size: 13px; }
    .acct-active { background: var(--brand-soft); }
    .acct-bubble { max-width: 85%; padding: var(--sp-3) var(--sp-4); border-radius: var(--r-lg); border-top-left-radius: var(--r-xs); background: var(--surface-2); font-size: var(--fs-sm); display: flex; flex-direction: column; gap: 4px; align-self: flex-start; }
    .acct-bubble.me { align-self: flex-end; background: var(--brand-soft); border-top-left-radius: var(--r-lg); border-top-right-radius: var(--r-xs); }
    .acct-sys { align-self: center; font-size: var(--fs-xs); color: var(--text-3); text-align: center; }
    .acct-composer { display: flex; gap: var(--sp-2); align-items: flex-end; padding: var(--sp-3); border-top: 1px solid var(--border); }
  `);

  /* ==================================================================
     10. Notifications
     ================================================================== */
  const notice = (n) => `<a class="acct-row" href="${n.href}">${ic(n.icon, n.tone)}<span class="stack gap-1 grow"><span class="row between gap-2 top"><span class="small${n.unread ? ' bold' : ''}">${n.title}</span><span class="xs muted nowrap">${n.time}</span></span><span class="xs sub">${n.body}</span><span class="xs muted">${n.tag}${n.link ? ` · <span class="mono">${n.link}</span>` : ''}</span></span>${n.unread ? '<span class="acct-dot" aria-hidden="true"></span><span class="sr-only">Unread</span>' : ''}</a>`;
  U.register({
    id: 'account/notifications', title: 'Notifications', ref: 'Plan ch. 19, 7',
    notes: 'In-account notice centre grouped by Today and This week, each notice linked to its order, return or case. Essential updates and promotions are separate sections with separate preferences, as plan ch. 19 requires.',
    render: () => layout('notifications', 'Notifications', `
      ${head('Notifications', 'Updates about your orders, returns, cases and account. We also email the important ones.', `${U.btn('Mark all as read', { v: 'ghost', size: 'sm', icon: 'check' })}${U.btn('Notification settings', { v: 'secondary', size: 'sm', icon: 'settings', href: go('account/profile') })}`)}
      ${U.chips([{ label: 'All', active: true }, { label: 'Orders', icon: 'package' }, { label: 'Returns & refunds', icon: 'undo-2' }, { label: 'Cases', icon: 'life-buoy' }, { label: 'Account', icon: 'shield-check' }, { label: 'Promotions', icon: 'tag' }])}
      <section class="stack gap-3" aria-labelledby="nt-ess">
        <div class="row between"><h2 class="h3" id="nt-ess">Order and account updates</h2><span class="row gap-1 xs muted">${U.icon('lock', 'ic-sm')} Always on</span></div>
        <h3 class="eyebrow">Today</h3>
        <div class="card">
          ${notice({ icon: 'truck', tone: 'info', unread: true, title: 'Package 2 of 3 is close', body: 'Your Kestrel SSDs reached the USPS facility in Portland. Arrives Fri, Oct 9 – Sat, Oct 10.', time: '6:20 AM', tag: 'Orders', link: 'MK-260914-48213', href: go('account/tracking') })}
          ${notice({ icon: 'message-square', tone: 'brand', unread: true, title: 'Casa Verde Home replied', body: 'About your duvet cover: "The Sage color restock arrives tomorrow. We\'ll ship Saturday."', time: '9:20 AM', tag: 'Orders', link: 'MK-260914-48213', href: go('account/messages') })}
          ${notice({ icon: 'life-buoy', tone: 'warning', unread: true, title: 'Case update: we\'re following up with the seller', body: 'Isabel from Marketly Support asked Casa Verde to ship by Oct 10. Next update by Fri, Oct 9, 12:00 PM.', time: '8:05 AM', tag: 'Cases', link: 'CS-261005-3381', href: go('help/case') })}
        </div>
        <h3 class="eyebrow">This week</h3>
        <div class="card">
          ${notice({ icon: 'undo-2', tone: 'info', title: 'Refund is processing', body: 'Pixel & Port received your keyboard. Refund of $109.00 is processing to Visa •••• 4417.', time: 'Wed', tag: 'Returns & refunds', link: 'RT-261002-0520', href: go('account/returns') })}
          ${notice({ icon: 'clock', tone: 'warning', title: 'Reminder: drop off your return by Oct 15', body: 'Pour-over set. Show the QR code at any UPS location.', time: 'Wed', tag: 'Returns & refunds', link: 'RT-260921-0457', href: go('account/return') })}
          ${notice({ icon: 'shield-check', tone: '', title: 'New sign-in on Chrome, Windows', body: 'Portland, OR. If this wasn\'t you, change your password.', time: 'Tue', tag: 'Account', href: go('account/security') })}
          ${notice({ icon: 'circle-check', tone: 'success', title: 'Order accepted, payment accepted', body: 'Trailhead Outfitters is preparing your bottle and yoga mat. Ships by Fri, Oct 9.', time: 'Tue', tag: 'Orders', link: 'MK-261006-90127', href: go('account/order') })}
          ${notice({ icon: 'triangle-alert', tone: 'warning', title: 'Your duvet cover is delayed', body: 'New estimate: arrives Mon, Oct 12. You can wait, cancel for a full refund, or contact support.', time: 'Mon', tag: 'Orders', link: 'MK-260914-48213', href: go('account/order') })}
        </div>
      </section>
      <section class="stack gap-3" aria-labelledby="nt-promo">
        <div class="row between"><h2 class="h3" id="nt-promo">Promotions and alerts</h2><a class="xs strong" href="${go('account/profile')}">Turn off promotions</a></div>
        <div class="card">
          ${notice({ icon: 'trending-down', tone: 'deal', title: 'Price drop on a saved item', body: 'Kestrel 27" 4K Monitor is now $299.00, lowest in 30 days.', time: 'Today', tag: 'Promotions · wishlist alert', href: go('account/wishlist') })}
          ${notice({ icon: 'tag', tone: 'deal', title: 'Home Week: up to 30% off bedding and cookware', body: 'Ends Mon, Oct 19. Includes Official Store and Casa Verde items.', time: 'Tue', tag: 'Promotions', href: go('store/deals') })}
        </div>
      </section>
    `),
  });

  /* ==================================================================
     11. Addresses
     ================================================================== */
  const addrCard = (a) => `<section class="card pad stack gap-3">
    <div class="row between"><span class="row gap-2">${U.icon(a.label === 'Home' ? 'house' : 'building-2', 'ic-sm')}<span class="strong">${a.label}</span>${a.default ? U.badge('Default', 'brand') : ''}</span></div>
    <address class="small sub" style="font-style:normal">${a.name}<br>${a.line1}<br>${a.city}<br>${a.phone}</address>
    <div class="row gap-2">${U.btn('Edit', { v: 'secondary', size: 'sm', icon: 'pencil', href: go('account/addresses', 'Edit address') })}${a.default ? '' : U.btn('Set as default', { v: 'ghost', size: 'sm' })}${U.btn('Remove', { v: 'ghost', size: 'sm', icon: 'trash-2' })}</div>
  </section>`;
  U.register({
    id: 'account/addresses', title: 'Addresses', ref: 'Plan ch. 7',
    notes: 'Saved delivery addresses with default, edit, remove and add. States the rule that address changes do not alter orders already placed. The edit state shows the form as a modal on desktop and a bottom sheet on phone, with a validation error.',
    states: ['Addresses', 'Edit address'],
    render: (state) => {
      const page = layout('addresses', 'Addresses', `
        ${head('Addresses', 'Used at checkout. Sellers only see the address of an order they ship.', U.btn('Add address', { size: 'sm', icon: 'plus', href: go('account/addresses', 'Edit address') }))}
        ${U.alert('info', 'Changing an address doesn\'t change orders already placed', `To redirect a package that hasn't shipped, message its seller from the order page. Open order: <a class="mono" href="${go('account/order')}">${O.ref}</a>.`)}
        <div class="grid md2">${D.customer.addresses.map(addrCard).join('')}
          <a class="card pad stack gap-2" href="${go('account/addresses', 'Edit address')}" style="align-items:center;justify-content:center;text-align:center;border-style:dashed;min-height:180px;color:var(--text-2);text-decoration:none">${U.icon('plus', 'ic-lg')}<span class="strong">Add a new address</span><span class="xs muted">We deliver to all 50 US states.</span></a>
        </div>
      `);
      if (state !== 'Edit address') return page;
      const a = D.customer.addresses[1];
      return page + U.modal({
        title: 'Edit address',
        body: `
          ${U.alert('danger', 'Check 1 field', 'Fix the ZIP code to save this address.')}
          <div class="grid md2" style="--gap:12px">
            ${U.field('Label', U.input('ad-label', a.label), { opt: true })}
            ${U.field('Full name', U.input('ad-name', a.name))}
          </div>
          ${U.field('Street address', U.input('ad-line1', '815 SW 2nd Ave'))}
          ${U.field('Apartment, suite, floor', U.input('ad-line2', 'Floor 4'), { opt: true })}
          <div class="grid md3" style="--gap:12px">
            ${U.field('City', U.input('ad-city', 'Portland'))}
            ${U.field('State', U.select('ad-state', ['Oregon', 'Washington', 'California', 'Idaho', 'Nevada'], 'Oregon'))}
            ${U.field('ZIP code', U.input('ad-zip', '9720', { error: true }), { error: 'Enter a 5-digit ZIP code, like 97204.' })}
          </div>
          ${U.field('Phone', U.input('ad-phone', a.phone, { type: 'tel' }), { hint: 'Carriers call only if there\'s a delivery problem.' })}
          ${U.field('Delivery instructions', U.textarea('ad-note', 'Front desk on the ground floor accepts packages.'), { opt: true })}
          ${U.check('ad-default', 'Make this my default address', false)}
          <span class="xs muted">Saving won't change orders already placed.</span>`,
        foot: `${U.btn('Cancel', { v: 'ghost', href: go('account/addresses', 'Addresses') })}${U.btn('Save address')}`,
      });
    },
  });

  U.css('store-account-more', `
    .acct-cc { width: 52px; height: 34px; border-radius: var(--r-sm); background: var(--surface-3); color: var(--text); display: inline-flex; align-items: center; justify-content: center; font-size: var(--fs-2xs); font-weight: 800; letter-spacing: 0.06em; flex: none; border: 1px solid var(--border); }
    .acct-coupon { display: grid; grid-template-columns: 92px minmax(0, 1fr); border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); overflow: hidden; min-width: 0; }
    .acct-coupon .amt { background: var(--deal-soft); color: var(--deal-text); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; font-weight: 800; font-size: var(--fs-xl); line-height: 1.1; padding: var(--sp-3) var(--sp-2); border-right: 2px dashed var(--border-strong); font-variant-numeric: tabular-nums; }
    .acct-coupon .amt small { font-size: var(--fs-2xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
    .acct-coupon .bd { padding: var(--sp-3) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
    .acct-coupon.is-muted .amt { background: var(--surface-2); color: var(--text-3); }
    .acct-coupon.is-muted { background: var(--surface-2); }
    .acct-stars { border: 0; padding: 0; margin: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .acct-star { cursor: pointer; color: var(--border-strong); display: inline-flex; padding: 2px; border-radius: var(--r-sm); }
    .acct-star svg.lucide { width: 30px; height: 30px; stroke-width: 1.5; }
    .acct-star.on { color: var(--star); }
    .acct-star.on svg.lucide { fill: var(--star); }
    .acct-star:focus-within { outline: 2px solid var(--focus); }
    .acct-star.sm svg.lucide { width: 22px; height: 22px; }
    .acct-pref { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-4); padding-block: var(--sp-3); border-top: 1px solid var(--border); }
    .acct-pref:first-child { border-top: 0; padding-top: 0; }
    .acct-wish .imgph { border-radius: var(--r-md); }
    .acct-recent > * { width: 140px; }
  `);
  const starPick = (name, val, label, o = {}) => `<fieldset class="acct-stars"><legend class="label">${label}</legend><div class="row gap-1">${[1, 2, 3, 4, 5].map((n) => `<label class="acct-star${o.sm ? ' sm' : ''}${n <= val ? ' on' : ''}" for="${name}-${n}"><input type="radio" class="sr-only" name="${name}" id="${name}-${n}"${n === val ? ' checked' : ''}>${U.icon('star')}<span class="sr-only">${n} ${n > 1 ? 'stars' : 'star'}</span></label>`).join('')}${o.caption ? `<span class="small sub" style="margin-left:6px">${o.caption}</span>` : ''}</div>${o.hint ? `<span class="hint">${o.hint}</span>` : ''}</fieldset>`;

  /* ==================================================================
     12. Profile and preferences
     ================================================================== */
  U.register({
    id: 'account/profile', title: 'Profile', ref: 'Plan ch. 7, 19',
    notes: 'Personal details with verified email, marketing preferences with separate email, SMS and push toggles, and essential order messages explained as always on (plan ch. 19 keeps promotions on separate preferences). A search-history switch controls whether recent searches are saved to the account. Includes data download and account closure.',
    render: () => layout('profile', 'Profile', `
      ${head('Profile', 'Your details and how we contact you.')}
      ${U.card({ title: 'Personal details', body: `
        <div class="grid md2" style="--gap:16px">
          ${U.field('First name', U.input('pf-first', 'Jordan'))}
          ${U.field('Last name', U.input('pf-last', 'Lee'))}
          <div class="field"><label class="label" for="pf-email">Email</label>${U.input('pf-email', D.customer.email, { type: 'email' })}<span class="row gap-2 xs">${U.status('Verified')}<span class="muted">Verified Aug 12. Changing it sends a new verification link.</span></span></div>
          <div class="field"><label class="label" for="pf-phone">Mobile phone</label>${U.input('pf-phone', D.customer.phone, { type: 'tel' })}<span class="hint">Used for delivery problems and 2-step verification.</span></div>
        </div>`, foot: U.btn('Save changes') })}

      ${U.card({ title: 'Order and account messages', sub: 'Always on. You need these to receive your orders safely.', body: `
        <div class="row gap-2 small">${U.icon('lock', 'ic-sm')}<span class="sub">Sent in your account and by email: order accepted, payment result, dispatch, delays, delivery, cancellations, return and refund updates, case replies and security alerts.</span></div>
        <a class="small strong" href="${go('account/notifications')}">See recent notifications</a>` })}

      ${U.card({ title: 'Promotions and offers', sub: 'Optional. Turning these off never affects order updates.', body: `
        <div class="acct-pref"><span class="stack gap-0"><span class="small strong">Email promotions</span><span class="xs muted">Weekly deals, Home Week and seasonal sales. About 2 emails a week.</span></span>${U.toggle('pf-pr-email', '<span class="sr-only">Email promotions</span>', true)}</div>
        <div class="acct-pref"><span class="stack gap-0"><span class="small strong">SMS promotions</span><span class="xs muted">Flash sales by text to ${D.customer.phone}. Message rates may apply.</span></span>${U.toggle('pf-pr-sms', '<span class="sr-only">SMS promotions</span>', false)}</div>
        <div class="acct-pref"><span class="stack gap-0"><span class="small strong">Push promotions</span><span class="xs muted">Offers in the Marketly Android app. Set separately from order push notices.</span></span>${U.toggle('pf-pr-push', '<span class="sr-only">Push promotions</span>', false)}</div>
        <div class="acct-pref"><span class="stack gap-0"><span class="small strong">Wishlist alerts</span><span class="xs muted">Price drops and back-in-stock notices for items you saved. <a href="${go('account/wishlist')}">Manage alerts</a></span></span>${U.toggle('pf-pr-wish', '<span class="sr-only">Wishlist alerts</span>', true)}</div>
        <span class="xs muted">Personalized recommendations use your order history. <a href="${go('info/policy', 'Privacy')}">Privacy policy</a></span>` })}

      ${U.card({ title: 'Search history', body: `
        <div class="acct-pref"><span class="stack gap-0"><span class="small strong">Save recent searches</span><span class="xs muted">Shows your last searches in the search box on every device you sign in to. Turning this off deletes the saved list.</span></span>${U.toggle('pf-recent', '<span class="sr-only">Save recent searches</span>', true)}</div>` })}

      <div class="grid md2">
        ${U.card({ title: 'Download my data', body: `<p class="small sub">Get a copy of your profile, orders, returns, messages and reviews as a ZIP file. We email a link within 48 hours.</p>`, foot: U.btn('Request my data', { v: 'secondary', icon: 'download' }) })}
        ${U.card({ title: 'Close account', body: `<p class="small sub">You can close your account after open orders, returns and cases are finished. You have 1 open order, 3 open returns and 1 open case. We keep order records as the law requires.</p>`, foot: U.btn('Close account', { v: 'danger-soft', disabled: true }) })}
      </div>
    `),
  });

  /* ==================================================================
     13. Sign-in and security
     ================================================================== */
  const device = (icn, name, where, when, cur) => `<div class="acct-row">${ic(icn)}<span class="stack gap-0 grow"><span class="small strong">${name}${cur ? ` ${U.badge('This device', 'brand')}` : ''}</span><span class="xs muted">${where} · ${when}</span></span>${cur ? '' : U.btn('Sign out', { v: 'secondary', size: 'sm' })}</div>`;
  U.register({
    id: 'account/security', title: 'Sign-in and security', ref: 'Plan ch. 7',
    notes: 'Password change, 2-step verification, email verification status, signed-in devices with per-device and everywhere sign-out, and recent security activity so customers can review account access.',
    render: () => layout('security', 'Sign-in and security', `
      ${head('Sign-in and security', 'Keep your account and saved payment methods safe.')}
      ${U.alert('warning', '2-step verification is off', 'Turn it on so a stolen password alone can\'t open your account.')}
      <div class="grid lg2" style="align-items:start">
        ${U.card({ title: 'Password', sub: 'Last changed Oct 2, 2026', body: `
          ${U.field('Current password', U.input('sc-cur', '', { type: 'password' }))}
          ${U.field('New password', U.input('sc-new', '', { type: 'password' }), { hint: 'At least 12 characters. Avoid passwords you use elsewhere.' })}
          ${U.field('Confirm new password', U.input('sc-conf', '', { type: 'password' }))}
          <a class="xs strong" href="${go('auth/recover')}">Forgot your current password?</a>`, foot: U.btn('Change password') })}
        <div class="stack gap-4">
          ${U.card({ title: '2-step verification', sub: 'A code at sign-in on new devices', actions: U.badge('Off', 'warning'), body: `<div class="stack gap-2" role="radiogroup" aria-label="Verification method">
            ${U.optCard('sc-2sv', 'sc-2sv-app', '<span class="strong">Authenticator app</span> ' + U.badge('Recommended', 'brand'), 'Google Authenticator, 1Password or similar.', true)}
            ${U.optCard('sc-2sv', 'sc-2sv-sms', '<span class="strong">Text message</span>', 'Codes sent to (503) •••-0148.', false)}
          </div>`, foot: U.btn('Turn on 2-step verification', { icon: 'shield-check' }) })}
          ${U.card({ title: 'Email verification', body: `<div class="row between"><span class="stack gap-0"><span class="small strong">${D.customer.email}</span><span class="xs muted">Verified Aug 12, 2026. Security alerts go here.</span></span>${U.status('Verified')}</div>` })}
        </div>
      </div>
      ${U.card({ title: 'Where you\'re signed in', sub: '3 devices', actions: U.btn('Sign out everywhere', { v: 'danger-soft', size: 'sm', icon: 'log-out' }), flush: true, body: `
        ${device('monitor', 'Chrome on Windows 11', 'Portland, OR', 'Active now', true)}
        ${device('smartphone', 'Marketly app on Pixel 8', 'Portland, OR', 'Today, 8:02 AM')}
        ${device('laptop', 'Safari on macOS', 'Seattle, WA', 'Sep 29, 4:47 PM')}` })}
      ${U.card({ title: 'Recent security activity', sub: 'Last 30 days · Pacific Time', flush: true, body: U.table(['Date', 'Activity', 'Device and location', 'Result'], [
        ['Oct 6, 9:12 AM', 'Signed in', 'Chrome on Windows · Portland, OR', U.status('Completed')],
        ['Oct 2, 7:30 PM', 'Password changed', 'Marketly app on Pixel 8 · Portland, OR', U.status('Completed')],
        ['Sep 29, 4:47 PM', 'Signed in on a new device', 'Safari on macOS · Seattle, WA', U.status('Completed')],
        ['Sep 27, 11:03 PM', '3 wrong passwords, sign-in blocked for 15 min', 'Unknown browser · Phoenix, AZ', U.status('Failed')],
      ]), foot: `<span class="xs muted grow">Don't recognize something? Change your password and sign out everywhere, then <a href="${go('help/contact')}">contact support</a>.</span>` })}
    `),
  });

  /* ==================================================================
     14. Payment methods
     ================================================================== */
  const cardRow = (brand, label, last4, exp, o = {}) => `<div class="acct-row">
    <span class="acct-cc" aria-hidden="true">${brand === 'Visa' ? 'VISA' : 'MC'}</span>
    <span class="stack gap-1 grow">
      <span class="row gap-2"><span class="small strong">${label}</span>${o.def ? U.badge('Default', 'brand') : ''}${o.expired ? U.status('Expired') : ''}</span>
      <span class="xs muted">${brand} ending in <span class="num">${last4}</span> · ${o.expired ? 'Expired' : 'Expires'} ${exp} · Billing: ${o.billing}</span>
    </span>
    <span class="row gap-2">${o.expired ? U.btn('Update expiry', { v: 'secondary', size: 'sm' }) : ''}${o.def || o.expired ? '' : U.btn('Make default', { v: 'ghost', size: 'sm' })}${U.btn('Remove', { v: 'ghost', size: 'sm', icon: 'trash-2' })}</span>
  </div>`;
  U.register({
    id: 'account/payment-methods', title: 'Payment methods', ref: 'Plan ch. 7, 14',
    notes: 'Saved cards show a recognisable label, last 4 digits and expiry, with default, remove and an expired card example. Removing a card does not affect past receipts. The add-card form uses empty placeholders only.',
    render: () => layout('payment', 'Payment methods', `
      ${head('Payment methods', 'Cards saved for faster checkout.')}
      ${U.card({ title: 'Saved cards', flush: true, body: `
        ${cardRow('Visa', 'Personal Visa', '4417', '08/29', { def: true, billing: 'Home, Portland 97205' })}
        ${cardRow('Mastercard', 'Work Mastercard', '2051', '11/27', { billing: 'Work, Portland 97204' })}
        ${cardRow('Visa', 'Old debit card', '9032', '09/26', { expired: true, billing: 'Home, Portland 97205' })}`,
        foot: `<span class="xs muted grow">${U.icon('info', 'ic-sm')} Removing a card doesn't affect past receipts. Refunds for earlier orders still go back to the card you paid with.</span>` })}
      ${U.card({ title: 'Add a card', sub: 'We accept Visa, Mastercard, American Express and Discover.', body: `
        ${U.field('Card number', U.input('pm-num', '', { placeholder: 'Card number', icon: 'credit-card' }))}
        <div class="grid c2" style="--gap:12px">
          ${U.field('Expiry date', U.input('pm-exp', '', { placeholder: 'MM / YY' }))}
          ${U.field('Security code', U.input('pm-cvc', '', { placeholder: '3 or 4 digits' }), { hint: 'On the back of the card, or the front for Amex.' })}
        </div>
        ${U.field('Name on card', U.input('pm-name', '', { placeholder: 'As printed on the card' }))}
        ${U.field('Card label', U.input('pm-label', '', { placeholder: 'For example: Travel card' }), { opt: true, hint: 'Helps you recognise the card at checkout.' })}
        <div class="field"><span class="label">Billing address</span><div class="stack gap-2" role="radiogroup" aria-label="Billing address">
          ${U.optCard('pm-bill', 'pm-bill-home', '<span class="strong">Home</span>', '2140 Alder St, Apt 5, Portland, OR 97205', true)}
          ${U.optCard('pm-bill', 'pm-bill-work', '<span class="strong">Work</span>', '815 SW 2nd Ave, Floor 4, Portland, OR 97204', false)}
          ${U.optCard('pm-bill', 'pm-bill-new', '<span class="strong">Use a different billing address</span>', '', false)}
        </div></div>
        ${U.check('pm-default', 'Make this my default card', false)}
        <span class="row gap-2 xs muted">${U.icon('lock', 'ic-sm')} Card details go straight to our payment provider. Marketly only keeps the card type, last 4 digits and expiry.</span>`,
        foot: `${U.btn('Cancel', { v: 'ghost' })}${U.btn('Save card')}` })}
    `),
  });

  /* ==================================================================
     15. Write a review
     ================================================================== */
  U.register({
    id: 'account/review', title: 'Write a review', ref: 'Plan ch. 17',
    notes: 'Product review and seller feedback are separate sections with copy explaining the difference, so a product defect and a seller service problem are not confused. Shows the Verified Purchase label, guidelines and that feedback can be edited later.',
    render: () => {
      const bar = `${U.btn('Save draft', { v: 'ghost' })}<span class="grow"></span>${U.btn('Post review', { href: go('account/reviews') })}`;
      return layout('orders', 'Write a review', `
        ${U.crumbs([{ label: 'Orders', href: go('account/orders') }, { label: O.ref, href: go('account/order') }, { label: 'Write a review' }])}
        ${head('Write a review', 'Two short parts. Each one appears in a different place.')}
        <section class="card pad row gap-4 nowrap top">${U.pimg(P.aurora, 'thumb')}<div class="stack gap-1">${pname(P.aurora)}<span class="xs muted">Midnight black · Delivered Sep 17 · Order <span class="mono">${O.ref}</span></span><span class="row gap-2">${U.badge('Verified Purchase', 'success', 'badge-check')}${U.sellerLine('official')}</span></div></section>
        <div class="acct-split">
          <div class="stack gap-4">
            ${U.card({ title: '1. Product review', sub: 'About the headphones themselves: sound, comfort, battery. Shown on the product page for every seller.', body: `
              ${starPick('rv-prod', 4, 'Overall rating', { caption: 'Good' })}
              ${U.field('Headline', U.input('rv-head', 'Great noise cancelling, tight fit at first'))}
              ${U.field('Your review', U.textarea('rv-text', 'The ANC blocks out bus and office noise really well and the battery lasted a full week of commuting. Clamping force was strong for the first few days but eased up. Call quality is fine indoors, weaker outside in wind.'), { hint: 'At least 50 characters. 238 so far.' })}
              <div class="field"><span class="label">Photos <span class="opt">(optional)</span></span>${U.dropzone('Add photos of the product', 'Up to 6 photos, JPG or PNG')}</div>
              ${U.check('rv-name', 'Show my name as Jordan L.', true)}` })}
            ${U.card({ title: '2. Seller feedback for Marketly Official', sub: 'About buying from this seller: accuracy, dispatch and communication. Shown on the seller profile, not the product page.', body: `
              <div class="field"><span class="label" id="rv-desc-l">Was the item as described?</span>${U.seg(['Yes', 'No'], 0)}</div>
              ${starPick('rv-ship', 5, 'Dispatch speed', { sm: true, caption: 'Arrived Sep 17, 1 day early' })}
              ${starPick('rv-comm', 0, 'Communication', { sm: true, hint: 'Leave blank if you didn\'t contact the seller.' })}
              ${U.field('Comment for the seller', U.textarea('rv-seller', '', 'For example: well packed, arrived early.'), { opt: true })}` })}
            <div class="row between only-desktop">${U.btn('Save draft', { v: 'ghost' })}${U.btn('Post review', { href: go('account/reviews') })}</div>
          </div>
          <aside>
            ${U.card({ title: 'Product review or seller feedback?', body: `<div class="stack gap-3 small sub">
              <p><span class="strong" style="color:var(--text)">Product review</span>: the item. If it broke or sounds bad, say it here.</p>
              <p><span class="strong" style="color:var(--text)">Seller feedback</span>: the purchase. Late dispatch, poor packing or slow replies go here.</p>
              <p>Need a refund or repair instead? <a href="${go('help/order-problem')}">Report a problem</a> or <a href="${go('account/return-new')}">return the item</a>.</p></div>` })}
            ${U.card({ title: 'Review guidelines', body: `<ul class="ul small sub stack gap-1">
              <li>Describe your own experience with this item.</li>
              <li>No personal details, links, prices or order numbers.</li>
              <li>No offers of payment or free items for reviews.</li>
              <li>We don't remove fair negative reviews.</li></ul>
              <a class="small strong" href="${go('help/article')}">Full review rules</a>` })}
            ${U.alert('info', 'You can edit later', '<span class="strong">Verified Purchase</span> means this review is linked to your recorded order. You can edit or delete it any time from <a href="' + go('account/reviews') + '">Reviews and feedback</a>, and we\'ll tell you if moderation changes it.')}
          </aside>
        </div>
      `, { actionBar: bar });
    },
  });

  /* ==================================================================
     15b. Reviews and feedback (my reviews, seller feedback, reports)
     ================================================================== */
  const rvActs = (o = {}) => `<div class="row gap-2">${o.edit === false ? '' : U.btn(o.editLabel || 'Edit', { v: 'secondary', size: 'sm', icon: 'pencil', href: go('account/review') })}${U.btn('Delete', { v: 'ghost', size: 'sm', icon: 'trash-2' })}</div>`;
  const myReview = (p, r) => `<article class="card">
    <div class="card-body">
      <div class="row gap-3 nowrap top">
        ${thumb(p)}
        <div class="stack gap-1 grow">
          <div class="row between gap-2 top">${pname(p)}${r.status}</div>
          <span class="row gap-2">${U.stars5(r.stars, 14)}<span class="small strong">${r.head}</span></span>
          <p class="small sub">${r.text}</p>
          <span class="row gap-2 xs muted">${U.badge('Verified Purchase', 'success', 'badge-check')}<span>${r.meta}</span></span>
        </div>
      </div>
      ${r.extra || ''}
    </div>
    <div class="card-foot" style="justify-content:space-between"><span class="xs muted">${r.foot || ''}</span>${rvActs(r.acts)}</div>
  </article>`;

  U.register({
    id: 'account/reviews', title: 'Reviews and feedback', ref: 'Plan ch. 17',
    notes: 'Everything the customer has written or reported: product reviews and seller feedback on separate tabs, with edit and delete, moderation outcomes with reason and an appeal route, items waiting for a review, and the outcome of reports made about other content.',
    states: ['Product reviews', 'Seller feedback', 'Reports you made'],
    render: (state) => {
      const tab = state || 'Product reviews';
      const tabs = U.tabs([
        { label: 'Product reviews', count: 3, href: go('account/reviews', 'Product reviews') },
        { label: 'Seller feedback', count: 2, href: go('account/reviews', 'Seller feedback') },
        { label: 'Reports you made', count: 3, href: go('account/reviews', 'Reports you made') },
      ], tab);
      let body = '';
      if (tab === 'Product reviews') {
        body = `
          ${U.card({ title: 'Waiting for your review', sub: 'Delivered purchases you haven\'t reviewed yet', flush: true, body: `
            <div class="acct-row">${U.pimg(P.aurora, 'tiny')}<span class="stack gap-0 grow"><span class="small strong">${U.esc(P.aurora.name)}</span><span class="xs muted">Delivered Sep 17 · Marketly Official</span></span>${sm('Write a review', go('account/review'), { icon: 'star' })}</div>
            <div class="acct-row">${U.pimg(P.skillet, 'tiny')}<span class="stack gap-0 grow"><span class="small strong">${U.esc(P.skillet.name)}</span><span class="xs muted">Delivered Sep 2 · Marketly Official</span></span>${sm('Write a review', go('account/review'), { icon: 'star' })}</div>` })}
          <h2 class="h3">Your reviews</h2>
          ${myReview(P.bottle, { stars: 5, head: 'Ice lasts all day on the trail', text: 'Filled it with ice at 7 AM and still had ice at 5 PM on a hot hike. The lid seals well and fits my pack\'s side pocket.', status: U.status('Published'), meta: 'Posted Aug 25 · 14 people found this helpful', foot: 'Shown on the product page for all sellers.' })}
          ${myReview(P.sweater, { stars: 2, head: 'Shrank after one wash', text: 'Followed the cold-wash label and it still shrank a full size. Soft and warm before that.', status: U.status('Hidden: under review', 'warning'), meta: 'Posted Oct 3',
            extra: U.alert('warning', 'Hidden while we check a report', 'A shopper reported this review on Oct 6. We\'re checking it against the review rules and will decide by Sat, Oct 10. Negative reviews are not removed for being negative. You don\'t need to do anything.'),
            foot: 'Not visible to shoppers right now.' })}
          ${myReview(P.serum, { stars: 1, head: 'Broke me out, contact me for details', text: 'Caused redness after two days. Text me at the number in my profile if you want photos.', status: U.status('Removed', 'danger'), meta: 'Posted Sep 14',
            extra: `<div class="panel stack gap-2">
              <span class="row gap-2 small strong">${U.icon('circle-alert', 'ic-sm')} Removed on Sep 18 by Marketly review moderation</span>
              <span class="xs sub"><span class="strong">Reason:</span> it asks shoppers to contact you directly, which the review rules don't allow. Your rating and experience were not the reason.</span>
              <span class="row gap-3 xs"><a class="strong" href="${go('help/case')}">Appeal this decision</a><span class="muted">Appeal by Oct 18</span><a href="${go('help/article')}">Review rules</a></span>
            </div>`,
            acts: { editLabel: 'Edit and resubmit' }, foot: 'You can fix it and post it again.' })}`;
      } else if (tab === 'Seller feedback') {
        body = `
          ${U.alert('info', 'Seller feedback is about the purchase, not the product', 'It shows on the seller\'s profile and covers accuracy, dispatch and communication. Product reviews are on the other tab.')}
          ${U.card({ title: 'Waiting for your feedback', flush: true, body: `
            <div class="acct-row">${U.logoTile(S.official)}<span class="stack gap-0 grow"><span class="small strong">Marketly Official</span><span class="xs muted">Order <span class="mono">${O.ref}</span> · Package 1, delivered Sep 17</span></span>${sm('Leave feedback', go('account/review'))}</div>
            <div class="acct-row">${U.logoTile(S.pixelport)}<span class="stack gap-0 grow"><span class="small strong">Pixel &amp; Port</span><span class="xs muted">Order <span class="mono">${O.ref}</span> · Package 2 · available after delivery</span></span>${U.btn('Leave feedback', { v: 'secondary', size: 'sm', disabled: true })}</div>` })}
          <h2 class="h3">Feedback you gave</h2>
          ${[
            { s: 'trailhead', order: 'MK-260806-02291', date: 'Aug 26', desc: 'Yes', ship: 5, comm: 'Didn\'t contact', text: 'Well packed and arrived a day early.', st: U.status('Published') },
            { s: 'pixelport', order: 'MK-260920-33018', date: 'Oct 3', desc: 'Yes', ship: 4, comm: 2, text: 'Item was fine but it took 3 days to answer my return question.', st: U.status('Published'), reply: 'Sorry for the slow reply, Jordan. We\'ve added weekend support since then. Pixel & Port, Oct 4' },
          ].map((f) => `<article class="card">
            <div class="card-body">
              <div class="row between gap-2 top"><div class="row gap-3 nowrap">${U.logoTile(S[f.s])}<div class="stack gap-0"><span class="small strong">${U.esc(S[f.s].name)}</span><span class="xs muted">Order <span class="mono">${f.order}</span> · posted ${f.date}</span></div></div>${f.st}</div>
              <div class="grid md3" style="--gap:12px">
                <div class="panel stack gap-1"><span class="acct-k">As described</span><span class="small strong">${f.desc}</span></div>
                <div class="panel stack gap-1"><span class="acct-k">Dispatch speed</span>${U.stars5(f.ship, 14)}</div>
                <div class="panel stack gap-1"><span class="acct-k">Communication</span>${typeof f.comm === 'number' ? U.stars5(f.comm, 14) : `<span class="small sub">${f.comm}</span>`}</div>
              </div>
              <p class="small sub">${f.text}</p>
              ${f.reply ? `<div class="panel stack gap-1"><span class="acct-k">Public reply from the seller</span><span class="small sub">${f.reply}</span></div>` : ''}
            </div>
            <div class="card-foot" style="justify-content:space-between"><span class="xs muted">Shown on the seller profile only.</span>${rvActs()}</div>
          </article>`).join('')}`;
      } else {
        body = `
          <p class="small sub">Reports you sent about reviews, answers or listings from other people. The people you report never see your name.</p>
          <section class="card">
            ${[
              { icon: 'message-square-warning', what: 'Report on a review', about: `Review of ${U.esc(P.kestrel27.name)} by "Sam R."`, why: 'You said: off-topic, about a different monitor', date: 'Sep 30', st: U.status('Removed', 'success'), outcome: 'Removed for off-topic content on Oct 2. Thanks, the product page is more accurate now.' },
              { icon: 'circle-help', what: 'Report on an answer', about: `Answer to "Does it fit a 16-inch laptop?" on ${U.esc(P.backpack.name)}`, why: 'You said: wrong information', date: 'Sep 12', st: U.status('Decision made'), outcome: 'No violation found. Trailhead Outfitters confirmed the sleeve fits 16-inch laptops and added the size to the product details.' },
              { icon: 'shield-alert', what: 'Report on a listing', about: `${U.esc(P.vacuum.name)} from Gadget Grove`, why: 'You said: may be counterfeit', date: 'Oct 5', st: U.status('Under review'), outcome: 'Our trust team is checking the seller\'s proof of supply. Expected outcome by Oct 12. Case <span class="mono">CS-261005-3390</span>.' },
            ].map((r) => `<div class="acct-row">${ic(r.icon, r.st.includes('t-info') ? 'info' : '')}<span class="stack gap-1 grow">
                <span class="row between gap-2 top"><span class="small strong">${r.what}</span>${r.st}</span>
                <span class="xs sub">${r.about}</span>
                <span class="xs muted">${r.why} · reported ${r.date}</span>
                <span class="xs"><span class="strong">Outcome:</span> <span class="sub">${r.outcome}</span></span>
              </span></div>`).join('')}
          </section>
          <span class="xs muted">To report something new, use the Report link on the review, answer or listing.</span>`;
      }
      return layout('reviews', 'Reviews and feedback', `
        ${head('Reviews and feedback', 'Product reviews describe the item. Seller feedback describes buying from a seller. You can edit either one later.')}
        ${tabs}
        <div class="stack gap-4">${body}</div>
      `);
    },
  });

  /* ==================================================================
     16. Wishlist and alerts
     ================================================================== */
  const WISH = [
    { p: 'kestrel27', price: 299, was: 329, hint: 'Lowest in 30 days', stock: 'In stock', drop: true, back: false },
    { p: 'backpack', price: 139, was: 165, hint: 'Typical price $139–$165', stock: 'Out of stock', drop: false, back: true },
    { p: 'lamp', price: 42, was: null, hint: 'Same price for 30 days', stock: 'Low stock', drop: true, back: false, left: '9 left' },
    { p: 'sweater', price: 84, was: null, hint: 'Lowest in 30 days', stock: 'In stock', drop: false, back: false },
  ];
  U.register({
    id: 'account/wishlist', title: 'Wishlist and alerts', ref: 'Plan ch. 7, 19',
    notes: 'Saved items with price-drop and back-in-stock alert toggles, a price history hint, move to cart, recently viewed and an alerts list. Plan marks wishlist as a Growth feature: coming in a later release.',
    render: () => layout('wishlist', 'Wishlist and alerts', `
      ${head('Wishlist and alerts', '4 saved items · alerts arrive as notifications and email.', U.btn('Share list', { v: 'secondary', size: 'sm', icon: 'share-2' }))}
      <div class="grid md2 lg2" style="--gap:16px">${WISH.map((w, i) => { const p = P[w.p]; return `
        <article class="card pad acct-wish stack gap-3">
          <div class="row gap-3 nowrap top">
            <a href="${go('store/product')}" style="width:96px;flex:none" aria-label="${U.esc(p.name)}">${U.pimg(p)}</a>
            <div class="stack gap-1 grow">
              ${pname(p)}
              ${U.sellerLine(p.seller)}
              ${U.price(w.price, w.was)}
              <span class="row gap-2">${w.hint.startsWith('Lowest') ? U.badge(w.hint, 'success', 'trending-down') : `<span class="xs muted">${w.hint}</span>`}</span>
              <span class="row gap-2">${U.status(w.stock)}${w.left ? `<span class="xs muted">${w.left}</span>` : ''}</span>
            </div>
            ${U.iconBtn('x', 'Remove ' + p.name + ' from wishlist')}
          </div>
          <div class="stack gap-2 panel">
            ${U.toggle('wl-drop-' + i, 'Alert me when the price drops', w.drop)}
            ${U.toggle('wl-back-' + i, 'Alert me when it\'s back in stock', w.back)}
          </div>
          ${w.stock === 'Out of stock' ? U.btn('Out of stock', { v: 'secondary', disabled: true, block: true }) : U.btn('Move to cart', { icon: 'shopping-cart', block: true, href: go('store/cart') })}
        </article>`; }).join('')}</div>
      ${U.card({ title: 'Your alerts', sub: 'Turn alerts off any time. These are separate from order updates.', flush: true, body: U.table(['Item', 'Alert', { label: 'Condition' }, 'Status', ''], [
        [`<div class="cell-main">${U.pimg(P.kestrel27, 'tiny')}<span class="small">${U.esc(P.kestrel27.name)}</span></div>`, 'Price drop', 'Any drop below $329.00', U.status('Triggered', 'success')],
        [`<div class="cell-main">${U.pimg(P.lamp, 'tiny')}<span class="small">${U.esc(P.lamp.name)}</span></div>`, 'Price drop', 'Any drop below $42.00', U.status('Active')],
        [`<div class="cell-main">${U.pimg(P.backpack, 'tiny')}<span class="small">${U.esc(P.backpack.name)}</span></div>`, 'Back in stock', 'Olive, from Trailhead Outfitters', U.status('Active')],
      ].map((r) => r.concat([U.btn('Remove', { v: 'ghost', size: 'sm' })]))) })}
      <section class="stack gap-3" aria-labelledby="wl-recent">
        ${U.sectionHead('<span id="wl-recent">Recently viewed</span>', { link: 'Clear history', href: 'javascript:void 0' })}
        <div class="hscroll acct-recent">${['ssd1tb', 'speaker', 'duvet', 'skillet', 'keyboard', 'serum'].map((id) => { const p = P[id]; return `<a href="${go('store/product')}" class="stack gap-2" style="color:var(--text)">${U.pimg(p)}<span class="xs clamp-2">${U.esc(p.name)}</span>${U.price(p.price, p.was, { noOff: true })}</a>`; }).join('')}</div>
      </section>
    `),
  });

  /* ==================================================================
     17. Coupons and store credit
     ================================================================== */
  const coupon = (amt, unit, title, cond, code, exp, o = {}) => `<article class="acct-coupon${o.muted ? ' is-muted' : ''}">
    <div class="amt"><span>${amt}</span><small>${unit}</small></div>
    <div class="bd">
      <div class="row between top gap-2"><span class="small strong">${title}</span>${o.action || ''}</div>
      <span class="xs sub">${cond}</span>
      <span class="row gap-3 xs muted"><span class="mono">${code}</span><span>${exp}</span>${o.muted ? '' : '<a href="javascript:void 0">Terms</a>'}</span>
    </div>
  </article>`;
  U.register({
    id: 'account/coupons', title: 'Coupons and credit', ref: 'Plan ch. 7, 15',
    notes: 'Available coupons with clip, terms, expiry and which items they apply to, store credit balance with its history, and used or expired coupons kept for reference.',
    render: () => layout('coupons', 'Coupons and credit', `
      ${head('Coupons and credit', 'Clipped coupons apply at checkout to the items they cover. You see each discount before you pay.')}
      <div class="grid lg2" style="align-items:start">
        <section class="card pad stack gap-3" aria-labelledby="cp-credit">
          <div class="row between"><h2 class="h3" id="cp-credit">Store credit</h2>${U.icon('wallet')}</div>
          <span class="stack gap-0"><span class="display d-lg num">${money(15)}</span><span class="xs muted">Available now · expires Sep 4, 2027</span></span>
          <p class="small sub">Choose to use it at the payment step of checkout. It covers any item from any seller.</p>
        </section>
        ${U.card({ title: 'Credit history', flush: true, body: U.table(['Date', 'Activity', { label: 'Amount', cls: 'r' }], [
          ['Sep 4, 2026', `Goodwill credit · case <span class="mono">CS-260903-1876</span>, late delivery`, `<span class="t-success-text strong">+${money(15)}</span>`],
          ['Aug 30, 2026', `Used on order <span class="mono">MK-260830-11764</span>`, `−${money(10)}`],
          ['Aug 2, 2026', `Price adjustment · case <span class="mono">CS-260801-0950</span>`, `<span class="t-success-text strong">+${money(10)}</span>`],
        ]) })}
      </div>
      <section class="stack gap-3" aria-labelledby="cp-avail">
        <h2 class="h3" id="cp-avail">Available coupons</h2>
        <div class="grid md2" style="--gap:12px">
          ${coupon('15%', 'off', 'Home Week: 15% off Home & Kitchen', 'Min. spend $75 on eligible items. Applies to Official Store and Casa Verde Home items in Home & Kitchen.', 'HOMEWEEK15', 'Expires Oct 19', { action: U.btn('Clip', { size: 'sm', icon: 'scissors' }) })}
          ${coupon('$10', 'off', '$10 off Northwind Audio', 'Orders of $80 or more from Northwind Audio. Headphones, speakers and cables.', 'NWA10', 'Expires Oct 31', { action: U.badge('Clipped', 'success', 'check') })}
          ${coupon('Free', 'shipping', 'Free shipping from Pixel & Port', 'Any Pixel & Port order over $50. One use.', 'PPSHIP50', 'Expires Nov 15', { action: U.btn('Clip', { size: 'sm', icon: 'scissors' }) })}
          ${coupon('$5', 'off', '$5 off your next Official Store order', 'Min. spend $35 on Official Store items. Not valid on gift cards.', 'THANKS5', 'Expires Dec 31', { action: U.badge('Clipped', 'success', 'check') })}
        </div>
        <span class="xs muted">One coupon per seller package. Some coupons can't be combined with sale prices; checkout tells you which.</span>
      </section>
      <section class="stack gap-3" aria-labelledby="cp-used">
        <h2 class="h3" id="cp-used">Used and expired</h2>
        <div class="grid md2" style="--gap:12px">
          ${coupon('$20', 'off', 'Welcome coupon', `Used Sep 14 on order <span class="mono">MK-260914-48213</span>. Saved $20.00.`, 'WELCOME20', 'Used', { muted: true, action: U.status('Completed', '') })}
          ${coupon('$5', 'off', 'Fall kickoff', 'Not used.', 'FALL5', 'Expired Sep 30', { muted: true, action: U.status('Expired') })}
        </div>
      </section>
    `),
  });
})();
