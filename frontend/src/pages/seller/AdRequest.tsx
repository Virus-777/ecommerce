import { Fragment, useRef, useState } from 'react';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import { useScrollRegion, useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Breadcrumbs, Button, Card, Checkbox, Field, Icon, Img, KeyValue, OptionCard, Price, StatusBadge, TableWrap, TextInput, announce, type IconName } from '@/ui';

// Design: pages/seller/seller-ad-request.html (set up) · view "in-review" (after "Submit for approval").

type AdType = 'product' | 'store';
type Billing = 'cpc' | 'fixed';

interface AdProduct {
  id: string;
  name: string;
  short: string;
  summary: string;
  sku: string;
  icon: IconName;
  stock: string;
  units: number;
  price: number;
  was: number | null;
}
interface Placement {
  id: string;
  label: string;
  short: string;
  long: string;
}
interface Draft {
  type: AdType;
  products: Record<string, boolean>;
  placements: Record<string, boolean>;
  start: string;
  end: string;
  daily: string;
  total: string;
  billing: Billing;
  headline: string;
  desktop: string;
  mobile: string;
}

const PRODUCTS: AdProduct[] = [
  { id: 'ad-p-0', name: 'Halden Pocket Bluetooth Speaker', short: 'Pocket Speaker', summary: 'Halden Pocket Bluetooth Speaker, Teal and Sand', sku: 'HAL-PKT-TEAL / SND', icon: 'speaker', stock: 'In stock · 88', units: 88, price: 53.1, was: 59 },
  { id: 'ad-p-1', name: 'Halden Aurora ANC Wireless Headphones', short: 'Aurora headphones', summary: 'Halden Aurora ANC Wireless Headphones', sku: 'HAL-AUR-BLK', icon: 'headphones', stock: 'In stock · 24', units: 24, price: 184, was: null },
  { id: 'ad-p-2', name: 'Studio Cable Kit', short: 'Cable kit', summary: 'Studio Cable Kit', sku: 'NWA-CBL-KIT', icon: 'cable', stock: 'Low stock · 12', units: 12, price: 24, was: null },
];
const PLACEMENTS: Placement[] = [
  { id: 'ad-pl-search', label: 'Search results for related terms', short: 'Search', long: 'Search results' },
  { id: 'ad-pl-cat', label: 'Category pages: Speakers', short: 'Speakers', long: 'Speakers category' },
  { id: 'ad-pl-cat2', label: 'Category pages: Headphones', short: 'Headphones', long: 'Headphones category' },
  { id: 'ad-pl-rel', label: 'Related products on product pages', short: 'related', long: 'related products on speaker pages' },
];
const RATES = { cpc: 0.35, fixed: 45 };
const STEPS = ['Draft', 'In review', 'Approved', 'Scheduled', 'Live'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DRAFT: Draft = {
  type: 'product',
  products: { 'ad-p-0': true },
  placements: { 'ad-pl-search': true, 'ad-pl-cat': true, 'ad-pl-rel': true },
  start: 'Nov 16, 2026, 12:00 AM',
  end: 'Dec 20, 2026, 11:59 PM',
  daily: '20.00',
  total: '500.00',
  billing: 'cpc',
  headline: '12-hour battery, splash resistant',
  desktop: '',
  mobile: '',
};

/** "Nov 16, 2026, 12:00 AM" -> UTC day number, or null. */
function dayOf(s: string): number | null {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/.exec(s.trim());
  if (!m || !MONTHS.includes(m[1])) return null;
  return Date.UTC(Number(m[3]), MONTHS.indexOf(m[1]), Number(m[2])) / 86400000;
}
const isAmount = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) > 0;
const noYear = (s: string) => s.replace(/,\s*\d{4}/, '');
const dayOnly = (s: string) => noYear(s).replace(/,.*$/, '');

function validate(d: Draft) {
  const e: Partial<Record<'products' | 'placements' | 'start' | 'end' | 'daily' | 'total' | 'headline', string>> = {};
  if (d.type === 'product' && !PRODUCTS.some((p) => d.products[p.id])) e.products = 'Choose at least one product to promote.';
  if (!PLACEMENTS.some((p) => d.placements[p.id])) e.placements = 'Choose at least one placement.';
  const s = dayOf(d.start);
  const en = dayOf(d.end);
  if (s === null) e.start = 'Enter a start date like Nov 16, 2026, 12:00 AM.';
  else if (s < dayOf('Oct 10, 2026')!) e.start = 'Choose a start date after review, from Oct 10, 2026.';
  if (en === null) e.end = 'Enter an end date like Dec 20, 2026, 11:59 PM.';
  else if (s !== null && en < s) e.end = 'The end must be after the start.';
  if (!isAmount(d.daily)) e.daily = 'Enter a daily limit in dollars, like 20.00.';
  else if (d.billing === 'fixed' && Number(d.daily) < RATES.fixed) e.daily = `A fixed placement costs ${money(RATES.fixed)} a day. Set the daily limit to at least that.`;
  else if (d.billing === 'cpc' && Number(d.daily) < 5) e.daily = 'Set the daily limit to $5.00 or more.';
  if (!isAmount(d.total)) e.total = 'Enter a total limit in dollars, like 500.00.';
  else if (isAmount(d.daily) && Number(d.total) < Number(d.daily)) e.total = `The total limit can't be less than the daily limit (${money(Number(d.daily))}).`;
  else if (Number(d.total) > 10000) e.total = 'Requests over $10,000.00 need a call with Marketly Advertising. Lower the total limit.';
  if (!d.headline.trim()) e.headline = 'Enter a short headline.';
  else if (d.headline.trim().length > 40) e.headline = `Use 40 characters or fewer (now ${d.headline.trim().length}).`;
  return e;
}

/** Steps with the design's "Step n of m" screen-reader note. */
function AdSteps({ current }: { current: number }) {
  const ref = useScrollRegion<HTMLOListElement>();
  return (
    <ol className="steps" aria-label="Progress" ref={ref} data-scroll-region="">
      {STEPS.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <li className="bar" aria-hidden="true" />}
          <li className={cx('step', i < current && 'is-done', i === current && 'is-current')} aria-current={i === current ? 'step' : undefined}>
            {i < current && <span className="sr-only">Completed: </span>}
            <span className="n">{i < current ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
            {i === current && <span className="sr-only">{`Step ${i + 1} of ${STEPS.length}: `}</span>}
            {s}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function Drop({ title, hint, file, onFile }: { title: string; hint: string; file: string; onFile: (name: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className="dropzone"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) onFile(f.name);
      }}
    >
      <Icon name={file ? 'circle-check' : 'image-plus'} className="ic-lg" />
      <span className="small strong u-c-text">{file || title}</span>
      <span className="xs">{hint}</span>
      <input ref={input} type="file" hidden accept="image/jpeg,image/png" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0].name)} />
      <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
        {file ? 'Replace file' : 'Browse files'}
      </Button>
    </div>
  );
}

function Previews({ p, headline }: { p: AdProduct; headline: string }) {
  const card = (
    <div className="stack gap-1">
      <span className="sponsored">
        <Icon name="info" className="ic-sm" />
        Sponsored
      </span>
      <span className="small strong clamp-2">{p.name}</span>
      <span className="xs sub">{headline}</span>
      <Price amount={p.price} was={p.was} noOff />
      <span className="seller-line">
        Sold by <b>Northwind Audio</b>
      </span>
    </div>
  );
  return (
    <div className="grid md2 gap-4">
      <div className="sb-device">
        <span className="xs muted row gap-1">
          <Icon name="monitor" className="ic-sm" />
          Desktop · search results for “bluetooth speaker”
        </span>
        <div className="grid c2 gap-2">
          <div className="sb-adcard col">
            <Img icon={p.icon} tint="2" className="r43" />
            {card}
          </div>
          <div className="sb-ghostcard u-fd-column" aria-hidden="true">
            <div className="imgph r43 tint-surface-3" />
            <i style={{ width: '80%' }} />
            <i className="u-w-50pct" />
          </div>
        </div>
      </div>
      <div className="sb-device phone">
        <span className="xs muted row gap-1">
          <Icon name="smartphone" className="ic-sm" />
          Mobile · search results
        </span>
        <div className="stack gap-2">
          <div className="sb-adcard">
            <Img icon={p.icon} tint="2" />
            {card}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChargesNote() {
  return (
    <div className="stack gap-2">
      <Alert tone="info" title="How you are charged">
        Ad charges appear on your statement as a separate line, not as part of the sales commission. Unused budget is not charged. If Marketly pauses or cancels the campaign, you are charged only for delivery so far.
      </Alert>
      <p className="xs muted">Paid campaigns bring attention to your offer. They never guarantee clicks or purchases.</p>
    </div>
  );
}

export default function AdRequest() {
  const [view, setView] = useView<'in-review'>();
  const [d, setD] = useState<Draft>(DRAFT);
  const [submitted, setSubmitted] = useState<Draft>(DRAFT);
  const [tried, setTried] = useState(false);
  const [notice, setNotice] = useState('');

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const errs = tried ? validate(d) : {};
  const nErr = Object.keys(errs).length;

  const summaryOf = (x: Draft) => {
    const prods = PRODUCTS.filter((p) => x.products[p.id]);
    const pls = PLACEMENTS.filter((p) => x.placements[p.id]);
    const s = dayOf(x.start);
    const e = dayOf(x.end);
    const days = s !== null && e !== null && e >= s ? e - s + 1 : 0;
    const daily = isAmount(x.daily) ? Number(x.daily) : 0;
    const total = isAmount(x.total) ? Number(x.total) : 0;
    const most = days && daily ? Math.min(total, daily * days) : total;
    const billing = x.billing === 'cpc' ? `Per click, ${money(RATES.cpc)}` : `Fixed, ${money(RATES.fixed)} per day`;
    const lead = x.type === 'store' ? null : (prods[0] ?? null);
    const name = x.type === 'store' ? 'Northwind store holiday feature' : `${lead?.short ?? 'Product'} holiday push`;
    return { prods, pls, days, daily, total, most, billing, lead, name };
  };
  const live = summaryOf(d);
  const sub = summaryOf(submitted);
  const preview = live.lead ?? PRODUCTS[0];

  const submit = () => {
    setTried(true);
    if (Object.keys(validate(d)).length) {
      announce('Check the highlighted fields');
      return;
    }
    setSubmitted(d);
    setNotice('');
    setView('in-review');
    window.scrollTo({ top: 0 });
    announce('Submitted for approval');
  };

  if (view === 'in-review') {
    return (
      <SellerLayout active="marketing">
        <div className="page-head">
          <div className="t">
            <Breadcrumbs items={[{ label: 'Marketing and ads', to: href('seller/marketing', 'sponsored-ads') }, { label: sub.name }]} />
            <h1 className="h1">{sub.name}</h1>
            <p className="sub small">
              Request <span className="mono">AD-261008-0091</span> · submitted Thu, Oct 8, 11:05 AM PT by Avery Stone
            </p>
          </div>
          <div className="actions">
            <StatusBadge status="In review" />
          </div>
        </div>
        <section className="card">
          <div className="card-body">
            <AdSteps current={1} />
          </div>
        </section>
        <div className="sb-main">
          <div className="stack gap-5">
            <Alert tone="info" title="Waiting for Marketly Advertising review">
              Usually within 2 business days (example). We check the offer is available, claims and links, and the Sponsored label. Editing the request now sends it back to the start of review.
            </Alert>
            <Card
              title="Request summary"
              foot={
                <>
                  <Button
                    variant="danger-soft"
                    onClick={() => {
                      setNotice('Request withdrawn. It is a draft again and nothing will be charged.');
                      setTried(false);
                      setView('');
                      announce('Request withdrawn');
                    }}
                  >
                    Withdraw request
                  </Button>
                  <Button
                    variant="secondary"
                    icon="pencil"
                    onClick={() => {
                      setD(submitted);
                      setNotice('Editing sends the request back to the start of review when you submit again.');
                      setView('');
                    }}
                  >
                    Edit and resubmit
                  </Button>
                </>
              }
            >
              <KeyValue
                pairs={[
                  ['Ad type', submitted.type === 'product' ? 'Sponsored product' : 'Sponsored store'],
                  ['Promotes', submitted.type === 'store' ? 'Store page' : sub.prods.map((p) => p.summary).join(' · ')],
                  ['Placements', sub.pls.map((p) => p.long).join(' · ').replace(/^./, (c) => c.toUpperCase())],
                  ['Schedule', `${noYear(submitted.start)} – ${noYear(submitted.end)} PT`],
                  ['Spending limit', `${money(sub.daily)} per day · ${money(sub.total)} total`],
                  ['Billing', `${sub.billing} (example rate)`],
                  ['Creatives', `Desktop ${submitted.desktop || '1200 × 900'} · Mobile ${submitted.mobile || '800 × 800'}`],
                ]}
              />
            </Card>
            <Card title="Review checks" titleAs="h3" sub="Updated by the reviewer">
              <ul className="list">
                <li>
                  <Icon name="circle-check" className="ic-sm t-success-text" />
                  <span className="grow small">{submitted.type === 'store' ? 'Store approved and selling' : `Offer active and in stock (${sub.lead?.units ?? 0} units)`}</span>
                  <StatusBadge status="Approved" />
                </li>
                <li>
                  <Icon name="circle-check" className="ic-sm t-success-text" />
                  <span className="grow small">Destination link goes to the {submitted.type === 'store' ? 'store page' : 'product page'}</span>
                  <StatusBadge status="Approved" />
                </li>
                <li>
                  <Icon name="clock" className="ic-sm" />
                  <span className="grow small">Creative text and claims (“{submitted.headline.split(',')[0]}”)</span>
                  <StatusBadge status="In review" />
                </li>
                <li>
                  <Icon name="clock" className="ic-sm" />
                  <span className="grow small">Sponsored label and seller name visible on both sizes</span>
                  <StatusBadge status="In review" />
                </li>
              </ul>
            </Card>
            <Card title="Previews you submitted" titleAs="h3">
              <Previews p={sub.lead ?? PRODUCTS[0]} headline={submitted.headline} />
            </Card>
          </div>
          <div className="stack gap-5">
            <Card title="Activity" titleAs="h3">
              <ol className="timeline">
                {[
                  { t: 'In review', d: 'Assigned to Jamie Brooks, Advertising', s: 'current' },
                  { t: 'Submitted for approval', d: 'Oct 8, 11:05 AM · Avery Stone', s: 'done' },
                  { t: 'Draft created', d: 'Oct 7, 4:40 PM · Avery Stone', s: 'done' },
                ].map((e) => (
                  <li key={e.t} className={`ev is-${e.s}`}>
                    <span className="dot" aria-hidden="true" />
                    <div className="stack gap-1">
                      <span className="t">{e.t}</span>
                      <span className="d">{e.d}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
            <Card title="What happens next" titleAs="h3">
              <ol className="ol small stack gap-1">
                <li>Approved: you get an email and the campaign is scheduled.</li>
                <li>Scheduled: it starts {dayOnly(submitted.start)} at {submitted.start.split(', ').pop()} PT.</li>
                <li>Live: charges start with the first {submitted.billing === 'cpc' ? 'click' : 'day of placement'}.</li>
              </ol>
              <span className="xs muted">If it is not approved, we tell you which check failed and how to fix it.</span>
            </Card>
            <ChargesNote />
          </div>
        </div>
      </SellerLayout>
    );
  }

  return (
    <SellerLayout active="marketing">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Marketing and ads', to: href('seller/marketing', 'sponsored-ads') }, { label: 'New request' }]} />
          <h1 className="h1">Request a sponsored campaign</h1>
          <p className="sub small">Marketly reviews every request. Nothing runs or is charged until it is approved and scheduled.</p>
        </div>
        <div className="actions">
          <StatusBadge status="Draft" />
        </div>
      </div>
      <section className="card">
        <div className="card-body">
          <AdSteps current={0} />
        </div>
      </section>
      <div className="sb-main">
        <div className="stack gap-5">
          {notice && <Alert tone="info" title={notice} />}
          {nErr > 0 && (
            <Alert tone="danger" title={`Check ${nErr} field${nErr > 1 ? 's' : ''}`}>
              Fix the highlighted fields to submit this request.
            </Alert>
          )}
          <Card title="1. Ad type">
            <div className="grid md2 gap-3">
              <OptionCard id="ad-type-prod" name="ad-type" title={<span className="strong">Sponsored product</span>} body="A labeled product card in search, category and related-product results." checked={d.type === 'product'} onChange={() => set('type', 'product')} />
              <OptionCard id="ad-type-store" name="ad-type" title={<span className="strong">Sponsored store</span>} body="A labeled feature linking to your store on home and discovery pages." checked={d.type === 'store'} onChange={() => set('type', 'store')} />
            </div>
          </Card>
          <Card title="2. Products" titleAs="h3" sub="Only active offers with stock can be promoted" flush>
            {errs.products && (
              <div className="card-body">
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {errs.products}
                </span>
              </div>
            )}
            <TableWrap label="2. Products table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                    <th scope="col">Product</th>
                    <th scope="col">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {PRODUCTS.map((p) => (
                    <tr key={p.id} className={cx(d.products[p.id] && d.type === 'product' && 'is-selected')}>
                      <td>
                        <input type="checkbox" id={p.id} aria-label={`Promote ${p.name}`} checked={!!d.products[p.id]} disabled={d.type === 'store'} onChange={(e) => set('products', { ...d.products, [p.id]: e.target.checked })} />
                      </td>
                      <td>
                        <label htmlFor={p.id} className="row gap-3 nowrap minw-240">
                          <Img icon={p.icon} tint="2" className="tiny" />
                          <span className="stack gap-0">
                            <span className="small strong">{p.name}</span>
                            <span className="xs muted mono nowrap" title={p.sku}>
                              {p.sku}
                            </span>
                          </span>
                        </label>
                      </td>
                      <td>
                        <span className="small">{p.stock}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
          <Card title="3. Placement and pages" titleAs="h3">
            <div className="grid md2 gap-2">
              {PLACEMENTS.map((p) => (
                <Checkbox key={p.id} id={p.id} label={p.label} checked={!!d.placements[p.id]} onChange={(e) => set('placements', { ...d.placements, [p.id]: e.target.checked })} />
              ))}
            </div>
            {errs.placements && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {errs.placements}
              </span>
            )}
            <span className="xs muted">Ads never appear in checkout, payment results, order tracking or return pages. Audience: all shoppers in the US service region.</span>
          </Card>
          <Card title="4. Schedule and spending limit" titleAs="h3">
            <div className="sb-form-grid">
              <Field label="Start" error={errs.start}>
                <TextInput id="ad-start" icon="calendar" value={d.start} error={!!errs.start} placeholder="" onChange={(e) => set('start', e.target.value)} />
              </Field>
              <Field label="End" hint="Times in Pacific Time" error={errs.end}>
                <TextInput id="ad-end" icon="calendar" value={d.end} error={!!errs.end} placeholder="" onChange={(e) => set('end', e.target.value)} />
              </Field>
              <Field label="Daily spending limit" hint="Ads stop for the day when reached." error={errs.daily}>
                <TextInput id="ad-daily" prefix="$" value={d.daily} error={!!errs.daily} placeholder="" inputMode="decimal" onChange={(e) => set('daily', e.target.value)} />
              </Field>
              <Field label="Total spending limit" hint="The campaign stops when reached." error={errs.total}>
                <TextInput id="ad-total" prefix="$" value={d.total} error={!!errs.total} placeholder="" inputMode="decimal" onChange={(e) => set('total', e.target.value)} />
              </Field>
            </div>
            <div className="stack gap-2">
              <span className="label">Billing model</span>
              <div className="grid md2 gap-3">
                <OptionCard
                  id="ad-bill-cpc"
                  name="ad-bill"
                  title={
                    <span className="row between">
                      <span className="strong small">Per click</span>
                      <span className="num small">{money(RATES.cpc)}</span>
                    </span>
                  }
                  body="You pay when a shopper clicks the ad."
                  checked={d.billing === 'cpc'}
                  onChange={() => set('billing', 'cpc')}
                />
                <OptionCard
                  id="ad-bill-fixed"
                  name="ad-bill"
                  title={
                    <span className="row between">
                      <span className="strong small">Fixed placement fee</span>
                      <span className="num small">{money(RATES.fixed)}/day</span>
                    </span>
                  }
                  body="Flat daily fee for a reserved slot."
                  checked={d.billing === 'fixed'}
                  onChange={() => set('billing', 'fixed')}
                />
              </div>
              <span className="xs muted">Example rates. Final pricing is in the advertising terms.</span>
            </div>
          </Card>
          <Card title="5. Creative" titleAs="h3" sub="Upload both sizes. Previews show the Sponsored label customers see.">
            <div className="grid md2 gap-4">
              <div className="stack gap-2">
                <span className="label">Desktop image</span>
                <Drop title="Upload desktop image" hint="1200 × 900 px, JPG or PNG, up to 5 MB" file={d.desktop} onFile={(n) => set('desktop', n)} />
              </div>
              <div className="stack gap-2">
                <span className="label">Mobile image</span>
                <Drop title="Upload mobile image" hint="800 × 800 px, JPG or PNG, up to 5 MB" file={d.mobile} onFile={(n) => set('mobile', n)} />
              </div>
            </div>
            <Field label="Short headline" hint={`40 characters max. Claims must match the product page. ${d.headline.trim().length}/40`} error={errs.headline}>
              <TextInput id="ad-headline" value={d.headline} error={!!errs.headline} placeholder="" onChange={(e) => set('headline', e.target.value)} />
            </Field>
            <Previews p={preview} headline={d.headline} />
          </Card>
        </div>
        <div className="stack gap-5">
          <Card
            title="Summary"
            titleAs="h3"
            foot={
              <>
                <Button variant="ghost" onClick={() => (setNotice('Draft saved. Nothing is sent to Marketly until you submit.'), announce('Draft saved'))}>
                  Save draft
                </Button>
                <Button iconRight="arrow-right" onClick={submit}>
                  Submit for approval
                </Button>
              </>
            }
          >
            <KeyValue
              pairs={[
                ['Type', d.type === 'product' ? 'Sponsored product' : 'Sponsored store'],
                ['Products', d.type === 'store' ? 'Store page' : `${live.prods.length} selected`],
                ['Pages', live.pls.map((p) => p.short).join(', ') || '—'],
                ['Runs', live.days ? `${dayOnly(d.start)} – ${dayOnly(d.end)} (${live.days} days)` : '—'],
                ['Most you can spend', money(live.most)],
                ['Billing', live.billing],
              ]}
            />
          </Card>
          <ChargesNote />
        </div>
      </div>
    </SellerLayout>
  );
}
