import { useEffect, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { Alert, Badge, Button, Icon, SummaryRow, Timeline, announce } from '@marketly/web-shared/ui';
import { ItemImg, PkgHead, SkRows, plural } from './data/purchase';
import { addressLine, paymentHref } from './data/checkout-api';

// Design: pages/store/store-confirmation.html. URL: /checkout/confirmation?session=<checkout session id>.
// Data: GET /api/store/checkout/sessions/{id}/confirmation (ConfirmationView; 409 while the payment is not
// accepted → payment result page). Receipt: GET /api/store/orders/orders/{orderId}/documents/{receiptDocumentId}
// (short-lived PDF link). The cart badge is re-read (the order took the purchased lines).

export default function Confirmation() {
  const [params] = useSearchParams();
  const id = params.get('session');
  const { api } = useApi();
  const { refreshCart } = useSession();
  const q = useQuery({
    queryKey: ['checkout', 'confirmation', id ?? ''],
    queryFn: () => call(api.GET('/api/store/checkout/sessions/{id}/confirmation', { params: { path: { id: id! } } })),
    enabled: !!id,
  });
  useEffect(() => refreshCart(), [refreshCart]);

  const receipt = useMutation({
    mutationFn: () => call(api.GET('/api/store/orders/orders/{id}/documents/{documentId}', { params: { path: { id: q.data!.orderId, documentId: q.data!.receiptDocumentId! } } })),
    onSuccess: (doc) => {
      const a = document.createElement('a');
      a.href = doc.url;
      a.download = doc.fileName;
      a.target = '_blank';
      a.rel = 'noopener';
      a.click();
      announce('Receipt downloaded');
    },
  });

  if (!id) return <Navigate to={href('store/cart')} replace />;
  // Not accepted yet (pending or failed): the payment result page explains what's happening.
  if (q.error instanceof ApiError && q.error.code === 'ILLEGAL_TRANSITION') return <Navigate to={paymentHref(id)} replace />;

  const shell = (children: ReactNode) => (
    <StoreLayout tab="cart" appbar={{ title: 'Order placed' }}>
      <div className="container page">
        <div className="buy-narrow stack gap-5">{children}</div>
      </div>
    </StoreLayout>
  );

  if (q.isError) {
    const gone = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 410);
    return shell(
      <>
        <h1 className="h1">{gone ? 'We couldn’t find this order confirmation' : 'Order confirmation'}</h1>
        <Alert tone={gone ? 'warning' : 'danger'} title={gone ? 'This link no longer works' : 'We couldn’t load your confirmation'}>
          {errorMessage(q.error)}{' '}
          {gone ? (
            <Link to={href('auth/guest-orders')} className="link-inline">
              Look up an order
            </Link>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
              Try again
            </Button>
          )}
        </Alert>
      </>,
    );
  }
  const o = q.data;
  if (!o) {
    return shell(
      <>
        <span className="sr-only">Loading your order confirmation</span>
        <div className="stack gap-3" aria-hidden="true">
          <span className="sk sk-line short" />
          <span className="sk sk-line" />
        </div>
        <div className="card pad">
          <SkRows n={3} />
        </div>
      </>,
    );
  }

  const t = o.totals;
  const steps = o.nextSteps;

  return shell(
    <>
      <div className="stack gap-3 items-start">
        <span className="buy-result-icon t-success">
          <Icon name="circle-check" />
        </span>
        <h1 className="h1">Order placed. Thank you{o.greetingName ? `, ${o.greetingName}` : ''}.</h1>
        <p className="sub">
          We sent a confirmation to <b>{o.email}</b>. {o.packagesNote}
        </p>
      </div>
      <div className="card pad">
        <div className="grid md3 gap-4">
          <div className="stack gap-1">
            <span className="xs muted">Order reference</span>
            <span className="buy-ref">{o.orderRef}</span>
          </div>
          <div className="stack gap-1">
            <span className="xs muted">Charged to {o.paymentLabel}</span>
            <span className="strong num">{formatMoney(o.charged)}</span>
            <span>
              <Badge tone="success">Accepted</Badge>
            </span>
          </div>
          <div className="stack gap-1">
            <span className="xs muted">Delivering to</span>
            <span className="small strong">{o.deliveryAddress.name}</span>
            <span className="xs sub">{addressLine(o.deliveryAddress)}</span>
          </div>
        </div>
      </div>
      {o.offerAccountCreation && (
        <Alert tone="brand" title="Create your account">
          You asked to create an account after checkout, so you can track all your orders in one place.{' '}
          <Link to={href('auth/register')} className="link-inline">
            Create an account with {o.email}
          </Link>
        </Alert>
      )}
      {o.packages.length > 1 && (
        <Alert tone="info" title="Packages may arrive separately">
          Each seller ships its own package and you'll get tracking for each one as it ships.
        </Alert>
      )}
      {o.packages.map((pkg) => (
        <section className="card buy-pkg" key={pkg.label}>
          <PkgHead seller={pkg.seller} label={pkg.label} shipsFrom={pkg.shipsFrom} arrives={pkg.arrivalLabel} shipNote={pkg.shippingLabel} />
          {pkg.items.map((l, i) => (
            <div className="buy-item" key={`${l.title}-${i}`}>
              <span>
                <ItemImg image={l.image} />
              </span>
              <div className="stack gap-1">
                <span className="buy-name">{l.title}</span>
                <span className="xs sub">
                  {l.variantLabel} · {l.condition} · Qty {l.quantity}
                </span>
                <span>
                  <Badge tone="info">{l.status}</Badge>
                </span>
              </div>
              <div className="buy-item-side">
                <span className="small strong num">{formatMoney(l.price)}</span>
              </div>
            </div>
          ))}
        </section>
      ))}
      <div className="card pad buy-sum">
        <SummaryRow k={`Items (${t.itemCount})`} v={formatMoney(t.items)} />
        {t.discounts.map((d, i) => (
          <SummaryRow key={`${d.code ?? d.label}-${i}`} className="discount" k={d.code ?? d.label} v={`−${formatMoney(d.amount)}`} />
        ))}
        {t.creditApplied.amount > 0 && <SummaryRow className="discount" k="Marketly credit" v={`−${formatMoney(t.creditApplied)}`} />}
        <SummaryRow k={`Shipping (${plural(o.packages.length, 'package')})`} v={t.shippingTotal.amount ? formatMoney(t.shippingTotal) : 'Free'} />
        {t.tax.length ? t.tax.map((x) => <SummaryRow key={x.jurisdiction} k={x.label} v={formatMoney(x.amount)} />) : <SummaryRow k="Tax" v={formatMoney(t.taxTotal)} />}
        <SummaryRow className="total" k="Charged" v={formatMoney(o.charged)} />
      </div>
      {steps.length > 0 && (
        <section className="card pad stack gap-3">
          <h2 className="h3">What happens next</h2>
          <Timeline events={steps.map((s, i) => ({ t: s.title, d: s.when, state: i === 0 ? 'current' : '', body: s.body }))} />
        </section>
      )}
      {receipt.isError && (
        <Alert tone="danger" title="We couldn't get your receipt">
          {errorMessage(receipt.error)}
        </Alert>
      )}
      <div className="row gap-2">
        <Button to={href('account/order', '', { ref: o.orderRef })} iconRight="arrow-right">
          View order
        </Button>
        <Button variant="secondary" icon="headset" to={href('help/contact')}>
          Contact support
        </Button>
        {o.receiptDocumentId && (
          <Button variant="ghost" icon="download" onClick={() => receipt.mutate()} disabled={receipt.isPending}>
            Download receipt
          </Button>
        )}
      </div>
      <p className="xs muted">
        {o.termsNote}{' '}
        <Link to={href('store/home')} className="link-inline">
          Continue shopping
        </Link>
      </p>
    </>,
  );
}
