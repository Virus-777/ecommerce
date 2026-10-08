/* Customer Store · Shopping + Advertising (plan ch. 3, 4, 5, 15, 16) */
(function () {
  const U = UI;
  const D = window.D;
  const P = D.P;
  const { icon, btn, badge, go, esc, money, num } = U;

  U.css('shop', `
    /* listing pages */
    .shop-listing { display: grid; gap: var(--sp-6); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1024px) { .shop-listing { grid-template-columns: 248px minmax(0, 1fr); } }
    .shop-toolbar { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); align-items: center; justify-content: space-between; }
    .shop-toolbar .select { width: auto; min-height: 40px; height: 40px; font-size: var(--fs-sm); }
    .shop-sort { display: inline-flex; align-items: center; gap: var(--sp-2); }
    .shop-fg { border-bottom: 1px solid var(--border); padding-block: var(--sp-2) var(--sp-3); }
    .shop-fg > summary { list-style: none; display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-weight: 700; font-size: var(--fs-sm); min-height: 36px; }
    .shop-fg > summary::-webkit-details-marker { display: none; }
    .shop-fg[open] > summary svg.lucide { transform: rotate(180deg); }
    .shop-fg .opts { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-1); }
    .shop-fg .check { font-size: var(--fs-sm); }
    .shop-fg .field .label { font-size: var(--fs-xs); font-weight: 500; color: var(--text-3); }
    .shop-fg .input-group { min-height: 38px; }
    .shop-fg .input-group .input { height: 36px; font-size: var(--fs-sm); }
    .shop-fhead { font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); padding-top: var(--sp-4); }
    .shop-from { display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--fs-xs); color: var(--text-2); }
    .shop-from svg.lucide { color: var(--text-3); width: 16px; height: 16px; }
    .shop-active { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .shop-active .chip { min-height: 32px; }
    /* banner ad */
    .shop-banner { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); border-radius: var(--r-xl); overflow: hidden; background: var(--img-2); color: var(--text) !important; text-decoration: none !important; }
    @container app (min-width: 768px) { .shop-banner { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); } }
    .shop-banner .copy { padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-2); }
    .shop-banner .art { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); padding: 0 var(--sp-5) var(--sp-5); align-content: center; }
    @container app (min-width: 768px) { .shop-banner .art { padding: var(--sp-5) var(--sp-5) var(--sp-5) 0; } }
    .shop-banner .art .imgph { background: var(--surface); }
    .shop-banner:hover .h2 { text-decoration: underline; }
    /* categories */
    .shop-rail { display: grid; grid-template-columns: 92px minmax(0, 1fr); min-height: 620px; background: var(--surface); border-bottom: 1px solid var(--border); }
    .shop-rail nav { background: var(--surface-2); display: flex; flex-direction: column; }
    .shop-rail nav a { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: var(--sp-3) var(--sp-1); font-size: var(--fs-2xs); font-weight: 600; color: var(--text-2) !important; text-align: center; text-decoration: none !important; border-left: 3px solid transparent; line-height: 1.25; }
    .shop-rail nav a.is-active { background: var(--surface); color: var(--brand-text) !important; border-left-color: var(--brand); }
    .shop-rail nav a.is-soon { color: var(--text-3) !important; }
    .shop-rail nav a .soon { font-size: 10px; font-weight: 700; color: var(--text-3); }
    .shop-rail .pane { padding: var(--sp-4) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-5); min-width: 0; }
    .shop-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-4) var(--sp-2); }
    .shop-tile { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; font-size: var(--fs-xs); font-weight: 600; color: var(--text) !important; text-decoration: none !important; line-height: 1.25; }
    .shop-tile .n { font-weight: 400; color: var(--text-3); font-size: var(--fs-2xs); }
    .shop-tile.is-soon .imgph { opacity: .5; }
    .shop-catgrid { display: grid; gap: var(--sp-4); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 1024px) { .shop-catgrid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .shop-catcard { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .shop-catcard .imgph { aspect-ratio: 16 / 9; }
    .shop-catcard ul { display: flex; flex-direction: column; }
    .shop-catcard li a, .shop-catcard li > span { display: flex; justify-content: space-between; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-2) !important; padding-block: 4px; }
    .shop-catcard li .n { color: var(--text-3); font-variant-numeric: tabular-nums; }
    .shop-catcard.is-soon { background: var(--surface-2); border-style: dashed; }
    .shop-catcard.is-soon .imgph { opacity: .55; }
    /* search suggestions */
    .shop-sugg-wrap { position: relative; }
    .shop-sugg-scrim { position: absolute; inset: 0; background: var(--overlay); z-index: 5; }
    .shop-sugg { position: absolute; z-index: 6; top: 0; left: 0; right: 0; background: var(--surface); border-bottom: 1px solid var(--border); box-shadow: var(--sh-3); }
    @container app (min-width: 768px) { .shop-sugg { left: 50%; right: auto; width: min(760px, calc(100% - 48px)); transform: translateX(-50%); top: var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-lg); } }
    .shop-sugg-grid { display: grid; grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .shop-sugg-grid { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); } .shop-sugg-grid > div + div { border-left: 1px solid var(--border); } }
    .shop-sugg-grid > div { padding: var(--sp-3) var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-1); }
    .shop-sugg h3 { font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); padding: var(--sp-2) var(--sp-3) var(--sp-1); }
    .shop-sugg .it { display: flex; align-items: center; gap: var(--sp-3); min-height: 44px; padding: 0 var(--sp-3); border-radius: var(--r-md); color: var(--text) !important; text-decoration: none !important; font-size: var(--fs-sm); }
    .shop-sugg .it:hover, .shop-sugg .it.is-hl { background: var(--surface-2); }
    .shop-sugg .it > svg.lucide { color: var(--text-3); width: 16px; height: 16px; }
    .shop-sugg .it b { font-weight: 400; }
    .shop-sugg .it .q { font-weight: 700; }
    .shop-sugg .recent { display: flex; align-items: center; gap: var(--sp-2); padding-left: var(--sp-3); font-size: var(--fs-sm); }
    .shop-sugg .recent a { flex: 1; color: var(--text) !important; display: flex; align-items: center; gap: var(--sp-3); min-height: 40px; }
    .shop-sugg .recent a svg.lucide { color: var(--text-3); width: 16px; height: 16px; }
    .shop-sugg .logo-tile { width: 32px; height: 32px; font-size: 13px; border-radius: var(--r-sm); }
    /* product page */
    .shop-pdp { display: grid; gap: var(--sp-6); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 768px) { .shop-pdp { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .shop-gal { grid-row: span 2; } }
    @container app (min-width: 1200px) { .shop-pdp { grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr) 340px; } .shop-gal { grid-row: auto; } }
    .shop-gal { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
    .shop-gal .main { position: relative; }
    .shop-gal .main .imgph { border-radius: var(--r-xl); }
    .shop-gal .main .cnt { position: absolute; right: var(--sp-3); bottom: var(--sp-3); }
    .shop-gal .main .fav { position: absolute; right: var(--sp-3); top: var(--sp-3); background: var(--surface); box-shadow: var(--sh-1); border-radius: 50%; }
    .shop-thumbs { display: flex; gap: var(--sp-2); overflow-x: auto; scrollbar-width: none; }
    .shop-thumbs button { padding: 2px; border: 2px solid transparent; border-radius: var(--r-md); background: none; cursor: pointer; position: relative; flex: none; }
    .shop-thumbs button.is-active { border-color: var(--brand); }
    .shop-thumbs .vid { position: absolute; inset: 2px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; color: var(--text); font-size: var(--fs-2xs); font-weight: 700; border-radius: var(--r-sm); background: color-mix(in srgb, var(--surface) 55%, transparent); }
    .shop-var { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-2); }
    .shop-var button { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--r-md); cursor: pointer; font-size: var(--fs-xs); background: var(--surface); text-align: left; color: var(--text); min-width: 0; }
    .shop-var button.is-selected { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
    .shop-var button .imgph { aspect-ratio: 4 / 3; }
    .shop-var button .imgph svg.lucide { width: 30%; height: 30%; }
    .shop-var .vn { font-weight: 700; font-size: var(--fs-sm); }
    .shop-buy .card-body { gap: var(--sp-3); }
    .shop-line { display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--fs-sm); color: var(--text-2); }
    .shop-line > svg.lucide { color: var(--text-3); width: 18px; height: 18px; margin-top: 1px; }
    .shop-line b { color: var(--text); }
    .shop-feat li { display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--fs-sm); color: var(--text-2); }
    .shop-feat li svg.lucide { color: var(--brand-text); width: 16px; height: 16px; margin-top: 2px; }
    .shop-two { display: grid; gap: var(--sp-6); grid-template-columns: minmax(0, 1fr); align-items: start; }
    @container app (min-width: 1024px) { .shop-two { grid-template-columns: 320px minmax(0, 1fr); } .shop-two.even { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
    .shop-rev { display: flex; flex-direction: column; gap: var(--sp-2); padding-block: var(--sp-4); border-bottom: 1px solid var(--border); }
    .shop-rev:last-child { border-bottom: 0; }
    .shop-reply { background: var(--surface-2); border-radius: var(--r-md); padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-2); display: flex; flex-direction: column; gap: 4px; }
    .shop-qa { display: flex; flex-direction: column; gap: var(--sp-3); padding-block: var(--sp-4); border-bottom: 1px solid var(--border); }
    .shop-qa:last-child { border-bottom: 0; }
    .shop-qa .a { padding-left: var(--sp-4); border-left: 2px solid var(--border); display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); color: var(--text-2); }
    /* offers */
    .shop-mini { display: flex; gap: var(--sp-3); align-items: center; }
    .shop-mini .imgph { width: 72px; }
    .shop-offer { display: flex; flex-direction: column; gap: var(--sp-3); }
    .shop-offer.is-featured { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
    .shop-offer .ogrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3) var(--sp-4); }
    .shop-offer .ogrid > div { display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-sm); min-width: 0; }
    .shop-offer .ogrid .k { font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); }
    .shop-note { display: flex; gap: 6px; align-items: flex-start; font-size: var(--fs-xs); color: var(--text-2); }
    .shop-note svg.lucide { width: 14px; height: 14px; margin-top: 1px; color: var(--text-3); }
    .shop-note.warn { color: var(--warning); }
    .shop-note.warn svg.lucide { color: var(--warning); }
    .shop-otable td { vertical-align: top !important; }
    .shop-otable tr.is-featured td { background: var(--brand-soft); }
    .shop-otable tr.is-featured td:first-child { box-shadow: inset 3px 0 0 var(--brand); }
    /* brand / seller / official */
    .shop-hero { position: relative; border-radius: var(--r-xl); overflow: hidden; background: var(--surface); border: 1px solid var(--border); }
    .shop-hero .ban { position: relative; height: 112px; background: var(--tint, var(--img-2)); display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-5); padding: 0 var(--sp-6); color: var(--img-ink); overflow: hidden; }
    @container app (min-width: 768px) { .shop-hero .ban { height: 168px; } }
    .shop-hero .ban svg.lucide { width: 56px; height: 56px; stroke-width: 1.1; opacity: .55; }
    .shop-hero .id { display: flex; gap: var(--sp-3) var(--sp-4); padding: var(--sp-3) var(--sp-4) var(--sp-4); align-items: flex-start; flex-wrap: wrap; position: relative; }
    @container app (min-width: 768px) { .shop-hero .id { padding: var(--sp-4) var(--sp-6) var(--sp-5); } }
    .shop-hero .id .logo-tile { border: 4px solid var(--surface); box-shadow: var(--sh-1); margin-top: -44px; }
    .shop-ban-t { font-family: var(--font-display); font-weight: 700; font-size: var(--fs-lg); line-height: 1.15; color: var(--text); max-width: 22ch; margin-right: auto; align-self: flex-start; padding-top: var(--sp-4); }
    @container app (min-width: 768px) { .shop-ban-t { font-size: 28px; align-self: center; padding-top: 0; } }
    .shop-collections { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .shop-collections { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .shop-coll { display: flex; gap: var(--sp-3); align-items: center; padding: var(--sp-3); border-radius: var(--r-lg); background: var(--surface); border: 1px solid var(--border); color: var(--text) !important; text-decoration: none !important; }
    .shop-coll:hover { border-color: var(--border-strong); }
    .shop-coll .imgph { width: 72px; }
    .shop-promises { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 1024px) { .shop-promises { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .shop-promises > div { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-4); border-radius: var(--r-lg); background: var(--surface); border: 1px solid var(--border); }
    .shop-promises svg.lucide { color: var(--brand-text); }
    .shop-off-hero { border-radius: var(--r-xl); background: var(--brand); color: var(--on-brand); padding: var(--sp-6); display: grid; gap: var(--sp-5); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .shop-off-hero { padding: var(--sp-8); grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); align-items: center; } }
    .shop-off-hero .art { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); }
    .shop-off-hero .art .imgph { background: color-mix(in srgb, var(--on-brand) 88%, transparent); border-radius: var(--r-lg); }
    .shop-shortcuts { display: grid; gap: var(--sp-3) var(--sp-2); grid-template-columns: repeat(4, minmax(0, 1fr)); }
    @container app (min-width: 768px) { .shop-shortcuts { grid-template-columns: repeat(8, minmax(0, 1fr)); } }
    .shop-shortcuts a { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; font-size: var(--fs-xs); font-weight: 600; color: var(--text) !important; text-decoration: none !important; }
    .shop-shortcuts .imgph { width: 64px; border-radius: 50%; }
    .shop-verify li { display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--fs-sm); padding-block: 3px; }
    .shop-verify li svg.lucide { width: 16px; height: 16px; margin-top: 2px; color: var(--success); }
    .shop-verify li.no svg.lucide { color: var(--text-3); }
    .shop-promo { display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; padding: var(--sp-4); border-radius: var(--r-lg); background: var(--deal-soft); }
    .shop-promo > svg.lucide { color: var(--deal-text); }
    /* deals */
    .shop-flash { background: var(--deal-soft); border-radius: var(--r-xl); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4); }
    @container app (min-width: 768px) { .shop-flash { padding: var(--sp-6); } }
    .shop-dgrid { display: grid; gap: var(--sp-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 768px) { .shop-dgrid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @container app (min-width: 1024px) { .shop-dgrid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
    .shop-dcard { background: var(--surface); border-radius: var(--r-lg); padding: var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); position: relative; min-width: 0; }
    .shop-dcard .tagrow { position: absolute; top: calc(var(--sp-3) + 8px); left: calc(var(--sp-3) + 8px); display: flex; gap: 4px; }
    .shop-dcard.is-out .imgph { opacity: .45; }
    .shop-dcard .regular { border-top: 1px dashed var(--border-strong); padding-top: var(--sp-2); display: flex; flex-direction: column; gap: 4px; }
    .shop-coupons { display: grid; gap: var(--sp-3); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .shop-coupons { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .shop-coupon { display: flex; border: 1px dashed var(--deal); border-radius: var(--r-lg); background: var(--surface); overflow: hidden; min-width: 0; }
    .shop-coupon .amt { background: var(--deal-soft); color: var(--deal-text); padding: var(--sp-3); display: flex; flex-direction: column; justify-content: center; align-items: center; width: 96px; flex: none; font-weight: 700; font-size: var(--fs-xl); text-align: center; line-height: 1.1; border-right: 1px dashed var(--deal); }
    .shop-coupon .amt span { font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .shop-coupon .body { padding: var(--sp-3) var(--sp-4); flex: 1; display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
    .shop-event { display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; }
    .shop-date { width: 56px; flex: none; border-radius: var(--r-md); background: var(--surface-2); display: flex; flex-direction: column; align-items: center; padding: var(--sp-2) 0; line-height: 1.1; }
    .shop-date .m { font-size: var(--fs-2xs); text-transform: uppercase; font-weight: 700; color: var(--text-3); }
    .shop-date .d { font-size: var(--fs-xl); font-weight: 700; font-variant-numeric: tabular-nums; }
    /* collections */
    .shop-rank { display: flex; align-items: center; gap: var(--sp-2); }
    .shop-rank .n { min-width: 34px; height: 26px; padding: 0 8px; border-radius: var(--r-pill); background: var(--text); color: var(--text-inverse); display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
    .shop-rank .n.top { background: var(--brand); color: var(--on-brand); }
    .shop-season { border-radius: var(--r-xl); overflow: hidden; background: var(--brand); color: var(--on-brand); display: grid; grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .shop-season { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); } }
    .shop-season .copy { padding: var(--sp-6); display: flex; flex-direction: column; gap: var(--sp-3); }
    @container app (min-width: 768px) { .shop-season .copy { padding: var(--sp-8); } }
    .shop-season .art { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); padding: 0 var(--sp-6) var(--sp-6); align-content: center; }
    @container app (min-width: 768px) { .shop-season .art { padding: var(--sp-6) var(--sp-6) var(--sp-6) 0; } }
    .shop-season .art .imgph { background: color-mix(in srgb, var(--on-brand) 88%, transparent); border-radius: var(--r-lg); }
    .shop-season .meta { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .shop-season .meta span { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm); font-weight: 600; padding: 4px 10px; border-radius: var(--r-pill); background: color-mix(in srgb, var(--on-brand) 16%, transparent); }
    .shop-row .hscroll > * { width: 168px; }
    @container app (min-width: 768px) { .shop-row .hscroll > * { width: 200px; } }
    /* not found */
    .shop-err { display: grid; gap: var(--sp-6); grid-template-columns: minmax(0, 1fr); align-items: center; }
    @container app (min-width: 768px) { .shop-err { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); } }
    .shop-err .big { font-family: var(--font-display); font-size: 88px; font-weight: 700; line-height: 1; color: var(--brand-text); letter-spacing: -0.03em; }
    @container app (min-width: 768px) { .shop-err .big { font-size: 128px; } }
    .shop-err .art { display: flex; align-items: center; justify-content: center; aspect-ratio: 4 / 3; border-radius: var(--r-xl); background: var(--surface-2); color: var(--text-3); }
    .shop-err .art svg.lucide { width: 96px; height: 96px; stroke-width: 1; }
    .shop-links { display: grid; gap: var(--sp-2); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @container app (min-width: 768px) { .shop-links { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .shop-links a { display: flex; gap: var(--sp-3); align-items: center; padding: var(--sp-3); border-radius: var(--r-md); border: 1px solid var(--border); background: var(--surface); color: var(--text) !important; font-weight: 600; font-size: var(--fs-sm); text-decoration: none !important; }
    .shop-links a svg.lucide { color: var(--brand-text); }
    .shop-links a:hover { border-color: var(--border-strong); }
    /* ads: shared */
    .shop-adtag { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .04em; padding: 3px 8px; border-radius: var(--r-xs); background: var(--surface); color: var(--text-2); border: 1px solid var(--border-strong); white-space: nowrap; }
    .shop-skip { display: inline-flex; gap: 6px; align-items: center; min-height: var(--tap); padding: 0 var(--sp-4); border-radius: var(--r-pill); background: var(--surface); color: var(--text) !important; border: 1px solid var(--border-strong); font-weight: 700; font-size: var(--fs-sm); cursor: pointer; box-shadow: var(--sh-2); text-decoration: none !important; }
    .shop-skip:hover { background: var(--surface-2); }
    /* opening ad */
    .overlay.shop-oa { align-items: stretch; z-index: 60; }
    @container app (min-width: 768px) { .overlay.shop-oa { align-items: center; padding: var(--sp-7); } }
    .shop-oa .ad { position: relative; width: 100%; background: var(--surface); display: flex; flex-direction: column; overflow: auto; }
    @container app (min-width: 768px) { .shop-oa .ad { max-width: 940px; border-radius: var(--r-xl); box-shadow: var(--sh-3); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); max-height: 100%; overflow: hidden; } }
    .shop-oa .top { position: absolute; top: var(--sp-3); left: var(--sp-3); right: var(--sp-3); display: flex; justify-content: space-between; align-items: center; gap: var(--sp-2); z-index: 2; }
    .shop-oa .art { flex: 1 1 auto; min-height: 300px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); padding: 72px var(--sp-5) var(--sp-5); align-content: center; background: var(--brand); }
    .shop-oa .art.alt { background: var(--img-2); }
    .shop-oa .art .imgph { background: color-mix(in srgb, var(--surface) 90%, transparent); border-radius: var(--r-lg); }
    .shop-oa .art .imgph.big { grid-column: span 2; aspect-ratio: 16 / 10; }
    .shop-oa .copy { padding: var(--sp-6) var(--sp-5) var(--sp-6); display: flex; flex-direction: column; gap: var(--sp-3); justify-content: center; }
    @container app (min-width: 768px) { .shop-oa .copy { padding: 72px var(--sp-8) var(--sp-8); } .shop-oa .art { min-height: 480px; } }
    /* pop-ups */
    .shop-pop { position: relative; width: 100%; max-width: 440px; background: var(--surface); border-radius: var(--r-xl) var(--r-xl) 0 0; box-shadow: var(--sh-3); overflow: hidden; }
    @container app (min-width: 768px) { .shop-pop { border-radius: var(--r-xl); } }
    .shop-pop .band { background: var(--deal-soft); color: var(--deal-text); padding: var(--sp-6) var(--sp-5) var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-2); }
    .shop-pop .band > svg.lucide { width: 36px; height: 36px; stroke-width: 1.5; }
    .shop-pop .x { position: absolute; top: var(--sp-2); right: var(--sp-2); }
    .shop-pop .body { padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-3); }
    .shop-code { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-4); border: 1.5px dashed var(--deal); border-radius: var(--r-md); }
    .shop-code .mono { font-size: var(--fs-lg); font-weight: 700; letter-spacing: .08em; flex: 1; }
    .overlay.shop-clear { background: transparent; pointer-events: none; align-items: flex-end; justify-content: flex-start; padding: var(--sp-3) var(--sp-3) calc(var(--tabbar-h) + var(--sp-3)); }
    @container app (min-width: 768px) { .overlay.shop-clear { padding: var(--sp-6); } }
    .shop-announce { pointer-events: auto; width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); box-shadow: var(--sh-3); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); position: relative; }
    .shop-announce .x { position: absolute; top: var(--sp-1); right: var(--sp-1); }
    /* ad formats showcase */
    .shop-ann { position: relative; outline: 2px dashed var(--info); outline-offset: 6px; border-radius: var(--r-lg); margin-top: 26px; }
    .shop-ann-tag { position: absolute; top: -32px; left: -4px; display: inline-flex; align-items: center; gap: 4px; background: var(--info); color: var(--text-inverse); font-size: var(--fs-2xs); font-weight: 700; padding: 2px 8px; border-radius: var(--r-xs); z-index: 3; white-space: nowrap; }
    .shop-ann-tag svg.lucide { width: 12px; height: 12px; }
    .shop-sfeat { position: relative; display: grid; gap: var(--sp-4); grid-template-columns: minmax(0, 1fr); padding: var(--sp-4); border-radius: var(--r-lg); background: var(--surface); border: 1px solid var(--border); }
    @container app (min-width: 768px) { .shop-sfeat { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); align-items: center; padding: var(--sp-5); } }
    .shop-sfeat .ad-label { background: var(--surface-3); color: var(--text-2); }
    .shop-video { position: relative; border-radius: var(--r-lg); overflow: hidden; background: var(--img-6); aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; color: var(--img-ink); }
    .shop-video .play { width: 64px; height: 64px; border-radius: 50%; background: var(--surface); color: var(--text); border: 0; display: inline-flex; align-items: center; justify-content: center; box-shadow: var(--sh-2); cursor: pointer; }
    .shop-video .play svg.lucide { width: 28px; height: 28px; }
    .shop-video .ctl { position: absolute; left: var(--sp-3); right: var(--sp-3); bottom: var(--sp-3); display: flex; align-items: center; gap: var(--sp-2); }
    .shop-video .ctl .icon-btn { background: var(--surface); width: 36px; height: 36px; }
    .shop-video .ctl .meter { flex: 1; }
    .shop-video .bg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: space-around; opacity: .35; }
    .shop-video .bg svg.lucide { width: 72px; height: 72px; stroke-width: 1; }
    .shop-sticky { position: sticky; bottom: calc(var(--tabbar-h) + var(--sp-2)); z-index: 28; margin: 0 var(--sp-3) var(--sp-3); }
    @container app (min-width: 768px) { .shop-sticky { bottom: var(--sp-3); margin: 0 auto var(--sp-4); max-width: 880px; } }
    .shop-sticky .strip { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-lg); box-shadow: var(--sh-3); }
    .shop-sticky .strip .imgph { width: 44px; }
    .shop-inter { position: relative; width: 100%; max-width: 520px; background: var(--surface); border-radius: var(--r-xl) var(--r-xl) 0 0; box-shadow: var(--sh-3); overflow: hidden; display: flex; flex-direction: column; }
    @container app (min-width: 768px) { .shop-inter { border-radius: var(--r-xl); } }
    .shop-inter .art { position: relative; background: var(--img-6); padding: var(--sp-6); display: flex; justify-content: center; }
    .shop-inter .art .imgph { max-width: 220px; background: var(--surface); border-radius: var(--r-lg); }
    .shop-legend { display: grid; gap: var(--sp-2); grid-template-columns: minmax(0, 1fr); }
    @container app (min-width: 768px) { .shop-legend { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @container app (min-width: 1024px) { .shop-legend { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .shop-legend > div { display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--fs-xs); color: var(--text-2); }
    .shop-legend > div svg.lucide { width: 16px; height: 16px; color: var(--info); margin-top: 1px; }
  `);

  /* ---------------- Extra sample products (same shape as D.products) ---------------- */
  const mk = (id, o) => Object.assign({ id, offers: 1, free: true, delivery: 'Fri, Oct 16', was: null, tint: 'var(--img-2)', icon: 'headphones' }, o);
  const X = {
    aria: mk('aria', { name: 'Halden Aria True Wireless Earbuds', brand: 'Halden', price: 99, was: 129, rating: 4.4, reviews: 688, icon: 'ear', seller: 'northwind', offers: 3 }),
    buds: mk('buds', { name: 'Halden Aurora Buds ANC Earbuds', brand: 'Halden', price: 139, was: 169, rating: 4.5, reviews: 912, icon: 'ear', seller: 'official', offers: 2, delivery: 'Thu, Oct 15' }),
    studio: mk('studio', { name: 'Halden Studio 2 Wired Monitor Headphones', brand: 'Halden', price: 149, rating: 4.7, reviews: 356, tint: 'var(--img-5)', seller: 'official', offers: 2, delivery: 'Thu, Oct 15' }),
    open: mk('open', { name: 'Halden Air Open-ear Sport Headphones', brand: 'Halden', price: 119, rating: 4.2, reviews: 204, icon: 'ear', tint: 'var(--img-1)', seller: 'northwind' }),
    wave: mk('wave', { name: 'Kestrel Wave Over-ear Bluetooth Headphones', brand: 'Kestrel', price: 79, rating: 4.2, reviews: 1032, tint: 'var(--img-6)', seller: 'pixelport', offers: 2 }),
    wavepro: mk('wavepro', { name: 'Kestrel Wave Pro ANC Headphones', brand: 'Kestrel', price: 129, was: 149, rating: 4.3, reviews: 577, tint: 'var(--img-6)', seller: 'pixelport', offers: 3 }),
    neck: mk('neck', { name: 'Kestrel Loop Neckband Earphones', brand: 'Kestrel', price: 39, rating: 3.9, reviews: 318, icon: 'ear', tint: 'var(--img-6)', seller: 'pixelport', free: false }),
    q3: mk('q3', { name: 'Lumen Q3 Noise Cancelling Headphones', brand: 'Lumen', price: 159, rating: 4.3, reviews: 421, tint: 'var(--img-3)', seller: 'pixelport', offers: 2 }),
    q1: mk('q1', { name: 'Lumen Q1 On-ear Wireless Headphones', brand: 'Lumen', price: 69, rating: 4.0, reviews: 265, tint: 'var(--img-3)', seller: 'northwind', offers: 2 }),
    run: mk('run', { name: 'Corvo Stride Sport Earbuds, Sweat-resistant', brand: 'Corvo', price: 49, was: 59, rating: 4.1, reviews: 540, icon: 'ear', tint: 'var(--img-4)', seller: 'trailhead', free: false }),
    kids: mk('kids', { name: 'Brightline Kids Volume-limited Headphones', brand: 'Brightline', price: 34, rating: 4.4, reviews: 731, tint: 'var(--img-1)', seller: 'official', offers: 2, delivery: 'Wed, Oct 14', free: false }),
    mini: mk('mini', { name: 'Halden Pocket Mini Bluetooth Speaker', brand: 'Halden', price: 39, rating: 4.3, reviews: 410, icon: 'speaker', seller: 'northwind', offers: 2, delivery: 'Thu, Oct 15' }),
    hcase: mk('hcase', { name: 'Halden Aurora Hard Travel Case', brand: 'Halden', price: 29, rating: 4.6, reviews: 188, icon: 'briefcase', tint: 'var(--img-5)', seller: 'official', delivery: 'Wed, Oct 14', free: false }),
    cable: mk('cable', { name: 'Northwind Studio Cable Kit, 3.5 mm to USB-C', brand: 'Northwind', price: 24, rating: 4.5, reviews: 96, icon: 'cable', seller: 'northwind', free: false }),
    sheets: mk('sheets', { name: 'Mosswood Percale Sheet Set, Queen', brand: 'Mosswood', price: 79, was: 99, rating: 4.6, reviews: 640, icon: 'bed-double', tint: 'var(--img-1)', seller: 'casaverde', offers: 2, delivery: 'Mon, Oct 19' }),
    floorlamp: mk('floorlamp', { name: 'Brightline Arc Floor Lamp, Dimmable', brand: 'Brightline', price: 89, was: 119, rating: 4.4, reviews: 233, icon: 'lamp-floor', tint: 'var(--img-5)', seller: 'official', delivery: 'Thu, Oct 15' }),
    dutch: mk('dutch', { name: 'Pellar Enameled Dutch Oven 5.5 qt', brand: 'Pellar', price: 96, was: 128, rating: 4.8, reviews: 1104, icon: 'cooking-pot', tint: 'var(--img-3)', seller: 'official', offers: 2, delivery: 'Wed, Oct 14' }),
    kettle: mk('kettle', { name: 'Mosswood Gooseneck Pour-over Kettle', brand: 'Mosswood', price: 48, was: 60, rating: 4.5, reviews: 377, icon: 'coffee', tint: 'var(--img-3)', seller: 'casaverde', delivery: 'Mon, Oct 19' }),
    string: mk('string', { name: 'Brightline Warm White String Lights, 10 m', brand: 'Brightline', price: 19, was: 26, rating: 4.3, reviews: 852, icon: 'lightbulb', tint: 'var(--img-5)', seller: 'official', free: false, delivery: 'Wed, Oct 14' }),
  };
  const PP = Object.assign({}, P, X);
  const cards = (ids, o = {}) => ids.map((id, i) => U.productCard(PP[id], { showSeller: o.seller !== false, from: true, sponsored: (o.sp || []).includes(i), compact: o.compact })).join('');
  const S = D.sellers;

  /* ---------------- Shared bits ---------------- */
  const SORTS = ['Recommended', 'Price: low to high', 'Price: high to low', 'Newest', 'Highest rated'];
  const sortSel = (id, val = 'Recommended') => `<span class="shop-sort"><label class="small sub nowrap" for="${id}">Sort by</label>${U.select(id, SORTS, val)}</span>`;
  const fromNote = () => `<p class="shop-from">${icon('info')}<span>A “from” price is the lowest eligible offer for that product, from one named seller. The product page shows that seller, the shipping cost and delivery date before you add it to your cart.</span></p>`;
  const fg = (title, body, open = true) => `<details class="shop-fg"${open ? ' open' : ''}><summary>${title}${icon('chevron-down', 'ic-sm')}</summary><div class="opts">${body}</div></details>`;
  const ck = (id, label, n, on) => U.check(id, `${label}${n !== undefined ? ` <span class="muted">(${num(n)})</span>` : ''}`, on);
  const rd = (name, id, label, n, on) => U.radio(name, id, `${label}${n !== undefined ? ` <span class="muted">(${num(n)})</span>` : ''}`, on);
  const sw = (n) => `<span class="row gap-1 nowrap">${U.stars5(n, 13)}<span>&amp; up</span></span>`;
  const ann = (on, name, html) => on ? `<div class="shop-ann"><span class="shop-ann-tag">${icon('tag')}${name}</span>${html}</div>` : html;
  const crumb = (items) => U.crumbs(items.map((x) => typeof x === 'string' ? { label: x } : x));
  const HOME = { label: 'Home', href: go('store/home') };

  function filterPanel(px, o = {}) {
    const isSearch = o.kind === 'search';
    const catBody = isSearch
      ? [['Headphones', 64], ['Earbuds', 18], ['Speakers', 4]].map(([l, n], i) => ck(`${px}-c${i}`, l, n, false)).join('')
      : `<a class="small" href="${go('store/categories')}">${icon('chevron-left', 'ic-sm')} Electronics</a><span class="small strong">Headphones <span class="muted">(128)</span></span><div class="stack gap-1" style="padding-left:var(--sp-3)">${[['Over-ear', 54], ['In-ear and earbuds', 49], ['On-ear', 25]].map(([l, n]) => `<a class="small" href="${go('store/category')}">${l} <span class="muted">(${n})</span></a>`).join('')}</div>`;
    return `<div class="stack gap-0">
      ${fg('Category', catBody)}
      ${fg('Price', `<div class="row nowrap gap-2">${U.field('Min', U.input(px + '-min', isSearch ? '50' : '', { prefix: '$', placeholder: '0' }))}${U.field('Max', U.input(px + '-max', isSearch ? '250' : '', { prefix: '$', placeholder: 'Any' }))}</div>
        ${[['Under $50', 18], ['$50 to $100', 34], ['$100 to $200', 51], ['$200 and up', 25]].map(([l, n], i) => rd(px + '-pr', `${px}-pr${i}`, l, n, false)).join('')}`)}
      ${fg('Customer rating', `${rd(px + '-rt', px + '-rt4', sw(4), 96, isSearch)}${rd(px + '-rt', px + '-rt3', sw(3), 121, false)}`)}
      ${fg('Brand', `${[['Halden', 21], ['Kestrel', 18], ['Lumen', 12], ['Corvo', 9], ['Brightline', 6]].map(([l, n], i) => ck(`${px}-b${i}`, l, n, false)).join('')}<a class="small strong" href="javascript:void 0">Show 7 more brands</a>`)}
      ${fg('Seller', `${ck(px + '-s0', 'Official Store', 34, false)}<span class="xs muted" style="padding-left:26px;margin-top:-4px">Shows company offers at the prices listed</span>${[['Northwind Audio', 22], ['Pixel &amp; Port', 19], ['Trailhead Outfitters', 7]].map(([l, n], i) => ck(`${px}-s${i + 1}`, l, n, false)).join('')}`)}
      ${fg('Condition', [['New', 112], ['Used', 11], ['Refurbished', 5]].map(([l, n], i) => ck(`${px}-cd${i}`, l, n, false)).join(''))}
      ${fg('Availability', `${ck(px + '-av0', 'In stock now', 121, true)}${ck(px + '-av1', 'Include out of stock', 7, false)}`)}
      ${fg('Delivery', `${ck(px + '-d0', 'Free delivery', 98, isSearch)}${ck(px + '-d1', 'Arrives by Fri, Oct 16', 74, false)}${ck(px + '-d2', 'Ships today', 41, false)}`)}
      <span class="shop-fhead">Headphone features</span>
      ${fg('Type', [['Over-ear', 54], ['In-ear and earbuds', 49], ['On-ear', 25]].map(([l, n], i) => ck(`${px}-t${i}`, l, n, false)).join(''))}
      ${fg('Noise cancelling', [['Active (ANC)', 61], ['Passive', 44], ['None', 23]].map(([l, n], i) => ck(`${px}-n${i}`, l, n, false)).join(''))}
      ${fg('Battery life', [['20 hours or more', 88], ['30 hours or more', 52], ['40 hours or more', 17]].map(([l, n], i) => rd(px + '-bl', `${px}-bl${i}`, l, n, false)).join(''), false)}
      ${fg('Connection', [['Bluetooth 5.3', 72], ['Bluetooth 5.0 to 5.2', 31], ['USB-C wired', 14], ['3.5 mm wired', 26]].map(([l, n], i) => ck(`${px}-cn${i}`, l, n, false)).join(''), false)}
    </div>`;
  }

  const bannerAd = () => `<a class="shop-banner" href="${go('store/product')}" aria-label="Advertisement: Halden Aurora headphones at the Official Store">
      <span class="ad-label">Ad</span>
      <div class="copy">
        <span class="eyebrow">Halden · at the Official Store</span>
        <span class="h2">40 hours of quiet. Aurora ANC headphones, now ${money(189)}.</span>
        <span class="small sub">Sale ends Oct 19, 11:59 PM PT. Sold and shipped by ${esc(S.official.name)}.</span>
        <span class="row gap-3"><span class="btn btn-primary btn-sm">Shop Aurora</span><span class="xs muted">Advertiser: Halden Audio</span></span>
      </div>
      <div class="art" aria-hidden="true">${U.pimg(P.aurora)}${U.pimg(X.buds)}</div>
    </a>`;

  /* ==================== 1. All categories ==================== */
  const SUBS = {
    electronics: [['Headphones', 128], ['Speakers', 96], ['Smart home', 210], ['Wearables', 74], ['Cameras', 0]],
  };
  const subsOf = (c) => SUBS[c.id] || c.subs.map((s, i) => [s, Math.round(c.count * [0.31, 0.24, 0.19, 0.15, 0.11][i])]);
  const SOON = [{ name: 'Garden & Outdoor', icon: 'flower-2', tint: 'var(--img-1)' }, { name: 'Automotive', icon: 'car', tint: 'var(--img-6)' }];
  const subIcons = { Headphones: 'headphones', Speakers: 'speaker', 'Smart home': 'house', Wearables: 'watch', Cameras: 'camera' };

  U.register({
    id: 'store/categories', title: 'All categories', ref: 'Plan ch. 3–4',
    notes: 'Category tree as the Android Categories tab (left rail of top categories, subcategory tiles) and as a desktop overview with counts. Categories without stock are shown as Coming soon instead of leading to empty pages.',
    render: () => {
      const el = D.categories[0];
      const phone = `<div class="only-phone"><div class="shop-rail">
        <nav aria-label="Top categories">${D.categories.map((c, i) => `<a href="javascript:void 0" class="${i === 0 ? 'is-active' : ''}"${i === 0 ? ' aria-current="true"' : ''}>${icon(c.icon)}<span>${esc(c.name)}</span></a>`).join('')}
          ${SOON.map((c) => `<a href="javascript:void 0" class="is-soon">${icon(c.icon)}<span>${c.name}</span><span class="soon">Coming soon</span></a>`).join('')}</nav>
        <div class="pane">
          <div class="row between base"><h1 class="h3">${esc(el.name)}</h1><a class="small strong" href="${go('store/category')}">Shop all (${num(el.count)})</a></div>
          <div class="shop-tiles">${subsOf(el).map(([s, n]) => n
            ? `<a class="shop-tile" href="${go('store/category')}">${U.img(subIcons[s] || el.icon, el.tint)}<span>${s}</span><span class="n">${num(n)} items</span></a>`
            : `<span class="shop-tile is-soon">${U.img(subIcons[s] || el.icon, 'var(--surface-3)')}<span>${s}</span><span class="n">Coming soon</span></span>`).join('')}</div>
          <p class="xs muted">${icon('info', 'ic-sm')} Cameras has no sellers with stock yet, so it can't be opened. We list it so you know it's planned.</p>
          <div class="stack gap-3"><h2 class="h4">Popular brands</h2>
            <div class="shop-tiles">${D.brands.slice(0, 3).map((b) => `<a class="shop-tile" href="${go('store/brand')}">${U.logoTile(b)}<span>${b.name}</span></a>`).join('')}</div></div>
          <div class="stack gap-3"><h2 class="h4">Electronics deals</h2>
            <a class="row gap-3 nowrap card pad" style="color:var(--text);text-decoration:none" href="${go('store/product')}">${U.pimg(P.aurora, 'tiny')}<span class="stack gap-0" style="min-width:0"><span class="small strong truncate">${esc(P.aurora.name)}</span>${U.price(P.aurora.price, P.aurora.was)}</span></a></div>
        </div>
      </div></div>`;
      const desktop = `<div class="container page no-phone">
        <div class="stack gap-2">${crumb([HOME, 'All categories'])}<h1 class="h1">All categories</h1><p class="sub">${num(D.categories.reduce((a, c) => a + c.count, 0))} products from the Official Store and approved sellers. Counts show items in stock now.</p></div>
        <div class="shop-catgrid">${D.categories.map((c) => `
          <section class="card shop-catcard" aria-labelledby="cat-${c.id}">
            <a href="${go('store/category')}" aria-hidden="true" tabindex="-1">${U.img(c.icon, c.tint)}</a>
            <div class="row between base"><h2 class="h3" id="cat-${c.id}"><a href="${go('store/category')}" style="color:var(--text)">${esc(c.name)}</a></h2><span class="xs muted">${num(c.count)}</span></div>
            <ul>${subsOf(c).map(([s, n]) => n ? `<li><a href="${go('store/category')}"><span>${s}</span><span class="n">${num(n)}</span></a></li>` : `<li><span><span class="muted">${s}</span>${badge('Coming soon')}</span></li>`).join('')}</ul>
            <a class="small strong" href="${go('store/category')}">Shop all ${esc(c.name)} ${icon('arrow-right', 'ic-sm')}</a>
          </section>`).join('')}
          ${SOON.map((c) => `
          <section class="card shop-catcard is-soon" aria-label="${c.name}, coming soon">
            ${U.img(c.icon, c.tint)}
            <div class="row between base"><h2 class="h3">${c.name}</h2>${badge('Coming soon')}</div>
            <p class="small sub">Opens when approved sellers have stock here. We hide empty categories so you never land on an empty page.</p>
          </section>`).join('')}
        </div>
        <div class="row gap-3 small sub">${icon('store')}<span>Want to sell in a category that isn't open yet? <a href="${go('sell/landing')}">Apply to sell on ${U.BRAND}</a>.</span></div>
      </div>`;
      return U.storeLayout(phone + desktop, { tab: 'categories', nav: 'categories' });
    },
  });

  /* ==================== 2. Category page ==================== */
  const CAT_IDS = ['aurora', 'aria', 'q3', 'wave', 'studio', 'buds', 'wavepro', 'q1', 'run', 'kids', 'open', 'neck'];
  function categoryPage(state) {
    const content = `<div class="container page" style="gap:var(--sp-5)">
      <div class="stack gap-2">
        ${crumb([HOME, { label: 'Electronics', href: go('store/categories') }, 'Headphones'])}
        <h1 class="h1">Headphones</h1>
        <p class="small muted">128 results from 9 sellers, including the Official Store</p>
      </div>
      ${U.chips([{ label: 'All headphones', active: true }, 'Over-ear', 'In-ear and earbuds', 'On-ear', 'Noise cancelling', 'Sport', 'Kids', 'Studio and wired'].map((c) => typeof c === 'string' ? { label: c, href: go('store/category') } : c))}
      ${bannerAd()}
      <div class="shop-listing">
        <aside class="only-desktop" aria-labelledby="cf-h"><h2 class="h4" id="cf-h">Filters</h2>${filterPanel('cf')}</aside>
        <div class="stack gap-4" style="min-width:0">
          <div class="shop-toolbar">
            <div class="row gap-2">
              <a class="btn btn-secondary btn-sm no-desktop" href="${go('store/category', 'Filters (phone sheet)')}">${icon('sliders-horizontal')}<span>Filters</span></a>
              <span class="small sub">Showing 1–12 of 128</span>
            </div>
            ${sortSel('cat-sort')}
          </div>
          ${fromNote()}
          <div class="grid-products">${cards(CAT_IDS, { sp: [2, 7] })}</div>
          <div class="row between"><span class="xs muted">Sponsored items are paid placements and are labeled. <a href="${go('help/article')}">How results are ranked</a></span>${U.pager(1, 11, { grid: true })}</div>
        </div>
      </div>
    </div>`;
    const layout = U.storeLayout(content, { nav: 'categories', tab: 'categories', appbar: { title: 'Headphones', back: go('store/categories'), actions: U.iconBtn('search', 'Search', { href: go('store/search') }) } });
    if (state !== 'Filters (phone sheet)') return layout;
    return layout + U.modal({
      title: 'Filters and sort',
      body: `<div class="stack gap-2"><h3 class="h4">Sort by</h3>${SORTS.map((s, i) => U.radio('cs-sort', 'cs-sort' + i, s, i === 0)).join('')}</div>${filterPanel('cs')}`,
      foot: `${btn('Clear all', { v: 'ghost' })}${btn('Show 128 results', { href: go('store/category'), cls: 'grow' })}`,
    });
  }
  U.register({
    id: 'store/category', title: 'Category page', ref: 'Plan ch. 4, 16', states: ['Default', 'Filters (phone sheet)'],
    notes: 'Electronics › Headphones with universal filters plus headphone-specific filters, five sort orders, a labeled banner ad and labeled sponsored cards. “From” prices are explained; on phones the filters open as a bottom sheet.',
    render: (state) => categoryPage(state),
  });

  /* ==================== 3. Search results ==================== */
  const SEARCH_IDS = ['aurora', 'wave', 'aria', 'q1', 'wavepro', 'buds', 'open', 'q3', 'run', 'kids', 'neck', 'studio'];
  function searchBody(q) {
    return `<div class="container page" style="gap:var(--sp-5)">
      <div class="stack gap-2">
        <h1 class="h2">Results for “${esc(q)}”</h1>
        <p class="small sub">Showing results for <b>wireless headphones</b>. <a href="javascript:void 0">Search instead for “wirless headfones”</a></p>
      </div>
      <div class="shop-active" aria-label="Active filters">
        <span class="small strong">Filters:</span>
        ${['Price: $50 to $250', '4 stars and up', 'Free delivery'].map((f) => `<a class="chip is-soft" href="javascript:void 0" aria-label="Remove filter ${f}">${f}${icon('x', 'ic-sm')}</a>`).join('')}
        <a class="small strong" href="javascript:void 0">Clear all</a>
      </div>
      <section class="card pad row between gap-4" aria-labelledby="sr-store">
        <div class="row gap-3 nowrap" style="min-width:0">${U.logoTile(S.northwind)}
          <div class="stack gap-1" style="min-width:0"><span class="eyebrow">Store match</span><span class="row gap-2"><h2 class="h4" id="sr-store">Store: Northwind Audio</h2>${U.sellerBadge(S.northwind, true)}</span><span class="xs muted">98% positive (4,812 ratings) · 86 products · Portland, OR</span></div></div>
        <div class="stack gap-1" style="align-items:flex-start">${btn('Visit store', { v: 'secondary', size: 'sm', href: go('store/seller'), iconR: 'arrow-right' })}<span class="xs muted">Stores are listed here, not mixed into product results.</span></div>
      </section>
      <section class="stack gap-3" aria-labelledby="sr-sp">
        <div class="row between base"><h2 class="h4" id="sr-sp">Sponsored products</h2><a class="xs" href="${go('help/article')}">Why these ads?</a></div>
        <div class="grid-products">${cards(['q3', 'buds', 'wavepro', 'aria'], { sp: [0, 1, 2, 3] })}</div>
      </section>
      <div class="shop-listing">
        <aside class="only-desktop" aria-labelledby="sf-h"><h2 class="h4" id="sf-h">Filters</h2>${filterPanel('sf', { kind: 'search' })}</aside>
        <div class="stack gap-4" style="min-width:0">
          <div class="shop-toolbar">
            <div class="row gap-2"><a class="btn btn-secondary btn-sm no-desktop" href="javascript:void 0">${icon('sliders-horizontal')}<span>Filters (3)</span></a><span class="small sub">86 results</span></div>
            ${sortSel('sr-sort')}
          </div>
          ${fromNote()}
          <div class="grid-products">${cards(SEARCH_IDS)}</div>
          <div class="row between"><span class="xs muted">Results match product names, brands and descriptions. Sponsored items are labeled.</span>${U.pager(1, 8, { grid: true })}</div>
        </div>
      </div>
    </div>`;
  }
  function suggestPanel() {
    const sugg = ['headphones', 'headphones noise cancelling', 'headphones for running', 'headphones under $100', 'earbuds'];
    return `<div class="shop-sugg" role="region" aria-label="Search suggestions">
      <div class="shop-sugg-grid">
        <div>
          <h3>Suggestions</h3>
          ${sugg.map((s, i) => `<a class="it${i === 0 ? ' is-hl' : ''}" href="${go('store/search')}">${icon('search')}<span><span class="q">wireless </span><b>${s}</b></span></a>`).join('')}
          <a class="it" href="${go('store/category')}">${icon('folder-tree')}<span><span class="q">wireless headphones</span> in <b>Electronics › Headphones</b></span></a>
          <h3>Brands</h3>
          ${['Halden', 'Kestrel'].map((n) => { const b = D.brands.find((x) => x.name === n); return `<a class="it" href="${go('store/brand')}">${U.logoTile(b)}<span class="stack gap-0"><span class="strong">${n}</span><span class="xs muted">Brand · ${b.products} products</span></span></a>`; }).join('')}
          <h3>Stores</h3>
          <a class="it" href="${go('store/seller')}">${U.logoTile(S.northwind)}<span class="stack gap-0 grow"><span class="row gap-2"><span class="strong">Northwind Audio</span>${U.sellerBadge(S.northwind, true)}</span><span class="xs muted">Seller store · 86 products in audio</span></span><span class="small strong t-brand-text nowrap">Visit store</span></a>
        </div>
        <div>
          <div class="row between" style="padding-right:var(--sp-3)"><h3>Recent searches</h3><a class="xs strong" href="javascript:void 0">Clear all</a></div>
          ${['cast iron skillet', 'usb-c monitor 27', 'merino sweater', 'halden speaker'].map((r) => `<div class="recent"><a href="${go('store/search')}">${icon('history')}<span>${r}</span></a>${U.iconBtn('x', `Remove “${r}” from recent searches`)}</div>`).join('')}
          <h3>Products</h3>
          ${['aurora', 'wave'].map((id) => { const p = PP[id]; return `<a class="it" href="${go('store/product')}">${U.pimg(p, 'tiny')}<span class="stack gap-0" style="min-width:0"><span class="small truncate">${esc(p.name)}</span><span class="xs muted">from ${money(p.price)} · ${esc(S[p.seller].name)}</span></span></a>`; }).join('')}
          <p class="xs muted" style="padding:var(--sp-2) var(--sp-3)">Recent searches are saved to your account (on this device when you're not signed in). Turn them off in <a href="${go('account/profile')}">Profile</a>.</p>
        </div>
      </div>
    </div>`;
  }
  U.register({
    id: 'store/search', title: 'Search results', ref: 'Plan ch. 4, 16', states: ['Results', 'Suggestions open'],
    notes: 'Search keeps the query in the box, corrects common misspellings with a way back, shows removable filter chips, lists a matching seller as a separate store card and labels sponsored products. Suggestions include queries, brands, a seller store and recent searches.',
    render: (state) => {
      if (state === 'Suggestions open') {
        return U.storeLayout(`<div class="shop-sugg-wrap">${suggestPanel()}<div class="shop-sugg-scrim" aria-hidden="true"></div>${searchBody('wireless headphones')}</div>`, { tab: 'home', q: 'wireless h' });
      }
      return U.storeLayout(searchBody('wireless headphones'), { tab: 'home', q: 'wireless headphones' });
    },
  });

  /* ==================== 4. No results / unavailable ==================== */
  function noResults() {
    return `<div class="container page" style="gap:var(--sp-6)">
      <div class="stack gap-2"><h1 class="h2">No results for “halden aurora pink”</h1><p class="small sub">with 3 filters applied</p></div>
      <div class="card pad stack gap-4">
        ${U.empty('search-x', 'Nothing matches all your filters', 'Aurora headphones come in Midnight black, Stone and Sage. Try removing a filter. Each button shows how many results you will get.')}
        <div class="row gap-2" style="justify-content:center">
          ${[['Color: Pink', 9], ['Condition: Used', 4], ['Price: under $100', 3]].map(([f, n]) => `<a class="chip" href="javascript:void 0">${icon('x', 'ic-sm')}Remove ${f} <span class="muted">(${n} results)</span></a>`).join('')}
        </div>
        <div class="row gap-3" style="justify-content:center">${btn('Clear all filters (12 results)', { v: 'secondary', href: go('store/search') })}${btn('Search all Headphones', { v: 'ghost', href: go('store/category') })}</div>
      </div>
      <section class="stack gap-3" aria-labelledby="nr-cats"><h2 class="h3" id="nr-cats">Nearby categories</h2>
        ${U.chips([{ label: 'Headphones', icon: 'headphones', href: go('store/category') }, { label: 'Earbuds', icon: 'ear', href: go('store/category') }, { label: 'Speakers', icon: 'speaker', href: go('store/category') }, { label: 'Headphone accessories', icon: 'cable', href: go('store/category') }])}</section>
      <section class="stack gap-3" aria-labelledby="nr-tips"><h2 class="h3" id="nr-tips">Search tips</h2>
        <ul class="ul small sub stack gap-1"><li>Check the spelling or use fewer words, for example “halden aurora”.</li><li>Search by brand, product type or seller name.</li><li>Colors are listed as the brand names them. Aurora's light color is “Stone”.</li></ul></section>
      <section class="stack gap-4" aria-labelledby="nr-pop">${U.sectionHead('<span id="nr-pop">Popular in Headphones</span>', { link: 'See all', href: go('store/category') })}
        <div class="grid-products wide">${cards(['aurora', 'buds', 'wave', 'aria', 'studio'])}</div></section>
    </div>`;
  }
  function unavailable() {
    const alts = D.auroraOffers.filter((o) => o.seller === 'northwind' || o.seller === 'pixelport');
    return `<div class="container page" style="gap:var(--sp-6)">
      ${crumb([HOME, { label: 'Electronics', href: go('store/categories') }, { label: 'Headphones', href: go('store/category') }, 'Halden Aurora'])}
      <div class="shop-pdp" style="grid-template-columns:minmax(0,1fr)">
        <div class="split">
          <div class="grid md2" style="--gap:var(--sp-6);align-items:start">
            <div style="position:relative">${U.img('headphones', 'var(--img-5)')}<span style="position:absolute;top:12px;left:12px">${U.status('Out of stock')}</span></div>
            <div class="stack gap-3">
              <a class="small strong" href="${go('store/brand')}">Halden</a>
              <h1 class="h2">Halden Aurora ANC Wireless Headphones, Stone</h1>
              ${U.stars(4.6, 1284)}
              ${U.alert('warning', 'Out of stock at the Official Store', 'Marketly Official expects more Stone units around Oct 26. Dates from suppliers can change. Other sellers still have this color below.')}
              <div class="stack gap-2"><span class="small strong">Color: Stone</span>
                <div class="row gap-2">${U.chips([{ label: 'Midnight black · in stock', href: go('store/product') }, { label: 'Stone · from other sellers', active: true }, { label: 'Sage · in stock', href: go('store/product') }])}</div></div>
              <div class="well stack gap-3">
                <span class="strong">${icon('bell-ring', 'ic-sm')} Email me when it's back</span>
                ${U.field('Email', U.input('pu-email', D.customer.email, { type: 'email' }), { hint: 'We send one email when the Official Store has Stone in stock. No marketing.' })}
                ${btn('Email me when it’s back', { icon: 'bell' })}
              </div>
            </div>
          </div>
          <section class="card" aria-labelledby="pu-alt">
            <div class="card-head"><div class="stack gap-0"><h2 class="h4" id="pu-alt">Available from other sellers</h2><span class="xs muted">Same product and color. Seller, condition and terms differ.</span></div></div>
            <ul class="list pad">${alts.map((o) => { const s = S[o.seller]; return `<li style="align-items:flex-start">
              <div class="stack gap-2 grow">
                <div class="row between"><span class="row gap-2"><b class="small">${esc(s.name)}</b>${U.sellerBadge(s, true)}</span>${badge(o.condition, 'outline')}</div>
                <div class="row gap-2 base">${U.price(o.price)}<span class="xs muted">${o.ship ? '+ ' + money(o.ship) + ' shipping' : 'Free shipping'}</span></div>
                ${U.shipLine(`Arrives ${o.delivery} · ${o.returns}`)}
                ${o.note ? `<span class="shop-note">${icon('info')}${esc(o.note)}</span>` : ''}
                ${btn('Choose this offer', { v: 'secondary', size: 'sm', href: go('store/product', 'Seller offer selected') })}
              </div></li>`; }).join('')}</ul>
            <div class="card-foot"><a class="small strong" href="${go('store/offers')}">Compare all offers ${icon('arrow-right', 'ic-sm')}</a></div>
          </section>
        </div>
      </div>
      <section class="card pad row gap-4 nowrap" aria-labelledby="pu-old">
        ${U.img('headphones', 'var(--surface-3)', 'thumb')}
        <div class="stack gap-1 grow"><span class="row gap-2"><h2 class="h4" id="pu-old">Halden Aurora (2025 model)</h2>${badge('No longer available', '')}</span>
          <span class="small sub">From your recently viewed. Halden stopped making this model and replaced it with the 2026 Aurora above. Your past orders and reviews for it stay in your account.</span></div>
      </section>
      <section class="stack gap-4" aria-labelledby="pu-sim">${U.sectionHead('<span id="pu-sim">Similar headphones in stock</span>', { link: 'See all', href: go('store/category') })}
        <div class="grid-products wide">${cards(['wavepro', 'q3', 'studio', 'wave', 'buds'])}</div></section>
    </div>`;
  }
  U.register({
    id: 'store/search-empty', title: 'No results and unavailable', ref: 'Plan ch. 4–5', states: ['No results', 'Product unavailable'],
    notes: 'Empty results suggest removing single filters (with result counts), nearby categories and popular products. An out-of-stock product explains the status and expected date, offers other sellers and a back-in-stock email, and a discontinued model is labeled “No longer available”.',
    render: (state) => state === 'Product unavailable'
      ? U.storeLayout(unavailable(), { appbar: { title: 'Product', back: go('store/category') } })
      : U.storeLayout(noResults(), { tab: 'home', q: 'halden aurora pink' }),
  });

  /* ==================== 5. Product page ==================== */
  const OFF = Object.fromEntries(D.auroraOffers.map((o) => [o.seller, o]));
  const total = (o) => o.price + o.ship;
  const qaBadge = { seller: badge('Seller', 'info', 'store'), staff: badge('Marketly staff', 'brand', 'badge-check'), customer: badge('Customer', '', 'user-round') };

  function buyBox(sel) {
    const o = sel ? OFF.northwind : OFF.official;
    const s = S[o.seller];
    const others = D.auroraOffers.filter((x) => x !== o);
    const minOther = Math.min(...others.map((x) => x.price));
    return `<section class="card shop-buy" aria-labelledby="buy-h">
      <div class="card-body">
        <h2 class="sr-only" id="buy-h">Purchase options</h2>
        ${sel ? U.alert('info', 'You chose Northwind Audio’s offer', 'This seller stays with the item in your cart. We never switch sellers for you.') : `<div class="row between"><span class="eyebrow">Featured offer</span><a class="xs" href="${go('store/offers')}">How it’s chosen</a></div>`}
        <div class="stack gap-1">
          ${sel ? U.price(o.price, null, { lg: true }) : U.price(o.price, P.aurora.was, { lg: true })}
          ${sel ? `<span class="small sub">+ ${money(o.ship)} shipping · <b>${money(total(o))}</b> before tax</span>` : `<span class="small t-deal-text strong">Sale ends Oct 19, 11:59 PM PT</span><span class="xs muted">Was price is the Official Store’s lowest price in the 30 days before the sale.</span>`}
        </div>
        <div class="row gap-2">${U.status('In stock')}<span class="small sub">${sel ? '23 available' : '142 available'} · Condition: <b>New</b></span></div>
        <div class="stack gap-2">
          <div class="shop-line">${icon('truck')}<span>${sel ? `<b>Arrives Fri, Oct 16 – Mon, Oct 19</b>` : `<b>Free delivery Thu, Oct 15</b>`} to Portland 97205 · <a href="javascript:void 0">Change</a>${sel ? '' : '<br><span class="xs muted">Order within 4 h 12 min for this date</span>'}</span></div>
          <div class="shop-line">${icon('package')}<span>${sel ? `Ships from Portland, OR by <b>Northwind Audio</b> with USPS Ground Advantage · ${money(o.ship)}` : `Ships from Reno, NV by <b>${U.BRAND}</b> with UPS Ground · Free`}</span></div>
          <div class="shop-line">${icon('store')}<span>Sold by <a href="${s.official ? go('store/official') : go('store/seller')}"><b>${esc(s.name)}</b></a> ${U.sellerBadge(s, true)}<br><span class="xs muted">${s.positive}% positive · ${num(s.ratings)} ratings</span></span></div>
          <div class="shop-line">${icon('undo-2')}<span>${sel ? '30-day returns. You pay return shipping (about $8.50) unless the item is faulty.' : '30-day free returns'} · <a href="${go('info/policy', 'Returns')}">Return policy</a></span></div>
          <div class="shop-line">${icon('shield-check')}<span>${o.warranty}</span></div>
        </div>
        <div class="row gap-3">
          <label class="small strong" for="pdp-qty">Quantity</label>${U.select('pdp-qty', ['1', '2', '3'], '1')}
          <span class="xs muted">Limit 3 per customer</span>
        </div>
        <div class="stack gap-2">
          ${btn('Add to cart', { block: true, icon: 'shopping-cart', href: go('store/cart') })}
          ${btn('Buy now', { block: true, v: 'secondary', href: go('store/checkout') })}
          <span class="xs muted center">You’ll review totals, delivery and seller details before paying.</span>
        </div>
        <a class="small strong" href="${s.official ? go('store/official') : go('store/seller')}">${icon('store', 'ic-sm')} Visit ${sel ? 'Northwind Audio’s' : 'the seller’s'} store</a>
      </div>
      ${sel ? `<div class="card-foot" style="justify-content:stretch;flex-direction:column;align-items:stretch">
          <span class="eyebrow">Featured offer</span>
          <div class="row between gap-2"><span class="stack gap-0"><span class="row gap-2"><b class="small">${esc(S.official.name)}</b>${U.sellerBadge(S.official, true)}</span><span class="xs muted">${money(189)} · Free delivery Thu, Oct 15 · 30-day free returns</span></span>${btn('Choose', { v: 'secondary', size: 'sm', href: go('store/product') })}</div>
          <a class="small strong" href="${go('store/offers')}">See all 4 offers</a>
        </div>`
        : `<div class="card-foot" style="justify-content:space-between"><span class="small sub">Other sellers on ${U.BRAND}</span><a class="small strong" href="${go('store/offers')}">${others.length} offers from ${money(minOther)} ${icon('chevron-right', 'ic-sm')}</a></div>`}
    </section>`;
  }

  function productPage(state) {
    const sel = state === 'Seller offer selected';
    const p = P.aurora;
    const gallery = `<div class="shop-gal">
      <div class="main">${U.img('headphones', 'var(--img-2)')}<span class="cnt">${badge('1 / 7', 'solid')}</span><span class="fav">${U.iconBtn('heart', 'Save to wishlist')}</span></div>
      <div class="shop-thumbs" role="group" aria-label="Photos and video">
        ${['headphones', 'headphones', 'briefcase', 'battery-charging', 'bluetooth'].map((ic, i) => `<button type="button" class="${i === 0 ? 'is-active' : ''}" aria-label="Photo ${i + 1}">${U.img(ic, 'var(--img-2)', 'thumb')}</button>`).join('')}
        <button type="button" aria-label="Play product video, 42 seconds">${U.img('headphones', 'var(--img-6)', 'thumb')}<span class="vid">${icon('circle-play')}0:42</span></button>
      </div>
      <p class="xs muted">${icon('info', 'ic-sm')} Photos show Midnight black. Choosing another color updates the photos, offers and price.</p>
    </div>`;
    const info = `<div class="stack gap-4" style="min-width:0">
      <div class="stack gap-2">
        <a class="small strong" href="${go('store/brand')}">Visit the Halden brand page</a>
        <h1 class="h2">${esc(p.name)}</h1>
        <div class="row gap-3">${U.stars5(4.6)}<a class="small" href="javascript:void 0">4.6 · ${num(p.reviews)} ratings</a><span class="xs muted">·</span><a class="small" href="javascript:void 0">38 answered questions</a></div>
        <span class="xs muted">${badge('#3 in Headphones', 'outline')} Ranked by units sold in the last 30 days</span>
      </div>
      <div class="stack gap-2">
        <span class="small"><b>Color:</b> Midnight black</span>
        <div class="shop-var" role="group" aria-label="Color">
          <button type="button" class="is-selected" aria-pressed="true">${U.img('headphones', 'var(--img-2)')}<span class="vn">Midnight black</span><span class="sub">${money(189)} · In stock</span></button>
          <button type="button" aria-pressed="false">${U.img('headphones', 'var(--img-5)')}<span class="vn">Stone</span><span class="sub">2 offers from ${money(184)}</span></button>
          <button type="button" aria-pressed="false">${U.img('headphones', 'var(--img-1)')}<span class="vn">Sage</span><span class="sub">${money(199)} · In stock</span></button>
        </div>
      </div>
      <div class="stack gap-2"><h2 class="h4">Key features</h2>
        <ul class="shop-feat stack gap-2">
          ${['Hybrid active noise cancelling with 6 microphones and an adjustable transparency mode', 'Up to 40 hours with ANC on, 55 hours off. 10 minutes of charging gives 5 hours', 'Bluetooth 5.3 multipoint: stay connected to a phone and a laptop at once', 'Folds flat into the included hard travel case', 'Wired listening with the 3.5 mm cable when the battery is empty'].map((t) => `<li>${icon('check')}<span>${t}</span></li>`).join('')}
        </ul></div>
    </div>`;

    const specs = [['Brand', 'Halden'], ['Model', 'Aurora (2026), HA-AUR26'], ['SKU', '<span class="mono">HAL-AUR-BLK</span>'], ['Type', 'Over-ear, closed back'], ['Noise cancelling', 'Active, hybrid (6 microphones)'], ['Battery', '40 h ANC on · 55 h ANC off'], ['Charging', 'USB-C, 2 h full charge'], ['Bluetooth', '5.3, multipoint (2 devices)'], ['Codecs', 'SBC, AAC, LDAC'], ['Wired', '3.5 mm (cable included)'], ['Weight', '254 g (9 oz)'], ['Warranty', '2-year manufacturer warranty, US']];
    const inBox = ['Aurora headphones', 'Hard travel case', 'USB-C to USB-C cable, 1 m', '3.5 mm audio cable, 1.2 m', 'Airplane adapter', 'Quick start guide'];
    const bars = [[5, 72], [4, 17], [3, 6], [2, 2], [1, 3]];
    const reviews = [
      { n: 'Mara D.', r: 5, t: 'Quiet enough for a six-hour flight', d: 'Oct 2, 2026', v: 'Midnight black', s: 'official', b: 'Wore them PDX to JFK and back. The engine noise drops to a low hum, and I still had 60% battery at the end. Clamping is firm for the first week.', h: 48 },
      { n: 'Devon P.', r: 4, t: 'Great noise cancelling, bulky case', d: 'Sep 27, 2026', v: 'Stone', s: 'northwind', b: 'Sound and ANC are excellent for the price. The case takes up half my backpack. Multipoint between my phone and work laptop works without re-pairing.', h: 21 },
      { n: 'Ines K.', r: 2, t: 'Left ear cup crackles at high volume', d: 'Sep 19, 2026', v: 'Midnight black', s: 'official', b: 'Started after two weeks. Only above 80% volume. Otherwise comfortable.', h: 9, reply: { from: 'Marketly Official Store', d: 'Sep 20, 2026', t: 'Sorry about this. This is covered by the 2-year warranty and by our 30-day return window. Start a return from your order and choose “Item is faulty” for a free replacement.' } },
    ];
    const qa = [
      { q: 'Can I connect it to my phone and laptop at the same time?', a: [{ who: 'staff', n: 'Marketly Product Support', d: 'Oct 1, 2026', t: 'Yes. Aurora supports Bluetooth multipoint with two devices. Audio switches to whichever device starts playing.' }] },
      { q: 'Is the Northwind Audio offer a US unit with the US warranty?', a: [{ who: 'seller', n: 'Northwind Audio', d: 'Sep 29, 2026', t: 'Yes. We sell US retail units bought from Halden’s US distributor. The 2-year warranty is registered in your name with Halden US.' }] },
      { q: 'Can the ear cushions be replaced?', a: [{ who: 'customer', n: 'Priya K.', d: 'Sep 22, 2026', t: 'Yes, they clip off. I bought a replacement pair from Halden for $24.' }, { who: 'staff', n: 'Marketly Product Support', d: 'Sep 23, 2026', t: 'Replacement cushions (HAL-AUR-CUSH) are sold by the Official Store.' }] },
    ];
    const below = `
      <section class="shop-two even" aria-label="Product details">
        <div class="stack gap-4">
          <h2 class="h3">About this item</h2>
          <p class="sub">Aurora is Halden’s full-size travel headphone. It blocks steady noise like engines and air conditioning, and the transparency mode lets announcements through without taking the headphones off. Controls are physical buttons, so they work with gloves.</p>
          <div class="stack gap-2"><h3 class="h4">In the box</h3><ul class="shop-feat stack gap-1">${inBox.map((t) => `<li>${icon('package')}<span>${t}</span></li>`).join('')}</ul></div>
        </div>
        <div class="stack gap-3"><h2 class="h3">Specifications</h2><div class="card pad">${U.kv(specs)}</div></div>
      </section>

      <section class="stack gap-5" id="pdp-reviews" aria-labelledby="pdp-rev-h">
        <h2 class="h2" id="pdp-rev-h">Customer reviews</h2>
        <div class="shop-two">
          <div class="stack gap-4">
            <div class="row gap-3 base"><span class="display d-xl">4.6</span><span class="stack gap-1">${U.stars5(4.6, 18)}<span class="small sub">${num(p.reviews)} ratings · 412 written reviews</span></span></div>
            <div class="rating-bars">${bars.map(([s, pc]) => `<a href="javascript:void 0" class="nowrap">${s} star</a>${U.meter(pc)}<span>${pc}%</span>`).join('')}</div>
            ${U.alert('info', 'About these reviews', 'Product reviews describe the headphones. Feedback about a seller’s shipping and service is on each seller’s page, for example <a href="' + go('store/seller') + '">Northwind Audio feedback</a>. Verified Purchase means the reviewer bought this product on ' + U.BRAND + '.')}
            ${btn('Write a review', { v: 'secondary', href: go('account/review') })}
          </div>
          <div class="stack gap-0">
            ${U.chips([{ label: 'All reviews', active: true }, 'Verified Purchase only', 'With photos', 'Critical (1–2 stars)', 'Midnight black'])}
            ${reviews.map((r) => `<article class="shop-rev">
              <div class="row gap-2">${U.avatar(r.n)}<span class="small strong">${r.n}</span>${badge('Verified Purchase', 'success', 'circle-check')}</div>
              <div class="row gap-2">${U.stars5(r.r, 14)}<h3 class="h4">${r.t}</h3></div>
              <span class="xs muted">Reviewed ${r.d} · Color: ${r.v} · Sold by ${esc(S[r.s].name)}</span>
              <p class="small">${r.b}</p>
              ${r.reply ? `<div class="shop-reply"><span class="xs strong">Response from ${r.reply.from} · ${r.reply.d}</span><span>${r.reply.t}</span></div>` : ''}
              <div class="row gap-2">${btn(`Helpful (${r.h})`, { v: 'ghost', size: 'sm', icon: 'thumbs-up' })}${btn('Report', { v: 'ghost', size: 'sm', icon: 'flag' })}</div>
            </article>`).join('')}
            <a class="small strong" href="javascript:void 0" style="padding-top:var(--sp-3)">See all 412 reviews ${icon('arrow-right', 'ic-sm')}</a>
          </div>
        </div>
      </section>

      <section class="stack gap-4" id="pdp-qa" aria-labelledby="pdp-qa-h">
        <div class="row between"><h2 class="h2" id="pdp-qa-h">Customer questions</h2>${btn('Ask a question', { v: 'secondary', size: 'sm', icon: 'message-circle-question' })}</div>
        <div class="toolbar">${U.searchIn('Search 38 questions and answers', 'pdp-qa-q')}</div>
        <div class="card pad stack gap-0">${qa.map((x) => `<div class="shop-qa">
          <div class="row gap-2 top nowrap"><span class="strong small none">Q:</span><span class="strong small">${x.q}</span></div>
          ${x.a.map((a) => `<div class="a"><div class="row gap-2">${qaBadge[a.who]}<span class="xs muted">${a.n} · ${a.d}</span></div><span>${a.t}</span></div>`).join('')}
        </div>`).join('')}</div>
        <p class="xs muted">Answers are labeled Seller, ${U.BRAND} staff or Customer so you know who is speaking. Questions about your own order go to <a href="${go('account/messages')}">order messages</a>.</p>
      </section>

      <section class="stack gap-4" aria-labelledby="pdp-rel">${U.sectionHead('<span id="pdp-rel">Related products</span>', { link: 'More headphones', href: go('store/category') })}
        <div class="grid-products wide">${cards(['buds', 'studio', 'hcase', 'wave', 'mini'])}</div></section>
      <section class="stack gap-4" aria-labelledby="pdp-sp"><div class="row between base"><h2 class="h3" id="pdp-sp">Sponsored products related to this item</h2><a class="xs" href="${go('help/article')}">Why these ads?</a></div>
        <div class="grid-products wide">${cards(['q3', 'wavepro', 'aria', 'q1', 'open'], { sp: [0, 1, 2, 3, 4] })}</div></section>`;

    const content = `<div class="container page" style="gap:var(--sp-8)">
      <div class="stack gap-4">
        ${crumb([HOME, { label: 'Electronics', href: go('store/categories') }, { label: 'Headphones', href: go('store/category') }, 'Halden Aurora'])}
        <div class="shop-pdp">${gallery}${info}${buyBox(sel)}</div>
      </div>
      ${below}
    </div>`;
    const ab = `<div class="stack gap-0 none">${sel ? U.price(184) : U.price(189, 229, { noOff: true })}<span class="xs muted">${sel ? '+ $6.99 shipping' : 'Free delivery Oct 15'}</span></div><span class="grow"></span>${btn('Add to cart', { size: 'sm', href: go('store/cart') })}${btn('Buy now', { v: 'secondary', size: 'sm', href: go('store/checkout') })}`;
    return U.storeLayout(content, { nav: 'categories', appbar: { title: 'Halden Aurora', back: go('store/category'), actions: U.iconBtn('share-2', 'Share') + U.iconBtn('shopping-cart', 'Cart, 4 items', { href: go('store/cart'), count: 4 }) }, actionBar: ab });
  }

  /* New listing without reviews (honest empty state) */
  function lampPage() {
    const p = P.lamp;
    const s = S.official;
    const gallery = `<div class="shop-gal">
      <div class="main">${U.img('lamp-desk', 'var(--img-5)')}<span class="cnt">${badge('1 / 5', 'solid')}</span><span class="fav">${U.iconBtn('heart', 'Save to wishlist')}</span></div>
      <div class="shop-thumbs" role="group" aria-label="Photos">
        ${['lamp-desk', 'lamp-desk', 'smartphone', 'sun-dim', 'plug'].map((ic, i) => `<button type="button" class="${i === 0 ? 'is-active' : ''}" aria-label="Photo ${i + 1}">${U.img(ic, 'var(--img-5)', 'thumb')}</button>`).join('')}
      </div>
      <p class="xs muted">${icon('info', 'ic-sm')} Photos show White. Choosing another color updates the photos, offers and price.</p>
    </div>`;
    const info = `<div class="stack gap-4" style="min-width:0">
      <div class="stack gap-2">
        <a class="small strong" href="${go('store/brand')}">Visit the Brightline brand page</a>
        <h1 class="h2">${esc(p.name)}</h1>
        <div class="row gap-2">${badge('New listing', 'info', 'sparkles')}<span class="small sub">No reviews yet</span><span class="xs muted">·</span><a class="small" href="javascript:void 0">1 answered question</a></div>
        <span class="xs muted">Listed on ${U.BRAND} Oct 6, 2026</span>
      </div>
      <div class="stack gap-2">
        <span class="small"><b>Color:</b> White</span>
        <div class="shop-var" role="group" aria-label="Color">
          <button type="button" class="is-selected" aria-pressed="true">${U.img('lamp-desk', 'var(--img-5)')}<span class="vn">White</span><span class="sub">${money(42)} · 9 left</span></button>
          <button type="button" aria-pressed="false">${U.img('lamp-desk', 'var(--img-6)')}<span class="vn">Charcoal</span><span class="sub">${money(42)} · In stock</span></button>
        </div>
      </div>
      <div class="stack gap-2"><h2 class="h4">Key features</h2>
        <ul class="shop-feat stack gap-2">
          ${['Built-in 15 W Qi wireless charger in the base', 'Five color temperatures from 2700 K to 6500 K, stepless dimming', 'App and voice control with a manual touch strip that works offline', 'Folding arm and head reach 45 cm over the desk from a 14 cm base', 'Auto-off timer and a night mode at 3% brightness'].map((t) => `<li>${icon('check')}<span>${t}</span></li>`).join('')}
        </ul></div>
    </div>`;
    const buy = `<section class="card shop-buy" aria-labelledby="buy-h">
      <div class="card-body">
        <h2 class="sr-only" id="buy-h">Purchase options</h2>
        <div class="row between"><span class="eyebrow">Only offer</span><span class="xs muted">1 seller</span></div>
        ${U.price(p.price, null, { lg: true })}
        <div class="row gap-2">${U.status('Low stock')}<span class="small sub">9 available · Condition: <b>New</b></span></div>
        <div class="stack gap-2">
          <div class="shop-line">${icon('truck')}<span><b>Free delivery Wed, Oct 14</b> to Portland 97205 · <a href="javascript:void 0">Change</a><br><span class="xs muted">Free on Official Store orders over $35</span></span></div>
          <div class="shop-line">${icon('package')}<span>Ships from Reno, NV by <b>${U.BRAND}</b> with UPS Ground</span></div>
          <div class="shop-line">${icon('store')}<span>Sold by <a href="${go('store/official')}"><b>${esc(s.name)}</b></a> ${U.sellerBadge(s, true)}<br><span class="xs muted">${s.positive}% positive · ${num(s.ratings)} ratings for this seller</span></span></div>
          <div class="shop-line">${icon('undo-2')}<span>30-day free returns · <a href="${go('info/policy', 'Returns')}">Return policy</a></span></div>
          <div class="shop-line">${icon('shield-check')}<span>2-year warranty on electronics, handled by ${U.BRAND}</span></div>
        </div>
        <div class="row gap-3"><label class="small strong" for="pdl-qty">Quantity</label>${U.select('pdl-qty', ['1', '2'], '1')}<span class="xs muted">Limit 2 per customer</span></div>
        <div class="stack gap-2">
          ${btn('Add to cart', { block: true, icon: 'shopping-cart', href: go('store/cart') })}
          ${btn('Buy now', { block: true, v: 'secondary', href: go('store/checkout') })}
          <span class="xs muted center">You’ll review totals, delivery and seller details before paying.</span>
        </div>
        <a class="small strong" href="${go('store/official')}">${icon('store', 'ic-sm')} Visit the Official Store</a>
      </div>
      <div class="card-foot" style="justify-content:flex-start"><span class="small sub">No other sellers offer this product yet.</span></div>
    </section>`;
    const specs = [['Brand', 'Brightline'], ['Model', 'Smart Desk Lamp W1'], ['SKU', '<span class="mono">BRL-LAMP-W</span>'], ['Light', '8 W LED, 520 lumens, CRI 90+'], ['Color temperature', '2700–6500 K'], ['Charging pad', 'Qi, up to 15 W'], ['Connectivity', 'Wi-Fi 2.4 GHz, Bluetooth for setup'], ['Power', '24 W USB-C adapter (included)'], ['Size', 'Base 14 cm, arm reach 45 cm'], ['Warranty', '2 years, handled by the Official Store']];
    const below = `
      <section class="shop-two even" aria-label="Product details">
        <div class="stack gap-4">
          <h2 class="h3">About this item</h2>
          <p class="sub">A compact desk lamp that charges your phone in its base. The touch strip on the arm controls brightness and color without the app, so it still works if your Wi-Fi is down.</p>
          <div class="stack gap-2"><h3 class="h4">In the box</h3><ul class="shop-feat stack gap-1">${['Lamp with charging base', '24 W USB-C power adapter', 'USB-C cable, 1.5 m', 'Quick start guide'].map((t) => `<li>${icon('package')}<span>${t}</span></li>`).join('')}</ul></div>
        </div>
        <div class="stack gap-3"><h2 class="h3">Specifications</h2><div class="card pad">${U.kv(specs)}</div></div>
      </section>

      <section class="stack gap-5" aria-labelledby="pdl-rev-h">
        <h2 class="h2" id="pdl-rev-h">Customer reviews</h2>
        <div class="shop-two">
          <div class="stack gap-3">
            <span class="h3">No reviews yet</span>
            <p class="small sub">This product was listed on Oct 6. We don’t show a star rating until customers who bought it have reviewed it.</p>
            ${U.alert('info', 'Only verified purchases can review', 'Reviews are linked to a recorded purchase on ' + U.BRAND + '. Seller feedback for the Official Store is shown on <a href="' + go('store/official') + '">its store page</a>.')}
          </div>
          <div class="card">${U.empty('message-square-text', 'Be the first to review after you buy it', 'Only verified purchases can review. We’ll ask you for a review a few days after delivery.', btn('How reviews work', { v: 'secondary', size: 'sm', href: go('help/article') }))}</div>
        </div>
      </section>

      <section class="stack gap-4" aria-labelledby="pdl-qa-h">
        <div class="row between"><h2 class="h2" id="pdl-qa-h">Customer questions</h2>${btn('Ask a question', { v: 'secondary', size: 'sm', icon: 'message-circle-question' })}</div>
        <div class="toolbar">${U.searchIn('Search questions and answers', 'pdl-qa-q')}</div>
        <div class="card pad stack gap-0">
          <div class="shop-qa">
            <div class="row gap-2 top nowrap"><span class="strong small none">Q:</span><span class="strong small">Will the charging pad work through a phone case?</span></div>
            <div class="a"><div class="row gap-2">${qaBadge.staff}<span class="xs muted">Marketly Product Support · Oct 7, 2026</span></div><span>Yes, through cases up to 5 mm thick without metal or magnets.</span></div>
          </div>
          <div class="shop-qa">
            <div class="row gap-2 top nowrap"><span class="strong small none">Q:</span><span class="strong small">Does it need the app to change brightness?</span></div>
            <div class="a"><span class="xs muted">Not answered yet. Asked Oct 8, 2026. The Official Store usually answers within 1 business day.</span></div>
          </div>
        </div>
        <p class="xs muted">Answers are labeled Seller, ${U.BRAND} staff or Customer so you know who is speaking.</p>
      </section>

      <section class="stack gap-4" aria-labelledby="pdl-rel">${U.sectionHead('<span id="pdl-rel">Related products</span>', { link: 'More lighting', href: go('store/category') })}
        <div class="grid-products wide">${cards(['floorlamp', 'string', 'keyboard', 'kestrel27', 'pourover'])}</div></section>
      <section class="stack gap-4" aria-labelledby="pdl-sp"><div class="row between base"><h2 class="h3" id="pdl-sp">Sponsored products related to this item</h2><a class="xs" href="${go('help/article')}">Why these ads?</a></div>
        <div class="grid-products wide">${cards(['ssd1tb', 'cable', 'kettle', 'sheets', 'speaker'], { sp: [0, 1, 2, 3, 4] })}</div></section>`;
    const content = `<div class="container page" style="gap:var(--sp-8)">
      <div class="stack gap-4">
        ${crumb([HOME, { label: 'Home & Kitchen', href: go('store/categories') }, { label: 'Lighting', href: go('store/category') }, 'Brightline Smart LED Desk Lamp'])}
        <div class="shop-pdp">${gallery}${info}${buy}</div>
      </div>
      ${below}
    </div>`;
    const ab = `<div class="stack gap-0 none">${U.price(p.price)}<span class="xs muted">Free delivery Oct 14</span></div><span class="grow"></span>${btn('Add to cart', { size: 'sm', href: go('store/cart') })}${btn('Buy now', { v: 'secondary', size: 'sm', href: go('store/checkout') })}`;
    return U.storeLayout(content, { nav: 'categories', appbar: { title: 'Desk lamp', back: go('store/category'), actions: U.iconBtn('share-2', 'Share') + U.iconBtn('shopping-cart', 'Cart, 4 items', { href: go('store/cart'), count: 4 }) }, actionBar: ab });
  }
  U.register({
    id: 'store/product', title: 'Product detail', ref: 'Plan ch. 5, 17', states: ['Official Store offer', 'Seller offer selected', 'No reviews yet'],
    notes: 'Product information (gallery with video, variations that update photos, offers and price, features, specs, in the box) is separate from the offer in the purchase box (seller, condition, discount terms, stock, limit, shipper, delivery estimate, returns, warranty). Picking another seller keeps that seller and still shows the featured offer. A new listing shows “No reviews yet” without fake stars.',
    render: (state) => state === 'No reviews yet' ? lampPage() : productPage(state),
  });

  /* ==================== 6. All offers ==================== */
  const OX = {
    official: { carrier: 'UPS Ground', arrive: 'Thu, Oct 15', ontime: 99 },
    northwind: { carrier: 'USPS Ground Advantage', arrive: 'Fri, Oct 16 – Mon, Oct 19', ontime: 97 },
    pixelport: { carrier: 'FedEx Ground', arrive: 'Mon, Oct 19 – Tue, Oct 20', ontime: 95 },
    gadgetgrove: { carrier: 'USPS Ground Advantage', arrive: 'Tue, Oct 20 – Fri, Oct 23', ontime: 81 },
  };
  const offerBits = (o) => {
    const s = S[o.seller], x = OX[o.seller];
    return {
      seller: `<div class="stack gap-1"><a href="${s.official ? go('store/official') : go('store/seller')}"><b>${esc(s.name)}</b></a><span class="row gap-1">${s.verified ? U.sellerBadge(s, true) : badge('Not verified', 'outline')}</span></div>`,
      cost: `<div class="stack gap-0 num"><span class="strong">${money(total(o))}</span><span class="xs muted">${money(o.price)} + ${o.ship ? money(o.ship) + ' shipping' : 'free shipping'}</span></div>`,
      cond: `<div class="stack gap-1">${badge(o.condition, 'outline')}${o.note ? `<span class="xs sub">${esc(o.note)}</span>` : ''}${o.seller === 'gadgetgrove' ? `<span class="shop-note warn">${icon('package-x')}Missing: carry case</span>` : ''}${o.seller === 'pixelport' ? `<span class="shop-note">${icon('package-check')}Complete: all accessories</span>` : ''}</div>`,
      deliv: `<div class="stack gap-0"><span class="small strong">${x.arrive}</span><span class="xs muted">${o.dispatch} · ${x.carrier}</span></div>`,
      quality: `<div class="stack gap-0"><span class="small">${s.positive}% positive</span><span class="xs muted">${num(s.ratings)} ratings · ${x.ontime}% on-time dispatch</span></div>`,
      after: `<div class="stack gap-0"><span class="small">${o.returns}</span><span class="xs muted">${o.warranty}</span></div>`,
    };
  };
  U.register({
    id: 'store/offers', title: 'All offers', ref: 'Plan ch. 4–5', states: ['Total cost', 'Fastest delivery'],
    notes: 'Every offer for one product compared by total cost, condition (with notes and missing accessories), delivery, seller quality and after-sales terms. The featured offer is marked and its rule explained; an offer whose seller has delivery performance under review is shown but not eligible.',
    render: (state) => {
      const fast = state === 'Fastest delivery';
      const order = fast ? ['official', 'northwind', 'pixelport', 'gadgetgrove'] : ['gadgetgrove', 'pixelport', 'official', 'northwind'];
      const offers = order.map((k) => OFF[k]);
      const inel = `<span class="shop-note warn">${icon('triangle-alert')}Not eligible for featured offer: delivery performance under review</span>`;
      const phone = `<div class="stack gap-3 no-desktop">${offers.map((o) => { const b = offerBits(o); return `<article class="card pad shop-offer${o.main ? ' is-featured' : ''}">
          <div class="row between top">${b.seller}${o.main ? badge('Featured offer', 'brand', 'award') : ''}</div>
          ${o.restricted ? inel : ''}
          <div class="ogrid">
            <div><span class="k">Cost</span>${b.cost}</div>
            <div><span class="k">Condition</span>${b.cond}</div>
            <div><span class="k">Delivery</span>${b.deliv}</div>
            <div><span class="k">Seller quality</span>${b.quality}</div>
            <div style="grid-column:1/-1"><span class="k">Returns and warranty</span>${b.after}</div>
          </div>
          ${btn('Add to cart', { v: o.main ? 'primary' : 'secondary', block: true, href: go('store/cart') })}
        </article>`; }).join('')}</div>`;
      const desk = `<div class="card only-desktop shop-otable">${U.table(['Seller', 'Total cost', 'Condition', 'Delivery to 97205', 'Seller quality', 'Returns and warranty', { label: '', cls: 'r' }],
        offers.map((o) => { const b = offerBits(o); return [`${b.seller}${o.main ? `<div style="margin-top:6px">${badge('Featured offer', 'brand', 'award')}</div>` : ''}${o.restricted ? `<div style="margin-top:6px;max-width:200px">${inel}</div>` : ''}`, b.cost, `<div style="max-width:220px">${b.cond}</div>`, b.deliv, b.quality, `<div style="max-width:200px">${b.after}</div>`, btn('Add to cart', { v: o.main ? 'primary' : 'secondary', size: 'sm', href: go('store/cart') })]; }),
        { rowCls: offers.map((o) => o.main ? 'is-featured' : '') })}</div>`;
      const content = `<div class="container page" style="gap:var(--sp-5)">
        ${crumb([HOME, { label: 'Headphones', href: go('store/category') }, { label: 'Halden Aurora', href: go('store/product') }, 'All offers'])}
        <div class="card pad shop-mini">${U.pimg(P.aurora)}<div class="stack gap-1 grow"><h1 class="h3">${esc(P.aurora.name)}</h1><span class="row gap-2 small sub">Color: <b>Midnight black</b> <a href="${go('store/product')}">Change</a></span>${U.stars(4.6, P.aurora.reviews)}</div></div>
        <div class="shop-toolbar">
          ${U.chips([{ label: 'All conditions (4)', active: true }, 'New (2)', 'Used (1)', 'Refurbished (1)'])}
          <span class="row gap-2"><span class="small sub">Sort by</span>${U.seg([{ label: 'Total cost', href: go('store/offers', 'Total cost') }, { label: 'Fastest delivery', href: go('store/offers', 'Fastest delivery') }], fast ? 1 : 0)}</span>
        </div>
        <p class="small sub">4 offers delivering to Portland 97205. Totals include shipping; sales tax is added at checkout.</p>
        ${phone}${desk}
        <section class="card pad stack gap-3" aria-labelledby="of-rule">
          <h2 class="h4 row gap-2" id="of-rule">${icon('award')} How we choose the featured offer</h2>
          <ol class="ol small sub stack gap-1">
            <li><b>Eligible:</b> the seller is in good standing, with no open restriction and delivery performance that meets our standard.</li>
            <li><b>Available:</b> in stock and ships to your address.</li>
            <li><b>Delivery:</b> faster and more reliable arrival ranks higher.</li>
            <li><b>Total price:</b> item price plus shipping, after any discount you qualify for.</li>
          </ol>
          <p class="xs muted">Advertising does not affect the featured offer. Used and refurbished offers compete only when you filter for that condition. Example rule; the published version is in <a href="${go('info/policy', 'Seller rules')}">Seller rules</a>. Once an item is in your cart, its seller never changes without your choice.</p>
        </section>
      </div>`;
      return U.storeLayout(content, { nav: 'categories', appbar: { title: 'All offers (4)', back: go('store/product') } });
    },
  });

  /* ==================== 7. Brand page ==================== */
  U.register({
    id: 'store/brand', title: 'Brand page', ref: 'Plan ch. 3–4',
    notes: 'Halden brand collection: header, description, curated collections, category chips, sort and every Halden product with its seller named. Brand pages list offers from all sellers, not only the brand owner.',
    render: () => {
      const b = D.brands[0];
      const content = `<div class="container page" style="gap:var(--sp-6)">
        ${crumb([HOME, { label: 'Brands', href: go('store/brand') }, 'Halden'])}
        <section class="shop-hero" aria-labelledby="br-h">
          <div class="ban" style="--tint:var(--img-2)" aria-hidden="true">${icon('headphones')}${icon('speaker')}${icon('ear')}</div>
          <div class="id">
            ${U.logoTile(b, 'lg')}
            <div class="stack gap-1 grow"><h1 class="display d-lg" id="br-h">Halden</h1><span class="small sub">Brand collection · ${b.products} products · Headphones, earbuds and speakers</span></div>
          </div>
          <div style="padding:0 var(--sp-5) var(--sp-5)" class="stack gap-2">
            <p class="sub" style="max-width:72ch">Halden makes noise-cancelling headphones and compact speakers for travel and small homes. Products here come from the Official Store and from approved sellers. Each card names the seller, and the product page compares all offers.</p>
          </div>
        </section>
        <section class="stack gap-3" aria-labelledby="br-col"><h2 class="h3" id="br-col">Collections</h2>
          <div class="shop-collections">${[['Aurora noise cancelling', '6 products', 'aurora'], ['Pocket speakers', '9 products', 'speaker'], ['Travel accessories', '8 products', 'hcase']].map(([t, n, id]) => `<a class="shop-coll" href="${go('store/collection', 'Best sellers')}">${U.pimg(PP[id])}<span class="stack gap-1"><span class="strong">${t}</span><span class="xs muted">${n}</span></span></a>`).join('')}</div></section>
        <section class="stack gap-4" aria-labelledby="br-all">
          <h2 class="h3" id="br-all">All Halden products</h2>
          ${U.chips([{ label: 'All (48)', active: true }, 'Headphones (21)', 'Earbuds (9)', 'Speakers (14)', 'Accessories (4)'])}
          <div class="shop-toolbar"><span class="small sub">Showing 1–8 of 48</span>${sortSel('br-sort')}</div>
          <div class="grid-products">${cards(['aurora', 'buds', 'aria', 'studio', 'speaker', 'mini', 'open', 'hcase'])}</div>
          <div class="row end">${U.pager(1, 6, { grid: true })}</div>
        </section>
      </div>`;
      return U.storeLayout(content, { nav: 'brands', appbar: { title: 'Halden', back: go('store/home') } });
    },
  });

  /* ==================== 8. Seller storefront ==================== */
  U.register({
    id: 'store/seller', title: 'Seller storefront', ref: 'Plan ch. 10, 17',
    notes: 'Northwind Audio’s store: identity, verification label that explains what was checked (and that product authenticity is not), rating, location, shipping coverage, dispatch time, return summary and contact. Seller feedback is shown here, separate from product reviews.',
    render: () => {
      const s = S.northwind;
      const fb = [
        { n: 'Sam R.', d: 'Oct 5, 2026', r: 'Positive', t: 'Shipped the next morning and arrived in two days. Very well packed.', item: 'Halden Pocket Bluetooth Speaker' },
        { n: 'Chris T.', d: 'Oct 1, 2026', r: 'Positive', t: 'Answered my question about the warranty within an hour.', item: 'Halden Aurora ANC Wireless Headphones' },
        { n: 'Alex M.', d: 'Sep 24, 2026', r: 'Negative', t: 'Package left Portland a day later than promised.', item: 'Halden Aria True Wireless Earbuds', reply: 'We missed our dispatch time on Sep 22 because of a carrier pickup problem. We refunded your shipping cost. Sorry for the wait.' },
      ];
      const main = `<div class="stack gap-6" style="min-width:0">
        ${U.tabs([{ label: 'Products', count: 86 }, { label: 'Feedback', count: '4,812' }, { label: 'About and policies' }], 0)}
        <div class="shop-promo">${icon('ticket-percent')}<div class="stack gap-0 grow"><span class="strong">10% off orders over $100 from Northwind Audio</span><span class="xs sub">Oct 1–31, 2026. Applied automatically at checkout to Northwind Audio items. Funded by the seller.</span></div>${btn('Shop eligible items', { v: 'secondary', size: 'sm' })}</div>
        <section class="stack gap-4" aria-labelledby="sl-feat">${U.sectionHead('<span id="sl-feat">Featured collection: Travel-ready audio</span>', { link: 'See 12 items', href: 'javascript:void 0' })}
          <div class="grid-products">${cards(['aria', 'speaker', 'q1', 'cable'], { seller: false })}</div></section>
        <section class="stack gap-4" aria-labelledby="sl-all">
          <h2 class="h3" id="sl-all">All products (86)</h2>
          ${U.chips([{ label: 'All', active: true }, 'Headphones (31)', 'Earbuds (22)', 'Speakers (19)', 'Cables and accessories (14)'])}
          <div class="shop-toolbar">${U.searchIn('Search this store', 'sl-q')}${sortSel('sl-sort')}</div>
          <div class="grid-products">${cards(['aurora', 'mini', 'open', 'aria', 'speaker', 'q1', 'cable', 'wave'].map((id) => id), { seller: false })}</div>
          <div class="row end">${U.pager(1, 8, { grid: true })}</div>
        </section>
        <section class="card" aria-labelledby="sl-fb">
          <div class="card-head"><div class="stack gap-0"><h2 class="h3" id="sl-fb">Seller feedback</h2><span class="xs muted">About shipping, packaging and communication. Product reviews are on each product page.</span></div><a class="small strong" href="javascript:void 0">See all 4,812</a></div>
          <div class="card-body">
            <div class="grid md3" style="--gap:var(--sp-4)">
              ${U.stat('Positive, last 12 months', '98%', { note: '4,812 ratings' })}
              ${U.stat('On-time dispatch', '97%', { note: 'Last 90 days' })}
              ${U.stat('Replies within 24 h', '94%', { note: 'Median 3 h' })}
            </div>
            <ul class="list">${fb.map((f) => `<li style="align-items:flex-start"><div class="stack gap-1 grow">
              <div class="row gap-2">${badge(f.r, f.r === 'Positive' ? 'success' : 'danger', f.r === 'Positive' ? 'thumbs-up' : 'thumbs-down')}<span class="xs muted">${f.n} · ${f.d} · Item: ${f.item}</span></div>
              <p class="small">${f.t}</p>
              ${f.reply ? `<div class="shop-reply"><span class="xs strong">Northwind Audio replied</span><span>${f.reply}</span></div>` : ''}
            </div></li>`).join('')}</ul>
          </div>
        </section>
      </div>`;
      const aside = `<aside class="stack gap-4">
        <section class="card" aria-labelledby="sl-ver">
          <div class="card-head"><h2 class="h4 row gap-2" id="sl-ver">${icon('shield-check')} What we verified</h2></div>
          <div class="card-body shop-verify">
            <p class="small sub">Verified seller means ${U.BRAND} checked these details before approving the store:</p>
            <ul>
              <li>${icon('circle-check')}<span>Business identity: Northwind Audio LLC, registered in Oregon</span></li>
              <li>${icon('circle-check')}<span>Payout bank account in the business’s name</span></li>
              <li>${icon('circle-check')}<span>US return address in Portland, OR</span></li>
              <li class="no">${icon('circle-minus')}<span><b>Not checked:</b> the authenticity of each product. If a listing looks wrong, <a href="${go('help/contact')}">report it</a>.</span></li>
            </ul>
            <span class="xs muted">Last checked Mar 12, 2026</span>
          </div>
        </section>
        <section class="card" aria-labelledby="sl-pol">
          <div class="card-head"><h2 class="h4" id="sl-pol">Shipping and returns</h2></div>
          <div class="card-body">${U.kv([
            ['Ships from', 'Portland, OR'],
            ['Ships to', 'Contiguous US (48 states). No P.O. boxes.'],
            ['Dispatch', 'Within 1 business day. Orders by 2 PM PT ship same day.'],
            ['Carriers', 'USPS, UPS'],
            ['Returns', '30 days. You pay return shipping unless the item is faulty or not as described.'],
            ['Warranty', 'Manufacturer warranty honored'],
            ['Replies', 'Usually within 6 hours, Mon–Sat'],
          ])}<a class="small strong" href="javascript:void 0">Full store policies</a></div>
        </section>
        <p class="xs muted">${U.BRAND} support steps in if a seller doesn’t resolve a problem. <a href="${go('help/center')}">How buyer protection works</a></p>
      </aside>`;
      const content = `<div class="container page" style="gap:var(--sp-6)">
        <section class="shop-hero" aria-labelledby="sl-h">
          <div class="ban" style="--tint:var(--img-2)"><span class="shop-ban-t">Sound for small apartments and long commutes</span><span class="no-phone">${icon('headphones')}${icon('speaker')}</span></div>
          <div class="id">
            ${U.logoTile(s, 'lg')}
            <div class="stack gap-1 grow" style="min-width:200px">
              <div class="row gap-2"><h1 class="h1" id="sl-h">${esc(s.name)}</h1>${U.sellerBadge(s)}</div>
              <div class="row gap-3 small sub"><span>${U.stars(4.8)} <b>${s.positive}% positive</b> (${num(s.ratings)} ratings)</span><span>${icon('map-pin', 'ic-sm')} ${s.location}</span><span>${icon('clock', 'ic-sm')} Ships in ${s.dispatch}</span><span>Selling on ${U.BRAND} since Mar 2026</span></div>
            </div>
            <div class="row gap-2">${btn('Contact seller', { v: 'secondary', icon: 'message-square', href: go('account/messages') })}${U.iconBtn('share-2', 'Share store')}</div>
          </div>
          <p class="small sub" style="padding:0 var(--sp-5) var(--sp-5);max-width:80ch">Independent audio shop in Portland since 2019. We test every returned unit before reselling it as used, and we answer warranty questions for everything we sell.</p>
        </section>
        <div class="split">${main}${aside}</div>
      </div>`;
      return U.storeLayout(content, { appbar: { title: s.name, back: go('store/product'), actions: U.iconBtn('search', 'Search this store') } });
    },
  });

  /* ==================== 9. Official Store ==================== */
  U.register({
    id: 'store/official', title: 'Official Store', ref: 'Plan ch. 3, 9',
    notes: 'Marketly’s own store: hero, service promises (free delivery threshold, free returns, electronics warranty, ship-from location), featured collections, category shortcuts and a grid of company offers at the prices shown.',
    render: () => {
      const content = `<div class="container page" style="gap:var(--sp-7)">
        <section class="shop-off-hero" aria-labelledby="of-h">
          <div class="stack gap-3">
            <span class="row gap-2">${badge('Official Store', 'solid', 'badge-check')}</span>
            <h1 class="display d-xl" id="of-h" style="color:var(--on-brand)">Sold and shipped by ${U.BRAND}</h1>
            <p style="opacity:.9;max-width:44ch">Our own stock, bought from brands and their authorized distributors, packed in our Reno, NV warehouse. We handle delivery, returns and warranty claims ourselves.</p>
            <div class="row gap-2"><a class="btn btn-lg" style="background:var(--on-brand);color:var(--brand-text)!important" href="javascript:void 0">Shop all Official Store items</a></div>
          </div>
          <div class="art" aria-hidden="true">${U.pimg(P.aurora)}${U.pimg(P.skillet)}${U.pimg(P.sweater)}</div>
        </section>
        <section class="shop-promises" aria-label="Official Store promises">
          <div>${icon('truck')}<span class="stack gap-1"><span class="small strong">Free delivery over $35</span><span class="xs muted">On Official Store items. $5.99 below that.</span></span></div>
          <div>${icon('undo-2')}<span class="stack gap-1"><span class="small strong">30-day free returns</span><span class="xs muted">Prepaid label or drop-off at any UPS store.</span></span></div>
          <div>${icon('shield-check')}<span class="stack gap-1"><span class="small strong">2-year warranty on electronics</span><span class="xs muted">We handle the claim with the brand.</span></span></div>
          <div>${icon('warehouse')}<span class="stack gap-1"><span class="small strong">Ships from Reno, NV</span><span class="xs muted">Same or next business day dispatch.</span></span></div>
        </section>
        <section class="stack gap-3" aria-labelledby="of-col"><h2 class="h2" id="of-col">Featured collections</h2>
          <div class="shop-collections">${[['Home Week picks', 'Up to 30% off until Oct 19', 'duvet', go('store/collection', 'Seasonal')], ['Travel audio', '14 products', 'aurora', go('store/collection', 'Best sellers')], ['Kitchen basics', '22 products', 'skillet', go('store/collection', 'New arrivals')]].map(([t, n, id, h]) => `<a class="shop-coll" href="${h}">${U.pimg(PP[id])}<span class="stack gap-1"><span class="strong">${t}</span><span class="xs muted">${n}</span></span></a>`).join('')}</div></section>
        <section class="stack gap-4" aria-labelledby="of-cat"><h2 class="h2" id="of-cat">Shop the Official Store by category</h2>
          <div class="shop-shortcuts">${D.categories.map((c) => `<a href="${go('store/category')}">${U.img(c.icon, c.tint)}<span>${esc(c.name)}</span></a>`).join('')}</div></section>
        <section class="stack gap-4" id="of-all" aria-labelledby="of-grid">
          <h2 class="h2" id="of-grid">All Official Store items</h2>
          <div class="shop-toolbar"><span class="small sub">1,960 items · prices shown are Official Store offers. Other sellers may list the same product.</span>${sortSel('of-sort')}</div>
          <div class="grid-products wide">${cards(['aurora', 'skillet', 'sweater', 'pourover', 'lamp', 'serum', 'studio', 'buds', 'kids', 'dutch'], { seller: false })}</div>
          <div class="row end">${U.pager(1, 82, { grid: true })}</div>
        </section>
      </div>`;
      return U.storeLayout(content, { nav: 'official', appbar: { title: 'Official Store', back: go('store/home') } });
    },
  });

  /* ==================== 10. Deals ==================== */
  U.register({
    id: 'store/deals', title: 'Deals', ref: 'Plan ch. 15',
    notes: 'Deals hub with a real-time flash sale (start and end times, countdown, claimed meter, purchase limit, sold-out deal that shows the regular offer separately), clippable coupons with eligibility and expiry, clearance and scheduled events.',
    render: () => {
      const flash = [
        { id: 'kestrel27', deal: 279, reg: 329, c: 41, lim: 1 },
        { id: 'speaker', deal: 49, reg: 79, c: 72, lim: 2 },
        { id: 'duvet', deal: 99, reg: 149, c: 58, lim: 2 },
        { id: 'skillet', deal: 49, reg: 72, c: 86, lim: 2 },
      ];
      const coupons = [
        { amt: '$10', sub: 'off', t: '$10 off Kestrel storage', e: 'Pixel & Port items over $75 · New customers and returning', x: 'Expires Oct 31, 2026', fund: 'Pixel & Port' },
        { amt: '15%', sub: 'off', t: '15% off Mosswood bedding', e: 'Casa Verde Home · minimum spend $100 · one use per customer', x: 'Expires Oct 19, 2026', fund: 'Casa Verde Home' },
        { amt: 'Free', sub: 'shipping', t: 'Free shipping from Trailhead', e: 'Trailhead Outfitters orders over $50', x: 'Expires Nov 15, 2026', fund: 'Trailhead Outfitters', clipped: true },
        { amt: '$5', sub: 'off', t: '$5 off your first Official Store order', e: 'Official Store items over $25 · first Official Store order only', x: 'Expires Dec 31, 2026', fund: U.BRAND },
      ];
      const content = `<div class="container page" style="gap:var(--sp-6)">
        <div class="stack gap-2"><h1 class="h1">Deals</h1><p class="small sub">Every deal names the seller whose offer it applies to. A deal price is valid only for that offer, until the end time or until deal stock runs out.</p></div>
        ${U.tabs([{ label: 'All deals', count: 148 }, { label: 'Flash sales', count: 5 }, { label: 'Clearance', count: 36 }, { label: 'Coupons', count: 12 }, { label: 'Upcoming events', count: 3 }], 0)}
        <section class="shop-flash" aria-labelledby="dl-flash">
          <div class="row between">
            <div class="stack gap-1"><h2 class="h2 row gap-2" id="dl-flash" style="color:var(--deal-text)">${icon('zap')} Flash sale</h2><span class="small sub">Today, Oct 8, 6:00 AM – 11:59 PM PT</span></div>
            <span class="row gap-2 small sub">Ends in ${U.countdown('05', '42', '18')}</span>
          </div>
          <div class="shop-dgrid">
            ${flash.map((f) => { const p = PP[f.id]; return `<article class="shop-dcard">
              <a href="${go('store/product')}" aria-label="${esc(p.name)}">${U.pimg(p)}</a>
              <div class="tagrow">${badge(`−${Math.round((1 - f.deal / f.reg) * 100)}%`, 'deal')}</div>
              ${U.price(f.deal, f.reg, { noOff: true })}
              <a class="small clamp-2" style="color:var(--text)" href="${go('store/product')}">${esc(p.name)}</a>
              <span class="xs muted">${esc(S[p.seller].name)} · Limit ${f.lim} per customer</span>
              <div class="stack gap-1">${U.meter(f.c, 'deal')}<span class="xs muted">${f.c}% claimed</span></div>
            </article>`; }).join('')}
            <article class="shop-dcard is-out">
              <a href="${go('store/product')}" aria-label="${esc(P.ssd1tb.name)}">${U.pimg(P.ssd1tb)}</a>
              <div class="tagrow">${badge('Deal sold out', 'solid')}</div>
              <span class="row gap-2 base"><span class="price"><span class="now" style="color:var(--text-3);text-decoration:line-through">${money(79.99)}</span></span><span class="xs muted">deal price</span></span>
              <a class="small clamp-2" style="color:var(--text)" href="${go('store/product')}">${esc(P.ssd1tb.name)}</a>
              <div class="stack gap-1">${U.meter(100, 'deal')}<span class="xs muted">100% claimed at 2:14 PM</span></div>
              <div class="regular"><span class="xs strong">Regular offer still available</span>${U.price(P.ssd1tb.price, P.ssd1tb.was, { noOff: true })}<span class="xs muted">${esc(S.pixelport.name)} · not part of the flash sale</span>${btn('View regular offer', { v: 'secondary', size: 'sm', href: go('store/product') })}</div>
            </article>
          </div>
        </section>
        <section class="stack gap-4" aria-labelledby="dl-cp">
          ${U.sectionHead('<span id="dl-cp">Coupons</span>', { link: 'My coupons', href: go('account/coupons') })}
          <div class="shop-coupons">${coupons.map((c) => `<article class="shop-coupon">
            <div class="amt">${c.amt}<span>${c.sub}</span></div>
            <div class="body">
              <span class="strong">${esc(c.t)}</span>
              <span class="xs sub">${esc(c.e)}</span>
              <span class="xs muted">${c.x} · Funded by ${esc(c.fund)}</span>
              <div class="row gap-2">${c.clipped ? `${badge('Clipped', 'success', 'check')}<span class="xs muted">Applies automatically at checkout</span>` : btn('Clip coupon', { v: 'soft', size: 'sm', icon: 'scissors' })}<a class="xs" href="javascript:void 0">Eligible items</a></div>
            </div></article>`).join('')}</div>
          <p class="xs muted">Coupons can’t be combined with flash sale prices unless the coupon says so. One coupon per seller per order.</p>
        </section>
        <section class="stack gap-4" aria-labelledby="dl-cl">
          ${U.sectionHead('<span id="dl-cl">Clearance</span>', { link: 'See all 36', href: 'javascript:void 0' })}
          <p class="small sub" style="margin-top:calc(-1 * var(--sp-2))">Clearance prices last while the listed seller’s current stock lasts. Normal return terms apply.</p>
          <div class="grid-products wide">${cards(['backpack', 'serum', 'buds', 'run', 'aria'])}</div>
        </section>
        <section class="card" aria-labelledby="dl-up">
          <div class="card-head"><h2 class="h3" id="dl-up">Upcoming events</h2><span class="xs muted">Times in Pacific Time</span></div>
          <ul class="list pad">${[['Oct', '20', 'Home Week, part 2: Kitchen', 'Oct 20, 6:00 AM – Oct 26, 11:59 PM PT · Cookware and coffee from the Official Store and Casa Verde'], ['Oct', '27', 'Outdoor gear clearance', 'Oct 27, 6:00 AM – Nov 2, 11:59 PM PT · Trailhead Outfitters end-of-season stock'], ['Nov', '23', 'Black Friday week', 'Nov 23, 12:00 AM – Nov 30, 11:59 PM PT · Daily flash sales across all categories']].map(([m, d, t, s]) => `<li><div class="shop-event grow"><span class="shop-date"><span class="m">${m}</span><span class="d">${d}</span></span><span class="stack gap-0 grow" style="min-width:200px"><span class="strong">${t}</span><span class="xs muted">${s}</span></span>${btn('Remind me', { v: 'secondary', size: 'sm', icon: 'bell' })}</div></li>`).join('')}</ul>
        </section>
      </div>`;
      return U.storeLayout(content, { tab: 'deals', nav: 'deals' });
    },
  });

  /* ==================== 11. Collections ==================== */
  function newArrivals() {
    const groups = [['Added Oct 6', ['lamp', 'yogamat', 'buds', 'string']], ['Added Oct 2', ['serum', 'keyboard', 'studio', 'kettle']], ['Added Sep 28', ['sweater', 'pourover', 'kids', 'open']]];
    return `<div class="stack gap-2"><h1 class="h1">New arrivals</h1><p class="small sub">Products first listed on ${U.BRAND} in the last 30 days, newest first. Updated daily.</p></div>
      ${U.chips([{ label: 'All', active: true }, 'Electronics', 'Home & Kitchen', 'Fashion', 'Sports & Outdoors', 'Beauty'])}
      ${groups.map(([d, ids]) => `<section class="stack gap-3" aria-label="${d}"><h2 class="h3 row gap-2">${icon('calendar-plus')} ${d}</h2><div class="grid-products">${cards(ids)}</div></section>`).join('')}
      <div class="row end">${U.pager(1, 4, { grid: true })}</div>`;
  }
  function bestSellers() {
    const ids = ['skillet', 'aurora', 'bottle', 'ssd1tb', 'duvet', 'speaker', 'serum', 'keyboard', 'buds', 'backpack'];
    return `<div class="stack gap-2"><h1 class="h1">Best sellers</h1><p class="small sub">Ranked by units sold in the last 30 days across all sellers. Updated every hour. Sponsored placements don’t affect rank.</p></div>
      ${U.tabs(['All categories', 'Electronics', 'Computers', 'Home & Kitchen', 'Fashion', 'Sports & Outdoors', 'Beauty'], 0)}
      <div class="grid-products wide">${ids.map((id, i) => `<div class="stack gap-2"><span class="shop-rank"><span class="n${i < 3 ? ' top' : ''}">#${i + 1}</span><span class="xs muted">${i < 3 ? 'Top 3 this month' : PP[id].sub || ''}</span></span>${U.productCard(PP[id], { showSeller: true, from: true })}</div>`).join('')}</div>
      <p class="xs muted">Last updated Oct 8, 2026, 6:00 PM PT</p>`;
  }
  function seasonal() {
    const secs = [['Bedding', 'bed-double', ['duvet', 'sheets']], ['Lighting', 'lamp', ['lamp', 'floorlamp', 'string']], ['Cookware and coffee', 'cooking-pot', ['skillet', 'dutch', 'kettle', 'pourover']]];
    return `<section class="shop-season" aria-labelledby="hw-h">
        <div class="copy">
          <span class="eyebrow" style="color:var(--on-brand);opacity:.85">Seasonal campaign</span>
          <h1 class="display d-xl" id="hw-h" style="color:var(--on-brand)">Home Week</h1>
          <p style="opacity:.92;max-width:42ch">Up to 30% off bedding, lighting and cookware from the Official Store, Casa Verde Home and other approved sellers.</p>
          <div class="meta"><span>${icon('calendar', 'ic-sm')} Oct 6 – Oct 19, 2026</span><span>${icon('clock', 'ic-sm')} Ends in 11 days</span></div>
        </div>
        <div class="art" aria-hidden="true">${U.pimg(P.duvet)}${U.pimg(P.lamp)}${U.pimg(P.skillet)}${U.pimg(X.kettle)}</div>
      </section>
      ${U.chips(secs.map(([t, ic]) => ({ label: t, icon: ic, href: 'javascript:void 0' })))}
      ${secs.map(([t, ic, ids]) => `<section class="stack gap-4" aria-label="${t}">${U.sectionHead(`<span class="row gap-2">${icon(ic)}${t}</span>`, { link: 'See all', href: go('store/category') })}<div class="grid-products">${cards(ids)}</div></section>`).join('')}
      <section class="card pad stack gap-2" aria-labelledby="hw-terms">
        <h2 class="h4" id="hw-terms">Home Week terms</h2>
        <ul class="ul small sub stack gap-1">
          <li>Offers end Oct 19, 11:59 PM PT, or earlier if the listed seller’s deal stock runs out.</li>
          <li>Deal prices apply only to the seller named on each product. Other sellers of the same product may charge a different price.</li>
          <li>Purchase limits are shown on each product page. Home Week prices can’t be combined with other coupons unless stated.</li>
          <li>Was prices are each seller’s lowest price in the 30 days before Oct 6.</li>
        </ul>
      </section>`;
  }
  // Curated collection: every item shows current availability
  const STOCK = { kestrel27: 18, ssd1tb: 64, cable: 27, lamp: 9, string: 112, floorlamp: 14, keyboard: 35, aurora: 142, studio: 23, pourover: 58, kettle: 19, bottle: 220 };
  const availCard = (id) => {
    const n = STOCK[id];
    const st = n < 10 ? 'Low stock' : 'In stock';
    return `<div class="stack gap-2">${U.productCard(PP[id], { showSeller: true, from: true })}<span class="row gap-2">${U.status(st)}<span class="xs muted">${n} available · checked 6:00 PM PT</span></span></div>`;
  };
  function curated() {
    const secs = [
      ['One screen, fewer cables', 'monitor', 'A single USB-C cable from this monitor charges a laptop and carries the picture, so the desk only needs one cord. Add the SSD for backups that fit in a drawer.', ['kestrel27', 'ssd1tb', 'cable']],
      ['Light that doesn’t take up desk space', 'lamp-desk', 'We picked lamps with small bases or none at all. The Brightline desk lamp also charges your phone, which frees up another outlet.', ['lamp', 'string', 'floorlamp']],
      ['Type and listen quietly', 'keyboard', 'A compact 75% keyboard leaves room for a notebook. Closed-back headphones keep calls private in a shared room.', ['keyboard', 'aurora', 'studio']],
      ['Coffee within reach', 'coffee', 'Small-footprint brewing for a desk or a side shelf, plus a bottle that won’t sweat onto your papers.', ['pourover', 'kettle', 'bottle']],
    ];
    return `<section class="stack gap-3" aria-labelledby="cc-h" style="max-width:80ch">
        <span class="eyebrow">Curated collection</span>
        <h1 class="display d-xl" id="cc-h">Desk setup for small spaces</h1>
        <p class="lead">Twelve pieces for a desk in a studio apartment or a shared room: fewer cables, smaller footprints and light that doesn’t need a second outlet.</p>
        <div class="row gap-3">${U.avatar('Noor Aziz')}<span class="stack gap-0"><span class="small strong">Curated by Noor Aziz, ${U.BRAND} editors</span><span class="xs muted">Updated Oct 7, 2026 · 4 sections · 12 products</span></span></div>
      </section>
      ${U.alert('info', 'Only in-stock offers are included', 'We check availability every hour. If an item sells out, we replace it or remove it from this page. No seller paid to be included; items come from the Official Store and approved sellers, and each card names the seller.')}
      ${U.chips(secs.map(([t, ic]) => ({ label: t, icon: ic, href: 'javascript:void 0' })))}
      ${secs.map(([t, ic, note, ids], i) => `<section class="stack gap-4" aria-labelledby="cc-s${i}">
        <div class="stack gap-2"><h2 class="h2 row gap-2" id="cc-s${i}">${icon(ic)}${t}</h2>
          <p class="small sub" style="max-width:72ch"><b>Editor’s note:</b> ${note}</p></div>
        <div class="grid-products">${ids.map(availCard).join('')}</div>
      </section>`).join('')}
      <p class="xs muted">Prices and stock are live and can change before you check out. You’ll see the final total before paying.</p>`;
  }
  U.register({
    id: 'store/collection', title: 'Campaign and collection', ref: 'Plan ch. 3, 15', states: ['New arrivals', 'Best sellers', 'Seasonal', 'Curated collection'],
    notes: 'One collection template for curated pages: New arrivals grouped by date added, Best sellers ranked with a stated rule and category tabs, the Home Week seasonal campaign with its period, category sections and terms, and an editor-curated collection with notes and live availability on every item.',
    render: (state) => {
      const st = state || 'New arrivals';
      const body = st === 'Best sellers' ? bestSellers() : st === 'Seasonal' ? seasonal() : st === 'Curated collection' ? curated() : newArrivals();
      const label = st === 'Seasonal' ? 'Home Week' : st === 'Curated collection' ? 'Desk setup for small spaces' : st;
      return U.storeLayout(`<div class="container page" style="gap:var(--sp-6)">${crumb([HOME, st === 'Curated collection' ? { label: 'Collections', href: go('store/collection', 'Curated collection') } : null, label].filter(Boolean))}${body}</div>`, { nav: st === 'New arrivals' ? 'new' : st === 'Best sellers' ? 'best' : '', appbar: { title: st === 'Curated collection' ? 'Collection' : label, back: go('store/home') } });
    },
  });

  /* ==================== 12. Not found / error ==================== */
  U.register({
    id: 'store/not-found', title: 'Page not found and error', ref: 'Plan ch. 3', states: ['404', 'Something went wrong'],
    notes: 'A missing page and a temporary error keep the store header and footer, explain what happened, and give a search box and links to continue. The error state offers a retry and a live status note.',
    render: (state) => {
      const err = state === 'Something went wrong';
      const links = `<div class="shop-links">${[['house', 'Home', go('store/home')], ['tag', 'Deals', go('store/deals')], ['package', 'Track an order', go('account/orders')], ['life-buoy', 'Help Center', go('help/center')]].map(([ic, l, h]) => `<a href="${h}">${icon(ic)}${l}</a>`).join('')}</div>`;
      const search = `<form class="stack gap-2" role="search" onsubmit="return false">${U.field('Search the store', `<div class="row nowrap gap-2">${U.input('nf-q', '', { icon: 'search', placeholder: 'Products, brands and sellers' })}${btn('Search')}</div>`)}</form>`;
      const body = err
        ? `<div class="shop-err">
            <div class="stack gap-4">
              <span class="eyebrow">Temporary problem</span>
              <h1 class="h1">Something went wrong on our side</h1>
              <p class="sub">We couldn’t load this page. It’s not something you did. Your cart, orders and payments are safe.</p>
              <div class="row gap-2">${btn('Try again', { icon: 'refresh-cw' })}${btn('Go to home page', { v: 'secondary', href: go('store/home') })}</div>
              ${U.alert('warning', 'Service status: search and category pages are slow', 'Our team is working on it. Checkout and order tracking are working normally. Updated 6:12 PM PT.')}
              <span class="xs muted">Error reference <span class="mono">ERR-7F3A-2210</span>. Quote it if you contact support.</span>
            </div>
            <div class="art" aria-hidden="true">${icon('server-crash')}</div>
          </div>`
        : `<div class="shop-err">
            <div class="stack gap-4">
              <span class="big" aria-hidden="true">404</span>
              <h1 class="h1">We can’t find that page</h1>
              <p class="sub">The link may be out of date, or the page was moved. If you followed a link to a product, it may no longer be sold here.</p>
              ${search}
            </div>
            <div class="art" aria-hidden="true">${icon('map')}</div>
          </div>`;
      const content = `<div class="container page" style="gap:var(--sp-7)">
        ${body}
        ${err ? search : ''}
        <section class="stack gap-3" aria-labelledby="nf-links"><h2 class="h3" id="nf-links">Helpful links</h2>${links}</section>
        <section class="stack gap-3" aria-labelledby="nf-cats"><h2 class="h3" id="nf-cats">Popular categories</h2>${U.chips(D.categories.slice(0, 6).map((c) => ({ label: c.name, icon: c.icon, href: go('store/category') })))}</section>
      </div>`;
      return U.storeLayout(content, { tab: 'home' });
    },
  });

  /* ==================== 13. Opening full-screen ad ==================== */
  const homeBase = () => (U.screens['store/home'] ? U.screens['store/home'].render() : U.storeLayout(`<div class="container page"><section class="hero-banner"><div class="copy"><h1 class="display d-xl" style="color:var(--on-brand)">Home</h1></div></section><div class="grid-products wide">${cards(['aurora', 'skillet', 'duvet', 'lamp', 'speaker'])}</div></div>`, { tab: 'home' }));
  U.register({
    id: 'ads/opening', title: 'Opening full-screen ad', ref: 'Plan ch. 16, scenario 8', states: ['Platform campaign', 'Sponsored brand'],
    notes: 'Shown once per visit on entry pages. Full-bleed on phones, a large centered card on desktop, with a labeled Skip/Close button, an Ad or Sponsored label naming the advertiser, and one campaign link. Closing returns the visitor to the page they opened.',
    render: (state) => {
      const brand = state === 'Sponsored brand';
      const top = `<div class="top"><span class="shop-adtag">${brand ? 'Sponsored' : 'Ad'}${brand ? '' : ` · ${U.BRAND} campaign`}</span><a class="shop-skip" href="${go('store/home')}">${brand ? 'Close ad' : 'Skip'} ${icon('x', 'ic-sm')}</a></div>`;
      const ad = brand
        ? `<div class="ad" role="dialog" aria-modal="true" aria-label="Sponsored: Halden Aurora headphones">${top}
            <div class="art alt" aria-hidden="true">${U.img('headphones', 'var(--surface)', 'big')}${U.pimg(X.hcase)}${U.img('battery-charging', 'var(--surface)')}</div>
            <div class="copy">
              <span class="row gap-2">${U.logoTile(D.brands[0])}<span class="stack gap-0"><span class="strong">Halden Audio</span><span class="xs muted">Advertiser</span></span></span>
              <h2 class="display d-xl">Aurora ANC. Forty hours of quiet.</h2>
              <p class="sub">Hybrid noise cancelling, multipoint Bluetooth and a hard travel case in the box.</p>
              <div class="row gap-2 base">${U.price(189, 229, { lg: true })}</div>
              <span class="small sub">Sold and shipped by ${esc(S.official.name)} · Sale ends Oct 19, 11:59 PM PT</span>
              <div class="row gap-2">${btn('Shop Aurora', { size: 'lg', href: go('store/product'), iconR: 'arrow-right' })}${btn('Continue to home page', { v: 'ghost', href: go('store/home') })}</div>
              <span class="xs muted">Sponsored by Halden Audio. Shown once per visit.</span>
            </div></div>`
        : `<div class="ad" role="dialog" aria-modal="true" aria-label="Ad: Home Week campaign">${top}
            <div class="art" aria-hidden="true">${U.pimg(P.duvet, 'big')}${U.pimg(P.lamp)}${U.pimg(P.skillet)}</div>
            <div class="copy">
              <span class="eyebrow">Home Week · Oct 6–19</span>
              <h2 class="display d-xl">Up to 30% off bedding, lighting and cookware</h2>
              <p class="sub">Linen from Casa Verde Home, cast iron from the Official Store and smart lamps that charge your phone.</p>
              <div class="row gap-2">${btn('Shop Home Week', { size: 'lg', href: go('store/collection', 'Seasonal'), iconR: 'arrow-right' })}${btn('Continue to home page', { v: 'ghost', href: go('store/home') })}</div>
              <span class="xs muted">Offers end Oct 19, 11:59 PM PT. Shown once per visit.</span>
            </div></div>`;
      return homeBase() + `<div class="overlay shop-oa" role="presentation">${ad}</div>`;
    },
  });

  /* ==================== 14. Promotional pop-up ==================== */
  U.register({
    id: 'ads/popup', title: 'Promotional pop-up', ref: 'Plan ch. 15–16', states: ['Coupon', 'Announcement'],
    notes: 'Optional pop-ups after a defined trigger on browsing pages: a dismissible welcome coupon with a clear “No thanks”, and a non-blocking announcement panel. Pop-ups never appear in checkout, payment results, tracking or returns, and only one overlay shows at a time.',
    render: (state) => {
      const base = categoryPage('Default');
      if (state === 'Announcement') {
        return base + `<div class="overlay shop-clear" role="presentation"><aside class="shop-announce" role="dialog" aria-label="Announcement from ${U.BRAND}">
          <span class="x">${U.iconBtn('x', 'Dismiss announcement')}</span>
          <span class="row gap-2"><span class="shop-adtag">Announcement</span><span class="xs muted">from ${U.BRAND}</span></span>
          <div class="row gap-3 top nowrap">${U.img('store', 'var(--brand-soft)', 'thumb')}<div class="stack gap-1"><h2 class="h4">New: Official Store pickup in Portland</h2><p class="small sub">From Oct 20, pick up Official Store orders at 1120 NW Couch St. Free, usually ready in 2 hours. Choose “Pickup” at checkout.</p></div></div>
          <div class="row gap-2">${btn('See pickup details', { size: 'sm', href: go('info/policy', 'Shipping') })}${btn('Dismiss', { v: 'ghost', size: 'sm' })}</div>
          <span class="xs muted">You won’t see this again after you dismiss it.</span>
        </aside></div>`;
      }
      return base + `<div class="overlay" role="presentation"><div class="shop-pop" role="dialog" aria-modal="true" aria-labelledby="pop-h">
        <span class="x">${U.iconBtn('x', 'Close offer')}</span>
        <div class="band">${icon('ticket-percent')}<span class="eyebrow" style="color:var(--deal-text)">Welcome offer from ${U.BRAND}</span><h2 class="display d-lg" id="pop-h">$10 off your first order over $50</h2></div>
        <div class="body">
          <div class="shop-code"><span class="mono">HELLO10</span>${btn('Copy code', { v: 'secondary', size: 'sm', icon: 'copy' })}</div>
          <p class="xs sub">Enter the code at checkout. Valid on your first ${U.BRAND} order with items over $50 from any seller, before tax and shipping. Expires Oct 31, 2026. ${U.BRAND} pays for the discount, so sellers’ prices don’t change.</p>
          ${btn('Start shopping', { block: true, href: go('store/category') })}
          ${btn('No thanks', { v: 'ghost', block: true })}
          <span class="xs muted center">Shown once. We never show pop-ups during checkout.</span>
        </div>
      </div></div>`;
    },
  });

  /* ==================== 15. Ad formats ==================== */
  function formatsPage(annotate) {
    const sfeat = `<section class="shop-sfeat" aria-label="Sponsored store">
        <span class="ad-label">Sponsored</span>
        <div class="stack gap-3">
          <div class="row gap-3 nowrap">${U.logoTile(S.northwind, 'lg')}<div class="stack gap-1"><span class="row gap-2"><span class="h3">Northwind Audio</span>${U.sellerBadge(S.northwind, true)}</span><span class="xs muted">98% positive · Portland, OR · Ships in 1 business day</span></div></div>
          <p class="small sub">Tested, warrantied audio from an independent Portland shop. 10% off orders over $100 this month.</p>
          <div>${btn('Visit store', { v: 'secondary', size: 'sm', href: go('store/seller'), iconR: 'arrow-right' })}</div>
        </div>
        <div class="grid c2" style="--gap:var(--sp-3)">${['aria', 'speaker'].map((id) => `<a href="${go('store/product')}" class="stack gap-2" style="color:var(--text)">${U.pimg(PP[id], 'r43')}<span class="small clamp-2">${esc(PP[id].name)}</span>${U.price(PP[id].price, PP[id].was, { noOff: true })}</a>`).join('')}</div>
      </section>`;
    const video = `<div class="stack gap-2"><div class="shop-video" aria-label="Video ad: Kestrel Wave Pro">
        <span class="ad-label">Ad</span>
        <div class="bg" aria-hidden="true">${icon('headphones')}${icon('audio-lines')}</div>
        <button type="button" class="play" aria-label="Play video ad">${icon('play')}</button>
        <div class="ctl">${U.iconBtn('play', 'Play')}${U.meter(0)}<span class="xs strong">0:00 / 0:30</span>${U.iconBtn('volume-x', 'Unmute')}</div>
      </div><span class="xs muted">Kestrel Wave Pro · sponsored by Pixel &amp; Port · Starts muted and only plays when you press play.</span></div>`;
    const inter = `<div class="card pad row gap-3 nowrap">${U.img('panel-top-open', 'var(--img-6)', 'thumb')}<div class="stack gap-1"><span class="small strong">Interstitial</span><span class="xs sub">Appears between selected browsing steps (for example category to product), with a Skip button. Never shown in checkout, payment results, tracking or returns.</span><a class="xs strong" href="${go('ads/formats', 'Interstitial')}">Preview interstitial</a></div></div>`;
    const sticky = `<div class="shop-sticky">${ann(annotate, 'Floating / sticky ad', `<div class="strip" role="complementary" aria-label="Advertisement">${U.pimg(P.aurora)}<div class="stack gap-0 grow" style="min-width:0"><span class="row gap-2"><span class="shop-adtag">Ad</span><span class="small strong truncate">Halden Aurora, ${money(189)} at the Official Store</span></span><span class="xs muted truncate">Sale ends Oct 19 · Advertiser: Halden Audio</span></div>${btn('Shop', { size: 'sm', href: go('store/product') })}${U.iconBtn('x', 'Close ad')}</div>`)}</div>`;
    const content = `<div class="container page" style="gap:var(--sp-6)">
      ${annotate ? `<section class="card pad stack gap-3" aria-labelledby="af-h"><div class="row between"><h1 class="h3" id="af-h">Ad placements on a category page</h1>${badge('Prototype annotation', 'info', 'tag')}</div>
        <div class="shop-legend">
          <div>${icon('image')}<span><b>Banner ad</b>: launch. Home, category and campaign pages.</span></div>
          <div>${icon('store')}<span><b>Sponsored store or brand</b>: home and discovery pages.</span></div>
          <div>${icon('layout-grid')}<span><b>Sponsored product</b>: search, categories, related products.</span></div>
          <div>${icon('panel-bottom')}<span><b>Floating / sticky ad</b>: dismissible strip, selected pages.</span></div>
          <div>${icon('panel-top-open')}<span><b>Interstitial</b>: between browsing steps, never in checkout.</span></div>
          <div>${icon('video')}<span><b>Video ad</b>: later phase, play and mute controls.</span></div>
          <div>${icon('maximize')}<span><b>Opening full-screen</b>: see Opening full-screen ad.</span></div>
          <div>${icon('message-square')}<span><b>Pop-up</b>: see Promotional pop-up.</span></div>
        </div>
        <p class="xs muted">Every paid placement carries an Ad or Sponsored label and names the advertiser or seller. Only one overlay shows at a time.</p></section>` : ''}
      <div class="stack gap-2">${crumb([HOME, { label: 'Electronics', href: go('store/categories') }, 'Headphones'])}<h1 class="h1">Headphones</h1><p class="small muted">128 results</p></div>
      ${ann(annotate, 'Banner ad', bannerAd())}
      ${ann(annotate, 'Sponsored store feature', sfeat)}
      <div class="shop-toolbar"><span class="small sub">Showing 1–8 of 128</span>${sortSel('af-sort')}</div>
      ${ann(annotate, 'Sponsored product cards', `<div class="grid-products">${cards(['q3', 'buds'], { sp: [0, 1] })}${cards(['aurora', 'wave'])}</div>`)}
      <div class="grid-products">${cards(['aria', 'studio', 'wavepro', 'q1'])}</div>
      <div class="grid md2" style="--gap:var(--sp-6)">
        ${ann(annotate, 'Video ad · later phase', video)}
        ${annotate ? ann(true, 'Interstitial', inter) : `<div class="stack gap-3"><h2 class="h3">Popular in Headphones</h2><div class="grid c2">${cards(['open', 'kids'])}</div></div>`}
      </div>
      <div class="grid-products">${cards(['run', 'neck', 'kids', 'open'])}</div>
    </div>${sticky}`;
    return U.storeLayout(content, { nav: 'categories', appbar: { title: 'Headphones', back: go('store/categories') } });
  }
  U.register({
    id: 'ads/formats', title: 'Ad placements', ref: 'Plan ch. 16', states: ['All placements', 'Sticky ad', 'Interstitial'],
    notes: 'Every launch and later ad format on a realistic category page: banner, sponsored store feature, sponsored product cards, video ad with play and mute (later), a dismissible sticky strip and an interstitial between browsing steps that never appears in checkout.',
    render: (state) => {
      if (state === 'Sticky ad') {
        return formatsPage(false).replace('<div class="shop-sticky">', `<div class="shop-sticky"><p class="xs muted center" style="margin-bottom:var(--sp-2)"><span class="shop-adtag" style="white-space:normal;text-align:left">${icon('info', 'ic-sm')}Sticky ad stays visible while browsing. Closing it hides it for the rest of the visit.</span></p>`);
      }
      if (state === 'Interstitial') {
        return formatsPage(false) + `<div class="overlay" role="presentation"><div class="shop-inter" role="dialog" aria-modal="true" aria-labelledby="int-h">
          <div class="art"><span class="ad-label">Ad</span>${U.pimg(P.kestrel27)}</div>
          <div class="modal-body">
            <span class="row gap-2"><span class="shop-adtag">Sponsored</span><span class="xs muted">by Pixel &amp; Port</span></span>
            <h2 class="h2" id="int-h">${esc(P.kestrel27.name)}</h2>
            <div class="row gap-2 base">${U.price(P.kestrel27.price)}<span class="xs muted">Free delivery Fri, Oct 16 · Sold by Pixel &amp; Port</span></div>
            <div class="row gap-2">${btn('View offer', { href: go('store/product') })}<a class="shop-skip" href="${go('store/product')}">Skip ad ${icon('arrow-right', 'ic-sm')}</a></div>
            <span class="xs muted">You’re on your way to Halden Aurora. Shown at most once per visit, between category and product pages. Never shown in checkout, payment results, tracking or returns.</span>
          </div>
        </div></div>`;
      }
      return formatsPage(true);
    },
  });
})();
