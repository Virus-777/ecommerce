import { useMutation, useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi, useUploads } from '@marketly/web-shared/api';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { formatMoney, money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, EmptyState, Field, FileDrop, Icon, Img, LogoTile, OptionCard, SellerBadge, StatusBadge, Textarea, type IconName } from '@marketly/web-shared/ui';
import { dateLong, dayDate } from './data/format';
import { LoadError, SkLines, SkRows } from './data/states';
import { UploadList } from './data/UploadList';

// Design: pages/store/help-order-problem.html
// Route: /help/order-problem?order=<MK-ref>&item=<orderItemId> (item optional, preselected). The ref is resolved with GET /api/store/orders/orders?q=<ref>;
// GET /api/store/support/orders/{orderId}/problem-context gives the packages and items, problem types, who
// handles it first, when Marketly steps in, open cases and remedy choices. Photos upload with purpose
// case_evidence; POST /api/store/support/cases (Idempotency-Key) { kind: order_problem, category,
// orderId, orderItemIds, problemType, message, mediaIds, desiredRemedy } → the new case.
// Without ?order the page lists recent orders to pick from.

type ProblemType = 'missing_item' | 'damaged' | 'wrong_item' | 'not_arrived' | 'other';
type Remedy = 'refund' | 'keep_waiting' | 'replacement' | 'other';

const TYPES: Record<ProblemType, { label: string; icon: IconName }> = {
  missing_item: { label: 'Item missing from package', icon: 'package-x' },
  damaged: { label: 'Arrived damaged', icon: 'package-open' },
  wrong_item: { label: 'Wrong item', icon: 'replace' },
  not_arrived: { label: "Hasn't arrived", icon: 'clock' },
  other: { label: 'Something else', icon: 'circle-help' },
};

/** Case category (support.CaseCategory.key) for each problem type. The API takes both and doesn't derive one. */
const CATEGORY: Record<ProblemType, string> = {
  missing_item: 'wrong_item',
  damaged: 'item_damaged',
  wrong_item: 'wrong_item',
  not_arrived: 'delivery_not_arrived',
  other: 'other_help',
};

const PHOTO_REQUIRED: ProblemType[] = ['damaged', 'wrong_item'];

function PickOrder() {
  const { api } = useApi();
  const orders = useQuery({ queryKey: ['orders', 'list', { limit: 10 }], queryFn: () => call(api.GET('/api/store/orders/orders', { params: { query: { limit: 10, page: 1 } } })) });
  return (
    <section className="card">
      <div className="card-head">
        <div className="stack gap-0">
          <h2 className="h4">Which order is it about?</h2>
          <span className="xs muted">Pick the order. The items are filled in for you.</span>
        </div>
      </div>
      <div>
        {orders.isPending ? (
          <SkRows n={4} />
        ) : orders.isError ? (
          <div className="card-body">
            <LoadError error={orders.error} retry={() => void orders.refetch()} />
          </div>
        ) : orders.data.items.length === 0 ? (
          <div className="card-body">
            <span className="small sub">You haven’t placed any orders yet.</span>
          </div>
        ) : (
          orders.data.items.map((o) => (
            <Link key={o.id} className="buy-order-pick" to={href('help/order-problem', '', undefined, { order: o.ref })}>
              <span className="buy-thumbs">
                {o.thumbnails.slice(0, 3).map((t, i) => (
                  <Img key={t.id ?? i} icon="package" src={t.url} alt={t.alt ?? ''} />
                ))}
              </span>
              <span className="stack gap-0 grow">
                <span className="small strong mono">{o.ref}</span>
                <span className="xs muted">
                  {dateLong(o.placedAt)} · {o.itemCount} item{o.itemCount === 1 ? '' : 's'}
                </span>
              </span>
              <StatusBadge status={o.statusLabel} />
            </Link>
          ))
        )}
      </div>
    </section>
  );
}

export default function OrderProblem() {
  const { api } = useApi();
  const { signedIn, ready } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const ref = params.get('order') ?? '';
  const itemParam = params.get('item') ?? '';

  const lookup = useQuery({
    queryKey: ['orders', 'by-ref', ref],
    queryFn: async () => {
      const r = await call(api.GET('/api/store/orders/orders', { params: { query: { q: ref, limit: 5, page: 1 } } }));
      const hit = r.items.find((o) => o.ref === ref);
      if (!hit) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
      return hit;
    },
    enabled: Boolean(ref) && signedIn,
  });
  const orderId = lookup.data?.id ?? '';
  const ctx = useQuery({
    queryKey: ['support', 'problem-context', orderId],
    queryFn: () => call(api.GET('/api/store/support/orders/{orderId}/problem-context', { params: { path: { orderId } } })),
    enabled: Boolean(orderId),
  });
  const topics = useQuery({ queryKey: ['support', 'contact-options'], queryFn: () => call(api.GET('/api/store/support/contact-options')), staleTime: 300_000 });

  const [selected, setSelected] = useState<string[]>([]);
  const [type, setType] = useState<ProblemType | ''>('');
  const [details, setDetails] = useState('');
  const photos = useUploads('case_evidence', { max: 10, accept: /\.(jpe?g|png|webp|heic)$|^image\//i });
  const [remedy, setRemedy] = useState<Remedy | ''>('');
  const [attempted, setAttempted] = useState(false);
  const idem = useRef(newIdempotencyKey());

  const c = ctx.data;
  const initFor = useRef('');
  useEffect(() => {
    if (c && initFor.current !== c.order.id) {
      initFor.current = c.order.id;
      const known = c.packages.some((p) => p.items.some((it) => it.orderItemId === itemParam));
      setSelected(Array.from(new Set([...c.preselectedItemIds, ...(known ? [itemParam] : [])])));
    }
  }, [c, itemParam]);

  const lines = (c?.packages ?? []).flatMap((p) => p.items.map((it) => ({ ...it, pkg: p })));
  const chosen = lines.filter((l) => selected.includes(l.orderItemId));
  const refund = chosen.reduce((s, l) => s + (l.price.amount / 100) * l.quantity, 0);
  const handlerNames = Array.from(new Set(chosen.map((l) => l.sellerName)));
  const handler = handlerNames.length === 1 ? chosen[0] : null;
  const handlerOfficial = handler?.ownerType === 'official';
  const lateWarning = type === 'not_arrived' ? Array.from(new Set(chosen.map((l) => l.pkg.warning).filter(Boolean))) : [];
  const openCaseFor = (id: string) => c?.openCases.find((o) => o.orderItemIds.includes(id));
  const choices = c?.remedyChoices ?? [];
  const activeRemedy = remedy && choices.some((r) => r.kind === remedy) ? remedy : (choices[0]?.kind ?? '');

  const errors: { items?: string; type?: string; details?: string; photos?: string } = {};
  if (attempted) {
    if (!selected.length) errors.items = 'Select at least one item.';
    if (!type) errors.type = "Choose what's wrong.";
    if (!details.trim()) errors.details = 'Describe the problem so the seller can help.';
    if (type && PHOTO_REQUIRED.includes(type) && !photos.items.length) errors.photos = 'Add at least one photo of the item.';
    else if (photos.uploading) errors.photos = 'Wait for the photos to finish uploading.';
    else if (photos.failed) errors.photos = 'Remove the photos that failed to upload, or add them again.';
  }
  const nErrors = Object.keys(errors).length;

  const create = useMutation({
    mutationFn: () => {
      const t = type as ProblemType;
      const known = topics.data?.topics.map((x) => x.key) ?? [];
      const category = known.length && !known.includes(CATEGORY[t]) ? (known.includes('other_help') ? 'other_help' : known[0]) : CATEGORY[t];
      return call(
        api.POST('/api/store/support/cases', {
          params: { header: { 'Idempotency-Key': idem.current } },
          body: {
            kind: 'order_problem',
            category,
            orderId,
            orderItemIds: selected,
            problemType: t,
            message: details.trim(),
            mediaIds: photos.assetIds.length ? photos.assetIds : undefined,
            desiredRemedy: activeRemedy || undefined,
          },
        }),
      );
    },
    onSuccess: (cs) => {
      idem.current = newIdempotencyKey();
      navigate(href('help/case', '', { ref: cs.ref }));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status < 500) idem.current = newIdempotencyKey();
    },
  });
  const duplicate = create.error instanceof ApiError && create.error.code === 'DUPLICATE_CASE' ? String(create.error.details.ref ?? '') : '';

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const submit = () => {
    setAttempted(true);
    const bad = !selected.length || !type || !details.trim() || (type && PHOTO_REQUIRED.includes(type) && !photos.items.length) || photos.uploading || photos.failed;
    if (!bad) create.mutate();
  };

  const orderTo = ref ? href('account/order', '', { ref }) : href('account/orders');
  const layout = (body: ReactNode) => (
    <StoreLayout tab="account" appbar={{ title: 'Report a problem', back: orderTo }}>
      <div className="container page">
        <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, ...(ref ? [{ label: ref, to: orderTo }] : []), { label: 'Report a problem' }]} />
        {body}
      </div>
    </StoreLayout>
  );

  if (ready && !signedIn) {
    return layout(
      <EmptyState icon="user-round" title="Sign in to report a problem" as="h1" action={<Button to={href('auth/sign-in', '', undefined, { next: location.pathname + location.search })}>Sign in</Button>}>
        Order problems are reported from your account so the seller can see the order. Guests can use the{' '}
        <Link to={href('auth/guest-orders')} className="link-inline">
          guest order lookup
        </Link>
        .
      </EmptyState>,
    );
  }
  if (!ref) {
    return layout(
      <div className="stack gap-4">
        <h1 className="h1">Report a problem</h1>
        <PickOrder />
      </div>,
    );
  }
  const notFound = lookup.error instanceof ApiError && lookup.error.status === 404;
  if (notFound || (ctx.error instanceof ApiError && ctx.error.status === 404)) {
    return layout(
      <EmptyState icon="package-x" title="We couldn’t find that order" as="h1" action={<Button to={href('help/order-problem')}>Choose an order</Button>}>
        Check the order number in your order confirmation, or pick the order from your list.
      </EmptyState>,
    );
  }
  if (lookup.isError || ctx.isError) {
    const e = lookup.error ?? ctx.error;
    return layout(<LoadError error={e} retry={() => void (lookup.isError ? lookup.refetch() : ctx.refetch())} title="We couldn’t load this order" />);
  }

  return layout(
    <div className="split">
      <div className="stack gap-4">
        <div className="stack gap-1">
          <h1 className="h1">Report a problem</h1>
          <p className="small sub">
            Order <span className="mono">{ref}</span>
            {c && <> · placed {dateLong(c.order.placedAt)}</>}
          </p>
        </div>
        {nErrors > 0 && (
          <Alert tone="danger" title={`Check ${nErrors} thing${nErrors > 1 ? 's' : ''} before sending`}>
            {Object.values(errors).join(' ')}
          </Alert>
        )}
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4">1. Which items are affected?</h2>
              <span className="xs muted">{c?.preselectedItemIds.length || itemParam ? 'We selected the item you came from. Add others if needed.' : 'Select every item with the problem.'}</span>
            </div>
          </div>
          {!c ? (
            <SkRows n={3} />
          ) : (
            c.packages.map((g) => (
              <Fragment key={g.label}>
                <div className="buy-pkg-head bt">
                  <span className="row gap-2">
                    <span className="small strong">
                      {g.label} · {g.sellerName}
                    </span>
                    <SellerBadge seller={{ official: g.ownerType === 'official', verified: g.verified }} compact />
                  </span>
                  <StatusBadge status={g.status} />
                </div>
                {g.items.map((it) => {
                  const open = openCaseFor(it.orderItemId);
                  return (
                    <label key={it.orderItemId} className="buy-item buy-item-chk u-cur-pointer" htmlFor={`op-it-${it.orderItemId}`}>
                      <span className="row gap-3 nowrap">
                        <input type="checkbox" id={`op-it-${it.orderItemId}`} className="check-input" checked={selected.includes(it.orderItemId)} onChange={() => toggle(it.orderItemId)} />
                        <Img icon="package" src={it.imageUrl ?? undefined} alt="" className="thumb" />
                      </span>
                      <span className="stack gap-1">
                        <span className="buy-name">{it.title}</span>
                        <span className="xs sub">
                          {[...Object.values(it.options ?? {}), `Qty ${it.quantity}`, formatMoney(it.price)].join(' · ')}
                        </span>
                        <span>
                          <StatusBadge status={it.itemStatus} />
                        </span>
                        {open && (
                          <span className="xs muted">
                            Open case{' '}
                            <Link to={href('help/case', '', { ref: open.ref })} className="link-inline">
                              {open.ref}
                            </Link>
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </Fragment>
            ))
          )}
          {errors.items && (
            <div className="card-body">
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {errors.items}
              </span>
            </div>
          )}
        </section>
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h3 className="h4">2. What's wrong?</h3>
            </div>
          </div>
          <div className="card-body">
            {!c ? (
              <SkLines n={3} />
            ) : (
              <div className="buy-opts c2" role="radiogroup" aria-label="What's wrong?">
                {(c.problemTypes as ProblemType[]).filter((t) => TYPES[t]).map((t) => (
                  <OptionCard
                    key={t}
                    id={`op-type-${t}`}
                    name="op-type"
                    checked={type === t}
                    onChange={() => setType(t)}
                    title={
                      <span className="row gap-2 small strong">
                        <Icon name={TYPES[t].icon} className="ic-sm" />
                        {TYPES[t].label}
                      </span>
                    }
                  />
                ))}
              </div>
            )}
            {errors.type && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {errors.type}
              </span>
            )}
            {lateWarning.map((w) => (
              <div key={w} className="buy-note">
                <Icon name="triangle-alert" />
                <span>{w}</span>
              </div>
            ))}
            <Field label="Details" error={errors.details}>
              <Textarea id="op-details" placeholder="" value={details} maxLength={5000} onChange={(e) => setDetails(e.target.value)} />
            </Field>
            <div className="field">
              <span className="label">
                Photos <span className="opt">({type && PHOTO_REQUIRED.includes(type) ? 'required for damaged or wrong items' : 'optional'})</span>
              </span>
              <FileDrop title="Add photos of the package or item" hint="Helpful for damaged, wrong or missing items. JPG or PNG, up to 10 MB each" onFiles={photos.add} />
              {errors.photos && (
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {errors.photos}
                </span>
              )}
              <UploadList uploads={photos} icon="image" />
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h3 className="h4">3. What would you like?</h3>
            </div>
          </div>
          <div className="card-body">
            <div className="buy-opts c2">
              {choices.map((r) => (
                <OptionCard
                  key={r.kind}
                  id={`op-rem-${r.kind}`}
                  name="op-rem"
                  checked={activeRemedy === r.kind}
                  onChange={() => setRemedy(r.kind)}
                  title={<span className="small strong">{r.label}</span>}
                  body={r.kind === 'refund' && chosen.length ? `${money(refund)} · ${r.description}` : r.description}
                />
              ))}
            </div>
            <span className="xs muted">The seller or Marketly confirms the final remedy. A refund shows as Sent only when it has left us.</span>
            {duplicate ? (
              <Alert tone="info" title={`These items already have an open case: ${duplicate}`}>
                <Link to={href('help/case', '', { ref: duplicate })} className="link-inline">
                  Open the case
                </Link>{' '}
                to add your details there.
              </Alert>
            ) : (
              create.isError && (
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {errorMessage(create.error)}
                </span>
              )
            )}
          </div>
          <div className="card-foot">
            <Button variant="ghost" to={orderTo}>
              Cancel
            </Button>
            <Button icon="send" onClick={submit} disabled={!c || create.isPending}>
              {create.isPending ? 'Sending…' : handler ? `Send to ${handlerOfficial ? 'Marketly' : handler.sellerName}` : handlerNames.length ? 'Send to the sellers' : 'Send report'}
            </Button>
          </div>
        </section>
      </div>
      <aside className="sticky-aside stack gap-4">
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h3 className="h4">Who handles this</h3>
            </div>
          </div>
          <div className="card-body">
            {handler ? (
              <div className="row gap-3 nowrap">
                <LogoTile initials={handler.sellerName.split(/\s+/).map((w) => w[0]).slice(0, 2).join('')} tint="1" />
                <div className="stack gap-0">
                  <span className="small strong">{handlerOfficial ? 'Marketly support handles it' : `${handler.sellerName} handles it first`}</span>
                  <span className="xs muted">
                    {handlerOfficial
                      ? 'We shipped this package and reply within 1 business day.'
                      : `The seller shipped this package and must reply within 2 business days${c?.sellerReplyDueAt ? `, by ${dayDate(c.sellerReplyDueAt)}` : ''}.`}
                  </span>
                </div>
              </div>
            ) : (
              <div className="row gap-3 nowrap">
                <Icon name="store" />
                <div className="stack gap-0">
                  <span className="small strong">{handlerNames.length ? 'Each seller handles their items first' : 'Select the affected items'}</span>
                  <span className="xs muted">{handlerNames.length ? 'Sellers must reply within 2 business days.' : 'We send the report to whoever shipped them.'}</span>
                </div>
              </div>
            )}
            <hr />
            {c && c.marketlyStepsIn.length > 0 && (
              <div className="row top gap-3 nowrap">
                <Icon name="life-buoy" />
                <div className="stack gap-1">
                  <span className="small strong">When Marketly steps in</span>
                  <ul className="ul xs sub stack gap-1">
                    {c.marketlyStepsIn.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <span className="xs muted">You'll get a case number and can follow every reply in Support cases.</span>
          </div>
        </section>
        {c?.otherItemsNote && (
          <div className="card pad stack gap-2">
            <span className="small strong">Other items in this order</span>
            <span className="xs muted">{c.otherItemsNote}</span>
          </div>
        )}
      </aside>
    </div>,
  );
}
