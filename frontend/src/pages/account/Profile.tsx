import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useSession } from '@/app/session';
import { AccountLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Field, Icon, Switch, TextInput } from '@marketly/web-shared/ui';

// Design: pages/store/account-profile.html (one view): personal details form, message preferences,
// search history, data export and account closure (blocked while orders/returns/cases are open).

interface Details {
  first: string;
  last: string;
  email: string;
  phone: string;
}

type PrefKey = 'email' | 'sms' | 'push' | 'wish' | 'recent';

const PROMOS: Array<{ key: PrefKey; id: string; title: string; body: ReactNode }> = [
  { key: 'email', id: 'pf-pr-email', title: 'Email promotions', body: 'Weekly deals, Home Week and seasonal sales. About 2 emails a week.' },
  { key: 'sms', id: 'pf-pr-sms', title: 'SMS promotions', body: 'Flash sales by text to (503) 555-0148. Message rates may apply.' },
  { key: 'push', id: 'pf-pr-push', title: 'Push promotions', body: 'Offers in the Marketly Android app. Set separately from order push notices.' },
  {
    key: 'wish',
    id: 'pf-pr-wish',
    title: 'Wishlist alerts',
    body: (
      <>
        Price drops and back-in-stock notices for items you saved.{' '}
        <Link to={href('account/wishlist')} className="link-inline">
          Manage alerts
        </Link>
      </>
    ),
  },
];

function validate(d: Details) {
  const e: Partial<Record<keyof Details, string>> = {};
  if (!d.first.trim()) e.first = 'Enter your first name.';
  if (!d.last.trim()) e.last = 'Enter your last name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) e.email = 'Enter an email address like name@example.com.';
  if (d.phone.replace(/\D/g, '').length !== 10) e.phone = 'Enter a 10-digit US phone number, like (503) 555-0148.';
  return e;
}

function Pref({ id, title, body, checked, onChange }: { id: string; title: string; body: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="acct-pref">
      <span className="stack gap-0">
        <span className="small strong">{title}</span>
        <span className="xs muted">{body}</span>
      </span>
      <Switch id={id} label={<span className="sr-only">{title}</span>} checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

export default function Profile() {
  const { customer } = useSession();
  const initial: Details = { first: customer.first, last: customer.name.split(' ').slice(1).join(' '), email: customer.email, phone: customer.phone };
  const [saved, setSaved] = useState<Details>(initial);
  const [d, setD] = useState<Details>(initial);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<'' | 'saved' | 'verify'>('');
  const [verified, setVerified] = useState(true);
  const [prefs, setPrefs] = useState<Record<PrefKey, boolean>>({ email: true, sms: false, push: false, wish: true, recent: true });
  const [dataRequested, setDataRequested] = useState(false);

  const errors = attempted ? validate(d) : {};
  const dirty = (Object.keys(d) as Array<keyof Details>).some((k) => d[k] !== saved[k]);
  const set = (k: keyof Details, v: string) => {
    setD((x) => ({ ...x, [k]: v }));
    setNotice('');
  };
  const save = () => {
    setAttempted(true);
    if (Object.keys(validate(d)).length) return;
    const emailChanged = d.email.trim() !== saved.email;
    setSaved({ ...d, email: d.email.trim() });
    if (emailChanged) setVerified(false);
    setNotice(emailChanged ? 'verify' : 'saved');
    setAttempted(false);
  };
  const setPref = (k: PrefKey, v: boolean) => setPrefs((p) => ({ ...p, [k]: v }));

  return (
    <AccountLayout active="profile" title="Profile">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Profile</h1>
          <p className="small sub">Your details and how we contact you.</p>
        </div>
      </div>
      {notice === 'saved' && <Alert tone="success" title="Changes saved" />}
      {notice === 'verify' && (
        <Alert tone="info" title="Check your inbox">
          We sent a verification link to {saved.email}. Order emails keep going to your verified address until you confirm.
        </Alert>
      )}
      <Card
        title="Personal details"
        foot={
          <Button onClick={save} disabled={!dirty && !attempted}>
            Save changes
          </Button>
        }
      >
        <div className="grid md2 gap-4">
          <Field label="First name" error={errors.first}>
            <TextInput id="pf-first" value={d.first} error={!!errors.first} onChange={(e) => set('first', e.target.value)} autoComplete="given-name" />
          </Field>
          <Field label="Last name" error={errors.last}>
            <TextInput id="pf-last" value={d.last} error={!!errors.last} onChange={(e) => set('last', e.target.value)} autoComplete="family-name" />
          </Field>
          <div className="field">
            <label className="label" htmlFor="pf-email">
              Email
            </label>
            <TextInput id="pf-email" type="email" value={d.email} error={!!errors.email} aria-describedby={errors.email ? 'pf-email-err' : undefined} onChange={(e) => set('email', e.target.value)} autoComplete="email" />
            {errors.email ? (
              <span className="error-text" id="pf-email-err">
                <Icon name="circle-alert" className="ic-sm" />
                {errors.email}
              </span>
            ) : verified ? (
              <span className="row gap-2 xs">
                <Badge tone="info">Verified</Badge>
                <span className="muted">Verified Aug 12. Changing it sends a new verification link.</span>
              </span>
            ) : (
              <span className="row gap-2 xs">
                <Badge tone="warning">Not verified</Badge>
                <span className="muted">Open the link we emailed to {saved.email}.</span>
              </span>
            )}
          </div>
          <Field label="Mobile phone" hint="Used for delivery problems and 2-step verification." error={errors.phone}>
            <TextInput id="pf-phone" type="tel" value={d.phone} error={!!errors.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" />
          </Field>
        </div>
      </Card>
      <Card title="Order and account messages" titleAs="h3" sub="Always on. You need these to receive your orders safely.">
        <div className="row gap-2 small">
          <Icon name="lock" className="ic-sm" />
          <span className="sub">Sent in your account and by email: order accepted, payment result, dispatch, delays, delivery, cancellations, return and refund updates, case replies and security alerts.</span>
        </div>
        <Link className="small strong" to={href('account/notifications')}>
          See recent notifications
        </Link>
      </Card>
      <Card title="Promotions and offers" titleAs="h3" sub="Optional. Turning these off never affects order updates.">
        {PROMOS.map((p) => (
          <Pref key={p.key} id={p.id} title={p.title} body={p.body} checked={prefs[p.key]} onChange={(v) => setPref(p.key, v)} />
        ))}
        <span className="xs muted">
          Personalized recommendations use your order history.{' '}
          <Link to={href('info/policy', 'privacy')} className="link-inline">
            Privacy policy
          </Link>
        </span>
      </Card>
      <Card title="Search history" titleAs="h3">
        <Pref
          id="pf-recent"
          title="Save recent searches"
          body="Shows your last searches in the search box on every device you sign in to. Turning this off deletes the saved list."
          checked={prefs.recent}
          onChange={(v) => setPref('recent', v)}
        />
      </Card>
      <div className="grid md2">
        <Card
          title="Download my data"
          titleAs="h3"
          foot={
            <Button variant="secondary" icon={dataRequested ? 'check' : 'download'} disabled={dataRequested} onClick={() => setDataRequested(true)}>
              {dataRequested ? 'Data requested' : 'Request my data'}
            </Button>
          }
        >
          <p className="small sub">
            {dataRequested
              ? `Request received. We'll email a download link to ${saved.email} within 48 hours.`
              : 'Get a copy of your profile, orders, returns, messages and reviews as a ZIP file. We email a link within 48 hours.'}
          </p>
        </Card>
        <Card
          title="Close account"
          titleAs="h3"
          foot={
            <Button variant="danger-soft" disabled>
              Close account
            </Button>
          }
        >
          <p className="small sub">You can close your account after open orders, returns and cases are finished. You have 1 open order, 3 open returns and 1 open case. We keep order records as the law requires.</p>
        </Card>
      </div>
    </AccountLayout>
  );
}
