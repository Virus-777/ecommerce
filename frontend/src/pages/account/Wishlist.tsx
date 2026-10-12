import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSession } from '@/app/session';
import { P, type SellerId } from '@marketly/web-shared/data/fixtures';
import { AccountLayout } from '@/layouts';
import { money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Card, EmptyState, Icon, IconButton, Img, Price, SellerLine, StatusBadge, Switch, TableWrap } from '@marketly/web-shared/ui';

// Design: pages/store/account-wishlist.html (one view): saved items with price-drop and back-in-stock
// switches; the alerts table is built from those switches. Recently viewed can be cleared.

interface WishItem {
  id: string;
  p: string;
  seller: SellerId;
  price: number;
  was?: number;
  priceNote: { badge?: string; text?: string };
  stock: 'In stock' | 'Low stock' | 'Out of stock';
  left?: number;
  drop: boolean;
  back: boolean;
  /** Alert condition copy. */
  backCondition?: string;
  triggered?: boolean;
}

const ITEMS: WishItem[] = [
  { id: 'w1', p: 'kestrel27', seller: 'pixelport', price: 299, was: 329, priceNote: { badge: 'Lowest in 30 days' }, stock: 'In stock', drop: true, back: false, triggered: true },
  { id: 'w2', p: 'backpack', seller: 'trailhead', price: 139, was: 165, priceNote: { text: 'Typical price $139–$165' }, stock: 'Out of stock', drop: false, back: true, backCondition: 'Olive, from Trailhead Outfitters' },
  { id: 'w3', p: 'lamp', seller: 'official', price: 42, priceNote: { text: 'Same price for 30 days' }, stock: 'Low stock', left: 9, drop: true, back: false },
  { id: 'w4', p: 'sweater', seller: 'official', price: 84, priceNote: { badge: 'Lowest in 30 days' }, stock: 'In stock', drop: false, back: false },
];

const RECENT = ['ssd1tb', 'speaker', 'duvet', 'skillet', 'keyboard', 'serum'];

export default function Wishlist() {
  const { cartCount, setCartCount } = useSession();
  const navigate = useNavigate();
  const [items, setItems] = useState(ITEMS);
  const [recent, setRecent] = useState(RECENT);
  const [notice, setNotice] = useState('');

  const setAlert = (id: string, k: 'drop' | 'back', v: boolean) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, [k]: v } : x)));
  const remove = (w: WishItem) => {
    setItems((xs) => xs.filter((x) => x.id !== w.id));
    setNotice(`${P[w.p].name} removed from your wishlist.`);
  };
  const moveToCart = (w: WishItem) => {
    setItems((xs) => xs.filter((x) => x.id !== w.id));
    setCartCount(cartCount + 1);
    navigate(href('store/cart'));
  };
  const share = async () => {
    const url = `${window.location.origin}${href('account/wishlist')}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'My Marketly wishlist', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setNotice('Link to your list copied. Anyone with the link can see the items, not your alerts.');
      announce('Wishlist link copied');
    } catch {
      /* share sheet dismissed */
    }
  };

  const alerts = [
    ...items.filter((w) => w.drop).map((w) => ({ w, kind: 'drop' as const, label: 'Price drop', cond: `Any drop below ${money(w.was ?? w.price)}`, status: w.triggered ? 'Triggered' : 'Active' })),
    ...items.filter((w) => w.back).map((w) => ({ w, kind: 'back' as const, label: 'Back in stock', cond: w.backCondition ?? `From ${P[w.p].name}`, status: 'Active' })),
  ];

  return (
    <AccountLayout active="wishlist" title="Wishlist and alerts">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Wishlist and alerts</h1>
          <p className="small sub">
            {items.length} saved item{items.length === 1 ? '' : 's'} · alerts arrive as notifications and email.
          </p>
        </div>
        <div className="acts">
          <Button variant="secondary" size="sm" icon="share-2" onClick={share} disabled={!items.length}>
            Share list
          </Button>
        </div>
      </div>
      {notice && <Alert tone="success" title={notice} />}
      {items.length === 0 ? (
        <div className="card">
          <EmptyState icon="heart" as="h2" title="Your wishlist is empty" action={<Button to={href('store/home')}>Browse the store</Button>}>
            Tap the heart on any product to save it here and get price-drop alerts.
          </EmptyState>
        </div>
      ) : (
        <div className="grid md2 lg2 gap-4">
          {items.map((w, i) => {
            const p = P[w.p];
            const out = w.stock === 'Out of stock';
            return (
              <article key={w.id} className="card pad acct-wish stack gap-3">
                <div className="row gap-3 nowrap top">
                  <Link to={href('store/product')} aria-label={p.name} className="u-w-96px u-flex-none">
                    <Img icon={p.icon} tint={p.tint} />
                  </Link>
                  <div className="stack gap-1 grow">
                    <Link className="small strong link-plain" to={href('store/product')}>
                      {p.name}
                    </Link>
                    <SellerLine seller={w.seller} badge />
                    <Price amount={w.price} was={w.was} />
                    <span className="row gap-2">
                      {w.priceNote.badge ? (
                        <Badge tone="success" icon="trending-down">
                          {w.priceNote.badge}
                        </Badge>
                      ) : (
                        <span className="xs muted">{w.priceNote.text}</span>
                      )}
                    </span>
                    <span className="row gap-2">
                      <StatusBadge status={w.stock} />
                      {w.left !== undefined && <span className="xs muted">{w.left} left</span>}
                    </span>
                  </div>
                  <IconButton icon="x" label={`Remove ${p.name} from wishlist`} onClick={() => remove(w)} />
                </div>
                <div className="stack gap-2 panel">
                  <Switch id={`wl-drop-${i}`} label="Alert me when the price drops" checked={w.drop} onChange={(e) => setAlert(w.id, 'drop', e.target.checked)} />
                  <Switch id={`wl-back-${i}`} label="Alert me when it's back in stock" checked={w.back} onChange={(e) => setAlert(w.id, 'back', e.target.checked)} />
                </div>
                {out ? (
                  <Button variant="secondary" block disabled>
                    Out of stock
                  </Button>
                ) : (
                  <Button block icon="shopping-cart" onClick={() => moveToCart(w)}>
                    Move to cart
                  </Button>
                )}
              </article>
            );
          })}
        </div>
      )}
      <Card title="Your alerts" sub="Turn alerts off any time. These are separate from order updates." flush>
        {alerts.length ? (
          <TableWrap label="Your alerts table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Alert</th>
                  <th scope="col">Condition</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={`${a.w.id}-${a.kind}`}>
                    <td>
                      <div className="cell-main">
                        <Img icon={P[a.w.p].icon} tint={P[a.w.p].tint} className="tiny" />
                        <span className="small">{P[a.w.p].name}</span>
                      </div>
                    </td>
                    <td>{a.label}</td>
                    <td>{a.cond}</td>
                    <td>
                      <StatusBadge status={a.status} tone="success" />
                    </td>
                    <td>
                      <Button variant="ghost" size="sm" onClick={() => setAlert(a.w.id, a.kind, false)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        ) : (
          <div className="card-body">
            <p className="small muted">No alerts on. Turn on a switch above to get told about price drops or restocks.</p>
          </div>
        )}
      </Card>
      <section className="stack gap-3" aria-labelledby="wl-recent">
        <div className="row between base">
          <h2 className="h2">
            <span id="wl-recent">Recently viewed</span>
          </h2>
          {recent.length > 0 && (
            <a
              className="small strong"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setRecent([]);
                announce('Browsing history cleared');
              }}
            >
              Clear history <Icon name="arrow-right" className="ic-sm" />
            </a>
          )}
        </div>
        {recent.length ? (
          <div className="hscroll acct-recent">
            {recent.map((id) => {
              const p = P[id];
              return (
                <Link key={id} to={href('store/product')} className="stack gap-2 link-plain">
                  <Img icon={p.icon} tint={p.tint} />
                  <span className="xs clamp-2">{p.name}</span>
                  <Price amount={p.price} was={p.was} noOff />
                </Link>
              );
            })}
          </div>
        ) : (
          <p className="small muted">
            History cleared. Products you view from now on show up here.
          </p>
        )}
      </section>
    </AccountLayout>
  );
}
