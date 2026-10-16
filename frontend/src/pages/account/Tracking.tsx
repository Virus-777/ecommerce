import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AccountLayout } from '@/layouts';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Card, CopyButton, EmptyState, Field, Icon, Img, OptionCard, Select, StatusBadge, Timeline, Track, type TimelineEvent } from '@marketly/web-shared/ui';
import { fmtDateTime, fmtWeekday, orderHref, productHref, stateTone, useOrderDetail, type DeliveryChoice, type OrderGroup, type Shipment } from './data/orders';
import { DetailSkeleton, LoadError, NotFoundCard, SellerLineApi } from './data/order-parts';

// Design: pages/store/account-tracking.html · the "delivery-failed" state (carrier's failed attempt,
// with "Choose next step") now follows the shipment's real `failedDelivery`. Data: OrderDetail
// (order(ref) → groups.shipments with steps, events and failedDelivery); the package is
// `?shipment=<id>` (default: the first one still on its way). The choice is
// POST shipping/shipments/{id}/delivery-choice.

const CONFIRM: Record<DeliveryChoice, string> = { REDELIVER: 'Confirm redelivery', PICKUP: 'Confirm pickup', RETURN_TO_SELLER: 'Send it back' };

/** "https://tools.usps.com/go/…" -> "usps.com" */
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^(www|tools)./, '');
  } catch {
    return 'the carrier site';
  }
};

function eventState(code: string, i: number, delivered: boolean): TimelineEvent['state'] {
  const c = code.toUpperCase();
  if (c === 'ATTEMPT_FAILED' || c === 'EXCEPTION') return 'danger';
  if (i === 0 && !delivered) return 'current';
  return 'done';
}

export default function Tracking() {
  const { ref = '' } = useParams();
  const [params] = useSearchParams();
  const q = useOrderDetail(ref);
  const order = q.data;
  const title = 'Track package';

  if (q.isPending || q.isError || !order) {
    return (
      <AccountLayout active="orders" title={title}>
        <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: ref, to: orderHref(ref) }, { label: title }]} />
        {q.isPending ? (
          <DetailSkeleton cards={2} />
        ) : q.isError ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <NotFoundCard title={`We couldn't find order ${ref}`}>Check the order number in your confirmation email.</NotFoundCard>
        )}
      </AccountLayout>
    );
  }

  const all = order.groups.flatMap((g) => g.shipments.map((s) => ({ g, s })));
  const wanted = params.get('shipment');
  const pick = all.find((x) => x.s.id === wanted) ?? all.find((x) => !x.s.deliveredAt) ?? all[0];

  if (!pick) {
    return (
      <AccountLayout active="orders" title={title}>
        <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: ref, to: orderHref(ref) }, { label: title }]} />
        <div className="card">
          <EmptyState icon="package" as="h1" title="No tracking yet" action={<Button to={orderHref(ref)}>Back to order</Button>}>
            None of the packages in order {ref} has shipped yet. Tracking appears here as soon as a seller hands a package to the carrier.
          </EmptyState>
        </div>
      </AccountLayout>
    );
  }
  return <TrackingView key={pick.s.id} orderRef={order.ref} placedAt={order.placedAt} g={pick.g} s={pick.s} groups={order.groups} items={order.groups.flatMap((x) => x.items)} />;
}

function TrackingView({ orderRef, placedAt, g, s, groups, items }: { orderRef: string; placedAt: string; g: OrderGroup; s: Shipment; groups: OrderGroup[]; items: OrderGroup['items'] }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const fd = s.failedDelivery;
  const failed = !!fd;
  const [choice, setChoice] = useState<DeliveryChoice>(fd?.options[0]?.choice ?? 'REDELIVER');
  const current = fd?.options.find((o) => o.choice === choice);
  const [date, setDate] = useState(current?.dates[0] ?? '');
  const choose = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/store/shipping/shipments/{id}/delivery-choice', {
          params: { path: { id: s.id } },
          body: { choice: choice.toLowerCase() as 'redeliver' | 'pickup' | 'return_to_seller', redeliveryDate: choice === 'REDELIVER' ? date || null : null },
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['orders', 'detail', orderRef] }),
  });
  const chosen = fd?.chosen ?? null;
  const chosenOption = chosen && fd?.options.find((o) => o.choice === chosen.choice);
  const delivered = !!s.deliveredAt;
  // The seller package ("Package 2 of 3"); with several shipments in the package, also which one ("Shipment 1 of 2").
  const label = g.shipments.length > 1 ? `${g.packageLabel} · ${s.packageLabel}` : g.packageLabel;
  const contents = s.contents.map((c) => ({ c, item: items.find((i) => i.id === c.orderItemId) }));
  const others = groups.filter((x) => x.id !== g.id);
  const events: TimelineEvent[] = [
    ...s.events.map((e, i) => ({
      t: e.label,
      d: [fmtDateTime(e.at), e.location].filter(Boolean).join(' · '),
      state: eventState(e.code, i, delivered),
      body: e.detail && e.detail.toLowerCase() !== e.label.toLowerCase() && !/^[a-z ]+$/.test(e.detail) ? e.detail : undefined,
    })),
    { t: 'Order placed', d: fmtDateTime(placedAt), state: 'done' },
  ];

  return (
    <AccountLayout active="orders" title="Track package">
      <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: orderRef, to: orderHref(orderRef) }, { label }]} />
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Track package</h1>
          <p className="small sub">
            {label} · Order{' '}
            <Link className="mono" to={orderHref(orderRef)}>
              {orderRef}
            </Link>
          </p>
        </div>
      </div>
      {fd &&
        (chosen ? (
          <Alert tone="success" title={`Got it. We've passed your choice to ${s.carrierName ?? 'the carrier'} and ${s.sellerName}`}>
            {chosenOption?.title ?? chosen.choice}
            {chosen.redeliveryDate ? ` on ${fmtWeekday(chosen.redeliveryDate)}` : ''}. {chosenOption?.description}
          </Alert>
        ) : (
          <Alert tone="danger" title={`Delivery failed. Choose what happens next by ${fmtWeekday(fd.chooseBy)}`}>
            {fd.reason} Nothing has been lost. Pick an option below and we'll pass it to {s.carrierName ?? 'the carrier'} and {s.sellerName}.
          </Alert>
        ))}
      <div className="acct-split">
        <div className="stack gap-4">
          <section className="card pad stack gap-4">
            <div className="row between top">
              {failed ? (
                <div className="stack gap-1">
                  <span className="eyebrow">Delivery attempt failed</span>
                  <span className="h2">{chosenOption ? chosenOption.title : 'Waiting for your choice'}</span>
                  {fd.heldAt && (
                    <span className="small sub">
                      Held at {fd.heldAt} until {fmtWeekday(fd.chooseBy)}
                    </span>
                  )}
                </div>
              ) : (
                <div className="stack gap-1">
                  <span className="eyebrow">{s.headline ?? 'Estimated delivery'}</span>
                  <span className="h2">{delivered ? fmtWeekday(s.deliveredAt!) : (s.estimateLabel ?? g.estimateLabel ?? 'Estimate pending')}</span>
                  {s.estimateNote && <span className="small sub">{s.estimateNote}</span>}
                </div>
              )}
              <StatusBadge status={failed ? 'Delivery failed' : s.statusLabel} tone={failed ? 'danger' : stateTone(s.status)} />
            </div>
            <Track labels={s.steps} done={s.currentStep + 1} tone={failed ? 'danger' : undefined} />
            <div className="grid md2 gap-3">
              <div className="panel stack gap-1">
                <span className="acct-k">Carrier</span>
                <span className="small strong">{s.serviceName ?? s.carrierName ?? 'Not shipped yet'}</span>
                {s.trackingUrl && (
                  <a className="xs" href={s.trackingUrl} target="_blank" rel="noreferrer">
                    Open on {hostOf(s.trackingUrl)} <Icon name="external-link" className="ic-sm" />
                  </a>
                )}
              </div>
              {s.trackingNumber && (
                <div className="panel stack gap-1">
                  <span className="acct-k">Tracking number</span>
                  <span className="row gap-1 nowrap">
                    <span className="mono small strong">{s.trackingNumber}</span>
                    <CopyButton text={s.trackingNumber} label="Copy tracking number" />
                  </span>
                </div>
              )}
            </div>
          </section>

          {s.notices.map((n) => (
            <Alert key={n.id} tone="info" title={n.title}>
              {n.message}
            </Alert>
          ))}

          {fd && !chosen && (
            <Card
              title="Choose next step"
              sub="Final costs follow the carrier and seller terms."
              foot={
                <>
                  {choose.isError && <span className="xs t-danger-text grow">{errorMessage(choose.error)}</span>}
                  <Button icon="check" onClick={() => choose.mutate()} disabled={choose.isPending || (choice === 'REDELIVER' && !date)}>
                    {CONFIRM[choice]}
                  </Button>
                </>
              }
            >
              <div className="stack gap-2" role="radiogroup" aria-label="Next step">
                {fd.options.map((o) => (
                  <OptionCard
                    key={o.choice}
                    id={`fail-${o.choice.toLowerCase()}`}
                    name="fail"
                    checked={choice === o.choice}
                    onChange={() => {
                      setChoice(o.choice);
                      setDate(o.dates[0] ?? '');
                    }}
                    title={<span className="strong">{o.title}</span>}
                    body={o.pickupLocation ? `${o.description} ${o.pickupLocation}` : o.description}
                    right={
                      <span className="small strong">
                        {o.cost.amount ? formatMoney(o.cost) : 'Free'}
                        {o.costIfNoChoice && (
                          <>
                            <br />
                            <span className="xs muted">{formatMoney(o.costIfNoChoice)} if no choice is made</span>
                          </>
                        )}
                      </span>
                    }
                  />
                ))}
              </div>
              {choice === 'REDELIVER' && current && current.dates.length > 0 && (
                <Field label="Date for redelivery">
                  <Select id="fail-date" options={current.dates.map((d) => ({ value: d, label: fmtWeekday(d) }))} value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
              )}
            </Card>
          )}

          <Card title="Tracking history" titleAs={fd && !chosen ? 'h3' : 'h2'} sub={`Times in Pacific Time.${s.carrierName ? ` Updates come from ${s.carrierName}.` : ''}`}>
            <Timeline events={events} />
          </Card>
        </div>
        <aside>
          <Card title="In this package" titleAs="h3">
            {contents.map(({ c, item }) => (
              <div key={c.orderItemId} className="row gap-3 nowrap top">
                {item ? (
                  <Link to={productHref(item.productId, item.title, item.productSlug)} aria-label={c.title}>
                    <Img icon="package" tint="2" className="thumb" src={item.image?.url} alt="" />
                  </Link>
                ) : (
                  <Img icon="package" tint="2" className="thumb" />
                )}
                <div className="stack gap-1">
                  {item ? (
                    <Link className="small strong link-plain" to={productHref(item.productId, item.title, item.productSlug)}>
                      {c.title}
                    </Link>
                  ) : (
                    <span className="small strong">{c.title}</span>
                  )}
                  <span className="xs muted">
                    {c.variantLabel ? `${c.variantLabel} · ` : ''}Qty {c.quantity}
                  </span>
                  <SellerLineApi seller={g.seller} />
                </div>
              </div>
            ))}
            <span className="xs muted">
              {s.shipFrom ? `Ships from ${s.shipFrom}. ` : ''}
              {others.length ? 'Other items in this order travel in separate packages.' : ''}
            </span>
          </Card>
          {others.length > 0 && (
            <Card title="Other packages" titleAs="h3" flush>
              <div className="list pad">
                {others.map((o) => (
                  <Link key={o.id} className="li" to={o.shipments[0] ? href('account/tracking', '', { ref: orderRef }, { shipment: o.shipments[0].id }) : orderHref(orderRef)}>
                    <span className="grow small">
                      {o.packageLabel} · {o.seller.name}
                    </span>
                    <StatusBadge status={o.statusLabel} tone={stateTone(o.status)} />
                  </Link>
                ))}
              </div>
            </Card>
          )}
          <Card title="Something wrong?" titleAs="h3">
            <div className="stack gap-2">
              <Button variant="secondary" block icon="package-x" to={href('help/order-problem', '', undefined, { order: orderRef })}>
                Report missing or damaged
              </Button>
              <Button variant="secondary" block icon="message-square" to={href('account/messages', '', undefined, { order: orderRef })}>
                Contact {s.sellerName}
              </Button>
              <Button variant="ghost" block icon="life-buoy" to={href('help/contact')}>
                Get help from Marketly
              </Button>
            </div>
            {s.helpNote && <span className="xs muted">{s.helpNote}</span>}
          </Card>
        </aside>
      </div>
    </AccountLayout>
  );
}
