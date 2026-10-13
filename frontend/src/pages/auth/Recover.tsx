import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Checkbox, Field, Icon, TextInput, announce } from '@marketly/web-shared/ui';
import { AuthShell, DevOutboxHint, EMAIL_RE, PasswordInput, PolicyRules, authError, mss, passwordChecks, useHashToken, useNextQuery, useSecondsUntil } from './data/parts';

// Design: pages/store/auth-recover.html
//   view "check-your-email" = after "Send reset link" (POST /api/public/identity/password-resets, always 202)
//   view "set-new-password" = opened from the emailed link ${STORE_URL}/reset-password#token=… (routes/email-links.tsx
//                             keeps the fragment) or from a sign-in that answered password_reset_required.
//                             The token is checked (…/lookups) and spent (…/complete) in request bodies only.
// New passwords are never prefilled.

type View = 'check-your-email' | 'set-new-password';
type ResetRequested = { emailMasked: string; expiresInMinutes: number; resendAvailableAt: string };

export default function Recover() {
  const [view, setView] = useView<View>();
  const st = (useLocation().state ?? null) as { email?: string } | null;
  const token = useHashToken();
  const [email, setEmail] = useState(st?.email ?? '');
  const [sent, setSent] = useState<ResetRequested | null>(null);

  // "Check your email" shows what the server answered; opened without a request it falls back to the form.
  useEffect(() => {
    if (view === 'check-your-email' && !sent) setView('', { replace: true });
  }, [view, sent, setView]);

  if (view === 'set-new-password') return <SetPassword token={token} onNewLink={() => setView('')} />;
  if (view === 'check-your-email' && sent) return <CheckEmail email={email} sent={sent} onSent={setSent} onDifferent={() => setView('')} />;
  return (
    <RequestLink
      email={email}
      setEmail={setEmail}
      onSent={(r) => {
        setSent(r);
        setView('check-your-email');
      }}
    />
  );
}

/** POST /api/public/identity/password-resets */
function useRequestReset(onSent: (r: ResetRequested) => void) {
  const { api } = useApi();
  return useMutation({
    mutationFn: (email: string) => call(api.POST('/api/public/identity/password-resets', { body: { email } })),
    onSuccess: onSent,
  });
}

function RequestLink({ email, setEmail, onSent }: { email: string; setEmail: (v: string) => void; onSent: (r: ResetRequested) => void }) {
  const [error, setError] = useState('');
  const request = useRequestReset(onSent);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter the email you use for Marketly, like name@example.com.');
      return;
    }
    if (!request.isPending) request.mutate(email.trim());
  };
  return (
    <AuthShell title="Reset password" back={href('auth/sign-in')} onSubmit={submit}>
      <div className="stack gap-1">
        <h1 className="h2">Forgot your password?</h1>
        <p className="small sub">Enter the email you use for Marketly. We'll send a link to set a new password.</p>
      </div>
      {request.isError && <Alert tone="danger" title="We couldn't send the link">{authError(request.error)}</Alert>}
      <Field label="Email" error={error}>
        <TextInput
          id="rc-email"
          type="email"
          value={email}
          error={!!error}
          autoComplete="email"
          onChange={(e) => {
            setEmail(e.target.value);
            setError('');
          }}
        />
      </Field>
      <Button type="submit" size="lg" block disabled={request.isPending}>
        {request.isPending ? 'Sending…' : 'Send reset link'}
      </Button>
      <p className="xs muted">For your security, we don't say whether an account exists for an email address.</p>
      <div className="row between small">
        <Link to={href('auth/sign-in')} state={{ email: email.trim() }}>
          Back to sign in
        </Link>
        <Link to={href('auth/guest-orders')}>Find a guest order</Link>
      </div>
    </AuthShell>
  );
}

function CheckEmail({ email, sent, onSent, onDifferent }: { email: string; sent: ResetRequested; onSent: (r: ResetRequested) => void; onDifferent: () => void }) {
  const left = useSecondsUntil(sent.resendAvailableAt);
  const resend = useRequestReset((r) => {
    onSent(r);
    announce(`We sent another link to ${r.emailMasked}`);
  });
  return (
    <AuthShell title="Reset password" back={href('auth/sign-in')}>
      <span className="buy-result-icon t-info">
        <Icon name="mail" />
      </span>
      <div className="stack gap-1">
        <h1 className="h2">Check your email</h1>
        <p className="small sub">
          If an account uses <b>{sent.emailMasked}</b>, we sent a link to reset the password.
        </p>
      </div>
      <ul className="ul small sub stack gap-1">
        <li>The link works once and expires in {sent.expiresInMinutes} minutes.</li>
        <li>Open it on any device. You'll set a new password there.</li>
        <li>Not there? Check spam or promotions folders.</li>
      </ul>
      {resend.isError && <Alert tone="danger" title="We couldn't send another link">{authError(resend.error)}</Alert>}
      <Button variant="secondary" block disabled={left > 0 || resend.isPending} onClick={() => resend.mutate(email.trim())}>
        {left > 0 ? `Resend link (available in ${mss(left)})` : resend.isPending ? 'Sending…' : 'Resend link'}
      </Button>
      <div className="row between small">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onDifferent();
          }}
        >
          Use a different email
        </a>
        <Link to={href('auth/sign-in')}>Back to sign in</Link>
      </div>
      <p className="xs muted">Still stuck? Call 1-800-555-0136, Mon–Sat 8 AM–8 PM PT.</p>
      <DevOutboxHint what="reset link" />
    </AuthShell>
  );
}

function SetPassword({ token, onNewLink }: { token: string | null; onNewLink: () => void }) {
  const { api } = useApi();
  const navigate = useNavigate();
  const nextQuery = useNextQuery();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState('');
  const [linkSpent, setLinkSpent] = useState(false);

  // POST …/password-resets/lookups: is the link still valid, whose account, and the password policy.
  const lookup = useQuery({
    queryKey: ['identity', 'password-reset', token],
    queryFn: () => call(api.POST('/api/public/identity/password-resets/lookups', { body: { token: token ?? '' } })),
    enabled: !!token,
    staleTime: Infinity,
    gcTime: 0,
  });
  const status = lookup.data;
  const checks = passwordChecks(pw, [], status?.policy);
  const allOk = checks.length > 0 && checks.every((c) => c.ok);
  const match = confirm.length > 0 && confirm === pw;
  const pwError = serverError || (tried && !allOk ? (pw ? 'Your new password needs to meet every rule below.' : 'Enter a new password.') : undefined);
  const confirmError = tried && !match ? (confirm ? "Passwords don't match." : 'Enter the new password again.') : confirm && !match && confirm.length >= pw.length ? "Passwords don't match." : undefined;

  const complete = useMutation({
    mutationFn: () => call(api.POST('/api/public/identity/password-resets/complete', { body: { token: token ?? '', newPassword: pw, signOutOtherDevices: signOutOthers } })),
    onSuccess: () => {
      announce(`Password changed${signOutOthers ? '. Other devices are signed out.' : ''} Sign in with your new password.`);
      navigate(href('auth/sign-in', undefined, undefined, nextQuery), { replace: true, state: { passwordChanged: true } });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'RESET_LINK_INVALID') setLinkSpent(true);
      else if (e instanceof ApiError && (e.code === 'WEAK_PASSWORD' || e.code === 'PASSWORD_REUSED')) setServerError(authError(e));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!allOk || !match || complete.isPending) return;
    complete.mutate();
  };

  // No token, an invalid or used link: offer a new one (the design has no state for this; same card).
  if (!token || linkSpent || (status && !status.valid))
    return (
      <AuthShell title="New password" back={href('auth/sign-in')}>
        <span className="buy-result-icon t-info">
          <Icon name="link" />
        </span>
        <div className="stack gap-1">
          <h1 className="h2">This link doesn't work anymore</h1>
          <p className="small sub">{!token ? 'Open the reset link from your email to set a new password here.' : 'Reset links work once and expire after 30 minutes. A newer link replaces older ones.'}</p>
        </div>
        <Button size="lg" block onClick={onNewLink}>
          Send a new link
        </Button>
        <div className="row between small">
          <Link to={href('auth/sign-in')}>Back to sign in</Link>
        </div>
      </AuthShell>
    );

  if (lookup.isError)
    return (
      <AuthShell title="New password" back={href('auth/sign-in')}>
        <Alert tone="danger" title="We couldn't check your reset link">
          {errorMessage(lookup.error)}
        </Alert>
        <Button size="lg" block onClick={() => void lookup.refetch()}>
          Try again
        </Button>
      </AuthShell>
    );

  return (
    <AuthShell title="New password" back={href('auth/sign-in')} onSubmit={submit}>
      <div className="stack gap-1">
        <h1 className="h2">Set a new password</h1>
        {status ? (
          <p className="small sub">
            For {status.emailMasked}
            {status.forced ? '. Your account needs a new password before you can sign in.' : ''}
          </p>
        ) : (
          <span className="sk sk-line" aria-hidden="true" />
        )}
      </div>
      {complete.isError && !serverError && !linkSpent && <Alert tone="danger" title="We couldn't save your new password">{authError(complete.error)}</Alert>}
      <div className="field">
        <div className="row between">
          <label className="label" htmlFor="rc-new">
            New password
          </label>
        </div>
        <PasswordInput
          id="rc-new"
          value={pw}
          onChange={(v) => {
            setPw(v);
            setServerError('');
          }}
          error={!!pwError}
          describedBy={pwError ? 'rc-new-err' : undefined}
          autoComplete="new-password"
        />
        {pwError && (
          <span className="error-text" id="rc-new-err">
            <Icon name="circle-alert" className="ic-sm" />
            {pwError}
          </span>
        )}
      </div>
      <PolicyRules loading={lookup.isPending} error={null} onRetry={() => void lookup.refetch()} checks={checks} />
      <div className="field">
        <div className="row between">
          <label className="label" htmlFor="rc-confirm">
            Confirm new password
          </label>
        </div>
        <PasswordInput
          id="rc-confirm"
          value={confirm}
          onChange={setConfirm}
          error={!!confirmError}
          describedBy={confirmError ? 'rc-confirm-err' : match ? 'rc-confirm-hint' : undefined}
          autoComplete="new-password"
        />
        {confirmError ? (
          <span className="error-text" id="rc-confirm-err">
            <Icon name="circle-alert" className="ic-sm" />
            {confirmError}
          </span>
        ) : match ? (
          <span className="hint" id="rc-confirm-hint">
            Passwords match.
          </span>
        ) : null}
      </div>
      <Checkbox id="rc-signout" label="Sign me out on all other devices" checked={signOutOthers} onChange={(e) => setSignOutOthers(e.target.checked)} />
      <Button type="submit" size="lg" block disabled={!status || complete.isPending}>
        {complete.isPending ? 'Saving…' : 'Save new password'}
      </Button>
      <p className="xs muted">We'll email you to confirm the change. If you didn't ask for this, contact support right away.</p>
    </AuthShell>
  );
}
