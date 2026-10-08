/* Admin Center · Dashboard (plan ch. 18) */
(function () {
  const { register, adminLayout, pageHead, card, stat, lineChart, legend, splitBar, queueTile, table, status, deadline, btn, seg, go, icon, badge, money, avatar } = UI;
  const D = window.D;

  UI.css('admin-dash', `
    .ad-kpis { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 1024px) { .ad-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .ad-main { display: grid; gap: 20px; grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1180px) { .ad-main { grid-template-columns: minmax(0, 1fr) 360px; } }
    .ad-queues { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) and (max-width: 1179px) { .ad-queues { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `);

  const s = D.sales14;
  const k = (v) => '$' + v.toFixed(0) + 'k';
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const off = sum(s.official.slice(-7)), sel = sum(s.sellers.slice(-7));
  const share = Math.round((off / (off + sel)) * 100);

  register({
    id: 'admin/dashboard', title: 'Admin dashboard', ref: 'Plan ch. 18–19',
    notes: 'Summary first: company vs marketplace sales, then the queues that break promises if ignored (overdue dispatch, cases past target, failed payouts). Every tile links to its work queue.',
    render: () => adminLayout(`
      ${pageHead('Good morning, Riley', { sub: 'Thursday, Oct 8, 2026 · figures through 9:40 AM PT · gross sales by order placement date', actions: seg(['Today', '7 days', '30 days'], 1) + btn('Export', { v: 'secondary', icon: 'download', size: 'sm' }) })}

      <div class="ad-kpis">
        <div class="card pad">${stat('Gross sales', '$' + (off + sel).toFixed(1) + 'k', { delta: '8.2%', dir: 'up', note: 'vs prior 7 days' })}</div>
        <div class="card pad">${stat('Orders', '3,418', { delta: '5.6%', dir: 'up', note: 'avg $71.20' })}</div>
        <div class="card pad">${stat('Marketplace fee income', '$10.9k', { note: 'on $' + sel.toFixed(1) + 'k seller sales' })}</div>
        <div class="card pad">${stat('Refunds', '$6.1k', { delta: '0.4 pts', dir: 'down', note: '2.1% of gross' })}</div>
      </div>

      <div class="ad-main">
        <div class="stack gap-5">
          ${card({
            title: 'Sales split', sub: 'Last 14 days · USD',
            actions: `<a class="small strong" href="${go('admin/reports')}">Open report</a>`,
            body: `${legend(['Official Store', 'Marketplace sellers'])}
              ${lineChart({ labels: s.labels, series: [{ name: 'Official', data: s.official }, { name: 'Sellers', data: s.sellers }], height: 230, fmt: k, label: 'Daily sales, Official Store vs marketplace sellers' })}
              <div class="stack gap-2"><div class="row between xs sub"><span>Official Store ${share}% · $${off.toFixed(1)}k</span><span>Sellers ${100 - share}% · $${sel.toFixed(1)}k</span></div>${splitBar(share, 100 - share)}</div>`,
          })}

          ${card({
            title: 'Overdue and at-risk dispatch', sub: '9 items past their dispatch deadline',
            actions: btn('Open dispatch queue', { v: 'secondary', size: 'sm', href: go('ops/dispatch') }),
            flush: true,
            body: table(['Order', 'Seller', 'Item', 'Deadline', 'Owner', ''], [
              [`<a class="mono" href="${go('admin/order')}">MK-261007-10433</a>`, 'Northwind Audio', 'Halden Pocket Speaker', deadline('Overdue 3 h', 'danger'), 'Seller', btn('Remind', { v: 'ghost', size: 'sm' })],
              [`<a class="mono" href="${go('admin/order')}">MK-260914-48213</a>`, 'Casa Verde Home', 'Linen Duvet Cover, Queen', deadline('Overdue 16 d', 'danger'), 'Grace Kim', btn('Escalate', { v: 'ghost', size: 'sm' })],
              [`<a class="mono" href="${go('admin/order')}">MK-261007-10120</a>`, 'Marketly Official', 'Kestrel 27" Monitor', deadline('Due in 1 h', 'warning'), 'Warehouse', btn('View', { v: 'ghost', size: 'sm' })],
              [`<a class="mono" href="${go('admin/order')}">MK-261006-09977</a>`, 'Gadget Grove', 'S2 Robot Vacuum', deadline('Overdue 1 d', 'danger'), 'Seller', btn('Remind', { v: 'ghost', size: 'sm' })],
            ], { rowCls: ['is-flagged', 'is-flagged', 'is-warn', 'is-flagged'] }),
          })}

          <div class="grid lg2" style="--gap:20px">
            ${card({
              title: 'Advertising today', sub: '3 live · 2 starting this week',
              actions: `<a class="small strong" href="${go('admin/ads')}">Manage</a>`,
              flush: true,
              body: `<ul class="list pad">
                <li><span class="grow stack gap-0"><span class="small strong">Home Week opening ad</span><span class="xs muted">Full-screen · once per session · ends Oct 19</span></span>${status('Live')}</li>
                <li><span class="grow stack gap-0"><span class="small strong">Halden Aurora banner</span><span class="xs muted">Home banner · sponsored · $1,240 of $3,000</span></span>${status('Live')}</li>
                <li><span class="grow stack gap-0"><span class="small strong">Free shipping pop-up</span><span class="xs muted">Pop-up · new visitors · starts Oct 10</span></span>${status('Scheduled')}</li>
              </ul>`,
            })}
            ${card({
              title: 'Next payout run', sub: 'Friday, Oct 9 · 10:00 AM PT',
              actions: `<a class="small strong" href="${go('admin/payouts')}">Review</a>`,
              body: `<div class="row between base"><span class="h2 num">${money(78420.55)}</span><span class="small muted">41 sellers</span></div>
                <ul class="list">
                  <li><span class="grow small">Ready to pay</span><span class="small strong num">38</span></li>
                  <li><span class="grow small">Held for review</span><span class="row gap-2">${badge('3', 'warning')}</span></li>
                  <li><span class="grow small">Failed last run</span><span class="row gap-2">${badge('2', 'danger')}</span></li>
                </ul>
                ${UI.alert('warning', 'Second review needed', 'Runs over $50,000 need approval from a second Finance reviewer.')}`,
            })}
          </div>
        </div>

        <div class="stack gap-5">
          ${card({
            title: 'Needs attention', sub: 'Queues past or near their targets',
            body: `<div class="ad-queues">
              ${queueTile(9, 'Overdue dispatch', { tone: 'danger', sub: 'Order & Shipping', href: go('ops/dispatch') })}
              ${queueTile(5, 'Cases past response target', { tone: 'danger', sub: 'Customer Support', href: go('admin/cases') })}
              ${queueTile(2, 'Failed payouts', { tone: 'danger', sub: 'Finance', href: go('admin/payouts') })}
              ${queueTile(3, 'Payment mismatches', { tone: 'warning', sub: 'Daily finance check', href: go('ops/finance-checks') })}
              ${queueTile(12, 'Low stock, Official Store', { tone: 'warning', sub: 'Inventory', href: go('ops/inventory') })}
              ${queueTile(23, 'Products awaiting review', { sub: 'Catalog · oldest 2 days', href: go('admin/product-review') })}
              ${queueTile(7, 'Seller applications', { sub: 'Seller Manager', href: go('admin/seller-application') })}
              ${queueTile(4, 'Trust and risk reports', { sub: 'Counterfeit, fake reviews', href: go('admin/trust') })}
              ${queueTile(14, 'Returns to decide', { sub: 'Returns Manager', href: go('admin/returns') })}
            </div>`,
          })}
          ${card({
            title: 'Team on shift', sub: 'Leads and backups',
            flush: true,
            body: `<ul class="list pad">${[['Theo Grant', 'Orders & Shipping', 'Lead'], ['Isabel Cruz', 'Customer Support', 'Lead'], ['Priya Nair', 'Finance', 'Lead'], ['Ana Silva', 'Inventory & Warehouse', 'Backup for Theo']].map(([n, a, r]) => `<li>${avatar(n)}<span class="grow stack gap-0"><span class="small strong">${n}</span><span class="xs muted">${a}</span></span><span class="xs muted">${r}</span></li>`).join('')}</ul>`,
          })}
        </div>
      </div>
    `, 'dashboard'),
  });
})();
