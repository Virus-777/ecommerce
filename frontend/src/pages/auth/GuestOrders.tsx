import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { StoreLayout } from '@/layouts';
import { useView } from '@/lib/hooks';
import { money } from '@/lib/format';
import { sellers, type SellerId, type Tint } from '@/data/fixtures';
import { href } from '@/routes/href';
import { Alert, Button, Field, Icon, Img, LogoTile, SellerBadge, StatusBadge, SummaryRow, TextInput, announce, type IconName } from '@/ui';
import { AuthShell, EMAIL_RE, useSignedOut } from './data/parts';

// Design: pages/store/auth-guest-orders.html · view "found" = the order after a successful lookup.
// In this mock the sample guest order is MK-261002-66018 for taylor.brooks@example.com.

interface GuestPackage {
  seller: SellerId;
  carrier: string;
  tracking: string;
  status: string;
  when: string;
  items: Array<{ name: string; icon: IconName; tint: Tint; variant: string; qty: number; price: number }>;
  shipping: number;
}

const GUEST_ORDER = {
  ref: 'MK-261002-66018',
  email: 'taylor.brooks@example.com',
  placed: 'Fri, Oct 2, 2026',
  status: 'Partly delivered',
  payment: 'Mastercard •••• 2291',
  paymentStatus: 'Accepted',
  deliverTo: 'Taylor Brooks, 77 NE Fremont St, Portland, OR 97212',
  tax: 0,
  packages: [
    {
      seller: 'official',
      carrier: 'UPS Ground',
      tracking: '1Z84E2W70392044210',
      status: 'Delivered',
      when: 'Delivered Tue, Oct 6',
      items: [{ name: 'Pellar Pre-seasoned Cast Iron Skillet 26 cm', icon: 'cooking-pot', tint: '3', variant: '26 cm', qty: 1, price: 58 }],
      shipping: 0,
    },
    {
      seller: 'trailhead',
      carrier: 'USPS Ground Advantage',
      tracking: '9400 1112 0298 7741 5530 18',
      status: 'In transit',
      when: 'Arrives Fri, Oct 9',
      items: [{ name: 'Tidewell Insulated Bottle 750 ml', icon: 'cup-soda', tint: '6', variant: 'Slate', qty: 1, price: 29.5 }],
      shipping: 4.99,
    },
  ] as GuestPackage[],
};

const REF_RE = /^MK-\d{6}-\d{5}$/;

export default function GuestOrders() {
  const [view, setView] = useView<'found'>();
  useSignedOut();
  return view === 'found' ? <Found /> : <Lookup onFound={() => setView('found')} />;
}

function Lookup({ onFound }: { onFound: () => void }) {
  const [ref, setRef] = useState(GUEST_ORDER.ref);
  const [email, setEmail] = useState(GUEST_ORDER.email);
  const [errors, setErrors] = useState<{ ref?: string; email?: string }>({});
  const [notFound, setNotFound] = useState(false);
  const [linksSent, setLinksSent] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = ref.trim().toUpperCase();
    const next: typeof errors = {};
    if (!REF_RE.test(r)) next.ref = 'Enter the reference as it appears in your email, like MK-261002-66018.';
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter the email you used at checkout.';
    setErrors(next);
    setNotFound(false);
    if (next.ref || next.email) return;
    if (r !== GUEST_ORDER.ref || email.trim().toLowerCase() !== GUEST_ORDER.email) {
      setNotFound(true);
      return;
    }
    onFound();
  };

  return (
    <AuthShell title="Guest order lookup" onSubmit={submit}>
      <span className="buy-result-icon t-info">
        <Icon name="package-search" />
      </span>
      <div className="stack gap-1">
        <h1 className="h2">Find your guest order</h1>
        <p className="small sub">Bought without an account? Look up your order to track packages, start a return or get help.</p>
      </div>
      {notFound && (
        <Alert tone="danger" title="We couldn't find that order">
          Check the reference and use the same email you entered at checkout. Orders placed in the last few minutes can take a moment to appear.
        </Alert>
      )}
      <Field label="Order reference" hint="It's in your confirmation email, starting with MK-." error={errors.ref}>
        <TextInput id="go-ref" value={ref} error={!!errors.ref} placeholder="MK-YYMMDD-NNNNN" autoCapitalize="characters" onChange={(e) => setRef(e.target.value)} />
      </Field>
      <Field label="Email used at checkout" error={errors.email}>
        <TextInput id="go-email" type="email" value={email} error={!!errors.email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Button type="submit" size="lg" block>
        Find order
      </Button>
      <p className="xs muted">
        We can also email you a fresh link to every order placed with this email.{' '}
        {linksSent ? (
          <span className="strong">Sent. Check your inbox.</span>
        ) : (
          <a
            href="#"
            className="link-inline"
            onClick={(e) => {
              e.preventDefault();
              if (!EMAIL_RE.test(email.trim())) {
                setErrors((x) => ({ ...x, email: 'Enter the email you used at checkout.' }));
                return;
              }
              setLinksSent(true);
              announce(`If there are orders for ${email.trim()}, we've emailed links to them.`);
            }}
          >
            Email me my order links
          </a>
        )}
      </p>
      <p className="small center">
        Have an account?{' '}
        <Link className="strong link-inline" to={href('auth/sign-in')}>
          Sign in
        </Link>{' '}
        to see all your orders.
      </p>
    </AuthShell>
  );
}

function Found() {
  const o = GUEST_ORDER;
  const items = o.packages.flatMap((p) => p.items);
  const itemsTotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const total = itemsTotal + o.packages.reduce((s, p) => s + p.shipping, 0) + o.tax;
  // Paid shipping first, as on the design's receipt.
  const shipRows = [...o.packages].sort((a, b) => b.shipping - a.shipping);
  return (
    <StoreLayout tab="account" appbar={{ title: 'Your order', back: href('auth/guest-orders') }}>
      <div className="container page">
        <div className="buy-narrow stack gap-5">
          <div className="stack gap-2">
            <Link className="small strong no-phone" to={href('auth/guest-orders')}>
              <Icon name="arrow-left" className="ic-sm" /> Look up another order
            </Link>
            <h1 className="h1">
              Order <span className="buy-ref">{o.ref}</span>
            </h1>
            <p className="small sub">
              Placed {o.placed} as a guest · {o.email}
            </p>
          </div>
          <div className="card pad">
            <div className="grid md3 gap-4">
              <div className="stack gap-1">
                <span className="xs muted">Order status</span>
                <StatusBadge status={o.status} />
              </div>
              <div className="stack gap-1">
                <span className="xs muted">Payment · {o.payment}</span>
                <span className="row gap-2">
                  <span className="strong num">{money(total)}</span>
                  <StatusBadge status={o.paymentStatus} />
                </span>
              </div>
              <div className="stack gap-1">
                <span className="xs muted">Delivering to</span>
                <span className="small">{o.deliverTo}</span>
              </div>
            </div>
          </div>
          {o.packages.map((p, i) => {
            const s = sellers[p.seller];
            return (
              <section className="card buy-pkg" key={p.seller}>
                <div className="buy-pkg-head">
                  <div className="row gap-2">
                    <LogoTile initials={s.initials} tint={s.tint} />
                    <div className="stack gap-0">
                      <span className="row gap-2">
                        <span className="strong">{s.name}</span>
                        <SellerBadge seller={s} compact />
                      </span>
                      <span className="xs muted">
                        Package {i + 1} of {o.packages.length} · {p.carrier} · {p.tracking}
                      </span>
                    </div>
                  </div>
                  <span className="row gap-2">
                    <StatusBadge status={p.status} />
                    <span className="xs strong">{p.when}</span>
                  </span>
                </div>
                {p.items.map((it) => (
                  <div className="buy-item" key={it.name}>
                    <span>
                      <Img icon={it.icon} tint={it.tint} />
                    </span>
                    <div className="stack gap-1">
                      <span className="buy-name">{it.name}</span>
                      <span className="xs sub">
                        {it.variant} · New · Qty {it.qty}
                      </span>
                      <span>
                        <StatusBadge status={p.status} />
                      </span>
                    </div>
                    <div className="buy-item-side">
                      <span className="small strong num">{money(it.price * it.qty)}</span>
                    </div>
                  </div>
                ))}
                <div className="card-foot">
                  <Button variant="secondary" size="sm" icon="truck" to={href('account/tracking')}>
                    Track package
                  </Button>
                  <Button variant="ghost" size="sm" icon="life-buoy" to={href('help/order-problem')}>
                    Get help
                  </Button>
                </div>
              </section>
            );
          })}
          <div className="card pad buy-sum">
            <SummaryRow k={`Items (${items.length})`} v={money(itemsTotal)} />
            {shipRows.map((p) => (
              <SummaryRow key={p.seller} k={`Shipping · ${sellers[p.seller].name}`} v={p.shipping ? money(p.shipping) : 'Free'} />
            ))}
            <SummaryRow k="Tax" v={money(o.tax)} />
            <SummaryRow className="total" k="Total charged" v={money(total)} />
          </div>
          <div className="panel row gap-3">
            <Icon name="user-plus" />
            <span className="small grow">Create an account with {o.email} to keep this order and future orders in one place.</span>
            <Button variant="secondary" size="sm" to={href('auth/register')}>
              Create account
            </Button>
          </div>
        </div>
      </div>
    </StoreLayout>
  );
}
