import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, call, errorMessage, useApi, type SessionTokens } from '@marketly/web-shared/api';
import { Logo } from '@marketly/web-shared/layouts';
import { Alert, Button, Field, TextInput } from '@marketly/web-shared/ui';

// Admin and Operations Center sign-in (designed in React; no design file). Staff accounts are invite-only and,
// on the offline server, sign in with email and password only (no 2-step; sensitive actions ask for the password
// again). A sign-in that answers password_reset_required continues on /reset-password with the token in memory.
// No "Forgot password?" form: it would send an email, which never arrives offline.

type Result = {
  status: 'signed_in' | 'second_factor_required' | 'password_reset_required' | 'seller_context_required';
  tokens?: SessionTokens | null;
  passwordResetToken?: string | null;
};

/** The device the session belongs to (the installation id the session layer keeps). */
export const device = () => {
  let installationId: string | undefined;
  try {
    installationId = localStorage.getItem('marketly.installationId') ?? undefined;
  } catch {
    /* private mode */
  }
  return { kind: 'web' as const, ...(installationId ? { installationId } : {}) };
};

/** The centred card the public staff pages share (sign-in, invitation, reset password). */
export function AuthFrame({ title, children, foot }: { title: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="bo">
      {/* No sidebar here: span both columns of the back-office grid (from 1024px it reserves the sidebar column). */}
      <main className="bo-content" id="main" tabIndex={-1} style={{ gridColumn: '1 / -1' }}>
        <div className="buy-auth stack gap-4" style={{ marginInline: 'auto', paddingBlock: 'var(--sp-8)' }}>
          <div className="row between">
            <Logo area="Admin Center" home="admin/dashboard" />
          </div>
          <section className="card">
            <div className="card-body stack gap-4">
              <h1 className="h2">{title}</h1>
              {children}
            </div>
          </section>
          {foot}
        </div>
      </main>
    </div>
  );
}

/** Starting the session failed: off the office network the server asks for an app proof this browser can't give. */
const offNetwork = (e: unknown) => e instanceof ApiError && e.code === 'APP_PROOF_INVALID';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CREDENTIALS') {
      const left = e.details.attemptsLeft as number | undefined;
      return `That email and password don't match a staff account.${left != null ? ` ${left} ${left === 1 ? 'try' : 'tries'} left before sign-in pauses.` : ''}`;
    }
    if (e.code === 'ACCOUNT_LOCKED') return 'Sign-in is paused for this account. Ask a Platform Administrator to unlock it.';
    if (e.code === 'ACCOUNT_DISABLED') return 'This staff account is disabled. Ask a Platform Administrator.';
    if (offNetwork(e)) return 'Open the Admin Center from the office network.';
  }
  return errorMessage(e);
}

/** notice: why the person is on this screen without signing out (e.g. signed out after a period without activity). */
export function SignIn({ startError, notice }: { startError?: unknown; notice?: string }) {
  const { api, session } = useApi();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return setError('Enter your work email and password.');
    setBusy(true);
    setError('');
    try {
      const r = (await call(
        api.POST('/api/public/identity/sessions', { body: { email: email.trim(), password, audience: 'admin', keepSignedIn: false, device: device() }, credentials: 'include' }),
      )) as Result;
      if (r.status === 'password_reset_required' && r.passwordResetToken) {
        // Continue on the reset page; the token travels in router state, never in the URL.
        navigate('/reset-password', { state: { resetToken: r.passwordResetToken, email: email.trim() } });
      } else if (r.tokens) {
        session.adopt(r.tokens);
      } else {
        setError('This account can’t sign in to the Admin Center.');
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in to the Admin Center">
      {offNetwork(startError) ? (
        <Alert tone="warning" title="Open the Admin Center from the office network">
          This server only accepts staff browsers on the local network. Connect to the office network (or its VPN) and reload.
        </Alert>
      ) : (
        <form className="stack gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <p className="small sub">Staff only. Use the work email you were invited with.</p>
          {notice && !error && <Alert tone="info">{notice}</Alert>}
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
          <p className="xs muted">Forgot your password? Ask your administrator for a reset link.</p>
          {import.meta.env.DEV && <p className="xs muted">Development: seeded staff passwords are in web-shared/.seed/state.json.</p>}
        </form>
      )}
    </AuthFrame>
  );
}
