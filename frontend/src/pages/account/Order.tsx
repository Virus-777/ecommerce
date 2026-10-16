import { Link, useParams } from 'react-router';
import { errorMessage } from '@marketly/web-shared/api';
import { AccountLayout } from '@/layouts';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Card, Icon, Img, LogoTile, SellerBadge, StatusBadge, SummaryRow, Track } from '@marketly/web-shared/ui';
import {
  caseHref, fmtPhone, fmtPlaced, groupTone, humanize, plural, productHref, returnHref, returnTone, sellerInitials, stateTone, useOpenDocument, useOrderDetail,
  type OrderDetail, type OrderGroup, type OrderItem,
} from './data/orders';
import { DetailSkeleton, LoadError, NotFoundCard } from './data/order-parts';

// Design: pages/store/account-order.html (one view). Data: the OrderDetail screen query (order(ref))
// for packages, item states and actions, payment, returns, refunds, cases and documents; documents
// open through GET orders/orders/{id}/documents/{documentId} (short-lived PDF link).

/** Mini delivery track class per package state ("d" delivered, "i" on its way, "w" late or failed). */
function miniClass(state: string): 'd' | 'i' | 'w' {
  const s = state.toLowerCase();
  if (s.startsWith('delivered')) return 'd';
  if (s.includes('delay') || s.includes('fail') || s.includes('late') || s.includes('exception')) return 'w';
  return 'i';
}
const MINI_LEGEND = { d: 'Delivered', i: 'In transit', w: 'Delayed' } as const;

/** Package track: the shipment's own steps once shipped, otherwise the pre-shipping steps. */
function packageTrack(g: OrderGroup): { labels: string[]; done: number; tone?: 'warning' | 'danger' } | null {
  const s = g.status.toUpperCase();
  if (s.includes('CANCELLED')) return null;
  const sh = g.shipments.find((x) => x.kind.toUpperCase() === 'OUTBOUND') ?? g.shipments[0];
  if (sh) {
    const failed = sh.status.toUpperCase().includes('FAIL') || !!sh.failedDelivery;
    return { labels: ['Confirmed', ...sh.steps], done: sh.currentStep + 2, tone: failed ? 'danger' : undefined };
  }
  const labels = ['Confirmed', 'Preparing', 'Shipped', 'Delivered'];
  if (s === 'PREPARING' || s === 'DELAYED') return { labels, done: 2, tone: s === 'DELAYED' ? 'warning' : undefined };
  return { labels, done: 1 };
}

export default function Order() {
  const { ref = '' } = useParams();
  const q = useOrderDetail(ref);
  const order = q.data;
  const docs = useOpenDocument(order?.id);
  const crumbs = <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: ref }]} />;

  if (q.isPending || q.isError || !order) {
    return (
      <AccountLayout active="orders" title="Order details">
        {crumbs}
        {q.isPending ? (
          <DetailSkeleton cards={3} />
        ) : q.isError ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <NotFoundCard title={`We couldn't find order ${ref}`}>Check the order number in your confirmation email. Orders placed as a guest are found with the guest order lookup.</NotFoundCard>
        )}
      </AccountLayout>
    );
  }

  const receipt = order.documents.find((d) => d.kind.toUpperCase() === 'RECEIPT');
  const openCase = order.cases.find((c) => c.open);
  const latestReturn = order.returns[0];
  const returnItem = latestReturn && order.groups.flatMap((g) => g.items).find((i) => latestReturn.items.some((r) => r.orderItemId === i.id));
  const expected = latestReturn && order.totals.expectedRefunds.find((e) => e.ref === latestReturn.ref);
  const pkgStates = order.progress.delivery.packageStates;
  const legend = [...new Set(pkgStates.map(miniClass))];

  return (
    <AccountLayout active="orders" title="Order details">
      {crumbs}
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">
            Order <span className="mono">{order.ref}</span>
          </h1>
          <p className="small sub only-phone mono">{order.ref}</p>
          <p className="small sub">
            Placed {fmtPlaced(order.placedAt)} PT · {order.summaryLine}
          </p>
        </div>
        <div className="acts">
          {receipt && (
            <Button variant="secondary" size="sm" icon="download" onClick={() => docs.mutate(receipt.id)} disabled={docs.isPending}>
              Download receipt
            </Button>
          )}
          <Button variant="soft" size="sm" icon="life-buoy" to={href('help/order-problem', '', undefined, { order: order.ref })}>
            Get help
          </Button>
        </div>
      </div>
      {docs.isError && (
        <Alert tone="danger" title="We couldn't open that document">
          {errorMessage(docs.error)}
        </Alert>
      )}

      <section className="card pad stack gap-4" aria-label="Order status">
        <div className="row between">
          <span className="row gap-2">
            <span className="small sub">Overall</span>
            <StatusBadge status={order.statusLabel} tone={stateTone(order.status)} />
          </span>
          <span className="xs muted">
            {order.progress.delivery.label}
            {order.progress.returns.openReturns ? ` · ${plural(order.progress.returns.openReturns, 'return')} open` : ''}
          </span>
        </div>
        <div className="acct-ind">
          <div>
            <span className="k">
              <Icon name="credit-card" className="ic-sm" />
              Payment
            </span>
            <span className="row gap-2">
              <StatusBadge status={order.payment?.stateLabel ?? order.progress.payment.label} />
              <span className="small strong num">{formatMoney(order.progress.payment.amountCharged ?? order.totals.total)}</span>
            </span>
            {order.progress.payment.note && <span className="xs sub">{order.progress.payment.note}</span>}
          </div>
          <div>
            <span className="k">
              <Icon name="truck" className="ic-sm" />
              Delivery
            </span>
            <span className="row gap-2">
              <StatusBadge status={humanize(order.progress.delivery.state)} tone={stateTone(order.progress.delivery.state)} />
            </span>
            {pkgStates.length > 0 && (
              <>
                <div className="acct-mini-track" role="img" aria-label={pkgStates.map((s, i) => `Package ${i + 1} ${s.toLowerCase()}`).join(', ')}>
                  {pkgStates.map((s, i) => (
                    <span key={i} className={miniClass(s)} />
                  ))}
                </div>
                <div className="legend acct-mini-legend">
                  {legend.map((c) => (
                    <span key={c}>
                      <i className={`mt-${c}`} aria-hidden="true" />
                      {MINI_LEGEND[c]}
                    </span>
                  ))}
                </div>
                <span className="xs sub">{pkgStates.join(' · ')}</span>
              </>
            )}
          </div>
          <div>
            <span className="k">
              <Icon name="undo-2" className="ic-sm" />
              Returns and refunds
            </span>
            {latestReturn ? (
              <>
                <span className="row gap-2">
                  <StatusBadge status={latestReturn.statusLabel} tone={returnTone(latestReturn.status)} />
                  <span className="xs muted">{plural(latestReturn.items.length, 'item')}</span>
                </span>
                <span className="xs sub">
                  {returnItem ? `${returnItem.title}, ` : ''}
                  <Link className="mono" to={returnHref(latestReturn.ref)}>
                    {latestReturn.ref}
                  </Link>
                  {latestReturn.nextStep ? `. ${latestReturn.nextStep}.` : '.'}
                  {expected ? ` Refund of about ${formatMoney(expected.amount)} after inspection.` : ''}
                </span>
              </>
            ) : (
              <>
                <span className="row gap-2">
                  <StatusBadge status={order.progress.returns.label} />
                </span>
                {order.progress.returns.note && <span className="xs sub">{order.progress.returns.note}</span>}
              </>
            )}
          </div>
        </div>
      </section>

      <div className="acct-split">
        <div className="stack gap-4">
          {order.groups.map((g, gi) => (
            <PackageCard key={g.id} order={order} g={g} index={gi} />
          ))}
        </div>
        <aside>
          <Card title="Payment summary" titleAs="h3">
            <SummaryRow k={`Items (${order.totals.itemCount})`} v={formatMoney(order.totals.items)} />
            {order.totals.discounts.map((d, i) => (
              <SummaryRow
                key={i}
                className="discount"
                k={
                  d.code ? (
                    <>
                      Coupon <span className="mono">{d.code}</span>
                    </>
                  ) : (
                    d.label
                  )
                }
                v={`−${formatMoney(d.amount)}`}
              />
            ))}
            <SummaryRow k={order.totals.shippingLabel} v={order.totals.shippingTotal.amount ? formatMoney(order.totals.shippingTotal) : 'Free'} />
            <SummaryRow k={order.totals.taxLabel} v={formatMoney(order.totals.tax)} />
            <hr />
            <SummaryRow className="total" k="Order total" v={formatMoney(order.totals.total)} />
            {order.totals.paidWith && <SummaryRow k="Paid with" v={order.totals.paidWith} />}
            <hr />
            <SummaryRow k="Refunded so far" v={formatMoney(order.totals.refundedSoFar)} />
            {order.totals.expectedRefunds.map((e, i) => (
              <SummaryRow key={i} k={e.ref ? `Expected refund, ${e.ref}` : e.label} v={formatMoney(e.amount)} />
            ))}
            <span className="xs muted">Refunds return to the card you paid with. A partial refund only affects the items it covers.</span>
          </Card>
          {order.deliveryAddress && (
            <Card title="Delivery address" titleAs="h3">
              <address className="small u-fst-normal">
                {order.deliveryAddress.name}
                <br />
                {order.deliveryAddress.line1}
                {order.deliveryAddress.line2 ? `, ${order.deliveryAddress.line2}` : ''}
                <br />
                {order.deliveryAddress.city}, {order.deliveryAddress.region} {order.deliveryAddress.postalCode}
                {order.deliveryAddress.phone && (
                  <>
                    <br />
                    {fmtPhone(order.deliveryAddress.phone)}
                  </>
                )}
              </address>
              {order.addressNote && <span className="xs muted">{order.addressNote}</span>}
            </Card>
          )}
          {order.documents.length > 0 && (
            <Card title="Documents" titleAs="h3" flush>
              <div className="list pad">
                {order.documents.map((d) => (
                  <a
                    key={d.id}
                    className="li"
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      docs.mutate(d.id);
                    }}
                  >
                    <Icon name={d.kind.toUpperCase() === 'RECEIPT' ? 'receipt' : 'file-text'} className="ic-sm" />
                    <span className="grow small">{d.label}</span>
                    <span className="xs muted">{d.format.toUpperCase()}</span>
                    <Icon name="download" className="ic-sm" />
                  </a>
                ))}
              </div>
            </Card>
          )}
          <Card title="Need help with this order?" titleAs="h3">
            <p className="small sub">Pick the item and tell us what happened. We'll bring in the seller if needed.</p>
            <div className="stack gap-2">
              <Button variant="secondary" block icon="circle-alert" to={href('help/order-problem', '', undefined, { order: order.ref })}>
                Report a problem
              </Button>
              {openCase && (
                <Button variant="ghost" block to={caseHref(openCase.ref)}>
                  View case {openCase.ref}
                </Button>
              )}
            </div>
          </Card>
        </aside>
      </div>
    </AccountLayout>
  );
}

function PackageCard({ order, g, index }: { order: OrderDetail; g: OrderGroup; index: number }) {
  const tone = groupTone(g.status);
  const track = packageTrack(g);
  const sh = g.shipments.find((x) => x.kind.toUpperCase() === 'OUTBOUND') ?? g.shipments[0];
  const H = index === 0 ? 'h2' : 'h3';
  const cancelled = g.status.toUpperCase().includes('CANCELLED');
  const canContact = g.items.some((i) => i.actions.includes('CONTACT_SELLER'));
  return (
    <section className={`card acct-pkgcard${tone ? ` t-${tone}` : ''}`}>
      <div className="card-head">
        <div className="row gap-3 nowrap min-w-0">
          <LogoTile initials={sellerInitials(g.seller.name)} tint={String((index % 6) + 1)} />
          <div className="stack gap-1">
            <span className="row gap-2">
              <H className="h4">{g.packageLabel}</H>
              <StatusBadge status={g.statusLabel} tone={stateTone(g.status)} />
            </span>
            <span className="row gap-2 xs muted">
              Sold and shipped by <b className="sub">{g.seller.name}</b>
              <SellerBadge seller={g.seller} compact />
            </span>
          </div>
        </div>
        <div className="stack gap-0 right">
          {g.estimateLabel && <span className="small strong">{g.estimateLabel}</span>}
          <span className="xs muted">
            {sh?.trackingNumber ? (
              <>
                {sh.carrierName ?? sh.serviceName} · <span className="mono">{sh.trackingNumber}</span>
              </>
            ) : cancelled ? null : (
              "No tracking yet. The seller hasn't shipped this package."
            )}
          </span>
        </div>
      </div>
      <div className="card-body">
        {track && <Track labels={track.labels} done={track.done} tone={track.tone} />}
        {g.alert && (
          <Alert tone={g.alert.tone.toLowerCase() === 'danger' ? 'danger' : g.alert.tone.toLowerCase() === 'info' ? 'info' : 'warning'} title={g.alert.title}>
            {g.alert.message}
            {g.alert.caseRef && (
              <>
                {' '}
                Your case{' '}
                <Link className="mono" to={caseHref(g.alert.caseRef)}>
                  {g.alert.caseRef}
                </Link>{' '}
                is open.
              </>
            )}
          </Alert>
        )}
        <div>
          {g.items.map((it) => (
            <ItemRow key={it.id} order={order} it={it} />
          ))}
        </div>
      </div>
      <div className="card-foot between">
        <span className="xs muted">{g.handlingNote ?? g.returnTermsSummary}</span>
        <span className="row gap-2">
          {canContact && (
            <Button variant="ghost" size="sm" icon="message-square" to={href('account/messages', '', undefined, { order: order.ref })}>
              Contact seller
            </Button>
          )}
          {g.alert && (
            <Button variant="soft" size="sm" icon="life-buoy" to={g.alert.caseRef ? caseHref(g.alert.caseRef) : href('help/order-problem', '', undefined, { order: order.ref })}>
              Get help with this package
            </Button>
          )}
        </span>
      </div>
    </section>
  );
}

function ItemRow({ order, it }: { order: OrderDetail; it: OrderItem }) {
  const product = productHref(it.productId, it.title, it.productSlug);
  const returnRef = it.afterSales?.returnRef ?? it.returnEligibility?.latestReturn?.ref ?? null;
  return (
    <div className="acct-item">
      <Link to={product} aria-label={it.title}>
        <Img icon="package" tint="2" className="thumb" src={it.image?.url} alt="" />
      </Link>
      <div className="stack gap-1">
        <Link className="small strong link-plain" to={product}>
          {it.title}
        </Link>
        <span className="xs muted">
          {it.variantLabel ? `${it.variantLabel} · ` : ''}Qty {it.quantity} · <span className="num">{formatMoney(it.lineSubtotal)}</span>
        </span>
        <span className="row gap-2">
          <StatusBadge status={it.stateLabel} tone={stateTone(it.state)} />
          {it.stateNote && <span className="xs sub">{it.stateNote}</span>}
        </span>
      </div>
      <div className="acts">
        {it.actions.includes('REVIEW') && (
          <Button variant="secondary" size="sm" icon="star" to={href('account/review', '', undefined, { item: it.id })}>
            Write a review
          </Button>
        )}
        {it.actions.includes('RETURN') && (
          <Button variant="secondary" size="sm" icon="undo-2" to={href('account/return-new', '', { ref: order.ref }, { item: it.id })}>
            Return item
          </Button>
        )}
        {it.actions.includes('VIEW_RETURN') && returnRef && (
          <Button variant="secondary" size="sm" icon="undo-2" to={returnHref(returnRef)}>
            View return
          </Button>
        )}
        {it.actions.includes('TRACK') && (
          <Button variant="secondary" size="sm" icon="truck" to={href('account/tracking', '', { ref: order.ref }, it.shipmentId ? { shipment: it.shipmentId } : undefined)}>
            Track package
          </Button>
        )}
        {it.actions.includes('CANCEL') && (
          <Button variant="secondary" size="sm" icon="x" to={href('account/cancel', '', { ref: order.ref }, { item: it.id })}>
            Cancel item
          </Button>
        )}
        {it.actions.includes('REPORT_PROBLEM') && (
          <Button variant="ghost" size="sm" to={href('help/order-problem', '', undefined, { order: order.ref, item: it.id })}>
            Report a problem
          </Button>
        )}
      </div>
    </div>
  );
}
