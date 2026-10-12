import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { StoreLayout } from '@/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Checkbox, Field, FileDrop, Icon, IconButton, KeyValue, Meter, OptionCard, Select, Steps, TextInput, type IconName } from '@marketly/web-shared/ui';

// Design: pages/store/sell-apply.html (step 1, account) · views business-details, verification,
// payout-and-return-address (steps 4–5 on one page) and agreement. Each step validates before Continue;
// submitting goes to the application status page.

type View = '' | 'business-details' | 'verification' | 'payout-and-return-address' | 'agreement';
const VIEWS: View[] = ['', 'business-details', 'verification', 'payout-and-return-address', 'agreement'];
const STEP_NAMES = ['Account', 'Business', 'Verification', 'Payout', 'Return address', 'Agreement'];

interface StepMeta {
  /** Index of the current step in the 6-step progress bar. */
  current: number;
  heading: string;
  pct: number;
  help: string[];
  next: string;
}

const META: StepMeta[] = [
  {
    current: 0,
    heading: 'Step 1 of 6: Account',
    pct: 5,
    next: 'Create account and continue',
    help: ['Use an email your team checks every day. Order and payout notices go there.', 'If you use your shopping account, your purchases stay private from seller staff you add later.', 'You can add seller staff with their own logins after approval.'],
  },
  { current: 1, heading: 'Step 2 of 6: Business', pct: 25, next: 'Continue to verification', help: ['Use the exact legal name on your registration.', "Your store name can differ, but can't use a brand you don't own.", 'Pick every category you plan to sell in. Some need extra approval.'] },
  {
    current: 2,
    heading: 'Step 3 of 6: Verification',
    pct: 45,
    next: 'Continue to payout',
    help: ['Your registration record is free from the Oregon Secretary of State business registry.', 'Upload the whole page. Cropped screenshots are the most common reason we ask again.', 'Your ID is checked by our verification partner and then deleted from our systems after 90 days.'],
  },
  {
    current: 3,
    heading: 'Steps 4–5 of 6: Payout and return address',
    pct: 65,
    next: 'Continue to agreement',
    help: ['Find the routing and account numbers on a check or in your online banking.', 'We never ask for your online banking password.', 'If returns go to a warehouse, use its street address and a contact who can sign for packages.'],
  },
  { current: 5, heading: 'Step 6 of 6: Agreement', pct: 95, next: 'Accept and submit application', help: ['The fee schedule shows example rates during this preview. Your final rates are confirmed in your approval email.', "Approval doesn't publish products. Each product or offer is reviewed before it goes live."] },
];

const CATEGORIES: Array<{ id: string; name: string }> = [
  { id: 'electronics', name: 'Electronics' },
  { id: 'computers', name: 'Computers' },
  { id: 'home', name: 'Home & Kitchen' },
  { id: 'fashion', name: 'Fashion' },
  { id: 'sports', name: 'Sports & Outdoors' },
  { id: 'beauty', name: 'Beauty' },
  { id: 'toys', name: 'Toys & Games' },
  { id: 'pets', name: 'Pet Supplies' },
];
const STATES = ['Oregon', 'Washington', 'California', 'Nevada'];
const STATE_CODE: Record<string, string> = { OR: 'Oregon', WA: 'Washington', CA: 'California', NV: 'Nevada' };

const AGREEMENTS: Array<{ title: string; body: string; version: string }> = [
  { title: 'Seller agreement', body: 'How selling, payouts, refunds and restrictions work.', version: 'v1.4 · effective Sep 15, 2026' },
  { title: 'Product rules', body: 'What you can list, condition grades and accuracy rules.', version: 'v1.2' },
  { title: 'Fee schedule', body: 'Commission by category and how fees treat discounts, returns and disputes.', version: 'Example rates' },
  { title: 'Service standards', body: 'Dispatch, tracking, reply and cancellation targets.', version: 'v1.1' },
];

interface Form {
  acct: 'existing' | 'new';
  contact: string;
  cphone: string;
  cemail: string;
  cpass: string;
  store: string;
  stype: 'biz' | 'ind';
  market: string;
  tips: boolean;
  legal: string;
  btype: string;
  state: string;
  addr: string;
  phone: string;
  web: string;
  cats: string[];
  count: string;
  regDoc: string;
  ein: string;
  w9: string;
  bname: string;
  bkind: string;
  brout: string;
  bacct: string;
  bacct2: string;
  rsame: boolean;
  rname: string;
  rphone: string;
  rline1: string;
  rcity: string;
  rstate: string;
  rzip: string;
  agreed: boolean[];
  sign: string;
}

// Prefilled as in the design's draft (Northwind Audio).
const INITIAL: Form = {
  acct: 'new',
  contact: 'Avery Stone',
  cphone: '(503) 555-0172',
  cemail: 'avery@northwindaudio.example',
  cpass: 'Northwind-3315',
  store: 'Northwind Audio',
  stype: 'biz',
  market: 'United States (USD)',
  tips: false,
  legal: 'Northwind Audio LLC',
  btype: 'LLC',
  state: 'Oregon',
  addr: '3315 SE Division St, Portland, OR 97202',
  phone: '(503) 555-0172',
  web: 'northwindaudio.example',
  cats: ['electronics'],
  count: '21–100',
  regDoc: '',
  ein: '93-4418210',
  w9: 'Fill in online',
  bname: 'Northwind Audio LLC',
  bkind: 'Business checking',
  brout: '',
  bacct: '',
  bacct2: '',
  rsame: true,
  rname: 'Northwind Audio Returns',
  rphone: '(503) 555-0172',
  rline1: '3315 SE Division St',
  rcity: 'Portland',
  rstate: 'Oregon',
  rzip: '97202',
  agreed: [true, true, true, false],
  sign: 'Avery Stone',
};

type Errors = Partial<Record<keyof Form, string>>;

/** "3315 SE Division St, Portland, OR 97202" -> street, city, state, ZIP. */
function splitAddress(a: string) {
  const parts = a.split(',').map((s) => s.trim());
  const m = (parts[2] ?? '').match(/^([A-Z]{2})\s+(\d{5})$/);
  return { line1: parts[0] ?? '', city: parts[1] ?? '', state: m ? (STATE_CODE[m[1]] ?? m[1]) : '', zip: m ? m[2] : '' };
}

function passwordRules(f: Form) {
  const p = f.cpass;
  const lower = p.toLowerCase();
  const local = f.cemail.split('@')[0].toLowerCase();
  const names = f.contact.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  return [
    { label: 'At least 10 characters', ok: p.length >= 10 },
    { label: 'One number', ok: /\d/.test(p) },
    { label: 'One uppercase letter', ok: /[A-Z]/.test(p) },
    { label: 'Not your email or name', ok: p.length > 0 && !(local && lower.includes(local)) && !names.some((n) => lower === n || lower === f.contact.toLowerCase()) },
  ];
}

function validate(step: number, f: Form): Errors {
  const e: Errors = {};
  const req = (k: keyof Form, msg: string) => {
    if (!String(f[k]).trim()) e[k] = msg;
  };
  if (step === 0) {
    req('contact', 'Enter the contact person.');
    if (f.cphone.replace(/\D/g, '').length < 10) e.cphone = 'Enter a 10-digit US phone number.';
    if (f.acct === 'new') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.cemail.trim())) e.cemail = 'Enter an email address, like name@business.com.';
      if (!passwordRules(f).every((r) => r.ok)) e.cpass = 'Choose a password that meets all the requirements below.';
    }
    req('store', 'Enter the store name customers will see.');
  }
  if (step === 1) {
    req('legal', f.stype === 'biz' ? 'Enter the legal name on your registration.' : 'Enter your full legal name.');
    req('store', 'Enter the store name customers will see.');
    req('addr', 'Enter the business address.');
    if (f.phone.replace(/\D/g, '').length < 10) e.phone = 'Enter a 10-digit US phone number.';
    if (!f.cats.length) e.cats = 'Pick at least one category.';
  }
  if (step === 2) {
    if (f.stype === 'biz' && !f.regDoc) e.regDoc = 'Upload your registration record to continue.';
    if (f.stype === 'biz' ? !/^\d{2}-?\d{7}$/.test(f.ein.trim()) : !/^(\d{2}-?\d{7}|\d{3}-?\d{2}-?\d{4})$/.test(f.ein.trim())) e.ein = f.stype === 'biz' ? 'Enter a 9-digit EIN, like 12-3456789.' : 'Enter a 9-digit EIN or SSN.';
  }
  if (step === 3) {
    req('bname', 'Enter the account holder name.');
    if (!/^\d{9}$/.test(f.brout.trim())) e.brout = 'Enter the 9-digit routing number.';
    if (!/^\d{4,17}$/.test(f.bacct.trim())) e.bacct = 'Enter the account number (4 to 17 digits).';
    else if (f.bacct2.trim() !== f.bacct.trim()) e.bacct2 = "The account numbers don't match.";
    req('rname', 'Enter a contact name for returns.');
    if (f.rphone.replace(/\D/g, '').length < 10) e.rphone = 'Enter a 10-digit US phone number.';
    if (!f.rsame) {
      if (!f.rline1.trim()) e.rline1 = 'Enter a street address.';
      else if (/\bp\.?\s*o\.?\s*box\b/i.test(f.rline1)) e.rline1 = "Use a street address. Carriers can't deliver returns to PO boxes.";
      req('rcity', 'Enter a city.');
      req('rstate', 'Enter a state.');
      if (!/^\d{5}$/.test(f.rzip.trim())) e.rzip = 'Enter a 5-digit ZIP code, like 97202.';
    }
  }
  if (step === 4) {
    if (!f.agreed.every(Boolean)) e.agreed = 'Accept all four documents to submit your application.';
    if (f.sign.trim().toLowerCase() !== f.contact.trim().toLowerCase()) e.sign = `Type your full name exactly: ${f.contact.trim() || 'the contact person'}.`;
  }
  return e;
}

function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <span className="error-text">
      <Icon name="circle-alert" className="ic-sm" />
      {children}
    </span>
  );
}

interface StepProps {
  f: Form;
  set: <K extends keyof Form>(k: K, v: Form[K]) => void;
  e: Errors;
}

function AccountStep({ f, set, e }: StepProps) {
  const [show, setShow] = useState(false);
  const rules = passwordRules(f);
  return (
    <>
      <div className="buy-opts c2">
        <OptionCard id="ap-acct-existing" name="ap-acct" checked={f.acct === 'existing'} onChange={() => set('acct', 'existing')} title={<span className="small strong">Use my Marketly account</span>} body="Sign in with your shopping account. Seller access is added to it." right={<Icon name="user-round" />} />
        <OptionCard id="ap-acct-new" name="ap-acct" checked={f.acct === 'new'} onChange={() => set('acct', 'new')} title={<span className="small strong">Create a new seller login</span>} body="Use a separate email for your business." right={<Icon name="user-plus" />} />
      </div>
      <div className="grid md2">
        <Field label="Contact person" hint="The person we contact about this application." error={e.contact}>
          <TextInput id="ap-contact" value={f.contact} error={!!e.contact} onChange={(ev) => set('contact', ev.target.value)} autoComplete="name" />
        </Field>
        <Field label="Phone" error={e.cphone}>
          <TextInput id="ap-cphone" type="tel" value={f.cphone} error={!!e.cphone} onChange={(ev) => set('cphone', ev.target.value)} autoComplete="tel" />
        </Field>
      </div>
      {f.acct === 'new' ? (
        <>
          <Field label="Work email" hint="We send a 6-digit code to confirm it." error={e.cemail}>
            <TextInput id="ap-cemail" type="email" value={f.cemail} error={!!e.cemail} onChange={(ev) => set('cemail', ev.target.value)} autoComplete="email" />
          </Field>
          <div className="field">
            <div className="row between">
              <label className="label" htmlFor="ap-cpass">
                Password
              </label>
            </div>
            <span className={cx('buy-pass', e.cpass && 'is-error')}>
              <input className="input" id="ap-cpass" type={show ? 'text' : 'password'} value={f.cpass} aria-invalid={!!e.cpass || undefined} aria-describedby="ap-cpass-rules" onChange={(ev) => set('cpass', ev.target.value)} autoComplete="new-password" />
              <Button variant="ghost" size="sm" icon={show ? 'eye-off' : 'eye'} aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((s) => !s)}>
                {show ? 'Hide' : 'Show'}
              </Button>
            </span>
            <ErrorText>{e.cpass}</ErrorText>
          </div>
          <ul className="buy-rules" aria-label="Password requirements" id="ap-cpass-rules">
            {rules.map((r) => (
              <li key={r.label} className={cx(r.ok && 'is-ok')}>
                <Icon name={r.ok ? 'circle-check' : 'circle'} className="ic-sm" />
                <span>
                  {r.label}
                  <span className="sr-only">{r.ok ? ' (met)' : ' (not met)'}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="panel row gap-3">
          <Icon name="user-round" />
          <span className="small grow">Seller access is added to jordan.lee@example.com. You sign in to Seller Center with the same password.</span>
        </div>
      )}
      <Field label="Store name" hint="Shown to customers on your offers and storefront. You can change it later; changes are reviewed." error={e.store}>
        <TextInput id="ap-cstore" value={f.store} error={!!e.store} onChange={(ev) => set('store', ev.target.value)} />
      </Field>
      <fieldset className="stack gap-2 fieldset-reset">
        <legend className="label u-mb-sp-2">Seller type</legend>
        <div className="buy-opts c2">
          <OptionCard id="ap-stype-biz" name="ap-stype" checked={f.stype === 'biz'} onChange={() => set('stype', 'biz')} title={<span className="small strong">Business</span>} body="LLC, corporation or partnership with an EIN" right={<Icon name="building-2" />} />
          <OptionCard id="ap-stype-ind" name="ap-stype" checked={f.stype === 'ind'} onChange={() => set('stype', 'ind')} title={<span className="small strong">Individual</span>} body="Sole proprietor selling under your own name" right={<Icon name="user-round" />} />
        </div>
      </fieldset>
      <Field label="Market" hint="At launch we sell in one market. The next steps list the requirements for US sellers.">
        <Select id="ap-market" options={['United States (USD)']} value={f.market} onChange={(ev) => set('market', ev.target.value)} />
      </Field>
      <Checkbox id="ap-ctips" label="Email me tips for new sellers. Application and account notices are always sent." checked={f.tips} onChange={(ev) => set('tips', ev.target.checked)} />
    </>
  );
}

function BusinessStep({ f, set, e }: StepProps) {
  const toggleCat = (id: string) => set('cats', f.cats.includes(id) ? f.cats.filter((c) => c !== id) : [...f.cats, id]);
  return (
    <>
      <div className="buy-opts c2">
        <OptionCard id="ap-type-biz" name="ap-type" checked={f.stype === 'biz'} onChange={() => set('stype', 'biz')} title={<span className="small strong">Registered business</span>} body="LLC, corporation or partnership" />
        <OptionCard id="ap-type-ind" name="ap-type" checked={f.stype === 'ind'} onChange={() => set('stype', 'ind')} title={<span className="small strong">Individual seller</span>} body="Sole proprietor using your own name or SSN" />
      </div>
      <div className="grid md2">
        <Field label={f.stype === 'biz' ? 'Legal business name' : 'Legal name'} error={e.legal}>
          <TextInput id="ap-legal" value={f.legal} error={!!e.legal} onChange={(ev) => set('legal', ev.target.value)} />
        </Field>
        <Field label="Store name shown to customers" hint="You can change it later. Changes are reviewed." error={e.store}>
          <TextInput id="ap-store" value={f.store} error={!!e.store} onChange={(ev) => set('store', ev.target.value)} />
        </Field>
      </div>
      <div className="grid md2">
        <Field label="Business type">
          <Select id="ap-btype" options={f.stype === 'biz' ? ['LLC', 'Corporation', 'Partnership'] : ['Sole proprietor']} value={f.stype === 'biz' ? f.btype : 'Sole proprietor'} onChange={(ev) => set('btype', ev.target.value)} />
        </Field>
        <Field label="State of registration">
          <Select id="ap-state" options={STATES} value={f.state} onChange={(ev) => set('state', ev.target.value)} />
        </Field>
      </div>
      <Field label="Business address" error={e.addr}>
        <TextInput id="ap-addr" value={f.addr} error={!!e.addr} onChange={(ev) => set('addr', ev.target.value)} autoComplete="street-address" />
      </Field>
      <div className="grid md2">
        <Field label="Business phone" error={e.phone}>
          <TextInput id="ap-phone" type="tel" value={f.phone} error={!!e.phone} onChange={(ev) => set('phone', ev.target.value)} />
        </Field>
        <Field label="Website" optional>
          <TextInput id="ap-web" value={f.web} onChange={(ev) => set('web', ev.target.value)} />
        </Field>
      </div>
      <fieldset className="stack gap-2 fieldset-reset" aria-invalid={!!e.cats || undefined}>
        <legend className="label u-mb-sp-2">What will you sell?</legend>
        <div className="grid m2 md4 gap-2">
          {CATEGORIES.map((c) => (
            <Checkbox key={c.id} id={`ap-cat-${c.id}`} label={c.name} checked={f.cats.includes(c.id)} onChange={() => toggleCat(c.id)} />
          ))}
        </div>
        <ErrorText>{e.cats}</ErrorText>
      </fieldset>
      <Field label="How many products do you plan to list?">
        <Select id="ap-count" options={['1–20', '21–100', '101–500', 'More than 500']} value={f.count} onChange={(ev) => set('count', ev.target.value)} />
      </Field>
    </>
  );
}

function VerificationStep({ f, set, e }: StepProps) {
  return (
    <>
      <div className="stack gap-2">
        <span className="label">Business owner</span>
        <div className="panel row gap-3">
          <Avatar name={f.contact || 'Avery Stone'} />
          <span className="stack gap-0 grow">
            <span className="small strong">{f.contact || 'Avery Stone'}</span>
            <span className="xs muted">Owner · 100% ownership · Portland, OR</span>
          </span>
          <Badge tone="info">Verified</Badge>
        </div>
      </div>
      <div className="field">
        <span className="label">Government photo ID</span>
        <div className="panel row gap-3">
          <Icon name="file-check" />
          <span className="small grow">drivers-license-front.jpg · drivers-license-back.jpg</span>
          <Badge tone="success" icon="check">
            Uploaded
          </Badge>
        </div>
      </div>
      {f.stype === 'biz' && (
        <div className="field">
          <span className="label">Business registration document</span>
          {f.regDoc ? (
            <div className="panel row gap-3">
              <Icon name="file-check" />
              <span className="small grow">{f.regDoc}</span>
              <Badge tone="success" icon="check">
                Uploaded
              </Badge>
              <IconButton icon="x" size="sm" label={`Remove ${f.regDoc}`} onClick={() => set('regDoc', '')} />
            </div>
          ) : (
            <FileDrop
              title={`Upload your ${f.state} registration record`}
              hint="PDF, JPG or PNG up to 10 MB. Must show the legal name, registry number and status."
              accept="application/pdf,image/jpeg,image/png"
              multiple={false}
              onFiles={(files) => files[0] && set('regDoc', files[0].name)}
            />
          )}
          <ErrorText>{e.regDoc}</ErrorText>
        </div>
      )}
      <div className="grid md2">
        <Field label={f.stype === 'biz' ? 'Tax ID (EIN)' : 'Tax ID (EIN or SSN)'} hint="Matches the name on your W-9." error={e.ein}>
          <TextInput id="ap-ein" value={f.ein} error={!!e.ein} onChange={(ev) => set('ein', ev.target.value)} />
        </Field>
        <Field label="W-9 form">
          <Select id="ap-w9" options={['Fill in online', 'Upload a signed PDF']} value={f.w9} onChange={(ev) => set('w9', ev.target.value)} />
        </Field>
      </div>
      <Alert tone="info" title="Some applications get an extra check">
        Our Trust and Risk team reviews some applications, for example for high-value electronics. This can add up to 2 business days. We'll tell you if it applies.
      </Alert>
    </>
  );
}

function PayoutFields({ f, set, e }: StepProps) {
  return (
    <>
      <Field label="Account holder name" hint="Must match your legal business name or the owner's name." error={e.bname}>
        <TextInput id="ap-bname" value={f.bname} error={!!e.bname} onChange={(ev) => set('bname', ev.target.value)} />
      </Field>
      <Field label="Account type">
        <Select id="ap-bkind" options={['Business checking', 'Business savings']} value={f.bkind} onChange={(ev) => set('bkind', ev.target.value)} />
      </Field>
      <div className="grid md2">
        <Field label="Routing number" error={e.brout}>
          <TextInput id="ap-brout" value={f.brout} placeholder="9 digits" inputMode="numeric" error={!!e.brout} onChange={(ev) => set('brout', ev.target.value)} />
        </Field>
        <Field label="Account number" error={e.bacct}>
          <TextInput id="ap-bacct" value={f.bacct} placeholder="Account number" inputMode="numeric" error={!!e.bacct} onChange={(ev) => set('bacct', ev.target.value)} />
        </Field>
      </div>
      <Field label="Confirm account number" error={e.bacct2}>
        <TextInput id="ap-bacct2" value={f.bacct2} placeholder="Enter it again" inputMode="numeric" error={!!e.bacct2} onChange={(ev) => set('bacct2', ev.target.value)} />
      </Field>
      <Alert tone="info" title="How we verify your bank account">
        After approval we send 2 small deposits to this account. They arrive in 1–2 business days. Confirm the amounts in Seller Center to turn on payouts. Changing this account later needs a new check and a review.
      </Alert>
      <div className="panel stack gap-1">
        <span className="small strong">Payout schedule (example)</span>
        <span className="xs sub">Earnings become available 7 days after delivery and are paid every Tuesday. Example schedule; final timing is in the seller agreement.</span>
      </div>
    </>
  );
}

function ReturnFields({ f, set, e }: StepProps) {
  const biz = splitAddress(f.addr);
  const toggleSame = (on: boolean) => {
    set('rsame', on);
    if (on) {
      set('rline1', biz.line1);
      set('rcity', biz.city);
      set('rstate', biz.state);
      set('rzip', biz.zip);
    }
  };
  const ro = f.rsame;
  return (
    <>
      <Checkbox id="ap-rsame" label={`Same as business address: ${f.addr}`} checked={f.rsame} onChange={(ev) => toggleSame(ev.target.checked)} />
      <div className="grid md2">
        <Field label="Contact name" error={e.rname}>
          <TextInput id="ap-rname" value={f.rname} error={!!e.rname} onChange={(ev) => set('rname', ev.target.value)} />
        </Field>
        <Field label="Phone" error={e.rphone}>
          <TextInput id="ap-rphone" type="tel" value={f.rphone} error={!!e.rphone} onChange={(ev) => set('rphone', ev.target.value)} />
        </Field>
      </div>
      <Field label="Street address" hint="Must be a street address. Carriers can't deliver returns to PO boxes." error={e.rline1}>
        <TextInput id="ap-rline1" value={ro ? biz.line1 : f.rline1} readOnly={ro} error={!!e.rline1} onChange={(ev) => set('rline1', ev.target.value)} />
      </Field>
      <div className="grid md3">
        <Field label="City" error={e.rcity}>
          <TextInput id="ap-rcity" value={ro ? biz.city : f.rcity} readOnly={ro} error={!!e.rcity} onChange={(ev) => set('rcity', ev.target.value)} />
        </Field>
        <Field label="State" error={e.rstate}>
          <TextInput id="ap-rstate" value={ro ? biz.state : f.rstate} readOnly={ro} error={!!e.rstate} onChange={(ev) => set('rstate', ev.target.value)} />
        </Field>
        <Field label="ZIP code" error={e.rzip}>
          <TextInput id="ap-rzip" value={ro ? biz.zip : f.rzip} readOnly={ro} inputMode="numeric" error={!!e.rzip} onChange={(ev) => set('rzip', ev.target.value)} />
        </Field>
      </div>
      <div className="buy-note t-info">
        <Icon name="undo-2" />
        <span>Customers ship returns to this address. It is printed on return labels and shown to customers who return your items.</span>
      </div>
    </>
  );
}

function AgreementStep({ f, set, e }: StepProps) {
  const ret = f.rsame ? f.addr : `${f.rline1}, ${f.rcity}, ${f.rstate} ${f.rzip}`;
  const last4 = f.bacct.trim().slice(-4) || '7731';
  return (
    <>
      <div className="buy-agree" aria-invalid={!!e.agreed || undefined}>
        {AGREEMENTS.map((a, i) => (
          <div key={a.title}>
            <input type="checkbox" id={`ap-ag-${i}`} className="check-input" checked={f.agreed[i]} onChange={(ev) => set('agreed', f.agreed.map((v, j) => (j === i ? ev.target.checked : v)))} />
            <label className="stack gap-0 grow" htmlFor={`ap-ag-${i}`}>
              <span className="small strong">I accept the {a.title}</span>
              <span className="xs muted">{a.body}</span>
            </label>
            <Link className="small strong nowrap" to={href('info/policy', 'seller-rules')}>
              <Icon name="file-text" className="ic-sm" /> Read · {a.version}
            </Link>
          </div>
        ))}
      </div>
      <ErrorText>{e.agreed}</ErrorText>
      <Field label="Type your full name to sign" hint={`Signing as owner of ${f.legal || 'your business'} on Thu, Oct 8, 2026.`} error={e.sign}>
        <TextInput id="ap-sign" value={f.sign} error={!!e.sign} onChange={(ev) => set('sign', ev.target.value)} />
      </Field>
      <div className="panel stack gap-2">
        <span className="small strong">Application summary</span>
        <KeyValue
          pairs={[
            [
              'Account',
              <>
                {f.acct === 'new' ? f.cemail : 'jordan.lee@example.com'} <Badge tone="info">Verified</Badge>
              </>,
            ],
            ['Business', `${f.legal} · ${f.state}`],
            ['Verification', f.stype === 'biz' ? 'ID and registration uploaded' : 'ID uploaded'],
            ['Payout', `${f.bkind.replace('Business ', '').replace(/^./, (c) => c.toUpperCase())} account •••• ${last4}`],
            ['Return address', ret],
          ]}
        />
      </div>
      <p className="xs muted">After you submit, a Seller Manager reviews your application, usually within 3–5 business days. We email you if we need anything.</p>
    </>
  );
}

const CHECKLIST: Array<{ label: string; doneFrom: number }> = [
  { label: 'Business registration', doneFrom: 3 },
  { label: 'Tax ID (EIN or SSN)', doneFrom: 3 },
  { label: 'Owner photo ID', doneFrom: 2 },
  { label: 'Bank account for payouts', doneFrom: 4 },
  { label: 'US return address', doneFrom: 4 },
];

function CardHead({ title, sub, as: H = 'h2' }: { title: string; sub: string; as?: 'h2' | 'h3' }) {
  return (
    <div className="card-head">
      <div className="stack gap-0">
        <H className="h4">{title}</H>
        <span className="xs muted">{sub}</span>
      </div>
    </div>
  );
}

export default function Apply() {
  const navigate = useNavigate();
  const [view, setView] = useView<Exclude<View, ''>>();
  const step = Math.max(0, VIEWS.indexOf(view as View));
  const meta = META[step];
  const [f, setF] = useState<Form>(INITIAL);
  const [tried, setTried] = useState<boolean[]>([false, false, false, false, false]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));
  const errors = tried[step] ? validate(step, f) : {};
  const nErrors = Object.keys(errors).length;
  const props = { f, set, e: errors };

  const go = (i: number) => {
    setView(VIEWS[i] as Exclude<View, ''>);
    window.scrollTo({ top: 0 });
  };
  const next = () => {
    setTried((t) => t.map((v, i) => (i === step ? true : v)));
    if (Object.keys(validate(step, f)).length) return;
    if (step === VIEWS.length - 1) navigate(href('sell/status'));
    else go(step + 1);
  };

  const stepItems = STEP_NAMES.map((n, i) =>
    i === meta.current ? (
      <>
        <span className="sr-only">
          Step {i + 1} of {STEP_NAMES.length}:{' '}
        </span>
        {n}
      </>
    ) : (
      n
    ),
  );

  const back =
    step === 0 ? (
      <Button variant="ghost" to={href('sell/landing')}>
        Cancel
      </Button>
    ) : (
      <Button variant="ghost" onClick={() => go(step - 1)}>
        Back
      </Button>
    );
  const primary =
    step === VIEWS.length - 1 ? (
      <Button icon="send" onClick={next}>
        {meta.next}
      </Button>
    ) : (
      <Button iconRight="arrow-right" onClick={next}>
        {meta.next}
      </Button>
    );
  const foot = (
    <div className="card-foot">
      {back}
      {primary}
    </div>
  );
  const summary = nErrors > 0 && (
    <Alert tone="danger" title={`Check ${nErrors} field${nErrors > 1 ? 's' : ''}`}>
      Fix the highlighted fields to continue.
    </Alert>
  );

  return (
    <StoreLayout appbar={{ title: 'Seller application', back: href('sell/landing') }} footer={false} tabbar={false}>
      <div className="container page gap-5">
        <div className="row between">
          <div className="stack gap-1">
            <h1 className="h1">Seller application</h1>
            <span className="xs muted">
              <Icon name="circle-check" className="ic-sm" /> Draft saved at 2:14 PM PT · {f.store || 'Your store'}
            </span>
          </div>
          <Button variant="secondary" icon="save" to={href('sell/landing')}>
            Save draft and exit
          </Button>
        </div>
        <div className="stack gap-2">
          <div className="row between xs">
            <span className="strong">{meta.heading}</span>
            <span className="muted">{meta.pct}% complete</span>
          </div>
          <Meter pct={meta.pct} label={meta.heading} />
          <Steps items={stepItems} current={meta.current} />
        </div>
        <div className="split">
          <div className="stack gap-4">
            {step === 3 ? (
              <>
                <section className="card">
                  <CardHead title="Where we send your payouts" sub="Step 4 of 6 · Payouts go only to an account in the name of your business or its owner." />
                  <div className="card-body">
                    {summary}
                    <PayoutFields {...props} />
                  </div>
                </section>
                <section className="card">
                  <CardHead as="h3" title="Return address" sub="Step 5 of 6 · Customers ship returns here." />
                  <div className="card-body">
                    <ReturnFields {...props} />
                  </div>
                  {foot}
                </section>
              </>
            ) : (
              <section className="card">
                {step === 0 && <CardHead title="Create your seller account" sub="Step 1 of 6 · This is how you sign in to Seller Center and how we contact you." />}
                {step === 1 && <CardHead title="Tell us about your business" sub="Step 2 of 6 · Customers see your store name. Legal details stay private." />}
                {step === 2 && <CardHead title="Verify your business" sub="Step 3 of 6 · We use this to confirm who you are. It isn't shown to customers." />}
                {step === 4 && <CardHead title="Review and accept" sub="Step 6 of 6 · Read each document. You can download copies." />}
                <div className="card-body">
                  {summary}
                  {step === 0 && <AccountStep {...props} />}
                  {step === 1 && <BusinessStep {...props} />}
                  {step === 2 && <VerificationStep {...props} />}
                  {step === 4 && <AgreementStep {...props} />}
                </div>
                {foot}
              </section>
            )}
          </div>
          <aside className="sticky-aside stack gap-4">
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h3 className="h4">Help with this step</h3>
                </div>
              </div>
              <div className="card-body">
                <ul className="ul small sub stack gap-2">
                  {meta.help.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              </div>
            </section>
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h3 className="h4">What you'll need</h3>
                </div>
              </div>
              <div className="card-body">
                <ul className="stack gap-2 small">
                  {CHECKLIST.map((c) => {
                    const done = step >= c.doneFrom;
                    const icon: IconName = done ? 'circle-check' : 'circle';
                    return (
                      <li key={c.label} className="row gap-2 nowrap">
                        <Icon name={icon} className="ic-sm" />
                        <span className={done ? '' : 'sub'}>
                          {c.label}
                          {done && <span className="sr-only"> (done)</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
            <div className="card pad stack gap-1">
              <span className="small strong">Talk to our seller team</span>
              <span className="xs muted">sellers@marketly.example · 1-800-555-0177, Mon–Fri 8 AM–5 PM PT</span>
            </div>
          </aside>
        </div>
      </div>
    </StoreLayout>
  );
}
