import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { ApiError, call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { announce, Alert, Badge, Button, Card, Checkbox, Dialog, Field, Icon, OptionCard, TextInput } from '@marketly/web-shared/ui';
import { cardExpiry } from './data/when';

// Design: pages/store/account-payment-methods.html (one view): saved cards (default, remove,
// update an expired card) and the "Add a card" form. Only type, last 4 and expiry are kept.
// API: payments saved methods (GET/POST/PATCH/DELETE /api/store/payments/methods, make-default, setup).
// Adding a card: POST …/methods/setup, then the provider's card fields return a setup token. With the
// development provider (card-processor) the token is built from the typed card's brand, last 4 and expiry
// (seti_<brand>_<last4>_<MMYY>); the card number never leaves the browser (gap G9: production needs the
// provider's hosted fields).

type SavedMethod = components['schemas']['payments.SavedPaymentMethod'];
type BrandKey = 'visa' | 'mastercard' | 'amex' | 'discover';

const BRAND_NAME: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover' };
const BRAND_TILE: Record<string, string> = { visa: 'VISA', mastercard: 'MC', amex: 'AMEX', discover: 'DISC' };
const brandName = (b: string) => BRAND_NAME[b.toLowerCase()] ?? b;
const brandTile = (b: string) => BRAND_TILE[b.toLowerCase()] ?? b.slice(0, 4).toUpperCase();

const now = new Date();
const NOW = { y: now.getFullYear() % 100, m: now.getMonth() + 1 };
const parseExp = (exp: string) => {
  const m = /^(0[1-9]|1[0-2])\s?\/\s?(\d{2})$/.exec(exp.trim());
  return m ? { m: Number(m[1]), y: Number(m[2]) } : null;
};
const validExp = (exp: string) => {
  const e = parseExp(exp);
  return !!e && (e.y > NOW.y || (e.y === NOW.y && e.m >= NOW.m));
};

function luhn(num: string) {
  let sum = 0;
  [...num].reverse().forEach((c, i) => {
    let d = Number(c);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  });
  return sum % 10 === 0;
}
const brandOf = (num: string): BrandKey => (num.startsWith('4') ? 'visa' : /^3[47]/.test(num) ? 'amex' : /^6/.test(num) ? 'discover' : 'mastercard');
const groupDigits = (v: string) => v.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');
const formatExp = (v: string) => {
  const d = v.replace(/\D/g, '').slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)} / ${d.slice(2)}` : d;
};

const EMPTY = { num: '', exp: '', cvc: '', name: '', label: '', billing: '', isDefault: false };

export default function PaymentMethods() {
  const { api } = useApi();
  const qc = useQueryClient();
  const methods = useQuery({ queryKey: ['payments', 'methods'], queryFn: () => call(api.GET('/api/store/payments/methods')) });
  const addresses = useQuery({ queryKey: ['customers', 'addresses'], queryFn: () => call(api.GET('/api/store/customers/addresses')) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['payments', 'methods'] });

  const [form, setForm] = useState(EMPTY);
  const [tried, setTried] = useState(false);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<SavedMethod | null>(null);
  const [newExp, setNewExp] = useState('');
  const [expTried, setExpTried] = useState(false);

  const cards = methods.data ?? [];
  const billingOptions = addresses.data ?? [];
  const billing = form.billing || billingOptions.find((a) => a.isDefault)?.id || billingOptions[0]?.id || '';
  const digits = form.num.replace(/\D/g, '');
  const amex = brandOf(digits) === 'amex';
  const errors = tried
    ? {
        num: digits.length < 13 || !luhn(digits) ? 'Check the card number.' : undefined,
        exp: validExp(form.exp) ? undefined : 'Enter a future expiry date as MM / YY.',
        cvc: new RegExp(`^\\d{${amex ? 4 : 3}}$`).test(form.cvc) ? undefined : amex ? 'Enter the 4-digit code on the front.' : 'Enter the 3-digit code on the back.',
        name: form.name.trim() ? undefined : 'Enter the name as printed on the card.',
      }
    : {};
  const nErr = Object.values(errors).filter(Boolean).length;
  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (addCard.isError) addCard.reset();
  };

  const addCard = useMutation({
    mutationFn: async () => {
      const setup = await call(api.POST('/api/store/payments/methods/setup'));
      if (setup.provider !== 'card-processor') {
        throw new ApiError(501, 'PROVIDER_FIELDS_REQUIRED', 'Adding a card needs the payment provider’s secure card fields, which this version of the store doesn’t have yet. You can still pay with a new card at checkout.');
      }
      const e = parseExp(form.exp)!;
      const setupToken = `seti_${brandOf(digits)}_${digits.slice(-4)}_${String(e.m).padStart(2, '0')}${String(e.y).padStart(2, '0')}`;
      return call(api.POST('/api/store/payments/methods', { body: { setupToken, label: form.label.trim() || null, billingAddressId: billing || null, makeDefault: form.isDefault || !cards.length } }));
    },
    onSuccess: (card) => {
      setForm(EMPTY);
      setTried(false);
      setNotice(`${card.label} saved.`);
      announce(`${card.label} saved`);
      refresh();
    },
  });
  const makeDefault = useMutation({
    mutationFn: (c: SavedMethod) => call(api.POST('/api/store/payments/methods/{id}/make-default', { params: { path: { id: c.id } } })),
    onSuccess: (c) => {
      setNotice(`${c.label} is now your default card.`);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (c: SavedMethod) => call(api.DELETE('/api/store/payments/methods/{id}', { params: { path: { id: c.id } } })),
    onSuccess: (_, c) => {
      setNotice(`${c.label} removed.`);
      refresh();
    },
  });
  const updateExp = useMutation({
    mutationFn: ({ c, m, y }: { c: SavedMethod; m: number; y: number }) => call(api.PATCH('/api/store/payments/methods/{id}', { params: { path: { id: c.id } }, body: { expMonth: m, expYear: 2000 + y } })),
    onSuccess: (c) => {
      setNotice(`${c.label} updated.`);
      setEditing(null);
      refresh();
    },
  });

  const save = () => {
    setTried(true);
    const ok = digits.length >= 13 && luhn(digits) && validExp(form.exp) && new RegExp(`^\\d{${amex ? 4 : 3}}$`).test(form.cvc) && form.name.trim();
    if (!ok) return;
    addCard.mutate();
  };
  const saveExp = () => {
    setExpTried(true);
    const e = parseExp(newExp);
    if (!editing || !e || !validExp(newExp)) return;
    updateExp.mutate({ c: editing, m: e.m, y: e.y });
  };
  const rowError = makeDefault.error ?? remove.error;

  return (
    <AccountLayout active="payment" title="Payment methods">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Payment methods</h1>
          <p className="small sub">Cards saved for faster checkout.</p>
        </div>
      </div>
      {rowError ? <Alert tone="danger" title="That didn't work">{errorMessage(rowError)}</Alert> : notice && <Alert tone="success" title={notice} />}
      <Card
        title="Saved cards"
        flush
        foot={
          <span className="xs muted grow">
            <Icon name="info" className="ic-sm" /> Removing a card doesn't affect past receipts. Refunds for earlier orders still go back to the card you paid with.
          </span>
        }
      >
        {methods.isError && (
          <div className="card-body">
            <Alert tone="danger" title="We couldn't load your cards">
              {errorMessage(methods.error)}{' '}
              <Button variant="ghost" size="sm" onClick={() => void methods.refetch()}>
                Try again
              </Button>
            </Alert>
          </div>
        )}
        {methods.isPending && (
          <div className="sk-list" aria-hidden="true">
            {[0, 1].map((i) => (
              <div className="sk-row" key={i}>
                <span className="sk sk-thumb" />
                <span className="sk-lines">
                  <span className="sk sk-line" />
                  <span className="sk sk-line short" />
                </span>
              </div>
            ))}
          </div>
        )}
        {cards.map((c) => {
          const exp = cardExpiry(c.expMonth, c.expYear);
          return (
            <div key={c.id} className="acct-row">
              <span className="acct-cc" aria-hidden="true">
                {brandTile(c.brand)}
              </span>
              <span className="stack gap-1 grow">
                <span className="row gap-2">
                  <span className="small strong">{c.label}</span>
                  {c.isDefault && <Badge tone="brand">Default</Badge>}
                  {c.expired && <Badge>Expired</Badge>}
                </span>
                <span className="xs muted">
                  {brandName(c.brand)} ending in <span className="num">{c.last4}</span> · {c.expired ? 'Expired' : 'Expires'} {exp}
                  {c.billingSummary && ` · Billing: ${c.billingSummary}`}
                </span>
              </span>
              <span className="row gap-2">
                {c.expired ? (
                  <Button variant="secondary" size="sm" onClick={() => (setEditing(c), setNewExp(''), setExpTried(false), updateExp.reset())}>
                    Update expiry
                  </Button>
                ) : (
                  !c.isDefault && (
                    <Button variant="ghost" size="sm" onClick={() => makeDefault.mutate(c)} disabled={makeDefault.isPending}>
                      Make default
                    </Button>
                  )
                )}
                <Button variant="ghost" size="sm" icon="trash-2" onClick={() => remove.mutate(c)} disabled={remove.isPending}>
                  Remove
                </Button>
              </span>
            </div>
          );
        })}
        {methods.isSuccess && cards.length === 0 && <p className="small muted u-p-sp-4">No saved cards. Add one below or enter a card at checkout.</p>}
      </Card>
      <Card
        title="Add a card"
        titleAs="h3"
        sub="We accept Visa, Mastercard, American Express and Discover."
        foot={
          <>
            <Button variant="ghost" onClick={() => (setForm(EMPTY), setTried(false), addCard.reset())}>
              Cancel
            </Button>
            <Button onClick={save} disabled={addCard.isPending}>
              {addCard.isPending ? 'Saving…' : 'Save card'}
            </Button>
          </>
        }
      >
        {nErr > 0 && <Alert tone="danger" title={`Check ${nErr} field${nErr > 1 ? 's' : ''}`}>Fix the highlighted fields to save this card.</Alert>}
        {addCard.isError && <Alert tone="danger" title="We couldn't save this card">{errorMessage(addCard.error)}</Alert>}
        <Field label="Card number" error={errors.num}>
          <TextInput id="pm-num" icon="credit-card" placeholder="Card number" inputMode="numeric" autoComplete="cc-number" value={form.num} error={!!errors.num} onChange={(e) => set('num', groupDigits(e.target.value))} />
        </Field>
        <div className="grid c2 gap-3">
          <Field label="Expiry date" error={errors.exp}>
            <TextInput id="pm-exp" placeholder="MM / YY" inputMode="numeric" autoComplete="cc-exp" value={form.exp} error={!!errors.exp} onChange={(e) => set('exp', formatExp(e.target.value))} />
          </Field>
          <Field label="Security code" hint="On the back of the card, or the front for Amex." error={errors.cvc}>
            <TextInput id="pm-cvc" placeholder="3 or 4 digits" inputMode="numeric" autoComplete="cc-csc" maxLength={4} value={form.cvc} error={!!errors.cvc} onChange={(e) => set('cvc', e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
        <Field label="Name on card" error={errors.name}>
          <TextInput id="pm-name" placeholder="As printed on the card" autoComplete="cc-name" value={form.name} error={!!errors.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Card label" optional hint="Helps you recognise the card at checkout.">
          <TextInput id="pm-label" placeholder="For example: Travel card" value={form.label} onChange={(e) => set('label', e.target.value)} />
        </Field>
        <div className="field">
          <span className="label">Billing address</span>
          <div className="stack gap-2" role="radiogroup" aria-label="Billing address">
            {billingOptions.map((b) => (
              <OptionCard
                key={b.id}
                id={`pm-bill-${b.id}`}
                name="pm-bill"
                checked={billing === b.id}
                onChange={() => set('billing', b.id)}
                title={<span className="strong">{b.label || 'Address'}</span>}
                body={`${b.address.line1}${b.address.line2 ? `, ${b.address.line2}` : ''}, ${b.address.city}, ${b.address.region} ${b.address.postalCode}`}
              />
            ))}
            <OptionCard
              id="pm-bill-new"
              name="pm-bill"
              disabled
              title={<span className="strong">Use a different billing address</span>}
              body={
                <>
                  Add it to your{' '}
                  <Link to={href('account/addresses')} className="link-inline">
                    addresses
                  </Link>{' '}
                  first, then choose it here.
                </>
              }
            />
          </div>
        </div>
        <Checkbox id="pm-default" label="Make this my default card" checked={form.isDefault} onChange={(e) => set('isDefault', e.target.checked)} />
        <span className="row gap-2 xs muted">
          <Icon name="lock" className="ic-sm" /> Card details go straight to our payment provider. Marketly only keeps the card type, last 4 digits and expiry.
        </span>
      </Card>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Update expiry"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={saveExp} disabled={updateExp.isPending}>
              Save
            </Button>
          </>
        }
      >
        <p className="small sub">{editing && `${brandName(editing.brand)} ending in ${editing.last4}. Enter the expiry date from your replacement card.`}</p>
        {updateExp.isError && <Alert tone="danger" title="We couldn't update the card">{errorMessage(updateExp.error)}</Alert>}
        <Field label="New expiry date" error={expTried && !validExp(newExp) ? 'Enter a future expiry date as MM / YY.' : undefined}>
          <TextInput id="pm-new-exp" placeholder="MM / YY" inputMode="numeric" value={newExp} error={expTried && !validExp(newExp)} onChange={(e) => setNewExp(formatExp(e.target.value))} />
        </Field>
      </Dialog>
    </AccountLayout>
  );
}
