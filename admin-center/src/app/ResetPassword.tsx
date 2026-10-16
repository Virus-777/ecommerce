import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError, call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { Alert, Button, Field, TextInput } from '@marketly/web-shared/ui';
import { AuthFrame } from './SignIn';
import { checkPassword, passwordError, PasswordRules, useHashToken } from './passwords';

// /reset-password (designed in React; no design file): set a new password from a reset token, then sign in.
// Case 1, a link: `npm run staff-link -- --email …` prints /reset-password#token=… (30 minutes).
// Case 2, sign-in: POST /sessions answered password_reset_required with passwordResetToken; the sign-in page
// passes that token here in router state (never the URL) and the lookup is skipped.
// API: POST /api/public/identity/password-resets/lookups { token } → PasswordResetStatus;
//      POST /api/public/identity/password-resets/complete { token, newPassword, signOutOtherDevices } → 204.
// No self-service "Forgot password?" form: it sends an email, which never arrives offline.

type ResetStatus = components['schemas']['identity.PasswordResetStatus'];

export default function ResetPassword() {
  const { api } = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const fromSignIn = (location.state as { resetToken?: string; email?: string } | null) ?? null;
  const hashToken = useHashToken();
  const token = fromSignIn?.resetToken ?? hashToken;

  const status = useQuery({
    queryKey: ['identity', 'password-reset', token],
    queryFn: () => call(api.POST('/api/public/identity/password-resets/lookups', { body: { token } })) as Promise<ResetStatus>,
    enabled: !!token && !fromSignIn?.resetToken,
    retry: false,
    staleTime: Infinity,
  });
  const st = status.data;

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [gone, setGone] = useState(false);
  const [done, setDone] = useState(false);

  const personal = fromSignIn?.email ? [fromSignIn.email.split('@')[0]] : [];
  const problems = {
    password: checkPassword(password, st?.policy, personal).join(' '),
    confirm: confirm !== password ? 'The passwords don’t match.' : '',
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problems.password || problems.confirm) return;
    setBusy(true);
    setError('');
    try {
      await call(api.POST('/api/public/identity/password-resets/complete', { body: { token, newPassword: password, signOutOtherDevices: true } }));
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'RESET_LINK_INVALID' || err.status === 410)) setGone(true);
      else setError(passwordError(err, st?.policy));
    } finally {
      setBusy(false);
    }
  };

  const expired = gone || (st && !st.valid) || (status.error instanceof ApiError && (status.error.code === 'RESET_LINK_INVALID' || status.error.status === 410));

  return (
    <AuthFrame title={done ? 'Password changed' : 'Choose a new password'}>
      {done ? (
        <div className="stack gap-4">
          <Alert tone="success" title="Password changed">
            Sign in with your new password. You were signed out on your other devices.
          </Alert>
          <Button block onClick={() => navigate('/', { replace: true })}>
            Go to sign in
          </Button>
        </div>
      ) : !token ? (
        <Alert tone="danger" title="This link is incomplete">
          Open the full reset link you were given. It ends with <code>#token=…</code>.
        </Alert>
      ) : status.isFetching && !st ? (
        <div className="sk-list" aria-label="Checking the link">
          <div className="sk-row">
            <span className="sk-lines">
              <span className="sk sk-line" />
              <span className="sk sk-line short" />
            </span>
          </div>
        </div>
      ) : expired ? (
        <div className="stack gap-3">
          <Alert tone="danger" title="This link can’t be used">
            This link was used, replaced or has expired. Ask the server operator for a new one.
          </Alert>
          <Link to="/" className="small">
            Back to sign in
          </Link>
        </div>
      ) : status.isError ? (
        <Alert tone="danger" title="We couldn’t check this link">
          {errorMessage(status.error)}
        </Alert>
      ) : (
        <form className="stack gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <p className="small sub">
            {fromSignIn?.resetToken ? 'Your password must be changed before you can sign in.' : st?.emailMasked ? `New password for ${st.emailMasked}.` : 'Choose a new password.'}
            {st?.forced && ' An administrator asked for a new password.'}
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="New password" error={tried ? problems.password : undefined}>
            <TextInput id="rp-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </Field>
          <PasswordRules policy={st?.policy} password={password} />
          <Field label="Confirm the password" error={tried ? problems.confirm : undefined}>
            <TextInput id="rp-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Button type="submit" block disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </Button>
          <Link to="/" className="small">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthFrame>
  );
}
