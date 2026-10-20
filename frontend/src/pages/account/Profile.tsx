import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { ApiError, call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Card, Dialog, Field, Icon, PhoneInput, Switch, Textarea, TextInput } from '@marketly/web-shared/ui';
import { WhatWeSend } from './data/notification-settings';
import { NO_PASSWORD_NOTE, isPasswordNotSet } from './data/password';
import { dateLong } from './data/when';

// Design: pages/store/account-profile.html (one view): personal details form, message preferences,
// search history, data export and account closure (blocked while orders/returns/cases are open).
// API: customers profile, marketing preferences, data requests and closure eligibility; "What we send" is
// notifications preferences (data/notification-settings.tsx); the sign-in email
// changes through identity (password re-auth, then a 6-digit code sent to the new address).

type Prefs = components['schemas']['customers.MarketingPreferences'];
type PrefKey = 'emailPromotions' | 'smsPromotions' | 'pushPromotions' | 'wishlistAlerts' | 'recentSearches';
type DataRequest = components['schemas']['customers.DataRequest'];

interface Details {
  first: string;
  last: string;
  email: string;
  phone: string;
}

/** +15035550148 -> (503) 555-0148 */
function formatPhone(p?: string | null): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : p;
}
const phoneDigits = (p: string) => {
  const d = p.replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
};

function validate(d: Details) {
  const e: Partial<Record<keyof Details, string>> = {};
  if (!d.first.trim()) e.first = 'Enter your first name.';
  if (!d.last.trim()) e.last = 'Enter your last name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) e.email = 'Enter an email address like name@example.com.';
  if (d.phone.trim() && phoneDigits(d.phone).length !== 10) e.phone = 'Enter a 10-digit US phone number, like (503) 555-0148.';
  return e;
}

/** VALIDATION_FAILED issues keyed by form field. */
function fieldErrorsOf(e: unknown): Partial<Record<keyof Details, string>> {
  if (!(e instanceof ApiError)) return {};
  const f = e.fieldErrors;
  const map: Record<string, keyof Details> = { firstName: 'first', lastName: 'last', phone: 'phone', newEmail: 'email' };
  return Object.fromEntries(Object.entries(f).flatMap(([k, v]) => (map[k] ? [[map[k], v]] : []))) as Partial<Record<keyof Details, string>>;
}

function Pref({ id, title, body, checked, disabled, onChange }: { id: string; title: string; body: ReactNode; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="acct-pref">
      <span className="stack gap-0">
        <span className="small strong">{title}</span>
        <span className="xs muted">{body}</span>
      </span>
      <Switch id={id} label={<span className="sr-only">{title}</span>} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

/** Password field + error for the re-auth step-up (POST /api/store/identity/reauth). */
function ReauthField({ id, value, onChange, error }: { id: string; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <Field label="Current password" hint="We ask for it before changing how you sign in." error={error}>
      <TextInput id={id} type="password" autoComplete="current-password" value={value} error={!!error} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

const reauthError = (e: unknown) =>
  e instanceof ApiError && (e.code === 'CURRENT_PASSWORD_WRONG' || e.code === 'INVALID_CREDENTIALS') ? 'The password is incorrect.' : isPasswordNotSet(e) ? NO_PASSWORD_NOTE : e ? errorMessage(e) : undefined;

export default function Profile() {
  const { api } = useApi();
  const qc = useQueryClient();

  const profile = useQuery({ queryKey: ['customers', 'profile'], queryFn: () => call(api.GET('/api/store/customers/profile')) });
  const prefs = useQuery({ queryKey: ['customers', 'marketing-preferences'], queryFn: () => call(api.GET('/api/store/customers/marketing-preferences')) });
  const requests = useQuery({ queryKey: ['customers', 'data-requests'], queryFn: () => call(api.GET('/api/store/customers/data-requests')) });
  const closure = useQuery({ queryKey: ['customers', 'closure-eligibility'], queryFn: () => call(api.GET('/api/store/customers/closure-eligibility')) });
  const security = useQuery({ queryKey: ['identity', 'security'], queryFn: () => call(api.GET('/api/store/identity/security')) });

  const p = profile.data;
  const saved: Details | null = p ? { first: p.firstName, last: p.lastName, email: p.email, phone: formatPhone(p.phone) } : null;
  const [d, setD] = useState<Details | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<'' | 'saved' | 'verify' | 'email-changed'>('');
  useEffect(() => {
    if (saved && !d) setD(saved);
  }, [saved, d]);

  // Email change: password re-auth -> code to the new address -> confirm.
  const [emailFlow, setEmailFlow] = useState<null | { step: 'password' | 'code'; newEmail: string; challengeId?: string; masked?: string; codeLength?: number }>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  const saveProfile = useMutation({
    mutationFn: (x: Details) => call(api.PATCH('/api/store/customers/profile', { body: { firstName: x.first.trim(), lastName: x.last.trim(), phone: x.phone.trim() || null } })),
    onSuccess: (next) => qc.setQueryData(['customers', 'profile'], next),
  });
  const startEmailChange = useMutation({
    mutationFn: async ({ newEmail, pw }: { newEmail: string; pw: string }) => {
      const { reauthToken } = await call(api.POST('/api/store/identity/reauth', { body: { purpose: 'email-change', password: pw } }));
      return call(api.POST('/api/store/identity/email-changes', { body: { newEmail, reauthToken } }));
    },
    onSuccess: (ch, v) => {
      setEmailFlow({ step: 'code', newEmail: v.newEmail, challengeId: ch.id, masked: ch.emailMasked, codeLength: ch.codeLength });
      setPassword('');
      void qc.invalidateQueries({ queryKey: ['identity', 'security'] });
    },
  });
  const confirmEmail = useMutation({
    mutationFn: ({ id, c }: { id: string; c: string }) => call(api.POST('/api/public/identity/verifications/{id}/confirm', { params: { path: { id } }, body: { code: c } })),
    onSuccess: () => {
      setEmailFlow(null);
      setCode('');
      setNotice('email-changed');
      void qc.invalidateQueries({ queryKey: ['customers', 'profile'] });
      void qc.invalidateQueries({ queryKey: ['identity', 'security'] });
      setD(null);
    },
  });
  const resend = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/public/identity/verifications/{id}/resend', { params: { path: { id } } })),
  });

  const setPrefs = useMutation({
    mutationFn: (patch: Partial<Record<PrefKey, boolean>>) => call(api.PUT('/api/store/customers/marketing-preferences', { body: { ...patch, source: 'profile' } })),
    onMutate: (patch) => {
      const prev = qc.getQueryData<Prefs>(['customers', 'marketing-preferences']);
      if (prev) qc.setQueryData(['customers', 'marketing-preferences'], { ...prev, ...patch });
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(['customers', 'marketing-preferences'], ctx.prev),
    onSuccess: (next) => qc.setQueryData(['customers', 'marketing-preferences'], next),
  });

  const exportData = useMutation({
    mutationFn: () => call(api.POST('/api/store/customers/data-requests/exports')),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers', 'data-requests'] }),
  });

  const [closing, setClosing] = useState(false);
  const [closePw, setClosePw] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const requestClosure = useMutation({
    mutationFn: async () => {
      const { reauthToken } = await call(api.POST('/api/store/identity/reauth', { body: { purpose: 'account-closure', password: closePw } }));
      return call(api.POST('/api/store/customers/data-requests/closure', { body: { reauthToken, reason: closeReason.trim() || null } }));
    },
    onSuccess: () => {
      setClosing(false);
      setClosePw('');
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
  const cancelRequest = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/store/customers/data-requests/{id}/cancel', { params: { path: { id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers'] }),
  });

  if (profile.isError) {
    return (
      <AccountLayout active="profile" title="Profile">
        <div className="acct-head">
          <div className="stack gap-1">
            <h1 className="h1 acct-h1">Profile</h1>
            <p className="small sub">Your details and how we contact you.</p>
          </div>
        </div>
        <Alert tone="danger" title="We couldn't load your profile">
          {errorMessage(profile.error)}{' '}
          <Button variant="ghost" size="sm" onClick={() => void profile.refetch()}>
            Try again
          </Button>
        </Alert>
      </AccountLayout>
    );
  }

  const form = d ?? saved;
  const local = attempted && form ? validate(form) : {};
  const errors = { ...fieldErrorsOf(saveProfile.error), ...fieldErrorsOf(startEmailChange.error), ...local };
  const dirty = !!form && !!saved && (form.first !== saved.first || form.last !== saved.last || form.email.trim() !== saved.email || phoneDigits(form.phone) !== phoneDigits(saved.phone));
  const set = (k: keyof Details, v: string) => {
    setD((x) => ({ ...(x ?? saved!), [k]: v }));
    setNotice('');
    saveProfile.reset();
  };
  const save = async () => {
    if (!form || !saved) return;
    setAttempted(true);
    if (Object.keys(validate(form)).length) return;
    const emailChanged = form.email.trim().toLowerCase() !== saved.email.toLowerCase();
    const detailsChanged = form.first !== saved.first || form.last !== saved.last || phoneDigits(form.phone) !== phoneDigits(saved.phone);
    try {
      if (detailsChanged) await saveProfile.mutateAsync(form);
    } catch {
      return;
    }
    setAttempted(false);
    if (emailChanged) {
      startEmailChange.reset();
      setEmailFlow({ step: 'password', newEmail: form.email.trim() });
    } else {
      setNotice('saved');
      announce('Changes saved');
    }
  };
  const cancelEmail = () => {
    setEmailFlow(null);
    setPassword('');
    setCode('');
    setD((x) => (x && saved ? { ...x, email: saved.email } : x));
  };

  const pending = security.data?.email.pendingChangeTo;
  /** No password on the account (G28): an email change and closing the account confirm with one, so both are off. */
  const noPassword = security.data?.hasPassword === false;
  const pr = prefs.data;
  const latestExport = (requests.data ?? []).filter((r) => r.kind === 'export').sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0] as DataRequest | undefined;
  const exportOpen = latestExport && ['requested', 'processing'].includes(latestExport.state);
  const exportReady = latestExport?.state === 'ready' && latestExport.downloadUrl ? latestExport : null;
  const openClosure = (requests.data ?? []).find((r) => r.kind === 'closure' && ['requested', 'processing'].includes(r.state));
  const blockers = closure.data?.blockers ?? [];
  const sms = formatPhone(pr?.smsNumber ?? p?.phone);

  const PROMOS: Array<{ key: PrefKey; id: string; title: string; body: ReactNode; off?: boolean }> = [
    { key: 'emailPromotions', id: 'pf-pr-email', title: 'Email promotions', body: 'Weekly deals, Home Week and seasonal sales. About 2 emails a week.' },
    { key: 'smsPromotions', id: 'pf-pr-sms', title: 'SMS promotions', body: sms ? `Flash sales by text to ${sms}. Message rates may apply.` : 'Add a mobile phone above to get flash sales by text.' },
    { key: 'pushPromotions', id: 'pf-pr-push', title: 'Push promotions', body: 'Offers in the Marketly Android app. Set separately from order push notices.' },
  ];

  return (
    <AccountLayout active="profile" title="Profile">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Profile</h1>
          <p className="small sub">Your details and how we contact you.</p>
        </div>
      </div>
      {notice === 'saved' && <Alert tone="success" title="Changes saved" />}
      {notice === 'email-changed' && <Alert tone="success" title="Email changed">You now sign in and get order emails at {p?.email}.</Alert>}
      {pending && !emailFlow && (
        <Alert tone="info" title="Check your inbox">
          We sent a code to {pending}. Order emails keep going to your verified address until you confirm.
        </Alert>
      )}
      {saveProfile.isError && !Object.keys(fieldErrorsOf(saveProfile.error)).length && <Alert tone="danger" title="We couldn't save your changes">{errorMessage(saveProfile.error)}</Alert>}
      <Card
        title="Personal details"
        foot={
          <Button onClick={save} disabled={!form || (!dirty && !attempted) || saveProfile.isPending}>
            {saveProfile.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        }
      >
        {!form ? (
          <div className="grid md2 gap-4" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="stack gap-2">
                <span className="sk sk-line short" />
                <span className="sk sk-line" />
              </span>
            ))}
          </div>
        ) : (
          <div className="grid md2 gap-4">
            <Field label="First name" error={errors.first}>
              <TextInput id="pf-first" value={form.first} error={!!errors.first} onChange={(e) => set('first', e.target.value)} autoComplete="given-name" />
            </Field>
            <Field label="Last name" error={errors.last}>
              <TextInput id="pf-last" value={form.last} error={!!errors.last} onChange={(e) => set('last', e.target.value)} autoComplete="family-name" />
            </Field>
            <div className="field">
              <label className="label" htmlFor="pf-email">
                Email
              </label>
              <TextInput id="pf-email" type="email" value={form.email} error={!!errors.email} disabled={noPassword} aria-describedby={errors.email ? 'pf-email-err' : noPassword ? 'pf-email-nopw' : undefined} onChange={(e) => set('email', e.target.value)} autoComplete="email" />
              {noPassword && (
                <span className="xs muted" id="pf-email-nopw">
                  Changing your email is confirmed with a password. {NO_PASSWORD_NOTE}
                </span>
              )}
              {errors.email ? (
                <span className="error-text" id="pf-email-err">
                  <Icon name="circle-alert" className="ic-sm" />
                  {errors.email}
                </span>
              ) : p?.emailVerified ? (
                <span className="row gap-2 xs">
                  <Badge tone="info">Verified</Badge>
                  <span className="muted">{p.emailVerifiedAt ? `Verified ${dateLong(p.emailVerifiedAt)}. ` : ''}Changing it sends a code to the new address.</span>
                </span>
              ) : (
                <span className="row gap-2 xs">
                  <Badge tone="warning">Not verified</Badge>
                  <span className="muted">Enter the code we emailed to {p?.email}.</span>
                </span>
              )}
            </div>
            <Field label="Mobile phone" hint="Used for delivery problems and 2-step verification." error={errors.phone}>
              <PhoneInput id="pf-phone" value={form.phone} error={!!errors.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" />
            </Field>
          </div>
        )}
      </Card>
      {/* Order and account messages: what is always sent and where, plus app order updates (phase 3) */}
      <WhatWeSend />
      <Card title="Promotions and offers" titleAs="h3" sub="Optional. Turning these off never affects order updates.">
        {setPrefs.isError && <Alert tone="danger" title="We couldn't change that setting">{errorMessage(setPrefs.error)}</Alert>}
        {prefs.isError ? (
          <Alert tone="danger" title="We couldn't load your preferences">
            {errorMessage(prefs.error)}{' '}
            <Button variant="ghost" size="sm" onClick={() => void prefs.refetch()}>
              Try again
            </Button>
          </Alert>
        ) : (
          PROMOS.map((x) => <Pref key={x.key} id={x.id} title={x.title} body={x.body} checked={!!pr?.[x.key]} disabled={!pr || setPrefs.isPending} onChange={(v) => setPrefs.mutate({ [x.key]: v })} />)
        )}
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
          checked={!!pr?.recentSearches}
          disabled={!pr || setPrefs.isPending}
          onChange={(v) => setPrefs.mutate({ recentSearches: v })}
        />
      </Card>
      <div className="grid md2">
        <Card
          title="Download my data"
          titleAs="h3"
          foot={
            exportReady ? (
              <Button variant="secondary" icon="download" href={exportReady.downloadUrl!}>
                Download my data
              </Button>
            ) : (
              <Button variant="secondary" icon={exportOpen ? 'check' : 'download'} disabled={!!exportOpen || exportData.isPending || !requests.isSuccess} onClick={() => exportData.mutate()}>
                {exportOpen ? 'Data requested' : 'Request my data'}
              </Button>
            )
          }
        >
          {exportData.isError && <Alert tone="danger" title="We couldn't start the export">{errorMessage(exportData.error)}</Alert>}
          <p className="small sub">
            {exportReady
              ? `Your copy is ready${exportReady.expiresAt ? ` until ${dateLong(exportReady.expiresAt)}` : ''}. We also emailed the link to ${p?.email ?? 'you'}.`
              : exportOpen
                ? `Request received. We'll email a download link to ${p?.email ?? 'you'} by ${dateLong(latestExport!.dueBy)}.`
                : 'Get a copy of your profile, orders, returns, messages and reviews as a ZIP file. We email a link within 48 hours.'}
          </p>
        </Card>
        <Card
          title="Close account"
          titleAs="h3"
          foot={
            openClosure ? (
              <Button variant="secondary" onClick={() => cancelRequest.mutate(openClosure.id)} disabled={cancelRequest.isPending}>
                Keep my account
              </Button>
            ) : (
              <Button variant="danger-soft" disabled={!closure.data?.eligible || noPassword} onClick={() => (requestClosure.reset(), setClosing(true))}>
                Close account
              </Button>
            )
          }
        >
          {cancelRequest.isError && <Alert tone="danger" title="That didn't work">{errorMessage(cancelRequest.error)}</Alert>}
          {noPassword && !openClosure && <span className="xs muted">Closing your account is confirmed with a password. {NO_PASSWORD_NOTE}</span>}
          <p className="small sub">
            {openClosure
              ? `Closure requested. Your account closes ${openClosure.scheduledFor ? `on ${dateLong(openClosure.scheduledFor)}` : 'after the cooling-off period'} unless you keep it.`
              : closure.isPending
                ? 'Checking whether your account can be closed…'
                : closure.data?.eligible
                  ? 'You can close your account now. We keep order records as the law requires.'
                  : `You can close your account after open orders, returns and cases are finished.${blockers.length ? ` You have ${blockers.map((b) => b.detail.replace(/ still in progress$/, ' in progress')).join(', ')}.` : ''} We keep order records as the law requires.`}
          </p>
        </Card>
      </div>

      <Dialog
        open={!!emailFlow}
        onClose={cancelEmail}
        title="Change your email"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={cancelEmail}>
              Cancel
            </Button>
            {emailFlow?.step === 'code' ? (
              <Button onClick={() => emailFlow.challengeId && confirmEmail.mutate({ id: emailFlow.challengeId, c: code.trim() })} disabled={!code.trim() || confirmEmail.isPending}>
                Confirm
              </Button>
            ) : (
              <Button onClick={() => emailFlow && startEmailChange.mutate({ newEmail: emailFlow.newEmail, pw: password })} disabled={!password || startEmailChange.isPending}>
                Send code
              </Button>
            )}
          </>
        }
      >
        {emailFlow?.step === 'code' ? (
          <>
            <p className="small sub">
              We sent a {emailFlow.codeLength ?? 6}-digit code to {emailFlow.masked ?? emailFlow.newEmail}. Enter it to finish. Until then you keep signing in with {saved?.email}.
            </p>
            <Field label="Code" error={confirmEmail.isError ? errorMessage(confirmEmail.error) : undefined}>
              <TextInput id="pf-email-code" inputMode="numeric" autoComplete="one-time-code" maxLength={emailFlow.codeLength ?? 6} value={code} error={confirmEmail.isError} onChange={(e) => (setCode(e.target.value), confirmEmail.reset())} />
            </Field>
            <Button variant="ghost" size="sm" onClick={() => emailFlow.challengeId && resend.mutate(emailFlow.challengeId)} disabled={resend.isPending}>
              Send a new code
            </Button>
            {resend.isError && <span className="hint">{errorMessage(resend.error)}</span>}
            {resend.isSuccess && <span className="hint">New code sent.</span>}
          </>
        ) : (
          <>
            <p className="small sub">To change your sign-in email to {emailFlow?.newEmail}, confirm it's you. We'll then send a code to the new address.</p>
            {startEmailChange.isError && !(startEmailChange.error instanceof ApiError && startEmailChange.error.code === 'CURRENT_PASSWORD_WRONG') && (
              <Alert tone="danger" title="We couldn't change your email">
                {startEmailChange.error instanceof ApiError && startEmailChange.error.code === 'EMAIL_IN_USE' ? 'Another account uses that email.' : errorMessage(startEmailChange.error)}
              </Alert>
            )}
            <ReauthField
              id="pf-email-pw"
              value={password}
              onChange={(v) => (setPassword(v), startEmailChange.reset())}
              error={startEmailChange.error instanceof ApiError && startEmailChange.error.code === 'CURRENT_PASSWORD_WRONG' ? reauthError(startEmailChange.error) : undefined}
            />
          </>
        )}
      </Dialog>

      <Dialog
        open={closing}
        onClose={() => setClosing(false)}
        title="Close your account?"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setClosing(false)}>
              Keep my account
            </Button>
            <Button variant="danger" onClick={() => requestClosure.mutate()} disabled={!closePw || requestClosure.isPending}>
              Close account
            </Button>
          </>
        }
      >
        <p className="small sub">
          We keep {(closure.data?.retainedRecords ?? ['order records']).join(', ').toLowerCase()} as the law requires. You can change your mind during the cooling-off period.
        </p>
        <ReauthField id="pf-close-pw" value={closePw} onChange={(v) => (setClosePw(v), requestClosure.reset())} error={reauthError(requestClosure.error)} />
        <Field label="Why are you leaving?" optional>
          <Textarea id="pf-close-reason" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} />
        </Field>
      </Dialog>
    </AccountLayout>
  );
}
