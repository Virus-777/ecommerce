import { useEffect } from 'react';
import { Link } from 'react-router';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { money } from '@marketly/web-shared/lib/format';
import { sellers } from '@marketly/web-shared/data/fixtures';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Icon, Img, SummaryRow, Timeline, announce } from '@marketly/web-shared/ui';
import { CARD, COUPON_WELCOME, ORDER_ITEMS, ORDER_LINES, ORDER_REF, ORDER_SHIPPING, ORDER_TOTAL, PkgHead, groupBySeller, pkgMeta, plural } from './data/purchase';

// Design: pages/store/store-confirmation.html

const GROUPS = groupBySeller(ORDER_LINES);
const N_ITEMS = ORDER_LINES.reduce((s, l) => s + l.qty, 0);
const ADDRESS = { name: 'Jordan Lee', line: '2140 Alder St, Apt 5, Portland, OR 97205' };

function receiptText(email: string) {
  const rows = ORDER_LINES.map((l) => `${l.name} (${l.variant}) x${l.qty}  ${money(l.price * l.qty)}  · ${sellers[l.seller].name}`);
  return [
    `Marketly receipt · Order ${ORDER_REF}`,
    `Placed Thu, Oct 8, 2026 · ${email}`,
    '',
    ...rows,
    '',
    `Items (${N_ITEMS})  ${money(ORDER_ITEMS)}`,
    `${COUPON_WELCOME.code}  −${money(COUPON_WELCOME.amount)}`,
    `Shipping (${GROUPS.length} packages)  ${money(ORDER_SHIPPING)}`,
    'Tax  $0.00',
    `Charged to ${CARD}  ${money(ORDER_TOTAL)}`,
    '',
    `Delivering to ${ADDRESS.name}, ${ADDRESS.line}`,
  ].join('\n');
}

export default function Confirmation() {
  const { customer, setCartCount } = useSession();

  // The order took the cart's items.
  useEffect(() => setCartCount(0), [setCartCount]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([receiptText(customer.email)], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `marketly-receipt-${ORDER_REF}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    announce('Receipt downloaded');
  };

  return (
    <StoreLayout tab="cart" appbar={{ title: 'Order placed' }}>
      <div className="container page">
        <div className="buy-narrow stack gap-5">
          <div className="stack gap-3 items-start">
            <span className="buy-result-icon t-success">
              <Icon name="circle-check" />
            </span>
            <h1 className="h1">Order placed. Thank you, {customer.first}.</h1>
            <p className="sub">
              We sent a confirmation to <b>{customer.email}</b>. Your {plural(N_ITEMS, 'item')} ship in {plural(GROUPS.length, 'package')} that may arrive on different days.
            </p>
          </div>
          <div className="card pad">
            <div className="grid md3 gap-4">
              <div className="stack gap-1">
                <span className="xs muted">Order reference</span>
                <span className="buy-ref">{ORDER_REF}</span>
              </div>
              <div className="stack gap-1">
                <span className="xs muted">Charged to {CARD}</span>
                <span className="strong num">{money(ORDER_TOTAL)}</span>
                <span>
                  <Badge tone="success">Accepted</Badge>
                </span>
              </div>
              <div className="stack gap-1">
                <span className="xs muted">Delivering to</span>
                <span className="small strong">{ADDRESS.name}</span>
                <span className="xs sub">{ADDRESS.line}</span>
              </div>
            </div>
          </div>
          <Alert tone="info" title="Packages may arrive separately">
            Each seller ships its own package and you'll get tracking for each one as it ships.
          </Alert>
          {GROUPS.map((g, gi) => {
            const meta = pkgMeta(g.seller);
            return (
              <section className="card buy-pkg" key={g.seller}>
                <PkgHead seller={g.seller} index={gi + 1} total={GROUPS.length} arrives={meta.options[0].arrives} shipNote={meta.shipNote} />
                {g.lines.map((l) => (
                  <div className="buy-item" key={l.id}>
                    <span>
                      <Img icon={l.icon} tint={l.tint} />
                    </span>
                    <div className="stack gap-1">
                      <span className="buy-name">{l.name}</span>
                      <span className="xs sub">
                        {l.variant} · {l.condition} · Qty {l.qty}
                      </span>
                      <span>
                        <Badge tone="info">Confirmed</Badge>
                      </span>
                    </div>
                    <div className="buy-item-side">
                      <span className="small strong num">{money(l.price * l.qty)}</span>
                    </div>
                  </div>
                ))}
              </section>
            );
          })}
          <div className="card pad buy-sum">
            <SummaryRow k={`Items (${N_ITEMS})`} v={money(ORDER_ITEMS)} />
            <SummaryRow className="discount" k={COUPON_WELCOME.code} v={`−${money(COUPON_WELCOME.amount)}`} />
            <SummaryRow k={`Shipping (${plural(GROUPS.length, 'package')})`} v={money(ORDER_SHIPPING)} />
            <SummaryRow k="Tax" v="$0.00" />
            <SummaryRow className="total" k="Charged" v={money(ORDER_TOTAL)} />
          </div>
          <section className="card pad stack gap-3">
            <h2 className="h3">What happens next</h2>
            <Timeline
              events={[
                { t: 'Sellers confirm and prepare your items', d: 'Today', state: 'current', body: 'You can cancel an item from the order page until its seller ships it.' },
                { t: 'Each package ships with its own tracking', d: 'Oct 9 – Oct 13', body: 'We email you as each package leaves.' },
                { t: 'Delivered', d: 'Oct 14 – Oct 20', body: 'Returns and help are on the order page, item by item.' },
              ]}
            />
          </section>
          <div className="row gap-2">
            <Button to={href('account/order')} iconRight="arrow-right">
              View order
            </Button>
            <Button variant="secondary" icon="headset" to={href('help/contact')}>
              Contact support
            </Button>
            <Button variant="ghost" icon="download" onClick={download}>
              Download receipt
            </Button>
          </div>
          <p className="xs muted">
            Your order keeps the purchase terms and each seller's return terms as they were when you ordered.{' '}
            <Link to={href('store/home')} className="link-inline">
              Continue shopping
            </Link>
          </p>
        </div>
      </div>
    </StoreLayout>
  );
}
