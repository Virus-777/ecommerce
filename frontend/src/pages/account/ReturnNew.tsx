import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { order, P, sellers, type SellerId } from '@marketly/web-shared/data/fixtures';
import { AccountLayout } from '@/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Card, Field, FileDrop, Icon, Img, KeyValue, OptionCard, Select, SellerLine, StatusBadge, Steps, SummaryRow, TableWrap, Textarea } from '@marketly/web-shared/ui';

// Design: pages/store/account-return-new.html · a 3-step wizard: "" = choose items,
// "reason-and-remedy" = what's wrong + what you want, "review" = check and submit.

type Step = '' | 'reason-and-remedy' | 'review';
const STEP_INDEX: Record<Step, number> = { '': 0, 'reason-and-remedy': 1, review: 2 };

interface Line {
  p: string;
  variant: string;
  price: number;
  qty: number;
  seller: SellerId;
  state: string;
  eligible: boolean;
  note: string;
}

const LINES: Line[] = [
  { p: 'aurora', variant: 'Midnight black', price: 189, qty: 1, seller: 'official', state: 'Delivered', eligible: true, note: 'Return by Sat, Oct 17' },
  { p: 'pourover', variant: 'Cream', price: 36, qty: 1, seller: 'official', state: 'Return requested', eligible: false, note: 'Return RT-260921-0457 already open' },
  { p: 'ssd1tb', variant: 'Space gray', price: 94.99, qty: 2, seller: 'pixelport', state: 'In transit', eligible: false, note: 'Not delivered yet. You can return it after it arrives.' },
  { p: 'duvet', variant: 'Queen · Sage', price: 119, qty: 1, seller: 'casaverde', state: 'Delayed', eligible: false, note: 'Not shipped yet. You can cancel it instead.' },
];

const REASONS = ['Choose a reason', 'Defective or stopped working', 'Arrived damaged', 'Wrong item sent', 'Not as described', 'Changed my mind', 'Better price elsewhere'];
const BUYER_PAYS = ['Changed my mind', 'Better price elsewhere'];
const RETURN_SHIPPING = 7.99;

type Remedy = 'refund' | 'repl' | 'credit';
const REMEDIES: Array<{ id: Remedy; title: string; body: string; want: string }> = [
  { id: 'refund', title: 'Refund to original payment', body: `${order.payment}. Sent after inspection, then 3–5 business days at your bank.`, want: `Refund to ${order.payment}` },
  { id: 'repl', title: 'Replacement', body: 'Same color, in stock. Ships once we scan your return at drop-off.', want: 'Replacement, same color' },
  { id: 'credit', title: 'Marketly store credit', body: 'Issued when we receive the item, usually 2 days sooner than a card refund.', want: 'Marketly store credit' },
];

interface Photo {
  id: string;
  src?: string;
  name: string;
}

const couponShare = (price: number, qty: number) => Math.round(((order.discount * price * qty) / order.subtotal) * 100) / 100;

function Eligibility() {
  return (
    <section className="acct-eligible" aria-label="Return eligibility">
      <div className="row gap-2">
        <Icon name="circle-check" />
        <span className="strong">This item can be returned</span>
      </div>
      <KeyValue
        pairs={[
          [
            'Return by',
            <>
              Sat, Oct 17, 2026 <span className="xs muted">(30 days after delivery)</span>
            </>,
          ],
          ['Ships back to', "Marketly Returns, Reno, NV warehouse. Items from outside sellers go to the seller's return address, shown here before you submit."],
          [
            'Return shipping',
            <>
              <span className="t-success-text strong">Free</span> for a defective item. $7.99 is deducted for change-of-mind returns.
            </>,
          ],
          ['Response', 'Marketly Official reviews within 1 business day.'],
        ]}
      />
    </section>
  );
}

export default function ReturnNew() {
  const [view, setView] = useView<Exclude<Step, ''>>();
  const navigate = useNavigate();
  const step = (view in STEP_INDEX ? view : '') as Step;
  const [selected, setSelected] = useState<string[]>(['aurora']);
  const [qty, setQty] = useState<Record<string, number>>({ aurora: 1 });
  const [reason, setReason] = useState(REASONS[1]);
  const [details, setDetails] = useState('The left ear cup cuts out every few minutes over Bluetooth. Reset it twice, still happens. Wired mode works.');
  const [photos, setPhotos] = useState<Photo[]>([
    { id: 'p1', name: 'Photo 1' },
    { id: 'p2', name: 'Photo 2' },
  ]);
  const [remedy, setRemedy] = useState<Remedy>('refund');
  const [attempted, setAttempted] = useState<Record<number, boolean>>({});

  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => photosRef.current.forEach((p) => p.src && URL.revokeObjectURL(p.src)), []);

  const chosen = LINES.filter((l) => selected.includes(l.p));
  const buyerPays = BUYER_PAYS.includes(reason);
  const itemTotal = chosen.reduce((s, l) => s + l.price * (qty[l.p] ?? 1), 0);
  const share = chosen.reduce((s, l) => s + couponShare(l.price, qty[l.p] ?? 1), 0);
  const refund = itemTotal - share - (buyerPays ? RETURN_SHIPPING : 0);

  const err1 = attempted[0] && chosen.length === 0 ? 'Choose at least one item to return.' : undefined;
  const errReason = attempted[1] && reason === REASONS[0] ? 'Choose a reason.' : undefined;
  const errDetails = attempted[1] && !buyerPays && details.trim().length < 10 ? 'Describe the problem in a sentence or two.' : undefined;

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
      if (reason !== REASONS[0] && (buyerPays || details.trim().length >= 10)) go('review');
    } else {
      navigate(href('account/return'));
    }
  };
  const back = () => (step === 'review' ? go('reason-and-remedy') : go(''));
  const addFiles = (files: File[]) => setPhotos((ps) => [...ps, ...files.map((f, i) => ({ id: `${Date.now()}-${i}`, name: f.name, src: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined }))]);

  const backBtn =
    step === '' ? (
      <Button variant="ghost" to={href('account/order')}>
        Cancel
      </Button>
    ) : (
      <Button variant="ghost" onClick={back}>
        Back
      </Button>
    );
  const nextBtn =
    step === 'review' ? (
      <Button icon="check" onClick={next}>
        Request return
      </Button>
    ) : (
      <Button iconRight="arrow-right" onClick={next}>
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

  const first = chosen[0] ?? LINES[0];
  const firstP = P[first.p];
  const firstSentence = details.trim().split(/(?<=\.)\s/)[0];

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
          <section className="card" aria-label="Delivered items">
            {LINES.map((l) => {
              const p = P[l.p];
              return (
                <div key={l.p} className={cx('acct-check', !l.eligible && 'is-off')}>
                  <input type="checkbox" id={`rn-${l.p}`} aria-label={`Return ${p.name}`} checked={selected.includes(l.p)} disabled={!l.eligible} onChange={() => setSelected((s) => (s.includes(l.p) ? s.filter((x) => x !== l.p) : [...s, l.p]))} />
                  <Img icon={p.icon} tint={p.tint} className="thumb" />
                  <div className="stack gap-1">
                    <label htmlFor={`rn-${l.p}`} className="small strong">
                      {p.name}
                    </label>
                    <span className="xs muted">
                      {l.variant} · {money(l.price)} · {sellers[l.seller].name}
                    </span>
                    <span className="row gap-2">
                      <StatusBadge status={l.state} />
                      <span className="xs sub">{l.note}</span>
                    </span>
                  </div>
                  <div className="side">
                    {l.eligible ? (
                      <div style={{ maxWidth: '120px' }}>
                        <Field label="Quantity">
                          <Select
                            id={`rn-qty-${l.p}`}
                            options={Array.from({ length: l.qty }, (_, i) => String(i + 1))}
                            value={String(qty[l.p] ?? 1)}
                            disabled={!selected.includes(l.p)}
                            onChange={(e) => setQty((q) => ({ ...q, [l.p]: Number(e.target.value) }))}
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
            <Link className="mono" to={href('account/order')}>
              {order.ref}
            </Link>{' '}
            · placed Sep 14. Want to return something from another order?{' '}
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
              <li>30 days from delivery for most items.</li>
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
    body = (
      <>
        <div className="stack gap-4">
          {chosen.map((l) => (
            <div key={l.p} className="row gap-3 nowrap top card pad">
              <Link to={href('store/product')} aria-label={P[l.p].name}>
                <Img icon={P[l.p].icon} tint={P[l.p].tint} className="thumb" />
              </Link>
              <div className="stack gap-1">
                <Link className="small strong link-plain" to={href('store/product')}>
                  {P[l.p].name}
                </Link>
                <span className="xs muted">
                  {l.variant} · Qty {qty[l.p] ?? 1} · {money(l.price * (qty[l.p] ?? 1))}
                </span>
                <SellerLine seller={l.seller} badge />
              </div>
            </div>
          ))}
          <Card title="What's wrong?">
            <Field label="Reason" hint={errReason ? undefined : 'Who pays return shipping depends on the reason.'} error={errReason}>
              <Select id="rn-reason" options={REASONS} value={reason} onChange={(e) => setReason(e.target.value)} className={cx(errReason && 'is-error')} />
            </Field>
            <Field label="Tell us more" hint={errDetails ? undefined : 'Helps the reviewer decide faster.'} error={errDetails}>
              <Textarea id="rn-details" placeholder="" value={details} onChange={(e) => setDetails(e.target.value)} className={cx(errDetails && 'is-error')} />
            </Field>
            <div className="field">
              <span className="label">
                Photos or video <span className="opt">(optional)</span>
              </span>
              {photos.length > 0 && (
                <div className="row gap-2">
                  {photos.map((ph) => (
                    <Img key={ph.id} icon="image" tint="2" className="thumb" src={ph.src} alt={ph.name} />
                  ))}
                </div>
              )}
              <FileDrop title="Add photos or a short video" hint="JPG, PNG or MP4, up to 10 MB each" accept="image/jpeg,image/png,video/mp4" onFiles={addFiles} />
            </div>
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
                    <td>Seller (free label)</td>
                  </tr>
                  <tr>
                    <td>Changed my mind, better price</td>
                    <td>You ($7.99 deducted from refund)</td>
                  </tr>
                </tbody>
              </table>
            </TableWrap>
            <span className="xs muted">Example policy. Outside sellers can offer more generous terms.</span>
          </Card>
          <Card title="What would you like?" titleAs="h3">
            <div className="stack gap-2" role="radiogroup" aria-label="Remedy">
              {REMEDIES.map((r) => (
                <OptionCard key={r.id} id={`rn-rem-${r.id}`} name="rn-rem" checked={remedy === r.id} onChange={() => setRemedy(r.id)} title={<span className="strong">{r.title}</span>} body={r.body} />
              ))}
            </div>
          </Card>
          <div className="row between only-desktop">{nav}</div>
        </div>
        <aside>
          <Eligibility />
        </aside>
      </>
    );
  } else {
    body = (
      <>
        <div className="stack gap-4">
          <Card title="Check your request">
            <KeyValue
              pairs={[
                ['Item', chosen.map((l) => `${P[l.p].name}, ${l.variant} · Qty ${qty[l.p] ?? 1}`).join('; ') || `${firstP.name}, ${first.variant} · Qty 1`],
                ['Sold by', sellers[first.seller].name],
                ['Reason', reason],
                ['Details', `${firstSentence}${photos.length ? ` ${photos.length} photo${photos.length > 1 ? 's' : ''} attached.` : ''}`],
                ['You want', REMEDIES.find((r) => r.id === remedy)!.want],
                ['Send it back', 'UPS drop-off with a QR code, no printer needed. By Sat, Oct 17.'],
              ]}
            />
          </Card>
          <Card title="Refund estimate" titleAs="h3">
            <SummaryRow k="Item price" v={money(itemTotal)} />
            <SummaryRow k="Original shipping" v={money(0)} />
            <SummaryRow k={`Coupon share (${order.coupon})`} v={`−${money(share)}`} />
            <SummaryRow k="Return shipping" v={buyerPays ? `−${money(RETURN_SHIPPING)}` : 'Free'} />
            <hr />
            <SummaryRow className="total" k={remedy === 'repl' ? 'Refund if no replacement' : 'Estimated refund'} v={money(refund)} />
            <span className="xs muted">Estimate. The final amount is confirmed after inspection. The coupon was split across all items in the order by price.</span>
          </Card>
          <Alert tone="info" title="After you submit">
            Marketly Official reviews within 1 business day. If approved, you get a drop-off QR code. Your refund starts only after the item is received and inspected.
          </Alert>
          <div className="row between only-desktop">{nav}</div>
        </div>
        <aside>
          <Eligibility />
        </aside>
      </>
    );
  }

  return (
    <AccountLayout active="orders" title="Request a return" actionBar={actionBar}>
      <Breadcrumbs items={[{ label: 'Orders', to: href('account/orders') }, { label: order.ref, to: href('account/order') }, { label: 'Request a return' }]} />
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
