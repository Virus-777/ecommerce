import { useState, type FormEvent } from 'react';
import { ApiError, call, errorMessage, useApi, type SessionTokens } from '@marketly/web-shared/api';
import { Logo } from '@marketly/web-shared/layouts';
import { Alert, Button, Field, TextInput } from '@marketly/web-shared/ui';

// Admin and Operations Center sign-in (designed in React; no design file). Staff accounts are invite-only and
// always answer 2-step (authenticator code or a recovery code); staff sessions last at most 12 hours and are
// never remembered. Development: `npm run staff-code -- olivia` in web-shared prints the current code for a
// seeded staff account (password in web-shared/.seed/state.json).

type Result = {
  status: 'signed_in' | 'second_factor_required' | 'password_reset_required' | 'seller_context_required';
  tokens?: SessionTokens | null;
  challenge?: { id: string; methods: Array<'totp' | 'sms' | 'recovery_code'> } | null;
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
      return `That email and password don't match a staff account.${left != null ? ` ${left} ${left === 1 ? 'try' : 'tries'} left before sign-in pauses.` : ''}`;
    }
    if (e.code === 'ACCOUNT_LOCKED') return 'Sign-in is paused for this account. Ask a Platform Administrator to unlock it.';
    if (e.code === 'ACCOUNT_DISABLED') return 'This staff account is disabled. Ask a Platform Administrator.';
    if (e.code === 'CODE_INVALID') return 'That code didn’t work. Check it and try again.';
  }
  return errorMessage(e);
}

export function SignIn() {
  const { api, session } = useApi();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<Result['challenge']>(null);
  const [code, setCode] = useState('');
  const [method, setMethod] = useState<'totp' | 'recovery_code'>('totp');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<Result>) => {
    setBusy(true);
    setError('');
    try {
      const r = await fn();
      if (r.status === 'second_factor_required' && r.challenge) {
        setChallenge(r.challenge);
        setMethod(r.challenge.methods.includes('totp') ? 'totp' : 'recovery_code');
        setCode('');
      } else if (r.status === 'password_reset_required') {
        setError('Your password must be changed before you can sign in. Use the link in the email from Marketly, or ask a Platform Administrator.');
      } else if (r.tokens) {
        session.adopt(r.tokens);
      } else {
        setError('This account can’t sign in to the Admin Center.');
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return setError('Enter your work email and password.');
    void run(() => call(api.POST('/api/public/identity/sessions', { body: { email: email.trim(), password, audience: 'admin', keepSignedIn: false, device: device() }, credentials: 'include' })) as Promise<Result>);
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    const c = code.replace(/[\s-]/g, '');
    if (!c) return setError(method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your recovery codes.');
    void run(() => call(api.POST('/api/public/identity/sign-in-challenges/{id}/verify', { params: { path: { id: challenge.id } }, body: { method, code: c, rememberDevice: false, device: device() } as never, credentials: 'include' })) as Promise<Result>);
  };

  return (
    <div className="bo">
      {/* No sidebar here: span both columns of the back-office grid (from 1024px it reserves the sidebar column). */}
      <main className="bo-content" id="main" tabIndex={-1} style={{ gridColumn: '1 / -1' }}>
        <div className="buy-auth stack gap-4" style={{ marginInline: 'auto', paddingBlock: 'var(--sp-8)' }}>
          <div className="row between">
            <Logo area="Admin Center" home="admin/dashboard" />
          </div>
          <section className="card">
            {challenge ? (
              <form className="card-body stack gap-4" onSubmit={verify} noValidate>
                <div className="stack gap-1">
                  <h1 className="h2">2-step verification</h1>
                  <p className="small sub">{method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of the recovery codes you saved when you set up 2-step.'}</p>
                </div>
                {error && <Alert tone="danger">{error}</Alert>}
                <Field label={method === 'totp' ? 'Code' : 'Recovery code'}>
                  <TextInput id="ac-code" value={code} onChange={(e) => setCode(e.target.value)} inputMode={method === 'totp' ? 'numeric' : 'text'} autoComplete="one-time-code" autoFocus />
                </Field>
                <Button type="submit" block disabled={busy}>
                  {busy ? 'Checking…' : 'Verify and sign in'}
                </Button>
                {challenge.methods.includes('recovery_code') && challenge.methods.includes('totp') && (
                  <Button variant="link" onClick={() => { setMethod(method === 'totp' ? 'recovery_code' : 'totp'); setCode(''); setError(''); }}>
                    {method === 'totp' ? 'Use a recovery code instead' : 'Use the authenticator app'}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => { setChallenge(null); setError(''); }}>
                  Back
                </Button>
              </form>
            ) : (
              <form className="card-body stack gap-4" onSubmit={submit} noValidate>
                <div className="stack gap-1">
                  <h1 className="h2">Sign in to the Admin Center</h1>
                  <p className="small sub">Staff only. Use the work account you were invited with; you’ll confirm with 2-step verification.</p>
                </div>
                {error && <Alert tone="danger">{error}</Alert>}
                <Field label="Work email">
                  <TextInput id="ac-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Password">
                  <TextInput id="ac-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
                <Button type="submit" block disabled={busy}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </Button>
                <p className="xs muted">Forgot your password or lost your authenticator? Ask a Platform Administrator to reset it.</p>
                {import.meta.env.DEV && <p className="xs muted">Development: seeded staff passwords are in web-shared/.seed/state.json; run <code>npm run staff-code -- olivia</code> for the current code.</p>}
              </form>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
