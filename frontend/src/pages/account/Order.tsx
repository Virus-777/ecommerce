import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { order, P, sellers, type SellerId } from '@/data/fixtures';
import { AccountLayout } from '@/layouts';
import { money } from '@/lib/format';
import { href } from '@/routes/href';
import { Alert, announce, Breadcrumbs, Button, Card, Icon, Img, LogoTile, SellerBadge, StatusBadge, SummaryRow, Track } from '@/ui';

// Design: pages/store/account-order.html (one view). Packages come from the shared order fixture;
// per-item notes and actions are screen copy.

type ItemAction = 'review' | 'return' | 'view-return' | 'track' | 'cancel';

const ITEM_NOTES: Record<string, { note: ReactNode; actions: ItemAction[] }> = {
  aurora: { note: 'Delivered Sep 17. Return by Sat, Oct 17.', actions: ['review', 'return'] },
  pourover: {
    note: (
      <>
        Return{' '}
        <Link className="mono" to={href('account/return')}>
          RT-260921-0457
        </Link>{' '}
        approved. Drop off by Oct 15. Refund after inspection.
      </>
    ),
    actions: ['view-return'],
  },
  ssd1tb: { note: "Shipped Oct 6. Can't be cancelled now. You can return it after delivery.", actions: ['track'] },
  duvet: { note: 'Not shipped yet. You can cancel it until Casa Verde ships it.', actions: ['cancel'] },
};

const PKG_META: Array<{ tone: 'success' | 'info' | 'warning'; labels: string[]; done: number; warn?: boolean; sub: ReactNode; foot: string }> = [
  { tone: 'success', labels: ['Confirmed', 'Shipped', 'In transit', 'Delivered'], done: 4, sub: null, foot: 'Official Store item. Marketly handles returns.' },
  { tone: 'info', labels: ['Confirmed', 'Shipped', 'In transit', 'Delivered'], done: 3, sub: null, foot: 'Pixel & Port handles this package. Marketly support can step in.' },
  { tone: 'warning', labels: ['Confirmed', 'Preparing', 'Shipped', 'Delivered'], done: 2, warn: true, sub: "No tracking yet. The seller hasn't shipped this package.", foot: 'Casa Verde Home handles this package. Marketly support can step in.' },
];

const DOCUMENTS = [
  { icon: 'receipt' as const, label: 'Order receipt' },
  ...order.groups.map((g) => ({ icon: 'file-text' as const, label: `Invoice, ${sellers[g.seller as SellerId].name}` })),
];

/** Saves a plain-text document (receipts and invoices are PDFs once the API exists). */
function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  announce(`Downloading ${name}`);
}

export default function Order() {
  const { ref = order.ref } = useParams();
  const itemCount = order.groups.reduce((n, g) => n + g.items.reduce((m, i) => m + i.qty, 0), 0);
  const receipt = () =>
    download(
      `${ref}-receipt.txt`,
      [`Marketly order ${ref}`, `Placed ${order.placed} PT`, '', ...order.groups.flatMap((g) => g.items.map((i) => `${P[i.p].name} × ${i.qty}  ${money(i.price * i.qty)}`)), '', `Order total ${money(order.total)}`].join('\n'),
    );

  return (
    <AccountLayout active="orders" title="Order details">
      <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: ref }]} />
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">
            Order <span className="mono">{ref}</span>
          </h1>
          <p className="small sub only-phone mono">{ref}</p>
          <p className="small sub">
            Placed {order.placed} PT · {itemCount} items from {order.groups.length} sellers · {money(order.total)}
          </p>
        </div>
        <div className="acts">
          <Button variant="secondary" size="sm" icon="download" onClick={receipt}>
            Download receipt
          </Button>
          <Button variant="soft" size="sm" icon="life-buoy" to={href('help/order-problem')}>
            Get help
          </Button>
        </div>
      </div>

      <section className="card pad stack gap-4" aria-label="Order status">
        <div className="row between">
          <span className="row gap-2">
            <span className="small sub">Overall</span>
            <StatusBadge status={order.status} />
          </span>
          <span className="xs muted">1 of 3 packages delivered · 1 return open</span>
        </div>
        <div className="acct-ind">
          <div>
            <span className="k">
              <Icon name="credit-card" className="ic-sm" />
              Payment
            </span>
            <span className="row gap-2">
              <StatusBadge status={order.paymentStatus} />
              <span className="small strong num">{money(order.total)}</span>
            </span>
            <span className="xs sub">{order.payment} charged Sep 14. No refunds sent yet.</span>
          </div>
          <div>
            <span className="k">
              <Icon name="truck" className="ic-sm" />
              Delivery
            </span>
            <span className="row gap-2">
              <StatusBadge status="Partly delivered" />
            </span>
            <div className="acct-mini-track" role="img" aria-label="Package 1 delivered, package 2 in transit, package 3 delayed">
              <span className="d" />
              <span className="i" />
              <span className="w" />
            </div>
            <div className="legend acct-mini-legend">
              <span>
                <i className="mt-d" aria-hidden="true" />
                Delivered
              </span>
              <span>
                <i className="mt-i" aria-hidden="true" />
                In transit
              </span>
              <span>
                <i className="mt-w" aria-hidden="true" />
                Delayed
              </span>
            </div>
            <span className="xs sub">Delivered · In transit · Delayed</span>
          </div>
          <div>
            <span className="k">
              <Icon name="undo-2" className="ic-sm" />
              Returns and refunds
            </span>
            <span className="row gap-2">
              <StatusBadge status="Approved" />
              <span className="xs muted">1 item</span>
            </span>
            <span className="xs sub">
              Pour-over set,{' '}
              <Link className="mono" to={href('account/return')}>
                RT-260921-0457
              </Link>
              . Refund of about $34.65 after inspection.
            </span>
          </div>
        </div>
      </section>

      <div className="acct-split">
        <div className="stack gap-4">
          {order.groups.map((g, gi) => {
            const s = sellers[g.seller as SellerId];
            const meta = PKG_META[gi];
            const H = gi === 0 ? 'h2' : 'h3';
            return (
              <section key={g.pkg} className={`card acct-pkgcard t-${meta.tone}`}>
                <div className="card-head">
                  <div className="row gap-3 nowrap min-w-0">
                    <LogoTile initials={s.initials} tint={s.tint} />
                    <div className="stack gap-1">
                      <span className="row gap-2">
                        <H className="h4">{g.pkg}</H>
                        <StatusBadge status={g.status} />
                      </span>
                      <span className="row gap-2 xs muted">
                        Sold and shipped by <b className="sub">{s.name}</b>
                        <SellerBadge seller={s} compact />
                      </span>
                    </div>
                  </div>
                  <div className="stack gap-0 right">
                    <span className="small strong">{g.eta}</span>
                    <span className="xs muted">
                      {g.tracking ? (
                        <>
                          {g.carrier} · <span className="mono">{g.tracking}</span>
                        </>
                      ) : (
                        meta.sub
                      )}
                    </span>
                  </div>
                </div>
                <div className="card-body">
                  <Track labels={meta.labels} done={meta.done} tone={meta.warn ? 'warning' : undefined} />
                  {meta.warn && (
                    <Alert tone="warning" title="This package is late">
                      Casa Verde Home missed its dispatch date of Sep 18. New estimate: arrives Mon, Oct 12. If it hasn't shipped by Sat, Oct 10, Marketly support will cancel it for a full refund or arrange a replacement. Your case{' '}
                      <Link className="mono" to={href('help/case')}>
                        CS-261005-3381
                      </Link>{' '}
                      is open, next update by Fri, Oct 9, 12:00 PM PT.
                    </Alert>
                  )}
                  <div>
                    {g.items.map((it) => {
                      const p = P[it.p];
                      const extra = ITEM_NOTES[it.p];
                      return (
                        <div key={it.p} className="acct-item">
                          <Link to={href('store/product')} aria-label={p.name}>
                            <Img icon={p.icon} tint={p.tint} className="thumb" />
                          </Link>
                          <div className="stack gap-1">
                            <Link className="small strong link-plain" to={href('store/product')}>
                              {p.name}
                            </Link>
                            <span className="xs muted">
                              {it.variant} · Qty {it.qty} · <span className="num">{money(it.price * it.qty)}</span>
                            </span>
                            <span className="row gap-2">
                              <StatusBadge status={it.state} />
                              <span className="xs sub">{extra?.note}</span>
                            </span>
                          </div>
                          <div className="acts">
                            {extra?.actions.includes('review') && (
                              <Button variant="secondary" size="sm" icon="star" to={href('account/review')}>
                                Write a review
                              </Button>
                            )}
                            {extra?.actions.includes('return') && (
                              <Button variant="secondary" size="sm" icon="undo-2" to={href('account/return-new', '', { ref })}>
                                Return item
                              </Button>
                            )}
                            {extra?.actions.includes('view-return') && (
                              <Button variant="secondary" size="sm" icon="undo-2" to={href('account/return')}>
                                View return
                              </Button>
                            )}
                            {extra?.actions.includes('track') && (
                              <Button variant="secondary" size="sm" icon="truck" to={href('account/tracking', '', { ref })}>
                                Track package
                              </Button>
                            )}
                            {extra?.actions.includes('cancel') && (
                              <Button variant="secondary" size="sm" icon="x" to={href('account/cancel')}>
                                Cancel item
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" to={href('help/order-problem')}>
                              Report a problem
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="card-foot between">
                  <span className="xs muted">{meta.foot}</span>
                  <span className="row gap-2">
                    <Button variant="ghost" size="sm" icon="message-square" to={href('account/messages')}>
                      Contact seller
                    </Button>
                    {meta.warn && (
                      <Button variant="soft" size="sm" icon="life-buoy" to={href('help/case')}>
                        Get help with this package
                      </Button>
                    )}
                  </span>
                </div>
              </section>
            );
          })}
        </div>
        <aside>
          <Card title="Payment summary" titleAs="h3">
            <SummaryRow k={`Items (${itemCount})`} v={money(order.subtotal)} />
            <SummaryRow
              className="discount"
              k={
                <>
                  Coupon <span className="mono">{order.coupon}</span>
                </>
              }
              v={`−${money(order.discount)}`}
            />
            <SummaryRow k={`Shipping (${order.groups.length} packages)`} v={order.shipping ? money(order.shipping) : 'Free'} />
            <SummaryRow k="Sales tax (OR)" v={money(order.tax)} />
            <hr />
            <SummaryRow className="total" k="Order total" v={money(order.total)} />
            <SummaryRow k="Paid with" v={order.payment} />
            <hr />
            <SummaryRow k="Refunded so far" v={money(0)} />
            <SummaryRow k="Expected refund, RT-260921-0457" v={money(34.65)} />
            <span className="xs muted">Refunds return to the card you paid with. A partial refund only affects the items it covers.</span>
          </Card>
          <Card title="Delivery address" titleAs="h3">
            <address className="small u-fst-normal">
              Jordan Lee
              <br />
              2140 Alder St, Apt 5
              <br />
              Portland, OR 97205
              <br />
              (503) 555-0148
            </address>
            <span className="xs muted">To change where a package goes, contact the seller before it ships. Address book changes don't affect this order.</span>
          </Card>
          <Card title="Documents" titleAs="h3" flush>
            <div className="list pad">
              {DOCUMENTS.map((d) => (
                <a
                  key={d.label}
                  className="li"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    download(`${ref}-${d.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`, `${d.label}\nMarketly order ${ref}\nTotal ${money(order.total)}`);
                  }}
                >
                  <Icon name={d.icon} className="ic-sm" />
                  <span className="grow small">{d.label}</span>
                  <span className="xs muted">PDF</span>
                  <Icon name="download" className="ic-sm" />
                </a>
              ))}
            </div>
          </Card>
          <Card title="Need help with this order?" titleAs="h3">
            <p className="small sub">Pick the item and tell us what happened. We'll bring in the seller if needed.</p>
            <div className="stack gap-2">
              <Button variant="secondary" block icon="circle-alert" to={href('help/order-problem')}>
                Report a problem
              </Button>
              <Button variant="ghost" block to={href('help/case')}>
                View case CS-261005-3381
              </Button>
            </div>
          </Card>
        </aside>
      </div>
    </AccountLayout>
  );
}
