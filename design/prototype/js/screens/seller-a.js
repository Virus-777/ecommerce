/* Seller Center A: setup, dashboard, products and offers, inventory, orders, shipping (plan ch. 8, 10, 11, 12) */
(function () {
  const U = UI;
  const D = window.D;
  const { icon, btn, badge, status, money, num, go, card, table, field, input, select, textarea, check, alert, kv, timeline, deadline, pageHead, tabs, searchIn } = U;

  U.css('seller-a', `
    .sa-tiles { display: grid; gap: var(--sp-2); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 600px) { .sa-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @container app (min-width: 1180px) { .sa-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .sa-split { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1180px) { .sa-split { grid-template-columns: minmax(0, 1fr) 340px; } .sa-sticky { position: sticky; top: 80px; } }
    .sa-kpis { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 1024px) { .sa-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .sa-ind { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .sa-ind { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .sa-ind .card { display: flex; flex-direction: column; gap: var(--sp-2); }
    .sa-steplist > li { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: var(--sp-2) var(--sp-3); padding: var(--sp-4); border-bottom: 1px solid var(--border); align-items: start; }
    .sa-steplist > li:last-child { border-bottom: 0; }
    .sa-steplist .sa-cta { grid-column: 2; display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    @container app (min-width: 768px) {
      .sa-steplist > li { grid-template-columns: 32px minmax(0, 1fr) auto; padding: var(--sp-4) var(--sp-5); align-items: center; }
      .sa-steplist .sa-cta { grid-column: auto; justify-content: flex-end; }
    }
    .sa-dot { width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--surface); color: var(--text-3); font-weight: 700; font-size: var(--fs-sm); border: 1.5px solid var(--border-strong); }
    .sa-dot.is-done { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
    .sa-dot.is-warn { background: var(--warning-soft); border-color: var(--warning); color: var(--warning); }
    .sa-dot.is-lock { background: var(--surface-2); }
    .sa-reason { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; padding: 6px 8px; border-radius: var(--r-sm); background: var(--warning-soft); color: var(--text); font-size: var(--fs-xs); line-height: 1.4; max-width: 46ch; white-space: normal; }
    .sa-reason.t-danger { background: var(--danger-soft); }
    .sa-reason svg.lucide { width: 14px; height: 14px; color: var(--warning); flex: none; margin-top: 1px; }
    .sa-reason.t-danger svg.lucide { color: var(--danger); }
    .app .input.sa-num { width: 84px; min-height: 34px; height: 34px; text-align: right; font-variant-numeric: tabular-nums; padding: 0 var(--sp-2); }
    .app .input.sa-mid { width: 120px; min-height: 34px; height: 34px; padding: 0 var(--sp-2); }
    .app .input.sa-sku { width: 150px; min-height: 34px; height: 34px; padding: 0 var(--sp-2); font-family: var(--font-mono); font-size: var(--fs-sm); }
    .sa-hl { border-left: 3px solid var(--danger); padding-left: var(--sp-3); }
    .sa-thumbs { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .sa-thumb { position: relative; width: 88px; }
    .sa-thumb .badge { position: absolute; left: 4px; bottom: 4px; }
    .sa-thumb.is-error .imgph { box-shadow: 0 0 0 2px var(--danger); }
    .sa-pills { display: flex; flex-wrap: wrap; gap: 6px; }
    .sa-result { display: grid; gap: var(--sp-3) var(--sp-4); grid-template-columns: 72px minmax(0, 1fr); padding: var(--sp-4); border-bottom: 1px solid var(--border); }
    .sa-result:last-child { border-bottom: 0; }
    .sa-result .sa-go { grid-column: 1 / -1; display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    @container app (min-width: 768px) {
      .sa-result { grid-template-columns: 104px minmax(0, 1fr) auto; padding: var(--sp-5); }
      .sa-result .sa-go { grid-column: auto; flex-direction: column; align-items: stretch; min-width: 170px; }
    }
    .sa-ocards { display: flex; flex-direction: column; }
    .sa-ocards > li { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4); border-bottom: 1px solid var(--border); }
    .sa-ocards > li:last-child { border-bottom: 0; }
    .sa-perf > li { display: flex; flex-direction: column; gap: 6px; padding: var(--sp-3) 0; border-bottom: 1px solid var(--border); }
    .sa-perf > li:last-child { border-bottom: 0; }
    .sa-money { font-size: var(--fs-xl); font-weight: 700; font-variant-numeric: tabular-nums; }
    .sa-arrow { color: var(--text-3); padding-inline: 4px; }
    .sa-strike { color: var(--text-3); }
    .sa-savebar { position: sticky; bottom: var(--sp-3); z-index: 10; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--sp-3) var(--sp-4); box-shadow: var(--sh-2); display: flex; gap: var(--sp-3); flex-wrap: wrap; align-items: center; justify-content: space-between; }
    .sa-days { display: flex; gap: 6px; flex-wrap: wrap; }
    .sa-days .pill-opt { min-width: 48px; min-height: 36px; }
    .sa-ro { background: var(--surface-2); border-radius: var(--r-md); padding: var(--sp-3) var(--sp-4); }
    .sa-cd { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-radius: var(--r-md); background: var(--warning-soft); }
    .sa-cd.t-ok { background: var(--success-soft); }
    .sa-cd .big { font-size: var(--fs-xl); font-weight: 700; font-variant-numeric: tabular-nums; }
    .sa-msg { padding: var(--sp-3); border-radius: var(--r-md); background: var(--surface-2); font-size: var(--fs-sm); max-width: 520px; }
    .sa-msg.me { background: var(--brand-soft); margin-left: auto; }
    .sa-pkgitem { display: flex; gap: var(--sp-3); align-items: center; padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-md); }
    .sa-feat { display: flex; gap: var(--sp-2); align-items: center; }
    .sa-feat .input { flex: 1; }
    .sa-checklist > li { display: flex; gap: var(--sp-2); align-items: flex-start; padding: var(--sp-2) 0; font-size: var(--fs-sm); }
    .sa-checklist > li svg.lucide { width: 18px; height: 18px; margin-top: 1px; flex: none; }
    .sa-checklist .ok svg.lucide { color: var(--success); }
    .sa-checklist .miss svg.lucide { color: var(--danger); }
    .sa-checklist .warn svg.lucide { color: var(--warning); }
  `);

  /* ---------- Local helpers ---------- */
  const ex = (t) => `<p class="xs muted row gap-1 nowrap" style="flex-wrap:nowrap;align-items:flex-start">${icon('info', 'ic-sm')}<span style="white-space:normal">${t}</span></p>`;
  const prodCell = (p, sub, href, extra = '') => `<div class="cell-main">${U.img(p.icon, p.tint, 'tiny')}<div class="stack gap-0" style="min-width:0"><a class="small strong" href="${href || go('seller/offer')}">${p.name}</a><span class="xs muted">${sub}</span>${extra}</div></div>`;
  const reason = (t, tone) => `<div class="sa-reason${tone ? ' t-' + tone : ''}">${icon(tone === 'danger' ? 'circle-alert' : 'message-square-warning')}<span>${t}</span></div>`;
  const tb = (inner) => `<div class="toolbar">${inner}</div>`;
  const back = (label, id) => `<a class="small strong row gap-1" href="${go(id)}">${icon('arrow-left', 'ic-sm')}${label}</a>`;

  /* ---------- Northwind Audio catalog (seller view) ---------- */
  const NW = [
    { name: 'Halden Pocket Bluetooth Speaker', v: 'Teal', sku: 'NWA-PKT-TEAL', price: 59, stock: 88, res: 4, low: 10, cond: 'New', review: 'Approved', pub: 'Active', icon: 'speaker', tint: 'var(--img-2)', upd: 'Oct 8, 9:15 AM · Order MK-261008-12077' },
    { name: 'Halden Pocket Bluetooth Speaker', v: 'Charcoal', sku: 'NWA-PKT-CHR', price: 59, stock: 6, res: 1, low: 10, cond: 'New', review: 'Approved', pub: 'Active', icon: 'speaker', tint: 'var(--img-6)', upd: 'Oct 7, 6:49 PM · Order MK-261007-10433' },
    { name: 'Halden Aurora ANC Wireless Headphones', v: 'Midnight black', sku: 'NWA-AUR-BLK', price: 184, stock: 14, res: 2, low: 5, cond: 'New', review: 'Approved', pub: 'Active', icon: 'headphones', tint: 'var(--img-2)', upd: 'Oct 8, 8:03 AM · Order MK-261008-11902' },
    { name: 'Halden Aurora ANC Wireless Headphones', v: 'Silver', sku: 'NWA-AUR-SLV', price: 184, stock: 0, res: 1, low: 5, cond: 'New', review: 'Approved', pub: 'Active', icon: 'headphones', tint: 'var(--img-1)', upd: 'Oct 7, 3:21 PM · Order MK-261007-10291' },
    { name: 'Northwind Studio Cable Kit', v: '3.5 mm + 6.35 mm, 2 m', sku: 'NWA-CBL-KIT', price: 24, stock: 42, res: 5, low: 15, cond: 'New', review: 'Approved', pub: 'Active', icon: 'cable', tint: 'var(--img-3)', upd: 'Oct 6, 4:30 PM · Avery Stone, received stock' },
    { name: 'Halden Aurora ANC Wireless Headphones', v: 'Midnight black', sku: 'NWA-AUR-BLK-U', price: 139, stock: 2, res: 0, low: 2, cond: 'Used – Good', review: 'Approved', pub: 'Hidden', icon: 'headphones', tint: 'var(--img-2)', upd: 'Oct 2, 11:12 AM · Avery Stone', note: 'Hidden by you on Oct 2' },
    { name: 'Ferro HD-60 Studio Monitor Headphones', v: '2 colors · Black, White', sku: 'NWA-FER-HD60', price: 129, stock: 20, res: 0, low: 5, cond: 'New', review: 'Changes requested', pub: 'Not published', icon: 'headphones', tint: 'var(--img-4)', upd: 'Oct 3, 2:40 PM · Avery Stone', why: 'Catalog team, Oct 6: Main image has a text overlay. Frequency response differs from the manufacturer spec. Carry pouch is shown but not listed.' },
    { name: 'Lumen B5 Bookshelf Speakers (pair)', v: 'Walnut', sku: 'NWA-LUM-B5-WAL', price: 249, stock: 8, res: 0, low: 2, cond: 'New', review: 'Submitted', pub: 'Not published', icon: 'speaker', tint: 'var(--img-3)', upd: 'Oct 7, 4:02 PM · Jae Park', note: 'Submitted Oct 7 · review usually takes 2 business days' },
    { name: 'Arclight Mini USB-C DAC', v: 'Graphite', sku: 'NWA-ARC-DAC', price: 79, stock: 0, res: 0, low: 3, cond: 'New', review: 'Draft', pub: 'Not published', icon: 'usb', tint: 'var(--img-6)', upd: 'Oct 5, 1:15 PM · Avery Stone', note: 'Missing images and identifiers' },
    { name: 'Sora SX-7 Cassette Deck', v: 'Silver', sku: 'NWA-SORA-SX7', price: 210, stock: 1, res: 0, low: 1, cond: 'Refurbished', review: 'Rejected', pub: 'Not published', icon: 'cassette-tape', tint: 'var(--img-5)', upd: 'Sep 30, 9:40 AM · Avery Stone', why: 'Refurbished audio equipment needs category approval first. Apply for Refurbished in Store and settings, then submit again.' },
    { name: 'Halden Buds Pro True Wireless Earbuds', v: 'Charcoal', sku: 'NWA-BUDS-CHR', price: 149, stock: 12, res: 0, low: 4, cond: 'New', review: 'Approved', pub: 'Suspended', icon: 'ear', tint: 'var(--img-1)', upd: 'Oct 4, 3:00 PM · Catalog team', why: 'Proof of purchase from an authorized distributor requested. Send an invoice by Oct 12 to restore the offer.' },
  ];
  const stockState = (r) => (r.stock === 0 ? 'Out of stock' : r.stock <= r.low ? 'Low stock' : 'In stock');

  /* ======================================================================
     1. Setup guide
     ====================================================================== */
  const setupSteps = [
    { done: true, t: 'Store profile', d: 'Name, logo, introduction and customer contact details are complete.', s: status('Done', 'success'), cta: btn('Edit profile', { v: 'ghost', size: 'sm', href: go('seller/store') }) },
    { done: true, t: 'Shipping coverage and rates', d: '48 contiguous states and DC · Standard and Expedited · 1 business day handling.', s: status('Done', 'success'), cta: btn('Review shipping', { v: 'ghost', size: 'sm', href: go('seller/shipping') }) },
    { done: true, t: 'Return address', d: 'Northwind Audio Returns, 1450 NW Raleigh St, Unit 3, Portland, OR 97209.', s: status('Done', 'success'), cta: btn('Edit address', { v: 'ghost', size: 'sm', href: go('seller/shipping') }) },
    { warn: true, t: 'Payout verification', d: 'We sent two small deposits to your account ending 6620 on Oct 6. Enter the amounts to confirm the account. Deposits usually arrive in 1–2 business days.', s: status('Verification pending', 'warning'), cta: btn('Confirm deposits', { size: 'sm', href: go('seller/finance') }) },
    { done: true, t: 'First product or offer submitted', d: '5 submitted: 2 approved, 2 in review, 1 needs changes.', s: status('Done', 'success'), cta: btn('Fix 1 product', { v: 'secondary', size: 'sm', href: go('seller/product-new', 'Changes requested') }) },
    { lock: true, t: 'Launch readiness review', d: 'Unlocks after payout verification. Your Seller Manager checks stock, shipping and service settings, then activates eligible offers. Usually 1 business day.', s: status('Not started'), cta: btn('Request review', { v: 'secondary', size: 'sm', disabled: true }) },
  ];
  const setupDone = setupSteps.filter((s) => s.done).length;

  U.register({
    id: 'seller/setup', title: 'Setup guide', ref: 'Plan ch. 10',
    notes: 'What a newly approved seller still has to finish before selling. Account status, product approval and payout readiness are shown separately, and the page states that approval alone does not publish incomplete or unapproved products.',
    render: () => U.sellerLayout(`
      ${pageHead('Set up Northwind Audio', { sub: 'Your seller account was approved on Oct 5, 2026. Finish these steps so your approved offers can go live.', actions: btn('Contact seller support', { v: 'secondary', size: 'sm', icon: 'life-buoy' }) })}

      <div class="sa-ind">
        <div class="card pad"><span class="xs muted strong">Account status</span><div class="row gap-2">${status('Approved')}<span class="xs muted">since Oct 5</span></div><p class="small sub">You can manage your store, products and settings.</p></div>
        <div class="card pad"><span class="xs muted strong">Product approval</span><div class="row between base"><span class="h3 num">2 of 5 approved</span><span class="xs muted">40%</span></div>${U.meter(40)}<p class="xs muted">2 in review · 1 changes requested</p></div>
        <div class="card pad"><span class="xs muted strong">Payout readiness</span><div class="row gap-2">${status('Verification pending', 'warning')}</div><p class="small sub">Payouts start after you confirm the test deposits. Sales before then are held as pending earnings.</p></div>
      </div>

      ${alert('info', 'Approval does not publish your products', 'Customers only see an offer when its product is approved, the offer is complete with stock, and your launch readiness review is passed. Incomplete or unapproved products stay unpublished.')}

      <div class="sa-split">
        ${card({
          title: 'Setup checklist', sub: `${setupDone} of ${setupSteps.length} complete`,
          actions: `<span style="width:140px">${U.meter(Math.round((setupDone / setupSteps.length) * 100))}</span>`,
          flush: true,
          body: `<ol class="sa-steplist">${setupSteps.map((s, i) => `<li>
            <span class="sa-dot ${s.done ? 'is-done' : s.warn ? 'is-warn' : s.lock ? 'is-lock' : ''}" aria-hidden="true">${s.done ? icon('check', 'ic-sm') : s.warn ? icon('clock', 'ic-sm') : s.lock ? icon('lock', 'ic-sm') : i + 1}</span>
            <div class="stack gap-1"><div class="row gap-2"><h3 class="h4">${s.t}</h3>${s.s}</div><p class="small sub">${s.d}</p></div>
            <div class="sa-cta">${s.cta}</div>
          </li>`).join('')}</ol>`,
        })}

        <div class="stack gap-5">
          ${card({
            title: 'What goes live after review', sub: 'Only approved products with a complete offer',
            flush: true,
            body: `<ul class="list pad">
              ${[['Halden Pocket Bluetooth Speaker, Teal', 'Approved', 'Will go live'], ['Halden Aurora ANC Headphones, Midnight black', 'Approved', 'Will go live'], ['Northwind Studio Cable Kit', 'Submitted', 'Waits for approval'], ['Lumen B5 Bookshelf Speakers', 'Submitted', 'Waits for approval'], ['Ferro HD-60 Studio Monitor Headphones', 'Changes requested', 'Stays unpublished']].map(([n, st, out]) => `<li><span class="grow stack gap-0"><span class="small strong">${n}</span><span class="xs muted">${out}</span></span>${status(st)}</li>`).join('')}
            </ul>`,
          })}
          ${card({
            title: 'Help while you set up',
            body: `<ul class="stack gap-2 small">
              <li><a href="javascript:void 0">${icon('book-open', 'ic-sm')} Fees and payout timing</a></li>
              <li><a href="javascript:void 0">${icon('image', 'ic-sm')} Product image standards</a></li>
              <li><a href="javascript:void 0">${icon('truck', 'ic-sm')} Dispatch deadlines and late shipments</a></li>
              <li><a href="javascript:void 0">${icon('file-pen', 'ic-sm')} Fixing a rejected or returned submission</a></li>
            </ul>
            <div class="divider"></div>
            <div class="row gap-3">${U.avatar('Grace Kim')}<div class="stack gap-0"><span class="small strong">Grace Kim</span><span class="xs muted">Your Seller Manager · replies within 1 business day</span></div></div>`,
          })}
        </div>
      </div>
    `, 'setup'),
  });

  /* ======================================================================
     2. Dashboard
     ====================================================================== */
  const nwSales = [1180, 1342, 1610, 1795, 1204, 1166, 1388, 1452, 1590, 2064, 2236, 1478, 1512, 1688];
  const sumArr = (a) => a.reduce((x, y) => x + y, 0);
  const nextAct = (o) => (o.status === 'New' ? 'Prepare' : o.status === 'Preparing' ? 'Record shipment' : 'View');

  U.register({
    id: 'seller/dashboard', title: 'Seller dashboard', ref: 'Plan ch. 11',
    notes: "Today's work comes first: new orders, dispatch deadlines with the overdue one flagged, low stock, open returns, unanswered messages against the response target, and payouts split into pending and available. Sales, performance against targets and policy announcements follow.",
    render: () => {
      const open = D.sellerOrders.filter((o) => o.status === 'New' || o.status === 'Preparing');
      const order = [...open].sort((a, b) => (a.dueTone === 'danger' ? -1 : b.dueTone === 'danger' ? 1 : 0));
      return U.sellerLayout(`
      ${pageHead('Today at Northwind Audio', { sub: 'Thursday, Oct 8, 2026 · updated 10:05 AM PT', actions: btn('Add product', { v: 'secondary', size: 'sm', icon: 'plus', href: go('seller/catalog-match') }) + btn('Go to orders', { size: 'sm', href: go('seller/orders') }) })}

      <section class="stack gap-3" aria-labelledby="sa-work">
        <h2 class="h3" id="sa-work">Work for today</h2>
        <div class="sa-tiles">
          ${U.queueTile(1, 'Overdue dispatch', { tone: 'danger', sub: 'MK-261007-10433 · 3 h past deadline', href: go('seller/orders', 'Preparing') })}
          ${U.queueTile(4, 'Dispatch due today by 5:00 PM', { tone: 'warning', sub: '2 new · 2 preparing', href: go('seller/orders', 'New') })}
          ${U.queueTile(3, 'New orders', { sub: 'Placed since yesterday 5:00 PM', href: go('seller/orders', 'New') })}
          ${U.queueTile(3, 'Low or out of stock', { tone: 'warning', sub: '2 low · 1 out of stock (Aurora, Silver)', href: go('seller/inventory') })}
          ${U.queueTile(2, 'Open returns', { sub: '1 needs your decision by Oct 9', href: go('seller/returns') })}
          ${U.queueTile(5, 'Unanswered messages', { tone: 'warning', sub: 'Reply within 24 h · oldest waiting 19 h', href: go('seller/customers') })}
        </div>
      </section>

      <div class="sa-split">
        <div class="stack gap-5">
          ${card({
            title: 'Dispatch deadlines', sub: 'Open orders, most urgent first',
            actions: `<a class="small strong" href="${go('seller/orders')}">All orders</a>`,
            flush: true,
            body: table(['Order', 'Buyer', 'Items', 'Deadline', ''], order.map((o) => [
              `<a class="mono small" href="${go('seller/order')}">${o.ref}</a><div class="xs muted">${o.placed}</div>`,
              o.buyer, `<span class="small">${o.items}</span>`, deadline(o.due, o.dueTone),
              btn(nextAct(o), { v: o.dueTone === 'danger' ? 'primary' : 'secondary', size: 'sm', href: go('seller/order') }),
            ]), { rowCls: order.map((o) => (o.dueTone === 'danger' ? 'is-flagged' : o.dueTone === 'warning' ? 'is-warn' : '')) }),
          })}

          ${card({
            title: 'Sales', sub: 'Last 14 days · item sales before fees, by order date',
            actions: `<a class="small strong" href="${go('seller/reports')}">Open report</a>`,
            body: `<div class="row gap-6">${U.stat('14-day sales', '$' + (sumArr(nwSales) / 1000).toFixed(1) + 'k', { delta: '12.4%', dir: 'up', note: 'vs prior 14 days' })}${U.stat('Orders', '214', { note: 'avg ' + money(sumArr(nwSales) / 214) })}${U.stat('Today so far', money(nwSales[13]), { note: '9 orders' })}</div>
              ${U.legend(['Northwind Audio sales'])}
              ${U.lineChart({ labels: D.sales14.labels, series: [{ name: 'Sales', data: nwSales }], height: 220, area: true, fmt: (v) => '$' + (v / 1000).toFixed(1) + 'k', label: 'Daily sales for Northwind Audio, last 14 days' })}`,
          })}
        </div>

        <div class="stack gap-5">
          ${card({
            title: 'Payouts', sub: 'Approved sales are not paid out until they become available',
            actions: `<a class="small strong" href="${go('seller/finance')}">Finance</a>`,
            body: `<div class="grid c2" style="--gap:12px">
                <div class="stack gap-1"><span class="xs muted strong">Pending</span><span class="sa-money">${money(2418.6)}</span><span class="xs muted">Waiting for delivery and hold</span></div>
                <div class="stack gap-1"><span class="xs muted strong">Available</span><span class="sa-money">${money(1306.25)}</span><span class="xs muted">Included in next payout</span></div>
              </div>
              <div class="panel row between"><span class="small">Next payout · <b>Tue, Oct 13</b></span><span class="small strong num">${money(1306.25)}</span></div>
              <span class="xs muted">To Northwind Audio checking ending 6620 · Held: ${money(0)}</span>
              ${ex('Example schedule: weekly on Tuesdays; earnings become available 7 days after delivery. Your seller agreement sets the final terms.')}`,
          })}
          ${card({
            title: 'Performance', sub: 'Last 30 days, compared with service targets',
            actions: `<a class="small strong" href="${go('seller/performance')}">Account health</a>`,
            body: `<ul class="sa-perf">
              <li><div class="row between"><span class="small strong">On-time dispatch</span>${status('Meets target', 'success')}</div><div class="row between xs muted"><span><b class="num" style="color:var(--text)">96.4%</b> of 214 orders</span><span>Target 95% or higher</span></div>${U.meter(96, 'success')}</li>
              <li><div class="row between"><span class="small strong">Cancellation rate</span>${status('Meets target', 'success')}</div><div class="row between xs muted"><span><b class="num" style="color:var(--text)">0.9%</b> seller-cancelled</span><span>Target below 2.5%</span></div>${U.meter(36, 'success')}</li>
              <li><div class="row between"><span class="small strong">Message response time</span>${status('Watch', 'warning')}</div><div class="row between xs muted"><span>Median <b class="num" style="color:var(--text)">14 h</b> · 2 over 24 h</span><span>Target within 24 h</span></div>${U.meter(58, 'warning')}</li>
            </ul>`,
          })}
          ${card({
            title: 'Announcements',
            flush: true,
            body: `<ul class="list pad">
              <li style="align-items:flex-start">${icon('file-text')}<span class="grow stack gap-1"><span class="row gap-2"><span class="small strong">Return policy update</span>${badge('Policy', 'info')}</span><span class="xs sub">Electronics return windows stay at 30 days. Restocking fees for opened headphones are no longer allowed.</span><span class="xs strong">Effective Nov 1, 2026 · <a href="javascript:void 0">Read the change</a></span></span></li>
              <li style="align-items:flex-start">${icon('calendar-days')}<span class="grow stack gap-1"><span class="small strong">Holiday dispatch cutoffs</span><span class="xs sub">Add your closures in Shipping by Nov 15 so arrival estimates stay accurate.</span><span class="xs muted">Posted Oct 5</span></span></li>
            </ul>`,
          })}
        </div>
      </div>
    `, 'dashboard');
    },
  });

  /* ======================================================================
     3. Products and offers
     ====================================================================== */
  const prodActions = (r) => {
    if (r.review === 'Changes requested') return btn('Fix and resubmit', { size: 'sm', href: go('seller/product-new', 'Changes requested') });
    if (r.review === 'Draft') return btn('Continue draft', { v: 'secondary', size: 'sm', href: go('seller/product-new', 'Draft') });
    if (r.review === 'Submitted') return btn('View submission', { v: 'ghost', size: 'sm', href: go('seller/product-new', 'Draft') });
    if (r.review === 'Rejected') return btn('See options', { v: 'ghost', size: 'sm' });
    if (r.pub === 'Suspended') return btn('Send documents', { v: 'secondary', size: 'sm' });
    if (r.pub === 'Hidden') return btn('Show offer', { v: 'ghost', size: 'sm' });
    return btn('Edit offer', { v: 'ghost', size: 'sm', href: go('seller/offer') });
  };
  const prodSub = (r) => `${r.v} · ${r.sku}`;
  const prodExtra = (r) => (r.why ? reason(r.why, r.review === 'Rejected' || r.pub === 'Suspended' ? 'danger' : '') : r.note ? `<span class="xs muted">${r.note}</span>` : '');

  U.register({
    id: 'seller/products', title: 'Products and offers', ref: 'Plan ch. 8, 11',
    states: ['All products', 'Rows selected', 'Add product'],
    notes: 'One list of the seller\'s offers with review state and publication shown as separate columns. A changes-requested row shows the reviewer\'s reason inline; selecting rows reveals bulk actions; Add product asks whether to match an existing catalog product first.',
    render: (st) => {
      const sel = st === 'Rows selected';
      const rows = NW.map((r) => [
        `<div class="cell-main" style="min-width:280px">${U.img(r.icon, r.tint, 'tiny')}<div class="stack gap-0" style="min-width:0"><a class="small strong" href="${r.review === 'Approved' ? go('seller/offer') : go('seller/product-new', r.review === 'Changes requested' ? 'Changes requested' : 'Draft')}">${r.name}</a><span class="xs muted">${r.v}</span>${prodExtra(r)}</div></div>`,
        `<span class="mono xs">${r.sku}</span>`,
        `<span class="num">${money(r.price)}</span>`,
        `<span class="num${r.stock === 0 ? ' t-danger-text strong' : r.stock <= r.low ? ' t-warning-text strong' : ''}">${r.stock}</span>`,
        `<span class="small">${r.cond}</span>`,
        status(r.review),
        status(r.pub),
        `<div class="row gap-1 nowrap">${prodActions(r)}${U.iconBtn('ellipsis', 'More actions for ' + r.sku)}</div>`,
      ]);
      const page = `
      ${pageHead('Products and offers', { sub: '24 offers across 11 products. Review state and publication are tracked separately.', actions: btn('Bulk update', { v: 'secondary', size: 'sm', icon: 'upload', href: go('seller/bulk-update') }) + btn('Add product', { size: 'sm', icon: 'plus', href: go('seller/products', 'Add product') }) })}
      ${tabs([{ label: 'All', count: 24 }, { label: 'Active', count: 14 }, { label: 'Draft', count: 2 }, { label: 'Submitted', count: 3 }, { label: 'Changes requested', count: 1 }, { label: 'Rejected', count: 1 }, { label: 'Hidden or suspended', count: 3 }], 0)}
      ${tb(`${searchIn('Search name, seller SKU, GTIN or model', 'sp-q')}
        <label class="sr-only" for="sp-cat">Category</label>${select('sp-cat', ['All categories', 'Headphones', 'Speakers', 'Cables and adapters', 'DACs and amplifiers', 'Turntables and decks'], 'All categories')}
        <label class="sr-only" for="sp-pub">Publication</label>${select('sp-pub', ['Any publication', 'Active', 'Hidden', 'Suspended', 'Not published'], 'Any publication')}
        <label class="sr-only" for="sp-miss">Content</label>${select('sp-miss', ['Any content', 'Missing images', 'Missing identifiers', 'Low stock'], 'Any content')}`)}
      ${sel ? `<div class="bulk-bar" role="region" aria-label="Bulk actions"><span>2 selected</span><span class="grow"></span>${btn('Change price', { v: 'ghost', size: 'sm', icon: 'tag' })}${btn('Update stock', { v: 'ghost', size: 'sm', icon: 'boxes' })}${btn('Hide offers', { v: 'ghost', size: 'sm', icon: 'eye-off' })}${btn('Export', { v: 'ghost', size: 'sm', icon: 'download' })}${btn('Clear', { v: 'ghost', size: 'sm', icon: 'x' })}</div>` : ''}
      <section class="card no-phone">
        ${table(['Product', 'Seller SKU', { label: 'Price', cls: 'r' }, { label: 'Stock', cls: 'r' }, 'Condition', 'Review', 'Publication', 'Actions'], rows, { select: true, checked: sel ? [0, 1] : [], rowCls: NW.map((r) => (r.review === 'Changes requested' ? 'is-warn' : r.pub === 'Suspended' || r.review === 'Rejected' ? 'is-flagged' : '')) })}
        <div class="card-foot" style="justify-content:space-between"><span class="xs muted">Showing 11 of 24 offers</span>${U.pager(1, 3)}</div>
      </section>
      <ul class="card sa-ocards only-phone">${NW.map((r) => `<li>
        <div class="row nowrap top gap-3">${U.img(r.icon, r.tint, 'thumb')}<div class="stack gap-1 grow"><a class="small strong" href="${go('seller/offer')}">${r.name}</a><span class="xs muted">${prodSub(r)} · ${r.cond}</span><span class="row gap-2"><b class="num small">${money(r.price)}</b><span class="xs muted">Stock ${r.stock}</span></span></div></div>
        <div class="row gap-2">${status(r.review)}${status(r.pub)}</div>
        ${prodExtra(r)}
        <div class="row gap-2">${prodActions(r)}</div>
      </li>`).join('')}</ul>${U.lazyLoad()}
      ${ex('An approved product can still show no offer to customers when stock is 0 or the offer is hidden. A restriction on one seller does not remove other sellers\' offers.')}
      `;
      const html = U.sellerLayout(page, 'products');
      if (st !== 'Add product') return html;
      return html + U.modal({
        title: 'Add a product',
        body: `<p class="small sub">Most products are already in the catalog. Adding your offer to an existing product keeps one page for customers and is faster to approve.</p>
          ${U.optCard('sp-add', 'sp-add-match', `<span class="row gap-2"><b>Sell a product already in the catalog</b>${badge('Recommended', 'brand')}</span>`, 'Search by name, model number or GTIN, then add your price, condition and stock. No product review needed when the product is approved.', true)}
          ${U.optCard('sp-add', 'sp-add-new', '<b>Create a new product</b>', 'For items not in the catalog. You add category, specifications, variations, images and identifiers. The Catalog team reviews it before it can be published, usually within 2 business days.', false)}`,
        foot: btn('Cancel', { v: 'ghost' }) + btn('Continue', { href: go('seller/catalog-match') }),
      });
    },
  });

  /* ======================================================================
     4. Catalog match
     ====================================================================== */
  const results = [
    { name: 'Halden Aurora ANC Wireless Headphones', model: 'HA-ANC700', gtin: '0 84067 31207 4', cat: 'Electronics › Headphones › Over-ear', vars: ['Midnight black', 'Silver', 'Sand'], box: 'Headphones, hard carry case, USB-C cable (1.2 m), 3.5 mm audio cable, airplane adapter', offers: 4, from: 129, match: 'Exact model match', mine: 'You sell Midnight black (New, Used – Good) and Silver (New).', tint: 'var(--img-2)' },
    { name: 'Halden Aurora ANC Wireless Headphones, Travel Bundle', model: 'HA-ANC700-TB', gtin: '0 84067 31288 3', cat: 'Electronics › Headphones › Over-ear', vars: ['Midnight black'], box: 'Everything in HA-ANC700, plus a wireless charging stand and spare ear cushions', offers: 1, from: 239, match: 'Same model, different bundle', tint: 'var(--img-2)' },
    { name: 'Halden Aurora Lite On-Ear Headphones', model: 'HA-ON300', gtin: '0 84067 30951 7', cat: 'Electronics › Headphones › On-ear', vars: ['Black', 'White', 'Coral'], box: 'Headphones, soft pouch, USB-C cable', offers: 2, from: 79, match: 'Different model', tint: 'var(--img-1)' },
  ];
  const tipsCard = card({
    title: 'Match precisely',
    body: `<ul class="sa-checklist">
        <li class="ok">${icon('circle-check')}<span><b>Model number</b> must be identical. HA-ANC700 and HA-ANC700-TB are different products.</span></li>
        <li class="ok">${icon('circle-check')}<span><b>Variation</b> must match: color, size or capacity.</span></li>
        <li class="ok">${icon('circle-check')}<span><b>Bundle contents</b> must match what is in your box. Extra or fewer items mean a different product.</span></li>
        <li class="warn">${icon('triangle-alert')}<span><b>Used items</b> with missing accessories can join the product, but you must list what is missing in the condition notes.</span></li>
      </ul>
      ${ex('Offers on the wrong product are removed by the Catalog team and count as a listing violation.')}`,
  });

  U.register({
    id: 'seller/catalog-match', title: 'Find the product in the catalog', ref: 'Plan ch. 8',
    states: ['Results', 'No match'],
    notes: 'Sellers search the shared catalog before creating anything, and see exact model, variations, bundle contents and existing offers to match precisely. When nothing matches, the page offers the create-new path and warns against attaching to close-but-different models.',
    render: (st) => {
      const none = st === 'No match';
      const q = none ? 'Halden Aurora Studio HA-ANC900' : 'Halden Aurora';
      const list = results.map((r, i) => `<article class="sa-result">
          ${U.img('headphones', r.tint)}
          <div class="stack gap-2" style="min-width:0">
            <div class="row gap-2">${badge(r.match, i === 0 ? 'success' : i === 1 ? 'warning' : '', i === 0 ? 'circle-check' : 'info')}<span class="xs muted">${r.cat}</span></div>
            <h3 class="h4">${r.name}</h3>
            <span class="xs muted">Brand Halden · Model <span class="mono">${r.model}</span> · GTIN <span class="mono">${r.gtin}</span></span>
            <div class="stack gap-1"><span class="xs strong">Variations</span><div class="sa-pills">${r.vars.map((v) => `<span class="badge t-outline">${v}</span>`).join('')}</div></div>
            <div class="stack gap-1"><span class="xs strong">In the box</span><span class="small sub">${r.box}</span></div>
            ${r.mine ? `<span class="xs t-info-text strong row gap-1">${icon('info', 'ic-sm')}${r.mine}</span>` : ''}
          </div>
          <div class="sa-go">
            <span class="small"><b>${r.offers} ${r.offers === 1 ? 'offer' : 'offers'}</b> <span class="muted">from ${money(r.from)}</span></span>
            ${btn('Sell this product', { v: i === 0 ? 'primary' : 'secondary', size: 'sm', href: go('seller/offer') })}
            <a class="xs" href="${go('store/product')}">View product page</a>
          </div>
        </article>`).join('');

      const noneHtml = `${card({
          body: U.empty('search-x', 'No catalog product matches "Halden Aurora Studio HA-ANC900"', 'Before creating a new product, try the GTIN/UPC from the box, the model number alone, or remove color words from the search.', `<div class="row gap-2" style="justify-content:center">${btn('Create a new product', { icon: 'plus', href: go('seller/product-new', 'Draft') })}${btn('Search by GTIN', { v: 'secondary' })}</div>`),
        })}
        ${card({
          title: 'Close matches that are not the same model', sub: 'Do not add your offer to these if your model number is different',
          flush: true,
          body: `<ul class="list pad">${results.slice(0, 2).map((r) => `<li>${U.img('headphones', r.tint, 'tiny')}<span class="grow stack gap-0"><span class="small strong">${r.name}</span><span class="xs muted">Model <span class="mono">${r.model}</span> · ${r.offers} offers</span></span>${badge('Different model', 'warning')}</li>`).join('')}</ul>`,
        })}`;

      return U.sellerLayout(`
      ${pageHead('Find the product in the catalog', { crumbs: [{ label: 'Products and offers', href: go('seller/products') }, 'Add product'], sub: 'If the product already exists, add your offer to it so customers compare sellers on one page.' })}
      ${U.steps(['Find the product', 'Create your offer', 'Publish'], 0)}
      <div class="sa-split">
        <div class="stack gap-4">
          <div class="card pad stack gap-3">
            <div class="toolbar">${`<label class="search-in" for="cm-q">${icon('search', 'ic-sm')}<input id="cm-q" type="search" value="${U.esc(q)}" aria-label="Search the catalog"></label>`}${btn('Search')}</div>
            <div class="row gap-2"><span class="xs muted">Search by</span>${U.chips([{ label: 'Name', active: true }, 'Model number', 'GTIN / UPC', 'Brand'])}</div>
          </div>
          ${none ? noneHtml : `<div class="row between"><span class="small sub">3 results for <b>"${q}"</b> in Electronics</span><label class="sr-only" for="cm-sort">Sort</label>${select('cm-sort', ['Best match', 'Most offers', 'Newest'], 'Best match')}</div>
          <section class="card">${list}</section>`}
        </div>
        <div class="stack gap-5">
          ${tipsCard}
          ${card({
            title: "Can't find it?",
            body: `<p class="small sub">Create a new product with full details. The Catalog team checks it for duplicates, accurate claims, image quality and the right category before it can go live.</p>
              ${btn('Create a new product', { v: none ? 'primary' : 'secondary', block: true, icon: 'plus', href: go('seller/product-new', 'Draft') })}
              ${ex('If the Catalog team finds a duplicate, it merges your submission into the existing product. Your offer, reviews and past orders stay linked.')}`,
          })}
        </div>
      </div>
    `, 'products');
    },
  });

  /* ======================================================================
     5. New product submission
     ====================================================================== */
  U.register({
    id: 'seller/product-new', title: 'New product submission', ref: 'Plan ch. 8',
    states: ['Draft', 'Changes requested'],
    notes: 'Full product submission with category-driven specifications, a variation matrix, images with standards and identifiers. The side panel prompts for missing information and shows submission status; when the Catalog team requests changes, the reason, affected fields and review history are shown.',
    render: (st) => {
      const cr = st === 'Changes requested';
      const errField = (label, control, err, hint) => (cr && err ? `<div class="sa-hl">${field(label, control, { error: err })}</div>` : field(label, control, { hint }));
      const spec = (id, label, val, o = {}) => field(label, o.opts ? select(id, o.opts, val) : input(id, val, { placeholder: o.ph || '', error: !!o.err }), { hint: o.hint, error: o.err, opt: o.opt });

      const checklist = cr ? [
        ['ok', 'Category and basic details'],
        ['miss', 'Main image has a text overlay. Replace image 1.'],
        ['miss', 'Frequency response does not match the manufacturer spec.'],
        ['miss', 'Carry pouch shown in photos but not listed in the box.'],
        ['ok', 'Variations: 2 of 2 complete'],
        ['ok', 'Identifiers: GTIN and model number'],
      ] : [
        ['ok', 'Category: Over-ear headphones'],
        ['ok', 'Brand, name and description'],
        ['warn', 'Specifications: 7 of 9 required (add Weight and Microphone)'],
        ['miss', 'Variation White has no price'],
        ['miss', 'Images: 2 of 3 required'],
        ['miss', 'GTIN/UPC missing, or confirm the product has none'],
        ['ok', 'Included accessories'],
      ];
      const pct = cr ? 82 : 64;

      const banner = cr ? `<div class="alert t-warning" role="alert">${icon('message-square-warning')}<div class="stack gap-2 grow">
          <span class="alert-title">Changes requested by the Catalog team</span>
          <span>Omar Haddad, Catalog Manager · Oct 6, 2026, 2:18 PM PT</span>
          <span><b>Reason:</b> Inaccurate details and image standards not met. Fix the 3 fields marked below, then resubmit. Other sellers will rely on this shared product content.</span>
          <ol class="ol small"><li>Image 1: remove the "Studio grade" text overlay. Main images must show only the product on a plain background.</li><li>Frequency response: manufacturer lists 10 Hz – 30 kHz.</li><li>Included accessories: photo 3 shows a carry pouch that is not listed.</li></ol>
        </div></div>` : '';

      const varRows = [
        ['Black', 'NWA-FER-HD60-BLK', '129.00', '12', '0 75213 66001 8'],
        ['White', 'NWA-FER-HD60-WHT', cr ? '129.00' : '', '8', '0 75213 66002 5'],
      ];

      return U.sellerLayout(`
      ${pageHead(cr ? 'Ferro HD-60 Studio Monitor Headphones' : 'New product', { crumbs: [{ label: 'Products and offers', href: go('seller/products') }, cr ? 'Fix submission' : 'Create a new product'], sub: cr ? 'Submission SUB-20417 · fix the marked fields and resubmit' : 'Not in the catalog yet. Complete every section; you can save a draft at any time.', actions: status(cr ? 'Changes requested' : 'Draft') })}
      ${banner}
      <div class="sa-split">
        <div class="stack gap-5">
          ${card({
            title: 'Category', sub: 'Sets the specifications this product needs',
            body: `<div class="row between"><span class="row gap-2">${icon('folder-tree', 'ic-sm')}${U.crumbs(['Electronics', 'Headphones', 'Over-ear and on-ear'])}</span>${btn('Change category', { v: 'ghost', size: 'sm' })}</div>`,
          })}
          ${card({
            title: 'Basic details',
            body: `<div class="grid md2">
                ${field('Brand', select('pn-brand', ['Ferro', 'Halden', 'Kestrel', 'Lumen', 'Brand not listed'], 'Ferro'), { hint: 'Missing a brand? Request it and we review it with the product.' })}
                ${field('Model number', input('pn-model', 'HD-60'))}
              </div>
              ${field('Product name', input('pn-name', 'Ferro HD-60 Studio Monitor Headphones'), { hint: 'Brand + model + product type. No prices, promotions or seller names. 36 of 150 characters.' })}
              ${field('Description', textarea('pn-desc', 'Closed-back studio monitor headphones tuned for accurate mixing and tracking. 40 mm drivers, detachable cables and memory-foam ear pads for long sessions.'), { hint: 'Describe the product, not your offer. Shipping and return terms go in your offer.' })}
              <div class="field"><span class="label">Key features</span>
                <div class="stack gap-2">${['Closed-back design isolates sound for tracking', '40 mm neodymium drivers, 32 Ω, easy to drive from laptops', 'Detachable 3 m coiled and 1.2 m straight cables', 'Swivel ear cups fold flat for travel', ''].map((f, i) => `<div class="sa-feat"><span class="xs muted num" style="width:16px">${i + 1}</span><label class="sr-only" for="pn-f${i}">Key feature ${i + 1}</label>${input('pn-f' + i, f, { placeholder: 'Add a feature (optional)' })}</div>`).join('')}</div>
                <span class="hint">Up to 5 short facts customers can scan.</span>
              </div>`,
          })}
          ${card({
            title: 'Specifications', sub: 'Required for Over-ear and on-ear headphones',
            body: `<div class="grid md2">
              ${spec('pn-type', 'Headphone type', 'Over-ear, closed-back', { opts: ['Over-ear, closed-back', 'Over-ear, open-back', 'On-ear'] })}
              ${spec('pn-conn', 'Connectivity', 'Wired', { opts: ['Wired', 'Bluetooth', 'Wired and Bluetooth'] })}
              ${spec('pn-driver', 'Driver size', '40 mm')}
              ${spec('pn-imp', 'Impedance', '32 Ω')}
              ${cr ? `<div class="sa-hl">${spec('pn-freq', 'Frequency response', '15 Hz – 28 kHz', { err: 'Manufacturer lists 10 Hz – 30 kHz. Update the value or attach the spec sheet.' })}</div>` : spec('pn-freq', 'Frequency response', '15 Hz – 28 kHz')}
              ${spec('pn-cable', 'Cable', 'Detachable, 3.5 mm')}
              ${spec('pn-weight', 'Weight', cr ? '285 g' : '', { ph: 'e.g. 285 g', err: cr ? '' : 'Add the weight without cables.' })}
              ${spec('pn-mic', 'Microphone', cr ? 'No microphone' : 'Select', { opts: ['Select', 'No microphone', 'Inline microphone', 'Boom microphone'], err: cr ? '' : 'Choose an option.' })}
              ${spec('pn-anc', 'Noise cancellation', 'None (passive isolation)', { opts: ['None (passive isolation)', 'Active (ANC)'] })}
            </div>`,
          })}
          ${card({
            title: 'Variations', sub: 'Each variation gets its own SKU, price and stock for your offer',
            actions: U.toggle('pn-hasvar', 'Has variations', true),
            body: `<div class="row gap-2"><span class="small strong">Varies by</span>${U.chips([{ label: 'Color', active: true }, { label: 'Add attribute', icon: 'plus' }])}</div>
              <div class="card">${table(['Color', 'Seller SKU', 'Price', 'Quantity', 'GTIN / UPC'], varRows.map((v, i) => [
                `<span class="small strong">${v[0]}</span>`,
                `<label class="sr-only" for="pn-vs${i}">SKU for ${v[0]}</label><input class="input sa-sku" id="pn-vs${i}" value="${v[1]}">`,
                `<label class="sr-only" for="pn-vp${i}">Price for ${v[0]}</label><input class="input sa-num${!v[2] ? ' is-error' : ''}" id="pn-vp${i}" value="${v[2]}" placeholder="0.00"${!v[2] ? ' aria-invalid="true"' : ''}>${!v[2] ? '<div class="error-text">Add a price</div>' : ''}`,
                `<label class="sr-only" for="pn-vq${i}">Quantity for ${v[0]}</label><input class="input sa-num" id="pn-vq${i}" value="${v[3]}">`,
                `<span class="mono xs">${v[4]}</span>`,
              ]), { rowCls: varRows.map((v) => (!v[2] ? 'is-flagged' : '')) })}</div>
              ${ex('Customers pick a color on one product page. Your price and quantity are your offer; other sellers set their own.')}`,
          })}
          ${card({
            title: 'Images', sub: 'At least 3 · first image is the main image',
            body: `${cr ? `<div class="sa-hl stack gap-2">` : '<div class="stack gap-2">'}
                <div class="sa-thumbs">
                  <div class="sa-thumb${cr ? ' is-error' : ''}">${U.img('headphones', 'var(--img-4)')}${badge('Main', cr ? 'danger' : 'solid')}</div>
                  <div class="sa-thumb">${U.img('headphones', 'var(--img-1)')}</div>
                  ${cr ? `<div class="sa-thumb">${U.img('package-open', 'var(--img-3)')}</div><div class="sa-thumb">${U.img('cable', 'var(--img-6)')}</div>` : ''}
                </div>
                ${cr ? `<span class="error-text">${icon('circle-alert', 'ic-sm')}Image 1 has a text overlay. Replace it with a clean product photo.</span>` : `<span class="error-text">${icon('circle-alert', 'ic-sm')}Add at least 1 more image.</span>`}
              </div>
              ${U.dropzone('Drag images here or browse', 'JPG or PNG · at least 1600 px on the longest side · up to 10 MB each')}
              <div class="well stack gap-2"><span class="small strong">Image standards</span>
                <ul class="ul small sub stack gap-1"><li>Main image: product only, plain white or light gray background, fills 85% of the frame.</li><li>No text, logos, watermarks, borders or prices.</li><li>Show every included accessory in at least one image.</li><li>Use your own photos or ones you have rights to.</li></ul></div>`,
          })}
          ${card({
            title: 'Identifiers',
            body: `<div class="grid md2">
                ${field('GTIN / UPC', input('pn-gtin', cr ? '0 75213 66001 8' : '', { placeholder: '12 or 13 digits', error: !cr }), cr ? { hint: 'Matches the barcode on the retail box.' } : { error: 'Enter the barcode number, or confirm the product has none.' })}
                ${field('Manufacturer part number', input('pn-mpn', 'FER-HD60-01'), { opt: true })}
              </div>
              ${check('pn-nogtin', 'This product has no GTIN (custom-made or private label). We may ask for proof.', false)}`,
          })}
          ${card({
            title: 'Included accessories', sub: 'Everything in a new, sealed box',
            body: `${cr ? '<div class="sa-hl stack gap-2">' : '<div class="stack gap-2">'}
                ${check('pn-acc1', '3 m coiled cable, 3.5 mm', true)}
                ${check('pn-acc2', '1.2 m straight cable, 3.5 mm', true)}
                ${check('pn-acc3', '6.35 mm (1/4 in) screw-on adapter', true)}
                ${check('pn-acc4', 'Carry pouch', false)}
                ${cr ? `<span class="error-text">${icon('circle-alert', 'ic-sm')}Photo 3 shows a carry pouch. Tick it if it ships in the box, or remove the photo.</span>` : ''}
              </div>
              <div class="row gap-2"><label class="sr-only" for="pn-accn">Add accessory</label><span class="grow">${input('pn-accn', '', { placeholder: 'Add another item in the box' })}</span>${btn('Add', { v: 'secondary' })}</div>`,
          })}
        </div>

        <aside class="stack gap-5 sa-sticky">
          ${card({
            title: 'Ready to submit?', sub: `${pct}% complete`,
            body: `${U.meter(pct, cr ? 'warning' : '')}
              <ul class="sa-checklist">${checklist.map(([k, t]) => `<li class="${k}">${icon(k === 'ok' ? 'circle-check' : k === 'warn' ? 'circle-dashed' : 'circle-alert')}<span>${t}</span></li>`).join('')}</ul>
              <div class="divider"></div>
              ${kv([['Status', status(cr ? 'Changes requested' : 'Draft')], ['Last saved', cr ? 'Oct 8, 9:58 AM by Avery Stone' : 'Oct 8, 10:42 AM by Avery Stone'], ['Review time', 'Usually 2 business days']])}
              ${cr ? field('Note to the reviewer', textarea('pn-note', '', 'Explain what you changed'), { opt: true }) : ''}`,
            foot: btn('Save draft', { v: 'secondary' }) + btn(cr ? 'Resubmit for review' : 'Submit for review', { disabled: true }),
          })}
          <p class="xs muted">${cr ? 'Fix the 3 marked items to resubmit.' : 'Fix 4 items to submit. Your draft is kept for 90 days.'}</p>
          ${cr ? card({
            title: 'Review history',
            body: timeline([
              { t: 'Changes requested', d: 'Oct 6, 2:18 PM · Omar Haddad, Catalog', state: 'warn', body: 'Image standards and inaccurate details. 3 fields.' },
              { t: 'Submitted for review', d: 'Oct 3, 2:40 PM · Avery Stone', state: 'done' },
              { t: 'Draft created', d: 'Oct 2, 4:05 PM · Avery Stone', state: 'done' },
            ]),
          }) : card({
            title: 'Before you submit',
            body: `<p class="small sub">Searched the catalog and found no match for <b>Ferro HD-60</b>. If a duplicate is found during review, your offer is attached to the existing product instead.</p><a class="small strong" href="${go('seller/catalog-match')}">Search the catalog again</a>`,
          })}
        </aside>
      </div>
    `, 'products');
    },
  });

  /* ======================================================================
     6. Create offer for an existing product
     ====================================================================== */
  U.register({
    id: 'seller/offer', title: 'Create offer', ref: 'Plan ch. 8, 11',
    states: ['New condition', 'Used condition'],
    notes: 'Seller offer on an approved catalog product: shared content is read-only with a correction link, and the seller sets condition, price, stock, dispatch, shipping, returns and warranty. The fee preview is an illustrative example, and offer availability is explained as separate from product approval.',
    render: (st) => {
      const used = st === 'Used condition';
      const price = used ? 139 : 189;
      const fee = Math.round(price * 10) / 100;
      return U.sellerLayout(`
      ${pageHead('Create your offer', { crumbs: [{ label: 'Products and offers', href: go('seller/products') }, { label: 'Find product', href: go('seller/catalog-match') }, 'Create offer'], sub: 'You set the terms of your offer. Product content is shared by every seller.' })}
      ${U.steps(['Find the product', 'Create your offer', 'Publish'], 1)}
      <div class="sa-split">
        <div class="stack gap-5">
          ${card({
            title: 'Product', sub: 'Shared catalog content · read-only',
            actions: `<a class="small strong row gap-1" href="javascript:void 0">${icon('pencil-line', 'ic-sm')}Suggest a correction</a>`,
            body: `<div class="row top gap-4 nowrap">${U.img('headphones', 'var(--img-2)', 'xl')}<div class="stack gap-1" style="min-width:0">
                <span class="row gap-2">${status('Approved')}${status('Active')}</span>
                <span class="strong">Halden Aurora ANC Wireless Headphones</span>
                <span class="xs muted">Halden · Model <span class="mono">HA-ANC700</span> · GTIN <span class="mono">0 84067 31207 4</span></span>
                <span class="xs muted">Electronics › Headphones › Over-ear · 4 other offers</span>
              </div></div>
              <div class="grid md2">
                ${field('Variation', select('of-var', ['Midnight black', 'Silver', 'Sand'], 'Midnight black'))}
                <div class="stack gap-1"><span class="label">In the box (new)</span><span class="small sub">Headphones, hard carry case, USB-C cable, 3.5 mm audio cable, airplane adapter</span></div>
              </div>
              ${ex('Corrections to shared content are reviewed by the Catalog team because they affect every seller on this product.')}`,
          })}
          ${card({
            title: 'Condition',
            body: `<div class="grid md2">
                ${field('Condition', select('of-cond', ['New', 'Used – Like new', 'Used – Good', 'Used – Acceptable', 'Refurbished'], used ? 'Used – Good' : 'New'))}
                <div></div>
              </div>
              ${used ? `${alert('warning', 'List anything missing from the box', 'This product normally includes a carry case, two cables and an airplane adapter. Customers see your notes next to the price.')}
                ${field('Condition notes', textarea('of-notes', 'Light wear on the headband, no scratches on ear cups. Original carry case and airplane adapter are missing. Includes USB-C and 3.5 mm cables. Battery tested at 28 hours.'), { hint: 'Required for used and refurbished items. 182 of 500 characters.' })}`
                : field('Condition notes', textarea('of-notes', '', 'e.g. Factory sealed, US retail version'), { opt: true, hint: 'Shown to customers beside your price.' })}`,
          })}
          ${card({
            title: 'Price and stock',
            body: `<div class="grid md2">
                ${field('Price', input('of-price', price.toFixed(2), { prefix: '$' }), { hint: 'Lowest New offer today: $184.00 · Official Store $189.00' })}
                ${field('Quantity available', input('of-qty', used ? '1' : '10', { type: 'number' }), { hint: 'Customers cannot buy more than this.' })}
                ${field('Seller SKU', input('of-sku', used ? 'NWA-AUR-BLK-U2' : 'NWA-AUR-BLK'), { hint: 'Your own code. Customers don\'t see it.' })}
                ${field('Low-stock alert at', input('of-low', '3', { type: 'number', suffix: 'units' }), { opt: true })}
              </div>`,
          })}
          ${card({
            title: 'Delivery',
            body: `<div class="grid md2">
                ${field('Dispatch time', select('of-disp', ['Same business day (order by 12 PM PT)', '1 business day', '2 business days', '3 business days'], '1 business day'), { hint: 'Missing this deadline counts as a late dispatch.' })}
                ${field('Shipping profile', select('of-ship', ['Standard and Expedited (default)', 'Large items, flat rate', 'Standard only'], 'Standard and Expedited (default)'), { hint: 'Free Standard over $49 · <a href="' + go('seller/shipping') + '">Edit profiles</a>' })}
              </div>
              <div class="panel small">Customers in Portland, OR see: <b>Arrives Tue, Oct 13 – Wed, Oct 14</b> with Standard if ordered today.</div>`,
          })}
          ${card({
            title: 'Returns and warranty',
            body: `<div class="stack gap-2"><span class="label">Return policy</span>
                ${U.optCard('of-ret', 'of-ret30', '<b>30-day returns</b> <span class="xs muted">Platform baseline</span>', 'Customer can return for any reason within 30 days of delivery. Return shipping: buyer pays unless the item is faulty or not as described.', true)}
                ${U.optCard('of-ret', 'of-ret60', '<b>60-day returns</b>', 'More generous than the baseline. Shown as a benefit on your offer.', false)}
                ${U.optCard('of-ret', 'of-ret60f', '<b>60-day returns with free return shipping</b>', 'You pay return shipping for every return.', false)}
                <span class="hint">You can't offer less than the platform baseline for this category.</span>
              </div>
              ${field('Warranty', select('of-war', used ? ['90-day seller warranty', '6-month seller warranty', 'No warranty'] : ['2-year manufacturer warranty', '1-year seller warranty', 'No warranty'], used ? '90-day seller warranty' : '2-year manufacturer warranty'), { hint: used ? 'Manufacturer warranty does not transfer for used items sold here.' : 'Only choose a manufacturer warranty if the product is new and sold in the US.' })}`,
          })}
        </div>

        <aside class="stack gap-5 sa-sticky">
          ${card({
            title: 'Fee and earnings preview', sub: 'Per unit sold, before shipping and tax',
            body: `${U.sumRow('Sale price', money(price))}
              ${U.sumRow('Platform fee (10%)', '−' + money(fee))}
              <div class="divider"></div>
              ${U.sumRow('Your earnings', money(price - fee), 'total')}
              ${badge('Example', 'outline')}
              ${ex('Illustrative 10% rate. Final fees by category are in your seller agreement. Earnings show as pending until delivery and the hold period end.')}`,
          })}
          ${card({
            title: 'Publish',
            body: `<p class="small sub">This product is already approved, so your offer goes live when you publish and have stock.</p>
              ${alert('info', '', 'Product approval and offer availability are separate. If your quantity reaches 0 or your offer is hidden or restricted, only your offer stops showing. Other sellers\' offers on this product stay up.')}`,
            foot: btn('Save draft', { v: 'secondary' }) + btn('Publish offer', { icon: 'check' }),
          })}
        </aside>
      </div>
    `, 'products');
    },
  });

  /* ======================================================================
     7. Inventory
     ====================================================================== */
  const invRows = NW.filter((r) => r.review === 'Approved');
  const invSummary = { inStock: invRows.filter((r) => stockState(r) === 'In stock').length, low: invRows.filter((r) => stockState(r) === 'Low stock').length, out: invRows.filter((r) => stockState(r) === 'Out of stock').length, res: invRows.reduce((a, r) => a + r.res, 0) };

  U.register({
    id: 'seller/inventory', title: 'Inventory', ref: 'Plan ch. 9, 11',
    states: ['Stock list', 'Adjust stock'],
    notes: 'Available, reserved, low-stock threshold and status per SKU, with inline quantity edits. Every adjustment asks for a reason and records who made it and when; reserved units stay held until the order ends.',
    render: (st) => {
      const rows = invRows.map((r, i) => [
        prodCell(r, `<span class="mono">${r.sku}</span> · ${r.v}`, go('seller/offer')),
        `<label class="sr-only" for="inv-q${i}">Available for ${r.sku}</label><input class="input sa-num" id="inv-q${i}" type="number" value="${r.stock}">`,
        `<span class="num">${r.res}</span>`,
        `<span class="num">${r.low}</span>`,
        status(stockState(r)),
        `<span class="xs sub">${r.upd}</span>`,
        btn('Adjust', { v: 'ghost', size: 'sm', href: go('seller/inventory', 'Adjust stock') }),
      ]);
      const html = U.sellerLayout(`
      ${pageHead('Inventory', { sub: 'Quantities for your approved offers. Customers cannot buy more than the available quantity.', actions: btn('Export', { v: 'secondary', size: 'sm', icon: 'download' }) + btn('Bulk update', { size: 'sm', icon: 'upload', href: go('seller/bulk-update') }) })}
      <div class="sa-kpis">
        <div class="card pad">${U.stat('In stock', invSummary.inStock + ' SKUs', { icon: 'package-check', note: invRows.filter((r) => stockState(r) === 'In stock').reduce((a, r) => a + r.stock, 0) + ' units available' })}</div>
        <div class="card pad">${U.stat('Low stock', invSummary.low + ' SKUs', { icon: 'triangle-alert', note: 'At or below threshold' })}</div>
        <div class="card pad">${U.stat('Out of stock', invSummary.out + ' SKU', { icon: 'package-x', note: 'Customers can\'t buy until restocked' })}</div>
        <div class="card pad">${U.stat('Reserved for open orders', invSummary.res + ' units', { icon: 'lock', note: 'Released only if an order is cancelled' })}</div>
      </div>
      ${tb(`${searchIn('Search product or SKU', 'inv-search')}
        <label class="sr-only" for="inv-st">Stock status</label>${select('inv-st', ['All statuses', 'In stock', 'Low stock', 'Out of stock'], 'All statuses')}
        <label class="sr-only" for="inv-cat">Category</label>${select('inv-cat', ['All categories', 'Headphones', 'Speakers', 'Cables and adapters'], 'All categories')}
        <span class="grow"></span><a class="small strong" href="${go('seller/bulk-update')}">${icon('file-spreadsheet', 'ic-sm')} Update many SKUs with a file</a>`)}
      <section class="card">
        ${table(['Product / SKU', { label: 'Available', cls: 'r' }, { label: 'Reserved', cls: 'r' }, { label: 'Low-stock at', cls: 'r' }, 'Status', 'Last updated', ''], rows, { rowCls: invRows.map((r) => (stockState(r) === 'Out of stock' ? 'is-flagged' : stockState(r) === 'Low stock' ? 'is-warn' : '')) })}
        <div class="card-foot" style="justify-content:space-between"><span class="xs muted">Changing a quantity asks you for a reason before it saves.</span>${btn('Save 0 changes', { size: 'sm', disabled: true })}</div>
      </section>
      ${card({
        title: 'Recent adjustments', sub: 'Every change keeps its reason, person and time',
        flush: true,
        body: table(['When', 'SKU', 'Change', 'Reason', 'By'], [
          ['Oct 6, 4:30 PM', '<span class="mono xs">NWA-CBL-KIT</span>', '<span class="num t-success-text strong">+30</span> <span class="xs muted">12 → 42</span>', 'Received new stock · Invoice 7781', 'Avery Stone'],
          ['Oct 5, 11:02 AM', '<span class="mono xs">NWA-PKT-CHR</span>', '<span class="num t-danger-text strong">−2</span> <span class="xs muted">9 → 7</span>', 'Damaged · dented grille, set aside', 'Jae Park'],
          ['Oct 2, 11:12 AM', '<span class="mono xs">NWA-AUR-BLK-U</span>', '<span class="num">0</span> <span class="xs muted">offer hidden</span>', 'Hold for photos', 'Avery Stone'],
        ]),
      })}
    `, 'inventory');
      if (st !== 'Adjust stock') return html;
      return html + U.modal({
        title: 'Adjust stock',
        body: `<div class="row gap-3 nowrap">${U.img('speaker', 'var(--img-6)', 'thumb')}<div class="stack gap-0"><span class="strong">Halden Pocket Bluetooth Speaker, Charcoal</span><span class="xs muted mono">NWA-PKT-CHR</span></div></div>
          <div class="grid c2" style="--gap:12px"><div class="panel stack gap-0"><span class="xs muted">Available now</span><span class="h3 num">6</span></div><div class="panel stack gap-0"><span class="xs muted">Reserved for orders</span><span class="h3 num">1</span></div></div>
          <div class="grid md2">
            ${field('New available quantity', input('adj-qty', '18', { type: 'number' }), { hint: 'Change: +12 units' })}
            ${field('Reason', select('adj-reason', ['Received new stock', 'Count correction', 'Damaged or defective', 'Lost or missing', 'Returned item restocked', 'Moved to another channel', 'Other'], 'Received new stock'))}
          </div>
          ${field('Note', textarea('adj-note', 'Shipment from Halden distributor, invoice HD-55102.'), { opt: true, hint: 'Helps your team and our support staff understand the change later.' })}
          <div class="panel row gap-2 small">${icon('history', 'ic-sm')}<span>Recorded as <b>Avery Stone</b> · Oct 8, 2026, 10:14 AM PT, with the reason and note above. Reserved units are not affected.</span></div>`,
        foot: btn('Cancel', { v: 'ghost' }) + btn('Save adjustment'),
      });
    },
  });

  /* ======================================================================
     8. Bulk price and stock update
     ====================================================================== */
  const bulkRows = [
    { row: 2, sku: 'NWA-PKT-TEAL', name: 'Halden Pocket Speaker, Teal', p0: 59, p1: 54, q0: 88, q1: 88 },
    { row: 3, sku: 'NWA-PKT-CHR', name: 'Halden Pocket Speaker, Charcoal', p0: 59, p1: 54, q0: 6, q1: 18 },
    { row: 4, sku: 'NWA-PKT-BLU', name: '', p0: null, p1: 54, q0: null, q1: 10, err: 'Unknown SKU. Check the code or create the offer first.' },
    { row: 5, sku: 'NWA-AUR-BLK', name: 'Halden Aurora ANC, Midnight black', p0: 184, p1: 179, q0: 14, q1: 20 },
    { row: 6, sku: 'NWA-AUR-SLV', name: 'Halden Aurora ANC, Silver', p0: 184, p1: 179, q0: 0, q1: -3, err: 'Quantity can\'t be negative. Enter 0 or more.' },
    { row: 7, sku: 'NWA-CBL-KIT', name: 'Northwind Studio Cable Kit', p0: 24, p1: 2.4, q0: 42, q1: 42, err: 'Price $2.40 is below the $5.00 minimum for Cables and adapters. Did you mean $24.00?' },
    { row: 8, sku: 'NWA-AUR-BLK-U', name: 'Halden Aurora ANC, Used – Good', p0: 139, p1: 135, q0: 2, q1: 2 },
    { row: 9, sku: 'NWA-BUDS-CHR', name: 'Halden Buds Pro, Charcoal', p0: 149, p1: null, q0: 12, q1: 12, err: 'Price is empty. Leave the column out to keep the current price.' },
  ];
  const chg = (a, b, isMoney) => {
    if (b === null || b === undefined) return '<span class="xs muted">No value</span>';
    const f = (v) => (isMoney ? money(v) : num(v));
    if (a === null || a === undefined) return `<span class="num">${f(b)}</span>`;
    if (a === b) return `<span class="num muted">${f(b)}</span>`;
    return `<span class="num nowrap"><span class="sa-strike">${f(a)}</span><span class="sa-arrow">→</span><b>${f(b)}</b></span>`;
  };

  U.register({
    id: 'seller/bulk-update', title: 'Bulk price and stock update', ref: 'Plan ch. 8, 11',
    states: ['Preview', 'Applied'],
    notes: 'Template download, CSV upload and a row-by-row preview where each error says what is wrong and how to fix it. Only valid rows are applied, and a correction report lists the skipped rows.',
    render: (st) => {
      const applied = st === 'Applied';
      const tableHtml = table(['Row', 'Seller SKU', 'Product', 'Price', 'Quantity', 'Result'], bulkRows.map((r) => [
        `<span class="num xs muted">${r.row}</span>`, `<span class="mono xs">${r.sku}</span>`, r.name ? `<span class="small">${r.name}</span>` : '<span class="xs muted">Not found</span>',
        chg(r.p0, r.p1, true), chg(r.q0, r.q1, false),
        r.err ? `<span class="error-text" style="max-width:36ch;white-space:normal;align-items:flex-start">${icon('circle-alert', 'ic-sm')}<span>${r.err}</span></span>` : (applied ? status('Applied', 'success') : status('Ready', 'success')),
      ]), { rowCls: bulkRows.map((r) => (r.err ? 'is-flagged' : '')) });

      const preview = `
        <div class="sa-kpis">
          <div class="card pad">${U.stat('Rows in file', '48', { icon: 'file-spreadsheet' })}</div>
          <div class="card pad">${U.stat('Ready to apply', '44', { icon: 'circle-check', note: '12 price · 36 stock changes' })}</div>
          <div class="card pad">${U.stat('Errors', '<span class="t-danger-text">4</span>', { icon: 'circle-alert', note: 'Skipped unless fixed' })}</div>
          <div class="card pad">${U.stat('Unchanged', '0', { icon: 'minus' })}</div>
        </div>
        ${alert('warning', '4 rows have errors', 'Rows with errors are skipped. Nothing changes until you apply. Fix them in your file and upload again, or apply the 44 valid rows now and download the correction report.')}
        ${card({
          title: 'Preview', sub: 'northwind-price-stock-2026-10-08.csv · uploaded 10:18 AM by Avery Stone',
          actions: U.seg(['All rows', 'Errors (4)', 'Ready (44)'], 0),
          flush: true,
          body: tableHtml,
          foot: `<span class="xs muted grow">Showing 8 of 48 rows</span>${btn('Download correction report', { v: 'secondary', size: 'sm', icon: 'download' })}${btn('Upload a corrected file', { v: 'secondary', size: 'sm', icon: 'upload' })}${btn('Apply 44 valid rows', { size: 'sm', href: go('seller/bulk-update', 'Applied') })}`,
        })}`;

      const done = `
        ${alert('success', '44 rows applied', 'Applied Oct 8, 2026, 10:21 AM PT by Avery Stone. New prices and quantities are live on your offers now. 4 rows were skipped.')}
        <div class="sa-kpis">
          <div class="card pad">${U.stat('Updated', '44', { icon: 'circle-check' })}</div>
          <div class="card pad">${U.stat('Skipped', '<span class="t-danger-text">4</span>', { icon: 'circle-alert', note: 'See correction report' })}</div>
          <div class="card pad">${U.stat('Price changes', '12', { icon: 'tag' })}</div>
          <div class="card pad">${U.stat('Stock changes', '36', { icon: 'boxes', note: 'Recorded as "Bulk update"' })}</div>
        </div>
        ${card({
          title: 'Correction report', sub: '4 rows were not applied. Fix and upload just these rows.',
          actions: btn('Download report (CSV)', { size: 'sm', icon: 'download' }),
          flush: true,
          body: table(['Row', 'Seller SKU', 'What to fix'], bulkRows.filter((r) => r.err).map((r) => [`<span class="num xs muted">${r.row}</span>`, `<span class="mono xs">${r.sku}</span>`, `<span class="small">${r.err}</span>`]), { rowCls: ['is-flagged', 'is-flagged', 'is-flagged', 'is-flagged'] }),
        })}
        ${card({
          title: 'Upload history',
          flush: true,
          body: table(['File', 'Uploaded', 'By', { label: 'Applied', cls: 'r' }, { label: 'Skipped', cls: 'r' }, ''], [
            ['northwind-price-stock-2026-10-08.csv', 'Oct 8, 10:18 AM', 'Avery Stone', '44', '4', `<a class="small" href="javascript:void 0">Report</a>`],
            ['stock-count-oct-01.csv', 'Oct 1, 5:40 PM', 'Jae Park', '22', '0', `<a class="small" href="javascript:void 0">Report</a>`],
          ]),
        })}`;

      return U.sellerLayout(`
      ${pageHead('Bulk price and stock update', { crumbs: [{ label: 'Inventory', href: go('seller/inventory') }, 'Bulk update'], sub: 'Update prices and quantities for many SKUs with one CSV file.' })}
      ${U.steps(['Download template', 'Upload file', 'Check preview', 'Apply'], applied ? 4 : 2)}
      <div class="grid md2">
        <div class="card pad stack gap-2"><span class="row gap-2">${icon('file-down')}<span class="strong">1. Download the template</span></span><p class="small sub">Prefilled with your 24 SKUs, current prices and quantities. Columns: seller_sku, price, quantity.</p><div class="row gap-2">${btn('Download template', { v: 'secondary', size: 'sm', icon: 'download' })}</div></div>
        <div class="card pad stack gap-2"><span class="row gap-2">${icon('file-up')}<span class="strong">2. Upload your file</span></span>
          <div class="panel row gap-2 nowrap">${icon('file-spreadsheet', 'ic-sm')}<span class="small grow truncate">northwind-price-stock-2026-10-08.csv</span><span class="xs muted">48 rows</span></div>
          <div class="row gap-2">${btn('Replace file', { v: 'ghost', size: 'sm' })}</div></div>
      </div>
      ${applied ? done : preview}
      ${ex('Price changes over 50% in one update and broad catalog edits need extra confirmation. Stock changes are recorded with the reason "Bulk update" and your name.')}
    `, 'inventory');
    },
  });

  /* ======================================================================
     9. Orders
     ====================================================================== */
  const ORD = {
    'New': [
      { ref: 'MK-261008-12077', placed: 'Oct 8, 9:14 AM', buyer: 'Sam R.', items: 'Halden Pocket Bluetooth Speaker, Teal × 2', total: 118, status: 'New', due: ['Due today 5:00 PM', 'warning'], act: 'Prepare' },
      { ref: 'MK-261008-11902', placed: 'Oct 8, 8:02 AM', buyer: 'Priya K.', items: 'Halden Aurora ANC Headphones, Midnight black', total: 190.99, status: 'New', due: ['Due today 5:00 PM', 'warning'], act: 'Prepare' },
      { ref: 'MK-261008-12688', placed: 'Oct 8, 9:52 AM', buyer: 'Dev P.', items: 'Northwind Studio Cable Kit × 3', total: 72, status: 'New', due: ['Due today 5:00 PM', 'warning'], act: 'Prepare' },
    ],
    'Preparing': [
      { ref: 'MK-261007-10433', placed: 'Oct 7, 6:48 PM', buyer: 'Alex M.', items: 'Halden Pocket Bluetooth Speaker, Charcoal × 1', total: 59, status: 'Preparing', due: ['Overdue 3 h', 'danger'], act: 'Record shipment' },
      { ref: 'MK-261007-10291', placed: 'Oct 7, 3:20 PM', buyer: 'Nina W.', items: 'Halden Aurora ANC Headphones, Silver + Studio Cable Kit', total: 214.99, status: 'Preparing', due: ['Due today 5:00 PM', 'warning'], act: 'Record shipment' },
      { ref: 'MK-261008-11430', placed: 'Oct 8, 7:40 AM', buyer: 'Hana Y.', items: 'Halden Aurora ANC Headphones + Pocket Speaker, Teal', total: 243, status: 'Preparing', due: ['Due today 5:00 PM', 'warning'], act: 'Ship remaining item', note: '1 of 2 items shipped' },
    ],
    'Shipped': [
      { ref: 'MK-261007-09811', placed: 'Oct 7, 2:10 PM', buyer: 'Chris T.', items: 'Halden Aurora ANC Headphones, Midnight black', total: 190.99, status: 'Shipped', due: ['Shipped Oct 8 · on time', 'ok'], act: 'View tracking' },
      { ref: 'MK-261006-08544', placed: 'Oct 6, 4:55 PM', buyer: 'Leah S.', items: 'Halden Pocket Bluetooth Speaker, Teal', total: 59, status: 'In transit', due: ['Shipped Oct 7 · on time', 'ok'], act: 'View tracking' },
      { ref: 'MK-261006-08302', placed: 'Oct 6, 10:21 AM', buyer: 'Ben A.', items: 'Northwind Studio Cable Kit × 2', total: 52.99, status: 'Out for delivery', due: ['Shipped Oct 6 · on time', 'ok'], act: 'View tracking' },
      { ref: 'MK-261005-07710', placed: 'Oct 5, 1:37 PM', buyer: 'Marco D.', items: 'Halden Buds Pro, Charcoal', total: 149, status: 'Shipped', due: ['Shipped Oct 6 · 1 day late', 'danger'], act: 'View tracking' },
    ],
    'Completed': [
      { ref: 'MK-261006-08120', placed: 'Oct 6, 11:31 AM', buyer: 'Jordan L.', items: 'Northwind Studio Cable Kit', total: 24, status: 'Completed', due: ['Delivered Oct 8', 'ok'], act: 'View' },
      { ref: 'MK-261003-05530', placed: 'Oct 3, 8:15 PM', buyer: 'Erin C.', items: 'Halden Aurora ANC Headphones, Silver', total: 190.99, status: 'Completed', due: ['Delivered Oct 7', 'ok'], act: 'View' },
      { ref: 'MK-261002-04418', placed: 'Oct 2, 12:02 PM', buyer: 'Tom H.', items: 'Halden Pocket Bluetooth Speaker, Teal × 1', total: 59, status: 'Partly refunded', due: ['Delivered Oct 6', 'ok'], act: 'View' },
    ],
  };
  const orderTabs = (active) => tabs([
    { label: 'New', count: 3, href: go('seller/orders', 'New') },
    { label: 'Preparing', count: 3, href: go('seller/orders', 'Preparing') },
    { label: 'Shipped', count: 4, href: go('seller/orders', 'Shipped') },
    { label: 'Completed', count: 126, href: go('seller/orders', 'Completed') },
    { label: 'Cancellation requests', count: 1, href: go('seller/orders', 'Cancellation requests') },
  ], active);

  U.register({
    id: 'seller/orders', title: 'Orders', ref: 'Plan ch. 11, 12',
    states: ['New', 'Preparing', 'Shipped', 'Completed', 'Cancellation requests'],
    notes: 'The seller sees only its own fulfillment tasks, grouped by stage. Every row shows the dispatch deadline and the next action, overdue work is flagged, and cancellation requests get their own response queue. On phone the table becomes a card list.',
    render: (st) => {
      const tab = st || 'New';
      const head = `${pageHead('Orders', { sub: 'Only your items are shown. Dispatch deadlines are in Pacific Time.', actions: btn('Packing slips', { v: 'secondary', size: 'sm', icon: 'printer' }) + btn('Export', { v: 'secondary', size: 'sm', icon: 'download' }) })}
        ${orderTabs(tab)}
        ${tb(`${searchIn('Order number, buyer or SKU', 'so-q')}<label class="sr-only" for="so-date">Date placed</label>${select('so-date', ['Last 7 days', 'Today', 'Last 30 days', 'Custom range'], 'Last 7 days')}<label class="sr-only" for="so-sort">Sort</label>${select('so-sort', ['Dispatch deadline, soonest', 'Newest first', 'Oldest first'], 'Dispatch deadline, soonest')}`)}`;

      if (tab === 'Cancellation requests') {
        return U.sellerLayout(`${head}
          ${alert('info', 'Respond before you ship', 'If you accept, the buyer is refunded for the cancelled items and the request does not count against your cancellation rate. If the item has already shipped, decline and the buyer can return it instead.')}
          <section class="card">
            <div class="card-body stack gap-3">
              <div class="row between"><div class="stack gap-0"><a class="mono strong" href="${go('seller/order')}">MK-261008-12519</a><span class="xs muted">Placed Oct 8, 8:47 AM · Taylor B.</span></div>${status('Cancellation requested')}</div>
              <div class="row gap-3 nowrap">${U.img('speaker', 'var(--img-6)', 'tiny')}<span class="grow stack gap-0"><span class="small strong">Halden Pocket Bluetooth Speaker, Charcoal × 1</span><span class="xs muted">${money(59)} · not shipped</span></span></div>
              <div class="panel small"><b>Buyer's reason:</b> Ordered the wrong color. "Meant to order Teal, sorry. I'll place a new order."</div>
              <div class="row between">${deadline('Respond by today 5:00 PM', 'warning')}<div class="row gap-2">${btn('Decline, already shipped', { v: 'secondary', size: 'sm' })}${btn('Cancel item and refund', { size: 'sm' })}</div></div>
            </div>
          </section>
        `, 'orders');
      }

      const list = ORD[tab];
      const rows = list.map((o) => [
        `<a class="mono small strong" href="${go('seller/order')}">${o.ref}</a>`,
        `<span class="small nowrap">${o.placed}</span>`,
        o.buyer,
        `<span class="small">${o.items}</span>${o.note ? `<div class="xs t-info-text strong">${o.note}</div>` : ''}`,
        `<span class="num">${money(o.total)}</span>`,
        status(o.status),
        deadline(o.due[0], o.due[1]),
        btn(o.act, { v: o.due[1] === 'danger' && tab === 'Preparing' ? 'primary' : tab === 'New' ? 'primary' : 'secondary', size: 'sm', href: go('seller/order', tab === 'Shipped' ? 'Shipped' : 'To ship') }),
      ]);
      const overdue = list.some((o) => o.due[1] === 'danger' && (tab === 'Preparing'));
      return U.sellerLayout(`${head}
        ${overdue ? alert('danger', '1 order is past its dispatch deadline', 'MK-261007-10433 was due 3 hours ago. Ship it today and record tracking, or cancel the item if you can\'t fulfill it. The buyer has been told it is running late and can contact support.') : ''}
        ${tab === 'New' ? `<div class="row gap-2"><span class="small sub grow">3 new orders waiting. Mark them as preparing to tell buyers their order is being packed.</span>${btn('Print 3 packing slips', { v: 'secondary', size: 'sm', icon: 'printer' })}${btn('Mark all as preparing', { v: 'secondary', size: 'sm', icon: 'package' })}</div>` : ''}
        <section class="card no-phone">
          ${table(['Order', 'Placed', 'Buyer', 'Items', { label: 'Total', cls: 'r' }, 'Status', 'Dispatch deadline', 'Next action'], rows, { select: true, rowCls: list.map((o) => (o.due[1] === 'danger' ? 'is-flagged' : o.due[1] === 'warning' ? 'is-warn' : '')) })}
          <div class="card-foot" style="justify-content:space-between"><span class="xs muted">${tab === 'Completed' ? 'Showing 3 of 126' : `Showing ${list.length} of ${list.length}`}</span>${tab === 'Completed' ? U.pager(1, 42) : ''}</div>
        </section>
        <ul class="card sa-ocards only-phone">${list.map((o) => `<li>
          <div class="row between"><a class="mono small strong" href="${go('seller/order')}">${o.ref}</a>${status(o.status)}</div>
          <span class="small">${o.items}</span>
          ${o.note ? `<span class="xs t-info-text strong">${o.note}</span>` : ''}
          <div class="row between xs muted"><span>${o.buyer} · ${o.placed}</span><b class="num" style="color:var(--text)">${money(o.total)}</b></div>
          <div class="row between">${deadline(o.due[0], o.due[1])}${btn(o.act, { v: tab === 'New' || o.due[1] === 'danger' ? 'primary' : 'secondary', size: 'sm', href: go('seller/order', tab === 'Shipped' ? 'Shipped' : 'To ship') })}</div>
        </li>`).join('')}</ul>${U.lazyLoad({ end: tab !== 'Completed' })}
      `, 'orders');
    },
  });

  /* ======================================================================
     10. Order detail
     ====================================================================== */
  U.register({
    id: 'seller/order', title: 'Order detail', ref: 'Plan ch. 11, 12',
    states: ['To ship', 'Shipped'],
    notes: 'One seller\'s fulfillment task inside a larger customer order: only this seller\'s items, the dispatch deadline, shipping details, a shipment form that supports partial packages, item cancellation with refund rules, buyer messages and the timeline. Once shipped, tracking can be corrected with a recorded history.',
    render: (st) => {
      const shipped = st === 'Shipped';
      const itemsHtml = `<div class="sa-pkgitem">${U.img('speaker', 'var(--img-2)', 'thumb')}<div class="stack gap-0 grow"><span class="small strong">Halden Pocket Bluetooth Speaker</span><span class="xs muted">Teal · New · <span class="mono">NWA-PKT-TEAL</span></span><span class="xs muted">Qty 2 × ${money(59)}</span></div><div class="stack gap-1" style="align-items:flex-end"><b class="num">${money(118)}</b>${status(shipped ? 'Shipped' : 'Confirmed')}</div></div>`;

      const shipForm = card({
        title: 'Record shipment', sub: 'Add one package at a time. Items not in this package stay open.',
        body: `<div class="grid md2">
            ${field('Carrier', select('od-carrier', ['UPS', 'USPS', 'FedEx', 'OnTrac', 'Other'], 'UPS'))}
            ${field('Tracking number', input('od-track', '1Z 7W4 E91 03 4471 2085', { placeholder: 'From your carrier label' }), { hint: 'We check the format and show it to the buyer.' })}
            ${field('Ship date', input('od-date', 'Oct 8, 2026', { icon: 'calendar' }))}
            ${field('Shipping service', select('od-svc', ['UPS Ground', 'UPS 2nd Day Air', 'USPS Ground Advantage'], 'UPS Ground'))}
          </div>
          <div class="stack gap-2"><span class="label">Items in this package</span>
            <div class="sa-pkgitem"><span class="grow">${check('od-pk1', '<span class="small"><b>Halden Pocket Bluetooth Speaker, Teal</b><br><span class="xs muted">2 ordered · NWA-PKT-TEAL</span></span>', true)}</span><label class="sr-only" for="od-pkq">Quantity in this package</label>${select('od-pkq', ['2 of 2', '1 of 2'], '2 of 2')}</div>
            <span class="hint">Shipping fewer than ordered creates a partial shipment. The rest keeps its dispatch deadline.</span>
          </div>
          <div class="panel row gap-2 small">${icon('tag', 'ic-sm')}<span>Buy a UPS or USPS label here instead · <a href="javascript:void 0">Buy label</a></span></div>`,
        foot: btn('Mark as shipped', { icon: 'truck', href: go('seller/order', 'Shipped') }),
      });

      const shippedCard = card({
        title: 'Package 1 of 1', sub: 'Both items shipped',
        actions: btn('Edit tracking', { v: 'secondary', size: 'sm', icon: 'pencil' }),
        body: `${kv([['Carrier', 'UPS Ground'], ['Tracking', '<span class="mono">1Z7W4E910344712085</span> · <a href="javascript:void 0">Track</a>'], ['Shipped', 'Oct 8, 2026, 2:32 PM PT'], ['Contents', 'Halden Pocket Bluetooth Speaker, Teal × 2'], ['Arrival estimate', 'Mon, Oct 12 – Tue, Oct 13']])}
          ${U.track(['Shipped', 'In transit', 'Out for delivery', 'Delivered'], 1)}
          <div class="stack gap-2"><span class="xs strong">Tracking changes</span>
            ${timeline([
              { t: 'Tracking corrected', d: 'Oct 8, 2:40 PM · Avery Stone', state: 'warn', body: 'From 1Z7W4E910344712058 to 1Z7W4E910344712085. Reason: typo in last digits. Buyer was sent the corrected number.' },
              { t: 'Shipment recorded', d: 'Oct 8, 2:32 PM · Avery Stone', state: 'done' },
            ])}</div>`,
      });

      return U.sellerLayout(`
      ${pageHead(`Order <span class="mono">MK-261008-12077</span>`, { crumbs: [{ label: 'Orders', href: go('seller/orders') }, 'MK-261008-12077'], sub: 'Placed Oct 8, 2026, 9:14 AM PT · buyer Sam R. · payment accepted', actions: status(shipped ? 'Shipped' : 'New') + btn('Print packing slip', { v: 'secondary', size: 'sm', icon: 'printer' }) })}
      ${shipped
        ? `<div class="sa-cd t-ok">${icon('circle-check')}<div class="stack gap-0 grow"><span class="strong">Shipped on time</span><span class="xs sub">Dispatch deadline was today 5:00 PM PT · shipped 2:32 PM</span></div></div>`
        : `<div class="sa-cd">${icon('alarm-clock')}<div class="stack gap-0 grow"><span class="xs sub strong">Dispatch by today, Oct 8, 5:00 PM PT</span><span class="big">6 h 55 m left</span></div>${deadline('Due today 5:00 PM', 'warning')}</div>`}
      <div class="sa-split">
        <div class="stack gap-5">
          ${card({
            title: 'Your items in this order', sub: '1 product · 2 units',
            body: `${itemsHtml}
              <div class="panel row gap-2 small">${icon('info', 'ic-sm')}<span>The customer's order also has items from other sellers. You only see and handle your own items.</span></div>
              <div class="stack gap-1">${U.sumRow('Item subtotal', money(118))}${U.sumRow('Shipping charged (Standard, free over $49)', money(0))}${U.sumRow('Platform fee (example 10%)', '−' + money(11.8))}<div class="divider"></div>${U.sumRow('Estimated earnings', money(106.2), 'total')}</div>
              ${ex('Example fee rate. Earnings stay pending until delivery and the hold period end.')}`,
          })}
          ${shipped ? shippedCard : shipForm}
          ${shipped ? '' : card({
            title: "Can't fulfill an item?", sub: 'Cancel only the items you can\'t ship',
            body: `<div class="grid md2">
                ${field('Item', select('od-cx-item', ['Halden Pocket Bluetooth Speaker, Teal (2)'], 'Halden Pocket Bluetooth Speaker, Teal (2)'))}
                ${field('Quantity to cancel', select('od-cx-qty', ['1', '2'], '1'))}
              </div>
              ${field('Reason', select('od-cx-reason', ['Out of stock', 'Damaged in storage', 'Pricing error', 'Can\'t ship to this address', 'Other'], 'Out of stock'))}
              ${alert('warning', '', 'Sam is notified right away and refunded for the cancelled items under the cancellation policy. Seller cancellations count toward your cancellation rate.')}`,
            foot: btn('Cancel selected items', { v: 'danger-soft', size: 'sm' }),
          })}
          ${card({
            title: 'Messages with Sam R.', sub: 'Private to this order · reply within 24 h',
            actions: `<a class="small strong" href="${go('seller/customers')}">Open in Customers</a>`,
            body: `<div class="sa-msg"><span class="xs muted">Sam R. · Oct 8, 9:20 AM</span><p>Hi, these are gifts. Could you leave the receipt out of the box?</p></div>
              <div class="sa-msg me"><span class="xs muted">You · Oct 8, 9:41 AM</span><p>Sure, the packing slip will show no prices. They ship today.</p></div>
              ${field('Reply', textarea('od-reply', '', 'Write to Sam'), {})}
              <div class="row end">${btn('Send message', { size: 'sm', icon: 'send' })}</div>`,
          })}
        </div>
        <aside class="stack gap-5 sa-sticky">
          ${card({
            title: 'Ship to',
            body: `<div class="stack gap-0 small"><span class="strong">Sam Rivera</span><span>418 W Bannock St</span><span>Boise, ID 83702</span><span class="muted">Phone for carrier: (208) 555-0117</span></div>
              <div class="divider"></div>
              ${kv([['Method', 'Standard · UPS Ground or USPS'], ['Promised arrival', 'Mon, Oct 12 – Wed, Oct 14'], ['Gift note', 'Hide prices on packing slip']])}`,
          })}
          ${card({
            title: 'Timeline',
            body: timeline((shipped ? [
              { t: 'Tracking corrected', d: 'Oct 8, 2:40 PM · Avery Stone', state: 'warn' },
              { t: 'Shipped with UPS Ground', d: 'Oct 8, 2:32 PM · buyer notified', state: 'done' },
            ] : [{ t: 'Waiting for shipment', d: 'Dispatch by Oct 8, 5:00 PM PT', state: 'current' }]).concat([
              { t: 'Message from buyer answered', d: 'Oct 8, 9:41 AM', state: 'done' },
              { t: 'Fulfillment task created', d: 'Oct 8, 9:14 AM · deadline 5:00 PM', state: 'done' },
              { t: 'Payment accepted, items reserved', d: 'Oct 8, 9:14 AM', state: 'done' },
              { t: 'Order placed', d: 'Oct 8, 9:14 AM', state: 'done' },
            ])),
          })}
        </aside>
      </div>
    `, 'orders');
    },
  });

  /* ======================================================================
     11. Shipping settings
     ====================================================================== */
  U.register({
    id: 'seller/shipping', title: 'Shipping settings', ref: 'Plan ch. 11, 12',
    notes: 'Where Northwind ships, its methods and rates, free-shipping threshold, dispatch schedule with holiday closures, return address and label purchase where supported. Saving shows when changes take effect; existing orders keep the terms shown at purchase.',
    render: () => U.sellerLayout(`
      ${pageHead('Shipping', { sub: 'These settings drive the delivery estimates and shipping prices customers see on your offers.', actions: btn('Shipment records', { v: 'secondary', size: 'sm', icon: 'package-search', href: go('seller/orders', 'Shipped') }) })}
      <div class="sa-split">
        <div class="stack gap-5">
          ${card({
            title: 'Coverage', sub: 'Where you ship',
            body: `<div class="stack gap-2"><span class="label">Ship to</span>
                ${U.optCard('sh-cov', 'sh-cov1', '<b>48 contiguous states and Washington, DC</b>', 'Recommended for launch.', true)}
                ${U.optCard('sh-cov', 'sh-cov2', '<b>All 50 states</b>', 'Alaska and Hawaii orders use separate rates.', false)}
              </div>
              <div class="stack gap-2"><span class="label">Excluded areas</span>
                <div class="grid md2" style="--gap:8px">
                  ${check('sh-ex1', 'PO boxes', true)}${check('sh-ex2', 'APO / FPO / DPO military addresses', true)}${check('sh-ex3', 'Alaska', true)}${check('sh-ex4', 'Hawaii', true)}${check('sh-ex5', 'Puerto Rico, Guam and US Virgin Islands', true)}
                </div>
                <span class="hint">Customers in excluded areas see "Doesn't ship to your address" before checkout.</span>
              </div>`,
          })}
          ${card({
            title: 'Methods and rates',
            actions: btn('Add method', { v: 'secondary', size: 'sm', icon: 'plus' }),
            flush: true,
            body: table(['Method', 'Transit', 'Rate type', 'Rates', 'Free shipping', 'On'], [
              ['<span class="small strong">Standard</span><div class="xs muted">UPS Ground or USPS Ground Advantage</div>', '3–5 business days', 'By weight', '<span class="small num">Up to 1 lb ' + money(4.99) + '<br>1–5 lb ' + money(6.99) + '<br>5–20 lb ' + money(9.99) + '</span>', badge('Over $49', 'success'), U.toggle('sh-m1', '<span class="sr-only">Standard on</span>', true)],
              ['<span class="small strong">Expedited</span><div class="xs muted">UPS 2nd Day Air</div>', '2 business days', 'By weight', '<span class="small num">Up to 1 lb ' + money(6.99) + '<br>1–5 lb ' + money(9.99) + '<br>5–20 lb ' + money(14.99) + '</span>', '<span class="xs muted">No</span>', U.toggle('sh-m2', '<span class="sr-only">Expedited on</span>', true)],
              ['<span class="small strong">Large items</span><div class="xs muted">Bookshelf speakers, 20 lb and over</div>', '4–6 business days', 'Flat per package', '<span class="small num">' + money(19.99) + '</span>', '<span class="xs muted">No</span>', U.toggle('sh-m3', '<span class="sr-only">Large items on</span>', true)],
            ]),
            foot: `<div class="row gap-3 grow">${field('Free Standard shipping on orders over', input('sh-free', '49.00', { prefix: '$' }))}</div><span class="xs muted" style="max-width:40ch">Applies to your items in one order. Customers see "Free delivery" on qualifying offers.</span>`,
          })}
          ${card({
            title: 'Dispatch schedule', sub: 'Used to set each order\'s dispatch deadline',
            body: `<div class="grid md2">
                ${field('Handling time', select('sh-handle', ['Same business day', '1 business day', '2 business days', '3 business days'], '1 business day'))}
                ${field('Same-day order cutoff', select('sh-cut', ['10:00 AM PT', '12:00 PM PT', '2:00 PM PT'], '12:00 PM PT'), { hint: 'Orders before the cutoff are due by 5:00 PM the same day.' })}
              </div>
              <div class="stack gap-2"><span class="label">Business days</span>
                <div class="sa-days" role="group" aria-label="Business days">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => `<button type="button" class="pill-opt${i < 5 ? ' is-selected' : ''}" aria-pressed="${i < 5}">${d}</button>`).join('')}</div></div>
              <div class="stack gap-2"><div class="row between"><span class="label">Holiday closures</span>${btn('Add closure', { v: 'ghost', size: 'sm', icon: 'plus' })}</div>
                <ul class="list">
                  <li><span class="grow small"><b>Thanksgiving</b> · Thu, Nov 26 – Fri, Nov 27</span>${U.iconBtn('trash-2', 'Remove Thanksgiving closure')}</li>
                  <li><span class="grow small"><b>Winter break</b> · Thu, Dec 24 – Fri, Dec 25</span>${U.iconBtn('trash-2', 'Remove winter break closure')}</li>
                  <li><span class="grow small"><b>New Year's Day</b> · Fri, Jan 1, 2027</span>${U.iconBtn('trash-2', 'Remove New Year closure')}</li>
                </ul>
                <span class="hint">Arrival estimates skip closed days, and customers see a note during closures.</span></div>`,
          })}
          ${card({
            title: 'Return address',
            actions: btn('Edit', { v: 'ghost', size: 'sm', icon: 'pencil' }),
            body: `<div class="stack gap-0 small"><span class="strong">Northwind Audio Returns</span><span>1450 NW Raleigh St, Unit 3</span><span>Portland, OR 97209</span><span class="muted">(503) 555-0172 · returns@northwindaudio.example</span></div>
              ${ex('Return labels and buyer instructions use this address. Changing it affects only returns opened after the change.')}`,
          })}
          ${card({
            title: 'Shipping labels', sub: 'Where supported',
            body: `${U.toggle('sh-labels', 'Buy labels in Seller Center', true)}
              <ul class="list">
                <li><span class="grow small">UPS Ground and 2nd Day Air</span>${badge('Supported', 'success')}</li>
                <li><span class="grow small">USPS Ground Advantage and Priority Mail</span>${badge('Supported', 'success')}</li>
                <li><span class="grow small">FedEx, OnTrac and others</span>${badge('Enter tracking manually')}</li>
              </ul>
              ${ex('Label cost is deducted from your earnings and shown on your statement.')}`,
          })}
          <div class="sa-savebar">
            <div class="stack gap-1"><span class="small strong">2 unsaved changes</span><span class="xs muted">Free shipping threshold, holiday closure</span></div>
            <div class="row gap-2"><label class="sr-only" for="sh-when">Effective</label>${select('sh-when', ['Apply now (orders after saving)', 'Apply from Mon, Oct 12, 12:00 AM PT'], 'Apply now (orders after saving)')}${btn('Discard', { v: 'ghost' })}${btn('Save changes')}</div>
          </div>
        </div>
        <aside class="stack gap-5 sa-sticky">
          ${card({
            title: 'What customers see', sub: 'Example: Halden Pocket Speaker to Portland, OR',
            body: `${kv([['Price', money(59)], ['Shipping', 'Free Standard'], ['Arrives', 'Tue, Oct 13 – Wed, Oct 14'], ['Dispatch', 'Ships in 1 business day']])}
              <div class="panel xs sub">Order today by 12:00 PM PT to ship today.</div>`,
          })}
          ${card({
            title: 'When changes apply',
            body: `<p class="small sub">New settings apply to orders placed after the effective time. Existing orders keep the delivery terms and prices the customer accepted.</p>
              ${timeline([{ t: 'Last saved', d: 'Oct 7, 4:12 PM · Avery Stone', state: 'done', body: 'Added the Large items method.' }, { t: 'Shipping set up', d: 'Oct 3, 2026 · Avery Stone', state: 'done', body: 'Completed in the setup guide.' }])}`,
          })}
        </aside>
      </div>
    `, 'shipping'),
  });
})();
