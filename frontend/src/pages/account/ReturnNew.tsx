import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi, uploadMedia } from '@marketly/web-shared/api';
import { AccountLayout } from '@/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, type MoneyValue } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Card, Field, FileDrop, Icon, Img, KeyValue, OptionCard, Select, StatusBadge, Steps, SummaryRow, TableWrap, Textarea } from '@marketly/web-shared/ui';
import { fmtDay, fmtWeekday, humanize, orderHref, productHref, returnHref, stateTone, useOrderDetail, type OrderDetail } from './data/orders';
import { DetailSkeleton, LoadError, NotFoundCard, SellerLineApi, SkeletonRows } from './data/order-parts';

// Design: pages/store/account-return-new.html · a 3-step wizard: "" = choose items,
// "reason-and-remedy" = what's wrong + what you want, "review" = check and submit.
// Data: OrderDetail (ref → id, item details), GET returns/orders/{orderId}/returnable-items (per-item
// eligibility), POST returns/eligibility (destination, who pays, remedies, refund estimate),
// GET returns/policy, media uploads (purpose return_evidence) and POST returns/requests with an
// Idempotency-Key (one return per seller; opens the first one).

type Step = '' | 'reason-and-remedy' | 'review';
const STEP_INDEX: Record<Step, number> = { '': 0, 'reason-and-remedy': 1, review: 2 };

type Reason = 'defective' | 'damaged' | 'wrong_item' | 'not_as_described' | 'missing_parts' | 'changed_mind' | 'better_price' | 'no_longer_needed' | 'wrong_size' | 'other';
const REASONS: Array<{ value: Reason | ''; label: string }> = [
  { value: '', label: 'Choose a reason' },
  { value: 'defective', label: 'Defective or stopped working' },
  { value: 'damaged', label: 'Arrived damaged' },
  { value: 'wrong_item', label: 'Wrong item sent' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'missing_parts', label: 'Missing parts' },
  { value: 'wrong_size', label: "Wrong size or doesn't fit" },
  { value: 'changed_mind', label: 'Changed my mind' },
  { value: 'better_price', label: 'Better price elsewhere' },
  { value: 'no_longer_needed', label: 'No longer needed' },
  { value: 'other', label: 'Other' },
];
/** Change-of-mind reasons: details are optional and the shopper may pay return shipping. */
const CHANGE_OF_MIND: Reason[] = ['changed_mind', 'better_price', 'no_longer_needed', 'wrong_size'];

type Remedy = 'refund' | 'replacement' | 'store_credit';
const REMEDY_TEXT: Record<Remedy, { title: string; want: string }> = {
  refund: { title: 'Refund to original payment', want: 'Refund to your original payment' },
  replacement: { title: 'Replacement', want: 'Replacement, same item' },
  store_credit: { title: 'Marketly store credit', want: 'Marketly store credit' },
};
const PAID_BY: Record<string, string> = { seller: 'Seller (free label)', platform: 'Marketly (free label)' };

interface Photo {
  id: string;
  name: string;
  src?: string;
  status: 'uploading' | 'ready' | 'failed';
  assetId?: string;
  error?: string;
}

function returnError(e: unknown) {
  if (e instanceof ApiError) {
    if (e.code === 'RETURN_NOT_ELIGIBLE') return 'One of these items can no longer be returned. Go back to the first step to check your items.';
    if (e.code === 'RETURN_WINDOW_CLOSED') return 'The return window for this item has ended.';
    if (e.code === 'QUANTITY_EXCEEDS_RETURNABLE') return 'You asked to return more units than can still be returned.';
    if (e.code === 'REMEDY_NOT_AVAILABLE') return "That option isn't available for this item. Choose another one.";
  }
  return errorMessage(e);
}

const sumMoney = (list: MoneyValue[]): MoneyValue => ({ amount: list.reduce((s, m) => s + m.amount, 0), currency: list[0]?.currency ?? 'USD' });

export default function ReturnNew() {
  const { ref = '' } = useParams();
  const q = useOrderDetail(ref);
  const order = q.data;
  const crumbs = <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: ref, to: orderHref(ref) }, { label: 'Request a return' }]} />;
  if (q.isPending || q.isError || !order) {
    return (
      <AccountLayout active="orders" title="Request a return">
        {crumbs}
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
  return <Wizard order={order} crumbs={crumbs} />;
}

function Wizard({ order, crumbs }: { order: OrderDetail; crumbs: ReactNode }) {
  const { api, session } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [view, setView] = useView<Exclude<Step, ''>>();
  const returnable = useQuery({
    queryKey: ['returns', 'returnable', order.id],
    queryFn: () => call(api.GET('/api/store/returns/orders/{orderId}/returnable-items', { params: { path: { orderId: order.id } } })),
  });
  const policy = useQuery({ queryKey: ['returns', 'policy'], queryFn: () => call(api.GET('/api/store/returns/policy')) });
  const lines = returnable.data?.items ?? [];
  const eligibleLines = lines.filter((l) => l.eligible && l.quantityReturnable > 0);
  const orderItems = order.groups.flatMap((g) => g.items.map((i) => ({ i, g })));

  const [picked, setPicked] = useState<string[] | null>(null);
  const pre = params.get('item');
  const selected = picked ?? (pre ? [pre] : eligibleLines[0] ? [eligibleLines[0].item.orderItemId] : []);
  const [qty, setQty] = useState<Record<string, number>>({});
  const chosen = eligibleLines.filter((l) => selected.includes(l.item.orderItemId));
  const items = chosen.map((l) => ({ orderItemId: l.item.orderItemId, quantity: Math.min(qty[l.item.orderItemId] ?? 1, l.quantityReturnable) }));
  const [reason, setReason] = useState<Reason | ''>('');
  const [details, setDetails] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [remedy, setRemedy] = useState<Remedy>('refund');
  const [attempted, setAttempted] = useState<Record<number, boolean>>({});
  const attemptRef = useRef<{ body: string; key: string } | null>(null);

  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => photosRef.current.forEach((p) => p.src && URL.revokeObjectURL(p.src)), []);

  const changeOfMind = !!reason && CHANGE_OF_MIND.includes(reason);
  const detailsOk = changeOfMind || details.trim().length >= 10;
  const rawStep = (view in STEP_INDEX ? view : '') as Step;
  // Steps need what the earlier steps collect (a link straight to "review" starts where data is missing).
  const step: Step = rawStep !== '' && (returnable.isSuccess && chosen.length === 0) ? '' : rawStep === 'review' && (!reason || !detailsOk) ? 'reason-and-remedy' : rawStep;

  const elig = useQuery({
    queryKey: ['returns', 'eligibility', order.id, items, reason, remedy],
    queryFn: () => call(api.POST('/api/store/returns/eligibility', { body: { orderId: order.id, items, reason: reason || undefined, remedy } })),
    enabled: step !== '' && items.length > 0,
    placeholderData: (prev) => prev,
  });
  const groups = elig.data?.groups ?? [];
  const remedyState = (kind: Remedy) => {
    const all = groups.map((g) => g.remedies.find((r) => r.kind === kind));
    return { available: all.length > 0 && all.every((r) => r?.available), description: all[0]?.description, reason: all.find((r) => r && !r.available)?.unavailableReason ?? undefined };
  };

  const submit = useMutation({
    mutationFn: () => {
      const body = { orderId: order.id, items, reason: reason as Reason, details: details.trim(), mediaIds: photos.filter((p) => p.assetId).map((p) => p.assetId!), remedy };
      const text = JSON.stringify(body);
      if (!attemptRef.current || attemptRef.current.body !== text) attemptRef.current = { body: text, key: newIdempotencyKey() };
      return call(api.POST('/api/store/returns/requests', { params: { header: { 'Idempotency-Key': attemptRef.current.key } }, body }));
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['returns'] });
      void qc.invalidateQueries({ queryKey: ['customers', 'overview'] });
      const first = res.returns[0];
      navigate(first ? returnHref(first.ref) : href('account/returns'));
    },
  });

  const err1 = attempted[0] && chosen.length === 0 ? 'Choose at least one item to return.' : undefined;
  const errReason = attempted[1] && !reason ? 'Choose a reason.' : undefined;
  const errDetails = attempted[1] && !detailsOk ? 'Describe the problem in a sentence or two.' : undefined;
  const uploading = photos.some((p) => p.status === 'uploading');

  const go = (s: Step) => {
    setView(s);
    window.scrollTo({ top: 0 });
  };
  const next = () => {
    if (step === '') {
      setAttempted((a) => ({ ...a, 0: true }));
      if (chosen.length) go('reason-and-remedy');
    } else if (step === 'reason-and-remedy') {
      setAttempted((a) => ({ ...a, 1: true }));
      if (reason && detailsOk && !uploading) go('review');
    } else if (!submit.isPending) {
      submit.mutate();
    }
  };
  const back = () => (step === 'review' ? go('reason-and-remedy') : go(''));
  const addFiles = (files: File[]) => {
    const added: Photo[] = files.map((f, i) => ({ id: `${Date.now()}-${i}`, name: f.name, src: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined, status: 'uploading' }));
    setPhotos((ps) => [...ps, ...added]);
    added.forEach((p, i) => {
      uploadMedia(session, files[i]!, 'return_evidence').then(
        (asset) => setPhotos((ps) => ps.map((x) => (x.id === p.id ? { ...x, status: 'ready', assetId: asset.id } : x))),
        (e: unknown) => setPhotos((ps) => ps.map((x) => (x.id === p.id ? { ...x, status: 'failed', error: e instanceof Error && !(e instanceof ApiError) ? e.message : errorMessage(e) } : x))),
      );
    });
  };

  const backBtn =
    step === '' ? (
      <Button variant="ghost" to={orderHref(order.ref)}>
        Cancel
      </Button>
    ) : (
      <Button variant="ghost" onClick={back}>
        Back
      </Button>
    );
  const nextBtn =
    step === 'review' ? (
      <Button icon="check" onClick={next} disabled={submit.isPending || !elig.data || groups.some((g) => !g.eligible)}>
        {submit.isPending ? 'Sending request…' : 'Request return'}
      </Button>
    ) : (
      <Button iconRight="arrow-right" onClick={next} disabled={step === 'reason-and-remedy' && uploading}>
        Continue
      </Button>
    );
  const nav = (
    <>
      {backBtn}
      {nextBtn}
    </>
  );
  const actionBar = (
    <>
      {backBtn}
      <span className="grow" />
      {nextBtn}
    </>
  );

  const eligibility = (
    <>
      {elig.isError && <LoadError error={elig.error} onRetry={() => void elig.refetch()} />}
      {!elig.data && elig.isFetching && (
        <section className="acct-eligible" aria-label="Return eligibility">
          <SkeletonRows rows={2} thumb={false} />
        </section>
      )}
      {groups.map((g) => (
        <section key={g.sellerId ?? g.sellerName} className="acct-eligible" aria-label="Return eligibility">
          <div className="row gap-2">
            <Icon name={g.eligible ? 'circle-check' : 'circle-x'} />
            <span className="strong">{g.eligible ? (items.length > 1 ? 'These items can be returned' : 'This item can be returned') : (g.items.find((i) => !i.eligible)?.message ?? "This item can't be returned")}</span>
          </div>
          <KeyValue
            pairs={[
              [
                'Return by',
                <>
                  {fmtDay(g.returnBy)} <span className="xs muted">({g.terms.windowDays} days after delivery)</span>
                </>,
              ],
              ['Ships back to', `${g.destination.name}, ${g.destination.address.city}, ${g.destination.address.region}`],
              [
                'Return shipping',
                g.shippingPaidBy === 'customer' ? (
                  <>{g.returnShippingCost ? `${formatMoney(g.returnShippingCost)} is deducted from your refund.` : 'You pay return shipping.'}</>
                ) : (
                  <>
                    <span className="t-success-text strong">Free</span> for this return.
                  </>
                ),
              ],
              ['Response', `${g.responseBy} reviews within ${g.responseDueBusinessDays} business day${g.responseDueBusinessDays === 1 ? '' : 's'}.`],
            ]}
          />
        </section>
      ))}
    </>
  );

  let body: ReactNode;
  if (step === '') {
    body = (
      <>
        <div className="stack gap-4">
          {err1 ? (
            <Alert tone="danger" title="Choose the items to return">
              {err1} Only delivered items can be returned.
            </Alert>
          ) : (
            <Alert tone="info" title="Choose the items to return">
              Only delivered items can be returned. Items from different sellers become separate returns, each with its own label.
            </Alert>
          )}
          {returnable.isError && <LoadError error={returnable.error} onRetry={() => void returnable.refetch()} />}
          <section className="card" aria-label="Delivered items">
            {returnable.isPending && <SkeletonRows rows={3} />}
            {lines.map((l) => {
              const id = l.item.orderItemId;
              const oi = orderItems.find((x) => x.i.id === id)?.i;
              const ok = l.eligible && l.quantityReturnable > 0;
              return (
                <div key={id} className={cx('acct-check', !ok && 'is-off')}>
                  <input type="checkbox" id={`rn-${id}`} aria-label={`Return ${l.item.title}`} checked={ok && selected.includes(id)} disabled={!ok} onChange={() => setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])} />
                  <Img icon="package" tint="2" className="thumb" src={l.item.imageUrl ?? oi?.image?.url} alt="" />
                  <div className="stack gap-1">
                    <label htmlFor={`rn-${id}`} className="small strong">
                      {l.item.title}
                    </label>
                    <span className="xs muted">
                      {oi?.variantLabel ? `${oi.variantLabel} · ` : ''}
                      {formatMoney(l.item.unitPrice)} · {l.sellerName}
                    </span>
                    <span className="row gap-2">
                      <StatusBadge status={oi?.stateLabel ?? l.itemState} tone={stateTone(oi?.state ?? l.itemState.replace(/ /g, '_'))} />
                      <span className="xs sub">{l.message}</span>
                    </span>
                  </div>
                  <div className="side">
                    {ok ? (
                      <div style={{ maxWidth: '120px' }}>
                        <Field label="Quantity">
                          <Select
                            id={`rn-qty-${id}`}
                            options={Array.from({ length: l.quantityReturnable }, (_, i) => String(i + 1))}
                            value={String(Math.min(qty[id] ?? 1, l.quantityReturnable))}
                            disabled={!selected.includes(id)}
                            onChange={(e) => setQty((q) => ({ ...q, [id]: Number(e.target.value) }))}
                          />
                        </Field>
                      </div>
                    ) : (
                      <span className="xs muted">Not available</span>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
          <p className="xs muted">
            Order{' '}
            <Link className="mono" to={orderHref(order.ref)}>
              {order.ref}
            </Link>{' '}
            · placed {fmtWeekday(order.placedAt)}. Want to return something from another order?{' '}
            <Link to={href('account/orders')} className="link-inline">
              Pick an order
            </Link>
            .
          </p>
          <div className="row between only-desktop">{nav}</div>
        </div>
        <aside>
          <Card title="Return policy">
            <ul className="ul small sub stack gap-1">
              <li>{policy.data ? `${policy.data.windowDays} days from delivery for most items.` : 'Most items can be returned after delivery.'}</li>
              <li>Official Store returns are free for defects and damage.</li>
              <li>Refunds cover the item, its share of discounts and any shipping you paid.</li>
            </ul>
            <Link className="small strong" to={href('info/policy')}>
              Full returns policy
            </Link>
          </Card>
        </aside>
      </>
    );
  } else if (step === 'reason-and-remedy') {
    const terms = groups[0]?.terms;
    const fault = terms?.responsibilities.find((r) => r.reasonGroup === 'defective');
    const com = terms?.responsibilities.find((r) => r.reasonGroup === 'change_of_mind');
    const paid = (r?: { paidBy: string; customerFee?: MoneyValue | null }) => (!r ? '' : r.paidBy === 'customer' ? `You${r.customerFee ? ` (${formatMoney(r.customerFee)} deducted from refund)` : ''}` : PAID_BY[r.paidBy] ?? humanize(r.paidBy));
    body = (
      <>
        <div className="stack gap-4">
          {chosen.map((l) => {
            const x = orderItems.find((o) => o.i.id === l.item.orderItemId);
            const n = Math.min(qty[l.item.orderItemId] ?? 1, l.quantityReturnable);
            const to = productHref(l.item.productId, l.item.title);
            return (
              <div key={l.item.orderItemId} className="row gap-3 nowrap top card pad">
                <Link to={to} aria-label={l.item.title}>
                  <Img icon="package" tint="2" className="thumb" src={l.item.imageUrl ?? x?.i.image?.url} alt="" />
                </Link>
                <div className="stack gap-1">
                  <Link className="small strong link-plain" to={to}>
                    {l.item.title}
                  </Link>
                  <span className="xs muted">
                    {x?.i.variantLabel ? `${x.i.variantLabel} · ` : ''}Qty {n} · {formatMoney({ amount: l.item.unitPrice.amount * n, currency: l.item.unitPrice.currency })}
                  </span>
                  {x && <SellerLineApi seller={x.g.seller} />}
                </div>
              </div>
            );
          })}
          <Card title="What's wrong?">
            <Field label="Reason" hint={errReason ? undefined : 'Who pays return shipping depends on the reason.'} error={errReason}>
              <Select id="rn-reason" options={REASONS} value={reason} onChange={(e) => setReason(e.target.value as Reason | '')} className={cx(errReason && 'is-error')} />
            </Field>
            <Field label="Tell us more" optional={changeOfMind} hint={errDetails ? undefined : 'Helps the reviewer decide faster.'} error={errDetails}>
              <Textarea id="rn-details" placeholder="" value={details} onChange={(e) => setDetails(e.target.value)} className={cx(errDetails && 'is-error')} maxLength={2000} />
            </Field>
            <div className="field">
              <span className="label">
                Photos or video <span className="opt">(optional)</span>
              </span>
              {photos.length > 0 && (
                <div className="row gap-2">
                  {photos.map((ph) => (
                    <span key={ph.id} className="stack gap-0" title={ph.error ?? ph.name}>
                      <Img icon={ph.status === 'failed' ? 'circle-x' : 'image'} tint="2" className="thumb" src={ph.src} alt={ph.name} />
                      {ph.status === 'uploading' && <span className="xs muted">Uploading…</span>}
                      {ph.status === 'failed' && <span className="xs t-danger-text">Failed</span>}
                    </span>
                  ))}
                </div>
              )}
              <FileDrop title="Add photos or a short video" hint="JPG, PNG, WebP, HEIC or MP4, up to 15 MB each" accept="image/jpeg,image/png,image/webp,image/heic,video/mp4" onFiles={addFiles} />
              {photos.some((p) => p.status === 'failed') && <span className="xs t-danger-text">{photos.find((p) => p.status === 'failed')?.error}</span>}
            </div>
            {fault && com && (
              <TableWrap label="What's wrong? table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Reason</th>
                      <th scope="col">Return shipping paid by</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Defective, damaged, wrong item, not as described</td>
                      <td>{paid(fault)}</td>
                    </tr>
                    <tr>
                      <td>Changed my mind, better price</td>
                      <td>{paid(com)}</td>
                    </tr>
                  </tbody>
                </table>
              </TableWrap>
            )}
            {terms && <span className="xs muted">{com?.officialStoreRule ? `${terms.summary}. ${com.officialStoreRule}.` : com?.note ? `${terms.summary}. ${com.note}.` : terms.summary}</span>}
          </Card>
          <Card title="What would you like?" titleAs="h3">
            <div className="stack gap-2" role="radiogroup" aria-label="Remedy">
              {(Object.keys(REMEDY_TEXT) as Remedy[]).map((k) => {
                const st = remedyState(k);
                return (
                  <OptionCard
                    key={k}
                    id={`rn-rem-${k}`}
                    name="rn-rem"
                    checked={remedy === k}
                    disabled={!!elig.data && !st.available}
                    onChange={() => setRemedy(k)}
                    title={<span className="strong">{REMEDY_TEXT[k].title}</span>}
                    body={!st.available && st.reason ? st.reason : (st.description ?? '')}
                  />
                );
              })}
            </div>
          </Card>
          <div className="row between only-desktop">{nav}</div>
        </div>
        <aside>{eligibility}</aside>
      </>
    );
  } else {
    const est = groups.map((g) => g.estimate);
    const first = chosen[0];
    const firstSentence = details.trim().split(/(?<=\.)\s/)[0] ?? '';
    const readyPhotos = photos.filter((p) => p.status === 'ready').length;
    const g0 = groups[0];
    const method = g0?.labelMethod === 'prepaid_qr' ? 'Drop-off with a QR code, no printer needed.' : g0?.labelMethod === 'prepaid_label' ? 'Prepaid label to print and attach.' : 'You arrange the shipping and add the tracking number.';
    body = (
      <>
        <div className="stack gap-4">
          {submit.isError && (
            <Alert tone="danger" title="We couldn't send your return request">
              {returnError(submit.error)}
            </Alert>
          )}
          <Card title="Check your request">
            <KeyValue
              pairs={[
                ['Item', chosen.map((l) => `${l.item.title}${orderItems.find((o) => o.i.id === l.item.orderItemId)?.i.variantLabel ? `, ${orderItems.find((o) => o.i.id === l.item.orderItemId)!.i.variantLabel}` : ''} · Qty ${Math.min(qty[l.item.orderItemId] ?? 1, l.quantityReturnable)}`).join('; ')],
                ['Sold by', [...new Set(chosen.map((l) => l.sellerName))].join(', ') || (first?.sellerName ?? '')],
                ['Reason', REASONS.find((r) => r.value === reason)?.label ?? ''],
                ['Details', `${firstSentence || 'None'}${readyPhotos ? ` ${readyPhotos} photo${readyPhotos > 1 ? 's' : ''} attached.` : ''}`],
                ['You want', REMEDY_TEXT[remedy].want],
                ['Send it back', g0 ? `${method} By ${fmtWeekday(g0.returnBy)}.` : '…'],
              ]}
            />
          </Card>
          <Card title="Refund estimate" titleAs="h3">
            {est.length ? (
              <>
                <SummaryRow k="Item price" v={formatMoney(sumMoney(est.map((e) => e.itemAmount)))} />
                <SummaryRow k="Original shipping" v={formatMoney(sumMoney(est.map((e) => e.shippingRefund)))} />
                {sumMoney(est.map((e) => e.discountShare)).amount > 0 && <SummaryRow k="Discount share" v={`−${formatMoney(sumMoney(est.map((e) => e.discountShare)))}`} />}
                <SummaryRow k="Return shipping" v={sumMoney(est.map((e) => e.returnShippingDeduction)).amount ? `−${formatMoney(sumMoney(est.map((e) => e.returnShippingDeduction)))}` : 'Free'} />
                {est.flatMap((e) => e.deductions).map((d, i) => (
                  <SummaryRow key={i} k={d.label} v={`−${formatMoney(d.amount)}`} />
                ))}
                <hr />
                <SummaryRow className="total" k={remedy === 'replacement' ? 'Refund if no replacement' : 'Estimated refund'} v={formatMoney(sumMoney(est.map((e) => e.total)))} />
                <SummaryRow k="Refund to" v={est[0]!.destination} />
                <span className="xs muted">Estimate. The final amount is confirmed after inspection. Order discounts are split across the items in the order by price.</span>
              </>
            ) : elig.isError ? (
              <span className="xs t-danger-text">{errorMessage(elig.error)}</span>
            ) : (
              <SkeletonRows rows={2} thumb={false} />
            )}
          </Card>
          {g0 && (
            <Alert tone="info" title="After you submit">
              {g0.responseBy} reviews within {g0.responseDueBusinessDays} business day{g0.responseDueBusinessDays === 1 ? '' : 's'}. If approved, you get {g0.labelMethod === 'prepaid_qr' ? 'a drop-off QR code' : g0.labelMethod === 'prepaid_label' ? 'a prepaid label' : 'the return address'}. Your refund starts only after the item is received and inspected.
            </Alert>
          )}
          <div className="row between only-desktop">{nav}</div>
        </div>
        <aside>{eligibility}</aside>
      </>
    );
  }

  return (
    <AccountLayout active="orders" title="Request a return" actionBar={actionBar}>
      {crumbs}
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Request a return</h1>
          <p className="small sub">
            Order <span className="mono">{order.ref}</span>
          </p>
        </div>
      </div>
      <Steps items={['Items', 'Reason and remedy', 'Review']} current={STEP_INDEX[step]} />
      <div className="acct-split">{body}</div>
    </AccountLayout>
  );
}
