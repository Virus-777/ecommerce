import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { Logo } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Avatar, Badge, Count, Icon, IconButton, LogoMark, LogoTile, Price, ShipLine, Sponsored } from '@marketly/web-shared/ui';
import { HomeAdCarousel } from '@/api/ads';
import { AD_CAROUSEL_DEMO, APP_VS_WEB, OFFERS, SELLER_NAV_DEMO, STORE_NAV_DEMO, TABBAR_DEMO } from './data/patterns';

// Design: pages/theme/theme-patterns.html (design-system reference page, no store chrome).
// The design's only <h1> sat inside the back-office preview ("Orders"); the page gets its own
// header + h1 (same look as the Components page) and the preview title is plain text.

const noSubmit = (e: FormEvent) => e.preventDefault();

export default function Patterns() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="container th-page">
        <header className="stack gap-3" id="main" tabIndex={-1}>
          <span className="eyebrow">Marketly design system · v0.1</span>
          <h1 className="display d-xl">Patterns and layouts</h1>
          <p className="lead mw-70ch">How seller identity, advertising labels and the app and website layouts appear on every screen.</p>
        </header>

        <section className="th-sec">
          <header>
            <h2 className="h2">Seller identity on every offer</h2>
            <p className="small sub measure-lg">Product = the item. Offer = how one seller sells it. Every offer line names the seller, who ships it, the delivery date and the return terms.</p>
          </header>
          <div className="grid md2 gap-4">
            {OFFERS.map((o) => (
              <div key={o.seller} className="card pad stack gap-2">
                <div className="row between">
                  <Price amount={o.price} />
                  <span className="xs muted">{o.shipping}</span>
                </div>
                <div className="row gap-2">
                  <span className="small">
                    Sold by <b>{o.seller}</b>
                  </span>
                  <Badge tone={o.badge.tone} icon={o.badge.icon}>
                    {o.badge.label}
                  </Badge>
                </div>
                {o.lines.map((l) => (
                  <ShipLine key={l.text + (l.strong ?? '')} icon={l.icon}>
                    {l.text}
                    {l.strong && <b>{l.strong}</b>}
                    {l.after}
                  </ShipLine>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="th-sec">
          <header>
            <h2 className="h2">Advertising labels</h2>
            <p className="small sub measure-lg">Paid placements carry “Sponsored” or “Ad”. Ads never cover checkout, payment results, tracking or returns.</p>
          </header>
          <div className="row gap-4">
            <Sponsored />
            <Badge tone="outline">Ad</Badge>
            <Badge tone="brand" icon="badge-check">
              Official Store
            </Badge>
          </div>
          <div className="stack gap-2">
            <h3 className="h4">Home banner carousel</h3>
            <p className="small sub measure-lg">Every live ad at the top of the home screen, 6 s each. Swipe on the phone; dots, arrows and pause on wider screens. It pauses on hover and focus. Example creatives below.</p>
            <HomeAdCarousel ads={AD_CAROUSEL_DEMO} seconds={6} />
          </div>
        </section>

        <section className="th-sec">
          <header>
            <h2 className="h2">Android app vs website</h2>
            <p className="small sub measure-lg">The phone layout is the Android app, not a shrunken website. Navigation comes from the app shell, never from page links at the bottom of a page.</p>
          </header>
          <div className="grid md2 gap-4">
            {APP_VS_WEB.map((c) => (
              <div key={c.title} className="card pad stack gap-2">
                <span className="row gap-2">
                  <Icon name={c.icon} />
                  <span className="h4">{c.title}</span>
                </span>
                <ul className="ul small sub stack gap-1">
                  {c.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className="th-sec">
          <header>
            <h2 className="h2">Layout shells</h2>
            <p className="small sub measure-lg">Three shells cover every screen. Switch the preview to Phone to see how each collapses.</p>
          </header>
          <div className="stack gap-2">
            <span className="th-demo-cap">Store shell · header, category bar, footer · phone: search bar + bottom tabs</span>
            <div className="th-demo">
              <StoreShellDemo />
            </div>
          </div>
          <div className="stack gap-2">
            <span className="th-demo-cap">Back-office shell · sidebar, top bar · phone/tablet: section chips</span>
            <div className="th-demo u-ov-hidden" style={{ height: 260 }}>
              <BackOfficeShellDemo />
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

/** Static preview of the store chrome (StoreLayout's header and tab bar, with fixed sample counts). */
function StoreShellDemo() {
  return (
    <>
      <header className="store-header">
        <div className="container">
          <div className="bar">
            <Logo />
            <button type="button" className="deliver only-desktop btn-ghost btn-bare">
              <span>
                <Icon name="map-pin" className="ic-sm" /> Deliver to
              </span>
              <b>Portland 97205</b>
            </button>
            <form className="search no-phone" role="search" onSubmit={noSubmit}>
              <label htmlFor="hdr-q" className="sr-only">
                Search Marketly
              </label>
              <Icon name="search" className="ic-sm" />
              <input id="hdr-q" type="search" placeholder="Search products, brands and sellers" defaultValue="" />
              <button type="submit" className="go" aria-label="Search">
                <Icon name="arrow-right" />
              </button>
            </form>
            <span className="grow only-phone" />
            <Link className="acct no-phone" to={href('account/overview')}>
              <span>Hello, Jordan</span>
              <b>Account</b>
            </Link>
            <Link className="acct only-desktop" to={href('account/orders')}>
              <span>Returns</span>
              <b>&amp; Orders</b>
            </Link>
            <IconButton icon="bell" label="Notifications, 3 unread" to={href('account/notifications')} count={3} />
            <Link className="cart-btn no-phone" to={href('store/cart')}>
              <Icon name="shopping-cart" />
              <span>Cart</span>
              <span className="n">4</span>
            </Link>
            <span className="only-phone">
              <IconButton icon="shopping-cart" label="Cart, 4 items" to={href('store/cart')} count={4} />
            </span>
          </div>
          <form className="search only-phone mobile-search" role="search" onSubmit={noSubmit}>
            <label htmlFor="hdr-mq" className="sr-only">
              Search Marketly
            </label>
            <Icon name="search" className="ic-sm" />
            <input id="hdr-mq" type="search" placeholder="Search Marketly" defaultValue="" />
            <IconButton icon="scan-line" label="Scan a barcode" />
          </form>
        </div>
        <div className="no-phone nav-row">
          <div className="container">
            <nav className="store-nav" aria-label="Shop">
              {STORE_NAV_DEMO.map((n) => (
                <Link key={n.label} to={href(n.id, n.view)} className={cx(n.active && 'is-active', n.deal && 'deal')} aria-current={n.active ? 'page' : undefined}>
                  {n.icon && <Icon name={n.icon} className="ic-sm" />}
                  {n.label}
                </Link>
              ))}
              <span className="spacer" />
              <Link to={href('sell/landing')}>
                <Icon name="store" className="ic-sm" />
                Sell on Marketly
              </Link>
              <Link to={href('help/center')}>
                <Icon name="life-buoy" className="ic-sm" />
                Help
              </Link>
            </nav>
          </div>
        </div>
      </header>
      <nav className="tabbar" aria-label="App">
        {TABBAR_DEMO.map((t) => (
          <Link key={t.label} to={href(t.id)} className={cx(t.active && 'is-active')} aria-current={t.active ? 'page' : undefined}>
            <Icon name={t.icon} />
            {t.count ? <span className="dot-count">{t.count}</span> : null}
            <span>{t.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}

/** Static preview of the Seller Center shell (BackOfficeLayout's sidebar, top bar and section chips). */
function BackOfficeShellDemo() {
  return (
    <div className="bo">
      <aside className="bo-side" id="bo-side">
        <div className="brand">
          <Logo area="Seller Center" />
        </div>
        <nav aria-label="Seller Center">
          {SELLER_NAV_DEMO.map((n) => (
            <Link key={n.id} to={href(n.id)} className={cx(n.active && 'is-active')} aria-current={n.active ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
              {n.count !== undefined && <Count n={n.count} tone={n.urgent ? 'danger' : undefined} sr={n.urgent ? 'urgent' : undefined} />}
            </Link>
          ))}
        </nav>
        <div className="me">
          <Avatar name="Avery Stone" />
          <div className="stack gap-0">
            <span className="strong truncate">Avery Stone</span>
            <span className="xs muted truncate">Owner · Northwind Audio</span>
          </div>
        </div>
      </aside>
      <div className="bo-main">
        <header className="bo-top">
          <div className="bar">
            <span className="no-desktop">
              {/* Preview only: the working menu sheet lives in BackOfficeLayout. */}
              <IconButton icon="menu" label="Open menu" aria-expanded={false} aria-haspopup="dialog" />
            </span>
            <span className="no-desktop only-phone">
              <LogoMark className="logo-mark sm" />
            </span>
            <button type="button" className="row gap-2 nowrap btn-bare tight">
              <span className="sr-only">Switch store: </span>
              <LogoTile initials="NA" tint="2" size="sm" />
              <span className="sr-only only-phone">Northwind Audio</span>
              <span className="stack gap-0 no-phone">
                <span className="small strong">Northwind Audio</span>
                <span className="xs t-success-text">● Approved · selling</span>
              </span>
              <Icon name="chevrons-up-down" className="ic-sm" />
            </button>
            <label className="search no-phone" htmlFor="bo-q">
              <Icon name="search" className="ic-sm" />
              <input id="bo-q" type="search" placeholder="Search orders, products, SKUs" />
              <span className="kbd">/</span>
            </label>
            <span className="grow" />
            <span className="only-phone">
              <IconButton icon="search" label="Search" />
            </span>
            <IconButton icon="circle-help" label="Help" to={href('seller/help')} />
            <IconButton icon="bell" label="Notifications, 4 unread" to={href('seller/notifications')} count={4} />
            <span className="no-phone">
              <Avatar name="Avery Stone" />
            </span>
          </div>
          <nav className="bo-mnav" aria-label="Sections">
            {SELLER_NAV_DEMO.map((n) => (
              <Link key={n.id} to={href(n.id)} className={cx(n.active && 'is-active')} aria-current={n.active ? 'page' : undefined}>
                <Icon name={n.icon} />
                {n.label}
              </Link>
            ))}
          </nav>
        </header>
        <div className="bo-content">
          <div className="page-head">
            <div className="t">
              <div className="h1">Orders</div>
              <p className="sub small">Example content area</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
