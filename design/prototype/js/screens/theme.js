/* Theme · design system reference (foundations, components, patterns) */
(function () {
  const U = UI;
  const D = window.D;

  U.css('theme', `
    .th-page { padding-block: 24px 64px; display: flex; flex-direction: column; gap: 40px; }
    .th-sec { display: flex; flex-direction: column; gap: 16px; }
    .th-sec > header { display: flex; flex-direction: column; gap: 4px; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    .th-swatches { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 768px) { .th-swatches { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    @container app (min-width: 1100px) { .th-swatches { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
    .th-sw { border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; background: var(--surface); }
    .th-sw .chipc { height: 64px; border-bottom: 1px solid var(--border); }
    .th-sw .meta { padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
    .th-sw .meta b { font-size: 12px; }
    .th-type { display: grid; gap: 4px 24px; grid-template-columns: minmax(0, 1fr); align-items: baseline; }
    @container app (min-width: 768px) { .th-type { grid-template-columns: 180px minmax(0, 1fr); } }
    .th-type .spec { font-size: 12px; color: var(--text-3); font-family: var(--font-mono); }
    .th-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
    .th-box { background: var(--brand-soft); border: 1px dashed var(--brand); height: 24px; }
    .th-bp { display: grid; gap: 8px; }
    .th-bp > div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 12px; align-items: center; font-size: 13px; }
    .th-bp .bar { height: 26px; border-radius: 6px; background: var(--surface-3); display: flex; align-items: center; padding: 0 10px; font-size: 12px; color: var(--text-2); }
    .th-demo { border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; background: var(--bg); position: relative; }
    .th-demo-cap { font-size: 12px; color: var(--text-3); }
  `);

  const page = (body) => `<div class="container th-page">${body}</div>`;
  const sec = (title, sub, body) => `<section class="th-sec"><header><h2 class="h2">${title}</h2>${sub ? `<p class="small sub" style="max-width:80ch">${sub}</p>` : ''}</header>${body}</section>`;

  const COLORS = [
    ['Surfaces', [['bg', '#F5F7F6', '#0D1412', 'Page background'], ['surface', '#FFFFFF', '#141D1A', 'Cards, sheets, header'], ['surface-2', '#EFF3F1', '#1A2521', 'Subtle fills, table header'], ['surface-3', '#E3E9E6', '#22302B', 'Tracks, neutral badges'], ['border', '#DAE2DE', '#2A3833', 'Dividers, card edges'], ['border-strong', '#BFCAC5', '#3B4C46', 'Inputs, outlines']]],
    ['Text', [['text', '#13201C', '#E7EEEB', 'Primary text'], ['text-2', '#44514C', '#B6C3BE', 'Secondary text'], ['text-3', '#5F6C67', '#8F9D98', 'Captions, meta (AA on white)']]],
    ['Brand · sea green', [['brand', '#0B6E5F', '#3CC2A6', 'Primary buttons, active nav'], ['brand-hover', '#085A4E', '#5BD3BA', 'Hover / pressed'], ['brand-soft', '#E2F1ED', '#12332C', 'Selected rows, Official panels'], ['brand-text', '#08604F', '#63D6BD', 'Links, brand text'], ['on-brand', '#FFFFFF', '#04201A', 'Text on brand fill']]],
    ['Deal · warm orange (prices and promotions only)', [['deal', '#C2410C', '#F07A3E', 'Discount badges, sale fills'], ['deal-soft', '#FFF0E6', '#3A2015', 'Deal sections'], ['deal-text', '#B03A09', '#FF9C66', 'Sale prices']]],
    ['Status (always with icon or label)', [['success', '#157A3F', '#4FCB82', 'Delivered, paid, approved'], ['warning', '#9A5A06', '#EDB04F', 'Delayed, held, needs info'], ['danger', '#B42318', '#FF7E72', 'Failed, overdue, suspended'], ['info', '#1F5BC4', '#82AAFF', 'In progress, verified seller'], ['star', '#D98E04', '#F0B23A', 'Ratings']]],
    ['Charts (validated for colour-blind readers)', [['chart-1', '#0F8A73', '#25A587', 'Official Store series'], ['chart-2', '#C77F14', '#BD7C1C', 'Marketplace sellers series']]],
  ];

  U.register({
    id: 'theme/foundations', title: 'Foundations', ref: 'design/tokens.json',
    notes: 'Colour, type, spacing, radius, elevation, breakpoints and icons. Values come from tokens.json, which also feeds the future Android theme. Toggle light/dark at the top right to see both palettes.',
    render: () => page(`
      <div class="stack gap-3">
        <span class="eyebrow">${U.BRAND} design system · v0.1</span>
        <h1 class="display d-xl">One calm green, one warm orange, and a lot of clear grey.</h1>
        <p class="lead" style="max-width:70ch">The store is busy by nature: many sellers, prices and delivery promises. The palette stays quiet so that seller identity, totals and dates read first. Orange appears only where money is saved.</p>
      </div>
      ${COLORS.map(([g, list]) => sec(g, '', `<div class="th-swatches">${list.map(([n, l, d, use]) => `<div class="th-sw"><div class="chipc" style="background:var(--${n})"></div><div class="meta"><b>--${n}</b><span class="mono">${l} · ${d}</span><span class="muted">${use}</span></div></div>`).join('')}</div>`)).join('')}

      ${sec('Typography', 'Bricolage Grotesque for store display headings, used sparingly. Figtree for every interface element. IBM Plex Mono for order references, SKUs and tracking numbers.', `
        <div class="th-type">
          <span class="spec">display-lg · 38/1.1 · 700</span><span class="display d-xl">Autumn Home Week</span>
          <span class="spec">display-md · 30/1.15 · 700</span><span class="display d-lg">Sold and shipped by ${U.BRAND}</span>
          <span class="spec">title-lg · 24/1.2 · 700</span><span class="h1">Order details</span>
          <span class="spec">title-md · 20/1.25 · 700</span><span class="h2">Package 2 of 3</span>
          <span class="spec">title-sm · 17/1.35 · 600</span><span class="h3">Delivery address</span>
          <span class="spec">body · 15/1.5 · 400</span><span>Arrives Thu, Oct 15. Free returns within 30 days of delivery.</span>
          <span class="spec">body-sm · 13/1.45 · 400</span><span class="small sub">Ships from Portland, OR. Seller responds within 24 hours.</span>
          <span class="spec">label · 13/1.3 · 600</span><span class="label">Card number</span>
          <span class="spec">caption · 12/1.35 · 500</span><span class="xs muted">Updated 9:40 AM PT</span>
          <span class="spec">overline · 11 · 700 · +0.08em</span><span class="eyebrow">Seller Center</span>
          <span class="spec">code · 13 · Plex Mono</span><span class="mono">MK-260914-48213 · SKU HAL-AUR-BLK</span>
          <span class="spec">price · tabular</span><span>${U.price(189, 229, { lg: true })}</span>
        </div>`)}

      ${sec('Spacing, radius and elevation', '4 px base grid. Cards use radius-lg; inputs and buttons radius-md; pills for chips and badges. Shadows only for floating layers.', `
        <div class="stack gap-2">${[['sp-1', 4], ['sp-2', 8], ['sp-3', 12], ['sp-4', 16], ['sp-5', 20], ['sp-6', 24], ['sp-7', 32], ['sp-8', 40], ['sp-9', 48], ['sp-10', 64]].map(([n, v]) => `<div class="row gap-3 nowrap"><span class="mono xs" style="width:70px">--${n}</span><span class="th-box" style="width:${v}px"></span><span class="xs muted">${v}px</span></div>`).join('')}</div>
        <div class="th-row">${[['xs', 4], ['sm', 6], ['md', 10], ['lg', 14], ['xl', 20], ['pill', 999]].map(([n, v]) => `<div class="stack gap-1" style="align-items:center"><span style="width:72px;height:56px;background:var(--surface);border:1px solid var(--border-strong);border-radius:${v}px"></span><span class="xs mono">r-${n}</span></div>`).join('')}</div>
        <div class="th-row">${[1, 2, 3].map((n) => `<div class="stack gap-1" style="align-items:center"><span style="width:120px;height:72px;background:var(--surface);border-radius:14px;box-shadow:var(--sh-${n})"></span><span class="xs mono">sh-${n}</span></div>`).join('')}</div>`)}

      ${sec('Breakpoints', 'Mobile first. Below 768 px the store becomes the Android app layout: bottom tab bar, app bars on sub-pages, sticky action bars, and no website footer, promo strip or breadcrumbs. Back-office screens collapse the sidebar into a scrollable section bar.', `
        <div class="th-bp">
          <div><span class="mono xs">0–767</span><span class="bar" style="width:30%">Phone · Android app · 1–2 columns</span></div>
          <div><span class="mono xs">768–1023</span><span class="bar" style="width:55%">Tablet · 3 product columns · top navigation</span></div>
          <div><span class="mono xs">1024–1279</span><span class="bar" style="width:78%">Desktop · sidebars appear · 4 product columns</span></div>
          <div><span class="mono xs">1280+</span><span class="bar" style="width:100%">Wide · 5 product columns · max content 1240 px</span></div>
        </div>`)}

      ${sec('Icons', 'Lucide outline icons at 1.75 stroke. Web: lucide-react. Android: the same icons as vector drawables. Icons never replace a text label on primary actions.', `
        <div class="th-row">${['house', 'layout-grid', 'tag', 'shopping-cart', 'user-round', 'search', 'heart', 'truck', 'package', 'undo-2', 'badge-check', 'shield-check', 'store', 'wallet', 'message-square', 'bell', 'life-buoy', 'megaphone', 'boxes', 'chart-column', 'settings', 'clock', 'triangle-alert', 'circle-check'].map((n) => `<span class="stack gap-1" style="align-items:center;width:84px"><span class="card" style="width:48px;height:48px;display:flex;align-items:center;justify-content:center">${U.icon(n, 'ic-lg')}</span><span class="xs muted truncate" style="max-width:84px">${n}</span></span>`).join('')}</div>`)}
    `),
  });

  U.register({
    id: 'theme/components', title: 'Components', ref: 'design/prototype/ui.css',
    notes: 'The building blocks every screen uses. Each maps to one React component in the web app and one Compose component in the Android app.',
    render: () => page(`
      ${sec('Buttons', 'One primary action per view. Minimum 44 px tall for touch. Deal buttons only inside promotions.', `
        <div class="th-row">${U.btn('Add to cart', { icon: 'shopping-cart' })}${U.btn('Buy now', { v: 'secondary' })}${U.btn('Save for later', { v: 'soft' })}${U.btn('Cancel', { v: 'ghost' })}${U.btn('Remove', { v: 'danger-soft', icon: 'trash-2' })}${U.btn('Suspend seller', { v: 'danger' })}${U.btn('Claim deal', { v: 'deal', icon: 'zap' })}${U.btn('View order', { v: 'link', iconR: 'arrow-right' })}</div>
        <div class="th-row">${U.btn('Large', { size: 'lg' })}${U.btn('Default')}${U.btn('Small', { size: 'sm' })}${U.btn('', { v: 'secondary', icon: 'heart', label: 'Save' })}${U.btn('Disabled', { disabled: true })}</div>`)}

      ${sec('Form controls', 'Labels sit above fields. Hints explain, errors say what to fix. Every field has an id.', `
        <div class="grid md2 lg3" style="--gap:20px">
          ${U.field('Full name', U.input('c-name', 'Jordan Lee'))}
          ${U.field('Email', U.input('c-email', 'jordan.lee@exmple', { error: true }), { error: 'Check the domain. Did you mean example.com?' })}
          ${U.field('Price', U.input('c-price', '189.00', { prefix: '$' }), { hint: 'Before shipping. Fees are taken from this amount.' })}
          ${U.field('Condition', U.select('c-cond', ['New', 'Used – Like new', 'Used – Good', 'Refurbished'], 'New'))}
          ${U.field('Search', U.input('c-search', '', { icon: 'search', placeholder: 'Order number or product' }))}
          ${U.field('Note to seller', U.textarea('c-note', '', 'Leave at the side door, please.'), { opt: true })}
        </div>
        <div class="th-row">${U.check('c-c1', 'Email me order updates', true)}${U.check('c-c2', 'Send me deals and promotions')}${U.radio('c-r', 'c-r1', 'Ship to home', true)}${U.radio('c-r', 'c-r2', 'Ship to work')}${U.toggle('c-t1', 'Price drop alerts', true)}${U.qty(2)}</div>
        <div class="grid md2" style="--gap:12px">
          ${U.optCard('c-ship', 'c-s1', '<span class="row between"><span class="strong">Standard · Thu, Oct 15</span><span class="strong">Free</span></span>', 'UPS Ground. Ships today from Reno, NV.', true)}
          ${U.optCard('c-ship', 'c-s2', '<span class="row between"><span class="strong">Express · Tue, Oct 13</span><span class="strong">$12.99</span></span>', 'UPS 2nd Day Air.', false)}
        </div>
        <div class="th-row">${['Midnight black', 'Stone', 'Sage'].map((v, i) => `<button type="button" class="pill-opt${i === 0 ? ' is-selected' : ''}">${v}</button>`).join('')}<button type="button" class="pill-opt is-unavailable" aria-disabled="true">Coral</button></div>`)}

      ${sec('Badges and status', 'Every status in the plan has one fixed colour. Colour never stands alone: the word is always there.', `
        <div class="stack gap-3">${[
          ['Seller identity', [U.badge('Official Store', 'brand', 'badge-check'), U.badge('Verified seller', 'info', 'shield-check'), U.sponsored(), U.badge('−17%', 'deal'), U.badge('Limited time', 'deal-soft', 'clock')]],
          ['Order and item', ['New', 'Confirmed', 'Preparing', 'Delayed', 'Shipped', 'In transit', 'Delivered', 'Partly delivered', 'Cancelled', 'Overdue'].map((s) => U.status(s))],
          ['Payment and refund', ['Accepted', 'Pending', 'Checking', 'Failed', 'Refunded', 'Requested', 'Under review', 'Approved', 'Processing', 'Sent'].map((s) => U.status(s))],
          ['Product review & publication', ['Draft', 'Submitted', 'Changes requested', 'Approved', 'Rejected', 'Active', 'Hidden', 'Suspended'].map((s) => U.status(s))],
          ['Seller account', ['Applied', 'Information required', 'Under review', 'Approved', 'Restricted', 'Suspended', 'Closed'].map((s) => U.status(s))],
          ['Stock groups', ['Available', 'Reserved', 'Incoming', 'Damaged', 'Held', 'Returned'].map((s) => U.status(s))],
          ['Payouts', ['Pending', 'Processing', 'Paid', 'Failed', 'On hold', 'Negative'].map((s) => U.status(s))],
          ['Ad campaigns', ['Draft', 'In review', 'Approved', 'Scheduled', 'Live', 'Paused', 'Finished', 'Archived'].map((s) => U.status(s))],
          ['Cases', ['Open', 'Waiting on seller', 'Escalated', 'Decision made', 'Appealed', 'Resolved', 'Reopened'].map((s) => U.status(s))],
        ].map(([t, list]) => `<div class="row top gap-3"><span class="xs strong muted" style="width:190px;padding-top:3px">${t}</span><span class="row gap-2 grow">${list.join('')}</span></div>`).join('')}</div>`)}

      ${sec('Product card', 'Image, name, rating, price, and a delivery cue. Discounts show the struck price. "From" prices belong to one eligible offer.', `
        <div class="grid-products">${['aurora', 'kestrel27', 'duvet', 'serum'].map((id, i) => U.productCard(D.P[id], { sponsored: i === 1, showSeller: true, from: true })).join('')}</div>`)}

      ${sec('Alerts, toasts, empty states', '', `
        <div class="grid md2" style="--gap:12px">
          ${U.alert('info', 'Packages may arrive separately', 'This order ships from 3 sellers. Each package has its own tracking.')}
          ${U.alert('success', 'Refund sent', '$36.00 to Visa •••• 4417. Banks usually post it within 5 business days.')}
          ${U.alert('warning', 'Price changed', 'Kestrel 1 TB SSD is now $99.99 (was $94.99). Review before you pay.')}
          ${U.alert('danger', 'Payment declined', 'Your bank declined the charge. Try another card or contact your bank.')}
        </div>
        <div class="row gap-3"><span class="toast">${U.icon('circle-check')} Added to cart</span><span class="toast">${U.icon('undo-2')} Return request sent</span></div>
        <div class="card">${U.empty('package-search', 'No orders match these filters', 'Try a wider date range or clear the status filter.', U.btn('Clear filters', { v: 'secondary' }))}</div>`)}

      ${sec('Navigation', 'Tabs for views of one list, segmented controls for modes, chips for filters, steppers for linear tasks.', `
        ${U.tabs([{ label: 'New', count: 4 }, { label: 'Preparing', count: 2 }, { label: 'Shipped', count: 18 }, { label: 'Completed' }], 0)}
        <div class="th-row">${U.seg(['List', 'Grid'], 0)}${U.seg(['Today', '7 days', '30 days'], 1)}</div>
        ${U.chips([{ label: 'Brand: Halden', x: true, active: true }, { label: 'Under $200', x: true, active: true }, { label: 'Free delivery' }, { label: 'Official Store' }, { label: '4★ & up' }])}
        ${U.steps(['Sign in', 'Address', 'Delivery', 'Payment', 'Review'], 2)}
        ${U.crumbs([{ label: 'Electronics', href: '#' }, { label: 'Headphones', href: '#' }, 'Over-ear'])}
        <div class="grid md2" style="--gap:16px">
          <div class="card pad stack gap-3"><span class="row gap-2">${U.icon('monitor')}<span class="h4">Website: numbered pages</span></span><p class="xs muted">Tablet and desktop. Customers can jump to a page and keep their place when they come back.</p>${(() => { const h = U.pager(1, 12); return h.slice(h.indexOf('<nav')).replace('pager no-phone', 'pager'); })()}</div>
          <div class="card pad stack gap-3"><span class="row gap-2">${U.icon('smartphone')}<span class="h4">Android app: loads as you scroll</span></span><p class="xs muted">Phone. The next batch loads before the user reaches the end. Skeletons hold the space, so nothing jumps. A short note marks the end of the list.</p>${U.lazyLoad({ grid: true }).replace('only-phone', '')}${U.lazyLoad({ end: true }).replace('only-phone', '')}</div>
        </div>`)}

      ${sec('Progress and history', 'Order progress uses a segmented track; case and refund history uses a timeline.', `
        <div class="grid md2" style="--gap:24px">
          <div class="card pad stack gap-4">${U.track(['Ordered', 'Shipped', 'Out for delivery', 'Delivered'], 2)}${U.track(['Ordered', 'Preparing', 'Shipped', 'Delivered'], 2, { tone: 'warning' })}</div>
          <div class="card pad">${U.timeline([{ t: 'Refund sent', d: 'Oct 4, 2:10 PM · $36.00 to Visa •••• 4417', state: 'done' }, { t: 'Return inspected', d: 'Oct 3 · Condition: as described', state: 'done' }, { t: 'Waiting for bank', d: 'Usually 3–5 business days', state: 'current' }])}</div>
        </div>`)}

      ${sec('Tables', 'Back-office lists. Numbers are tabular and right-aligned. Rows that miss a promise carry a left severity stripe. Wide tables scroll inside their card.', `
        <div class="card">${U.table(['Order', 'Customer', { label: 'Items', cls: 'r' }, { label: 'Total', cls: 'r' }, 'Status', 'Dispatch by'], [
          ['<span class="mono">MK-261008-12077</span>', 'Sam R.', '2', U.money(118), U.status('New'), U.deadline('Today 5:00 PM', 'warning')],
          ['<span class="mono">MK-261007-10433</span>', 'Alex M.', '1', U.money(59), U.status('Preparing'), U.deadline('Overdue 3 h', 'danger')],
          ['<span class="mono">MK-261007-09811</span>', 'Chris T.', '1', U.money(190.99), U.status('Shipped'), U.deadline('Shipped Oct 8')],
        ].map((r) => r.map((c, i) => i === 2 || i === 3 ? `<span class="num">${c}</span>` : c)), { select: true, rowCls: ['', 'is-flagged', ''] }).replace(/<td class="">(<span class="num">)/g, '<td class="r">$1')}</div>`)}

      ${sec('Statistics and charts', 'Two-series charts compare the Official Store with marketplace sellers. Hover any point for exact values.', `
        <div class="grid md2 lg4" style="--gap:12px">${[['Gross sales', '$284.6k', '8.2%', 'up'], ['Orders', '3,418', '5.6%', 'up'], ['On-time dispatch', '96.4%', '0.8 pts', 'down'], ['Open cases', '31', '', '']].map(([a, b, c, d]) => `<div class="card pad">${U.stat(a, b, { delta: c, dir: d })}</div>`).join('')}</div>
        <div class="card pad stack gap-3">${U.legend(['Official Store', 'Marketplace sellers'])}${U.lineChart({ labels: D.sales14.labels, series: [{ name: 'Official', data: D.sales14.official }, { name: 'Sellers', data: D.sales14.sellers }], fmt: (v) => '$' + v.toFixed(0) + 'k' })}</div>`)}
    `),
  });

  U.register({
    id: 'theme/patterns', title: 'Patterns and layouts', ref: 'Plan ch. 3, 5, 16',
    notes: 'Recurring marketplace patterns: who sells and ships, delivery and total cost, ad labels, and the three layout shells (store, account, back office).',
    render: () => page(`
      ${sec('Seller identity on every offer', 'Product = the item. Offer = how one seller sells it. Every offer line names the seller, who ships it, the delivery date and the return terms.', `
        <div class="grid md2" style="--gap:16px">${D.auroraOffers.slice(0, 2).map((o) => { const s = D.sellers[o.seller]; return `<div class="card pad stack gap-2">
          <div class="row between">${U.price(o.price)}<span class="xs muted">${o.ship ? '+ ' + U.money(o.ship) + ' shipping' : 'Free shipping'}</span></div>
          <div class="row gap-2"><span class="small">Sold by <b>${s.name}</b></span>${U.sellerBadge(s, true)}</div>
          ${U.shipLine(`Arrives <b>${o.delivery}</b> · ${o.dispatch}`)}${U.shipLine(o.returns, 'undo-2')}${U.shipLine(o.warranty, 'shield-check')}</div>`; }).join('')}</div>`)}

      ${sec('Advertising labels', 'Paid placements carry “Sponsored” or “Ad”. Ads never cover checkout, payment results, tracking or returns.', `
        <div class="row gap-4">${U.sponsored()}<span class="badge t-outline">Ad</span>${U.badge('Official Store', 'brand', 'badge-check')}</div>`)}

      ${sec('Android app vs website', 'The phone layout is the Android app, not a shrunken website. Navigation comes from the app shell, never from page links at the bottom of a page.', `
        <div class="grid md2" style="--gap:16px">
          <div class="card pad stack gap-2"><span class="row gap-2">${U.icon('smartphone')}<span class="h4">Android app (phone)</span></span><ul class="ul small sub stack gap-1"><li>Bottom tab bar: Home, Categories, Deals, Cart, Account</li><li>App bar with back button on every sub-page</li><li>Sticky action bar for Add to cart, Checkout, Submit</li><li>Lists load more as you scroll; no page numbers</li><li>Help, policies, About, selling and app settings live in the Account tab</li><li>No footer, no promo strip, no breadcrumbs</li></ul></div>
          <div class="card pad stack gap-2"><span class="row gap-2">${U.icon('monitor')}<span class="h4">Website (tablet and desktop)</span></span><ul class="ul small sub stack gap-1"><li>Header with search, account, orders and cart</li><li>Category bar: Deals, Official Store, New arrivals, Brands</li><li>Breadcrumbs on catalogue pages</li><li>Footer with help, policies, selling and company links</li><li>Numbered pages on long lists</li><li>Account pages use a side menu on desktop</li></ul></div>
        </div>`)}

      ${sec('Layout shells', 'Three shells cover every screen. Switch the preview to Phone to see how each collapses.', `
        <div class="stack gap-2"><span class="th-demo-cap">Store shell · header, category bar, footer · phone: search bar + bottom tabs</span><div class="th-demo">${U.storeHeader({ nav: 'deals' })}${U.tabbar('home')}</div></div>
        <div class="stack gap-2"><span class="th-demo-cap">Back-office shell · sidebar, top bar · phone/tablet: section chips</span><div class="th-demo" style="height:260px;overflow:hidden">${U.sellerLayout(`${U.pageHead('Orders', { sub: 'Example content area' })}`, 'orders')}</div></div>`)}
    `),
  });
})();
