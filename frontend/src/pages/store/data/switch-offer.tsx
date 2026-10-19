import { useMutation } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { Alert, Badge, Button, Dialog, Icon } from '@marketly/web-shared/ui';
import { SkLines } from '@/api/cards';
import { useOfferComparison, type ConditionGroup } from './offers';
import type { CartItem, CartView } from './checkout-api';

// Cart "See other offers": the other sellers' offers for the line's exact variant, each with "Switch to this
// offer" (POST /api/store/cart/cart/items/{id}/switch-offer). The cart never switches sellers on its own, so
// this is the explicit choice the backend asks for; it replaces the line instead of adding a second one (which
// is what adding from the All offers page would do).

const groupOf = (c: string): ConditionGroup => (c === 'new' ? 'new' : c === 'refurbished' ? 'refurbished' : 'used');

export function SwitchOfferDialog({ line, onClose, onSwitched }: { line: CartItem; onClose: () => void; onSwitched: (cart: CartView, seller: string) => void }) {
  const { api } = useApi();
  // The notice hint names the variant and condition the alternatives were counted for; the line's own are the fallback.
  const hint = line.notices.find((n) => n.alternatives)?.alternatives;
  const variantId = hint?.variantId ?? line.variantId;
  const offers = useOfferComparison(hint?.productId ?? line.productId, { variantId, condition: groupOf(hint?.condition ?? line.condition) });
  const switchOffer = useMutation({
    mutationFn: (offerId: string) => call(api.POST('/api/store/cart/cart/items/{id}/switch-offer', { params: { path: { id: line.id } }, body: { offerId } })),
  });
  // Only offers the customer could actually buy right now: active, in stock, shipping to them, not the current one.
  const choices = (offers.data?.offers ?? []).filter((o) => o.offerId !== line.offerId && o.status === 'active' && o.availability.state !== 'out_of_stock' && o.delivery.shipsToLocation !== false);

  return (
    <Dialog open onClose={onClose} title="Other offers for this item">
      <div className="stack gap-3">
        <p className="small sub">
          {line.title} · {line.variantLabel}. Switching replaces this line in your cart with the offer you choose; the quantity stays the same where the seller has enough stock.
        </p>
        {offers.isPending ? (
          <SkLines n={4} />
        ) : offers.isError ? (
          <Alert tone="danger" title="We couldn’t load the other offers">
            {errorMessage(offers.error)}{' '}
            <Button variant="secondary" size="sm" icon="refresh-cw" onClick={() => void offers.refetch()}>
              Try again
            </Button>
          </Alert>
        ) : choices.length === 0 ? (
          <p className="small muted">No other seller can sell this item to you right now.</p>
        ) : (
          <ul className="list">
            {choices.map((o) => (
              <li key={o.offerId}>
                <div className="row between gap-3 grow">
                  <span className="stack gap-0 minw-200 grow">
                    <span className="small strong row gap-2">
                      {o.seller.name}
                      {o.seller.official ? <Badge tone="brand">Official</Badge> : o.seller.verified ? <Badge icon="badge-check">Verified</Badge> : null}
                    </span>
                    <span className="xs sub">
                      {o.conditionLabel} · {o.delivery.label}
                    </span>
                    <span className="xs muted">
                      {formatMoney(o.price)} item · {formatMoney(o.total)} with shipping, before tax
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={switchOffer.isPending}
                    aria-label={`Switch to this offer from ${o.seller.name}`}
                    onClick={() => switchOffer.mutate(o.offerId, { onSuccess: (cart) => onSwitched(cart, o.seller.name) })}
                  >
                    Switch to this offer
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {switchOffer.isError && (
          <span className="error-text" role="alert">
            <Icon name="circle-alert" className="ic-sm" />
            {errorMessage(switchOffer.error)}
          </span>
        )}
      </div>
    </Dialog>
  );
}
