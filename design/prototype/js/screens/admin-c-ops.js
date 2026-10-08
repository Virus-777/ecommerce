/* Admin Center · Reports and settings  +  Operations Center · Work queues
   Plan ch. 2, 9, 12, 13, 14, 18, 19 */
(function () {
  const U = UI;
  const D = window.D;
  const { register, adminLayout, opsLayout, pageHead, card, stat, table, status, badge, btn, go, icon, money, num, avatar,
    alert, field, input, select, textarea, check, toggle, tabs, seg, chips, deadline, meter, kv, steps, timeline, modal,
    legend, lineChart, img, pimg, searchIn, queueTile, optCard, sumRow } = U;

  U.css('admin-c-ops', `
    .ac-av { width: 28px; height: 28px; font-size: var(--fs-2xs); }
    .ac-who { display: inline-flex; align-items: center; gap: var(--sp-2); min-width: 0; }
    .ac-ba { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: var(--fs-xs); }
    .ac-ba .b { color: var(--text-3); }
    .ac-ba .a { color: var(--text); font-weight: 600; }
    .ac-ba svg.lucide { width: 14px; height: 14px; color: var(--text-3); }
    .ac-kpis { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 1024px) { .ac-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .ac-main { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1180px) { .ac-main { grid-template-columns: minmax(0, 1fr) 340px; } }
    .ac-lib { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1024px) { .ac-lib { grid-template-columns: 272px minmax(0, 1fr); } }
    .ac-libgrp { padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; }
    .ac-libgrp:last-child { border-bottom: 0; }
    .ac-rl { display: flex; align-items: center; gap: var(--sp-2); min-height: 34px; padding: 0 var(--sp-2); border-radius: var(--r-sm); font-size: var(--fs-sm); color: var(--text-2) !important; text-decoration: none !important; }
    .ac-rl:hover { background: var(--surface-2); }
    .ac-rl.is-active { background: var(--brand-soft); color: var(--brand-text) !important; font-weight: 600; }
    .ac-filters { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .ac-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @container app (min-width: 1280px) { .ac-filters { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
    .ac-defs { display: flex; flex-direction: column; gap: var(--sp-1); }
    .ac-defs dt { font-weight: 700; font-size: var(--fs-sm); color: var(--text); }
    .ac-defs dd { font-size: var(--fs-sm); color: var(--text-2); margin: 0 0 var(--sp-3); }
    .ac-mlist { display: flex; flex-direction: column; }
    .ac-mi { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); min-width: 0; }
    .ac-mi:last-child { border-bottom: 0; }
    .ac-mi.is-flagged { box-shadow: inset 3px 0 0 var(--danger); }
    .ac-mi.is-warn { box-shadow: inset 3px 0 0 var(--warning); }
    .ac-perm { display: grid; gap: var(--sp-2) var(--sp-4); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .ac-perm { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .ac-limit { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); padding-block: var(--sp-3); border-bottom: 1px solid var(--border); }
    .ac-limit:last-child { border-bottom: 0; padding-bottom: 0; }
    .ac-limit:first-child { padding-top: 0; }
    @container app (min-width: 768px) { .ac-limit { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: end; } .ac-limit > .ac-limit-t { grid-column: 1 / -1; } }
    .ac-set { display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1024px) { .ac-set { grid-template-columns: 200px minmax(0, 1fr); } }
    .ac-setnav { position: sticky; top: calc(var(--header-h) + var(--sp-4)); display: flex; flex-direction: column; gap: 2px; }
    .ac-setnav a { display: flex; align-items: center; gap: var(--sp-2); min-height: 36px; padding: 0 var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-sm); font-weight: 500; color: var(--text-2) !important; text-decoration: none !important; }
    .ac-setnav a:hover { background: var(--surface-2); }
    .ac-setnav a.is-active { background: var(--brand-soft); color: var(--brand-text) !important; font-weight: 700; }
    .ac-fgrid { display: grid; gap: var(--sp-4); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .ac-fgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .ac-fgrid .full { grid-column: 1 / -1; }
    .ac-meta { display: flex; gap: var(--sp-2) var(--sp-4); flex-wrap: wrap; font-size: var(--fs-xs); color: var(--text-3); }
    .ac-meta span { display: inline-flex; align-items: center; gap: 4px; }
    .ac-matrix .table td.c, .ac-matrix .table th.c { text-align: center; }
    .ac-matrix .table td { padding-block: var(--sp-2); }
    .ac-email { background: var(--surface-2); border-radius: var(--r-lg); padding: var(--sp-4); }
    .ac-mail { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); max-width: 540px; margin-inline: auto; overflow: hidden; }
    .ac-mail-top { padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .ac-mail-top .logo { font-size: 17px; }
    .ac-mail-top .logo svg { width: 24px; height: 24px; }
    .ac-mail-body { padding: var(--sp-5) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); font-size: var(--fs-sm); }
    .ac-mail-foot { padding: var(--sp-3) var(--sp-4); background: var(--surface-2); font-size: var(--fs-2xs); color: var(--text-3); line-height: 1.5; }
    .ac-var { font-family: var(--font-mono); font-size: var(--fs-2xs); background: var(--info-soft); color: var(--info); border-radius: var(--r-xs); padding: 1px 5px; white-space: nowrap; }
    .ac-varbtn { border: 1px solid var(--border-strong); background: var(--surface); border-radius: var(--r-pill); padding: 4px 10px; font-family: var(--font-mono); font-size: var(--fs-2xs); color: var(--text-2); cursor: pointer; }
    .ac-varbtn:hover { border-color: var(--brand); color: var(--brand-text); }
    .ac-ck { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-3) 0; border-bottom: 1px solid var(--border); }
    .ac-ck:last-child { border-bottom: 0; padding-bottom: 0; }
    .ac-ck:first-child { padding-top: 0; }
    .ac-ck .ic { width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: none; border: 1.5px solid var(--border-strong); color: var(--text-3); }
    .ac-ck .ic svg.lucide { width: 14px; height: 14px; stroke-width: 2.5; }
    .ac-ck.is-done .ic { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
    .ac-ck.is-late .ic { border-color: var(--danger); color: var(--danger); }
    .ac-ck.is-now .ic { border-color: var(--brand); color: var(--brand-text); box-shadow: 0 0 0 3px var(--brand-soft); }
    .ac-groups { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 768px) { .ac-groups { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @container app (min-width: 1180px) { .ac-groups { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
    .ac-grp { padding: var(--sp-3) var(--sp-4); border-radius: var(--r-lg); background: var(--surface); border: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; box-shadow: inset 0 3px 0 var(--tone, var(--border-strong)); min-width: 0; }
    .ac-grp .v { font-size: var(--fs-2xl); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }
    .ac-low { color: var(--warning); font-weight: 700; }
    .ac-out { color: var(--danger); font-weight: 700; }
    .ac-bin { font-family: var(--font-mono); font-weight: 700; font-size: var(--fs-lg); background: var(--text); color: var(--text-inverse); border-radius: var(--r-sm); padding: var(--sp-1) var(--sp-2); min-width: 84px; text-align: center; flex: none; letter-spacing: 0.02em; }
    .ac-pick { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) 0; border-bottom: 1px solid var(--border); min-width: 0; }
    .ac-pick:last-child { border-bottom: 0; }
    .ac-pick.is-done .ac-bin { background: var(--surface-3); color: var(--text-3); }
    .ac-pick.is-short .ac-bin { background: var(--warning-soft); color: var(--warning); }
    .ac-pick .q { font-size: var(--fs-xl); font-weight: 700; font-variant-numeric: tabular-nums; min-width: 40px; text-align: right; }
    .ac-scan { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border: 2px dashed var(--brand); border-radius: var(--r-lg); background: var(--brand-soft); color: var(--brand-text); }
    .ac-scan input { flex: 1; min-width: 0; border: 0; background: transparent; font-family: var(--font-mono); font-size: var(--fs-lg); color: var(--text); min-height: 40px; }
    .ac-scan input:focus { outline: none; }
    .ac-scan:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }
    .ac-hand .btn { min-height: 52px; }
    .ac-handbar { position: sticky; bottom: 0; z-index: 10; background: var(--surface); border-top: 1px solid var(--border); padding: var(--sp-3) var(--sp-4); margin-inline: calc(-1 * var(--sp-4)); display: flex; gap: var(--sp-2); }
    .ac-handbar .btn { flex: 1; min-height: 52px; }
    .ac-photos { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); }
    @container app (min-width: 768px) { .ac-photos { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .ac-photo { display: flex; flex-direction: column; gap: 4px; }
    .ac-photo .imgph { aspect-ratio: 4 / 3; }
    .ac-qty { width: 84px; min-height: 36px; text-align: right; font-variant-numeric: tabular-nums; padding: 0 var(--sp-2); }
    .ac-loc { width: 104px; min-height: 36px; font-family: var(--font-mono); font-size: var(--fs-sm); padding: 0 var(--sp-2); }
    .ac-slip { border: 1px dashed var(--border-strong); border-radius: var(--r-md); padding: var(--sp-4); background: var(--surface); font-size: var(--fs-sm); display: flex; flex-direction: column; gap: var(--sp-2); }
    .ac-total td { font-weight: 700; background: var(--surface-2); }
    .ac-acts { display: flex; gap: var(--sp-1); flex-wrap: wrap; }
    .ac-lines { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ac-line { border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--sp-4); display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); background: var(--surface); }
    .ac-line.is-warn { box-shadow: inset 3px 0 0 var(--warning); }
    .ac-line.is-flagged { box-shadow: inset 3px 0 0 var(--danger); }
    .ac-line-nums { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 768px) { .ac-line-nums { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .ac-diff-neg { color: var(--danger); font-weight: 700; }
    .ac-diff-pos { color: var(--warning); font-weight: 700; }
    .ac-big { font-size: var(--fs-2xl); font-weight: 700; font-variant-numeric: tabular-nums; }
    .ac-sect { scroll-margin-top: calc(var(--header-h) + var(--sp-4)); }
  `);

  /* ---------------- Local helpers ---------------- */
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const who = (name, role) => `<span class="ac-who">${avatar(name, 'ac-av')}<span class="stack gap-0" style="min-width:0"><span class="small strong nowrap">${name}</span>${role ? `<span class="xs muted nowrap">${role}</span>` : ''}</span></span>`;
  const ba = (b, a) => `<span class="ac-ba"><span class="b">${b}</span>${icon('arrow-right')}<span class="a">${a}</span></span>`;
  const ex = (t) => `<span class="xs muted row gap-1 nowrap" style="white-space:normal">${icon('info', 'ic-sm')}<span>${t || 'Example value. The final value is a business decision.'}</span></span>`;
  const ref = (t, href) => `<a class="mono nowrap" href="${href || 'javascript:void 0'}">${t}</a>`;
  const sellerTag = (id) => { const s = D.sellers[id]; return `<span class="stack gap-1" style="align-items:flex-start"><span class="small nowrap">${s.name}</span>${s.official ? badge('Official', 'brand', 'badge-check') : badge('Marketplace', 'outline')}</span>`; };
  const cbx = (label, checked, o = {}) => `<input type="checkbox" aria-label="${U.esc(label)}"${checked ? ' checked' : ''}${o.disabled ? ' disabled' : ''}>`;
  const ain = (id, value, label, cls, o = {}) => `<input class="input ${cls || ''}" id="${id}" type="${o.type || 'text'}" value="${U.esc(value)}" aria-label="${U.esc(label)}"${o.err ? ' aria-invalid="true" style="border-color:var(--danger)"' : ''}>`;
  // Phone card list paired with a .no-phone table
  const mlist = (items) => `<div class="ac-mlist only-phone">${items.map((it) => `<div class="ac-mi ${it.cls || ''}"><div class="row between gap-2 nowrap" style="align-items:flex-start"><span class="small strong" style="min-width:0">${it.title}</span>${it.right || ''}</div>${(it.lines || []).map((l) => `<div class="xs sub">${l}</div>`).join('')}${it.foot ? `<div class="row gap-2" style="margin-top:6px">${it.foot}</div>` : ''}</div>`).join('')}</div>`;
  const both = (tbl, items) => `<div class="no-phone">${tbl}</div>${mlist(items)}`;
  const ck = (state, title, sub, right) => `<li class="ac-ck ${state ? 'is-' + state : ''}"><span class="ic" aria-hidden="true">${state === 'done' ? icon('check') : state === 'late' ? icon('alarm-clock') : ''}</span><span class="stack gap-0 grow"><span class="small strong">${title}</span>${sub ? `<span class="xs muted">${sub}</span>` : ''}</span>${right || ''}<span class="sr-only">${state === 'done' ? 'Done' : state === 'late' ? 'Overdue' : 'Not done'}</span></li>`;

  /* ======================================================================
     ADMIN 1 · Reports
     ====================================================================== */
  const S = D.sales14;
  const cr = [1.6, 1.9, 1.4, 2.2, 1.7, 1.5, 1.8, 2.0, 1.6, 1.9, 2.3, 1.7, 1.5, 1.2];
  const rr = [2.1, 1.8, 2.4, 2.0, 2.2, 1.9, 2.6, 2.1, 1.7, 2.0, 2.5, 2.2, 1.4, 0.6];
  const rows14 = S.labels.map((l, i) => {
    const o = S.official[i] * 1000, m = S.sellers[i] * 1000, g = o + m, c = g * cr[i] / 100, r = g * rr[i] / 100;
    return { l, o, m, g, c, r, net: g - c - r, orders: Math.round(g / 71.2) };
  });
  const T = ['o', 'm', 'g', 'c', 'r', 'net', 'orders'].reduce((acc, k) => { acc[k] = sum(rows14.map((x) => x[k])); return acc; }, {});
  const feeIncome = T.m * 0.094;
  const kfmt = (v) => '$' + v.toFixed(0) + 'k';
  const kk = (v) => '$' + (v / 1000).toFixed(1) + 'k';

  const LIB = [
    { g: 'Commerce', owner: 'Mei Lin', role: 'Reports Analyst', ic: 'shopping-bag', items: ['Sales', 'Orders and average order value', 'Cancellations and refunds'] },
    { g: 'Company trading', owner: 'Dana Ortiz', role: 'Official Store Manager', ic: 'badge-check', items: ['Product sales and margin', 'Purchasing cost', 'Discounts and shipping expense', 'Returns cost'] },
    { g: 'Marketplace finance', owner: 'Priya Nair', role: 'Finance Manager', ic: 'landmark', items: ['Seller sales and earned fees', 'Discount funding', 'Amounts owed to sellers', 'Holds and completed payouts'] },
    { g: 'Products and discovery', owner: 'Omar Haddad', role: 'Catalog Manager', ic: 'package', items: ['Views, cart additions, purchases', 'Searches with no available result', 'Stockouts', 'Product return reasons'] },
    { g: 'Service and sellers', owner: 'Grace Kim', role: 'Seller Manager', ic: 'store', items: ['On-time dispatch', 'Delivery issues', 'Seller cancellations', 'Response time and case backlog', 'Complaint patterns'] },
    { g: 'Customers, marketing and ads', owner: 'Jamie Brooks', role: 'Marketing and Advertising', ic: 'megaphone', items: ['Returning buyers and repeat purchases', 'Campaign results', 'Ad displays, clicks, dismissals and spend'] },
  ];

  register({
    id: 'admin/reports', title: 'Reports', ref: 'Plan ch. 19, 18',
    notes: 'Report library grouped by business area, each with a named owner, and the open Commerce sales report. Shows the plan rules on report definitions: stated date basis, currency and time zone, gross vs net sales, and marketplace sales vs marketplace fee income.',
    render: () => adminLayout(`
      ${pageHead('Reports', { crumbs: ['Reports and settings', 'Reports'], sub: 'Definitions are maintained by Mei Lin, Reports Analyst. Exports follow your permissions.', actions: btn('Schedule email', { v: 'secondary', icon: 'calendar-clock', size: 'sm' }) + btn('Export CSV', { v: 'secondary', icon: 'download', size: 'sm' }) })}

      <div class="ac-lib">
        <section class="card" aria-label="Report library">
          <div class="card-head"><div class="stack gap-0"><h2 class="h4">Report library</h2><span class="xs muted">${sum(LIB.map((g) => g.items.length))} launch reports · 6 areas</span></div></div>
          ${LIB.map((grp, gi) => `<div class="ac-libgrp">
            <div class="row between gap-2 nowrap"><span class="row gap-2 nowrap small strong">${icon(grp.ic, 'ic-sm')}${grp.g}</span></div>
            <span class="xs muted" style="margin-bottom:4px">Owner: ${grp.owner}, ${grp.role}</span>
            ${grp.items.map((it, ii) => `<a class="ac-rl${gi === 0 && ii === 0 ? ' is-active' : ''}" href="${gi === 0 && ii === 0 ? U.go('admin/reports') : 'javascript:void 0'}"${gi === 0 && ii === 0 ? ' aria-current="page"' : ''}>${icon(gi === 0 && ii === 0 ? 'chart-line' : 'file-chart-column', 'ic-sm')}<span>${it}</span></a>`).join('')}
          </div>`).join('')}
        </section>

        <div class="stack gap-5">
          <section class="card">
            <div class="card-head">
              <div class="stack gap-1"><span class="eyebrow">Commerce · Owner Mei Lin</span><h2 class="h3">Commerce: sales</h2><span class="xs muted">Completed and gross sales, split between the Official Store and marketplace sellers</span></div>
              <div class="row gap-2">${btn('Save view', { v: 'ghost', size: 'sm', icon: 'bookmark' })}${btn('Export', { v: 'secondary', size: 'sm', icon: 'download' })}</div>
            </div>
            <div class="card-body" style="gap:var(--sp-4)">
              <div class="ac-filters">
                ${field('Date range', select('rp-range', ['Sep 25 – Oct 8, 2026 (14 days)', 'Today', 'Last 7 days', 'Last 30 days', 'Custom range'], 'Sep 25 – Oct 8, 2026 (14 days)'))}
                ${field('Date basis', select('rp-basis', ['Order placement date', 'Payment date', 'Shipment date', 'Completion date'], 'Order placement date'))}
                ${field('Sold by', select('rp-seller', ['Official Store and sellers', 'Official Store only', 'Marketplace sellers only'], 'Official Store and sellers'))}
                ${field('Currency', select('rp-cur', ['USD (US dollar)'], 'USD (US dollar)'), { hint: 'One currency at launch' })}
                ${field('Time zone', select('rp-tz', ['Pacific Time (PT)'], 'Pacific Time (PT)'), { hint: 'Days run 12:00 AM to 11:59 PM PT' })}
              </div>
              <div class="panel xs sub row gap-2">${icon('info', 'ic-sm')}<span>Showing orders <b>placed</b> Sep 25 – Oct 8, 2026, Pacific Time, in USD. Tax excluded. Figures through Oct 8, 9:40 AM PT; refunds for recent days can still change.</span></div>

              <div class="ac-kpis">
                <div class="panel">${stat('Gross sales', kk(T.g), { delta: '8.2%', dir: 'up', note: 'vs prior 14 days' })}</div>
                <div class="panel">${stat('Sales after cancellations and refunds', kk(T.net), { note: Math.round((T.net / T.g) * 1000) / 10 + '% of gross' })}</div>
                <div class="panel">${stat('Orders', num(T.orders), { delta: '5.6%', dir: 'up' })}</div>
                <div class="panel">${stat('Average order value', money(T.g / T.orders), { note: 'gross sales ÷ orders' })}</div>
              </div>

              <div class="stack gap-2">
                <div class="row between">${legend(['Official Store', 'Marketplace sellers'])}<span class="xs muted">Daily gross sales, USD</span></div>
                ${lineChart({ labels: S.labels, series: [{ name: 'Official Store', data: S.official }, { name: 'Marketplace sellers', data: S.sellers }], height: 240, fmt: kfmt, label: 'Daily gross sales, Official Store vs marketplace sellers, Sep 25 to Oct 8' })}
                <div class="row between xs sub"><span>Official Store ${kk(T.o)} · ${Math.round((T.o / T.g) * 100)}%</span><span>Marketplace sellers ${kk(T.m)} · ${100 - Math.round((T.o / T.g) * 100)}%</span></div>
                ${U.splitBar(Math.round((T.o / T.g) * 100), 100 - Math.round((T.o / T.g) * 100))}
              </div>
            </div>
            ${table(['Date (placed)', { label: 'Official Store', cls: 'r' }, { label: 'Marketplace sellers', cls: 'r' }, { label: 'Gross sales', cls: 'r' }, { label: 'Cancellations', cls: 'r' }, { label: 'Refunds', cls: 'r' }, { label: 'After cancellations and refunds', cls: 'r' }, { label: 'Orders', cls: 'r' }],
              rows14.slice().reverse().map((x) => [x.l + ', 2026', money(x.o), money(x.m), `<b>${money(x.g)}</b>`, '−' + money(x.c), '−' + money(x.r), money(x.net), num(x.orders)])
                .concat([['14-day total', money(T.o), money(T.m), money(T.g), '−' + money(T.c), '−' + money(T.r), money(T.net), num(T.orders)]]),
              { rowCls: rows14.map(() => '').concat(['ac-total']) })}
          </section>

          <section class="card">
            <div class="card-head"><div class="stack gap-0"><h2 class="h4">Definitions used in this report</h2><span class="xs muted">Maintained by Mei Lin, Reports Analyst · version 3, reviewed Oct 1, 2026</span></div>${btn('Suggest a change', { v: 'ghost', size: 'sm', icon: 'pencil' })}</div>
            <div class="card-body">
              <div class="grid lg2" style="--gap:var(--sp-5)">
                <dl class="ac-defs">
                  <dt>Gross sales</dt><dd>Item prices plus shipping charged to customers, after customer discounts, before cancellations and refunds. Tax is excluded. Includes Official Store and marketplace seller sales.</dd>
                  <dt>Sales after cancellations and refunds</dt><dd>Gross sales minus cancelled items and refunds sent, counted on the selected date basis. This is the figure to compare against targets.</dd>
                  <dt>Orders</dt><dd>Accepted checkouts. One checkout with items from three sellers counts as one order with three seller groups.</dd>
                  <dt>Date basis</dt><dd>Placement counts an order on the day it was placed. Payment, shipment and completion dates move the same order to a later day, so totals differ by basis.</dd>
                </dl>
                <div class="stack gap-3">
                  ${alert('info', 'Marketplace sales are not marketplace fee income', `Marketplace sellers sold ${money(T.m)} in this period. The company earned ${money(feeIncome)} in marketplace fees on those sales. Fee income appears in Marketplace finance reports, not here.`)}
                  <div class="well stack gap-2">
                    <span class="small strong">How the two figures relate</span>
                    ${sumRow('Marketplace sales (customer paid)', money(T.m))}
                    ${sumRow('Marketplace fee income (company)', money(feeIncome))}
                    ${sumRow('Seller earnings before adjustments', money(T.m - feeIncome))}
                    ${ex('Effective fee rate 9.4% for the period. Category rates are set in Settings.')}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    `, 'reports'),
  });

  /* ======================================================================
     ADMIN 2 · Staff and roles
     ====================================================================== */
  const BACKUP = ['Dana Ortiz', 'Mei Lin', 'Ken Watanabe', 'Dana Ortiz', 'Theo Grant', 'Theo Grant', 'Ana Silva', 'Ana Silva', 'Isabel Cruz', 'Noor Aziz', 'Sven Larsen', 'Lena Park', 'Morgan Hale', 'Dana Ortiz', 'Noor Aziz', 'Jamie Brooks', 'Grace Kim', 'Riley Chen'];
  const people = {};
  D.staffRoles.forEach((r) => r.people.forEach((p) => { (people[p] = people[p] || []).push(r.role); }));
  const LAST = { 'Morgan Hale': 'Today 9:41 AM', 'Riley Chen': 'Active now', 'Dana Ortiz': 'Today 8:55 AM', 'Ken Watanabe': 'Yesterday', 'Ana Silva': 'Active now', 'Theo Grant': 'Active now', 'Lena Park': 'Today 7:58 AM', 'Omar Haddad': 'Today 9:02 AM', 'Grace Kim': 'Today 8:47 AM', 'Isabel Cruz': 'Active now', 'Priya Nair': 'Active now', 'Jamie Brooks': 'Yesterday', 'Noor Aziz': 'Oct 6', 'Sven Larsen': 'Today 8:50 AM', 'Mei Lin': 'Today 9:15 AM' };
  const email = (n) => n.toLowerCase().replace(' ', '.') + '@marketly.example';

  const PERMS = [
    ['Finance', 'landmark', [['View payments, balances and statements', true], ['Approve refunds within limit', true], ['Place and release seller holds', true], ['Release payout runs', true], ['Record financial corrections with a reason', true], ['Change seller payout destinations', false]]],
    ['Orders and shipping', 'truck', [['View orders, seller groups and shipments', true], ['Cancel items', false], ['Open carrier claims', false]]],
    ['Returns and cases', 'undo-2', [['View return and dispute cases', true], ['Decide return eligibility', false], ['Approve refund without return', true]]],
    ['Sellers', 'store', [['View seller accounts and statements', true], ['Restrict or suspend sellers', false]]],
    ['Catalog and content', 'package', [['View products and offers', true], ['Publish, hide or suspend products', false]]],
    ['Reports', 'chart-column', [['View finance and commerce reports', true], ['Export reports', true]]],
    ['Settings and staff', 'settings', [['Change fee and payout settings', false], ['Manage staff accounts and roles', false]]],
  ];
  const LIMITS = [
    ['Payouts', 'Release payout runs', '50,000', 'per run', '25,000', 'Morgan Hale, Business Owner'],
    ['Refunds', 'Approve customer refunds and refund overrides', '2,000', 'per refund', '1,000', 'Morgan Hale, Business Owner'],
    ['Holds', 'Place or release seller balance holds', '10,000', 'per hold', '5,000', 'Morgan Hale, Business Owner'],
  ];

  function staffList() {
    const roleRows = D.staffRoles.map((r, i) => [
      `<span class="small strong">${r.role}</span>`,
      `<span class="small">${r.area}</span>`,
      r.people.map((p) => who(p)).join(' '),
      `<span class="small">${BACKUP[i]}</span>`,
      `<span class="small">${r.limit}</span>`,
      `<a class="small strong nowrap" href="${go('admin/staff', 'Edit role')}">Edit role</a>`,
    ]);
    const staffRows = Object.keys(people).map((p) => [
      `<span class="ac-who">${avatar(p, 'ac-av')}<span class="stack gap-0"><span class="small strong">${p}</span><span class="xs muted">${email(p)}</span></span></span>`,
      `<span class="row gap-1">${people[p].map((r) => badge(r, 'outline')).join('')}</span>`,
      `<span class="small">${LAST[p] || 'Yesterday'}</span>`,
      badge('2-step on', 'success', 'shield-check'),
      status('Active'),
    ]).concat([
      [`<span class="ac-who">${avatar('Carlos Mendez', 'ac-av')}<span class="stack gap-0"><span class="small strong">Carlos Mendez</span><span class="xs muted">carlos.mendez@marketly.example</span></span></span>`, badge('Warehouse worker', 'outline'), '<span class="small muted">Not signed in</span>', badge('Not set up'), status('Invited')],
      [`<span class="ac-who">${avatar('Hannah Wu', 'ac-av')}<span class="stack gap-0"><span class="small strong">Hannah Wu</span><span class="xs muted">hannah.wu@marketly.example</span></span></span>`, badge('Finance staff', 'outline'), '<span class="small muted">Not signed in</span>', badge('Not set up'), status('Invited')],
    ]);
    return adminLayout(`
      ${pageHead('Staff and roles', { crumbs: ['Reports and settings', 'Staff and roles'], sub: `${D.staffRoles.length} roles · ${Object.keys(people).length} active staff · 2 invitations`, actions: btn('Add role', { v: 'secondary', icon: 'plus', size: 'sm' }) + btn('Invite staff', { icon: 'user-plus', size: 'sm' }) })}
      ${alert('warning', 'Access is not financial authority', 'Assigning a role gives access to its screens. Approval limits for payouts, refunds, holds, restrictions and publication overrides are set by the Business Owner, Morgan Hale, and changes to them need her approval.')}
      <div class="ac-main">
        <div class="stack gap-5">
          ${card({
            title: 'Roles', sub: 'A role is a set of responsibilities, not a person. One person can hold several roles.', flush: true,
            actions: searchIn('Search roles', 'st-q'),
            body: both(table(['Role', 'Working area', 'People', 'Backup', 'Approval limit', ''], roleRows),
              D.staffRoles.map((r, i) => ({ title: r.role, right: `<a class="small strong" href="${go('admin/staff', 'Edit role')}">Edit</a>`, lines: [`${r.area} · ${r.people.join(', ')} · backup ${BACKUP[i]}`, `Limit: ${r.limit}`] }))),
          })}
          ${card({
            title: 'Staff members', sub: 'Every account uses 2-step sign-in', flush: true,
            actions: seg(['All', 'Active', 'Invited'], 0),
            body: both(table(['Name', 'Roles', 'Last active', 'Sign-in', 'Status'], staffRows),
              Object.keys(people).map((p) => ({ title: p, right: status('Active'), lines: [people[p].join(', '), `Last active: ${LAST[p] || 'Yesterday'}`] })).concat([{ title: 'Carlos Mendez', right: status('Invited'), lines: ['Warehouse worker · invitation sent Oct 7'] }, { title: 'Hannah Wu', right: status('Invited'), lines: ['Finance staff · invitation sent Oct 7'] }])),
          })}
        </div>
        <div class="stack gap-5">
          ${card({
            title: 'Invite staff', sub: 'Invitations expire after 7 days',
            body: `${field('Full name', input('st-name', '', { placeholder: 'First and last name' }))}
              ${field('Work email', input('st-email', '', { placeholder: 'name@marketly.example', type: 'email' }))}
              ${field('Role', select('st-role', ['Choose a role'].concat(D.staffRoles.map((r) => r.role)).concat(['Warehouse worker', 'Finance staff', 'Support agent']), 'Choose a role'), { hint: 'You can add more roles after they accept.' })}
              ${field('Reports to', select('st-mgr', ['Theo Grant', 'Ana Silva', 'Priya Nair', 'Isabel Cruz', 'Lena Park'], 'Ana Silva'))}
              ${field('Reason for access', textarea('st-reason', '', 'Why this person needs this role, e.g. new hire for the Reno, NV warehouse'), { hint: 'Required. Saved in Action history with the invitation.' })}
              ${check('st-limit', 'Request approval limits from the Business Owner', false)}`,
            foot: btn('Send invitation', { icon: 'send', size: 'sm' }),
          })}
          ${card({
            title: 'Coverage gaps', sub: 'Every work queue needs a lead and a backup',
            body: `<ul class="list">
              <li><span class="grow stack gap-0"><span class="small strong">Theo Grant leads 2 roles</span><span class="xs muted">Order Manager and Shipping Manager share one backup (Ana Silva)</span></span>${badge('Review', 'warning')}</li>
              <li><span class="grow stack gap-0"><span class="small strong">Jamie Brooks leads 2 roles</span><span class="xs muted">Marketing and Advertising, different backups</span></span>${badge('OK', 'success')}</li>
              <li><span class="grow stack gap-0"><span class="small strong">Warehouse workers</span><span class="xs muted">1 active, 1 invited for Reno, NV</span></span>${badge('Invited', 'info')}</li>
            </ul>`,
          })}
        </div>
      </div>
    `, 'staff');
  }

  function staffEditRole() {
    const allowed = (items) => items.filter((x) => x[1]).length;
    return adminLayout(`
      ${pageHead('Edit role: Finance Manager', { crumbs: [{ label: 'Staff and roles', href: go('admin/staff') }, 'Finance Manager'], sub: 'Working area: Finance · Lead Priya Nair · Backup Morgan Hale · 2 people hold this role', actions: btn('Cancel', { v: 'ghost', size: 'sm', href: go('admin/staff') }) + btn('Send for approval', { icon: 'send', size: 'sm' }) })}
      ${alert('warning', 'Granting access is not financial authority', 'You can change which screens this role can open. The approval limits below are proposals until Morgan Hale, Business Owner, approves them. Platform Administrators cannot approve their own financial limits.')}
      <div class="ac-main">
        <div class="stack gap-4">
          <div class="row between"><h2 class="h3">Permissions by area</h2><span class="xs muted">${sum(PERMS.map((g) => allowed(g[2])))} of ${sum(PERMS.map((g) => g[2].length))} actions allowed</span></div>
          ${PERMS.map(([area, ic, items], gi) => card({
            title: `<span class="row gap-2 nowrap">${icon(ic, 'ic-sm')}${area}</span>`, sub: `${allowed(items)} of ${items.length} allowed`,
            actions: toggle(`er-all-${gi}`, 'All', allowed(items) === items.length),
            body: `<div class="ac-perm">${items.map(([label, on], ii) => check(`er-p-${gi}-${ii}`, label, on)).join('')}</div>
              ${area === 'Finance' ? `<span class="xs muted">${icon('lock', 'ic-sm')} Payout destination changes always need verification by a second person and are not part of this role.</span>` : ''}
              ${area === 'Settings and staff' ? `<span class="xs muted">${icon('info', 'ic-sm')} Fee and payout settings are proposed by the Platform Administrator and approved by the Business Owner.</span>` : ''}`,
          })).join('')}
        </div>
        <div class="stack gap-5">
          ${card({
            title: 'Approval limits', sub: 'Set by the Business Owner. Example values.',
            body: `${LIMITS.map(([k, d, lim, per, rev, who2], i) => `<div class="ac-limit">
                <div class="ac-limit-t stack gap-0"><span class="small strong">${k}</span><span class="xs muted">${d}</span></div>
                ${field(`Limit ${per}`, input(`er-lim-${i}`, lim, { prefix: '$' }))}
                ${field('Second reviewer above', input(`er-rev-${i}`, rev, { prefix: '$' }), { hint: who2 })}
              </div>`).join('')}
              <div class="ac-limit">
                <div class="ac-limit-t stack gap-0"><span class="small strong">Seller restrictions</span><span class="xs muted">Restrict or suspend a seller account</span></div>
                ${field('Authority', select('er-restr', ['Not permitted', 'Recommend only', 'Permitted', 'Permitted with second review'], 'Recommend only'), { hint: 'Owned by Seller Manager' })}
              </div>
              <div class="ac-limit">
                <div class="ac-limit-t stack gap-0"><span class="small strong">Publication overrides</span><span class="xs muted">Publish or restore content against a review decision</span></div>
                ${field('Authority', select('er-pub', ['Not permitted', 'Recommend only', 'Permitted', 'Permitted with second review'], 'Not permitted'))}
              </div>`,
          })}
          ${card({
            title: 'Second reviewer', body: `${toggle('er-2nd', 'Require a second reviewer for high-value adjustments', true)}
              <span class="xs muted">A second Finance person or the Business Owner approves any action above the thresholds. The first person cannot approve their own request.</span>
              ${field('Default second reviewer', select('er-2nd-who', ['Morgan Hale, Business Owner', 'Hannah Wu, Finance staff (after onboarding)'], 'Morgan Hale, Business Owner'))}`,
          })}
          ${card({
            title: 'Reason for change', body: `${field('Reason (required)', U.textarea('er-reason', 'Raise refund limit from $1,500 to $2,000 to cover monitor and furniture returns without waiting for a second review.'))}
              ${field('Effective from', input('er-eff', 'Oct 12, 2026', { icon: 'calendar' }), { hint: 'Requests already waiting for approval keep the old limit.' })}`,
            foot: btn('Send for approval', { icon: 'send', size: 'sm' }),
          })}
        </div>
      </div>
    `, 'staff');
  }

  register({
    id: 'admin/staff', title: 'Staff and roles', ref: 'Plan ch. 2, 18',
    notes: 'Role list with people, backups, working areas and approval limits, plus staff accounts and invitations. The role editor groups permissions by area and keeps financial approval limits and the second reviewer separate from access, as the plan requires.',
    states: ['Roles and people', 'Edit role'],
    render: (st) => (st === 'Edit role' ? staffEditRole() : staffList()),
  });

  /* ======================================================================
     ADMIN 3 · Settings
     ====================================================================== */
  const SET_NAV = [['Market', 'globe'], ['Shipping defaults', 'truck'], ['Returns baseline', 'undo-2'], ['Fees', 'percent'], ['Payouts and holds', 'wallet'], ['Advertising rules', 'megaphone'], ['Checkout', 'shopping-cart']];
  const FEES = [['Electronics', '8%'], ['Computers', '7%'], ['Home & Kitchen', '12%'], ['Fashion', '15%'], ['Sports & Outdoors', '12%'], ['Beauty', '15%'], ['Toys & Games', '12%'], ['Pet Supplies', '12%']];
  const changed = (by, when, eff) => `<div class="ac-meta"><span>${icon('history', 'ic-sm')}Last changed ${when} by ${by}</span><span>${icon('calendar-check', 'ic-sm')}Effective ${eff}</span></div>`;

  function settingsPage(review) {
    const sec = (id, title, sub, body, meta, o = {}) => `<section class="card ac-sect" id="set-${id}">
      <div class="card-head"><div class="stack gap-0"><h2 class="h3">${title}</h2>${sub ? `<span class="xs muted">${sub}</span>` : ''}</div><div class="row gap-2">${o.badge || ''}${btn('Edit', { v: 'secondary', size: 'sm', icon: 'pencil' })}</div></div>
      <div class="card-body">${body}</div>
      <div class="card-foot" style="justify-content:space-between">${meta}</div></section>`;
    const page = adminLayout(`
      ${pageHead('Settings', { crumbs: ['Reports and settings', 'Settings'], sub: 'Market rules for the United States marketplace. Every change states its effective date and its effect on existing orders before you save.', actions: btn('View change history', { v: 'secondary', icon: 'history', size: 'sm', href: go('admin/audit') }) })}
      ${alert('info', '1 scheduled change', 'Electronics return window changes from 30 to 15 days on Nov 1, 2026. Orders placed before then keep 30 days. Approved by Morgan Hale on Oct 7.')}
      <div class="ac-set">
        <nav class="ac-setnav only-desktop" aria-label="Settings sections">${SET_NAV.map(([l, ic], i) => `<a href="javascript:void 0" class="${i === (review ? 2 : 0) ? 'is-active' : ''}">${icon(ic, 'ic-sm')}${l}</a>`).join('')}</nav>
        <div class="stack gap-5">
          ${sec(0, 'Market', 'One service region and one currency at launch', `<div class="ac-fgrid">
              ${field('Service region', select('se-region', ['United States, 48 contiguous states', 'United States, all states'], 'United States, 48 contiguous states'), { hint: 'Alaska, Hawaii and territories are planned for a later phase.' })}
              ${field('Currency', select('se-cur', ['USD (US dollar)'], 'USD (US dollar)'), { hint: 'Fixed for launch. All prices, fees and payouts use USD.' })}
              ${field('Time zone', select('se-tz', ['Pacific Time (PT)', 'Mountain Time (MT)', 'Central Time (CT)', 'Eastern Time (ET)'], 'Pacific Time (PT)'), { hint: 'Used for dispatch deadlines, reports and campaign schedules.' })}
              ${field('Business hours', input('se-hours', 'Mon–Sat, 8:00 AM – 8:00 PM PT'), { hint: 'Support response targets count only these hours.' })}
              <div class="full">${field('Holidays with no dispatch', input('se-hol', 'Nov 26 Thanksgiving · Dec 25 Christmas · Jan 1 New Year'), { hint: 'Arrival estimates skip these days and show a notice to customers.' })}</div>
            </div>`, changed('Riley Chen', 'Sep 14', 'Sep 15, 2026'))}

          ${sec(1, 'Shipping defaults', 'Sellers can be faster, not slower, than these targets', `<div class="ac-fgrid">
              ${field('Seller dispatch target', select('se-disp', ['1 business day', '2 business days', '3 business days'], '2 business days'))}
              ${field('Official Store order cutoff', input('se-cut', '2:00 PM PT', { icon: 'clock' }), { hint: 'Orders before cutoff ship the same business day.' })}
              ${field('Free delivery threshold, Official Store', input('se-free', '35.00', { prefix: '$' }))}
              ${field('Flag missing tracking after', input('se-trk', '24', { suffix: 'hours after marked shipped' }))}
              <div class="full stack gap-2"><span class="label">Carrier services</span><div class="row gap-2">${['UPS Ground', 'UPS 2nd Day Air', 'USPS Priority Mail', 'USPS Ground Advantage', 'FedEx Home Delivery'].map((c) => badge(c, 'outline', 'truck')).join('')}</div></div>
            </div>${ex('Example targets. Final dispatch standards are in the seller agreement.')}`, changed('Theo Grant', 'Sep 30', 'Oct 1, 2026'))}

          ${sec(2, 'Returns baseline', 'Sellers can offer more generous terms, never less', `<div class="ac-fgrid">
              ${field('Standard return window', input('se-rw', '30', { suffix: 'days after delivery' }))}
              ${field('Refund timing target', input('se-rt', '5', { suffix: 'business days after inspection' }))}
            </div>
            <span class="small strong">Category exceptions</span>
            ${table(['Category', 'Window', 'Condition', 'Shown to customers'], [
              ['Electronics', `30 days ${badge('15 days from Nov 1', 'warning', 'calendar-clock')}`, 'Opened items accepted with all accessories', 'Product page, checkout'],
              ['Beauty', 'Unopened only', 'Opened skincare not returnable for hygiene', 'Product page, checkout'],
              ['Fashion', '30 days', 'Tags attached, unworn', 'Product page'],
              ['Mattresses and bedding', '30 days', 'Sealed in original packaging', 'Product page, checkout'],
            ])}
            <span class="small strong">Who pays return shipping</span>
            ${U.kv([['Damaged, incorrect or defective', 'Seller or Official Store pays'], ['Change of mind', 'Customer pays, unless the seller offers free returns'], ['Lost in transit to warehouse', 'Marketly support decides with carrier claim']])}
            ${ex('Example policy. Final windows and exceptions are a business decision.')}`, changed('Riley Chen', 'Oct 7', 'Sep 1, 2026 · next change Nov 1'), { badge: badge('Change scheduled', 'warning', 'calendar-clock') })}

          ${sec(3, 'Fees', 'Commission rules by category', `<div class="ac-fgrid">
              ${field('Commission basis', select('se-basis', ['Item price after seller-funded discounts, excluding shipping', 'Item price before discounts, excluding shipping', 'Item price and shipping'], 'Item price after seller-funded discounts, excluding shipping'))}
              ${field('Platform-funded discounts', select('se-pfd', ['Do not reduce the seller fee', 'Reduce the seller fee'], 'Do not reduce the seller fee'))}
            </div>
            ${table(['Category', { label: 'Commission', cls: 'r' }, { label: 'On a $100.00 sale', cls: 'r' }], FEES.map(([c, r]) => [c, `<b>${r}</b>`, `${money(parseFloat(r))} fee · ${money(100 - parseFloat(r))} to seller`]))}
            ${ex('Example rates. Final fees are in the seller agreement. Cancellation, return and chargeback fee treatment is explained there too.')}`, changed('Riley Chen', 'Aug 28', 'Sep 1, 2026'))}

          ${sec(4, 'Payout schedule and hold rules', 'Earnings move from Pending to Available, then to a payout', `<div class="ac-fgrid">
              ${field('Payout schedule', select('se-po', ['Weekly, Friday', 'Twice weekly, Tuesday and Friday', 'Daily'], 'Weekly, Friday'))}
              ${field('Earnings become available', input('se-av', '7', { suffix: 'days after delivery' }))}
              ${field('Minimum payout', input('se-min', '25.00', { prefix: '$' }))}
              ${field('New seller hold', input('se-new', '14', { suffix: 'days, first 30 days of selling' }))}
            </div>
            <ul class="list">
              <li>${icon('lock', 'ic-sm')}<span class="small grow">Every hold needs a reason and a review date, both shown to the seller.</span></li>
              <li>${icon('shield-check', 'ic-sm')}<span class="small grow">Payout destination changes need verification and pause payouts for 72 hours.</span></li>
              <li>${icon('undo-2', 'ic-sm')}<span class="small grow">Refunds after payout are deducted from later earnings. If none, the seller balance shows the amount owed.</span></li>
            </ul>
            ${ex('Example schedule and holds. Final payout timing is a business decision.')}`, changed('Priya Nair (proposed), Morgan Hale (approved)', 'Sep 3', 'Sep 4, 2026'))}

          ${sec(5, 'Advertising rules', 'Launch formats: opening full-screen ad, banners, optional pop-ups', `<div class="ac-fgrid">
              ${field('Opening ad frequency', select('se-af', ['Once per session', 'Once per day', 'Once per campaign'], 'Once per session'))}
              ${field('Overlays per page view', select('se-ov', ['1 at most', '2 at most'], '1 at most'))}
              <div class="full">${field('Pages where ads never show', input('se-noad', 'Checkout · Payment result · Order tracking · Return request'), { hint: 'Ads must not cover purchase, tracking or return actions.' })}</div>
            </div>
            <div class="stack gap-2">
              <span class="row gap-2"><label class="switch" for="se-label"><input type="checkbox" role="switch" id="se-label" checked disabled aria-readonly="true"><span class="small">Require "Sponsored" or "Ad" label on every paid placement</span></label>${badge('Always on', '', 'lock')}</span>
              ${toggle('se-dismiss', 'Dismissing an ad stops it for the rest of the session', true)}
              <span class="row gap-2">${toggle('se-paid', 'Paid seller advertising', false)}${badge('Later', 'outline')}</span>
            </div>`, changed('Jamie Brooks', 'Sep 22', 'Sep 23, 2026'))}

          ${sec(6, 'Checkout', 'Guest purchases and order identity', `<div class="stack gap-3">
              ${toggle('se-guest', 'Allow guest checkout', true)}
              <span class="xs muted">Guests get an order link by email and can find orders with Guest order lookup using their email and order number.</span>
              ${toggle('se-acc', 'Offer to create an account after a guest purchase', true)}
            </div>`, changed('Riley Chen', 'Aug 20', 'Sep 1, 2026'))}
        </div>
      </div>
    `, 'settings');
    if (!review) return page;
    return page + modal({
      title: 'Review change before saving', size: 'lg',
      body: `<div class="stack gap-1"><span class="eyebrow">Returns baseline · Electronics</span><span class="h4">${ba('30-day return window', '15-day return window')}</span></div>
        <div class="ac-fgrid">
          ${field('Effective date', input('se-m-eff', 'Nov 1, 2026', { icon: 'calendar' }), { hint: 'At least 14 days after saving, so sellers and Help content can update.' })}
          ${field('Applies to', select('se-m-scope', ['Orders placed on or after the effective date', 'All orders not yet delivered'], 'Orders placed on or after the effective date'))}
        </div>
        <div class="stack gap-2"><span class="small strong">Impact on existing commitments</span>
          <ul class="list">
            <li>${icon('package', 'ic-sm')}<span class="small grow"><b>1,284 open Electronics orders</b> keep their 30-day window. Their order pages and return requests do not change.</span></li>
            <li>${icon('store', 'ic-sm')}<span class="small grow"><b>23 sellers</b> with Electronics offers are notified today. 4 sellers already offer 30 days and keep it.</span></li>
            <li>${icon('file-text', 'ic-sm')}<span class="small grow"><b>3 Help articles</b> and the Returns policy need an update by Noor Aziz, Content Manager, before Nov 1.</span></li>
            <li>${icon('shopping-cart', 'ic-sm')}<span class="small grow">Product pages and checkout show the new window from Nov 1, 12:00 AM PT.</span></li>
          </ul></div>
        ${field('Reason (required)', U.textarea('se-m-reason', 'Align Electronics with manufacturer return terms and reduce used-as-new resale.'))}
        ${alert('warning', 'Needs Business Owner approval', 'Returns baseline changes are approved by Morgan Hale. The change is scheduled only after approval.')}`,
      foot: btn('Back to editing', { v: 'ghost' }) + btn('Send for approval', { icon: 'send' }),
    });
  }

  register({
    id: 'admin/settings', title: 'Settings', ref: 'Plan ch. 18, 13, 14, 16',
    notes: 'Market, shipping, returns baseline with category exceptions, category fees, payout and hold rules, advertising rules and guest checkout. Business values are marked as examples; the review state shows a change with its effective date and impact on existing orders before saving.',
    states: ['All settings', 'Review change'],
    render: (st) => settingsPage(st === 'Review change'),
  });

  /* ======================================================================
     ADMIN 4 · Notifications
     ====================================================================== */
  const NOTI = {
    Customer: [
      ['Order accepted', 'Order details', 1], ['Payment result', 'Order details', 1], ['Dispatched, with tracking', 'Tracking', 1], ['Delay', 'Order details', 1], ['Delivered', 'Order details', 1],
      ['Cancellation', 'Order details', 1], ['Return update', 'Return', 1], ['Refund update', 'Refund progress', 1], ['Case reply', 'Case', 1],
    ],
    Seller: [
      ['Application result', 'Application status', 1], ['Requested corrections', 'Product or application', 1], ['New order', 'Seller order', 1], ['Dispatch deadline, 4 h before', 'Seller order', 1],
      ['Return request', 'Seller return', 1], ['Case opened or reply', 'Case', 1], ['Restriction', 'Account health', 1], ['Payout result', 'Payout record', 1],
    ],
    Staff: [
      ['Overdue shipping', 'Dispatch queue', 1], ['Stock shortage', 'Stock', 1], ['Waiting approval', 'Approval', 1], ['Escalated case', 'Case', 1], ['Failed payout', 'Payout record', 1], ['Unusual financial activity', 'Finance checks', 1],
    ],
  };
  const PROMO = [['Deals and coupons newsletter', 'Customer', 'Weekly'], ['Price drop and back-in-stock alerts', 'Customer', 'Growth phase'], ['Seller tips and campaigns', 'Seller', 'Monthly']];

  function notiMatrix() {
    const cols = ['Event', 'Type', { label: 'In-app', cls: 'c' }, { label: 'Email', cls: 'c' }, { label: 'SMS', cls: 'c' }, { label: 'Push', cls: 'c' }, 'Opens', ''];
    const rows = (aud) => NOTI[aud].map(([ev, opens], i) => [
      `<span class="small strong">${ev}</span>`, badge('Essential', 'info', 'lock'),
      cbx(`${aud} ${ev} in-app`, true, { disabled: true }), cbx(`${aud} ${ev} email`, !(aud === 'Staff' && i === 3)),
      badge('Later'), badge('Later'),
      `<span class="xs sub">${opens}</span>`,
      `<a class="small strong nowrap" href="${go('admin/notifications', 'Edit template')}">Edit template</a>`,
    ]);
    const audCard = (aud, ic, sub) => card({
      title: `<span class="row gap-2 nowrap">${icon(ic, 'ic-sm')}${aud} notices</span>`, sub, flush: true,
      body: `<div class="ac-matrix no-phone">${table(cols, rows(aud))}</div>${mlist(NOTI[aud].map(([ev, opens]) => ({ title: ev, right: badge('Essential', 'info'), lines: [`In-app and email · opens ${opens}`], foot: `<a class="small strong" href="${go('admin/notifications', 'Edit template')}">Edit template</a>` })))}`,
    });
    return adminLayout(`
      ${pageHead('Notifications', { crumbs: ['Reports and settings', 'Notifications'], sub: 'Who is told what, on which channel. Every notice links to the order, case or action it is about.', actions: btn('Send test notice', { v: 'secondary', icon: 'send', size: 'sm' }) })}
      <div class="ac-kpis">
        <div class="card pad">${stat('Essential events', String(NOTI.Customer.length + NOTI.Seller.length + NOTI.Staff.length), { note: 'customers, sellers, staff' })}</div>
        <div class="card pad">${stat('Channels live', '2', { note: 'In-app and email' })}</div>
        <div class="card pad">${stat('Email delivery, 7 days', '99.2%', { delta: '0.1 pts', dir: 'up' })}</div>
        <div class="card pad">${stat('Bounced or blocked', '38', { note: 'shown on customer record' })}</div>
      </div>
      ${alert('info', 'Essential and promotional messages are separate', 'Customers and sellers cannot turn off essential order, payment, return and account notices. Promotional messages follow their own consent and preferences. SMS and push come later; push will matter for the Android app.')}
      ${audCard('Customer', 'user-round', 'Order accepted through case replies')}
      ${audCard('Seller', 'store', 'Application through payout results')}
      ${audCard('Staff', 'user-cog', 'Sent to the queue lead and backup')}
      ${card({
        title: 'Promotional messages', sub: 'Sent only to people who opted in. Never mixed into essential notices.', flush: true,
        body: both(table(['Message', 'Audience', 'Frequency', 'Consent', { label: 'Email', cls: 'c' }, ''], PROMO.map(([m, a, f]) => [`<span class="small strong">${m}</span>`, a, `<span class="small">${f}</span>`, badge('Opt-in required', 'outline'), cbx(`${m} email`, f !== 'Growth phase', { disabled: f === 'Growth phase' }), `<a class="small strong" href="${go('admin/notifications', 'Edit template')}">Edit template</a>`])),
          PROMO.map(([m, a, f]) => ({ title: m, right: badge('Opt-in', 'outline'), lines: [`${a} · ${f}`] }))),
      })}
    `, 'notifications');
  }

  function notiTemplate() {
    const vars = ['customer.first_name', 'order.ref', 'seller.name', 'package.label', 'package.items', 'carrier.name', 'tracking.number', 'tracking.url', 'delivery.estimate', 'order.url'];
    const v = (t) => `<span class="ac-var">{{${t}}}</span>`;
    return adminLayout(`
      ${pageHead('Edit template: Dispatched, with tracking', { crumbs: [{ label: 'Notifications', href: go('admin/notifications') }, 'Customer', 'Dispatched'], sub: 'Customer · Essential · version 4 published Sep 30 by Noor Aziz, Content Manager', actions: btn('Send test to riley.chen@marketly.example', { v: 'secondary', size: 'sm', icon: 'send' }) + btn('Save draft', { v: 'secondary', size: 'sm' }) + btn('Publish version 5', { size: 'sm' }) })}
      <div class="split half">
        <div class="stack gap-5">
          ${card({
            title: 'Content', actions: seg(['Email', 'In-app'], 0),
            body: `${field('Subject', input('nt-subject', 'Your package from {{seller.name}} is on the way'), { hint: '48 characters. Keep under 60 so phones show it in full.' })}
              ${field('Preview text', input('nt-pre', '{{package.label}} · arrives {{delivery.estimate}}'))}
              ${field('Message', U.textarea('nt-body', 'Hi {{customer.first_name}},\n\n{{seller.name}} shipped {{package.label}} of your order {{order.ref}}.\n\n{{package.items}}\n\nCarrier: {{carrier.name}}\nTracking: {{tracking.number}}\nEstimated arrival: {{delivery.estimate}}\n\nOther packages in this order ship separately. You can follow each one from your order page.'), { hint: 'Plain language. Do not say the package is delivered or in transit until the carrier confirms a scan.' })}
              ${field('Button', input('nt-btn', 'Track package → {{tracking.url}}'))}`,
          })}
          ${card({
            title: 'Variables', sub: 'Click to insert at the cursor',
            body: `<div class="row gap-2">${vars.map((x) => `<button type="button" class="ac-varbtn">{{${x}}}</button>`).join('')}</div>
              ${alert('warning', 'Required variable missing in In-app version', `The In-app message does not include ${v('order.url')}. Every notice must link to its order.`)}`,
          })}
          ${card({
            title: 'Settings',
            body: `<div class="ac-fgrid">
                ${field('Language', select('nt-lang', ['English (US)'], 'English (US)'))}
                ${field('Sender', select('nt-from', ['Marketly Orders <orders@marketly.example>'], 'Marketly Orders <orders@marketly.example>'))}
              </div>
              ${toggle('nt-ess', 'Essential notice: recipients cannot unsubscribe', true)}
              ${check('nt-ads', 'Allow promotional content in this email', false)}
              <span class="xs muted">Promotional content is blocked in essential notices.</span>`,
          })}
        </div>
        <div class="stack gap-4">
          <div class="row between"><h2 class="h4">Preview</h2>${seg([{ label: 'Desktop', icon: 'monitor' }, { label: 'Phone', icon: 'smartphone' }], 0)}</div>
          <div class="ac-email">
            <div class="ac-mail">
              <div class="ac-mail-top">${U.logo()}<span class="xs muted">Order MK-261008-12544</span></div>
              <div class="ac-mail-body">
                <h3 class="h3">Your package from Pixel &amp; Port is on the way</h3>
                <p>Hi Jordan,</p>
                <p>Pixel &amp; Port shipped Package 2 of 3 of your order <span class="mono">MK-261008-12544</span>.</p>
                <div class="row gap-3 nowrap panel">${pimg(D.P.ssd1tb, 'tiny')}<span class="stack gap-0 grow"><span class="small strong">Kestrel 1 TB Portable SSD, USB 3.2</span><span class="xs muted">Space gray · Qty 2 · Sold by Pixel &amp; Port</span></span></div>
                ${U.kv([['Carrier', 'USPS Priority Mail'], ['Tracking', '<span class="mono">9405 5112 9830 1847 2290 31</span>'], ['Estimated arrival', 'Fri, Oct 9 – Sat, Oct 10']])}
                <span>${btn('Track package', { size: 'sm' })}</span>
                <p class="xs sub">Other packages in this order ship separately. You can follow each one from your order page.</p>
              </div>
              <div class="ac-mail-foot">This is an essential order update for jordan.lee@example.com. You can't unsubscribe from order updates. Manage promotional emails in Account › Notifications. Marketly, Inc. · Portland, OR</div>
            </div>
          </div>
          ${card({
            title: 'In-app preview', body: `<div class="row gap-3 nowrap" style="align-items:flex-start">${U.iconBtn('truck', 'Shipment')}<span class="stack gap-0 grow"><span class="small strong">Package 2 of 3 shipped</span><span class="xs sub">Pixel &amp; Port · USPS Priority · arrives Oct 9–10</span><span class="xs muted">Just now</span></span></div>`,
          })}
          ${card({
            title: 'Version history', flush: true,
            body: `<ul class="list pad">
              <li><span class="grow stack gap-0"><span class="small strong">Version 5 · draft</span><span class="xs muted">Riley Chen · today 9:50 AM · added separate-package line</span></span>${status('Draft')}</li>
              <li><span class="grow stack gap-0"><span class="small strong">Version 4</span><span class="xs muted">Noor Aziz · Sep 30 · live</span></span>${status('Published')}</li>
              <li><span class="grow stack gap-0"><span class="small strong">Version 3</span><span class="xs muted">Noor Aziz · Sep 12</span></span>${btn('Restore', { v: 'ghost', size: 'sm' })}</li>
            </ul>`,
          })}
        </div>
      </div>
    `, 'notifications');
  }

  register({
    id: 'admin/notifications', title: 'Notifications', ref: 'Plan ch. 19',
    notes: 'Notification matrix of audience × essential event × channel (in-app and email live, SMS and push later), with promotional messages kept separate under their own consent. The template state edits one email with variables, previews and versions.',
    states: ['Matrix', 'Edit template'],
    render: (st) => (st === 'Edit template' ? notiTemplate() : notiMatrix()),
  });

  /* ======================================================================
     ADMIN 5 · Action history (audit)
     ====================================================================== */
  const AUDIT = [
    { t: 'Oct 8, 9:32 AM', s: 'Priya Nair', r: 'Finance Manager', a: 'Released payout hold', tt: 'Payout', tr: 'PO-261009-0418', tn: 'Casa Verde Home', why: 'Carrier confirmed delivery for disputed order MK-260921-18320', b: 'Held $1,240.00', af: 'Available $1,240.00', ap: ['Approved', 'Morgan Hale, 9:41 AM'], hl: true },
    { t: 'Oct 8, 9:05 AM', s: 'Ana Silva', r: 'Inventory Manager', a: 'Stock adjustment', tt: 'Product', tr: 'PLR-CI26', tn: 'Pellar Cast Iron Skillet', why: 'Damaged in receiving, PUR-2610-0039', b: 'Available 79', af: 'Available 77, Damaged 2', ap: ['Not required', 'Under 50 units'] },
    { t: 'Oct 8, 8:47 AM', s: 'Grace Kim', r: 'Seller Manager', a: 'Restricted seller', tt: 'Seller', tr: 'Gadget Grove', tn: 'New sales paused', why: 'Late dispatch 11% over 30 days, target under 4%', b: 'Approved', af: 'Restricted', ap: ['Approved', 'Sven Larsen, 8:52 AM'] },
    { t: 'Oct 7, 6:12 PM', s: 'Isabel Cruz', r: 'Customer Support Manager', a: 'Goodwill credit', tt: 'Order', tr: 'MK-261002-55410', tn: 'Jordan Lee', why: 'Delivery 4 days late, seller Casa Verde Home', b: '$0.00', af: '$15.00 credit', ap: ['Not required', 'Within $50 limit'] },
    { t: 'Oct 7, 4:40 PM', s: 'Omar Haddad', r: 'Catalog Manager', a: 'Suspended offer', tt: 'Product', tr: 'BRL-S2', tn: 'Gadget Grove offer', why: 'Counterfeit report TR-261007-004 under review', b: 'Active', af: 'Suspended', ap: ['Not required', 'Catalog role'] },
    { t: 'Oct 7, 3:18 PM', s: 'Priya Nair', r: 'Finance Manager', a: 'Refund without return', tt: 'Order', tr: 'MK-260930-21877', tn: 'Kestrel 27" Monitor', why: 'Package lost by carrier, claim USPS-CLM-4410', b: 'Requested', af: 'Approved $329.00', ap: ['Pending', 'Waiting for Morgan Hale'] },
    { t: 'Oct 7, 11:02 AM', s: 'Riley Chen', r: 'Platform Administrator', a: 'Assigned role', tt: 'Staff', tr: 'Hannah Wu', tn: 'Finance staff', why: 'New finance staff member, invited', b: 'No role', af: 'Finance staff, view only', ap: ['Not required', 'Access only'] },
    { t: 'Oct 7, 10:15 AM', s: 'Riley Chen', r: 'Platform Administrator', a: 'Scheduled setting change', tt: 'Setting', tr: 'Returns · Electronics', tn: 'From Nov 1', why: 'Align with manufacturer return terms', b: '30 days', af: '15 days', ap: ['Approved', 'Morgan Hale, Oct 7'] },
    { t: 'Oct 6, 5:55 PM', s: 'Theo Grant', r: 'Shipping Manager', a: 'Opened carrier claim', tt: 'Order', tr: 'MK-261001-33019', tn: 'UPS-CLM-88412', why: 'UPS scan shows damage in transit', b: 'No claim', af: 'Claim $116.00', ap: ['Not required', 'Within $1,000 limit'] },
    { t: 'Oct 6, 2:31 PM', s: 'Dana Ortiz', r: 'Official Store Manager', a: 'Price change', tt: 'Product', tr: 'HAL-AUR-BLK', tn: 'Official Store offer', why: 'Home Week markdown, Oct 6–19', b: '$229.00', af: '$189.00 (−17%)', ap: ['Not required', 'Within 30% limit'] },
  ];
  const apTone = { Approved: 'success', Pending: 'warning', 'Not required': '' };
  const tgtIcon = { Payout: 'wallet', Product: 'package', Seller: 'store', Order: 'shopping-bag', Staff: 'user-cog', Setting: 'settings' };

  register({
    id: 'admin/audit', title: 'Action history', ref: 'Plan ch. 18, 2',
    notes: 'Read-only record of material staff actions: who, which role, what changed (before and after), the target, the recorded reason and any second-reviewer approval. Supports filters and authorized export.',
    render: () => adminLayout(`
      ${pageHead('Action history', { crumbs: ['Reports and settings', 'Action history'], sub: 'Every material change with its reason and approvals. Records cannot be edited or deleted.', actions: btn('Export CSV', { v: 'secondary', icon: 'download', size: 'sm' }) })}
      <div class="toolbar">
        ${searchIn('Search by order, seller, SKU, payout or staff', 'au-q')}
        <label class="sr-only" for="au-staff">Staff</label>${select('au-staff', ['All staff', ...Object.keys(people)], 'All staff')}
        <label class="sr-only" for="au-target">Target</label>${select('au-target', ['All targets', 'Orders', 'Sellers', 'Products', 'Payouts', 'Settings', 'Staff'], 'All targets')}
        <label class="sr-only" for="au-range">Date range</label>${select('au-range', ['Last 7 days', 'Today', 'Last 30 days', 'Custom range'], 'Last 7 days')}
      </div>
      ${chips([{ label: 'Second review pending', icon: 'user-check' }, { label: 'Financial actions', icon: 'landmark' }, { label: 'Seller enforcement', icon: 'store' }, { label: 'Settings changes', icon: 'settings' }], -1)}
      <div class="ac-main">
        ${card({
          title: 'Actions', sub: '214 actions in the last 7 days · showing 10', flush: true,
          body: both(table(['Time', 'Staff and role', 'Action', 'Target', 'Reason', 'Before → after', 'Approval'], AUDIT.map((x) => [
            `<span class="small nowrap">${x.t}</span>`, who(x.s, x.r), `<span class="small strong">${x.a}</span>`,
            `<span class="stack gap-0"><span class="row gap-1 nowrap xs muted">${icon(tgtIcon[x.tt], 'ic-sm')}${x.tt}</span>${ref(x.tr)}<span class="xs muted">${x.tn}</span></span>`,
            `<span class="small" style="display:block;min-width:200px">${x.why}</span>`, ba(x.b, x.af),
            `<span class="stack gap-1" style="align-items:flex-start">${status(x.ap[0], apTone[x.ap[0]])}<span class="xs muted nowrap">${x.ap[1]}</span></span>`,
          ]), { rowCls: AUDIT.map((x) => (x.ap[0] === 'Pending' ? 'is-warn' : '')) }),
          AUDIT.map((x) => ({ cls: x.ap[0] === 'Pending' ? 'is-warn' : '', title: x.a, right: status(x.ap[0], apTone[x.ap[0]]), lines: [`${x.t} · ${x.s}, ${x.r}`, `${x.tt} <span class="mono">${x.tr}</span> · ${x.why}`, ba(x.b, x.af)] }))) + `<div class="card-foot" style="justify-content:space-between"><span class="xs muted">Retention: 7 years (example)</span>${U.pager(1, 22)}</div>`,
        })}
        ${card({
          title: 'Released payout hold', sub: 'Oct 8, 9:32 AM · selected entry',
          body: `${U.kv([['Staff', 'Priya Nair, Finance Manager'], ['Target', `Payout ${ref('PO-261009-0418', go('admin/payouts'))} · Casa Verde Home`], ['Change', ba('Held $1,240.00', 'Available $1,240.00')], ['Reason', 'Carrier confirmed delivery for disputed order MK-260921-18320'], ['Hold placed', 'Sep 29 · review date Oct 9'], ['Evidence', 'UPS proof of delivery, case CS-260930-1172']])}
            <div class="divider"></div>
            <span class="small strong">Approval history</span>
            ${timeline([
              { t: 'Requested by Priya Nair', d: 'Oct 8, 9:32 AM', state: 'done', body: 'Above $1,000 threshold, second review required' },
              { t: 'Approved by Morgan Hale, Business Owner', d: 'Oct 8, 9:41 AM', state: 'done' },
              { t: 'Included in payout run', d: 'Fri, Oct 9, 10:00 AM PT', state: 'current', body: 'Approved is not paid. Status shows Paid only after the bank confirms.' },
            ])}`,
        })}
      </div>
    `, 'audit'),
  });

  /* ======================================================================
     OPS 6 · My work queues
     ====================================================================== */
  const QUEUES = [
    ['Overdue dispatch', 'Theo Grant', 'Ana Silva', 'Seller Manager (sellers), Business Owner after 48 h', 9, 6, 'MK-260914-48213 · 16 d', 'ops/dispatch', 'Late dispatch', true],
    ['Missing tracking', 'Theo Grant', 'Ana Silva', 'Seller Manager', 4, 2, 'MK-261005-07711 · 3 d', 'ops/dispatch', 'Missing tracking', true],
    ['Lost, damaged or failed delivery', 'Theo Grant', 'Isabel Cruz', 'Finance for claims over $1,000', 5, 1, 'MK-260929-30126 · 9 d', 'ops/dispatch', 'Lost or damaged', true],
    ['Seller cannot fulfill', 'Theo Grant', 'Isabel Cruz', 'Seller Manager', 3, 0, 'MK-261007-10512 · 18 h', 'ops/dispatch', 'Seller cannot fulfill', true],
    ['Pick and pack, Official Store', 'Ana Silva', 'Theo Grant', 'Warehouse Manager → Order Manager', 27, 0, 'MK-261008-12544 · 3 h', 'ops/pick-pack', null, false],
    ['Receiving', 'Ana Silva', 'Ken Watanabe', 'Purchasing Manager', 3, 0, 'PUR-2610-0042 · today', 'ops/receiving', null, false],
    ['Return inspection', 'Lena Park', 'Ana Silva', 'Customer Support Manager', 5, 1, 'RT-261004-0197 · 2 d', 'ops/return-inspection', null, false],
    ['Daily finance checks', 'Priya Nair', 'Morgan Hale', 'Business Owner', 6, 1, 'Deposit Oct 7 · 1 d', 'ops/finance-checks', null, false],
    ['Customer cases waiting', 'Isabel Cruz', 'Theo Grant', 'Customer Support Manager', 31, 5, 'CS-260929-1044 · 9 d', 'admin/cases', null, false],
  ];

  register({
    id: 'ops/queues', title: 'My work queues', ref: 'Plan ch. 18, 2',
    notes: 'Theo Grant’s workspace: every queue shows its lead, backup, escalation route, counts, overdue items and oldest item. Includes the daily operating routine, the day-end review and saved filters from the plan.',
    render: () => opsLayout(`
      ${pageHead('My work queues', { sub: 'Theo Grant · Order Manager and Shipping Manager · Thursday, Oct 8, 2026 · 10:05 AM PT', actions: btn('Export', { v: 'secondary', icon: 'download', size: 'sm' }) + btn('Start day-end review', { icon: 'clipboard-check', size: 'sm' }) })}
      <div class="ac-kpis">
        <div class="card pad">${stat('Assigned to me', '21', { note: '4 queues where I lead' })}</div>
        <div class="card pad">${stat('Overdue', '9', { delta: '3', dir: 'down', note: 'more than yesterday' })}</div>
        <div class="card pad">${stat('Oldest open item', '16 days', { note: 'MK-260914-48213' })}</div>
        <div class="card pad">${stat('Ship today, Official Store', '214', { note: 'UPS pickup 4:00 PM' })}</div>
      </div>
      <div class="ac-main">
        <div class="stack gap-5">
          ${card({
            title: 'Work queues', sub: 'Lead, backup and escalation route for every queue', flush: true,
            actions: seg(['Mine', 'All queues'], 1),
            body: both(table(['Queue', 'Lead', 'Backup', 'Escalation route', { label: 'Open', cls: 'r' }, { label: 'Overdue', cls: 'r' }, 'Oldest item', ''], QUEUES.map((q) => [
              `<span class="row gap-2 nowrap"><a class="small strong" href="${go(q[7], q[8])}">${q[0]}</a>${q[9] ? badge('Mine', 'brand') : ''}</span>`,
              `<span class="small nowrap">${q[1]}</span>`, `<span class="small nowrap">${q[2]}</span>`, `<span class="xs sub" style="display:block;min-width:160px">${q[3]}</span>`,
              `<b>${q[4]}</b>`, q[5] ? `<span class="ac-out">${q[5]}</span>` : '<span class="muted">0</span>', `<span class="xs mono nowrap">${q[6]}</span>`,
              btn('Open', { v: 'ghost', size: 'sm', href: go(q[7], q[8]) }),
            ]), { rowCls: QUEUES.map((q) => (q[5] ? 'is-flagged' : '')) }),
            QUEUES.map((q) => ({ cls: q[5] ? 'is-flagged' : '', title: `<a href="${go(q[7], q[8])}">${q[0]}</a>`, right: `<span class="row gap-1 nowrap">${badge(q[4] + ' open')}${q[5] ? badge(q[5] + ' overdue', 'danger') : ''}</span>`, lines: [`Lead ${q[1]} · backup ${q[2]}`, `Escalates to ${q[3]}`, `Oldest: <span class="mono">${q[6]}</span>`] }))),
          })}
          ${card({
            title: 'Day-end review', sub: 'Due 5:30 PM PT · shared with all queue leads',
            actions: btn('Send summary to managers', { v: 'secondary', size: 'sm', icon: 'send' }),
            body: `<ul>
              ${ck('', 'Unresolved commitments', '7 orders past dispatch deadline still open. 2 customers not yet notified.', `<a class="small strong nowrap" href="${go('ops/dispatch', 'Late dispatch')}">Review</a>`)}
              ${ck('', 'Failed payouts', 'PO-261002-0311 Trailhead Outfitters and PO-261002-0316 Gadget Grove · owner Priya Nair', `<a class="small strong nowrap" href="${go('ops/finance-checks')}">Review</a>`)}
              ${ck('', 'Upcoming campaigns', 'Free shipping pop-up starts Sat, Oct 10 · Home Week ends Mon, Oct 19 · owner Jamie Brooks', `<a class="small strong nowrap" href="${go('admin/ads')}">Review</a>`)}
              ${ck('', 'Next-day shipping', 'Fri, Oct 9: 188 Official Store orders forecast · UPS pickup 4:00 PM · 2 SKUs short for open orders', `<a class="small strong nowrap" href="${go('ops/inventory')}">Review</a>`)}
            </ul>`,
          })}
        </div>
        <div class="stack gap-5">
          ${card({
            title: "Today's routine", sub: '2 of 5 reviews done',
            body: `${meter(40)}<ul>
              ${ck('done', 'Review dispatch and delivery', 'Order and Shipping · Theo Grant · done 8:40 AM')}
              ${ck('done', 'Review shortages and physical work', 'Inventory and Warehouse · Ana Silva · done 9:10 AM')}
              ${ck('now', 'Review waiting cases', 'Seller, Catalog, Returns, Support managers · 3 of 4 checked in')}
              ${ck('late', 'Check payments and payouts', 'Finance · Priya Nair · was due 10:00 AM')}
              ${ck('', 'Check live campaigns and schedules', 'Advertising · Jamie Brooks · due 11:00 AM')}
            </ul>`,
          })}
          ${card({
            title: 'Saved filters', sub: 'Your filters, plus 2 shared by Ana Silva',
            body: `<ul class="list">
              ${[['Overdue over 24 h, marketplace sellers', 6, 'Late dispatch'], ['Missing tracking, Official Store', 1, 'Missing tracking'], ['Lost or damaged, no claim opened', 2, 'Lost or damaged'], ['Due before 2 PM cutoff (shared)', 41, null], ['Failed delivery, customer cost applies (shared)', 1, 'Delivery failed']].map(([l, n, stt]) => `<li>${icon('bookmark', 'ic-sm')}<a class="small grow" href="${go(stt ? 'ops/dispatch' : 'ops/pick-pack', stt)}">${l}</a>${badge(String(n))}</li>`).join('')}
            </ul>`,
            foot: btn('Save current filter', { v: 'ghost', size: 'sm', icon: 'plus' }),
          })}
          ${alert('info', 'Escalation reminder', 'Seller shipping problems go to Grace Kim, Seller Manager, when performance action is needed. Exports are limited to your areas: orders and shipping.')}
        </div>
      </div>
    `, 'queues'),
  });

  /* ======================================================================
     OPS 7 · Official Store stock
     ====================================================================== */
  const STOCK = [
    { p: D.P.aurora, name: 'Halden Aurora ANC Headphones, Black', sku: 'HAL-AUR-BLK', loc: 'A-03-2', av: 142, re: 38, inc: 120, dmg: 0, ret: 3, rop: 40, cost: 112 },
    { p: D.P.aurora, name: 'Halden Aurora ANC Headphones, Silver', sku: 'HAL-AUR-SLV', loc: 'A-03-4', av: 0, re: 6, inc: 80, dmg: 0, ret: 0, rop: 25, cost: 112 },
    { p: D.P.lamp, name: 'Brightline Smart LED Desk Lamp', sku: 'BRL-LAMP-W', loc: 'C-04-1', av: 9, re: 4, inc: 0, dmg: 1, ret: 1, rop: 20, cost: 21 },
    { p: D.P.skillet, name: 'Pellar Cast Iron Skillet 26 cm', sku: 'PLR-CI26', loc: 'D-02-3', av: 77, re: 12, inc: 120, dmg: 2, ret: 1, rop: 30, cost: 26 },
    { p: D.P.sweater, name: 'Nordvik Merino Crew, M, Navy', sku: 'NDV-MER-M-NVY', loc: 'F-12-2', av: 52, re: 7, inc: 0, dmg: 0, ret: 2, rop: 15, cost: 38 },
    { p: D.P.sweater, name: 'Nordvik Merino Crew, L, Navy', sku: 'NDV-MER-L-NVY', loc: 'F-12-3', av: 11, re: 5, inc: 40, dmg: 0, ret: 0, rop: 15, cost: 38 },
    { p: D.P.pourover, name: 'Mosswood Pour-over Coffee Set, Cream', sku: 'MSW-PO-CRM', loc: 'C-07-1', av: 58, re: 9, inc: 0, dmg: 1, ret: 1, rop: 20, cost: 15 },
    { p: D.P.serum, name: 'Aster Daily Vitamin C Serum 30 ml', sku: 'AST-VC30', loc: 'E-01-4', av: 140, re: 22, inc: 0, dmg: 0, ret: 0, rop: 50, cost: 8 },
  ];
  const stockStatus = (x) => (x.av === 0 ? 'Out of stock' : x.av <= x.rop ? 'Low stock' : 'In stock');
  const ADJ = [
    ['Oct 8, 9:05 AM', 'PLR-CI26', ['Available', 'Damaged or held'], 2, 'Damaged in receiving, PUR-2610-0039', 'Ana Silva', 'Not required'],
    ['Oct 7, 4:22 PM', 'HAL-AUR-BLK', ['Returned', 'Available'], 1, 'Return RT-261001-0161 inspected, like new', 'Ana Silva', 'Not required'],
    ['Oct 7, 11:40 AM', 'BRL-LAMP-W', ['Available', 'Available'], -3, 'Cycle count correction, bin C-04-1', 'Ana Silva', 'Not required'],
    ['Oct 6, 3:15 PM', 'AST-VC30', ['Incoming', 'Available'], 120, 'Received PUR-2610-0031', 'Ana Silva', 'Dana Ortiz approved'],
    ['Oct 5, 10:02 AM', 'MSW-PO-CRM', ['Available', 'Damaged or held'], 1, 'Chipped cup found during packing', 'Carlos Mendez', 'Not required'],
  ];

  function inventoryPage(adjust) {
    const tot = (k) => sum(STOCK.map((x) => x[k]));
    const val = (k) => sum(STOCK.map((x) => x[k] * x.cost));
    const GROUPS = [
      ['Available', 'av', 'var(--success)', 'Sellable to new customers'], ['Reserved', 're', 'var(--info)', 'Allocated to accepted orders'], ['Incoming', 'inc', 'var(--border-strong)', 'Expected from suppliers'],
      ['Damaged or held', 'dmg', 'var(--danger)', 'Awaiting inspection or unsellable'], ['Returned', 'ret', 'var(--warning)', 'Needs a condition decision'],
    ];
    const page = opsLayout(`
      ${pageHead('Official Store stock', { sub: 'Reno, NV warehouse · company-owned stock only. Seller stock is never mixed in.', actions: btn('Export', { v: 'secondary', icon: 'download', size: 'sm' }) + btn('Adjust stock', { icon: 'sliders-horizontal', size: 'sm', href: go('ops/inventory', 'Adjust stock') }) })}
      <div class="ac-groups">${GROUPS.map(([l, k, tone, m]) => `<div class="ac-grp" style="--tone:${tone}"><span class="xs strong sub">${l}</span><span class="v">${num(tot(k))}</span><span class="xs muted">${money(val(k))} at cost</span><span class="xs muted">${m}</span></div>`).join('')}</div>
      ${alert('warning', '3 SKUs at or below reorder point', 'Halden Aurora Silver is out of stock, 80 incoming on PUR-2610-0042 (arrived today). Brightline desk lamp and Nordvik Merino L are low. Customers can buy only Available units.')}
      <div class="toolbar">
        ${searchIn('Search SKU, product or bin', 'inv-q')}
        <label class="sr-only" for="inv-grp">Stock group</label>${select('inv-grp', ['All stock groups', 'Low or out of stock', 'Has damaged or held', 'Has returned'], 'All stock groups')}
        <label class="sr-only" for="inv-loc">Location</label>${select('inv-loc', ['All locations', 'Zone A', 'Zone C', 'Zone D', 'Zone E', 'Zone F'], 'All locations')}
      </div>
      ${card({
        title: 'Stock by SKU', sub: `${STOCK.length} of 214 Official Store SKUs`, flush: true,
        body: both(table(['Product', 'Location', { label: 'Available', cls: 'r' }, { label: 'Reserved', cls: 'r' }, { label: 'Incoming', cls: 'r' }, { label: 'Damaged or held', cls: 'r' }, { label: 'Returned', cls: 'r' }, { label: 'Reorder at', cls: 'r' }, 'Status', ''], STOCK.map((x) => {
          const st = stockStatus(x);
          return [`<div class="cell-main">${pimg(x.p, 'tiny')}<span class="stack gap-0"><span class="small strong">${x.name}</span><span class="xs mono muted">${x.sku}</span></span></div>`,
            `<span class="mono small">${x.loc}</span>`, `<span class="${st === 'Out of stock' ? 'ac-out' : st === 'Low stock' ? 'ac-low' : 'strong'}">${x.av}</span>`, x.re, x.inc || '<span class="muted">0</span>', x.dmg ? `<span class="t-danger-text strong">${x.dmg}</span>` : '<span class="muted">0</span>', x.ret ? `<span class="t-warning-text strong">${x.ret}</span>` : '<span class="muted">0</span>', `<span class="muted">${x.rop}</span>`,
            status(st), btn('Adjust', { v: 'ghost', size: 'sm', href: go('ops/inventory', 'Adjust stock') })];
        }), { rowCls: STOCK.map((x) => (x.av === 0 ? 'is-flagged' : x.av <= x.rop ? 'is-warn' : '')) }),
        STOCK.map((x) => { const st = stockStatus(x); return { cls: x.av === 0 ? 'is-flagged' : x.av <= x.rop ? 'is-warn' : '', title: `${x.name}`, right: status(st), lines: [`<span class="mono">${x.sku}</span> · bin <span class="mono">${x.loc}</span>`, `Available <b>${x.av}</b> · Reserved ${x.re} · Incoming ${x.inc} · Damaged ${x.dmg} · Returned ${x.ret}`] }; })),
      })}
      <div class="grid lg2" style="--gap:var(--sp-5)">
        ${card({
          title: 'Adjustment history', sub: 'Reason, staff member and date for every change', flush: true,
          actions: `<a class="small strong" href="${go('admin/audit')}">Full history</a>`,
          body: both(table(['Date', 'SKU', 'Change', { label: 'Qty', cls: 'r' }, 'Reason', 'Staff', 'Second review'], ADJ.map((a) => [`<span class="small nowrap">${a[0]}</span>`, `<span class="mono small">${a[1]}</span>`, a[2][0] === a[2][1] ? `<span class="xs">Count correction</span>` : ba(a[2][0], a[2][1]), `<b>${a[3] > 0 ? a[3] : '−' + Math.abs(a[3])}</b>`, `<span class="small" style="display:block;min-width:180px">${a[4]}</span>`, `<span class="small nowrap">${a[5]}</span>`, `<span class="xs muted">${a[6]}</span>`])),
            ADJ.map((a) => ({ title: `<span class="mono">${a[1]}</span> · ${a[3] > 0 ? a[3] : '−' + Math.abs(a[3])} units`, right: `<span class="xs muted nowrap">${a[0]}</span>`, lines: [a[2][0] === a[2][1] ? 'Count correction' : ba(a[2][0], a[2][1]), `${a[4]} · ${a[5]}`] }))),
        })}
        <div class="stack gap-5">
          ${card({
            title: 'Stock rules', body: `<ul class="list">
              <li>${icon('shield-check', 'ic-sm')}<span class="small grow">Checkout cannot sell more than the Available quantity.</span></li>
              <li>${icon('refresh-cw', 'ic-sm')}<span class="small grow">Reserved units return to Available only when the purchase ends or is cancelled.</span></li>
              <li>${icon('user-check', 'ic-sm')}<span class="small grow">Adjustments over 50 units need a second reviewer (Inventory Manager limit).</span></li>
            </ul>`,
          })}
          ${card({ title: `<span class="row gap-2 nowrap">${icon('arrow-left-right', 'ic-sm')}Transfers ${badge('Later', 'outline')}</span>`, body: '<p class="small sub">Transfers between warehouses and seller-owned stock storage arrive with multiple warehouses in the operational expansion phase. One location, Reno, NV, at launch.</p>' })}
        </div>
      </div>
    `, 'inventory');
    if (!adjust) return page;
    return page + modal({
      title: 'Adjust stock',
      body: `${field('SKU', select('adj-sku', STOCK.map((x) => `${x.sku} · ${x.name}`), 'AST-VC30 · Aster Daily Vitamin C Serum 30 ml'))}
        <div class="panel row gap-4 xs sub"><span>Available <b>140</b></span><span>Reserved <b>22</b></span><span>Damaged or held <b>0</b></span><span>Bin <b class="mono">E-01-4</b></span></div>
        <div class="ac-fgrid">
          ${field('From group', select('adj-from', ['Available', 'Reserved', 'Incoming', 'Damaged or held', 'Returned'], 'Available'))}
          ${field('To group', select('adj-to', ['Available', 'Damaged or held', 'Returned', 'Remove from stock (write off)'], 'Damaged or held'))}
          ${field('Quantity', input('adj-qty', '60', { type: 'number', suffix: 'units' }))}
          ${field('Reason (required)', select('adj-reason', ['Choose a reason', 'Quality hold: supplier notice', 'Damaged in warehouse', 'Count correction', 'Found stock', 'Theft or loss'], 'Quality hold: supplier notice'))}
          <div class="full">${field('Note', U.textarea('adj-note', 'Supplier recall notice for batch L2609 received Oct 8, 8:15 AM. Hold until lab result.'), { opt: true })}</div>
        </div>
        <div class="well stack gap-2"><span class="small strong">After this change</span>${sumRow('Available', ba('140', '80'))}${sumRow('Damaged or held', ba('0', '60'))}<span class="xs muted">22 reserved units stay with their orders. Order Manager is notified to check them.</span></div>
        ${alert('warning', 'Second review needed', '60 units is above your 50-unit adjustment limit. The change applies after Dana Ortiz, Official Store Manager, approves it.')}
        ${field('Second reviewer', select('adj-rev', ['Dana Ortiz, Official Store Manager', 'Morgan Hale, Business Owner'], 'Dana Ortiz, Official Store Manager'))}`,
      foot: btn('Cancel', { v: 'ghost', href: go('ops/inventory') }) + btn('Send for second review', { icon: 'send' }),
    });
  }

  register({
    id: 'ops/inventory', title: 'Official Store stock', ref: 'Plan ch. 9',
    notes: 'Company-owned stock by the five stock groups with value, per-SKU table with locations and low-stock warnings, and adjustment history with reason, staff and date. The adjust state requires a reason and sends changes over 50 units to a second reviewer.',
    states: ['Stock', 'Adjust stock'],
    render: (st) => inventoryPage(st === 'Adjust stock'),
  });

  /* ======================================================================
     OPS 8 · Receiving
     ====================================================================== */
  const PURS = [
    ['PUR-2610-0042', 'Halden Audio Distribution', 'Today, 10:00 AM – 12:00 PM', 'Freight · 2 pallets', 3, 260, ['Arrived, dock 2', 'info'], true],
    ['PUR-2610-0045', 'Pellar Cookware Co.', 'Today, 1:00 – 3:00 PM', 'UPS Freight · PRO 482-119-5530', 2, 120, ['Incoming', ''], false],
    ['PUR-2610-0047', 'Mosswood Home Goods', 'Today, 3:00 – 5:00 PM', 'FedEx Freight · 1 pallet', 4, 180, ['Delayed', 'warning'], false],
    ['PUR-2610-0036', 'Nordvik Knitwear', 'Mon, Oct 12', 'UPS Ground · 6 cartons', 2, 40, ['Incoming', ''], false],
    ['PUR-2610-0039', 'Pellar Cookware Co.', 'Received Oct 7', 'Shortage 4, damaged 2', 1, 120, ['Received with issues', 'warning'], false],
  ];
  const LINES = [
    { p: D.P.aurora, name: 'Halden Aurora ANC Headphones, Black', sku: 'HAL-AUR-BLK', exp: 120, rec: 118, dmg: 0, loc: 'A-03-2', cls: 'is-warn' },
    { p: D.P.aurora, name: 'Halden Aurora ANC Headphones, Silver', sku: 'HAL-AUR-SLV', exp: 80, rec: 80, dmg: 3, loc: 'A-03-4', cls: 'is-flagged' },
    { p: D.P.speaker, name: 'Halden Pocket Bluetooth Speaker, Teal', sku: 'HAL-PKT-TEAL', exp: 60, rec: 60, dmg: 0, loc: 'B-11-1', cls: '' },
  ];

  function receivingList() {
    return opsLayout(`
      ${pageHead('Receiving', { sub: 'Inbound purchase deliveries · Reno, NV · Purchasing orders, Warehouse receives, Inventory confirms what can be sold', actions: btn('Export', { v: 'secondary', icon: 'download', size: 'sm' }) })}
      <div class="ac-kpis">
        <div class="card pad">${stat('Expected today', '3', { note: '560 units' })}</div>
        <div class="card pad">${stat('Arrived, not received', '1', { note: 'PUR-2610-0042 at dock 2' })}</div>
        <div class="card pad">${stat('Received this week', '9', { note: '1,420 units' })}</div>
        <div class="card pad">${stat('Open shortages', '2', { note: 'with Ken Watanabe' })}</div>
      </div>
      ${tabs([{ label: 'Expected', count: 4 }, { label: 'Receiving', count: 1 }, { label: 'Received with issues', count: 1 }, { label: 'Completed' }], 0)}
      ${card({
        title: 'Purchase deliveries', sub: 'Expected arrivals from Purchasing', flush: true,
        body: both(table(['Purchase order', 'Supplier', 'Expected', 'Carrier', { label: 'Lines', cls: 'r' }, { label: 'Units', cls: 'r' }, 'Status', ''], PURS.map((r) => [
          ref(r[0], r[7] ? go('ops/receiving', 'Receiving PUR-2610-0042') : null), `<span class="small strong">${r[1]}</span>`, `<span class="small nowrap">${r[2]}</span>`, `<span class="xs sub">${r[3]}</span>`, r[4], num(r[5]), status(r[6][0], r[6][1]),
          r[7] ? btn('Start receiving', { size: 'sm', href: go('ops/receiving', 'Receiving PUR-2610-0042') }) : btn('View', { v: 'ghost', size: 'sm' }),
        ]), { rowCls: PURS.map((r) => (r[6][1] === 'warning' ? 'is-warn' : '')) }),
        PURS.map((r) => ({ cls: r[6][1] === 'warning' ? 'is-warn' : '', title: ref(r[0], r[7] ? go('ops/receiving', 'Receiving PUR-2610-0042') : null), right: status(r[6][0], r[6][1]), lines: [`${r[1]} · ${r[4]} lines · ${r[5]} units`, r[2], r[3]], foot: r[7] ? btn('Start receiving', { size: 'sm', href: go('ops/receiving', 'Receiving PUR-2610-0042') }) : '' }))),
      })}
      <div class="grid lg2" style="--gap:var(--sp-5)">
        ${alert('warning', 'PUR-2610-0047 running late', 'FedEx Freight moved delivery to Fri, Oct 9. Ken Watanabe, Purchasing Manager, updated the expected date. 2 Mosswood SKUs stay in Incoming until then.')}
        ${card({ title: 'Who does what', body: U.kv([['Purchasing', 'Ken Watanabe orders stock and tracks arrival'], ['Warehouse', 'Carlos Mendez counts, records shortages and damage, puts away'], ['Inventory', 'Ana Silva confirms the sellable quantity']]) })}
      </div>
    `, 'receiving');
  }

  function receivingOne() {
    const sell = sum(LINES.map((l) => l.rec - l.dmg));
    return opsLayout(`
      ${pageHead('Receiving PUR-2610-0042', { crumbs: [{ label: 'Receiving', href: go('ops/receiving', 'Expected') }, 'PUR-2610-0042'], sub: 'Halden Audio Distribution · ordered Sep 28 by Ken Watanabe · arrived 10:22 AM, dock 2 · received by Carlos Mendez', actions: btn('Print labels', { v: 'secondary', icon: 'printer', size: 'sm' }) })}
      ${steps(['Check in', 'Count lines', 'Record issues', 'Put away', 'Make available'], 2)}
      <div class="ac-main">
        <div class="stack gap-4">
          <div class="row between"><h2 class="h3">Lines</h2><span class="xs muted">3 lines · 260 expected · 258 received</span></div>
          <div class="ac-lines">${LINES.map((l, i) => {
            const short = l.exp - l.rec;
            return `<article class="ac-line ${l.cls}">
              <div class="row gap-3 nowrap" style="align-items:flex-start">${pimg(l.p, 'thumb')}<span class="stack gap-0 grow"><span class="small strong">${l.name}</span><span class="xs mono muted">${l.sku}</span></span>
                ${short ? badge(`Short ${short}`, 'warning', 'triangle-alert') : l.dmg ? badge(`${l.dmg} damaged`, 'danger', 'circle-alert') : badge('Matches', 'success', 'check')}</div>
              <div class="ac-line-nums">
                ${field('Expected', `<input class="input ac-qty" id="rc-exp-${i}" value="${l.exp}" readonly>`)}
                ${field('Received', `<input class="input ac-qty" id="rc-rec-${i}" type="number" value="${l.rec}">`)}
                ${field('Damaged', `<input class="input ac-qty" id="rc-dmg-${i}" type="number" value="${l.dmg}">`)}
                ${field('Put-away bin', `<input class="input ac-loc" id="rc-loc-${i}" value="${l.loc}">`)}
              </div>
              ${short ? `<div class="panel xs sub row gap-2">${icon('triangle-alert', 'ic-sm')}<span>2 units short. Purchasing is told automatically and raises a supplier claim. Shortage stays on the purchase record.</span></div>` : ''}
              ${l.dmg ? `<div class="stack gap-2"><span class="xs strong">Damage photos (required)</span><div class="ac-photos">
                ${['Crushed carton', 'Cracked headband', 'Dented case'].map((c) => `<div class="ac-photo">${img('image', 'var(--img-2)')}<span class="xs muted">${c}</span></div>`).join('')}
                <div class="ac-photo">${btn('Add photo', { v: 'secondary', size: 'sm', icon: 'camera', block: true })}</div>
              </div><span class="xs muted">Damaged units go to Damaged or held. They are not offered for sale.</span></div>` : ''}
            </article>`;
          }).join('')}</div>
          ${field('Receiving note', U.textarea('rc-note', 'Pallet 2 outer wrap torn. 3 Silver units with crushed cartons photographed. Black count 118 confirmed by second count.'), { opt: true })}
        </div>
        <div class="stack gap-5">
          ${card({
            title: 'Make available for sale', sub: 'Inventory Manager confirms the sellable quantity',
            body: `${sumRow('Received', '258 units')}
              ${sumRow('Damaged or held', '−3 units')}
              ${sumRow('Shortage reported to Purchasing', '2 units')}
              <div class="divider"></div>
              <div class="row between base"><span class="small strong">Sellable now</span><span class="ac-big">${sell}</span></div>
              ${U.kv([['HAL-AUR-BLK', '118 → bin A-03-2'], ['HAL-AUR-SLV', '77 → bin A-03-4'], ['HAL-PKT-TEAL', '60 → bin B-11-1']])}
              ${alert('info', 'Stays in Incoming until confirmed', 'Customers cannot buy these units until Ana Silva confirms. HAL-AUR-SLV is out of stock now, so 6 waiting orders get allocated first.')}
              ${check('rc-confirm', 'I counted and checked these units. Ana Silva, Inventory Manager', true)}`,
            foot: btn('Save and finish later', { v: 'ghost', size: 'sm' }) + btn(`Make ${sell} units available`, { size: 'sm', icon: 'circle-check' }),
          })}
          ${card({
            title: 'Delivery record', body: U.kv([['Supplier', 'Halden Audio Distribution'], ['Purchase order', '<span class="mono">PUR-2610-0042</span>'], ['Carrier', 'Freight · BOL 77120-4418'], ['Expected', 'Today 10:00 AM – 12:00 PM'], ['Arrived', '10:22 AM, dock 2'], ['Buying cost', money(23540)]]),
          })}
        </div>
      </div>
    `, 'receiving');
  }

  register({
    id: 'ops/receiving', title: 'Receiving', ref: 'Plan ch. 9, 2',
    notes: 'Expected purchase deliveries and the receiving flow for one PUR: expected vs received quantity, shortages, damaged units with photos and put-away bins. Stock becomes sellable only when the Inventory Manager confirms it.',
    states: ['Expected', 'Receiving PUR-2610-0042'],
    render: (st) => (st === 'Receiving PUR-2610-0042' ? receivingOne() : receivingList()),
  });

  /* ======================================================================
     OPS 9 · Pick and pack (handheld-friendly)
     ====================================================================== */
  const PICK = [
    { ref: 'MK-261008-12544', by: 'Ship by 2:00 PM', tone: 'warning', lines: [['A-03-2', D.P.aurora, 'Halden Aurora ANC Headphones, Black', 'HAL-AUR-BLK', 1, 'done'], ['C-07-1', D.P.pourover, 'Mosswood Pour-over Coffee Set, Cream', 'MSW-PO-CRM', 1, 'now']] },
    { ref: 'MK-261008-12610', by: 'Ship by 2:00 PM', tone: 'warning', lines: [['D-02-3', D.P.skillet, 'Pellar Cast Iron Skillet 26 cm', 'PLR-CI26', 2, '']] },
    { ref: 'MK-261008-12688', by: 'Ship by 4:00 PM', tone: 'ok', lines: [['E-01-4', D.P.serum, 'Aster Daily Vitamin C Serum 30 ml', 'AST-VC30', 1, ''], ['F-12-3', D.P.sweater, 'Nordvik Merino Crew, L, Navy', 'NDV-MER-L-NVY', 1, 'short']] },
    { ref: 'MK-261008-12702', by: 'Ship by 4:00 PM', tone: 'ok', lines: [['C-04-1', D.P.lamp, 'Brightline Smart LED Desk Lamp', 'BRL-LAMP-W', 1, '']] },
  ];

  function pickList() {
    return opsLayout(`
      ${pageHead('Pick and pack', { sub: 'Wave 3 · 27 Official Store orders · UPS pickup 4:00 PM · marketplace sellers pack their own orders', actions: seg([{ label: 'Pick list', href: go('ops/pick-pack', 'Pick list') }, { label: 'Packing station', href: go('ops/pick-pack', 'Packing station') }], 0) })}
      <label class="ac-scan" for="pp-scan">${icon('scan-barcode', 'ic-lg')}<span class="sr-only">Scan bin or item barcode</span><input id="pp-scan" type="text" placeholder="Scan bin or item barcode" autocomplete="off"></label>
      <div class="stack gap-2"><div class="row between small"><span class="strong">11 of 27 orders picked</span><span class="muted">Next bin <b class="mono">C-07-1</b></span></div>${meter(41)}</div>
      ${alert('warning', 'Shortage reported on MK-261008-12688', 'Bin F-12-3 was empty for NDV-MER-L-NVY. Ana Silva is checking Returned stock. The order stays in the wave; do not pack it partly.')}
      <div class="grid lg2" style="--gap:var(--sp-4)">
        ${PICK.map((o) => {
          const done = o.lines.filter((l) => l[5] === 'done').length;
          return `<section class="card">
            <div class="card-head"><div class="stack gap-0"><a class="mono strong" href="${go('ops/pick-pack', 'Packing station')}">${o.ref}</a><span class="xs muted">${o.lines.length} ${o.lines.length > 1 ? 'items' : 'item'} · ${done} picked</span></div>${deadline(o.by, o.tone)}</div>
            <div class="card-body ac-hand" style="gap:0">
              ${o.lines.map(([bin, p, name, sku, q, st]) => `<div class="ac-pick ${st === 'done' ? 'is-done' : st === 'short' ? 'is-short' : ''}">
                <span class="ac-bin">${bin}</span>
                <span class="stack gap-0 grow"><span class="small strong">${name}</span><span class="xs mono muted">${sku}</span>
                  ${st === 'done' ? `<span class="xs t-success-text strong row gap-1">${icon('circle-check', 'ic-sm')}Picked 10:02 AM</span>` : st === 'short' ? `<span class="xs t-warning-text strong row gap-1">${icon('triangle-alert', 'ic-sm')}Shortage reported</span>` : st === 'now' ? '<span class="xs t-brand-text strong">Scan this item next</span>' : ''}</span>
                <span class="q" aria-label="Quantity ${q}">×${q}</span>
              </div>`).join('')}
            </div>
            <div class="card-foot">${btn('Report shortage', { v: 'ghost', size: 'sm', icon: 'package-x' })}${btn('Report damaged item', { v: 'ghost', size: 'sm', icon: 'circle-alert' })}</div>
          </section>`;
        }).join('')}
      </div>
      <div class="ac-handbar only-phone">${btn('Report problem', { v: 'secondary', icon: 'flag' })}${btn('Confirm pick', { icon: 'check' })}</div>
    `, 'pick-pack');
  }

  function packStation() {
    return opsLayout(`
      ${pageHead('Packing station 2', { crumbs: [{ label: 'Pick and pack', href: go('ops/pick-pack', 'Pick list') }, 'MK-261008-12544'], sub: 'Order MK-261008-12544 · Package 1 of 2 · Official Store items only', actions: seg([{ label: 'Pick list', href: go('ops/pick-pack', 'Pick list') }, { label: 'Packing station', href: go('ops/pick-pack', 'Packing station') }], 1) })}
      <label class="ac-scan" for="pk-scan">${icon('scan-barcode', 'ic-lg')}<span class="sr-only">Scan item to confirm</span><input id="pk-scan" type="text" placeholder="Scan each item to confirm" autocomplete="off"></label>
      ${alert('info', 'Mixed order', 'This order also has Package 2 of 2 from Pixel & Port. They ship it separately. Your packing slip lists only Official Store items.')}
      <div class="ac-main">
        <div class="stack gap-5">
          ${card({
            title: 'Items to pack', sub: '2 of 2 scanned',
            body: `<div class="ac-hand" style="display:flex;flex-direction:column">
              ${[[D.P.aurora, 'Halden Aurora ANC Headphones, Black', 'HAL-AUR-BLK', 1], [D.P.pourover, 'Mosswood Pour-over Coffee Set, Cream', 'MSW-PO-CRM', 1]].map(([p, n, sku, q]) => `<div class="ac-pick">${pimg(p, 'thumb')}<span class="stack gap-0 grow"><span class="small strong">${n}</span><span class="xs mono muted">${sku}</span><span class="xs t-success-text strong row gap-1">${icon('circle-check', 'ic-sm')}Scanned</span></span><span class="q">×${q}</span></div>`).join('')}
            </div>`,
            foot: btn('Report shortage', { v: 'ghost', size: 'sm', icon: 'package-x' }) + btn('Report damaged item', { v: 'ghost', size: 'sm', icon: 'circle-alert' }),
          })}
          ${card({
            title: 'Package',
            body: `<div class="ac-fgrid">
                ${field('Box size', select('pk-box', ['S box · 10 × 8 × 4 in', 'M box · 14 × 10 × 6 in', 'L box · 18 × 14 × 8 in', 'Padded mailer'], 'M box · 14 × 10 × 6 in'), { hint: 'Suggested from item dimensions' })}
                ${field('Weight', input('pk-wt', '3.4', { suffix: 'lb · from scale' }))}
                ${field('Carrier service', select('pk-svc', ['UPS Ground · arrives Tue, Oct 13', 'UPS 2nd Day Air · arrives Mon, Oct 12'], 'UPS Ground · arrives Tue, Oct 13'), { hint: 'Matches the delivery option the customer chose' })}
                ${field('Tracking number', input('pk-trk', '1Z84E2W70392104418', { readonly: true }), { hint: 'Created with the label' })}
              </div>
              ${check('pk-fragile', 'Fragile: ceramic item, use paper fill', true)}`,
          })}
        </div>
        <div class="stack gap-5">
          ${card({
            title: 'Packing slip', actions: btn('Print', { v: 'ghost', size: 'sm', icon: 'printer' }),
            body: `<div class="ac-slip">
              <div class="row between">${U.logo()}<span class="xs mono">MK-261008-12544</span></div>
              <span class="xs muted">Package 1 of 2 · Sold and shipped by Marketly Official</span>
              <div class="stack gap-1"><span class="small strong">Ship to</span><span class="small">Sam Rivera<br>4127 Fremont Ave N<br>Seattle, WA 98103</span></div>
              <div class="divider"></div>
              ${sumRow('Halden Aurora ANC Headphones, Black', '1')}
              ${sumRow('Mosswood Pour-over Coffee Set, Cream', '1')}
              <div class="divider"></div>
              <span class="xs sub">Returns: 30 days from delivery. Start a return from your order page. Package 2 ships separately from Pixel &amp; Port.</span>
            </div>`,
          })}
          ${card({
            title: 'Carrier label', body: `<div class="row gap-3 nowrap">${img('barcode', 'var(--img-1)', 'thumb')}<span class="stack gap-0"><span class="small strong">UPS Ground</span><span class="xs mono">1Z84E2W70392104418</span><span class="xs muted">4x6 label · printer PS-2</span></span></div>`,
            foot: btn('Reprint label', { v: 'ghost', size: 'sm', icon: 'printer' }) + btn('Mark as packed', { size: 'sm', icon: 'package-check' }),
          })}
        </div>
      </div>
      <div class="ac-handbar only-phone">${btn('Print label', { v: 'secondary', icon: 'printer' })}${btn('Mark as packed', { icon: 'package-check' })}</div>
    `, 'pick-pack');
  }

  register({
    id: 'ops/pick-pack', title: 'Pick and pack', ref: 'Plan ch. 9, 12',
    notes: 'Warehouse handheld flow for Official Store orders: pick list grouped by order with bin locations and a scan field, then a packing station with item checklist, box and weight, carrier label and packing slip. Shortage and damage can be reported at every step.',
    states: ['Pick list', 'Packing station'],
    render: (st) => (st === 'Packing station' ? packStation() : pickList()),
  });

  /* ======================================================================
     OPS 10 · Dispatch and delivery exceptions
     ====================================================================== */
  const A = {
    notify: () => btn('Notify seller', { v: 'ghost', size: 'sm', icon: 'bell' }),
    esc: () => btn('Escalate to Seller Manager', { v: 'ghost', size: 'sm', icon: 'arrow-up-right' }),
    claim: () => btn('Open carrier claim', { v: 'ghost', size: 'sm', icon: 'file-plus' }),
    cust: () => btn('Contact customer', { v: 'ghost', size: 'sm', icon: 'message-square' }),
    cancel: () => btn('Cancel item and refund', { v: 'ghost', size: 'sm', icon: 'circle-x' }),
    track: () => btn('Request tracking', { v: 'ghost', size: 'sm', icon: 'scan-line' }),
  };
  const DISPATCH = {
    'Seller cannot fulfill': {
      need: 'Flag the affected items, notify the customer and apply the cancellation and refund policy.', count: 3,
      rows: [
        ['MK-261007-10512', 'trailhead', 'Corvo Swift Trail Running Shoes, size 10', 'Yes · Oct 8, 8:12 AM', 'Cancel item, refund $112.00', 'Theo Grant', ['Refund by today 5:00 PM', 'warning'], ['cancel', 'cust', 'esc']],
        ['MK-261008-11204', 'pixelport', 'Kestrel 1 TB Portable SSD × 2 of 2', 'No', 'Notify customer, offer other seller', 'Theo Grant', ['Notify by 12:00 PM', 'danger'], ['cust', 'cancel']],
        ['MK-261006-08870', 'casaverde', 'Mosswood Linen Duvet Cover, King', 'Yes · Oct 7', 'Cancel item, refund $149.00', 'Isabel Cruz', ['Refund sent, confirm', 'ok'], ['cust']],
      ],
    },
    'Late dispatch': {
      need: 'Create an overdue task, notify the seller and offer customer support escalation.', count: 9,
      rows: [
        ['MK-260914-48213', 'casaverde', 'Mosswood Washed Linen Duvet Cover, Queen', 'Yes · Oct 5', 'Seller performance action', 'Grace Kim', ['Overdue 16 d', 'danger'], ['cust', 'cancel']],
        ['MK-261006-09977', 'gadgetgrove', 'Brightline S2 Robot Vacuum', 'Yes · Oct 8, 8:00 AM', 'Escalate, seller restricted', 'Theo Grant', ['Overdue 1 d', 'danger'], ['esc', 'cust']],
        ['MK-261007-10388', 'pixelport', 'Kestrel K75 Wireless Keyboard', 'No', 'Notify seller and customer', 'Theo Grant', ['Overdue 5 h', 'danger'], ['notify', 'cust']],
        ['MK-261007-10433', 'northwind', 'Halden Pocket Bluetooth Speaker × 1', 'No', 'Notify seller', 'Theo Grant', ['Overdue 3 h', 'danger'], ['notify', 'cust']],
        ['MK-261007-10120', 'official', 'Halden Aurora ANC Headphones, Silver', 'Not yet', 'Allocate incoming stock, pack', 'Ana Silva', ['Due in 1 h', 'warning'], ['cust']],
      ],
    },
    'Missing tracking': {
      need: 'Request valid details and avoid implying the package has been delivered.', count: 4,
      rows: [
        ['MK-261005-07711', 'trailhead', 'Trailhead Ridge 40 L Backpack · USPS number not recognized', 'Yes · Oct 7', 'Request valid tracking', 'Theo Grant', ['Overdue 3 d', 'danger'], ['track', 'esc']],
        ['MK-261006-08345', 'northwind', 'Halden Aurora ANC Headphones · marked shipped, no number', 'No', 'Request tracking number', 'Theo Grant', ['Details due 2:00 PM', 'warning'], ['track', 'notify']],
        ['MK-261007-09530', 'gadgetgrove', 'Brightline S2 Robot Vacuum · label created, no scan 36 h', 'No', 'Confirm handover to carrier', 'Theo Grant', ['Due 4:00 PM', 'warning'], ['track', 'esc']],
        ['MK-261007-09102', 'official', 'Pellar Cast Iron Skillet · label voided and reprinted', 'Not needed', 'Attach new tracking', 'Ana Silva', ['Due 12:00 PM', 'ok'], []],
      ],
    },
    'Lost or damaged': {
      need: 'Open a case with the item, carrier information and agreed customer remedy.', count: 3,
      rows: [
        ['MK-260929-30126', 'pixelport', 'Kestrel 27" 4K Monitor · USPS no scan for 9 days', 'Yes · Oct 6', 'Remedy: refund $329.00 (Finance)', 'Theo Grant', ['Decide by Oct 9', 'warning'], ['claim', 'cust']],
        ['MK-261001-33019', 'official', 'Pellar Cast Iron Skillet × 2 · UPS damaged in transit', 'Yes · Oct 6', 'Replacement shipped, claim open', 'Theo Grant', ['Claim reply Oct 13', 'ok'], ['cust']],
        ['MK-261003-35501', 'trailhead', 'Tidewell Insulated Bottle · dented on arrival', 'Yes · Oct 7', 'Seller sends replacement', 'Isabel Cruz', ['Seller reply by 3:00 PM', 'warning'], ['notify', 'claim']],
      ],
    },
    'Delivery failed': {
      need: 'Show next delivery, pickup or return steps and any applicable costs.', count: 2,
      rows: [
        ['MK-261004-36620', 'official', 'Brightline Smart LED Desk Lamp · UPS: address not found', 'Yes · Oct 8, 7:30 AM', 'Pickup at UPS Access Point by Oct 14, no cost', 'Theo Grant', ['Customer reply by Oct 10', 'ok'], ['cust']],
        ['MK-261002-34018', 'casaverde', 'Mosswood Linen Duvet Cover · returning after 3 attempts', 'No', 'Offer reship for $8.99 or refund', 'Theo Grant', ['Notify by 1:00 PM', 'danger'], ['cust', 'notify']],
      ],
    },
  };
  const SITS = Object.keys(DISPATCH);
  const SIT_IC = { 'Seller cannot fulfill': 'package-x', 'Late dispatch': 'alarm-clock', 'Missing tracking': 'scan-line', 'Lost or damaged': 'package-minus', 'Delivery failed': 'house' };
  const CLAIMS = [
    ['UPS-CLM-88412', 'UPS', 'MK-261001-33019', 116.00, 'Oct 6', 'Under review', 'Theo Grant'],
    ['USPS-CLM-4410', 'USPS', 'MK-260929-30126', 329.00, 'Oct 7', 'Submitted', 'Pixel & Port (seller files)'],
    ['FDX-CLM-20931', 'FedEx', 'MK-260925-27760', 289.00, 'Sep 28', 'Paid', 'Theo Grant'],
    ['UPS-CLM-87960', 'UPS', 'MK-260919-21455', 58.00, 'Sep 22', 'Rejected', 'Theo Grant'],
  ];

  function dispatchPage(sit) {
    const d = DISPATCH[sit];
    return opsLayout(`
      ${pageHead('Dispatch and delivery exceptions', { sub: 'Official Store and marketplace orders that are late, unclear or failed. Shipping owns these; seller problems go to the Seller Manager when performance action is needed.', actions: btn('Export', { v: 'secondary', icon: 'download', size: 'sm' }) })}
      <div class="grid md3 lg5" style="--gap:var(--sp-2)">${SITS.map((s) => queueTile(DISPATCH[s].count, s, { tone: s === 'Late dispatch' || s === 'Lost or damaged' ? 'danger' : 'warning', sub: s === sit ? 'Showing now' : 'Open tab', href: go('ops/dispatch', s) })).join('')}</div>
      ${tabs(SITS.map((s) => ({ label: s, count: DISPATCH[s].count, href: go('ops/dispatch', s), icon: SIT_IC[s] })), sit)}
      <div class="panel row gap-3 nowrap" style="align-items:flex-start">${icon('clipboard-list')}<span class="stack gap-0"><span class="small strong">Required response: ${sit}</span><span class="small sub">${d.need}</span></span></div>
      ${sit === 'Missing tracking' ? alert('info', 'Customers see "Shipped, tracking pending"', 'The order page does not show In transit or Delivered until the carrier confirms a scan.') : ''}
      <div class="toolbar">
        ${searchIn('Search order, seller or tracking number', 'dp-q')}
        <label class="sr-only" for="dp-seller">Seller</label>${select('dp-seller', ['All sellers', 'Official Store', 'Marketplace sellers'], 'All sellers')}
        <label class="sr-only" for="dp-owner">Owner</label>${select('dp-owner', ['All owners', 'Theo Grant', 'Ana Silva', 'Isabel Cruz', 'Grace Kim'], 'All owners')}
        ${U.check('dp-notn', 'Customer not notified', false)}
      </div>
      ${card({
        title: sit, sub: `${d.count} open · showing ${d.rows.length}`, flush: true,
        body: both(table(['Order', 'Seller', 'Item and situation', 'Customer notified', 'Required response', 'Owner', 'Deadline', 'Actions'], d.rows.map((r) => [
          ref(r[0], go('admin/order')), sellerTag(r[1]), `<span class="small" style="display:block;min-width:200px">${r[2]}</span>`,
          r[3] === 'No' ? badge('Not notified', 'danger', 'bell-off') : r[3].startsWith('Yes') ? `<span class="stack gap-0">${badge('Notified', 'success', 'check')}<span class="xs muted nowrap">${r[3].slice(6)}</span></span>` : `<span class="xs muted">${r[3]}</span>`,
          `<span class="small" style="display:block;min-width:160px">${r[4]}</span>`, `<span class="small nowrap">${r[5]}</span>`, deadline(r[6][0], r[6][1]),
          `<div class="ac-acts" style="min-width:180px">${r[7].map((k) => A[k]()).join('') || '<span class="xs muted">No action needed</span>'}</div>`,
        ]), { rowCls: d.rows.map((r) => (r[6][1] === 'danger' ? 'is-flagged' : r[6][1] === 'warning' ? 'is-warn' : '')) }),
        d.rows.map((r) => ({ cls: r[6][1] === 'danger' ? 'is-flagged' : r[6][1] === 'warning' ? 'is-warn' : '', title: ref(r[0], go('admin/order')), right: deadline(r[6][0], r[6][1]), lines: [`${D.sellers[r[1]].name}${D.sellers[r[1]].official ? ' · Official' : ' · Marketplace'}`, r[2], `Customer notified: ${r[3]} · Owner ${r[5]}`, `<b>${r[4]}</b>`], foot: r[7].slice(0, 2).map((k) => A[k]()).join('') }))),
      })}
      ${card({
        title: 'Carrier claims', sub: 'Claims over $1,000 need Finance approval', flush: true,
        actions: btn('Open carrier claim', { v: 'secondary', size: 'sm', icon: 'file-plus' }),
        body: both(table(['Claim', 'Carrier', 'Order', { label: 'Amount', cls: 'r' }, 'Filed', 'Status', 'Owner'], CLAIMS.map((c) => [`<span class="mono small">${c[0]}</span>`, c[1], ref(c[2], go('admin/order')), money(c[3]), c[4], status(c[5], c[5] === 'Under review' ? 'info' : c[5] === 'Submitted' ? 'info' : c[5] === 'Paid' ? 'success' : 'danger'), `<span class="small">${c[6]}</span>`])),
          CLAIMS.map((c) => ({ title: `<span class="mono">${c[0]}</span>`, right: status(c[5], c[5] === 'Paid' ? 'success' : c[5] === 'Rejected' ? 'danger' : 'info'), lines: [`${c[1]} · ${money(c[3])} · filed ${c[4]}`, `Order <span class="mono">${c[2]}</span> · ${c[6]}`] }))),
      })}
    `, 'dispatch');
  }

  register({
    id: 'ops/dispatch', title: 'Dispatch and delivery exceptions', ref: 'Plan ch. 12, 17',
    notes: 'One tab per exception from the plan (cannot fulfill, late, missing tracking, lost or damaged, failed delivery), each with its required response. Rows show seller type, whether the customer was notified, owner and deadline, with actions to notify, escalate, claim or contact.',
    states: ['Late dispatch', 'Seller cannot fulfill', 'Missing tracking', 'Lost or damaged', 'Delivery failed'],
    render: (st) => dispatchPage(DISPATCH[st] ? st : 'Late dispatch'),
  });

  /* ======================================================================
     OPS 11 · Return inspection
     ====================================================================== */
  const RQ = [
    ['RT-261004-0197', 'MK-260926-29004', D.P.skillet, 'Pellar Cast Iron Skillet 26 cm', 'Defective: cracked', 'Oct 6', 'Carlos Mendez', 'Returned', ['Overdue 1 d', 'danger']],
    ['RT-261005-0212', 'MK-260928-30551', D.P.aurora, 'Halden Aurora ANC Headphones, Black', 'No longer needed', 'Oct 7', 'Carlos Mendez', 'Inspecting', ['Inspect by Oct 9', 'warning']],
    ['RT-261006-0226', 'MK-261001-32870', D.P.serum, 'Aster Daily Vitamin C Serum 30 ml', 'Skin reaction, opened', 'Oct 8', 'Unassigned', 'Returned', ['Inspect by Oct 12', 'ok']],
    ['RT-261006-0230', 'MK-260930-31207', D.P.sweater, 'Nordvik Merino Crew, M, Navy', 'Wrong size', 'Oct 8', 'Unassigned', 'Returned', ['Inspect by Oct 12', 'ok']],
    ['RT-261002-0175', 'MK-260924-26618', D.P.lamp, 'Brightline Smart LED Desk Lamp', 'Not as described', 'Oct 5', 'Carlos Mendez', 'Decision made', ['Refund with Finance', 'ok']],
    ['RT-261003-0188', 'MK-260914-48213', D.P.pourover, 'Mosswood Pour-over Coffee Set, Cream', 'Arrived chipped', 'Arriving Oct 9', '—', 'Return in transit', ['Not received', 'ok']],
  ];

  function rqList() {
    return opsLayout(`
      ${pageHead('Return inspection', { sub: 'Official Store returns received at Reno, NV. Warehouse inspects, Inventory records the stock outcome, Finance approves the refund.', actions: btn('Export', { v: 'secondary', icon: 'download', size: 'sm' }) })}
      <div class="ac-kpis">
        <div class="card pad">${stat('Waiting for inspection', '4', { note: 'target 2 business days' })}</div>
        <div class="card pad">${stat('Overdue', '1', { note: 'RT-261004-0197' })}</div>
        <div class="card pad">${stat('Arriving this week', '7', { note: 'tracked separately from deliveries' })}</div>
        <div class="card pad">${stat('Refunds with Finance', '3', { note: money(412.0) + ' proposed' })}</div>
      </div>
      ${tabs([{ label: 'Received', count: 5 }, { label: 'Arriving', count: 7 }, { label: 'Decided this week', count: 18 }], 0)}
      ${card({
        title: 'Return queue', flush: true,
        body: both(table(['Return', 'Item', 'Reason', 'Received', 'Inspector', 'Status', 'Target', ''], RQ.map((r) => [
          `<span class="stack gap-0">${ref(r[0], r[0] === 'RT-261005-0212' ? go('ops/return-inspection', 'Inspecting RT-261005-0212') : null)}<span class="xs mono muted">${r[1]}</span></span>`,
          `<div class="cell-main">${pimg(r[2], 'tiny')}<span class="small">${r[3]}</span></div>`, `<span class="small">${r[4]}</span>`, `<span class="small nowrap">${r[5]}</span>`, `<span class="small nowrap">${r[6]}</span>`, status(r[7]), deadline(r[8][0], r[8][1]),
          r[7] === 'Returned' || r[7] === 'Inspecting' ? btn(r[7] === 'Inspecting' ? 'Continue' : 'Inspect', { size: 'sm', v: r[7] === 'Inspecting' ? 'primary' : 'secondary', href: go('ops/return-inspection', 'Inspecting RT-261005-0212') }) : '',
        ]), { rowCls: RQ.map((r) => (r[8][1] === 'danger' ? 'is-flagged' : r[8][1] === 'warning' ? 'is-warn' : '')) }),
        RQ.map((r) => ({ cls: r[8][1] === 'danger' ? 'is-flagged' : r[8][1] === 'warning' ? 'is-warn' : '', title: ref(r[0], go('ops/return-inspection', 'Inspecting RT-261005-0212')), right: status(r[7]), lines: [r[3], `${r[4]} · received ${r[5]}`, deadline(r[8][0], r[8][1])] }))),
      })}
    `, 'return-inspection');
  }

  function rqInspect() {
    const OUT = [
      ['Restock as new', 'Only for sealed, unused items', false, true],
      ['Repair', 'Send to Halden service partner, 10 business days', false, false],
      ['Sell as different condition', 'Used – Like new offer HAL-AUR-BLK-LN at $159.00', true, false],
      ['Return to supplier', 'Halden Audio Distribution, return authorization needed', false, false],
      ['Write off', 'Not sellable. Records the cost as a return loss.', false, false],
    ];
    return opsLayout(`
      ${pageHead('Inspecting RT-261005-0212', { crumbs: [{ label: 'Return inspection', href: go('ops/return-inspection', 'Queue') }, 'RT-261005-0212'], sub: 'Order MK-260928-30551 · Halden Aurora ANC Headphones, Black · reason: No longer needed · received Oct 7 by Carlos Mendez', actions: status('Inspecting') })}
      <div class="ac-main">
        <div class="stack gap-5">
          ${card({
            title: 'Photos', sub: '4 taken at the inspection bench',
            body: `<div class="ac-photos">${['Front, headband', 'Ear cushions', 'Accessories laid out', 'Box and seal'].map((c, i) => `<div class="ac-photo">${img(['headphones', 'headphones', 'cable', 'package-open'][i], 'var(--img-2)')}<span class="xs muted">${c}</span></div>`).join('')}</div>
              ${U.dropzone('Add more photos', 'JPG or PNG from the bench camera')}`,
          })}
          ${card({
            title: 'Condition',
            body: `<div class="grid md2" style="--gap:var(--sp-2)">
                ${optCard('rq-cond', 'rq-c1', '<span class="small strong">New, sealed</span>', 'Factory seal intact', false)}
                ${optCard('rq-cond', 'rq-c2', '<span class="small strong">Like new, opened</span>', 'No marks, works fully', true)}
                ${optCard('rq-cond', 'rq-c3', '<span class="small strong">Good, light wear</span>', 'Small marks, works fully', false)}
                ${optCard('rq-cond', 'rq-c4', '<span class="small strong">Damaged or not working</span>', 'Needs repair or write-off', false)}
              </div>
              <span class="small strong">Contents and checks</span>
              <div class="ac-perm">
                ${check('rq-k1', 'USB-C charging cable', true)}
                ${check('rq-k2', '3.5 mm audio cable', true)}
                ${check('rq-k3', 'Carry case', false)}
                ${check('rq-k4', 'Serial number matches order (HA24-0918-7731)', true)}
                ${check('rq-k5', 'Powers on, pairs, noise cancelling works', true)}
                ${check('rq-k6', 'No odor, hygiene OK', true)}
              </div>
              ${alert('warning', 'Missing part: carry case', 'Customer did not mention it in the return request. Lena Park, Returns Manager, decides whether a deduction applies.')}`,
          })}
          ${card({
            title: 'Outcome', sub: 'Proposed by the inspector, decided by the Returns Manager',
            body: `<div class="stack gap-2">${OUT.map(([t, b, sel, dis], i) => optCard('rq-out', `rq-o${i}`, `<span class="small strong">${t}</span>`, b, sel, { disabled: dis })).join('')}</div>
              <div class="well stack gap-2"><span class="small strong">Stock outcome, recorded by Inventory</span>${U.kv([['Movement', ba('Returned · 1 unit', 'Available · Used – Like new')], ['SKU', '<span class="mono">HAL-AUR-BLK-LN</span> · bin R-01-3'], ['Recorded by', 'Ana Silva, Inventory Manager · waiting']])}</div>`,
          })}
        </div>
        <div class="stack gap-5">
          ${card({
            title: 'Proposed refund', sub: 'Sent to Finance for approval',
            body: `${sumRow('Item price', money(189))}
              ${sumRow('Original shipping', money(0))}
              ${sumRow('Missing carry case', '−' + money(15))}
              ${sumRow('Return shipping label (change of mind)', '−' + money(0))}
              <div class="divider"></div>
              ${sumRow('Proposed refund', money(174), 'total')}
              ${ex('Example deduction for missing accessories, per the returns policy.')}
              ${field('Reason for deduction', U.textarea('rq-why', 'Carry case missing from return. Accessory value $15.00 per Halden price list.'))}
              <div class="panel xs sub stack gap-1"><span>${icon('landmark', 'ic-sm')} Finance approver: <b>Priya Nair</b>, refunds up to $2,000</span><span>Refund to Visa •••• 2203 within 5 business days after approval.</span></div>
              ${alert('info', 'Approved is not paid', 'The customer sees "Refund under review" now, "Approved" after Finance, and "Sent" only when the payment provider confirms.')}`,
            foot: btn('Save inspection', { v: 'ghost', size: 'sm' }) + btn('Send to Finance', { size: 'sm', icon: 'send' }),
          })}
          ${card({
            title: 'Return record',
            body: timeline([
              { t: 'Return requested', d: 'Oct 2 · Jordan Lee', state: 'done', body: '"Opened, used once. Prefer over-ear."' },
              { t: 'Return approved', d: 'Oct 2 · automatic, within 30 days', state: 'done' },
              { t: 'Received at Reno, NV', d: 'Oct 7, 2:14 PM · UPS 1Z84E2W70392096631', state: 'done' },
              { t: 'Inspection', d: 'Today · Carlos Mendez', state: 'current' },
              { t: 'Refund decision', d: 'Finance · Priya Nair', state: '' },
            ]),
          })}
        </div>
      </div>
    `, 'return-inspection');
  }

  register({
    id: 'ops/return-inspection', title: 'Return inspection', ref: 'Plan ch. 13, 9, 2',
    notes: 'Returns received at the Reno warehouse and the inspection of one return: photos, condition grade, missing parts, and an outcome of restock, repair, different condition, return to supplier or write-off. Inventory records the stock outcome and Finance approves the proposed refund.',
    states: ['Queue', 'Inspecting RT-261005-0212'],
    render: (st) => (st === 'Inspecting RT-261005-0212' ? rqInspect() : rqList()),
  });

  /* ======================================================================
     OPS 12 · Daily finance checks
     ====================================================================== */
  const sdiff = (n) => (n === 0 ? '<span class="muted">$0.00</span>' : `<span class="${n < 0 ? 'ac-diff-neg' : 'ac-diff-pos'}">${n < 0 ? '−' : '+'}${money(Math.abs(n))}</span>`);
  const FC = {
    pay: [
      ['MK-261007-41022', 'Visa •••• 9012', 1850.0, 1580.0, '1 d', 'Mismatch', 'Possible duplicate capture'],
      ['MK-261006-37110', 'Mastercard •••• 5521', 96.15, 104.15, '2 d', 'Mismatch', 'Coupon applied after authorization'],
      ['MK-261007-39876', 'PayPal', 312.4, 312.4, '1 d', 'Matched', 'Matched after payment retry'],
    ],
    seller: [
      ['Pixel & Port', 'ST-2610-PP-02', 4212.6, 4182.6, '1 d', 'Mismatch', 'Fee charged on shipping'],
      ['Casa Verde Home', 'ST-2610-CV-02', 2045.0, 1805.0, '3 d', 'Mismatch', 'Post-payout refund deducted twice'],
      ['Northwind Audio', 'ST-2610-NA-02', 3118.2, 3118.2, '1 d', 'Matched', ''],
    ],
    cb: [
      ['CB-261005-0019', 'MK-260921-18833', 'Trailhead Outfitters', 139.0, 'Item not received', 'Oct 12', 'Chargeback'],
      ['CB-261007-0022', 'MK-260930-24410', 'Marketly Official', 329.0, 'Unauthorized transaction', 'Oct 15', 'Disputed'],
    ],
    po: [
      ['PO-261002-0311', 'Trailhead Outfitters', 2904.18, 'Bank rejected: account closed', '6 d', 'Request new payout details'],
      ['PO-261002-0316', 'Gadget Grove', 611.4, 'Account name does not match', '6 d', 'Held: seller restricted'],
    ],
  };

  register({
    id: 'ops/finance-checks', title: 'Daily finance checks', ref: 'Plan ch. 14, 18',
    notes: 'Priya Nair’s daily reconciliation: payments vs orders, seller amounts vs statements, chargebacks, failed payouts and unexplained amounts, each with amount, age and Mismatch or Matched status. Corrections need a recorded reason and high-value ones a second reviewer.',
    render: () => opsLayout(`
      ${pageHead('Daily finance checks', { sub: 'Assigned to Priya Nair, Finance Manager · backup Morgan Hale · checking Wed, Oct 7 settlement · due 12:00 PM PT', actions: btn('Export', { v: 'secondary', icon: 'download', size: 'sm' }) + btn('Complete day check', { icon: 'circle-check', size: 'sm', disabled: true }) })}
      <div class="ac-main">
        <div class="stack gap-5">
          <div class="ac-kpis">
            <div class="card pad">${stat('Open mismatches', '5', { note: money(578.0) + ' net difference' })}</div>
            <div class="card pad">${stat('Chargebacks and disputes', '2', { note: money(468) + ' at risk' })}</div>
            <div class="card pad">${stat('Failed payouts', '2', { note: money(3515.58) })}</div>
            <div class="card pad">${stat('Unexplained', money(12.3), { note: 'processor deposit Oct 7' })}</div>
          </div>
          ${card({
            title: 'Payments vs orders', sub: 'Collected by the payment provider vs order totals', flush: true,
            body: both(table(['Order', 'Method', { label: 'Collected', cls: 'r' }, { label: 'Order total', cls: 'r' }, { label: 'Difference', cls: 'r' }, 'Age', 'Status', 'Note', ''], FC.pay.map((r) => [ref(r[0], go('admin/order')), `<span class="small nowrap">${r[1]}</span>`, money(r[2]), money(r[3]), sdiff(r[2] - r[3]), r[4], status(r[5]), `<span class="xs sub">${r[6]}</span>`, r[5] === 'Mismatch' ? btn('Record correction', { v: 'ghost', size: 'sm' }) : ''] ), { rowCls: FC.pay.map((r) => (r[5] === 'Mismatch' ? 'is-flagged' : '')) }),
              FC.pay.map((r) => ({ cls: r[5] === 'Mismatch' ? 'is-flagged' : '', title: ref(r[0]), right: status(r[5]), lines: [`Collected ${money(r[2])} · order ${money(r[3])} · ${sdiff(r[2] - r[3])}`, `${r[1]} · ${r[4]} · ${r[6]}`] }))),
          })}
          ${card({
            title: 'Seller amounts', sub: 'Statement amounts vs ledger', flush: true,
            body: both(table(['Seller', 'Statement', { label: 'Expected', cls: 'r' }, { label: 'Recorded', cls: 'r' }, { label: 'Difference', cls: 'r' }, 'Age', 'Status', 'Note'], FC.seller.map((r) => [`<span class="small strong">${r[0]}</span>`, `<span class="mono small">${r[1]}</span>`, money(r[2]), money(r[3]), sdiff(r[3] - r[2]), r[4], status(r[5]), `<span class="xs sub">${r[6] || '—'}</span>`]), { rowCls: FC.seller.map((r) => (r[5] === 'Mismatch' ? 'is-flagged' : '')) }),
              FC.seller.map((r) => ({ cls: r[5] === 'Mismatch' ? 'is-flagged' : '', title: r[0], right: status(r[5]), lines: [`<span class="mono">${r[1]}</span> · expected ${money(r[2])} · recorded ${money(r[3])}`, `${sdiff(r[3] - r[2])} · ${r[4]}${r[6] ? ' · ' + r[6] : ''}`] }))),
          })}
          ${card({
            title: 'Chargebacks and payment disputes', sub: 'A customer disputed the charge with their card provider', flush: true,
            body: both(table(['Case', 'Order', 'Seller', { label: 'Amount', cls: 'r' }, 'Reason', 'Response due', 'Status'], FC.cb.map((r) => [`<span class="mono small">${r[0]}</span>`, ref(r[1], go('admin/order')), `<span class="small">${r[2]}</span>`, money(r[3]), `<span class="small">${r[4]}</span>`, deadline(r[5], 'warning'), status(r[6])])),
              FC.cb.map((r) => ({ title: `<span class="mono">${r[0]}</span>`, right: status(r[6]), lines: [`${r[2]} · ${money(r[3])} · ${r[4]}`, `Response due ${r[5]}`] }))),
          })}
          ${card({
            title: 'Failed payouts', flush: true,
            body: both(table(['Payout', 'Seller', { label: 'Amount', cls: 'r' }, 'Failure', 'Age', 'Status', 'Next step'], FC.po.map((r) => [ref(r[0], go('admin/payouts')), `<span class="small strong">${r[1]}</span>`, money(r[2]), `<span class="small">${r[3]}</span>`, r[4], status('Failed'), `<span class="small">${r[5]}</span>`]), { rowCls: ['is-flagged', 'is-flagged'] }),
              FC.po.map((r) => ({ cls: 'is-flagged', title: `<span class="mono">${r[0]}</span>`, right: status('Failed'), lines: [`${r[1]} · ${money(r[2])} · ${r[4]}`, r[3], `Next: ${r[5]}`] }))) + `<div class="card-foot" style="justify-content:flex-start"><span class="xs muted">Funds stay in the seller's Available balance until a new payout succeeds. New bank details need verification and a 72-hour review.</span></div>`,
          })}
          ${card({
            title: 'Unexplained amounts', flush: true,
            body: both(table(['Item', { label: 'Expected', cls: 'r' }, { label: 'Received', cls: 'r' }, { label: 'Difference', cls: 'r' }, 'Age', 'Status', 'Owner'], [['Processor deposit for Oct 7', money(84210.33), money(84198.03), sdiff(-12.3), '1 d', status('Mismatch'), 'Priya Nair']], { rowCls: ['is-flagged'] }),
              [{ cls: 'is-flagged', title: 'Processor deposit for Oct 7', right: status('Mismatch'), lines: [`Expected ${money(84210.33)} · received ${money(84198.03)} · ${sdiff(-12.3)}`] }]),
          })}
        </div>
        <div class="stack gap-5">
          ${card({
            title: "Today's checklist", sub: '2 of 6 done',
            body: `${meter(33)}<ul>
              ${ck('done', 'Processor deposit received', 'Done 8:05 AM · 1 unexplained difference logged')}
              ${ck('done', 'Chargebacks reviewed', 'Done 9:20 AM · 2 responses scheduled')}
              ${ck('now', 'Payments matched to orders', '2 mismatches open')}
              ${ck('', 'Seller amounts match statements', '2 mismatches open')}
              ${ck('late', 'Failed payouts followed up', '2 open for 6 days')}
              ${ck('', 'Unexplained amounts explained', '1 open')}
            </ul>`,
          })}
          ${card({
            title: 'Record correction', sub: 'MK-261007-41022 · collected $270.00 more than the order total',
            body: `${field('Correction', select('fc-type', ['Refund duplicate capture to customer', 'Adjust order total', 'Write off difference'], 'Refund duplicate capture to customer'))}
              ${field('Amount', input('fc-amt', '270.00', { prefix: '$' }))}
              ${field('Reason (required)', select('fc-reason', ['Choose a reason', 'Duplicate capture by payment provider', 'Coupon applied after authorization', 'Fee calculation error', 'Other, explained in note'], 'Duplicate capture by payment provider'))}
              ${field('Note', U.textarea('fc-note', 'Processor log shows two captures 4 seconds apart after a retry. Customer charged twice for the shipping upgrade.'))}
              ${alert('warning', 'Second reviewer required', 'Corrections over $200 need a second Finance reviewer. This goes to Morgan Hale, Business Owner.')}
              ${ex('Example threshold set by the Business Owner.')}`,
            foot: btn('Send for second review', { size: 'sm', icon: 'send' }),
          })}
        </div>
      </div>
    `, 'finance-checks'),
  });
})();
