import { useState } from 'react';
import { AccountLayout } from '@/layouts';
import { announce, Alert, Badge, Button, Card, Checkbox, Dialog, Field, Icon, OptionCard, TextInput } from '@/ui';

// Design: pages/store/account-payment-methods.html (one view): saved cards (default, remove,
// update an expired card) and the "Add a card" form. Only type, last 4 and expiry are kept.

interface SavedCard {
  id: string;
  brand: 'VISA' | 'MC' | 'AMEX' | 'DISC';
  label: string;
  last4: string;
  exp: string;
  billing: string;
  isDefault: boolean;
}

const BRAND_NAME: Record<SavedCard['brand'], string> = { VISA: 'Visa', MC: 'Mastercard', AMEX: 'American Express', DISC: 'Discover' };

const CARDS: SavedCard[] = [
  { id: 'c1', brand: 'VISA', label: 'Personal Visa', last4: '4417', exp: '08/29', billing: 'Home, Portland 97205', isDefault: true },
  { id: 'c2', brand: 'MC', label: 'Work Mastercard', last4: '2051', exp: '11/27', billing: 'Work, Portland 97204', isDefault: false },
  { id: 'c3', brand: 'VISA', label: 'Old debit card', last4: '9032', exp: '09/26', billing: 'Home, Portland 97205', isDefault: false },
];

const BILLING = [
  { id: 'home', title: 'Home', body: '2140 Alder St, Apt 5, Portland, OR 97205', short: 'Home, Portland 97205' },
  { id: 'work', title: 'Work', body: '815 SW 2nd Ave, Floor 4, Portland, OR 97204', short: 'Work, Portland 97204' },
  { id: 'new', title: 'Use a different billing address', body: '', short: '' },
] as const;

/** Today is Oct 2026 in the sample data: a card is expired after the end of its month. */
const NOW = { y: 26, m: 10 };
const isExpired = (exp: string) => {
  const [m, y] = exp.split('/').map(Number);
  return y < NOW.y || (y === NOW.y && m < NOW.m);
};
const validExp = (exp: string) => /^(0[1-9]|1[0-2])\s?\/\s?\d{2}$/.test(exp.trim()) && !isExpired(exp.replace(/\s/g, ''));

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
const brandOf = (num: string): SavedCard['brand'] => (num.startsWith('4') ? 'VISA' : /^3[47]/.test(num) ? 'AMEX' : /^6/.test(num) ? 'DISC' : 'MC');
const groupDigits = (v: string) => v.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');
const formatExp = (v: string) => {
  const d = v.replace(/\D/g, '').slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)} / ${d.slice(2)}` : d;
};

const EMPTY = { num: '', exp: '', cvc: '', name: '', label: '', billing: 'home' as (typeof BILLING)[number]['id'], street: '', isDefault: false };

export default function PaymentMethods() {
  const [cards, setCards] = useState(CARDS);
  const [form, setForm] = useState(EMPTY);
  const [tried, setTried] = useState(false);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<SavedCard | null>(null);
  const [newExp, setNewExp] = useState('');
  const [expTried, setExpTried] = useState(false);

  const digits = form.num.replace(/\D/g, '');
  const amex = brandOf(digits) === 'AMEX';
  const errors = tried
    ? {
        num: digits.length < 13 || !luhn(digits) ? 'Check the card number.' : undefined,
        exp: validExp(form.exp) ? undefined : 'Enter a future expiry date as MM / YY.',
        cvc: new RegExp(`^\\d{${amex ? 4 : 3}}$`).test(form.cvc) ? undefined : amex ? 'Enter the 4-digit code on the front.' : 'Enter the 3-digit code on the back.',
        name: form.name.trim() ? undefined : 'Enter the name as printed on the card.',
        street: form.billing !== 'new' || form.street.trim() ? undefined : 'Enter the billing address.',
      }
    : {};
  const nErr = Object.values(errors).filter(Boolean).length;
  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = () => {
    setTried(true);
    const ok = digits.length >= 13 && luhn(digits) && validExp(form.exp) && new RegExp(`^\\d{${amex ? 4 : 3}}$`).test(form.cvc) && form.name.trim() && (form.billing !== 'new' || form.street.trim());
    if (!ok) return;
    const brand = brandOf(digits);
    const card: SavedCard = {
      id: `c${Date.now()}`,
      brand,
      label: form.label.trim() || `${BRAND_NAME[brand]} ${digits.slice(-4)}`,
      last4: digits.slice(-4),
      exp: form.exp.replace(/\s/g, ''),
      billing: form.billing === 'new' ? form.street.trim() : BILLING.find((b) => b.id === form.billing)!.short,
      isDefault: form.isDefault,
    };
    setCards((cs) => [...(card.isDefault ? cs.map((c) => ({ ...c, isDefault: false })) : cs), card]);
    setForm(EMPTY);
    setTried(false);
    setNotice(`${card.label} saved.`);
    announce(`${card.label} saved`);
  };
  const makeDefault = (id: string) => setCards((cs) => cs.map((c) => ({ ...c, isDefault: c.id === id })));
  const remove = (card: SavedCard) => {
    const rest = cards.filter((c) => c.id !== card.id);
    setCards(card.isDefault && rest.length ? rest.map((c, i) => ({ ...c, isDefault: i === 0 })) : rest);
    setNotice(`${card.label} removed.`);
  };
  const saveExp = () => {
    setExpTried(true);
    if (!editing || !validExp(newExp)) return;
    setCards((cs) => cs.map((c) => (c.id === editing.id ? { ...c, exp: newExp.replace(/\s/g, '') } : c)));
    setNotice(`${editing.label} updated.`);
    setEditing(null);
  };

  return (
    <AccountLayout active="payment" title="Payment methods">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Payment methods</h1>
          <p className="small sub">Cards saved for faster checkout.</p>
        </div>
      </div>
      {notice && <Alert tone="success" title={notice} />}
      <Card
        title="Saved cards"
        flush
        foot={
          <span className="xs muted grow">
            <Icon name="info" className="ic-sm" /> Removing a card doesn't affect past receipts. Refunds for earlier orders still go back to the card you paid with.
          </span>
        }
      >
        {cards.map((c) => {
          const expired = isExpired(c.exp);
          return (
            <div key={c.id} className="acct-row">
              <span className="acct-cc" aria-hidden="true">
                {c.brand}
              </span>
              <span className="stack gap-1 grow">
                <span className="row gap-2">
                  <span className="small strong">{c.label}</span>
                  {c.isDefault && <Badge tone="brand">Default</Badge>}
                  {expired && <Badge>Expired</Badge>}
                </span>
                <span className="xs muted">
                  {BRAND_NAME[c.brand]} ending in <span className="num">{c.last4}</span> · {expired ? 'Expired' : 'Expires'} {c.exp} · Billing: {c.billing}
                </span>
              </span>
              <span className="row gap-2">
                {expired ? (
                  <Button variant="secondary" size="sm" onClick={() => (setEditing(c), setNewExp(''), setExpTried(false))}>
                    Update expiry
                  </Button>
                ) : (
                  !c.isDefault && (
                    <Button variant="ghost" size="sm" onClick={() => makeDefault(c.id)}>
                      Make default
                    </Button>
                  )
                )}
                <Button variant="ghost" size="sm" icon="trash-2" onClick={() => remove(c)}>
                  Remove
                </Button>
              </span>
            </div>
          );
        })}
        {cards.length === 0 && <p className="small muted u-p-sp-4">No saved cards. Add one below or enter a card at checkout.</p>}
      </Card>
      <Card
        title="Add a card"
        titleAs="h3"
        sub="We accept Visa, Mastercard, American Express and Discover."
        foot={
          <>
            <Button variant="ghost" onClick={() => (setForm(EMPTY), setTried(false))}>
              Cancel
            </Button>
            <Button onClick={save}>Save card</Button>
          </>
        }
      >
        {nErr > 0 && <Alert tone="danger" title={`Check ${nErr} field${nErr > 1 ? 's' : ''}`}>Fix the highlighted fields to save this card.</Alert>}
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
            {BILLING.map((b) => (
              <OptionCard key={b.id} id={`pm-bill-${b.id}`} name="pm-bill" checked={form.billing === b.id} onChange={() => set('billing', b.id)} title={<span className="strong">{b.title}</span>} body={b.body || undefined} />
            ))}
          </div>
        </div>
        {form.billing === 'new' && (
          <Field label="Billing address" error={errors.street}>
            <TextInput id="pm-street" placeholder="Street, city, state and ZIP" autoComplete="billing street-address" value={form.street} error={!!errors.street} onChange={(e) => set('street', e.target.value)} />
          </Field>
        )}
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
            <Button onClick={saveExp}>Save</Button>
          </>
        }
      >
        <p className="small sub">
          {editing && `${BRAND_NAME[editing.brand]} ending in ${editing.last4}. Enter the expiry date from your replacement card.`}
        </p>
        <Field label="New expiry date" error={expTried && !validExp(newExp) ? 'Enter a future expiry date as MM / YY.' : undefined}>
          <TextInput id="pm-new-exp" placeholder="MM / YY" inputMode="numeric" value={newExp} error={expTried && !validExp(newExp)} onChange={(e) => setNewExp(formatExp(e.target.value))} />
        </Field>
      </Dialog>
    </AccountLayout>
  );
}
