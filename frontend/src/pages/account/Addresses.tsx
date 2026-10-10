import { useState } from 'react';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Badge, Button, Checkbox, Dialog, Field, Icon, Select, Textarea, TextInput, type IconName } from '@/ui';

// Design: pages/store/account-addresses.html · view "edit-address" = the edit dialog with a ZIP error.

interface Address {
  id: string;
  label: string;
  icon: IconName;
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  note: string;
  isDefault: boolean;
}

const INITIAL: Address[] = [
  { id: 'a1', label: 'Home', icon: 'house', name: 'Jordan Lee', line1: '2140 Alder St', line2: 'Apt 5', city: 'Portland', state: 'Oregon', zip: '97205', phone: '(503) 555-0148', note: '', isDefault: true },
  { id: 'a2', label: 'Work', icon: 'building-2', name: 'Jordan Lee', line1: '815 SW 2nd Ave', line2: 'Floor 4', city: 'Portland', state: 'Oregon', zip: '97204', phone: '(503) 555-0199', note: 'Front desk on the ground floor accepts packages.', isDefault: false },
];

const STATES = ['Oregon', 'Washington', 'California', 'Idaho', 'Nevada'];
const STATE_CODE: Record<string, string> = { Oregon: 'OR', Washington: 'WA', California: 'CA', Idaho: 'ID', Nevada: 'NV' };
const EMPTY: Address = { id: '', label: '', icon: 'map-pin', name: 'Jordan Lee', line1: '', line2: '', city: '', state: 'Oregon', zip: '', phone: '', note: '', isDefault: false };

function validate(a: Address) {
  const e: Partial<Record<keyof Address, string>> = {};
  if (!a.name.trim()) e.name = 'Enter the name for delivery.';
  if (!a.line1.trim()) e.line1 = 'Enter a street address.';
  if (!a.city.trim()) e.city = 'Enter a city.';
  if (!/^\d{5}$/.test(a.zip.trim())) e.zip = 'Enter a 5-digit ZIP code, like 97204.';
  if (!a.phone.trim()) e.phone = 'Enter a phone number.';
  return e;
}

export default function Addresses() {
  const [view, setView] = useView<'edit-address'>();
  const [list, setList] = useState(INITIAL);
  // The design's "edit-address" view shows the Work address after a save with a 4-digit ZIP.
  const [draft, setDraft] = useState<Address>(() => (view === 'edit-address' ? { ...INITIAL[1], zip: '9720' } : EMPTY));
  const [attempted, setAttempted] = useState(view === 'edit-address');

  const open = view === 'edit-address';
  const errors = attempted ? validate(draft) : {};
  const nErrors = Object.keys(errors).length;

  const edit = (a?: Address) => {
    setDraft(a ? { ...a } : { ...EMPTY });
    setAttempted(false);
    setView('edit-address');
  };
  const close = () => setView('');
  const set = <K extends keyof Address>(k: K, v: Address[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const save = () => {
    setAttempted(true);
    if (Object.keys(validate(draft)).length) return;
    setList((l) => {
      const saved = { ...draft, id: draft.id || `a${Date.now()}`, label: draft.label || 'Address' };
      const next = draft.id ? l.map((a) => (a.id === draft.id ? saved : a)) : [...l, saved];
      return saved.isDefault ? next.map((a) => ({ ...a, isDefault: a.id === saved.id })) : next;
    });
    close();
  };
  const makeDefault = (id: string) => setList((l) => l.map((a) => ({ ...a, isDefault: a.id === id })));
  const remove = (id: string) => setList((l) => l.filter((a) => a.id !== id));

  return (
    <AccountLayout active="addresses" title="Addresses">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Addresses</h1>
          <p className="small sub">Used at checkout. Sellers only see the address of an order they ship.</p>
        </div>
        <div className="acts">
          <Button size="sm" icon="plus" onClick={() => edit()}>
            Add address
          </Button>
        </div>
      </div>
      <Alert tone="info" title="Changing an address doesn't change orders already placed">
        To redirect a package that hasn't shipped, message its seller from the order page. Open order:{' '}
        <Link className="mono" to={href('account/order')}>
          MK-260914-48213
        </Link>
        .
      </Alert>
      <div className="grid md2">
        {list.map((a) => (
          <section key={a.id} className="card pad stack gap-3">
            <div className="row between">
              <span className="row gap-2">
                <Icon name={a.icon} className="ic-sm" />
                <span className="strong">{a.label}</span>
                {a.isDefault && <Badge tone="brand">Default</Badge>}
              </span>
            </div>
            <address className="small sub u-fst-normal">
              {a.name}
              <br />
              {a.line1}
              {a.line2 && `, ${a.line2}`}
              <br />
              {a.city}, {STATE_CODE[a.state] ?? a.state} {a.zip}
              <br />
              {a.phone}
            </address>
            <div className="row gap-2">
              <Button variant="secondary" size="sm" icon="pencil" onClick={() => edit(a)}>
                Edit
              </Button>
              {!a.isDefault && (
                <Button variant="ghost" size="sm" onClick={() => makeDefault(a.id)}>
                  Set as default
                </Button>
              )}
              <Button variant="ghost" size="sm" icon="trash-2" onClick={() => remove(a.id)} disabled={a.isDefault && list.length > 1}>
                Remove
              </Button>
            </div>
          </section>
        ))}
        <button type="button" className="card pad stack gap-2 u-items-center u-justify-center u-ta-center u-bs-dashed u-minh-180px u-c-text-2 u-td-none" onClick={() => edit()}>
          <Icon name="plus" className="ic-lg" />
          <span className="strong">Add a new address</span>
          <span className="xs muted">We deliver to all 50 US states.</span>
        </button>
      </div>

      <Dialog
        open={open}
        onClose={close}
        title={draft.id ? 'Edit address' : 'Add address'}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={save}>Save address</Button>
          </>
        }
      >
        {nErrors > 0 && (
          <Alert tone="danger" title={`Check ${nErrors} field${nErrors > 1 ? 's' : ''}`}>
            {errors.zip && nErrors === 1 ? 'Fix the ZIP code to save this address.' : 'Fix the highlighted fields to save this address.'}
          </Alert>
        )}
        <div className="grid md2 gap-3">
          <Field label="Label" optional>
            <TextInput id="ad-label" value={draft.label} onChange={(e) => set('label', e.target.value)} />
          </Field>
          <Field label="Full name" error={errors.name}>
            <TextInput id="ad-name" value={draft.name} error={!!errors.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
        </div>
        <Field label="Street address" error={errors.line1}>
          <TextInput id="ad-line1" value={draft.line1} error={!!errors.line1} onChange={(e) => set('line1', e.target.value)} autoComplete="address-line1" />
        </Field>
        <Field label="Apartment, suite, floor" optional>
          <TextInput id="ad-line2" value={draft.line2} onChange={(e) => set('line2', e.target.value)} autoComplete="address-line2" />
        </Field>
        <div className="grid md3 gap-3">
          <Field label="City" error={errors.city}>
            <TextInput id="ad-city" value={draft.city} error={!!errors.city} onChange={(e) => set('city', e.target.value)} />
          </Field>
          <Field label="State">
            <Select id="ad-state" options={STATES} value={draft.state} onChange={(e) => set('state', e.target.value)} />
          </Field>
          <Field label="ZIP code" error={errors.zip}>
            <TextInput id="ad-zip" value={draft.zip} error={!!errors.zip} inputMode="numeric" onChange={(e) => set('zip', e.target.value)} />
          </Field>
        </div>
        <Field label="Phone" hint="Carriers call only if there's a delivery problem." error={errors.phone}>
          <TextInput id="ad-phone" type="tel" value={draft.phone} error={!!errors.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Delivery instructions" optional>
          <Textarea id="ad-note" value={draft.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
        <Checkbox id="ad-default" label="Make this my default address" checked={draft.isDefault} onChange={(e) => set('isDefault', e.target.checked)} />
        <span className="xs muted">Saving won't change orders already placed.</span>
      </Dialog>
    </AccountLayout>
  );
}
