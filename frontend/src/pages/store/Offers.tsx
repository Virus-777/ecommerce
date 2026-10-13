import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { StoreLayout } from '@/layouts';
import { ApiError } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Badge, Breadcrumbs, Button, Chip, EmptyState, Icon, Stars, TableWrap } from '@marketly/web-shared/ui';
import NotFound from './NotFound';
import { CONDITIONS, kitNote, splitStep, useOfferComparison, type ConditionGroup } from './data/offers';
import { productCrumbs, productHref, sellerHref, useCartButton, useCategories, useProductParams, useRatingSummary, variantAxis, variantName, type OfferView } from './data/product';
import { ListSkeleton, LoadError, Photo } from './data/review-parts';

// Design: pages/store/store-offers.html (sorted by total cost)
//   view "fastest-delivery" = the same offers sorted by earliest arrival
// ?variant=<variantId> compares the offers of that variant (default: the product's default variant).

type View = 'fastest-delivery';
type CondFilter = 'all' | ConditionGroup;

const SORTS: Array<{ view: View | ''; label: string }> = [
  { view: '', label: 'Total cost' },
  { view: 'fastest-delivery', label: 'Fastest delivery' },
];

export default function Offers() {
  const [view] = useView<View>();
  const { slug, id } = useProductParams();
  const [params] = useSearchParams();
  const variantId = params.get('variant') ?? undefined;
  const [cond, setCond] = useState<CondFilter>('all');
  const cart = useCartButton('offers_list');

  const comparison = useOfferComparison(id, { variantId, condition: cond, sort: view === 'fastest-delivery' ? 'fastest_delivery' : 'total_cost' });
  const summary = useRatingSummary(id);
  const categories = useCategories();
  const data = comparison.data;
  const rows = data?.offers ?? [];
  const counts = data?.conditionCounts ?? {};
  const productLink = productHref(slug, id);
  const sortQuery = variantId ? { variant: variantId } : undefined;

  if (comparison.error instanceof ApiError && comparison.error.status === 404) return <NotFound />;

  const addToCart = (o: OfferView) => cart.run(o.offerId, 1, `${data?.product.title ?? 'this item'} from ${o.seller.name}, ${formatMoney(o.total)}`);
  const addLabel = (o: OfferView) => (cart.added === o.offerId ? 'Added to cart' : 'Add to cart');
  const addError = (o: OfferView) =>
    cart.error?.offerId === o.offerId ? (
      <span className="error-text xs" role="alert">
        {cart.error.text}
      </span>
    ) : null;

  const crumbs = productCrumbs(data ? { categoryId: data.product.categoryId, categoryPath: [] } : undefined, categories.data);
  const color = variantName(data?.variant);

  return (
    <StoreLayout nav="categories" appbar={{ title: data ? `All offers (${counts.all ?? rows.length})` : 'All offers', back: productLink }}>
      <div className="container page gap-5">
        <Breadcrumbs items={[...crumbs, { label: data?.product.title ?? 'Product', to: productLink }, { label: 'All offers' }]} />
        {comparison.error ? (
          <LoadError error={comparison.error} onRetry={() => void comparison.refetch()} title="We couldn’t load the offers" />
        ) : !data ? (
          <>
            <div className="card pad shop-mini" aria-busy="true">
              <span className="sk sk-thumb" />
              <div className="sk-lines grow">
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </div>
            </div>
            <ListSkeleton rows={4} />
          </>
        ) : (
          <>
            <div className="card pad shop-mini">
              <Photo media={data.variant.images?.[0] ?? data.product.image} />
              <div className="stack gap-1 grow">
                <h1 className="h3">{data.product.title}</h1>
                {color && (
                  <span className="row gap-2 small sub">
                    {variantAxis(data.variant)}: <b>{color}</b>{' '}
                    <Link to={productLink} className="link-inline">
                      Change
                    </Link>
                  </span>
                )}
                {summary.data?.hasReviews && summary.data.average != null && <Stars rating={summary.data.average} count={summary.data.ratingCount} />}
              </div>
            </div>
            <div className="shop-toolbar">
              <div className="hscroll gap-2">
                <Chip active={cond === 'all'} onClick={() => setCond('all')}>
                  All conditions ({counts.all ?? 0})
                </Chip>
                {CONDITIONS.map((g) => (
                  <Chip key={g.value} active={cond === g.value} onClick={() => setCond(g.value)}>
                    {g.label} ({counts[g.value] ?? 0})
                  </Chip>
                ))}
              </div>
              <span className="row gap-2">
                <span className="small sub">Sort by</span>
                <div className="seg" role="group">
                  {SORTS.map((s) => {
                    const on = s.view === view;
                    return (
                      <Link key={s.label} to={href('store/offers', s.view, { slug, id }, sortQuery)} className={cx(on && 'is-active')} aria-current={on ? 'page' : undefined} preventScrollReset replace>
                        {s.label}
                      </Link>
                    );
                  })}
                </div>
              </span>
            </div>
            <p className="small sub">
              {rows.length} offer{rows.length === 1 ? '' : 's'} delivering to {data.deliverTo.label}. {data.taxNote}
            </p>

            {rows.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon="search-x"
                  title="No offers in this condition"
                  action={
                    <Button variant="secondary" size="sm" onClick={() => setCond('all')}>
                      Show all conditions
                    </Button>
                  }
                >
                  No seller offers this item in this condition for {data.deliverTo.label} right now.
                </EmptyState>
              </div>
            ) : (
              <>
                {/* Phone and tablet: offer cards */}
                <div className="stack gap-3 no-desktop">
                  {rows.map((o) => {
                    const main = o.offerId === data.featuredOfferId;
                    return (
                      <article key={o.offerId} className={cx('card pad shop-offer', main && 'is-featured')}>
                        <div className="row between top">
                          <SellerCell o={o} />
                          {main && <FeaturedBadge />}
                        </div>
                        {ineligible(o) && <Ineligible text={ineligible(o)!} />}
                        <div className="ogrid">
                          <div>
                            <span className="k">Cost</span>
                            <CostCell o={o} />
                          </div>
                          <div>
                            <span className="k">Condition</span>
                            <ConditionCell o={o} />
                          </div>
                          <div>
                            <span className="k">Delivery</span>
                            <DeliveryCell o={o} />
                          </div>
                          <div>
                            <span className="k">Seller quality</span>
                            <QualityCell o={o} />
                          </div>
                          <div className="span-all">
                            <span className="k">Returns and warranty</span>
                            <ReturnsCell o={o} />
                          </div>
                        </div>
                        <button
                          type="button"
                          className={cx('btn btn-block', main ? 'btn-primary' : 'btn-secondary')}
                          disabled={cart.pending === o.offerId || o.availability.state === 'out_of_stock'}
                          onClick={() => addToCart(o)}
                        >
                          <span>{addLabel(o)}</span>
                        </button>
                        {addError(o)}
                      </article>
                    );
                  })}
                </div>

                {/* Desktop: comparison table */}
                <div className="card only-desktop shop-otable">
                  <TableWrap label={`${data.product.title} table`}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Seller</th>
                          <th scope="col">Total cost</th>
                          <th scope="col">Condition</th>
                          <th scope="col">Delivery to {data.deliverTo.postalCode}</th>
                          <th scope="col">Seller quality</th>
                          <th scope="col">Returns and warranty</th>
                          <th className="r" scope="col">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((o) => {
                          const main = o.offerId === data.featuredOfferId;
                          return (
                            <tr key={o.offerId} className={cx(main && 'is-featured')}>
                              <td>
                                <SellerCell o={o} />
                                {main && (
                                  <div className="mt-1-5">
                                    <FeaturedBadge />
                                  </div>
                                )}
                                {ineligible(o) && (
                                  <div className="mt-1-5 maxw-200">
                                    <Ineligible text={ineligible(o)!} />
                                  </div>
                                )}
                              </td>
                              <td>
                                <CostCell o={o} />
                              </td>
                              <td>
                                <div className="maxw-220">
                                  <ConditionCell o={o} />
                                </div>
                              </td>
                              <td>
                                <DeliveryCell o={o} />
                              </td>
                              <td>
                                <QualityCell o={o} />
                              </td>
                              <td>
                                <div className="maxw-200">
                                  <ReturnsCell o={o} />
                                </div>
                              </td>
                              <td className="r">
                                <button
                                  type="button"
                                  className={cx('btn btn-sm', main ? 'btn-primary' : 'btn-secondary')}
                                  disabled={cart.pending === o.offerId || o.availability.state === 'out_of_stock'}
                                  onClick={() => addToCart(o)}
                                >
                                  <span>{addLabel(o)}</span>
                                  <span className="sr-only"> {o.seller.name}</span>
                                </button>
                                {addError(o)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </TableWrap>
                </div>
              </>
            )}

            <section className="card pad stack gap-3" aria-labelledby="of-rule">
              <h2 className="h4 row gap-2" id="of-rule">
                <Icon name="award" /> How we choose the featured offer
              </h2>
              <ol className="ol small sub stack gap-1">
                {data.rule.steps.map((step) => {
                  const [lead, rest] = splitStep(step);
                  return (
                    <li key={step}>
                      {lead && <b>{lead}:</b>} {rest}
                    </li>
                  );
                })}
              </ol>
              <p className="xs muted">
                {data.rule.notes.join(' ')} The published version is in{' '}
                <Link to={href('info/policy', 'seller-rules')} className="link-inline">
                  Seller rules
                </Link>
                . Once an item is in your cart, its seller never changes without your choice.
              </p>
            </section>
          </>
        )}
      </div>
    </StoreLayout>
  );
}

/** Why an offer can't be the featured offer (shown under it). */
const ineligible = (o: OfferView) => o.ineligibleNote ?? (o.featuredEligible ? null : 'Not eligible for featured offer');

function SellerCell({ o }: { o: OfferView }) {
  const s = o.seller;
  return (
    <div className="stack gap-1">
      <Link to={sellerHref(s)} className="link-inline">
        <b>{s.name}</b>
      </Link>
      <span className="row gap-1">
        {s.official ? (
          <Badge tone="brand" icon="badge-check">
            Official
          </Badge>
        ) : s.verified ? (
          <Badge tone="info" icon="shield-check">
            Verified
          </Badge>
        ) : (
          <Badge tone="outline">Not verified</Badge>
        )}
      </span>
    </div>
  );
}

function FeaturedBadge() {
  return (
    <Badge tone="brand" icon="award">
      Featured offer
    </Badge>
  );
}

function Ineligible({ text }: { text: string }) {
  return (
    <span className="shop-note warn">
      <Icon name="triangle-alert" />
      {text}
    </span>
  );
}

function CostCell({ o }: { o: OfferView }) {
  const ship = o.delivery.shippingCost;
  return (
    <div className="stack gap-0 num">
      <span className="strong">{formatMoney(o.total)}</span>
      <span className="xs muted">
        {formatMoney(o.price)} + {!o.delivery.free && ship?.amount ? `${formatMoney(ship)} shipping` : 'free shipping'}
        {o.automaticDiscount && ` − ${formatMoney(o.automaticDiscount.amount)} ${o.automaticDiscount.label}`}
      </span>
    </div>
  );
}

function ConditionCell({ o }: { o: OfferView }) {
  const kit = kitNote(o);
  return (
    <div className="stack gap-1">
      <Badge tone="outline">{o.conditionLabel}</Badge>
      {o.conditionNotes && <span className="xs sub">{o.conditionNotes}</span>}
      {kit && (
        <span className={cx('shop-note', kit.warn && 'warn')}>
          <Icon name={kit.icon} />
          {kit.text}
        </span>
      )}
    </div>
  );
}

function DeliveryCell({ o }: { o: OfferView }) {
  return (
    <div className="stack gap-0">
      <span className="small strong">{o.delivery.label}</span>
      <span className="xs muted">
        {o.delivery.dispatchLabel}
        {o.delivery.carrier && ` · ${o.delivery.carrier}`}
      </span>
    </div>
  );
}

function QualityCell({ o }: { o: OfferView }) {
  const s = o.seller;
  if (!s.ratingCount || s.positivePct == null) {
    return (
      <div className="stack gap-0">
        <span className="small">No ratings yet</span>
        {s.onTimeDispatchPct != null && <span className="xs muted">{s.onTimeDispatchPct}% on-time dispatch</span>}
      </div>
    );
  }
  return (
    <div className="stack gap-0">
      <span className="small">{s.positivePct}% positive</span>
      <span className="xs muted">
        {num(s.ratingCount)} ratings{s.onTimeDispatchPct != null && ` · ${s.onTimeDispatchPct}% on-time dispatch`}
      </span>
    </div>
  );
}

function ReturnsCell({ o }: { o: OfferView }) {
  return (
    <div className="stack gap-0">
      <span className="small">{o.returns.summary}</span>
      <span className="xs muted">{o.warranty.summary}</span>
    </div>
  );
}
