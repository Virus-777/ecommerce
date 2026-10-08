/* Seller Center · Returns, Finance, Marketing and ads, Customers, Reports, Account health, Store and staff (plan ch. 10, 11, 13, 14, 15, 16, 17) */
(function () {
  const U = UI;
  const D = window.D;
  const { icon, btn, badge, status, go, money, card, table, field, input, select, textarea, check, radio, toggle, optCard, kv, sumRow, alert, deadline, steps, timeline, tabs, seg, chips, pageHead, stat, queueTile, meter, img, avatar, logoTile, dropzone, searchIn, iconBtn, esc } = U;

  U.css('seller-b', `
    .sb-kpis { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 1024px) { .sb-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } .sb-kpis.c3 { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .sb-bal { display: flex; flex-direction: column; gap: var(--sp-2); }
    .sb-bal .why { font-size: var(--fs-xs); color: var(--text-3); line-height: 1.45; }
    .sb-bal.is-held { border-color: var(--warning); box-shadow: inset 0 3px 0 var(--warning); }
    .sb-bal.is-avail { box-shadow: inset 0 3px 0 var(--brand); }
    .sb-main { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1100px) { .sb-main { grid-template-columns: minmax(0, 1fr) 360px; } }
    .sb-mlist > a { display: flex; flex-direction: column; gap: 6px; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); color: inherit !important; text-decoration: none !important; }
    .sb-mlist > a:last-child { border-bottom: 0; }
    .sb-mlist > a.is-flagged { box-shadow: inset 3px 0 0 var(--danger); }
    .sb-mlist > a.is-warn { box-shadow: inset 3px 0 0 var(--warning); }
    .sb-photos { display: grid; gap: var(--sp-2); grid-template-columns: repeat(3, minmax(0, 1fr)); max-width: 440px; }
    .sb-photos figure { display: flex; flex-direction: column; gap: 4px; margin: 0; }
    .sb-photos figcaption { font-size: var(--fs-2xs); color: var(--text-3); }
    .sb-quote { border-left: 3px solid var(--border-strong); padding: var(--sp-1) var(--sp-3); color: var(--text-2); font-size: var(--fs-sm); }
    .sb-impact { background: var(--surface-2); border-radius: var(--r-lg); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2); }
    .sb-impact .flow { display: grid; gap: var(--sp-2); grid-template-columns: minmax(0, 1fr); }
    .sb-impact .flow > div { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); display: flex; flex-direction: column; gap: 2px; }
    .sb-impact .flow b { font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
    .sb-thread { display: flex; flex-direction: column; gap: var(--sp-3); }
    .sb-msg { max-width: 88%; padding: var(--sp-3); border-radius: var(--r-lg); background: var(--surface-2); font-size: var(--fs-sm); display: flex; flex-direction: column; gap: 4px; align-self: flex-start; }
    .sb-msg.me { align-self: flex-end; background: var(--brand-soft); }
    .sb-msg.staff { background: var(--info-soft); border: 1px solid var(--info); }
    .sb-msg .who { font-size: var(--fs-xs); font-weight: 700; color: var(--text-2); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .sb-msg .when { font-size: var(--fs-2xs); color: var(--text-3); font-weight: 500; }
    .sb-sysnote { align-self: center; font-size: var(--fs-xs); color: var(--text-3); display: inline-flex; gap: 6px; align-items: center; text-align: center; }
    .sb-subform { border-left: 2px solid var(--border); padding-left: var(--sp-4); margin-left: var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-3); }
    .sb-subform.is-on { border-left-color: var(--brand); }
    .sb-total td { font-weight: 700; background: var(--surface-2); }
    .sb-neg { color: var(--danger); }
    .sb-pos { color: var(--success); }
    .sb-recon { display: flex; flex-direction: column; gap: var(--sp-2); }
    .sb-recon .sum-row { padding-block: 2px; }
    .sb-recon .sum-row.total { border-top: 1px solid var(--border-strong); padding-top: var(--sp-2); }
    .sb-inbox { display: grid; grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .sb-inbox { grid-template-columns: 300px minmax(0, 1fr); } .sb-inbox > .sb-inbox-list { border-right: 1px solid var(--border); } }
    @container app (min-width: 1280px) { .sb-inbox { grid-template-columns: 360px minmax(0, 1fr); } }
    .sb-conv { display: flex; flex-direction: column; gap: 4px; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); color: inherit !important; text-decoration: none !important; }
    .sb-conv:hover { background: var(--surface-2); }
    .sb-conv.is-active { background: var(--brand-soft); }
    .sb-conv.is-overdue { box-shadow: inset 3px 0 0 var(--danger); }
    .sb-conv-pane { display: flex; flex-direction: column; min-width: 0; }
    .sb-conv-pane > .hd { padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; }
    .sb-conv-pane > .bd { padding: var(--sp-4); }
    .sb-conv-pane > .ft { padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: var(--sp-2); }
    .sb-perm { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; }
    .sb-perm.full { color: var(--success); }
    .sb-perm.view { color: var(--info); }
    .sb-perm.none { color: var(--text-3); }
    .sb-perm.lock { color: var(--text-2); }
    .sb-prev { border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; background: var(--surface); }
    .sb-prev .imgph.sb-banner { aspect-ratio: 3 / 1; border-radius: 0; }
    .sb-prev .body { padding: 0 var(--sp-4) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
    .sb-prev .logo-tile { margin-top: -28px; border: 3px solid var(--surface); }
    .sb-pending { outline: 1.5px dashed var(--warning); outline-offset: 3px; border-radius: var(--r-xs); }
    .sb-device { border: 1px solid var(--border-strong); border-radius: var(--r-lg); padding: var(--sp-3); background: var(--bg); display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
    .sb-device.phone { max-width: 260px; border-radius: var(--r-xl); }
    .sb-adcard { position: relative; display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-3); border-radius: var(--r-md); background: var(--surface); border: 1px solid var(--border); }
    .sb-adcard .imgph { width: 72px; }
    .sb-adcard.col { flex-direction: column; }
    .sb-adcard.col .imgph { width: 100%; }
    .sb-ghostcard { border-radius: var(--r-md); background: var(--surface); border: 1px solid var(--border); padding: var(--sp-3); display: flex; gap: var(--sp-3); opacity: 0.55; }
    .sb-ghostcard i { display: block; height: 8px; border-radius: var(--r-pill); background: var(--surface-3); }
    .sb-metric { display: grid; gap: var(--sp-2) var(--sp-4); grid-template-columns: minmax(0, 1fr) auto; align-items: center; padding: var(--sp-3) 0; border-bottom: 1px solid var(--border); }
    .sb-metric:last-child { border-bottom: 0; }
    .sb-metric .bar { grid-column: 1 / -1; }
    .sb-restrict { border: 1px solid var(--warning); border-radius: var(--r-lg); background: var(--surface); overflow: hidden; }
    .sb-restrict > .hd { background: var(--warning-soft); padding: var(--sp-4); display: flex; gap: var(--sp-3); align-items: flex-start; }
    .sb-restrict > .hd > svg.lucide { color: var(--warning); margin-top: 2px; }
    .sb-restrict > .bd { padding: var(--sp-4); display: grid; gap: var(--sp-4); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 900px) { .sb-restrict > .bd { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .sb-ticks { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); }
    .sb-ticks li { display: flex; gap: var(--sp-2); align-items: flex-start; }
    .sb-ticks li > svg.lucide { width: 16px; height: 16px; margin-top: 2px; }
    .sb-ticks.ok li > svg.lucide { color: var(--success); }
    .sb-ticks.no li > svg.lucide { color: var(--danger); }
    .sb-form-grid { display: grid; gap: var(--sp-4); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .sb-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .sb-form-grid .full { grid-column: 1 / -1; } }
    .sb-mini { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 768px) { .sb-mini { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .sb-mini > div { background: var(--surface-2); border-radius: var(--r-md); padding: var(--sp-3); display: flex; flex-direction: column; gap: 2px; }
    .sb-mini b { font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
    .sb-sticky-foot { display: flex; gap: var(--sp-2); flex-wrap: wrap; justify-content: flex-end; align-items: center; }
  `);

  /* ---------- Local helpers ---------- */
  const r2 = (n) => Math.round(n * 100) / 100;
  const sm = (n) => (n < 0 ? '−' : '') + money(Math.abs(n));                     // signed money, minus only
  const sgn = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));      // signed money, plus or minus
  const amt = (n) => `<span class="num ${n < 0 ? 'sb-neg' : ''}">${sgn(n)}</span>`;
  const mono = (t, href) => (href ? `<a class="mono" href="${href}">${t}</a>` : `<span class="mono">${t}</span>`);
  const exNote = (t) => `<span class="xs muted">${icon('info', 'ic-sm')} ${t}</span>`;
  const ticks = (items, ok = true) => `<ul class="sb-ticks ${ok ? 'ok' : 'no'}">${items.map((t) => `<li>${icon(ok ? 'circle-check' : 'circle-x')}<span>${t}</span></li>`).join('')}</ul>`;
  const FEE = 0.10; // example commission rate
  const msg = (who, when, text, o = {}) => `<div class="sb-msg ${o.me ? 'me' : ''}${o.staff ? ' staff' : ''}"><span class="who">${who}${o.tag || ''}<span class="when">${when}</span></span><span>${text}</span>${o.att || ''}</div>`;
  const sysNote = (t, ic = 'info') => `<span class="sb-sysnote">${icon(ic, 'ic-sm')}${t}</span>`;

  /* ======================================================================
     1. Returns and cases list
     ====================================================================== */
  const RT_TABS = ['Return requests', 'Received, to inspect', 'Disputes', 'Closed'];
  const RT_DUE_HEAD = ['Respond by', 'Inspect by', 'Next deadline', 'Outcome'];
  const RT = [
    { ref: 'RT-261004-0871', order: 'MK-260929-05518', item: 'Studio Cable Kit', sku: 'NWA-CBL-KIT', reason: 'Missing parts', detail: 'No 3.5 mm adapter in the box', amount: 24.00, req: 'Oct 4, 7:02 PM', due: 'Overdue 6 h', tone: 'danger', status: 'Return requested', tab: 0, row: 'is-flagged' },
    { ref: 'RT-261005-0912', order: 'MK-260926-31840', item: 'Halden Pocket Bluetooth Speaker', sku: 'HAL-PKT-TEAL', reason: 'Defective', detail: 'Audio cuts out after a few minutes', amount: 59.00, req: 'Oct 5, 4:12 PM', due: 'Oct 9, 4:00 PM', tone: 'warning', status: 'Return requested', tab: 0, row: 'is-warn', open: true },
    { ref: 'RT-261007-0977', order: 'MK-261001-03321', item: 'Halden Aurora ANC Wireless Headphones', sku: 'HAL-AUR-BLK', reason: 'Changed mind', detail: 'Prefers a different fit', amount: 184.00, req: 'Oct 7, 9:40 AM', due: 'Oct 10, 9:40 AM', tone: 'ok', status: 'Return requested', tab: 0 },
    { ref: 'RT-261006-0941', order: 'MK-260930-06102', item: 'Halden Pocket Bluetooth Speaker', sku: 'HAL-PKT-SND', reason: 'Not as described', detail: 'Color differs from photos; you asked for a photo', amount: 59.00, req: 'Oct 6, 1:15 PM', due: 'Customer replies by Oct 11', tone: 'ok', status: 'Waiting on customer', tab: 0 },
    { ref: 'RT-261003-0855', order: 'MK-260927-02233', item: 'Studio Cable Kit', sku: 'NWA-CBL-KIT', reason: 'Arrived damaged', detail: 'Bent connector; prepaid label sent Oct 4', amount: 24.00, req: 'Oct 3, 10:05 AM', due: 'Arrives Oct 9', tone: 'ok', status: 'Return in transit', tab: 0 },
    { ref: 'RT-261001-0745', order: 'MK-260925-04410', item: 'Halden Pocket Bluetooth Speaker × 2', sku: 'HAL-PKT-TEAL', reason: 'Changed mind', detail: 'Received Oct 7, 2:00 PM', amount: 118.00, req: 'Oct 1, 8:30 PM', due: 'Oct 9, 2:00 PM', tone: 'warning', status: 'Inspecting', tab: 1, row: 'is-warn' },
    { ref: 'RT-260930-0730', order: 'MK-260922-01954', item: 'Halden Aurora ANC Wireless Headphones', sku: 'HAL-AUR-BLK', reason: 'Defective', detail: 'Received Oct 8, 9:05 AM', amount: 184.00, req: 'Sep 30, 6:44 PM', due: 'Oct 10, 9:05 AM', tone: 'ok', status: 'Inspecting', tab: 1 },
    { ref: 'RT-260927-0622', order: 'MK-260920-88341', item: 'Halden Aurora ANC Wireless Headphones', sku: 'HAL-AUR-BLK', reason: 'Not as described', detail: 'Customer disputes your $46.00 partial refund · case CS-261002-1180', amount: 184.00, req: 'Sep 27, 11:20 AM', due: 'Evidence due Oct 9, 5:00 PM', tone: 'warning', status: 'Escalated', tab: 2, row: 'is-flagged', dispute: true },
    { ref: 'RT-260919-0410', order: 'MK-260914-71206', item: 'Studio Cable Kit', sku: 'NWA-CBL-KIT', reason: 'Wrong item', detail: 'Marketly decided: refund without return · case CS-260923-1033', amount: 24.00, req: 'Sep 19, 3:02 PM', due: 'Appeal by Oct 16', tone: 'ok', status: 'Decision made', tab: 2, dispute: true },
    { ref: 'RT-261002-0804', order: 'MK-260928-04877', item: 'Studio Cable Kit', sku: 'NWA-CBL-KIT', reason: 'Missing parts', detail: 'Partial refund $8.00 for missing adapter', amount: 8.00, req: 'Oct 2, 9:12 AM', due: 'Closed Oct 3', tone: 'ok', status: 'Partly refunded', tab: 3 },
    { ref: 'RT-260930-0718', order: 'MK-260923-09310', item: 'Halden Pocket Bluetooth Speaker', sku: 'HAL-PKT-TEAL', reason: 'Defective', detail: 'Full refund after inspection', amount: 59.00, req: 'Sep 30, 8:51 AM', due: 'Closed Oct 2', tone: 'ok', status: 'Refunded', tab: 3 },
    { ref: 'RT-260924-0533', order: 'MK-260912-55102', item: 'Halden Aurora ANC Wireless Headphones', sku: 'HAL-AUR-BLK', reason: 'Defective', detail: 'Refunded after payout; deducted on statement Sep 28 – Oct 4', amount: 184.00, req: 'Sep 24, 5:30 PM', due: 'Closed Sep 30', tone: 'ok', status: 'Refunded', tab: 3 },
    { ref: 'RT-260921-0498', order: 'MK-260815-20661', item: 'Halden Pocket Bluetooth Speaker', sku: 'HAL-PKT-SND', reason: 'Changed mind', detail: 'Rejected: requested 7 days after the 30-day window', amount: 59.00, req: 'Sep 21, 12:40 PM', due: 'Closed Sep 22', tone: 'ok', status: 'Rejected', tab: 3 },
  ];

  U.register({
    id: 'seller/returns', title: 'Returns and cases', ref: 'Plan ch. 11, 13',
    notes: 'Return requests, received returns to inspect, disputes and closed cases with respond-by deadlines. Escalated disputes show that Marketly support is involved, and the return address is shown with an edit link.',
    states: RT_TABS,
    render: (state) => {
      const ti = Math.max(0, RT_TABS.indexOf(state || RT_TABS[0]));
      const rows = RT.filter((r) => r.tab === ti);
      const counts = RT_TABS.map((_, i) => RT.filter((r) => r.tab === i).length);
      const refCell = (r) => `<div class="stack gap-0">${mono(r.ref, go('seller/return', r.tab === 1 ? 'Inspect and refund' : 'Respond'))}${r.dispute ? `<span class="row gap-1" style="margin-top:4px">${badge('Marketly support involved', r.status === 'Escalated' ? 'danger' : 'info', 'shield')}</span>` : ''}</div>`;
      const dueCell = (r) => (ti === 3 ? `<span class="xs sub">${r.due}</span>` : r.status === 'Waiting on customer' || r.status === 'Return in transit' ? `<span class="xs sub">${r.due}</span>` : deadline(r.due, r.tone));
      const tbl = table([
        'Return', 'Order', 'Item', 'Reason', { label: ti === 3 ? 'Refunded' : 'Amount', cls: 'r' }, 'Requested', RT_DUE_HEAD[ti], 'Status',
      ], rows.map((r) => [
        refCell(r),
        mono(r.order, go('seller/order')),
        `<div class="stack gap-0" style="min-width:200px"><span class="small strong">${r.item}</span><span class="xs muted mono">${r.sku}</span></div>`,
        `<div class="stack gap-0" style="min-width:160px"><span class="small">${r.reason}</span><span class="xs muted">${r.detail}</span></div>`,
        `<span class="num">${ti === 3 && r.status === 'Rejected' ? money(0) : money(r.amount)}</span>`,
        `<span class="xs sub nowrap">${r.req}</span>`,
        dueCell(r),
        status(r.status),
      ]), { rowCls: rows.map((r) => r.row || '') });
      const mlist = `<div class="sb-mlist">${rows.map((r) => `<a href="${go('seller/return', r.tab === 1 ? 'Inspect and refund' : 'Respond')}" class="${r.row || ''}">
          <span class="row between"><span class="mono small strong">${r.ref}</span>${status(r.status)}</span>
          <span class="small strong">${r.item}</span>
          <span class="xs sub">${r.reason} · ${r.detail}</span>
          <span class="row between"><span class="num small strong">${money(r.amount)}</span>${dueCell(r)}</span>
          ${r.dispute ? `<span>${badge('Marketly support involved', r.status === 'Escalated' ? 'danger' : 'info', 'shield')}</span>` : ''}
        </a>`).join('')}</div>`;

      const tabHint = [
        'Approve, reject with a reason or request information before the respond-by time. If you miss it, Marketly support may decide the return.',
        'Record the item condition and your refund decision within 2 days of receipt (example target).',
        'Marketly support reviews purchase terms, shipment evidence, photos and messages, then records a decision. Each decision has an appeal deadline.',
        'Returns closed in the last 30 days. Refunds show the amount actually sent to the customer.',
      ][ti];

      return U.sellerLayout(`
        ${pageHead('Returns and cases', { sub: 'All times Pacific. Customers see your response target on their return page.', actions: btn('Export', { v: 'secondary', icon: 'download', size: 'sm' }) + btn('Return policy', { v: 'secondary', icon: 'file-text', size: 'sm', href: go('seller/store') }) })}

        <div class="sb-kpis">
          ${queueTile(1, 'Response overdue', { tone: 'danger', sub: 'RT-261004-0871 · Marketly may step in', href: go('seller/returns', 'Return requests') })}
          ${queueTile(2, 'Waiting for your response', { tone: 'warning', sub: 'Next due Oct 9, 4:00 PM', href: go('seller/returns', 'Return requests') })}
          ${queueTile(2, 'Received, to inspect', { sub: 'Oldest received Oct 7', href: go('seller/returns', 'Received, to inspect') })}
          ${queueTile(1, 'Dispute needs evidence', { tone: 'danger', sub: 'Due Oct 9, 5:00 PM', href: go('seller/returns', 'Disputes') })}
        </div>

        <div class="sb-main">
          ${card({
            flush: true,
            body: `<div style="padding:0 var(--sp-2)">${tabs(RT_TABS.map((t, i) => ({ label: t, count: counts[i], href: go('seller/returns', t) })), ti)}</div>
              <div class="stack gap-3" style="padding:var(--sp-4)">
                <div class="toolbar">${searchIn('Search return, order or SKU', 'rt-q')}<label class="sr-only" for="rt-reason">Reason</label>${select('rt-reason', ['All reasons', 'Defective', 'Changed mind', 'Not as described', 'Missing parts', 'Arrived damaged', 'Wrong item'], 'All reasons')}<label class="sr-only" for="rt-period">Period</label>${select('rt-period', ['Last 30 days', 'Last 90 days', 'This year'], 'Last 30 days')}</div>
                <p class="xs sub">${tabHint}</p>
              </div>
              <div class="no-phone">${tbl}</div>
              <div class="only-phone" style="border-top:1px solid var(--border)">${mlist}</div>`,
            foot: `<span class="xs muted grow">${rows.length} of ${rows.length} ${ti === 3 ? 'closed returns' : 'cases'}</span>`,
          })}

          <div class="stack gap-5">
            ${card({
              title: 'Return address', sub: 'Printed on prepaid labels and shown to customers',
              actions: `<a class="small strong" href="${go('seller/store')}">${icon('pencil', 'ic-sm')} Edit</a>`,
              body: `<div class="row top gap-3">${icon('map-pin')}<div class="stack gap-0 small"><span class="strong">Northwind Audio Returns</span><span>1820 SE Water Ave, Unit 4</span><span>Portland, OR 97214</span><span class="muted">Receiving hours Mon–Fri, 9 AM–5 PM PT</span></div></div>
                <p class="xs muted">A new address applies to new return requests. Returns already on their way keep the address on their label.</p>`,
            })}
            ${card({
              title: 'Your return terms', sub: 'Within the platform baseline',
              body: kv([
                ['Return window', '30 days after delivery'],
                ['Change of mind', 'Customer pays return shipping'],
                ['Defective, damaged, wrong item', 'You pay return shipping'],
                ['Response target', 'Within 2 business days (example)'],
                ['Refund target', 'Within 2 days of receipt (example)'],
              ]) + `<p class="xs muted">Customers see these terms before they buy. Orders keep the terms accepted at purchase.</p>`,
            })}
          </div>
        </div>
      `, 'returns');
    },
  });

  /* ======================================================================
     2. Return case RT-261005-0912
     ====================================================================== */
  const impactPanel = (refund, o = {}) => {
    const fee = r2(refund * FEE), earn = r2(refund - fee);
    return `<div class="sb-impact">
      <div class="row between"><span class="small strong">Effect on your earnings</span>${o.example ? badge('Example', 'outline') : ''}</div>
      <div class="flow">
        <div><span class="xs muted">Refund to customer</span><b>${money(refund)}</b></div>
        <div><span class="xs muted">Your earnings</span><b class="sb-neg">${sm(-earn)}</b></div>
        <div><span class="xs muted">Marketplace fee refunded to you</span><b>${money(fee)}</b></div>
      </div>
      ${o.label ? sumRow('Prepaid return label (you pay, defective item)', `<span class="sb-neg">${sm(-o.label)}</span>`) : ''}
      ${sumRow('Total change to your balance', `<b class="sb-neg">${sm(-(earn + (o.label || 0)))}</b>`, 'strong')}
      <span class="xs muted">Refund ${money(refund)} → your earnings ${sm(-earn)}, fee refunded ${money(fee)}. ${o.example ? 'Example rate of 10%. Final fees are in the seller agreement.' : 'Commission rate 10% (example rate).'} If this order was already paid out, the amount is deducted from your next payout.</span>
    </div>`;
  };

  U.register({
    id: 'seller/return', title: 'Return case', ref: 'Plan ch. 13',
    notes: 'One return from request to refund: customer reason and photos, the policy that applies, approve / reject with reason / request information, return shipping responsibility, inspection outcome, full or partial refund and its effect on seller earnings and fees. Shows the dispute thread with Marketly support and that the platform may step in if the deadline is missed.',
    states: ['Respond', 'Inspect and refund'],
    render: (state) => {
      const insp = state === 'Inspect and refund';
      const head = pageHead(`Return <span class="mono">RT-261005-0912</span>`, {
        crumbs: [{ label: 'Returns and cases', href: go('seller/returns') }, { label: 'RT-261005-0912' }],
        sub: `Order ${mono('MK-260926-31840', go('seller/order'))} · requested Oct 5, 2026, 4:12 PM PT by Dana W. · reason: Defective`,
        actions: insp ? status('Inspecting') : status('Return requested'),
      });
      const prog = steps(['Requested', 'Your response', 'Return shipped', 'Received and inspected', 'Refund'], insp ? 3 : 1);

      const request = card({
        title: 'Customer’s request', sub: 'Submitted with the return form',
        body: `<div class="row gap-2">${badge('Defective', 'warning', 'zap-off')}${badge('Wants: refund to original payment', 'outline')}</div>
          <p class="sb-quote">“Works for about five minutes, then the sound cuts out and it disconnects from my phone. Tried two phones and a full charge. Same thing every time.”</p>
          <div class="sb-photos">
            <figure>${img('image', 'var(--img-2)', 'r43')}<figcaption>Speaker, front</figcaption></figure>
            <figure>${img('smartphone', 'var(--img-6)', 'r43')}<figcaption>Bluetooth screen, disconnected</figcaption></figure>
            <figure>${img('package-open', 'var(--img-3)', 'r43')}<figcaption>Box and cable</figcaption></figure>
          </div>
          <span class="xs muted">3 photos · uploaded Oct 5, 4:10 PM</span>`,
      });

      const item = card({
        title: 'Order item',
        body: `<div class="row top gap-3">${img('speaker', 'var(--img-2)', 'thumb')}<div class="stack gap-1 grow">
            <span class="small strong">Halden Pocket Bluetooth Speaker</span>
            <span class="xs sub">Teal · ${mono('HAL-PKT-TEAL')} · Qty 1 of 1</span>
            <span class="xs sub">Delivered Sep 29 · return window ends Oct 29</span></div>
            <span class="num strong">${money(59)}</span></div>
          ${kv([['Paid by customer', `${money(59)} item · ${money(0)} shipping · no discount`], ['Max refundable', `${money(59)} (nothing refunded yet)`], ['Payment', 'Visa •••• 2290, refund goes back to this card']])}`,
      });

      const policy = card({
        title: 'Policy that applies', sub: 'Terms accepted at purchase, Sep 26, 2026',
        body: `${kv([
          ['Your return terms', '30 days after delivery'],
          ['Reason category', 'Defective item'],
          ['Return shipping', '<b>You pay</b> (platform rule for defective, damaged or wrong items)'],
          ['Remedy offered', 'Refund or replacement'],
          ['Respond by', 'Fri, Oct 9, 4:00 PM PT (2 business days, example)'],
        ])}
        <p class="xs muted">Platform baseline: 30-day returns. You may offer more generous terms, not shorter ones.</p>`,
      });

      const respond = card({
        title: 'Your response', sub: 'The customer sees your decision and any explanation',
        body: `${optCard('rt-dec', 'rt-dec-approve', '<span class="strong">Approve return</span>', 'Send a prepaid label. Refund after you receive and inspect the item.', true)}
          <div class="sb-subform is-on">
            <span class="small strong">Return shipping</span>
            ${optCard('rt-ship', 'rt-ship-seller', `<span class="row between"><span class="strong small">You pay: prepaid USPS label</span><span class="num small">${money(8.45)}</span></span>`, 'Deducted from your earnings. Example rate.', true)}
            ${optCard('rt-ship', 'rt-ship-cust', '<span class="strong small">Customer pays</span>', 'Not allowed for defective items under platform rules.', false, { disabled: true })}
            ${check('rt-noreturn', 'Refund without asking for the item back (records a reason; use for low-value or unsafe items)', false)}
          </div>
          ${optCard('rt-dec', 'rt-dec-info', '<span class="strong">Request more information</span>', 'Pauses the respond-by clock until the customer replies, up to 3 days.', false)}
          <div class="sb-subform">
            ${field('Question for the customer', textarea('rt-info-q', '', 'Example: Does the speaker cut out when connected by cable as well?'), { opt: false })}
          </div>
          ${optCard('rt-dec', 'rt-dec-reject', '<span class="strong">Reject return</span>', 'Only when the request breaks your published terms. The customer can ask Marketly to review.', false)}
          <div class="sb-subform">
            ${field('Reason for rejecting (required)', select('rt-rej-reason', ['Choose a reason', 'Outside the return window', 'Item not eligible for return', 'Item damaged by the customer', 'Other (explain below)'], 'Choose a reason'))}
            ${field('Explanation shown to the customer (required)', textarea('rt-rej-text', '', 'Explain which term applies and what the customer can do next.'))}
          </div>`,
        foot: `${btn('Request information', { v: 'secondary' })}${btn('Approve and send label', { icon: 'check' })}`,
      });

      const shipment = card({
        title: 'Return shipment', sub: 'Tracked separately from the original delivery',
        body: `${kv([['Carrier', 'USPS Ground Advantage, prepaid label'], ['Tracking', mono('9202 1901 2475 3381 0049 17')], ['Label cost', `${money(8.45)} (you pay, defective item)`], ['Delivered to', 'Northwind Audio Returns, Portland, OR 97214']])}
          ${timeline([
            { t: 'Delivered to your return address', d: 'Oct 8, 10:20 AM', state: 'done' },
            { t: 'In transit', d: 'Oct 7, 6:02 AM · Portland, OR', state: 'done' },
            { t: 'Dropped off by customer', d: 'Oct 6, 5:41 PM · Seattle, WA', state: 'done' },
            { t: 'Return approved, label sent', d: 'Oct 5, 6:15 PM · by Avery Stone', state: 'done' },
          ])}`,
      });

      const inspect = card({
        title: 'Inspection outcome', sub: 'Record what arrived before you decide the refund',
        body: `<fieldset class="stack gap-2" style="border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:6px">Condition on arrival</legend>
            ${optCard('rt-cond', 'rt-cond-ok', '<span class="strong small">As described by the customer</span>', 'Defect confirmed: audio drops after 4–6 minutes on battery.', true)}
            ${optCard('rt-cond', 'rt-cond-dmg', '<span class="strong small">Damaged by the customer</span>', 'Physical damage not reported in the request. Add photos.', false)}
            ${optCard('rt-cond', 'rt-cond-miss', '<span class="strong small">Missing parts</span>', 'Choose what is missing so a partial refund can be explained.', false)}
          </fieldset>
          <div class="sb-form-grid">
            ${field('Inspection notes', textarea('rt-insp-notes', 'Tested on two phones. Drops connection at 4–6 min on battery, works on USB power. Matches a known battery-board fault. All parts and box included.'), { opt: true })}
            ${field('Stock outcome', select('rt-stock', ['Return to supplier (Halden RMA)', 'Back to available stock', 'Damaged stock', 'Write off'], 'Return to supplier (Halden RMA)'), { hint: 'Updates your inventory: the unit does not go back on sale.' })}
          </div>
          ${dropzone('Add inspection photos', 'Optional, JPG or PNG up to 10 MB. Kept with the case if the customer disputes it.')}`,
      });

      const refundForm = card({
        title: 'Refund decision', sub: `Refundable now: ${money(59)} of ${money(59)}`,
        body: `${optCard('rt-ref', 'rt-ref-full', `<span class="row between"><span class="strong small">Full refund</span><span class="num strong">${money(59)}</span></span>`, 'Item value. Original shipping was free.', true)}
          ${optCard('rt-ref', 'rt-ref-part', '<span class="strong small">Partial refund</span>', 'Only with a recorded reason, for example missing parts or damage caused after delivery.', false)}
          <div class="sb-subform">
            <div class="sb-form-grid">
              ${field('Partial amount', input('rt-ref-amt', '', { prefix: '$', placeholder: '0.00' }), { hint: `Up to ${money(59)}. You can't refund more than the customer paid.` })}
              ${field('Explanation for the customer (required for partial)', textarea('rt-ref-why', '', 'Example: Charging cable was not returned. Deducted $6.00, the replacement cost.'))}
            </div>
          </div>
          ${alert('info', 'What the customer sees', 'After you confirm, the refund shows as Processing until the card network confirms it, then Sent. We tell the customer it can take 3–5 business days to appear. We never show it as received before that.')}`,
        foot: `${btn('Save draft', { v: 'ghost' })}${btn(`Confirm inspection and refund ${money(59)}`, { icon: 'check' })}`,
      });

      const thread = card({
        title: 'Messages and evidence', sub: insp ? 'Customer, you and Marketly support · kept with this case' : 'Customer and you · Marketly support joins if the case is escalated',
        body: `<div class="sb-thread">
            ${msg('Dana W. (customer)', 'Oct 5, 4:12 PM', 'Requesting a return. The speaker cuts out after a few minutes, photos attached.')}
            ${insp ? msg('You · Avery Stone', 'Oct 5, 6:15 PM', 'Sorry about that. I approved the return and sent a prepaid label to your email. The refund follows once it arrives and we test it.', { me: true }) : ''}
            ${insp ? sysNote('Return approved and label sent · Oct 5, 6:15 PM', 'circle-check') : ''}
            ${insp ? msg('Dana W. (customer)', 'Oct 7, 8:30 AM', 'Dropped it off yesterday. When will I get my money back?') : ''}
            ${insp ? msg('Marco Diaz · Marketly support', 'Oct 7, 9:12 AM', 'The customer asked us about refund timing. The parcel is due today. Please record the inspection by Oct 10, 10:20 AM PT so the refund stays on target.', { staff: true, tag: badge('Marketly', 'info', 'shield') }) : ''}
            ${insp ? '' : sysNote('Respond by Oct 9, 4:00 PM PT. After that, Marketly support may decide this return.', 'clock')}
          </div>
          ${field('Reply', textarea('rt-reply', '', insp ? 'Reply to the customer and Marketly support' : 'Write to the customer'), { hint: 'Messages stay private to this order. Don’t share personal contact details or links outside Marketly.' })}
          <div class="stack gap-2"><span class="label">Dispute evidence</span>
            <span class="xs muted">If the customer disputes your decision, support reviews purchase terms, shipment records, photos and these messages. Add files now so they are on record.</span>
            ${dropzone('Upload evidence', 'Photos, test videos, invoices or carrier records · PDF, JPG, PNG, MP4 up to 25 MB')}
            ${insp ? `<ul class="list"><li>${icon('file-text', 'ic-sm')}<span class="grow small">inspection-test-oct8.mp4</span><span class="xs muted">14.2 MB · you · Oct 8</span></li></ul>` : ''}
          </div>`,
        foot: `${btn('Attach file', { v: 'ghost', icon: 'paperclip' })}${btn('Send message', { v: 'secondary', icon: 'send' })}`,
      });

      const side = `<div class="stack gap-5">
          ${insp
            ? alert('info', 'Inspect and refund by Sat, Oct 10, 10:20 AM PT', 'Received Oct 8, 10:20 AM. Example target: 2 days after receipt. Marketly support may step in if this passes.')
            : alert('warning', 'Respond by Fri, Oct 9, 4:00 PM PT', `${deadline('1 day 6 h left', 'warning')}<br>If you miss the deadline, Marketly support may decide the return for you, and it counts as an unresolved case in Account health.`)}
          ${card({ body: impactPanel(59, { example: !insp, label: 8.45 }) })}
          ${card({
            title: 'Customer',
            body: `<div class="row gap-3">${avatar('Dana W')}<div class="stack gap-0"><span class="small strong">Dana W.</span><span class="xs muted">Seattle, WA · 4 orders with you</span></div></div>
              <p class="xs muted">Contact details stay private. Use the case messages.</p>`,
          })}
          ${card({
            title: 'Activity',
            body: timeline(insp ? [
              { t: 'Return delivered to you', d: 'Oct 8, 10:20 AM', state: 'current' },
              { t: 'Support note added', d: 'Oct 7, 9:12 AM · Marco Diaz' , state: 'done' },
              { t: 'Return shipped by customer', d: 'Oct 6, 5:41 PM', state: 'done' },
              { t: 'Approved, label sent', d: 'Oct 5, 6:15 PM · Avery Stone', state: 'done' },
              { t: 'Return requested', d: 'Oct 5, 4:12 PM · Dana W.', state: 'done' },
            ] : [
              { t: 'Waiting for your response', d: 'Due Oct 9, 4:00 PM PT', state: 'warn' },
              { t: 'Viewed by Leo Grant', d: 'Oct 6, 9:02 AM', state: 'done' },
              { t: 'Return requested', d: 'Oct 5, 4:12 PM · Dana W.', state: 'done' },
              { t: 'Delivered', d: 'Sep 29, 1:48 PM · USPS', state: 'done' },
            ]),
          })}
        </div>`;

      const main = insp
        ? `<div class="stack gap-5">${prog}${shipment}${inspect}${refundForm}${request}${thread}</div>`
        : `<div class="stack gap-5">${prog}${request}<div class="grid lg2" style="--gap:20px">${item}${policy}</div>${respond}${thread}</div>`;

      return U.sellerLayout(`${head}<div class="sb-main">${main}${side}</div>`, 'returns');
    },
  });

  /* ======================================================================
     Statement data (shared by Finance and Statement so totals agree)
     ====================================================================== */
  const ST = {
    sales: [
      ['Halden Pocket Bluetooth Speaker', 'HAL-PKT-TEAL / SND', 38, 2242.00],
      ['Halden Aurora ANC Wireless Headphones', 'HAL-AUR-BLK', 9, 1656.00],
      ['Studio Cable Kit', 'NWA-CBL-KIT', 12, 288.00],
      ['Ardent USB Desk Microphone', 'ARD-USB-MIC', 1, 100.00],
    ],
    sellerDiscount: -129.80, // Fall audio markdown, 10% on 22 Pocket Speakers
    shipping: 62.91,         // 9 orders × $6.99
    refunds: [
      ['Oct 2', 'RT-260930-0718', 'Halden Pocket Bluetooth Speaker · defective, full refund', -59.00],
      ['Oct 3', 'RT-261002-0804', 'Studio Cable Kit · missing adapter, partial refund', -8.00],
    ],
    afterPayout: ['Sep 30', 'RT-260924-0533', 'Halden Aurora ANC Wireless Headphones · sold Sep 12, paid out in PO-260921-2954', -184.00],
    holds: [
      ['Oct 3', 'MK-261003-07712', 'Held: carrier shows no delivery scan. Review Oct 12.', -172.59],
      ['Oct 1', 'MK-260924-03987', 'Released: delivery confirmed by carrier Sep 30', 106.20],
    ],
    adjustments: [
      ['Sep 30', 'ADJ-260930-0112', 'Duplicate shipping label charge reversed for MK-260929-05518', 'Label billed twice by carrier · recorded by Priya Nair, Finance', 4.35],
      ['Oct 2', 'ADJ-261002-0127', 'Late dispatch goodwill credit for MK-261001-03321', 'Dispatched 2 days late; seller agreement section 7.3 · recorded by Isabel Cruz, Support', -5.00],
    ],
    ads: [['Sep 28 – Oct 4', 'AD-260915-0044', 'Pocket Speaker search boost · sponsored product · 236 clicks × $0.35', -82.60]],
  };
  const sum = (a, i) => r2(a.reduce((s, x) => s + x[i], 0));
  const stItems = sum(ST.sales, 3);
  const stFeeBasis = r2(stItems + ST.sellerDiscount);
  const stFee = r2(-stFeeBasis * FEE);
  const stProceeds = r2(stItems + ST.sellerDiscount + ST.shipping);
  const stRefunds = sum(ST.refunds, 3);
  const stRefundFees = r2(-stRefunds * FEE);
  const stAfter = ST.afterPayout[3];
  const stAfterFee = r2(-stAfter * FEE);
  const stHolds = sum(ST.holds, 3);
  const stAdj = sum(ST.adjustments, 4);
  const stAds = sum(ST.ads, 3);
  const PAYOUT = r2(stProceeds + stFee + stRefunds + stRefundFees + stAfter + stAfterFee + stHolds + stAdj + stAds);

  /* ======================================================================
     3. Finance
     ====================================================================== */
  const BANK = 'Pacific Coast Credit Union •••• 6620';
  U.register({
    id: 'seller/finance', title: 'Finance', ref: 'Plan ch. 14',
    notes: 'Seller balances explained one by one (proceeds, pending, available, held with reason and review date), next payout with a verified destination, a ledger of sales, fees, refunds, adjustments, ad charges and payouts with a running balance, and payout statuses. Shows how a refund after payout creates a negative balance and that destination changes need verification and review.',
    render: () => {
      const start = 6320.02; // chosen so the latest balance equals pending + available + held
      const tx = [
        ['Oct 5, 6:00 AM', 'Payout', 'PO-261005-3381', `To ${BANK}`, -PAYOUT],
        ['Oct 5, 11:42 AM', 'Sale', 'MK-261005-17730', 'Halden Pocket Bluetooth Speaker × 1', 59.00],
        ['Oct 5, 11:42 AM', 'Marketplace fee', 'MK-261005-17730', '10% of $59.00 item price', -5.90],
        ['Oct 6, 3:18 PM', 'Sale', 'MK-261006-20419', 'Halden Aurora ANC Headphones, incl. $6.99 shipping', 190.99],
        ['Oct 6, 3:18 PM', 'Marketplace fee', 'MK-261006-20419', '10% of $184.00 item price (shipping excluded)', -18.40],
        ['Oct 6, 11:59 PM', 'Ad charge', 'AD-260915-0044', 'Pocket Speaker search boost · 38 clicks Oct 6', -13.30],
        ['Oct 7, 10:05 AM', 'Refund', 'RT-260929-0702', 'Studio Cable Kit · full refund', -24.00],
        ['Oct 7, 10:05 AM', 'Marketplace fee', 'RT-260929-0702', 'Fee refunded on returned item', 2.40],
        ['Oct 7, 4:30 PM', 'Adjustment', 'ADJ-261007-0141', 'Carrier claim paid, lost parcel MK-260922-01187 · Priya Nair, Finance', 45.00],
        ['Oct 8, 9:14 AM', 'Sale', 'MK-261008-12077', 'Halden Pocket Bluetooth Speaker × 2', 118.00],
        ['Oct 8, 9:14 AM', 'Marketplace fee', 'MK-261008-12077', '10% of $118.00', -11.80],
      ];
      let bal = start;
      const withBal = tx.map((t) => { bal = r2(bal + t[4]); return [...t, bal]; }).reverse();
      const typeIc = { Sale: 'shopping-bag', 'Marketplace fee': 'percent', Refund: 'undo-2', Adjustment: 'scale', 'Ad charge': 'megaphone', Payout: 'landmark' };
      const txTable = table(['Date', 'Type', 'Reference', 'Details', { label: 'Amount', cls: 'r' }, { label: 'Balance after', cls: 'r' }], withBal.map((t) => [
        `<span class="xs sub nowrap">${t[0]}</span>`,
        `<span class="row gap-2 nowrap small">${icon(typeIc[t[1]], 'ic-sm')}${t[1]}</span>`,
        mono(t[2], t[1] === 'Payout' ? go('seller/statement') : t[1] === 'Refund' ? go('seller/return') : t[2].startsWith('MK') ? go('seller/order') : null),
        `<span class="small" style="display:inline-block;min-width:220px">${t[3]}</span>`,
        amt(t[4]),
        `<span class="num small">${money(t[5])}</span>`,
      ]));

      const payouts = [
        ['PO-261012-3502', 'Mon, Oct 12', 'Estimated', 1318.62, 'Pending', 'Amount set at cutoff Sun, Oct 11, 11:59 PM PT'],
        ['PO-261005-3381', 'Mon, Oct 5', 'Oct 6', PAYOUT, 'Paid', 'Statement Sep 28 – Oct 4'],
        ['PO-260928-3240', 'Mon, Sep 28', 'Sep 29', 2871.44, 'Paid', 'Statement Sep 21 – Sep 27'],
        ['PO-260921-2954', 'Mon, Sep 21', 'Sep 22', 3105.08, 'Paid', 'Statement Sep 14 – Sep 20'],
        ['PO-260916-2833', 'Wed, Sep 16', 'Sep 17', 2214.90, 'Paid', 'Retry of PO-260914-2810 to the updated account'],
        ['PO-260914-2810', 'Mon, Sep 14', '—', 2214.90, 'Failed', 'Bank returned it: account closed (R02). Funds kept safe in your balance.'],
      ];
      const payTable = table(['Payout', 'Requested', 'Arrived', { label: 'Amount', cls: 'r' }, 'Status', 'Result'], payouts.map((p) => [
        mono(p[0], p[4] === 'Paid' ? go('seller/statement') : null), `<span class="small nowrap">${p[1]}</span>`, `<span class="small nowrap">${p[2]}</span>`, `<span class="num strong">${money(p[3])}</span>`, status(p[4]), `<span class="xs sub" style="display:inline-block;min-width:200px">${p[5]}</span>`,
      ]), { rowCls: payouts.map((p) => (p[4] === 'Failed' ? 'is-flagged' : '')) });

      const balCard = (label, value, why, o = {}) => `<div class="card pad sb-bal ${o.cls || ''}">${stat(label, money(value), { icon: o.icon })}<span class="why">${why}</span>${o.extra || ''}</div>`;

      return U.sellerLayout(`
        ${pageHead('Finance', { sub: 'Balances as of Thu, Oct 8, 2026, 9:40 AM PT. Example settlement rules: weekly payouts on Mondays, earnings become available 3 days after delivery.', actions: btn('Statements', { v: 'secondary', icon: 'file-text', size: 'sm', href: go('seller/statement') }) + btn('Export ledger', { v: 'secondary', icon: 'download', size: 'sm' }) })}

        <div class="sb-kpis">
          ${balCard('Sales proceeds', 2184.30, 'Accepted sales this period (Oct 5–8), including shipping you charged. Before fees, refunds and holds.', { icon: 'shopping-bag' })}
          ${balCard('Pending earnings', 1742.85, 'After fees, waiting for delivery plus the 3-day hold. Moves to available on its own.', { icon: 'hourglass' })}
          ${balCard('Available earnings', 1318.62, 'Eligible for your next payout. Fees, refunds and holds already taken off.', { icon: 'wallet', cls: 'is-avail' })}
          ${balCard('Held amounts', 172.59, 'Temporarily withheld. Not lost: released or adjusted after review.', { icon: 'lock', cls: 'is-held', extra: `<div class="panel stack gap-1"><span class="xs strong">${mono('MK-261003-07712', go('seller/order'))} · ${money(172.59)}</span><span class="xs sub">Reason: carrier shows no delivery scan</span><span class="xs sub">Review date: Mon, Oct 12</span></div>` })}
        </div>

        <div class="sb-main">
          <div class="stack gap-5">
            ${card({
              title: 'Transactions', sub: 'Latest 11 of 64 this month · balance after = pending + available + held',
              actions: `${seg(['All', 'Sales', 'Fees', 'Refunds', 'Payouts'], 0)}`,
              flush: true,
              body: txTable,
              foot: `<span class="xs muted grow">Ad charges are billed separately from sales commission.</span>${U.pager(1, 6)}`,
            })}
            ${card({
              title: 'Payouts', sub: 'Pending → Processing → Paid, or Failed with the reason',
              flush: true,
              body: payTable,
              foot: `<span class="xs muted grow">Processing means the bank transfer has been sent and is not yet confirmed. A failed payout stays in your balance until it is paid to a verified account.</span>`,
            })}
          </div>

          <div class="stack gap-5">
            ${card({
              title: 'Next payout', sub: 'Weekly, every Monday (example schedule)',
              body: `<div class="row between base"><span class="h2 num">${money(1318.62)}</span>${status('Pending')}</div>
                ${kv([['Date', 'Mon, Oct 12, 2026'], ['Cutoff', 'Sun, Oct 11, 11:59 PM PT'], ['Destination', `${BANK} ${badge('Verified', 'info', 'shield-check')}`], ['Arrives', 'Usually 1 business day after sending']])}
                <span class="xs muted">Estimate. Earnings that become available before the cutoff are added. New holds or refunds reduce it.</span>`,
              foot: btn('Change payout account', { v: 'secondary', size: 'sm', icon: 'landmark' }),
            })}
            ${alert('info', 'Changing the payout account', 'Only the store owner can change it. We verify the new account with a test deposit and Marketly Finance reviews the change (example: up to 2 business days). Payouts continue to the current account until the review is done, and you get an email about every change.')}
            ${card({
              title: 'When your balance goes negative', sub: 'Example from Sep 30',
              body: `<p class="small sub">A refund approved after a payout can't come out of money already sent. It is deducted from your next earnings instead.</p>
                <div class="sb-recon">
                  ${sumRow('Available on Sep 30, 9:00 AM', money(120.00))}
                  ${sumRow(`Refund after payout ${mono('RT-260924-0533')}`, `<span class="sb-neg">${sm(-165.60)}</span>`)}
                  ${sumRow('Balance', `<span class="row gap-2"><b class="sb-neg">${sm(-45.60)}</b>${status('Negative')}</span>`, 'total')}
                </div>
                <p class="xs muted">${money(184)} refunded to the customer, less the ${money(18.40)} fee returned to you. Covered by sales on Oct 1 and shown on statement Sep 28 – Oct 4. If a negative balance isn't covered within 30 days, it becomes an amount you owe (example terms; see the seller agreement).</p>`,
            })}
          </div>
        </div>
      `, 'finance');
    },
  });

  /* ======================================================================
     4. Statement
     ====================================================================== */
  U.register({
    id: 'seller/statement', title: 'Payout statement', ref: 'Plan ch. 14',
    notes: 'Itemized statement connecting sales, fees (with the fee basis), refunds, a refund-after-payout deduction, holds and releases, adjustments with reasons and ad charges to one payout. Section totals reconcile exactly to PO-261005-3381.',
    render: () => {
      const sec = (title, sub, cols, rows, total, o = {}) => card({
        title, sub,
        actions: `<span class="num strong ${total < 0 ? 'sb-neg' : ''}">${sgn(total)}</span>`,
        flush: true,
        body: table(cols, rows.concat(o.noTotal ? [] : [[`<span>${o.totalLabel || 'Section total'}</span>`, ...Array(cols.length - 2).fill(''), amt(total)]]), { rowCls: rows.map(() => '').concat(['sb-total']) }) + (o.after || ''),
      });
      const R = { label: 'Amount', cls: 'r' };

      const sales = sec('Sales', `${ST.sales.reduce((s, x) => s + x[2], 0)} units in 51 orders accepted Sep 28 – Oct 4`,
        ['Product', 'SKU', { label: 'Units', cls: 'r' }, R],
        ST.sales.map((s) => [`<span class="small strong">${s[0]}</span>`, mono(s[1]), `<span class="num">${s[2]}</span>`, amt(s[3])]).concat([
          [`<span class="small">Seller-funded discount: Fall audio markdown</span><br><span class="xs muted">10% off 22 Pocket Speakers. You fund this discount.</span>`, '', '', amt(ST.sellerDiscount)],
          [`<span class="small">Shipping charged to customers</span><br><span class="xs muted">9 orders × ${money(6.99)}</span>`, '', '', amt(ST.shipping)],
        ]), stProceeds, { totalLabel: 'Sales proceeds' });

      const fees = sec('Marketplace fees', 'Commission on item price after your discounts',
        ['Fee', 'Basis', R],
        [[`<span class="small strong">Commission, 10% (example rate)</span>`, `<span class="small num">${money(stFeeBasis)}</span><br><span class="xs muted">${money(stItems)} items − ${money(-ST.sellerDiscount)} seller-funded discount</span>`, amt(stFee)]],
        stFee, { totalLabel: 'Fees total', after: `<div class="panel" style="margin:var(--sp-3) var(--sp-4) var(--sp-4)"><span class="xs sub"><b>How the fee basis works:</b> commission applies to the item price after seller-funded discounts. Shipping is not charged commission. Platform-funded discounts don't lower your proceeds or your fee basis. Fees are refunded in proportion when an item is refunded. Final rates are in your seller agreement.</span></div>` });

      const refunds = sec('Refunds', 'Refunds sent this period and the fee returned to you',
        ['Date', 'Return', 'Details', R],
        ST.refunds.flatMap((r) => [
          [`<span class="small nowrap">${r[0]}</span>`, mono(r[1], go('seller/return')), `<span class="small">${r[2]}</span>`, amt(r[3])],
          ['', '', `<span class="xs sub">Fee refunded, 10% of ${money(-r[3])}</span>`, amt(r2(-r[3] * FEE))],
        ]).concat([
          [`<span class="small nowrap">${ST.afterPayout[0]}</span>`, mono(ST.afterPayout[1], go('seller/return')), `<span class="small"><b>Refund after payout.</b> ${ST.afterPayout[2]}</span>`, amt(stAfter)],
          ['', '', `<span class="xs sub">Fee refunded, 10% of ${money(-stAfter)}. Net ${sm(stAfter + stAfterFee)} deducted from this payout.</span>`, amt(stAfterFee)],
        ]),
        r2(stRefunds + stRefundFees + stAfter + stAfterFee), { totalLabel: 'Refunds total' });

      const holds = sec('Holds and releases', 'Earnings withheld with a reason and review date, and earlier holds released',
        ['Date', 'Order', 'Reason', R],
        ST.holds.map((h) => [`<span class="small nowrap">${h[0]}</span>`, mono(h[1], go('seller/order')), `<span class="small">${h[2]}</span>`, amt(h[3])]),
        stHolds, { totalLabel: 'Holds net' });

      const adj = sec('Adjustments', 'Every adjustment has a recorded reason and owner',
        ['Date', 'Reference', 'Adjustment and reason', R],
        ST.adjustments.map((a) => [`<span class="small nowrap">${a[0]}</span>`, mono(a[1]), `<span class="small">${a[2]}</span><br><span class="xs muted">${a[3]}</span>`, amt(a[4])]),
        stAdj, { totalLabel: 'Adjustments net' });

      const ads = sec('Advertising charges', 'Billed separately from sales commission',
        ['Period', 'Campaign', 'Details', R],
        ST.ads.map((a) => [`<span class="small nowrap">${a[0]}</span>`, mono(a[1], go('seller/marketing', 'Sponsored ads')), `<span class="small">${a[2]}</span>`, amt(a[3])]),
        stAds, { totalLabel: 'Ad charges total' });

      const recon = `<div class="sb-recon">
          ${sumRow('Opening available balance, Sep 28', money(0))}
          ${sumRow('Sales proceeds', sgn(stProceeds))}
          ${sumRow('Marketplace fees', sgn(stFee))}
          ${sumRow('Refunds, incl. after payout', sgn(r2(stRefunds + stRefundFees + stAfter + stAfterFee)))}
          ${sumRow('Holds and releases', sgn(stHolds))}
          ${sumRow('Adjustments', sgn(stAdj))}
          ${sumRow('Advertising charges', sgn(stAds))}
          ${sumRow('Payout PO-261005-3381', money(PAYOUT), 'total')}
          ${sumRow('Closing available balance, Oct 4', money(0))}
        </div>`;

      return U.sellerLayout(`
        ${pageHead('Statement: Sep 28 – Oct 4, 2026', {
          crumbs: [{ label: 'Finance', href: go('seller/finance') }, { label: 'Statements' }, { label: 'Sep 28 – Oct 4' }],
          sub: `Northwind Audio · seller ID NWA-20714 · payout ${mono('PO-261005-3381')} · issued Oct 5, 2026`,
          actions: btn('Download PDF', { v: 'secondary', icon: 'file-down', size: 'sm' }) + btn('Download CSV', { v: 'secondary', icon: 'sheet', size: 'sm' }),
        })}
        <div class="sb-main">
          <div class="stack gap-5">${sales}${fees}${refunds}${holds}${adj}${ads}</div>
          <div class="stack gap-5">
            ${card({
              title: 'Reconciliation', sub: 'Every line on this page adds up to the payout',
              body: recon,
            })}
            ${card({
              title: 'Payout', sub: mono('PO-261005-3381'),
              body: `<div class="row between base"><span class="h2 num">${money(PAYOUT)}</span>${status('Paid')}</div>
                ${kv([['Sent', 'Mon, Oct 5, 6:00 AM PT'], ['Arrived', 'Tue, Oct 6'], ['Destination', BANK], ['Bank reference', mono('PCCU-77810452')]])}`,
            })}
            ${alert('warning', 'Includes a refund after payout', `${mono('RT-260924-0533')} was refunded after its earnings were paid out on Sep 21. The net ${money(165.60)} was deducted here, not charged to your bank account.`)}
            <p class="xs muted">Example fee rate and schedule. Final fees and settlement terms are in the seller agreement. Questions about a line? ${btn('Contact seller support', { v: 'link' })}</p>
          </div>
        </div>
      `, 'finance');
    },
  });

  /* ======================================================================
     5. Marketing and ads
     ====================================================================== */
  const MK_TABS = ['Discounts', 'Platform campaigns', 'Sponsored ads'];
  U.register({
    id: 'seller/marketing', title: 'Marketing and ads', ref: 'Plan ch. 15–16',
    notes: 'Seller-funded discounts, a platform campaign invitation with eligibility, funding split, earnings impact and explicit consent, and sponsored ad requests with status and spend against limits.',
    states: MK_TABS,
    render: (state) => {
      const ti = Math.max(0, MK_TABS.indexOf(state || MK_TABS[0]));
      const tabBar = tabs(MK_TABS.map((t, i) => ({ label: t, href: go('seller/marketing', t), count: [4, 1, 4][i] })), ti);
      let body = '';

      if (ti === 0) {
        const rows = [
          ['Fall audio markdown', 'Halden Pocket Bluetooth Speaker (2 colors)', '10% off', 'Oct 1 – Oct 31', 'Live', '63 orders'],
          ['Cable kit with headphones', 'Studio Cable Kit, with any Halden headphones', `${money(5)} off`, 'Oct 12 – Oct 25', 'Scheduled', '—'],
          ['Weekend microphone deal', 'Ardent USB Desk Microphone', `Free shipping over ${money(75)}`, 'Not set', 'Draft', '—'],
          ['Back to campus', 'Halden Aurora ANC Wireless Headphones', '15% off', 'Aug 24 – Sep 14', 'Finished', '41 orders'],
        ];
        body = `<div class="sb-main">
          ${card({
            title: 'Your discounts', sub: 'Discounts you create are funded by you and lower the fee basis',
            actions: btn('Create discount', { icon: 'plus', size: 'sm' }),
            flush: true,
            body: table(['Discount', 'Offers', 'Type', 'Period (PT)', 'Funding', 'Status', { label: 'Used', cls: 'r' }], rows.map((r) => [
              `<span class="small strong">${r[0]}</span>`, `<span class="small" style="display:inline-block;min-width:200px">${r[1]}</span>`, `<span class="small t-deal-text strong nowrap">${r[2]}</span>`, `<span class="small nowrap">${r[3]}</span>`, badge('Seller-funded', 'outline'), status(r[4]), `<span class="small num">${r[5]}</span>`,
            ])),
          })}
          ${card({
            title: 'Create a discount', sub: 'Preview before it goes live',
            body: `${field('Discount name', input('mk-name', 'Holiday speaker deal'), { hint: 'Only you see this name.' })}
              ${field('Type', select('mk-type', ['Percentage off', 'Fixed amount off', 'Minimum spend', 'Free shipping'], 'Percentage off'))}
              <div class="sb-form-grid">${field('Amount', input('mk-amt', '10', { suffix: '%' }))}${field('Limit per customer', input('mk-limit', '2', { suffix: 'units' }))}</div>
              ${field('Offers', select('mk-offers', ['Halden Pocket Bluetooth Speaker, Teal and Sand', 'Halden Aurora ANC Wireless Headphones', 'Studio Cable Kit'], 'Halden Pocket Bluetooth Speaker, Teal and Sand'))}
              <div class="sb-form-grid">${field('Starts', input('mk-start', 'Nov 20, 2026, 12:00 AM', { icon: 'calendar' }))}${field('Ends', input('mk-end', 'Nov 30, 2026, 11:59 PM', { icon: 'calendar' }))}</div>
              ${check('mk-stack', 'Can combine with Marketly coupons (platform-funded part never comes from you)', true)}
              <div class="panel stack gap-1"><span class="xs muted">Customer sees</span>${U.price(53.10, 59.00)}<span class="xs sub">Your earnings per unit: ${money(47.79)} (was ${money(53.10)}) after the 10% fee on the discounted price. Example rate.</span></div>`,
            foot: `${btn('Save draft', { v: 'ghost' })}${btn('Schedule discount')}`,
          })}
        </div>`;
      } else if (ti === 1) {
        const offerRows = [
          ['speaker', 'Halden Pocket Bluetooth Speaker', 'HAL-PKT-TEAL', 88, true, ''],
          ['headphones', 'Halden Aurora ANC Wireless Headphones', 'HAL-AUR-BLK', 24, true, ''],
          ['cable', 'Studio Cable Kit', 'NWA-CBL-KIT', 12, false, 'Needs at least 20 units in stock (you have 12)'],
        ];
        body = `<div class="sb-main">
          <div class="stack gap-5">
            ${card({
              title: `Invitation: Home Week ${badge('Join by Sat, Oct 10', 'warning', 'clock')}`,
              sub: 'Platform campaign · Mon, Oct 12, 12:00 AM – Mon, Oct 19, 11:59 PM PT · run by Marketly Marketing',
              body: `<div class="imgph wide" style="--tint:var(--img-3);aspect-ratio:5/1">${icon('house')}</div>
                <p class="small sub">Marketly features Home Week on the home page, the Deals page and an opening ad. Joined offers show the campaign price and a Home Week label.</p>
                <div class="grid md2" style="--gap:var(--sp-4)">
                  <div class="stack gap-2"><span class="small strong">Eligibility</span>${ticks(['Offer rating 4.0 or higher', 'Dispatch within 2 business days', 'At least 20 units in stock', 'No price increase in the last 30 days'])}</div>
                  <div class="stack gap-2"><span class="small strong">Who funds what</span>
                    ${kv([['Campaign discount', '15% off'], ['You fund', '10% of the price'], ['Marketly funds', '5% of the price'], ['Fee basis', 'Price after your 10%; Marketly’s 5% does not reduce your proceeds']])}
                  </div>
                </div>`,
            })}
            ${card({
              title: 'Choose offers', sub: 'Only eligible offers can join',
              flush: true,
              body: table(['', 'Offer', 'Stock', 'Eligibility'], offerRows.map((o, i) => [
                `<input type="checkbox" id="mk-hw-${i}" aria-label="Include ${o[1]}"${o[4] ? ' checked' : ' disabled'}>`,
                `<label for="mk-hw-${i}" class="row gap-3 nowrap" style="min-width:240px">${img(o[0], 'var(--img-2)', 'tiny')}<span class="stack gap-0"><span class="small strong">${o[1]}</span><span class="xs muted mono">${o[2]}</span></span></label>`,
                `<span class="num small">${o[3]}</span>`,
                o[4] ? status('Eligible', 'success') : `<span class="stack gap-1">${status('Not eligible', 'danger')}<span class="xs muted">${o[5]}</span></span>`,
              ])),
            })}
          </div>
          <div class="stack gap-5">
            ${card({
              title: 'Expected impact per unit', sub: 'Halden Pocket Bluetooth Speaker',
              body: `<div class="sb-recon">
                  ${sumRow('Regular price', money(59.00))}
                  ${sumRow('Campaign price for customers', `<span class="t-deal-text strong">${money(50.15)}</span>`)}
                  ${sumRow('You fund (10%)', `<span class="sb-neg">${sm(-5.90)}</span>`)}
                  ${sumRow('Marketly funds (5%)', money(2.95))}
                  ${sumRow('Fee, 10% of ' + money(53.10), `<span class="sb-neg">${sm(-5.31)}</span>`)}
                  ${sumRow('Your earnings per unit', `<b>${money(47.79)}</b>`, 'total')}
                  ${sumRow('Regular earnings per unit', money(53.10))}
                </div>
                <span class="xs muted">Example only. Similar Home Week offers sold 2–3 times their usual weekly units last year, which is not a promise of sales.</span>`,
            })}
            ${card({
              title: 'Join Home Week',
              body: `${check('mk-consent', 'I agree to fund 10% of the price on the 2 selected offers from Oct 12 to Oct 19, 2026, and not to raise their prices during the campaign. Marketly funds the other 5%.', false)}
                <span class="xs muted">You can leave before Oct 12. After it starts, leaving needs approval from Marketly Marketing.</span>`,
              foot: `${btn('Decline', { v: 'ghost' })}${btn('Join campaign', { disabled: true })}`,
            })}
            ${card({
              title: 'Past campaigns', flush: true,
              body: `<ul class="list pad"><li><span class="grow stack gap-0"><span class="small strong">Back to Campus Week</span><span class="xs muted">Aug 24 – Aug 31 · 2 offers · you funded 5%</span></span>${status('Finished')}</li></ul>`,
            })}
          </div>
        </div>`;
      } else {
        const ads = [
          ['Pocket Speaker search boost', 'Sponsored product', 'Halden Pocket Bluetooth Speaker', 'Sep 15 – Oct 31', 'Live', 82.60, 300, 'Per click, $0.35'],
          ['Northwind store feature', 'Sponsored store', 'Store page', 'Oct 15 – Nov 15', 'In review', 0, 500, 'Fixed, $45 per day'],
          ['Aurora headphones in Headphones', 'Sponsored product', 'Halden Aurora ANC Wireless Headphones', 'Sep 20 – Oct 20', 'Paused', 140.20, 200, 'Per click, $0.40'],
          ['Summer cable kit', 'Sponsored product', 'Studio Cable Kit', 'Jul 1 – Aug 31', 'Finished', 96.50, 100, 'Per click, $0.25'],
        ];
        body = `${alert('info', 'Paid ads are labeled Sponsored for customers', 'Marketly reviews every request before it runs. Ad charges appear on your statement separately from sales commission. Paid campaigns bring attention to an offer and never guarantee purchases.')}
          ${card({
            title: 'Sponsored ads', sub: 'Spend this campaign against your total limit',
            actions: btn('Request a sponsored campaign', { icon: 'plus', size: 'sm', href: go('seller/ad-request') }),
            flush: true,
            body: table(['Campaign', 'Type', 'Promotes', 'Schedule', 'Billing (example)', 'Status', 'Spend vs limit', ''], ads.map((a) => [
              `<a class="small strong" href="${go('seller/ad-request', a[4] === 'In review' ? 'In review' : 'Set up')}">${a[0]}</a>`,
              `<span class="small nowrap">${a[1]}</span>`,
              `<span class="small" style="display:inline-block;min-width:180px">${a[2]}</span>`,
              `<span class="small nowrap">${a[3]}</span>`,
              `<span class="xs sub nowrap">${a[7]}</span>`,
              status(a[4]) + (a[4] === 'Paused' ? `<br><span class="xs muted">Paused by you Oct 3</span>` : ''),
              `<div class="stack gap-1" style="min-width:140px"><span class="xs num">${money(a[5])} of ${money(a[6])}</span>${meter(Math.round((a[5] / a[6]) * 100), a[5] / a[6] > 0.9 ? 'warning' : '')}</div>`,
              a[4] === 'Live' ? btn('Pause', { v: 'ghost', size: 'sm' }) : a[4] === 'Paused' ? btn('Resume', { v: 'ghost', size: 'sm' }) : '',
            ])),
          })}
          <div class="grid md3" style="--gap:var(--sp-4)">
            <div class="card pad">${stat('Ad spend, Oct 1–8', money(96.10), { note: 'Shown on statements as ad charges' })}</div>
            <div class="card pad">${stat('Clicks', '262', { note: 'Pocket Speaker and Aurora' })}</div>
            <div class="card pad">${stat('Attributed orders', '19', { note: 'Ordered within 7 days of a click' })}</div>
          </div>`;
      }

      return U.sellerLayout(`
        ${pageHead('Marketing and ads', { sub: 'Discounts you fund, Marketly campaigns you can join and sponsored ads you can request.' })}
        <div style="margin-bottom:calc(-1 * var(--sp-2))">${tabBar}</div>
        ${body}
      `, 'marketing');
    },
  });

  /* ======================================================================
     6. Sponsored campaign request
     ====================================================================== */
  const adPreview = (phone) => `<div class="sb-device ${phone ? 'phone' : ''}">
      <span class="xs muted row gap-1">${icon(phone ? 'smartphone' : 'monitor', 'ic-sm')}${phone ? 'Mobile · search results' : 'Desktop · search results for “bluetooth speaker”'}</span>
      <div class="${phone ? 'stack gap-2' : 'grid c2'}" style="--gap:var(--sp-2)">
        <div class="sb-adcard ${phone ? '' : 'col'}">
          ${img('speaker', 'var(--img-2)', phone ? '' : 'r43')}
          <div class="stack gap-1" style="min-width:0">
            ${U.sponsored()}
            <span class="small strong clamp-2">Halden Pocket Bluetooth Speaker</span>
            <span class="xs sub">12-hour battery, splash resistant</span>
            ${U.price(53.10, 59.00, { noOff: true })}
            <span class="seller-line">Sold by <b>Northwind Audio</b></span>
          </div>
        </div>
        ${phone ? '' : `<div class="sb-ghostcard" aria-hidden="true" style="flex-direction:column"><div class="imgph r43" style="--tint:var(--surface-3)"></div><i style="width:80%"></i><i style="width:50%"></i></div>`}
      </div>
    </div>`;

  U.register({
    id: 'seller/ad-request', title: 'Request a sponsored campaign', ref: 'Plan ch. 16',
    notes: 'Seller ad request: ad type, products, placements and pages, schedule, daily and total spending limits, desktop and mobile creatives with Sponsored-labelled previews and the billing model. States that ad charges are separate from commission and never guarantee purchases; submission moves through Draft, In review, Approved, Scheduled, Live.',
    states: ['Set up', 'In review'],
    render: (state) => {
      const review = state === 'In review';
      const flow = steps(['Draft', 'In review', 'Approved', 'Scheduled', 'Live'], review ? 1 : 0);
      const head = pageHead(review ? 'Pocket Speaker holiday push' : 'Request a sponsored campaign', {
        crumbs: [{ label: 'Marketing and ads', href: go('seller/marketing', 'Sponsored ads') }, { label: review ? 'Pocket Speaker holiday push' : 'New request' }],
        sub: review ? `Request ${mono('AD-261008-0091')} · submitted Thu, Oct 8, 11:05 AM PT by Avery Stone` : 'Marketly reviews every request. Nothing runs or is charged until it is approved and scheduled.',
        actions: review ? status('In review') : status('Draft'),
      });
      const terms = `<div class="stack gap-2">
          ${alert('info', 'How you are charged', 'Ad charges appear on your statement as a separate line, not as part of the sales commission. Unused budget is not charged. If Marketly pauses or cancels the campaign, you are charged only for delivery so far.')}
          <p class="xs muted">Paid campaigns bring attention to your offer. They never guarantee clicks or purchases.</p>
        </div>`;

      if (review) {
        return U.sellerLayout(`${head}${card({ body: flow })}
          <div class="sb-main">
            <div class="stack gap-5">
              ${alert('info', 'Waiting for Marketly Advertising review', 'Usually within 2 business days (example). We check the offer is available, claims and links, and the Sponsored label. Editing the request now sends it back to the start of review.')}
              ${card({
                title: 'Request summary',
                body: kv([
                  ['Ad type', 'Sponsored product'],
                  ['Promotes', 'Halden Pocket Bluetooth Speaker, Teal and Sand'],
                  ['Placements', 'Search results · Speakers category · related products on speaker pages'],
                  ['Schedule', 'Nov 16, 12:00 AM – Dec 20, 11:59 PM PT'],
                  ['Spending limit', `${money(20)} per day · ${money(500)} total`],
                  ['Billing', `Per click, ${money(0.35)} (example rate)`],
                  ['Creatives', 'Desktop 1200 × 900 · Mobile 800 × 800'],
                ]),
                foot: `${btn('Withdraw request', { v: 'danger-soft' })}${btn('Edit and resubmit', { v: 'secondary', icon: 'pencil' })}`,
              })}
              ${card({
                title: 'Review checks', sub: 'Updated by the reviewer',
                body: `<ul class="list">
                  <li>${icon('circle-check', 'ic-sm t-success-text')}<span class="grow small">Offer active and in stock (88 units)</span>${status('Approved')}</li>
                  <li>${icon('circle-check', 'ic-sm t-success-text')}<span class="grow small">Destination link goes to the product page</span>${status('Approved')}</li>
                  <li>${icon('clock', 'ic-sm')}<span class="grow small">Creative text and claims (“12-hour battery”)</span>${status('In review')}</li>
                  <li>${icon('clock', 'ic-sm')}<span class="grow small">Sponsored label and seller name visible on both sizes</span>${status('In review')}</li>
                </ul>`,
              })}
              ${card({ title: 'Previews you submitted', body: `<div class="grid md2" style="--gap:var(--sp-4)">${adPreview(false)}${adPreview(true)}</div>` })}
            </div>
            <div class="stack gap-5">
              ${card({ title: 'Activity', body: timeline([
                { t: 'In review', d: 'Assigned to Jamie Brooks, Advertising', state: 'current' },
                { t: 'Submitted for approval', d: 'Oct 8, 11:05 AM · Avery Stone', state: 'done' },
                { t: 'Draft created', d: 'Oct 7, 4:40 PM · Avery Stone', state: 'done' },
              ]) })}
              ${card({ title: 'What happens next', body: `<ol class="ol small stack gap-1"><li>Approved: you get an email and the campaign is scheduled.</li><li>Scheduled: it starts Nov 16 at 12:00 AM PT.</li><li>Live: charges start with the first click.</li></ol><span class="xs muted">If it is not approved, we tell you which check failed and how to fix it.</span>` })}
              ${terms}
            </div>
          </div>`, 'marketing');
      }

      const products = [
        ['speaker', 'Halden Pocket Bluetooth Speaker', 'HAL-PKT-TEAL / SND', 'In stock · 88', true],
        ['headphones', 'Halden Aurora ANC Wireless Headphones', 'HAL-AUR-BLK', 'In stock · 24', false],
        ['cable', 'Studio Cable Kit', 'NWA-CBL-KIT', 'Low stock · 12', false],
      ];
      return U.sellerLayout(`${head}${card({ body: flow })}
        <div class="sb-main">
          <div class="stack gap-5">
            ${card({
              title: '1. Ad type',
              body: `<div class="grid md2" style="--gap:var(--sp-3)">
                ${optCard('ad-type', 'ad-type-prod', '<span class="strong">Sponsored product</span>', 'A labeled product card in search, category and related-product results.', true)}
                ${optCard('ad-type', 'ad-type-store', '<span class="strong">Sponsored store</span>', 'A labeled feature linking to your store on home and discovery pages.', false)}
              </div>`,
            })}
            ${card({
              title: '2. Products', sub: 'Only active offers with stock can be promoted',
              flush: true,
              body: table(['', 'Product', 'Stock'], products.map((p, i) => [
                `<input type="checkbox" id="ad-p-${i}" aria-label="Promote ${p[1]}"${p[4] ? ' checked' : ''}>`,
                `<label for="ad-p-${i}" class="row gap-3 nowrap" style="min-width:240px">${img(p[0], 'var(--img-2)', 'tiny')}<span class="stack gap-0"><span class="small strong">${p[1]}</span><span class="xs muted mono">${p[2]}</span></span></label>`,
                `<span class="small">${p[3]}</span>`,
              ])),
            })}
            ${card({
              title: '3. Placement and pages',
              body: `<div class="grid md2" style="--gap:var(--sp-2)">
                ${check('ad-pl-search', 'Search results for related terms', true)}
                ${check('ad-pl-cat', 'Category pages: Speakers', true)}
                ${check('ad-pl-cat2', 'Category pages: Headphones', false)}
                ${check('ad-pl-rel', 'Related products on product pages', true)}
              </div>
              <span class="xs muted">Ads never appear in checkout, payment results, order tracking or return pages. Audience: all shoppers in the US service region.</span>`,
            })}
            ${card({
              title: '4. Schedule and spending limit',
              body: `<div class="sb-form-grid">
                ${field('Start', input('ad-start', 'Nov 16, 2026, 12:00 AM', { icon: 'calendar' }))}
                ${field('End', input('ad-end', 'Dec 20, 2026, 11:59 PM', { icon: 'calendar' }), { hint: 'Times in Pacific Time' })}
                ${field('Daily spending limit', input('ad-daily', '20.00', { prefix: '$' }), { hint: 'Ads stop for the day when reached.' })}
                ${field('Total spending limit', input('ad-total', '500.00', { prefix: '$' }), { hint: 'The campaign stops when reached.' })}
              </div>
              <div class="stack gap-2"><span class="label">Billing model</span>
                <div class="grid md2" style="--gap:var(--sp-3)">
                  ${optCard('ad-bill', 'ad-bill-cpc', `<span class="row between"><span class="strong small">Per click</span><span class="num small">${money(0.35)}</span></span>`, 'You pay when a shopper clicks the ad.', true)}
                  ${optCard('ad-bill', 'ad-bill-fixed', `<span class="row between"><span class="strong small">Fixed placement fee</span><span class="num small">${money(45)}/day</span></span>`, 'Flat daily fee for a reserved slot.', false)}
                </div>
                <span class="xs muted">Example rates. Final pricing is in the advertising terms.</span>
              </div>`,
            })}
            ${card({
              title: '5. Creative', sub: 'Upload both sizes. Previews show the Sponsored label customers see.',
              body: `<div class="grid md2" style="--gap:var(--sp-4)">
                  <div class="stack gap-2"><span class="label">Desktop image</span>${dropzone('Upload desktop image', '1200 × 900 px, JPG or PNG, up to 5 MB')}</div>
                  <div class="stack gap-2"><span class="label">Mobile image</span>${dropzone('Upload mobile image', '800 × 800 px, JPG or PNG, up to 5 MB')}</div>
                </div>
                ${field('Short headline', input('ad-headline', '12-hour battery, splash resistant'), { hint: '40 characters max. Claims must match the product page.' })}
                <div class="grid md2" style="--gap:var(--sp-4)">${adPreview(false)}${adPreview(true)}</div>`,
            })}
          </div>
          <div class="stack gap-5">
            ${card({
              title: 'Summary',
              body: `${kv([['Type', 'Sponsored product'], ['Products', '1 selected'], ['Pages', 'Search, Speakers, related'], ['Runs', 'Nov 16 – Dec 20 (35 days)'], ['Most you can spend', money(500)], ['Billing', `Per click, ${money(0.35)}`]])}`,
              foot: `${btn('Save draft', { v: 'ghost' })}${btn('Submit for approval', { iconR: 'arrow-right', href: go('seller/ad-request', 'In review') })}`,
            })}
            ${terms}
          </div>
        </div>`, 'marketing');
    },
  });

  /* ======================================================================
     7. Customers: order messages, product questions, seller feedback
     ====================================================================== */
  const CU_TABS = ['Order messages', 'Product questions', 'Feedback'];
  U.register({
    id: 'seller/customers', title: 'Customers', ref: 'Plan ch. 11, 17',
    notes: 'Private order messages with a 24-hour reply target and overdue conversations highlighted, public product questions answered as the seller, and seller feedback with public responses under stated rules. Seller feedback is kept separate from product reviews.',
    states: CU_TABS,
    render: (state) => {
      const ti = Math.max(0, CU_TABS.indexOf(state || CU_TABS[0]));
      const tabBar = tabs(CU_TABS.map((t, i) => ({ label: t, href: go('seller/customers', t), count: [3, 2, 1][i] })), ti);
      let body = '';

      if (ti === 0) {
        const convs = [
          { n: 'Alex M.', ref: 'MK-261007-10433', last: 'Has my speaker shipped yet? I need it by Saturday.', when: 'Oct 7, 7:40 PM', due: 'Overdue 2 h', tone: 'danger', unread: true, active: true },
          { n: 'Priya K.', ref: 'MK-261008-11902', last: 'Can you ship to my work address instead?', when: 'Oct 8, 8:15 AM', due: 'Reply by Oct 9, 8:15 AM', tone: 'warning', unread: true },
          { n: 'Sam R.', ref: 'MK-261008-12077', last: 'Is the teal one the same as in the photos?', when: 'Oct 8, 9:20 AM', due: 'Reply by Oct 9, 9:20 AM', tone: 'ok', unread: true },
          { n: 'Chris T.', ref: 'MK-261007-09811', last: 'You: Shipped this morning, tracking is on your order.', when: 'Oct 8, 8:05 AM', due: 'Replied in 1 h', tone: 'ok' },
          { n: 'Dana W.', ref: 'MK-260926-31840', last: 'You: I approved the return and sent a label.', when: 'Oct 5, 6:15 PM', due: 'Replied in 2 h', tone: 'ok' },
        ];
        const list = `<div class="sb-inbox-list">
          <div style="padding:var(--sp-3) var(--sp-4);border-bottom:1px solid var(--border)">${searchIn('Search buyer or order', 'cu-q')}</div>
          ${convs.map((c) => `<a class="sb-conv${c.active ? ' is-active' : ''}${c.tone === 'danger' ? ' is-overdue' : ''}" href="javascript:void 0">
            <span class="row between nowrap"><span class="row gap-2 nowrap">${avatar(c.n)}<span class="stack gap-0"><span class="small ${c.unread ? 'bold' : 'strong'}">${c.n}</span><span class="xs muted mono">${c.ref}</span></span></span><span class="xs muted nowrap">${c.when}</span></span>
            <span class="xs sub truncate">${c.last}</span>
            <span>${c.tone === 'ok' ? `<span class="xs muted">${c.due}</span>` : deadline(c.due, c.tone)}</span>
          </a>`).join('')}
        </div>`;
        const pane = `<div class="sb-conv-pane no-phone">
          <div class="hd">${avatar('Alex M')}<div class="stack gap-0 grow"><span class="strong">Alex M.</span><span class="xs sub">Order ${mono('MK-261007-10433', go('seller/order'))} · Halden Pocket Speaker × 1 · ${status('Preparing')}</span></div>${deadline('Overdue 2 h', 'danger')}</div>
          <div class="bd sb-thread">
            ${sysNote('Private conversation linked to this order. Only you, the buyer and Marketly support can see it.', 'lock')}
            ${msg('Alex M.', 'Oct 7, 7:40 PM', 'Hi, has my speaker shipped yet? I need it by Saturday for a trip.')}
            ${sysNote('Dispatch deadline for this order was Oct 8, 12:00 PM. It is now overdue.', 'triangle-alert')}
          </div>
          <div class="ft">
            ${alert('danger', 'Reply target missed', 'You aim to reply within 24 hours, and this buyer also has an overdue dispatch. Reply with a real ship date.')}
            ${field('Reply to Alex M.', textarea('cu-reply', 'Sorry for the delay. Your speaker ships today by 5 PM with USPS Priority and should arrive Friday, Oct 9. I’ll add tracking to your order as soon as it is scanned.'))}
            <div class="row between"><div class="row gap-2">${btn('Attach', { v: 'ghost', size: 'sm', icon: 'paperclip' })}${btn('Templates', { v: 'ghost', size: 'sm', icon: 'file-text' })}</div>${btn('Send reply', { icon: 'send' })}</div>
            <span class="xs muted">Keep service messages about the order. Promotional messages are not allowed here.</span>
          </div>
        </div>`;
        body = `<div class="row gap-3">${badge('Reply within 24 hours', 'brand', 'clock')}<span class="xs sub">Your average this month: 9 h 30 min · 1 conversation overdue</span></div>
          ${card({ flush: true, body: `<div class="sb-inbox">${list}${pane}</div>` })}`;
      } else if (ti === 1) {
        const qs = [
          { p: 'Halden Pocket Bluetooth Speaker', ic: 'speaker', q: 'Can two of these pair together for stereo?', who: 'Asked by a shopper · Oct 7', a: null },
          { p: 'Halden Aurora ANC Wireless Headphones', ic: 'headphones', q: 'Does the case fit in a laptop bag sleeve?', who: 'Asked by Marcus J. · Oct 6', a: null },
          { p: 'Studio Cable Kit', ic: 'cable', q: 'Is the 3.5 mm to 6.35 mm adapter gold plated?', who: 'Asked by a shopper · Sep 30', a: 'Yes. Both ends of the adapter are gold plated, and the kit includes a 2 m braided cable.', ans: 'Northwind Audio · Oct 1', helpful: 14 },
        ];
        body = `<div class="sb-main">
          <div class="stack gap-4">
            ${qs.map((q, i) => card({
              body: `<div class="row top gap-3">${img(q.ic, 'var(--img-2)', 'tiny')}<div class="stack gap-1 grow"><span class="xs muted">${q.p}</span><span class="strong">${q.q}</span><span class="xs muted">${q.who}</span></div>${q.a ? status('Published') : status('Open')}</div>
                ${q.a
                  ? `<div class="panel stack gap-1"><span class="row gap-2">${badge('Answer from the seller', 'info', 'store')}<span class="xs muted">${q.ans} · ${q.helpful} found this helpful</span></span><span class="small">${q.a}</span></div>`
                  : `${field('Your public answer', textarea('cu-ans-' + i, i === 0 ? 'Yes. Press the link button on both speakers within 10 seconds to pair them as a stereo set (left and right).' : '', 'Answer the question for every shopper'), { hint: 'Shown on the product page as “Answer from the seller · Northwind Audio”.' })}
                    <div class="row end gap-2">${btn('Skip', { v: 'ghost', size: 'sm' })}${btn('Publish answer', { size: 'sm' })}</div>`}`,
            })).join('')}
          </div>
          ${card({
            title: 'Answering questions',
            body: `<ul class="ul small sub stack gap-1"><li>Answers are public and labeled as from Northwind Audio.</li><li>Stick to facts in the product listing. Marketly staff and customers can answer too, each with their own label.</li><li>No personal contact details, outside links or discount codes.</li><li>Order-specific questions belong in order messages.</li></ul>`,
          })}
        </div>`;
      } else {
        const fb = [
          { n: 'Alex M.', r: 2, t: 'Item is fine but it shipped a day late and nobody answered my message.', when: 'Oct 8', ref: 'MK-260921-30418', resp: null },
          { n: 'Priya K.', r: 5, t: 'Fast shipping, well packed, seller answered within the hour.', when: 'Oct 4', ref: 'MK-260929-11406', resp: 'Thank you, Priya. Enjoy the headphones.' },
          { n: 'Morgan F.', r: 4, t: 'Good communication. Box was a bit crushed but the speaker was fine.', when: 'Sep 30', ref: 'MK-260925-28877', resp: null },
        ];
        body = `<div class="sb-main">
          <div class="stack gap-4">
            ${card({
              body: `<div class="row gap-6">
                  <div class="stack gap-0"><span class="h1 num">98%</span><span class="xs muted">positive · 4,812 ratings · last 12 months</span></div>
                  <div class="stack gap-1 grow" style="min-width:200px">
                    ${[['Positive (4–5)', 98, 'success'], ['Neutral (3)', 1, ''], ['Negative (1–2)', 1, 'danger']].map(([l, p, t]) => `<div class="row gap-3 nowrap"><span class="xs" style="width:110px">${l}</span><div class="grow">${meter(p, t)}</div><span class="xs num">${p}%</span></div>`).join('')}
                  </div>
                </div>
                <span class="xs muted">Seller feedback rates buying from you: dispatch, packing and communication. Product reviews describe the item and are shown separately on product pages.</span>`,
            })}
            ${fb.map((f, i) => card({
              body: `<div class="row top gap-3">${avatar(f.n)}<div class="stack gap-1 grow"><span class="row gap-2">${U.stars5(f.r, 14)}<span class="small strong">${f.n}</span><span class="xs muted">${f.when} · ${mono(f.ref)}</span></span><span class="small">${f.t}</span></div></div>
                ${f.resp
                  ? `<div class="panel stack gap-1"><span>${badge('Response from the seller', 'info', 'store')}</span><span class="small">${f.resp}</span></div>`
                  : `${field('Public response', textarea('cu-fb-' + i, i === 0 ? 'Sorry, Alex. Your order shipped a day late and we missed your message. We have added a second person to answer messages so this doesn’t happen again.' : '', 'Write a public response'), { opt: true, hint: 'Shown under the feedback as “Response from the seller”. You can edit it for 7 days.' })}
                    <div class="row end gap-2">${btn('Report feedback', { v: 'ghost', size: 'sm', icon: 'flag' })}${btn('Post response', { size: 'sm' })}</div>`}`,
            })).join('')}
          </div>
          ${card({
            title: 'Rules for public responses',
            body: `<span class="small strong">Responses may</span>${ticks(['Thank the customer or apologize', 'Explain what happened and what you changed', 'Invite the customer to continue in order messages'])}
              <span class="small strong">Responses may not</span>${ticks(['Include the customer’s name beyond what they show, address or order details', 'Offer refunds or gifts in exchange for changing feedback', 'Contain outside links, contact details or insults'], false)}
              <p class="xs muted">Marketly does not remove legitimate negative feedback because it is unfavorable. Report feedback only if it breaks the feedback rules, for example if it is about the product instead of your service.</p>`,
          })}
        </div>`;
      }

      return U.sellerLayout(`
        ${pageHead('Customers', { sub: 'Order messages are private to each order. Questions and feedback responses are public.' })}
        <div style="margin-bottom:calc(-1 * var(--sp-2))">${tabBar}</div>
        ${body}
      `, 'customers');
    },
  });

  /* ======================================================================
     8. Reports
     ====================================================================== */
  U.register({
    id: 'seller/reports', title: 'Seller reports', ref: 'Plan ch. 11, 19',
    notes: 'Product sales, a single-series order trend, returns by reason and service performance against targets for a chosen date range, with export. Each metric states how it is calculated.',
    render: () => {
      const labels = [];
      for (let d = 9; d <= 30; d++) labels.push('Sep ' + d);
      for (let d = 1; d <= 8; d++) labels.push('Oct ' + d);
      const orders = [9, 11, 8, 14, 15, 10, 9, 12, 11, 13, 16, 18, 12, 10, 11, 13, 12, 15, 17, 11, 10, 12, 14, 13, 12, 16, 19, 13, 12, 14];
      const totalOrders = orders.reduce((a, b) => a + b, 0);
      const prod = [
        ['speaker', 'Halden Pocket Bluetooth Speaker', 'HAL-PKT-TEAL / SND', 214, 11872.40, 9, 'Live discount'],
        ['headphones', 'Halden Aurora ANC Wireless Headphones', 'HAL-AUR-BLK', 61, 11224.00, 4, ''],
        ['cable', 'Studio Cable Kit', 'NWA-CBL-KIT', 88, 2112.00, 5, ''],
        ['mic', 'Ardent USB Desk Microphone', 'ARD-USB-MIC', 17, 1700.00, 0, ''],
      ];
      const svc = [
        ['On-time dispatch', '96.4%', 'At least 95%', 96.4, 'success', 'Meets target', 'Orders dispatched by their deadline ÷ all dispatched orders'],
        ['Cancellation rate', '0.8%', 'At most 2.5%', 32, 'success', 'Meets target', 'Orders you cancelled ÷ all orders'],
        ['Median first response', '9 h 30 min', 'Within 24 h', 40, 'success', 'Meets target', 'Time from a buyer message to your first reply'],
        ['Valid tracking uploaded', '93.1%', 'At least 95%', 93.1, 'warning', 'Below target', 'Shipments with a carrier-scanned tracking number'],
      ];
      return U.sellerLayout(`
        ${pageHead('Reports', { sub: 'Figures by order date, Pacific Time. Refreshed Oct 8, 9:40 AM.', actions: `${seg(['7 days', '30 days', '90 days'], 1)}<label class="sr-only" for="rp-range">Date range</label>${input('rp-range', 'Sep 9 – Oct 8, 2026', { icon: 'calendar' })}${btn('Export CSV', { v: 'secondary', icon: 'download', size: 'sm' })}` })}

        <div class="sb-kpis">
          <div class="card pad">${stat('Gross sales', money(26908.40), { delta: '6.1%', dir: 'up', note: 'vs prior 30 days' })}</div>
          <div class="card pad">${stat('Orders', U.num(totalOrders), { delta: '4.3%', dir: 'up' })}</div>
          <div class="card pad">${stat('Units sold', '380', { note: '1.0 units per order' })}</div>
          <div class="card pad">${stat('Return rate', '4.7%', { delta: '0.6 pts', dir: 'down', note: 'returns ÷ units' })}</div>
        </div>

        <div class="grid lg2" style="--gap:var(--sp-5)">
          ${card({
            title: 'Orders per day', sub: `${totalOrders} orders · Sep 9 – Oct 8`,
            body: `${U.legend(['Northwind Audio orders'])}${U.lineChart({ labels, series: [{ name: 'Orders', data: orders }], height: 220, area: true, label: 'Orders per day, Sep 9 to Oct 8' })}`,
          })}
          ${card({
            title: 'Returns by reason', sub: '18 returns in the period',
            body: `${U.barChart({ labels: ['Defective', 'Changed mind', 'Not as desc.', 'Missing parts', 'Damaged', 'Wrong item'], data: [7, 5, 2, 2, 1, 1], height: 220, label: 'Returns by reason' })}
              <span class="xs muted">Defective returns are mostly the Pocket Speaker (6 of 7). Consider checking the batch received Sep 3.</span>`,
          })}
        </div>

        ${card({
          title: 'Product sales', sub: 'Sorted by gross sales',
          flush: true,
          body: table(['Product', 'SKU', { label: 'Units', cls: 'r' }, { label: 'Gross sales', cls: 'r' }, { label: 'Avg price', cls: 'r' }, { label: 'Returns', cls: 'r' }, { label: 'Return rate', cls: 'r' }], prod.map((p) => [
            `<div class="cell-main" style="min-width:240px">${img(p[0], 'var(--img-2)', 'tiny')}<span class="stack gap-0"><span class="small strong">${p[1]}</span>${p[6] ? `<span>${badge(p[6], 'deal-soft')}</span>` : ''}</span></div>`,
            mono(p[2]),
            `<span class="num">${p[3]}</span>`,
            `<span class="num strong">${money(p[4])}</span>`,
            `<span class="num">${money(p[4] / p[3])}</span>`,
            `<span class="num">${p[5]}</span>`,
            `<span class="num">${((p[5] / p[3]) * 100).toFixed(1)}%</span>`,
          ])),
        })}

        ${card({
          title: 'Service performance', sub: 'Against Marketly service targets, last 30 days',
          actions: `<a class="small strong" href="${go('seller/performance')}">Account health</a>`,
          body: `<div class="grid md2" style="--gap:0 var(--sp-6)">${svc.map((s) => `<div class="sb-metric">
              <div class="stack gap-0"><span class="small strong">${s[0]}</span><span class="xs muted">Target: ${s[2]}</span></div>
              <div class="row gap-2 nowrap"><span class="h3 num">${s[1]}</span>${status(s[5], s[4])}</div>
              <div class="bar">${meter(s[3], s[4])}</div>
              <span class="xs muted" style="grid-column:1/-1">${s[6]}</span>
            </div>`).join('')}</div>`,
        })}
      `, 'reports');
    },
  });

  /* ======================================================================
     9. Account health
     ====================================================================== */
  U.register({
    id: 'seller/performance', title: 'Account health', ref: 'Plan ch. 10',
    notes: 'Performance summary against targets (dispatch reliability, cancellations, returns, unresolved cases, policy violations) and one active restriction with its reason, affected activity, what still works, how to resolve it and an appeal route with a deadline.',
    render: () => {
      const metrics = [
        ['Dispatch reliability', '96.4%', 'At least 95%', 'Meets target', 'success', 'Last 30 days · 362 of 376 orders on time'],
        ['Cancellation rate', '0.8%', 'At most 2.5%', 'Meets target', 'success', '3 seller cancellations in 376 orders'],
        ['Return rate', '4.7%', 'At most 8% for Electronics', 'Meets target', 'success', '18 returns in 380 units'],
        ['Unresolved cases', '1', '0 past their deadline', 'At risk', 'warning', `${mono('RT-261004-0871')} response overdue 6 h`],
        ['Policy violations', '1', '0 in 90 days', 'Action needed', 'danger', 'Brand claim without documents · Oct 2'],
      ];
      return U.sellerLayout(`
        ${pageHead('Account health', { sub: 'Measured over the last 30 days unless stated. Updated daily at 6:00 AM PT.' })}

        <div class="sb-kpis">
          <div class="card pad sb-bal">${stat('Account status', status('Approved'))}<span class="why">Selling since Jul 14, 2026 · 1 category restriction</span></div>
          <div class="card pad sb-bal">${stat('Verification', badge('Verified seller', 'info', 'shield-check'))}<span class="why">Business and identity checked Jul 2026</span></div>
          <div class="card pad sb-bal">${stat('Payouts', status('Active', 'success'))}<span class="why">Not affected by the restriction</span></div>
          <div class="card pad sb-bal">${stat('Seller feedback', '98%')}<span class="why">positive · 4,812 ratings</span></div>
        </div>

        <section class="sb-restrict" aria-labelledby="sb-r-title">
          <div class="hd">${icon('ban')}<div class="stack gap-1 grow"><span class="row gap-2"><h2 class="h3" id="sb-r-title">New listings in Cameras paused</h2>${status('Restricted')}</span><span class="small sub">Since Fri, Oct 2, 2026 · applied by Grace Kim, Seller Manager · reference ${mono('RS-261002-0019')}</span></div></div>
          <div class="bd">
            <div class="stack gap-2"><span class="small strong">Reason</span><p class="small">Two Vantor V4 Action Camera listings said “authorized Vantor dealer” and used Vantor campaign photos without documents that show you are authorized. Seller rules section 4.2, brand claims.</p></div>
            <div class="stack gap-2"><span class="small strong">How to resolve</span><ol class="ol small stack gap-1"><li>Upload an invoice or authorization letter from Vantor or an approved distributor, dated within 12 months.</li><li>Or remove the authorized-dealer claim and replace the photos with your own.</li><li>Marketly reviews within 3 business days (example) and lifts the pause if it is resolved.</li></ol></div>
            <div class="stack gap-2"><span class="small strong">Affected activity</span>${ticks(['Creating new offers in Cameras', 'Reactivating the 2 hidden Vantor listings'], false)}</div>
            <div class="stack gap-2"><span class="small strong">Still works</span>${ticks(['Existing orders, dispatch and shipping', 'Returns, refunds and cases', 'Customer messages and questions', 'Payouts and statements', 'All listings in other categories'])}</div>
          </div>
          <div class="card-foot" style="justify-content:space-between">
            <span class="row gap-2">${deadline('Appeal by Fri, Oct 16, 11:59 PM PT', 'warning')}<span class="xs muted">Appeals go to a second Seller Manager reviewer, not the person who applied it.</span></span>
            <span class="row gap-2">${btn('Upload documents', { v: 'secondary', icon: 'upload' })}${btn('Appeal restriction', { icon: 'scale' })}</span>
          </div>
        </section>

        <div class="sb-main">
          ${card({
            title: 'Performance against targets', flush: true,
            body: table(['Metric', { label: 'Yours', cls: 'r' }, 'Target', 'Status', 'Details'], metrics.map((m) => [
              `<span class="small strong nowrap">${m[0]}</span>`, `<span class="num strong">${m[1]}</span>`, `<span class="small nowrap">${m[2]}</span>`, status(m[3], m[4]), `<span class="xs sub" style="display:inline-block;min-width:200px">${m[5]}</span>`,
            ]), { rowCls: metrics.map((m) => (m[4] === 'danger' ? 'is-flagged' : m[4] === 'warning' ? 'is-warn' : '')) }),
            foot: `<span class="xs muted grow">Missing targets repeatedly can lead to warnings, restrictions or suspension. We always tell you the reason and how to appeal.</span>`,
          })}
          ${card({
            title: 'Warnings and actions', sub: 'Last 12 months',
            body: timeline([
              { t: 'Restriction: new Cameras listings paused', d: 'Oct 2, 2026 · open · appeal by Oct 16', state: 'warn' },
              { t: 'Warning: 3 late dispatches in one week', d: 'Sep 18, 2026 · resolved Sep 25 after 7 days on time', state: 'done' },
              { t: 'Warning: listing photo with another store’s watermark', d: 'Aug 30, 2026 · resolved same day, photo replaced', state: 'done' },
              { t: 'Account approved', d: 'Jul 14, 2026', state: 'done' },
            ]),
          })}
        </div>
      `, 'performance');
    },
  });

  /* ======================================================================
     10. Store profile and storefront
     ====================================================================== */
  U.register({
    id: 'seller/store', title: 'Store profile', ref: 'Plan ch. 10–11',
    notes: 'Storefront editor with a live preview: name, logo, banner, introduction, location, categories, featured collections, return and warranty policies and contact options. Changes to public claims or brand affiliation wait for staff review before going live.',
    render: () => {
      const pending = badge('Pending review', 'warning', 'clock');
      const preview = `<div class="sb-prev">
          ${img('audio-lines', 'var(--img-2)', 'wide sb-banner')}
          <div class="body">
            <div class="row gap-3" style="align-items:flex-end">${logoTile(D.sellers.northwind, 'lg')}<div class="stack gap-0" style="padding-bottom:4px"><span class="h3">Northwind Audio</span><span class="row gap-2">${badge('Verified seller', 'info', 'shield-check')}<span class="xs muted">${icon('map-pin', 'ic-sm')} Portland, OR</span></span></div></div>
            <span class="row gap-2 xs sub">${U.stars(4.9)}<span>98% positive · 4,812 ratings · ships in 1 business day</span></span>
            <p class="small sub">Independent audio shop in Portland since 2014. We test every speaker and headphone before it ships and answer messages 7 days a week.</p>
            <span class="sb-pending row gap-2" style="align-self:flex-start;padding:2px 6px">${badge('Authorized Halden retailer', 'outline', 'badge-check')}<span class="xs muted">Shown after approval</span></span>
            <div class="stack gap-2"><span class="xs strong">Featured</span><div class="grid c2" style="--gap:var(--sp-2)">
              <div class="stack gap-1">${img('speaker', 'var(--img-2)', 'r43')}<span class="xs strong">Portable speakers</span></div>
              <div class="stack gap-1">${img('headphones', 'var(--img-6)', 'r43')}<span class="xs strong">Noise-cancelling picks</span></div>
            </div></div>
            <div class="panel xs sub">30-day returns · free return shipping on defective items · 1-year Northwind warranty on top of the manufacturer’s</div>
            ${btn('Message the seller', { v: 'secondary', size: 'sm', icon: 'message-square', block: true })}
          </div>
        </div>`;
      return U.sellerLayout(`
        ${pageHead('Store and settings', { sub: 'What customers see on your storefront.', actions: `<a class="btn btn-secondary btn-sm" href="${go('store/seller')}">${icon('external-link')}<span>View storefront</span></a>${btn('Save changes', { size: 'sm' })}` })}
        <div>${tabs([{ label: 'Store profile', href: go('seller/store') }, { label: 'Staff and permissions', href: go('seller/staff') }, { label: 'Notifications', href: go('seller/staff') }, { label: 'Shipping', href: go('seller/shipping') }], 0)}</div>
        ${alert('warning', '1 change waiting for staff review', 'Changes to public claims or brand affiliation are checked by Marketly staff before they go live (example: within 2 business days). Your other changes publish when you save.')}

        <div class="sb-main">
          <div class="stack gap-5">
            ${card({
              title: 'Identity',
              body: `<div class="sb-form-grid">
                ${field('Store name', input('st-name', 'Northwind Audio'), { hint: 'Changing your store name needs review.' })}
                ${field('Location shown', input('st-loc', 'Portland, OR', { icon: 'map-pin' }))}
                <div class="stack gap-2"><span class="label">Logo</span><div class="row gap-3">${logoTile(D.sellers.northwind, 'lg')}${btn('Replace logo', { v: 'secondary', size: 'sm', icon: 'upload' })}</div><span class="hint">Square, at least 400 × 400 px</span></div>
                <div class="stack gap-2"><span class="label">Banner</span>${img('audio-lines', 'var(--img-2)', 'wide')}<span class="row gap-2">${btn('Replace banner', { v: 'secondary', size: 'sm', icon: 'upload' })}<span class="hint">2400 × 800 px</span></span></div>
                <div class="full">${field('Introduction', textarea('st-intro', 'Independent audio shop in Portland since 2014. We test every speaker and headphone before it ships and answer messages 7 days a week.'), { hint: '220 of 400 characters' })}</div>
              </div>`,
            })}
            ${card({
              title: 'Categories and featured collections',
              body: `<div class="stack gap-2"><span class="label">Categories you sell in</span>${chips([{ label: 'Headphones', active: true }, { label: 'Speakers', active: true }, { label: 'Accessories', active: true }, { label: 'Cameras · paused', icon: 'ban' }])}<span class="hint">Cameras: new listings paused. See Account health.</span></div>
                <ul class="list">
                  <li>${icon('grip-vertical', 'ic-sm')}${img('speaker', 'var(--img-2)', 'tiny')}<span class="grow stack gap-0"><span class="small strong">Portable speakers</span><span class="xs muted">6 offers</span></span>${iconBtn('pencil', 'Edit Portable speakers')}</li>
                  <li>${icon('grip-vertical', 'ic-sm')}${img('headphones', 'var(--img-6)', 'tiny')}<span class="grow stack gap-0"><span class="small strong">Noise-cancelling picks</span><span class="xs muted">3 offers</span></span>${iconBtn('pencil', 'Edit Noise-cancelling picks')}</li>
                </ul>
                <div>${btn('Add collection', { v: 'soft', size: 'sm', icon: 'plus' })}</div>`,
            })}
            ${card({
              title: 'Store policies', sub: 'Shown on every offer and before checkout',
              body: `<div class="sb-form-grid">
                ${field('Return window', select('st-ret', ['30 days (platform baseline)', '45 days', '60 days'], '30 days (platform baseline)'), { hint: 'You can offer more than the baseline, not less.' })}
                ${field('Return shipping for change of mind', select('st-retship', ['Customer pays', 'You pay (free returns)'], 'Customer pays'))}
                <div class="full">${field('Warranty', textarea('st-warr', '1-year Northwind warranty on top of the manufacturer warranty. We repair or replace faulty items.'))}</div>
              </div>
              <span class="xs muted">Defective, damaged or wrong items: you always pay return shipping (platform rule).</span>`,
            })}
            ${card({
              title: 'Public claims and brand affiliation', sub: pending,
              body: `${field('Brand affiliation', input('st-brand', 'Authorized Halden retailer'), { hint: 'Submitted Oct 7 with a Halden distributor letter. Not shown until approved.' })}
                <div class="panel stack gap-1"><span class="xs strong">${icon('shield-check', 'ic-sm')} About your Verified seller label</span><span class="xs sub">Marketly checked your business registration and the owner’s identity in July 2026. The label does not certify product authenticity beyond that check.</span></div>`,
            })}
            ${card({
              title: 'Contact options',
              body: `<div class="stack gap-3">
                ${toggle('st-msg', 'Order messages (always on for buyers with an order)', true)}
                ${toggle('st-q', 'Product questions from shoppers', true)}
                ${toggle('st-phone', 'Show a phone number for order questions', false)}
                ${field('Reply target shown to customers', select('st-target', ['Within 24 hours', 'Within 12 hours'], 'Within 24 hours'))}
              </div>`,
            })}
          </div>
          <div class="stack gap-3">
            <span class="row between"><span class="small strong">Live preview</span>${seg([{ label: 'Desktop', icon: 'monitor' }, { label: 'Phone', icon: 'smartphone' }], 1)}</span>
            ${preview}
            <span class="xs muted">Dashed outline: waiting for staff review.</span>
          </div>
        </div>
      `, 'store');
    },
  });

  /* ======================================================================
     11. Staff and permissions
     ====================================================================== */
  const STAFF = [
    { n: 'Avery Stone', e: 'avery@northwindaudio.com', role: 'Owner', st: 'Active', last: 'Now' },
    { n: 'Jun Park', e: 'jun@northwindaudio.com', role: 'Products and inventory', st: 'Active', last: 'Today, 8:52 AM' },
    { n: 'Maya Ortiz', e: 'maya@northwindaudio.com', role: 'Shipping', st: 'Active', last: 'Today, 9:31 AM' },
    { n: 'Leo Grant', e: 'leo@northwindaudio.com', role: 'Customer service', st: 'Active', last: 'Yesterday, 6:10 PM' },
    { n: 'Sana Ali', e: 'sana.ali@example.com', role: 'Shipping', st: 'Invited', last: 'Invite expires Oct 15' },
  ];
  const P = { f: `<span class="sb-perm full">${icon('check', 'ic-sm')}Manage</span>`, v: `<span class="sb-perm view">${icon('eye', 'ic-sm')}View</span>`, n: `<span class="sb-perm none">${icon('minus', 'ic-sm')}<span class="sr-only">No access</span></span>`, o: `<span class="sb-perm lock">${icon('lock', 'ic-sm')}Owner only</span>` };
  const MATRIX = [
    ['Products', 'f', 'f', 'n', 'v'],
    ['Inventory', 'f', 'f', 'v', 'n'],
    ['Orders and shipping', 'f', 'v', 'f', 'v'],
    ['Returns', 'f', 'n', 'f', 'f'],
    ['Customers', 'f', 'n', 'v', 'f'],
    ['Finance (view)', 'f', 'n', 'n', 'n'],
    ['Payout changes', 'o', 'n', 'n', 'n'],
  ];
  const inviteForm = (pfx) => `<div class="sb-form-grid">
      ${field('Email', input(pfx + '-email', pfx === 'sf-m' ? 'theo.nguyen@northwindaudio.com' : '', { type: 'email', placeholder: 'name@company.com' }))}
      ${field('Name', input(pfx + '-name', pfx === 'sf-m' ? 'Theo Nguyen' : '', { placeholder: 'Full name' }))}
      ${field('Role', select(pfx + '-role', ['Products and inventory', 'Shipping', 'Customer service', 'Custom permissions'], 'Customer service'), { hint: 'Roles are starting points. You can change single permissions.' })}
    </div>`;

  U.register({
    id: 'seller/staff', title: 'Staff and permissions', ref: 'Plan ch. 10–11',
    notes: 'Seller staff with scoped roles, an invite form, a permission matrix where finance is owner-only and payout changes can never be delegated, notification preferences per person and the account status card.',
    states: ['Staff', 'Invite staff'],
    render: (state) => {
      const staffTable = table(['Person', 'Role', 'Status', 'Last active', ''], STAFF.map((s) => [
        `<div class="cell-main">${avatar(s.n)}<span class="stack gap-0"><span class="small strong">${s.n}</span><span class="xs muted">${s.e}</span></span></div>`,
        s.role === 'Owner' ? badge('Owner', 'solid') : `<span class="small">${s.role}</span>`,
        status(s.st),
        `<span class="xs sub nowrap">${s.last}</span>`,
        s.role === 'Owner' ? '' : s.st === 'Invited' ? btn('Resend', { v: 'ghost', size: 'sm' }) : btn('Edit', { v: 'ghost', size: 'sm' }),
      ]));
      const matrix = table(['Permission', 'Avery Stone<br><span class="xs muted">Owner</span>', 'Jun Park<br><span class="xs muted">Products</span>', 'Maya Ortiz<br><span class="xs muted">Shipping</span>', 'Leo Grant<br><span class="xs muted">Service</span>'].map((l, i) => (i ? { label: l, cls: 'c' } : l)),
        MATRIX.map((r) => [`<span class="small strong nowrap">${r[0]}</span>`, ...r.slice(1).map((k) => P[k])]));
      const EVENTS = ['New orders', 'Dispatch overdue', 'Returns and cases', 'Customer messages', 'Payouts and holds'];
      const prefs = [
        ['Avery Stone', [1, 1, 1, 0, 1], 'In-app and email'],
        ['Jun Park', [0, 0, 0, 0, 0], 'In-app'],
        ['Maya Ortiz', [1, 1, 1, 0, 0], 'In-app and email'],
        ['Leo Grant', [0, 0, 1, 1, 0], 'In-app'],
      ];
      const prefTable = table(['Person', ...EVENTS.map((e) => ({ label: e, cls: 'c' })), 'Channel'], prefs.map((p, i) => [
        `<span class="small strong nowrap">${p[0]}</span>`,
        ...p[1].map((on, j) => (j === 4 && i > 0 ? `<span class="sb-perm none" title="Owner only">${icon('lock', 'ic-sm')}<span class="sr-only">Owner only</span></span>` : `<input type="checkbox" id="sf-n-${i}-${j}" aria-label="${p[0]}: ${EVENTS[j]}"${on ? ' checked' : ''}>`)),
        select('sf-ch-' + i, ['In-app', 'In-app and email', 'Email'], p[2]),
      ]));

      const page = U.sellerLayout(`
        ${pageHead('Staff and permissions', { crumbs: [{ label: 'Store and settings', href: go('seller/store') }, { label: 'Staff and permissions' }], sub: 'Give each person only the access they need. Every change is recorded.', actions: btn('Invite staff', { icon: 'user-plus', size: 'sm', href: go('seller/staff', 'Invite staff') }) })}
        <div>${tabs([{ label: 'Store profile', href: go('seller/store') }, { label: 'Staff and permissions', href: go('seller/staff') }, { label: 'Notifications', href: go('seller/staff') }, { label: 'Shipping', href: go('seller/shipping') }], 1)}</div>

        <div class="sb-main">
          <div class="stack gap-5">
            ${card({ title: 'Staff', sub: '4 active · 1 invited', flush: true, body: staffTable })}
            ${card({
              title: 'Permission matrix', sub: 'Manage = view and change · View = read only',
              flush: true,
              body: matrix,
              foot: `<span class="xs muted grow">Finance is visible to the owner only. Payout account changes can never be given to staff and always need verification and Marketly review. Staff never see other sellers’ orders, costs, messages or balances.</span>`,
            })}
            ${card({
              title: 'Notification preferences', sub: 'Who hears about what',
              flush: true,
              body: prefTable,
              foot: btn('Save preferences', { v: 'secondary', size: 'sm' }),
            })}
          </div>
          <div class="stack gap-5">
            ${card({
              title: 'Account status',
              body: `<div class="row gap-3">${logoTile(D.sellers.northwind)}<div class="stack gap-0"><span class="strong">Northwind Audio</span><span class="xs muted">Seller ID NWA-20714</span></div></div>
                ${kv([['Account', status('Approved')], ['Seller since', 'Jul 14, 2026'], ['Verification', badge('Verified seller', 'info', 'shield-check')], ['Product approval', '26 active · 2 hidden'], ['Payouts', status('Active', 'success')], ['Restrictions', `<a href="${go('seller/performance')}">1 active: Cameras</a>`]])}
                <span class="xs muted">Changes to ownership or verification details need Marketly review.</span>`,
            })}
            ${card({
              title: 'Invite staff', sub: 'They get an email link valid for 7 days',
              body: inviteForm('sf-q'),
              foot: btn('Send invite', { icon: 'send', size: 'sm' }),
            })}
          </div>
        </div>
      `, 'store');

      if (state !== 'Invite staff') return page;
      return page + U.modal({
        title: 'Invite staff',
        size: 'lg',
        body: `${inviteForm('sf-m')}
          <div class="stack gap-2"><span class="label">Permissions for Customer service</span>
            <div class="grid md2" style="--gap:var(--sp-2)">
              ${check('sf-m-p1', 'Customers: answer messages, questions and feedback', true)}
              ${check('sf-m-p2', 'Returns: respond to return requests', true)}
              ${check('sf-m-p3', 'Orders and shipping: view only', true)}
              ${check('sf-m-p4', 'Products: view only', false)}
              ${check('sf-m-p5', 'Inventory', false)}
              ${check('sf-m-p6', 'Finance view (owner only today)', false)}
            </div>
            <div class="panel row gap-2 xs sub">${icon('lock', 'ic-sm')}Payout changes: owner only. This can't be given to staff.</div>
          </div>
          ${check('sf-m-notify', 'Send Theo notifications for returns and customer messages', true)}`,
        foot: `${btn('Cancel', { v: 'ghost', href: go('seller/staff') })}${btn('Send invite', { icon: 'send' })}`,
      });
    },
  });

  /* ======================================================================
     12. Notifications (seller workspace inbox)
     ====================================================================== */
  U.css('seller-b-2', `
    .sb-note { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: var(--sp-3); align-items: start; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); color: inherit !important; text-decoration: none !important; position: relative; }
    @container app (min-width: 768px) { .sb-note { padding: var(--sp-4) var(--sp-5); } }
    .sb-note:last-child { border-bottom: 0; }
    .sb-note:hover { background: var(--surface-2); }
    .sb-note.is-unread { background: var(--brand-soft); }
    .sb-note.is-unread:hover { background: var(--brand-soft-2); }
    .sb-note.is-action { box-shadow: inset 3px 0 0 var(--warning); }
    .sb-note.is-urgent { box-shadow: inset 3px 0 0 var(--danger); }
    .sb-note .ic { width: 40px; height: 40px; border-radius: 50%; background: var(--surface-2); display: inline-flex; align-items: center; justify-content: center; color: var(--text-2); }
    .sb-note.is-unread .ic { background: var(--surface); color: var(--brand-text); }
    .sb-note .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--brand); display: inline-block; flex: none; }
    .sb-note .side { display: flex; flex-direction: column; align-items: flex-end; gap: var(--sp-2); }
    .sb-grp { padding: var(--sp-2) var(--sp-4); background: var(--surface-2); border-bottom: 1px solid var(--border); font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-3); }
    @container app (min-width: 768px) { .sb-grp { padding-inline: var(--sp-5); } }
    .sb-topics { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .sb-topics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @container app (min-width: 1280px) { .sb-topics { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .sb-topic { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4); border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); }
    .sb-topic .ic { width: 40px; height: 40px; border-radius: var(--r-md); background: var(--brand-soft); color: var(--brand-text); display: inline-flex; align-items: center; justify-content: center; }
    .sb-topic ul { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); }
    .sb-hsearch { background: var(--brand-soft); border-radius: var(--r-xl); padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-3); }
    .sb-hsearch .search-in { display: flex; align-items: center; gap: var(--sp-2); height: 48px; padding: 0 var(--sp-4); border: 1px solid var(--border-strong); border-radius: var(--r-pill); background: var(--surface); color: var(--text-3); }
    .sb-hsearch .search-in input { flex: 1; border: 0; background: transparent; font: inherit; color: var(--text); min-width: 0; }
    .sb-hsearch .search-in input:focus { outline: none; }
    .sb-guide { counter-reset: g; display: flex; flex-direction: column; gap: var(--sp-3); }
    .sb-guide li { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: var(--sp-3); align-items: start; }
    .sb-guide li::before { counter-increment: g; content: counter(g); width: 28px; height: 28px; border-radius: 50%; background: var(--brand); color: var(--on-brand); font-weight: 700; font-size: var(--fs-xs); display: inline-flex; align-items: center; justify-content: center; }
  `);

  const NOTE_CATS = ['All', 'Orders', 'Returns & cases', 'Products', 'Account & finance'];
  const NOTES = [
    { g: 'Today', cat: 'Orders', ic: 'alarm-clock', title: 'Dispatch overdue: MK-261007-10433', body: 'Halden Pocket Speaker × 1 for Alex M. was due Oct 8, 12:00 PM. Ship it or tell the buyer the new date. Overdue orders count toward dispatch reliability.', time: '3:02 PM', href: go('seller/order'), unread: true, due: 'Overdue 3 h', tone: 'danger' },
    { g: 'Today', cat: 'Orders', ic: 'shopping-bag', title: '2 new orders to dispatch today', body: 'MK-261008-12077 (Pocket Speaker × 2) and MK-261008-11902 (Aurora ANC Headphones).', time: '9:14 AM', href: go('seller/order'), unread: true, due: 'Dispatch by 5:00 PM', tone: 'warning' },
    { g: 'Today', cat: 'Returns & cases', ic: 'package-check', title: 'Return received: RT-260930-0730', body: 'Halden Aurora ANC Headphones arrived at your return address. Record the inspection and refund decision.', time: '9:05 AM', href: go('seller/return', 'Inspect and refund'), unread: true, due: 'Inspect by Oct 10, 9:05 AM', tone: 'ok' },
    { g: 'Today', cat: 'Returns & cases', ic: 'scale', title: 'Dispute RT-260927-0622 needs your evidence', body: 'Marketly support is reviewing the customer’s challenge to your $46.00 partial refund. Add photos or test results before the deadline.', time: '8:30 AM', href: go('seller/returns', 'Disputes'), unread: true, due: 'Evidence due Oct 9, 5:00 PM', tone: 'warning' },
    { g: 'Earlier this week', cat: 'Products', ic: 'file-pen-line', title: 'Changes requested: Ardent USB Desk Microphone', body: 'Reviewer Omar Haddad asked for a photo without a watermark and the sample rate in the specifications.', time: 'Wed, Oct 7', href: go('seller/product-new', 'Changes requested'), unread: false, due: 'Resubmit by Oct 14', tone: 'ok' },
    { g: 'Earlier this week', cat: 'Returns & cases', ic: 'undo-2', title: 'New return request: RT-261007-0977', body: 'Halden Aurora ANC Headphones · changed mind. Respond by Oct 10, 9:40 AM.', time: 'Wed, Oct 7', href: go('seller/return', 'Respond'), unread: false },
    { g: 'Earlier this week', cat: 'Account & finance', ic: 'lock', title: 'Hold placed on MK-261003-07712', body: `${money(172.59)} held because the carrier shows no delivery scan. Review date Mon, Oct 12. No action needed unless you have proof of delivery.`, time: 'Tue, Oct 6', href: go('seller/finance'), unread: false },
    { g: 'Earlier this week', cat: 'Account & finance', ic: 'gavel', title: 'Appeal window closes Oct 16', body: 'New listings in Cameras are still paused (RS-261002-0019). Upload documents or appeal before the deadline.', time: 'Tue, Oct 6', href: go('seller/performance'), unread: false, due: 'Appeal by Oct 16', tone: 'ok' },
    { g: 'Earlier this week', cat: 'Account & finance', ic: 'landmark', title: `Payout PO-261005-3381 paid: ${money(PAYOUT)}`, body: `Sent Oct 5 to ${BANK}. Arrived Oct 6. Includes a refund-after-payout deduction.`, time: 'Mon, Oct 5', href: go('seller/finance'), unread: false },
    { g: 'Earlier this week', cat: 'Products', ic: 'circle-check', title: 'Product approved: Halden Pocket Speaker, Sand', body: 'Your new color variation is live on the shared product page.', time: 'Mon, Oct 5', href: go('seller/products'), unread: false },
    { g: 'Older', cat: 'Account & finance', ic: 'badge-check', title: 'Seller application approved', body: 'Northwind Audio is approved to sell on Marketly. Finish store setup and submit your first offers.', time: 'Jul 14, 2026', href: go('seller/setup'), unread: false },
  ];

  U.register({
    id: 'seller/notifications', title: 'Notifications', ref: 'Plan ch. 19',
    notes: 'Seller notices inside the workspace: application result, requested corrections, new orders, dispatch deadlines, returns, cases, restrictions and payout results. Each notice links to the screen where it is handled, and notices that need action show their deadline.',
    render: () => {
      const unread = NOTES.filter((n) => n.unread).length;
      const action = NOTES.filter((n) => n.due).length;
      const row = (n) => `<a class="sb-note${n.unread ? ' is-unread' : ''}${n.tone === 'danger' ? ' is-urgent' : n.due ? ' is-action' : ''}" href="${n.href}">
          <span class="ic">${icon(n.ic)}</span>
          <span class="stack gap-1" style="min-width:0">
            <span class="row gap-2">${n.unread ? '<span class="dot" aria-hidden="true"></span><span class="sr-only">Unread.</span>' : ''}<span class="small ${n.unread ? 'bold' : 'strong'}">${n.title}</span></span>
            <span class="xs sub">${n.body}</span>
            <span class="row gap-2">${badge(n.cat, 'outline')}${n.due ? badge('Action required', n.tone === 'danger' ? 'danger' : 'warning', 'triangle-alert') + deadline(n.due, n.tone) : ''}</span>
          </span>
          <span class="side"><span class="xs muted nowrap">${n.time}</span>${icon('chevron-right', 'ic-sm')}</span>
        </a>`;
      const groups = ['Today', 'Earlier this week', 'Older'].map((g) => `<div class="sb-grp">${g}</div>${NOTES.filter((n) => n.g === g).map(row).join('')}`).join('');
      const counts = NOTE_CATS.map((c) => (c === 'All' ? NOTES.length : NOTES.filter((n) => n.cat === c).length));

      return U.sellerLayout(`
        ${pageHead('Notifications', { sub: `${unread} unread · ${action} need action. Times in Pacific Time.`, actions: btn('Mark all as read', { v: 'secondary', icon: 'check-check', size: 'sm' }) })}
        <div class="sb-main">
          <div class="stack gap-3">
            <div class="row between">${chips(NOTE_CATS.map((c, i) => ({ label: `${c} (${counts[i]})` })), 0)}${toggle('nt-unread', 'Unread only', false)}</div>
            ${card({ flush: true, body: groups, foot: `<span class="xs muted grow">Notices are kept for 12 months.</span>${btn('Load older notices', { v: 'ghost', size: 'sm' })}` })}
          </div>
          <div class="stack gap-5">
            ${card({
              title: 'Needs action', sub: 'Sorted by deadline',
              body: `<ul class="list">${NOTES.filter((n) => n.due).map((n) => `<li><span class="grow stack gap-0"><a class="small strong" href="${n.href}">${n.title}</a>${deadline(n.due, n.tone)}</span></li>`).join('')}</ul>`,
            })}
            ${card({
              title: 'Email notifications',
              body: `<p class="small sub">Choose which notices each person also gets by email.</p>
                <a class="small strong" href="${go('seller/staff')}">${icon('settings', 'ic-sm')} Notification preferences</a>
                ${alert('info', 'Essential notices can’t be turned off', 'New orders, dispatch deadlines, return and case deadlines, restrictions, payout results and security alerts always appear here and are always emailed to the owner.')}`,
            })}
          </div>
        </div>
      `, 'notifications');
    },
  });

  /* ======================================================================
     13. Help and support
     ====================================================================== */
  const TOPICS = [
    ['wallet', 'Fees and payouts', 'How commission is calculated, when earnings become available, holds and statements.', ['How the fee basis works', 'Payout schedule and cutoffs', 'Refunds after payout and negative balances']],
    ['file-check', 'Listing rules and rejected submissions', 'What reviewers check and how to fix a submission.', ['Photo and title rules', 'Brand claims and proof documents', 'Fix a rejected or changes-requested product']],
    ['truck', 'Shipping and dispatch targets', 'Dispatch deadlines, valid tracking and late shipments.', ['Dispatch deadline rules', 'Uploading valid tracking', 'When you can’t fulfill an order']],
    ['undo-2', 'Returns and disputes', 'Response targets, who pays return shipping and how disputes are decided.', ['Responding to a return request', 'Partial refunds and reasons', 'Disputes, evidence and appeals']],
    ['gauge', 'Account health and restrictions', 'Targets, warnings, restrictions and how to appeal.', ['What each metric measures', 'What a restriction affects', 'How to appeal a decision']],
    ['megaphone', 'Advertising', 'Sponsored products and stores, billing and review.', ['Requesting a sponsored campaign', 'How ad charges are billed', 'Why an ad was not approved']],
  ];
  const REQUESTS = [
    ['CS-261007-1251', 'Documents for the Cameras restriction', 'Account health', 'Open', 'Reply expected by Oct 9, 10:00 AM'],
    ['CS-261005-1219', 'Hold on MK-261003-07712', 'Fees and payouts', 'Waiting on seller', 'Support asked for proof of delivery · Oct 6'],
    ['CS-260928-1107', 'Shipping label billed twice', 'Fees and payouts', 'Resolved', 'Adjustment ADJ-260930-0112 added Sep 30'],
  ];

  U.register({
    id: 'seller/help', title: 'Help and support', ref: 'Plan ch. 11',
    notes: 'Seller help that explains fees (with an example calculation), restrictions and the correction steps for rejected submissions, plus a seller support contact form with expected reply time and the list of open support requests.',
    states: ['Help', 'Contact seller support'],
    render: (state) => {
      const contact = state === 'Contact seller support';
      const reqList = card({
        title: 'Your support requests', sub: '2 open',
        flush: true,
        body: `<ul class="list pad">${REQUESTS.map((r) => `<li><span class="grow stack gap-1"><span class="row between"><a class="mono small" href="javascript:void 0">${r[0]}</a>${status(r[3])}</span><span class="small strong">${r[1]}</span><span class="xs muted">${r[2]} · ${r[4]}</span></span></li>`).join('')}</ul>`,
      });
      const replyCard = card({
        title: 'Expected reply time',
        body: `${kv([['Standard', 'Within 1 business day'], ['Restrictions and failed payouts', 'Within 4 hours'], ['Hours', 'Mon–Sat, 8 AM–8 PM PT']])}
          <span class="xs muted">Example service targets. Replies arrive here and by email.</span>`,
      });

      if (contact) {
        return U.sellerLayout(`
          ${pageHead('Contact seller support', { crumbs: [{ label: 'Help and support', href: go('seller/help') }, { label: 'Contact seller support' }], sub: 'For questions the help articles don’t answer. A Marketly Seller Manager team member handles your request.' })}
          <div class="sb-main">
            ${card({
              title: 'New support request',
              body: `<div class="sb-form-grid">
                  ${field('Topic', select('hp-topic', ['Account health and restrictions', 'Fees and payouts', 'Listing rules and rejected submissions', 'Shipping and dispatch', 'Returns and disputes', 'Advertising', 'Something else'], 'Account health and restrictions'))}
                  ${field('Related order, product or reference', input('hp-ref', 'RS-261002-0019', { icon: 'hash' }), { opt: true, hint: 'Order MK-…, return RT-…, payout PO-… or a SKU' })}
                  <div class="full">${field('Subject', input('hp-subj', 'Which documents prove we can sell Vantor cameras?'))}</div>
                  <div class="full">${field('Message', textarea('hp-msg', 'We buy Vantor cameras from Westline Distribution, an authorized US distributor. Is a recent invoice from them enough, or do you need a letter from Vantor? Invoice attached.'), { hint: 'Don’t include customer personal details or card numbers.' })}</div>
                </div>
                <div class="stack gap-2"><span class="label">Attachments <span class="opt">(optional)</span></span>
                  ${dropzone('Add files', 'PDF, JPG or PNG, up to 10 MB each')}
                  <ul class="list"><li>${icon('file-text', 'ic-sm')}<span class="grow small">westline-invoice-2026-08.pdf</span><span class="xs muted">412 KB</span>${iconBtn('x', 'Remove westline-invoice-2026-08.pdf')}</li></ul>
                </div>
                ${field('Reply by', select('hp-chan', ['In Seller Center and email to avery@northwindaudio.com', 'In Seller Center only'], 'In Seller Center and email to avery@northwindaudio.com'))}`,
              foot: `${btn('Cancel', { v: 'ghost', href: go('seller/help') })}${btn('Send request', { icon: 'send' })}`,
            })}
            <div class="stack gap-5">
              ${replyCard}
              ${card({
                title: 'These may answer it now',
                body: `<ul class="stack gap-2 small"><li><a href="javascript:void 0">Brand claims and proof documents</a></li><li><a href="${go('seller/performance')}">How to appeal a decision</a></li><li><a href="javascript:void 0">What a restriction affects</a></li></ul>`,
              })}
              ${reqList}
            </div>
          </div>
        `, 'help');
      }

      const fee = card({
        title: 'How fees work', sub: 'Example calculation',
        body: `<div class="sb-recon">
            ${sumRow('Item price', money(100.00))}
            ${sumRow('Your discount (seller-funded)', `<span class="t-deal-text">${sm(-10.00)}</span>`)}
            ${sumRow('Fee basis', money(90.00), 'strong')}
            ${sumRow('Marketplace fee, 10% of fee basis', `<span class="sb-neg">${sm(-9.00)}</span>`)}
            ${sumRow('Shipping you charged (no fee)', money(6.99))}
            ${sumRow('Your earnings', money(87.99), 'total')}
          </div>
          <p class="xs muted">Example rate. Without a discount, a ${money(100)} sale with a 10% fee gives ${money(10)} in fees and ${money(90)} to you. Platform-funded discounts don't reduce your earnings. Final fees are in your seller agreement.</p>
          <a class="small strong" href="${go('seller/statement')}">See it on a real statement ${icon('arrow-right', 'ic-sm')}</a>`,
      });

      return U.sellerLayout(`
        ${pageHead('Help and support', { sub: 'Guides for selling on Marketly, and a direct line to seller support.', actions: btn('Contact seller support', { icon: 'message-square', size: 'sm', href: go('seller/help', 'Contact seller support') }) })}
        <div class="sb-hsearch">
          <h2 class="h3">How can we help?</h2>
          <label class="search-in" for="hp-q">${icon('search', 'ic-sm')}<input id="hp-q" type="search" placeholder="Search seller help, e.g. why was my product rejected"></label>
          <div class="row gap-2 xs sub"><span>Popular:</span>${chips(['Payout schedule', 'Changes requested', 'Dispatch deadlines', 'Appeal a restriction'])}</div>
        </div>

        <div class="sb-main">
          <div class="stack gap-5">
            <div class="sb-topics">${TOPICS.map((t) => `<section class="sb-topic"><span class="ic">${icon(t[0])}</span><h3 class="h4">${t[1]}</h3><p class="xs sub">${t[2]}</p><ul>${t[3].map((a) => `<li><a href="javascript:void 0">${a}</a></li>`).join('')}</ul></section>`).join('')}</div>

            ${card({
              title: 'Fix a rejected or changes-requested product', sub: 'Featured guide · 4 min read',
              body: `<ol class="sb-guide">
                  <li><div class="stack gap-1"><span class="small strong">Find the submission</span><span class="xs sub">In Products and offers, filter by Changes requested or Rejected. Each one shows the reviewer and the date.</span></div></li>
                  <li><div class="stack gap-1"><span class="small strong">Read each reviewer note</span><span class="xs sub">Notes are attached to the field that needs work, such as a photo, the title or a specification. Common reasons: watermarked or borrowed photos, missing required attributes, brand claims without proof, a duplicate of an existing product.</span></div></li>
                  <li><div class="stack gap-1"><span class="small strong">Fix the flagged fields</span><span class="xs sub">Only flagged fields need changes. For a duplicate, add your offer to the existing product instead.</span></div></li>
                  <li><div class="stack gap-1"><span class="small strong">Resubmit</span><span class="xs sub">The status goes back to Submitted. Review usually takes up to 2 business days (example).</span></div></li>
                  <li><div class="stack gap-1"><span class="small strong">If it was rejected</span><span class="xs sub">The rejection explains the rule that applies. You can submit a corrected version or ask support to review the decision.</span></div></li>
                </ol>`,
              foot: btn('Open a product with changes requested', { v: 'secondary', size: 'sm', iconR: 'arrow-right', href: go('seller/product-new', 'Changes requested') }),
            })}

            ${card({
              title: 'Restrictions, in short',
              body: `<p class="small sub">A restriction always tells you the reason, which activity it affects and how to appeal. Existing orders, returns, customer messages and payouts keep working unless the notice says otherwise.</p>
                <a class="small strong" href="${go('seller/performance')}">View your account health ${icon('arrow-right', 'ic-sm')}</a>`,
            })}
          </div>
          <div class="stack gap-5">
            ${fee}
            ${card({
              title: 'Contact seller support',
              body: `<p class="small sub">Owners and staff with access can send a request. Replies come to this page and by email.</p>${kv([['Standard reply', 'Within 1 business day'], ['Urgent', 'Within 4 hours (example)']])}`,
              foot: btn('Contact seller support', { icon: 'message-square', size: 'sm', href: go('seller/help', 'Contact seller support') }),
            })}
            ${reqList}
          </div>
        </div>
      `, 'help');
    },
  });
})();
