import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money, num } from '@marketly/web-shared/lib/format';
import { useScrollRegion, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Checkbox, Field, Icon, Img, PageHeader, Price, Radio, Select, StatusBadge, TableWrap, Textarea, TextInput, announce, type IconName } from '@marketly/web-shared/ui';

// Design: pages/admin/admin-promotion-new.html (step 1, set up) · view "finance-confirmation" = after "Send to Finance":
// step 2, the setup locked (.ab-locked) and the Finance confirmation card. QA m-9 (locked text at 2.48:1) is fixed in
// marketly.css (.ab-locked has no opacity); here the locked controls are read-only/disabled without dimming the text.

/* ---------------- Options ---------------- */

const TYPES = ['Item markdown', 'Percentage coupon', 'Fixed-amount coupon', 'Minimum-spend discount', 'Free shipping', 'Flash sale'];
const PERCENT_TYPES = ['Item markdown', 'Percentage coupon', 'Flash sale'];
const CODE_TYPES = ['Percentage coupon', 'Fixed-amount coupon', 'Minimum-spend discount'];
const TIME_ZONES = ['Pacific Time (PT)', 'Mountain Time (MT)', 'Central Time (CT)', 'Eastern Time (ET)'];

const CATEGORIES = [
  { name: 'Home & Kitchen › Bedding', offers: 132 },
  { name: 'Home & Kitchen › Lighting', offers: 82 },
  { name: 'Home & Kitchen › Cookware', offers: 96 },
  { name: 'Home & Kitchen › Bath', offers: 54 },
];

const CUSTOMERS = [
  { label: 'All customers, including guests', short: 'Everyone' },
  { label: 'Signed-in customers', short: 'Signed-in' },
  { label: 'New customers (first order)', short: 'New customers' },
  { label: 'Customers in selected regions', short: 'Selected regions' },
];

type Funding = 'Platform' | 'Seller' | 'Shared';
const FUNDING: Array<{ value: Funding; body: string; platformShare: number }> = [
  { value: 'Platform', body: 'Marketly pays the full discount. Seller proceeds are unchanged.', platformShare: 1 },
  { value: 'Seller', body: 'Each participating seller pays for its own offers.', platformShare: 0 },
  { value: 'Shared', body: 'Platform 50% · sellers 50% of the discount on seller offers', platformShare: 0.5 },
];

type ComboKey = 'markdowns' | 'coupons' | 'freeShip' | 'flash';
const COMBOS: Array<{ key: ComboKey; label: string; short: string }> = [
  { key: 'markdowns', label: 'Combines with seller markdowns', short: 'markdowns' },
  { key: 'coupons', label: 'Combines with other coupons', short: 'other coupons' },
  { key: 'freeShip', label: 'Combines with free shipping offers', short: 'free shipping' },
  { key: 'flash', label: 'Applies to items already in a flash sale', short: 'flash sales' },
];

const EXCLUSIONS = ['Official Store clearance', 'Gadget Grove (restricted seller)', 'Brightline S2 (under review)'];

const SELLERS = [
  { name: 'Casa Verde Home', offers: 42, consent: 'Accepted' },
  { name: 'Mosswood Living', offers: 18, consent: 'Accepted' },
  { name: 'Trailhead Outfitters', offers: 6, consent: 'Pending' },
];

const COMMISSION = 0.12;
const PREVIEW_PRICE = 119;
const MARKETING_LIMIT = 10000;
const STEPS = ['Set up', 'Finance confirmation', 'Content and pages', 'Scheduled'];

/* ---------------- Form ---------------- */

interface Form {
  name: string;
  type: string;
  code: string;
  note: string;
  start: string;
  end: string;
  tz: string;
  scope: 'categories' | 'products';
  cats: string[];
  customers: number;
  value: string;
  max: string;
  budget: string;
  cap: string;
  perCustomer: string;
  perOrder: string;
  funding: Funding;
  combos: Record<ComboKey, boolean>;
  invite: boolean;
}

const INITIAL: Form = {
  name: 'Fall Home Sale',
  type: 'Percentage coupon',
  code: 'FALLHOME20',
  note: 'Supports Home Week follow-up and Q4 bedding push',
  start: 'Oct 16, 2026, 12:00 AM',
  end: 'Oct 25, 2026, 11:59 PM',
  tz: TIME_ZONES[0],
  scope: 'categories',
  cats: [CATEGORIES[0].name, CATEGORIES[1].name],
  customers: 1,
  value: '20',
  max: '40.00',
  budget: '12,000.00',
  cap: '2,000',
  perCustomer: '1',
  perOrder: '1',
  funding: 'Shared',
  combos: { markdowns: true, coupons: false, freeShip: true, flash: false },
  invite: true,
};

const toNum = (s: string) => Number(s.replace(/[$,\s]/g, ''));
const isInt = (s: string) => /^\d[\d,]*$/.test(s.trim()) && toNum(s) > 0;

type Errors = Partial<Record<'name' | 'code' | 'start' | 'end' | 'cats' | 'value' | 'max' | 'budget' | 'cap' | 'perCustomer' | 'perOrder', string>>;

function validate(f: Form): Errors {
  const e: Errors = {};
  const pct = PERCENT_TYPES.includes(f.type);
  if (!f.name.trim()) e.name = 'Enter a campaign name.';
  if (CODE_TYPES.includes(f.type) && !/^[A-Z0-9]{4,20}$/.test(f.code.trim())) e.code = 'Use 4–20 capital letters or digits, like FALLHOME20.';
  if (!f.start.trim()) e.start = 'Enter a start date and time.';
  if (!f.end.trim()) e.end = 'Enter an end date and time.';
  if (f.scope === 'categories' && !f.cats.length) e.cats = 'Add at least one category.';
  if (f.type !== 'Free shipping') {
    const v = toNum(f.value);
    if (!f.value.trim() || Number.isNaN(v) || v <= 0) e.value = 'Enter the discount value.';
    else if (pct && v > 90) e.value = 'Enter a discount between 1% and 90%.';
  }
  if (pct && f.max.trim() && (Number.isNaN(toNum(f.max)) || toNum(f.max) <= 0)) e.max = 'Enter an amount, or leave it empty for no maximum.';
  if (!(toNum(f.budget) > 0)) e.budget = 'Enter the total budget.';
  if (!isInt(f.cap)) e.cap = 'Enter a whole number of redemptions.';
  if (!isInt(f.perCustomer)) e.perCustomer = 'Enter a whole number.';
  if (!isInt(f.perOrder)) e.perOrder = 'Enter a whole number.';
  return e;
}

/** "Oct 16, 2026, 12:00 AM" → { m: 'Oct', d: '16', y: '2026' } */
function parseDate(s: string) {
  const m = /^([A-Z][a-z]{2})\w*\s+(\d{1,2}),?\s*(\d{4})?/.exec(s.trim());
  return m ? { m: m[1], d: m[2], y: m[3] ?? '' } : null;
}
function period(f: Form, withYear: boolean) {
  const a = parseDate(f.start);
  const b = parseDate(f.end);
  const tz = /\((\w+)\)/.exec(f.tz)?.[1] ?? f.tz;
  if (!a || !b) return `${f.start} – ${f.end}`;
  const range = a.m === b.m ? `${a.m} ${a.d}–${b.d}` : `${a.m} ${a.d} – ${b.m} ${b.d}`;
  return withYear ? `${range}, ${b.y} ${tz}` : `${range}, ${tz}`;
}
const fmtCap = (n: number) => `$${Number.isInteger(n) ? num(n) : n.toFixed(2)}`;
const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/* ---------------- Page-local helpers ---------------- */

/** Progress steps with the design's "Step N of M:" sr-only text on the current step (missing from the shared Steps). */
function WizardSteps({ items, current }: { items: string[]; current: number }) {
  const ref = useScrollRegion<HTMLOListElement>();
  return (
    <ol className="steps" aria-label="Progress" ref={ref} data-scroll-region="">
      {items.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <li className="bar" aria-hidden="true" />}
          <li className={cx('step', i < current && 'is-done', i === current && 'is-current')} aria-current={i === current ? 'step' : undefined}>
            {i < current && <span className="sr-only">Completed: </span>}
            <span className="n">{i < current ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
            {i === current && <span className="sr-only">{`Step ${i + 1} of ${items.length}: `}</span>}
            {s}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function Section({ n, title, sub, children }: { n: number; title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <Card
      titleAs={n === 1 ? 'h2' : 'h3'}
      title={
        <span className="row gap-2">
          <Badge tone="outline">{n}</Badge>
          {title}
        </span>
      }
      sub={sub}
    >
      {children}
    </Card>
  );
}

type Check = { tone: 'ok' | 'info' | 'warn'; text: string; sub?: string };
const CHECK_ICON: Record<Check['tone'], IconName> = { ok: 'circle-check', info: 'info', warn: 'triangle-alert' };
const CHECK_SR: Record<Check['tone'], string> = { ok: 'Passed: ', info: '', warn: 'Warning: ' };

function Checks({ items }: { items: Check[] }) {
  return (
    <ul className="ab-checks">
      {items.map((c) => (
        <li key={c.text} className={`t-${c.tone}`}>
          {CHECK_SR[c.tone] && <span className="sr-only">{CHECK_SR[c.tone]}</span>}
          <Icon name={CHECK_ICON[c.tone]} className="ic-sm" />
          <span className="stack gap-0">
            <span>{c.text}</span>
            {c.sub && <span className="xs muted">{c.sub}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SumList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div className="ab-sumlist">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Page ---------------- */

export default function PromotionNew() {
  const [view, setView] = useView<'finance-confirmation'>();
  const [f, setF] = useState<Form>(INITIAL);
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState('9:41 AM');
  const [comment, setComment] = useState('');
  const [commentErr, setCommentErr] = useState('');
  const [outcome, setOutcome] = useState<null | 'confirmed' | { changes: string }>(null);

  const finance = view === 'finance-confirmation';
  const confirmed = finance && outcome === 'confirmed';
  const locked = finance;
  const errors = attempted && !finance ? validate(f) : {};
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  // Derived values (summary, seller earnings, price preview).
  const pct = PERCENT_TYPES.includes(f.type);
  const value = f.type === 'Free shipping' ? 0 : toNum(f.value) || 0;
  const maxOff = toNum(f.max) || 0;
  const budget = toNum(f.budget) || 0;
  const cap = toNum(f.cap) || 0;
  const fund = FUNDING.find((x) => x.value === f.funding)!;
  const covered = CATEGORIES.filter((c) => f.cats.includes(c.name));
  const offers = covered.reduce((s, c) => s + c.offers, 0);
  const typeSummary =
    f.type === 'Percentage coupon' ? `${value}% coupon${maxOff ? `, max ${fmtCap(maxOff)}` : ''}`
    : f.type === 'Item markdown' ? `${value}% markdown`
    : f.type === 'Flash sale' ? `${value}% flash sale`
    : f.type === 'Fixed-amount coupon' ? `${fmtCap(value)} coupon`
    : f.type === 'Minimum-spend discount' ? `${fmtCap(value)} off a minimum spend`
    : 'Free shipping';
  const fundSummary = f.funding === 'Shared' ? 'Shared 50/50' : f.funding;
  const stacking = COMBOS.filter((c) => f.combos[c.key]).map((c) => c.short);

  // Seller earnings on a $100 sale.
  const disc = Math.min(value, 100);
  const sellerFund = disc * (1 - fund.platformShare);
  const platformFund = disc - sellerFund;
  const commission = COMMISSION * (100 - sellerFund);
  const earns = 100 - sellerFund - commission;
  const offLabel = pct ? `${disc}% off` : `${money(disc)} off`;

  // Price preview on the Mosswood duvet cover.
  const rawOff = pct ? (PREVIEW_PRICE * value) / 100 : value;
  const previewOff = Math.min(rawOff, pct && maxOff ? maxOff : rawOff, PREVIEW_PRICE);
  const previewNow = PREVIEW_PRICE - previewOff;
  const consented = SELLERS.filter((s) => s.consent === 'Accepted').length;
  const pending = SELLERS.filter((s) => s.consent !== 'Accepted');
  const platformMax = budget * fund.platformShare;

  const send = () => {
    setAttempted(true);
    const e = validate(f);
    const first = Object.keys(e)[0];
    if (first) {
      const id = { name: 'pn-name', code: 'pn-code', start: 'pn-start', end: 'pn-end', cats: 'pn-scope-1', value: 'pn-val', max: 'pn-max', budget: 'pn-bud', cap: 'pn-cap', perCustomer: 'pn-pc', perOrder: 'pn-po' }[first];
      if (id) document.getElementById(id)?.focus();
      return;
    }
    setOutcome(null);
    setView('finance-confirmation');
    announce('Sent to Finance');
  };
  const requestChanges = () => {
    if (!comment.trim()) {
      setCommentErr('Add a comment so Marketing knows what to change.');
      return;
    }
    setOutcome({ changes: comment.trim() });
    setComment('');
    setView('');
  };
  const confirm = () => {
    setOutcome('confirmed');
    announce('Funding confirmed');
  };
  const saveDraft = () => {
    setSaved(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
    announce('Draft saved');
  };

  const removeCat = (name: string) => !locked && set('cats', f.cats.filter((c) => c !== name));
  const nextCat = CATEGORIES.find((c) => !f.cats.includes(c.name));
  const lockedSub = locked ? (
    <span className="xs muted">
      <Icon name="lock" className="ic-sm" /> Locked while Finance reviews
    </span>
  ) : undefined;

  const financeChecks: Check[] = [
    budget > MARKETING_LIMIT
      ? { tone: 'warn', text: `Budget $${num(budget)} is above the Marketing limit of $${num(MARKETING_LIMIT)}`, sub: `Finance confirms the extra $${num(budget - MARKETING_LIMIT)} from the Q4 bedding fund` }
      : { tone: 'ok', text: `Budget is within the Marketing limit of $${num(MARKETING_LIMIT)}` },
    { tone: 'ok', text: 'Platform share does not reduce seller proceeds' },
    { tone: 'ok', text: 'Seller share matches the consent each seller gave' },
    ...pending.map((s): Check => ({ tone: 'warn', text: `${s.name} has not consented`, sub: `Its ${s.offers} offers stay out until it accepts` })),
    { tone: 'ok', text: 'Cost center MKT-2026-Q4 has $18,400 left' },
  ];

  const setupChecks: Check[] = [
    { tone: 'ok', text: 'Marketing: Jamie Brooks' },
    { tone: 'info', text: 'Finance confirms funding: Priya Nair' },
    { tone: 'info', text: 'Content prepares banner and campaign page: Noor Aziz' },
    ...(f.invite ? [{ tone: 'info' as const, text: `Sellers consent: ${consented} of ${SELLERS.length}` }] : []),
  ];

  return (
    <AdminLayout active="promotions">
      <PageHeader
        crumbs={[{ label: 'Promotions and coupons', to: href('admin/promotions') }, { label: finance ? f.name : 'New campaign' }]}
        title={finance ? f.name : 'Create campaign'}
        sub={finance ? `${f.type} · ${period(f, true)} · created by Jamie Brooks` : 'Marketing sets up the campaign. Finance confirms funding before it can go live.'}
        actions={finance ? <StatusBadge status={confirmed ? 'Approved' : 'In review'} /> : undefined}
      />
      <WizardSteps items={STEPS} current={confirmed ? 2 : finance ? 1 : 0} />
      {finance &&
        (confirmed ? (
          <Alert tone="success" title="Funding confirmed">
            Priya Nair confirmed the funding. Noor Aziz can now prepare the banner and campaign page.
          </Alert>
        ) : (
          <Alert tone="info" title="Waiting for Finance">
            Edits are locked while Priya Nair reviews the funding. You get a notification when it is confirmed or sent back.
          </Alert>
        ))}
      {!finance && outcome && outcome !== 'confirmed' && (
        <Alert tone="warning" title="Finance requested changes">
          {outcome.changes}
        </Alert>
      )}
      <div className="ab-main wide">
        <div className={cx('stack gap-4', locked && 'ab-locked')}>
          <Section n={1} title="Basics" sub={lockedSub}>
            <div className="ab-form-grid">
              <Field label="Campaign name" error={errors.name}>
                <TextInput id="pn-name" value={f.name} error={!!errors.name} readOnly={locked} onChange={(e) => set('name', e.target.value)} placeholder="" />
              </Field>
              <Field label="Promotion type">
                <Select id="pn-type" options={TYPES} value={f.type} disabled={locked} onChange={(e) => set('type', e.target.value)} />
              </Field>
              <Field label="Coupon code" hint="Also applied automatically from the campaign page" error={errors.code}>
                <TextInput id="pn-code" value={f.code} error={!!errors.code} readOnly={locked} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="" />
              </Field>
              <Field label="Internal note" optional>
                <TextInput id="pn-note" value={f.note} readOnly={locked} onChange={(e) => set('note', e.target.value)} placeholder="" />
              </Field>
            </div>
          </Section>
          <Section n={2} title="Schedule">
            <div className="ab-form-grid c3">
              <Field label="Starts" error={errors.start}>
                <TextInput id="pn-start" icon="calendar" value={f.start} error={!!errors.start} readOnly={locked} onChange={(e) => set('start', e.target.value)} placeholder="" />
              </Field>
              <Field label="Ends" error={errors.end}>
                <TextInput id="pn-end" icon="calendar" value={f.end} error={!!errors.end} readOnly={locked} onChange={(e) => set('end', e.target.value)} placeholder="" />
              </Field>
              <Field label="Time zone">
                <Select id="pn-tz" options={TIME_ZONES} value={f.tz} disabled={locked} onChange={(e) => set('tz', e.target.value)} />
              </Field>
            </div>
            <p className="ab-note">
              <Icon name="info" className="ic-sm" /> Countdowns on the Deals page use these exact times.
            </p>
          </Section>
          <Section n={3} title="Products and offers">
            <fieldset className="stack gap-2 fieldset-reset">
              <legend className="sr-only">What the campaign covers</legend>
              <Radio id="pn-scope-1" name="pn-scope" label="Categories" checked={f.scope === 'categories'} disabled={locked} onChange={() => set('scope', 'categories')} />
              <Radio id="pn-scope-2" name="pn-scope" label="Selected products or offers" checked={f.scope === 'products'} disabled={locked} onChange={() => set('scope', 'products')} />
            </fieldset>
            <div className="hscroll gap-2">
              {f.cats.map((c) => (
                <a
                  key={c}
                  className="chip is-active"
                  href="#"
                  aria-current="true"
                  onClick={(e) => {
                    e.preventDefault();
                    removeCat(c);
                  }}
                >
                  {c}
                  <Icon name="x" className="ic-sm" />
                </a>
              ))}
              {!locked && nextCat && (
                <a
                  className="chip"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    set('cats', [...f.cats, nextCat.name]);
                  }}
                >
                  <Icon name="plus" />
                  Add category
                </a>
              )}
            </div>
            {errors.cats && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {errors.cats}
              </span>
            )}
            <span className="xs muted">{offers} eligible offers · 6 sellers + Official Store</span>
          </Section>
          <Section n={4} title="Eligible customers">
            <div className="ab-checkgrid">
              {CUSTOMERS.map((c, i) => (
                <Radio key={c.label} id={`pn-cust-${i + 1}`} name="pn-cust" label={c.label} checked={f.customers === i} disabled={locked} onChange={() => set('customers', i)} />
              ))}
            </div>
          </Section>
          <Section n={5} title="Discount and limits">
            <div className="ab-form-grid c3">
              <Field label="Discount value" error={errors.value}>
                {pct ? (
                  <TextInput id="pn-val" suffix="% off" value={f.value} error={!!errors.value} inputMode="decimal" readOnly={locked} onChange={(e) => set('value', e.target.value)} placeholder="" />
                ) : (
                  <TextInput id="pn-val" prefix="$" value={f.value} error={!!errors.value} inputMode="decimal" readOnly={locked || f.type === 'Free shipping'} onChange={(e) => set('value', e.target.value)} placeholder="" />
                )}
              </Field>
              <Field label="Maximum discount per order" error={errors.max}>
                <TextInput id="pn-max" prefix="$" value={f.max} error={!!errors.max} inputMode="decimal" readOnly={locked} onChange={(e) => set('max', e.target.value)} placeholder="" />
              </Field>
              <Field label="Total budget" hint="Campaign stops when the budget is used" error={errors.budget}>
                <TextInput id="pn-bud" prefix="$" value={f.budget} error={!!errors.budget} inputMode="decimal" readOnly={locked} onChange={(e) => set('budget', e.target.value)} placeholder="" />
              </Field>
              <Field label="Usage cap" error={errors.cap}>
                <TextInput id="pn-cap" suffix="redemptions" value={f.cap} error={!!errors.cap} inputMode="numeric" readOnly={locked} onChange={(e) => set('cap', e.target.value)} placeholder="" />
              </Field>
              <Field label="Per customer" error={errors.perCustomer}>
                <TextInput id="pn-pc" suffix="use" value={f.perCustomer} error={!!errors.perCustomer} inputMode="numeric" readOnly={locked} onChange={(e) => set('perCustomer', e.target.value)} placeholder="" />
              </Field>
              <Field label="Per order" error={errors.perOrder}>
                <TextInput id="pn-po" suffix="coupon" value={f.perOrder} error={!!errors.perOrder} inputMode="numeric" readOnly={locked} onChange={(e) => set('perOrder', e.target.value)} placeholder="" />
              </Field>
            </div>
          </Section>
          <Section n={6} title="Funding owner">
            <div className="ab-checkgrid">
              {/* Inline opt-cards: OptionCard's disabled state adds .is-disabled (opacity), which the lock must not use (m-9). */}
              {FUNDING.map((o, i) => (
                <label key={o.value} className={cx('opt-card', f.funding === o.value && 'is-selected')} htmlFor={`pn-fund-${i + 1}`}>
                  <input type="radio" name="pn-fund" id={`pn-fund-${i + 1}`} checked={f.funding === o.value} disabled={locked} onChange={() => set('funding', o.value)} />
                  <span className="stack gap-1 grow">
                    <span className="small strong">{o.value}</span>
                    <span className="small sub">{o.body}</span>
                  </span>
                </label>
              ))}
            </div>
            <span className="xs muted">Official Store items: the discount is a company cost and shows in company trading margin.</span>
          </Section>
          <Section n={7} title="Combination rules and exclusions">
            <div className="ab-checkgrid">
              {COMBOS.map((c, i) => (
                <Checkbox key={c.key} id={`pn-c${i + 1}`} label={c.label} checked={f.combos[c.key]} disabled={locked} onChange={(e) => set('combos', { ...f.combos, [c.key]: e.target.checked })} />
              ))}
            </div>
            <div className="field">
              <label className="label">Exclusions</label>
              <div className="row gap-2">
                {EXCLUSIONS.map((x) => (
                  <Badge key={x} tone="outline">
                    {x}
                  </Badge>
                ))}
                {!locked && (
                  <Button variant="link" size="sm" icon="plus">
                    Add exclusion
                  </Button>
                )}
              </div>
            </div>
          </Section>
          <Section n={8} title="Seller participation">
            <Checkbox id="pn-sp" label="Invite sellers to join. Each seller must consent before its offers are included." checked={f.invite} disabled={locked} onChange={(e) => set('invite', e.target.checked)} />
            <TableWrap label="8 Seller participation table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Seller</th>
                    <th scope="col">Offers</th>
                    <th scope="col">Consent</th>
                    <th className="r" scope="col">
                      Seller earns per $100 sale
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {SELLERS.map((s) => (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td>{s.offers}</td>
                      <td>
                        <StatusBadge status={s.consent} />
                      </td>
                      <td className="r">
                        <span className="num">
                          {money(earns)} <span className="xs muted">(was {money(100 - COMMISSION * 100)})</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <div className="panel small">
              On a $100.00 sale at {offLabel} with {f.funding.toLowerCase()} funding: the customer pays {money(100 - disc)}, the seller funds {money(sellerFund)} and the platform funds {money(platformFund)}. Commission of 12% applies to {money(100 - sellerFund)} after the seller-funded part, which is {money(commission)}. The seller earns {money(earns)}.
            </div>
            <p className="ab-note">
              <Icon name="info" className="ic-sm" /> Example rate for Home &amp; Kitchen. Sellers see this estimate on their invitation before they consent.
            </p>
          </Section>
          <Section n={9} title="Price preview">
            <div className="ab-pv">
              <div>
                <span className="pcap">Product card</span>
                <Img icon="bed-double" tint="1" className="r43" />
                <span className="small">Mosswood Washed Linen Duvet Cover, Queen</span>
                <Price amount={previewNow} was={previewOff > 0 ? PREVIEW_PRICE : null} />
                <span className="row gap-2">
                  <Badge className="t-deal-soft">{`${f.name || 'Campaign'} ${pct ? `−${value}%` : `−${money(previewOff)}`}`}</Badge>
                </span>
                <span className="xs muted">Sold by Casa Verde Home</span>
              </div>
              <div>
                <span className="pcap">Cart</span>
                <span className="small strong">Casa Verde Home · Package 1</span>
                <span className="small">Linen Duvet Cover, Queen</span>
                <div className="sum-row">
                  <span>Item</span>
                  <span>{money(PREVIEW_PRICE)}</span>
                </div>
                <div className="sum-row discount">
                  <span>
                    {f.name || 'Campaign'}
                    {CODE_TYPES.includes(f.type) && f.code ? ` (${f.code})` : ''}
                  </span>
                  <span>−{money(previewOff)}</span>
                </div>
                <div className="sum-row">
                  <span>Shipping</span>
                  <span>Free</span>
                </div>
              </div>
              <div>
                <span className="pcap">Checkout</span>
                <div className="sum-row">
                  <span>Items (1)</span>
                  <span>{money(PREVIEW_PRICE)}</span>
                </div>
                <div className="sum-row discount">
                  <span>Discounts</span>
                  <span>−{money(previewOff)}</span>
                </div>
                <span className="xs muted">{f.name || 'Campaign'} applied to 1 item</span>
                <div className="sum-row">
                  <span>Shipping</span>
                  <span>Free</span>
                </div>
                <div className="sum-row">
                  <span>Tax</span>
                  <span>$0.00</span>
                </div>
                <div className="sum-row total">
                  <span>Total</span>
                  <span>{money(previewNow)}</span>
                </div>
              </div>
            </div>
          </Section>
        </div>
        <div className="stack gap-4 ab-sticky">
          {finance ? (
            <Card
              title="Finance confirmation"
              titleAs="h3"
              sub={confirmed ? 'Confirmed by Priya Nair just now' : 'Sent Oct 8, 9:58 AM · waiting on Priya Nair'}
              foot={
                confirmed ? (
                  <Button variant="secondary" size="sm" to={href('admin/promotions')}>
                    Back to promotions
                  </Button>
                ) : (
                  <>
                    <Button variant="secondary" size="sm" onClick={requestChanges}>
                      Request changes
                    </Button>
                    <Button size="sm" icon="check" onClick={confirm}>
                      Confirm funding
                    </Button>
                  </>
                )
              }
            >
              <Checks items={financeChecks} />
              <SumList
                rows={[
                  ['Platform maximum', money(platformMax)],
                  ['Sellers maximum', money(budget - platformMax)],
                  ['Expected sales', '$64,000.00'],
                  ['Official Store margin impact', '−3.1 pts'],
                ]}
              />
              {!confirmed && (
                <Field label="Finance comment" error={commentErr || undefined}>
                  <Textarea
                    id="pn-fin"
                    placeholder="Visible to Marketing"
                    className={cx(commentErr && 'is-error')}
                    value={comment}
                    onChange={(e) => {
                      setComment(e.target.value);
                      if (commentErr) setCommentErr('');
                    }}
                  />
                </Field>
              )}
            </Card>
          ) : (
            <Card
              title="Summary"
              titleAs="h3"
              sub={`Draft · last saved ${saved}`}
              foot={
                <>
                  <Button variant="ghost" size="sm" onClick={saveDraft}>
                    Save draft
                  </Button>
                  <Button size="sm" icon="send" onClick={send}>
                    Send to Finance
                  </Button>
                </>
              }
            >
              <SumList
                rows={[
                  ['Type', typeSummary],
                  ['Period', period(f, false)],
                  ['Covers', f.scope === 'categories' ? `${offers} offers in ${covered.length} ${covered.length === 1 ? 'category' : 'categories'}` : 'Selected products or offers'],
                  ['Customers', CUSTOMERS[f.customers].short],
                  ['Budget', `${money(budget)} · ${num(cap)} uses`],
                  ['Funding', fundSummary],
                  ['Stacking', stacking.length ? `With ${andList(stacking)}` : 'Does not combine'],
                ]}
              />
              <div className="divider" />
              <span className="small strong">Before publishing</span>
              <Checks items={setupChecks} />
              {attempted && Object.keys(errors).length > 0 && (
                <Alert tone="danger" title="Fix the highlighted fields">
                  {`${Object.keys(errors).length} ${Object.keys(errors).length === 1 ? 'field needs' : 'fields need'} attention before Finance can review the campaign.`}
                </Alert>
              )}
            </Card>
          )}
          {confirmed && (
            <p className="ab-note">
              <Icon name="info" className="ic-sm" /> Next: Content prepares the banner and campaign page. <Link to={href('admin/content')}>Open Homepage and pages</Link>
            </p>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
