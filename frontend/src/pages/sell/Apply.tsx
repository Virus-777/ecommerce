import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError, call, errorMessage, useApi, useUploads, type UploadItem } from '@marketly/web-shared/api';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Checkbox, EmptyState, Field, FileDrop, Icon, IconButton, KeyValue, Meter, OptionCard, Select, Steps, TextInput, type IconName } from '@marketly/web-shared/ui';
import { dayDateYear, timePT } from '../help/data/format';
import { ApiLink } from '../help/data/links';
import { LoadError, Loading, SkLines } from '../help/data/states';
import { UploadList } from '../help/data/UploadList';
import { APPLICATION_KEY, displayPhone, e164, formatAddress, sections, stateName, US_STATES, useApplication, type SellerApplication } from './data/application';
import { contactLine, useSellerProgram } from './data/program';

// Design: pages/store/sell-apply.html (step 1, account) · views business-details, verification,
// payout-and-return-address (steps 4–5 on one page) and agreement. Each step validates, then saves:
//   step 1  POST /api/store/sellers/applications (first time, with the invitation code: invite-only launch)
//           or PATCH …/applications/{id} { step: account }
//   step 2  PATCH { step: business }
//   step 3  PATCH { step: verification } (when there is something new to save), then the documents:
//           upload (purpose verification_document) → POST …/{id}/documents { mediaId, kind, ownerId? };
//           DELETE …/{id}/documents/{documentId} removes one
//   step 4–5 PATCH { step: payout } and PATCH { step: return_address }
//   step 6  POST …/{id}/submit { acceptances: [{ key, versionLabel }], signedName } → sell/status
// GET …/applications/current fills the form, progress, checklist and agreements. The applicant must be signed
// in: the sellers API has no in-flow creation of a separate seller login, so "Create a new seller login" is
// shown disabled with an explanation. A submitted application goes to sell/status.

type View = '' | 'business-details' | 'verification' | 'payout-and-return-address' | 'agreement';
const VIEWS: View[] = ['', 'business-details', 'verification', 'payout-and-return-address', 'agreement'];
const STEP_NAMES = ['Account', 'Business', 'Verification', 'Payout', 'Return address', 'Agreement'];
/** API currentStep → view. */
const STEP_VIEW: Record<string, View> = { account: '', business: 'business-details', verification: 'verification', payout: 'payout-and-return-address', return_address: 'payout-and-return-address', agreement: 'agreement' };

interface StepMeta {
  current: number;
  heading: string;
  help: string[];
  next: string;
}

// Help copy per step (static guidance from the design).
const META: StepMeta[] = [
  {
    current: 0,
    heading: 'Step 1 of 6: Account',
    next: 'Save and continue',
    help: ['Use an email your team checks every day. Order and payout notices go there.', 'If you use your shopping account, your purchases stay private from seller staff you add later.', 'You can add seller staff with their own logins after approval.'],
  },
  { current: 1, heading: 'Step 2 of 6: Business', next: 'Continue to verification', help: ['Use the exact legal name on your registration.', "Your store name can differ, but can't use a brand you don't own.", 'Pick every category you plan to sell in. Some need extra approval.'] },
  {
    current: 2,
    heading: 'Step 3 of 6: Verification',
    next: 'Continue to payout',
    help: ['Your registration record is available from your state’s business registry.', 'Upload the whole page. Cropped screenshots are the most common reason we ask again.', 'Your ID is checked by our verification partner and deleted after the review period.'],
  },
  {
    current: 3,
    heading: 'Steps 4–5 of 6: Payout and return address',
    next: 'Continue to agreement',
    help: ['Find the routing and account numbers on a check or in your online banking.', 'We never ask for your online banking password.', 'If returns go to a warehouse, use its street address and a contact who can sign for packages.'],
  },
  { current: 5, heading: 'Step 6 of 6: Agreement', next: 'Accept and submit application', help: ['Rates marked as examples are confirmed in your approval email.', "Approval doesn't publish products. Each product or offer is reviewed before it goes live."] },
];

const BTYPES: Array<{ value: 'llc' | 'corporation' | 'partnership'; label: string }> = [
  { value: 'llc', label: 'LLC' },
  { value: 'corporation', label: 'Corporation' },
  { value: 'partnership', label: 'Partnership' },
];
const COUNTS: Array<{ value: '1_20' | '21_100' | '101_500' | 'over_500'; label: string }> = [
  { value: '1_20', label: '1–20' },
  { value: '21_100', label: '21–100' },
  { value: '101_500', label: '101–500' },
  { value: 'over_500', label: 'More than 500' },
];
const BKINDS: Array<{ value: 'business_checking' | 'business_savings' | 'personal_checking'; label: string }> = [
  { value: 'business_checking', label: 'Business checking' },
  { value: 'business_savings', label: 'Business savings' },
  { value: 'personal_checking', label: 'Personal checking' },
];

interface Form {
  acct: 'existing' | 'new';
  contact: string;
  cphone: string;
  cemail: string;
  invite: string;
  store: string;
  stype: 'biz' | 'ind';
  tips: boolean;
  legal: string;
  btype: 'llc' | 'corporation' | 'partnership';
  state: string;
  addr: string;
  phone: string;
  web: string;
  cats: string[];
  count: '1_20' | '21_100' | '101_500' | 'over_500';
  ein: string;
  w9: 'online' | 'uploaded';
  bname: string;
  bkind: 'business_checking' | 'business_savings' | 'personal_checking';
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
  agreed: Record<string, boolean>;
  sign: string;
}

const EMPTY: Form = {
  acct: 'existing', contact: '', cphone: '', cemail: '', invite: '', store: '', stype: 'biz', tips: false,
  legal: '', btype: 'llc', state: 'OR', addr: '', phone: '', web: '', cats: [], count: '1_20',
  ein: '', w9: 'online', bname: '', bkind: 'business_checking', brout: '', bacct: '', bacct2: '',
  rsame: true, rname: '', rphone: '', rline1: '', rcity: '', rstate: '', rzip: '', agreed: {}, sign: '',
};

type Errors = Partial<Record<keyof Form | 'idDoc' | 'regDoc' | 'w9Doc', string>>;

/** "3315 SE Division St, Portland, OR 97202" → street, city, state code, ZIP (null when it doesn't parse). */
function splitAddress(a: string) {
  const parts = a.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const m = parts[parts.length - 1].match(/^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
  if (!m) return null;
  return { line1: parts.slice(0, parts.length - 2).join(', '), city: parts[parts.length - 2], region: m[1].toUpperCase(), postalCode: m[2] };
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

interface Docs {
  idDoc: ReturnType<typeof useUploads>;
  regDoc: ReturnType<typeof useUploads>;
  w9Doc: ReturnType<typeof useUploads>;
}

interface StepProps {
  f: Form;
  set: <K extends keyof Form>(k: K, v: Form[K]) => void;
  e: Errors;
  app: SellerApplication | null;
}

function AccountStep({ f, set, e, app, email, inviteNeeded }: StepProps & { email: string; inviteNeeded: boolean }) {
  return (
    <>
      <div className="buy-opts c2">
        <OptionCard id="ap-acct-existing" name="ap-acct" checked={f.acct === 'existing'} onChange={() => set('acct', 'existing')} title={<span className="small strong">Use my Marketly account</span>} body="Seller access is added to the account you're signed in with." right={<Icon name="user-round" />} />
        <OptionCard id="ap-acct-new" name="ap-acct" disabled title={<span className="small strong">Create a new seller login</span>} body="To use a separate business login, sign out, create a Marketly account with your business email and apply from it." right={<Icon name="user-plus" />} />
      </div>
      {!app && (
        <Field label="Invitation code" optional={!inviteNeeded} hint={inviteNeeded ? 'Applications are invite-only during our launch. Enter the code from your invitation email.' : 'If you were invited, enter the code from your invitation email.'} error={e.invite}>
          <TextInput id="ap-invite" value={f.invite} error={!!e.invite} autoComplete="off" onChange={(ev) => set('invite', ev.target.value.toUpperCase())} />
        </Field>
      )}
      <div className="grid md2">
        <Field label="Contact person" hint="The person we contact about this application." error={e.contact}>
          <TextInput id="ap-contact" value={f.contact} error={!!e.contact} onChange={(ev) => set('contact', ev.target.value)} autoComplete="name" />
        </Field>
        <Field label="Phone" error={e.cphone}>
          <TextInput id="ap-cphone" type="tel" value={f.cphone} error={!!e.cphone} onChange={(ev) => set('cphone', ev.target.value)} autoComplete="tel" />
        </Field>
      </div>
      <div className="panel row gap-3">
        <Icon name="user-round" />
        <span className="small grow">Seller access is added to {email}. You sign in to Seller Center with the same password.</span>
      </div>
      <Field label="Work email" hint="Order, payout and application notices go here." error={e.cemail}>
        <TextInput id="ap-cemail" type="email" value={f.cemail} error={!!e.cemail} onChange={(ev) => set('cemail', ev.target.value)} autoComplete="email" />
      </Field>
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
        <Select id="ap-market" options={[{ value: 'US', label: 'United States (USD)' }]} value="US" onChange={() => undefined} />
      </Field>
      <Checkbox id="ap-ctips" label="Email me tips for new sellers. Application and account notices are always sent." checked={f.tips} onChange={(ev) => set('tips', ev.target.checked)} />
    </>
  );
}

function BusinessStep({ f, set, e, categories }: StepProps & { categories: Array<{ id: string; name: string; needsExtraApproval: boolean }> }) {
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
          {f.stype === 'biz' ? (
            <Select id="ap-btype" options={BTYPES} value={f.btype} onChange={(ev) => set('btype', ev.target.value as Form['btype'])} />
          ) : (
            <Select id="ap-btype" options={[{ value: 'sole_proprietor', label: 'Sole proprietor' }]} value="sole_proprietor" onChange={() => undefined} />
          )}
        </Field>
        <Field label="State of registration">
          <Select id="ap-state" options={US_STATES.map(([value, label]) => ({ value, label }))} value={f.state} onChange={(ev) => set('state', ev.target.value)} />
        </Field>
      </div>
      <Field label="Business address" hint="Street, city, state ZIP, for example 410 Pine St, Portland, OR 97204." error={e.addr}>
        <TextInput id="ap-addr" value={f.addr} error={!!e.addr} onChange={(ev) => set('addr', ev.target.value)} autoComplete="street-address" />
      </Field>
      <div className="grid md2">
        <Field label="Business phone" error={e.phone}>
          <TextInput id="ap-phone" type="tel" value={f.phone} error={!!e.phone} onChange={(ev) => set('phone', ev.target.value)} />
        </Field>
        <Field label="Website" optional error={e.web}>
          <TextInput id="ap-web" value={f.web} error={!!e.web} onChange={(ev) => set('web', ev.target.value)} />
        </Field>
      </div>
      <fieldset className="stack gap-2 fieldset-reset" aria-invalid={!!e.cats || undefined}>
        <legend className="label u-mb-sp-2">What will you sell?</legend>
        <div className="grid m2 md4 gap-2">
          {categories.map((c) => (
            <Checkbox key={c.id} id={`ap-cat-${c.id}`} label={c.needsExtraApproval ? `${c.name} (extra approval)` : c.name} checked={f.cats.includes(c.id)} onChange={() => toggleCat(c.id)} />
          ))}
        </div>
        <ErrorText>{e.cats}</ErrorText>
      </fieldset>
      <Field label="How many products do you plan to list?">
        <Select id="ap-count" options={COUNTS} value={f.count} onChange={(ev) => set('count', ev.target.value as Form['count'])} />
      </Field>
    </>
  );
}

type AppDoc = SellerApplication['documents'][number];

function DocField({ label, docs, uploads, onRemove, removing, error, title, hint, multiple = false }: { label: string; docs: AppDoc[]; uploads: ReturnType<typeof useUploads>; onRemove: (d: AppDoc) => void; removing: string | null; error?: string; title: string; hint: string; multiple?: boolean }) {
  const full = !multiple && docs.length + uploads.items.length > 0;
  return (
    <div className="field">
      <span className="label">{label}</span>
      {docs.map((d) => (
        <div key={d.id} className="panel row gap-3">
          <Icon name="file-check" />
          <span className="small grow">{d.fileName}</span>
          {d.status === 'rejected' ? (
            <Badge tone="danger">Rejected</Badge>
          ) : (
            <Badge tone="success" icon="check">
              {d.status === 'accepted' ? 'Accepted' : 'Uploaded'}
            </Badge>
          )}
          <IconButton icon="x" size="sm" label={`Remove ${d.fileName}`} onClick={() => onRemove(d)} disabled={removing === d.id} />
        </div>
      ))}
      <UploadList uploads={uploads} icon="file-check" />
      {!full && <FileDrop title={title} hint={hint} accept="application/pdf,image/jpeg,image/png" multiple={multiple} onFiles={uploads.add} />}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function VerificationStep({ f, set, e, app, docs, onRemove, removing }: StepProps & { docs: Docs; onRemove: (d: AppDoc) => void; removing: string | null }) {
  const v = sections(app).verification;
  const owner = v?.owners?.find((o) => o.isPrimary) ?? v?.owners?.[0];
  const ofKind = (k: AppDoc['kind']) => (app?.documents ?? []).filter((d) => d.kind === k);
  const city = sections(app).business?.address;
  return (
    <>
      <div className="stack gap-2">
        <span className="label">Business owner</span>
        <div className="panel row gap-3">
          <Avatar name={owner?.name || f.contact || ' '} />
          <span className="stack gap-0 grow">
            <span className="small strong">{owner?.name || f.contact}</span>
            <span className="xs muted">
              Owner · {owner?.ownershipPct ?? 100}% ownership{city?.city ? ` · ${city.city}, ${city.region}` : ''}
            </span>
          </span>
          {owner?.verificationState === 'verified' && <Badge tone="info">Verified</Badge>}
        </div>
      </div>
      <DocField label="Government photo ID" docs={ofKind('owner_id')} uploads={docs.idDoc} onRemove={onRemove} removing={removing} error={e.idDoc} title="Upload the front and back of your ID" hint="PDF, JPG or PNG up to 10 MB each." multiple />
      {f.stype === 'biz' && (
        <DocField
          label="Business registration document"
          docs={ofKind('business_registration')}
          uploads={docs.regDoc}
          onRemove={onRemove}
          removing={removing}
          error={e.regDoc}
          title={`Upload your ${stateName(f.state)} registration record`}
          hint="PDF, JPG or PNG up to 10 MB. Must show the legal name, registry number and status."
        />
      )}
      <div className="grid md2">
        <Field label={f.stype === 'biz' ? 'Tax ID (EIN)' : 'Tax ID (EIN or SSN)'} hint={v?.taxIdLast4 ? `On file: •••• ${v.taxIdLast4}. Enter it again only to change it.` : 'Matches the name on your W-9.'} error={e.ein}>
          <TextInput id="ap-ein" value={f.ein} error={!!e.ein} autoComplete="off" onChange={(ev) => set('ein', ev.target.value)} />
        </Field>
        <Field label="W-9 form">
          <Select
            id="ap-w9"
            options={[
              { value: 'online', label: 'Fill in online' },
              { value: 'uploaded', label: 'Upload a signed PDF' },
            ]}
            value={f.w9}
            onChange={(ev) => set('w9', ev.target.value as Form['w9'])}
          />
        </Field>
      </div>
      {f.w9 === 'uploaded' && <DocField label="Signed W-9" docs={ofKind('tax_form')} uploads={docs.w9Doc} onRemove={onRemove} removing={removing} error={e.w9Doc} title="Upload your signed W-9" hint="PDF up to 10 MB." />}
      <Alert tone="info" title="Some applications get an extra check">
        Our Trust and Risk team reviews some applications, for example for high-value electronics. This can add up to 2 business days. We'll tell you if it applies.
      </Alert>
    </>
  );
}

function PayoutFields({ f, set, e, app, schedule }: StepProps & { schedule: string }) {
  const onFile = app?.payout;
  return (
    <>
      {onFile && (
        <div className="panel row gap-3">
          <Icon name="landmark" />
          <span className="small grow">
            On file: {onFile.label} · {onFile.accountHolderName}. Enter new details only to change it.
          </span>
        </div>
      )}
      <Field label="Account holder name" hint="Must match your legal business name or the owner's name." error={e.bname}>
        <TextInput id="ap-bname" value={f.bname} error={!!e.bname} onChange={(ev) => set('bname', ev.target.value)} />
      </Field>
      <Field label="Account type">
        <Select id="ap-bkind" options={BKINDS} value={f.bkind} onChange={(ev) => set('bkind', ev.target.value as Form['bkind'])} />
      </Field>
      <div className="grid md2">
        <Field label="Routing number" error={e.brout}>
          <TextInput id="ap-brout" value={f.brout} placeholder="9 digits" inputMode="numeric" autoComplete="off" error={!!e.brout} onChange={(ev) => set('brout', ev.target.value)} />
        </Field>
        <Field label="Account number" error={e.bacct}>
          <TextInput id="ap-bacct" value={f.bacct} placeholder="Account number" inputMode="numeric" autoComplete="off" error={!!e.bacct} onChange={(ev) => set('bacct', ev.target.value)} />
        </Field>
      </div>
      <Field label="Confirm account number" error={e.bacct2}>
        <TextInput id="ap-bacct2" value={f.bacct2} placeholder="Enter it again" inputMode="numeric" autoComplete="off" error={!!e.bacct2} onChange={(ev) => set('bacct2', ev.target.value)} />
      </Field>
      <Alert tone="info" title="How we verify your bank account">
        After approval we send 2 small deposits to this account. Confirm the amounts in Seller Center to turn on payouts. Changing this account later needs a new check and a review.
      </Alert>
      {schedule && (
        <div className="panel stack gap-1">
          <span className="small strong">Payout schedule</span>
          <span className="xs sub">{schedule}</span>
        </div>
      )}
    </>
  );
}

function ReturnFields({ f, set, e }: StepProps) {
  const biz = splitAddress(f.addr);
  const ro = f.rsame;
  return (
    <>
      <Checkbox id="ap-rsame" label={`Same as business address: ${f.addr}`} checked={f.rsame} onChange={(ev) => set('rsame', ev.target.checked)} />
      <div className="grid md2">
        <Field label="Contact name" error={e.rname}>
          <TextInput id="ap-rname" value={f.rname} error={!!e.rname} onChange={(ev) => set('rname', ev.target.value)} />
        </Field>
        <Field label="Phone" error={e.rphone}>
          <TextInput id="ap-rphone" type="tel" value={f.rphone} error={!!e.rphone} onChange={(ev) => set('rphone', ev.target.value)} />
        </Field>
      </div>
      <Field label="Street address" hint="Must be a street address. Carriers can't deliver returns to PO boxes." error={e.rline1}>
        <TextInput id="ap-rline1" value={ro ? (biz?.line1 ?? '') : f.rline1} readOnly={ro} error={!!e.rline1} onChange={(ev) => set('rline1', ev.target.value)} />
      </Field>
      <div className="grid md3">
        <Field label="City" error={e.rcity}>
          <TextInput id="ap-rcity" value={ro ? (biz?.city ?? '') : f.rcity} readOnly={ro} error={!!e.rcity} onChange={(ev) => set('rcity', ev.target.value)} />
        </Field>
        <Field label="State" error={e.rstate}>
          {ro ? (
            <TextInput id="ap-rstate" value={stateName(biz?.region)} readOnly />
          ) : (
            <Select id="ap-rstate" options={[{ value: '', label: 'Choose a state' }, ...US_STATES.map(([value, label]) => ({ value, label }))]} value={f.rstate} onChange={(ev) => set('rstate', ev.target.value)} />
          )}
        </Field>
        <Field label="ZIP code" error={e.rzip}>
          <TextInput id="ap-rzip" value={ro ? (biz?.postalCode ?? '') : f.rzip} readOnly={ro} inputMode="numeric" error={!!e.rzip} onChange={(ev) => set('rzip', ev.target.value)} />
        </Field>
      </div>
      <div className="buy-note t-info">
        <Icon name="undo-2" />
        <span>Customers ship returns to this address. It is printed on return labels and shown to customers who return your items.</span>
      </div>
    </>
  );
}

function AgreementStep({ f, set, e, app, agreements }: StepProps & { agreements: Array<{ key: string; title: string; summary: string; versionLabel: string; url: string | null; isExample?: boolean }> }) {
  const s = sections(app);
  const docs = app?.documents ?? [];
  const ret = s.returnAddress?.sameAsBusiness ? formatAddress(s.business?.address) : formatAddress(s.returnAddress?.address);
  return (
    <>
      <div className="buy-agree" aria-invalid={!!e.agreed || undefined}>
        {agreements.map((a) => (
          <div key={a.key}>
            <input type="checkbox" id={`ap-ag-${a.key}`} className="check-input" checked={Boolean(f.agreed[a.key])} onChange={(ev) => set('agreed', { ...f.agreed, [a.key]: ev.target.checked })} />
            <label className="stack gap-0 grow" htmlFor={`ap-ag-${a.key}`}>
              <span className="small strong">I accept the {a.title}</span>
              <span className="xs muted">{a.summary}</span>
            </label>
            {a.url ? (
              <ApiLink url={a.url} className="small strong nowrap">
                <Icon name="file-text" className="ic-sm" /> Read · {a.isExample ? 'Example rates' : a.versionLabel}
              </ApiLink>
            ) : (
              <span className="small muted nowrap">{a.versionLabel}</span>
            )}
          </div>
        ))}
      </div>
      <ErrorText>{e.agreed}</ErrorText>
      <Field label="Type your full name to sign" hint={`Signing as owner of ${s.business?.legalName || f.legal || 'your business'} on ${dayDateYear(new Date().toISOString())}.`} error={e.sign}>
        <TextInput id="ap-sign" value={f.sign} error={!!e.sign} onChange={(ev) => set('sign', ev.target.value)} />
      </Field>
      <div className="panel stack gap-2">
        <span className="small strong">Application summary</span>
        <KeyValue
          pairs={[
            ['Account', s.account?.workEmail ?? f.cemail],
            ['Business', [s.business?.legalName, stateName(s.business?.stateOfRegistration)].filter(Boolean).join(' · ') || '–'],
            ['Verification', [docs.some((d) => d.kind === 'owner_id') && 'ID', docs.some((d) => d.kind === 'business_registration') && 'registration'].filter(Boolean).join(' and ').replace(/^./, (c) => c.toUpperCase()) + (docs.length ? ' uploaded' : '') || 'Not done yet'],
            ['Payout', app?.payout?.label ?? 'Not added yet'],
            ['Return address', ret || 'Not added yet'],
          ]}
        />
      </div>
      <p className="xs muted">After you submit, a Seller Manager reviews your application. We email you if we need anything.</p>
    </>
  );
}

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

const MISSING_STEP: Record<string, string> = { account: 'Account', business: 'Business', verification: 'Verification', payout: 'Payout', return_address: 'Return address', agreement: 'Agreement' };

export default function Apply() {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { signedIn, ready, customer } = useSession();
  const [view, setView] = useView<Exclude<View, ''>>();
  const step = Math.max(0, VIEWS.indexOf(view as View));
  const meta = META[step];
  const appQ = useApplication();
  const program = useSellerProgram();
  const app = appQ.data ?? null;
  const [f, setF] = useState<Form>(EMPTY);
  const [tried, setTried] = useState<boolean[]>([false, false, false, false, false]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));
  const docs: Docs = {
    idDoc: useUploads('verification_document', { max: 2, accept: /\.(pdf|jpe?g|png)$/i }),
    regDoc: useUploads('verification_document', { max: 1, accept: /\.(pdf|jpe?g|png)$/i }),
    w9Doc: useUploads('verification_document', { max: 1, accept: /\.pdf$/i }),
  };
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState('');

  // Fill the form once from the saved application (or the customer's profile for a new one).
  const filled = useRef('');
  useEffect(() => {
    const key = app ? app.id : customer ? `new:${customer.id}` : '';
    if (!key || filled.current === key || appQ.isPending) return;
    filled.current = key;
    const s = sections(app);
    const a = s.account;
    const b = s.business;
    const v = s.verification;
    const r = s.returnAddress;
    setF((cur) => ({
      ...cur,
      contact: a?.contactName ?? customer?.name ?? '',
      cphone: displayPhone(a?.contactPhone ?? customer?.phone ?? ''),
      cemail: a?.workEmail ?? customer?.email ?? '',
      store: b?.storeName ?? a?.storeName ?? '',
      stype: (b?.kind ? b.kind === 'individual' : a?.sellerType === 'individual') ? 'ind' : 'biz',
      tips: Boolean(a?.tipsOptIn),
      legal: b?.legalName ?? '',
      btype: b?.businessType && b.businessType !== 'sole_proprietor' ? b.businessType : 'llc',
      state: b?.stateOfRegistration ?? 'OR',
      addr: formatAddress(b?.address),
      phone: displayPhone(b?.phone ?? ''),
      web: b?.website ?? '',
      cats: b?.categoryIds ?? [],
      count: b?.plannedProductCount ?? '1_20',
      w9: v?.w9Method ?? 'online',
      bname: app?.payout?.accountHolderName ?? b?.legalName ?? '',
      rsame: r?.sameAsBusiness ?? true,
      rname: r?.contactName ?? a?.contactName ?? customer?.name ?? '',
      rphone: displayPhone(r?.phone ?? a?.contactPhone ?? ''),
      rline1: r?.address?.line1 ?? '',
      rcity: r?.address?.city ?? '',
      rstate: r?.address?.region ?? '',
      rzip: r?.address?.postalCode ?? '',
      agreed: Object.fromEntries((app?.agreementsAccepted ?? []).map((x) => [(x as { key: string }).key, true])),
    }));
    // A returning applicant lands on the step they reached.
    if (app && !view && app.completedSteps.includes('account')) setView(STEP_VIEW[app.currentStep] as Exclude<View, ''>, { replace: true });
  }, [app, customer, appQ.isPending, view, setView]);

  const p = program.data;
  const inviteNeeded = p ? !p.applicationsOpen : true;
  const s = sections(app);
  const ofKind = (k: string) => (app?.documents ?? []).filter((d) => d.kind === k);

  const validate = (st: number): Errors => {
    const e: Errors = {};
    const req = (k: keyof Form, msg: string) => {
      if (!String(f[k]).trim()) e[k] = msg;
    };
    if (st === 0) {
      if (!app && inviteNeeded && !f.invite.trim()) e.invite = 'Enter the invitation code from your email.';
      req('contact', 'Enter the contact person.');
      if (f.cphone.replace(/\D/g, '').length < 10) e.cphone = 'Enter a 10-digit US phone number.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.cemail.trim())) e.cemail = 'Enter an email address, like name@business.com.';
      req('store', 'Enter the store name customers will see.');
    }
    if (st === 1) {
      req('legal', f.stype === 'biz' ? 'Enter the legal name on your registration.' : 'Enter your full legal name.');
      req('store', 'Enter the store name customers will see.');
      if (!f.addr.trim()) e.addr = 'Enter the business address.';
      else if (!splitAddress(f.addr)) e.addr = 'Enter the address as street, city, state ZIP, for example 410 Pine St, Portland, OR 97204.';
      if (f.phone.replace(/\D/g, '').length < 10) e.phone = 'Enter a 10-digit US phone number.';
      if (!f.cats.length) e.cats = 'Pick at least one category.';
    }
    if (st === 2) {
      const ready = (u: ReturnType<typeof useUploads>) => u.items.some((i) => i.status === 'ready');
      if (!ofKind('owner_id').length && !ready(docs.idDoc)) e.idDoc = 'Upload a photo of your government ID.';
      if (f.stype === 'biz' && !ofKind('business_registration').length && !ready(docs.regDoc)) e.regDoc = 'Upload your registration record to continue.';
      if (f.w9 === 'uploaded' && !ofKind('tax_form').length && !ready(docs.w9Doc)) e.w9Doc = 'Upload your signed W-9.';
      for (const [k, u] of [['idDoc', docs.idDoc], ['regDoc', docs.regDoc], ['w9Doc', docs.w9Doc]] as const) {
        if (u.uploading) e[k] = 'Wait for the upload to finish.';
        else if (u.failed) e[k] = 'Remove the file that failed to upload, or add it again.';
      }
      const needTax = !s.verification?.taxIdLast4 || f.ein.trim() !== '';
      if (needTax && (f.stype === 'biz' ? !/^\d{2}-?\d{7}$/.test(f.ein.trim()) : !/^(\d{2}-?\d{7}|\d{3}-?\d{2}-?\d{4})$/.test(f.ein.trim()))) e.ein = f.stype === 'biz' ? 'Enter a 9-digit EIN, like 12-3456789.' : 'Enter a 9-digit EIN or SSN.';
    }
    if (st === 3) {
      const newPayout = !app?.payout || [f.brout, f.bacct, f.bacct2].some((x) => x.trim());
      if (newPayout) {
        req('bname', 'Enter the account holder name.');
        if (!/^\d{9}$/.test(f.brout.trim())) e.brout = 'Enter the 9-digit routing number.';
        if (!/^\d{4,17}$/.test(f.bacct.trim())) e.bacct = 'Enter the account number (4 to 17 digits).';
        else if (f.bacct2.trim() !== f.bacct.trim()) e.bacct2 = "The account numbers don't match.";
      }
      req('rname', 'Enter a contact name for returns.');
      if (f.rphone.replace(/\D/g, '').length < 10) e.rphone = 'Enter a 10-digit US phone number.';
      if (f.rsame && !splitAddress(f.addr)) e.rline1 = 'Your business address is incomplete: add the return address here instead.';
      if (!f.rsame) {
        if (!f.rline1.trim()) e.rline1 = 'Enter a street address.';
        else if (/\bp\.?\s*o\.?\s*box\b/i.test(f.rline1)) e.rline1 = "Use a street address. Carriers can't deliver returns to PO boxes.";
        req('rcity', 'Enter a city.');
        req('rstate', 'Choose a state.');
        if (!/^\d{5}$/.test(f.rzip.trim())) e.rzip = 'Enter a 5-digit ZIP code, like 97202.';
      }
    }
    if (st === 4) {
      const list = app?.agreementsRequired ?? [];
      if (!list.length || !list.every((a) => f.agreed[a.key])) e.agreed = `Accept all ${list.length || 'the'} documents to submit your application.`;
      if (f.sign.trim().toLowerCase() !== (s.account?.contactName ?? f.contact).trim().toLowerCase()) e.sign = `Type your full name exactly: ${(s.account?.contactName ?? f.contact).trim() || 'the contact person'}.`;
    }
    return e;
  };

  const accountBody = () => ({
    accountMode: 'existing_member' as const,
    contactName: f.contact.trim(),
    contactPhone: e164(f.cphone),
    workEmail: f.cemail.trim(),
    storeName: f.store.trim(),
    sellerType: f.stype === 'biz' ? ('business' as const) : ('individual' as const),
    market: 'US',
    tipsOptIn: f.tips,
  });

  const patch = (id: string, body: Record<string, unknown>) =>
    call(api.PATCH('/api/store/sellers/applications/{id}', { params: { path: { id } }, body: body as never })) as Promise<SellerApplication>;

  const save = useMutation({
    mutationFn: async (st: number): Promise<SellerApplication> => {
      if (st === 0) {
        if (!app) return call(api.POST('/api/store/sellers/applications', { body: { ...accountBody(), invitationCode: f.invite.trim() || undefined } }));
        return patch(app.id, { step: 'account', account: accountBody() });
      }
      const id = app!.id;
      if (st === 1) {
        const a = splitAddress(f.addr)!;
        return patch(id, {
          step: 'business',
          business: {
            kind: f.stype === 'biz' ? 'registered_business' : 'individual',
            legalName: f.legal.trim(),
            storeName: f.store.trim(),
            businessType: f.stype === 'biz' ? f.btype : 'sole_proprietor',
            stateOfRegistration: f.state,
            address: { name: f.legal.trim(), ...a, country: 'US' },
            phone: e164(f.phone),
            website: f.web.trim() || undefined,
            categoryIds: f.cats,
            plannedProductCount: f.count,
          },
        });
      }
      if (st === 2) {
        let cur: SellerApplication = app!;
        const v = sections(cur).verification;
        if (!v?.taxIdLast4 || f.ein.trim()) {
          const owners = v?.owners?.length ? v.owners.map((o) => ({ name: o.name, ownershipPct: o.ownershipPct, isPrimary: o.isPrimary, idDocumentIds: [] })) : [{ name: (s.account?.contactName ?? f.contact).trim(), ownershipPct: 100, isPrimary: true, idDocumentIds: [] }];
          const taxId = f.ein.trim();
          cur = await patch(id, { step: 'verification', verification: { owners, taxIdType: /^\d{3}-?\d{2}-?\d{4}$/.test(taxId) ? 'ssn' : 'ein', taxId, w9Method: f.w9 } });
        }
        const ownerId = (sections(cur).verification?.owners ?? []).find((o) => o.isPrimary)?.id ?? sections(cur).verification?.owners?.[0]?.id;
        const attach = async (items: UploadItem[], kind: 'owner_id' | 'business_registration' | 'tax_form') => {
          for (const it of items.filter((i) => i.status === 'ready')) {
            await call(api.POST('/api/store/sellers/applications/{id}/documents', { params: { path: { id } }, body: { mediaId: it.assetId!, kind, ...(kind === 'owner_id' && ownerId ? { ownerId } : {}) } }));
          }
        };
        await attach(docs.idDoc.items, 'owner_id');
        if (f.stype === 'biz') await attach(docs.regDoc.items, 'business_registration');
        if (f.w9 === 'uploaded') await attach(docs.w9Doc.items, 'tax_form');
        docs.idDoc.clear();
        docs.regDoc.clear();
        docs.w9Doc.clear();
        return call(api.GET('/api/store/sellers/applications/current'));
      }
      if (st === 3) {
        if (!app!.payout || [f.brout, f.bacct, f.bacct2].some((x) => x.trim())) {
          await patch(id, { step: 'payout', payout: { accountHolderName: f.bname.trim(), accountType: f.bkind, routingNumber: f.brout.trim(), accountNumber: f.bacct.trim(), confirmAccountNumber: f.bacct2.trim() } });
        }
        return patch(id, {
          step: 'return_address',
          returnAddress: f.rsame
            ? { sameAsBusiness: true, contactName: f.rname.trim(), phone: e164(f.rphone) }
            : { sameAsBusiness: false, contactName: f.rname.trim(), phone: e164(f.rphone), address: { name: f.rname.trim(), line1: f.rline1.trim(), city: f.rcity.trim(), region: f.rstate, postalCode: f.rzip.trim(), country: 'US' } },
        });
      }
      const acceptances = (app!.agreementsRequired ?? []).map((a) => ({ key: a.key, versionLabel: a.versionLabel }));
      return call(api.POST('/api/store/sellers/applications/{id}/submit', { params: { path: { id } }, body: { acceptances, signedName: f.sign.trim() } }));
    },
    onSuccess: (next, st) => {
      qc.setQueryData(APPLICATION_KEY, next);
      if (st === 3) setF((cur) => ({ ...cur, brout: '', bacct: '', bacct2: '' }));
      if (st === 2) set('ein', '');
      if (st === VIEWS.length - 1) navigate(href('sell/status'));
      else go(st + 1);
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'AGREEMENT_VERSION_OUTDATED' || e.code === 'APPLICATION_INCOMPLETE')) void appQ.refetch();
    },
  });

  const removeDoc = async (d: AppDoc) => {
    if (!app) return;
    setRemoving(d.id);
    setRemoveError('');
    try {
      await call(api.DELETE('/api/store/sellers/applications/{id}/documents/{documentId}', { params: { path: { id: app.id, documentId: d.id } } }));
      await qc.invalidateQueries({ queryKey: APPLICATION_KEY });
    } catch (e) {
      setRemoveError(errorMessage(e));
    } finally {
      setRemoving(null);
    }
  };

  const errors = tried[step] ? validate(step) : {};
  const nErrors = Object.keys(errors).length;
  const props = { f, set, e: errors, app };

  function go(i: number) {
    setView(VIEWS[i] as Exclude<View, ''>);
    window.scrollTo({ top: 0 });
  }
  const next = () => {
    setTried((t) => t.map((v, i) => (i === step ? true : v)));
    if (Object.keys(validate(step)).length) return;
    save.mutate(step);
  };

  const layout = (body: ReactNode) => (
    <StoreLayout appbar={{ title: 'Seller application', back: href('sell/landing') }} footer={false} tabbar={false}>
      <div className="container page gap-5">{body}</div>
    </StoreLayout>
  );

  if (ready && !signedIn) {
    return layout(
      <EmptyState icon="user-round" title="Sign in to apply" as="h1" action={<Button to={href('auth/sign-in', '', undefined, { next: location.pathname + location.search })}>Sign in</Button>}>
        Seller access is added to your Marketly account, so sign in (or create an account) before you start. You can save a draft and come back any time.
      </EmptyState>,
    );
  }
  if (appQ.isError) return layout(<LoadError error={appQ.error} retry={() => void appQ.refetch()} title="We couldn’t load your application" />);
  if (!appQ.isSuccess) {
    return layout(
      <>
        <Loading label="Loading your application" />
        <span className="sk sk-line h-30" aria-hidden="true" />
        <SkLines n={8} />
      </>,
    );
  }
  // Submitted, decided, withdrawn or expired applications are followed on the status page.
  if (app && app.state !== 'draft') {
    if (!['withdrawn', 'expired'].includes(app.state)) return <Navigate replace to={href('sell/status')} />;
  }
  const restart = app && ['withdrawn', 'expired'].includes(app.state);
  const appForForm = restart ? null : app;
  // Steps after the first need a saved application.
  if (!appForForm && step > 0) return <Navigate replace to={href('sell/apply')} />;

  const formProps = { ...props, app: appForForm };
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
  const pct = appForForm?.percentComplete ?? 0;
  const serverError = save.error;
  const missing = serverError instanceof ApiError && serverError.code === 'APPLICATION_INCOMPLETE' ? ((serverError.details.missing ?? appForForm?.missing ?? {}) as Record<string, string[]>) : null;
  const fieldIssues = serverError instanceof ApiError ? Object.values(serverError.fieldErrors) : [];

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
  const label = save.isPending ? (step === VIEWS.length - 1 ? 'Submitting…' : 'Saving…') : step === 0 && !appForForm ? 'Start application and continue' : meta.next;
  const primary =
    step === VIEWS.length - 1 ? (
      <Button icon="send" onClick={next} disabled={save.isPending}>
        {label}
      </Button>
    ) : (
      <Button iconRight="arrow-right" onClick={next} disabled={save.isPending}>
        {label}
      </Button>
    );
  const foot = (
    <div className="card-foot">
      {back}
      {primary}
    </div>
  );
  const summary = (
    <>
      {nErrors > 0 && (
        <Alert tone="danger" title={`Check ${nErrors} field${nErrors > 1 ? 's' : ''}`}>
          Fix the highlighted fields to continue.
        </Alert>
      )}
      {serverError && nErrors === 0 && (
        <Alert tone="danger" title={serverError instanceof ApiError && serverError.code === 'INVITATION_REQUIRED' ? 'Invitation code needed' : missing ? 'Some steps aren’t finished' : 'We couldn’t save this step'}>
          {missing ? (
            <span className="stack gap-1">
              {Object.entries(missing).map(([k, fields]) => (
                <span key={k}>
                  <Link to={href('sell/apply', STEP_VIEW[k] ?? '')} className="link-inline">
                    {MISSING_STEP[k] ?? k}
                  </Link>
                  : {fields.join(', ')}
                </span>
              ))}
            </span>
          ) : fieldIssues.length ? (
            fieldIssues.join(' ')
          ) : (
            errorMessage(serverError)
          )}
        </Alert>
      )}
      {removeError && <Alert tone="danger" title="We couldn’t remove that document">{removeError}</Alert>}
    </>
  );

  const checklist: Array<{ label: string; done: boolean }> = [
    { label: 'Business registration', done: ofKind('business_registration').length > 0 || s.business?.kind === 'individual' },
    { label: 'Tax ID (EIN or SSN)', done: Boolean(s.verification?.taxIdLast4) },
    { label: 'Owner photo ID', done: ofKind('owner_id').length > 0 },
    { label: 'Bank account for payouts', done: Boolean(appForForm?.payout) },
    { label: 'US return address', done: Boolean(appForForm?.completedSteps.includes('return_address')) },
  ];
  const agreements = appForForm?.agreementsRequired ?? p?.agreements ?? [];
  const schedule = p?.payoutTiming ? `Earnings become available ${p.payoutTiming.holdDaysAfterDelivery} days after delivery and are paid ${p.payoutTiming.schedule.toLowerCase()}; they arrive ${p.payoutTiming.arrival.replace(/^./, (c) => c.toLowerCase())}.${p.payoutTiming.isExample ? ' Example schedule; final timing is in the seller agreement.' : ''}` : '';

  return layout(
    <>
      <div className="row between">
        <div className="stack gap-1">
          <h1 className="h1">Seller application</h1>
          <span className="xs muted">
            {appForForm ? (
              <>
                <Icon name="circle-check" className="ic-sm" /> Draft saved at {timePT(appForForm.draftSavedAt)} · {s.business?.storeName || s.account?.storeName || 'Your store'}
              </>
            ) : (
              'Your draft is saved after the first step.'
            )}
          </span>
        </div>
        <Button variant="secondary" icon="save" to={href('sell/landing')}>
          {appForForm ? 'Save draft and exit' : 'Exit'}
        </Button>
      </div>
      <div className="stack gap-2">
        <div className="row between xs">
          <span className="strong">{meta.heading}</span>
          <span className="muted">{pct}% complete</span>
        </div>
        <Meter pct={pct} label={meta.heading} />
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
                  <PayoutFields {...formProps} schedule={schedule} />
                </div>
              </section>
              <section className="card">
                <CardHead as="h3" title="Return address" sub="Step 5 of 6 · Customers ship returns here." />
                <div className="card-body">
                  <ReturnFields {...formProps} />
                </div>
                {foot}
              </section>
            </>
          ) : (
            <section className="card">
              {step === 0 && <CardHead title="Your seller account" sub="Step 1 of 6 · This is how you sign in to Seller Center and how we contact you." />}
              {step === 1 && <CardHead title="Tell us about your business" sub="Step 2 of 6 · Customers see your store name. Legal details stay private." />}
              {step === 2 && <CardHead title="Verify your business" sub="Step 3 of 6 · We use this to confirm who you are. It isn't shown to customers." />}
              {step === 4 && <CardHead title="Review and accept" sub="Step 6 of 6 · Read each document before you accept it." />}
              <div className="card-body">
                {summary}
                {step === 0 && <AccountStep {...formProps} email={customer?.email ?? ''} inviteNeeded={inviteNeeded} />}
                {step === 1 && <BusinessStep {...formProps} categories={p?.launchCategories ?? []} />}
                {step === 2 && <VerificationStep {...formProps} docs={docs} onRemove={removeDoc} removing={removing} />}
                {step === 4 && <AgreementStep {...formProps} agreements={agreements} />}
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
                {checklist.map((c) => {
                  const icon: IconName = c.done ? 'circle-check' : 'circle';
                  return (
                    <li key={c.label} className="row gap-2 nowrap">
                      <Icon name={icon} className="ic-sm" />
                      <span className={cx(!c.done && 'sub')}>
                        {c.label}
                        {c.done && <span className="sr-only"> (done)</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
          {p?.contact && (
            <div className="card pad stack gap-1">
              <span className="small strong">Talk to our seller team</span>
              <span className="xs muted">{contactLine(p.contact)}</span>
            </div>
          )}
        </aside>
      </div>
    </>,
  );
}
