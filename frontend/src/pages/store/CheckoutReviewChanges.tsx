import { Fragment, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckoutLayout } from '@/layouts';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { ApiError, call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { Alert, Badge, Button, Card, Dialog, Icon, OptionCard, SummaryRow } from '@marketly/web-shared/ui';
import { BuyMini, CheckoutSteps, ItemImg, PurchaseSkeleton, SecN } from './data/purchase';
import { checkoutHref, checkoutKey, reviewChangesHref, useCheckoutSession, type Change, type ChangeDecision, type ChangeSet, type CheckoutLine, type CheckoutView } from './data/checkout-api';

// Design: pages/store/store-checkout-review-changes.html: the checkout re-check found changes before charging;
// the shopper picks what to do with each one. URL: /checkout/review-changes?session=<checkout id>&changes=<change set id>
// (changes defaults to the session's open change set). Data: GET …/sessions/{id}/changes/{changeSetId} (ChangeSet),
// GET …/sessions/{id} (order behind the dialog); accept: POST …/changes/{changeSetId}/accept, then back to checkout.
// The API prices the default choices only (effectOnTotal, newTotal); other choices are estimated here.

type Choice = ChangeDecision['choice'];
type Alternative = components['schemas']['checkout.AlternativeOffer'];

interface ChoiceItem {
  key: string;
  choice: Choice;
  offerId?: string;
  label: string;
  sub?: string;
  alt?: Alternative;
}

const money = (amount: number) => formatMoney({ amount, currency: 'USD' });
const signed = (n: number) => `${n < 0 ? '−' : '+'}${money(Math.abs(n))}`;

function acceptLabel(c: Change): string {
  const cur = c.currentAmount ? formatMoney(c.currentAmount) : c.current;
  switch (c.kind) {
    case 'price_increased':
    case 'price_decreased':
      return `Accept the new price, ${cur}`;
    case 'quantity_reduced':
    case 'purchase_limit':
      return `Buy the ${c.availableQuantity ?? 'quantity'} available from ${c.sellerName}`;
    case 'delivery_date_changed':
      return 'Keep it with the new date';
    case 'shipping_cost_changed':
      return `Accept the new shipping cost, ${cur}`;
    case 'coupon_no_longer_applies':
    case 'coupon_amount_changed':
      return `Keep it at ${cur}`;
    case 'terms_changed':
      return 'Accept the new terms';
    default:
      return 'Accept this change';
  }
}

function choicesOf(c: Change): ChoiceItem[] {
  const out: ChoiceItem[] = [];
  for (const choice of c.choices) {
    if (choice === 'choose_offer') {
      for (const alt of c.alternatives) out.push({ key: `choose_offer:${alt.offerId}`, choice, offerId: alt.offerId, label: 'Choose another offer', alt });
      continue;
    }
    const label =
      choice === 'accept'
        ? acceptLabel(c)
        : choice === 'remove'
          ? 'Remove this item'
          : choice === 'reduce_quantity'
            ? `Buy the ${c.availableQuantity ?? 'quantity'} available from ${c.sellerName}`
            : choice === 'keep_without_discount'
              ? 'Keep it without the discount'
              : 'Choose another delivery option';
    const effect = c.effectOnTotal.amount;
    out.push({ key: choice, choice, label, sub: choice === c.defaultChoice && effect ? `Your total goes ${effect > 0 ? 'up' : 'down'} by ${money(Math.abs(effect))}.` : undefined });
  }
  return out;
}

const defaultKey = (c: Change) => {
  const items = choicesOf(c);
  return (items.find((x) => x.choice === c.defaultChoice) ?? items[0])?.key ?? c.defaultChoice;
};

/** Change in total for one pick: exact for the default (API), estimated from the line otherwise. */
function effectOf(c: Change, item: ChoiceItem | undefined, line: CheckoutLine | undefined): number {
  if (!item || item.key === defaultKey(c)) return c.effectOnTotal.amount;
  const disc = line ? line.discounts.reduce((s, d) => s + d.amount.amount, 0) : 0;
  switch (item.choice) {
    case 'remove':
      return line ? -(line.lineTotal.amount - disc) : c.effectOnTotal.amount;
    case 'choose_offer':
      return line && item.alt ? (item.alt.price.amount - line.unitPrice.amount) * line.quantity : 0;
    case 'reduce_quantity':
      return line && c.availableQuantity != null ? -line.unitPrice.amount * Math.max(0, line.quantity - c.availableQuantity) : 0;
    case 'keep_without_discount':
      return disc;
    default:
      return 0;
  }
}

export default function CheckoutReviewChanges() {
  const [params] = useSearchParams();
  const id = params.get('session');
  const session = useCheckoutSession(id);
  const csId = params.get('changes') ?? session.data?.openChangeSetId ?? null;
  const { api } = useApi();
  const changes = useQuery({
    queryKey: ['checkout', 'changes', id ?? '', csId ?? ''],
    queryFn: () => call(api.GET('/api/store/checkout/sessions/{id}/changes/{changeSetId}', { params: { path: { id: id!, changeSetId: csId! } } })),
    enabled: !!id && !!csId,
  });

  if (!id) return <Navigate to={href('store/cart')} replace />;
  if (session.data && !csId) return <Navigate to={checkoutHref(id)} replace />;
  if (changes.data && changes.data.status !== 'open') return <Navigate to={session.data?.openChangeSetId ? reviewChangesHref(id, session.data.openChangeSetId) : checkoutHref(id)} replace />;

  const err = session.error ?? changes.error;
  if (err) {
    const gone = err instanceof ApiError && (err.status === 404 || err.status === 410);
    return (
      <Shell>
        <Alert tone={gone ? 'warning' : 'danger'} title={gone ? 'These changes are no longer open' : "We couldn't load the changes"}>
          {errorMessage(err)}{' '}
          {gone ? (
            <Link to={checkoutHref(id)} className="link-inline">
              Back to checkout
            </Link>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void session.refetch();
                void changes.refetch();
              }}
            >
              Try again
            </Button>
          )}
        </Alert>
      </Shell>
    );
  }
  if (!session.data || !changes.data) {
    return (
      <Shell>
        <PurchaseSkeleton label="the changes to your order" />
      </Shell>
    );
  }
  return <Review key={changes.data.id} c={session.data} cs={changes.data} />;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <CheckoutLayout>
      <div className="container page">
        <div className="stack gap-3">
          <h1 className="h1">Checkout</h1>
          <CheckoutSteps current={4} />
        </div>
        {children}
      </div>
    </CheckoutLayout>
  );
}

function Review({ c, cs }: { c: CheckoutView; cs: ChangeSet }) {
  const id = c.id;
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [picked, setPicked] = useState<Record<string, string>>(() => Object.fromEntries(cs.changes.map((ch) => [ch.id, defaultKey(ch)])));
  const lines = c.packages.flatMap((p) => p.lines);
  const lineOf = (ch: Change) => lines.find((l) => l.id === ch.lineId);

  const rows = cs.changes.map((ch) => {
    const items = choicesOf(ch);
    const item = items.find((x) => x.key === picked[ch.id]) ?? items[0];
    return { ch, item, effect: effectOf(ch, item, lineOf(ch)) };
  });
  const allDefault = rows.every((r) => r.item?.key === defaultKey(r.ch));
  const newTotal = allDefault ? cs.newTotal.amount : cs.previousTotal.amount + rows.reduce((s, r) => s + r.effect, 0);
  const removing = rows.filter((r) => r.item?.choice === 'remove');
  const keptAny = removing.length < rows.length;

  const accept = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/store/checkout/sessions/{id}/changes/{changeSetId}/accept', {
          params: { path: { id, changeSetId: cs.id } },
          body: {
            decisions: rows.map((r) => ({ changeId: r.ch.id, choice: r.item?.choice ?? r.ch.defaultChoice, offerId: r.item?.offerId ?? null, quantity: r.item?.choice === 'reduce_quantity' ? (r.ch.availableQuantity ?? null) : null })),
            acceptPartialOrder: cs.partialOrder || removing.length > 0,
          },
        }),
      ),
    onSuccess: (v) => {
      qc.setQueryData(checkoutKey(id), v);
      navigate(checkoutHref(id));
    },
    onError: async (e) => {
      if (e instanceof ApiError && e.code === 'CHANGESET_STALE') {
        const fresh = await qc.fetchQuery({ queryKey: checkoutKey(id), queryFn: () => call(api.GET('/api/store/checkout/sessions/{id}', { params: { path: { id } } })) });
        navigate(fresh.openChangeSetId ? reviewChangesHref(id, fresh.openChangeSetId) : checkoutHref(id), { replace: true });
      }
    },
  });
  const leave = useMutation({
    mutationFn: () => call(api.DELETE('/api/store/checkout/sessions/{id}', { params: { path: { id } } })),
    onSettled: () => navigate(href('store/cart')),
  });

  return (
    <Shell>
      <div className="split">
        <div className="stack gap-4">
          <section className="card">
            <div className="card-head">
              <div className="row gap-3 nowrap">
                <SecN n={6} />
                <h2 className="h4">Review your order</h2>
              </div>
            </div>
            <div className="card-body">
              {lines.map((l, i) => (
                <Fragment key={l.id}>
                  {i > 0 && <hr />}
                  <BuyMini image={l.image} name={l.title} sub={`${c.packages.find((p) => p.lines.includes(l))?.seller.name ?? ''} · Qty ${l.quantity}`} amount={formatMoney(l.lineTotal)} clamp={false} />
                </Fragment>
              ))}
            </div>
          </section>
        </div>
        <aside>
          <Card title="Order total" titleAs="h3">
            <SummaryRow className="total" k="Total" v={formatMoney(cs.previousTotal)} />
            <Button size="lg" block disabled>
              Place order · {formatMoney(cs.previousTotal)}
            </Button>
          </Card>
        </aside>
      </div>

      <Dialog
        open
        size="lg"
        onClose={() => navigate(checkoutHref(id))}
        title="Some details changed before you placed your order"
        foot={
          <>
            <Button variant="secondary" to={href('store/cart')}>
              Back to cart
            </Button>
            {keptAny ? (
              <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
                Accept changes and continue · {money(newTotal)}
              </Button>
            ) : (
              <Button onClick={() => leave.mutate()} disabled={leave.isPending}>
                Remove all and go back to cart
              </Button>
            )}
          </>
        }
      >
        <p className="small sub">{cs.intro} Choose what to do with each change.</p>
        {cs.changes.map((ch) => (
          <div className="buy-change" key={ch.id}>
            <div className="buy-change-head">
              <ItemImg image={ch.image} />
              <div className="stack gap-1 grow">
                <span className="xs strong t-warning-text">{ch.headline}</span>
                <span className="small strong">{ch.title}</span>
                <span className="buy-delta">
                  {ch.previous ? (
                    <>
                      <span className="buy-strike">{ch.previous}</span>
                      <Icon name="arrow-right" className="ic-sm" />
                      <span>{ch.current}</span>
                    </>
                  ) : (
                    <span>{ch.current}</span>
                  )}
                  <span className="xs muted">· {ch.sellerName}</span>
                </span>
              </div>
            </div>
            {ch.detail && <span className="xs muted">{ch.detail}</span>}
            <div className="buy-opts">
              {choicesOf(ch).map((x) => (
                <OptionCard
                  key={x.key}
                  id={`rc-${ch.id}-${x.key}`}
                  name={`rc-${ch.id}`}
                  checked={picked[ch.id] === x.key}
                  onChange={() => setPicked((p) => ({ ...p, [ch.id]: x.key }))}
                  title={
                    <>
                      <span className="small strong">{x.label}</span>
                      {(x.sub || x.alt) && (
                        <span className="small sub">
                          {x.sub}
                          {x.alt && (
                            <span className="buy-alt stack gap-1 mt-1-5 u-d-flex">
                              <span className="row gap-2">
                                <b>{x.alt.seller.name}</b>
                                {x.alt.seller.official ? (
                                  <Badge tone="brand" icon="badge-check">
                                    Official
                                  </Badge>
                                ) : x.alt.seller.verified ? (
                                  <Badge tone="info" icon="shield-check">
                                    Verified
                                  </Badge>
                                ) : null}
                              </span>
                              <span>
                                {[
                                  x.alt.conditionLabel,
                                  `${formatMoney(x.alt.price)} each`,
                                  `${x.alt.available} in stock`,
                                  x.alt.shipping ? (x.alt.shipping.amount ? `${formatMoney(x.alt.shipping)} shipping` : 'Free shipping') : null,
                                  x.alt.arrivalLabel,
                                  x.alt.returnTerms,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                              {x.alt.differentSeller && x.alt.note && <span className="xs muted">{x.alt.note}</span>}
                            </span>
                          )}
                        </span>
                      )}
                    </>
                  }
                />
              ))}
            </div>
          </div>
        ))}
        {cs.partialNote && (
          <Alert tone="info" title="If you remove an item, the rest of your order can still go through">
            {cs.partialNote}
          </Alert>
        )}
        {accept.isError && (
          <Alert tone="danger" title="We couldn't apply your choices">
            {errorMessage(accept.error)}
          </Alert>
        )}
        <div className="panel buy-sum">
          <SummaryRow k="Previous total" v={<span className="buy-strike">{formatMoney(cs.previousTotal)}</span>} />
          {allDefault
            ? cs.deltas.map((d, i) => (d.amount.amount ? <SummaryRow key={i} k={d.label} v={signed(d.amount.amount)} /> : null))
            : rows.map((r) => (r.effect ? <SummaryRow key={r.ch.id} k={`${r.ch.headline} · ${r.ch.title}`} v={signed(r.effect)} /> : null))}
          <SummaryRow className="total" k="New total" v={money(newTotal)} />
          {!allDefault && <span className="xs muted">Estimated for the options you picked. The review step shows the exact total before you place the order.</span>}
        </div>
      </Dialog>
    </Shell>
  );
}
