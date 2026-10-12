import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router';
import { order, P, sellers, type Seller, type SellerId } from '@marketly/web-shared/data/fixtures';
import { StoreLayout } from '@/layouts';
import { money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Field, FileDrop, Icon, IconButton, Img, LogoTile, OptionCard, SellerBadge, StatusBadge, Textarea, type IconName } from '@marketly/web-shared/ui';

// Design: pages/store/help-order-problem.html (the order's packages, with the delayed duvet preselected).

type ProblemType = 'missing' | 'damaged' | 'wrong' | 'late' | 'other';
type Remedy = 'refund' | 'wait' | 'replace';

const TYPES: Array<{ id: ProblemType; label: string; icon: IconName }> = [
  { id: 'missing', label: 'Item missing from package', icon: 'package-x' },
  { id: 'damaged', label: 'Arrived damaged', icon: 'package-open' },
  { id: 'wrong', label: 'Wrong item', icon: 'replace' },
  { id: 'late', label: "Hasn't arrived", icon: 'clock' },
  { id: 'other', label: 'Something else', icon: 'circle-help' },
];

const PHOTO_REQUIRED: ProblemType[] = ['damaged', 'wrong'];

export default function OrderProblem() {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>(['duvet']);
  const [type, setType] = useState<ProblemType | ''>('late');
  const [details, setDetails] = useState("The duvet cover was due on Sep 22 and still hasn't shipped. I'd like it by mid-October or my money back.");
  const [photos, setPhotos] = useState<File[]>([]);
  const [remedy, setRemedy] = useState<Remedy>('refund');
  const [attempted, setAttempted] = useState(false);

  const lines = order.groups.flatMap((g) => g.items.map((it) => ({ ...it, seller: g.seller as SellerId })));
  const chosen = lines.filter((l) => selected.includes(l.p));
  const refund = chosen.reduce((s, l) => s + l.price * l.qty, 0);
  const handlers = Array.from(new Set(chosen.map((l) => l.seller)));
  const handler: Seller | null = handlers.length === 1 ? sellers[handlers[0]] : null;
  const isLate = type === 'late';

  const errors: { items?: string; type?: string; details?: string; photos?: string } = {};
  if (attempted) {
    if (!selected.length) errors.items = 'Select at least one item.';
    if (!type) errors.type = "Choose what's wrong.";
    if (!details.trim()) errors.details = 'Describe the problem so the seller can help.';
    if (type && PHOTO_REQUIRED.includes(type) && !photos.length) errors.photos = 'Add at least one photo of the item.';
  }
  const nErrors = Object.keys(errors).length;

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const submit = () => {
    setAttempted(true);
    const bad = !selected.length || !type || !details.trim() || (type && PHOTO_REQUIRED.includes(type) && !photos.length);
    if (!bad) navigate(href('help/case'));
  };

  const remedies: Array<{ id: Remedy; title: string; body: string }> = [
    { id: 'refund', title: 'Refund', body: `${money(refund)} back to ${order.payment}${isLate ? " if the item can't ship soon" : ''}` },
    isLate ? { id: 'wait', title: 'Keep waiting for it', body: 'Ship as soon as possible, with a firm date from the seller' } : { id: 'replace', title: 'Replacement', body: 'The seller sends a new one if it is in stock' },
  ];
  const activeRemedy = remedies.some((r) => r.id === remedy) ? remedy : 'refund';

  return (
    <StoreLayout tab="account" appbar={{ title: 'Report a problem', back: href('account/order') }}>
      <div className="container page">
        <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: order.ref, to: href('account/order') }, { label: 'Report a problem' }]} />
        <div className="split">
          <div className="stack gap-4">
            <div className="stack gap-1">
              <h1 className="h1">Report a problem</h1>
              <p className="small sub">
                Order <span className="mono">{order.ref}</span> · placed {order.placed}
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
                  <span className="xs muted">We selected the item you came from. Add others if needed.</span>
                </div>
              </div>
              {order.groups.map((g) => {
                const s = sellers[g.seller as SellerId];
                return (
                  <Fragment key={g.pkg}>
                    <div className="buy-pkg-head bt">
                      <span className="row gap-2">
                        <span className="small strong">
                          {g.pkg} · {s.name}
                        </span>
                        <SellerBadge seller={s} compact />
                      </span>
                      <StatusBadge status={g.status} />
                    </div>
                    {g.items.map((it) => {
                      const p = P[it.p];
                      return (
                        <label key={it.p} className="buy-item buy-item-chk u-cur-pointer" htmlFor={`op-it-${it.p}`}>
                          <span className="row gap-3 nowrap">
                            <input type="checkbox" id={`op-it-${it.p}`} className="check-input" checked={selected.includes(it.p)} onChange={() => toggle(it.p)} />
                            <Img icon={p.icon} tint={p.tint} className="thumb" />
                          </span>
                          <span className="stack gap-1">
                            <span className="buy-name">{p.name}</span>
                            <span className="xs sub">
                              {it.variant} · Qty {it.qty} · {money(it.price)}
                            </span>
                            <span>
                              <StatusBadge status={it.state} />
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </Fragment>
                );
              })}
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
                <div className="buy-opts c2" role="radiogroup" aria-label="What's wrong?">
                  {TYPES.map((t) => (
                    <OptionCard
                      key={t.id}
                      id={`op-type-${t.id}`}
                      name="op-type"
                      checked={type === t.id}
                      onChange={() => setType(t.id)}
                      title={
                        <span className="row gap-2 small strong">
                          <Icon name={t.icon} className="ic-sm" />
                          {t.label}
                        </span>
                      }
                    />
                  ))}
                </div>
                {errors.type && (
                  <span className="error-text">
                    <Icon name="circle-alert" className="ic-sm" />
                    {errors.type}
                  </span>
                )}
                {isLate && selected.includes('duvet') && (
                  <div className="buy-note">
                    <Icon name="triangle-alert" />
                    <span>This package was due Sep 22. Casa Verde Home now estimates Oct 12. No tracking number has been added yet.</span>
                  </div>
                )}
                <Field label="Details" error={errors.details}>
                  <Textarea id="op-details" placeholder="" value={details} onChange={(e) => setDetails(e.target.value)} />
                </Field>
                <div className="field">
                  <span className="label">
                    Photos <span className="opt">({type && PHOTO_REQUIRED.includes(type) ? 'required for damaged or wrong items' : 'optional for late items'})</span>
                  </span>
                  <FileDrop title="Add photos of the package or item" hint="Helpful for damaged, wrong or missing items. JPG or PNG, up to 10 MB each" onFiles={(f) => setPhotos((l) => [...l, ...f])} />
                  {errors.photos && (
                    <span className="error-text">
                      <Icon name="circle-alert" className="ic-sm" />
                      {errors.photos}
                    </span>
                  )}
                  {photos.length > 0 && (
                    <ul className="list">
                      {photos.map((f, i) => (
                        <li key={`${f.name}${i}`} className="row gap-2">
                          <Icon name="image" className="ic-sm" />
                          <span className="small grow">{f.name}</span>
                          <IconButton icon="x" size="sm" label={`Remove ${f.name}`} onClick={() => setPhotos((l) => l.filter((_, j) => j !== i))} />
                        </li>
                      ))}
                    </ul>
                  )}
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
                  {remedies.map((r) => (
                    <OptionCard key={r.id} id={`op-rem-${r.id}`} name="op-rem" checked={activeRemedy === r.id} onChange={() => setRemedy(r.id)} title={<span className="small strong">{r.title}</span>} body={r.body} />
                  ))}
                </div>
                <span className="xs muted">The seller or Marketly confirms the final remedy. A refund shows as Sent only when it has left us.</span>
              </div>
              <div className="card-foot">
                <Button variant="ghost" to={href('account/order')}>
                  Cancel
                </Button>
                <Button icon="send" onClick={submit}>
                  {handler ? `Send to ${handler.name}` : handlers.length ? 'Send to the sellers' : 'Send report'}
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
                    <LogoTile initials={handler.initials} tint={handler.tint} />
                    <div className="stack gap-0">
                      <span className="small strong">{handler.official ? 'Marketly support handles it' : `${handler.name} handles it first`}</span>
                      <span className="xs muted">{handler.official ? 'We shipped this package and reply within 1 business day.' : 'The seller shipped this package and must reply within 2 business days, by Mon, Oct 12.'}</span>
                    </div>
                  </div>
                ) : (
                  <div className="row gap-3 nowrap">
                    <Icon name="store" />
                    <div className="stack gap-0">
                      <span className="small strong">{handlers.length ? 'Each seller handles their items first' : 'Select the affected items'}</span>
                      <span className="xs muted">{handlers.length ? 'Sellers must reply within 2 business days.' : 'We send the report to whoever shipped them.'}</span>
                    </div>
                  </div>
                )}
                <hr />
                <div className="row top gap-3 nowrap">
                  <Icon name="life-buoy" />
                  <div className="stack gap-1">
                    <span className="small strong">When Marketly steps in</span>
                    <ul className="ul xs sub stack gap-1">
                      <li>If the seller hasn't replied within 2 business days</li>
                      <li>If you don't agree with the seller's answer</li>
                      <li>If a promised refund isn't sent on time</li>
                    </ul>
                  </div>
                </div>
                <span className="xs muted">You'll get a case number and can follow every reply in Support cases.</span>
              </div>
            </section>
            <div className="card pad stack gap-2">
              <span className="small strong">Other items in this order</span>
              <span className="xs muted">The SSDs are in transit and arrive Oct 9–10. Report them after that date if they don't show up.</span>
            </div>
          </aside>
        </div>
      </div>
    </StoreLayout>
  );
}
