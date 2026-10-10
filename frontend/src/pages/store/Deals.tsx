import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { P } from '@/data/fixtures';
import { StoreLayout } from '@/layouts';
import { money, percentOff } from '@/lib/format';
import { href } from '@/routes/href';
import { Badge, Button, Countdown, Icon, Img, Meter, Price, ProductCard, Tabs, announce } from '@/ui';
import { items } from './data/collection';
import { CLEARANCE_IDS, CLEARANCE_TOTAL, COUPONS, DEAL_TABS, EVENTS, FLASH, FLASH_DEALS, type DealTab, type FlashDeal } from './data/deals';

// Design: pages/store/store-deals.html. The tabs show one deal type at a time ("All deals" shows every
// section); the flash-sale countdown is live; coupons clip and event reminders toggle locally.

const CLEARANCE = items(CLEARANCE_IDS);

export default function Deals() {
  const [tab, setTab] = useState<DealTab>('all');
  const [clipped, setClipped] = useState<Record<string, boolean>>(() => Object.fromEntries(COUPONS.map((c) => [c.id, c.clipped])));
  const [reminders, setReminders] = useState<Record<string, boolean>>({});
  const show = (t: DealTab) => tab === 'all' || tab === t;

  const clip = (id: string, title: string) => {
    setClipped((c) => ({ ...c, [id]: true }));
    announce(`Coupon clipped: ${title}. It applies automatically at checkout.`);
  };
  const remind = (id: string, title: string) => {
    const on = !reminders[id];
    setReminders((r) => ({ ...r, [id]: on }));
    announce(on ? `We'll remind you when ${title} starts.` : `Reminder removed for ${title}.`);
  };

  return (
    <StoreLayout nav="deals" tab="deals">
      <div className="container page gap-6">
        <div className="stack gap-2">
          <h1 className="h1">Deals</h1>
          <p className="small sub">Every deal names the seller whose offer it applies to. A deal price is valid only for that offer, until the end time or until deal stock runs out.</p>
        </div>
        <Tabs<DealTab> items={DEAL_TABS} active={tab} onChange={setTab} label="Deal types" />

        {show('flash') && (
          <section className="shop-flash" aria-labelledby="dl-flash">
            <div className="row between">
              <div className="stack gap-1">
                <h2 className="h2 row gap-2 u-c-deal-text" id="dl-flash">
                  <Icon name="zap" /> Flash sale
                </h2>
                <span className="small sub">{FLASH.window}</span>
              </div>
              <span className="row gap-2 small sub">
                Ends in <Countdown seconds={FLASH.endsIn} />
              </span>
            </div>
            <div className="shop-dgrid">
              {FLASH_DEALS.map((d) => (
                <FlashCard key={d.p} d={d} />
              ))}
            </div>
          </section>
        )}

        {show('coupons') && (
          <section className="stack gap-4" aria-labelledby="dl-cp">
            <div className="row between base">
              <h2 className="h2">
                <span id="dl-cp">Coupons</span>
              </h2>
              <Link className="small strong" to={href('account/coupons')}>
                My coupons <Icon name="arrow-right" className="ic-sm" />
              </Link>
            </div>
            <div className="shop-coupons">
              {COUPONS.map((c) => (
                <article key={c.id} className="shop-coupon">
                  <div className="amt">
                    {c.amt}
                    <span>{c.unit}</span>
                  </div>
                  <div className="body">
                    <span className="strong">{c.title}</span>
                    <span className="xs sub">{c.terms}</span>
                    <span className="xs muted">{c.expires}</span>
                    <div className="row gap-2">
                      {clipped[c.id] ? (
                        <>
                          <Badge tone="success" icon="check">
                            Clipped
                          </Badge>
                          <span className="xs muted">Applies automatically at checkout</span>
                        </>
                      ) : (
                        <Button variant="soft" size="sm" icon="scissors" onClick={() => clip(c.id, c.title)}>
                          Clip coupon
                        </Button>
                      )}
                      <a className="xs" href="#">
                        Eligible items
                      </a>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            <p className="xs muted">Coupons can’t be combined with flash sale prices unless the coupon says so. One coupon per seller per order.</p>
          </section>
        )}

        {show('clearance') && (
          <section className="stack gap-4" aria-labelledby="dl-cl">
            <div className="row between base">
              <h2 className="h2">
                <span id="dl-cl">Clearance</span>
              </h2>
              {tab === 'all' && (
                <a
                  className="small strong"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setTab('clearance');
                  }}
                >
                  See all {CLEARANCE_TOTAL} <Icon name="arrow-right" className="ic-sm" />
                </a>
              )}
            </div>
            <p className="small sub" style={{ marginTop: 'calc(-1 * var(--sp-2))' } as CSSProperties}>
              Clearance prices last while the listed seller’s current stock lasts. Normal return terms apply.
            </p>
            <div className="grid-products wide">
              {CLEARANCE.map((p) => (
                <ProductCard key={p.id} p={p} from showSeller />
              ))}
            </div>
          </section>
        )}

        {show('events') && (
          <section className="card" aria-labelledby="dl-up">
            <div className="card-head">
              <h2 className="h3" id="dl-up">
                Upcoming events
              </h2>
              <span className="xs muted">Times in Pacific Time</span>
            </div>
            <ul className="list pad">
              {EVENTS.map((ev) => (
                <li key={ev.id}>
                  <div className="shop-event grow">
                    <span className="shop-date">
                      <span className="m">{ev.month}</span>
                      <span className="d">{ev.day}</span>
                    </span>
                    <span className="stack gap-0 grow minw-200">
                      <span className="strong">{ev.title}</span>
                      <span className="xs muted">{ev.when}</span>
                    </span>
                    <Button variant="secondary" size="sm" icon={reminders[ev.id] ? 'bell-ring' : 'bell'} aria-pressed={!!reminders[ev.id]} onClick={() => remind(ev.id, ev.title)}>
                      {reminders[ev.id] ? 'Reminder set' : 'Remind me'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </StoreLayout>
  );
}

/** Flash-sale card (.shop-dcard); a sold-out deal shows the seller's regular offer. */
function FlashCard({ d }: { d: FlashDeal }) {
  const p = P[d.p];
  const sub = `${d.seller} · Limit ${d.limit} per customer`;
  if (d.soldOutAt && d.regular) {
    return (
      <article className="shop-dcard is-out">
        <Link to={href('store/product')} aria-label={p.name}>
          <Img icon={p.icon} tint={p.tint} />
        </Link>
        <div className="tagrow">
          <Badge tone="solid">Deal sold out</Badge>
        </div>
        <span className="row gap-2 base">
          <span className="price">
            <span className="now u-c-text-3" style={{ textDecoration: 'line-through' }}>
              {money(d.price)}
            </span>
          </span>
          <span className="xs muted">deal price</span>
        </span>
        <Link className="small clamp-2 link-plain" to={href('store/product')}>
          {p.name}
        </Link>
        <div className="stack gap-1">
          <Meter pct={100} tone="deal" label={`${p.name}: share claimed`} />
          <span className="xs muted">100% claimed at {d.soldOutAt}</span>
        </div>
        <div className="regular">
          <span className="xs strong">Regular offer still available</span>
          <Price amount={d.regular.price} was={d.regular.was} noOff />
          <span className="xs muted">{d.seller} · not part of the flash sale</span>
          <Button variant="secondary" size="sm" to={href('store/product')}>
            View regular offer
          </Button>
        </div>
      </article>
    );
  }
  return (
    <article className="shop-dcard">
      <Link to={href('store/product')} aria-label={p.name}>
        <Img icon={p.icon} tint={p.tint} />
      </Link>
      <div className="tagrow">
        <Badge tone="deal">−{percentOff(d.price, d.was)}%</Badge>
      </div>
      <Price amount={d.price} was={d.was} noOff />
      <Link className="small clamp-2 link-plain" to={href('store/product')}>
        {p.name}
      </Link>
      <span className="xs muted">{sub}</span>
      <div className="stack gap-1">
        <Meter pct={d.claimed} tone="deal" label={`${sub}: share claimed`} />
        <span className="xs muted">{d.claimed}% claimed</span>
      </div>
    </article>
  );
}
