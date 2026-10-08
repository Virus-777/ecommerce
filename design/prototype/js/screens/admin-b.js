/* Admin Center · Finance, customers and service, marketing and content, advertisements (plan ch. 14, 15, 16, 17, 19) */
(function () {
  const U = UI;
  const D = window.D;
  const { register, adminLayout, pageHead, card, stat, table, status, badge, btn, go, icon, money, num, esc, avatar, deadline, tabs, seg, chips, kv, sumRow, alert, timeline, field, input, select, textarea, check, radio, toggle, optCard, steps, modal, drawer, meter, searchIn, barChart, splitBar, legend, img, pimg, price, logoTile, dropzone, iconBtn } = U;

  U.css('admin-b', `
    .ab-kpis { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .ab-kpis .stat .v { font-size: var(--fs-xl); }
    @container app (min-width: 768px) { .ab-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } .ab-kpis .stat .v { font-size: var(--fs-2xl); } }
    @container app (min-width: 1280px) { .ab-kpis.k4 { grid-template-columns: repeat(4, minmax(0, 1fr)); } .ab-kpis.k5 { grid-template-columns: repeat(5, minmax(0, 1fr)); } .ab-kpis.k6 { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
    .ab-main { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1180px) { .ab-main { grid-template-columns: minmax(0, 1fr) 360px; } .ab-main.wide { grid-template-columns: minmax(0, 1fr) 400px; } }
    .ab-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .ab-cell > .strong { font-weight: 600; }
    .ab-av-sm { width: 28px; height: 28px; font-size: var(--fs-2xs); }
    .ab-note { font-size: var(--fs-xs); color: var(--text-3); }
    .ab-mlist { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ab-mlist > li { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ab-checks { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ab-checks li { display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--fs-sm); }
    .ab-checks li > svg.lucide { margin-top: 2px; }
    .ab-checks .t-ok > svg.lucide { color: var(--success); }
    .ab-checks .t-warn > svg.lucide { color: var(--warning); }
    .ab-checks .t-fail > svg.lucide { color: var(--danger); }
    .ab-checks .t-info > svg.lucide { color: var(--info); }
    .ab-flow { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ab-flow .r { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px var(--sp-3); align-items: baseline; font-size: var(--fs-sm); }
    .ab-flow .r .meter { grid-column: 1 / -1; height: 6px; }
    .ab-flow .r b { font-variant-numeric: tabular-nums; }
    .ab-approvals { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ab-approvals li { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: var(--sp-3); align-items: center; }
    .ab-approvals .n { width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--surface-3); color: var(--text-2); font-size: var(--fs-xs); font-weight: 700; }
    .ab-approvals .n.is-done { background: var(--success-soft); color: var(--success); }
    .ab-approvals .n.is-wait { background: var(--warning-soft); color: var(--warning); }
    .ab-conv { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ab-msg { border-radius: var(--r-lg); padding: var(--sp-3) var(--sp-4); background: var(--surface-2); display: flex; flex-direction: column; gap: 6px; max-width: 92%; border: 1px solid transparent; }
    .ab-msg .who { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; font-size: var(--fs-xs); color: var(--text-3); }
    .ab-msg .who b { color: var(--text); font-size: var(--fs-sm); }
    .ab-msg p { font-size: var(--fs-sm); color: var(--text); }
    .ab-msg.is-customer { align-self: flex-start; }
    .ab-msg.is-seller { align-self: flex-end; background: var(--info-soft); }
    .ab-msg.is-staff { align-self: stretch; max-width: 100%; background: var(--brand-soft); }
    .ab-msg.is-note { align-self: stretch; max-width: 100%; background: var(--warning-soft); border-style: dashed; border-color: var(--warning); }
    .ab-photos { display: grid; gap: var(--sp-3); grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .ab-photos figure { display: flex; flex-direction: column; gap: 4px; }
    .ab-photos figcaption { font-size: var(--fs-2xs); color: var(--text-3); line-height: 1.3; }
    .ab-lifecycle { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .ab-lifecycle svg.lucide { width: 14px; height: 14px; color: var(--text-3); }
    .ab-report { display: flex; flex-direction: column; }
    .ab-report .top { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-4); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .ab-report .body { display: grid; gap: var(--sp-4); padding: var(--sp-4); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 1024px) { .ab-report .body { grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); } }
    .ab-risk { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; width: 56px; height: 56px; border-radius: var(--r-md); border: 2px solid currentColor; font-weight: 700; font-size: var(--fs-xl); line-height: 1; flex: none; font-variant-numeric: tabular-nums; }
    .ab-risk small { font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; margin-top: 2px; }
    .ab-risk.t-high { color: var(--danger); background: var(--danger-soft); }
    .ab-risk.t-med { color: var(--warning); background: var(--warning-soft); }
    .ab-risk.t-low { color: var(--info); background: var(--info-soft); }
    .ab-links { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .ab-link { display: inline-flex; gap: 6px; align-items: center; padding: 4px 10px; border-radius: var(--r-pill); background: var(--surface-2); font-size: var(--fs-xs); font-weight: 600; color: var(--text-2) !important; }
    .ab-link svg.lucide { width: 14px; height: 14px; }
    .ab-route { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-2); }
    .ab-route li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px var(--sp-3); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-md); align-items: center; }
    .ab-route li .xs { grid-column: 1 / -1; }
    .ab-sec { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: var(--sp-2) var(--sp-3); align-items: center; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); }
    .ab-sec:last-child { border-bottom: 0; }
    .ab-sec .meta { grid-column: 2; display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); align-items: center; font-size: var(--fs-xs); color: var(--text-3); }
    .ab-sec .acts { grid-column: 2; display: flex; gap: 2px; align-items: center; }
    @container app (min-width: 768px) { .ab-sec { grid-template-columns: 24px minmax(0, 1fr) auto; } .ab-sec .acts { grid-column: 3; grid-row: 1 / span 2; } }
    .ab-sec .handle { color: var(--text-3); grid-row: 1 / span 2; }
    .ab-sec.is-ad { background: repeating-linear-gradient(135deg, var(--surface-2) 0 8px, var(--surface) 8px 16px); }
    .ab-sec.is-edit { box-shadow: inset 3px 0 0 var(--brand); background: var(--brand-soft); }
    .ab-wire { display: flex; flex-direction: column; gap: 6px; padding: var(--sp-3); background: var(--surface-2); border-radius: var(--r-md); }
    .ab-wire > div { border-radius: var(--r-sm); background: var(--surface); border: 1px solid var(--border); font-size: var(--fs-2xs); font-weight: 600; color: var(--text-2); display: flex; align-items: center; justify-content: center; text-align: center; padding: 4px; }
    .ab-wire .w-hero { height: 64px; background: var(--brand-soft); color: var(--brand-text); }
    .ab-wire .w-cats { height: 26px; }
    .ab-wire .w-deals { height: 40px; background: var(--deal-soft); color: var(--deal-text); }
    .ab-wire .w-off { height: 44px; }
    .ab-wire .w-ad { height: 30px; border-style: dashed; border-color: var(--border-strong); background: repeating-linear-gradient(135deg, var(--surface-2) 0 6px, var(--surface) 6px 12px); }
    .ab-wire .w-feat { height: 44px; border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
    .ab-wire .w-sell { height: 30px; }
    .ab-diff { font-size: var(--fs-sm); line-height: 1.6; color: var(--text-2); }
    .ab-diff del { background: var(--danger-soft); color: var(--danger); text-decoration: line-through; padding: 0 2px; border-radius: 3px; }
    .ab-diff ins { background: var(--success-soft); color: var(--success); text-decoration: none; padding: 0 2px; border-radius: 3px; }
    .ab-edbar { display: flex; gap: 2px; padding: 4px; border: 1px solid var(--border-strong); border-bottom: 0; border-radius: var(--r-md) var(--r-md) 0 0; background: var(--surface-2); flex-wrap: wrap; }
    .ab-edbar + .textarea { border-radius: 0 0 var(--r-md) var(--r-md); min-height: 180px; }
    .ab-edbar .icon-btn { width: 34px; height: 34px; }
    .ab-pv { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .ab-pv { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .ab-pv > div { border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); background: var(--surface); }
    .ab-pv .pcap { font-size: var(--fs-2xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); }
    .ab-types { display: grid; gap: var(--sp-2); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .ab-types { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @container app (min-width: 1280px) { .ab-types { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .ab-types .opt-card svg.lucide { color: var(--text-2); }
    .ab-wizard-foot { display: flex; gap: var(--sp-2); justify-content: space-between; flex-wrap: wrap; align-items: center; }
    .ab-previews { display: grid; gap: var(--sp-4); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 768px) { .ab-previews { grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); } }
    .ab-dframe { border: 1px solid var(--border-strong); border-radius: var(--r-md); overflow: hidden; background: var(--surface); }
    .ab-dbar { display: flex; gap: 5px; align-items: center; padding: 6px 10px; background: var(--surface-2); border-bottom: 1px solid var(--border); font-size: var(--fs-2xs); color: var(--text-3); }
    .ab-dbar i { width: 8px; height: 8px; border-radius: 50%; background: var(--border-strong); display: inline-block; }
    .ab-dbar span { margin-left: 8px; background: var(--surface); border-radius: var(--r-pill); padding: 1px 10px; }
    .ab-screen { position: relative; padding: 10px; display: flex; flex-direction: column; gap: 6px; background: var(--bg); }
    .ab-screen .sk { border-radius: 4px; background: var(--surface-3); }
    .ab-screen.desk { aspect-ratio: 16 / 10; }
    .ab-mframe { width: 100%; max-width: 230px; margin-inline: auto; border: 6px solid var(--text); border-radius: 26px; overflow: hidden; background: var(--surface); }
    .ab-screen.mob { aspect-ratio: 9 / 18; padding: 8px; }
    .ab-scrim { position: absolute; inset: 0; background: var(--overlay); display: flex; align-items: center; justify-content: center; padding: 6%; }
    .ab-ad { position: relative; width: 100%; background: var(--surface); border-radius: var(--r-md); overflow: hidden; display: grid; grid-template-columns: minmax(0, 1fr); box-shadow: var(--sh-3); }
    .ab-ad.desk { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); max-width: 86%; }
    .ab-ad .art { background: var(--brand-soft); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 10px; align-content: center; }
    .ab-ad .art .imgph { border-radius: 8px; }
    .ab-ad .copy { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 5px; justify-content: center; }
    .ab-ad .copy b { font-family: var(--font-display); font-size: 14px; line-height: 1.15; }
    .ab-ad .copy span { font-size: 10px; color: var(--text-2); line-height: 1.3; }
    .ab-ad .cta { align-self: flex-start; background: var(--brand); color: var(--on-brand); border-radius: 6px; font-size: 10px; font-weight: 700; padding: 5px 8px; }
    .ab-adtag { position: absolute; top: 6px; left: 6px; z-index: 2; font-size: 9px; font-weight: 700; letter-spacing: 0.04em; padding: 1px 5px; border-radius: var(--r-xs); background: var(--surface); color: var(--text); border: 1px solid var(--border-strong); }
    .ab-adx { position: absolute; top: 4px; right: 4px; z-index: 2; width: 24px; height: 24px; border-radius: 50%; background: var(--surface); border: 1px solid var(--border-strong); color: var(--text); display: inline-flex; align-items: center; justify-content: center; }
    .ab-adx svg.lucide { width: 14px; height: 14px; }
    .ab-place { display: grid; gap: var(--sp-4); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 1024px) { .ab-place { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .ab-place .card.is-off { background: var(--surface-2); }
    .ab-rules { display: grid; gap: var(--sp-2); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .ab-rules { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .ab-rules li { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-3); border-radius: var(--r-md); background: var(--surface-2); }
    .ab-rules li svg.lucide { color: var(--brand-text); margin-top: 1px; }
    .ab-sumlist { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ab-sumlist > div { display: flex; justify-content: space-between; gap: var(--sp-3); font-size: var(--fs-sm); }
    .ab-sumlist > div > span:first-child { color: var(--text-3); }
    .ab-sumlist > div > span:last-child { text-align: right; font-weight: 600; }
    .ab-form-grid { display: grid; gap: var(--sp-4); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .ab-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .ab-form-grid .full { grid-column: 1 / -1; } }
    @container app (min-width: 1280px) { .ab-form-grid.c3 { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .ab-checkgrid { display: grid; gap: var(--sp-2); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .ab-checkgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .ab-locked { opacity: 0.6; }
    .ab-sticky { position: sticky; top: 76px; }
  `);

  /* ---------------- Local helpers ---------------- */
  const cell = (main, sub) => `<span class="ab-cell"><span class="strong">${main}</span>${sub ? `<span class="xs muted">${sub}</span>` : ''}</span>`;
  const ref = (r, id, st) => `<a class="mono nowrap" href="${id ? go(id, st) : 'javascript:void 0'}">${r}</a>`;
  const kpis = (items, cls = '') => `<div class="ab-kpis ${cls}">${items.map(([k, v, o]) => `<div class="card pad">${stat(k, v, o || {})}</div>`).join('')}</div>`;
  const person = (n, sub) => `<span class="row nowrap gap-2">${avatar(n, 'ab-av-sm')}${cell(n, sub)}</span>`;
  const CHK = { ok: 'circle-check', warn: 'triangle-alert', fail: 'circle-x', info: 'info' };
  const checks = (arr) => `<ul class="ab-checks">${arr.map(([t, title, body]) => `<li class="t-${t}">${icon(CHK[t], 'ic-sm')}<span class="stack gap-0"><span>${title}</span>${body ? `<span class="xs muted">${body}</span>` : ''}</span></li>`).join('')}</ul>`;
  const mlist = (items) => `<ul class="ab-mlist only-phone">${items.map((i) => `<li class="card pad">${i}</li>`).join('')}</ul>${U.lazyLoad()}`;
  const sumlist = (pairs) => `<div class="ab-sumlist">${pairs.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('')}</div>`;
  const seller = (id) => D.sellers[id].name;
  const neg = (n) => `<span class="t-danger-text strong num">−${money(n)}</span>`;
  const example = (t) => `<p class="ab-note">${icon('info', 'ic-sm')} ${t}</p>`;
  const toolbar = (inner) => `<div class="toolbar">${inner}</div>`;

  /* ======================================================================
     1. admin/finance — Payments and fees
     ====================================================================== */
  const FIN_TABS = ['Unexplained amounts', 'Disputes and chargebacks', 'Refunds failing'];
  const finTable = (t) => {
    if (t === 'Disputes and chargebacks') {
      return `<div class="card-body" style="padding-bottom:0">${alert('info', 'What a chargeback is', 'A chargeback happens when a customer disputes a charge with their card issuer or payment provider instead of with us; the provider takes the money back until the dispute is decided.')}</div>
      ${table(['Case', 'Order and seller', 'Customer', 'Reason given', { label: 'Amount', cls: 'r' }, 'Evidence due', 'Seller balance effect', 'Status', ''], [
        [ref('CB-2210'), cell(ref('MK-260921-33018', 'admin/order'), 'Pixel &amp; Port'), 'Marcus Webb', 'Item not received (card issuer)', `<span class="num">${money(480)}</span>`, deadline('Oct 14 · 6 days', 'ok'), `${badge('Held ' + money(480), 'warning')}`, status('Chargeback'), btn('Submit evidence', { v: 'secondary', size: 'sm' })],
        [ref('CB-2214'), cell(ref('MK-260928-40112', 'admin/order'), 'Marketly Official'), 'Hannah Wu', 'Unrecognized charge', `<span class="num">${money(189)}</span>`, deadline('Oct 9 · tomorrow', 'warning'), '<span class="xs muted">Company sale. A loss is recorded in company trading.</span>', status('Chargeback'), btn('Submit evidence', { v: 'secondary', size: 'sm' })],
        [ref('DP-0318'), cell(ref('MK-261002-51207', 'admin/order'), 'Trailhead Outfitters'), 'Leo Park', 'Charged twice (wallet provider dispute)', `<span class="num">${money(139)}</span>`, deadline('Oct 12 · 4 days', 'ok'), `${badge('Held ' + money(139), 'warning')}`, status('Disputed'), btn('Open', { v: 'ghost', size: 'sm' })],
        [ref('CB-2201'), cell(ref('MK-260919-28870', 'admin/order'), 'Northwind Audio'), 'Tara Singh', 'Item not as described', `<span class="num">${money(59)}</span>`, '<span class="xs muted">Evidence sent Oct 5</span>', `${badge('Held ' + money(59), 'warning')}`, status('Under review'), btn('Open', { v: 'ghost', size: 'sm' })],
        [ref('CB-2189'), cell(ref('MK-260911-17342', 'admin/order'), 'Casa Verde Home'), 'Owen Hart', 'Item not received', `<span class="num">${money(72)}</span>`, '<span class="xs muted">Won Oct 6</span>', '<span class="xs t-success-text strong">Hold released Oct 6</span>', status('Resolved'), btn('Open', { v: 'ghost', size: 'sm' })],
      ], { rowCls: ['', 'is-warn'] })}
      <div class="card-foot" style="justify-content:flex-start">${example('Example rule: the marketplace fee is kept while a chargeback is open and returned to the seller if we win. Final treatment is in the seller agreement.')}</div>`;
    }
    if (t === 'Refunds failing') {
      return `${table(['Refund', 'Order', 'Customer', { label: 'Amount', cls: 'r' }, 'Why it failed', 'Attempts', 'Status', 'Next step'], [
        [ref('RF-261006-0419'), ref('MK-260927-21877', 'admin/order'), 'Ella Fischer', `<span class="num">${money(212.4)}</span>`, cell('Card closed by the issuer', 'Visa •••• 9012 · Oct 6, 4:12 PM'), '2 of 3', status('Failed'), btn('Ask customer for a new method', { v: 'secondary', size: 'sm' })],
        [ref('RF-261007-0433'), ref('MK-261001-30554', 'admin/order'), 'Sam Rivera', `<span class="num">${money(106)}</span>`, cell('Provider timed out, outcome unknown', 'We check the provider before any retry'), '1 of 3', status('Checking'), btn('Check status', { v: 'secondary', size: 'sm', icon: 'refresh-cw' })],
      ], { rowCls: ['is-flagged', 'is-warn'] })}
      <div class="card-foot" style="justify-content:flex-start">${example('A retry first asks the payment provider for the result, so a refund is never sent twice. The customer sees "Failed" with the next step, not "Sent".')}</div>`;
    }
    return `${table(['Reference', 'What we found', { label: 'Difference', cls: 'r' }, 'Detected', 'Owner', 'Next step'], [
      [ref('STL-261007-ADY'), cell('Provider settlement for Oct 7 is short', '2,114 captured payments vs settlement batch'), neg(12.4), 'Oct 8, 6:00 AM', person('Priya Nair', 'Finance Manager'), btn('Investigate', { v: 'secondary', size: 'sm' })],
      [ref('PAY-8F21C904'), cell('Payment captured with no order', 'Checkout timed out. Duplicate check confirmed no order was created.'), `<span class="num strong">${money(84.2)}</span>`, 'Oct 7, 9:41 PM', person('Owen Price', 'Finance Specialist'), btn('Refund customer', { v: 'secondary', size: 'sm' })],
      [ref('MK-261006-09977', 'admin/order'), cell('Seller amount differs from order lines', 'Gadget Grove · shipping counted twice in seller proceeds'), `<span class="num strong">${money(6.99)}</span>`, 'Oct 7, 6:00 AM', person('Owen Price', 'Finance Specialist'), btn('Correct with reason', { v: 'secondary', size: 'sm' })],
    ], { rowCls: ['is-warn', 'is-warn', ''] })}
    <div class="card-foot" style="justify-content:space-between">${example('Every correction needs a recorded reason. Corrections over $500 need a second Finance reviewer.')}<a class="small strong" href="${go('ops/finance-checks')}">Daily finance checks ${icon('arrow-right', 'ic-sm')}</a></div>`;
  };

  register({
    id: 'admin/finance', title: 'Payments and fees', ref: 'Plan ch. 14',
    notes: 'Money overview that keeps collected payments, company product sales, marketplace fee income and amounts owed to sellers apart, plus the finance queues for unexplained amounts, chargebacks and failing refunds. Fee rules state the commission basis and how discount funding is treated.',
    states: FIN_TABS,
    render: (st) => {
      const t = st || FIN_TABS[0];
      const official = 236410, sellers = 171480.3, ship = 4969.9;
      const coll = official + sellers + ship;
      const share = Math.round((official / (official + sellers)) * 100);
      return adminLayout(`
      ${pageHead('Payments and fees', { crumbs: [{ label: 'Admin', href: go('admin/dashboard') }, 'Finance'], sub: 'Oct 1–8, 2026 · USD · Pacific Time · counted by payment date · owner Priya Nair, Finance Manager', actions: seg(['Today', '7 days', 'Month to date'], 2) + btn('Export', { v: 'secondary', size: 'sm', icon: 'download' }) })}

      ${kpis([
        ['Collected payments', money(coll), { icon: 'credit-card', note: '5,742 accepted payments' }],
        ['Company product sales', money(official), { icon: 'badge-check', note: 'Official Store · company trading' }],
        ['Marketplace fee income', money(16902.75), { icon: 'landmark', note: 'on ' + money(sellers) + ' seller sales' }],
        ['Owed to sellers', money(148317.4), { icon: 'wallet', note: 'Pending ' + money(96280.1) + ' · available ' + money(52037.3) }],
        ['Refunds sent', money(9842.15), { icon: 'undo-2', note: '31 sent · 2 failing' }],
        ['Holds', money(12640), { icon: 'hand-coins', note: '6 sellers · each with review date' }],
      ], 'k6')}

      <div class="ab-main">
        <div class="stack gap-5">
          ${card({
            title: 'Finance queues', sub: 'Work these before the Friday payout run',
            flush: true,
            body: `<div style="padding:0 var(--sp-4)">${tabs(FIN_TABS.map((l, i) => ({ label: l, count: [3, 5, 2][i], href: go('admin/finance', l) })), t)}</div>${finTable(t)}`,
          })}

          ${card({
            title: 'Where the money went', sub: 'Month to date · one payment can cover several seller groups',
            body: `<div class="ab-flow">
                <div class="r"><span>Company product sales (Official Store)</span><b>${money(official)}</b>${meter(Math.round(official / coll * 100))}</div>
                <div class="r"><span>Seller sales (marketplace)</span><b>${money(sellers)}</b>${meter(Math.round(sellers / coll * 100), 'warning')}</div>
                <div class="r"><span>Shipping charges collected</span><b>${money(ship)}</b>${meter(Math.round(ship / coll * 100))}</div>
              </div>
              <div class="divider"></div>
              <div class="grid md3" style="--gap:var(--sp-3)">
                <div class="panel stack gap-1"><span class="xs muted">From seller sales: fee income</span><b class="num">${money(16902.75)}</b><span class="xs muted">Earned by the marketplace</span></div>
                <div class="panel stack gap-1"><span class="xs muted">From seller sales: seller earnings</span><b class="num">${money(154577.55)}</b><span class="xs muted">Before refunds and holds</span></div>
                <div class="panel stack gap-1"><span class="xs muted">Paid out to sellers</span><b class="num">${money(61340.8)}</b><span class="xs muted">Run of Oct 2 · 39 sellers</span></div>
              </div>
              <div class="stack gap-2"><div class="row between xs sub"><span>Official Store ${share}%</span><span>Marketplace sellers ${100 - share}%</span></div>${splitBar(share, 100 - share)}${legend(['Official Store', 'Marketplace sellers'])}</div>
              ${example('Seller sales are not marketplace income. Only the fee portion is income. Company proceeds stay in company trading reports and are never part of a seller payout.')}`,
          })}
        </div>

        <div class="stack gap-5">
          ${card({
            title: 'Fee rules', sub: 'Effective Sep 1, 2026 · seller agreement v2.0',
            actions: btn('Edit in settings', { v: 'ghost', size: 'sm', href: go('admin/settings') }),
            body: `${kv([
              ['Commission basis', 'Item price after seller-funded discounts'],
              ['Shipping', 'Not included in commission'],
              ['Platform-funded discounts', 'Do not reduce seller proceeds. Platform pays the difference.'],
              ['Seller-funded discounts', 'Reduce the item price that commission is charged on'],
              ['Cancellation before dispatch', 'No fee'],
              ['Returns and refunds', 'Fee returned in proportion to the refunded item value'],
              ['Payment disputes', 'Fee kept while open; returned if we win'],
            ])}
            <div class="divider"></div>
            <span class="small strong">Category rates</span>
            ${table(['Category', { label: 'Rate', cls: 'r' }], [['Electronics', '8%'], ['Computers', '7%'], ['Home &amp; Kitchen', '12%'], ['Fashion', '15%'], ['Sports &amp; Outdoors', '10%'], ['Beauty', '12%']])}
            <div class="panel small"><b>Illustration:</b> a $100.00 item sale with a 10% fee creates $10.00 of fee income and $90.00 of seller earnings before other adjustments.</div>
            ${example('Example rates. Final fees are in the seller agreement.')}`,
          })}
          ${card({
            title: 'Discount funding this month', sub: 'Recorded separately from sales',
            body: sumlist([
              ['Platform-funded coupons', money(6420)],
              ['Seller-funded markdowns', money(4180)],
              ['Shared campaigns', money(1270)],
              ['Total discount cost', `<b>${money(11870)}</b>`],
            ]) + `<a class="small strong" href="${go('admin/promotions')}">Campaign results ${icon('arrow-right', 'ic-sm')}</a>`,
          })}
        </div>
      </div>
    `, 'finance');
    },
  });

  /* ======================================================================
     2. admin/payouts — Payout run
     ====================================================================== */
  const payoutRows = [
    ['Northwind Audio', 6842.1, null, 0, ['Chase', '4021', 'ok'], 6842.1, 'Scheduled'],
    ['Pixel &amp; Port', 9310.45, [480, 'Chargeback CB-2210', 'Oct 21'], 0, ['Wells Fargo', '5521', 'ok'], 8830.45, 'Scheduled'],
    ['Casa Verde Home', 3912.6, [1240, 'Open dispute CS-104882', 'Oct 15'], 0, ['US Bank', '3307', 'ok'], 2672.6, 'Scheduled'],
    ['Trailhead Outfitters', 5104.2, null, 0, ['Wells Fargo', '1184', 'change'], 5104.2, 'Scheduled'],
    ['Bayside Prints', 340, null, 212.4, ['BECU', '6610', 'ok'], 127.6, 'Scheduled'],
    ['Moss &amp; Mill', 485.5, null, 0, ['Citi', '2290', 'ok'], 485.5, 'Scheduled'],
    ['Gadget Grove', 4188.4, [4188.4, 'Seller restricted, counterfeit review TR-3391', 'Oct 16'], 0, ['Chase', '8875', 'ok'], 0, 'On hold'],
    ['Lumen &amp; Loom', 1460, [1460, 'First payout, identity re-check', 'Oct 12'], 0, ['Ally', '0412', 'pending'], 0, 'On hold'],
    ['Fernway Garden', 580, [580, 'Unusual refund rate, 3 open returns', 'Oct 14'], 0, ['Chase', '7719', 'ok'], 0, 'On hold'],
  ];
  const destCell = ([bank, last, st]) => st === 'ok' ? cell(`${bank} •••• ${last}`, `<span class="t-success-text">${icon('shield-check', 'ic-sm')} Verified</span>`)
    : st === 'change' ? cell(`${bank} •••• ${last}`, `<span class="t-warning-text">${icon('triangle-alert', 'ic-sm')} Change under review</span>`)
      : cell(`${bank} •••• ${last}`, `<span class="t-warning-text">${icon('clock', 'ic-sm')} Verification pending</span>`);

  const payoutBody = () => {
    const total = 78420.55, held = 6228.4;
    return `
      ${pageHead('Payout run PO-RUN-261009', { crumbs: [{ label: 'Finance', href: go('admin/finance') }, 'Payouts'], sub: 'Friday, Oct 9, 2026 · release 10:00 AM PT · weekly run · earnings from items delivered by Oct 2 and past the 7-day hold', actions: btn('Statements', { v: 'secondary', size: 'sm', icon: 'file-text' }) + btn('Export run', { v: 'secondary', size: 'sm', icon: 'download' }) })}
      ${kpis([
        ['Run total', money(total), { icon: 'wallet', note: 'Needs two Finance approvals' }],
        ['Sellers', '41', { icon: 'store', note: 'Weekly schedule' }],
        ['Ready', '38', { icon: 'circle-check', note: money(total - held) + ' · incl. 2 retries' }],
        ['Held', '3', { icon: 'hand-coins', note: money(held) + ' · each with review date' }],
        ['Failed last run', '2', { icon: 'circle-alert', note: money(1297.85) + ' · retry or fix' }],
      ], 'k5')}
      ${example('Example schedule: weekly, after delivery plus a 7-day hold. Final payout timing is set in the seller agreement.')}

      <div class="ab-main wide">
        <div class="stack gap-5">
          ${card({
            title: 'Sellers in this run', sub: 'Showing 9 of 41 · held and changed rows first',
            actions: `<span class="no-phone">${searchIn('Search seller', 'po-q')}</span>`,
            flush: true,
            body: table(['Seller', { label: 'Available', cls: 'r' }, 'Holds (reason · review date)', { label: 'Negative balance', cls: 'r' }, 'Destination', { label: 'Payout', cls: 'r' }, 'Status'],
              payoutRows.map(([n, av, hold, ng, dest, pay, st]) => [
                `<a class="strong" href="${go('admin/seller')}">${n}</a>`,
                `<span class="num">${money(av)}</span>`,
                hold ? cell(`<span class="t-warning-text num">${money(hold[0])}</span> · ${hold[1]}`, 'Review by ' + hold[2]) : '<span class="muted">None</span>',
                ng ? cell(neg(ng), 'Refund after payout, offset now') : '<span class="muted">—</span>',
                destCell(dest),
                `<span class="num strong">${money(pay)}</span>`,
                status(st),
              ]), { rowCls: payoutRows.map((r) => r[6] === 'On hold' ? 'is-warn' : r[4][2] === 'change' ? 'is-warn' : '') }),
            foot: `<span class="ab-note grow">Held amounts stay in the seller balance as Held and appear on the seller statement with the same reason and review date.</span>${U.pager(1, 5)}`,
          })}

          ${card({
            title: 'Failed payouts', sub: 'From the Oct 2 run · the seller sees the same reason',
            flush: true,
            body: table(['Payout', 'Seller', { label: 'Amount', cls: 'r' }, 'Reason from the bank', 'Fix', 'Status', ''], [
              [ref('PO-261002-0187'), 'Rowan Leather Co.', `<span class="num">${money(812.35)}</span>`, 'Account closed (bank code R02)', 'Seller must add and verify a new account', status('Failed'), btn('Retry', { v: 'secondary', size: 'sm', disabled: true })],
              [ref('PO-261002-0191'), 'Moss &amp; Mill', `<span class="num">${money(485.5)}</span>`, 'Account holder name does not match', '<span class="t-success-text">Seller corrected name Oct 6</span>', status('Failed'), btn('Retry in this run', { v: 'secondary', size: 'sm', icon: 'refresh-cw' })],
            ], { rowCls: ['is-flagged', 'is-warn'] }),
          })}

          ${card({
            title: 'Destination changes', sub: 'Changes need verification and a recorded review before money goes to the new account',
            flush: true,
            body: `<ul class="list pad">
              <li class="row top" style="align-items:flex-start">
                <span class="grow stack gap-2">
                  <span class="row gap-2"><b class="small">Trailhead Outfitters</b>${status('Under review')}</span>
                  <span class="small">Wells Fargo •••• 1184 ${icon('arrow-right', 'ic-sm')} First Tech •••• 7730 · requested Oct 7 by owner Lucia Ramos</span>
                  ${checks([['ok', 'Micro-deposits confirmed'], ['ok', 'Owner signed in again with two-step verification'], ['warn', 'Callback to the registered phone not answered yet']])}
                  <span class="xs muted">This run pays the verified account •••• 1184 until the change is approved.</span>
                </span>
                <span class="row gap-2">${btn('Reject', { v: 'ghost', size: 'sm' })}${btn('Approve change', { v: 'secondary', size: 'sm' })}</span>
              </li>
              <li><span class="grow stack gap-0"><span class="small"><b>Pixel &amp; Port</b> · Chase •••• 3318 ${icon('arrow-right', 'ic-sm')} Wells Fargo •••• 5521</span><span class="xs muted">Approved Oct 3 by Priya Nair · reason: bank switch confirmed by phone and statement</span></span>${status('Approved')}</li>
            </ul>`,
          })}
        </div>

        <div class="stack gap-5 ab-sticky">
          ${card({
            title: 'Approval', sub: 'Runs over $50,000 need a second Finance reviewer',
            body: `<ul class="ab-approvals">
                <li><span class="n is-done">${icon('check', 'ic-sm')}</span>${cell('Priya Nair · Finance Manager', 'Approved Oct 8, 8:52 AM')}${status('Approved')}</li>
                <li><span class="n is-wait">2</span>${cell('Second Finance reviewer', 'Assigned to Owen Price · due Oct 9, 9:30 AM')}${status('Pending')}</li>
              </ul>
              ${alert('info', 'You can view this run', 'Riley Chen, Platform Administrator: this role manages accounts but has no payout authority.')}
              ${sumlist([['Paying now', money(72192.15)], ['Held, not paid', money(6228.4)], ['Negative balances offset', money(212.4)], ['Release', 'Fri, Oct 9, 10:00 AM PT']])}`,
            foot: `${btn('Remind Owen Price', { v: 'secondary', size: 'sm', icon: 'bell' })}${btn('Open approval', { size: 'sm', href: go('admin/payouts', 'Approve run') })}`,
          })}
          ${card({
            title: 'Payout status meaning',
            body: `<div class="stack gap-2 small">
              <span class="row gap-2">${status('Pending')}<span class="sub">In a run, not yet released</span></span>
              <span class="row gap-2">${status('Processing')}<span class="sub">Sent to the bank, not yet confirmed</span></span>
              <span class="row gap-2">${status('Paid')}<span class="sub">Bank confirmed the deposit</span></span>
              <span class="row gap-2">${status('Failed')}<span class="sub">Returned by the bank with a reason</span></span>
            </div>`,
          })}
        </div>
      </div>`;
  };

  register({
    id: 'admin/payouts', title: 'Payout run', ref: 'Plan ch. 14, 18',
    notes: 'Friday payout run with per-seller available amounts, holds with reason and review date, negative balances, verified destinations, failed payouts and destination-change reviews. Runs over $50,000 need a second Finance reviewer, and admin access alone gives no payout authority.',
    states: ['Run review', 'Approve run'],
    render: (st) => {
      const base = adminLayout(payoutBody(), 'payouts');
      if (st !== 'Approve run') return base;
      return base + modal({
        title: 'Approve payout run PO-RUN-261009', size: 'lg',
        body: `<div class="row gap-2 small sub">${avatar('Owen Price', 'ab-av-sm')}<span>Approving as <b>Owen Price</b>, Finance Specialist · second reviewer</span></div>
          <div class="grid md2" style="--gap:var(--sp-4)">
            <div class="well stack gap-2">${sumlist([['Run total', money(78420.55)], ['Paying now · 38 sellers', money(72192.15)], ['Held · 3 sellers', money(6228.4)], ['Retries included', '2 · ' + money(1297.85)], ['Release', 'Fri, Oct 9, 10:00 AM PT']])}</div>
            <ul class="ab-approvals">
              <li><span class="n is-done">${icon('check', 'ic-sm')}</span>${cell('Priya Nair', 'First approval · Oct 8, 8:52 AM')}${status('Approved')}</li>
              <li><span class="n is-wait">2</span>${cell('Owen Price', 'Second approval · now')}${status('Pending')}</li>
            </ul>
          </div>
          ${checks([
            ['ok', 'Daily finance check for Oct 7 settled', 'One $12.40 settlement difference is logged and does not affect seller amounts'],
            ['ok', 'Every paid destination is verified'],
            ['info', 'Trailhead Outfitters is paid to its current verified account', 'The requested new account is still under review'],
            ['info', 'Bayside Prints negative balance of $212.40 is offset in this run'],
            ['warn', 'Rowan Leather Co. stays unpaid', 'No valid account. The seller has been notified.'],
          ])}
          ${check('po-confirm', 'I reviewed the held, failed and changed-destination payouts in this run', true)}
          ${field('Approval note', textarea('po-note', 'Checked holds against open disputes CS-104882 and CB-2210. OK to release.'), { opt: true })}
          ${alert('info', 'Approved is not paid', 'At release each payout moves to Processing. It shows Paid only when the bank confirms the deposit. Sellers see the same status.')}`,
        foot: `${btn('Cancel', { v: 'ghost' })}${btn('Send back with comment', { v: 'secondary' })}${btn('Approve and schedule release', { icon: 'check' })}`,
      });
    },
  });

  /* ======================================================================
     3. admin/customers
     ====================================================================== */
  const CUSTOMERS = [
    ['Jordan Lee', 'jordan.lee@example.com', 'Portland, OR', 5, 911.48, 1, 'Active', 'Email and phone', 'Aug 2026'],
    ['Priya Kapoor', 'priya.k@example.com', 'Seattle, WA', 12, 1842.3, 0, 'Active', 'Email and phone', 'Jun 2026'],
    ['Sam Rivera', 'sam.rivera@example.com', 'Oakland, CA', 3, 296, 1, 'Active', 'Email', 'Sep 2026'],
    ['Alex Morgan', 'alex.morgan@example.com', 'Boise, ID', 7, 1104.75, 1, 'Active', 'Email and phone', 'Jun 2026'],
    ['Derek Mills', 'dmills@example.com', 'Tacoma, WA', 4, 612.4, 1, 'Restricted', 'Email and phone', 'Jul 2026'],
    ['Kyle Benson', 'kb.orders@example.com', 'Reno, NV', 1, 189.98, 1, 'Under review', 'Email', 'Oct 2026'],
    ['Nina Okafor', 'nina.o@example.com', 'Eugene, OR', 1, 42, 1, 'Active', 'Not verified', 'Oct 2026'],
    ['Ella Fischer', 'ella.fischer@example.com', 'Spokane, WA', 6, 540.1, 0, 'Closed', 'Email', 'Jun 2026'],
  ];
  const customersBody = (detail) => `
    ${pageHead('Customers', { crumbs: [{ label: 'Admin', href: go('admin/dashboard') }, 'Customers and service'], sub: '18,406 accounts · 1,212 guest buyers with order lookup · account actions need a recorded reason', actions: btn('Export', { v: 'secondary', size: 'sm', icon: 'download' }) })}
    ${toolbar(`${searchIn('Search by name, email, phone or order number', 'cu-q')}${select('cu-status', ['All account statuses', 'Active', 'Restricted', 'Under review', 'Suspended', 'Closed'], 'All account statuses')}${select('cu-ver', ['Any verification', 'Email and phone', 'Email only', 'Not verified'], 'Any verification')}${btn('More filters', { v: 'secondary', size: 'sm', icon: 'filter' })}`)}
    ${chips([{ label: 'All', active: true }, 'Open cases', 'Abuse reports', 'New this week', 'Guest buyers'])}
    <div class="card no-phone">${table(['Customer', 'Location', { label: 'Orders', cls: 'r' }, { label: 'Spend', cls: 'r' }, { label: 'Open cases', cls: 'r' }, 'Account status', 'Verified', 'Joined', ''],
      CUSTOMERS.map(([n, e, loc, o, s, c, st, v, j], i) => [
        `<span class="row nowrap gap-3">${avatar(n)}${cell(`<a href="${go('admin/customers', 'Customer detail')}">${n}</a>`, e)}</span>`,
        loc, num(o), `<span class="num">${money(s)}</span>`,
        c ? `<a class="strong" href="${go('admin/cases')}">${c}</a>` : '<span class="muted">0</span>',
        status(st, st === 'Under review' ? 'info' : undefined),
        v === 'Not verified' ? `<span class="xs t-warning-text strong">${icon('triangle-alert', 'ic-sm')} Not verified</span>` : `<span class="xs">${icon('shield-check', 'ic-sm')} ${v}</span>`,
        j,
        btn('Open', { v: 'ghost', size: 'sm', href: go('admin/customers', 'Customer detail') }),
      ]), { rowCls: detail ? ['is-warn'] : [] })}
      <div class="card-foot"><span class="ab-note grow">Showing 8 of 18,406</span>${U.pager(1, 2301)}</div></div>
    ${mlist(CUSTOMERS.slice(0, 5).map(([n, e, loc, o, s, c, st]) => `<a class="row between" href="${go('admin/customers', 'Customer detail')}" style="color:inherit"><span class="row gap-3">${avatar(n)}${cell(n, loc)}</span>${status(st, st === 'Under review' ? 'info' : undefined)}</a><span class="row between xs sub"><span>${o} orders · ${money(s)}</span><span>${c} open case${c === 1 ? '' : 's'}</span></span>`))}`;

  register({
    id: 'admin/customers', title: 'Customers', ref: 'Plan ch. 17, 18',
    notes: 'Customer accounts with orders, spend, open cases, account status and verification. The detail drawer brings profile, orders, cases, messages, internal notes and abuse reports together, and account actions require a recorded reason.',
    states: ['List', 'Customer detail'],
    render: (st) => {
      const base = adminLayout(customersBody(st === 'Customer detail'), 'customers');
      if (st !== 'Customer detail') return base;
      return base + drawer({
        title: 'Jordan Lee',
        body: `<div class="row gap-3">${avatar('Jordan Lee', 'lg')}<div class="stack gap-1"><span class="row gap-2"><b>Jordan Lee</b>${status('Active')}</span><span class="xs muted">Customer since Aug 2026 · ID CU-208114</span></div></div>
          ${kv([['Email', 'jordan.lee@example.com ' + badge('Verified', 'info')], ['Phone', '(503) 555-0148 ' + badge('Verified', 'info')], ['Default address', '2140 Alder St, Apt 5, Portland, OR 97205'], ['Sign-in', 'Password + two-step code · last Oct 8, 7:02 AM'], ['Marketing', 'Email offers on · essential updates always on']])}
          <div class="row between"><span class="small strong">Orders (5) · ${money(911.48)} spent</span><a class="xs strong" href="${go('admin/orders')}">All orders</a></div>
          <ul class="list">
            ${D.orders.map((o) => `<li><span class="grow stack gap-0"><a class="mono small" href="${go('admin/order')}">${o.ref}</a><span class="xs muted">${o.date} · ${o.sellers} seller${o.sellers > 1 ? 's' : ''}</span></span><span class="small num">${money(o.total)}</span>${status(o.status)}</li>`).join('')}
          </ul>
          <div class="stack gap-2"><span class="small strong">Open case</span>
            <a class="panel row between" href="${go('admin/case', 'Investigating')}" style="color:inherit"><span class="stack gap-0"><span class="mono small">CS-104882</span><span class="xs muted">Dispute · delayed duvet cover · Casa Verde Home</span></span>${status('Waiting on seller')}</a></div>
          <div class="stack gap-2"><span class="small strong">Messages</span><span class="small sub">2 order conversations · last message Oct 6 to Casa Verde Home</span></div>
          <div class="stack gap-2"><span class="small strong">Internal notes</span>
            <div class="ab-msg is-note"><span class="who"><b>Isabel Cruz</b> · Oct 6</span><p>Polite and clear. Delay is on the seller side. Offer refund if no scan by Oct 9.</p></div></div>
          <div class="stack gap-2"><span class="small strong">Abuse reports</span><span class="small sub">None filed by or against this customer.</span></div>
          <div class="divider"></div>
          <span class="h4">Account action</span>
          ${field('Action', select('cu-act', ['Choose an action', 'Send password reset link', 'Sign out of all devices', 'Restrict messaging', 'Restrict account', 'Close account'], 'Choose an action'))}
          ${field('Reason', select('cu-reason', ['Select a reason', 'Customer request', 'Suspected account takeover', 'Abusive messages', 'Payment fraud review', 'Policy violation'], 'Select a reason'))}
          ${field('Details for the record', textarea('cu-detail', '', 'What happened and what evidence you checked'))}
          ${alert('info', 'What stays available', 'Restricting or closing an account stops new orders. Existing orders, returns, refunds and cases stay open and reachable by the customer and our teams.')}`,
        foot: `${btn('Cancel', { v: 'ghost' })}${btn('Apply action', { disabled: true })}`,
      });
    },
  });

  /* ======================================================================
     4. admin/cases — Cases and disputes queue
     ====================================================================== */
  const CASES = [
    ['CS-104921', 'Delivery · lost package', 'High', 'Alex Morgan', 'Marketly Official', null, 'Open', ['Overdue 1 h', 'danger'], 'MK-260930-44310'],
    ['CS-104915', 'Return dispute · damaged on arrival', 'High', 'Sam Rivera', 'Pixel &amp; Port', 'Lena Park', 'Escalated', ['Overdue 4 h', 'danger'], 'MK-261001-30554'],
    ['CS-104933', 'Dispute · not as described', 'Medium', 'Chris Taylor', 'Gadget Grove', null, 'Open', ['Overdue 30 min', 'danger'], 'MK-261006-09977'],
    ['CS-104882', 'Dispute · delayed item', 'High', 'Jordan Lee', 'Casa Verde Home', 'Isabel Cruz', 'Waiting on seller', ['Due 12:00 PM', 'warning'], 'MK-260914-48213'],
    ['CS-104930', 'Refund · not received', 'Medium', 'Priya Kapoor', 'Northwind Audio', 'Isabel Cruz', 'Open', ['Due 1:30 PM', 'warning'], 'MK-260926-37720'],
    ['CS-104944', 'Order change · cancel item', 'Medium', 'Kyle Benson', 'Pixel &amp; Port', null, 'Open', ['Due 3:00 PM', 'ok'], 'MK-261007-52018'],
    ['CS-104947', 'Seller report · abusive messages', 'Medium', 'Derek Mills', 'Pixel &amp; Port', 'Sven Larsen', 'Open', ['Due 4:00 PM', 'ok'], 'MK-260929-41175'],
    ['CS-104940', 'Account · cannot sign in', 'Low', 'Nina Okafor', '—', 'Mateo Ruiz', 'Waiting on customer', ['Oct 9, 10:00 AM', 'ok'], null],
    ['CS-104951', 'Delivery · delayed', 'Low', 'Hana Sato', 'Trailhead Outfitters', 'Aisha Bello', 'Reopened', ['Oct 9, 11:00 AM', 'ok'], 'MK-261003-48802'],
    ['CS-104802', 'Dispute · wrong item sent', 'Medium', 'Ben Alvarez', 'Gadget Grove', 'Isabel Cruz', 'Appealed', ['Appeal ends Oct 9', 'warning'], 'MK-260920-30017'],
  ];
  const prio = (p) => badge(p, p === 'High' ? 'danger' : p === 'Medium' ? 'warning' : '', p === 'High' ? 'arrow-up' : null);

  register({
    id: 'admin/cases', title: 'Cases and disputes', ref: 'Plan ch. 13, 17',
    notes: 'Support and dispute queue with category, priority, parties, owner, status and the next response deadline; overdue cases are flagged and sorted first. Saved filters and bulk assignment keep every case owned.',
    states: ['Queue', 'Bulk assign'],
    render: (st) => {
      const bulk = st === 'Bulk assign';
      const rows = bulk ? CASES.filter((c) => !c[5]) : CASES;
      const caseHref = (r) => r === 'CS-104882' ? go('admin/case', 'Investigating') : go('admin/case');
      return adminLayout(`
      ${pageHead('Cases and disputes', { crumbs: [{ label: 'Admin', href: go('admin/dashboard') }, 'Customers and service'], sub: 'Owner Isabel Cruz, Customer Support Manager · backup Mateo Ruiz · escalation to Returns or Finance by case type', actions: btn('Export', { v: 'secondary', size: 'sm', icon: 'download' }) + btn('New case', { size: 'sm', icon: 'plus' }) })}
      ${kpis([
        ['Open cases', '31', { icon: 'life-buoy', note: '8 opened today' }],
        ['Past response target', '5', { icon: 'alarm-clock', note: 'Oldest overdue 4 h' }],
        ['Unassigned', '6', { icon: 'user-x', note: 'Assign within 1 h' }],
        ['Open disputes', '4', { icon: 'scale', note: 'Decision target 5 business days' }],
        ['Median first reply', '2 h 40 m', { icon: 'clock', delta: '18 min', dir: 'up', note: 'faster than last week' }],
      ], 'k5')}
      ${example('Example targets: first reply within 4 business hours, dispute decision within 5 business days. Business hours Mon–Sat, 8 AM–8 PM PT.')}
      <div class="stack gap-3">
        ${tabs([{ label: 'All open', count: 31 }, { label: 'My cases', count: 0 }, { label: 'Unassigned', count: 6 }, { label: 'Overdue', count: 5 }, { label: 'Disputes', count: 4 }], bulk ? 'Unassigned' : 'All open')}
        ${toolbar(`${searchIn('Search case, order, customer or seller', 'cs-q')}${select('cs-cat', ['All categories', 'Delivery', 'Return dispute', 'Dispute', 'Refund', 'Order change', 'Account', 'Seller report'], 'All categories')}${select('cs-pri', ['Any priority', 'High', 'Medium', 'Low'], 'Any priority')}${select('cs-sort', ['Sort: next deadline', 'Sort: newest', 'Sort: priority'], 'Sort: next deadline')}`)}
        ${bulk ? `<div class="bulk-bar"><span>3 selected</span><span class="grow"></span><label class="sr-only" for="cs-assign">Assign to</label>${select('cs-assign', ['Assign to… Mateo Ruiz (2 open)', 'Aisha Bello (5 open)', 'Isabel Cruz (9 open)', 'Lena Park, Returns (6 open)'], 'Assign to… Mateo Ruiz (2 open)')}${btn('Assign 3 cases', { v: 'soft', size: 'sm', icon: 'user-check' })}${btn('Set priority', { v: 'ghost', size: 'sm' })}${btn('Clear', { v: 'ghost', size: 'sm' })}</div>` : ''}
        <div class="card no-phone">${table(['Case', 'Category', 'Priority', 'Customer', 'Seller', 'Owner', 'Status', 'Next response', 'Order'],
          rows.map(([r, cat, p, cu, se, ow, s, dl, o]) => [
            `<a class="mono strong nowrap" href="${caseHref(r)}">${r}</a>`, cat, prio(p), cu, se,
            ow ? person(ow) : `<span class="xs t-warning-text strong">Unassigned</span>`,
            status(s), deadline(dl[0], dl[1]), o ? ref(o, 'admin/order') : '<span class="muted">—</span>',
          ]), { select: true, checked: bulk ? [0, 1, 2] : [], rowCls: rows.map((c) => c[7][1] === 'danger' ? 'is-flagged' : c[7][1] === 'warning' ? 'is-warn' : '') })}
          <div class="card-foot"><span class="ab-note grow">Cases close only after any promised refund or replacement is complete.</span>${U.pager(1, 4)}</div></div>
        ${mlist(rows.slice(0, 6).map(([r, cat, p, cu, se, ow, s, dl]) => `<div class="row between"><a class="mono strong" href="${caseHref(r)}">${r}</a>${status(s)}</div><span class="small">${cat}</span><span class="xs muted">${cu} · ${se} · ${ow || 'Unassigned'}</span><div class="row between">${prio(p)}${deadline(dl[0], dl[1])}</div>`))}
      </div>
    `, 'cases');
    },
  });

  /* ======================================================================
     5. admin/case — Dispute CS-104882
     ====================================================================== */
  const msg = (cls, who, role, when, text) => `<div class="ab-msg is-${cls}"><span class="who"><b>${who}</b>${badge(role, cls === 'customer' ? '' : cls === 'seller' ? 'info' : cls === 'staff' ? 'brand' : 'warning')}<span>${when}</span></span><p>${text}</p></div>`;

  register({
    id: 'admin/case', title: 'Dispute CS-104882', ref: 'Plan ch. 13, 14, 17',
    notes: 'Dispute review for a delayed duvet cover: parties, purchase terms captured at order time, shipment evidence, photos, the labelled conversation and staff-only notes. The decision records a remedy, routes the refund to Finance within approval limits and publishes an appeal deadline to both parties.',
    states: ['Investigating', 'Decision recorded'],
    render: (st) => {
      const done = st === 'Decision recorded';
      const P = D.P;
      const decisionPanel = done
        ? card({
          title: 'Decision', sub: 'Recorded Oct 8, 10:12 AM by Isabel Cruz',
          body: `${alert('success', 'Customer favored: full item refund', 'Seller missed the dispatch deadline and two later promises. No carrier scan as of Oct 8, 9:00 AM.')}
            ${sumlist([['Refund to customer', `<b>${money(114.54)}</b>`], ['Item price paid', money(119)], ['Coupon share (platform funded)', '−' + money(4.46)], ['Charged to seller earnings', '−' + money(104.72)], ['Marketplace fee returned', money(14.28)]])}
            <div class="divider"></div>
            <ul class="ab-approvals">
              <li><span class="n is-done">${icon('check', 'ic-sm')}</span>${cell('Isabel Cruz · Support', 'Decision recorded 10:12 AM')}${status('Decision made')}</li>
              <li><span class="n is-done">${icon('check', 'ic-sm')}</span>${cell('Priya Nair · Finance', 'Remedy approved 10:31 AM · limit $2,000')}${status('Approved')}</li>
              <li><span class="n">${icon('loader', 'ic-sm')}</span>${cell('Refund RF-261008-0447', 'Visa •••• 4417 · 3–5 business days')}${status('Processing')}</li>
            </ul>
            ${alert('info', 'Refund approved, not yet received', 'The customer sees Processing until the card network confirms. The case stays open until the refund shows Sent.')}
            ${kv([['Appeal deadline', '<b>Oct 15, 2026, 11:59 PM PT</b>'], ['Published to', 'Jordan Lee and Casa Verde Home · Oct 8, 10:33 AM'], ['Seller statement', 'Deduction −$104.72 on the Oct 16 statement'], ['Appeal reviewer', 'Grace Kim (not the original decider)']])}`,
          foot: `${btn('Add update', { v: 'secondary', size: 'sm' })}${btn('Resolve case', { size: 'sm', disabled: true })}`,
        })
        : card({
          title: 'Decision', sub: 'Decision target: Oct 13 · 5 business days from escalation',
          body: `${field('Decision', select('cd-dec', ['Customer favored', 'Seller favored', 'Shared outcome', 'Request more information'], 'Customer favored'))}
            <fieldset class="stack gap-2" style="border:0;padding:0;margin:0"><legend class="label">Remedy</legend>
              ${optCard('cd-rem', 'cd-rem-1', '<span class="small strong">Refund the item</span>', 'Customer keeps the order if it arrives and may return it free', true)}
              ${optCard('cd-rem', 'cd-rem-2', '<span class="small strong">Replacement by a deadline</span>', 'Seller ships with tracking by Oct 12; refund if no carrier scan', false)}
              ${optCard('cd-rem', 'cd-rem-3', '<span class="small strong">Partial refund</span>', 'For a delay the customer accepts', false)}
            </fieldset>
            ${field('Refund amount', input('cd-amt', '114.54', { prefix: '$' }), { hint: 'Maximum refundable for this item: $114.54 (price $119.00 less $4.46 coupon share). Shipping was free.' })}
            ${field('Charged to', select('cd-who', ['Seller: late dispatch', 'Platform: goodwill', 'Shared'], 'Seller: late dispatch'))}
            <div class="panel stack gap-1 small">${sumRow('Seller earnings', '−' + money(104.72))}${sumRow('Marketplace fee returned', money(14.28))}${sumRow('Platform coupon recovered', money(4.46))}</div>
            ${alert('warning', 'Finance approval needed', 'Your goodwill limit is $50.00. This remedy goes to Priya Nair, Finance Manager (limit $2,000), before the refund is sent.')}
            ${field('Reason shared with both parties', textarea('cd-why', 'Casa Verde Home missed the Sep 16 dispatch deadline and the Oct 5 ship date. The label was created on Oct 5 but has no carrier scan. Under the purchase terms, a late item can be refunded.'))}
            ${field('Appeal deadline', input('cd-appeal', 'Oct 15, 2026, 11:59 PM PT', { icon: 'calendar' }), { hint: '7 days from the decision. Published to the customer and the seller.' })}
            ${check('cd-notify', 'Notify Jordan Lee and Casa Verde Home with the decision and appeal route', true)}`,
          foot: `${btn('Save draft', { v: 'ghost', size: 'sm' })}${btn('Record decision and send to Finance', { size: 'sm', href: go('admin/case', 'Decision recorded') })}`,
        });

      return adminLayout(`
      ${pageHead('Dispute CS-104882', { crumbs: [{ label: 'Cases and disputes', href: go('admin/cases') }, 'CS-104882'], eyebrow: 'Dispute · delayed item', sub: `Order ${ref('MK-260914-48213', 'admin/order')} · Mosswood Washed Linen Duvet Cover, Queen · opened Sep 23 · escalated to dispute Oct 6`, actions: `${done ? status('Decision made') : status('Waiting on seller')}${prio('High')}${btn('Reassign', { v: 'secondary', size: 'sm', icon: 'user-round' })}${btn('Escalate', { v: 'secondary', size: 'sm', icon: 'arrow-up-right' })}` })}

      <div class="card pad"><div class="row between" style="--gap:var(--sp-4)">
        ${done
          ? `<span class="row gap-2">${icon('circle-check')}<span class="stack gap-0"><b class="small">Decision published Oct 8, 10:33 AM</b><span class="xs muted">Next: confirm refund Sent · appeal window open until Oct 15</span></span></span>${deadline('Appeal window: 7 days', 'ok')}`
          : `<span class="row gap-4">${deadline('Seller evidence due 12:00 PM · 2 h 20 m', 'warning')}${deadline('Reply promised to customer: Oct 9, 9:00 AM', 'ok')}${deadline('Decision target: Oct 13', 'ok')}</span><span class="xs muted">Owner Isabel Cruz · Finance reviewer Priya Nair</span>`}
      </div></div>

      <div class="ab-main wide">
        <div class="stack gap-5">
          <div class="grid md2" style="--gap:var(--sp-4)">
            ${card({ title: 'Customer', body: `<div class="row gap-3">${avatar('Jordan Lee')}${cell(`<a href="${go('admin/customers', 'Customer detail')}">Jordan Lee</a>`, 'Portland, OR · 5 orders · 1 open case')}</div>${kv([['Asks for', 'Full refund'], ['Contact', 'jordan.lee@example.com']])}` })}
            ${card({ title: 'Seller', body: `<div class="row gap-3">${logoTile(D.sellers.casaverde)}${cell(`<a href="${go('admin/seller')}">Casa Verde Home</a>`, 'Sacramento, CA · Verified seller')}</div>${kv([['Offers', 'Ship the order on Oct 8'], ['On-time dispatch', '<span class="t-warning-text">91% this month</span>']])}` })}
          </div>

          ${card({
            title: 'Purchase terms at time of order', sub: 'Snapshot taken Sep 14, 2026, 7:42 PM · purchase terms v3.2',
            body: `<div class="row top gap-4">${pimg(P.duvet, 'thumb')}<div class="grow">${kv([
              ['Item', 'Mosswood Washed Linen Duvet Cover, Queen · Sage · SKU MSW-LIN-Q-SAGE'],
              ['Price paid', `${price(119, 149)} <span class="xs muted">seller markdown, plus $4.46 share of WELCOME20</span>`],
              ['Promised delivery', 'Mon, Sep 22 · dispatch within 2 business days (by Sep 16)'],
              ['Shipping', 'Free · ships from seller, Sacramento, CA'],
              ['Returns', '30-day returns · seller pays return shipping for late, damaged or incorrect items'],
              ['Payment', 'Visa •••• 4417 · Accepted Sep 14'],
            ])}</div></div>`,
          })}

          ${card({
            title: 'Shipment evidence',
            body: `${timeline([
              { t: 'Order accepted', d: 'Sep 14, 7:42 PM', state: 'done' },
              { t: 'Dispatch deadline missed', d: 'Sep 16, 5:00 PM', state: 'danger', body: 'No shipment recorded. Seller reminder sent automatically.' },
              { t: 'Seller set new ship date: Oct 5', d: 'Sep 24, 10:02 AM', state: 'warn', body: 'Reason given: backordered from the mill.' },
              { t: 'Label created', d: 'Oct 5, 4:48 PM', state: 'warn', body: 'USPS Ground Advantage 9400 1118 9922 3456 7821 04 · no carrier scan' },
              { t: done ? 'Still no carrier scan at decision time' : 'No carrier scan yet', d: 'Checked Oct 8, 9:00 AM', state: 'current' },
            ])}`,
          })}

          ${card({
            title: 'Photos and files', sub: '3 files · uploaded by parties',
            body: `<div class="ab-photos">
              <figure>${img('package', 'var(--img-3)', 'r43')}<figcaption>Seller: packed parcel, Oct 5</figcaption></figure>
              <figure>${img('receipt', 'var(--img-5)', 'r43')}<figcaption>Seller: label printout, Oct 5</figcaption></figure>
              <figure>${img('smartphone', 'var(--img-2)', 'r43')}<figcaption>Customer: order page showing Sep 22 estimate</figcaption></figure>
            </div>`,
          })}

          ${card({
            title: 'Conversation', sub: 'Customer, seller and staff messages in one place. Internal notes are never shown to the parties.',
            body: `<div class="ab-conv">
              ${msg('customer', 'Jordan Lee', 'Customer', 'Sep 23, 8:14 PM', 'My duvet cover was due Sep 22 and the order still says Preparing. When will it ship?')}
              ${msg('seller', 'Marta Reyes, Casa Verde Home', 'Seller', 'Sep 24, 10:02 AM', 'Sorry for the wait. The sage queen is backordered from our mill. We expect to ship on Oct 5 and will send tracking.')}
              ${msg('customer', 'Jordan Lee', 'Customer', 'Oct 6, 7:40 AM', 'It is Oct 6 and there is still no tracking. I would like a refund instead.')}
              ${msg('seller', 'Marta Reyes, Casa Verde Home', 'Seller', 'Oct 6, 9:15 AM', 'We printed the label on Oct 5 and the carrier picks up on Oct 8. We would prefer to ship the order.')}
              ${msg('staff', 'Isabel Cruz', 'Marketly staff', 'Oct 6, 11:30 AM · to both parties', 'I am reviewing this dispute. Casa Verde Home, please share proof of carrier pickup by Oct 8, 12:00 PM PT. Jordan, you will have a decision from us by Oct 9.')}
              ${msg('note', 'Isabel Cruz', 'Internal note', 'Oct 7, 4:05 PM', 'Seller missed two dispatch promises. Leaning toward a refund unless a carrier scan appears before noon on Oct 8.')}
              ${msg('note', 'Grace Kim', 'Internal note · Seller Manager', 'Oct 7, 5:20 PM', 'Casa Verde on-time dispatch is down to 91% this month. Performance review opened. No restriction for now.')}
              ${done ? msg('staff', 'Isabel Cruz', 'Marketly staff', 'Oct 8, 10:33 AM · to both parties', 'Decision: full refund of $114.54 to Jordan Lee, charged to the seller for late dispatch. The refund is being processed and usually arrives in 3–5 business days. Either party can appeal until Oct 15, 2026, 11:59 PM PT.') : ''}
            </div>
            <div class="stack gap-2">
              ${seg(['Reply to both', 'Customer only', 'Seller only', 'Internal note'], 0)}
              ${field('Message', textarea('cd-reply', '', 'Write a reply'))}
              <div class="row between">${btn('Attach file', { v: 'ghost', size: 'sm', icon: 'paperclip' })}${btn('Send', { size: 'sm', icon: 'send' })}</div>
            </div>`,
          })}
        </div>

        <div class="stack gap-5">
          ${decisionPanel}
          ${card({
            title: 'Case history',
            body: timeline([
              { t: 'Problem reported on the order', d: 'Sep 23 · by customer', state: 'done' },
              { t: 'Escalated to dispute', d: 'Oct 6, 7:41 AM · by customer', state: 'done' },
              { t: 'Assigned to Isabel Cruz', d: 'Oct 6, 8:05 AM · by Mateo Ruiz', state: 'done' },
              { t: 'Seller hold placed: $1,240.00', d: 'Oct 6 · Finance · review Oct 15', state: 'done' },
              done ? { t: 'Decision recorded and approved', d: 'Oct 8, 10:31 AM', state: 'current' } : { t: 'Waiting for seller evidence', d: 'Due Oct 8, 12:00 PM', state: 'current' },
            ]),
          })}
        </div>
      </div>
    `, 'cases');
    },
  });

  /* ======================================================================
     6. admin/trust — Trust and risk
     ====================================================================== */
  const route = (items) => `<ul class="ab-route">${items.map(([action, owner, st, why]) => `<li><span class="stack gap-0"><span class="small strong">${action}</span><span class="xs muted">${owner}</span></span>${status(st, st === 'Sent to owner' ? 'info' : undefined)}${why ? `<span class="xs sub">Reason recorded: ${why}</span>` : ''}</li>`).join('')}</ul>`;
  const lnk = (ic, t, id) => `<a class="ab-link" href="${id ? go(id) : 'javascript:void 0'}">${icon(ic)}${t}</a>`;
  const report = (o) => `<section class="card ab-report">
    <div class="top">
      <span class="ab-risk t-${o.risk >= 70 ? 'high' : o.risk >= 40 ? 'med' : 'low'}" aria-label="Risk score ${o.risk} of 100">${o.risk}<small>${o.risk >= 70 ? 'High' : o.risk >= 40 ? 'Medium' : 'Low'}</small></span>
      <div class="grow stack gap-1"><span class="row gap-2"><span class="mono small">${o.id}</span>${badge(o.type, '', o.icon)}${status(o.status)}</span><h3 class="h4">${o.title}</h3><span class="xs muted">${o.meta}</span></div>
      <div class="row gap-2">${btn('Dismiss with reason', { v: 'ghost', size: 'sm' })}${btn('Open report', { v: 'secondary', size: 'sm' })}</div>
    </div>
    <div class="body">
      <div class="stack gap-3"><span class="small strong">Evidence</span>${checks(o.evidence)}<span class="small strong">Linked records</span><div class="ab-links">${o.links.join('')}</div></div>
      <div class="stack gap-3"><span class="small strong">Recommended actions · routed to the owning team</span>${route(o.route)}</div>
    </div>
  </section>`;

  register({
    id: 'admin/trust', title: 'Trust and risk', ref: 'Plan ch. 17, 18',
    notes: 'Trust and Risk queue for counterfeit reports, suspicious orders, fake reviews and abuse, each with evidence, a risk score and linked seller, product and customer. Recommendations go to the team that acts (Catalog, Seller Manager, Support, Finance) with recorded reasons, and appeals are reviewed by someone other than the original decider.',
    render: () => adminLayout(`
      ${pageHead('Trust and risk', { crumbs: [{ label: 'Admin', href: go('admin/dashboard') }, 'Customers and service'], sub: 'Queue owner Sven Larsen, Trust and Risk Manager · Trust recommends; Catalog, Seller Manager, Support and Finance act', actions: btn('Export', { v: 'secondary', size: 'sm', icon: 'download' }) })}
      ${kpis([
        ['Open reports', '4', { icon: 'shield-alert', note: '1 high risk' }],
        ['Counterfeit', '1', { icon: 'badge-alert', note: 'Brand owner report' }],
        ['Suspicious orders', '1', { icon: 'credit-card', note: '6 orders on hold' }],
        ['Fake reviews', '1', { icon: 'star', note: '11 reviews flagged' }],
        ['Abuse', '1', { icon: 'message-square-warning', note: 'Messaging' }],
        ['Appeals waiting', '2', { icon: 'scale', note: 'Decide by Oct 14' }],
      ], 'k6')}
      ${tabs([{ label: 'All open', count: 4 }, { label: 'Counterfeit', count: 1 }, { label: 'Suspicious orders', count: 1 }, { label: 'Fake reviews', count: 1 }, { label: 'Abuse', count: 1 }, { label: 'Appeals', count: 2 }], 0)}

      ${report({
        id: 'TR-3391', type: 'Counterfeit', icon: 'badge-alert', status: 'Escalated', risk: 86,
        title: 'Brightline S2 Robot Vacuum offered by Gadget Grove may be counterfeit',
        meta: 'Reported Oct 5 by Brightline (brand owner) and 3 customers · assigned to Sven Larsen',
        evidence: [['fail', '4 serial numbers from buyer photos are not in the Brightline registry'], ['fail', 'Charging dock label and font differ from the brand reference photos'], ['warn', 'Offer price $279.00 is 20% below every authorized offer'], ['info', 'Seller supplied 2 purchase invoices · supplier could not be confirmed']],
        links: [lnk('store', 'Gadget Grove · Restricted', 'admin/seller'), lnk('package', 'Brightline S2 · BRL-S2', 'admin/catalog'), lnk('users', '14 buyers in 30 days', 'admin/customers'), lnk('life-buoy', 'CS-104933', 'admin/case')],
        route: [
          ['Suspend the Gadget Grove offer for BRL-S2', 'Catalog · Omar Haddad', 'Completed', 'Brand registry mismatch on 4 units'],
          ['Restrict new listings in Home &amp; Kitchen', 'Seller Manager · Grace Kim', 'Completed', 'Counterfeit risk pending review; open orders and returns stay active'],
          ['Tell the 14 recent buyers how to get a refund', 'Support · Isabel Cruz', 'Sent to owner', null],
          ['Hold seller payout until review', 'Finance · Priya Nair', 'Completed', 'Held $4,188.40, review Oct 16'],
        ],
      })}

      ${report({
        id: 'TR-3402', type: 'Suspicious orders', icon: 'credit-card', status: 'Open', risk: 74,
        title: '6 orders from new accounts ship to one Reno address with different cards',
        meta: 'Detected Oct 7 by payment risk rules · $1,140.94 total · Kestrel portable SSDs',
        evidence: [['fail', '6 accounts created within 40 minutes, 5 different cards'], ['warn', '2 card payments passed with address mismatch'], ['info', 'Shipping address is a parcel forwarding service']],
        links: [lnk('user-round', 'Kyle Benson + 5 accounts', 'admin/customers'), lnk('store', 'Pixel &amp; Port', 'admin/seller'), lnk('shopping-bag', '6 orders', 'admin/orders')],
        route: [
          ['Hold dispatch on 6 orders', 'Orders · Theo Grant', 'Completed', 'Payment risk review; seller asked not to ship'],
          ['Review payments and refund if unconfirmed', 'Finance · Priya Nair', 'Sent to owner', null],
          ['Ask buyers to confirm identity', 'Support · Mateo Ruiz', 'Pending', null],
        ],
      })}

      ${report({
        id: 'TR-3405', type: 'Fake reviews', icon: 'star', status: 'Open', risk: 58,
        title: '11 five-star reviews on Aster Daily Vitamin C Serum posted within 2 hours',
        meta: 'Detected Oct 7 by review pattern check · product sold by Marketly Official',
        evidence: [['warn', '9 of 11 reviewers have no recorded purchase (not Verified Purchase)'], ['warn', 'Similar wording in 7 reviews'], ['ok', '2 reviews are Verified Purchase and stay published']],
        links: [lnk('package', 'Aster Vitamin C Serum · AST-VC30', 'admin/catalog'), lnk('star', '11 reviews', 'admin/reviews')],
        route: [
          ['Remove 9 unverified reviews', 'Catalog · reviews moderation · Omar Haddad', 'Sent to owner', 'Coordinated posting by accounts with no purchase'],
          ['Keep legitimate reviews, including negative ones', 'Catalog · Omar Haddad', 'Pending', null],
        ],
      })}

      ${report({
        id: 'TR-3410', type: 'Abuse', icon: 'message-square-warning', status: 'Open', risk: 41,
        title: 'Customer sent abusive messages to Pixel &amp; Port',
        meta: 'Reported Oct 7 by the seller · linked case CS-104947',
        evidence: [['warn', '4 messages with insults and threats after a return was approved'], ['info', 'Return itself was handled on time']],
        links: [lnk('user-round', 'Derek Mills · Restricted', 'admin/customers'), lnk('store', 'Pixel &amp; Port', 'admin/seller'), lnk('life-buoy', 'CS-104947', 'admin/cases')],
        route: [
          ['Restrict messaging for 30 days', 'Support · Isabel Cruz', 'Completed', 'Abusive messages to seller staff; orders and refund unaffected'],
          ['Send warning with appeal route', 'Support · Isabel Cruz', 'Completed', null],
        ],
      })}

      ${card({
        title: 'Appeals', sub: 'Reviewed by someone other than the person who decided',
        flush: true,
        body: table(['Appeal', 'Filed by', 'Decision appealed', 'Filed', 'Reviewer', 'Decide by', 'Status'], [
          [ref('AP-0127'), 'Gadget Grove', 'Listing restriction, Home &amp; Kitchen (TR-3391)', 'Oct 7', person('Morgan Hale', 'Business Owner'), deadline('Oct 14', 'ok'), status('Under review')],
          [ref('AP-0125'), 'Derek Mills', 'Messaging restricted 30 days (TR-3410)', 'Oct 8', person('Grace Kim', 'Seller Manager'), deadline('Oct 15', 'ok'), status('Open')],
          [ref('AP-0119'), 'Bayside Prints', 'Review removal on 3 products', 'Sep 28', person('Omar Haddad', 'Catalog'), '<span class="xs muted">Decided Oct 2</span>', status('Resolved')],
        ]),
        foot: `<span class="ab-note grow">Restrictions keep valid order history, returns and access to help for everyone involved.</span>`,
      })}
    `, 'trust'),
  });

  /* ======================================================================
     7. admin/promotions
     ====================================================================== */
  const PROMOS = [
    ['Home Week markdowns', 'Bedding, lighting, cookware', 'Markdown', 'Oct 6 – Oct 19', 'Shared 50/50', 3920, 8000, 612, 'Live'],
    ['WELCOME20', '$20 off first order of $100+', 'Fixed coupon', 'Aug 1 – Dec 31', 'Platform', 7440, 15000, 372, 'Live'],
    ['AUDIO15', '15% off Halden audio · Northwind Audio', '% coupon', 'Oct 1 – Oct 31', 'Seller', 1105, 2500, 98, 'Live'],
    ['Kestrel SSD flash sale', '400 units · limit 2 per customer', 'Flash sale', 'Oct 9, 9 AM – 9 PM', 'Shared 70/30', 0, 4000, 0, 'Scheduled'],
    ['Spend $75, save $10', 'Whole store except Official clearance', 'Min-spend', 'Oct 10 – Oct 12', 'Platform', 0, 5000, 0, 'Scheduled'],
    ['Free shipping weekend', 'Seller-shipped orders over $25', 'Free shipping', 'Oct 16 – Oct 18', 'Platform', 0, 3000, 0, 'Scheduled'],
    ['Fall Home Sale', '20% off bedding and lighting', '% coupon', 'Oct 16 – Oct 25', 'Shared 50/50', 0, 12000, 0, 'In review'],
    ['Back to campus', '10% off computers and storage', '% coupon', 'Aug 15 – Sep 15', 'Platform', 9310, 10000, 1104, 'Finished'],
  ];
  const fundBadge = (f) => badge(f, f === 'Platform' ? 'brand' : f === 'Seller' ? 'info' : 'outline');

  register({
    id: 'admin/promotions', title: 'Promotions and coupons', ref: 'Plan ch. 15',
    notes: 'All promotions with type, period, funding owner, budget use, redemptions and status, plus campaign results that keep discount cost and margin impact separate from sales. Funding owner is always visible so a platform coupon never quietly reduces seller proceeds.',
    render: () => adminLayout(`
      ${pageHead('Promotions and coupons', { crumbs: [{ label: 'Admin', href: go('admin/dashboard') }, 'Marketing and content'], sub: 'Owner Jamie Brooks, Marketing Manager · Finance confirms funding · Pacific Time', actions: btn('Export', { v: 'secondary', size: 'sm', icon: 'download' }) + btn('Create campaign', { size: 'sm', icon: 'plus', href: go('admin/promotion-new') }) })}
      ${kpis([
        ['Sales with a promotion', money(96240), { icon: 'shopping-bag', note: 'Oct 1–8 · 1,214 orders' }],
        ['Discount cost', money(11870), { icon: 'ticket-percent', note: 'Platform $6,420 · sellers $4,180 · shared $1,270' }],
        ['Official Store margin impact', '−2.4 pts', { icon: 'chart-column', note: '31.8% → 29.4% on promoted items' }],
        ['Coupon redemptions', num(1912), { icon: 'tag', note: '6.1% of orders' }],
        ['Returns on promoted orders', '3.1%', { icon: 'undo-2', note: 'Store average 2.8%' }],
      ], 'k5')}
      <div class="card">
        <div style="padding:0 var(--sp-4)">${tabs([{ label: 'All', count: 8 }, { label: 'Live', count: 3 }, { label: 'Scheduled', count: 3 }, { label: 'Waiting for Finance', count: 1 }, { label: 'Ended', count: 1 }, { label: 'Drafts', count: 0 }], 0)}</div>
        <div class="card-body" style="padding-bottom:var(--sp-3)">${toolbar(`${searchIn('Search by name or code', 'pr-q')}${select('pr-type', ['All types', 'Markdown', '% coupon', 'Fixed coupon', 'Min-spend', 'Free shipping', 'Flash sale'], 'All types')}${select('pr-fund', ['Any funding owner', 'Platform', 'Seller', 'Shared'], 'Any funding owner')}`)}</div>
        ${table(['Campaign', 'Type', 'Period (PT)', 'Funding owner', 'Budget used', { label: 'Redemptions', cls: 'r' }, 'Status', ''],
          PROMOS.map(([n, d, t, p, f, used, bud, red, st]) => [
            cell(`<a href="${go('admin/promotion-new', st === 'In review' ? 'Finance confirmation' : 'Setup')}">${n}</a>`, d),
            badge(t, 'deal-soft'), `<span class="nowrap">${p}</span>`, fundBadge(f),
            `<div class="stack gap-1" style="min-width:140px"><span class="xs num">${money(used)} of ${money(bud)}</span>${meter(Math.round(used / bud * 100), used / bud > 0.9 ? 'warning' : '')}</div>`,
            num(red), status(st), btn(st === 'Live' ? 'Pause' : 'Edit', { v: 'ghost', size: 'sm' }),
          ]))}
      </div>
      <div class="grid lg2" style="--gap:var(--sp-5)">
        ${card({
          title: 'Campaign results', sub: 'Oct 1–8 · costs recorded separately from sales',
          flush: true,
          body: table(['Campaign', { label: 'Sales', cls: 'r' }, { label: 'Discount cost', cls: 'r' }, 'Margin impact', 'Sellers'], [
            ['Home Week markdowns', money(48210), money(3920), '−3.1 pts', '6 joined'],
            ['WELCOME20', money(37480), money(7440), '−1.8 pts', 'Not affected'],
            ['AUDIO15', money(10550), money(1105), 'Seller funded', '1 seller'],
            ['Back to campus (ended)', money(92640), money(9310), '−2.2 pts', '4 joined'],
          ]),
          foot: `<span class="ab-note grow">Margin uses landed cost for Official Store items. Seller-funded discounts do not change company margin.</span><a class="small strong" href="${go('admin/reports')}">Full report</a>`,
        })}
        ${card({
          title: 'Daily discount cost', sub: 'Oct 1–8 · all campaigns · USD',
          body: barChart({ labels: ['Oct 1', 'Oct 2', 'Oct 3', 'Oct 4', 'Oct 5', 'Oct 6', 'Oct 7', 'Oct 8'], data: [920, 1040, 1310, 1620, 1580, 1890, 1960, 1550], fmt: (v) => '$' + Math.round(v).toLocaleString('en-US'), label: 'Daily discount cost' }) + example('Oct 8 is partial, through 9:40 AM PT.'),
        })}
      </div>
    `, 'promotions'),
  });

  /* ======================================================================
     8. admin/promotion-new — Campaign setup
     ====================================================================== */
  register({
    id: 'admin/promotion-new', title: 'Create promotion campaign', ref: 'Plan ch. 15, 14',
    notes: 'Campaign setup covering period with time zone, products or categories, eligible customers, discount, budget and usage caps, per-customer and per-order limits, funding owner, stacking rules, exclusions and seller consent with expected earnings impact. A price preview shows the product card, cart and checkout, and Finance confirms funding before publication.',
    states: ['Setup', 'Finance confirmation'],
    render: (st) => {
      const fin = st === 'Finance confirmation';
      const P = D.P;
      const sec = (n, title, body, sub) => card({ title: `<span class="row gap-2"><span class="badge t-outline">${n}</span>${title}</span>`, sub, body });
      const lock = fin ? '<span class="xs muted">' + icon('lock', 'ic-sm') + ' Locked while Finance reviews</span>' : '';
      const form = `
        ${sec(1, 'Basics', `<div class="ab-form-grid">
          ${field('Campaign name', input('pn-name', 'Fall Home Sale'))}
          ${field('Promotion type', select('pn-type', ['Item markdown', 'Percentage coupon', 'Fixed-amount coupon', 'Minimum-spend discount', 'Free shipping', 'Flash sale'], 'Percentage coupon'))}
          ${field('Coupon code', input('pn-code', 'FALLHOME20'), { hint: 'Also applied automatically from the campaign page' })}
          ${field('Internal note', input('pn-note', 'Supports Home Week follow-up and Q4 bedding push'), { opt: true })}
        </div>`, lock)}
        ${sec(2, 'Schedule', `<div class="ab-form-grid c3">
          ${field('Starts', input('pn-start', 'Oct 16, 2026, 12:00 AM', { icon: 'calendar' }))}
          ${field('Ends', input('pn-end', 'Oct 25, 2026, 11:59 PM', { icon: 'calendar' }))}
          ${field('Time zone', select('pn-tz', ['Pacific Time (PT)', 'Mountain Time (MT)', 'Central Time (CT)', 'Eastern Time (ET)'], 'Pacific Time (PT)'))}
        </div>${example('Countdowns on the Deals page use these exact times.')}`)}
        ${sec(3, 'Products and offers', `<fieldset class="stack gap-2" style="border:0;padding:0;margin:0"><legend class="sr-only">What the campaign covers</legend>
            ${radio('pn-scope', 'pn-scope-1', 'Categories', true)}${radio('pn-scope', 'pn-scope-2', 'Selected products or offers', false)}</fieldset>
          ${chips([{ label: 'Home &amp; Kitchen › Bedding', x: true, active: true }, { label: 'Home &amp; Kitchen › Lighting', x: true, active: true }, { label: 'Add category', icon: 'plus' }])}
          <span class="xs muted">214 eligible offers · 6 sellers + Official Store</span>`)}
        ${sec(4, 'Eligible customers', `<div class="ab-checkgrid">
          ${radio('pn-cust', 'pn-cust-1', 'All customers, including guests', false)}${radio('pn-cust', 'pn-cust-2', 'Signed-in customers', true)}
          ${radio('pn-cust', 'pn-cust-3', 'New customers (first order)', false)}${radio('pn-cust', 'pn-cust-4', 'Customers in selected regions', false)}
        </div>`)}
        ${sec(5, 'Discount and limits', `<div class="ab-form-grid c3">
          ${field('Discount value', input('pn-val', '20', { suffix: '% off' }))}
          ${field('Maximum discount per order', input('pn-max', '40.00', { prefix: '$' }))}
          ${field('Total budget', input('pn-bud', '12,000.00', { prefix: '$' }), { hint: 'Campaign stops when the budget is used' })}
          ${field('Usage cap', input('pn-cap', '2,000', { suffix: 'redemptions' }))}
          ${field('Per customer', input('pn-pc', '1', { suffix: 'use' }))}
          ${field('Per order', input('pn-po', '1', { suffix: 'coupon' }))}
        </div>`)}
        ${sec(6, 'Funding owner', `<div class="ab-checkgrid">
          ${optCard('pn-fund', 'pn-fund-1', '<span class="small strong">Platform</span>', 'Marketly pays the full discount. Seller proceeds are unchanged.', false)}
          ${optCard('pn-fund', 'pn-fund-2', '<span class="small strong">Seller</span>', 'Each participating seller pays for its own offers.', false)}
          ${optCard('pn-fund', 'pn-fund-3', '<span class="small strong">Shared</span>', 'Platform 50% · sellers 50% of the discount on seller offers', true)}
        </div><span class="xs muted">Official Store items: the discount is a company cost and shows in company trading margin.</span>`)}
        ${sec(7, 'Combination rules and exclusions', `<div class="ab-checkgrid">
          ${check('pn-c1', 'Combines with seller markdowns', true)}${check('pn-c2', 'Combines with other coupons', false)}
          ${check('pn-c3', 'Combines with free shipping offers', true)}${check('pn-c4', 'Applies to items already in a flash sale', false)}
        </div>
        ${field('Exclusions', `<div class="row gap-2">${badge('Official Store clearance', 'outline')}${badge('Gadget Grove (restricted seller)', 'outline')}${badge('Brightline S2 (under review)', 'outline')}${btn('Add exclusion', { v: 'link', size: 'sm', icon: 'plus' })}</div>`)}`)}
        ${sec(8, 'Seller participation', `${check('pn-sp', 'Invite sellers to join. Each seller must consent before its offers are included.', true)}
          ${table(['Seller', 'Offers', 'Consent', { label: 'Seller earns per $100 sale', cls: 'r' }], [
            ['Casa Verde Home', '42', status('Accepted', 'success'), '<span class="num">$79.20 <span class="xs muted">(was $88.00)</span></span>'],
            ['Mosswood Living', '18', status('Accepted', 'success'), '<span class="num">$79.20 <span class="xs muted">(was $88.00)</span></span>'],
            ['Trailhead Outfitters', '6', status('Pending'), '<span class="num">$79.20 <span class="xs muted">(was $88.00)</span></span>'],
          ])}
          <div class="panel small">On a $100.00 sale at 20% off with shared funding: the customer pays $80.00, the seller funds $10.00 and the platform funds $10.00. Commission of 12% applies to $90.00 after the seller-funded part, which is $10.80. The seller earns $79.20.</div>
          ${example('Example rate for Home &amp; Kitchen. Sellers see this estimate on their invitation before they consent.')}`)}
        ${sec(9, 'Price preview', `<div class="ab-pv">
          <div><span class="pcap">Product card</span>${pimg(P.duvet, 'r43')}<span class="small">Mosswood Washed Linen Duvet Cover, Queen</span>${price(95.2, 119)}<span class="row gap-2">${badge('Fall Home Sale −20%', 'deal-soft')}</span><span class="xs muted">Sold by Casa Verde Home</span></div>
          <div><span class="pcap">Cart</span><span class="small strong">Casa Verde Home · Package 1</span><span class="small">Linen Duvet Cover, Queen</span>${sumRow('Item', money(119))}${sumRow('Fall Home Sale (FALLHOME20)', '−' + money(23.8), 'discount')}${sumRow('Shipping', 'Free')}</div>
          <div><span class="pcap">Checkout</span>${sumRow('Items (1)', money(119))}${sumRow('Discounts', '−' + money(23.8), 'discount')}<span class="xs muted">Fall Home Sale applied to 1 item</span>${sumRow('Shipping', 'Free')}${sumRow('Tax', money(0))}${sumRow('Total', money(95.2), 'total')}</div>
        </div>`)}`;

      const side = fin
        ? card({
          title: 'Finance confirmation', sub: 'Sent Oct 8, 9:58 AM · waiting on Priya Nair',
          body: `${checks([
              ['warn', 'Budget $12,000 is above the Marketing limit of $10,000', 'Finance confirms the extra $2,000 from the Q4 bedding fund'],
              ['ok', 'Platform share does not reduce seller proceeds'],
              ['ok', 'Seller share matches the consent each seller gave'],
              ['warn', 'Trailhead Outfitters has not consented', 'Its 6 offers stay out until it accepts'],
              ['ok', 'Cost center MKT-2026-Q4 has $18,400 left'],
            ])}
            ${sumlist([['Platform maximum', money(6000)], ['Sellers maximum', money(6000)], ['Expected sales', money(64000)], ['Official Store margin impact', '−3.1 pts']])}
            ${field('Finance comment', textarea('pn-fin', '', 'Visible to Marketing'))}`,
          foot: `${btn('Request changes', { v: 'secondary', size: 'sm' })}${btn('Confirm funding', { size: 'sm', icon: 'check' })}`,
        })
        : card({
          title: 'Summary', sub: 'Draft · last saved 9:41 AM',
          body: `${sumlist([['Type', '20% coupon, max $40'], ['Period', 'Oct 16–25, PT'], ['Covers', '214 offers in 2 categories'], ['Customers', 'Signed-in'], ['Budget', money(12000) + ' · 2,000 uses'], ['Funding', 'Shared 50/50'], ['Stacking', 'With markdowns and free shipping']])}
            <div class="divider"></div>
            <span class="small strong">Before publishing</span>
            ${checks([['ok', 'Marketing: Jamie Brooks'], ['info', 'Finance confirms funding: Priya Nair'], ['info', 'Content prepares banner and campaign page: Noor Aziz'], ['info', 'Sellers consent: 2 of 3']])}`,
          foot: `${btn('Save draft', { v: 'ghost', size: 'sm' })}${btn('Send to Finance', { size: 'sm', icon: 'send', href: go('admin/promotion-new', 'Finance confirmation') })}`,
        });

      return adminLayout(`
        ${pageHead(fin ? 'Fall Home Sale' : 'Create campaign', { crumbs: [{ label: 'Promotions and coupons', href: go('admin/promotions') }, fin ? 'Fall Home Sale' : 'New campaign'], sub: fin ? 'Percentage coupon · Oct 16–25, 2026 PT · created by Jamie Brooks' : 'Marketing sets up the campaign. Finance confirms funding before it can go live.', actions: fin ? status('In review') : '' })}
        ${steps(['Set up', 'Finance confirmation', 'Content and pages', 'Scheduled'], fin ? 1 : 0)}
        ${fin ? alert('info', 'Waiting for Finance', 'Edits are locked while Priya Nair reviews the funding. You get a notification when it is confirmed or sent back.') : ''}
        <div class="ab-main wide"><div class="stack gap-4${fin ? ' ab-locked' : ''}">${form}</div><div class="stack gap-4 ab-sticky">${side}</div></div>
      `, 'promotions');
    },
  });

  /* ======================================================================
     9. admin/content — Homepage and pages
     ====================================================================== */
  const SECTIONS = [
    ['Campaign banner', 'Home Week: up to 30% off bedding, lighting and cookware', 'Noor Aziz · Content', 'Oct 6 – Oct 19', 'Published', 'image'],
    ['Opening full-screen ad', 'Controlled by Advertising · Home Week opening ad', 'Jamie Brooks · Advertising', 'Oct 6 – Oct 19', 'ad', 'app-window'],
    ['Category shortcuts', '8 categories', 'Noor Aziz · Content', 'Always on', 'Published', 'layout-grid'],
    ['Deals', 'Flash deals from live campaigns', 'Jamie Brooks · Marketing', 'Follows campaigns', 'Published', 'tag'],
    ['Official Store highlights', '4 products · chosen by Official Store', 'Dana Ortiz · Official Store', 'Always on', 'Published', 'badge-check'],
    ['Sponsored brand banner', 'Controlled by Advertising · Halden Aurora', 'Jamie Brooks · Advertising', 'Oct 1 – Oct 10', 'ad', 'megaphone'],
    ['Featured products: Fall picks', '12 products · manual selection', 'Noor Aziz · Content', 'Oct 9, 6:00 AM – Oct 31', 'Scheduled', 'sparkles'],
    ['Featured sellers', '4 verified sellers', 'Grace Kim · Sellers', 'Always on', 'Published', 'store'],
    ['Holiday gift guide teaser', 'Draft copy and 3 collections', 'Noor Aziz · Content', 'From Nov 1', 'Draft', 'gift'],
  ];

  register({
    id: 'admin/content', title: 'Homepage and pages', ref: 'Plan ch. 15, 19',
    notes: 'Ordered homepage sections with owner, schedule, status and preview; ad positions are marked as controlled by Advertising and cannot be edited here. Campaign pages have publish and removal times, and every change creates a version that can be restored.',
    states: ['Sections', 'Edit section'],
    render: (st) => {
      const edit = st === 'Edit section';
      const rows = SECTIONS.map(([n, d, ow, sch, s, ic], i) => {
        const ad = s === 'ad';
        return `<div class="ab-sec${ad ? ' is-ad' : ''}${edit && i === 6 ? ' is-edit' : ''}">
          <span class="handle">${ad ? icon('lock', 'ic-sm') : icon('grip-vertical', 'ic-sm')}</span>
          <span class="row gap-2"><span class="xs muted num">${i + 1}</span>${icon(ic, 'ic-sm')}<b class="small">${n}</b>${ad ? badge('Ad position', 'outline') : status(s)}</span>
          <span class="meta"><span>${d}</span><span>${icon('user-round', 'ic-sm')} ${ow}</span><span>${icon('calendar', 'ic-sm')} ${sch}</span></span>
          <span class="acts">${ad ? `<a class="small strong" href="${go('admin/ads')}">Managed in Advertisements</a>` : `${iconBtn('arrow-up', 'Move ' + n + ' up')}${iconBtn('arrow-down', 'Move ' + n + ' down')}${iconBtn('eye', 'Preview ' + n)}${btn('Edit', { v: 'ghost', size: 'sm', href: go('admin/content', 'Edit section') })}`}</span>
        </div>`;
      }).join('');
      const page = adminLayout(`
        ${pageHead('Homepage and pages', { crumbs: [{ label: 'Admin', href: go('admin/dashboard') }, 'Marketing and content'], sub: 'Owner Noor Aziz, Content Manager · ad positions and timing belong to Advertising · times in PT', actions: btn('Preview homepage', { v: 'secondary', size: 'sm', icon: 'eye' }) + btn('Add section', { size: 'sm', icon: 'plus' }) })}
        <div class="ab-main">
          <div class="stack gap-5">
            ${card({ title: 'Homepage sections', sub: 'Shown top to bottom · drag or use arrows to reorder · live version 14', flush: true, body: rows, foot: `<span class="ab-note grow">Reordering saves a draft. Customers see it after you publish.</span>${btn('Discard draft', { v: 'ghost', size: 'sm' })}${btn('Publish order', { size: 'sm' })}` })}
            ${card({
              title: 'Campaign pages', sub: 'Each page has a publish time and a removal time',
              actions: btn('New campaign page', { v: 'secondary', size: 'sm', icon: 'plus' }),
              flush: true,
              body: table(['Page', 'Owner', 'Publish', 'Remove', 'Status', ''], [
                [cell('Home Week', '/campaign/home-week'), 'Noor Aziz', 'Oct 6, 12:00 AM', 'Oct 19, 11:59 PM', status('Published'), btn('Preview', { v: 'ghost', size: 'sm', icon: 'eye' })],
                [cell('Fall Home Sale', '/campaign/fall-home-sale'), 'Noor Aziz', 'Oct 16, 12:00 AM', 'Oct 25, 11:59 PM', status('Scheduled'), btn('Preview', { v: 'ghost', size: 'sm', icon: 'eye' })],
                [cell('Kestrel flash sale', '/campaign/kestrel-flash'), 'Jamie Brooks', 'Oct 9, 9:00 AM', 'Oct 9, 9:00 PM', status('Scheduled'), btn('Preview', { v: 'ghost', size: 'sm', icon: 'eye' })],
                [cell('Back to campus', '/campaign/back-to-campus'), 'Noor Aziz', 'Aug 15', 'Removed Sep 16', status('Unpublished'), btn('Restore', { v: 'ghost', size: 'sm', icon: 'rotate-ccw' })],
                [cell('Holiday gift guide', '/campaign/holiday-gifts'), 'Noor Aziz', 'Not set', 'Not set', status('Draft'), btn('Edit', { v: 'ghost', size: 'sm' })],
              ]),
            })}
          </div>
          <div class="stack gap-5">
            ${card({
              title: 'Preview', sub: 'Desktop homepage · draft',
              body: `<div class="ab-wire" aria-label="Homepage layout preview">
                <div class="w-hero">Campaign banner · Home Week</div><div class="w-ad">Ad · opening full-screen (Advertising)</div><div class="w-cats">Category shortcuts</div><div class="w-deals">Deals</div><div class="w-off">Official Store highlights</div><div class="w-ad">Ad · sponsored brand (Advertising)</div><div class="w-feat">Featured: Fall picks · from Oct 9</div><div class="w-sell">Featured sellers</div></div>
                ${seg([{ label: 'Desktop', icon: 'monitor' }, { label: 'Phone', icon: 'smartphone' }], 0)}`,
            })}
            ${card({
              title: 'Version history', flush: true,
              body: `<ul class="list pad">
                <li><span class="grow stack gap-0"><span class="small strong">v14 · live</span><span class="xs muted">Oct 6, 9:02 AM · Noor Aziz · Published Home Week banner, moved Deals above Official Store</span></span>${badge('Current', 'brand')}</li>
                <li><span class="grow stack gap-0"><span class="small strong">v13</span><span class="xs muted">Oct 1, 8:15 AM · Jamie Brooks · Added Sponsored brand position</span></span>${btn('Restore', { v: 'ghost', size: 'sm', icon: 'rotate-ccw' })}</li>
                <li><span class="grow stack gap-0"><span class="small strong">v12</span><span class="xs muted">Sep 16, 12:01 AM · System · Removed Back to campus banner on schedule</span></span>${btn('Restore', { v: 'ghost', size: 'sm', icon: 'rotate-ccw' })}</li>
                <li><span class="grow stack gap-0"><span class="small strong">v11</span><span class="xs muted">Sep 2, 3:40 PM · Noor Aziz · Corrected category shortcut order</span></span>${btn('Restore', { v: 'ghost', size: 'sm', icon: 'rotate-ccw' })}</li>
              </ul>`,
              foot: `<span class="ab-note grow">Restoring creates a new version. Nothing is overwritten.</span>`,
            })}
          </div>
        </div>
      `, 'content');
      if (!edit) return page;
      return page + drawer({
        title: 'Edit section: Fall picks',
        body: `${field('Heading', input('ct-head', 'Fall picks for home'))}
          ${field('Subheading', input('ct-sub', 'Warm layers, soft light and slow coffee'), { opt: true })}
          ${field('Product source', select('ct-src', ['Manual selection', 'Collection: Fall home', 'Rule: top sellers in Home &amp; Kitchen'], 'Manual selection'))}
          <div class="stack gap-2"><span class="label">Products (12)</span>
            <ul class="list">${['duvet', 'lamp', 'pourover', 'skillet'].map((id) => { const p = D.P[id]; return `<li>${pimg(p, 'tiny')}<span class="grow stack gap-0"><span class="small truncate">${esc(p.name)}</span><span class="xs muted">${seller(p.seller)} · ${p.stock} in stock</span></span>${iconBtn('x', 'Remove ' + p.name)}</li>`; }).join('')}</ul>
            <span class="xs muted">+ 8 more · unavailable products are hidden automatically</span>${btn('Add products', { v: 'secondary', size: 'sm', icon: 'plus' })}</div>
          <div class="ab-form-grid">
            ${field('Show from', input('ct-from', 'Oct 9, 2026, 6:00 AM', { icon: 'calendar' }))}
            ${field('Remove at', input('ct-to', 'Oct 31, 2026, 11:59 PM', { icon: 'calendar' }))}
          </div>
          ${field('Time zone', select('ct-tz', ['Pacific Time (PT)', 'Eastern Time (ET)'], 'Pacific Time (PT)'))}
          ${field('Position', select('ct-pos', ['7 · after Sponsored brand banner', '3 · after Category shortcuts', '5 · after Official Store highlights'], '7 · after Sponsored brand banner'))}
          ${field('Owner', select('ct-own', ['Noor Aziz · Content', 'Jamie Brooks · Marketing'], 'Noor Aziz · Content'))}
          ${alert('info', 'Saved as version 15', 'Customers see this section at the scheduled time. Version 14 stays available to restore.')}`,
        foot: `${btn('Remove section', { v: 'danger-soft', size: 'sm' })}<span class="grow"></span>${btn('Save draft', { v: 'ghost', size: 'sm' })}${btn('Schedule', { size: 'sm' })}`,
      });
    },
  });

  /* ======================================================================
     10. admin/help-content — Help articles and policies
     ====================================================================== */
  register({
    id: 'admin/help-content', title: 'Help articles and policies', ref: 'Plan ch. 17, 19',
    notes: 'Help articles and policies with category, owner, status, effective date and version. Policy edits carry an effective date, a change summary and a note on existing orders, which keep the terms accepted at purchase; previous versions stay viewable.',
    states: ['Articles', 'Edit policy'],
    render: (st) => {
      if (st === 'Edit policy') {
        return adminLayout(`
          ${pageHead('Return policy · version 3.1', { crumbs: [{ label: 'Help and policies', href: go('admin/help-content') }, 'Return policy'], sub: 'Policy owner Lena Park, Returns Manager · content editor Noor Aziz', actions: status('Draft') + btn('Preview public page', { v: 'secondary', size: 'sm', icon: 'eye', href: go('info/policy', 'Returns') }) })}
          <div class="ab-main wide">
            <div class="stack gap-4">
              ${card({
                title: 'Policy text',
                body: `${field('Title', input('hp-title', 'Return policy'))}
                  <div class="field"><label class="label" for="hp-body">Body</label>
                    <div class="ab-edbar" role="toolbar" aria-label="Formatting">${iconBtn('heading-2', 'Heading')}${iconBtn('bold', 'Bold')}${iconBtn('italic', 'Italic')}${iconBtn('list', 'Bulleted list')}${iconBtn('list-ordered', 'Numbered list')}${iconBtn('link', 'Insert link')}</div>
                    ${textarea('hp-body', 'Holiday returns\nItems delivered from Nov 1 to Dec 31, 2026 can be returned until Jan 31, 2027.\n\nWho pays return shipping\nThe seller pays return shipping for damaged, defective, incorrect or late items. For change-of-mind returns, the seller\'s listed return terms apply. Sellers can offer more generous terms.')}</div>`,
              })}
              ${card({
                title: 'Changes from version 3.0',
                body: `<p class="ab-diff">Items can be returned within 30 days of delivery<ins>, except items delivered from Nov 1 to Dec 31, 2026, which can be returned until Jan 31, 2027</ins>. The seller pays return shipping for <del>damaged or incorrect</del><ins>damaged, defective, incorrect or late</ins> items.</p>`,
              })}
              ${card({
                title: 'Previous versions', flush: true,
                body: table(['Version', 'Effective', 'Summary', 'Approved by', ''], [
                  ['<b>3.0</b> · current', 'Sep 1, 2026', 'Category exceptions for beauty and opened electronics', 'Morgan Hale', btn('View', { v: 'ghost', size: 'sm' })],
                  ['2.1', 'Jul 15, 2026', 'Clarified refund timing by payment method', 'Morgan Hale', btn('View', { v: 'ghost', size: 'sm' })],
                  ['2.0', 'Jun 1, 2026', 'Seller return terms can be more generous than baseline', 'Morgan Hale', btn('View', { v: 'ghost', size: 'sm' })],
                ]),
              })}
            </div>
            <div class="stack gap-4 ab-sticky">
              ${card({
                title: 'Publishing',
                body: `${field('Effective date', input('hp-eff', 'Nov 1, 2026, 12:00 AM PT', { icon: 'calendar' }), { hint: 'At least 14 days after publishing for customer-facing changes' })}
                  ${field('Change summary', textarea('hp-sum', 'Longer return window for holiday deliveries. Late items added to the list where the seller pays return shipping.'), { hint: 'Shown at the top of the policy page and in the notice' })}
                  <fieldset class="stack gap-2" style="border:0;padding:0;margin:0"><legend class="label">Impact on existing orders</legend>
                    ${optCard('hp-imp', 'hp-imp-1', '<span class="small strong">Orders placed from Nov 1 only</span>', 'Earlier orders keep the terms accepted at purchase', true)}
                    ${optCard('hp-imp', 'hp-imp-2', '<span class="small strong">Also extend to open orders</span>', 'Only for changes that favor the customer', false)}</fieldset>
                  ${check('hp-n1', 'Notify customers with an account', true)}${check('hp-n2', 'Notify sellers in Seller Center', true)}
                  <div class="divider"></div>
                  <ul class="ab-approvals">
                    <li><span class="n is-done">${icon('check', 'ic-sm')}</span>${cell('Lena Park · Returns', 'Policy owner · approved Oct 7')}${status('Approved')}</li>
                    <li><span class="n is-wait">2</span>${cell('Morgan Hale · Business Owner', 'Final approval')}${status('Pending')}</li>
                  </ul>`,
                foot: `${btn('Save draft', { v: 'ghost', size: 'sm' })}${btn('Send for approval', { size: 'sm' })}`,
              })}
            </div>
          </div>
        `, 'help-content');
      }
      const rows = [
        ['Return policy', 'Policy', 'Returns', 'Lena Park', 'Published', 'Sep 1, 2026', '3.0'],
        ['Return policy', 'Policy', 'Returns', 'Lena Park', 'Draft', 'Nov 1, 2026', '3.1'],
        ['Shipping and delivery policy', 'Policy', 'Delivery', 'Theo Grant', 'Published', 'Aug 1, 2026', '2.2'],
        ['Purchase terms', 'Policy', 'Shopping', 'Morgan Hale', 'Published', 'Aug 1, 2026', '3.2'],
        ['Seller rules and fees', 'Policy', 'Sellers', 'Grace Kim', 'Scheduled', 'Oct 15, 2026', '2.1'],
        ['Advertising and sponsored labels', 'Policy', 'Advertising', 'Jamie Brooks', 'Published', 'Sep 1, 2026', '1.0'],
        ['When will I get my refund?', 'Article', 'Refunds', 'Noor Aziz', 'Published', 'Sep 20, 2026', '4'],
        ['Track a package from another seller', 'Article', 'Delivery', 'Noor Aziz', 'Published', 'Sep 12, 2026', '2'],
        ['Cancel an item before it ships', 'Article', 'Cancellations', 'Noor Aziz', 'Published', 'Aug 28, 2026', '3'],
        ['My payment was declined', 'Article', 'Payment', 'Noor Aziz', 'In review', '—', '2'],
      ];
      return adminLayout(`
        ${pageHead('Help and policies', { crumbs: [{ label: 'Admin', href: go('admin/dashboard') }, 'Marketing and content'], sub: 'Content Manager Noor Aziz maintains articles; each policy has a business owner and an approval step', actions: btn('New article', { v: 'secondary', size: 'sm', icon: 'plus' }) + btn('New policy version', { size: 'sm', icon: 'file-plus', href: go('admin/help-content', 'Edit policy') }) })}
        ${kpis([['Published articles', '48', { icon: 'book-open', note: '8 categories' }], ['Policies', '9', { icon: 'scale', note: '1 scheduled · 1 draft' }], ['Articles needing review', '3', { icon: 'clock', note: 'Older than 90 days' }], ['Helpful rating', '87%', { icon: 'thumbs-up', note: 'Last 30 days' }]], 'k4')}
        <div class="card">
          <div style="padding:0 var(--sp-4)">${tabs([{ label: 'All', count: 57 }, { label: 'Policies', count: 9 }, { label: 'Help articles', count: 48 }, { label: 'Drafts and review', count: 3 }], 0)}</div>
          <div class="card-body" style="padding-bottom:var(--sp-3)">${toolbar(`${searchIn('Search titles', 'hc-q')}${select('hc-cat', ['All categories', 'Shopping', 'Delivery', 'Payment', 'Cancellations', 'Returns', 'Refunds', 'Accounts', 'Sellers', 'Advertising'], 'All categories')}`)}</div>
          ${table(['Title', 'Type', 'Category', 'Owner', 'Status', 'Effective date', 'Version', ''],
            rows.map(([t, ty, c, o, s, e, v]) => [
              `<a class="strong" href="${ty === 'Policy' ? go('admin/help-content', 'Edit policy') : 'javascript:void 0'}">${t}</a>`,
              badge(ty, ty === 'Policy' ? 'info' : ''), c, o, status(s), e, `<span class="mono">v${v}</span>`,
              btn('Edit', { v: 'ghost', size: 'sm', href: ty === 'Policy' ? go('admin/help-content', 'Edit policy') : undefined }),
            ]))}
          <div class="card-foot"><span class="ab-note grow">Policies show their effective date publicly. Orders keep the terms accepted at purchase.</span>${U.pager(1, 6)}</div>
        </div>
      `, 'help-content');
    },
  });

  /* ======================================================================
     11. admin/ads — Advertisement Management dashboard
     ====================================================================== */
  const LIFECYCLE = ['Draft', 'In review', 'Approved', 'Scheduled', 'Live', 'Paused', 'Finished', 'Archived'];
  const ADS = [
    ['Home Week opening ad', 'Marketly', false, 'Opening full-screen', 'Home, category entry', 'Oct 6 – Oct 19', 'Internal', 128400, 3210, 'Live'],
    ['Halden Aurora banner', 'Halden (brand)', true, 'Banner', 'Home, Electronics', 'Oct 1 – Oct 10', '$1,240 of $3,000', 86200, 1930, 'Live'],
    ['Kestrel SSD sponsored products', 'Pixel &amp; Port', true, 'Sponsored product', 'Search, Computers', 'Oct 3 – Oct 31', '$412 of $1,500', 54100, 1480, 'Live'],
    ['Free shipping weekend pop-up', 'Marketly', false, 'Pop-up', 'Home, cart page excluded', 'Oct 10 – Oct 18', 'Internal', 0, 0, 'Scheduled'],
    ['Fall Home Sale opening ad', 'Marketly', false, 'Opening full-screen', 'Home, campaign page', 'Oct 16 – Oct 25', 'Internal', 0, 0, 'In review'],
    ['Kestrel 27" monitor sponsored product', 'Pixel &amp; Port', true, 'Sponsored product', 'Search, Monitors', 'Oct 12 – Nov 8', '$0 of $800', 0, 0, 'In review'],
    ['Trailhead Ridge store feature', 'Trailhead Outfitters', true, 'Sponsored store', 'Home, Sports', 'Oct 1 – Oct 20', '$96 of $600', 12800, 210, 'Paused'],
    ['Fall picks banner', 'Marketly', false, 'Banner', 'Home &amp; Kitchen', 'Oct 9 – Oct 31', 'Internal', 0, 0, 'Approved'],
    ['Northwind Audio store feature', 'Northwind Audio', true, 'Sponsored store', 'Electronics', 'Not set', '$500 limit', 0, 0, 'Draft'],
    ['Back to campus opening ad', 'Marketly', false, 'Opening full-screen', 'Home', 'Aug 15 – Sep 15', 'Internal', 402300, 8870, 'Finished'],
    ['Summer clearance banner', 'Marketly', false, 'Banner', 'Home, Deals', 'Jul 1 – Jul 31', 'Internal', 311000, 6020, 'Archived'],
  ];
  const adActions = (s) => ({
    Live: btn('Pause', { v: 'ghost', size: 'sm', icon: 'pause' }) + btn('Finish', { v: 'ghost', size: 'sm' }),
    Paused: btn('Resume', { v: 'ghost', size: 'sm', icon: 'play' }) + btn('Finish', { v: 'ghost', size: 'sm' }),
    Scheduled: btn('Pause', { v: 'ghost', size: 'sm', icon: 'pause' }) + btn('Edit', { v: 'ghost', size: 'sm' }),
    'In review': btn('Review', { v: 'secondary', size: 'sm', href: go('admin/ad-campaign', 'Approval') }),
    Approved: btn('Schedule', { v: 'secondary', size: 'sm' }),
    Draft: btn('Edit', { v: 'ghost', size: 'sm', href: go('admin/ad-campaign', 'Goal & advertiser') }),
    Finished: btn('Archive', { v: 'ghost', size: 'sm' }) + btn('Renew', { v: 'ghost', size: 'sm' }),
    Archived: btn('View', { v: 'ghost', size: 'sm' }),
  }[s]);

  register({
    id: 'admin/ads', title: 'Advertisement Management', ref: 'Plan ch. 16',
    notes: 'Advertising Manager dashboard: live campaigns, upcoming starts, ending soon, waiting approvals, spending and performance with a stated attribution period. The campaigns table covers our own promotional ads and seller paid ads through the full lifecycle, with Pause, Resume and Finish actions.',
    render: () => adminLayout(`
      ${pageHead('Advertisements', { crumbs: [{ label: 'Admin', href: go('admin/dashboard') }, 'Advertisements'], sub: 'Owner Jamie Brooks, Advertising Manager · own promotions and seller paid ads (pilot with 3 sellers) · Pacific Time', actions: btn('Placements and rules', { v: 'secondary', size: 'sm', icon: 'settings-2', href: go('admin/ad-placements') }) + btn('Create campaign', { size: 'sm', icon: 'plus', href: go('admin/ad-campaign', 'Goal & advertiser') }) })}
      ${kpis([
        ['Live now', '3', { icon: 'radio', note: '1 own · 2 paid' }],
        ['Starting in 7 days', '2', { icon: 'calendar', note: 'Next: Oct 9, 6:00 AM' }],
        ['Ending soon', '1', { icon: 'timer', note: 'Halden Aurora banner, Oct 10' }],
        ['Waiting approval', '2', { icon: 'list-checks', note: 'Oldest 1 day' }],
        ['Spend this month', money(1748), { icon: 'circle-dollar-sign', note: 'Seller paid ads · billed separately from commission' }],
        ['Attributed purchases', '186', { icon: 'shopping-bag', note: money(21940) + ' · 7-day click window' }],
      ], 'k6')}

      <div class="ab-main">
        <div class="stack gap-5">
          ${card({
            title: 'Campaigns', sub: 'Every status in the campaign lifecycle',
            flush: true,
            body: `<div class="card-body" style="padding-bottom:var(--sp-2)"><div class="ab-lifecycle" aria-label="Campaign lifecycle">${LIFECYCLE.map((s, i) => (i ? icon('chevron-right') : '') + status(s)).join('')}</div>
              ${toolbar(`${searchIn('Search campaign or advertiser', 'ad-q')}${select('ad-src', ['Own and paid ads', 'Own promotions', 'Seller paid ads', 'Brand campaigns'], 'Own and paid ads')}${select('ad-type', ['All ad types', 'Opening full-screen', 'Banner', 'Pop-up', 'Sponsored product', 'Sponsored store'], 'All ad types')}`)}</div>
              ${table(['Campaign', 'Advertiser', 'Type and placement', 'Period', 'Budget / spend', { label: 'Displays', cls: 'r' }, { label: 'Clicks', cls: 'r' }, 'Status', ''],
                ADS.map(([n, adv, paid, t, pl, per, bud, dis, cl, s]) => [
                  `<a class="strong" href="${go('admin/ad-campaign', 'Creative & preview')}">${n}</a>`,
                  `<span class="row nowrap gap-2">${adv}${paid ? badge('Paid', 'info') : badge('Own', 'brand')}</span>`,
                  cell(t, pl), `<span class="nowrap">${per}</span>`, bud, dis ? num(dis) : '—', cl ? num(cl) : '—', status(s), `<span class="row nowrap gap-1">${adActions(s)}</span>`,
                ]), { rowCls: ADS.map((a) => a[9] === 'Paused' || a[9] === 'In review' ? 'is-warn' : '') })}`,
            foot: `<span class="ab-note grow">Pausing takes an ad off the site within 1 minute. Expired ads and ads for unavailable offers are removed automatically.</span>`,
          })}

          ${card({
            title: 'Performance', sub: 'Oct 1–8 · all live campaigns',
            body: `<div class="grid m2 md4" style="--gap:var(--sp-3)">
                <div class="panel">${stat('Displays', num(281500))}</div>
                <div class="panel">${stat('Clicks', num(6620), { note: '2.4% of displays' })}</div>
                <div class="panel">${stat('Dismissals', num(41300), { note: 'Opening ad closed: 32%' })}</div>
                <div class="panel">${stat('Attributed purchases', '186', { note: money(21940) })}</div>
              </div>
              ${barChart({ labels: ['Oct 1', 'Oct 2', 'Oct 3', 'Oct 4', 'Oct 5', 'Oct 6', 'Oct 7', 'Oct 8'], data: [24.1, 26.8, 31.2, 35.4, 33.9, 48.7, 52.3, 29.1], fmt: (v) => v.toFixed(0) + 'k', label: 'Daily ad displays in thousands' })}
              ${example('Attribution period: a purchase counts when it happens within 7 days of a click on the ad. Paid campaigns never guarantee purchases. Oct 8 is partial.')}`,
          })}
        </div>

        <div class="stack gap-5">
          ${card({
            title: 'Waiting approval', flush: true,
            body: `<ul class="list pad">
              <li><span class="grow stack gap-0"><a class="small strong" href="${go('admin/ad-campaign', 'Approval')}">Fall Home Sale opening ad</a><span class="xs muted">Marketly · needs Content review · Noor Aziz</span></span>${status('In review')}</li>
              <li><span class="grow stack gap-0"><span class="small strong">Kestrel 27" monitor sponsored product</span><span class="xs muted">Pixel &amp; Port · paid · creative check</span></span>${status('In review')}</li>
            </ul>`,
          })}
          ${card({
            title: 'Upcoming starts', flush: true,
            body: `<ul class="list pad">
              <li><span class="grow stack gap-0"><span class="small strong">Fall picks banner</span><span class="xs muted">Banner · Oct 9, 6:00 AM</span></span>${status('Approved')}</li>
              <li><span class="grow stack gap-0"><span class="small strong">Free shipping weekend pop-up</span><span class="xs muted">Pop-up · Oct 10, 12:00 AM</span></span>${status('Scheduled')}</li>
            </ul>`,
          })}
          ${card({
            title: 'Ending soon', flush: true,
            body: `<ul class="list pad"><li><span class="grow stack gap-0"><span class="small strong">Halden Aurora banner</span><span class="xs muted">Ends Oct 10, 11:59 PM · finish or renew deliberately</span></span>${status('Ending soon')}</li></ul>`,
            foot: `${btn('Renew', { v: 'secondary', size: 'sm' })}${btn('Let it finish', { v: 'ghost', size: 'sm' })}`,
          })}
          ${card({
            title: 'Seller ad billing', sub: 'Example model: fixed placement fee per week',
            body: sumlist([['Billed this month', money(1748)], ['Unused budget returned', money(312)], ['Cancelled campaigns', '0']]) + example('Ad charges appear on seller statements as a separate line from sales commission.'),
          })}
        </div>
      </div>
    `, 'ads'),
  });

  /* ======================================================================
     12. admin/ad-campaign — Create campaign wizard
     ====================================================================== */
  const AD_STEPS = ['Goal & advertiser', 'Placement & audience', 'Schedule & limits', 'Creative & preview', 'Approval'];
  const adCreative = (desk) => { const P = D.P; return `<div class="ab-ad${desk ? ' desk' : ''}"><span class="ab-adtag">Ad</span><button type="button" class="ab-adx" aria-label="Close advertisement">${icon('x')}</button><div class="art">${pimg(P.duvet)}${pimg(P.lamp)}</div><div class="copy"><b>Fall Home Sale: 20% off bedding and lighting</b><span>Oct 16–25 · Casa Verde Home, Mosswood and the Official Store</span><span class="cta">Shop the sale</span></div></div>`; };
  const skeleton = (n) => Array.from({ length: n }, (_, i) => `<div class="sk" style="height:${[18, 46, 12, 30, 30][i % 5]}px;${i === 2 ? 'width:60%' : ''}"></div>`).join('');
  const adPreviews = () => `<div class="ab-previews">
      <div class="stack gap-2"><span class="xs strong sub">${icon('monitor', 'ic-sm')} Desktop · 1600 × 900</span>
        <div class="ab-dframe"><div class="ab-dbar"><i></i><i></i><i></i><span>marketly.com</span></div><div class="ab-screen desk">${skeleton(5)}<div class="ab-scrim">${adCreative(true)}</div></div></div></div>
      <div class="stack gap-2"><span class="xs strong sub">${icon('smartphone', 'ic-sm')} Phone · 1080 × 1920</span>
        <div class="ab-mframe"><div class="ab-screen mob">${skeleton(7)}<div class="ab-scrim">${adCreative(false)}</div></div></div></div>
    </div>`;

  const AD_TYPES = [
    ['Opening full-screen', 'app-window', 'Appears when a visitor opens the site. Close or skip always visible.', 'Launch', true],
    ['Banner', 'rectangle-horizontal', 'Image or message on home, category and campaign pages.', 'Launch'],
    ['Pop-up', 'message-square', 'Dismissible window after a set trigger.', 'Launch'],
    ['Sponsored product', 'package', 'Labeled product card in search and categories.', 'Pilot'],
    ['Sponsored store or brand', 'store', 'Labeled feature linking to a seller store or brand.', ''],
    ['Floating panel', 'panel-bottom', 'Compact dismissible strip while browsing.', ''],
    ['Interstitial', 'layers', 'Between selected browsing steps, never in checkout.', ''],
    ['Video', 'video', 'Promotional video with playback and mute controls.', 'Later', false, true],
  ];

  const adStepBody = (i) => {
    if (i === 0) {
      return card({
        title: 'Goal and advertiser',
        body: `<fieldset class="stack gap-2" style="border:0;padding:0;margin:0"><legend class="label">Advertiser</legend><div class="ab-checkgrid">
            ${optCard('ac-adv', 'ac-adv-1', '<span class="small strong">Marketly (own promotion)</span>', 'No charge. Owned by Advertising.', true)}
            ${optCard('ac-adv', 'ac-adv-2', '<span class="small strong">Seller (paid)</span>', 'Seller request with spending limit and billing', false)}
            ${optCard('ac-adv', 'ac-adv-3', '<span class="small strong">Brand (paid)</span>', 'Brand campaign across sellers', false)}
            ${optCard('ac-adv', 'ac-adv-4', '<span class="small strong">Official Store product</span>', 'Company product promotion', false)}
          </div></fieldset>
          <fieldset class="stack gap-2" style="border:0;padding:0;margin:0"><legend class="label">Campaign goal</legend><div class="ab-checkgrid">
            ${radio('ac-goal', 'ac-goal-1', 'Company promotion', false)}${radio('ac-goal', 'ac-goal-2', 'Platform event', true)}
            ${radio('ac-goal', 'ac-goal-3', 'Seller offer', false)}${radio('ac-goal', 'ac-goal-4', 'Brand campaign', false)}
          </div></fieldset>
          <div class="ab-form-grid">
            ${field('Campaign name', input('ac-name', 'Fall Home Sale opening ad'))}
            ${field('Linked promotion', select('ac-promo', ['Fall Home Sale (FALLHOME20)', 'Home Week markdowns', 'None'], 'Fall Home Sale (FALLHOME20)'), { hint: 'The ad brings attention; the promotion changes the price' })}
            ${field('Destination', input('ac-dest', '/campaign/fall-home-sale', { prefix: 'marketly.com' }))}
            ${field('Campaign owner', select('ac-own', ['Jamie Brooks · Advertising', 'Noor Aziz · Content'], 'Jamie Brooks · Advertising'))}
          </div>`,
      });
    }
    if (i === 1) {
      return card({
        title: 'Ad type',
        body: `<div class="ab-types">${AD_TYPES.map(([n, ic, d, tag, sel, dis], k) => optCard('ac-type', 'ac-type-' + k, `<span class="row gap-2">${icon(ic, 'ic-sm')}<span class="small strong">${n}</span>${tag ? badge(tag, tag === 'Launch' ? 'brand' : tag === 'Pilot' ? 'info' : '') : ''}</span>`, d, !!sel, { disabled: dis })).join('')}</div>`,
      }) + card({
        title: 'Pages',
        body: `<div class="ab-checkgrid">
            ${check('ac-pg1', 'Home page', true)}${check('ac-pg2', 'Category pages: Home &amp; Kitchen', true)}
            ${check('ac-pg3', 'Campaign pages', false)}${check('ac-pg4', 'Search results', false)}
            ${check('ac-pg5', 'Product pages', false)}
          </div>
          <div class="panel stack gap-2"><span class="small strong">${icon('lock', 'ic-sm')} Never shown on</span><span class="small sub">Checkout, payment results, order tracking and return pages. This is a platform rule and cannot be changed per campaign.</span></div>`,
      }) + card({
        title: 'Audience',
        body: `<div class="ab-checkgrid">
            ${radio('ac-aud', 'ac-aud-1', 'All shoppers', false)}${radio('ac-aud', 'ac-aud-2', 'Selected audience', true)}
          </div>
          <div class="ab-form-grid">
            ${field('Service regions', select('ac-reg', ['All of the United States', 'West Coast: CA, OR, WA', 'Mountain: CO, ID, NV, UT'], 'All of the United States'))}
            ${field('Visitors', select('ac-vis', ['New and returning', 'New visitors only', 'Returning visitors only'], 'New and returning'))}
            ${field('Sign-in', select('ac-sign', ['Signed-in customers only', 'Everyone, including guests'], 'Signed-in customers only'), { hint: 'Matches the promotion, which needs sign-in' })}
            ${field('Interested in categories', select('ac-cat', ['Home &amp; Kitchen', 'Any category'], 'Home &amp; Kitchen'), { hint: 'Based on browsing in this store only' })}
          </div>
          ${example('Targeting uses only information customers gave us or that their privacy choices allow. Estimated reach: 41,000 visitors per week.')}`,
      });
    }
    if (i === 2) {
      return card({
        title: 'Schedule',
        body: `<div class="ab-form-grid c3">
            ${field('Start', input('ac-start', 'Oct 16, 2026, 12:00 AM', { icon: 'calendar' }))}
            ${field('End', input('ac-end', 'Oct 25, 2026, 11:59 PM', { icon: 'calendar' }))}
            ${field('Publication time zone', select('ac-tz', ['Pacific Time (PT)', 'Eastern Time (ET)'], 'Pacific Time (PT)'))}
          </div>
          ${alert('warning', 'Overlaps with Home Week opening ad on Oct 16–19', 'Both target the home page. Only one overlay shows at a time. The higher priority shows first and the other waits for the next session.')}`,
      }) + card({
        title: 'Display limits and priority',
        body: `<div class="ab-form-grid">
            ${field('Display frequency', select('ac-freq', ['Once per session', 'Once per day', 'Once per campaign', 'Twice per week'], 'Once per session'), { hint: 'Default for opening ads' })}
            ${field('After a visitor closes it', select('ac-dis', ['Do not show again for 7 days', 'Do not show again this campaign', 'Show again next session'], 'Do not show again for 7 days'))}
            ${field('Priority when several ads qualify', select('ac-pri', ['High (3)', 'Normal (2)', 'Low (1)'], 'High (3)'), { hint: 'Equal priority rotates evenly' })}
            ${field('Delivery cap', input('ac-cap', '250,000', { suffix: 'displays' }), { hint: 'Own promotion, no budget charge' })}
          </div>
          ${check('ac-stop', 'Stop the ad when the linked promotion ends or its budget runs out', true)}`,
      });
    }
    if (i === 3) {
      return card({
        title: 'Creative',
        body: `<div class="ab-form-grid">
            <div class="field"><span class="label">Desktop image · 1600 × 900</span><div class="panel row gap-3">${img('image', 'var(--img-1)', 'thumb')}<span class="grow stack gap-0"><span class="small strong">fall-home-desktop.jpg</span><span class="xs muted">1600 × 900 · 412 KB · uploaded Oct 8</span></span>${btn('Replace', { v: 'ghost', size: 'sm' })}</div></div>
            <div class="field"><span class="label">Phone image · 1080 × 1920</span><div class="panel row gap-3">${img('image', 'var(--img-1)', 'thumb')}<span class="grow stack gap-0"><span class="small strong">fall-home-mobile.jpg</span><span class="xs muted">1080 × 1920 · 538 KB · uploaded Oct 8</span></span>${btn('Replace', { v: 'ghost', size: 'sm' })}</div></div>
            ${field('Headline', input('ac-h', 'Fall Home Sale: 20% off bedding and lighting'), { hint: '44 of 60 characters' })}
            ${field('Supporting text', input('ac-t', 'Oct 16–25 · Casa Verde Home, Mosswood and the Official Store'))}
            ${field('Button text', input('ac-b', 'Shop the sale'))}
            ${field('Link', input('ac-l', 'marketly.com/campaign/fall-home-sale', { icon: 'link' }))}
          </div>
          ${dropzone('Add a video version', 'Video ads are not available yet')}`,
      }) + card({
        title: 'Preview', sub: 'Exactly as visitors see it, with the Ad label and close control',
        actions: seg(['Light', 'Dark'], 0),
        body: adPreviews(),
      }) + card({
        title: 'Checks',
        body: checks([
          ['ok', 'Label: "Ad" shown on desktop and phone'],
          ['ok', 'Close control visible, 44 px on phone, reachable with the keyboard'],
          ['ok', 'Claims: "20% off" matches the Fall Home Sale discount'],
          ['warn', 'Availability: 2 Mosswood offers are out of stock', 'They are hidden from the campaign page. 212 offers remain.'],
          ['ok', 'Link: campaign page publishes Oct 16, 12:00 AM, same as ad start'],
          ['ok', 'Text contrast meets 4.5:1 on both images'],
        ]),
      });
    }
    return card({
      title: 'Reviewers', sub: 'Own promotions need Advertising and Content or Marketing approval',
      body: `<ul class="ab-approvals">
          <li><span class="n is-done">${icon('check', 'ic-sm')}</span>${cell('Jamie Brooks · Advertising', 'Placement, schedule and limits · approved Oct 8, 9:20 AM')}${status('Approved')}</li>
          <li><span class="n is-wait">2</span>${cell('Noor Aziz · Content', 'Creative, claims and links')}${status('In review')}</li>
        </ul>
        ${field('Note to reviewers', textarea('ac-note', 'Runs alongside the Fall Home Sale promotion. Same creative as the campaign page banner.'), { opt: true })}`,
    }) + card({
      title: 'After approval',
      body: `<div class="stack gap-2">
          ${optCard('ac-pub', 'ac-pub-1', '<span class="small strong">Schedule</span>', 'Goes live Oct 16, 2026, 12:00 AM PT and ends Oct 25, 11:59 PM PT', true)}
          ${optCard('ac-pub', 'ac-pub-2', '<span class="small strong">Activate as soon as approved</span>', 'Not available: the linked promotion starts Oct 16', false, { disabled: true })}
        </div>
        ${alert('info', 'You can pause at any time', 'Pause from Advertisements if details change. The ad leaves the site within 1 minute and can be resumed.')}`,
    });
  };

  register({
    id: 'admin/ad-campaign', title: 'Create ad campaign', ref: 'Plan ch. 16',
    notes: 'Five-step campaign setup: advertiser and goal, ad type with pages and audience, schedule with time zone, frequency, priority and delivery cap, creative with side-by-side desktop and phone preview showing the Ad label and close control, then approval by Advertising and Content before scheduling. Checkout, payment results, tracking and returns are always excluded.',
    states: AD_STEPS,
    render: (st) => {
      const i = Math.max(0, AD_STEPS.indexOf(st || AD_STEPS[0]));
      const next = AD_STEPS[i + 1], prev = AD_STEPS[i - 1];
      const summary = card({
        title: 'Campaign summary', sub: i === 4 ? 'Submitted Oct 8, 9:12 AM' : 'Draft · saved 9:41 AM',
        body: `${sumlist([
            ['Advertiser', 'Marketly · own promotion'], ['Goal', 'Platform event'], ['Linked promotion', 'Fall Home Sale'],
            ['Ad type', i >= 1 ? 'Opening full-screen' : '—'], ['Pages', i >= 1 ? 'Home, Home &amp; Kitchen' : '—'], ['Audience', i >= 1 ? 'Signed-in · Home &amp; Kitchen interest' : '—'],
            ['Period', i >= 2 ? 'Oct 16–25 PT' : '—'], ['Frequency', i >= 2 ? 'Once per session' : '—'], ['Priority', i >= 2 ? 'High (3)' : '—'],
            ['Creative', i >= 3 ? 'Desktop + phone' : '—'],
          ])}
          <div class="divider"></div>${checks([['info', 'Never covers checkout, payment results, tracking or returns'], ['info', 'One overlay at a time']])}`,
      });
      return adminLayout(`
        ${pageHead('Fall Home Sale opening ad', { crumbs: [{ label: 'Advertisements', href: go('admin/ads') }, 'New campaign'], sub: 'Opening full-screen · own promotion · owner Jamie Brooks', actions: status(i === 4 ? 'In review' : 'Draft') })}
        <div class="card pad">${steps(AD_STEPS.map(esc), i)}</div>
        <div class="ab-main">
          <div class="stack gap-4">
            ${adStepBody(i)}
            <div class="ab-wizard-foot">
              ${prev ? btn('Back', { v: 'ghost', icon: 'arrow-left', href: go('admin/ad-campaign', prev) }) : btn('Cancel', { v: 'ghost', href: go('admin/ads') })}
              <span class="row gap-2">${btn('Save draft', { v: 'secondary' })}${next ? btn('Continue to ' + esc(next.toLowerCase()), { iconR: 'arrow-right', href: go('admin/ad-campaign', next) }) : btn('Submit for approval', { icon: 'send' })}</span>
            </div>
          </div>
          <div class="stack gap-4 ab-sticky">${summary}</div>
        </div>
      `, 'ads');
    },
  });

  /* ======================================================================
     13. admin/ad-placements — Placements and rules
     ====================================================================== */
  const PLACEMENTS = [
    ['Opening full-screen', 'app-window', true, 'Launch', 'Home, category and campaign entry pages', 'Desktop 1600 × 900 · phone 1080 × 1920', '1 per session · max 3 per visitor per 7 days', 'Highest priority wins; equal priority rotates evenly', 'Closing hides that campaign for 7 days', 1],
    ['Home banner', 'rectangle-horizontal', true, 'Launch', 'Home, below the campaign banner', 'Desktop 1440 × 360 · phone 750 × 500', 'No cap (in-page)', 'Up to 3 rotate every 6 s by priority; rotation pauses on hover and focus', 'Not dismissible', 1],
    ['Category banner', 'rectangle-horizontal', true, 'Launch', 'Top of category pages', 'Desktop 1200 × 240 · phone 750 × 400', 'No cap (in-page)', 'Category match first, then priority', 'Not dismissible', 1],
    ['Promotional pop-up', 'message-square', true, 'Launch', 'Home, deals and campaign pages', 'Desktop 640 × 480 · phone 600 × 800', '1 per session · after 20 s or 50% scroll', 'Skipped in any session where an opening ad already showed', 'Closing hides that pop-up for 14 days', 0],
    ['Sponsored product', 'package', true, 'Pilot', 'Search results, category lists, related products', 'Product card with Sponsored label', 'Max 2 per results page, positions 3 and 8', 'Relevance to the search first, then bid priority', 'Not dismissible', 2],
    ['Sponsored store or brand', 'store', false, 'Later', 'Home and discovery pages', 'Desktop 1200 × 300 · phone 750 × 420', '—', 'Priority, then rotation', '—', 0],
    ['Floating panel', 'panel-bottom', false, 'Later', 'Selected desktop and phone pages', 'Strip, 72 px tall', '1 per session', 'One floating panel per page', 'Closing hides it for the session', 0],
    ['Interstitial', 'layers', false, 'Later', 'Between browsing steps, outside checkout', 'Desktop 1200 × 800 · phone 1080 × 1920', '1 per day', 'Priority', 'Closing hides that campaign for 7 days', 0],
  ];

  register({
    id: 'admin/ad-placements', title: 'Ad placements and rules', ref: 'Plan ch. 16',
    notes: 'Each placement with an on/off switch, eligible pages, formats, frequency cap, the rotation or priority rule when several ads qualify, and dismissal suppression. Global rules are always on: ads never cover checkout, payment results, tracking or returns, one overlay at a time, and every paid ad carries a label.',
    render: () => adminLayout(`
      ${pageHead('Placements and rules', { crumbs: [{ label: 'Advertisements', href: go('admin/ads') }, 'Placements and rules'], sub: 'Owner Jamie Brooks, Advertising Manager · changes take effect for new displays immediately and are recorded in Action history', actions: btn('Action history', { v: 'secondary', size: 'sm', icon: 'history', href: go('admin/audit') }) })}
      ${card({
        title: 'Global rules', sub: 'Apply to every placement and campaign. The Ad label rule is always on and cannot be turned off; changing the others needs Business Owner approval.',
        body: `<ul class="ab-rules">
          <li>${icon('shield-check')}<span class="stack gap-0"><span class="small strong">Never cover checkout, payment results, tracking or returns</span><span class="xs muted">Overlays and interstitials are blocked on these pages</span></span></li>
          <li>${icon('layers')}<span class="stack gap-0"><span class="small strong">One overlay at a time</span><span class="xs muted">Opening ad, pop-up and interstitial never stack</span></span></li>
          <li>${icon('tag')}<span class="stack gap-0 grow"><span class="small strong">Ad label required</span><span class="xs muted">"Ad" on overlays and banners, "Sponsored" on product and store cards. Locked on for every placement and campaign.</span></span><label class="switch" for="pl-rule-label" title="Always on"><input type="checkbox" role="switch" id="pl-rule-label" checked disabled aria-readonly="true"><span class="sr-only">Ad label required (always on)</span></label>${badge('Always on', '', 'lock')}</li>
          <li>${icon('x')}<span class="stack gap-0"><span class="small strong">Visible close control</span><span class="xs muted">At least 44 px on phones, reachable with the keyboard, returns to the intended page</span></span></li>
          <li>${icon('package-x')}<span class="stack gap-0"><span class="small strong">Remove unavailable or expired ads</span><span class="xs muted">Ads stop when the promoted offer sells out or the campaign ends</span></span></li>
          <li>${icon('user-round')}<span class="stack gap-0"><span class="small strong">Seller behind promoted offers is named</span><span class="xs muted">Seller ad content is reviewed before it runs</span></span></li>
        </ul>`,
      })}
      <div class="ab-place">
        ${PLACEMENTS.map(([n, ic, on, phase, pages, fmt, freq, rot, dis, live], k) => `<section class="card${on ? '' : ' is-off'}">
          <div class="card-head"><span class="row gap-2">${icon(ic)}<h3 class="h4">${n}</h3>${badge(phase, phase === 'Launch' ? 'brand' : phase === 'Pilot' ? 'info' : '')}</span>${toggle('pl-on-' + k, on ? 'Enabled' : 'Off', on)}</div>
          <div class="card-body">${kv([['Pages', pages], ['Formats', fmt], ['Frequency cap', freq], ['When several ads qualify', rot], ['Dismissal', dis]])}</div>
          <div class="card-foot"><span class="xs muted grow">${on ? `${live} live campaign${live === 1 ? '' : 's'}` : phase === 'Later' ? 'Turn on when approval and billing are ready' : 'Off'}</span>${btn('Edit rules', { v: 'ghost', size: 'sm', icon: 'pencil' })}</div>
        </section>`).join('')}
        <section class="card is-off">
          <div class="card-head"><span class="row gap-2">${icon('video')}<h3 class="h4">Video</h3>${badge('Later', '')}</span>${toggle('pl-on-video', 'Not available', false)}</div>
          <div class="card-body"><p class="small sub">Playback and mute controls, designated campaign and display areas. Planned after launch.</p></div>
        </section>
      </div>
    `, 'ads'),
  });

  /* ======================================================================
     14. admin/ad-assets — Ad creative library
     ====================================================================== */
  U.css('admin-b-2', `
    .ab-tiles { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .ab-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @container app (min-width: 1280px) { .ab-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .ab-tile { border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; display: flex; flex-direction: column; background: var(--surface); }
    .ab-tile.is-sel { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
    .ab-tile .pv { position: relative; background: var(--surface-2); display: flex; align-items: center; justify-content: center; padding: var(--sp-3); height: 132px; }
    .ab-tile .pv .imgph { height: 100%; width: auto; }
    .ab-tile .pv .imgph.wide { aspect-ratio: 16 / 9; }
    .ab-tile .pv .imgph.tall { aspect-ratio: 9 / 16; }
    .ab-tile .pv .imgph.band { aspect-ratio: 4 / 1; height: auto; width: 100%; }
    .ab-tile .pv .txt { font-family: var(--font-display); font-weight: 700; font-size: var(--fs-md); text-align: center; color: var(--text); padding: var(--sp-3); }
    .ab-tile .bd { padding: var(--sp-3); display: flex; flex-direction: column; gap: 6px; flex: 1; }
    .ab-tile .note { font-size: var(--fs-xs); color: var(--text-2); background: var(--surface-2); border-radius: var(--r-sm); padding: 6px 8px; }
    .ab-dpair { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); align-items: start; }
    .ab-sm .ab-ad .copy { padding: 6px 8px 8px; gap: 3px; }
    .ab-sm .ab-ad .copy b { font-size: 10px; }
    .ab-sm .ab-ad .copy span { font-size: 8px; }
    .ab-sm .ab-ad .cta { font-size: 8px; padding: 3px 6px; }
    .ab-sm .ab-ad .art { padding: 6px; gap: 4px; }
    .ab-sm .ab-adx { width: 20px; height: 20px; }
    .ab-sm .ab-mframe { border-width: 4px; border-radius: 18px; }
    .ab-ntc { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: var(--sp-2) var(--sp-3); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); align-items: start; }
    .ab-ntc:last-child { border-bottom: 0; }
    .ab-ntc.is-unread { box-shadow: inset 3px 0 0 var(--brand); background: var(--surface-2); }
    .ab-ntc .ic { width: 36px; height: 36px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--surface-3); color: var(--text-2); }
    .ab-ntc .ic.t-danger { background: var(--danger-soft); color: var(--danger); }
    .ab-ntc .ic.t-warning { background: var(--warning-soft); color: var(--warning); }
    .ab-ntc .ic.t-info { background: var(--info-soft); color: var(--info); }
    .ab-ntc .ic.t-brand { background: var(--brand-soft); color: var(--brand-text); }
    .ab-ntc .meta { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); align-items: center; font-size: var(--fs-xs); color: var(--text-3); }
    .ab-ntc .acts { grid-column: 2; display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    @container app (min-width: 768px) { .ab-ntc { grid-template-columns: 36px minmax(0, 1fr) auto; } .ab-ntc .acts { grid-column: 3; grid-row: 1; justify-content: flex-end; } }
    .ab-day { padding: var(--sp-2) var(--sp-4); font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-3); background: var(--surface-2); border-bottom: 1px solid var(--border); }
  `);

  // [file/name, kind ('wide'|'tall'|'band'|'square'|'text'|'video'), format, size, status, link check [tone, text], note]
  const CREATIVE_GROUPS = [
    { name: 'Fall Home Sale opening ad', adv: 'Marketly', paid: false, used: 'Fall Home Sale opening ad · In review', items: [
      ['fall-home-desktop.jpg', 'wide', 'Opening full-screen · desktop', '1600 × 900 · 412 KB', 'In review', ['ok', 'Campaign page publishes Oct 16, 12:00 AM'], 'Advertising approved placement. Waiting on Content.', true],
      ['fall-home-mobile.jpg', 'tall', 'Opening full-screen · phone', '1080 × 1920 · 538 KB', 'In review', ['ok', 'Campaign page publishes Oct 16, 12:00 AM'], null],
      ['Ad text', 'text', 'Headline, text, button', '44 / 60 characters', 'In review', ['warn', '2 linked offers out of stock, hidden'], null],
    ] },
    { name: 'Kestrel 27" monitor sponsored product', adv: 'Pixel &amp; Port', paid: true, used: 'Kestrel 27" monitor sponsored product · In review', items: [
      ['kestrel27-card.png', 'square', 'Sponsored product card', '1000 × 1000 · 220 KB', 'Changes requested', ['ok', 'Product page works · 18 in stock'], 'Noor Aziz: "Best 4K monitor of 2026" is not supported. Remove the claim or cite a source.'],
      ['Ad text', 'text', 'Card title and seller line', '38 / 50 characters', 'Changes requested', ['ok', 'Seller named: Pixel &amp; Port'], 'Same claim appears in the title.'],
    ] },
    { name: 'Halden Aurora banner', adv: 'Halden (brand)', paid: true, used: 'Halden Aurora banner · Live', items: [
      ['aurora-banner-desktop.jpg', 'band', 'Home banner · desktop', '1440 × 360 · 301 KB', 'Approved', ['ok', 'Product page works · 142 in stock'], 'Approved Sep 29 by Jamie Brooks and Noor Aziz.'],
      ['aurora-banner-phone.jpg', 'wide', 'Home banner · phone', '750 × 500 · 188 KB', 'Approved', ['ok', 'Product page works'], null],
    ] },
    { name: 'Trailhead Ridge store feature', adv: 'Trailhead Outfitters', paid: true, used: 'Trailhead Ridge store feature · Paused', items: [
      ['ridge-store-feature.jpg', 'band', 'Sponsored store · desktop and phone', '1200 × 300 · 264 KB', 'Approved', ['warn', 'Featured backpack has 6 left. Campaign paused below 10.'], null],
    ] },
    { name: 'Gadget Grove robot vacuum banner', adv: 'Gadget Grove', paid: true, used: 'Not used', items: [
      ['s2-vacuum-banner.jpg', 'band', 'Category banner · desktop', '1200 × 240 · 245 KB', 'Rejected', ['fail', 'Promoted offer suspended (TR-3391)'], 'Rejected Oct 6: seller restricted and the offer is under counterfeit review. Seller can appeal.'],
    ] },
    { name: 'Home Week brand video', adv: 'Marketly', paid: false, used: 'Not used · video ads come later', items: [
      ['home-week-15s.mp4', 'video', 'Video · 15 s, captions included', '1920 × 1080 · 8.4 MB', 'Draft', ['info', 'Stored for later. No video placement is on.'], null],
    ] },
  ];
  const tilePreview = (kind) => {
    if (kind === 'text') return `<div class="pv"><span class="txt">Fall Home Sale: 20% off bedding and lighting</span></div>`;
    if (kind === 'video') return `<div class="pv">${img('video', 'var(--img-4)', 'wide')}</div>`;
    return `<div class="pv"><span class="ab-adtag">${kind === 'square' ? 'Sponsored' : 'Ad'}</span>${img('image', kind === 'band' ? 'var(--img-2)' : 'var(--img-1)', kind === 'square' ? '' : kind)}</div>`;
  };
  const linkLine = ([t, txt]) => `<span class="xs row nowrap gap-1 ${t === 'ok' ? 't-success-text' : t === 'warn' ? 't-warning-text' : t === 'fail' ? 't-danger-text' : 'muted'}" style="--gap:4px">${icon(CHK[t], 'ic-sm')}<span style="white-space:normal">${txt}</span></span>`;

  register({
    id: 'admin/ad-assets', title: 'Ad creative library', ref: 'Plan ch. 16',
    notes: 'Creative assets grouped by campaign: desktop and phone images, ad text and optional video, with sizes, advertiser, review status, where each is used, the destination link check and review notes. Reviewing a creative shows desktop and phone previews with the required Ad or Sponsored label and close control, the automatic checks and both reviewers\' notes.',
    states: ['Library', 'Review creative'],
    render: (st) => {
      const rev = st === 'Review creative';
      const groups = CREATIVE_GROUPS.map((g) => card({
        title: g.name, sub: `${g.adv} · used in: ${g.used}`,
        actions: g.paid ? badge('Paid', 'info') : badge('Own', 'brand'),
        body: `<div class="ab-tiles">${g.items.map(([f, kind, fmt, size, s, link, note, first]) => `<article class="ab-tile${rev && first ? ' is-sel' : ''}">
            ${tilePreview(kind)}
            <div class="bd">
              <div class="row between" style="--gap:6px"><span class="small strong truncate">${f}</span>${status(s)}</div>
              <span class="xs muted">${fmt}</span><span class="xs num">${size}</span>
              ${linkLine(link)}
              ${note ? `<span class="note">${note}</span>` : ''}
              <span class="row gap-2" style="margin-top:auto">${s === 'In review' || s === 'Changes requested' ? btn('Review', { v: 'secondary', size: 'sm', href: go('admin/ad-assets', 'Review creative') }) : btn('View', { v: 'ghost', size: 'sm' })}${btn('', { v: 'ghost', size: 'sm', icon: 'download', label: 'Download ' + f })}</span>
            </div>
          </article>`).join('')}</div>`,
      })).join('');

      const page = adminLayout(`
        ${pageHead('Ad creative library', { crumbs: [{ label: 'Advertisements', href: go('admin/ads') }, 'Creative library'], sub: 'Images, ad text, video and destination links for every campaign · reviewed by Advertising and Content', actions: btn('Upload creative', { size: 'sm', icon: 'upload' }) })}
        ${tabs([{ label: 'All', count: 10 }, { label: 'In review', count: 3 }, { label: 'Changes requested', count: 2 }, { label: 'Approved', count: 3 }, { label: 'Rejected', count: 1 }], 0)}
        ${toolbar(`${searchIn('Search file name, campaign or advertiser', 'aa-q')}${select('aa-adv', ['Own and seller', 'Own promotions', 'Seller paid', 'Brand'], 'Own and seller')}${select('aa-fmt', ['All formats', 'Opening full-screen', 'Banner', 'Pop-up', 'Sponsored product', 'Sponsored store', 'Ad text', 'Video'], 'All formats')}${select('aa-link', ['Any link check', 'Link works', 'Needs attention', 'Broken'], 'Any link check')}${seg([{ label: 'Grid', icon: 'layout-grid' }, { label: 'List', icon: 'list' }], 0)}`)}
        ${example('Required sizes: opening ad 1600 × 900 desktop and 1080 × 1920 phone; banners 1440 × 360 and 750 × 500; JPG or PNG up to 1 MB. Video is stored but not shown until video placements are turned on.')}
        <div class="stack gap-4">${groups}</div>
      `, 'ad-assets');
      if (!rev) return page;
      return page + drawer({
        title: 'Review creative: Fall Home Sale opening ad',
        body: `${kv([['Advertiser', 'Marketly · own promotion'], ['Files', 'fall-home-desktop.jpg · fall-home-mobile.jpg · ad text'], ['Destination', 'marketly.com/campaign/fall-home-sale'], ['Campaign', `<a href="${go('admin/ad-campaign', 'Approval')}">Fall Home Sale opening ad</a> · Oct 16–25`]])}
          <div class="ab-dpair ab-sm">
            <div class="stack gap-1"><span class="xs strong sub">${icon('monitor', 'ic-sm')} Desktop</span><div class="ab-dframe"><div class="ab-dbar"><i></i><i></i><i></i></div><div class="ab-screen desk">${skeleton(4)}<div class="ab-scrim">${adCreative(true)}</div></div></div></div>
            <div class="stack gap-1"><span class="xs strong sub">${icon('smartphone', 'ic-sm')} Phone</span><div class="ab-mframe"><div class="ab-screen mob">${skeleton(6)}<div class="ab-scrim">${adCreative(false)}</div></div></div></div>
          </div>
          <div class="panel stack gap-1"><span class="small strong">Fall Home Sale: 20% off bedding and lighting</span><span class="xs sub">Oct 16–25 · Casa Verde Home, Mosswood and the Official Store · button "Shop the sale"</span></div>
          <span class="h4">Checks</span>
          ${checks([
            ['ok', 'Claims: "20% off" matches the Fall Home Sale discount'],
            ['ok', 'Link works: campaign page loads in preview and publishes at ad start'],
            ['warn', 'Products available: 212 of 214 offers in stock', '2 Mosswood offers are hidden from the campaign page'],
            ['ok', 'Label present: "Ad" on desktop and phone'],
            ['ok', 'Close control visible, 44 px on phone, keyboard reachable'],
          ])}
          <span class="h4">Reviewer notes</span>
          <div class="ab-conv">
            <div class="ab-msg is-staff"><span class="who"><b>Jamie Brooks</b>${badge('Advertising', 'brand')}<span>Oct 8, 9:20 AM · approved</span></span><p>Placement, sizes and frequency are fine. Overlap with Home Week is handled by priority.</p></div>
            <div class="ab-msg is-note"><span class="who"><b>Noor Aziz</b>${badge('Content', 'warning')}<span>Your review</span></span><p>Copy matches the campaign page. Checking the phone crop on the lamp image.</p></div>
          </div>
          <fieldset class="stack gap-2" style="border:0;padding:0;margin:0"><legend class="label">Decision</legend>
            ${optCard('aa-dec', 'aa-dec-1', '<span class="small strong">Approve</span>', 'Campaign can be scheduled once all reviewers approve', true)}
            ${optCard('aa-dec', 'aa-dec-2', '<span class="small strong">Request changes</span>', 'Sent to the campaign owner with your reason', false)}
          </fieldset>
          ${field('Reason or note', select('aa-reason', ['No changes needed', 'Unsupported claim', 'Broken or wrong link', 'Promoted product unavailable', 'Label missing or hidden', 'Image quality or crop'], 'No changes needed'))}
          ${field('Comment for the owner', textarea('aa-note', 'Phone crop checked. Approved.'), { opt: true })}`,
        foot: `${btn('Request changes', { v: 'secondary', size: 'sm' })}${btn('Approve creative', { size: 'sm', icon: 'check' })}`,
      });
    },
  });

  /* ======================================================================
     15. admin/inbox — Staff notifications
     ====================================================================== */
  // [id, tone, icon, area, title, body, routed, deadline [text, tone], link [label, screen, state], mine, unread, day]
  const NOTICES = [
    ['n1', 'warning', 'file-check', 'Sellers', '3 seller applications are past the 2-day review target', 'Oldest: Lumen &amp; Loom Ceramics, waiting 3 days for a decision.', 'Seller Manager · Riley Chen (backup, Grace Kim away Oct 8–9)', ['Today 5:00 PM', 'warning'], ['Open applications', 'admin/seller-application'], true, true, 'Today'],
    ['n2', 'info', 'user-cog', 'Staff and roles', 'Access request: Owen Price needs the payout second-reviewer role', 'Requested by Priya Nair for the Oct 9 run. Access does not set financial limits; Business Owner Morgan Hale sets those.', 'Platform Administrator · Riley Chen', ['Oct 9, 9:00 AM', 'warning'], ['Review request', 'admin/staff'], true, true, 'Today'],
    ['n3', 'danger', 'life-buoy', 'Customer service', 'CS-104921 lost package is high priority and unassigned for over 1 hour', 'Escalation route: unassigned high-priority cases go to the on-duty administrator after 1 hour.', 'Customer Support Manager · Isabel Cruz → on-duty admin Riley Chen', ['Overdue 1 h', 'danger'], ['Open cases', 'admin/cases'], true, true, 'Today'],
    ['n4', 'danger', 'truck', 'Shipping', '9 items are past their dispatch deadline', '4 seller orders and 5 Official Store items. Oldest: Casa Verde Home, 16 days.', 'Shipping Manager · Theo Grant (lead)', ['Overdue', 'danger'], ['Open dispatch queue', 'ops/dispatch'], false, true, 'Today'],
    ['n5', 'warning', 'boxes', 'Inventory', '12 Official Store SKUs are below reorder point', '2 will run out tomorrow at current sales: BRL-LAMP-W and KST-27UHD.', 'Inventory Manager · Ana Silva (lead)', ['Today 3:00 PM', 'warning'], ['Open stock', 'ops/inventory'], false, true, 'Today'],
    ['n6', 'warning', 'wallet', 'Finance', 'Payout run of $78,420.55 needs a second Finance reviewer', 'First approval by Priya Nair at 8:52 AM. Release is Fri, Oct 9, 10:00 AM PT.', 'Finance Manager · Priya Nair (lead), Owen Price', ['Oct 9, 9:30 AM', 'warning'], ['Open payout run', 'admin/payouts'], false, false, 'Today'],
    ['n7', 'danger', 'circle-alert', 'Finance', '2 payouts from the Oct 2 run failed', 'Rowan Leather Co. account closed. Moss &amp; Mill name mismatch, corrected by seller.', 'Finance Manager · Priya Nair (lead)', ['Before Oct 9 run', 'ok'], ['Open payouts', 'admin/payouts'], false, false, 'Today'],
    ['n8', 'danger', 'scale', 'Finance', 'Unusual financial activity: settlement for Oct 7 is $12.40 short', 'Also flagged: 6 new-account orders to one Reno address (TR-3402).', 'Finance Manager · Priya Nair · Trust and Risk · Sven Larsen', ['Today 12:00 PM', 'warning'], ['Open finance checks', 'ops/finance-checks'], false, false, 'Today'],
    ['n9', 'danger', 'arrow-up-right', 'Customer service', 'CS-104915 escalated: damaged item return disputed by seller', 'Customer has waited 4 hours past the response target.', 'Returns Manager · Lena Park (lead)', ['Overdue 4 h', 'danger'], ['Open case', 'admin/cases'], false, false, 'Today'],
    ['n10', 'info', 'megaphone', 'Advertisements', 'Fall Home Sale opening ad is waiting for Content approval', 'Advertising approved. Start date Oct 16.', 'Content Manager · Noor Aziz (lead)', ['Oct 12', 'ok'], ['Open campaign', 'admin/ad-campaign', 'Approval'], false, false, 'Earlier'],
    ['n11', 'danger', 'shield-alert', 'Trust and risk', 'Counterfeit report TR-3391 escalated, seller restricted', 'Gadget Grove listings in Home &amp; Kitchen stopped. Open orders and returns continue.', 'Trust and Risk Manager · Sven Larsen (lead)', ['Appeal by Oct 14', 'ok'], ['Open report', 'admin/trust'], false, false, 'Earlier'],
    ['n12', 'warning', 'boxes', 'Inventory', 'Receiving discrepancy on PUR-260930-0112: 24 units short', 'Supplier Halden Audio Supply. Stock was not added for missing units.', 'Purchasing Manager · Ken Watanabe (lead)', ['Resolved Oct 7', 'ok'], ['Open stock', 'ops/inventory'], false, false, 'Earlier'],
  ];
  const notice = ([, tone, ic, area, title, body, routed, dl, link, mine, unread]) => `<article class="ab-ntc${unread ? ' is-unread' : ''}">
      <span class="ic t-${tone}">${icon(ic, 'ic-sm')}</span>
      <div class="stack gap-1">
        <span class="row gap-2">${badge(area, 'outline')}${mine ? badge('Needs my action', 'brand') : ''}${unread ? '<span class="sr-only">Unread.</span>' : ''}</span>
        <span class="small strong">${title}</span>
        <span class="xs sub">${body}</span>
        <span class="meta"><span>${icon('route', 'ic-sm')} Routed to ${routed}</span>${deadline(dl[0], dl[1])}</span>
      </div>
      <div class="acts">${btn(link[0], { v: mine ? 'primary' : 'secondary', size: 'sm', href: go(link[1], link[2]) })}${iconBtn('check', 'Mark as read')}</div>
    </article>`;

  register({
    id: 'admin/inbox', title: 'Notifications', ref: 'Plan ch. 19, 2',
    notes: 'Staff notices inside the workspace for overdue shipping, stock shortages, waiting approvals, escalated cases, failed payouts and unusual financial activity. Each notice names the role it is routed to, its deadline and the queue to open; notices route by role, so a backup receives them while the lead is away.',
    states: ['All', 'Needs my action'],
    render: (st) => {
      const mineOnly = st === 'Needs my action';
      const list = mineOnly ? NOTICES.filter((n) => n[9]) : NOTICES;
      const groups = ['Today', 'Earlier'].map((d) => { const items = list.filter((n) => n[11] === d); return items.length ? `<div class="ab-day">${d === 'Today' ? 'Today · Thu, Oct 8' : 'Earlier this week'}</div>${items.map(notice).join('')}` : ''; }).join('');
      return adminLayout(`
        ${pageHead('Notifications', { sub: 'Riley Chen · Platform Administrator · backup Seller Manager on Oct 8–9', actions: btn('Mark all as read', { v: 'ghost', size: 'sm', icon: 'check-check' }) + btn('Notification settings', { v: 'secondary', size: 'sm', icon: 'settings', href: go('admin/notifications') }) })}
        <div class="ab-main">
          <div class="stack gap-3">
            ${tabs([{ label: 'All', count: NOTICES.length, href: go('admin/inbox', 'All') }, { label: 'Needs my action', count: NOTICES.filter((n) => n[9]).length, href: go('admin/inbox', 'Needs my action') }, { label: 'Mentions', count: 2 }], mineOnly ? 1 : 0)}
            ${toolbar(`${select('in-area', ['All areas', 'Shipping', 'Inventory', 'Finance', 'Customer service', 'Sellers', 'Advertisements', 'Trust and risk', 'Staff and roles'], 'All areas')}${check('in-unread', 'Unread only', false)}`)}
            ${mineOnly ? alert('brand', '3 notices need you today', 'Two come from your own role. One reaches you as backup Seller Manager while Grace Kim is away.') : ''}
            <section class="card" aria-label="Notices">${groups}</section>
            ${example('Shown here in the workspace and sent by email according to each person\'s settings. SMS and push come later.')}
          </div>
          <div class="stack gap-4">
            ${card({
              title: 'Routing today', sub: 'Notices go to roles, not people',
              flush: true,
              body: table(['Role', 'Receives now', 'Lead'], [
                ['Seller Manager', person('Riley Chen', 'Backup until Oct 9'), '<span class="xs t-warning-text strong">Grace Kim · away</span>'],
                ['Shipping Manager', person('Theo Grant'), 'Theo Grant'],
                ['Inventory Manager', person('Ana Silva'), 'Ana Silva'],
                ['Finance Manager', person('Priya Nair'), 'Priya Nair'],
                ['Customer Support', person('Isabel Cruz'), 'Isabel Cruz'],
              ]),
              foot: `<span class="ab-note grow">When a lead is away, the backup gets the same notices and deadlines. The lead sees them on return.</span>${btn('Edit backups', { v: 'ghost', size: 'sm', href: go('admin/staff') })}`,
            })}
            ${card({
              title: 'Mentions', sub: '2 unread',
              flush: true,
              body: `<ul class="list pad">
                <li><span class="grow stack gap-0"><span class="small"><b>Isabel Cruz</b> in <a href="${go('admin/case', 'Investigating')}">CS-104882</a></span><span class="xs muted">"Riley, can you confirm the appeal deadline text in the decision notice?" · 9:12 AM</span></span></li>
                <li><span class="grow stack gap-0"><span class="small"><b>Priya Nair</b> in <a href="${go('admin/payouts')}">PO-RUN-261009</a></span><span class="xs muted">"Owen needs the second-reviewer role before 9:30 AM tomorrow." · 8:55 AM</span></span></li>
              </ul>`,
            })}
          </div>
        </div>
      `, 'inbox');
    },
  });
})();
