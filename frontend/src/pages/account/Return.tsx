import type { ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { QrCode } from '@/app/QrCode';
import { useSession } from '@/app/session';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AccountLayout } from '@/layouts';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, CopyButton, Img, StatusBadge, SummaryRow, Timeline, Track, type TimelineEvent } from '@marketly/web-shared/ui';
import { caseHref, fmtDateTime, fmtWeekday, humanize, orderHref, refundTone, returnTone, stateTone, useReturnDetail, type ReturnDetail, type TrackStep } from './data/orders';
import { DetailSkeleton, LoadError, NotFoundCard, SellerLineApi } from './data/order-parts';
import { AddTrackingForm, canDo, EscalateReturnButton, InfoReplyCard, WithdrawReturnButton } from './data/return-actions';

// Design: pages/store/account-return.html · the three design views now follow the return's data:
// approved and waiting for drop-off (QR code + label), refund sent (`refund.status` SENT), and the
// replacement on its way (`replacement`). Data: the ReturnDetail screen query (return(ref)) plus REST
// returns/requests/{id} for the drop-off code (drawn as a QR) and the refund estimate; "Email me
// the code" is POST returns/requests/{id}/label/email. What the customer can do comes from
// `actions` (data/return-actions.tsx): answer a question, add tracking for a return they ship
// themselves, withdraw, ask Marketly to step in, get the label, report a problem.

const REFUND_STEPS = ['Requested', 'Under review', 'Approved', 'Processing', 'Sent'];

/** Track segments done: up to and including the current step (all when every step is done). */
const trackDone = (t: TrackStep[]) => {
  const cur = t.findIndex((s) => s.state === 'CURRENT');
  return cur >= 0 ? cur + 1 : t.filter((s) => s.state === 'DONE').length;
};


export default function Return() {
  const { ref = '' } = useParams();
  const q = useReturnDetail(ref);
  const r = q.data;
  const crumbs = <Breadcrumbs items={[{ label: 'Returns and refunds', to: href('account/returns') }, { label: ref }]} />;
  if (q.isPending || q.isError || !r) {
    return (
      <AccountLayout active="returns" title="Return details">
        {crumbs}
        {q.isPending ? (
          <DetailSkeleton cards={2} />
        ) : q.isError ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <NotFoundCard title={`We couldn't find return ${ref}`} back={href('account/returns')} backLabel="Back to returns">
            Check the return number in your email, or find the return from its order.
          </NotFoundCard>
        )}
      </AccountLayout>
    );
  }
  return <ReturnView r={r} crumbs={crumbs} />;
}

function ReturnView({ r, crumbs }: { r: ReturnDetail; crumbs: ReactNode }) {
  const { api } = useApi();
  const { customer } = useSession();
  const email = useMutation({
    mutationFn: () => call(api.POST('/api/store/returns/requests/{id}/label/email', { params: { path: { id: r.id } } })),
    onSuccess: () => announce(`We emailed the drop-off code${customer ? ` to ${customer.email}` : ''}`),
  });
  const sh = r.shipment;
  const waiting = !!sh && sh.status.toUpperCase() === 'LABEL_ISSUED' && r.open;
  // A label or drop-off code exists only when the seller ships it (GET_LABEL); a return the customer
  // sends themselves (customer-arranged) needs their carrier and tracking number instead (ADD_TRACKING).
  const getLabel = canDo(r, 'GET_LABEL');
  const addTracking = canDo(r, 'ADD_TRACKING');
  const selfShip = sh?.method.toUpperCase() === 'CUSTOMER_ARRANGED';
  const escalate = canDo(r, 'ESCALATE');
  const refund = r.refund;
  const refundSent = refund?.status.toUpperCase() === 'SENT';
  const repl = r.replacement;
  const isReplacement = r.remedy.toUpperCase() === 'REPLACEMENT' || !!repl;
  const official = r.ownerType.toUpperCase() === 'OFFICIAL';
  const seller = { name: r.sellerName, official, verified: true };
  const itemTotal = { amount: r.items.reduce((s, i) => s + i.unitPrice.amount * i.quantity, 0), currency: r.items[0]?.unitPrice.currency ?? 'USD' };
  // The ReturnDetail screen query doesn't select shipment.dropOffCode or refundEstimate yet (the schema has
  // both): read them from REST GET returns/requests/{id} while they matter (waiting for drop-off, refund not decided).
  const extra = useQuery({
    queryKey: ['returns', 'request', r.id],
    queryFn: () => call(api.GET('/api/store/returns/requests/{id}', { params: { path: { id: r.id } } })),
    enabled: (waiting && getLabel) || (!r.refund && r.open),
  });
  const code = extra.data?.shipment?.dropOffCode ?? null;
  const estimate = extra.data?.refundEstimate ?? null;
  /** The decided refund's breakdown, else the estimate before a decision (isEstimate). */
  const bd = refund?.breakdown ?? estimate;
  const near = sh?.dropOffPoints[0];
  const rejected = r.decision?.kind.toUpperCase() === 'REJECTED';

  const shipmentEvents: TimelineEvent[] = [
    ...(waiting && sh?.dropOffBy ? [{ t: 'Waiting for drop-off', d: `Drop off by ${fmtWeekday(sh.dropOffBy)}`, state: 'current' as const, body: selfShip ? "Add the carrier and tracking number once you've sent it." : 'The label activates when the carrier scans your QR code.' }] : []),
    ...[...(sh?.events ?? []), ...r.timeline]
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((e) => ({ t: e.label, d: fmtDateTime(e.at), state: 'done' as const, body: e.detail ?? undefined })),
  ];

  return (
    <AccountLayout active="returns" title="Return details">
      {crumbs}
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">
            Return <span className="mono">{r.ref}</span>
          </h1>
          <p className="small sub">
            Order{' '}
            <Link className="mono" to={orderHref(r.orderRef)}>
              {r.orderRef}
            </Link>{' '}
            · requested {fmtWeekday(r.requestedAt)}
          </p>
        </div>
        <div className="acts">
          <Button variant="soft" size="sm" icon="life-buoy" to={href('help/order-problem', '', undefined, { order: r.orderRef })}>
            Get help
          </Button>
        </div>
      </div>

      <section className="card pad stack gap-4">
        {r.items.map((it) => (
          <div key={it.orderItemId} className="row gap-3 nowrap top">
            <Img icon="package" tint="2" className="thumb" src={it.imageUrl ?? undefined} alt="" />
            <div className="stack gap-1 grow">
              <span className="small strong">{it.title}</span>
              <span className="xs muted">
                {[...it.options.map((o) => o.value), `Qty ${it.quantity}`].join(' · ')} · Reason: {r.reason.toLowerCase()}
              </span>
              <SellerLineApi seller={seller} />
            </div>
          </div>
        ))}
        <div className="stack gap-2">
          <span className="row gap-2">
            <span className="acct-k">Return</span>
            <StatusBadge status={r.statusLabel} tone={returnTone(r.status)} />
            {isReplacement && <span className="xs muted">Remedy: replacement</span>}
          </span>
          <Track labels={r.track.map((t) => t.label)} done={trackDone(r.track)} tone={rejected ? 'danger' : undefined} />
          {r.open && r.nextStep && (
            <span className="xs sub">
              Next: {r.nextStep}
              {r.nextDeadline && !r.nextStep.includes(fmtWeekday(r.nextDeadline.dueAt)) ? ` · by ${fmtDateTime(r.nextDeadline.dueAt)} PT` : ''}
            </span>
          )}
        </div>
      </section>

      <div className="acct-split">
        <div className="stack gap-4">
          {canDo(r, 'REPLY_INFO') && <InfoReplyCard r={r} />}
          {rejected && (
            <Alert tone="danger" title="Return not approved">
              <span className="stack gap-2">
                <span>
                  {r.decision?.explanation ?? 'The seller did not approve this return.'}{' '}
                  {escalate ? 'If you disagree, ask Marketly to step in and a support agent will decide.' : r.escalation ? '' : 'If you disagree, open a support case and Marketly will take a look.'}
                </span>
                {escalate && (
                  <span className="row gap-2">
                    <EscalateReturnButton r={r} size="sm" label="I disagree: ask Marketly" />
                  </span>
                )}
              </span>
            </Alert>
          )}
          {r.escalation && r.open && (
            <Alert tone="info" title="Marketly is looking at this return">
              Marketly stepped in on {fmtWeekday(r.escalation.at)}. A support agent reviews the return and decides.
              {r.escalation.caseRef && (
                <>
                  {' '}
                  Follow it in case{' '}
                  <Link className="mono" to={caseHref(r.escalation.caseRef)}>
                    {r.escalation.caseRef}
                  </Link>
                  .
                </>
              )}
            </Alert>
          )}
          {waiting && sh && (
            <>
              {email.isSuccess ? (
                <Alert tone="success" title={`Code sent${customer ? ` to ${customer.email}` : ''}`}>
                  Show it at a drop-off point{sh.dropOffBy ? ` by ${fmtWeekday(sh.dropOffBy)}` : ''}. Your refund starts once we receive and inspect the item.
                </Alert>
              ) : (
                <Alert tone="info" title="Approved means you can send it back">
                  Your refund hasn't been sent yet. It starts once we receive and inspect the item.
                </Alert>
              )}
              <Card
                title={sh.dropOffBy ? `Send it back by ${fmtWeekday(sh.dropOffBy)}` : 'Send it back'}
                sub={
                  selfShip
                    ? 'You arrange the shipping: use a tracked service, then add the tracking number here.'
                    : sh.paidBy.toUpperCase() === 'CUSTOMER'
                      ? `Return shipping${sh.cost ? ` of ${formatMoney(sh.cost)}` : ''} is deducted from your refund.`
                      : 'Prepaid. No printer or box label needed.'
                }
              >
                <div className="row gap-5 top">
                  {code && (
                    // The API sends the code the carrier scans (dropOffCode); the app draws the QR (G26a).
                    <div className="stack gap-1 center">
                      <QrCode className="acct-qr" value={code} size={148} label={`Drop-off QR code for ${r.ref}`} />
                      <span className="mono xs">{code}</span>
                    </div>
                  )}
                  <div className="stack gap-3 grow minw-220">
                    <ol className="ol small sub stack gap-2">
                      {sh.instructions.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                      {near && (
                        <li>
                          Nearest: {near.name}, {near.address}
                          {near.distanceMiles != null ? ` (${near.distanceMiles} mi)` : ''}.
                        </li>
                      )}
                    </ol>
                    {getLabel && (
                      <div className="row gap-2">
                        <Button variant="secondary" size="sm" icon={email.isSuccess ? 'check' : 'mail'} onClick={() => email.mutate()} disabled={email.isSuccess || email.isPending}>
                          {email.isSuccess ? 'Code emailed' : 'Email me the code'}
                        </Button>
                        {sh.labelUrl && (
                          <Button variant="ghost" size="sm" icon="printer" href={sh.labelUrl}>
                            Print label instead
                          </Button>
                        )}
                        {sh.qrCodeUrl && (
                          <Button variant="ghost" size="sm" icon="external-link" href={sh.qrCodeUrl}>
                            Open drop-off link
                          </Button>
                        )}
                      </div>
                    )}
                    {email.isError && <span className="xs t-danger-text">{errorMessage(email.error)}</span>}
                    {sh.to && (
                      <span className="xs muted">
                        Ships to {sh.to.name}, {sh.to.line1}
                        {sh.to.line2 ? `, ${sh.to.line2}` : ''}, {sh.to.city}, {sh.to.region} {sh.to.postalCode}.
                      </span>
                    )}
                  </div>
                </div>
                {addTracking && (
                  <>
                    <hr />
                    <AddTrackingForm r={r} />
                  </>
                )}
              </Card>
            </>
          )}

          {refundSent && refund && (
            <Alert tone="success" title={`Refund of ${refund.breakdown ? formatMoney(refund.breakdown.total) : ''} sent${refund.sentAt ? ` on ${fmtWeekday(refund.sentAt)}` : ''}`}>
              {refund.breakdown ? `Sent to ${refund.breakdown.destination}. ` : ''}
              {refund.explanation}
              {refund.bankReference && (
                <>
                  {' '}
                  If it isn't there{refund.expectedBy ? ` by ${fmtWeekday(refund.expectedBy)}` : ' soon'}, ask your bank about reference <span className="mono">{refund.bankReference}</span>.
                </>
              )}
            </Alert>
          )}
          {refund?.status.toUpperCase() === 'FAILED' && (
            <Alert tone="danger" title="Your refund couldn't be sent">
              {refund.failedReason ?? refund.explanation}
            </Alert>
          )}

          {repl && (
            <>
              <Alert tone="success" title={repl.shipment ? 'Your replacement has shipped' : 'Your replacement is being prepared'}>
                {repl.chargeNote ?? 'You chose a replacement, so no refund is due.'} Order{' '}
                <Link className="mono" to={orderHref(r.orderRef)}>
                  {r.orderRef}
                </Link>{' '}
                stays as it was: same receipt, same total.
              </Alert>
              <Card
                title="Replacement shipment"
                sub="Its own shipment record, separate from your return and from the original delivery"
                foot={
                  <>
                    <span className="xs muted grow">
                      If the replacement arrives damaged, report it from this page.{repl.newReturnWindowEnds ? ` It can be returned until ${fmtWeekday(repl.newReturnWindowEnds)}.` : ''}
                    </span>
                    <Button variant="ghost" size="sm" to={href('help/order-problem', '', undefined, { order: r.orderRef })}>
                      Report a problem
                    </Button>
                  </>
                }
              >
                <div className="row gap-3 nowrap top">
                  <Img icon="package" tint="2" className="thumb" src={r.items[0]?.imageUrl ?? undefined} alt="" />
                  <div className="stack gap-1 grow">
                    <span className="small strong">{repl.title}</span>
                    <span className="xs muted">{[...repl.options.map((o) => o.value), `Qty ${repl.quantity}`, `Replacement for return ${r.ref}`].join(' · ')}</span>
                    <SellerLineApi seller={seller} />
                  </div>
                  <StatusBadge status={repl.shipment?.statusLabel ?? humanize(repl.status)} tone={stateTone(repl.shipment?.status ?? repl.status)} />
                </div>
                {repl.shipment && (
                  <>
                    <div className="grid md3 gap-3">
                      <div className="panel stack gap-1">
                        <span className="acct-k">Estimated delivery</span>
                        <span className="small strong">{repl.shipment.deliveredAt ? `Delivered ${fmtWeekday(repl.shipment.deliveredAt)}` : (repl.shipment.estimateLabel ?? 'Estimate pending')}</span>
                      </div>
                      <div className="panel stack gap-1">
                        <span className="acct-k">Carrier</span>
                        <span className="small strong">{repl.shipment.serviceName ?? repl.shipment.carrierName ?? '–'}</span>
                      </div>
                      {repl.shipment.trackingNumber && (
                        <div className="panel stack gap-1">
                          <span className="acct-k">Tracking number</span>
                          <span className="row gap-1 nowrap">
                            <span className="mono small strong">{repl.shipment.trackingNumber}</span>
                            <CopyButton text={repl.shipment.trackingNumber} label="Copy tracking number" />
                          </span>
                        </div>
                      )}
                    </div>
                    <Track labels={repl.shipment.steps} done={repl.shipment.currentStep + 1} />
                    <Timeline events={repl.shipment.events.map((e, i) => ({ t: e.label, d: [fmtDateTime(e.at), e.location].filter(Boolean).join(' · '), state: i === 0 && !repl.shipment!.deliveredAt ? 'current' : 'done', body: e.detail ?? undefined }))} />
                  </>
                )}
              </Card>
            </>
          )}

          {sh ? (
            <Card title="Return shipment" titleAs={waiting || repl ? 'h3' : 'h2'} sub="Separate from the original delivery">
              <div className="row between">
                <span className="stack gap-0">
                  <span className="small strong">
                    {sh.service ?? sh.carrier}
                    {sh.trackingNumber && (
                      <>
                        {' '}
                        · <span className="mono">{sh.trackingNumber}</span>
                      </>
                    )}
                  </span>
                  {sh.from && sh.to && (
                    <span className="xs muted">
                      From {sh.from.city}, {sh.from.region} to {sh.to.city}, {sh.to.region}
                    </span>
                  )}
                </span>
                {waiting ? <Badge>Waiting for drop-off</Badge> : <StatusBadge status={humanize(sh.status)} tone={stateTone(sh.status)} />}
              </div>
              <Timeline events={shipmentEvents} />
            </Card>
          ) : (
            <Card title="What's happened so far" titleAs="h2">
              <Timeline events={shipmentEvents} />
            </Card>
          )}
        </div>

        <aside>
          {isReplacement ? (
            <>
              <Card title="Remedy" titleAs="h3">
                <div className="row between">
                  <span className="small sub">You chose</span>
                  <Badge tone="brand" icon="refresh-cw">
                    Replacement
                  </Badge>
                </div>
                <SummaryRow k="Item returned" v={formatMoney(itemTotal)} />
                <SummaryRow k="Replacement sent" v={repl?.chargeNote ?? 'Same item, no charge'} />
                <SummaryRow k="Return shipping" v={sh && sh.paidBy.toUpperCase() === 'CUSTOMER' && sh.cost ? formatMoney(sh.cost) : 'Free'} />
                <hr />
                <SummaryRow className="total" k="Refund due" v={formatMoney(refund?.breakdown?.total ?? { amount: 0, currency: itemTotal.currency })} />
                <span className="xs muted">No refund is due because you're getting the same item again. Nothing changes on your card or on the original order.</span>
              </Card>
              {r.order && (
                <Card title="Original order" titleAs="h3">
                  <div className="row between">
                    <Link className="mono small strong" to={orderHref(r.order.ref)}>
                      {r.order.ref}
                    </Link>
                    <StatusBadge status={r.order.statusLabel} tone={stateTone(r.order.status)} />
                  </div>
                  <span className="xs sub">
                    Placed {fmtWeekday(r.order.placedAt)} · {formatMoney(r.order.totals.total)} · unchanged.
                  </span>
                </Card>
              )}
            </>
          ) : (
            <Card title="Refund" titleAs="h3">
              <div className="row between">
                <span className="small sub">Refund status</span>
                <StatusBadge status={refund?.statusLabel ?? 'Not started'} tone={refundTone(refund?.status)} />
              </div>
              <Track labels={refund ? refund.track.map((t) => t.label) : REFUND_STEPS} done={refund ? trackDone(refund.track) : 0} tone={refund?.status.toUpperCase() === 'FAILED' ? 'danger' : undefined} />
              <span className="xs sub">
                {refund?.explanation ?? "The refund starts when the item arrives and is inspected. Approved still means the money hasn't been sent. Sent means it left Marketly."}
              </span>
              <hr />
              {bd ? (
                <>
                  <SummaryRow k="Item" v={formatMoney(bd.itemAmount)} />
                  {bd.discountShare.amount > 0 && <SummaryRow k="Discount share" v={`−${formatMoney(bd.discountShare)}`} />}
                  {bd.shippingRefund.amount > 0 && <SummaryRow k="Shipping refund" v={formatMoney(bd.shippingRefund)} />}
                  <SummaryRow k="Return shipping" v={bd.returnShippingDeduction.amount ? `−${formatMoney(bd.returnShippingDeduction)}` : 'Free'} />
                  {bd.deductions.map((d, i) => (
                    <SummaryRow key={i} k={d.label} v={`−${formatMoney(d.amount)}`} />
                  ))}
                  <hr />
                  <SummaryRow className="total" k={refundSent ? 'Refunded' : bd.isEstimate ? 'Expected refund' : 'Refund'} v={formatMoney(bd.total)} />
                  <SummaryRow k="To" v={bd.destination} />
                  {!refund && bd.isEstimate && <span className="xs muted">An estimate until the item is inspected.</span>}
                </>
              ) : (
                <>
                  <SummaryRow k="Item" v={formatMoney(itemTotal)} />
                  <SummaryRow k="Return shipping" v={sh && sh.paidBy.toUpperCase() === 'CUSTOMER' && sh.cost ? `−${formatMoney(sh.cost)}` : 'Free'} />
                  <hr />
                  <SummaryRow className="total" k="Expected refund" v="After inspection" />
                </>
              )}
            </Card>
          )}
          <Card title="Questions about this return?" titleAs="h3">
            <div className="stack gap-2">
              <Button variant="secondary" block icon="message-square" to={href('account/messages', '', undefined, r.conversation ? { conversation: r.conversation.id } : { order: r.orderRef })}>
                Message {r.conversation?.counterparty.name ?? r.sellerName}
              </Button>
              {/* Rejected returns offer escalation in the "not approved" alert; a missed deadline or a late refund offers it here. */}
              {escalate && !rejected && <EscalateReturnButton r={r} variant="ghost" block className="btn-wrap" />}
              {r.case ? (
                <Button variant="ghost" block icon="life-buoy" to={caseHref(r.case.ref)} className="btn-wrap">
                  View support case {r.case.ref}
                </Button>
              ) : canDo(r, 'REPORT_PROBLEM') ? (
                // Problems with an open return go through a support case (help/order-problem), the backend's route for them.
                <Button variant="ghost" block icon="flag" to={href('help/order-problem', '', undefined, { order: r.orderRef, ...(r.items[0] ? { item: r.items[0].orderItemId } : {}) })}>
                  Report a problem
                </Button>
              ) : (
                <Button variant="ghost" block icon="life-buoy" to={href('help/order-problem', '', undefined, { order: r.orderRef })}>
                  Open a support case
                </Button>
              )}
            </div>
          </Card>
          {canDo(r, 'WITHDRAW') && (
            <Card title="Changed your mind?" titleAs="h3">
              <span className="xs sub">You can withdraw the return until the item is on its way back. You keep the item and no refund is made.</span>
              <WithdrawReturnButton r={r} variant="secondary" block />
            </Card>
          )}
        </aside>
      </div>
    </AccountLayout>
  );
}
