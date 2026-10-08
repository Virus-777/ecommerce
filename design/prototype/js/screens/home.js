/* Customer Store · Home (plan ch. 3–4) */
(function () {
  const { register, storeLayout, productCard, sectionHead, icon, btn, badge, go, img, pimg, price, stars, logoTile, sellerBadge, countdown, meter, sponsored, esc } = UI;
  const D = window.D;

  UI.css('home', `
    .home-hero-art { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; padding: 0 24px 24px; align-content: center; }
    @container app (min-width: 768px) { .home-hero-art { padding: 32px 32px 32px 0; gap: 14px; } }
    .home-hero-art .imgph { border-radius: 16px; background: color-mix(in srgb, var(--on-brand) 88%, transparent); }
    .home-hero-art .imgph:nth-child(2) { transform: translateY(-10px); }
    .home-hero-art .imgph:nth-child(3) { transform: translateY(8px); }
    .home-cats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px 8px; }
    @container app (min-width: 768px) { .home-cats { grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 16px; } }
    .home-cat { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; color: var(--text) !important; text-decoration: none !important; font-size: var(--fs-xs); font-weight: 600; line-height: 1.25; }
    .home-cat .imgph { width: 64px; border-radius: 50%; }
    @container app (min-width: 768px) { .home-cat .imgph { width: 88px; } .home-cat { font-size: var(--fs-sm); } }
    .home-cat:hover .imgph { box-shadow: 0 0 0 2px var(--brand); }
    .home-deals { background: var(--deal-soft); border-radius: var(--r-xl); padding: 16px; }
    @container app (min-width: 768px) { .home-deals { padding: 24px; } }
    .home-deals .hscroll > * { width: 168px; }
    @container app (min-width: 1024px) { .home-deals .hscroll { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); } .home-deals .hscroll > * { width: auto; } }
    .deal-card { background: var(--surface); border-radius: var(--r-lg); padding: 10px; display: flex; flex-direction: column; gap: 6px; }
    .home-official { border-radius: var(--r-xl); background: var(--brand-soft); padding: 16px; display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 1024px) { .home-official { grid-template-columns: 280px minmax(0, 1fr); padding: 28px; align-items: center; } }
    .home-official .grid-products { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 768px) { .home-official .grid-products { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .home-official .pcard { background: var(--surface); padding: 10px; border-radius: var(--r-lg); }
    .home-sponsor { position: relative; border-radius: var(--r-xl); background: var(--surface); border: 1px solid var(--border); display: grid; grid-template-columns: minmax(0, 1fr); overflow: hidden; }
    @container app (min-width: 768px) { .home-sponsor { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); } }
    .home-sponsor .ad-label { background: var(--surface-3); color: var(--text-2); }
    .home-sellers { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .home-sellers { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @container app (min-width: 1024px) { .home-sellers { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .home-promise { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 1024px) { .home-promise { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .home-promise > div { display: flex; gap: 12px; align-items: flex-start; padding: 14px; border-radius: var(--r-lg); background: var(--surface); border: 1px solid var(--border); }
    .home-promise svg.lucide { color: var(--brand-text); }
    .home-row .hscroll > * { width: 156px; }
    @container app (min-width: 768px) { .home-row .hscroll > * { width: 200px; } }
  `);

  const P = D.P;
  const deals = ['vacuum', 'aurora', 'duvet', 'skillet', 'ssd1tb'].map((id) => P[id]);
  const claimed = [72, 41, 58, 86, 33];

  register({
    id: 'store/home', title: 'Home', ref: 'Plan ch. 3–4, 16',
    notes: 'Campaign banner, category shortcuts, flash deals, Official Store highlights, a sponsored brand placement and featured sellers. Phone width turns into the Android app layout with a bottom tab bar.',
    render: () => storeLayout(`
      <div class="container page" style="gap:var(--sp-7)">

        <section class="hero-banner" aria-label="Campaign">
          <div class="copy">
            <span class="eyebrow" style="color:var(--on-brand);opacity:.85">Home Week · Oct 6–19</span>
            <h1 class="display d-xl" style="color:var(--on-brand)">Up to 30% off bedding, lighting and cookware</h1>
            <p style="opacity:.9;max-width:40ch">Linen sets from Casa Verde, cast iron from the Official Store and smart lamps that charge your phone.</p>
            <div class="row gap-2"><a class="btn btn-lg" style="background:var(--on-brand);color:var(--brand-text)!important" href="${go('store/collection', 'Seasonal')}">Shop Home Week</a><a class="btn btn-lg btn-ghost" style="color:var(--on-brand)!important" href="${go('store/deals')}">All deals</a></div>
          </div>
          <div class="home-hero-art" aria-hidden="true">${pimg(P.duvet)}${pimg(P.lamp)}${pimg(P.skillet)}</div>
        </section>

        <section class="stack gap-4" aria-labelledby="h-cats">
          ${sectionHead('<span id="h-cats">Shop by category</span>', { link: 'All categories', href: go('store/categories') })}
          <div class="home-cats">${D.categories.map((c) => `<a class="home-cat" href="${go('store/category')}">${img(c.icon, c.tint)}<span>${esc(c.name)}</span></a>`).join('')}</div>
        </section>

        <section class="home-deals stack gap-4" aria-labelledby="h-deals">
          <div class="row between">
            <div class="row gap-3"><h2 class="h2" id="h-deals" style="color:var(--deal-text)">${icon('zap')} Flash deals</h2><span class="row gap-2 small sub">Ends in ${countdown('05', '42', '18')}</span></div>
            <a class="small strong" href="${go('store/deals')}">See all deals ${icon('arrow-right', 'ic-sm')}</a>
          </div>
          <div class="hscroll">${deals.map((p, i) => `
            <article class="deal-card">
              <a href="${go('store/product')}" aria-label="${esc(p.name)}">${pimg(p)}</a>
              <div class="row gap-1">${badge(`−${Math.round((1 - p.price / p.was) * 100)}%`, 'deal')}<span class="xs muted">Limit 2</span></div>
              ${price(p.price, p.was, { noOff: true })}
              <a class="small clamp-2" style="color:var(--text)" href="${go('store/product')}">${esc(p.name)}</a>
              <div class="stack gap-1">${meter(claimed[i], 'deal')}<span class="xs muted">${claimed[i]}% claimed</span></div>
            </article>`).join('')}</div>
        </section>

        <section class="home-official" aria-labelledby="h-official">
          <div class="stack gap-3">
            ${badge('Official Store', 'brand', 'badge-check')}
            <h2 class="display d-lg" id="h-official">Sold and shipped by ${UI.BRAND}</h2>
            <p class="small sub">Our own stock, packed in our Reno warehouse. Free delivery over $35 and 30-day free returns.</p>
            <div>${btn('Visit the Official Store', { href: go('store/official'), iconR: 'arrow-right' })}</div>
          </div>
          <div class="grid-products">${['aurora', 'skillet', 'sweater', 'pourover'].map((id) => productCard(P[id], { compact: true })).join('')}</div>
        </section>

        <section class="stack gap-4" aria-labelledby="h-feat">
          ${sectionHead('<span id="h-feat">Featured for you</span>', { link: 'See more', href: go('store/collection', 'Best sellers') })}
          <div class="grid-products wide">${['kestrel27', 'speaker', 'backpack', 'keyboard', 'serum', 'shoes', 'bottle', 'lamp', 'yogamat', 'vacuum'].map((id, i) => productCard(P[id], { sponsored: i === 2, from: true, showSeller: true })).join('')}</div>
        </section>

        <section class="home-sponsor" aria-label="Sponsored brand">
          <span class="ad-label">Sponsored</span>
          <div class="stack gap-3" style="padding:var(--sp-6)">
            <div class="row gap-3">${logoTile({ initials: 'H', tint: 'var(--img-2)' }, 'lg')}<div class="stack gap-0"><span class="h3">Halden Audio</span><span class="xs muted">Brand collection · 48 products</span></div></div>
            <p class="sub">Noise cancelling that lasts a long-haul flight. Aurora headphones now with 40-hour battery.</p>
            <div>${btn('Shop Halden', { v: 'secondary', href: go('store/brand'), iconR: 'arrow-right' })}</div>
          </div>
          <div class="grid c2" style="padding:var(--sp-4);--gap:12px;align-content:center">${['aurora', 'speaker'].map((id) => `<a href="${go('store/product')}" class="stack gap-2" style="color:var(--text)">${pimg(P[id], 'r43')}<span class="small strong clamp-2">${esc(P[id].name)}</span>${price(P[id].price, P[id].was, { noOff: true })}</a>`).join('')}</div>
        </section>

        <section class="stack gap-4" aria-labelledby="h-sellers">
          ${sectionHead('<span id="h-sellers">Featured sellers</span>', { link: 'How sellers are checked', href: go('info/policy', 'Seller rules') })}
          <div class="home-sellers">${['northwind', 'casaverde', 'pixelport', 'trailhead'].map((k) => { const s = D.sellers[k]; return `
            <a class="card pad row gap-3 nowrap" style="color:var(--text);text-decoration:none" href="${go('store/seller')}">
              ${logoTile(s)}
              <span class="stack gap-1" style="min-width:0"><span class="strong truncate">${esc(s.name)}</span><span class="row gap-2">${sellerBadge(s, true)}<span class="xs muted">${s.positive}% positive</span></span><span class="xs muted">${s.location} · ships in ${s.dispatch}</span></span>
            </a>`; }).join('')}</div>
        </section>

        <section class="home-row stack gap-4" aria-labelledby="h-new">
          ${sectionHead('<span id="h-new">New arrivals</span>', { link: 'See all', href: go('store/collection', 'New arrivals') })}
          <div class="hscroll">${['lamp', 'yogamat', 'serum', 'keyboard', 'bottle', 'sweater', 'pourover'].map((id) => productCard(P[id], { compact: true })).join('')}</div>
        </section>

        <section class="stack gap-4" aria-labelledby="h-brands">
          ${sectionHead('<span id="h-brands">Brand collections</span>', { link: 'All brands', href: go('store/brand') })}
          <div class="hscroll">${D.brands.map((b) => `<a class="card pad stack gap-2" style="width:150px;align-items:center;text-align:center;color:var(--text);text-decoration:none" href="${go('store/brand')}">${logoTile(b, 'lg')}<span class="strong small">${b.name}</span><span class="xs muted">${b.products} products</span></a>`).join('')}</div>
        </section>

        <section class="home-row stack gap-4" aria-labelledby="h-recent">
          ${sectionHead('<span id="h-recent">Recently viewed</span>', { link: 'Clear', href: 'javascript:void 0' })}
          <div class="hscroll">${['ssd1tb', 'kestrel27', 'duvet', 'aurora'].map((id) => `<a href="${go('store/product')}" class="stack gap-2" style="color:var(--text)">${pimg(P[id])}<span class="xs clamp-2">${esc(P[id].name)}</span>${price(P[id].price, P[id].was, { noOff: true })}</a>`).join('')}</div>
        </section>

        <section class="home-promise" aria-label="Our promise">
          <div>${icon('store')}<span class="stack gap-1"><span class="small strong">Know who sells it</span><span class="xs muted">Every item names its seller and who ships it.</span></span></div>
          <div>${icon('calendar-check')}<span class="stack gap-1"><span class="small strong">Delivery date first</span><span class="xs muted">See arrival dates and the full total before you pay.</span></span></div>
          <div>${icon('undo-2')}<span class="stack gap-1"><span class="small strong">Clear returns</span><span class="xs muted">Return terms are shown on every offer.</span></span></div>
          <div>${icon('life-buoy')}<span class="stack gap-1"><span class="small strong">We step in</span><span class="xs muted">${UI.BRAND} support helps if a seller doesn't.</span></span></div>
        </section>
      </div>`, { tab: 'home' }),
  });
})();
