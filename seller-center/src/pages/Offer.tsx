import { useState } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Field, Icon, Img, PageHeader, Select, Steps, SummaryRow, Textarea, TextInput, announce } from '@marketly/web-shared/ui';

// Design: pages/seller/seller-offer.html (New condition) · view "used-condition" = the same form
// with Used – Good selected: missing-items alert, required condition notes, seller warranties.
// Choosing a used/refurbished condition switches the view; the fee preview follows the price.

type View = 'used-condition';

const CONDITIONS = ['New', 'Used – Like new', 'Used – Good', 'Used – Acceptable', 'Refurbished'];
const isUsed = (c: string) => c !== 'New';
const WARRANTY_NEW = ['2-year manufacturer warranty', '1-year seller warranty', 'No warranty'];
const WARRANTY_USED = ['90-day seller warranty', '6-month seller warranty', 'No warranty'];
const DISPATCH = ['Same business day (order by 12 PM PT)', '1 business day', '2 business days', '3 business days'];
const ARRIVAL: Record<string, string> = {
  [DISPATCH[0]]: 'Mon, Oct 12 – Tue, Oct 13',
  [DISPATCH[1]]: 'Tue, Oct 13 – Wed, Oct 14',
  [DISPATCH[2]]: 'Wed, Oct 14 – Thu, Oct 15',
  [DISPATCH[3]]: 'Thu, Oct 15 – Fri, Oct 16',
};
const RETURNS = [
  { id: 'of-ret30', title: '30-day returns', baseline: true, body: 'Customer can return for any reason within 30 days of delivery. Return shipping: buyer pays unless the item is faulty or not as described.' },
  { id: 'of-ret60', title: '60-day returns', body: 'More generous than the baseline. Shown as a benefit on your offer.' },
  { id: 'of-ret60f', title: '60-day returns with free return shipping', body: 'You pay return shipping for every return.' },
];
const FEE_RATE = 0.1;
const NOTES_MAX = 500;
const USED_NOTES = 'Light wear on the headband, no scratches on ear cups. Original carry case and airplane adapter are missing. Includes USB-C and 3.5 mm cables. Battery tested at 28 hours.';

function initial(used: boolean) {
  return used
    ? { variation: 'Midnight black', condition: 'Used – Good', notes: USED_NOTES, price: '139.00', qty: '1', sku: 'NWA-AUR-BLK-U2', low: '3', dispatch: DISPATCH[1], ship: 'Standard and Expedited (default)', ret: 'of-ret30', warranty: WARRANTY_USED[0] }
    : { variation: 'Midnight black', condition: 'New', notes: '', price: '189.00', qty: '10', sku: 'NWA-AUR-BLK', low: '3', dispatch: DISPATCH[1], ship: 'Standard and Expedited (default)', ret: 'of-ret30', warranty: WARRANTY_NEW[0] };
}
type Form = ReturnType<typeof initial>;

function validate(f: Form) {
  const e: Partial<Record<keyof Form, string>> = {};
  const p = Number(f.price);
  if (!f.price.trim() || !Number.isFinite(p) || p <= 0) e.price = 'Enter a price, like 189.00.';
  const q = Number(f.qty);
  if (f.qty.trim() === '' || !Number.isInteger(q) || q < 0) e.qty = 'Enter a whole number of 0 or more.';
  if (!f.sku.trim()) e.sku = 'Enter your seller SKU.';
  if (f.low.trim() !== '' && (!Number.isInteger(Number(f.low)) || Number(f.low) < 0)) e.low = 'Enter a whole number, or leave it empty.';
  if (isUsed(f.condition) && !f.notes.trim()) e.notes = 'Describe the condition, including anything missing from the box.';
  if (f.notes.length > NOTES_MAX) e.notes = `Keep the notes to ${NOTES_MAX} characters.`;
  return e;
}

export default function Offer() {
  const [view, setView] = useView<View>();
  const [f, setF] = useState<Form>(() => initial(view === 'used-condition'));
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<'' | 'draft' | 'published'>('');
  const used = isUsed(f.condition);
  const errors = attempted ? validate(f) : {};
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));

  const changeCondition = (c: string) => {
    setF((s) => {
      const wasUsed = isUsed(s.condition);
      const nowUsed = isUsed(c);
      // Warranty options differ: switch to the first option of the new list when crossing New/used.
      const warranty = wasUsed === nowUsed ? s.warranty : nowUsed ? WARRANTY_USED[0] : WARRANTY_NEW[0];
      return { ...s, condition: c, warranty };
    });
    setView(isUsed(c) ? 'used-condition' : '', { replace: true });
  };

  const priceN = Number(f.price);
  const price = Number.isFinite(priceN) && priceN > 0 ? priceN : 0;
  const fee = Math.round(price * FEE_RATE * 100) / 100;

  const save = (publish: boolean) => {
    if (publish) {
      setAttempted(true);
      if (Object.keys(validate(f)).length) {
        announce('Check the highlighted fields');
        return;
      }
    }
    setResult(publish ? 'published' : 'draft');
    announce(publish ? 'Offer published' : 'Draft saved');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <SellerLayout active="products">
      <PageHeader
        crumbs={[{ label: 'Products and offers', to: href('seller/products') }, { label: 'Find product', to: href('seller/catalog-match') }, { label: 'Create offer' }]}
        title="Create your offer"
        sub="You set the terms of your offer. Product content is shared by every seller."
      />
      <Steps items={['Find the product', <><span className="sr-only">Step 2 of 3: </span>Create your offer</>, 'Publish']} current={result === 'published' ? 3 : 1} />
      {result === 'published' && (
        <Alert tone="success" title="Your offer is live">
          {f.variation}, {f.condition} at {money(price)} · {f.qty} available. {Number(f.qty) === 0 ? 'It shows to customers once you add stock. ' : ''}
          <Link to={href('seller/products')}>View products and offers</Link>
        </Alert>
      )}
      {result === 'draft' && <Alert tone="info" title="Draft saved">Customers don't see a draft. Publish it when you're ready.</Alert>}
      <div className="sa-split">
        <div className="stack gap-5">
          <Card
            title="Product"
            sub="Shared catalog content · read-only"
            actions={
              <Link className="small strong row gap-1" to={href('seller/help', 'contact-seller-support')}>
                <Icon name="pencil-line" className="ic-sm" />
                Suggest a correction
              </Link>
            }
          >
            <div className="row top gap-4 nowrap">
              <Img icon="headphones" tint="2" className="xl" />
              <div className="stack gap-1">
                <span className="row gap-2">
                  <Badge tone="success">Approved</Badge>
                  <Badge tone="success">Active</Badge>
                </span>
                <span className="strong">Halden Aurora ANC Wireless Headphones</span>
                <span className="xs muted">
                  Halden · Model <span className="mono">HA-ANC700</span> · GTIN <span className="mono">0 84067 31207 4</span>
                </span>
                <span className="xs muted">Electronics › Headphones › Over-ear · 4 other offers</span>
              </div>
            </div>
            <div className="grid md2">
              <Field label="Variation">
                <Select id="of-var" options={['Midnight black', 'Silver', 'Sand']} value={f.variation} onChange={(e) => set('variation', e.target.value)} />
              </Field>
              <div className="stack gap-1">
                <span className="label">In the box (new)</span>
                <span className="small sub">Headphones, hard carry case, USB-C cable, 3.5 mm audio cable, airplane adapter</span>
              </div>
            </div>
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">Corrections to shared content are reviewed by the Catalog team because they affect every seller on this product.</span>
            </p>
          </Card>

          <Card title="Condition" titleAs="h3">
            <div className="grid md2">
              <Field label="Condition">
                <Select id="of-cond" options={CONDITIONS} value={f.condition} onChange={(e) => changeCondition(e.target.value)} />
              </Field>
              <div />
            </div>
            {used && (
              <Alert tone="warning" title="List anything missing from the box">
                This product normally includes a carry case, two cables and an airplane adapter. Customers see your notes next to the price.
              </Alert>
            )}
            <Field
              label="Condition notes"
              optional={!used}
              hint={used ? `Required for used and refurbished items. ${f.notes.length} of ${NOTES_MAX} characters.` : 'Shown to customers beside your price.'}
              error={errors.notes}
            >
              <Textarea id="of-notes" placeholder={used ? '' : 'e.g. Factory sealed, US retail version'} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </Card>

          <Card title="Price and stock" titleAs="h3">
            <div className="grid md2">
              <Field label="Price" hint="Lowest New offer today: $184.00 · Official Store $189.00" error={errors.price}>
                <TextInput id="of-price" prefix="$" inputMode="decimal" value={f.price} error={!!errors.price} onChange={(e) => set('price', e.target.value)} onBlur={() => price > 0 && set('price', price.toFixed(2))} />
              </Field>
              <Field label="Quantity available" hint="Customers cannot buy more than this." error={errors.qty}>
                <TextInput id="of-qty" type="number" min={0} value={f.qty} error={!!errors.qty} onChange={(e) => set('qty', e.target.value)} />
              </Field>
              <Field label="Seller SKU" hint="Your own code. Customers don't see it." error={errors.sku}>
                <TextInput id="of-sku" value={f.sku} error={!!errors.sku} onChange={(e) => set('sku', e.target.value)} />
              </Field>
              <Field label="Low-stock alert at" optional error={errors.low}>
                <TextInput id="of-low" type="number" min={0} suffix="units" value={f.low} error={!!errors.low} onChange={(e) => set('low', e.target.value)} />
              </Field>
            </div>
          </Card>

          <Card title="Delivery" titleAs="h3">
            <div className="grid md2">
              <Field label="Dispatch time" hint="Missing this deadline counts as a late dispatch.">
                <Select id="of-disp" options={DISPATCH} value={f.dispatch} onChange={(e) => set('dispatch', e.target.value)} />
              </Field>
              <Field
                label="Shipping profile"
                hint={
                  <>
                    Free Standard over $49 ·{' '}
                    <Link to={href('seller/shipping')} className="link-inline">
                      Edit profiles
                    </Link>
                  </>
                }
              >
                <Select id="of-ship" options={['Standard and Expedited (default)', 'Large items, flat rate', 'Standard only']} value={f.ship} onChange={(e) => set('ship', e.target.value)} />
              </Field>
            </div>
            <div className="panel small">
              Customers in Portland, OR see: <b>Arrives {ARRIVAL[f.dispatch]}</b> with Standard if ordered today.
            </div>
          </Card>

          <Card title="Returns and warranty" titleAs="h3">
            <div className="stack gap-2">
              <span className="label">Return policy</span>
              {RETURNS.map((r) => (
                <label key={r.id} className={cx('opt-card', f.ret === r.id && 'is-selected')} htmlFor={r.id}>
                  <input type="radio" name="of-ret" id={r.id} checked={f.ret === r.id} aria-describedby={r.baseline ? 'of-ret30-hint' : undefined} onChange={() => set('ret', r.id)} />
                  <span className="stack gap-1 grow">
                    <b>{r.title}</b>
                    {r.baseline && (
                      <>
                        {' '}
                        <span className="xs muted">Platform baseline</span>
                      </>
                    )}
                    <span className="small sub">{r.body}</span>
                  </span>
                </label>
              ))}
              <span className="hint" id="of-ret30-hint">
                You can't offer less than the platform baseline for this category.
              </span>
            </div>
            <Field label="Warranty" hint={used ? 'Manufacturer warranty does not transfer for used items sold here.' : 'Only choose a manufacturer warranty if the product is new and sold in the US.'}>
              <Select id="of-war" options={used ? WARRANTY_USED : WARRANTY_NEW} value={f.warranty} onChange={(e) => set('warranty', e.target.value)} />
            </Field>
          </Card>
        </div>

        <aside className="stack gap-5 sa-sticky">
          <Card title="Fee and earnings preview" titleAs="h3" sub="Per unit sold, before shipping and tax">
            <SummaryRow k="Sale price" v={money(price)} />
            <SummaryRow k={`Platform fee (${FEE_RATE * 100}%)`} v={`−${money(fee)}`} />
            <div className="divider" />
            <SummaryRow className="total" k="Your earnings" v={money(price - fee)} />
            <Badge tone="outline">Example</Badge>
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">Illustrative 10% rate. Final fees by category are in your seller agreement. Earnings show as pending until delivery and the hold period end.</span>
            </p>
          </Card>
          <Card
            title="Publish"
            titleAs="h3"
            foot={
              <>
                <Button variant="secondary" onClick={() => save(false)}>
                  Save draft
                </Button>
                <Button icon="check" onClick={() => save(true)} disabled={result === 'published'}>
                  {result === 'published' ? 'Published' : 'Publish offer'}
                </Button>
              </>
            }
          >
            <p className="small sub">This product is already approved, so your offer goes live when you publish and have stock.</p>
            <Alert tone="info">
              Product approval and offer availability are separate. If your quantity reaches 0 or your offer is hidden or restricted, only your offer stops showing. Other sellers' offers on this product stay up.
            </Alert>
          </Card>
        </aside>
      </div>
    </SellerLayout>
  );
}
