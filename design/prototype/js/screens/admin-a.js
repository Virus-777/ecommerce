/* Admin Center · Commerce, Catalog, Official store, Sellers, Shipping (plan ch. 2, 8, 9, 10, 12, 13, 17, 18)
   Signed-in staff user: Riley Chen, Platform Administrator. */
(function () {
  const U = UI;
  const D = window.D;

  U.css('admin-a', `
    .aa-lt { width: 32px; height: 32px; font-size: 12px; border-radius: var(--r-sm); }
    .aa-lt.sm { width: 24px; height: 24px; font-size: 10px; border-radius: var(--r-xs); }
    .aa-flt { gap: 4px; }
    .aa-flt .label { font-size: var(--fs-xs); color: var(--text-3); }
    .aa-flt .select, .aa-flt .input { min-height: 40px; height: 40px; font-size: var(--fs-sm); }
    .aa-filters { display: grid; gap: var(--sp-2) var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 768px) { .aa-filters { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @container app (min-width: 1280px) { .aa-filters { grid-template-columns: repeat(6, minmax(0, 1fr)); } .aa-filters.c5 { grid-template-columns: repeat(5, minmax(0, 1fr)); } .aa-filters.c4 { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .aa-kpis { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 1024px) { .aa-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } .aa-kpis.c5 { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
    .aa-split { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1180px) { .aa-split { grid-template-columns: minmax(0, 1fr) 340px; } }
    .aa-mlist { display: flex; flex-direction: column; gap: var(--sp-2); }
    .aa-mcard { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); color: inherit !important; text-decoration: none !important; min-width: 0; }
    .aa-mcard.is-flagged { box-shadow: inset 3px 0 0 var(--danger); }
    .aa-mcard.is-warn { box-shadow: inset 3px 0 0 var(--warning); }
    .aa-flags { display: flex; flex-wrap: wrap; gap: 4px; }
    .aa-tip { position: relative; display: inline-flex; }
    .aa-tip .aa-tipbox { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 6; width: max-content; max-width: 260px; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--surface); color: var(--text); border: 1px solid var(--border-strong); box-shadow: var(--sh-2); font-size: var(--fs-xs); font-weight: 500; line-height: 1.4; white-space: normal; opacity: 0; pointer-events: none; transition: opacity var(--dur-fast) var(--ease); }
    .aa-tip:hover .aa-tipbox, .aa-tip:focus-within .aa-tipbox, .aa-tip.is-open .aa-tipbox { opacity: 1; }
    .aa-tip .btn[disabled] { pointer-events: none; }
    .aa-item { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: var(--sp-3); align-items: start; padding: var(--sp-3) 0; border-bottom: 1px solid var(--border); }
    .aa-item:last-child { border-bottom: 0; }
    .aa-item .imgph { width: 48px; height: 48px; border-radius: var(--r-sm); }
    .aa-item .imgph svg.lucide { width: 22px; height: 22px; }
    .aa-item-r { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); align-items: center; justify-content: space-between; }
    .aa-ship { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); align-items: center; padding: var(--sp-3) var(--sp-4); background: var(--surface-2); border-radius: var(--r-md); font-size: var(--fs-sm); }
    .aa-rv { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1024px) { .aa-rv { grid-template-columns: 320px minmax(0, 1fr); } }
    .aa-q { display: flex; flex-direction: column; }
    .aa-q > a { display: flex; flex-direction: column; gap: 4px; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); color: inherit !important; text-decoration: none !important; }
    .aa-q > a:last-child { border-bottom: 0; }
    .aa-q > a:hover { background: var(--surface-2); }
    .aa-q > a.is-active { background: var(--brand-soft); box-shadow: inset 3px 0 0 var(--brand); }
    .aa-cmp { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .aa-cmp { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
    .aa-cmp .kv dd.aa-diff { background: var(--warning-soft); border-radius: var(--r-xs); padding: 0 4px; }
    .aa-imgs { display: grid; gap: var(--sp-2); grid-template-columns: repeat(5, minmax(0, 1fr)); }
    .aa-imgs figure { position: relative; display: flex; flex-direction: column; gap: 4px; }
    .aa-imgs figure.is-bad .imgph { box-shadow: 0 0 0 2px var(--danger); }
    .aa-imgs figcaption { font-size: var(--fs-2xs); color: var(--text-3); }
    .aa-imgs figure.is-bad figcaption { color: var(--danger); font-weight: 700; }
    .aa-chk { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: var(--sp-3); padding: var(--sp-3) 0; border-bottom: 1px solid var(--border); }
    .aa-chk:last-child { border-bottom: 0; }
    .aa-chk > svg.lucide { margin-top: 2px; }
    .aa-chk.t-danger > svg.lucide { color: var(--danger); }
    .aa-chk.t-warning > svg.lucide { color: var(--warning); }
    .aa-chk.t-success > svg.lucide { color: var(--success); }
    .aa-mark { background: var(--danger-soft); color: var(--danger); padding: 0 3px; border-radius: 3px; font-weight: 600; }
    .aa-tree { display: flex; flex-direction: column; gap: 1px; }
    .aa-tn { display: flex; align-items: center; gap: var(--sp-2); min-height: 40px; padding: 0 var(--sp-2) 0 calc(var(--sp-2) + var(--lvl, 0) * 22px); border-radius: var(--r-sm); font-size: var(--fs-sm); color: var(--text) !important; text-decoration: none !important; }
    .aa-tn:hover { background: var(--surface-2); }
    .aa-tn.is-active { background: var(--brand-soft); color: var(--brand-text) !important; font-weight: 700; }
    .aa-tn .tg { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 0; background: none; border-radius: var(--r-xs); color: var(--text-3); cursor: pointer; padding: 0; flex: none; }
    .aa-tn .tg.sp { visibility: hidden; }
    .aa-tn .cnt { margin-left: auto; font-size: var(--fs-xs); color: var(--text-3); font-variant-numeric: tabular-nums; }
    .aa-tn.is-muted .nm { color: var(--text-3); }
    .aa-ed .input, .aa-ed .select { min-height: 36px; height: 36px; font-size: var(--fs-sm); min-width: 120px; }
    .aa-perf { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .aa-perf { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @container app (min-width: 1280px) { .aa-perf { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .aa-metric { display: flex; flex-direction: column; gap: 6px; padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border); border-radius: var(--r-md); }
    .aa-metric .v { font-size: var(--fs-xl); font-weight: 700; font-variant-numeric: tabular-nums; }
    .aa-sec { display: flex; flex-direction: column; gap: var(--sp-2); }
    .aa-sec + .aa-sec { padding-top: var(--sp-4); border-top: 1px solid var(--border); }
    .aa-note { padding: var(--sp-3); border-radius: var(--r-md); background: var(--surface-2); display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); }
    .aa-doc { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-md); font-size: var(--fs-sm); }
    .aa-doc > svg.lucide { color: var(--text-3); }
    .aa-preview { border: 1px dashed var(--border-strong); border-radius: var(--r-md); padding: var(--sp-3) var(--sp-4); background: var(--surface-2); }
    .aa-carrier { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 1024px) { .aa-carrier { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .aa-2 { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1024px) { .aa-2 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
    .aa-lines .input { min-height: 36px; height: 36px; width: 84px; font-size: var(--fs-sm); text-align: right; }
    .aa-rf { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-2) var(--sp-3); align-items: center; padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-md); }
    .aa-rf.is-selected { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
    .aa-rf.is-disabled { background: var(--surface-2); }
    @container app (min-width: 768px) { .aa-rf { grid-template-columns: minmax(0, 1fr) 150px; } }
    .aa-rf .input-group { min-height: 38px; }
    .aa-rf .input-group .input { height: 36px; }
  `);

  /* ---------------- Shared helpers ---------------- */
  const S = Object.assign({}, D.sellers, {
    lumen: { id: 'lumen', name: 'Lumen Cycle Co.', initials: 'LC', tint: 'var(--img-5)', location: 'Bend, OR', verified: false },
    fernhill: { id: 'fernhill', name: 'Fernhill Tea Co.', initials: 'FT', tint: 'var(--img-3)', location: 'Seattle, WA', verified: false },
    bolt: { id: 'bolt', name: 'Bolt Street Supply', initials: 'BS', tint: 'var(--img-4)', location: 'Newark, NJ', verified: false },
    harbor: { id: 'harbor', name: 'Harbor & Pine', initials: 'HP', tint: 'var(--img-1)', location: 'Portland, ME', verified: true },
    oldmill: { id: 'oldmill', name: 'Old Mill Goods', initials: 'OM', tint: 'var(--img-2)', location: 'Lancaster, PA', verified: false },
  });
  const P = D.P;
  const sname = (sid) => S[sid].name;
  const lt = (sid, sm) => U.logoTile(S[sid], 'aa-lt' + (sm ? ' sm' : ''));
  const sellerCell = (sid, sub) => `<span class="row nowrap gap-2">${lt(sid)}<span class="stack gap-0"><span class="small strong nowrap">${S[sid].name}</span><span class="xs muted nowrap">${sub || (S[sid].official ? 'Official Store' : 'Marketplace seller')}</span></span></span>`;
  const oref = (r, st) => `<a class="mono strong nowrap" href="${U.go('admin/order', st)}">${r}</a>`;
  const mono = (t) => `<span class="mono nowrap">${t}</span>`;
  const flt = (id, label, options, value) => U.field(label, U.select(id, options, value)).replace('class="field"', 'class="field aa-flt"');
  const fltIn = (id, label, value, ph) => U.field(label, U.input(id, value, { placeholder: ph })).replace('class="field"', 'class="field aa-flt"');
  const flags = (arr) => arr.length ? `<span class="aa-flags">${arr.map(([t, tone, ic]) => U.badge(t, tone, ic || (tone === 'danger' ? 'circle-alert' : tone === 'warning' ? 'triangle-alert' : 'info'))).join('')}</span>` : '<span class="xs muted">None</span>';
  const rowTone = (arr) => arr.some((f) => f[1] === 'danger') ? 'is-flagged' : arr.some((f) => f[1] === 'warning') ? 'is-warn' : '';
  const tip = (control, text, open) => `<span class="aa-tip${open ? ' is-open' : ''}" tabindex="0">${control}<span class="aa-tipbox" role="tooltip">${text}</span></span>`;
  const thumb = (pid) => U.pimg(P[pid], 'tiny');
  const pct = (n, d = 1) => n.toFixed(d) + '%';
  const meterRow = (label, val, target, pctv, tone, note) => `<div class="aa-metric"><span class="xs strong muted">${label}</span><span class="row between base"><span class="v">${val}</span><span class="xs muted">Target ${target}</span></span>${U.meter(pctv, tone)}<span class="xs ${tone === 'danger' ? 't-danger-text strong' : tone === 'warning' ? 't-warning-text strong' : 'muted'}">${note}</span></div>`;

  /* ======================================================================
     1. admin/orders
     ====================================================================== */
  const ORDERS = [
    { ref: 'MK-261008-12210', placed: 'Oct 8, 9:31 AM', cust: 'Olivia Bennett', city: 'Denver, CO', sellers: ['official'], items: 1, total: 42.00, pay: 'Failed', ful: 'Pending', fnote: 'Waiting for payment retry', flags: [['Payment failed', 'danger']] },
    { ref: 'MK-261008-12077', placed: 'Oct 8, 9:14 AM', cust: 'Sam Rivera', city: 'Seattle, WA', sellers: ['northwind'], items: 2, total: 118.00, pay: 'Captured', ful: 'New', fnote: 'Dispatch due today 5:00 PM', flags: [] },
    { ref: 'MK-261008-11950', placed: 'Oct 8, 8:40 AM', cust: 'Hannah Moore', city: 'Austin, TX', sellers: ['official', 'trailhead'], items: 3, total: 214.50, pay: 'Checking', fnote: 'Held until payment confirms', ful: 'Confirmed', flags: [['Payment checking', 'warning']] },
    { ref: 'MK-261007-10433', placed: 'Oct 7, 6:48 PM', cust: 'Alex Morgan', city: 'Boise, ID', sellers: ['northwind'], items: 1, total: 59.00, pay: 'Captured', ful: 'Overdue', fnote: 'Dispatch overdue 3 h', flags: [['Overdue dispatch', 'danger']], od: 'Overdue 3 h' },
    { ref: 'MK-261007-10120', placed: 'Oct 7, 3:22 PM', cust: 'Priya Kapoor', city: 'San Jose, CA', sellers: ['official'], items: 1, total: 329.00, pay: 'Captured', ful: 'Preparing', fnote: 'Dispatch due in 1 h', flags: [['Due soon', 'warning', 'clock']] },
    { ref: 'MK-261006-09977', placed: 'Oct 6, 1:05 PM', cust: 'Marcus Webb', city: 'Tucson, AZ', sellers: ['gadgetgrove', 'official'], items: 2, total: 337.00, pay: 'Captured', ful: 'Partly delivered', fnote: '1 of 2 packages overdue', flags: [['Overdue dispatch', 'danger'], ['Seller restricted', 'warning']], od: 'Overdue 1 d' },
    { ref: 'MK-261006-09812', placed: 'Oct 6, 10:47 AM', cust: 'Elena Ruiz', city: 'Fresno, CA', sellers: ['casaverde'], items: 2, total: 155.00, pay: 'Captured', ful: 'Cancellation requested', fnote: 'Customer asked to cancel 1 item', flags: [['Cancellation requested', 'warning']] },
    { ref: 'MK-261005-08841', placed: 'Oct 5, 4:30 PM', cust: 'Tom Becker', city: 'Chicago, IL', sellers: ['pixelport', 'trailhead'], items: 3, total: 233.48, pay: 'Partly refunded', ful: 'Partly delivered', fnote: '1 of 2 packages delivered', flags: [] },
    { ref: 'MK-260914-48213', placed: 'Sep 14, 7:42 PM', cust: 'Jordan Lee', city: 'Portland, OR', sellers: ['official', 'pixelport', 'casaverde'], items: 4, total: 513.98, pay: 'Captured', ful: 'Partly delivered', fnote: '1 of 3 packages delivered', flags: [['Overdue dispatch', 'danger'], ['Return requested', 'warning'], ['Case open', 'info']], od: 'Overdue 16 d' },
    { ref: 'MK-261004-07730', placed: 'Oct 4, 11:02 AM', cust: 'Grace Wu', city: 'Sacramento, CA', sellers: ['official'], items: 1, total: 58.00, pay: 'Captured', ful: 'Delivered', fnote: 'Delivered Oct 7', flags: [] },
    { ref: 'MK-261003-06612', placed: 'Oct 3, 8:19 PM', cust: 'Daniel Kim', city: 'Reno, NV', sellers: ['trailhead'], items: 1, total: 139.00, pay: 'Refunded', ful: 'Cancelled', fnote: 'Seller could not fulfil', flags: [] },
  ];
  const OVERDUE_EXTRA = [
    { ref: 'MK-261007-10388', placed: 'Oct 7, 1:12 PM', cust: 'Zoe Adams', city: 'Eugene, OR', sellers: ['official'], items: 1, total: 36.00, pay: 'Captured', ful: 'Overdue', fnote: 'Warehouse short 1 unit', flags: [['Overdue dispatch', 'danger']], od: 'Overdue 1 h' },
    { ref: 'MK-261006-09544', placed: 'Oct 6, 9:40 AM', cust: 'Ryan Patel', city: 'Provo, UT', sellers: ['trailhead'], items: 1, total: 45.00, pay: 'Captured', ful: 'Overdue', fnote: 'No tracking received', flags: [['Overdue dispatch', 'danger']], od: 'Overdue 6 h' },
    { ref: 'MK-261006-09311', placed: 'Oct 6, 8:02 AM', cust: 'Mia Lopez', city: 'Mesa, AZ', sellers: ['gadgetgrove'], items: 1, total: 279.00, pay: 'Captured', ful: 'Overdue', fnote: 'Seller has not confirmed', flags: [['Overdue dispatch', 'danger'], ['Seller restricted', 'warning']], od: 'Overdue 1 d' },
    { ref: 'MK-261005-08702', placed: 'Oct 5, 6:55 PM', cust: 'Noah Fischer', city: 'Dallas, TX', sellers: ['pixelport'], items: 2, total: 188.98, pay: 'Captured', ful: 'Overdue', fnote: 'Label created, no carrier scan', flags: [['Overdue dispatch', 'danger']], od: 'Overdue 5 h' },
    { ref: 'MK-261005-08455', placed: 'Oct 5, 2:21 PM', cust: 'Ava Thompson', city: 'Oakland, CA', sellers: ['casaverde'], items: 1, total: 119.00, pay: 'Captured', ful: 'Overdue', fnote: 'Seller reported supplier delay', flags: [['Overdue dispatch', 'danger']], od: 'Overdue 2 d' },
    { ref: 'MK-261004-07981', placed: 'Oct 4, 5:47 PM', cust: 'Liam Brooks', city: 'Phoenix, AZ', sellers: ['gadgetgrove', 'northwind'], items: 2, total: 243.00, pay: 'Captured', ful: 'Partly delivered', fnote: 'Gadget Grove package overdue', flags: [['Overdue dispatch', 'danger']], od: 'Overdue 2 d' },
  ];
  const ODOWN = { official: 'Ana Silva · Warehouse', northwind: 'Seller', trailhead: 'Seller', gadgetgrove: 'Grace Kim', pixelport: 'Seller', casaverde: 'Grace Kim' };

  const sellerNames = (o) => `<span class="stack gap-0"><span class="small strong">${o.sellers.length} seller${o.sellers.length > 1 ? 's' : ''}</span><span class="xs muted">${o.sellers.map(sname).join(', ')}</span></span>`;
  const fulCell = (o) => `<span class="stack gap-1">${U.status(o.ful)}<span class="xs muted">${o.fnote}</span></span>`;

  function ordersTable(rows, overdue) {
    const cols = overdue
      ? ['Order', 'Placed', 'Customer', 'Sellers', { label: 'Total', cls: 'r' }, 'Fulfilment', 'Late by', 'Owner', 'Flags', '']
      : ['Order', 'Placed', 'Customer', 'Sellers', { label: 'Items', cls: 'r' }, { label: 'Total', cls: 'r' }, 'Payment', 'Fulfilment', 'Flags'];
    const body = rows.map((o) => overdue
      ? [oref(o.ref), `<span class="small nowrap">${o.placed}</span>`, `<span class="stack gap-0"><span class="small strong nowrap">${o.cust}</span><span class="xs muted">${o.city}</span></span>`, sellerNames(o), `<span class="strong">${U.money(o.total)}</span>`, fulCell(o), U.deadline(o.od, 'danger'), `<span class="small nowrap">${ODOWN[o.sellers[0]]}</span>`, flags(o.flags), U.btn('Remind seller', { v: 'ghost', size: 'sm', icon: 'bell' })]
      : [oref(o.ref), `<span class="small nowrap">${o.placed}</span>`, `<span class="stack gap-0"><span class="small strong nowrap">${o.cust}</span><span class="xs muted">${o.city}</span></span>`, sellerNames(o), o.items, `<span class="strong">${U.money(o.total)}</span>`, U.status(o.pay), fulCell(o), flags(o.flags)]);
    return U.table(cols, body, { select: true, rowCls: rows.map((o) => rowTone(o.flags)) });
  }
  function ordersCards(rows, overdue) {
    return `<div class="aa-mlist">${rows.map((o) => `<a class="aa-mcard ${rowTone(o.flags)}" href="${U.go('admin/order')}">
      <span class="row between"><span class="mono strong">${o.ref}</span><span class="strong num">${U.money(o.total)}</span></span>
      <span class="xs muted">${o.placed} · ${o.cust} · ${o.items} item${o.items > 1 ? 's' : ''}</span>
      <span class="row gap-2">${o.sellers.map((s) => `<span class="row nowrap gap-1 xs">${lt(s, true)}${sname(s)}</span>`).join('')}</span>
      <span class="row gap-2">${U.status(o.pay)}${U.status(o.ful)}${overdue ? U.deadline(o.od, 'danger') : ''}</span>
      ${o.flags.length ? flags(o.flags) : ''}
    </a>`).join('')}</div>`;
  }

  U.register({
    id: 'admin/orders', title: 'All orders', ref: 'Plan ch. 12, 18',
    notes: 'One list for company and seller orders with saved filters, seller-type filters and an authorized, logged export. Payment and fulfilment are separate columns, and flags surface overdue dispatch, payment checks and cancellation requests.',
    states: ['All orders', 'Overdue dispatch'],
    render: (state) => {
      const overdue = state === 'Overdue dispatch';
      const rows = overdue ? ORDERS.filter((o) => o.od).concat(OVERDUE_EXTRA) : ORDERS;
      const saved = [
        { label: 'Overdue dispatch · 9', icon: 'alarm-clock', href: U.go('admin/orders', 'Overdue dispatch'), active: overdue },
        { label: 'Partly delivered · 41', icon: 'package-open' },
        { label: 'Payment checking · 3', icon: 'hourglass' },
        { label: 'Cancellation requested · 6', icon: 'circle-x' },
        { label: 'Save current filters', icon: 'bookmark-plus' },
      ];
      return U.adminLayout(`
        ${U.pageHead(overdue ? 'Orders · Overdue dispatch' : 'Orders', {
          crumbs: [{ label: 'Commerce' }, { label: 'Orders', href: U.go('admin/orders') }],
          sub: overdue ? 'Saved filter · items past their dispatch deadline · sellers and customers already notified' : 'Company and marketplace seller orders · 3,418 in the last 7 days · times in PT',
          actions: tip(U.btn('Export CSV', { v: 'secondary', icon: 'download', size: 'sm' }), 'Exports are logged in Action history with your name. Customer phone numbers are masked unless your role allows them.') + U.btn('Open dispatch queue', { v: 'secondary', icon: 'truck', size: 'sm', href: U.go('ops/dispatch') }),
        })}

        <div class="stack gap-2">
          <span class="xs strong muted">Saved filters</span>
          ${U.chips(saved)}
        </div>

        ${overdue ? U.alert('danger', '9 orders have items past their dispatch deadline', 'Overdue tasks were created automatically. Each seller got a reminder and each customer got an update with a way to contact support. Escalate to Grace Kim (Seller Manager) when a seller misses a second deadline.') : ''}

        <section class="card">
          <div class="card-body">
            <div class="toolbar">${U.searchIn('Search by order ref, customer, email or tracking number', 'aa-o-q')}${U.btn('More filters', { v: 'ghost', size: 'sm', icon: 'sliders-horizontal' })}</div>
            <div class="aa-filters">
              ${flt('aa-o-type', 'Seller type', ['All sellers', 'Official Store', 'Marketplace sellers'], 'All sellers')}
              ${flt('aa-o-seller', 'Seller', ['Any seller', 'Marketly Official', 'Northwind Audio', 'Pixel & Port', 'Casa Verde Home', 'Trailhead Outfitters', 'Gadget Grove'], 'Any seller')}
              ${flt('aa-o-status', 'Fulfilment status', ['Any status', 'New', 'Preparing', 'Overdue', 'Shipped', 'Partly delivered', 'Delivered', 'Cancellation requested', 'Cancelled'], overdue ? 'Overdue' : 'Any status')}
              ${flt('aa-o-pay', 'Payment status', ['Any payment', 'Captured', 'Checking', 'Failed', 'Partly refunded', 'Refunded'], 'Any payment')}
              ${flt('aa-o-date', 'Placed', ['Last 7 days', 'Today', 'Last 30 days', 'Custom range'], overdue ? 'Last 30 days' : 'Last 7 days')}
              ${flt('aa-o-flag', 'Flag', ['Any flag', 'Overdue dispatch', 'Payment checking', 'Cancellation requested', 'Return requested', 'Seller restricted'], overdue ? 'Overdue dispatch' : 'Any flag')}
            </div>
            ${overdue ? `<div class="row gap-2">${U.chips([{ label: 'Status: Overdue', x: true }, { label: 'Flag: Overdue dispatch', x: true }, { label: 'Last 30 days', x: true }])}<a class="small strong" href="${U.go('admin/orders')}">Clear all</a></div>` : ''}
          </div>
          ${overdue ? `<div style="padding:0 var(--sp-4) var(--sp-3)"><div class="bulk-bar"><span>3 selected</span><span class="grow"></span>${U.btn('Remind sellers', { v: 'ghost', icon: 'bell' })}${U.btn('Assign owner', { v: 'ghost', icon: 'user-plus' })}${U.btn('Escalate to Seller Manager', { v: 'ghost', icon: 'arrow-up-right' })}</div></div>` : ''}
          <div class="no-phone">${ordersTable(rows, overdue)}</div>
          <div class="only-phone" style="padding:0 var(--sp-4) var(--sp-4)">${ordersCards(rows, overdue)}</div>
          <div class="card-foot" style="justify-content:space-between"><span class="xs muted">Showing 1–${rows.length} of ${overdue ? '9' : '3,418'} · Flags update every 5 minutes</span>${overdue ? '' : U.pager(1, 342)}</div>
        </section>
      `, 'orders');
    },
  });

  /* ======================================================================
     2. admin/order — MK-260914-48213
     ====================================================================== */
  const O = D.order;
  const SHARE = { aurora: 7.08, pourover: 1.35, ssd1tb: 7.11, duvet: 4.46 }; // WELCOME20 allocation by item value
  const lineTotal = (it) => it.price * it.qty;
  const paid = (it) => lineTotal(it) - SHARE[it.p];
  const ITEM_EXTRA = {
    aurora: { refund: 'None', note: 'Delivered Sep 17 · return window open until Oct 17' },
    pourover: { refund: 'Under review', note: `Return ${'RT-261006-0193'} · arrived chipped · refund without return proposed` },
    ssd1tb: { refund: 'None', note: 'In transit · USPS last scan Oct 7, Memphis, TN' },
    duvet: { refund: 'None', note: 'Not shipped · dispatch was due Sep 22 · seller promises Oct 12 · eligible to cancel' },
  };
  const GROUP_EXTRA = [
    { deadline: 'Dispatched Sep 15, 10:12 AM · on time', tone: 'ok', shipped: 'Sep 15' },
    { deadline: 'Dispatched Oct 6, 4:40 PM · on time after backorder notice', tone: 'ok', shipped: 'Oct 6' },
    { deadline: 'Dispatch deadline Sep 22 · overdue 16 days', tone: 'danger', shipped: null },
  ];

  function orderGroup(g, gi) {
    const s = S[g.seller], x = GROUP_EXTRA[gi];
    const sub = g.items.reduce((a, it) => a + lineTotal(it), 0);
    return U.card({
      title: `<span class="row gap-2">${lt(g.seller)}<span>${s.name}</span>${U.sellerBadge(s, true)}</span>`,
      sub: `${g.pkg} · ${s.official ? 'Shipped by Marketly warehouse, Reno, NV' : 'Seller ships · ' + s.location} · items ${U.money(sub)}`,
      actions: U.status(g.status),
      body: `${g.items.map((it) => { const p = P[it.p], e = ITEM_EXTRA[it.p]; return `<div class="aa-item">${U.pimg(p)}<div class="stack gap-1">
          <a class="small strong" href="${U.go('admin/catalog')}">${p.name}</a>
          <span class="xs muted">${it.variant} · SKU <span class="mono">${p.sku}</span> · Qty ${it.qty} · ${U.money(it.price)} each</span>
          <div class="aa-item-r"><span class="row gap-2">${U.status(it.state)}${e.refund !== 'None' ? `<span class="xs muted">Refund</span>${U.status(e.refund)}` : ''}</span><span class="small num"><span class="muted xs">Paid after coupon </span><b>${U.money(paid(it))}</b></span></div>
          <span class="xs sub">${e.note}</span>
        </div></div>`; }).join('')}
        <div class="aa-ship">${U.icon('truck', 'ic-sm')}<span class="strong">${g.carrier === '—' ? 'No shipment yet' : g.carrier}</span>${g.tracking ? `<span class="mono">${g.tracking}</span>` : '<span class="muted">No tracking number</span>'}<span class="muted">${g.eta}</span><span class="grow"></span>${U.deadline(x.deadline, x.tone)}</div>`,
      foot: g.seller === 'casaverde'
        ? `${U.btn('Contact seller', { v: 'secondary', size: 'sm', icon: 'message-square' })}${U.btn('Cancel item', { v: 'danger-soft', size: 'sm', icon: 'circle-x' })}`
        : g.tracking ? `${U.btn('Shipment history', { v: 'ghost', size: 'sm', icon: 'history' })}${U.btn('Correct tracking', { v: 'ghost', size: 'sm', icon: 'pencil' })}` : '',
    });
  }

  const orderTimeline = () => U.timeline([
    { t: 'Overdue dispatch escalated to Casa Verde Home', d: 'Oct 8, 9:02 AM · Grace Kim, Seller Manager', state: 'warn', body: 'Reason: 16 days past dispatch deadline. Seller reports a supplier delay and promises dispatch by Oct 12. Customer updated.' },
    { t: 'Support case CS-261007-0412 opened', d: 'Oct 7, 4:18 PM · Isabel Cruz, Customer Support', state: 'current', body: 'Reason: customer asked when the duvet cover will ship and whether they can cancel it.' },
    { t: 'Return RT-261006-0193 requested for Pour-over Coffee Set', d: 'Oct 6, 11:20 AM · Customer', body: 'Reason given: arrived chipped. 3 photos attached.' },
    { t: 'Package 2 dispatched by Pixel & Port', d: 'Oct 6, 4:40 PM · Seller', state: 'done', body: 'USPS Priority, 9405 5112 9830 1847 2290 31.' },
    { t: 'Overdue task created for Package 3', d: 'Sep 23, 8:00 AM · System', state: 'warn', body: 'Seller reminded. Customer notified with new estimate and a link to contact support.' },
    { t: 'Package 1 delivered', d: 'Sep 17, 2:41 PM · UPS', state: 'done' },
    { t: 'Package 1 dispatched', d: 'Sep 15, 10:12 AM · Ana Silva, Warehouse', state: 'done' },
    { t: 'Payment captured and order accepted', d: 'Sep 14, 7:42 PM · System', state: 'done', body: `${U.money(O.total)} on Visa •••• 4417. Purchase snapshots saved for 4 items.` },
  ]);

  function refundModal() {
    const row = (pid, sel, o) => { const it = O.groups.flatMap((g) => g.items.map((i) => Object.assign({ seller: g.seller }, i))).find((i) => i.p === pid); const p = P[pid]; const max = paid(it);
      return `<div class="aa-rf${sel ? ' is-selected' : ''}${o.disabled ? ' is-disabled' : ''}">
        <div class="row nowrap top gap-3">
          <input type="checkbox" id="aa-rf-${pid}" aria-label="Refund ${U.esc(p.name)}"${sel ? ' checked' : ''}${o.disabled ? ' disabled' : ''} style="width:18px;height:18px;margin-top:2px;accent-color:var(--brand)">
          ${U.pimg(p, 'tiny')}
          <label class="stack gap-0" for="aa-rf-${pid}" style="min-width:0"><span class="small strong">${p.name}</span><span class="xs muted">${sname(it.seller)} · ${it.variant} · ${U.status(it.state)}</span><span class="xs ${o.disabled ? 't-warning-text strong' : 'sub'}">${o.note}</span></label>
        </div>
        ${o.disabled ? `<span class="xs muted">Refundable remaining ${U.money(max)}</span>` : U.field(`Amount <span class="xs muted">· up to ${U.money(max)}</span>`, U.input('aa-rf-amt-' + pid, sel ? max.toFixed(2) : '', { prefix: '$' }))}
      </div>`; };
    const total = paid({ p: 'pourover', price: 36, qty: 1 }) + paid({ p: 'duvet', price: 119, qty: 1 });
    return U.modal({
      title: 'Issue refund · MK-260914-48213', size: 'lg',
      body: `
        <div class="row between small"><span class="sub">Customer paid ${U.money(O.total)} · refunded so far ${U.money(0)}</span><span class="strong">Remaining refundable ${U.money(O.total)}</span></div>
        <div class="stack gap-2">
          <span class="label">Items and amounts</span>
          ${row('pourover', true, { note: 'Return RT-261006-0193 · refund without return (exception)' })}
          ${row('duvet', true, { note: 'Not shipped · this also cancels the item and closes the overdue task' })}
          ${row('aurora', false, { note: 'Delivered · return window open until Oct 17' })}
          ${row('ssd1tb', false, { disabled: true, note: 'In transit · refund after delivery or after the carrier confirms a loss' })}
        </div>
        ${U.alert('info', 'Over-refund check', 'Amounts are capped at what is still refundable per item, after the coupon share. A second refund for the same item and reason is blocked. Shipping was free, so there is no shipping to refund.')}
        <div class="grid md2" style="--gap:12px">
          ${U.field('Reason', U.select('aa-rf-reason', ['Choose a reason', 'Damaged on arrival, refund without return', 'Seller cannot fulfil', 'Late delivery', 'Goodwill'], 'Seller cannot fulfil'), { hint: 'Each item keeps its own reason in the record.' })}
          ${U.field('Refund to', U.select('aa-rf-dest', ['Original payment · Visa •••• 4417', 'Store credit'], 'Original payment · Visa •••• 4417'), { hint: 'Card refunds usually arrive 3–5 business days after we send them.' })}
        </div>
        ${U.field('Note for the record', U.textarea('aa-rf-note', 'Pour-over: chip visible in 3 customer photos, return shipping costs more than the item (Lena Park recommendation). Duvet: 16 days overdue, customer asked to cancel in CS-261007-0412.'), { hint: 'Required. Shown in Action history and to Finance.' })}
        <div class="stack gap-2">
          <span class="label">Effect on seller earnings and fees</span>
          ${U.table(['Seller', { label: 'Refund', cls: 'r' }, { label: 'Seller earnings', cls: 'r' }, { label: 'Marketplace fee', cls: 'r' }, { label: 'Coupon (platform-funded)', cls: 'r' }], [
            [sellerCell('official'), U.money(34.65), '<span class="xs muted">Company sales −$36.00</span>', '<span class="muted">Not charged</span>', U.money(1.35)],
            [sellerCell('casaverde'), U.money(114.54), '−' + U.money(107.10), '−' + U.money(11.90) + ' reversed', U.money(4.46)],
          ])}
          <span class="xs muted">Example fee: 10% of item price after seller-funded discounts, excluding shipping. Final fees are in the seller agreement. Platform-funded coupon shares are returned to the WELCOME20 budget and never charged to sellers.</span>
        </div>
        <div class="well stack gap-2">
          <div class="row between"><span class="strong">Refund total</span><span class="h3 num">${U.money(total)}</span></div>
          ${U.sumRow('Approval route', 'Finance Manager · Priya Nair')}
          ${U.sumRow('Your refund authority', 'None · Platform Administrator role')}
          ${U.sumRow('Finance limit', 'Up to $2,000.00 · one approval')}
          <span class="xs muted">Refunds above $2,000.00 also need a second Finance reviewer. The customer sees "Refund requested" until Finance sends it; approval is not money arrived.</span>
        </div>`,
      foot: `${U.btn('Cancel', { v: 'ghost' })}${U.btn('Send ' + U.money(total) + ' to Finance for approval', { icon: 'send' })}`,
    });
  }

  U.register({
    id: 'admin/order', title: 'Order detail (admin)', ref: 'Plan ch. 12, 13, 14, 18',
    notes: 'Admin view of a three-seller order: item-level states per seller group and package, coupon funding by source, refunds per item, staff history with reasons and internal notes. The refund dialog caps amounts at what is still refundable, shows the effect on seller earnings and fees, and routes the money decision to Finance within its limit.',
    states: ['Overview', 'Issue refund'],
    render: (state) => {
      const g = O.groups;
      const page = U.adminLayout(`
        ${U.pageHead(`Order <span class="mono">${O.ref}</span>`, {
          crumbs: [{ label: 'Commerce' }, { label: 'Orders', href: U.go('admin/orders') }, { label: O.ref }],
          sub: `Placed ${O.placed} PT · 3 sellers · 3 packages · ${U.status(O.status)} ${U.status('Captured')}`,
          actions: `${U.btn('Cancel items', { v: 'secondary', size: 'sm', icon: 'circle-x' })}${U.btn('Issue refund', { v: 'secondary', size: 'sm', icon: 'undo-2', href: U.go('admin/order', 'Issue refund') })}${U.btn('Contact seller', { v: 'secondary', size: 'sm', icon: 'message-square' })}${U.btn('Open case', { size: 'sm', icon: 'life-buoy', href: U.go('admin/case') })}`,
        })}
        ${U.alert('danger', 'Package 3 is 16 days past its dispatch deadline', 'Casa Verde Home has not shipped the duvet cover. Case CS-261007-0412 is open with Isabel Cruz. Grace Kim set a final date of Oct 12; after that, cancel the item and refund it in full.')}

        <div class="aa-split">
          <div class="stack gap-5">
            ${g.map(orderGroup).join('')}

            ${U.card({
              title: 'Cancellations and refunds', sub: 'Tracked per item · nothing refunded yet',
              flush: true,
              body: U.table(['Item', 'Seller', 'Request', { label: 'Amount', cls: 'r' }, 'Status', 'Owner'], [
                [`<span class="row nowrap gap-2">${thumb('pourover')}<span class="small">Pour-over Coffee Set</span></span>`, 'Marketly Official', `Return <a class="mono" href="${U.go('admin/returns')}">RT-261006-0193</a><br><span class="xs muted">Refund without return proposed</span>`, U.money(34.65), `<span class="stack gap-1">${U.status('Return requested')}${U.status('Under review')}</span>`, 'Lena Park'],
                [`<span class="row nowrap gap-2">${thumb('duvet')}<span class="small">Linen Duvet Cover</span></span>`, 'Casa Verde Home', 'Cancellation eligible<br><span class="xs muted">Customer asked in CS-261007-0412</span>', U.money(114.54), U.status('Delayed'), 'Grace Kim'],
                [`<span class="row nowrap gap-2">${thumb('aurora')}<span class="small">Aurora ANC Headphones</span></span>`, 'Marketly Official', '<span class="muted">None</span>', '<span class="muted">—</span>', U.status('Delivered'), '<span class="muted">—</span>'],
                [`<span class="row nowrap gap-2">${thumb('ssd1tb')}<span class="small">1 TB Portable SSD × 2</span></span>`, 'Pixel & Port', '<span class="muted">None</span>', '<span class="muted">—</span>', U.status('In transit'), '<span class="muted">—</span>'],
              ], { rowCls: ['is-warn', 'is-flagged', '', ''] }),
            })}

            ${U.card({
              title: 'Coupon funding and money by seller', sub: 'WELCOME20 · −$20.00 · allocated by item value',
              flush: true,
              body: `${U.table(['Seller group', { label: 'Items', cls: 'r' }, { label: 'Platform-funded', cls: 'r' }, { label: 'Seller-funded', cls: 'r' }, { label: 'Customer paid', cls: 'r' }, { label: 'Marketplace fee', cls: 'r' }, { label: 'Seller earnings', cls: 'r' }], [
                  [sellerCell('official'), U.money(225), U.money(8.43), U.money(0), U.money(216.57), '<span class="muted">—</span>', '<span class="xs muted">Company sales</span>'],
                  [sellerCell('pixelport'), U.money(189.98), U.money(7.11), U.money(0), U.money(182.87), U.money(19.00), U.money(170.98)],
                  [sellerCell('casaverde'), U.money(119), U.money(4.46), U.money(0), U.money(114.54), U.money(11.90), U.money(107.10)],
                  ['<span class="strong">Order</span>', `<span class="strong">${U.money(O.subtotal)}</span>`, `<span class="strong">${U.money(20)}</span>`, `<span class="strong">${U.money(0)}</span>`, `<span class="strong">${U.money(O.total)}</span>`, `<span class="strong">${U.money(30.90)}</span>`, `<span class="strong">${U.money(278.08)}</span>`],
                ])}
                <div class="card-body" style="padding-top:0"><span class="xs muted">Pixel &amp; Port's markdown on the SSD (was $119.99) is seller-funded and already in the item price. Example fee: 10% of item price after seller-funded discounts, excluding shipping. Final fees are in the seller agreement.</span></div>`,
            })}

            ${U.card({ title: 'Action history', sub: 'Every change with staff name and reason', actions: `<a class="small strong" href="${U.go('admin/audit')}">Full log</a>`, body: orderTimeline() })}
          </div>

          <div class="stack gap-5">
            ${U.card({
              title: 'Customer', actions: `<a class="small strong" href="${U.go('admin/customers')}">Profile</a>`,
              body: `<div class="row gap-3">${U.avatar(D.customer.name)}<div class="stack gap-0"><span class="strong">${D.customer.name}</span><span class="xs muted">Customer since ${D.customer.since} · 5 orders</span></div></div>
                ${U.kv([['Email', D.customer.email], ['Phone', D.customer.phone], ['Ship to', D.customer.addresses[0].line1 + ', ' + D.customer.addresses[0].city], ['Open cases', '<a href="' + U.go('admin/case') + '" class="mono">CS-261007-0412</a>']])}`,
            })}
            ${U.card({
              title: 'Payment', actions: U.status('Captured'),
              body: `${U.kv([['Method', 'Visa •••• 4417'], ['Authorized', 'Sep 14, 7:42 PM'], ['Captured', 'Sep 14, 7:42 PM'], ['Processor ref', '<span class="mono">ch_3PqK8e2L0dX41</span>']])}
                <div class="stack gap-2">${U.sumRow('Items', U.money(O.subtotal))}${U.sumRow('Coupon WELCOME20', '−' + U.money(O.discount), 'discount')}${U.sumRow('Shipping', 'Free')}${U.sumRow('Sales tax', U.money(0))}${U.sumRow('Captured', U.money(O.total), 'total')}${U.sumRow('Refunded', U.money(0))}</div>
                <span class="xs muted">Sales tax: Oregon has no sales tax.</span>`,
            })}
            ${U.card({
              title: 'Internal notes', sub: 'Staff only · never shown to customer or sellers',
              body: `<div class="aa-note"><span class="row between xs"><b>Grace Kim</b><span class="muted">Oct 8, 9:05 AM</span></span><span>Casa Verde confirmed restock arrives Oct 10. If the duvet is not shipped by Oct 12, cancel it and refund in full.</span></div>
                <div class="aa-note"><span class="row between xs"><b>Lena Park</b><span class="muted">Oct 6, 2:30 PM</span></span><span>Chip clearly visible in photos. Low value and fragile. Recommend refund without return.</span></div>
                ${U.field('Add a note', U.textarea('aa-od-note', '', 'Write a note for the team'))}${U.btn('Save note', { v: 'secondary', size: 'sm' })}`,
            })}
          </div>
        </div>
      `, 'orders');
      return state === 'Issue refund' ? page + refundModal() : page;
    },
  });

  /* ======================================================================
     3. admin/returns
     ====================================================================== */
  const RETURNS = [
    { rt: 'RT-261006-0193', ord: 'MK-260914-48213', seller: 'official', reason: 'Damaged on arrival', item: 'Pour-over Coffee Set', amt: 34.65, owner: 'Lena Park', dl: ['Decide by Oct 9', 'warning'], rs: 'Return requested', fs: 'Under review', flags: [['Refund without return proposed', 'warning', 'file-warning']], exc: 'Proposed by Lena Park: fragile item, chip visible in 3 photos, return label costs more than the item.' },
    { rt: 'RT-261005-0187', ord: 'MK-261001-04410', seller: 'northwind', reason: 'Changed mind', item: 'Halden Pocket Speaker', amt: 59.00, owner: 'Northwind Audio', dl: ['Seller reply overdue 1 d', 'danger'], rs: 'Return requested', fs: null, flags: [['Seller missed deadline', 'danger']] },
    { rt: 'RT-261004-0179', ord: 'MK-260928-02215', seller: 'pixelport', reason: 'Not as described', item: 'Kestrel 1 TB Portable SSD', amt: 94.99, owner: 'Pixel & Port', dl: ['Arrives Oct 12', 'ok'], rs: 'Return in transit', fs: null, flags: [] },
    { rt: 'RT-261003-0172', ord: 'MK-260925-01987', seller: 'official', reason: 'Defective', item: 'Halden Aurora ANC Headphones', amt: 189.00, owner: 'Lena Park', dl: ['Inspect by Oct 9', 'warning'], rs: 'Inspecting', fs: 'Requested', flags: [] },
    { rt: 'RT-261001-0158', ord: 'MK-260919-00541', seller: 'gadgetgrove', reason: 'Defective', item: 'Brightline S2 Robot Vacuum', amt: 279.00, owner: 'Lena Park', dl: ['Label used by Oct 10', 'ok'], rs: 'Return approved', fs: null, flags: [['Platform took over', 'info', 'shield']] },
    { rt: 'RT-260929-0144', ord: 'MK-260917-00291', seller: 'official', reason: 'Changed mind', item: 'Aster Vitamin C Serum', amt: 24.00, owner: 'Lena Park', dl: ['Due back Oct 8', 'warning'], rs: 'Return in transit', fs: null, flags: [] },
    { rt: 'RT-260928-0139', ord: 'MK-260916-00188', seller: 'pixelport', reason: 'Wrong item sent', item: 'Kestrel K75 Keyboard', amt: 109.00, owner: 'Priya Nair', dl: ['Retry by Oct 9', 'danger'], rs: 'Completed', fs: 'Failed', flags: [['Card closed: refund failed', 'danger']] },
    { rt: 'RT-260930-0151', ord: 'MK-260918-00377', seller: 'casaverde', reason: 'Missing parts', item: 'Mosswood Linen Napkins, set of 4', amt: 48.00, owner: 'Lena Park', dl: ['Closed Sep 30', 'ok'], rs: 'Completed', fs: 'Sent', flags: [['Refund without return approved', 'info', 'file-check']], exc: 'Approved by Priya Nair, Sep 30: return shipping cost more than the item; seller agreed to the deduction.' },
    { rt: 'RT-261002-0166', ord: 'MK-260920-00812', seller: 'trailhead', reason: 'Wrong size', item: 'Corvo Swift Trail Running Shoes', amt: 112.00, owner: 'Trailhead Outfitters', dl: ['Closed Oct 6', 'ok'], rs: 'Completed', fs: 'Sent', flags: [] },
  ];

  function returnDrawer() {
    return U.drawer({
      title: 'RT-261006-0193 · refund without return',
      body: `
        <div class="row gap-3">${U.pimg(P.pourover, 'thumb')}<div class="stack gap-0"><span class="strong">${P.pourover.name}</span><span class="xs muted">Cream · Qty 1 · Sold by Marketly Official · ${oref('MK-260914-48213')}</span></div></div>
        ${U.kv([['Customer', 'Jordan Lee'], ['Reason', 'Damaged on arrival'], ['Delivered', 'Sep 17, 2026'], ['Return window', 'Open until Oct 17 (30 days)'], ['Paid for item', U.money(34.65) + ' <span class="xs muted">after $1.35 coupon share</span>'], ['Owner', 'Lena Park, Returns Manager']])}
        <div class="stack gap-2"><span class="label">Customer evidence</span><div class="grid c2" style="grid-template-columns:repeat(3,minmax(0,1fr));--gap:8px">${U.img('image', 'var(--img-3)', 'r43')}${U.img('image', 'var(--img-3)', 'r43')}${U.img('image', 'var(--img-3)', 'r43')}</div>
          <p class="small sub">"The carafe arrived with a chip on the spout. Box looked fine from outside."</p></div>
        ${U.alert('warning', 'Exception to the standard return journey', 'Refund without return is a controlled exception. The reason is recorded and Finance approves the money. The item is written off in stock, not restocked.')}
        ${U.field('Recorded reason', U.select('aa-rt-exc', ['Return shipping costs more than the item', 'Hazardous or unsafe to ship back', 'Item damaged beyond resale, photo evidence', 'Customer goodwill'], 'Return shipping costs more than the item'))}
        ${U.field('Details', U.textarea('aa-rt-exc-d', 'Fragile ceramic item. Chip visible in 3 photos. Prepaid return label would cost $9.80; resale value after return is $0.'), { hint: 'Required. Visible to Finance and in Action history.' })}
        <div class="well stack gap-2">${U.sumRow('Refund amount', U.money(34.65))}${U.sumRow('Refund to', 'Visa •••• 4417')}${U.sumRow('Stock outcome', 'Written off · recorded by Ana Silva')}${U.sumRow('Approval', 'Finance · Priya Nair (limit $2,000)')}</div>
        ${U.timeline([{ t: 'Remedy proposed', d: 'Oct 6, 2:30 PM · Lena Park', state: 'done' }, { t: 'Finance approval', d: 'Waiting · Priya Nair · target Oct 9', state: 'current' }, { t: 'Refund sent to card', d: 'After approval · 3–5 business days to arrive' }])}`,
      foot: `${U.btn('Request more photos', { v: 'ghost' })}${U.btn('Send to Finance', { icon: 'send' })}`,
    });
  }

  U.register({
    id: 'admin/returns', title: 'Returns and refunds queue', ref: 'Plan ch. 13, 14',
    notes: 'Queue owned by the Returns Manager with reason, owner, deadline and amount per return, and return status kept separate from refund status. Refund-without-return exceptions are flagged with their recorded reason and go to Finance for approval.',
    states: ['Queue', 'Exception review'],
    render: (state) => {
      const rows = RETURNS;
      const page = U.adminLayout(`
        ${U.pageHead('Returns and refunds', {
          crumbs: [{ label: 'Commerce' }, { label: 'Returns and refunds' }],
          sub: 'Queue owner: Lena Park, Returns Manager · backup Theo Grant · escalation Isabel Cruz (Customer Support)',
          actions: U.btn('Export CSV', { v: 'secondary', icon: 'download', size: 'sm' }) + U.btn('Return policy settings', { v: 'secondary', icon: 'settings', size: 'sm', href: U.go('admin/settings') }),
        })}
        <div class="aa-kpis c5">
          <div class="card pad">${U.stat('Open returns', '14', { note: '6 company · 8 sellers' })}</div>
          <div class="card pad">${U.stat('Past deadline', '<span class="t-danger-text">3</span>', { note: '2 seller replies overdue' })}</div>
          <div class="card pad">${U.stat('Awaiting inspection', '5', { note: 'Reno warehouse' })}</div>
          <div class="card pad">${U.stat('Refunds pending', U.money(1284.62), { note: '9 refunds · not yet sent' })}</div>
          <div class="card pad">${U.stat('Exceptions', '2', { note: 'Refund without return' })}</div>
        </div>
        <section class="card">
          ${U.tabs([{ label: 'All open', count: 14 }, { label: 'Needs decision', count: 4 }, { label: 'In transit', count: 3 }, { label: 'Inspecting', count: 5 }, { label: 'Refund pending', count: 9 }, { label: 'Exceptions', count: 2 }, { label: 'Closed' }], 0)}
          <div class="card-body">
            <div class="toolbar">${U.searchIn('Search RT ref, order ref or customer', 'aa-rt-q')}</div>
            <div class="aa-filters">
              ${flt('aa-rt-type', 'Seller type', ['All sellers', 'Official Store', 'Marketplace sellers'], 'All sellers')}
              ${flt('aa-rt-seller', 'Seller', ['Any seller', 'Marketly Official', 'Northwind Audio', 'Pixel & Port', 'Casa Verde Home', 'Trailhead Outfitters', 'Gadget Grove'], 'Any seller')}
              ${flt('aa-rt-reason', 'Reason', ['Any reason', 'Damaged on arrival', 'Defective', 'Not as described', 'Wrong item sent', 'Changed mind', 'Missing parts'], 'Any reason')}
              ${flt('aa-rt-owner', 'Owner', ['Any owner', 'Lena Park', 'Priya Nair', 'Seller'], 'Any owner')}
              ${flt('aa-rt-refund', 'Refund status', ['Any', 'Requested', 'Under review', 'Approved', 'Processing', 'Sent', 'Failed'], 'Any')}
              ${flt('aa-rt-dl', 'Deadline', ['Any time', 'Overdue', 'Due today', 'Next 3 days'], 'Any time')}
            </div>
          </div>
          <div class="no-phone">${U.table(['Return', 'Order', 'Seller', 'Reason', { label: 'Amount', cls: 'r' }, 'Owner', 'Deadline', 'Return', 'Refund', 'Flags'],
            rows.map((r) => [
              `<a class="mono strong nowrap" href="${U.go('admin/returns', 'Exception review')}">${r.rt}</a>`,
              oref(r.ord),
              `<span class="stack gap-0"><span class="small strong nowrap">${sname(r.seller)}</span><span class="xs muted nowrap">${r.item}</span></span>`,
              `<span class="small">${r.reason}</span>`,
              `<span class="strong">${U.money(r.amt)}</span>`,
              `<span class="small nowrap">${r.owner}</span>`,
              U.deadline(r.dl[0], r.dl[1]),
              U.status(r.rs),
              r.fs ? U.status(r.fs) : '<span class="xs muted">Not started</span>',
              r.flags.length ? `<span class="stack gap-1">${flags(r.flags)}${r.exc ? `<span class="xs sub" style="max-width:34ch">${r.exc}</span>` : ''}</span>` : '<span class="xs muted">None</span>',
            ]), { rowCls: rows.map((r) => r.dl[1] === 'danger' ? 'is-flagged' : r.exc && r.fs !== 'Sent' ? 'is-warn' : '') })}</div>
          <div class="only-phone" style="padding:0 var(--sp-4) var(--sp-4)"><div class="aa-mlist">${rows.map((r) => `<a class="aa-mcard ${r.dl[1] === 'danger' ? 'is-flagged' : ''}" href="${U.go('admin/returns', 'Exception review')}">
              <span class="row between"><span class="mono strong">${r.rt}</span><span class="strong num">${U.money(r.amt)}</span></span>
              <span class="xs muted">${r.item} · ${sname(r.seller)} · ${r.reason}</span>
              <span class="row gap-2"><span class="xs muted">Return</span>${U.status(r.rs)}<span class="xs muted">Refund</span>${r.fs ? U.status(r.fs) : '<span class="xs muted">Not started</span>'}</span>
              <span class="row between">${U.deadline(r.dl[0], r.dl[1])}<span class="xs muted">${r.owner}</span></span>
              ${r.flags.length ? flags(r.flags) : ''}${r.exc ? `<span class="xs sub">${r.exc}</span>` : ''}
            </a>`).join('')}</div></div>
          <div class="card-foot" style="justify-content:space-between"><span class="xs muted">Refund "Approved" means approved for sending, not that money has reached the customer.</span>${U.pager(1, 2)}</div>
        </section>
      `, 'returns');
      return state === 'Exception review' ? page + returnDrawer() : page;
    },
  });

  /* ======================================================================
     4. admin/catalog
     ====================================================================== */
  const CATNAME = Object.fromEntries(D.categories.map((c) => [c.id, c.name]));
  const CAT_EXTRA = {
    aurora: [96, 'Approved', 'Active'], kestrel27: [91, 'Approved', 'Active'], ssd1tb: [94, 'Approved', 'Active'], lamp: [68, 'Approved', 'Active', 'Missing dimensions, 2 images'],
    duvet: [92, 'Approved', 'Active'], bottle: [88, 'Approved', 'Active'], backpack: [85, 'Approved', 'Active'], shoes: [74, 'Approved', 'Hidden', 'Missing size chart'],
    skillet: [97, 'Approved', 'Active'], sweater: [83, 'Approved', 'Active'], speaker: [90, 'Approved', 'Active'], vacuum: [81, 'Approved', 'Active', null, 'Gadget Grove offer paused · 3 other offers live'],
    keyboard: [93, 'Approved', 'Active'], pourover: [89, 'Approved', 'Active'], serum: [62, 'Changes requested', 'Hidden', 'Missing ingredients list'], yogamat: [86, 'Approved', 'Active'],
  };
  const CAT_NEW = [
    { name: 'Kestrel K75 Wireless Mechanical Keyboard, Lavender', brand: 'Kestrel', cat: 'Computers › Accessories', offers: 1, best: 114.00, rs: 'Submitted', pub: 'Hidden', score: 71, miss: 'Missing warranty', icon: 'keyboard', tint: 'var(--img-6)' },
    { name: 'Volt Max Pro X9 Wireless Earbuds', brand: 'Volt Max', cat: 'Electronics › Headphones', offers: 1, best: 19.99, rs: 'Rejected', pub: 'Suspended', score: 40, miss: 'Brand not verified', icon: 'headphones', tint: 'var(--img-4)' },
  ];
  function catalogRows() {
    const rows = CAT_NEW.map((n) => ({ ...n, sku: 'Submission' }))
      .concat(D.products.map((p) => { const x = CAT_EXTRA[p.id]; return { name: p.name, brand: p.brand, cat: CATNAME[p.cat] + ' › ' + p.sub, offers: p.offers, best: p.price, rs: x[1], pub: x[2], score: x[0], miss: x[3], note: x[4], icon: p.icon, tint: p.tint, sku: p.sku }; }));
    return rows;
  }
  const scoreCell = (n, miss) => `<span class="stack gap-1" style="min-width:110px"><span class="row between xs"><span class="strong num">${n}</span><span class="muted">/ 100</span></span>${U.meter(n, n >= 85 ? 'success' : n >= 70 ? 'warning' : 'danger')}${miss ? `<span class="xs t-warning-text strong">${miss}</span>` : ''}</span>`;

  U.register({
    id: 'admin/catalog', title: 'Catalog products', ref: 'Plan ch. 8',
    notes: 'Shared catalog list with every filter the plan names: category, brand, seller, approval state, missing content and publication. Review state and publication are separate columns, and bulk actions respect controlled permissions with a visible reason when an action is not allowed.',
    states: ['Products', 'Bulk selection'],
    render: (state) => {
      const bulk = state === 'Bulk selection';
      const rows = catalogRows();
      return U.adminLayout(`
        ${U.pageHead('Products', {
          crumbs: [{ label: 'Catalog' }, { label: 'Products' }],
          sub: '8,335 shared products · 11,920 offers · owner Omar Haddad, Catalog Manager',
          actions: U.btn('Export', { v: 'secondary', icon: 'download', size: 'sm' }) + U.btn('Review queue · 23', { v: 'secondary', icon: 'list-checks', size: 'sm', href: U.go('admin/product-review') }) + U.btn('Add product', { icon: 'plus', size: 'sm' }),
        })}
        <section class="card">
          ${U.tabs([{ label: 'All', count: '8,335' }, { label: 'Active', count: '7,912' }, { label: 'Hidden', count: 341 }, { label: 'Suspended', count: 82 }, { label: 'Missing content', count: 516 }, { label: 'Duplicates suspected', count: 12 }], 0)}
          <div class="card-body">
            <div class="toolbar">${U.searchIn('Search by name, brand, SKU, UPC or model number', 'aa-c-q')}</div>
            <div class="aa-filters">
              ${flt('aa-c-cat', 'Category', ['All categories', 'Electronics', 'Computers', 'Home & Kitchen', 'Fashion', 'Sports & Outdoors', 'Beauty'], 'All categories')}
              ${flt('aa-c-brand', 'Brand', ['All brands', 'Halden', 'Kestrel', 'Mosswood', 'Brightline', 'Corvo', 'Pellar'], 'All brands')}
              ${flt('aa-c-seller', 'Seller', ['Any seller', 'Marketly Official', 'Northwind Audio', 'Pixel & Port', 'Casa Verde Home', 'Trailhead Outfitters', 'Gadget Grove'], 'Any seller')}
              ${flt('aa-c-review', 'Approval state', ['Any state', 'Draft', 'Submitted', 'Changes requested', 'Approved', 'Rejected'], 'Any state')}
              ${flt('aa-c-miss', 'Missing content', ['Any', 'Missing images', 'Missing required attributes', 'Missing description', 'Missing warranty'], 'Any')}
              ${flt('aa-c-pub', 'Publication', ['Any', 'Active', 'Hidden', 'Suspended'], 'Any')}
            </div>
          </div>
          ${bulk ? `<div style="padding:0 var(--sp-4) var(--sp-3)"><div class="bulk-bar"><span>3 selected</span><span class="grow"></span>
              ${U.btn('Hide', { v: 'ghost', icon: 'eye-off' })}
              ${U.btn('Request changes', { v: 'ghost', icon: 'message-square-warning' })}
              ${tip(U.btn('Bulk price and stock update', { v: 'ghost', icon: 'lock', disabled: true }), 'Needs the Catalog bulk edit permission. Ask Omar Haddad (Catalog Manager) or request access in Staff and roles.', true)}
              ${tip(U.btn('Suspend', { v: 'ghost', icon: 'lock', disabled: true }), 'Only the Catalog Manager can suspend products. Suspending needs a recorded reason and explains the effect on open orders.')}
              ${U.btn('Clear', { v: 'ghost' })}
            </div></div>` : `<div style="padding:0 var(--sp-4) var(--sp-3)" class="xs muted">${U.icon('info', 'ic-sm')} Select products to hide, request changes or update in bulk. Bulk price, stock and suspension need extra permissions.</div>`}
          <div class="no-phone">${U.table(['Product', 'Brand', 'Category', { label: 'Offers', cls: 'r' }, { label: 'Best price', cls: 'r' }, 'Review state', 'Publication', 'Content score'],
            rows.map((r) => [
              `<span class="cell-main">${U.img(r.icon, r.tint, 'tiny')}<span class="stack gap-0"><a class="small strong clamp-2" href="${U.go(r.sku === 'Submission' ? 'admin/product-review' : 'store/product')}">${r.name}</a><span class="xs muted">${r.sku === 'Submission' ? 'New submission' : `<span class="mono">${r.sku}</span>`}${r.note ? ' · ' + r.note : ''}</span></span></span>`,
              r.brand, `<span class="small nowrap">${r.cat}</span>`, r.offers, U.money(r.best), U.status(r.rs), U.status(r.pub), scoreCell(r.score, r.miss),
            ]), { select: true, checked: bulk ? [2, 5, 18] : [], rowCls: rows.map((r) => r.rs === 'Rejected' ? 'is-flagged' : r.miss ? 'is-warn' : '') })}</div>
          <div class="only-phone" style="padding:0 var(--sp-4) var(--sp-4)"><div class="aa-mlist">${rows.slice(0, 10).map((r) => `<a class="aa-mcard ${r.miss ? 'is-warn' : ''}" href="${U.go(r.sku === 'Submission' ? 'admin/product-review' : 'store/product')}">
              <span class="row nowrap top gap-3">${U.img(r.icon, r.tint, 'tiny')}<span class="stack gap-1 grow"><span class="small strong clamp-2">${r.name}</span><span class="xs muted">${r.brand} · ${r.cat} · ${r.offers} offer${r.offers > 1 ? 's' : ''} · from ${U.money(r.best)}</span></span></span>
              <span class="row gap-2">${U.status(r.rs)}${U.status(r.pub)}<span class="xs muted">Content ${r.score}/100</span></span>
              ${r.miss ? `<span class="xs t-warning-text strong">${r.miss}</span>` : ''}
            </a>`).join('')}</div></div>
          <div class="card-foot" style="justify-content:space-between"><span class="xs muted">Hiding or suspending a product does not remove other sellers' valid offers from past orders. Purchase snapshots keep the terms accepted at purchase.</span>${U.pager(1, 417)}</div>
        </section>
      `, 'catalog');
    },
  });

  /* ======================================================================
     5. admin/product-review
     ====================================================================== */
  const SUBS = [
    { name: 'Kestrel K75 Wireless Mechanical Keyboard, Lavender', seller: 'pixelport', cat: 'Computers › Accessories', age: '2 d', tone: 'warning', icon: 'keyboard', tint: 'var(--img-6)', f: [['Possible duplicate', 'danger']], on: true },
    { name: 'Aster Retinol Night Cream 50 ml', seller: 'official', cat: 'Beauty › Skincare', age: '1 d 4 h', icon: 'droplet', tint: 'var(--img-5)', f: [['Resubmitted', 'info']] },
    { name: 'Northwind Studio Cable Kit, 3-pack', seller: 'northwind', cat: 'Electronics › Accessories', age: '1 d', icon: 'cable', tint: 'var(--img-2)', f: [] },
    { name: 'Mosswood Linen Napkins, set of 4', seller: 'casaverde', cat: 'Home & Kitchen › Kitchen linens', age: '20 h', icon: 'layers', tint: 'var(--img-1)', f: [['Image issues', 'warning']] },
    { name: 'Halden Aurora Replacement Ear Cushions', seller: 'gadgetgrove', cat: 'Electronics › Headphones', age: '18 h', icon: 'headphones', tint: 'var(--img-3)', f: [['Seller restricted', 'warning']] },
    { name: 'Trailhead Summit 2-Person Tent', seller: 'trailhead', cat: 'Sports & Outdoors › Camping', age: '9 h', icon: 'tent', tint: 'var(--img-5)', f: [] },
    { name: 'Brightline Smart Plug, 2-pack', seller: 'pixelport', cat: 'Electronics › Smart home', age: '3 h', icon: 'plug', tint: 'var(--img-6)', f: [['Safety listing check', 'info']] },
  ];
  const kvd = (pairs) => `<dl class="kv">${pairs.map(([k, v, diff]) => `<dt>${k}</dt><dd${diff ? ' class="aa-diff"' : ''}>${v}${diff ? ' <span class="xs t-warning-text strong">Differs</span>' : ''}</dd>`).join('')}</dl>`;
  const chk = (tone, ic, title, body) => `<div class="aa-chk t-${tone}">${U.icon(ic)}<div class="stack gap-2"><div class="row between"><span class="small strong">${title}</span>${U.badge(tone === 'success' ? 'Passed' : tone === 'danger' ? 'Blocking' : 'Needs fix', tone)}</div>${body}</div></div>`;

  function mergeModal() {
    return U.modal({
      title: 'Merge duplicate into existing product', size: 'lg',
      body: `
        <p class="small sub">Merging keeps one product page. Offers, reviews and past orders move to the product you keep, and the merged records redirect to it.</p>
        <div class="stack gap-2"><span class="label">Product to keep</span>
          ${U.optCard('aa-mg-t', 'aa-mg-t1', `<span class="row gap-2"><span class="strong small">Kestrel K75 Wireless Mechanical Keyboard</span>${U.badge('Keep', 'brand')}</span>`, '<span class="mono">PRD-10233</span> · Computers › Keyboards · 2 offers · 731 reviews · rating 4.6 · created Mar 2026', true, { right: U.img('keyboard', 'var(--img-6)', 'tiny') })}
          ${U.optCard('aa-mg-t', 'aa-mg-t2', '<span class="strong small">Kestrel K75 Mech Keyboard Wireless, Gray</span>', '<span class="mono">PRD-30418</span> · Computers › Accessories · 1 offer · 9 reviews · created Jun 2026', false, { right: U.img('keyboard', 'var(--img-4)', 'tiny') })}
        </div>
        <div class="stack gap-2"><span class="label">Records merged into PRD-10233</span>
          ${U.check('aa-mg-s1', '<span class="small"><b>Submission SUB-26100614</b> (Lavender) becomes a new variation: Color "Lavender", Switch "Kestrel Brown"</span>', true)}
          ${U.check('aa-mg-s2', '<span class="small"><b>PRD-30418</b> (older duplicate, Gray) merges into the existing Gray variation</span>', true)}
        </div>
        ${U.table(['What', 'How it carries over', 'After merge'], [
          ['<span class="strong small">Offers</span>', '<span class="small">Pixel &amp; Port offer moves to the new Lavender variation. Gadget Grove offer from PRD-30418 moves to Gray and stays paused while the seller is restricted.</span>', '<span class="small num">4 offers · 3 on sale</span>'],
          ['<span class="strong small">Reviews</span>', '<span class="small">9 reviews from PRD-30418 move with their variation label, date and Verified Purchase status. Seller feedback stays with each seller, not the product.</span>', '<span class="small num">740 reviews · 4.6</span>'],
          ['<span class="strong small">Past orders</span>', '<span class="small">17 past orders keep their purchase snapshot: title, variation, condition and price accepted at purchase. Order pages link to PRD-10233.</span>', '<span class="small num">No order changes</span>'],
          ['<span class="strong small">Questions and answers</span>', '<span class="small">4 questions move and show the variation they were asked about.</span>', '<span class="small num">58 questions</span>'],
          ['<span class="strong small">Links</span>', '<span class="small">Old product URLs redirect to PRD-10233. Ads and coupons that targeted PRD-30418 now target PRD-10233.</span>', '<span class="small num">2 redirects</span>'],
        ])}
        ${U.alert('info', 'Sellers are notified', 'Pixel & Port and Gadget Grove get a message explaining the merge and where their offers now appear. The merge is recorded in Action history and the Catalog Manager can reverse it within 30 days.')}
        ${U.field('Reason for merge', U.textarea('aa-mg-reason', 'Same model (K75), same brand and UPC family. Lavender is a color variation of the existing product. PRD-30418 is an older duplicate of the Gray variation.'), { hint: 'Required. Shown to the affected sellers.' })}`,
      foot: `${U.btn('Cancel', { v: 'ghost' })}${U.btn('Merge 2 records into PRD-10233', { icon: 'merge' })}`,
    });
  }

  U.register({
    id: 'admin/product-review', title: 'Product review queue', ref: 'Plan ch. 8',
    notes: 'Catalog review with automated checks for duplicates, image standards, category fit and prohibited claims, and a decision that needs a reason and field-level comments. Merging a duplicate explains how offers, reviews and past orders carry over.',
    states: ['Submission', 'Merge duplicate'],
    render: (state) => {
      const p = P.keyboard;
      const page = U.adminLayout(`
        ${U.pageHead('Review queue', {
          crumbs: [{ label: 'Catalog' }, { label: 'Review queue' }],
          sub: '23 waiting · oldest 2 days · review target 2 business days · lead Omar Haddad, backup Noor Aziz',
          actions: U.seg(['New products', 'Shared content changes', 'Resubmitted'], 0),
        })}
        <div class="aa-rv">
          <section class="card">
            <div class="card-head"><span class="h4">Submissions</span><span class="xs muted">Oldest first</span></div>
            <div class="card-body" style="padding-bottom:0">${flt('aa-pr-cat', 'Category', ['All categories', 'Computers', 'Electronics', 'Home & Kitchen', 'Beauty', 'Sports & Outdoors'], 'All categories')}</div>
            <nav class="aa-q" aria-label="Submissions" style="margin-top:var(--sp-3)">${SUBS.map((s) => `<a href="${U.go('admin/product-review')}" class="${s.on ? 'is-active' : ''}"${s.on ? ' aria-current="true"' : ''}>
                <span class="row nowrap top gap-3">${U.img(s.icon, s.tint, 'tiny')}<span class="stack gap-0 grow"><span class="small strong clamp-2">${s.name}</span><span class="xs muted">${sname(s.seller)} · ${s.cat}</span></span></span>
                <span class="row between">${s.f.length ? flags(s.f) : '<span></span>'}${U.deadline('Waiting ' + s.age, s.tone || 'ok')}</span>
              </a>`).join('')}</nav>
            <div class="card-foot" style="justify-content:center"><a class="small strong" href="javascript:void 0">Show all 23</a></div>
          </section>

          <div class="stack gap-5">
            <section class="card">
              <div class="card-head">
                <div class="row nowrap top gap-3">${U.pimg(p, 'thumb')}<div class="stack gap-1"><span class="eyebrow">New product · SUB-26100614</span><h2 class="h3">Kestrel K75 Wireless Mechanical Keyboard, Lavender</h2><span class="xs muted">${sellerCell('pixelport', 'Submitted by Dev Malik · Oct 6, 2:14 PM PT')}</span></div></div>
                <div class="row gap-2">${U.status('Submitted')}${U.deadline('Review by Oct 9', 'warning')}</div>
              </div>
              <div class="card-body">
                <div class="aa-sec"><span class="h4">Content</span>
                  ${kvd([['Brand', 'Kestrel <span class="xs muted">· Pixel &amp; Port is an authorized reseller</span>'], ['Category', 'Computers › Accessories', true], ['Model', '<span class="mono">K75-LV-BR</span>'], ['UPC', '<span class="mono">0 84172 55613 9</span>'], ['Offer', U.money(114) + ' · New · 20 in stock · ships in 1–2 business days']])}
                  <p class="small sub">Compact 75% wireless mechanical keyboard in lavender with hot-swappable Kestrel Brown tactile switches, PBT double-shot keycaps and a 4,000 mAh battery. Connect over Bluetooth 5.1, 2.4 GHz or USB-C. <mark class="aa-mark">The #1 rated keyboard for creators</mark>, backed by a <mark class="aa-mark">lifetime warranty</mark>.</p>
                </div>
                <div class="aa-sec"><span class="h4">Images · 5</span>
                  <div class="aa-imgs">
                    <figure>${U.img('keyboard', 'var(--img-6)')}<figcaption>1 · Main · 2000 px</figcaption></figure>
                    <figure>${U.img('keyboard', 'var(--img-6)')}<figcaption>2 · Side · 2000 px</figcaption></figure>
                    <figure class="is-bad">${U.img('badge-percent', 'var(--img-4)')}<figcaption>3 · Text overlay</figcaption></figure>
                    <figure>${U.img('cable', 'var(--img-6)')}<figcaption>4 · Ports · 1600 px</figcaption></figure>
                    <figure class="is-bad">${U.img('image', 'var(--img-6)')}<figcaption>5 · 640 px, too small</figcaption></figure>
                  </div>
                </div>
                <div class="aa-sec"><span class="h4">Attributes</span>
                  ${U.table(['Attribute', 'Value', ''], [
                    ['Connection', 'Bluetooth 5.1, 2.4 GHz, USB-C', ''], ['Layout size', '75%', ''], ['Switch type', 'Kestrel Brown (tactile)', ''], ['Keycaps', 'PBT double-shot', ''],
                    ['Battery', '4,000 mAh', ''], ['Weight', '830 g', ''], ['Color', 'Lavender', ''],
                    ['Warranty <span class="xs muted">· required</span>', '<span class="t-danger-text strong small">Missing</span>', U.badge('Required', 'danger')],
                  ], { rowCls: ['', '', '', '', '', '', '', 'is-flagged'] })}
                </div>
              </div>
            </section>

            ${U.card({
              title: 'Automated checks', sub: 'Ran Oct 6, 2:15 PM · 4 need attention · 3 passed',
              body: `
                ${chk('danger', 'copy', 'Possible duplicate of PRD-10233', `<p class="small sub">Same brand, model family and UPC prefix as an existing product. Only the color differs, so this is likely a new variation, not a new product.</p>
                  <div class="aa-cmp">
                    <div class="panel stack gap-2"><span class="row gap-2">${U.img('keyboard', 'var(--img-6)', 'tiny')}<span class="stack gap-0"><span class="xs strong muted">This submission</span><span class="small strong">K75 Wireless Mechanical Keyboard, Lavender</span></span></span>
                      ${kvd([['Brand', 'Kestrel'], ['Model', 'K75-LV-BR'], ['Layout', '75%'], ['Switch', 'Kestrel Brown'], ['Color', 'Lavender', true], ['Category', 'Accessories', true]])}</div>
                    <div class="panel stack gap-2"><span class="row gap-2">${U.pimg(p, 'tiny')}<span class="stack gap-0"><span class="xs strong muted">Existing · PRD-10233</span><a class="small strong" href="${U.go('store/product')}">${p.name}</a></span></span>
                      ${kvd([['Brand', 'Kestrel'], ['Model', 'K75-GY-BR'], ['Layout', '75%'], ['Switch', 'Kestrel Brown'], ['Color', 'Gray'], ['Category', 'Keyboards']])}
                      <span class="xs muted">2 offers · 731 reviews · on sale since Mar 2026</span></div>
                  </div>
                  <div class="row gap-2">${U.btn('Merge into PRD-10233', { size: 'sm', icon: 'merge', href: U.go('admin/product-review', 'Merge duplicate') })}${U.btn('Not a duplicate', { v: 'ghost', size: 'sm' })}</div>`)}
                ${chk('warning', 'image', 'Image standards: 2 issues', '<ul class="ul small sub"><li>Image 3 has a "50% OFF" text overlay. Promotional text is not allowed on product images.</li><li>Image 5 is 640 × 640 px. The minimum is 1000 × 1000 px.</li></ul>')}
                ${chk('warning', 'folder-tree', 'Category mismatch', '<p class="small sub">Submitted under Computers › Accessories. Attributes match Computers › Keyboards (94% match). Keyboards requires Switch type and Warranty.</p>')}
                ${chk('danger', 'ban', 'Prohibited claims', '<ul class="ul small sub"><li>"#1 rated keyboard for creators" is an unverifiable ranking claim.</li><li>"Lifetime warranty" conflicts with the Kestrel brand warranty of 2 years. Offer-specific warranties go in the offer terms.</li></ul>')}
                ${chk('success', 'shield-check', 'Brand authorization', '<p class="small sub">Pixel &amp; Port is on the Kestrel authorized seller list (checked Oct 6).</p>')}
                ${chk('success', 'circle-check', 'Restricted items and safety', '<p class="small sub">Not a restricted category. Lithium battery is built in and under 100 Wh, so ground shipping is allowed.</p>')}
                ${chk('success', 'scan-barcode', 'Identifiers', '<p class="small sub">UPC is valid and not used by another product.</p>')}`,
            })}

            ${U.card({
              title: 'Decision', sub: 'The seller sees your reason and each field comment',
              body: `
                <div class="grid md3" style="--gap:8px">
                  ${U.optCard('aa-pr-d', 'aa-pr-d1', '<span class="small strong">Approve</span>', 'Publish as a new product', false)}
                  ${U.optCard('aa-pr-d', 'aa-pr-d2', '<span class="small strong">Request changes</span>', 'Seller fixes and resubmits', true)}
                  ${U.optCard('aa-pr-d', 'aa-pr-d3', '<span class="small strong">Reject</span>', 'Outside allowed assortment or unsafe', false)}
                </div>
                ${U.field('Reason', U.select('aa-pr-reason', ['Choose a reason', 'Misleading or prohibited claims', 'Duplicate of an existing product', 'Images do not meet standards', 'Wrong category', 'Missing required information'], 'Misleading or prohibited claims'), { hint: 'Required for Request changes and Reject.' })}
                <div class="stack gap-2"><span class="label">Field comments · 4</span>
                  ${U.table(['Field', 'Comment to seller', ''], [
                    ['<span class="small strong">Description</span>', '<span class="small">Remove "#1 rated" and "lifetime warranty". Put any seller warranty in your offer terms.</span>', U.iconBtn('trash-2', 'Remove comment')],
                    ['<span class="small strong">Images 3 and 5</span>', '<span class="small">Replace image 3 with one without text. Upload image 5 at 1000 px or larger.</span>', U.iconBtn('trash-2', 'Remove comment')],
                    ['<span class="small strong">Category</span>', '<span class="small">Move to Computers › Keyboards.</span>', U.iconBtn('trash-2', 'Remove comment')],
                    ['<span class="small strong">Warranty</span>', '<span class="small">Add the manufacturer warranty (Kestrel: 2 years).</span>', U.iconBtn('trash-2', 'Remove comment')],
                  ])}
                  ${U.btn('Add field comment', { v: 'ghost', size: 'sm', icon: 'plus' })}
                </div>
                ${U.alert('info', 'Duplicate first', 'If you merge this into PRD-10233, the change request goes with the new Lavender variation and the seller fixes it there.')}`,
              foot: `${U.btn('Save draft', { v: 'ghost' })}${U.btn('Send change request', { icon: 'send' })}`,
            })}

            ${U.card({ title: 'History', body: U.timeline([
              { t: 'Assigned to Omar Haddad', d: 'Oct 7, 9:00 AM · auto-assign by category', state: 'current' },
              { t: 'Automated checks finished', d: 'Oct 6, 2:15 PM · 4 issues, 3 passed', state: 'warn' },
              { t: 'Submitted for review', d: 'Oct 6, 2:14 PM · Dev Malik, Pixel & Port', state: 'done' },
              { t: 'Draft saved', d: 'Oct 5, 6:02 PM · Dev Malik', state: 'done' },
            ]) })}
          </div>
        </div>
      `, 'review');
      return state === 'Merge duplicate' ? page + mergeModal() : page;
    },
  });

  /* ======================================================================
     6. admin/categories
     ====================================================================== */
  const TREE = [
    { n: 'Electronics', c: 1240, v: 'Visible', open: true, kids: [['Headphones', 312, 'Visible'], ['Speakers', 188, 'Visible'], ['Smart home', 240, 'Visible'], ['Cameras', 96, 'Visible'], ['Wearables', 0, 'Coming soon']] },
    { n: 'Computers', c: 860, v: 'Visible', open: true, kids: [['Monitors', 142, 'Visible'], ['Storage', 205, 'Visible'], ['Keyboards', 118, 'Visible', true], ['Laptops', 0, 'Hidden'], ['Accessories', 395, 'Visible']] },
    { n: 'Home & Kitchen', c: 2105, v: 'Visible' }, { n: 'Fashion', c: 1830, v: 'Visible' }, { n: 'Sports & Outdoors', c: 940, v: 'Visible' },
    { n: 'Beauty', c: 620, v: 'Visible' }, { n: 'Toys & Games', c: 410, v: 'Visible' }, { n: 'Pet Supplies', c: 330, v: 'Visible' }, { n: 'Musical instruments', c: 0, v: 'Hidden' },
  ];
  const visBadge = (v) => v === 'Visible' ? '' : v === 'Coming soon' ? U.badge('Coming soon', 'info', 'clock') : U.badge('Hidden', '', 'eye-off');
  function tree() {
    const node = (name, count, vis, lvl, o = {}) => `<a href="javascript:void 0" class="aa-tn${o.active ? ' is-active' : ''}${vis !== 'Visible' ? ' is-muted' : ''}" style="--lvl:${lvl}"${o.active ? ' aria-current="true"' : ''}>
      ${o.toggle ? `<button type="button" class="tg" aria-expanded="${o.open}" aria-label="${o.open ? 'Collapse' : 'Expand'} ${U.esc(name)}">${U.icon(o.open ? 'chevron-down' : 'chevron-right', 'ic-sm')}</button>` : '<span class="tg sp" aria-hidden="true"></span>'}
      ${U.icon(lvl ? 'folder' : (o.open ? 'folder-open' : 'folder'), 'ic-sm')}<span class="nm">${name}</span>${visBadge(vis)}<span class="cnt">${U.num(count)}</span></a>`;
    return `<div class="aa-tree" role="tree">${TREE.map((t) => node(t.n, t.c, t.v, 0, { toggle: true, open: !!t.open }) + (t.open ? t.kids.map(([n, c, v, a]) => node(n, c, v, 1, { active: a })).join('') : '')).join('')}</div>`;
  }
  const ATTRS = [
    ['Brand', 'List', 'From brand list', true, true, 118, true],
    ['Connection', 'List', 'Wired, Bluetooth, 2.4 GHz', true, true, 118],
    ['Layout size', 'List', 'Full, TKL, 75%, 65%, 60%', true, true, 116],
    ['Switch type', 'List', '14 values', true, true, 102],
    ['Color', 'List · variation', '11 values', true, true, 118],
    ['Backlight', 'Yes / No', '', false, true, 97],
    ['Keycap material', 'Text', '', false, false, 81],
    ['Battery capacity', 'Number', 'mAh', false, false, 64],
    ['Weight', 'Number', 'g', true, false, 109],
    ['Warranty', 'Text', '', true, false, 99],
  ];
  function attrEditor() {
    const ck = (id, on, label, dis) => `<input type="checkbox" id="${id}" aria-label="${label}"${on ? ' checked' : ''}${dis ? ' disabled' : ''}>`;
    return `<div class="aa-ed">${U.table(['Attribute name', 'Type', 'Values or unit', { label: 'Required', cls: 'c' }, { label: 'Filterable', cls: 'c' }, { label: 'Filled in', cls: 'r' }, ''],
      ATTRS.map(([n, t, vals, req, fil, used, inh], i) => [
        inh ? `<span class="stack gap-0"><span class="small strong">${n}</span><span class="xs muted">Inherited from All products</span></span>` : `<label class="sr-only" for="aa-at-n${i}">Attribute name</label>${U.input('aa-at-n' + i, n)}`,
        inh ? `<span class="small">${t}</span>` : `<label class="sr-only" for="aa-at-t${i}">Type</label>${U.select('aa-at-t' + i, ['Text', 'Number', 'List', 'List · variation', 'Yes / No'], t)}`,
        `<span class="small sub">${vals || '<span class="muted">—</span>'}</span>`,
        ck('aa-at-r' + i, req, 'Required: ' + n, inh), ck('aa-at-f' + i, fil, 'Filterable: ' + n, inh),
        `<span class="small num ${used < 118 && req ? 't-warning-text strong' : ''}">${used} / 118</span>`,
        inh ? '' : U.iconBtn('trash-2', 'Remove ' + n),
      ]))}</div>`;
  }
  const BRANDS = [
    { b: D.brands[0], prod: 48, offers: 131, sellers: 6, auth: 'Authorized seller list', st: 'Active' },
    { b: D.brands[1], prod: 63, offers: 154, sellers: 5, auth: 'Authorized seller list', st: 'Active' },
    { b: D.brands[2], prod: 37, offers: 52, sellers: 3, auth: 'Open to all sellers', st: 'Active' },
    { b: D.brands[3], prod: 29, offers: 71, sellers: 4, auth: 'Open to all sellers', st: 'Active' },
    { b: D.brands[4], prod: 41, offers: 66, sellers: 3, auth: 'Open to all sellers', st: 'Active' },
    { b: D.brands[5], prod: 18, offers: 30, sellers: 2, auth: 'Open to all sellers', st: 'Active' },
    { b: { name: 'Aster', initials: 'A', tint: 'var(--img-5)' }, prod: 22, offers: 25, sellers: 2, auth: 'Authorized seller list', st: 'Active' },
    { b: { name: 'Nordvik', initials: 'N', tint: 'var(--img-4)' }, prod: 14, offers: 14, sellers: 1, auth: 'Official Store only', st: 'Active' },
    { b: { name: 'Volt Max', initials: 'VM', tint: 'var(--img-3)' }, prod: 3, offers: 3, sellers: 1, auth: 'Brand not verified', st: 'Under review', flag: 'Counterfeit report CS-261004-0377 with Trust and Risk' },
  ];

  U.register({
    id: 'admin/categories', title: 'Categories and brands', ref: 'Plan ch. 8',
    notes: 'Category tree with product counts and storefront visibility, including hiding categories without eligible inventory or showing "Coming soon". The selected category has an attribute editor (name, type, required, filterable) and image standards; the Brands tab lists brands with their seller authorization.',
    states: ['Categories', 'Brands'],
    render: (state) => {
      const brands = state === 'Brands';
      const head = U.pageHead('Categories and brands', {
        crumbs: [{ label: 'Catalog' }, { label: 'Categories and brands' }],
        sub: 'Owner Omar Haddad, Catalog Manager · changes apply to new submissions and show in Action history',
        actions: brands ? U.btn('Add brand', { icon: 'plus', size: 'sm' }) : U.btn('Add category', { v: 'secondary', icon: 'folder-plus', size: 'sm' }) + U.btn('Publish changes', { icon: 'upload', size: 'sm' }),
      });
      const tabsHtml = U.tabs([{ label: 'Categories', count: 9, href: U.go('admin/categories', 'Categories') }, { label: 'Brands', count: 214, href: U.go('admin/categories', 'Brands') }], brands ? 1 : 0);
      if (brands) {
        return U.adminLayout(`${head}${tabsHtml}
          <section class="card">
            <div class="card-body"><div class="toolbar">${U.searchIn('Search brands', 'aa-br-q')}${U.select('aa-br-st', ['All statuses', 'Active', 'Under review', 'Blocked'], 'All statuses')}${U.select('aa-br-auth', ['Any authorization', 'Authorized seller list', 'Open to all sellers', 'Official Store only'], 'Any authorization')}</div></div>
            ${U.table(['Brand', { label: 'Products', cls: 'r' }, { label: 'Offers', cls: 'r' }, { label: 'Sellers', cls: 'r' }, 'Who can sell', 'Status', ''],
              BRANDS.map((r) => [
                `<span class="row nowrap gap-3">${U.logoTile(r.b, 'aa-lt')}<span class="stack gap-0"><span class="small strong">${r.b.name}</span>${r.flag ? `<span class="xs t-warning-text strong">${r.flag}</span>` : '<span class="xs muted">Brand page live</span>'}</span></span>`,
                r.prod, r.offers, r.sellers, `<span class="small">${r.auth}</span>`, U.status(r.st), U.btn(r.st === 'Under review' ? 'Review' : 'Edit', { v: 'ghost', size: 'sm' }),
              ]), { rowCls: BRANDS.map((r) => r.flag ? 'is-warn' : '') })}
            <div class="card-foot" style="justify-content:space-between"><span class="xs muted">Brand claims on storefronts (for example "authorized reseller") are reviewed before they show to customers.</span>${U.pager(1, 22)}</div>
          </section>
          ${U.card({ title: 'Brand claims waiting', sub: '2 requests', flush: true, body: `<ul class="list pad">
            <li>${lt('pixelport')}<span class="grow stack gap-0"><span class="small strong">Pixel &amp; Port · "Authorized Kestrel reseller" label</span><span class="xs muted">Letter from Kestrel Peripherals US attached · Oct 5</span></span>${U.btn('Review', { v: 'secondary', size: 'sm' })}</li>
            <li>${lt('trailhead')}<span class="grow stack gap-0"><span class="small strong">Trailhead Outfitters · add brand "Ridgeback Gear"</span><span class="xs muted">New brand request · Oct 7</span></span>${U.btn('Review', { v: 'secondary', size: 'sm' })}</li>
          </ul>` })}
        `, 'categories');
      }
      return U.adminLayout(`${head}${tabsHtml}
        <div class="aa-rv">
          <section class="card">
            <div class="card-head"><span class="h4">Category tree</span><span class="row gap-1">${U.iconBtn('chevrons-down-up', 'Collapse all')}${U.iconBtn('chevrons-up-down', 'Expand all')}</span></div>
            <div class="card-body">${U.searchIn('Find a category', 'aa-ct-q')}${tree()}</div>
            <div class="card-foot" style="justify-content:flex-start"><span class="xs muted">Counts are active products with at least one eligible offer.</span></div>
          </section>
          <div class="stack gap-5">
            <section class="card">
              <div class="card-head"><div class="stack gap-1">${U.crumbs(['Computers', 'Keyboards'])}<h2 class="h3">Keyboards</h2><span class="xs muted">118 products · 241 offers · slug /computers/keyboards</span></div>${U.status('Visible', 'success')}</div>
              <div class="card-body">
                <div class="grid md2" style="--gap:12px">
                  ${U.field('Category name', U.input('aa-ct-name', 'Keyboards'))}
                  ${U.field('Parent', U.select('aa-ct-parent', ['Computers', 'Electronics', 'Top level'], 'Computers'))}
                </div>
                <div class="stack gap-2"><span class="label">Store visibility</span>
                  ${U.toggle('aa-ct-menu', 'Show in store menus and search filters', true)}
                  <span class="small sub">When this category has no eligible inventory:</span>
                  <div class="grid md2" style="--gap:8px">
                    ${U.optCard('aa-ct-empty', 'aa-ct-e1', '<span class="small strong">Hide the category</span>', 'Removed from menus until an offer is eligible', true)}
                    ${U.optCard('aa-ct-empty', 'aa-ct-e2', '<span class="small strong">Show "Coming soon"</span>', 'Page stays visible with a short note', false)}
                  </div>
                </div>
              </div>
            </section>
            ${U.card({
              title: 'Attributes', sub: 'Required attributes block submission · filterable attributes appear as store filters',
              actions: U.btn('Add attribute', { v: 'secondary', size: 'sm', icon: 'plus' }),
              flush: true,
              body: `${attrEditor()}<div class="card-body">${U.alert('warning', '19 products are missing Warranty', 'Making an attribute required does not unpublish existing products. They appear under Missing content and their sellers get a request to fill it in.')}</div>`,
            })}
            ${U.card({
              title: 'Image standards', sub: 'Checked automatically on every submission',
              actions: U.btn('Edit standards', { v: 'ghost', size: 'sm', icon: 'pencil' }),
              body: `<ul class="list">
                <li>${U.icon('maximize', 'ic-sm')}<span class="grow small">Minimum 1000 × 1000 px, JPG or PNG, up to 10 MB</span>${U.badge('Blocking', 'danger')}</li>
                <li>${U.icon('square', 'ic-sm')}<span class="grow small">Main image on a white or light neutral background, product fills 80% of the frame</span>${U.badge('Blocking', 'danger')}</li>
                <li>${U.icon('type', 'ic-sm')}<span class="grow small">No text overlays, watermarks, prices or promotional badges</span>${U.badge('Blocking', 'danger')}</li>
                <li>${U.icon('images', 'ic-sm')}<span class="grow small">At least 3 images, including one of the ports or connection side</span>${U.badge('Warning', 'warning')}</li>
                <li>${U.icon('scan-eye', 'ic-sm')}<span class="grow small">Photos show the exact model and color sold, no renders of other variations</span>${U.badge('Warning', 'warning')}</li>
              </ul>`,
            })}
          </div>
        </div>
      `, 'categories');
    },
  });

  /* ======================================================================
     7. admin/reviews
     ====================================================================== */
  const REPORTED = [
    { kind: 'Product review', title: 'Brightline S2 Robot Vacuum', r: 1, by: 'Reported by Gadget Grove (seller)', why: 'Harms sales', age: '1 d', on: true },
    { kind: 'Product review', title: 'Halden Pocket Bluetooth Speaker', r: 5, by: 'Reported by 3 customers', why: 'Spam or links', age: '20 h' },
    { kind: 'Product review', title: 'Mosswood Linen Duvet Cover', r: 2, by: 'Reported by system', why: 'Personal information', age: '14 h' },
    { kind: 'Seller feedback', title: 'Pixel & Port', r: 1, by: 'Reported by Pixel & Port (seller)', why: 'Abusive language', age: '11 h' },
    { kind: 'Q&A answer', title: 'Tidewell Insulated Bottle 750 ml', r: 0, by: 'Reported by Trailhead Outfitters', why: 'Inaccurate answer', age: '6 h' },
    { kind: 'Product review', title: 'Corvo Grip Yoga Mat 6 mm', r: 5, by: 'Flagged by Trust and Risk', why: 'Suspected paid review', age: '2 h' },
  ];

  U.register({
    id: 'admin/reviews', title: 'Reviews and Q&A moderation', ref: 'Plan ch. 17',
    notes: 'Moderation queue for reported product reviews, seller feedback and Q&A answers, each with the report reason and reporter. Decisions need a reason, and the policy reminder blocks removing legitimate negative reviews; Q&A answers are labelled by who answered and seller responses are checked against the rules.',
    states: ['Reported content', 'Q&A and seller responses'],
    render: (state) => {
      const qa = state === 'Q&A and seller responses';
      const head = U.pageHead('Reviews and Q&A', {
        crumbs: [{ label: 'Catalog' }, { label: 'Reviews and Q&A' }],
        sub: 'Moderation lead Noor Aziz · backup Isabel Cruz · fake review patterns go to Trust and Risk (Sven Larsen)',
        actions: U.btn('Moderation policy', { v: 'secondary', size: 'sm', icon: 'book-open', href: U.go('admin/help-content') }),
      });
      const tabsHtml = U.tabs([{ label: 'Reported content', count: 6, href: U.go('admin/reviews', 'Reported content') }, { label: 'Q&A answers', count: 4, href: U.go('admin/reviews', 'Q&A and seller responses') }, { label: 'Seller responses', count: 2, href: U.go('admin/reviews', 'Q&A and seller responses') }, { label: 'Decided' }], qa ? 1 : 0);
      const policy = U.alert('warning', "Don't remove legitimate negative reviews", 'Unfavorable is not a policy reason. Remove only for personal information, hate or harassment, spam or links, off-topic content, conflict of interest or proven fake reviews. Product reviews and seller feedback are judged separately.', 'scale');
      if (qa) {
        return U.adminLayout(`${head}${tabsHtml}${policy}
          ${U.card({
            title: 'Q&A answers needing review', sub: 'Answers are labelled by who wrote them: seller, Marketly staff or customer', flush: true,
            body: U.table(['Product and question', 'Answer', 'Answered by', 'Why held', ''], [
              [`<span class="stack gap-0"><span class="small strong">Tidewell Insulated Bottle 750 ml</span><span class="xs sub">"Is it dishwasher safe?"</span></span>`, '<span class="small">"Yes, totally fine in the dishwasher, I do it daily."</span>', U.badge('Customer', ''), '<span class="small">Reported by seller: brand says hand wash only</span>', `<span class="row nowrap gap-1">${U.btn('Keep', { v: 'ghost', size: 'sm' })}${U.btn('Add staff answer', { v: 'secondary', size: 'sm' })}</span>`],
              [`<span class="stack gap-0"><span class="small strong">Halden Aurora ANC Headphones</span><span class="xs sub">"Does it work with two phones at once?"</span></span>`, '<span class="small">"Yes, multipoint with 2 devices. Buy from us at northwind-audio.example for 10% off."</span>', U.badge('Seller · Northwind Audio', 'info'), '<span class="small">Off-platform link and offer</span>', `<span class="row nowrap gap-1">${U.btn('Request edit', { v: 'secondary', size: 'sm' })}${U.btn('Remove', { v: 'danger-soft', size: 'sm' })}</span>`],
              [`<span class="stack gap-0"><span class="small strong">Kestrel 27" 4K Monitor</span><span class="xs sub">"Can it charge a 16-inch laptop?"</span></span>`, '<span class="small">"It delivers 65 W over USB-C. Some 16-inch laptops need 90 W or more and will charge slowly."</span>', U.badge('Marketly staff', 'brand'), '<span class="small">New staff answer, second check</span>', `<span class="row nowrap gap-1">${U.btn('Publish', { size: 'sm' })}</span>`],
              [`<span class="stack gap-0"><span class="small strong">Aster Vitamin C Serum 30 ml</span><span class="xs sub">"Will this cure acne scars?"</span></span>`, '<span class="small">"It removes scars in 2 weeks, guaranteed."</span>', U.badge('Customer', ''), '<span class="small">Medical claim filter</span>', `<span class="row nowrap gap-1">${U.btn('Remove', { v: 'danger-soft', size: 'sm' })}</span>`],
            ], { rowCls: ['', 'is-warn', '', 'is-flagged'] }),
          })}
          ${U.card({
            title: 'Seller responses waiting', sub: 'Sellers can respond publicly once per review · held when a rule check fails', flush: true,
            body: U.table(['Review', 'Seller response', 'Rule check', ''], [
              [`<span class="stack gap-1">${U.stars5(2, 13)}<span class="small">"Duvet faded after the second wash."</span><span class="xs muted">Product review · Mosswood Duvet Cover</span></span>`, `<span class="stack gap-0"><span class="xs strong muted">Casa Verde Home</span><span class="small">"Sorry to hear this. Wash below 40 °C. Message us through your order and we'll help with a replacement."</span></span>`, `${U.badge('Passed', 'success')}`, U.btn('Publish', { size: 'sm' })],
              [`<span class="stack gap-1">${U.stars5(1, 13)}<span class="small">"Package arrived 9 days late, no updates."</span><span class="xs muted">Seller feedback · Gadget Grove</span></span>`, `<span class="stack gap-0"><span class="xs strong muted">Gadget Grove</span><span class="small">"Delete this review and we'll refund you $20."</span></span>`, `${U.badge('Offers payment to change a review', 'danger')}`, `<span class="row nowrap gap-1">${U.btn('Reject response', { v: 'danger-soft', size: 'sm' })}${U.btn('Send to Trust and Risk', { v: 'ghost', size: 'sm' })}</span>`],
            ], { rowCls: ['', 'is-flagged'] }),
          })}
        `, 'reviews');
      }
      return U.adminLayout(`${head}${tabsHtml}
        <div class="aa-rv">
          <section class="card">
            <div class="card-head"><span class="h4">Reported</span>${U.select('aa-rv-kind', ['All types', 'Product reviews', 'Seller feedback', 'Q&A answers'], 'All types')}</div>
            <nav class="aa-q" aria-label="Reported items">${REPORTED.map((r) => `<a href="${U.go('admin/reviews')}" class="${r.on ? 'is-active' : ''}">
                <span class="row between"><span class="xs strong muted">${r.kind}</span><span class="xs muted">${r.age}</span></span>
                <span class="small strong">${r.title}</span>
                <span class="row gap-2">${r.r ? U.stars5(r.r, 12) : ''}${U.badge(r.why, 'warning')}</span>
                <span class="xs muted">${r.by}</span>
              </a>`).join('')}</nav>
          </section>
          <div class="stack gap-5">
            ${policy}
            <section class="card">
              <div class="card-head"><div class="row nowrap gap-3">${U.pimg(P.vacuum, 'tiny')}<div class="stack gap-0"><span class="eyebrow">Product review</span><a class="small strong" href="${U.go('store/product')}">${P.vacuum.name}</a></div></div>${U.badge('Reported · Harms sales', 'warning')}</div>
              <div class="card-body">
                <div class="row gap-2">${U.stars5(1, 16)}<span class="strong">Stopped mapping after a week</span></div>
                <span class="row gap-2 xs muted">By Chris T. · Sep 30, 2026 · ${U.badge('Verified Purchase', 'success', 'badge-check')} · sold by Gadget Grove · Refurbished</span>
                <p class="small">Worked fine for six days, then lost the floor map every run and kept bumping into the same chair. Reset it twice following the manual. Support from the seller took four days to answer. Would not buy refurbished again.</p>
                <div class="row gap-2">${U.img('image', 'var(--img-1)', 'thumb')}${U.img('image', 'var(--img-1)', 'thumb')}</div>
                <div class="panel stack gap-1"><span class="xs strong muted">Seller response · published Oct 1</span><span class="small">"We tested this unit before shipping. Please contact us through your order for a replacement."</span></div>
                ${U.kv([['Reporter', 'Gadget Grove (seller)'], ['Report reason', 'Harms sales · "Customer did not follow setup instructions"'], ['Purchase', '<span class="mono">MK-260912-30442</span> · delivered Sep 22'], ['Other reports', 'None'], ['Helpful votes', '23']])}
                <div class="aa-note"><span class="xs strong">Note on separation</span><span>The line about slow seller support is about the seller, not the product. It is part of the customer's honest experience, so it stays. Gadget Grove's seller rating comes only from seller feedback, which is reviewed separately.</span></div>
              </div>
            </section>
            ${U.card({
              title: 'Decision', sub: 'The reviewer and the reporter both see the outcome',
              body: `
                <div class="grid md3" style="--gap:8px">
                  ${U.optCard('aa-rv-d', 'aa-rv-d1', '<span class="small strong">Keep</span>', 'Content follows the policy', true)}
                  ${U.optCard('aa-rv-d', 'aa-rv-d2', '<span class="small strong">Remove for policy</span>', 'Pick the rule it breaks', false)}
                  ${U.optCard('aa-rv-d', 'aa-rv-d3', '<span class="small strong">Request edit</span>', 'Ask the reviewer to change one part', false)}
                </div>
                ${U.field('Reason', U.select('aa-rv-reason', ['Legitimate experience, no policy breach', 'Personal information', 'Hate or harassment', 'Spam or links', 'Off-topic', 'Conflict of interest', 'Proven fake'], 'Legitimate experience, no policy breach'), { hint: 'Required. "Harms sales" is not a removal reason.' })}
                ${U.field('Message to reporter', U.textarea('aa-rv-msg', 'We reviewed this report. The review describes the buyer\'s own experience with a verified purchase and follows our review policy, so it stays published. You can respond publicly under the review.'), { opt: true })}`,
              foot: `${U.btn('Skip', { v: 'ghost' })}${U.btn('Keep review and notify', { icon: 'check' })}`,
            })}
          </div>
        </div>
      `, 'reviews');
    },
  });

  /* ======================================================================
     8. admin/official
     ====================================================================== */
  const OFFERS = [
    { p: 'aurora', price: 189.00, was: 229.00, cost: 128.00, stock: 142, st: 'Active' },
    { p: 'kestrel27', price: 335.00, was: null, cost: 262.00, stock: 4, st: 'Active', name: 'Kestrel 27" 4K IPS Monitor, USB-C 65 W', sku: 'KST-27UHD-OS' },
    { p: 'skillet', price: 58.00, was: 72.00, cost: 34.00, stock: 77, st: 'Active' },
    { p: 'sweater', price: 84.00, was: null, cost: 47.00, stock: 52, st: 'Active' },
    { p: 'pourover', price: 36.00, was: null, cost: 19.80, stock: 58, st: 'Active' },
    { p: 'serum', price: 24.00, was: 30.00, cost: 9.60, stock: 140, st: 'Hidden', note: 'Product changes requested' },
    { p: 'lamp', price: 42.00, was: null, cost: 24.50, stock: 9, st: 'Active' },
    { p: 'speaker', price: 59.00, was: 79.00, cost: 41.00, stock: 0, st: 'Out of stock', name: 'Halden Pocket Bluetooth Speaker', sku: 'HAL-PKT-TEAL-OS', note: 'Incoming 120 on PUR-2610-0042' },
  ];
  const margin = (o) => ((o.price - o.cost) / o.price) * 100;
  const stockCell = (n) => n === 0 ? `<span class="stack gap-0"><span class="strong num t-danger-text">0</span><span class="xs muted">Not sellable</span></span>` : n < 10 ? `<span class="stack gap-0"><span class="strong num t-warning-text">${n}</span><span class="xs t-warning-text">Low stock</span></span>` : `<span class="strong num">${n}</span>`;

  function priceModal() {
    const o = OFFERS[0], np = 129.00, ch = ((o.price - np) / o.price) * 100, nm = ((np - o.cost) / np) * 100;
    return U.modal({
      title: 'Change price · Halden Aurora ANC Headphones', size: 'lg',
      body: `
        <div class="row nowrap gap-3">${U.pimg(P.aurora, 'thumb')}<div class="stack gap-0"><span class="strong">${P.aurora.name}</span><span class="xs muted">Official Store offer · SKU <span class="mono">${P.aurora.sku}</span> · 142 available · cost ${U.money(o.cost)}</span></div></div>
        <div class="grid md3" style="--gap:12px">
          ${U.field('Current price', U.input('aa-pc-cur', o.price.toFixed(2), { prefix: '$', readonly: true }), { hint: 'List price ' + U.money(o.was) })}
          ${U.field('New price', U.input('aa-pc-new', np.toFixed(2), { prefix: '$' }), { hint: 'Change −' + pct(ch) })}
          ${U.field('Show was-price', U.select('aa-pc-was', ['List price $229.00', 'None'], 'List price $229.00'), { hint: 'Must be a real recent price' })}
        </div>
        <div class="grid md2" style="--gap:12px">
          ${U.field('Starts', U.input('aa-pc-start', 'Oct 12, 2026, 12:00 AM PT'))}
          ${U.field('Ends', U.input('aa-pc-end', 'Oct 19, 2026, 11:59 PM PT'), { opt: true })}
        </div>
        ${U.alert('warning', 'This change is above the 30% limit', `Official Store Manager (Dana Ortiz) can change prices by up to 30% without approval. This is a ${pct(ch)} cut, so it goes to Morgan Hale (Business Owner) before it can go live.`)}
        <div class="well stack gap-2">
          ${U.sumRow('Margin now', pct(margin(o)) + ' · ' + U.money(o.price - o.cost) + ' per unit')}
          ${U.sumRow('Margin after change', '<span class="t-danger-text strong">' + pct(nm) + ' · ' + U.money(np - o.cost) + ' per unit</span>')}
          ${U.sumRow('Discount funding', 'Company (Official Store markdown)')}
          ${U.sumRow('Other offers on this product', 'Northwind Audio ' + U.money(184) + ' + ' + U.money(6.99) + ' shipping')}
          <span class="xs muted">The main offer is still chosen by the published rule (eligibility, availability, delivery and total price). The price applies to new orders only; open carts show the change before checkout.</span>
        </div>
        ${U.field('Reason', U.textarea('aa-pc-reason', 'Home Week event, Oct 12–19. Match expected competitor price and clear older stock before the Aurora 2 arrives.'), { hint: 'Required. Recorded in Action history.' })}`,
      foot: `${U.btn('Cancel', { v: 'ghost' })}${U.btn('Send to Morgan Hale for approval', { icon: 'send' })}`,
    });
  }

  U.register({
    id: 'admin/official', title: 'Official Store offers and trading', ref: 'Plan ch. 9, 18',
    notes: 'Company trading summary (sales, margin, discounts, returns) kept separate from marketplace fee income, with company offers showing cost, margin and sellable stock. Price changes show the Official Store Manager 30% limit and route larger changes for approval.',
    states: ['Trading', 'Price change'],
    render: (state) => {
      const s = D.sales14;
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      const off = sum(s.official), sel = sum(s.sellers);
      const page = U.adminLayout(`
        ${U.pageHead('Official Store', {
          crumbs: [{ label: 'Official store' }, { label: 'Offers and trading' }],
          sub: 'Company trading · Sep 25 – Oct 8, 2026 · owner Dana Ortiz, Official Store Manager',
          actions: U.seg(['7 days', '14 days', '30 days'], 1) + U.btn('Trading report', { v: 'secondary', size: 'sm', icon: 'chart-column', href: U.go('admin/reports') }),
        })}
        <div class="aa-kpis">
          <div class="card pad">${U.stat('Company sales', '$' + off.toFixed(1) + 'k', { delta: '6.4%', dir: 'up', note: 'vs prior 14 days' })}</div>
          <div class="card pad">${U.stat('Gross margin', '31.4%', { note: '$' + (off * 0.314).toFixed(1) + 'k after buying cost' })}</div>
          <div class="card pad">${U.stat('Discounts given', '$18.6k', { note: '6.4% of sales · company-funded' })}</div>
          <div class="card pad">${U.stat('Returns', '$7.9k', { delta: '0.3 pts', dir: 'down', note: '2.7% of sales' })}</div>
        </div>
        <div class="aa-split">
          ${U.card({
            title: 'Company sales by day', sub: 'Official Store only · USD',
            body: `${U.legend(['Official Store'])}${U.lineChart({ labels: s.labels, series: [{ name: 'Official Store', data: s.official }], height: 210, area: true, fmt: (v) => '$' + v.toFixed(0) + 'k', label: 'Official Store daily sales' })}`,
          })}
          <div class="stack gap-5">
            ${U.card({
              title: 'Marketplace fee income', sub: 'Reported separately · not company trading',
              body: `<span class="h2 num">$${(sel * 0.1).toFixed(1)}k</span><span class="small sub">on $${sel.toFixed(1)}k of seller sales in the same period. Seller sales are not company revenue and are not in the figures on the left.</span><span class="xs muted">Example rate of 10%. Final fees are in the seller agreement.</span>`,
            })}
            ${U.card({
              title: 'Storefront', sub: 'What customers see on the Official Store page',
              body: `<ul class="list">
                <li>${U.icon('layout-template', 'ic-sm')}<span class="grow small">Official Store page</span><a class="small strong" href="${U.go('store/official')}">View</a></li>
                <li>${U.icon('layers', 'ic-sm')}<span class="grow small">Featured collections · 4 live</span><a class="small strong" href="${U.go('admin/content')}">Manage</a></li>
                <li>${U.icon('file-text', 'ic-sm')}<span class="grow small">Service policies · returns 30 days</span><a class="small strong" href="${U.go('admin/help-content')}">Edit</a></li>
              </ul>`,
            })}
          </div>
        </div>
        <section class="card">
          <div class="card-head"><div class="stack gap-0"><h2 class="h4">Company offers</h2><span class="xs muted">612 offers · price, cost and sellable stock</span></div><div class="row gap-2">${U.btn('Bulk price update', { v: 'secondary', size: 'sm', icon: 'upload' })}${U.btn('Add offer', { size: 'sm', icon: 'plus' })}</div></div>
          <div class="card-body"><div class="toolbar">${U.searchIn('Search company offers by name or SKU', 'aa-of-q')}${U.select('aa-of-st', ['All statuses', 'Active', 'Hidden', 'Out of stock', 'Low stock'], 'All statuses')}${U.select('aa-of-cat', ['All categories', 'Electronics', 'Computers', 'Home & Kitchen', 'Fashion', 'Beauty'], 'All categories')}</div></div>
          ${U.table(['Product', { label: 'Price', cls: 'r' }, { label: 'Cost', cls: 'r' }, { label: 'Margin', cls: 'r' }, { label: 'Available', cls: 'r' }, 'Status', ''],
            OFFERS.map((o) => { const p = P[o.p], m = margin(o); return [
              `<span class="cell-main">${U.pimg(p, 'tiny')}<span class="stack gap-0"><span class="small strong clamp-2">${o.name || p.name}</span><span class="xs muted"><span class="mono">${o.sku || p.sku}</span>${o.note ? ' · ' + o.note : ''}</span></span></span>`,
              U.price(o.price, o.was, { noOff: true }), U.money(o.cost),
              `<span class="strong ${m < 25 ? 't-warning-text' : ''}">${pct(m)}</span>`,
              stockCell(o.stock), U.status(o.st), U.btn('Change price', { v: 'ghost', size: 'sm', href: U.go('admin/official', 'Price change') }),
            ]; }), { rowCls: OFFERS.map((o) => o.stock === 0 ? 'is-flagged' : o.stock < 10 ? 'is-warn' : '') })}
          <div class="card-foot" style="justify-content:space-between"><span class="xs muted">Price change limit: Official Store Manager up to 30%. Larger changes need Business Owner approval. Available excludes reserved and damaged stock.</span>${U.pager(1, 62)}</div>
        </section>
      `, 'official');
      return state === 'Price change' ? page + priceModal() : page;
    },
  });

  /* ======================================================================
     9. admin/purchasing
     ====================================================================== */
  const SUPPLIERS = [
    ['Halden Audio Distribution', 'Los Angeles, CA', 'Carla Nguyen', '6 days', '94%', 2],
    ['Kestrel Peripherals US', 'San Jose, CA', 'Ben Ortiz', '8 days', '89%', 1],
    ['Pellar Cookware Co.', 'Chicago, IL', 'Ruth Adler', '10 days', '97%', 1],
    ['Brightline US', 'Dallas, TX', 'Omar Said', '7 days', '91%', 1],
    ['Mosswood Home Goods', 'Asheville, NC', 'Ivy Chambers', '12 days', '92%', 0],
    ['Aster Labs', 'Irvine, CA', 'Kai Moreno', '5 days', '98%', 0],
  ];
  const POS = [
    ['PUR-2610-0051', 'Halden Audio Distribution', '3 lines · 300 units', 28400.00, 'Not set', 'Draft', '', 'Over $25,000: needs Morgan Hale'],
    ['PUR-2610-0049', 'Brightline US', '2 lines · 120 units', 3360.00, 'Not set', 'Draft', ''],
    ['PUR-2610-0047', 'Pellar Cookware Co.', '1 line · 120 units', 4080.00, 'Oct 16', 'Sent', 'info'],
    ['PUR-2610-0045', 'Kestrel Peripherals US', '2 lines · 80 units', 14920.00, 'Oct 14', 'Sent', 'info'],
    ['PUR-2610-0042', 'Halden Audio Distribution', '3 lines · 260 units', 22860.00, 'Oct 6 · 80 due Oct 13', 'Partly received', 'warning', null, true],
    ['PUR-2609-0038', 'Mosswood Home Goods', '4 lines · 210 units', 6512.00, 'Sep 30', 'Received', 'success'],
    ['PUR-2609-0035', 'Aster Labs', '1 line · 300 units', 2880.00, 'Sep 28', 'Received', 'success'],
  ];

  function poDrawer() {
    const lines = [
      ['HAL-AUR-BLK', 'Aurora ANC Headphones, Midnight black', 100, 60, 2, 128.00, 'Rest due Oct 13'],
      ['HAL-AUR-SLV', 'Aurora ANC Headphones, Silver', 40, 40, 0, 128.00, 'Complete'],
      ['HAL-PKT-TEAL', 'Pocket Bluetooth Speaker, Teal', 120, 80, 0, 38.50, 'Rest due Oct 13'],
    ];
    return U.drawer({
      title: 'PUR-2610-0042',
      body: `
        <div class="row between">${U.status('Partly received', 'warning')}<span class="xs muted">Created Sep 24 by Ken Watanabe</span></div>
        ${U.kv([['Supplier', 'Halden Audio Distribution, Los Angeles, CA'], ['Ship to', 'Marketly warehouse, Reno, NV'], ['Expected', 'Oct 6 · remaining 80 units Oct 13'], ['Approval', 'Within Ken Watanabe\'s limit (POs up to $25,000)'], ['Payment terms', 'Net 30 from invoice']])}
        <div class="stack gap-2"><span class="label">Lines · expected vs received</span>
          ${lines.map(([sku, n, ord, rec, dmg, cost, note]) => `<div class="panel stack gap-2">
            <div class="row between top"><span class="stack gap-0"><span class="small strong">${n}</span><span class="xs muted mono">${sku}</span></span><span class="small num strong">${U.money(ord * cost)}</span></div>
            ${U.meter(Math.round((rec / ord) * 100), rec === ord ? 'success' : 'warning')}
            <div class="row between xs"><span><b class="num">${rec}</b> of <b class="num">${ord}</b> received${dmg ? ` · <span class="t-danger-text strong">${dmg} damaged, held</span>` : ''}</span><span class="muted">${U.money(cost)} each · ${note}</span></div>
          </div>`).join('')}
        </div>
        <div class="well stack gap-2">
          ${U.sumRow('Lines subtotal', U.money(22540))}
          ${U.sumRow('Freight', U.money(320))}
          ${U.sumRow('PO total', U.money(22860), 'total')}
          ${U.sumRow('Received value', U.money(15880))}
          ${U.sumRow('Supplier claim · 2 damaged', U.money(256))}
        </div>
        ${U.alert('info', 'Stock made available', 'Ana Silva received 180 units on Oct 6 (receiving REC-261006-03). Inventory made 178 sellable; 2 damaged units are in Damaged or held until the supplier claim is settled.')}
        ${U.timeline([
          { t: 'Partly received · 180 of 260', d: 'Oct 6, 11:40 AM · Ana Silva, Warehouse', state: 'warn' },
          { t: 'Supplier confirmed backorder of 80 units', d: 'Oct 2 · new date Oct 13', state: 'done' },
          { t: 'Sent to supplier', d: 'Sep 25, 9:10 AM · Ken Watanabe', state: 'done' },
          { t: 'Draft created', d: 'Sep 24, 4:22 PM · Ken Watanabe', state: 'done' },
        ])}`,
      foot: `${U.btn('Open supplier claim', { v: 'ghost' })}${U.btn('Record receipt', { icon: 'package-check', href: U.go('ops/receiving') })}`,
    });
  }

  U.register({
    id: 'admin/purchasing', title: 'Suppliers and purchasing', ref: 'Plan ch. 9',
    notes: 'Suppliers with lead times and on-time rates, and purchase orders with status Draft, Sent, Partly received or Received. The purchase order drawer compares expected and received quantities, costs and damage, and shows the Purchasing Manager approval limit.',
    states: ['Purchase orders', 'Purchase order'],
    render: (state) => {
      const page = U.adminLayout(`
        ${U.pageHead('Suppliers and purchasing', {
          crumbs: [{ label: 'Official store' }, { label: 'Suppliers and purchasing' }],
          sub: 'Owner Ken Watanabe, Purchasing Manager · POs up to $25,000 without extra approval',
          actions: U.btn('Add supplier', { v: 'secondary', size: 'sm', icon: 'plus' }) + U.btn('New purchase order', { size: 'sm', icon: 'file-plus' }),
        })}
        <div class="aa-kpis">
          <div class="card pad">${U.stat('Open purchase orders', '5', { note: U.money(73620) + ' committed' })}</div>
          <div class="card pad">${U.stat('Incoming units', '660', { note: 'Next arrival Oct 13' })}</div>
          <div class="card pad">${U.stat('Late or short', '<span class="t-warning-text">1</span>', { note: 'PUR-2610-0042 · 80 units' })}</div>
          <div class="card pad">${U.stat('Low-stock items', '12', { note: 'Reorder suggested for 7' })}</div>
        </div>
        <section class="card">
          ${U.tabs([{ label: 'Purchase orders', count: 7 }, { label: 'Suppliers', count: 6 }, { label: 'Reorder suggestions', count: 7 }], 0)}
          <div class="card-body"><div class="toolbar">${U.searchIn('Search PUR ref, supplier or SKU', 'aa-po-q')}${U.select('aa-po-st', ['All statuses', 'Draft', 'Sent', 'Partly received', 'Received'], 'All statuses')}${U.select('aa-po-sup', ['All suppliers'].concat(SUPPLIERS.map((x) => x[0])), 'All suppliers')}</div></div>
          ${U.table(['Purchase order', 'Supplier', 'Items', { label: 'Cost', cls: 'r' }, 'Expected arrival', 'Status', ''],
            POS.map(([r, sup, items, cost, exp, st, tone, note, open]) => [
              `<a class="mono strong nowrap" href="${U.go('admin/purchasing', 'Purchase order')}">${r}</a>`, `<span class="small strong">${sup}</span>`, `<span class="small">${items}</span>`,
              `<span class="stack gap-0"><span class="strong">${U.money(cost)}</span>${note ? `<span class="xs t-warning-text strong">${note}</span>` : ''}</span>`,
              `<span class="small nowrap">${exp}</span>`, U.status(st, tone), U.btn(open ? 'Open' : 'View', { v: 'ghost', size: 'sm', href: U.go('admin/purchasing', 'Purchase order') }),
            ]), { rowCls: POS.map((x) => x[7] ? 'is-warn' : x[8] ? 'is-warn' : '') })}
        </section>
        ${U.card({
          title: 'Suppliers', sub: 'Lead time and on-time arrival over the last 90 days', flush: true,
          body: U.table(['Supplier', 'Contact', { label: 'Lead time', cls: 'r' }, { label: 'On time', cls: 'r' }, { label: 'Open POs', cls: 'r' }],
            SUPPLIERS.map(([n, loc, c, lead, ot, open]) => [`<span class="stack gap-0"><span class="small strong">${n}</span><span class="xs muted">${loc}</span></span>`, `<span class="small">${c}</span>`, lead, `<span class="${parseInt(ot, 10) < 90 ? 't-warning-text strong' : ''}">${ot}</span>`, open])),
        })}
      `, 'purchasing');
      return state === 'Purchase order' ? page + poDrawer() : page;
    },
  });

  /* ======================================================================
     10. admin/sellers
     ====================================================================== */
  const SELLERS = [
    { id: 'northwind', st: 'Approved', ver: true, rating: '98% · 4,812', ot: 97.8, cases: 1, bal: 4862.10, rest: null },
    { id: 'pixelport', st: 'Approved', ver: true, rating: '96% · 2,391', ot: 95.1, cases: 2, bal: 3118.44, rest: null },
    { id: 'casaverde', st: 'Approved', ver: true, rating: '97% · 1,730', ot: 88.4, cases: 3, bal: 2240.90, rest: null, warn: 'Performance warning sent Oct 2' },
    { id: 'trailhead', st: 'Approved', ver: true, rating: '95% · 980', ot: 96.2, cases: 0, bal: 1906.30, rest: null },
    { id: 'harbor', st: 'Approved', ver: true, rating: '99% · 611', ot: 99.1, cases: 0, bal: 812.00, rest: null },
    { id: 'gadgetgrove', st: 'Restricted', ver: false, rating: '89% · 412', ot: 81.5, cases: 4, bal: 1372.15, held: 640.00, rest: 'Refurbished offers and new listings paused' },
    { id: 'bolt', st: 'Suspended', ver: false, rating: '71% · 208', ot: 64.0, cases: 2, bal: -212.40, rest: 'All new sales stopped · appeal closed Sep 29' },
    { id: 'lumen', st: 'Under review', ver: false, rating: null, ot: null, cases: 0, bal: 0, rest: 'Application · decision due Oct 9' },
    { id: 'fernhill', st: 'Information required', ver: false, rating: null, ot: null, cases: 0, bal: 0, rest: 'Waiting on tax form · due Oct 15' },
    { id: 'oldmill', st: 'Closed', ver: false, rating: '94% · 120', ot: null, cases: 0, bal: 0, rest: 'Closed by seller Aug 31' },
  ];
  const sellerHref = (r) => U.go(r.st === 'Under review' || r.st === 'Information required' ? 'admin/seller-application' : 'admin/seller');
  const otCell = (v) => v === null ? '<span class="muted">—</span>' : `<span class="stack gap-1" style="min-width:90px"><span class="strong num ${v < 90 ? 't-danger-text' : v < 95 ? 't-warning-text' : ''}">${pct(v)}</span>${U.meter(v, v < 90 ? 'danger' : v < 95 ? 'warning' : 'success')}</span>`;
  const balCell = (r) => r.bal < 0 ? `<span class="stack gap-0"><span class="strong t-danger-text">−${U.money(-r.bal)}</span>${U.badge('Negative', 'danger')}</span>` : `<span class="stack gap-0"><span class="strong">${U.money(r.bal)}</span>${r.held ? `<span class="xs t-warning-text strong">${U.money(r.held)} held</span>` : ''}</span>`;

  U.register({
    id: 'admin/sellers', title: 'Sellers', ref: 'Plan ch. 10, 18',
    notes: 'All marketplace sellers with account status, verification, rating, on-time dispatch, open cases, balance and active restrictions, filterable by status. Account status, verification and payout balance are shown separately as the plan requires.',
    render: () => U.adminLayout(`
      ${U.pageHead('Sellers', {
        crumbs: [{ label: 'Sellers' }],
        sub: '48 seller accounts · owner Grace Kim, Seller Manager · Official Store is managed under Official store',
        actions: U.btn('Export', { v: 'secondary', size: 'sm', icon: 'download' }) + U.btn('Applications · 7', { v: 'secondary', size: 'sm', icon: 'file-check', href: U.go('admin/seller-application') }) + U.btn('Invite seller', { size: 'sm', icon: 'send' }),
      })}
      <div class="aa-kpis">
        <div class="card pad">${U.stat('Selling now', '38', { note: '5 added this month' })}</div>
        <div class="card pad">${U.stat('Below dispatch target', '<span class="t-warning-text">3</span>', { note: 'Target 95% on time' })}</div>
        <div class="card pad">${U.stat('Restricted or suspended', '2', { note: '1 appeal under review' })}</div>
        <div class="card pad">${U.stat('Seller balances', U.money(84210.66), { note: U.money(2140) + ' held · 1 negative' })}</div>
      </div>
      <section class="card">
        ${U.tabs([{ label: 'All', count: 48 }, { label: 'Approved', count: 38 }, { label: 'Applied', count: 4 }, { label: 'Information required', count: 1 }, { label: 'Under review', count: 2 }, { label: 'Restricted', count: 1 }, { label: 'Suspended', count: 1 }, { label: 'Closed', count: 1 }], 0)}
        <div class="card-body">
          <div class="toolbar">${U.searchIn('Search seller name, legal name or contact email', 'aa-sl-q')}</div>
          <div class="aa-filters c5">
            ${flt('aa-sl-st', 'Status', ['Any status', 'Applied', 'Information required', 'Under review', 'Approved', 'Restricted', 'Suspended', 'Closed'], 'Any status')}
            ${flt('aa-sl-ver', 'Verification', ['Any', 'Verified seller', 'Not verified'], 'Any')}
            ${flt('aa-sl-perf', 'On-time dispatch', ['Any', 'Below 95% target', 'Below 90%'], 'Any')}
            ${flt('aa-sl-cat', 'Main category', ['Any category', 'Electronics', 'Computers', 'Home & Kitchen', 'Sports & Outdoors'], 'Any category')}
            ${flt('aa-sl-bal', 'Balance', ['Any balance', 'Has held amounts', 'Negative balance'], 'Any balance')}
          </div>
        </div>
        <div class="no-phone">${U.table(['Seller', 'Status', 'Verified', 'Rating', 'On-time dispatch', { label: 'Open cases', cls: 'r' }, { label: 'Balance', cls: 'r' }, 'Restrictions'],
          SELLERS.map((r) => [
            `<a class="row nowrap gap-2" href="${sellerHref(r)}" style="color:inherit">${lt(r.id)}<span class="stack gap-0"><span class="small strong">${sname(r.id)}</span><span class="xs muted">${S[r.id].location}</span></span></a>`,
            U.status(r.st), r.ver ? U.badge('Verified', 'info', 'shield-check') : '<span class="xs muted">Not verified</span>',
            r.rating ? `<span class="small num">${r.rating}</span>` : '<span class="muted">—</span>', otCell(r.ot),
            r.cases ? `<span class="strong ${r.cases > 2 ? 't-warning-text' : ''}">${r.cases}</span>` : '0', balCell(r),
            r.rest ? `<span class="small" style="max-width:28ch;display:inline-block">${r.rest}</span>` : r.warn ? `<span class="xs t-warning-text strong">${r.warn}</span>` : '<span class="xs muted">None</span>',
          ]), { rowCls: SELLERS.map((r) => r.st === 'Suspended' ? 'is-flagged' : r.st === 'Restricted' || r.warn ? 'is-warn' : '') })}</div>
        <div class="only-phone" style="padding:0 var(--sp-4) var(--sp-4)"><div class="aa-mlist">${SELLERS.map((r) => `<a class="aa-mcard ${r.st === 'Suspended' ? 'is-flagged' : r.st === 'Restricted' ? 'is-warn' : ''}" href="${sellerHref(r)}">
            <span class="row nowrap gap-3">${lt(r.id)}<span class="stack gap-0 grow"><span class="small strong">${sname(r.id)}</span><span class="xs muted">${S[r.id].location}</span></span>${U.status(r.st)}</span>
            <span class="row gap-3 xs"><span>On time <b>${r.ot === null ? '—' : pct(r.ot)}</b></span><span>Cases <b>${r.cases}</b></span><span>Balance <b>${r.bal < 0 ? '−' + U.money(-r.bal) : U.money(r.bal)}</b></span>${r.ver ? U.badge('Verified', 'info', 'shield-check') : ''}</span>
            ${r.rest ? `<span class="xs sub">${r.rest}</span>` : ''}
          </a>`).join('')}</div></div>
        <div class="card-foot" style="justify-content:space-between"><span class="xs muted">Balance is what we owe the seller after fees and refunds. It is not paid until a payout is sent.</span>${U.pager(1, 5)}</div>
      </section>
    `, 'sellers'),
  });

  /* ======================================================================
     11. admin/seller-application — Lumen Cycle Co.
     ====================================================================== */
  const vcheck = (tone, ic, title, result, meta) => `<div class="aa-chk t-${tone}">${U.icon(ic)}<div class="stack gap-1"><div class="row between"><span class="small strong">${title}</span>${U.badge(tone === 'success' ? 'Passed' : tone === 'warning' ? 'Needs attention' : 'Failed', tone)}</div><span class="small sub">${result}</span><span class="xs muted">${meta}</span></div></div>`;

  U.register({
    id: 'admin/seller-application', title: 'Seller application review', ref: 'Plan ch. 10, 2',
    notes: 'Application review with business, contact and store details, verification checks with results, Trust and Risk flags and documents. Each decision has its own requirements: requesting information needs a list and deadline, and rejecting needs an explanation the applicant will read.',
    states: ['Review', 'Request information', 'Reject'],
    render: (state) => {
      const st = state || 'Review';
      let decision;
      if (st === 'Request information') {
        decision = U.card({
          title: 'Request information', sub: 'Status changes to Information required. The applicant gets an email and a task in their application.',
          body: `<div class="stack gap-2"><span class="label">What the applicant must send</span>
              ${U.check('aa-ap-n1', '<span class="small"><b>Bank letter or statement</b> showing the account holder as Lumen Cycle Company LLC</span>', true)}
              ${U.check('aa-ap-n2', '<span class="small"><b>UL 2271 certificates</b> for the e-bike batteries in the product plan, or remove those products</span>', true)}
              ${U.check('aa-ap-n3', '<span class="small">Proof of address for the return address</span>', false)}
              ${U.check('aa-ap-n4', '<span class="small">Photo ID for an additional business owner</span>', false)}
            </div>
            <div class="grid md2" style="--gap:12px">
              ${U.field('Reply by', U.input('aa-ap-due', 'Thu, Oct 22, 2026'), { hint: '14 days. The application closes if there is no reply.' })}
              ${U.field('Reminder', U.select('aa-ap-rem', ['3 days before the deadline', 'No reminder'], '3 days before the deadline'))}
            </div>
            ${U.field('Message to applicant', U.textarea('aa-ap-msg', 'Thanks for applying. To finish our review, please upload a bank letter that shows Lumen Cycle Company LLC as the account holder, and UL 2271 certificates for the e-bike batteries you plan to sell. You can upload both from your application page.'))}`,
          foot: `${U.btn('Back', { v: 'ghost', href: U.go('admin/seller-application') })}${U.btn('Send request', { icon: 'send' })}`,
        });
      } else if (st === 'Reject') {
        decision = U.card({
          title: 'Reject application', sub: 'The applicant reads your explanation. Rejections are recorded in Action history.',
          body: `${U.field('Reason', U.select('aa-ap-rr', ['Choose a reason', 'Could not verify identity or business', 'Products outside the allowed assortment', 'Risk review not passed', 'Duplicate account'], 'Products outside the allowed assortment'))}
            ${U.field('Explanation to applicant', U.textarea('aa-ap-rx', '', 'Explain what we checked, why the application cannot be approved and what would change the outcome'), { error: 'Write an explanation. The applicant sees this text, so say what was checked and what they can do next.' })}
            ${U.field('Can reapply after', U.select('aa-ap-ra', ['Immediately', '30 days', '90 days', 'Not eligible'], '30 days'))}
            ${U.alert('info', 'Before you reject', 'Two checks passed and two need attention. Requesting information is usually the right step when documents can fix the issue.')}`,
          foot: `${U.btn('Back', { v: 'ghost', href: U.go('admin/seller-application') })}${U.btn('Reject application', { v: 'danger', icon: 'circle-x', disabled: true })}`,
        });
      } else {
        decision = U.card({
          title: 'Decision', sub: 'Decision target: Oct 9 (5 business days)',
          body: `<div class="stack gap-2">
              ${U.optCard('aa-ap-d', 'aa-ap-d1', '<span class="small strong">Approve</span>', 'Seller can set up their store. Products still need review before they go live.', false, { disabled: true })}
              <span class="xs t-warning-text strong" style="padding-left:var(--sp-4)">${U.icon('lock', 'ic-sm')} Resolve the payout account check before approving.</span>
              <a class="opt-card" href="${U.go('admin/seller-application', 'Request information')}" style="color:inherit;text-decoration:none"><span class="stack gap-1 grow"><span class="small strong">Request information</span><span class="small sub">Ask for documents with a deadline</span></span>${U.icon('chevron-right', 'ic-sm')}</a>
              <a class="opt-card" href="${U.go('admin/seller-application', 'Reject')}" style="color:inherit;text-decoration:none"><span class="stack gap-1 grow"><span class="small strong">Reject</span><span class="small sub">Explanation required</span></span>${U.icon('chevron-right', 'ic-sm')}</a>
            </div>
            <span class="xs muted">Approval does not publish products or allow payouts. Payout readiness and product approval are tracked separately.</span>`,
        });
      }
      return U.adminLayout(`
        ${U.pageHead('Lumen Cycle Co.', {
          crumbs: [{ label: 'Sellers' }, { label: 'Applications', href: U.go('admin/seller-application') }, { label: 'Lumen Cycle Co.' }],
          sub: `Application APP-261002-0094 · applied Oct 2, 2026 · reviewer Grace Kim · ${U.status(st === 'Request information' ? 'Information required' : 'Under review')}`,
          actions: U.btn('Message applicant', { v: 'secondary', size: 'sm', icon: 'mail' }) + U.btn('Assign', { v: 'secondary', size: 'sm', icon: 'user-plus' }),
        })}
        ${U.steps(['Applied', 'Checks', 'Under review', 'Decision', 'Store setup', 'Launch ready'], 2)}
        <div class="aa-split">
          <div class="stack gap-5">
            ${U.card({
              title: 'Business and store details',
              body: `<div class="aa-2">
                <div class="aa-sec"><span class="h4">Business</span>${U.kv([['Legal name', 'Lumen Cycle Company LLC'], ['Type', 'Limited liability company'], ['Registered', 'Oregon, 2019'], ['EIN', '•• •••4471'], ['Address', '61 NW Oregon Ave, Bend, OR 97703'], ['Seller type', 'Business · seller shipping']])}</div>
                <div class="aa-sec"><span class="h4">Contact</span>${U.kv([['Owner', 'Marisol Vega'], ['Email', 'marisol@lumencycle.example'], ['Phone', '(541) 555-0172'], ['Support hours', 'Mon–Fri, 8 AM–5 PM PT']])}</div>
              </div>
              <div class="aa-sec"><span class="h4">Store</span>${U.kv([['Store name', 'Lumen Cycle Co.'], ['Categories', 'Sports & Outdoors › Cycling'], ['Planned products', 'About 120 · lights, locks, tools, e-bike batteries'], ['Shipping', 'Contiguous US · UPS Ground, USPS Priority · dispatch 1 business day'], ['Return address', '61 NW Oregon Ave, Bend, OR 97703'], ['Agreement', 'Seller agreement v2026.3, fee schedule and product rules accepted Oct 2, 4:51 PM']])}</div>`,
            })}
            ${U.card({
              title: 'Verification checks', sub: '2 passed · 2 need attention',
              body: `${vcheck('success', 'id-card', 'Identity', 'Marisol Vega · photo ID matched selfie and name on application.', 'Automated check · Oct 3, 9:12 AM')}
                ${vcheck('success', 'building-2', 'Business registration', 'Active in Oregon Secretary of State records since Apr 2019. Owner listed as Marisol Vega.', 'Automated check · Oct 3, 9:13 AM')}
                ${vcheck('warning', 'landmark', 'Payout account', 'Account holder name "M. Vega" does not match the legal business name. Payouts need a business account or proof of ownership.', 'Bank verification · Oct 3, 9:20 AM')}
                ${vcheck('warning', 'map-pin', 'Return address', 'Address exists and accepts packages. It is the same as the business address; no proof of occupancy uploaded.', 'Address check · Oct 3, 9:21 AM')}`,
            })}
            ${U.card({
              title: 'Risk flags from Trust and Risk', sub: 'Sven Larsen · reviewed Oct 6',
              body: `<ul class="list">
                <li>${U.badge('Medium', 'warning')}<span class="grow small">Payout account holder name does not match the legal business name.</span></li>
                <li>${U.badge('Medium', 'warning')}<span class="grow small">Product plan includes e-bike batteries. Restricted category: needs UL 2271 safety certification.</span></li>
                <li>${U.badge('Low', 'info')}<span class="grow small">No previous marketplace selling history. Recommend a 60-day payout hold window after approval.</span></li>
              </ul>
              <span class="xs muted">Recommendation: request information. No signs of a linked or previously closed account.</span>`,
            })}
            ${U.card({
              title: 'Documents', sub: '4 uploaded · 1 missing',
              body: `<div class="stack gap-2">
                <div class="aa-doc">${U.icon('file-text')}<span class="grow">Articles of organization.pdf</span><span class="xs muted">412 KB</span>${U.btn('View', { v: 'ghost', size: 'sm' })}</div>
                <div class="aa-doc">${U.icon('id-card')}<span class="grow">Driver license, Marisol Vega (redacted)</span><span class="xs muted">1.2 MB</span>${U.btn('View', { v: 'ghost', size: 'sm' })}</div>
                <div class="aa-doc">${U.icon('file-text')}<span class="grow">Form W-9.pdf</span><span class="xs muted">188 KB</span>${U.btn('View', { v: 'ghost', size: 'sm' })}</div>
                <div class="aa-doc">${U.icon('file-text')}<span class="grow">Bank letter.pdf</span><span class="xs muted">96 KB</span>${U.btn('View', { v: 'ghost', size: 'sm' })}</div>
                <div class="aa-doc" style="border-style:dashed">${U.icon('file-x')}<span class="grow t-danger-text strong">UL 2271 battery certificates · not uploaded</span></div>
              </div>`,
            })}
          </div>
          <div class="stack gap-5">
            ${decision}
            ${U.card({
              title: 'Status timeline', body: U.timeline([
                { t: 'Applied', d: 'Oct 2, 4:51 PM · Marisol Vega', state: 'done' },
                { t: 'Automated checks finished', d: 'Oct 3, 9:21 AM · 2 need attention', state: 'warn' },
                { t: 'Under review · Grace Kim', d: 'Oct 5, 10:02 AM', state: 'done' },
                { t: 'Trust and Risk review', d: 'Oct 6, 3:40 PM · Sven Larsen', state: 'done' },
                st === 'Request information' ? { t: 'Information required', d: 'Today · reply by Oct 22', state: 'current' } : { t: 'Decision', d: 'Due Oct 9', state: 'current' },
              ]),
            })}
            ${U.card({
              title: 'Notes', body: `<div class="aa-note"><span class="row between xs"><b>Grace Kim</b><span class="muted">Oct 6, 4:05 PM</span></span><span>Good fit for cycling. If documents come back clean, approve with batteries excluded until certificates are checked.</span></div>${U.field('Add a note', U.textarea('aa-ap-note', '', 'Visible to staff only'))}`,
            })}
          </div>
        </div>
      `, 'applications');
    },
  });

  /* ======================================================================
     12. admin/seller — Gadget Grove (Restricted)
     ====================================================================== */
  function suspendModal() {
    return U.modal({
      title: 'Suspend Gadget Grove', size: 'lg',
      body: `
        ${U.alert('danger', 'Suspension stops all new sales', 'Customers can no longer buy from Gadget Grove. Existing orders, returns and cases stay open and accessible to the seller and our teams until they are resolved.')}
        <div class="stack gap-2"><span class="label">What happens</span>
          ${U.table(['Area', 'Effect'], [
            ['<span class="small strong">Offers · 31</span>', '<span class="small">Removed from sale now. Shared products stay live with other sellers\' offers.</span>'],
            ['<span class="small strong">Open orders · 7</span>', '<span class="small">Choose below. Customers are told about any change to their items.</span>'],
            ['<span class="small strong">Returns · 2</span>', '<span class="small">Stay open. Seller keeps access to respond. Lena Park takes over if a deadline is missed.</span>'],
            ['<span class="small strong">Cases · 4</span>', '<span class="small">Stay open with Isabel Cruz\'s team. Seller can still reply and upload evidence.</span>'],
            ['<span class="small strong">Payouts</span>', `<span class="small">Available ${U.money(732.15)} and pending ${U.money(1018.40)} move to Held. Reason: cover refunds on open orders and cases. Review date Nov 7.</span>`],
            ['<span class="small strong">Seller Center</span>', '<span class="small">Read and fulfil only. Seller sees the reason and how to appeal.</span>'],
          ])}
        </div>
        <div class="stack gap-2"><span class="label">Open orders</span>
          ${U.optCard('aa-ss-o', 'aa-ss-o1', '<span class="small strong">Seller keeps fulfilling open orders</span>', '5 orders are within their dispatch deadline', true)}
          ${U.optCard('aa-ss-o', 'aa-ss-o2', '<span class="small strong">Cancel unshipped orders and refund customers</span>', '7 orders · ' + U.money(1284.00) + ' · Finance approval needed', false)}
        </div>
        <div class="grid md2" style="--gap:12px">
          ${U.field('Reason', U.select('aa-ss-r', ['Choose a reason', 'Repeated late dispatch after restriction', 'Counterfeit or unsafe products', 'Fraud or abuse', 'Failure to resolve cases'], 'Repeated late dispatch after restriction'))}
          ${U.field('Review date', U.input('aa-ss-d', 'Sat, Nov 7, 2026'))}
        </div>
        ${U.field('Details shown to the seller', U.textarea('aa-ss-x', 'On-time dispatch stayed at 81.5% during the restriction (target 95%), with 2 more overdue orders this week. New sales are suspended until the review on Nov 7.'), { hint: 'Required. Include facts and what the seller can do to resolve it.' })}
        <div class="well stack gap-2">
          ${U.field('Second reviewer', U.select('aa-ss-rv', ['Grace Kim · Seller Manager', 'Morgan Hale · Business Owner'], 'Grace Kim · Seller Manager'), { hint: 'Suspension takes effect only after a second reviewer approves.' })}
          <span class="xs muted">Appeal route: seller can appeal in Seller Center within 14 days. Appeals are decided by someone who did not make this decision.</span>
        </div>`,
      foot: `${U.btn('Cancel', { v: 'ghost' })}${U.btn('Send to second reviewer', { v: 'danger', icon: 'send' })}`,
    });
  }

  U.register({
    id: 'admin/seller', title: 'Seller detail', ref: 'Plan ch. 10, 14, 18, 21',
    notes: 'A restricted seller with performance against targets, the active restriction (reason, affected activity, appeal route), appeals, payout holds with reason and review date, and the open orders, returns and cases that must stay accessible. Suspension explains its effect on each and needs a second reviewer.',
    states: ['Profile', 'Suspend seller'],
    render: (state) => {
      const page = U.adminLayout(`
        ${U.pageHead(`<span class="row gap-3">${U.logoTile(S.gadgetgrove)}<span>Gadget Grove</span></span>`, {
          crumbs: [{ label: 'Sellers', href: U.go('admin/sellers') }, { label: 'Gadget Grove' }],
          sub: `Phoenix, AZ · seller since Mar 2026 · owner Raj Mehta · account manager Grace Kim · ${U.status('Restricted')} <span class="xs muted">Not verified</span>`,
          actions: U.btn('Message seller', { v: 'secondary', size: 'sm', icon: 'mail' }) + U.btn('Edit restriction', { v: 'secondary', size: 'sm', icon: 'pencil' }) + U.btn('Suspend', { v: 'danger-soft', size: 'sm', icon: 'ban', href: U.go('admin/seller', 'Suspend seller') }),
        })}
        <section class="card" style="border-color:var(--warning)">
          <div class="card-head"><div class="row gap-2">${U.icon('triangle-alert')}<h2 class="h4">Active restriction since Oct 2, 2026</h2></div>${U.badge('Review Oct 30', 'warning', 'calendar')}</div>
          <div class="card-body">
            ${U.kv([
              ['Reason', 'On-time dispatch below 85% for 30 days, and 2 refurbished items described as "like new" with missing parts.'],
              ['Affected activity', 'Refurbished offers (6) removed from sale. No new listings or product submissions. Weekly payouts held 14 days after delivery.'],
              ['Not affected', 'New-condition offers (25) stay on sale. Open orders, returns, cases and messages work as normal.'],
              ['To resolve', 'Reach 92% on-time dispatch for 21 days and add condition photos to every refurbished offer.'],
              ['Appeal route', 'Seller Center › Account health › Appeal, by Oct 16. Decided by Grace Kim; a second appeal goes to Morgan Hale.'],
              ['Set by', 'Grace Kim, Seller Manager · recommended by Sven Larsen, Trust and Risk'],
            ])}
          </div>
        </section>
        <div class="aa-split">
          <div class="stack gap-5">
            ${U.card({
              title: 'Performance vs targets', sub: 'Last 30 days · 186 orders',
              body: `<div class="aa-perf">
                ${meterRow('On-time dispatch', '81.5%', '≥ 95%', 81.5, 'danger', '34 late of 186')}
                ${meterRow('Cancellation rate', '4.8%', '≤ 2%', 48, 'danger', '9 cancelled by seller')}
                ${meterRow('Valid tracking', '96.2%', '≥ 98%', 96.2, 'warning', '7 without carrier scan')}
                ${meterRow('Return rate', '6.1%', '≤ 8%', 61, 'success', 'Within target')}
                ${meterRow('Response time', '31 h', '≤ 24 h', 77, 'warning', 'Median first reply')}
                ${meterRow('Unresolved cases', '4', '0 over 3 days', 60, 'warning', '2 older than 3 days')}
              </div>
              <span class="xs muted">Policy violations in 90 days: 2 (condition misdescribed). Seller feedback: 89% positive from 412 ratings.</span>`,
            })}
            ${U.card({
              title: 'Open obligations', sub: 'Stay accessible during any restriction or suspension', flush: true,
              body: `${U.tabs([{ label: 'Orders', count: 7 }, { label: 'Returns', count: 2 }, { label: 'Cases', count: 4 }], 0)}
                ${U.table(['Order', 'Item', 'Status', 'Deadline', ''], [
                  [oref('MK-261006-09977'), 'Brightline S2 Robot Vacuum', U.status('Overdue'), U.deadline('Overdue 1 d', 'danger'), U.btn('Remind', { v: 'ghost', size: 'sm' })],
                  [oref('MK-261006-09311'), 'Brightline S2 Robot Vacuum', U.status('Overdue'), U.deadline('Overdue 1 d', 'danger'), U.btn('Remind', { v: 'ghost', size: 'sm' })],
                  [oref('MK-261007-10291'), 'Halden Aurora ANC (Refurbished)', U.status('Preparing'), U.deadline('Due Oct 9', 'warning'), ''],
                  [oref('MK-261008-11730'), 'Kestrel K75 Keyboard', U.status('New'), U.deadline('Due Oct 10', 'ok'), ''],
                ], { rowCls: ['is-flagged', 'is-flagged', '', ''] })}
                <div class="card-body" style="padding-top:var(--sp-2)"><span class="xs muted">Also open: returns RT-261001-0158 and RT-260927-0131 · cases CS-261004-0377, CS-261005-0390, CS-261007-0401, CS-261008-0415.</span></div>`,
            })}
            ${U.card({
              title: 'Appeals', flush: true,
              body: U.table(['Appeal', 'Submitted', 'Argument', 'Owner', 'Status'], [
                ['<span class="mono">AP-261004-021</span>', 'Oct 4', '<span class="small">Carrier missed 3 pickups in Phoenix in September. UPS pickup log attached.</span>', 'Grace Kim', `<span class="stack gap-1">${U.status('Under review')}${U.deadline('Decide by Oct 11', 'warning')}</span>`],
                ['<span class="mono">AP-260821-007</span>', 'Aug 21', '<span class="small">Listing warning for "like new" condition wording.</span>', 'Grace Kim', `<span class="stack gap-1">${U.status('Decision made')}<span class="xs muted">Warning kept · Aug 25</span></span>`],
              ]),
            })}
            ${U.card({ title: 'Action history', actions: `<a class="small strong" href="${U.go('admin/audit')}">Full log</a>`, body: U.timeline([
              { t: 'Appeal AP-261004-021 received', d: 'Oct 4, 2:10 PM · Raj Mehta, seller', state: 'current' },
              { t: 'Restriction applied', d: 'Oct 2, 9:30 AM · Grace Kim', state: 'warn', body: 'Reason: on-time dispatch 79.8% over 30 days; 2 condition misdescriptions. Review date Oct 30.' },
              { t: 'Payout hold set to 14 days after delivery', d: 'Oct 2, 9:31 AM · Priya Nair, Finance', state: 'warn', body: 'Reason: open cases may need refunds.' },
              { t: 'Performance warning sent', d: 'Sep 15 · Grace Kim', state: 'done' },
              { t: 'Approved to sell', d: 'Mar 18, 2026 · Grace Kim', state: 'done' },
            ]) })}
          </div>
          <div class="stack gap-5">
            ${U.card({
              title: 'Account', body: U.kv([
                ['Account status', U.status('Restricted')],
                ['Verification', 'Identity and business passed · Verified label not granted: business license renewal expired Sep 30'],
                ['Product approval', '31 approved · 0 waiting (submissions blocked)'],
                ['Payout readiness', 'Bank account verified · payouts on hold rule'],
                ['Legal name', 'Gadget Grove Trading LLC'],
                ['Contact', 'raj@gadgetgrove.example · (602) 555-0139'],
              ]),
            })}
            ${U.card({
              title: 'Payouts and holds', actions: `<a class="small strong" href="${U.go('admin/payouts')}">Finance view</a>`,
              body: `<div class="stack gap-2">
                  ${U.sumRow('Pending earnings', U.money(1018.40))}
                  ${U.sumRow('Available', U.money(732.15))}
                  ${U.sumRow('Held', '<span class="t-warning-text strong">' + U.money(640.00) + '</span>')}
                </div>
                <div class="panel stack gap-1"><span class="small strong">Hold · ${U.money(640.00)}</span><span class="xs sub">Reason: covers possible refunds on 4 open cases. Review date Oct 30. Set by Priya Nair.</span></div>
                <div class="row between small"><span>Next payout · Fri, Oct 9</span>${U.status('Scheduled')}</div>
                <span class="xs muted">${U.money(732.15)} to Chase •••• 2208. Scheduled is not paid; the seller sees "Paid" only after the bank confirms.</span>`,
            })}
            ${U.card({
              title: 'Notes', body: `<div class="aa-note"><span class="row between xs"><b>Grace Kim</b><span class="muted">Oct 7</span></span><span>Pickup log checks out for 3 days only. Not enough to explain 34 late orders. Leaning toward keeping the restriction.</span></div>${U.field('Add a note', U.textarea('aa-sd-note', '', 'Visible to staff only'))}`,
            })}
          </div>
        </div>
      `, 'sellers');
      return state === 'Suspend seller' ? page + suspendModal() : page;
    },
  });

  /* ======================================================================
     13. admin/shipping
     ====================================================================== */
  const CARRIERS = [
    { n: 'UPS', acct: 'Account •••• 7Y2W · connected', ot: '96.1%', svc: [['Ground', '1–5 business days', true], ['2nd Day Air', '2 business days', true], ['Next Day Air Saver', '1 business day', false]] },
    { n: 'USPS', acct: 'Account •••• 3301 · connected', ot: '93.4%', svc: [['Ground Advantage', '2–5 business days', true], ['Priority Mail', '1–3 business days', true], ['Priority Mail Express', '1–2 days', false]] },
    { n: 'FedEx', acct: 'Account •••• 5820 · connected', ot: '95.0%', svc: [['Home Delivery', '1–5 business days', true], ['Express Saver', '3 business days', true], ['2Day', '2 business days', true]] },
  ];

  function noticeModal() {
    return U.modal({
      title: 'Add service notice', size: 'lg',
      body: `
        <p class="small sub">Service notices adjust delivery estimates and show a short message to customers where they make delivery decisions.</p>
        <div class="grid md2" style="--gap:12px">
          ${U.field('Notice title', U.input('aa-sn-t', 'Wildfire road closures, Sacramento area'))}
          ${U.field('Type', U.select('aa-sn-type', ['Service interruption', 'Holiday', 'Carrier delay', 'Warehouse closure'], 'Service interruption'))}
          ${U.field('Carriers and services', U.select('aa-sn-c', ['All carriers', 'UPS · all services', 'UPS Ground only', 'USPS · all services', 'FedEx · all services'], 'UPS Ground only'))}
          ${U.field('Affected area', U.input('aa-sn-a', 'ZIP codes 956xx, 957xx, 958xx'), { hint: 'ZIP prefixes, states or zones' })}
          ${U.field('From', U.input('aa-sn-from', 'Tue, Oct 6, 2026'))}
          ${U.field('Until', U.input('aa-sn-to', 'Sun, Oct 11, 2026'), { hint: 'Ends automatically. You can end it early.' })}
          ${U.field('Add to delivery estimate', U.select('aa-sn-add', ['+1 business day', '+1–2 business days', '+3 business days', 'Pause delivery to this area'], '+1–2 business days'))}
          ${U.field('Applies to', U.select('aa-sn-who', ['Official Store and all sellers', 'Official Store only', 'Marketplace sellers only'], 'Official Store and all sellers'))}
        </div>
        ${U.field('Message to customers', U.textarea('aa-sn-msg', 'UPS deliveries to the Sacramento area may take 1–2 extra business days because of road closures. Estimates below include the delay.'), { hint: 'Plain language. Under 200 characters.' })}
        <div class="stack gap-2"><span class="label">Show on</span>
          <div class="grid md3" style="--gap:8px">${U.check('aa-sn-s1', 'Product page delivery estimate', true)}${U.check('aa-sn-s2', 'Checkout delivery options', true)}${U.check('aa-sn-s3', 'Order tracking for affected packages', true)}</div>
        </div>
        <div class="aa-preview stack gap-2"><span class="xs strong muted">Preview · checkout, Sacramento 95814</span>
          ${U.alert('warning', 'Possible delay', 'UPS deliveries to the Sacramento area may take 1–2 extra business days because of road closures. Estimates below include the delay.', 'truck')}
          <span class="small"><b>UPS Ground</b> · Arrives Thu, Oct 15 – Fri, Oct 16</span>
        </div>
        <span class="xs muted">Sellers shipping to this area get a Seller Center notice. Dispatch deadlines do not change; only arrival estimates do.</span>`,
      foot: `${U.btn('Cancel', { v: 'ghost' })}${U.btn('Save as draft', { v: 'secondary' })}${U.btn('Publish notice', { icon: 'megaphone' })}`,
    });
  }

  U.register({
    id: 'admin/shipping', title: 'Shipping settings', ref: 'Plan ch. 12, 18',
    notes: 'Carriers and services, shipping methods and rates, eligible destinations, dispatch targets for the Official Store and default seller targets, holiday and service interruption notices shown to customers, and free-shipping rules with their funding.',
    states: ['Settings', 'Add service notice'],
    render: (state) => {
      const page = U.adminLayout(`
        ${U.pageHead('Shipping', {
          crumbs: [{ label: 'Commerce' }, { label: 'Shipping' }],
          sub: 'Owner Theo Grant, Shipping Manager · changes show their effective date and apply to new orders only',
          actions: U.btn('Dispatch and exceptions', { v: 'secondary', size: 'sm', icon: 'truck', href: U.go('ops/dispatch') }) + U.btn('Add service notice', { size: 'sm', icon: 'plus', href: U.go('admin/shipping', 'Add service notice') }),
        })}
        ${U.alert('warning', '1 service notice is live', 'Wildfire road closures, Sacramento area: UPS Ground +1–2 business days, Oct 6–11. Shown on product pages, checkout and tracking.')}
        ${U.tabs(['Carriers and methods', 'Destinations', 'Dispatch targets', 'Calendar and notices', 'Free shipping'], 0)}

        <div class="aa-carrier">${CARRIERS.map((c) => U.card({
          title: c.n, sub: c.acct, actions: U.status('Active'),
          body: `<ul class="list">${c.svc.map(([s, t, on]) => `<li><span class="grow stack gap-0"><span class="small strong">${s}</span><span class="xs muted">${t}</span></span>${U.toggle('aa-sh-' + c.n + '-' + s.replace(/\W+/g, ''), '<span class="sr-only">' + c.n + ' ' + s + ' enabled</span>', on)}</li>`).join('')}</ul>
            <span class="row between xs"><span class="muted">On-time delivery, 30 days</span><b class="num">${c.ot}</b></span>
            <span class="xs muted">Tracking updates connected · last event 2 min ago</span>`,
        })).join('')}</div>

        ${U.card({
          title: 'Shipping methods and rates', sub: 'Official Store rates · sellers set their own within these methods', actions: U.btn('Edit rates', { v: 'secondary', size: 'sm', icon: 'pencil' }), flush: true,
          body: U.table(['Method', 'Customer sees', 'Carriers', { label: 'Up to 2 lb', cls: 'r' }, { label: '2–10 lb', cls: 'r' }, { label: 'Over 10 lb', cls: 'r' }, 'Free when'], [
            ['<span class="small strong">Standard</span>', '<span class="small">3–6 business days</span>', '<span class="small">UPS Ground, USPS Ground Advantage, FedEx Home</span>', U.money(5.99), U.money(7.99), U.money(12.99), '<span class="small">Official Store order $35+</span>'],
            ['<span class="small strong">Expedited</span>', '<span class="small">2–3 business days</span>', '<span class="small">USPS Priority, FedEx Express Saver</span>', U.money(12.99), U.money(16.99), U.money(24.99), '<span class="xs muted">Never</span>'],
            ['<span class="small strong">Express</span>', '<span class="small">1–2 business days</span>', '<span class="small">UPS 2nd Day Air, FedEx 2Day</span>', U.money(24.99), U.money(29.99), U.money(44.99), '<span class="xs muted">Never</span>'],
          ]),
        })}

        <div class="aa-2">
          ${U.card({
            title: 'Destinations', sub: 'One service region at launch',
            body: `<ul class="list">
              <li>${U.icon('map', 'ic-sm')}<span class="grow stack gap-0"><span class="small strong">Contiguous US · 48 states and DC</span><span class="xs muted">All methods · Official Store and sellers</span></span>${U.status('Active')}</li>
              <li>${U.icon('map-pin', 'ic-sm')}<span class="grow stack gap-0"><span class="small strong">Zone 1 · West (from Reno, NV)</span><span class="xs muted">CA, NV, OR, WA, ID, UT, AZ · Standard 2–4 days</span></span></li>
              <li>${U.icon('map-pin', 'ic-sm')}<span class="grow stack gap-0"><span class="small strong">Zone 2 · Central</span><span class="xs muted">Standard 3–5 days</span></span></li>
              <li>${U.icon('map-pin', 'ic-sm')}<span class="grow stack gap-0"><span class="small strong">Zone 3 · East</span><span class="xs muted">Standard 4–6 days</span></span></li>
              <li>${U.icon('circle-slash', 'ic-sm')}<span class="grow stack gap-0"><span class="small strong">Alaska, Hawaii, US territories, APO/FPO</span><span class="xs muted">Not served at launch. Customers see this before checkout.</span></span>${U.status('Disabled')}</li>
            </ul>`,
          })}
          ${U.card({
            title: 'Dispatch targets', sub: 'Late dispatch creates an overdue task and notifies the customer',
            body: `<div class="aa-sec"><span class="row gap-2">${lt('official', true)}<span class="h4">Official Store</span></span>
                ${U.kv([['Order cutoff', '2:00 PM PT, Mon–Fri'], ['Before cutoff', 'Ships same business day'], ['After cutoff', 'Ships next business day'], ['Current', '<span class="t-success-text strong">98.6% on time</span> · 30 days']])}</div>
              <div class="aa-sec"><span class="h4">Default seller targets</span>
                ${U.kv([['Dispatch within', '2 business days (sellers can promise 1–3)'], ['Valid tracking', 'Within 24 hours of dispatch'], ['Reply to customers', 'Within 24 hours'], ['Performance target', '95% on time over 30 days']])}
                <span class="xs muted">Example targets. Final service standards are in the seller agreement.</span></div>`,
          })}
        </div>

        <div class="aa-2">
          ${U.card({
            title: 'Holiday calendar and service notices', sub: 'Customers see these in delivery estimates', actions: U.btn('Add', { v: 'ghost', size: 'sm', icon: 'plus', href: U.go('admin/shipping', 'Add service notice') }), flush: true,
            body: U.table(['When', 'Notice', 'Effect', 'Status'], [
              ['<span class="small nowrap">Oct 6–11</span>', '<span class="small">Wildfire road closures, Sacramento area</span>', '<span class="small">UPS Ground +1–2 days</span>', U.status('Live')],
              ['<span class="small nowrap">Mon, Oct 12</span>', '<span class="small">Columbus Day · USPS closed</span>', '<span class="small">No USPS pickup or delivery</span>', U.status('Scheduled')],
              ['<span class="small nowrap">Wed, Nov 11</span>', '<span class="small">Veterans Day · USPS closed</span>', '<span class="small">No USPS pickup or delivery</span>', U.status('Scheduled')],
              ['<span class="small nowrap">Thu, Nov 26</span>', '<span class="small">Thanksgiving · warehouse and carriers closed</span>', '<span class="small">No dispatch; estimates skip the day</span>', U.status('Scheduled')],
              ['<span class="small nowrap">Dec 17–21</span>', '<span class="small">Holiday cutoffs: Standard Dec 17, Expedited Dec 19, Express Dec 21</span>', '<span class="small">Shown on product pages from Dec 1</span>', U.status('Draft')],
            ], { rowCls: ['is-warn', '', '', '', ''] }),
          })}
          ${U.card({
            title: 'Free-shipping rules', sub: 'Who pays is recorded per order',
            body: `<ul class="list">
              <li><span class="grow stack gap-0"><span class="small strong">Official Store orders $35 and over</span><span class="xs muted">Standard method · company-funded · always on</span></span>${U.status('Active')}</li>
              <li><span class="grow stack gap-0"><span class="small strong">Seller free shipping</span><span class="xs muted">Sellers choose per offer or above their own minimum · seller-funded</span></span>${U.status('Active')}</li>
              <li><span class="grow stack gap-0"><span class="small strong">Home Week free shipping</span><span class="xs muted">All sellers, orders $25+ · platform-funded · Oct 12–19</span></span>${U.status('Scheduled')}</li>
            </ul>
            <a class="small strong" href="${U.go('admin/promotions')}">Manage shipping promotions</a>`,
          })}
        </div>
      `, 'shipping');
      return state === 'Add service notice' ? page + noticeModal() : page;
    },
  });
})();
