/* Customer Store · Purchase, Sign in, Help and policies, Seller entry (plan ch. 3, 6, 7, 10, 13, 17, 19) */
(function () {
  const U = UI;
  const D = window.D;
  const { go, esc, icon, btn, badge, money, pimg, card, alert, field, input, select, textarea, check, radio, optCard, sumRow, kv, timeline, steps, table, sellerBadge, logoTile, crumbs } = U;
  const P = D.P;
  const S = D.sellers;

  U.css('buy', `
    .buy-h1 { display: flex; align-items: baseline; gap: var(--sp-3); flex-wrap: wrap; }
    .buy-pkg { overflow: hidden; }
    .buy-pkg-head { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); align-items: center; justify-content: space-between; padding: var(--sp-3) var(--sp-4); background: var(--surface-2); border-bottom: 1px solid var(--border); }
    @container app (min-width: 768px) { .buy-pkg-head { padding: var(--sp-3) var(--sp-5); } }
    .buy-pkg-meta { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-4); font-size: var(--fs-xs); color: var(--text-2); }
    .buy-pkg-meta span { display: inline-flex; align-items: center; gap: 5px; }
    .buy-pkg-meta svg.lucide { width: 14px; height: 14px; color: var(--text-3); }
    .buy-item { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: var(--sp-2) var(--sp-3); padding: var(--sp-4); border-top: 1px solid var(--border); }
    .buy-item:first-of-type { border-top: 0; }
    @container app (min-width: 768px) { .buy-item { grid-template-columns: 96px minmax(0, 1fr) auto; gap: var(--sp-4); padding: var(--sp-4) var(--sp-5); } }
    .buy-item .imgph { width: 72px; }
    @container app (min-width: 768px) { .buy-item .imgph { width: 96px; } }
    .buy-item-side { grid-column: 2; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
    @container app (min-width: 768px) { .buy-item-side { grid-column: 3; flex-direction: column; align-items: flex-end; justify-content: flex-start; } }
    .buy-item.buy-item-chk { grid-template-columns: auto minmax(0, 1fr); }
    .buy-item.buy-item-chk .imgph { width: 56px; }
    .buy-item.is-unavail .imgph { opacity: .45; filter: grayscale(1); }
    .buy-item.is-unavail .buy-name { color: var(--text-3); }
    .buy-name { color: var(--text) !important; font-weight: 600; font-size: var(--fs-sm); line-height: 1.35; }
    .buy-acts { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-4); font-size: var(--fs-sm); }
    .buy-acts a, .buy-acts button { background: none; border: 0; padding: 0; color: var(--brand-text); font-weight: 600; cursor: pointer; font-size: var(--fs-sm); display: inline-flex; align-items: center; gap: 4px; }
    .buy-note { display: flex; gap: var(--sp-2); align-items: flex-start; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-xs); line-height: 1.45; background: var(--warning-soft); color: var(--text); }
    .buy-note > svg.lucide { width: 16px; height: 16px; color: var(--warning); margin-top: 1px; }
    .buy-note.t-danger { background: var(--danger-soft); } .buy-note.t-danger > svg.lucide { color: var(--danger); }
    .buy-note.t-info { background: var(--info-soft); } .buy-note.t-info > svg.lucide { color: var(--info); }
    .buy-note.t-success { background: var(--success-soft); } .buy-note.t-success > svg.lucide { color: var(--success); }
    .buy-strike { text-decoration: line-through; color: var(--text-3); }
    .buy-sum { display: flex; flex-direction: column; gap: var(--sp-2); }
    .buy-sum .sum-row.total { padding-top: var(--sp-3); border-top: 1px solid var(--border); margin-top: var(--sp-1); }
    .buy-sum .sum-row .sub { font-size: var(--fs-xs); }
    .buy-sec-n { width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: var(--fs-xs); font-weight: 700; background: var(--brand-soft); color: var(--brand-text); flex: none; }
    .buy-sec-n.is-done { background: var(--brand); color: var(--on-brand); }
    .buy-opts { display: grid; gap: var(--sp-2); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .buy-opts.c2 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .buy-mini { display: flex; gap: var(--sp-3); align-items: center; font-size: var(--fs-sm); }
    .buy-mini .imgph { width: 44px; }
    .buy-result-icon { width: 64px; height: 64px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: none; }
    .buy-result-icon svg.lucide { width: 30px; height: 30px; }
    .buy-result-icon.t-success { background: var(--success-soft); color: var(--success); }
    .buy-result-icon.t-danger { background: var(--danger-soft); color: var(--danger); }
    .buy-result-icon.t-warning { background: var(--warning-soft); color: var(--warning); }
    .buy-result-icon.t-info { background: var(--info-soft); color: var(--info); }
    .buy-narrow { max-width: 760px; width: 100%; margin-inline: auto; }
    .buy-change { border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
    .buy-change-head { display: flex; gap: var(--sp-3); align-items: flex-start; }
    .buy-change-head .imgph { width: 48px; }
    .buy-delta { display: inline-flex; gap: var(--sp-2); align-items: center; font-variant-numeric: tabular-nums; font-size: var(--fs-sm); font-weight: 600; }
    .buy-alt { border: 1px dashed var(--border-strong); border-radius: var(--r-md); padding: var(--sp-3); background: var(--surface-2); }
    .buy-ref { font-family: var(--font-mono); font-weight: 700; letter-spacing: 0.01em; }
    /* Auth */
    .buy-auth { width: 100%; max-width: 460px; margin-inline: auto; }
    .buy-auth .card-body { gap: var(--sp-4); padding: var(--sp-5); }
    @container app (min-width: 768px) { .buy-auth .card-body { padding: var(--sp-7); } }
    @container app (max-width: 767.98px) { .buy-auth > .card { border: 0; background: transparent; } .buy-auth .card-body { padding: 0; } }
    .buy-or { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-xs); color: var(--text-3); }
    .buy-or::before, .buy-or::after { content: ""; flex: 1; height: 1px; background: var(--border); }
    .buy-pass { display: flex; align-items: center; gap: var(--sp-2); min-height: var(--tap); padding: 0 var(--sp-2) 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-md); background: var(--surface); }
    .buy-pass:focus-within { outline: 2px solid var(--focus); outline-offset: -1px; }
    .buy-pass.is-error { border-color: var(--danger); box-shadow: 0 0 0 1px var(--danger); }
    .buy-pass .input { border: 0; padding: 0; min-height: 0; height: 40px; background: transparent; }
    .buy-pass .input:focus { outline: none; }
    .buy-rules { display: grid; gap: 6px; font-size: var(--fs-xs); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .buy-rules { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .buy-rules li { display: flex; gap: 6px; align-items: center; color: var(--text-3); }
    .buy-rules li.is-ok { color: var(--success); }
    .buy-rules svg.lucide { width: 14px; height: 14px; }
    .buy-code { display: flex; gap: var(--sp-2); justify-content: center; }
    .buy-code input { width: 46px; height: 56px; text-align: center; font-family: var(--font-mono); font-size: var(--fs-xl); font-weight: 700; border: 1px solid var(--border-strong); border-radius: var(--r-md); background: var(--surface); color: var(--text); }
    .buy-code input:focus { outline: 2px solid var(--focus); outline-offset: -1px; }
    /* Help */
    .buy-help-hero { background: var(--brand-soft); border-radius: var(--r-xl); padding: var(--sp-6) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); align-items: center; text-align: center; }
    @container app (min-width: 768px) { .buy-help-hero { padding: var(--sp-8); } }
    .buy-help-hero .search-in { width: 100%; max-width: 560px; display: flex; align-items: center; gap: var(--sp-2); height: 52px; padding: 0 var(--sp-4); border-radius: var(--r-pill); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-3); }
    .buy-help-hero .search-in input { flex: 1; border: 0; background: transparent; font: inherit; color: var(--text); min-width: 0; }
    .buy-help-hero .search-in input:focus { outline: none; }
    .buy-topics { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 768px) { .buy-topics { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .buy-topic { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4); border-radius: var(--r-lg); border: 1px solid var(--border); background: var(--surface); color: var(--text) !important; text-decoration: none !important; }
    .buy-topic:hover { border-color: var(--brand); }
    .buy-topic > svg.lucide { color: var(--brand-text); }
    .buy-order-pick { display: flex; gap: var(--sp-3); align-items: center; padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--border); color: var(--text) !important; text-decoration: none !important; }
    .buy-order-pick:first-child { border-top: 0; }
    .buy-order-pick:hover { background: var(--surface-2); }
    .buy-thumbs { display: flex; }
    .buy-thumbs .imgph { width: 40px; border: 2px solid var(--surface); }
    .buy-thumbs .imgph + .imgph { margin-left: -12px; }
    .buy-contact { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .buy-contact { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .buy-thread { display: flex; flex-direction: column; gap: var(--sp-4); }
    .buy-msg { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: var(--sp-3); }
    .buy-msg .bubble { border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--sp-3) var(--sp-4); background: var(--surface); display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); }
    .buy-msg.is-customer .bubble { background: var(--brand-soft); border-color: transparent; }
    .buy-msg.is-staff .bubble { border-left: 3px solid var(--info); }
    .buy-msg.is-seller .bubble { border-left: 3px solid var(--warning); }
    .buy-attach { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: var(--r-sm); background: var(--surface-2); font-size: var(--fs-xs); color: var(--text-2); }
    .buy-owner { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .buy-owner { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .buy-owner > div { padding: var(--sp-3) var(--sp-4); border-radius: var(--r-md); background: var(--surface-2); display: flex; flex-direction: column; gap: 4px; }
    .buy-steps-list { counter-reset: s; display: flex; flex-direction: column; gap: var(--sp-4); }
    .buy-steps-list > li { counter-increment: s; display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: var(--sp-3); }
    .buy-steps-list > li::before { content: counter(s); width: 32px; height: 32px; border-radius: 50%; background: var(--brand-soft); color: var(--brand-text); font-weight: 700; display: inline-flex; align-items: center; justify-content: center; font-size: var(--fs-sm); }
    /* Policy */
    .buy-policy { display: grid; gap: var(--sp-6); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1024px) { .buy-policy { grid-template-columns: 240px minmax(0, 1fr); } }
    .buy-meta-strip { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-5); padding: var(--sp-3) var(--sp-4); border-radius: var(--r-md); background: var(--surface-2); font-size: var(--fs-xs); color: var(--text-2); }
    .buy-meta-strip span { display: inline-flex; gap: 6px; align-items: center; }
    .buy-meta-strip svg.lucide { width: 14px; height: 14px; }
    /* Seller entry */
    .buy-sell-hero { border-radius: var(--r-xl); background: var(--text); color: var(--text-inverse); padding: var(--sp-6) var(--sp-5); display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 1024px) { .buy-sell-hero { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); padding: var(--sp-9) var(--sp-8); align-items: center; } }
    .buy-sell-hero .h-sub { color: var(--text-inverse); opacity: .8; }
    .buy-sell-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); }
    .buy-sell-stats > div { border-radius: var(--r-lg); padding: var(--sp-4); background: color-mix(in srgb, var(--text-inverse) 10%, transparent); display: flex; flex-direction: column; gap: 4px; }
    .buy-sell-stats b { font-size: var(--fs-2xl); font-variant-numeric: tabular-nums; }
    .buy-feature { display: flex; gap: var(--sp-3); align-items: flex-start; }
    .buy-feature > svg.lucide { color: var(--brand-text); margin-top: 2px; }
    .buy-faq details { border-top: 1px solid var(--border); padding: var(--sp-3) 0; }
    .buy-faq details:first-child { border-top: 0; }
    .buy-faq summary { cursor: pointer; font-weight: 600; font-size: var(--fs-sm); list-style: none; display: flex; justify-content: space-between; gap: var(--sp-3); }
    .buy-faq summary::-webkit-details-marker { display: none; }
    .buy-faq details p { margin-top: var(--sp-2); font-size: var(--fs-sm); color: var(--text-2); }
    .buy-indic { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .buy-indic { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .buy-indic > div { border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2); background: var(--surface); }
    .buy-agree { display: flex; flex-direction: column; }
    .buy-agree > div { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-3) 0; border-top: 1px solid var(--border); }
    .buy-agree > div:first-child { border-top: 0; }
  `);

  /* ---------------- Shared purchase data ---------------- */
  const CART = [
    {
      seller: 'official', pkg: 'Package 1 of 3', from: 'Reno, NV warehouse', eta: 'Arrives Wed, Oct 14', ship: 0, shipNote: 'Free over $35',
      items: [
        { p: 'aurora', variant: 'Midnight black', cond: 'New', qty: 1, price: 189.00, was: 229.00 },
        { p: 'pourover', variant: 'Cream', cond: 'New', qty: 1, price: 36.00 },
        { p: 'lamp', variant: 'White', cond: 'New', qty: 1, price: 42.00, unavailable: true },
      ],
    },
    {
      seller: 'northwind', pkg: 'Package 2 of 3', from: 'Portland, OR', eta: 'Arrives Thu, Oct 15', ship: 5.99, shipNote: 'Standard',
      items: [{ p: 'speaker', name: 'Halden Pocket Bluetooth Speaker, 2-pack', variant: 'Teal', cond: 'New', qty: 1, price: 99.99, oldPrice: 94.99 }],
    },
    {
      seller: 'casaverde', pkg: 'Package 3 of 3', from: 'Sacramento, CA', eta: 'Arrives Mon, Oct 19 – Tue, Oct 20', ship: 0, shipNote: 'Free',
      items: [{ p: 'duvet', variant: 'Queen · Sage', cond: 'New', qty: 1, price: 119.00, was: 149.00 }],
    },
  ];
  const RETURNS = { official: '30-day free returns. We pay return shipping.', northwind: '30-day returns. Buyer pays return shipping for change of mind.', casaverde: '30-day returns. Bedding must be unopened for change-of-mind returns.' };
  const SUBTOTAL = 443.99; // 189 + 36 + 99.99 + 119
  const SHIPPING = 5.99;
  const COUPON = 20.00;
  const TOTAL = SUBTOTAL - COUPON + SHIPPING; // 429.98
  const ORDER_REF = 'MK-261008-52190';
  const itemName = (it) => it.name || P[it.p].name;

  const pkgHead = (g, o = {}) => { const s = S[g.seller]; return `<div class="buy-pkg-head">
      <div class="row gap-2">${logoTile(s, '')}<div class="stack gap-0"><span class="row gap-2"><span class="strong">${esc(s.name)}</span>${sellerBadge(s, true)}</span><span class="xs muted">${g.pkg} · Ships from ${g.from}</span></div></div>
      <div class="buy-pkg-meta"><span>${icon('calendar-check')}${o.eta || g.eta}</span><span>${icon('truck')}${g.ship ? money(g.ship) + ' shipping' : 'Free shipping'}${!g.ship && g.shipNote && g.shipNote !== 'Free' ? ' · ' + g.shipNote : ''}</span></div>
    </div>`; };

  function cartItem(it) {
    const p = P[it.p];
    const notice = it.unavailable
      ? `<div class="buy-note t-danger">${icon('package-x')}<div class="stack gap-1"><span><b>Out of stock.</b> Marketly Official sold the last one at 1:12 PM. It won't be included at checkout. The rest of your cart is unchanged.</span><span class="buy-acts"><button type="button">${icon('trash-2', 'ic-sm')}Remove</button><a href="${go('store/offers')}">${icon('store', 'ic-sm')}See other offers (2 from $39.50)</a><button type="button">${icon('bell', 'ic-sm')}Tell me when it's back</button></span></div></div>`
      : it.oldPrice
        ? `<div class="buy-note">${icon('triangle-alert')}<span><b>Price changed since you added it:</b> was ${money(it.oldPrice)}, now ${money(it.price)}. Northwind Audio updated this offer on Oct 8. Remove it if you no longer want it at this price.</span></div>`
        : '';
    return `<div class="buy-item${it.unavailable ? ' is-unavail' : ''}">
      <a href="${go('store/product')}" aria-label="${esc(itemName(it))}">${pimg(p)}</a>
      <div class="stack gap-1" style="min-width:0">
        <a class="buy-name" href="${go('store/product')}">${esc(itemName(it))}</a>
        <span class="xs sub">${esc(it.variant)} · Condition: ${it.cond}</span>
        ${it.unavailable ? `<span>${U.status('Out of stock')}</span>` : `<span class="xs muted">SKU ${p.sku}</span>`}
        ${notice}
        ${it.unavailable ? '' : `<div class="buy-acts" style="margin-top:4px"><button type="button">${icon('trash-2', 'ic-sm')}Remove</button><button type="button">${icon('bookmark', 'ic-sm')}Save for later</button></div>`}
      </div>
      <div class="buy-item-side">
        ${it.unavailable ? `<span class="small buy-strike num">${money(it.price)}</span>` : `${U.qty(it.qty, 'sm')}<span class="stack gap-0" style="align-items:flex-end">${U.price(it.price, it.was, { noOff: true })}${it.oldPrice ? `<span class="xs buy-strike num">${money(it.oldPrice)}</span>` : ''}</span>`}
      </div>
    </div>`;
  }

  function cartSummary(o = {}) {
    return `<div class="buy-sum">
      ${sumRow('Subtotal (4 items)', money(SUBTOTAL))}
      ${sumRow('Discounts · WELCOME20', '−' + money(COUPON), 'discount')}
      ${sumRow('Shipping · Marketly Official', 'Free')}
      ${sumRow('Shipping · Northwind Audio', money(5.99))}
      ${sumRow('Shipping · Casa Verde Home', 'Free')}
      ${o.tax ? sumRow('Tax (Oregon has no sales tax)', money(0)) : sumRow('Estimated tax', '<span class="sub">Calculated after you enter an address</span>')}
      ${sumRow(o.tax ? 'Order total' : 'Total before tax', money(TOTAL), 'total')}
    </div>`;
  }

  /* ==================== 1. CART ==================== */
  U.register({
    id: 'store/cart', title: 'Cart', ref: 'Plan ch. 6',
    notes: 'One cart across the Official Store and two outside sellers, grouped into packages with their own ship-from, delivery estimate and shipping cost. Price changes and an out-of-stock item are explained inline while the rest of the cart stays intact.',
    states: ['Default', 'Empty'],
    render: (state) => {
      if (state === 'Empty') {
        return U.storeLayout(`<div class="container page">
          <h1 class="h1 no-phone">Your cart</h1>
          <div class="card">${U.empty('shopping-cart', 'Your cart is empty', 'Items you add from the Official Store and from marketplace sellers show up here, grouped by the package they ship in.', `<div class="row gap-2" style="justify-content:center">${btn('Continue shopping', { href: go('store/home') })}${btn('See today\'s deals', { v: 'secondary', href: go('store/deals') })}</div>`)}</div>
          <section class="stack gap-4">
            ${U.sectionHead('Saved for later (2)')}
            <div class="grid-products">${['kestrel27', 'bottle'].map((id) => `<div class="stack gap-2">${U.productCard(P[id], { showSeller: true })}${btn('Move to cart', { v: 'secondary', size: 'sm', block: true })}</div>`).join('')}</div>
          </section>
          <section class="stack gap-4">
            ${U.sectionHead('Recently viewed', { link: 'See all', href: go('store/collection', 'Best sellers') })}
            <div class="grid-products">${['aurora', 'skillet', 'sweater', 'keyboard'].map((id) => U.productCard(P[id], { compact: true })).join('')}</div>
          </section>
        </div>`, { tab: 'cart', appbar: { title: 'Cart', back: go('store/home') } });
      }
      const groups = CART.map((g) => `<section class="card buy-pkg" aria-label="${esc(S[g.seller].name)} package">
          ${pkgHead(g)}
          ${g.items.map(cartItem).join('')}
          <div class="card-foot" style="justify-content:space-between"><span class="xs muted">${icon('undo-2', 'ic-sm')} ${RETURNS[g.seller]}</span><span class="small strong num">Package subtotal ${money(g.items.filter((i) => !i.unavailable).reduce((a, i) => a + i.price * i.qty, 0) + g.ship)}</span></div>
        </section>`).join('');
      const summary = card({
        title: 'Order summary', body: `${cartSummary()}
          <div class="field"><label class="label" for="cart-coupon">Coupon code</label><div class="row nowrap gap-2"><input class="input" id="cart-coupon" placeholder="Enter code">${btn('Apply', { v: 'secondary' })}</div><span class="hint">${icon('circle-check', 'ic-sm')} WELCOME20 applied: $20.00 off your first order. ${'<a href="javascript:void 0">Remove</a>'}</span></div>
          ${btn('Check out · ' + money(TOTAL), { href: go('store/checkout', 'Signed in'), block: true, size: 'lg', iconR: 'arrow-right' })}
          <p class="xs muted">You'll see delivery options per package and the final total, including tax, before you place the order. 3 packages arrive separately.</p>`,
      });
      return U.storeLayout(`<div class="container page">
        <div class="buy-h1"><h1 class="h1">Your cart</h1><span class="sub small">4 items from 3 sellers · 3 packages</span></div>
        ${alert('warning', '2 items need your attention', 'One price went up since you added it and one item sold out. Everything else is ready for checkout.')}
        <div class="split">
          <div class="stack gap-4">${groups}
            <div class="row gap-2 xs muted">${icon('info', 'ic-sm')}<span>Items stay in your cart for 30 days. Prices and stock are checked again at checkout.</span></div>
          </div>
          <aside class="sticky-aside stack gap-4">${summary}
            <div class="card pad stack gap-2"><span class="small strong">${icon('shield-check', 'ic-sm')} Every item shows who sells it</span><span class="xs muted">Marketly Official ships its own stock. Northwind Audio and Casa Verde Home are verified sellers that ship their own orders. <a href="${go('info/about')}">What the labels mean</a></span></div>
          </aside>
        </div>
      </div>`, {
        tab: 'cart', appbar: { title: 'Cart (4)', back: go('store/home') },
        actionBar: `<div class="stack gap-0 grow"><span class="xs muted">Total before tax</span><span class="strong num" style="font-size:var(--fs-lg)">${money(TOTAL)}</span></div>${btn('Check out', { href: go('store/checkout', 'Signed in'), iconR: 'arrow-right' })}`,
      });
    },
  });

  /* ==================== 2. CHECKOUT ==================== */
  const secHead = (n, title, o = {}) => `<div class="card-head"><div class="row gap-3 nowrap"><span class="buy-sec-n${o.done ? ' is-done' : ''}">${o.done ? icon('check', 'ic-sm') : n}</span><h2 class="h4">${title}</h2></div>${o.action || ''}</div>`;
  const sec = (n, title, body, o = {}) => `<section class="card">${secHead(n, title, o)}<div class="card-body">${body}</div></section>`;

  function deliverySection() {
    const opts = {
      official: [['Standard', 'Free', 'Arrives Wed, Oct 14', 'Ships today from Reno, NV · UPS Ground', true], ['Express', money(9.99), 'Arrives Fri, Oct 9', 'Order within 2 h 18 min · UPS 2nd Day Air', false]],
      northwind: [['Standard', money(5.99), 'Arrives Thu, Oct 15', 'Ships in 1 business day · USPS Ground Advantage', true], ['Priority', money(12.99), 'Arrives Mon, Oct 12', 'Ships in 1 business day · USPS Priority Mail', false]],
      casaverde: [['Standard', 'Free', 'Arrives Mon, Oct 19 – Tue, Oct 20', 'Ships in 2 business days · FedEx Ground', true]],
    };
    return CART.map((g) => {
      const s = S[g.seller];
      const items = g.items.filter((i) => !i.unavailable);
      return `<div class="stack gap-2">
        <div class="row between"><span class="row gap-2"><span class="small strong">${g.pkg}: ${esc(s.name)}</span>${sellerBadge(s, true)}</span><span class="xs muted">${items.map((i) => esc(itemName(i).split(',')[0].replace(/^(Halden|Mosswood) /, ''))).join(' · ')}</span></div>
        <div class="buy-opts c2">${opts[g.seller].map((o, i) => optCard('co-ship-' + g.seller, `co-ship-${g.seller}-${i}`, `<span class="row between"><span class="strong small">${o[2]}</span><span class="small strong num">${o[1]}</span></span>`, `${o[0]} · ${o[3]}`, o[4])).join('')}</div>
      </div>`;
    }).join('<hr>');
  }

  function reviewSection() {
    return CART.map((g) => {
      const s = S[g.seller];
      return `<div class="stack gap-3">
        <div class="row between"><span class="row gap-2"><span class="small strong">${g.pkg}</span><span class="xs sub">Sold and shipped by <b>${esc(s.name)}</b></span>${sellerBadge(s, true)}</span><span class="xs strong">${icon('calendar-check', 'ic-sm')} ${g.eta}</span></div>
        ${g.items.filter((i) => !i.unavailable).map((it) => `<div class="buy-mini">${pimg(P[it.p])}<div class="stack gap-0 grow"><span class="small strong clamp-2">${esc(itemName(it))}</span><span class="xs muted">${esc(it.variant)} · ${it.cond} · Qty ${it.qty}</span></div><span class="small strong num">${money(it.price)}</span></div>`).join('')}
        <span class="xs muted">${icon('undo-2', 'ic-sm')} Return terms: ${RETURNS[g.seller]} · Seller support replies within ${g.seller === 'official' ? '12 hours' : '1 business day'}</span>
      </div>`;
    }).join('<hr>');
  }

  U.register({
    id: 'store/checkout', title: 'Checkout', ref: 'Plan ch. 6',
    notes: 'Single-page checkout following the plan sequence: identify (or guest), address with shipability check, delivery per package with separate arrival dates, coupons with item coverage, payment, then review with seller info and return terms. Place order shows the total and is safe against double taps.',
    states: ['Signed in', 'Guest checkout', 'Coupon rejected'],
    render: (state) => {
      const guest = state === 'Guest checkout';
      const rejected = state === 'Coupon rejected';
      const total = guest ? SUBTOTAL + SHIPPING : TOTAL;
      const account = guest
        ? sec(1, 'Contact details', `<div class="row between"><span class="small sub">Checking out as a guest.</span><a class="small strong" href="${go('auth/sign-in')}">Sign in instead</a></div>
            <div class="grid md2">${field('Email', input('co-g-email', 'jordan.lee@example.com', { type: 'email' }), { hint: 'We\'ll email a link to view and manage this order.' })}${field('Mobile phone', input('co-g-phone', '(503) 555-0148', { type: 'tel' }), { hint: 'Only for delivery updates about this order.' })}</div>
            ${check('co-g-acct', 'Create an account after checkout so I can track all my orders in one place', false)}
            ${alert('info', 'You can still manage this order without an account', 'Use the link in your confirmation email, or look it up anytime with your order reference and email under <a href="' + go('auth/guest-orders') + '">Guest order lookup</a>.')}`, { done: true })
        : sec(1, 'Account', `<div class="row gap-3">${U.avatar(D.customer.name)}<div class="stack gap-0 grow"><span class="small strong">Signed in as ${D.customer.name}</span><span class="xs muted">${D.customer.email} · Order updates go here</span></div><a class="small strong" href="${go('auth/sign-in')}">Switch account</a></div>`, { done: true });

      const address = guest
        ? sec(2, 'Delivery address', `<div class="grid md2">${field('Full name', input('co-a-name', 'Jordan Lee'))}${field('Phone', input('co-a-phone', '(503) 555-0148', { type: 'tel' }))}</div>
            ${field('Street address', input('co-a-line1', '2140 Alder St'))}${field('Apartment, suite, floor', input('co-a-line2', 'Apt 5'), { opt: true })}
            <div class="grid md3">${field('City', input('co-a-city', 'Portland'))}${field('State', select('co-a-state', ['Oregon', 'Washington', 'California', 'Idaho'], 'Oregon'))}${field('ZIP code', input('co-a-zip', '97205'))}</div>
            <div class="buy-note t-success">${icon('circle-check')}<span><b>All 4 items can ship to this address.</b> We checked each seller's delivery area.</span></div>`, { done: true })
        : sec(2, 'Delivery address', `<div class="buy-opts c2">${D.customer.addresses.map((a, i) => optCard('co-addr', 'co-addr-' + a.id, `<span class="row gap-2"><span class="strong small">${a.label}</span>${a.default ? badge('Default', '') : ''}</span>`, `${a.name}<br>${a.line1}<br>${a.city}<br>${a.phone}`, i === 0)).join('')}</div>
            <div class="row between">${btn('Add a new address', { v: 'ghost', size: 'sm', icon: 'plus' })}<span class="xs muted">Changing an address here doesn't update your saved addresses.</span></div>
            <div class="buy-note t-success">${icon('circle-check')}<span><b>All 4 items can ship to this address.</b> Delivery dates below are for Portland, OR 97205.</span></div>`, { done: true });

      const coupon = guest
        ? sec(4, 'Coupons and credit', `<div class="field"><label class="label" for="co-coupon">Coupon code</label><div class="row nowrap gap-2"><input class="input" id="co-coupon" placeholder="Enter code">${btn('Apply', { v: 'secondary' })}</div><span class="hint">Account coupons such as WELCOME20 and store credit need you to <a href="${go('auth/sign-in')}">sign in</a>.</span></div>`)
        : sec(4, 'Coupons and credit', `
            ${rejected ? `<div class="field"><label class="label" for="co-coupon">Coupon code</label><div class="row nowrap gap-2"><input class="input is-error" id="co-coupon" value="AUTUMN15" aria-invalid="true">${btn('Apply', { v: 'secondary' })}</div><span class="error-text">${icon('circle-alert', 'ic-sm')}AUTUMN15 can't be used on this order.</span></div>
              ${alert('danger', 'Why AUTUMN15 was rejected', 'Applies only to Home & Kitchen items from the Official Store. None in your cart qualify. The Pour-over set is Home & Kitchen but is excluded as a new arrival. Your other discount is unchanged.')}`
              : `<div class="field"><label class="label" for="co-coupon">Add another code</label><div class="row nowrap gap-2"><input class="input" id="co-coupon" placeholder="Enter code">${btn('Apply', { v: 'secondary' })}</div></div>`}
            <div class="panel stack gap-2">
              <div class="row between"><span class="row gap-2">${badge('WELCOME20', 'deal-soft', 'ticket-percent')}<span class="small strong">Applied · ${'−' + money(COUPON)}</span></span><a class="small" href="javascript:void 0">Remove</a></div>
              <span class="xs sub">$20 off your first order over $100. Funded by Marketly, so sellers receive their full price.</span>
              <span class="xs"><b>Covers:</b> Aurora headphones (−$11.63), Pour-over set (−$2.22), Pocket speaker 2-pack (−$6.15). <b>Not covered:</b> Linen duvet cover, already on a seller markdown.</span>
            </div>
            ${check('co-credit', 'Use my Marketly credit: <b>$12.50 available</b> (from a refund on Aug 18)', false)}`, { done: !rejected });

      const payment = sec(5, 'Payment method', `<div class="buy-opts">
          ${guest ? '' : optCard('co-pay', 'co-pay-visa', `<span class="row gap-2"><span class="small strong">Visa •••• 4417</span>${badge('Saved', '')}</span>`, 'Jordan Lee · Expires 09/29 · Billing address same as Home', true, { right: icon('credit-card') })}
          ${optCard('co-pay', 'co-pay-new', '<span class="small strong">New debit or credit card</span>', 'Visa, Mastercard, American Express, Discover', guest, { right: icon('plus') })}
          ${guest ? `<div class="well stack gap-3">${field('Name on card', input('co-card-name', 'Jordan Lee'))}${field('Card number', input('co-card-n', '4417 2210 8830 1093', { icon: 'credit-card' }))}<div class="grid c2">${field('Expiry', input('co-card-exp', '09 / 29'))}${field('Security code', input('co-card-cvc', '', { placeholder: '3 or 4 digits' }))}</div>${check('co-card-bill', 'Billing address is the same as the delivery address', true)}</div>` : ''}
          ${optCard('co-pay', 'co-pay-wallet', '<span class="small strong">Digital wallet</span>', 'Pay with the wallet saved on this device. You confirm on the next screen.', false, { right: icon('smartphone') })}
        </div>
        <span class="xs muted">${icon('lock', 'ic-sm')} Your card is charged once, when the order is accepted. Each seller is paid by Marketly after delivery.</span>`, { done: !guest });

      const summary = `<aside class="sticky-aside stack gap-4">
        ${card({ title: 'Order total', body: `<div class="buy-sum">
            ${sumRow('Items (4)', money(SUBTOTAL))}
            ${guest ? '' : sumRow('WELCOME20', '−' + money(COUPON), 'discount')}
            ${sumRow('Shipping · Marketly Official', 'Free')}${sumRow('Shipping · Northwind Audio', money(5.99))}${sumRow('Shipping · Casa Verde Home', 'Free')}
            ${sumRow('Tax (Oregon has no sales tax)', money(0))}
            ${sumRow('Total', money(total), 'total')}
          </div>
          ${btn('Place order · ' + money(total), { block: true, size: 'lg', href: go('store/confirmation') })}
          <p class="xs muted">${icon('shield-check', 'ic-sm')} Tapping twice or refreshing won't create two orders or charge you twice.</p>
          <p class="xs muted">By placing your order you agree to the <a href="${go('info/policy', 'Purchase terms')}">Purchase terms</a> and the return terms shown for each package.</p>` })}
        <div class="card pad stack gap-2"><span class="small strong">Need help?</span><span class="xs muted">Call 1-800-555-0136, Mon–Sat 8 AM–8 PM PT, or <a href="${go('help/center')}">visit the Help Center</a>.</span></div>
      </aside>`;

      const cur = guest ? 1 : rejected ? 3 : 4;
      return U.checkoutLayout(`<div class="container page" style="gap:var(--sp-5)">
        <div class="stack gap-3"><a class="small strong" href="${go('store/cart')}">${icon('arrow-left', 'ic-sm')} Back to cart</a><h1 class="h1">Checkout</h1>${steps(['Account', 'Address', 'Delivery', 'Payment', 'Review'], cur)}</div>
        <div class="split">
          <div class="stack gap-4">
            ${account}
            ${address}
            ${sec(3, 'Delivery options for each package', `<p class="xs muted">Your items ship in 3 packages from different places, so each has its own options and arrival date.</p>${deliverySection()}`, { done: true })}
            ${coupon}
            ${payment}
            ${sec(6, 'Review your order', reviewSection())}
          </div>
          ${summary}
        </div>
      </div>
      <div class="action-bar no-desktop"><div class="stack gap-0 grow"><span class="xs muted">Total · 3 packages</span><span class="strong num" style="font-size:var(--fs-lg)">${money(total)}</span></div>${btn('Place order', { href: go('store/confirmation') })}</div>`);
    },
  });

  /* ==================== 3. REVIEW CHANGES (modal) ==================== */
  U.register({
    id: 'store/checkout-review-changes', title: 'Checkout: review changes', ref: 'Plan ch. 5–6',
    notes: 'Shown when price, stock, delivery or coupon eligibility changes between the cart and Place order. Every change needs a choice, alternative offers from other sellers are shown explicitly and never swapped in silently, and a partial order is only accepted with a clear choice about the revised charge.',
    render: () => {
      const change = (p, title, delta, body, opts) => `<div class="buy-change">
        <div class="buy-change-head">${pimg(p)}<div class="stack gap-1 grow"><span class="xs strong t-warning-text">${title}</span><span class="small strong">${esc(p.name)}</span>${delta}</div></div>
        ${body || ''}
        <div class="buy-opts">${opts}</div>
      </div>`;
      const body = `
        <p class="small sub">We checked your order again before charging you. Nothing has been charged yet. Choose what to do with each change.</p>
        ${change(P.ssd1tb, 'Price went up', `<span class="buy-delta"><span class="buy-strike">${money(94.99)}</span>${icon('arrow-right', 'ic-sm')}<span>${money(99.99)} each</span><span class="xs muted">· Pixel &amp; Port · Qty 1</span></span>`, '',
          optCard('rc-ssd', 'rc-ssd-a', '<span class="small strong">Accept the new price, $99.99</span>', '', true)
          + optCard('rc-ssd', 'rc-ssd-r', '<span class="small strong">Remove this item</span>', '', false)
          + optCard('rc-ssd', 'rc-ssd-o', '<span class="small strong">Choose another offer</span>', `<span class="buy-alt stack gap-1" style="display:flex;margin-top:6px"><span class="row gap-2"><b>Marketly Official</b>${badge('Official', 'brand', 'badge-check')}</span><span>New · ${money(97.49)} · Free shipping · Arrives Thu, Oct 15 · 30-day free returns</span><span class="xs muted">Different seller. Only switched if you pick this.</span></span>`, false))}
        ${change(P.speaker, 'Less stock available', `<span class="buy-delta"><span>Qty 2</span>${icon('arrow-right', 'ic-sm')}<span>1 available</span><span class="xs muted">· Northwind Audio</span></span>`, '',
          optCard('rc-spk', 'rc-spk-a', '<span class="small strong">Buy the 1 available from Northwind Audio</span>', 'Your total goes down by $59.00.', true)
          + optCard('rc-spk', 'rc-spk-r', '<span class="small strong">Remove this item</span>', '', false)
          + optCard('rc-spk', 'rc-spk-o', '<span class="small strong">Choose another offer for both</span>', `<span class="buy-alt stack gap-1" style="display:flex;margin-top:6px"><span class="row gap-2"><b>Pixel &amp; Port</b>${badge('Verified', 'info', 'shield-check')}</span><span>New · ${money(61.00)} each · 6 in stock · ${money(4.99)} shipping · Arrives Fri, Oct 16 · 30-day returns</span></span>`, false))}
        ${change(P.duvet, 'Delivery date moved', `<span class="buy-delta"><span class="buy-strike">Mon, Oct 19</span>${icon('arrow-right', 'ic-sm')}<span>Wed, Oct 21 – Thu, Oct 22</span><span class="xs muted">· Casa Verde Home</span></span>`, '<span class="xs muted">Casa Verde Home now ships in 4 business days because of a restock.</span>',
          optCard('rc-duv', 'rc-duv-a', '<span class="small strong">Keep it with the new date</span>', '', true)
          + optCard('rc-duv', 'rc-duv-r', '<span class="small strong">Remove this item</span>', '', false))}
        ${change(P.pourover, 'Coupon no longer covers this item', `<span class="buy-delta">HOMEWEEK10 ended at 12:00 PM PT <span class="xs muted">· Pour-over set loses −$3.60</span></span>`, '<span class="xs muted">Your other items keep their discounts. WELCOME20 still applies.</span>',
          optCard('rc-po', 'rc-po-a', '<span class="small strong">Keep it at full price, $36.00</span>', '', true)
          + optCard('rc-po', 'rc-po-r', '<span class="small strong">Remove this item</span>', '', false))}
        ${alert('info', 'If you remove an item, the rest of your order can still go through', 'You\'ll only be charged for the items you keep. We\'ll show the revised packages and total on the review step before you place the order.')}
        <div class="panel buy-sum">
          ${sumRow('Previous total', `<span class="buy-strike">${money(370.38)}</span>`)}
          ${sumRow('Price change · SSD', '+' + money(5.00))}
          ${sumRow('One fewer speaker', '−' + money(59.00))}
          ${sumRow('HOMEWEEK10 removed', '+' + money(3.60))}
          ${sumRow('New total', money(319.98), 'total')}
        </div>`;
      const scen = [['ssd1tb', 'pixelport', 'Qty 1', 94.99], ['speaker', 'northwind', 'Qty 2', 118.00], ['duvet', 'casaverde', 'Qty 1', 119.00], ['pourover', 'official', 'Qty 1', 36.00]];
      const bg = U.checkoutLayout(`<div class="container page"><div class="stack gap-3"><h1 class="h1">Checkout</h1>${steps(['Account', 'Address', 'Delivery', 'Payment', 'Review'], 4)}</div><div class="split"><div class="stack gap-4">${sec(6, 'Review your order', scen.map(([id, sid, q, pr]) => `<div class="buy-mini">${pimg(P[id])}<div class="stack gap-0 grow"><span class="small strong">${esc(P[id].name)}</span><span class="xs muted">${esc(S[sid].name)} · ${q}</span></div><span class="small strong num">${money(pr)}</span></div>`).join('<hr>'))}</div><aside>${card({ title: 'Order total', body: sumRow('Total', money(370.38), 'total') + btn('Place order · ' + money(370.38), { block: true, size: 'lg', disabled: true }) })}</aside></div></div>`);
      return bg + U.modal({ title: 'Some details changed before you placed your order', size: 'lg', body, foot: `${btn('Back to cart', { v: 'secondary', href: go('store/cart') })}${btn('Accept changes and continue · ' + money(319.98), { href: go('store/checkout', 'Signed in') })}` });
    },
  });

  /* ==================== 4. PAYMENT RESULT ==================== */
  const miniOrder = () => card({ title: 'Your order', sub: '4 items · 3 packages', body: `${CART.map((g) => g.items.filter((i) => !i.unavailable).map((it) => `<div class="buy-mini">${pimg(P[it.p])}<div class="stack gap-0 grow"><span class="small clamp-2">${esc(itemName(it))}</span><span class="xs muted">${esc(S[g.seller].name)} · ${g.eta.replace('Arrives ', '')}</span></div><span class="small num">${money(it.price)}</span></div>`).join('')).join('')}<hr>${sumRow('Total', money(TOTAL), 'total')}` });

  U.register({
    id: 'store/payment-result', title: 'Payment result', ref: 'Plan ch. 6, 14',
    notes: 'Clear payment outcomes with no ads on this page. A failed payment keeps the cart and lets the customer retry or switch method; an uncertain result tells the customer not to pay again and points to the order status while the bank confirms.',
    states: ['Payment failed', 'Checking payment'],
    render: (state) => {
      if (state === 'Checking payment') {
        return U.checkoutLayout(`<div class="container page"><div class="split">
          <div class="stack gap-5">
            <div class="row top gap-4 nowrap"><span class="buy-result-icon t-warning">${icon('hourglass')}</span><div class="stack gap-2"><h1 class="h1">We're confirming your payment</h1><p class="sub">We're confirming your payment with your bank. Don't pay again. This usually takes a few minutes.</p></div></div>
            <div class="card pad stack gap-3">
              ${kv([['Order reference', `<span class="buy-ref">${ORDER_REF}</span>`], ['Payment', `${U.status('Pending')} <span class="xs muted">Visa •••• 4417 · ${money(TOTAL)}</span>`], ['Last checked', 'Thu, Oct 8, 2:41 PM PT']])}
              <div class="row gap-2 xs muted">${icon('refresh-cw', 'ic-sm')}<span>This page checks again automatically every 30 seconds. You can close it; we'll email ${D.customer.email} with the result.</span></div>
              <div class="row gap-2">${btn('View order status', { href: go('account/order'), iconR: 'arrow-right' })}${btn('Check now', { v: 'secondary', icon: 'refresh-cw' })}</div>
            </div>
            ${alert('warning', 'Please don\'t place this order again', 'Your bank may show a temporary hold for ' + money(TOTAL) + '. Placing the order again could create a second hold. Your order reference stays the same whatever happens.')}
            <section class="card pad stack gap-3"><h2 class="h3">What happens next</h2>
              ${timeline([
                { t: 'Order received', d: 'Thu, Oct 8, 2:39 PM PT', state: 'done', body: 'Your items are reserved while we check the payment.' },
                { t: 'Bank confirms the payment', d: 'Usually within minutes, at most 24 hours', state: 'current', body: 'If accepted, the order is confirmed and you get a confirmation email. Sellers start preparing your packages.' },
                { t: 'If the bank declines', state: '', body: 'The order is cancelled, nothing is charged and any hold is released by your bank within 3–5 business days. Your cart is restored so you can pay another way.' },
              ])}
            </section>
          </div>
          <aside class="stack gap-4">${miniOrder()}<div class="card pad stack gap-2"><span class="small strong">Questions about this payment?</span><span class="xs muted">Call 1-800-555-0136, Mon–Sat 8 AM–8 PM PT. Have ${ORDER_REF} ready.</span></div></aside>
        </div></div>`);
      }
      return U.checkoutLayout(`<div class="container page"><div class="split">
        <div class="stack gap-5">
          <div class="row top gap-4 nowrap"><span class="buy-result-icon t-danger">${icon('credit-card')}</span><div class="stack gap-2"><h1 class="h1">Your payment didn't go through</h1><p class="sub">Your bank declined Visa •••• 4417. Nothing was charged and no order was created.</p></div></div>
          ${alert('danger', 'Reason from your bank: card declined (code 05)', 'Banks use this code for several reasons, such as a spending limit or a security check. Your bank can tell you more. Try again, or use a different payment method.')}
          ${card({ title: 'Try again', body: `<div class="buy-opts">
              ${optCard('pr-pay', 'pr-visa', '<span class="small strong">Visa •••• 4417</span>', 'Same card. Use this if you just approved the payment in your banking app.', true, { right: icon('credit-card') })}
              ${optCard('pr-pay', 'pr-new', '<span class="small strong">New debit or credit card</span>', 'Visa, Mastercard, American Express, Discover', false, { right: icon('plus') })}
              ${optCard('pr-pay', 'pr-wallet', '<span class="small strong">Digital wallet</span>', 'Confirm on this device', false, { right: icon('smartphone') })}
            </div>
            <div class="row gap-2">${btn('Pay ' + money(TOTAL) + ' with Visa •••• 4417', { href: go('store/confirmation') })}${btn('Back to checkout', { v: 'secondary', href: go('store/checkout', 'Signed in') })}</div>` })}
          <div class="buy-note t-info">${icon('info')}<span>Your cart, delivery choices and WELCOME20 coupon are saved. Prices and stock are held until 3:15 PM PT, and we'll show you any changes before you pay.</span></div>
        </div>
        <aside class="stack gap-4">${miniOrder()}</aside>
      </div></div>`);
    },
  });

  /* ==================== 5. CONFIRMATION ==================== */
  U.register({
    id: 'store/confirmation', title: 'Order confirmation', ref: 'Plan ch. 6',
    notes: 'Shown only after the payment is accepted. Order reference, charged total, items grouped by seller package with their own delivery estimates, delivery address and next steps; packages may arrive separately.',
    render: () => U.storeLayout(`<div class="container page"><div class="buy-narrow stack gap-5">
        <div class="stack gap-3" style="align-items:flex-start">
          <span class="buy-result-icon t-success">${icon('circle-check')}</span>
          <h1 class="h1">Order placed. Thank you, ${D.customer.first}.</h1>
          <p class="sub">We sent a confirmation to <b>${D.customer.email}</b>. Your 4 items ship in 3 packages that may arrive on different days.</p>
        </div>
        <div class="card pad"><div class="grid md3" style="--gap:var(--sp-4)">
          <div class="stack gap-1"><span class="xs muted">Order reference</span><span class="buy-ref">${ORDER_REF}</span></div>
          <div class="stack gap-1"><span class="xs muted">Charged to Visa •••• 4417</span><span class="strong num">${money(TOTAL)}</span><span>${U.status('Accepted')}</span></div>
          <div class="stack gap-1"><span class="xs muted">Delivering to</span><span class="small strong">Jordan Lee</span><span class="xs sub">2140 Alder St, Apt 5, Portland, OR 97205</span></div>
        </div></div>
        ${alert('info', 'Packages may arrive separately', 'Each seller ships its own package and you\'ll get tracking for each one as it ships.')}
        ${CART.map((g) => `<section class="card buy-pkg">${pkgHead(g)}${g.items.filter((i) => !i.unavailable).map((it) => `<div class="buy-item"><span>${pimg(P[it.p])}</span><div class="stack gap-1"><span class="buy-name">${esc(itemName(it))}</span><span class="xs sub">${esc(it.variant)} · ${it.cond} · Qty ${it.qty}</span><span>${U.status('Confirmed')}</span></div><div class="buy-item-side"><span class="small strong num">${money(it.price)}</span></div></div>`).join('')}</section>`).join('')}
        <div class="card pad buy-sum">
          ${sumRow('Items (4)', money(SUBTOTAL))}${sumRow('WELCOME20', '−' + money(COUPON), 'discount')}${sumRow('Shipping (3 packages)', money(SHIPPING))}${sumRow('Tax', money(0))}${sumRow('Charged', money(TOTAL), 'total')}
        </div>
        <section class="card pad stack gap-3"><h2 class="h3">What happens next</h2>
          ${timeline([
            { t: 'Sellers confirm and prepare your items', d: 'Today', state: 'current', body: 'You can cancel an item from the order page until its seller ships it.' },
            { t: 'Each package ships with its own tracking', d: 'Oct 9 – Oct 13', body: 'We email you as each package leaves.' },
            { t: 'Delivered', d: 'Oct 14 – Oct 20', body: 'Returns and help are on the order page, item by item.' },
          ])}
        </section>
        <div class="row gap-2">${btn('View order', { href: go('account/order'), iconR: 'arrow-right' })}${btn('Contact support', { v: 'secondary', href: go('help/contact'), icon: 'headset' })}${btn('Download receipt', { v: 'ghost', icon: 'download' })}</div>
        <p class="xs muted">Your order keeps the purchase terms and each seller's return terms as they were when you ordered. <a href="${go('store/home')}">Continue shopping</a></p>
      </div></div>`, { tab: 'cart', appbar: { title: 'Order placed', back: go('store/home') } }),
  });

  /* ==================== SIGN IN ==================== */
  const authLayout = (content, title, back) => U.storeLayout(`<div class="container page"><div class="buy-auth">${content}</div></div>`, { footer: false, tabbar: false, promo: false, signedIn: false, appbar: { title, back: back || go('store/home') } });
  const authCard = (body) => `<section class="card"><div class="card-body">${body}</div></section>`;
  const passField = (id, label, value, o = {}) => `<div class="field"><div class="row between"><label class="label" for="${id}">${label}</label>${o.link || ''}</div><span class="buy-pass${o.error ? ' is-error' : ''}"><input class="input" id="${id}" type="password" value="${esc(value)}"${o.error ? ' aria-invalid="true"' : ''}><button type="button" class="btn btn-ghost btn-sm" aria-label="Show password">${icon('eye', 'ic-sm')}<span>Show</span></button></span>${o.error ? `<span class="error-text">${icon('circle-alert', 'ic-sm')}${o.error}</span>` : o.hint ? `<span class="hint">${o.hint}</span>` : ''}</div>`;
  const pwRules = (ok) => `<ul class="buy-rules" aria-label="Password requirements">${[['At least 10 characters', ok[0]], ['One number', ok[1]], ['One uppercase letter', ok[2]], ['Not your email or name', ok[3]]].map(([t, v]) => `<li class="${v ? 'is-ok' : ''}">${icon(v ? 'circle-check' : 'circle', 'ic-sm')}<span>${t}${v ? '<span class="sr-only"> (met)</span>' : '<span class="sr-only"> (not met yet)</span>'}</span></li>`).join('')}</ul>`;
  // codeEntry(idPrefix, digits, legend) — 6-digit one-time code boxes (email verification, two-step sign-in)
  const codeEntry = (pfx, digits, legend = 'Verification code') => `<fieldset class="stack gap-2" style="border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:var(--sp-2)">${legend}</legend>
            <div class="buy-code">${digits.map((d, i) => `<input id="${pfx}-${i}" inputmode="numeric" maxlength="1" value="${d}" aria-label="Digit ${i + 1} of 6">`).join('')}</div>
          </fieldset>`;
  // The API returns emails masked (first two letters, then dots): jordan.lee@example.com → jo•••@example.com
  const maskEmail = (e) => { const [user, domain] = String(e).split('@'); return `${user.slice(0, 2)}•••@${domain}`; };
  const socials = () => `<div class="buy-or">or</div><div class="stack gap-2">${btn('Continue with Google', { v: 'secondary', block: true })}${btn('Continue with Apple', { v: 'secondary', block: true })}</div>`;

  U.register({
    id: 'auth/sign-in', title: 'Sign in', ref: 'Plan ch. 6–7',
    notes: 'Email and password sign-in with show password, recovery and account creation, plus a guest checkout route. The error state says exactly what went wrong, how many attempts remain and how to reset. When the account has two-step verification on, the API answers the password with second_factor_required and the customer enters a 6-digit code from their authenticator app or a text message, or a backup code, and can trust the device for 30 days.',
    states: ['Sign in', 'Wrong password', 'Two-step code'],
    render: (state) => {
      if (state === 'Two-step code') {
        return authLayout(authCard(`
          <span class="buy-result-icon t-info">${icon('shield-check')}</span>
          <div class="stack gap-1"><h1 class="h2">Two-step verification</h1><p class="small sub">Enter the 6-digit code we texted to <b>(•••) •••-••48</b>, or the code from your authenticator app. Signing in as <b>${maskEmail(D.customer.email)}</b>.</p></div>
          ${codeEntry('si-code', ['2', '7', '0', '5', '', ''], 'Sign-in code')}
          ${check('si-trust', 'Trust this device for 30 days. We won\'t ask for a code here again until then.', false)}
          ${btn('Verify and sign in', { block: true, size: 'lg', href: go('account/overview') })}
          <div class="row between small"><span class="muted">${icon('clock', 'ic-sm')} Resend text in 0:38</span><a href="javascript:void 0">Use authenticator app</a></div>
          <div class="panel row gap-3 nowrap">${icon('key-round')}<div class="stack gap-0 grow"><span class="small strong">No access to your phone?</span><span class="xs muted">Each backup code from your security settings works once.</span></div><a class="small strong nowrap" href="javascript:void 0">Use a backup code</a></div>
          <p class="xs muted">Lost your phone and your backup codes? Call 1-800-555-0136, Mon–Sat 8 AM–8 PM PT. <a href="${go('auth/sign-in')}">Back to sign in</a></p>
        `), 'Two-step verification', go('auth/sign-in'));
      }
      const wrong = state === 'Wrong password';
      return authLayout(authCard(`
        <div class="stack gap-1"><h1 class="h2">Sign in to ${U.BRAND}</h1><p class="small sub">Track orders, start returns and check out faster.</p></div>
        ${wrong ? alert('danger', 'That email and password don\'t match', 'Check your password and try again, or reset it. You have <b>2 attempts left</b> before sign-in pauses for 15 minutes to protect your account.') : ''}
        ${field('Email', input('si-email', 'jordan.lee@example.com', { type: 'email' }))}
        ${passField('si-pass', 'Password', wrong ? 'portland2025' : '', { link: `<a class="small" href="${go('auth/recover')}">Forgot password?</a>`, error: wrong ? 'Incorrect password for this email.' : '' })}
        ${check('si-keep', 'Keep me signed in on this device', true)}
        ${btn('Sign in', { block: true, size: 'lg', href: go('account/overview') })}
        ${wrong ? `<a class="btn btn-soft btn-block" href="${go('auth/recover', 'Request link')}">${icon('key-round')}<span>Reset your password</span></a>` : ''}
        ${socials()}
        <p class="small center">New to ${U.BRAND}? <a class="strong" href="${go('auth/register')}">Create an account</a></p>
        <div class="panel row gap-3 nowrap">${icon('shopping-cart')}<div class="stack gap-0 grow"><span class="small strong">Checking out?</span><span class="xs muted">No account needed. We'll email a link to manage your order.</span></div><a class="small strong nowrap" href="${go('store/checkout', 'Guest checkout')}">Continue as guest</a></div>
      `) + `<p class="xs muted center" style="margin-top:var(--sp-4)"><a href="${go('info/policy', 'Privacy')}">Privacy</a> · <a href="${go('info/policy', 'Purchase terms')}">Purchase terms</a> · <a href="${go('help/center')}">Help</a></p>`, 'Sign in');
    },
  });

  U.register({
    id: 'auth/register', title: 'Create account', ref: 'Plan ch. 7, 19',
    notes: 'Account creation with live password rules and marketing opt-in unchecked by default (essential order updates are separate). Email verification uses a 6-digit code with a resend timer.',
    states: ['Create account', 'Verify email'],
    render: (state) => {
      if (state === 'Verify email') {
        return authLayout(authCard(`
          <span class="buy-result-icon t-info">${icon('mail-check')}</span>
          <div class="stack gap-1"><h1 class="h2">Check your email</h1><p class="small sub">Enter the 6-digit code we sent to <b>${maskEmail(D.customer.email)}</b>. It expires in 10 minutes.</p></div>
          ${codeEntry('rg-code', ['4', '8', '1', '', '', ''])}
          ${btn('Verify email', { block: true, size: 'lg', href: go('account/overview') })}
          <div class="row between small"><span class="muted">${icon('clock', 'ic-sm')} Resend code in 0:42</span><a href="${go('auth/register')}">Change email</a></div>
          <p class="xs muted">Can't find it? Check your spam folder. The email comes from no-reply@marketly.example.</p>
        `), 'Verify email', go('auth/register'));
      }
      return authLayout(authCard(`
        <div class="stack gap-1"><h1 class="h2">Create your account</h1><p class="small sub">One account for orders from the Official Store and every marketplace seller.</p></div>
        <div class="grid c2">${field('First name', input('rg-first', 'Jordan'))}${field('Last name', input('rg-last', 'Lee'))}</div>
        ${field('Email', input('rg-email', 'jordan.lee@example.com', { type: 'email' }), { hint: 'We\'ll send a code to confirm it.' })}
        ${passField('rg-pass', 'Password', 'alder2140x')}
        ${pwRules([true, true, false, true])}
        ${check('rg-mkt', 'Email me deals, new arrivals and seller promotions. You can turn this off anytime.', false)}
        <p class="xs muted">Order, delivery and refund updates are always sent, whatever you choose above.</p>
        ${btn('Create account', { block: true, size: 'lg', href: go('auth/register', 'Verify email') })}
        <p class="xs muted">By creating an account, you agree to the <a href="${go('info/policy', 'Purchase terms')}">Purchase terms</a> and confirm you've read the <a href="${go('info/policy', 'Privacy')}">Privacy policy</a>.</p>
        ${socials()}
        <p class="small center">Already have an account? <a class="strong" href="${go('auth/sign-in')}">Sign in</a></p>
      `), 'Create account', go('auth/sign-in'));
    },
  });

  U.register({
    id: 'auth/recover', title: 'Reset password', ref: 'Plan ch. 7',
    notes: 'Password recovery in three steps: request a link without revealing whether an account exists, confirmation with expiry and resend, then setting a new password with live rules and an option to sign out other devices.',
    states: ['Request link', 'Check your email', 'Set new password'],
    render: (state) => {
      if (state === 'Check your email') {
        return authLayout(authCard(`
          <span class="buy-result-icon t-info">${icon('mail')}</span>
          <div class="stack gap-1"><h1 class="h2">Check your email</h1><p class="small sub">If an account uses <b>${maskEmail(D.customer.email)}</b>, we sent a link to reset the password.</p></div>
          <ul class="ul small sub stack gap-1"><li>The link works once and expires in 30 minutes.</li><li>Open it on any device. You'll set a new password there.</li><li>Not there? Check spam or promotions folders.</li></ul>
          ${btn('Resend link (available in 0:51)', { v: 'secondary', block: true, disabled: true })}
          <div class="row between small"><a href="${go('auth/recover', 'Request link')}">Use a different email</a><a href="${go('auth/sign-in')}">Back to sign in</a></div>
          <p class="xs muted">Still stuck? Call 1-800-555-0136, Mon–Sat 8 AM–8 PM PT.</p>
        `), 'Reset password', go('auth/sign-in'));
      }
      if (state === 'Set new password') {
        return authLayout(authCard(`
          <div class="stack gap-1"><h1 class="h2">Set a new password</h1><p class="small sub">For ${maskEmail(D.customer.email)}</p></div>
          ${passField('rc-new', 'New password', 'Alder2140xp')}
          ${pwRules([true, true, true, true])}
          ${passField('rc-confirm', 'Confirm new password', 'Alder2140xp', { hint: 'Passwords match.' })}
          ${check('rc-signout', 'Sign me out on all other devices', true)}
          ${btn('Save new password', { block: true, size: 'lg', href: go('auth/sign-in') })}
          <p class="xs muted">We'll email you to confirm the change. If you didn't ask for this, contact support right away.</p>
        `), 'New password', go('auth/sign-in'));
      }
      return authLayout(authCard(`
        <div class="stack gap-1"><h1 class="h2">Forgot your password?</h1><p class="small sub">Enter the email you use for ${U.BRAND}. We'll send a link to set a new password.</p></div>
        ${field('Email', input('rc-email', 'jordan.lee@example.com', { type: 'email' }))}
        ${btn('Send reset link', { block: true, size: 'lg', href: go('auth/recover', 'Check your email') })}
        <p class="xs muted">For your security, we don't say whether an account exists for an email address.</p>
        <div class="row between small"><a href="${go('auth/sign-in')}">Back to sign in</a><a href="${go('auth/guest-orders')}">Find a guest order</a></div>
      `), 'Reset password', go('auth/sign-in'));
    },
  });

  U.register({
    id: 'auth/guest-orders', title: 'Guest order lookup', ref: 'Plan ch. 6–7',
    notes: 'Guests can revisit an order with the order reference and the email used at checkout. Found orders show items by seller package with item-level status, plus Track and Get help actions.',
    states: ['Look up', 'Found'],
    render: (state) => {
      if (state === 'Found') {
        const pk = [
          { seller: 'official', label: 'Package 1 of 2', st: 'Delivered', eta: 'Delivered Tue, Oct 6', carrier: 'UPS Ground · 1Z84E2W70392044210', items: [[P.skillet, '26 cm', 58.00, 'Delivered']] },
          { seller: 'trailhead', label: 'Package 2 of 2', st: 'In transit', eta: 'Arrives Fri, Oct 9', carrier: 'USPS Ground Advantage · 9400 1112 0298 7741 5530 18', items: [[P.bottle, 'Slate', 29.50, 'In transit']] },
        ];
        return U.storeLayout(`<div class="container page"><div class="buy-narrow stack gap-5">
          <div class="stack gap-2"><a class="small strong no-phone" href="${go('auth/guest-orders')}">${icon('arrow-left', 'ic-sm')} Look up another order</a><h1 class="h1">Order <span class="buy-ref">MK-261002-66018</span></h1><p class="small sub">Placed Fri, Oct 2, 2026 as a guest · taylor.brooks@example.com</p></div>
          <div class="card pad"><div class="grid md3" style="--gap:var(--sp-4)">
            <div class="stack gap-1"><span class="xs muted">Order status</span>${U.status('Partly delivered')}</div>
            <div class="stack gap-1"><span class="xs muted">Payment · Mastercard •••• 2291</span><span class="row gap-2"><span class="strong num">${money(92.49)}</span>${U.status('Accepted')}</span></div>
            <div class="stack gap-1"><span class="xs muted">Delivering to</span><span class="small">Taylor Brooks, 77 NE Fremont St, Portland, OR 97212</span></div>
          </div></div>
          ${pk.map((g) => { const s = S[g.seller]; return `<section class="card buy-pkg"><div class="buy-pkg-head"><div class="row gap-2">${logoTile(s)}<div class="stack gap-0"><span class="row gap-2"><span class="strong">${esc(s.name)}</span>${sellerBadge(s, true)}</span><span class="xs muted">${g.label} · ${g.carrier}</span></div></div><span class="row gap-2">${U.status(g.st)}<span class="xs strong">${g.eta}</span></span></div>
            ${g.items.map(([p, v, pr, st]) => `<div class="buy-item"><span>${pimg(p)}</span><div class="stack gap-1"><span class="buy-name">${esc(p.name)}</span><span class="xs sub">${v} · New · Qty 1</span><span>${U.status(st)}</span></div><div class="buy-item-side"><span class="small strong num">${money(pr)}</span></div></div>`).join('')}
            <div class="card-foot">${btn('Track package', { v: 'secondary', size: 'sm', icon: 'truck', href: go('account/tracking') })}${btn('Get help', { v: 'ghost', size: 'sm', icon: 'life-buoy', href: go('help/order-problem') })}</div>
          </section>`; }).join('')}
          <div class="card pad buy-sum">${sumRow('Items (2)', money(87.50))}${sumRow('Shipping · Trailhead Outfitters', money(4.99))}${sumRow('Shipping · Marketly Official', 'Free')}${sumRow('Tax', money(0))}${sumRow('Total charged', money(92.49), 'total')}</div>
          <div class="panel row gap-3">${icon('user-plus')}<span class="small grow">Create an account with taylor.brooks@example.com to keep this order and future orders in one place.</span>${btn('Create account', { v: 'secondary', size: 'sm', href: go('auth/register') })}</div>
        </div></div>`, { tab: 'account', signedIn: false, appbar: { title: 'Your order', back: go('auth/guest-orders') } });
      }
      return authLayout(authCard(`
        <span class="buy-result-icon t-info">${icon('package-search')}</span>
        <div class="stack gap-1"><h1 class="h2">Find your guest order</h1><p class="small sub">Bought without an account? Look up your order to track packages, start a return or get help.</p></div>
        ${field('Order reference', input('go-ref', 'MK-261002-66018', { placeholder: 'MK-YYMMDD-NNNNN' }), { hint: 'It\'s in your confirmation email, starting with MK-.' })}
        ${field('Email used at checkout', input('go-email', 'taylor.brooks@example.com', { type: 'email' }))}
        ${btn('Find order', { block: true, size: 'lg', href: go('auth/guest-orders', 'Found') })}
        <p class="xs muted">We can also email you a fresh link to every order placed with this email. <a href="javascript:void 0">Email me my order links</a></p>
        <p class="small center">Have an account? <a class="strong" href="${go('auth/sign-in')}">Sign in</a> to see all your orders.</p>
      `), 'Guest order lookup');
    },
  });

  /* ==================== HELP ==================== */
  const helpLayout = (content, title, back, o = {}) => U.storeLayout(`<div class="container page">${content}</div>`, Object.assign({ tab: 'account', appbar: { title, back: back || go('help/center') } }, o));
  const contactCards = () => `<div class="buy-contact">
      <div class="card pad stack gap-2">${icon('message-circle')}<span class="strong">Chat with us</span><span class="xs muted">Mon–Sat, 8 AM–8 PM PT · Typical wait 2 minutes</span>${btn('Start chat', { v: 'secondary', size: 'sm' })}</div>
      <div class="card pad stack gap-2">${icon('phone')}<span class="strong">Call 1-800-555-0136</span><span class="xs muted">Mon–Sat, 8 AM–8 PM PT · Closed Sundays and US holidays</span>${btn('Request a call back', { v: 'secondary', size: 'sm', href: go('help/contact') })}</div>
      <div class="card pad stack gap-2">${icon('mail')}<span class="strong">Send a message</span><span class="xs muted">Any time · We reply within 1 business day</span>${btn('Write to us', { v: 'secondary', size: 'sm', href: go('help/contact') })}</div>
    </div>`;

  U.register({
    id: 'help/center', title: 'Help Center', ref: 'Plan ch. 17',
    notes: 'Search, topic areas named in the plan, order-specific help with the affected items already identified, popular articles and contact options with hours.',
    render: () => {
      const topics = [
        ['shopping-bag', 'Shopping', 'Offers, sellers, product questions'], ['truck', 'Delivery', 'Estimates, tracking, late packages'], ['credit-card', 'Payment', 'Methods, failed or pending payments'], ['circle-x', 'Cancellations', 'Cancel items before they ship'],
        ['undo-2', 'Returns', 'Windows, labels, who pays shipping'], ['banknote', 'Refunds', 'Refund timing and status'], ['user-round', 'Account', 'Sign-in, security, addresses'], ['store', 'Marketplace sellers', 'Buying from outside sellers'],
      ];
      const orders = D.orders.slice(0, 3);
      return helpLayout(`
        <section class="buy-help-hero">
          <h1 class="display d-lg">How can we help, ${D.customer.first}?</h1>
          <label class="search-in" for="hc-q">${icon('search', 'ic-sm')}<input id="hc-q" type="search" placeholder="Search help, for example &quot;return shipping&quot;"></label>
          <div class="row gap-2 xs" style="justify-content:center"><span class="muted">Popular:</span><a href="${go('help/article')}">Return a seller item</a><a href="javascript:void 0">Where is my package?</a><a href="javascript:void 0">Refund timing</a></div>
        </section>
        <div class="split">
          <div class="stack gap-6">
            <section class="stack gap-3"><h2 class="h2">Browse by topic</h2>
              <div class="buy-topics">${topics.map(([ic, t, d]) => `<a class="buy-topic" href="${go('help/article')}">${icon(ic)}<span class="strong small">${t}</span><span class="xs muted">${d}</span></a>`).join('')}</div>
            </section>
            <section class="stack gap-3"><h2 class="h2">Popular articles</h2>
              <ul class="card list pad">${['Returning an item bought from a marketplace seller', 'My package is late. What can I do?', 'Why did my order arrive in several packages?', 'My payment is pending. Was I charged?', 'How long do refunds take to reach my card?', 'What do Official Store and Verified seller mean?'].map((t) => `<li><a class="row gap-3 grow" style="color:var(--text)" href="${go('help/article')}">${icon('file-text', 'ic-sm')}<span class="small grow">${t}</span>${icon('chevron-right', 'ic-sm')}</a></li>`).join('')}</ul>
            </section>
            <section class="stack gap-3"><h2 class="h2">Contact us</h2>${contactCards()}<p class="xs muted">For items from marketplace sellers, the seller answers first. If they haven't replied within 2 business days, ${U.BRAND} support steps in.</p></section>
          </div>
          <aside class="stack gap-4">
            ${card({ title: 'Get help with a recent order', sub: 'Pick the order. The items are filled in for you.', flush: true, body: `<div>${orders.map((o) => `<a class="buy-order-pick" href="${go('help/order-problem')}"><span class="buy-thumbs">${o.items.slice(0, 3).map((id) => pimg(P[id])).join('')}</span><span class="stack gap-0 grow"><span class="small strong mono">${o.ref}</span><span class="xs muted">${o.date} · ${o.items.length} item${o.items.length > 1 ? 's' : ''} · ${o.sellers} seller${o.sellers > 1 ? 's' : ''}</span></span>${U.status(o.status)}</a>`).join('')}</div>`, foot: `<a class="small strong" href="${go('account/orders')}">See all orders</a>` })}
            <div class="card pad stack gap-2"><span class="row gap-2"><span class="strong small">Your support cases</span>${badge('3 open', 'info')}</span><span class="xs muted">CS-104882 is waiting on Casa Verde Home. Reply expected by Fri, Oct 9.</span><a class="small strong" href="${go('help/cases')}">View cases</a></div>
            <div class="card pad stack gap-2"><span class="strong small">Not signed in?</span><span class="xs muted">Guests can look up an order with the reference and email.</span><a class="small strong" href="${go('auth/guest-orders')}">Guest order lookup</a></div>
          </aside>
        </div>`, 'Help', go('store/home'), { tab: 'account' });
    },
  });

  U.register({
    id: 'help/article', title: 'Help article', ref: 'Plan ch. 13, 17',
    notes: 'A help article with breadcrumb, effective and updated dates, steps, the who-pays-return-shipping table and when Marketly steps in, plus related articles and feedback.',
    render: () => helpLayout(`
      ${crumbs([{ label: 'Help Center', href: go('help/center') }, { label: 'Returns', href: go('help/center') }, 'Returning a marketplace seller item'])}
      <div class="split">
        <article class="stack gap-5">
          <div class="stack gap-2"><h1 class="h1">Returning an item bought from a marketplace seller</h1>
            <div class="buy-meta-strip"><span>${icon('calendar')}Effective Sep 1, 2026</span><span>${icon('history')}Updated Oct 2, 2026</span><span>${icon('clock')}4 min read</span></div></div>
          <div class="prose">
            <p>Items sold by outside sellers on ${U.BRAND} are returned to that seller, not to our warehouse. The seller's return terms are shown on the product page and in your order. Every seller must accept returns for at least 30 days after delivery, and many offer longer.</p>
            <h2>How to return an item</h2>
            <ol>
              <li>Go to <a href="${go('account/orders')}">Orders</a> and open the order.</li>
              <li>Choose <b>Return items</b> next to the package, then select the item and quantity.</li>
              <li>Pick a reason and add photos if the item is damaged, defective or not as described.</li>
              <li>Check the summary: return deadline, where it goes, who pays shipping and your refund amount.</li>
              <li>Submit. The seller approves, asks for details or explains a rejection within 2 business days.</li>
              <li>Pack the item and drop it off with the label or instructions you receive. Track the return on your order page.</li>
            </ol>
            <h2>Who pays return shipping</h2>
          </div>
          ${table(['Reason for return', 'Who pays return shipping', 'Original shipping refunded'], [
            ['Damaged in delivery', '<b>Seller</b> · prepaid label', 'Yes'],
            ['Incorrect item sent', '<b>Seller</b> · prepaid label', 'Yes'],
            ['Defective or not working', '<b>Seller</b> · prepaid label', 'Yes'],
            ['Changed my mind', '<b>You</b>, unless the seller offers free returns', 'No'],
          ])}
          <p class="xs muted">Official Store items always have free return shipping. Some categories have exceptions, such as opened bedding or personal care items. See the <a href="${go('info/policy', 'Returns')}">Returns policy</a>.</p>
          <div class="prose">
            <h2>When ${U.BRAND} steps in</h2>
            <ul>
              <li>The seller hasn't replied to your return request within 2 business days.</li>
              <li>The seller rejected the return and you don't agree with the reason.</li>
              <li>Your refund hasn't been sent within 3 business days after the seller received the item.</li>
            </ul>
            <p>Choose <b>Ask ${U.BRAND} to help</b> on the return. Our team reviews the purchase terms, tracking, photos and messages, then makes a decision. You can appeal a decision within 14 days.</p>
          </div>
          <div class="card pad row between"><span class="strong small">Was this helpful?</span><span class="row gap-2">${btn('Yes', { v: 'secondary', size: 'sm', icon: 'thumbs-up' })}${btn('No', { v: 'secondary', size: 'sm', icon: 'thumbs-down' })}</span></div>
        </article>
        <aside class="stack gap-4">
          ${card({ title: 'Related articles', flush: true, body: `<ul class="list pad">${['How refunds are calculated', 'Return windows by category', 'My return label doesn\'t work', 'Refund-without-return: when it applies', 'Appealing a decision'].map((t) => `<li><a class="small" href="${go('help/article')}">${t}</a></li>`).join('')}</ul>` })}
          <div class="card pad stack gap-2"><span class="strong small">Start a return</span><span class="xs muted">Returns start from your order so the item is already identified.</span>${btn('Go to my orders', { v: 'secondary', size: 'sm', href: go('account/orders') })}</div>
          <div class="card pad stack gap-2"><span class="strong small">Still need help?</span><span class="xs muted">Mon–Sat, 8 AM–8 PM PT</span>${btn('Contact us', { v: 'ghost', size: 'sm', href: go('help/contact'), icon: 'headset' })}</div>
        </aside>
      </div>`, 'Help article'),
  });

  U.register({
    id: 'help/contact', title: 'Contact support', ref: 'Plan ch. 17',
    notes: 'Contact form tied to the affected order and item, with attachments and channel options showing expected response times.',
    render: () => helpLayout(`
      ${crumbs([{ label: 'Help Center', href: go('help/center') }, 'Contact us'])}
      <div class="split">
        <div class="stack gap-4">
          <h1 class="h1">Contact ${U.BRAND} support</h1>
          ${card({ title: 'What do you need help with?', body: `
            ${field('Topic', select('ct-topic', ['Delivery: late or missing package', 'Damaged or wrong item', 'Returns and refunds', 'Payment or charge question', 'Cancel an item', 'Account and sign-in', 'Something else'], 'Delivery: late or missing package'))}
            <div class="grid md2">${field('Order', select('ct-order', D.orders.map((o) => `${o.ref} · ${o.date}`), 'MK-260914-48213 · Sep 14, 2026'))}${field('Item', select('ct-item', ['Mosswood Washed Linen Duvet Cover, Queen (Casa Verde Home)', 'Kestrel 1 TB Portable SSD ×2 (Pixel & Port)', 'Halden Aurora ANC Headphones (Marketly Official)', 'Mosswood Ceramic Pour-over Set (Marketly Official)', 'Whole order'], 'Mosswood Washed Linen Duvet Cover, Queen (Casa Verde Home)'))}</div>
            <div class="buy-note t-info">${icon('info')}<span>This item already has an open case, <a href="${go('help/case')}">CS-104882</a>. Adding a message there keeps everything in one place.</span></div>
            ${field('Message', textarea('ct-msg', '', 'Tell us what happened and what you would like us to do.'), { hint: 'Don\'t include full card numbers or passwords.' })}
            <div class="field"><span class="label">Attachments <span class="opt">(optional)</span></span>${U.dropzone('Add photos or screenshots', 'JPG, PNG or PDF, up to 10 MB each, 5 files max')}</div>
          ` })}
          ${card({ title: 'How should we reply?', body: `<div class="buy-opts">
              ${optCard('ct-ch', 'ct-ch-email', '<span class="row between"><span class="small strong">Email</span><span class="xs strong">Within 1 business day</span></span>', 'Reply goes to jordan.lee@example.com and appears in Support cases.', true, { right: icon('mail') })}
              ${optCard('ct-ch', 'ct-ch-chat', '<span class="row between"><span class="small strong">Chat</span><span class="xs strong">About 2 minutes</span></span>', 'Open now until 8 PM PT. Your message starts the chat.', false, { right: icon('message-circle') })}
              ${optCard('ct-ch', 'ct-ch-phone', '<span class="row between"><span class="small strong">Phone call back</span><span class="xs strong">Within 4 business hours</span></span>', 'We call (503) 555-0148 between 8 AM and 8 PM PT.', false, { right: icon('phone') })}
            </div>`, foot: `${btn('Cancel', { v: 'ghost', href: go('help/center') })}${btn('Send message', { icon: 'send', href: go('help/cases') })}` })}
        </div>
        <aside class="stack gap-4">
          <div class="card pad stack gap-2"><span class="strong small">Support hours</span>${kv([['Chat', 'Mon–Sat, 8 AM–8 PM PT'], ['Phone', '1-800-555-0136, Mon–Sat 8 AM–8 PM PT'], ['Messages', 'Any time, reply in 1 business day']])}</div>
          <div class="card pad stack gap-2"><span class="strong small">Item from a marketplace seller?</span><span class="xs muted">The seller handles questions about their items first. You can <a href="${go('account/messages')}">message the seller</a> from your order. We step in if they don't reply within 2 business days.</span></div>
        </aside>
      </div>`, 'Contact us'),
  });

  U.register({
    id: 'help/order-problem', title: 'Report an order problem', ref: 'Plan ch. 7, 13, 17',
    notes: 'Opened from order MK-260914-48213 with items pre-identified per seller package. Shows who handles it first (the seller) and exactly when Marketly steps in.',
    render: () => {
      const o = D.order;
      return helpLayout(`
        ${crumbs([{ label: 'Orders', href: go('account/orders') }, { label: o.ref, href: go('account/order') }, 'Report a problem'])}
        <div class="split">
          <div class="stack gap-4">
            <div class="stack gap-1"><h1 class="h1">Report a problem</h1><p class="small sub">Order <span class="mono">${o.ref}</span> · placed ${o.placed}</p></div>
            ${card({ title: '1. Which items are affected?', sub: 'We selected the item you came from. Add others if needed.', flush: true, body: o.groups.map((g) => { const s = S[g.seller]; return `<div class="buy-pkg-head" style="border-top:1px solid var(--border)"><span class="row gap-2"><span class="small strong">${g.pkg} · ${esc(s.name)}</span>${sellerBadge(s, true)}</span>${U.status(g.status)}</div>
                ${g.items.map((it) => { const p = P[it.p]; const on = it.p === 'duvet'; return `<label class="buy-item buy-item-chk" for="op-it-${it.p}" style="cursor:pointer"><span class="row gap-3 nowrap"><input type="checkbox" id="op-it-${it.p}"${on ? ' checked' : ''} style="width:18px;height:18px;accent-color:var(--brand)">${pimg(p, 'thumb')}</span><span class="stack gap-1"><span class="buy-name">${esc(p.name)}</span><span class="xs sub">${it.variant} · Qty ${it.qty} · ${money(it.price)}</span><span>${U.status(it.state)}</span></span></label>`; }).join('')}`; }).join('') })}
            ${card({ title: '2. What\'s wrong?', body: `<div class="buy-opts c2">
                ${[['missing', 'Item missing from package', 'package-x'], ['damaged', 'Arrived damaged', 'package-open'], ['wrong', 'Wrong item', 'replace'], ['late', 'Hasn\'t arrived', 'clock'], ['other', 'Something else', 'circle-help']].map(([k, t, ic]) => optCard('op-type', 'op-type-' + k, `<span class="row gap-2 small strong">${icon(ic, 'ic-sm')}${t}</span>`, '', k === 'late')).join('')}
              </div>
              <div class="buy-note">${icon('triangle-alert')}<span>This package was due Sep 22. Casa Verde Home now estimates Oct 12. No tracking number has been added yet.</span></div>
              ${field('Details', textarea('op-details', 'The duvet cover was due on Sep 22 and still hasn\'t shipped. I\'d like it by mid-October or my money back.'))}
              <div class="field"><span class="label">Photos <span class="opt">(optional for late items)</span></span>${U.dropzone('Add photos of the package or item', 'Helpful for damaged, wrong or missing items. JPG or PNG, up to 10 MB each')}</div>` })}
            ${card({ title: '3. What would you like?', body: `<div class="buy-opts c2">
                ${optCard('op-rem', 'op-rem-refund', '<span class="small strong">Refund</span>', money(119.00) + ' back to Visa •••• 4417 if the item can\'t ship soon', true)}
                ${optCard('op-rem', 'op-rem-repl', '<span class="small strong">Keep waiting for it</span>', 'Ship as soon as possible, with a firm date from the seller', false)}
              </div><span class="xs muted">The seller or ${U.BRAND} confirms the final remedy. A refund shows as Sent only when it has left us.</span>`, foot: `${btn('Cancel', { v: 'ghost', href: go('account/order') })}${btn('Send to Casa Verde Home', { icon: 'send', href: go('help/case', 'Open') })}` })}
          </div>
          <aside class="sticky-aside stack gap-4">
            ${card({ title: 'Who handles this', body: `
              <div class="row gap-3 nowrap">${logoTile(S.casaverde)}<div class="stack gap-0"><span class="small strong">Casa Verde Home handles it first</span><span class="xs muted">The seller shipped this package and must reply within 2 business days, by Mon, Oct 12.</span></div></div>
              <hr>
              <div class="row top gap-3 nowrap">${icon('life-buoy')}<div class="stack gap-1"><span class="small strong">When ${U.BRAND} steps in</span><ul class="ul xs sub stack gap-1"><li>If the seller hasn't replied within 2 business days</li><li>If you don't agree with the seller's answer</li><li>If a promised refund isn't sent on time</li></ul></div></div>
              <span class="xs muted">You'll get a case number and can follow every reply in Support cases.</span>` })}
            <div class="card pad stack gap-2"><span class="small strong">Other items in this order</span><span class="xs muted">The SSDs are in transit and arrive Oct 9–10. Report them after that date if they don't show up.</span></div>
          </aside>
        </div>`, 'Report a problem', go('account/order'));
    },
  });

  /* ==================== SUPPORT CASES ==================== */
  const CASES = [
    { ref: 'CS-104882', subject: 'Linen duvet cover hasn\'t arrived', order: 'MK-260914-48213', item: 'duvet', status: 'Waiting on seller', who: 'Casa Verde Home', role: 'Seller', next: 'Casa Verde Home confirms a ship date or offers a refund', reply: 'By Fri, Oct 9, 5:00 PM PT', open: true },
    { ref: 'CS-104860', subject: 'Pour-over carafe arrived chipped', order: 'MK-260914-48213', item: 'pourover', status: 'Open', who: 'Marketly Official returns team', role: 'Official Store', next: 'Returns team reviews your photos', reply: 'Today by 8:00 PM PT', open: true },
    { ref: 'CS-104731', subject: 'Charged twice for one order?', order: 'MK-261006-90127', item: 'bottle', status: 'Waiting on customer', who: 'Isabel Cruz, Marketly support', role: 'Marketly', next: 'You: send a screenshot of the two charges', reply: 'We reply within 1 business day of your message', open: true, you: true },
    { ref: 'CS-103977', subject: 'Refund for returned backpack', order: 'MK-260818-07352', item: 'backpack', status: 'Resolved', who: 'Trailhead Outfitters', role: 'Seller', next: 'None. Refund sent Aug 27', reply: 'Closed Aug 28', open: false },
    { ref: 'CS-103502', subject: 'Cancel running shoes before shipping', order: 'MK-260811-03309', item: 'shoes', status: 'Resolved', who: 'Trailhead Outfitters', role: 'Seller', next: 'None. Item cancelled, refund sent Aug 12', reply: 'Closed Aug 12', open: false },
  ];

  U.register({
    id: 'help/cases', title: 'Support cases', ref: 'Plan ch. 7, 17',
    notes: 'Every case shows its reference, linked order, status, who is handling it, the next action and when a reply is expected. Cases where the customer must act are flagged.',
    render: () => {
      const open = CASES.filter((c) => c.open);
      const rows = CASES.map((c) => [
        `<a class="mono strong" href="${go('help/case', 'Open')}">${c.ref}</a>`,
        `<span class="cell-main">${pimg(P[c.item], 'tiny')}<span class="small">${esc(c.subject)}</span></span>`,
        `<a class="mono xs" href="${go('account/order')}">${c.order}</a>`,
        U.status(c.status),
        `<span class="stack gap-0"><span class="small">${esc(c.who)}</span><span class="xs muted">${c.role}</span></span>`,
        `<span class="small${c.you ? ' strong' : ''}">${esc(c.next)}</span>`,
        `<span class="xs">${c.reply}</span>`,
      ]);
      return U.accountLayout(`
        <div class="row between"><div class="stack gap-1"><h1 class="h1">Support cases</h1><p class="small sub">${open.length} open · Replies from sellers and ${U.BRAND} support appear here and by email.</p></div>${btn('Get help with an order', { icon: 'plus', href: go('help/center') })}</div>
        ${alert('warning', 'CS-104731 needs your reply', 'Isabel from Marketly support asked for a screenshot of the two charges. <a href="' + go('help/case', 'Open') + '">Reply now</a>')}
        ${U.tabs([{ label: 'Open', count: 3 }, { label: 'Closed', count: 2 }, { label: 'All', count: 5 }], 2)}
        <div class="card no-phone">${table(['Case', 'Subject', 'Order', 'Status', 'Handled by', 'Next action', 'Expected reply'], rows, { rowCls: CASES.map((c) => c.you ? 'is-warn' : '') })}</div>
        <div class="stack gap-3 only-phone">${CASES.map((c) => `<a class="card pad stack gap-2" style="color:var(--text);text-decoration:none" href="${go('help/case', 'Open')}">
          <div class="row between"><span class="mono strong small">${c.ref}</span>${U.status(c.status)}</div>
          <div class="row gap-3 nowrap">${pimg(P[c.item], 'tiny')}<span class="small strong">${esc(c.subject)}</span></div>
          <span class="xs muted">Order <span class="mono">${c.order}</span> · ${esc(c.who)} (${c.role})</span>
          <span class="xs${c.you ? ' strong t-warning-text' : ''}">${icon('arrow-right', 'ic-sm')} ${esc(c.next)}</span>
          <span class="xs muted">${icon('clock', 'ic-sm')} ${c.reply}</span>
        </a>`).join('')}</div>
        <p class="xs muted">Closed cases can be reopened within 30 days if the promised remedy didn't happen. Decisions can be appealed within 14 days.</p>
      `, { active: 'cases', title: 'Support cases', back: go('account/overview') });
    },
  });

  const msg = (who, kind, label, time, text, att) => `<div class="buy-msg is-${kind}">${U.avatar(who, kind === 'seller' ? 'sq' : '')}<div class="bubble"><div class="row between gap-2"><span class="row gap-2"><span class="small strong">${esc(who)}</span>${badge(label, kind === 'customer' ? 'brand' : kind === 'seller' ? 'warning' : 'info')}</span><span class="xs muted">${time}</span></div><p>${text}</p>${att ? `<span class="row gap-2">${att.map((a) => `<span class="buy-attach">${icon('paperclip', 'ic-sm')}${a}</span>`).join('')}</span>` : ''}</div></div>`;

  U.register({
    id: 'help/case', title: 'Support case', ref: 'Plan ch. 7, 13, 17',
    notes: 'Case CS-104882 about the delayed Casa Verde duvet: who handles it, the next action and who must take it, the expected response time, the linked item, a labelled conversation and timeline. After a decision, the remedy, refund progress (approved is not paid), appeal deadline and reopen rules are shown.',
    states: ['Open', 'Decision made'],
    render: (state) => {
      const decided = state === 'Decision made';
      const thread = [
        msg('Jordan Lee', 'customer', 'You', 'Tue, Oct 6, 4:10 PM', 'My duvet cover was due Sep 22 and still hasn\'t shipped. There\'s no tracking number on the order. Can you tell me when it will arrive?'),
        msg('Casa Verde Home', 'seller', 'Seller', 'Wed, Oct 7, 9:32 AM', 'Sorry for the wait, Jordan. Our sage linen restock arrives Oct 9. We\'ll ship on Oct 10 and expect delivery by Oct 12. We\'ll add tracking as soon as it leaves.'),
        msg('Isabel Cruz', 'staff', `${U.BRAND} support`, 'Wed, Oct 7, 11:05 AM', 'I\'m following this case. If the duvet hasn\'t shipped by Oct 10, you can choose a full refund and we\'ll make sure it happens. You don\'t need to do anything right now.'),
        msg('Jordan Lee', 'customer', 'You', 'Wed, Oct 7, 11:40 AM', 'Thanks. Attaching the original confirmation showing the Sep 22 date.', ['order-confirmation.png']),
      ];
      if (decided) {
        thread.push(msg('Casa Verde Home', 'seller', 'Seller', 'Thu, Oct 8, 8:15 AM', 'Our supplier has delayed the restock again and we can\'t give a firm ship date. We\'re sorry.'));
        thread.push(msg('Isabel Cruz', 'staff', `${U.BRAND} support`, 'Thu, Oct 8, 10:20 AM', 'We\'ve made a decision on this case: a full refund of $119.00 for the duvet cover. Details are at the top of this page. The rest of your order isn\'t affected.'));
      }
      const owner = decided
        ? `<div class="buy-owner">
            <div><span class="xs muted">Decided by</span><span class="small strong">Isabel Cruz, ${U.BRAND} support</span><span class="xs muted">Customer Support team</span></div>
            <div><span class="xs muted">Next action</span><span class="small strong">${U.BRAND} sends your refund</span><span class="xs muted">Nothing needed from you</span></div>
            <div><span class="xs muted">Expected</span><span class="small strong">Refund sent by Fri, Oct 9</span><span class="xs muted">Then 3–5 business days at your bank</span></div>
          </div>`
        : `<div class="buy-owner">
            <div><span class="xs muted">Handled by</span><span class="small strong">Casa Verde Home (seller)</span><span class="xs muted">${U.BRAND} support is following</span></div>
            <div><span class="xs muted">Next action · who must act</span><span class="small strong">Casa Verde Home confirms tracking or offers a refund</span><span class="xs muted">You don't need to do anything</span></div>
            <div><span class="xs muted">Expected response</span><span class="small strong">By Fri, Oct 9, 5:00 PM PT</span><span class="xs muted">If they miss it, ${U.BRAND} steps in</span></div>
          </div>`;
      const decision = decided ? `<section class="card">
          <div class="card-head"><div class="row gap-2">${icon('gavel')}<h2 class="h3">Decision: full refund of ${money(119.00)}</h2></div>${U.status('Decision made')}</div>
          <div class="card-body">
            <p class="small sub"><b>Why:</b> Casa Verde Home couldn't give a ship date for an item already 16 days past its delivery estimate. Under the <a href="${go('info/policy', 'Purchase terms')}">Purchase terms</a> you accepted on Sep 14, items that don't ship within 14 days of the estimate qualify for a full refund. The duvet cover is cancelled; the rest of order MK-260914-48213 continues as normal.</p>
            ${kv([['Remedy', 'Refund ' + money(119.00) + ' (item price, shipping was free)'], ['Refund to', 'Visa •••• 4417'], ['Funded by', 'Casa Verde Home, deducted from their earnings']])}
            <div class="stack gap-2"><span class="small strong">Refund progress</span>${U.track(['Requested', 'Approved', 'Processing', 'Sent'], 3)}<span class="xs muted">Approved means we've agreed to refund you. It isn't money in your account yet. After it's sent, your bank usually takes 3–5 business days.</span></div>
            <div class="panel stack gap-2"><span class="small strong">Don't agree? You can appeal until Oct 22</span><span class="xs sub">A different ${U.BRAND} team member reviews the case, the order terms and all messages, and replies within 3 business days.</span><div>${btn('Appeal this decision', { v: 'secondary', size: 'sm', icon: 'scale' })}</div></div>
            <p class="xs muted"><b>Reopen rules:</b> this case stays open until the refund is sent. After it closes, you can reopen it within 30 days if the refund doesn't reach you within 5 business days of being sent, or if the duvet arrives anyway and you need help returning it.</p>
          </div></section>` : '';
      const tl = decided
        ? [{ t: 'Case opened', d: 'Oct 6, 4:10 PM', state: 'done' }, { t: 'Sent to Casa Verde Home', d: 'Oct 6, 4:10 PM', state: 'done' }, { t: 'Seller replied', d: 'Oct 7, 9:32 AM', state: 'done' }, { t: `${U.BRAND} support joined`, d: 'Oct 7, 11:05 AM', state: 'done' }, { t: 'Seller missed new ship date', d: 'Oct 8, 8:15 AM', state: 'warn' }, { t: 'Decision made: full refund', d: 'Oct 8, 10:20 AM', state: 'done' }, { t: 'Refund processing', d: 'Sent by Oct 9', state: 'current' }, { t: 'Appeal window ends', d: 'Oct 22' }]
        : [{ t: 'Case opened', d: 'Oct 6, 4:10 PM', state: 'done' }, { t: 'Sent to Casa Verde Home', d: 'Oct 6, 4:10 PM', state: 'done' }, { t: 'Seller replied', d: 'Oct 7, 9:32 AM', state: 'done', body: 'New ship date Oct 10' }, { t: `${U.BRAND} support joined`, d: 'Oct 7, 11:05 AM', state: 'done' }, { t: 'Waiting on seller: tracking or refund', d: 'Due Oct 9, 5:00 PM PT', state: 'current' }, { t: `${U.BRAND} steps in if no reply`, d: 'From Oct 9, 5:00 PM PT' }];
      return U.accountLayout(`
        <div class="stack gap-2">${crumbs([{ label: 'Support cases', href: go('help/cases') }, 'CS-104882'])}
          <div class="row between"><div class="stack gap-1"><span class="row gap-2"><span class="mono strong small">CS-104882</span>${U.status(decided ? 'Decision made' : 'Waiting on seller')}</span><h1 class="h1">Linen duvet cover hasn't arrived</h1><span class="xs muted">Opened Tue, Oct 6 · Category: Delivery, late item · Priority: Normal</span></div></div></div>
        ${owner}
        ${decision}
        <div class="split">
          <div class="stack gap-4">
            ${card({ title: 'Conversation', sub: 'Messages from you, the seller and ' + U.BRAND + ' staff are labelled', body: `<div class="buy-thread">${thread.join('')}</div>`,
              foot: decided ? `<span class="xs muted grow">You can still add a message while the refund is processing.</span>${btn('Reply', { v: 'secondary', size: 'sm', icon: 'message-square' })}` : '' })}
            ${decided ? '' : card({ title: 'Reply', body: `${field('Your message', textarea('cs-reply', '', 'Write to Casa Verde Home and Marketly support'))}<div class="row between">${btn('Add photos', { v: 'secondary', size: 'sm', icon: 'image-plus' })}${btn('Send reply', { icon: 'send' })}</div>` })}
          </div>
          <aside class="stack gap-4">
            ${card({ title: 'Linked item', body: `<div class="buy-mini">${pimg(P.duvet)}<div class="stack gap-0"><span class="small strong">Mosswood Washed Linen Duvet Cover, Queen</span><span class="xs muted">Queen · Sage · Qty 1 · ${money(119.00)}</span></div></div>${kv([['Order', `<a class="mono" href="${go('account/order')}">MK-260914-48213</a>`], ['Package', '3 of 3 · Casa Verde Home'], ['Item status', U.status(decided ? 'Cancelled' : 'Delayed')], ['Estimate', decided ? 'Cancelled Oct 8' : 'Was Sep 22 · now Oct 12']])}` })}
            ${card({ title: 'Attachments', body: `<span class="buy-attach">${icon('paperclip', 'ic-sm')}order-confirmation.png · 212 KB</span>` })}
            ${card({ title: 'Timeline', body: timeline(tl) })}
          </aside>
        </div>
      `, { active: 'cases', title: 'CS-104882', back: go('help/cases') });
    },
  });

  /* ==================== POLICIES ==================== */
  const POLICIES = {
    'Returns': { v: '3.2', eff: 'Sep 1, 2026', prev: 'v3.1, Jun 1, 2026', ic: 'undo-2' },
    'Shipping': { v: '2.1', eff: 'Aug 15, 2026', prev: 'v2.0, May 20, 2026', ic: 'truck' },
    'Seller rules': { v: '1.4', eff: 'Sep 15, 2026', prev: 'v1.3, Jul 1, 2026', ic: 'store' },
    'Privacy': { v: '2.0', eff: 'Aug 1, 2026', prev: 'v1.2, Apr 10, 2026', ic: 'lock' },
    'Purchase terms': { v: '1.3', eff: 'Sep 1, 2026', prev: 'v1.2, Jun 1, 2026', ic: 'file-text' },
  };
  const whoPays = () => table(['Return reason', 'Official Store items', 'Marketplace seller items', 'Original shipping refunded'], [
    ['Damaged in delivery', 'Free', 'Seller pays', 'Yes'],
    ['Incorrect item sent', 'Free', 'Seller pays', 'Yes'],
    ['Defective or not working', 'Free', 'Seller pays', 'Yes'],
    ['Change of mind', 'Free', 'Customer pays, unless the seller offers free returns', 'No'],
  ]);
  function policyBody(name) {
    if (name === 'Shipping') return `<div class="prose">
      <p>Every item shows who ships it, where it ships from, the shipping cost and a delivery estimate for your address before you pay.</p>
      <h2>Who ships your order</h2><ul><li><b>Official Store items</b> ship from the ${U.BRAND} warehouse in Reno, NV.</li><li><b>Marketplace seller items</b> are shipped by the seller from their own location. Fulfillment by ${U.BRAND} for sellers will come later; sellers will still be named as the seller.</li><li>One order can arrive in several packages, one per seller or ship-from location.</li></ul>
      <h2>Costs</h2><ul><li>Official Store: free standard delivery on orders over $35, otherwise $5.99.</li><li>Sellers set their own rates. You see each package's cost at checkout.</li></ul>
      <h2>Delivery estimates</h2><p>Estimates combine the seller's dispatch time and the carrier's transit time to your ZIP code. If a package is late, we tell you and show your options on the order page.</p>
      <h2>Where we deliver</h2><p>We deliver to street addresses and PO boxes in the 50 US states. Some large items can't ship to PO boxes, Alaska or Hawaii; the product page tells you before checkout.</p>
      <h2>Late, lost or damaged packages</h2><ul><li>Report it from the order page. The seller responds first; ${U.BRAND} steps in after 2 business days.</li><li>If an item doesn't ship within 14 days of its estimate, you can cancel it for a full refund.</li></ul></div>`;
    if (name === 'Seller rules') return `<div class="prose">
      <p>These rules apply to every outside seller on ${U.BRAND}. Sellers accept them in the seller agreement. Customers can rely on them when buying from any seller.</p>
      <h2>Listing accuracy</h2><ul><li>Offers must match the catalog product exactly: model, variation, bundle contents and condition.</li><li>Used and refurbished items must describe wear and missing accessories.</li><li>Prices and discounts must be real. A "was" price must have been charged in the last 90 days.</li></ul>
      <h2>Dispatch and response targets</h2></div>
      ${table(['Measure', 'Target', 'Measured over'], [['On-time dispatch', 'At least 95% of orders', '30 days'], ['Valid tracking added', 'At least 95% of packages', '30 days'], ['Reply to customer messages', 'Within 1 business day', '30 days'], ['Seller cancellations', 'Below 2.5% of orders', '30 days'], ['Return requests answered', 'Within 2 business days', '30 days']])}
      <p class="xs muted">Example targets. Final targets are published in the seller service standards.</p>
      <div class="prose"><h2>What the Verified seller label means</h2><p>We checked the seller's business registration, the identity of its owner, a US bank account for payouts and a US return address. It does not mean we inspected each product. Report anything that looks wrong from the product or order page.</p>
      <h2>Restricted products</h2><p>Sellers can't list weapons, recalled items, prescription drugs, counterfeit goods or items outside our launch categories. Some categories need approval first.</p>
      <h2>Restrictions and appeals</h2><ul><li>When we restrict a seller, we tell them the reason, which activity is affected (for example, new sales or new listings) and how to appeal.</li><li>Existing orders, returns and customer cases continue while a seller is restricted.</li><li>Sellers can appeal within 14 days. A different team member reviews the appeal.</li></ul></div>`;
    if (name === 'Privacy') return `<div class="prose">
      <p>This policy explains what personal information ${U.BRAND} collects, why, and the choices you have.</p>
      <h2>What we collect</h2><ul><li>Account details: name, email, phone and password (stored encrypted).</li><li>Order details: addresses, items, payment results. Card numbers are handled by our payment processor; we keep only the last 4 digits.</li><li>Support messages and photos you send.</li><li>Basic device and usage data to keep the site secure and working.</li></ul>
      <h2>What sellers see</h2><p>Sellers get only what they need to deliver and support your order: your name, delivery address, phone for the carrier and the items you bought. They can't see your payment details or other orders.</p>
      <h2>Marketing</h2><p>We only send marketing emails if you opt in. Order, delivery and refund updates are always sent. Change this in Profile at any time.</p>
      <h2>How long we keep it</h2><p>Order records are kept for 7 years for tax and accounting. You can close your account and ask us to delete other data.</p>
      <h2>Your rights</h2><p>You can ask for a copy of your data, correct it or delete it. Email privacy@marketly.example or write to the address on our About page.</p></div>`;
    if (name === 'Purchase terms') return `<div class="prose">
      <p>These terms apply when you buy on ${U.BRAND}. Your order keeps the terms, and each seller's return terms, that were shown when you placed it.</p>
      <h2>Who you're buying from</h2><p>Each item names its seller. Official Store items are sold by ${U.BRAND}, Inc. Marketplace items are sold by the named seller; ${U.BRAND} operates the store, takes payment and provides support.</p>
      <h2>Prices and total</h2><p>You see the full total, including shipping and tax, before you place an order. If a price, stock level, delivery date or coupon changes before you pay, we show the change and ask you to choose.</p>
      <h2>When an order is accepted</h2><p>An order is accepted when your payment is accepted. We email a confirmation only then. If the payment result is uncertain, we tell you and don't charge you twice.</p>
      <h2>Cancellations</h2><p>You can cancel an item until its seller ships it. Cancelling one item doesn't cancel the rest of the order.</p>
      <h2>Returns, refunds and help</h2><p>Returns follow the <a href="${go('info/policy', 'Returns')}">Returns policy</a> and the seller's stated terms. If a seller doesn't resolve a problem, ${U.BRAND} reviews it and decides. You can appeal a decision within 14 days.</p>
      <h2>Changes to these terms</h2><p>We publish new versions with an effective date. Changes never apply to orders placed before that date.</p></div>`;
    return `<div class="prose">
      <p>Every item on ${U.BRAND} can be returned for at least 30 days after delivery unless a category exception below applies. Sellers can offer longer or free returns; their terms are shown on the product page before you buy.</p>
      <h2>Return window</h2><ul><li>30 days from delivery for most items.</li><li>Official Store items: 30 days, free return shipping for every reason.</li><li>Seller items: at least 30 days. Longer windows are shown on the offer.</li></ul>
      <h2>Who pays return shipping</h2></div>
      ${whoPays()}
      <div class="prose"><h2>Category exceptions</h2></div>
      ${table(['Category', 'Return window', 'Condition for change-of-mind returns'], [['Bedding and linens', '30 days', 'Unopened, in original packaging'], ['Beauty and personal care', '30 days', 'Unopened and sealed'], ['Electronics', '30 days', 'All accessories and packaging included'], ['Final sale items', 'No change-of-mind returns', 'Marked "Final sale" on the product page'], ['Damaged, wrong or defective items', '30 days in every category', 'No condition required']])}
      <div class="prose"><h2>Refunds</h2><ul><li>Refunds go back to your original payment method. You see each step: Requested, Under review, Approved, Processing, Sent.</li><li>Approved doesn't mean the money has arrived. Banks take 3–5 business days after we send it.</li><li>Partial returns refund only the returned items and their share of any discount.</li></ul>
      <h2>When ${U.BRAND} steps in</h2><p>If a seller doesn't answer a return request within 2 business days, rejects it and you disagree, or doesn't refund within 3 business days of receiving the item, ask ${U.BRAND} to help from the return page. In some cases we refund without asking you to send the item back, and we record why.</p></div>`;
  }

  U.register({
    id: 'info/policy', title: 'Policies', ref: 'Plan ch. 3, 10, 13, 19',
    notes: 'One policy template for Returns, Shipping, Seller rules, Privacy and Purchase terms. Each shows its effective date, version and previous versions, and states that orders keep the terms accepted at purchase.',
    states: Object.keys(POLICIES),
    render: (state) => {
      const name = POLICIES[state] ? state : 'Returns';
      const pol = POLICIES[name];
      const nav = `<nav class="side-nav" aria-label="Policies">${Object.keys(POLICIES).map((k) => `<a href="${go('info/policy', k)}" class="${k === name ? 'is-active' : ''}"${k === name ? ' aria-current="page"' : ''}>${icon(POLICIES[k].ic)}<span>${k}${k === 'Purchase terms' || k === 'Privacy' ? '' : ' policy'}</span></a>`).join('')}</nav>`;
      return U.storeLayout(`<div class="container page">
        ${crumbs([{ label: 'Home', href: go('store/home') }, { label: 'Policies', href: go('info/policy') }, name])}
        <div class="buy-policy">
          <aside class="only-desktop stack gap-3"><span class="eyebrow">Policies</span>${nav}<div class="panel xs muted">Questions about a policy? <a href="${go('help/contact')}">Contact us</a></div></aside>
          <article class="stack gap-5" style="min-width:0">
            <div class="no-desktop">${field('Policy', select('pol-pick', Object.keys(POLICIES), name))}</div>
            <div class="stack gap-3"><h1 class="h1">${name}${name === 'Purchase terms' || name === 'Privacy' ? '' : ' policy'}</h1>
              <div class="buy-meta-strip"><span>${icon('calendar-check')}Effective ${pol.eff}</span><span>${icon('file-text')}Version ${pol.v}</span><span>${icon('history')}<a href="javascript:void 0">Previous versions</a> (latest before this: ${pol.prev})</span></div>
              ${alert('info', 'Orders keep the terms accepted at purchase', 'If you ordered before ' + pol.eff + ', the version shown in your order details applies to that order.')}
            </div>
            ${policyBody(name)}
            <p class="xs muted">${U.BRAND}, Inc. · Policy owner: Content and Legal · Published ${pol.eff}</p>
          </article>
        </div>
      </div>`, { appbar: { title: name, back: go('help/center') } });
    },
  });

  U.register({
    id: 'info/about', title: 'About us', ref: 'Plan ch. 1, 3, 10',
    notes: 'Explains the hybrid model (Official Store plus approved sellers), how sellers are checked, what the Official Store, Verified seller and Sponsored labels mean, contact details and placeholder company facts.',
    render: () => U.storeLayout(`<div class="container page">
      <section class="stack gap-3" style="max-width:760px"><span class="eyebrow">About ${U.BRAND}</span><h1 class="display d-xl">One store for our own products and approved independent sellers</h1><p class="lead">You can buy from us and from sellers we've checked, in one cart and one checkout. Every item tells you who sells it, when it arrives and how returns work.</p></section>
      <div class="grid md2">
        <div class="card pad stack gap-3">${badge('Official Store', 'brand', 'badge-check')}<h2 class="h3">Products we sell ourselves</h2><p class="small sub">We buy the stock, set the price, pack it in our Reno, NV warehouse and handle returns. Free returns on every Official Store item.</p><a class="small strong" href="${go('store/official')}">Visit the Official Store</a></div>
        <div class="card pad stack gap-3">${badge('Verified seller', 'info', 'shield-check')}<h2 class="h3">Products from approved sellers</h2><p class="small sub">Independent businesses list their offers on our catalog and ship their own orders. They follow our seller rules, and we step in when something goes wrong.</p><a class="small strong" href="${go('info/policy', 'Seller rules')}">Read the seller rules</a></div>
      </div>
      <section class="stack gap-4"><h2 class="h2">How we check sellers</h2>
        <div class="grid md2 lg4">${[['file-check', 'Application review', 'We review the business, its products and where it ships from before approving it.'], ['user-round-check', 'Identity and bank checks', 'We confirm who owns the business and that payouts go to a verified US bank account.'], ['gauge', 'Ongoing performance', 'We track on-time dispatch, cancellations, replies and unresolved cases.'], ['shield-alert', 'Restrictions when needed', 'Sellers who miss our standards can be restricted. Your existing orders are still looked after.']].map(([ic, t, d]) => `<div class="buy-feature card pad">${icon(ic)}<div class="stack gap-1"><span class="small strong">${t}</span><span class="xs muted">${d}</span></div></div>`).join('')}</div>
      </section>
      <section class="stack gap-4"><h2 class="h2">What the labels mean</h2>
        ${table(['Label', 'What it means', 'What it doesn\'t mean'], [
          [badge('Official Store', 'brand', 'badge-check'), `Sold and shipped by ${U.BRAND}. We own the stock and handle service.`, 'It isn\'t a ranking. Other sellers may offer a better price.'],
          [badge('Verified seller', 'info', 'shield-check'), 'We checked the business registration, owner identity, payout account and return address.', 'We don\'t inspect every product a seller sends.'],
          [U.sponsored(), 'A seller or brand paid for this position. It\'s always labelled.', 'It isn\'t a recommendation from us, and it doesn\'t change the price.'],
        ])}
      </section>
      <div class="split">
        <section class="card pad stack gap-3"><h2 class="h3">Company facts</h2>${kv([['Company', `${U.BRAND}, Inc. <span class="xs muted">(placeholder)</span>`], ['Founded', '2026 <span class="xs muted">(placeholder)</span>'], ['Headquarters', 'Portland, Oregon <span class="xs muted">(placeholder)</span>'], ['Warehouse', 'Reno, Nevada'], ['Service region', 'United States, prices in USD'], ['Approved sellers', '120+ <span class="xs muted">(placeholder)</span>']])}</section>
        <section class="card pad stack gap-3"><h2 class="h3">Contact us</h2>${kv([['Customer support', '1-800-555-0136'], ['Hours', 'Mon–Sat, 8 AM–8 PM PT'], ['Email', 'help@marketly.example'], ['Mail', '1000 SW Broadway, Suite 1200, Portland, OR 97205'], ['Sellers', 'sellers@marketly.example'], ['Press', 'press@marketly.example']])}${btn('Contact support', { v: 'secondary', href: go('help/contact') })}</section>
      </div>
    </div>`, { appbar: { title: 'About us', back: go('store/home') } }),
  });

  /* ==================== SELLER ENTRY ==================== */
  const TARGETS = [['Dispatch on time', 'At least 95% of orders shipped by the dispatch deadline'], ['Tracking', 'Valid tracking on at least 95% of packages'], ['Customer messages', 'Reply within 1 business day'], ['Return requests', 'Answer within 2 business days'], ['Seller cancellations', 'Below 2.5% of orders']];

  U.register({
    id: 'sell/landing', title: 'Sell on Marketly', ref: 'Plan ch. 10, 14',
    notes: 'Explains eligible products, requirements, example fees and payout timing, shipping responsibilities, service targets and the application process before a seller applies. Business-decision values are marked as examples.',
    render: () => U.storeLayout(`<div class="container page" style="gap:var(--sp-8)">
      <section class="buy-sell-hero">
        <div class="stack gap-4">
          <span class="eyebrow" style="color:var(--text-inverse);opacity:.7">Sell on ${U.BRAND}</span>
          <h1 class="display d-xl">Reach shoppers in one store, next to our own products</h1>
          <p class="h-sub">List your offers on our shared catalog, ship your own orders and get paid weekly. We review every seller so customers trust who they buy from.</p>
          <div class="row gap-2">${btn('Start your application', { size: 'lg', href: go('sell/apply', 'Seller account'), iconR: 'arrow-right' })}<a class="btn btn-lg btn-ghost" style="color:var(--text-inverse)!important" href="#sell-fees">See fees</a></div>
          <span class="xs" style="opacity:.7">Takes about 20 minutes. Save a draft anytime. Already applied? <a style="color:var(--text-inverse)" href="${go('sell/status', 'Information required')}">Check your status</a></span>
        </div>
        <div class="buy-sell-stats">
          <div><span class="xs" style="opacity:.75">Launch categories</span><b>8</b></div>
          <div><span class="xs" style="opacity:.75">Example commission</span><b>7–15%</b></div>
          <div><span class="xs" style="opacity:.75">Example payouts</span><b>Weekly</b></div>
          <div><span class="xs" style="opacity:.75">Monthly fee at launch</span><b>$0</b></div>
        </div>
      </section>

      <div class="grid lg2" style="--gap:var(--sp-6)">
        <section class="stack gap-3"><h2 class="h2">What you can sell</h2>
          <div class="grid m2" style="--gap:var(--sp-2)">${D.categories.map((c) => `<div class="row gap-2 nowrap panel">${icon(c.icon, 'ic-sm')}<span class="small">${c.name}</span></div>`).join('')}</div>
          <p class="xs muted">New, used and refurbished physical goods in these categories. Not at launch: digital goods, subscriptions, gift cards, perishable food, weapons, recalled or restricted items.</p>
        </section>
        <section class="stack gap-3"><h2 class="h2">Seller requirements</h2>
          <ul class="stack gap-3">${[['building-2', 'A US business or sole proprietor', 'With an EIN or SSN for tax reporting.'], ['landmark', 'A US bank account', 'In the business or owner\'s name, for payouts.'], ['map-pin', 'A US return address', 'Street address that can receive returns.'], ['truck', 'Ship with tracking', 'Within your stated dispatch time, at most 3 business days.'], ['message-square', 'Answer customers', 'Within 1 business day, Monday to Friday.']].map(([ic, t, d]) => `<li class="buy-feature">${icon(ic)}<span class="stack gap-0"><span class="small strong">${t}</span><span class="xs muted">${d}</span></span></li>`).join('')}</ul>
        </section>
      </div>

      <section class="stack gap-4" id="sell-fees"><h2 class="h2">Fees</h2>
        <div class="split">
          <div class="card">${table(['Category', { label: 'Commission (example)', cls: 'r' }, 'Charged on'], [['Electronics', '8%', 'Item price after your discounts'], ['Computers', '7%', 'Item price after your discounts'], ['Home & Kitchen', '12%', 'Item price after your discounts'], ['Fashion', '15%', 'Item price after your discounts'], ['Sports & Outdoors', '12%', 'Item price after your discounts'], ['Beauty', '15%', 'Item price after your discounts']].map((r) => [r[0], `<span class="strong">${r[1]}</span>`, r[2]]))}</div>
          <div class="card pad stack gap-3"><span class="small strong">How a sale works out</span>
            <div class="buy-sum">${sumRow('Item sold', money(100))}${sumRow('Commission at 10% (example)', '−' + money(10))}${sumRow('Your earnings', money(90), 'total')}</div>
            <span class="xs muted">Shipping you charge isn't commissioned. Discounts funded by ${U.BRAND} don't reduce your earnings. No listing or monthly fees at launch.</span>
          </div>
        </div>
        <p class="xs muted">Example rates. Final fees are in the seller agreement and fee schedule you accept when you apply.</p>
      </section>

      <div class="grid lg2" style="--gap:var(--sp-6)">
        <section class="card pad stack gap-3"><h2 class="h3">When you get paid</h2>
          ${timeline([{ t: 'Customer receives the order', state: 'done', body: 'Earnings show as Pending in Seller Center.' }, { t: '7-day hold after delivery', state: 'done', body: 'Covers early returns and delivery problems.' }, { t: 'Earnings become Available', state: 'done' }, { t: 'Weekly payout every Tuesday', state: 'current', body: 'Sent to your verified bank account; arrives in 1–2 business days.' }])}
          <p class="xs muted">Example schedule. Final payout timing is in the seller agreement. Holds always show a reason and review date.</p>
        </section>
        <section class="card pad stack gap-3"><h2 class="h3">Who ships</h2>
          <div class="buy-feature">${icon('package')}<span class="stack gap-1"><span class="row gap-2"><span class="small strong">You ship your own orders</span>${badge('At launch', 'success')}</span><span class="xs muted">Set your shipping rates, coverage and dispatch time. Pack, ship and add tracking in Seller Center by the dispatch deadline.</span></span></div>
          <div class="buy-feature">${icon('warehouse')}<span class="stack gap-1"><span class="row gap-2"><span class="small strong">${U.BRAND} fulfillment</span>${badge('Later', '')}</span><span class="xs muted">Store stock in our warehouse and we ship for you. You stay the named seller and own the stock.</span></span></div>
        </section>
      </div>

      <section class="stack gap-4"><h2 class="h2">Service expectations</h2>
        <div class="card">${table(['Measure', 'Target'], TARGETS)}</div>
        <p class="xs muted">Example targets. Final targets are in the service standards. You see your results in Seller Center under Account health.</p>
      </section>

      <section class="stack gap-4"><h2 class="h2">How to join</h2>
        <ol class="buy-steps-list grid md2 lg3">${[['Create your seller account', 'Contact, business and store details.'], ['Verify your business', 'Identity, tax details, payout account and return address.'], ['Accept the agreement', 'Seller agreement, product rules, fee schedule and service standards.'], ['We review your application', 'Usually 3–5 business days. We may ask for more information.'], ['Set up your store', 'Shipping coverage, store profile and your first products or offers.'], ['Go live', 'We check launch readiness. Only approved products and offers are published.']].map(([t, d]) => `<li><span class="stack gap-1"><span class="small strong">${t}</span><span class="xs muted">${d}</span></span></li>`).join('')}</ol>
      </section>

      <section class="split">
        <div class="stack gap-3"><h2 class="h2">Questions sellers ask</h2>
          <div class="card pad buy-faq">${[['Do I need my own product listings?', 'No. If the product is already in our catalog, you add an offer to it: your price, condition, stock and dispatch time. New products need catalog approval first.'], ['Can I sell the same product as the Official Store?', 'Yes. Customers compare all offers on the product page. The main offer is chosen by a published rule based on eligibility, availability, delivery and total price.'], ['What does Verified seller mean?', 'We checked your business registration, owner identity, payout account and return address. It doesn\'t certify each product.'], ['What happens if I miss targets?', 'We contact you first. Repeated issues can lead to a restriction with a stated reason, the affected activity and an appeal route. Existing orders continue.'], ['Who handles returns?', 'You do, using your return address and our return baseline. We step in if a customer needs help and you haven\'t replied in time.']].map(([q, a], i) => `<details${i === 0 ? ' open' : ''}><summary>${q}${icon('chevron-down', 'ic-sm')}</summary><p>${a}</p></details>`).join('')}</div>
        </div>
        <aside class="card pad stack gap-3" style="align-self:start"><h2 class="h3">Ready to apply?</h2><p class="small sub">Have your business registration, tax ID, bank details and return address ready.</p>${btn('Start your application', { block: true, href: go('sell/apply', 'Seller account') })}<span class="xs muted">Questions first? Email sellers@marketly.example or call 1-800-555-0177, Mon–Fri 8 AM–5 PM PT.</span></aside>
      </section>
    </div>`, { appbar: { title: 'Sell on ' + U.BRAND, back: go('store/home') } }),
  });

  const APPLY_STEPS = ['Account', 'Business', 'Verification', 'Payout', 'Return address', 'Agreement'];
  U.register({
    id: 'sell/apply', title: 'Seller application', ref: 'Plan ch. 10',
    notes: 'Six-step application wizard following the plan: account, business, verification, payout, return address and agreement. Drafts save, progress is visible and a help panel explains what is needed.',
    states: ['Seller account', 'Business details', 'Verification', 'Payout and return address', 'Agreement'],
    render: (state) => {
      const cur = { 'Seller account': 0, 'Verification': 2, 'Payout and return address': 3, 'Agreement': 5 }[state] ?? 1;
      const stepLabel = state === 'Payout and return address' ? 'Steps 4–5 of 6: Payout and return address' : `Step ${cur + 1} of 6: ${APPLY_STEPS[cur]}`;
      const pct = [5, 25, 45, 65, 80, 95][cur];
      let body;
      if (state === 'Verification') {
        body = card({ title: 'Verify your business', sub: 'Step 3 of 6 · We use this to confirm who you are. It isn\'t shown to customers.', body: `
          <div class="stack gap-2"><span class="label">Business owner</span><div class="panel row gap-3">${U.avatar('Avery Stone')}<span class="stack gap-0 grow"><span class="small strong">Avery Stone</span><span class="xs muted">Owner · 100% ownership · Portland, OR</span></span>${U.status('Verified')}</div></div>
          <div class="field"><span class="label">Government photo ID</span><div class="panel row gap-3">${icon('file-check')}<span class="small grow">drivers-license-front.jpg · drivers-license-back.jpg</span>${badge('Uploaded', 'success', 'check')}</div></div>
          <div class="field"><span class="label">Business registration document</span>${U.dropzone('Upload your Oregon registration record', 'PDF, JPG or PNG up to 10 MB. Must show the legal name, registry number and status.')}</div>
          <div class="grid md2">${field('Tax ID (EIN)', input('ap-ein', '93-4418210'), { hint: 'Matches the name on your W-9.' })}${field('W-9 form', select('ap-w9', ['Fill in online', 'Upload a signed PDF'], 'Fill in online'))}</div>
          ${alert('info', 'Some applications get an extra check', 'Our Trust and Risk team reviews some applications, for example for high-value electronics. This can add up to 2 business days. We\'ll tell you if it applies.')}
        `, foot: `${btn('Back', { v: 'ghost', href: go('sell/apply', 'Business details') })}${btn('Continue to payout', { iconR: 'arrow-right', href: go('sell/apply', 'Payout and return address') })}` });
      } else if (state === 'Agreement') {
        const docs = [['Seller agreement', 'v1.4 · effective Sep 15, 2026', 'How selling, payouts, refunds and restrictions work.'], ['Product rules', 'v1.2', 'What you can list, condition grades and accuracy rules.'], ['Fee schedule', 'Example rates', 'Commission by category and how fees treat discounts, returns and disputes.'], ['Service standards', 'v1.1', 'Dispatch, tracking, reply and cancellation targets.']];
        body = card({ title: 'Review and accept', sub: 'Step 6 of 6 · Read each document. You can download copies.', body: `
          <div class="buy-agree">${docs.map(([t, v, d], i) => `<div><input type="checkbox" id="ap-ag-${i}"${i < 3 ? ' checked' : ''} style="width:18px;height:18px;margin-top:2px;accent-color:var(--brand)"><label class="stack gap-0 grow" for="ap-ag-${i}"><span class="small strong">I accept the ${t}</span><span class="xs muted">${d}</span></label><a class="small strong nowrap" href="${go('info/policy', 'Seller rules')}">${icon('file-text', 'ic-sm')} Read · ${v}</a></div>`).join('')}</div>
          ${field('Type your full name to sign', input('ap-sign', 'Avery Stone'), { hint: 'Signing as owner of Northwind Audio LLC on Thu, Oct 8, 2026.' })}
          <div class="panel stack gap-2"><span class="small strong">Application summary</span>${kv([['Account', 'avery@northwindaudio.example ' + U.status('Verified')], ['Business', 'Northwind Audio LLC · Oregon'], ['Verification', 'ID and registration uploaded'], ['Payout', 'Checking account •••• 7731'], ['Return address', '3315 SE Division St, Portland, OR 97202']])}</div>
          <p class="xs muted">After you submit, a Seller Manager reviews your application, usually within 3–5 business days. We email you if we need anything.</p>
        `, foot: `${btn('Back', { v: 'ghost', href: go('sell/apply', 'Payout and return address') })}${btn('Accept and submit application', { icon: 'send', href: go('sell/status', 'Information required'), disabled: false })}` });
      } else if (state === 'Seller account') {
        body = card({ title: 'Create your seller account', sub: 'Step 1 of 6 · This is how you sign in to Seller Center and how we contact you.', body: `
          <div class="buy-opts c2">${optCard('ap-acct', 'ap-acct-existing', '<span class="small strong">Use my ' + U.BRAND + ' account</span>', 'Sign in with your shopping account. Seller access is added to it.', false, { right: icon('user-round') })}${optCard('ap-acct', 'ap-acct-new', '<span class="small strong">Create a new seller login</span>', 'Use a separate email for your business.', true, { right: icon('user-plus') })}</div>
          <div class="grid md2">${field('Contact person', input('ap-contact', 'Avery Stone'), { hint: 'The person we contact about this application.' })}${field('Phone', input('ap-cphone', '(503) 555-0172', { type: 'tel' }))}</div>
          ${field('Work email', input('ap-cemail', 'avery@northwindaudio.example', { type: 'email' }), { hint: 'We send a 6-digit code to confirm it.' })}
          ${passField('ap-cpass', 'Password', 'Northwind-3315')}
          ${pwRules([true, true, true, true])}
          ${field('Store name', input('ap-cstore', 'Northwind Audio'), { hint: 'Shown to customers on your offers and storefront. You can change it later; changes are reviewed.' })}
          <fieldset class="stack gap-2" style="border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:var(--sp-2)">Seller type</legend><div class="buy-opts c2">${optCard('ap-stype', 'ap-stype-biz', '<span class="small strong">Business</span>', 'LLC, corporation or partnership with an EIN', true, { right: icon('building-2') })}${optCard('ap-stype', 'ap-stype-ind', '<span class="small strong">Individual</span>', 'Sole proprietor selling under your own name', false, { right: icon('user-round') })}</div></fieldset>
          ${field('Market', select('ap-market', ['United States (USD)'], 'United States (USD)'), { hint: 'At launch we sell in one market. The next steps list the requirements for US sellers.' })}
          ${check('ap-ctips', 'Email me tips for new sellers. Application and account notices are always sent.', false)}
        `, foot: `${btn('Cancel', { v: 'ghost', href: go('sell/landing') })}${btn('Create account and continue', { iconR: 'arrow-right', href: go('sell/apply', 'Business details') })}` });
      } else if (state === 'Payout and return address') {
        body = card({ title: 'Where we send your payouts', sub: 'Step 4 of 6 · Payouts go only to an account in the name of your business or its owner.', body: `
          ${field('Account holder name', input('ap-bname', 'Northwind Audio LLC'), { hint: "Must match your legal business name or the owner's name." })}
          ${field('Account type', select('ap-bkind', ['Business checking', 'Business savings'], 'Business checking'))}
          <div class="grid md2">${field('Routing number', input('ap-brout', '', { placeholder: '9 digits' }))}${field('Account number', input('ap-bacct', '', { placeholder: 'Account number' }))}</div>
          ${field('Confirm account number', input('ap-bacct2', '', { placeholder: 'Enter it again' }))}
          ${alert('info', 'How we verify your bank account', 'After approval we send 2 small deposits to this account. They arrive in 1–2 business days. Confirm the amounts in Seller Center to turn on payouts. Changing this account later needs a new check and a review.')}
          <div class="panel stack gap-1"><span class="small strong">Payout schedule (example)</span><span class="xs sub">Earnings become available 7 days after delivery and are paid every Tuesday. Example schedule; final timing is in the seller agreement.</span></div>
        ` }) + card({ title: 'Return address', sub: 'Step 5 of 6 · Customers ship returns here.', body: `
          ${check('ap-rsame', 'Same as business address: 3315 SE Division St, Portland, OR 97202', true)}
          <div class="grid md2">${field('Contact name', input('ap-rname', 'Northwind Audio Returns'))}${field('Phone', input('ap-rphone', '(503) 555-0172', { type: 'tel' }))}</div>
          ${field('Street address', input('ap-rline1', '3315 SE Division St', { readonly: true }), { hint: "Must be a street address. Carriers can't deliver returns to PO boxes." })}
          <div class="grid md3">${field('City', input('ap-rcity', 'Portland', { readonly: true }))}${field('State', input('ap-rstate', 'Oregon', { readonly: true }))}${field('ZIP code', input('ap-rzip', '97202', { readonly: true }))}</div>
          <div class="buy-note t-info">${icon('undo-2')}<span>Customers ship returns to this address. It is printed on return labels and shown to customers who return your items.</span></div>
        `, foot: `${btn('Back', { v: 'ghost', href: go('sell/apply', 'Verification') })}${btn('Continue to agreement', { iconR: 'arrow-right', href: go('sell/apply', 'Agreement') })}` });
      } else {
        body = card({ title: 'Tell us about your business', sub: 'Step 2 of 6 · Customers see your store name. Legal details stay private.', body: `
          <div class="buy-opts c2">${optCard('ap-type', 'ap-type-biz', '<span class="small strong">Registered business</span>', 'LLC, corporation or partnership', true)}${optCard('ap-type', 'ap-type-ind', '<span class="small strong">Individual seller</span>', 'Sole proprietor using your own name or SSN', false)}</div>
          <div class="grid md2">${field('Legal business name', input('ap-legal', 'Northwind Audio LLC'))}${field('Store name shown to customers', input('ap-store', 'Northwind Audio'), { hint: 'You can change it later. Changes are reviewed.' })}</div>
          <div class="grid md2">${field('Business type', select('ap-btype', ['LLC', 'Corporation', 'Partnership'], 'LLC'))}${field('State of registration', select('ap-state', ['Oregon', 'Washington', 'California', 'Nevada'], 'Oregon'))}</div>
          ${field('Business address', input('ap-addr', '3315 SE Division St, Portland, OR 97202'))}
          <div class="grid md2">${field('Business phone', input('ap-phone', '(503) 555-0172', { type: 'tel' }))}${field('Website', input('ap-web', 'northwindaudio.example'), { opt: true })}</div>
          <fieldset class="stack gap-2" style="border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:var(--sp-2)">What will you sell?</legend><div class="grid m2 md4" style="--gap:var(--sp-2)">${D.categories.slice(0, 8).map((c, i) => check('ap-cat-' + c.id, c.name, i === 0)).join('')}</div></fieldset>
          ${field('How many products do you plan to list?', select('ap-count', ['1–20', '21–100', '101–500', 'More than 500'], '21–100'))}
        `, foot: `${btn('Back', { v: 'ghost', href: go('sell/apply', 'Seller account') })}${btn('Continue to verification', { iconR: 'arrow-right', href: go('sell/apply', 'Verification') })}` });
      }
      return U.storeLayout(`<div class="container page" style="gap:var(--sp-5)">
        <div class="row between"><div class="stack gap-1"><h1 class="h1">Seller application</h1><span class="xs muted">${icon('circle-check', 'ic-sm')} Draft saved at 2:14 PM PT · Northwind Audio</span></div>${btn('Save draft and exit', { v: 'secondary', icon: 'save', href: go('sell/landing') })}</div>
        <div class="stack gap-2"><div class="row between xs"><span class="strong">${stepLabel}</span><span class="muted">${pct}% complete</span></div>${U.meter(pct)}${steps(APPLY_STEPS, cur)}</div>
        <div class="split">
          <div class="stack gap-4">${body}</div>
          <aside class="sticky-aside stack gap-4">
            ${card({ title: 'Help with this step', body: state === 'Seller account'
              ? '<ul class="ul small sub stack gap-2"><li>Use an email your team checks every day. Order and payout notices go there.</li><li>If you use your shopping account, your purchases stay private from seller staff you add later.</li><li>You can add seller staff with their own logins after approval.</li></ul>'
              : state === 'Payout and return address'
              ? '<ul class="ul small sub stack gap-2"><li>Find the routing and account numbers on a check or in your online banking.</li><li>We never ask for your online banking password.</li><li>If returns go to a warehouse, use its street address and a contact who can sign for packages.</li></ul>'
              : state === 'Verification'
              ? '<ul class="ul small sub stack gap-2"><li>Your registration record is free from the Oregon Secretary of State business registry.</li><li>Upload the whole page. Cropped screenshots are the most common reason we ask again.</li><li>Your ID is checked by our verification partner and then deleted from our systems after 90 days.</li></ul>'
              : state === 'Agreement'
                ? '<ul class="ul small sub stack gap-2"><li>The fee schedule shows example rates during this preview. Your final rates are confirmed in your approval email.</li><li>Approval doesn\'t publish products. Each product or offer is reviewed before it goes live.</li></ul>'
                : '<ul class="ul small sub stack gap-2"><li>Use the exact legal name on your registration.</li><li>Your store name can differ, but can\'t use a brand you don\'t own.</li><li>Pick every category you plan to sell in. Some need extra approval.</li></ul>' })}
            ${card({ title: 'What you\'ll need', body: `<ul class="stack gap-2 small">${[['Business registration', cur > 2], ['Tax ID (EIN or SSN)', cur > 2], ['Owner photo ID', cur >= 2], ['Bank account for payouts', cur > 3], ['US return address', cur > 4]].map(([t, ok]) => `<li class="row gap-2 nowrap">${icon(ok ? 'circle-check' : 'circle', 'ic-sm')}<span class="${ok ? '' : 'sub'}">${t}</span></li>`).join('')}</ul>` })}
            <div class="card pad stack gap-1"><span class="small strong">Talk to our seller team</span><span class="xs muted">sellers@marketly.example · 1-800-555-0177, Mon–Fri 8 AM–5 PM PT</span></div>
          </aside>
        </div>
      </div>`, { footer: false, tabbar: false, appbar: { title: 'Seller application', back: go('sell/landing') } });
    },
  });

  U.register({
    id: 'sell/status', title: 'Application status', ref: 'Plan ch. 10',
    notes: 'Seller application status using the plan statuses. Information required says exactly what is missing with an upload and deadline; Approved shows account status, product approval and payout readiness separately; Rejected gives the reason, options and reapply date.',
    states: ['Information required', 'Approved', 'Rejected'],
    render: (state) => {
      const head = (st, title, sub) => `<div class="stack gap-2"><span class="row gap-2"><span class="xs muted">Application <span class="mono">SA-260929-0412</span> · Northwind Audio LLC</span>${U.status(st)}</span><h1 class="h1">${title}</h1><p class="sub">${sub}</p></div>`;
      const tl = {
        'Information required': [{ t: 'Applied', d: 'Tue, Sep 29', state: 'done' }, { t: 'Information required', d: 'Requested Wed, Oct 7 by Grace Kim, Seller Manager', state: 'warn', body: '2 items needed by Thu, Oct 22' }, { t: 'Under review', d: 'Usually 3–5 business days after you reply' }, { t: 'Approved' }],
        'Approved': [{ t: 'Applied', d: 'Tue, Sep 29', state: 'done' }, { t: 'Information required', d: 'Oct 7, sent Oct 7', state: 'done' }, { t: 'Under review', d: 'Oct 7 – Oct 8', state: 'done' }, { t: 'Approved', d: 'Thu, Oct 8, 11:30 AM', state: 'done' }],
        'Rejected': [{ t: 'Applied', d: 'Tue, Sep 29', state: 'done' }, { t: 'Information required', d: 'Oct 7, sent Oct 7', state: 'done' }, { t: 'Under review', d: 'Oct 7 – Oct 8', state: 'done', body: 'Including an additional Trust and Risk check' }, { t: 'Rejected', d: 'Thu, Oct 8, 11:30 AM', state: 'danger' }],
      }[state] || [];
      let main;
      if (state === 'Approved') {
        main = `${head('Approved', 'You\'re approved to sell on ' + U.BRAND, 'Approved by Grace Kim, Seller Manager, on Thu, Oct 8. Finish setting up your store before your offers can go live.')}
          <div class="buy-indic">
            <div><span class="xs muted">Account status</span>${U.status('Approved')}<span class="small">You can sign in to Seller Center and set up your store.</span></div>
            <div><span class="xs muted">Product approval</span>${U.status('Draft', '')}<span class="small">0 products submitted. Each product or offer is reviewed before it's published.</span></div>
            <div><span class="xs muted">Payout readiness</span>${U.status('Pending')}<span class="small">Confirm the 2 small deposits sent to •••• 7731 on Oct 8.</span></div>
          </div>
          ${alert('info', 'Approval alone doesn\'t publish anything', 'Customers see your offers only after your store setup is complete and each offer is approved.')}
          ${card({ title: 'Next: finish setup', body: `<ul class="stack gap-2 small">${[['Set shipping coverage and rates', false], ['Complete your store profile and return policy', false], ['Confirm payout deposits', false], ['Submit your first products or offers', false]].map(([t]) => `<li class="row gap-2 nowrap">${icon('circle', 'ic-sm')}<span>${t}</span></li>`).join('')}</ul>`, foot: btn('Finish setup in Seller Center', { iconR: 'arrow-right', href: go('seller/setup') }) })}`;
      } else if (state === 'Rejected') {
        main = `${head('Rejected', 'We couldn\'t approve your application', 'Reviewed by Grace Kim, Seller Manager, with the Trust and Risk team on Thu, Oct 8.')}
          ${card({ title: 'Reason', body: `<p class="small">The registry number on your application doesn't match the Oregon Secretary of State record for Northwind Audio LLC, and the registration document we requested shows a different owner name. We can't verify who owns the business.</p><span class="xs muted">Rule: Seller agreement, section 2.1, Business verification.</span>` })}
          ${card({ title: 'What you can do', body: `<ul class="stack gap-3 small">
              <li class="buy-feature">${icon('scale')}<span class="stack gap-0"><span class="strong">Appeal by Thu, Oct 22</span><span class="xs muted">If our check was wrong, send the correct registration record. A different reviewer replies within 5 business days.</span></span></li>
              <li class="buy-feature">${icon('calendar-clock')}<span class="stack gap-0"><span class="strong">Reapply from Mon, Jan 4, 2027</span><span class="xs muted">Start a new application once the business registration and ownership records match.</span></span></li>
              <li class="buy-feature">${icon('mail')}<span class="stack gap-0"><span class="strong">Ask us a question</span><span class="xs muted">sellers@marketly.example · 1-800-555-0177, Mon–Fri 8 AM–5 PM PT</span></span></li>
            </ul>`, foot: `${btn('Contact the seller team', { v: 'ghost' })}${btn('Appeal this decision', { v: 'secondary', icon: 'scale' })}` })}
          <p class="xs muted">Your uploaded documents are kept for 90 days for the appeal and then deleted.</p>`;
      } else {
        main = `${head('Information required', 'We need 2 more things to review your application', 'Your application is on hold until we get these. Send them by Thu, Oct 22, 2026, or the application closes and you\'ll need to start again.')}
          ${alert('warning', 'Deadline: Thu, Oct 22, 2026', '14 days left · Requested on Wed, Oct 7 by Grace Kim, Seller Manager')}
          ${card({ title: '1. Full business registration record', sub: 'Needed for: Verification', body: `<p class="small sub">The file you uploaded (registration-screenshot.png) is cropped and doesn't show the registry number or the registered owner. Upload the full record from the Oregon Secretary of State business registry.</p>${U.dropzone('Upload registration record', 'PDF, JPG or PNG up to 10 MB')}` })}
          ${card({ title: '2. A street return address', sub: 'Needed for: Return address', body: `<p class="small sub">PO Box 1182 can't receive carrier returns. Add a street address where customers can send items back.</p>
              ${field('Street address', input('st-ret1', '3315 SE Division St'))}<div class="grid md3">${field('City', input('st-retc', 'Portland'))}${field('State', select('st-rets', ['Oregon', 'Washington'], 'Oregon'))}${field('ZIP code', input('st-retz', '97202'))}</div>` , foot: `${btn('Save draft', { v: 'ghost' })}${btn('Send for review', { icon: 'send' })}` })}`;
      }
      return U.storeLayout(`<div class="container page"><div class="split">
        <div class="stack gap-5">${main}</div>
        <aside class="stack gap-4">
          ${card({ title: 'Application progress', body: timeline(tl) })}
          ${card({ title: 'Your application', body: kv([['Applicant', 'Avery Stone'], ['Business', 'Northwind Audio LLC'], ['Categories', 'Electronics'], ['Submitted', 'Tue, Sep 29, 2026']]) })}
          <div class="card pad stack gap-1"><span class="small strong">Questions?</span><span class="xs muted">sellers@marketly.example · 1-800-555-0177, Mon–Fri 8 AM–5 PM PT</span></div>
        </aside>
      </div></div>`, { footer: false, appbar: { title: 'Application status', back: go('sell/landing') } });
    },
  });
})();
