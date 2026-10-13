import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError, call, errorMessage, useApi, useSessionState, type SessionTokens } from '@marketly/web-shared/api';
import { Logo } from '@marketly/web-shared/layouts';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Checkbox, Dialog, Field, TextInput } from '@marketly/web-shared/ui';
import { StorePicker, type SellerContextItem } from './session';

// Seller Center sign-in (designed in React; no design file). Seller members sign in with their Marketly
// account (the same login as the store), answer 2-step if it's on, and pick a store when they belong to
// several. Development: "Continue with Google" uses the backend's dev ID token (seeded sellers have no password).

type Result = {
  status: 'signed_in' | 'second_factor_required' | 'seller_context_required' | 'password_reset_required';
  tokens?: SessionTokens | null;
  challenge?: { id: string; methods: Array<'totp' | 'sms' | 'recovery_code'> } | null;
  sellerContexts: SellerContextItem[];
};

const device = () => {
  let installationId: string | undefined;
  try {
    installationId = localStorage.getItem('marketly.installationId') ?? undefined;
  } catch {
    /* private mode */
  }
  return { kind: 'web' as const, ...(installationId ? { installationId } : {}) };
};

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CREDENTIALS') {
      const left = e.details.attemptsLeft as number | undefined;
      return `That email and password don't match.${left != null ? ` ${left} ${left === 1 ? 'try' : 'tries'} left before sign-in pauses.` : ''}`;
    }
    if (e.code === 'ACCOUNT_LOCKED') return 'Sign-in is paused for this account. Try again later or reset your password.';
    if (e.code === 'NO_SELLER_ACCESS') return 'This account isn’t a member of any seller. Apply to sell, or ask the store owner to invite you.';
    if (e.code === 'CODE_INVALID') return 'That code didn’t work. Check it and try again.';
  }
  return errorMessage(e);
}

export function SignIn() {
  const { api, session } = useApi();
  const state = useSessionState();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(true);
  const [challenge, setChallenge] = useState<Result['challenge']>(null);
  const [code, setCode] = useState('');
  const [method, setMethod] = useState<'totp' | 'recovery_code'>('totp');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [devOpen, setDevOpen] = useState(false);
  const [dev, setDev] = useState({ email: '', first: '', last: '' });

  // Signed in without a store yet (several stores, or after a fresh sign-in): choose one.
  const needsStore = state.kind === 'seller' && !state.claims?.sellerId;
  const contexts = useQuery({
    queryKey: ['identity', 'sellers', 'pick'],
    queryFn: () => call(api.GET('/api/seller/identity/session/sellers')) as Promise<SellerContextItem[]>,
    enabled: needsStore,
  });

  const handle = async (r: Result) => {
    if (r.status === 'second_factor_required' && r.challenge) {
      setChallenge(r.challenge);
      setMethod(r.challenge.methods.includes('totp') ? 'totp' : 'recovery_code');
      return;
    }
    if (r.status === 'password_reset_required') {
      setError('Your password must be reset before you can sign in. Reset it from the store’s sign-in page.');
      return;
    }
    if (r.tokens) session.adopt(r.tokens);
    // One store: pick it straight away; several: the picker shows (needsStore).
    if (r.status === 'seller_context_required' && r.sellerContexts.length === 1) await pick(r.sellerContexts[0].sellerId);
  };

  const run = async (fn: () => Promise<Result>) => {
    setBusy(true);
    setError('');
    try {
      await handle(await fn());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return setError('Enter your email and password.');
    void run(() => call(api.POST('/api/public/identity/sessions', { body: { email: email.trim(), password, audience: 'seller', keepSignedIn: keep, device: device() }, credentials: 'include' })) as Promise<Result>);
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    const c = code.replace(/[\s-]/g, '');
    if (!c) return setError(method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes.');
    void run(() => call(api.POST('/api/public/identity/sign-in-challenges/{id}/verify', { params: { path: { id: challenge.id } }, body: { method, code: c, rememberDevice: false, device: device() } as never, credentials: 'include' })) as Promise<Result>);
  };

  const devSignIn = (e: FormEvent) => {
    e.preventDefault();
    if (!dev.email.trim()) return;
    const names = dev.first || dev.last ? `:${dev.first}:${dev.last}` : '';
    setDevOpen(false);
    void run(() => call(api.POST('/api/public/identity/external-sign-ins', { body: { provider: 'google', idToken: `dev:${dev.email.trim()}${names}`, audience: 'seller', device: device(), marketingOptIn: false }, credentials: 'include' })) as Promise<Result>);
  };

  const pick = async (sellerId: string) => {
    setPicking(sellerId);
    setError('');
    try {
      const tokens = await call(api.POST('/api/seller/identity/session/seller-context', { body: { sellerId }, credentials: 'include' }));
      session.adopt(tokens as SessionTokens);
    } catch (e) {
      setError(message(e));
    } finally {
      setPicking(null);
    }
  };

  return (
    <div className="bo">
      {/* No sidebar here: span both columns of the back-office grid (from 1024px it reserves the sidebar column). */}
      <main className="bo-content" id="main" tabIndex={-1} style={{ gridColumn: '1 / -1' }}>
        <div className="buy-auth stack gap-4" style={{ marginInline: 'auto', paddingBlock: 'var(--sp-8)' }}>
          <div className="row between">
            <Logo area="Seller Center" home="seller/dashboard" />
          </div>
          <section className="card">
            {needsStore ? (
              <div className="card-body stack gap-4">
                <div className="stack gap-1">
                  <h1 className="h2">Choose a store</h1>
                  <p className="small sub">Your account can act for these stores. You can switch later from the top bar.</p>
                </div>
                {error && <Alert tone="danger">{error}</Alert>}
                {contexts.isLoading ? (
                  <div className="sk-list" aria-hidden="true">
                    <div className="sk-row"><span className="sk sk-thumb" /><span className="sk-lines"><span className="sk sk-line" /><span className="sk sk-line short" /></span></div>
                  </div>
                ) : (
                  <StorePicker contexts={contexts.data ?? []} onPick={(id) => void pick(id)} busy={picking} />
                )}
                <Button variant="ghost" size="sm" onClick={() => void session.signOut()}>
                  Use a different account
                </Button>
              </div>
            ) : challenge ? (
              <form className="card-body stack gap-4" onSubmit={verify} noValidate>
                <div className="stack gap-1">
                  <h1 className="h2">2-step verification</h1>
                  <p className="small sub">{method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of the recovery codes you saved when you turned on 2-step.'}</p>
                </div>
                {error && <Alert tone="danger">{error}</Alert>}
                <Field label={method === 'totp' ? 'Code' : 'Recovery code'}>
                  <TextInput id="sc-code" value={code} onChange={(e) => setCode(e.target.value)} inputMode={method === 'totp' ? 'numeric' : 'text'} autoComplete="one-time-code" />
                </Field>
                <Button type="submit" block disabled={busy}>
                  Verify and sign in
                </Button>
                {challenge.methods.includes('recovery_code') && challenge.methods.includes('totp') && (
                  <Button variant="link" onClick={() => { setMethod(method === 'totp' ? 'recovery_code' : 'totp'); setCode(''); setError(''); }}>
                    {method === 'totp' ? 'Use a recovery code instead' : 'Use the authenticator app'}
                  </Button>
                )}
              </form>
            ) : (
              <form className="card-body stack gap-4" onSubmit={submit} noValidate>
                <div className="stack gap-1">
                  <h1 className="h2">Sign in to Seller Center</h1>
                  <p className="small sub">Use the Marketly account the store owner invited, or the one you applied with.</p>
                </div>
                {error && <Alert tone="danger">{error}</Alert>}
                <Field label="Email">
                  <TextInput id="sc-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Password">
                  <TextInput id="sc-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
                <Checkbox id="sc-keep" label="Keep me signed in on this device" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
                <Button type="submit" block disabled={busy}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </Button>
                <Button variant="secondary" block icon="log-in" onClick={() => setDevOpen(true)} disabled={!import.meta.env.DEV || busy}>
                  Continue with Google
                </Button>
                {!import.meta.env.DEV && <p className="xs muted">Google sign-in isn’t available yet.</p>}
                <p className="small">
                  <Link to={href('auth/recover')}>Forgot your password?</Link>
                </p>
              </form>
            )}
          </section>
          <p className="small sub">
            Not selling on Marketly yet? <Link to={href('sell/landing')}>See how selling works</Link>
          </p>
        </div>
      </main>
      <Dialog
        open={devOpen}
        onClose={() => setDevOpen(false)}
        title="Development sign-in"
        foot={
          <>
            <Button variant="ghost" onClick={() => setDevOpen(false)}>
              Cancel
            </Button>
            <Button onClick={devSignIn as never}>Continue</Button>
          </>
        }
      >
        <p className="small sub">Google isn’t configured in development. Enter the email of a seller member: the backend’s dev ID token signs in to that account (for example a seeded store owner such as hannah@northwindaudio.example.com).</p>
        <form className="stack gap-3" onSubmit={devSignIn}>
          <Field label="Email">
            <TextInput id="sc-dev-email" type="email" value={dev.email} onChange={(e) => setDev({ ...dev, email: e.target.value })} />
          </Field>
          <div className="grid md2 gap-3">
            <Field label="First name" optional>
              <TextInput id="sc-dev-first" value={dev.first} onChange={(e) => setDev({ ...dev, first: e.target.value })} />
            </Field>
            <Field label="Last name" optional>
              <TextInput id="sc-dev-last" value={dev.last} onChange={(e) => setDev({ ...dev, last: e.target.value })} />
            </Field>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
