import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { ApiError, call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Checkbox, Dialog, Field, Icon, Select, Textarea, TextInput, type IconName } from '@marketly/web-shared/ui';

// Design: pages/store/account-addresses.html · view "edit-address" = the add/edit dialog.
// API: customers saved addresses (GET/POST/PATCH/DELETE /api/store/customers/addresses, make-default).

type SavedAddress = components['schemas']['customers.SavedAddress'];

interface Draft {
  id: string;
  label: string;
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
type FieldKey = 'name' | 'line1' | 'line2' | 'city' | 'state' | 'zip' | 'phone' | 'label' | 'note';

/** The 50 states and DC (the service region, customers/domain/address.ts). */
const STATES: Array<{ value: string; label: string }> = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'],
  ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
  ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'],
  ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
].map(([value, label]) => ({ value, label }));

const EMPTY: Draft = { id: '', label: '', name: '', line1: '', line2: '', city: '', state: 'OR', zip: '', phone: '', note: '', isDefault: false };

/** API field (issue.field or the last part of issue.path) -> form field. */
const API_FIELD: Record<string, FieldKey> = { name: 'name', line1: 'line1', line2: 'line2', city: 'city', region: 'state', postalCode: 'zip', phone: 'phone', label: 'label', deliveryInstructions: 'note' };

const iconFor = (label?: string | null): IconName => (/home/i.test(label ?? '') ? 'house' : /work|office/i.test(label ?? '') ? 'building-2' : 'map-pin');

/** +15035550148 -> (503) 555-0148; other formats are shown as saved. */
function formatPhone(p?: string | null): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : p;
}

const toDraft = (a: SavedAddress): Draft => ({
  id: a.id,
  label: a.label ?? '',
  name: a.address.name,
  line1: a.address.line1,
  line2: a.address.line2 ?? '',
  city: a.address.city,
  state: a.address.region,
  zip: a.address.postalCode,
  phone: formatPhone(a.address.phone),
  note: a.deliveryInstructions ?? '',
  isDefault: a.isDefault,
});

/** The same format rules the API applies (customers/domain/address.ts), so most mistakes show before saving. */
function validate(a: Draft) {
  const e: Partial<Record<FieldKey, string>> = {};
  if (!a.name.trim()) e.name = 'Enter the name for delivery.';
  if (!a.line1.trim()) e.line1 = 'Enter a street address.';
  else if (/\b(p\s*\.?\s*o\s*\.?\s*box|post\s+office\s+box)/i.test(a.line1)) e.line1 = 'We can’t deliver to PO boxes; use a street address.';
  if (!a.city.trim()) e.city = 'Enter a city.';
  if (!/^\d{5}(-\d{4})?$/.test(a.zip.trim())) e.zip = 'Enter a 5-digit ZIP code, like 97204.';
  if (!a.phone.trim()) e.phone = 'Enter a phone number.';
  else if (!/^\+?[0-9 ().-]{7,20}$/.test(a.phone.trim())) e.phone = 'Enter a phone number with digits only, like (503) 555-0148.';
  return e;
}

/** Field errors from VALIDATION_FAILED or ADDRESS_UNDELIVERABLE (details.issues: { path?, field?, message }). */
function serverFieldErrors(e: unknown): Partial<Record<FieldKey, string>> {
  if (!(e instanceof ApiError)) return {};
  const issues = (e.details.issues as Array<{ path?: string; field?: string; message: string }> | undefined) ?? [];
  const out: Partial<Record<FieldKey, string>> = {};
  for (const i of issues) {
    const key = API_FIELD[i.field ?? String(i.path ?? '').split('.').pop() ?? ''];
    if (key && !out[key]) out[key] = /[.!?]$/.test(i.message) ? i.message : `${i.message}.`;
  }
  return out;
}

export default function Addresses() {
  const { api } = useApi();
  const qc = useQueryClient();
  const [view, setView] = useView<'edit-address'>();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState('');

  const list = useQuery({ queryKey: ['customers', 'addresses'], queryFn: () => call(api.GET('/api/store/customers/addresses')) });
  // An order that hasn't shipped yet, for the "redirect a package" hint.
  const openOrders = useQuery({
    queryKey: ['orders', 'list', { tab: 'in_progress', limit: 10 }],
    queryFn: () => call(api.GET('/api/store/orders/orders', { params: { query: { tab: 'in_progress', limit: 10 } } })),
  });
  const notShipped = openOrders.data?.items.find((o) => ['payment_pending', 'confirmed', 'preparing', 'delayed'].includes(o.status.value));

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = {
        label: d.label.trim() || null,
        address: { name: d.name.trim(), line1: d.line1.trim(), line2: d.line2.trim() || null, city: d.city.trim(), region: d.state, postalCode: d.zip.trim(), country: 'US', phone: d.phone.trim() || null },
        deliveryInstructions: d.note.trim() || null,
        makeDefault: d.isDefault,
      };
      return d.id
        ? call(api.PATCH('/api/store/customers/addresses/{id}', { params: { path: { id: d.id } }, body }))
        : call(api.POST('/api/store/customers/addresses', { body }));
    },
    onSuccess: (saved, d) => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
      const label = saved.label || 'Address';
      setNotice(d.id ? `${label} updated.` : `${label} added.`);
      announce(d.id ? `${label} updated` : `${label} added`);
      setView('');
    },
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/store/customers/addresses/{id}/make-default', { params: { path: { id } } })),
    onSuccess: (rows) => {
      qc.setQueryData(['customers', 'addresses'], rows);
      void qc.invalidateQueries({ queryKey: ['customers', 'profile'] });
      setNotice('Default address changed.');
    },
  });
  const remove = useMutation({
    mutationFn: (a: SavedAddress) => call(api.DELETE('/api/store/customers/addresses/{id}', { params: { path: { id: a.id } } })),
    onSuccess: (_, a) => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
      setNotice(`${a.label || 'Address'} removed.`);
    },
  });

  const open = view === 'edit-address';
  const server = save.isError ? serverFieldErrors(save.error) : {};
  const local = attempted ? validate(draft) : {};
  const errors: Partial<Record<FieldKey, string>> = { ...server, ...local };
  const nErrors = Object.keys(errors).length;
  const formError = save.isError && !Object.keys(server).length ? save.error : null;
  const rows = list.data ?? [];
  const editingDefault = !!draft.id && !!rows.find((r) => r.id === draft.id)?.isDefault;

  const edit = (a?: SavedAddress) => {
    setDraft(a ? toDraft(a) : { ...EMPTY, isDefault: !rows.length });
    setAttempted(false);
    save.reset();
    setView('edit-address');
  };
  const close = () => setView('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    if (save.isError) save.reset();
  };
  const submit = () => {
    setAttempted(true);
    if (Object.keys(validate(draft)).length) return;
    save.mutate(draft);
  };
  const actionError = makeDefault.error ?? remove.error;

  return (
    <AccountLayout active="addresses" title="Addresses">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Addresses</h1>
          <p className="small sub">Used at checkout. Sellers only see the address of an order they ship.</p>
        </div>
        <div className="acts">
          <Button size="sm" icon="plus" onClick={() => edit()} disabled={!list.isSuccess}>
            Add address
          </Button>
        </div>
      </div>
      <Alert tone="info" title="Changing an address doesn't change orders already placed">
        To redirect a package that hasn't shipped, message its seller from the order page.
        {notShipped && (
          <>
            {' '}Open order:{' '}
            <Link className="mono" to={href('account/order', '', { ref: notShipped.ref })}>
              {notShipped.ref}
            </Link>
            .
          </>
        )}
      </Alert>
      {actionError ? <Alert tone="danger" title="That didn't work">{errorMessage(actionError)}</Alert> : notice && <Alert tone="success" title={notice} />}
      {list.isError ? (
        <Alert tone="danger" title="We couldn't load your addresses">
          {errorMessage(list.error)}{' '}
          <Button variant="ghost" size="sm" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </Alert>
      ) : (
        <div className="grid md2">
          {list.isPending
            ? [0, 1].map((i) => (
                <section key={i} className="card pad stack gap-3" aria-hidden="true">
                  <span className="sk sk-line short" />
                  <span className="sk sk-line" />
                  <span className="sk sk-line" />
                  <span className="sk sk-line short" />
                </section>
              ))
            : rows.map((a) => (
                <section key={a.id} className="card pad stack gap-3">
                  <div className="row between">
                    <span className="row gap-2">
                      <Icon name={iconFor(a.label)} className="ic-sm" />
                      <span className="strong">{a.label || 'Address'}</span>
                      {a.isDefault && <Badge tone="brand">Default</Badge>}
                    </span>
                  </div>
                  <address className="small sub u-fst-normal">
                    {a.address.name}
                    <br />
                    {a.address.line1}
                    {a.address.line2 && `, ${a.address.line2}`}
                    <br />
                    {a.address.city}, {a.address.region} {a.address.postalCode}
                    {a.address.phone && (
                      <>
                        <br />
                        {formatPhone(a.address.phone)}
                      </>
                    )}
                  </address>
                  <div className="row gap-2">
                    <Button variant="secondary" size="sm" icon="pencil" onClick={() => edit(a)}>
                      Edit
                    </Button>
                    {!a.isDefault && (
                      <Button variant="ghost" size="sm" onClick={() => makeDefault.mutate(a.id)} disabled={makeDefault.isPending}>
                        Set as default
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" icon="trash-2" onClick={() => remove.mutate(a)} disabled={(a.isDefault && rows.length > 1) || remove.isPending}>
                      Remove
                    </Button>
                  </div>
                </section>
              ))}
          {list.isSuccess && (
            <button type="button" className="card pad stack gap-2 u-items-center u-justify-center u-ta-center u-bs-dashed u-minh-180px u-c-text-2 u-td-none" onClick={() => edit()}>
              <Icon name="plus" className="ic-lg" />
              <span className="strong">Add a new address</span>
              <span className="xs muted">We deliver to all 50 US states.</span>
            </button>
          )}
        </div>
      )}

      <Dialog
        open={open}
        onClose={close}
        title={draft.id ? 'Edit address' : 'Add address'}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save address'}
            </Button>
          </>
        }
      >
        {nErrors > 0 && (
          <Alert tone="danger" title={`Check ${nErrors} field${nErrors > 1 ? 's' : ''}`}>
            {errors.zip && nErrors === 1 ? 'Fix the ZIP code to save this address.' : 'Fix the highlighted fields to save this address.'}
          </Alert>
        )}
        {formError && (
          <Alert tone="danger" title="We couldn't save this address">
            {formError instanceof ApiError && formError.code === 'ADDRESS_LIMIT_REACHED' ? 'You have the maximum number of saved addresses. Remove one to add another.' : errorMessage(formError)}
          </Alert>
        )}
        <div className="grid md2 gap-3">
          <Field label="Label" optional error={errors.label}>
            <TextInput id="ad-label" value={draft.label} error={!!errors.label} onChange={(e) => set('label', e.target.value)} />
          </Field>
          <Field label="Full name" error={errors.name}>
            <TextInput id="ad-name" value={draft.name} error={!!errors.name} onChange={(e) => set('name', e.target.value)} autoComplete="name" />
          </Field>
        </div>
        <Field label="Street address" error={errors.line1}>
          <TextInput id="ad-line1" value={draft.line1} error={!!errors.line1} onChange={(e) => set('line1', e.target.value)} autoComplete="address-line1" />
        </Field>
        <Field label="Apartment, suite, floor" optional error={errors.line2}>
          <TextInput id="ad-line2" value={draft.line2} error={!!errors.line2} onChange={(e) => set('line2', e.target.value)} autoComplete="address-line2" />
        </Field>
        <div className="grid md3 gap-3">
          <Field label="City" error={errors.city}>
            <TextInput id="ad-city" value={draft.city} error={!!errors.city} onChange={(e) => set('city', e.target.value)} autoComplete="address-level2" />
          </Field>
          <Field label="State" error={errors.state}>
            <Select id="ad-state" options={STATES} value={draft.state} onChange={(e) => set('state', e.target.value)} autoComplete="address-level1" />
          </Field>
          <Field label="ZIP code" error={errors.zip}>
            <TextInput id="ad-zip" value={draft.zip} error={!!errors.zip} inputMode="numeric" onChange={(e) => set('zip', e.target.value)} autoComplete="postal-code" />
          </Field>
        </div>
        <Field label="Phone" hint="Carriers call only if there's a delivery problem." error={errors.phone}>
          <TextInput id="ad-phone" type="tel" value={draft.phone} error={!!errors.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" />
        </Field>
        <Field label="Delivery instructions" optional error={errors.note}>
          <Textarea id="ad-note" value={draft.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
        <Checkbox id="ad-default" label="Make this my default address" checked={draft.isDefault} disabled={editingDefault} onChange={(e) => set('isDefault', e.target.checked)} />
        <span className="xs muted">Saving won't change orders already placed.</span>
      </Dialog>
    </AccountLayout>
  );
}
