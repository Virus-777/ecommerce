import { useState } from 'react';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import { href } from '@/routes/href';
import { Alert, Badge, Button, Card, Checkbox, Dialog, Field, Icon, KeyValue, OptionCard, PageHeader, Select, Switch, TableWrap, TextInput, Timeline, announce, type TimelineEvent } from '@/ui';

// Design: pages/seller/seller-shipping.html (single view).
// The design opens with "2 unsaved changes" (free shipping threshold, holiday closure): the saved
// settings below differ from the draft in exactly those two fields, so the save bar is live.

interface Method {
  id: string;
  name: string;
  carrier: string;
  transit: string;
  rateType: string;
  rates: string[];
  free: boolean;
  on: boolean;
}
interface Closure {
  id: string;
  name: string;
  dates: string;
  removeLabel: string;
}
interface ReturnAddress {
  name: string;
  line1: string;
  city: string;
  phone: string;
  email: string;
}
interface Settings {
  coverage: 'contiguous' | 'all50';
  excluded: Record<string, boolean>;
  methods: Method[];
  free: string;
  handling: string;
  cutoff: string;
  days: Record<string, boolean>;
  closures: Closure[];
  address: ReturnAddress;
  labels: boolean;
}

const EXCLUSIONS = [
  { id: 'sh-ex1', label: 'PO boxes' },
  { id: 'sh-ex2', label: 'APO / FPO / DPO military addresses' },
  { id: 'sh-ex3', label: 'Alaska' },
  { id: 'sh-ex4', label: 'Hawaii' },
  { id: 'sh-ex5', label: 'Puerto Rico, Guam and US Virgin Islands' },
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HANDLING = ['Same business day', '1 business day', '2 business days', '3 business days'];
const ARRIVES: Record<string, string> = {
  'Same business day': 'Mon, Oct 12 – Tue, Oct 13',
  '1 business day': 'Tue, Oct 13 – Wed, Oct 14',
  '2 business days': 'Wed, Oct 14 – Thu, Oct 15',
  '3 business days': 'Thu, Oct 15 – Fri, Oct 16',
};
const CUTOFFS = ['10:00 AM PT', '12:00 PM PT', '2:00 PM PT'];
const EFFECTIVE = ['Apply now (orders after saving)', 'Apply from Mon, Oct 12, 12:00 AM PT'];

const LABEL_CARRIERS = [
  { name: 'UPS Ground and 2nd Day Air', supported: true },
  { name: 'USPS Ground Advantage and Priority Mail', supported: true },
  { name: 'FedEx, OnTrac and others', supported: false },
];

const METHODS: Method[] = [
  { id: 'm1', name: 'Standard', carrier: 'UPS Ground or USPS Ground Advantage', transit: '3–5 business days', rateType: 'By weight', rates: ['Up to 1 lb $4.99', '1–5 lb $6.99', '5–20 lb $9.99'], free: true, on: true },
  { id: 'm2', name: 'Expedited', carrier: 'UPS 2nd Day Air', transit: '2 business days', rateType: 'By weight', rates: ['Up to 1 lb $6.99', '1–5 lb $9.99', '5–20 lb $14.99'], free: false, on: true },
  { id: 'm3', name: 'Large items', carrier: 'Bookshelf speakers, 20 lb and over', transit: '4–6 business days', rateType: 'Flat per package', rates: ['$19.99'], free: false, on: true },
];

const CLOSURES: Closure[] = [
  { id: 'c1', name: 'Thanksgiving', dates: 'Thu, Nov 26 – Fri, Nov 27', removeLabel: 'Remove Thanksgiving closure' },
  { id: 'c2', name: 'Winter break', dates: 'Thu, Dec 24 – Fri, Dec 25', removeLabel: 'Remove winter break closure' },
  { id: 'c3', name: "New Year's Day", dates: 'Fri, Jan 1, 2027', removeLabel: 'Remove New Year closure' },
];

const DRAFT: Settings = {
  coverage: 'contiguous',
  excluded: Object.fromEntries(EXCLUSIONS.map((e) => [e.id, true])),
  methods: METHODS,
  free: '49.00',
  handling: '1 business day',
  cutoff: '12:00 PM PT',
  days: Object.fromEntries(DAYS.map((d, i) => [d, i < 5])),
  closures: CLOSURES,
  address: { name: 'Northwind Audio Returns', line1: '1450 NW Raleigh St, Unit 3', city: 'Portland, OR 97209', phone: '(503) 555-0172', email: 'returns@northwindaudio.example' },
  labels: true,
};
const SAVED: Settings = { ...DRAFT, free: '35.00', closures: CLOSURES.slice(0, 2) };

const HISTORY: TimelineEvent[] = [
  { t: 'Last saved', d: 'Oct 7, 4:12 PM · Avery Stone', state: 'done', body: 'Added the Large items method.' },
  { t: 'Shipping set up', d: 'Oct 3, 2026 · Avery Stone', state: 'done', body: 'Completed in the setup guide.' },
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Human names of the settings that differ from the saved ones, in page order. */
function changes(d: Settings, s: Settings): string[] {
  const out: string[] = [];
  if (d.coverage !== s.coverage) out.push('coverage');
  if (!same(d.excluded, s.excluded)) out.push('excluded areas');
  if (!same(d.methods, s.methods)) out.push('methods and rates');
  if (Number(d.free) !== Number(s.free) || (d.free.trim() === '') !== (s.free.trim() === '')) out.push('free shipping threshold');
  if (d.handling !== s.handling) out.push('handling time');
  if (d.cutoff !== s.cutoff) out.push('order cutoff');
  if (!same(d.days, s.days)) out.push('business days');
  if (!same(d.closures, s.closures)) out.push(Math.abs(d.closures.length - s.closures.length) > 1 ? 'holiday closures' : 'holiday closure');
  if (!same(d.address, s.address)) out.push('return address');
  if (d.labels !== s.labels) out.push('shipping labels');
  return out;
}
const sentence = (l: string[]) => l.join(', ').replace(/^./, (c) => c.toUpperCase());

const isAmount = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim());
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const freeError = (v: string) => (isAmount(v) && Number(v) > 0 ? '' : 'Enter an amount in dollars, like 49.00.');

const EMPTY_CLOSURE = { name: '', from: '', to: '' };
const EMPTY_METHOD = { name: '', carrier: '', transit: '', rate: '' };

export default function Shipping() {
  const [saved, setSaved] = useState<Settings>(SAVED);
  const [s, setS] = useState<Settings>(DRAFT);
  const [effective, setEffective] = useState(EFFECTIVE[0]);
  const [history, setHistory] = useState(HISTORY);
  const [notice, setNotice] = useState('');
  const [freeTouched, setFreeTouched] = useState(false);

  const [closureOpen, setClosureOpen] = useState(false);
  const [closure, setClosure] = useState(EMPTY_CLOSURE);
  const [closureTried, setClosureTried] = useState(false);
  const [addrOpen, setAddrOpen] = useState(false);
  const [addr, setAddr] = useState<ReturnAddress>(DRAFT.address);
  const [addrTried, setAddrTried] = useState(false);
  const [methodOpen, setMethodOpen] = useState(false);
  const [method, setMethod] = useState(EMPTY_METHOD);
  const [methodTried, setMethodTried] = useState(false);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setNotice('');
    setS((p) => ({ ...p, [k]: v }));
  };
  const dirty = changes(s, saved);
  const fErr = freeTouched ? freeError(s.free) : '';
  const freeLabel = freeError(s.free) ? 'Over —' : `Over $${Number(s.free) % 1 ? Number(s.free).toFixed(2) : Number(s.free)}`;

  const save = () => {
    setFreeTouched(true);
    if (freeError(s.free)) return;
    const normal = { ...s, free: Number(s.free).toFixed(2) };
    const now = effective === EFFECTIVE[0];
    setS(normal);
    setSaved(normal);
    setHistory((h) => [
      { t: 'Last saved', d: 'Oct 8, just now · Avery Stone', state: 'done', body: `${sentence(dirty)}. ${now ? 'Applies to orders placed after saving.' : 'Applies from Mon, Oct 12, 12:00 AM PT.'}` },
      ...h.map((e) => (e.t === 'Last saved' ? { ...e, t: 'Saved' } : e)),
    ]);
    setNotice(now ? 'Shipping settings saved. They apply to orders placed from now on.' : 'Shipping settings saved. They apply from Mon, Oct 12, 12:00 AM PT.');
    announce('Shipping settings saved');
  };
  const discard = () => {
    setS(saved);
    setFreeTouched(false);
    announce('Changes discarded');
  };

  // "What customers see": Halden Pocket Speaker ($59.00) to Portland, OR.
  const price = 59;
  const standard = s.methods.find((m) => m.id === 'm1');
  const shipping = standard?.on ? (!freeError(s.free) && price >= Number(s.free) ? 'Free Standard' : `${money(6.99)} Standard`) : `${money(9.99)} Expedited`;
  const sameDay = s.handling === HANDLING[0];

  // Add closure dialog
  const closureErrors = { name: closureTried && !closure.name.trim() ? 'Enter a name for the closure.' : '', from: closureTried && !closure.from.trim() ? 'Enter the first closed day.' : '' };
  const openClosure = () => {
    setClosure(EMPTY_CLOSURE);
    setClosureTried(false);
    setClosureOpen(true);
  };
  const addClosure = () => {
    setClosureTried(true);
    if (!closure.name.trim() || !closure.from.trim()) return;
    const name = closure.name.trim();
    set('closures', [...s.closures, { id: `c${Date.now()}`, name, dates: closure.to.trim() ? `${closure.from.trim()} – ${closure.to.trim()}` : closure.from.trim(), removeLabel: `Remove ${name} closure` }]);
    setClosureOpen(false);
  };

  // Return address dialog
  const addrBad = { name: !addr.name.trim(), line1: !addr.line1.trim(), city: !/\d{5}$/.test(addr.city.trim()), email: !isEmail(addr.email) };
  const addrErrors = {
    name: addrTried && addrBad.name ? 'Enter the name on the return address.' : '',
    line1: addrTried && addrBad.line1 ? 'Enter a street address.' : '',
    city: addrTried && addrBad.city ? 'Enter the city, state and 5-digit ZIP code, like Portland, OR 97209.' : '',
    email: addrTried && addrBad.email ? 'Enter an email address, like returns@example.com.' : '',
  };
  const openAddr = () => {
    setAddr(s.address);
    setAddrTried(false);
    setAddrOpen(true);
  };
  const saveAddr = () => {
    setAddrTried(true);
    if (Object.values(addrBad).some(Boolean)) return;
    set('address', { ...addr, name: addr.name.trim(), line1: addr.line1.trim(), city: addr.city.trim(), email: addr.email.trim() });
    setAddrOpen(false);
  };

  // Add method dialog
  const methodBad = { name: !method.name.trim(), transit: !method.transit.trim(), rate: !isAmount(method.rate) };
  const methodErrors = {
    name: methodTried && methodBad.name ? 'Enter a method name.' : '',
    transit: methodTried && methodBad.transit ? 'Enter the transit time, like 3–5 business days.' : '',
    rate: methodTried && methodBad.rate ? 'Enter a flat rate in dollars, like 12.99.' : '',
  };
  const openMethod = () => {
    setMethod(EMPTY_METHOD);
    setMethodTried(false);
    setMethodOpen(true);
  };
  const addMethod = () => {
    setMethodTried(true);
    if (Object.values(methodBad).some(Boolean)) return;
    set('methods', [...s.methods, { id: `m${Date.now()}`, name: method.name.trim(), carrier: method.carrier.trim() || 'Carrier of your choice', transit: method.transit.trim(), rateType: 'Flat per package', rates: [money(Number(method.rate))], free: false, on: true }]);
    setMethodOpen(false);
  };

  return (
    <SellerLayout active="shipping">
      <PageHeader
        title="Shipping settings"
        sub="These settings drive the delivery estimates and shipping prices customers see on your offers."
        actions={
          <Button variant="secondary" size="sm" icon="package-search" to={href('seller/orders', 'shipped')}>
            Shipment records
          </Button>
        }
      />
      <div className="sa-split">
        <div className="stack gap-5">
          {notice && <Alert tone="success" title={notice} />}
          <Card title="Coverage" sub="Where you ship">
            <div className="stack gap-2">
              <span className="label">Ship to</span>
              <OptionCard id="sh-cov1" name="sh-cov" title={<b>48 contiguous states and Washington, DC</b>} body="Recommended for launch." checked={s.coverage === 'contiguous'} onChange={() => set('coverage', 'contiguous')} />
              <OptionCard id="sh-cov2" name="sh-cov" title={<b>All 50 states</b>} body="Alaska and Hawaii orders use separate rates." checked={s.coverage === 'all50'} onChange={() => set('coverage', 'all50')} />
            </div>
            <div className="stack gap-2">
              <span className="label">Excluded areas</span>
              <div className="grid md2 gap-2">
                {EXCLUSIONS.map((e, i) => (
                  <Checkbox key={e.id} id={e.id} label={e.label} checked={!!s.excluded[e.id]} aria-describedby={i === 0 ? 'sh-ex1-hint' : undefined} onChange={(ev) => set('excluded', { ...s.excluded, [e.id]: ev.target.checked })} />
                ))}
              </div>
              <span className="hint" id="sh-ex1-hint">
                Customers in excluded areas see "Doesn't ship to your address" before checkout.
              </span>
            </div>
          </Card>

          <Card
            title="Methods and rates"
            titleAs="h3"
            flush
            footClassName="card-foot--field"
            actions={
              <Button variant="secondary" size="sm" icon="plus" onClick={openMethod}>
                Add method
              </Button>
            }
            foot={
              <>
                {/* QA M-2: on the phone layout the row, field and input keep a real width (the input used to collapse to 0 px). */}
                <div className="row gap-3 grow" style={{ minWidth: 'min(100%, 16rem)' }}>
                  <div className="field grow" style={{ minWidth: 'min(100%, 12rem)' }}>
                    <label className="label" htmlFor="sh-free">
                      Free Standard shipping on orders over
                    </label>
                    <span className="input-group" style={{ minWidth: '8rem' }}>
                      <span className="affix">$</span>
                      <input
                        className={cx('input', fErr && 'is-error')}
                        id="sh-free"
                        type="text"
                        inputMode="decimal"
                        value={s.free}
                        placeholder=""
                        aria-invalid={fErr ? true : undefined}
                        aria-describedby={fErr ? 'sh-free-err' : undefined}
                        style={{ flex: '1 1 auto', minWidth: '4rem', width: '100%' }}
                        onChange={(e) => set('free', e.target.value)}
                        onBlur={() => setFreeTouched(true)}
                      />
                    </span>
                    {fErr && (
                      <span className="error-text" id="sh-free-err">
                        <Icon name="circle-alert" className="ic-sm" />
                        {fErr}
                      </span>
                    )}
                  </div>
                </div>
                <span className="xs muted u-maxw-40ch">Applies to your items in one order. Customers see "Free delivery" on qualifying offers.</span>
              </>
            }
          >
            <TableWrap label="Methods and rates table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Method</th>
                    <th scope="col">Transit</th>
                    <th scope="col">Rate type</th>
                    <th scope="col">Rates</th>
                    <th scope="col">Free shipping</th>
                    <th scope="col">On</th>
                  </tr>
                </thead>
                <tbody>
                  {s.methods.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <span className="small strong">{m.name}</span>
                        <div className="xs muted">{m.carrier}</div>
                      </td>
                      <td>{m.transit}</td>
                      <td>{m.rateType}</td>
                      <td>
                        <span className="small num">
                          {m.rates.map((r, i) => (
                            <span key={r}>
                              {i > 0 && <br />}
                              {r}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td>{m.free ? <Badge tone="success">{freeLabel}</Badge> : <span className="xs muted">No</span>}</td>
                      <td>
                        <Switch id={`sh-${m.id}`} label={<span className="sr-only">{m.name} on</span>} checked={m.on} aria-checked={m.on} onChange={(e) => set('methods', s.methods.map((x) => (x.id === m.id ? { ...x, on: e.target.checked } : x)))} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>

          <Card title="Dispatch schedule" titleAs="h3" sub="Used to set each order's dispatch deadline">
            <div className="grid md2">
              <Field label="Handling time">
                <Select id="sh-handle" options={HANDLING} value={s.handling} onChange={(e) => set('handling', e.target.value)} />
              </Field>
              <Field label="Same-day order cutoff" hint="Orders before the cutoff are due by 5:00 PM the same day.">
                <Select id="sh-cut" options={CUTOFFS} value={s.cutoff} onChange={(e) => set('cutoff', e.target.value)} />
              </Field>
            </div>
            <div className="stack gap-2">
              <span className="label">Business days</span>
              <div className="sa-days" role="group" aria-label="Business days">
                {DAYS.map((d) => (
                  <button key={d} type="button" className={cx('pill-opt', s.days[d] && 'is-selected')} aria-pressed={!!s.days[d]} data-toggle="" onClick={() => set('days', { ...s.days, [d]: !s.days[d] })}>
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div className="stack gap-2">
              <div className="row between">
                <span className="label">Holiday closures</span>
                <Button variant="ghost" size="sm" icon="plus" onClick={openClosure}>
                  Add closure
                </Button>
              </div>
              <ul className="list">
                {s.closures.map((c) => (
                  <li key={c.id}>
                    <span className="grow small">
                      <b>{c.name}</b> · {c.dates}
                    </span>
                    <button type="button" className="icon-btn" aria-label={c.removeLabel} onClick={() => set('closures', s.closures.filter((x) => x.id !== c.id))}>
                      <Icon name="trash-2" />
                    </button>
                  </li>
                ))}
              </ul>
              <span className="hint">Arrival estimates skip closed days, and customers see a note during closures.</span>
            </div>
          </Card>

          <Card
            title="Return address"
            titleAs="h3"
            actions={
              <Button variant="ghost" size="sm" icon="pencil" onClick={openAddr}>
                Edit
              </Button>
            }
          >
            <div className="stack gap-0 small">
              <span className="strong">{s.address.name}</span>
              <span>{s.address.line1}</span>
              <span>{s.address.city}</span>
              <span className="muted">
                {s.address.phone} · {s.address.email}
              </span>
            </div>
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">Return labels and buyer instructions use this address. Changing it affects only returns opened after the change.</span>
            </p>
          </Card>

          <Card title="Shipping labels" titleAs="h3" sub="Where supported">
            <Switch id="sh-labels" label="Buy labels in Seller Center" checked={s.labels} aria-checked={s.labels} onChange={(e) => set('labels', e.target.checked)} />
            <ul className="list">
              {LABEL_CARRIERS.map((c) => (
                <li key={c.name}>
                  <span className="grow small">{c.name}</span>
                  {!c.supported ? <Badge>Enter tracking manually</Badge> : s.labels ? <Badge tone="success">Supported</Badge> : <Badge>Labels off</Badge>}
                </li>
              ))}
            </ul>
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">Label cost is deducted from your earnings and shown on your statement.</span>
            </p>
          </Card>

          <div className="sa-savebar">
            <div className="stack gap-1">
              <span className="small strong">{dirty.length ? `${dirty.length} unsaved change${dirty.length > 1 ? 's' : ''}` : 'All changes saved'}</span>
              <span className="xs muted">{dirty.length ? sentence(dirty) : history[0].d}</span>
            </div>
            <div className="row gap-2">
              <label className="sr-only" htmlFor="sh-when">
                Effective
              </label>
              <Select id="sh-when" options={EFFECTIVE} value={effective} onChange={(e) => setEffective(e.target.value)} />
              <Button variant="ghost" onClick={discard} disabled={!dirty.length}>
                Discard
              </Button>
              <Button onClick={save} disabled={!dirty.length}>
                Save changes
              </Button>
            </div>
          </div>
        </div>

        <aside className="stack gap-5 sa-sticky">
          <Card title="What customers see" titleAs="h3" sub="Example: Halden Pocket Speaker to Portland, OR">
            <KeyValue
              pairs={[
                ['Price', money(price)],
                ['Shipping', shipping],
                ['Arrives', ARRIVES[s.handling]],
                ['Dispatch', sameDay ? 'Ships the same business day' : `Ships in ${s.handling}`],
              ]}
            />
            <div className="panel xs sub">Order today by {s.cutoff} to ship today.</div>
          </Card>
          <Card title="When changes apply" titleAs="h3">
            <p className="small sub">New settings apply to orders placed after the effective time. Existing orders keep the delivery terms and prices the customer accepted.</p>
            <Timeline events={history} />
          </Card>
        </aside>
      </div>

      <Dialog
        open={closureOpen}
        onClose={() => setClosureOpen(false)}
        title="Add closure"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setClosureOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addClosure}>Add closure</Button>
          </>
        }
      >
        <Field label="Name" error={closureErrors.name}>
          <TextInput id="sh-cl-name" value={closure.name} error={!!closureErrors.name} placeholder="Inventory count" onChange={(e) => setClosure({ ...closure, name: e.target.value })} />
        </Field>
        <div className="grid md2 gap-3">
          <Field label="First closed day" error={closureErrors.from}>
            <TextInput id="sh-cl-from" value={closure.from} error={!!closureErrors.from} placeholder="Mon, Feb 15" onChange={(e) => setClosure({ ...closure, from: e.target.value })} />
          </Field>
          <Field label="Last closed day" optional>
            <TextInput id="sh-cl-to" value={closure.to} placeholder="Tue, Feb 16" onChange={(e) => setClosure({ ...closure, to: e.target.value })} />
          </Field>
        </div>
        <span className="xs muted">Arrival estimates skip closed days.</span>
      </Dialog>

      <Dialog
        open={addrOpen}
        onClose={() => setAddrOpen(false)}
        title="Edit return address"
        foot={
          <>
            <Button variant="ghost" onClick={() => setAddrOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveAddr}>Save address</Button>
          </>
        }
      >
        <Field label="Name" error={addrErrors.name}>
          <TextInput id="sh-ad-name" value={addr.name} error={!!addrErrors.name} onChange={(e) => setAddr({ ...addr, name: e.target.value })} />
        </Field>
        <Field label="Street address" error={addrErrors.line1}>
          <TextInput id="sh-ad-line1" value={addr.line1} error={!!addrErrors.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} />
        </Field>
        <Field label="City, state and ZIP code" error={addrErrors.city}>
          <TextInput id="sh-ad-city" value={addr.city} error={!!addrErrors.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} />
        </Field>
        <div className="grid md2 gap-3">
          <Field label="Phone">
            <TextInput id="sh-ad-phone" type="tel" value={addr.phone} onChange={(e) => setAddr({ ...addr, phone: e.target.value })} />
          </Field>
          <Field label="Email" error={addrErrors.email}>
            <TextInput id="sh-ad-email" type="email" value={addr.email} error={!!addrErrors.email} onChange={(e) => setAddr({ ...addr, email: e.target.value })} />
          </Field>
        </div>
        <span className="xs muted">Changing it affects only returns opened after the change.</span>
      </Dialog>

      <Dialog
        open={methodOpen}
        onClose={() => setMethodOpen(false)}
        title="Add method"
        foot={
          <>
            <Button variant="ghost" onClick={() => setMethodOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addMethod}>Add method</Button>
          </>
        }
      >
        <div className="grid md2 gap-3">
          <Field label="Method name" error={methodErrors.name}>
            <TextInput id="sh-mt-name" value={method.name} error={!!methodErrors.name} placeholder="Freight" onChange={(e) => setMethod({ ...method, name: e.target.value })} />
          </Field>
          <Field label="Carrier or service" optional>
            <TextInput id="sh-mt-carrier" value={method.carrier} onChange={(e) => setMethod({ ...method, carrier: e.target.value })} />
          </Field>
        </div>
        <div className="grid md2 gap-3">
          <Field label="Transit" error={methodErrors.transit}>
            <TextInput id="sh-mt-transit" value={method.transit} error={!!methodErrors.transit} placeholder="5–7 business days" onChange={(e) => setMethod({ ...method, transit: e.target.value })} />
          </Field>
          <Field label="Flat rate per package" error={methodErrors.rate}>
            <TextInput id="sh-mt-rate" prefix="$" value={method.rate} error={!!methodErrors.rate} inputMode="decimal" onChange={(e) => setMethod({ ...method, rate: e.target.value })} />
          </Field>
        </div>
      </Dialog>
    </SellerLayout>
  );
}
