import { Icon, Price } from '@/ui';
import { BREAKPOINTS, ICON_SAMPLES, RADII, SHADOWS, SPACING, SWATCH_GROUPS, TYPE_SCALE } from './data/foundations';

// Design: pages/theme/theme-foundations.html (design-system reference page, no store chrome).

export default function Foundations() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="container th-page">
        <div className="stack gap-3" id="main" tabIndex={-1}>
          <span className="eyebrow">Marketly design system · v0.1</span>
          <h1 className="display d-xl">One calm green, one warm orange, and a lot of clear grey.</h1>
          <p className="lead" style={{ maxWidth: '70ch' }}>
            The store is busy by nature: many sellers, prices and delivery promises. The palette stays quiet so that seller identity, totals and dates read first. Orange appears only where money is saved.
          </p>
        </div>

        {SWATCH_GROUPS.map((g) => (
          <section key={g.title} className="th-sec">
            <header>
              <h2 className="h2">{g.title}</h2>
            </header>
            <div className="th-swatches">
              {g.swatches.map((s) => (
                <div key={s.token} className="th-sw">
                  <div className={s.cls ? `chipc ${s.cls}` : 'chipc'} style={s.cls ? undefined : { background: `var(${s.token})` }} />
                  <div className="meta">
                    <b>{s.token}</b>
                    <span className="mono">{s.hex}</span>
                    <span className="muted">{s.use}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="th-sec">
          <header>
            <h2 className="h2">Typography</h2>
            <p className="small sub measure-lg">Bricolage Grotesque for store display headings, used sparingly. Figtree for every interface element. IBM Plex Mono for order references, SKUs and tracking numbers.</p>
          </header>
          <div className="th-type">
            {TYPE_SCALE.map((t) => (
              <TypeRow key={t.spec} spec={t.spec} cls={t.cls} sample={t.sample} />
            ))}
            <span className="spec">price · tabular</span>
            <span>
              <Price amount={189} was={229} lg />
            </span>
          </div>
        </section>

        <section className="th-sec">
          <header>
            <h2 className="h2">Spacing, radius and elevation</h2>
            <p className="small sub measure-lg">4 px base grid. Cards use radius-lg; inputs and buttons radius-md; pills for chips and badges. Shadows only for floating layers.</p>
          </header>
          <div className="stack gap-2">
            {SPACING.map(([token, px]) => (
              <div key={token} className="row gap-3 nowrap">
                <span className="mono xs u-w-70px">{token}</span>
                <span className="th-box" style={{ width: px }} />
                <span className="xs muted">{px}px</span>
              </div>
            ))}
          </div>
          <div className="th-row">
            {RADII.map((r) => (
              <div key={r} className="stack gap-1 u-items-center">
                <span style={{ borderRadius: `var(--${r})` }} className="th-radius-demo" />
                <span className="xs mono">{r}</span>
              </div>
            ))}
          </div>
          <div className="th-row">
            {SHADOWS.map((s) => (
              <div key={s} className="stack gap-1 u-items-center">
                <span style={{ boxShadow: `var(--${s})` }} className="th-shadow-demo" />
                <span className="xs mono">{s}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="th-sec">
          <header>
            <h2 className="h2">Breakpoints</h2>
            <p className="small sub measure-lg">
              Mobile first. Below 768 px the store becomes the Android app layout: bottom tab bar, app bars on sub-pages, sticky action bars, and no website footer, promo strip or breadcrumbs. Back-office screens collapse the sidebar into a scrollable section bar.
            </p>
          </header>
          <div className="th-bp">
            {BREAKPOINTS.map((b) => (
              <div key={b.range}>
                <span className="mono xs">{b.range}</span>
                <span className={b.cls ? `bar ${b.cls}` : 'bar'} style={b.cls ? undefined : { width: b.width }}>
                  {b.label}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="th-sec">
          <header>
            <h2 className="h2">Icons</h2>
            <p className="small sub measure-lg">Lucide outline icons at 1.75 stroke. Web: lucide-react. Android: the same icons as vector drawables. Icons never replace a text label on primary actions.</p>
          </header>
          <div className="th-row">
            {ICON_SAMPLES.map((name) => (
              <span key={name} className="stack gap-1 u-items-center u-w-84px">
                <span className="card u-w-48px u-h-48px u-d-flex u-items-center u-justify-center">
                  <Icon name={name} className="ic-lg" />
                </span>
                <span className="xs muted truncate u-maxw-84px">{name}</span>
              </span>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function TypeRow({ spec, cls, sample }: { spec: string; cls?: string; sample: string }) {
  return (
    <>
      <span className="spec">{spec}</span>
      <span className={cls}>{sample}</span>
    </>
  );
}
