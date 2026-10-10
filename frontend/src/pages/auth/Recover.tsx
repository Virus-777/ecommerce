import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSession } from '@/app/session';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Button, Checkbox, Field, Icon, TextInput, announce } from '@/ui';
import { AuthShell, EMAIL_RE, PasswordInput, PasswordRules, maskEmail, mss, passwordChecks, useResendTimer, useSignedOut } from './data/parts';

// Design: pages/store/auth-recover.html
//   view "check-your-email" = after "Send reset link"
//   view "set-new-password" = opened from the emailed link (no in-app step leads here)
// New passwords are never prefilled.

type View = 'check-your-email' | 'set-new-password';

export default function Recover() {
  const [view, setView] = useView<View>();
  const { customer } = useSession();
  const [email, setEmail] = useState(customer.email);
  useSignedOut();
  if (view === 'check-your-email') return <CheckEmail email={email} onDifferent={() => setView('')} />;
  if (view === 'set-new-password') return <SetPassword email={email} />;
  return <RequestLink email={email} setEmail={setEmail} onSent={() => setView('check-your-email')} />;
}

function RequestLink({ email, setEmail, onSent }: { email: string; setEmail: (v: string) => void; onSent: () => void }) {
  const [error, setError] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter the email you use for Marketly, like name@example.com.');
      return;
    }
    onSent();
  };
  return (
    <AuthShell title="Reset password" back={href('auth/sign-in')} onSubmit={submit}>
      <div className="stack gap-1">
        <h1 className="h2">Forgot your password?</h1>
        <p className="small sub">Enter the email you use for Marketly. We'll send a link to set a new password.</p>
      </div>
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
      <Button type="submit" size="lg" block>
        Send reset link
      </Button>
      <p className="xs muted">For your security, we don't say whether an account exists for an email address.</p>
      <div className="row between small">
        <Link to={href('auth/sign-in')}>Back to sign in</Link>
        <Link to={href('auth/guest-orders')}>Find a guest order</Link>
      </div>
    </AuthShell>
  );
}

function CheckEmail({ email, onDifferent }: { email: string; onDifferent: () => void }) {
  const [left, restart] = useResendTimer(51);
  return (
    <AuthShell title="Reset password" back={href('auth/sign-in')}>
      <span className="buy-result-icon t-info">
        <Icon name="mail" />
      </span>
      <div className="stack gap-1">
        <h1 className="h2">Check your email</h1>
        <p className="small sub">
          If an account uses <b>{maskEmail(email)}</b>, we sent a link to reset the password.
        </p>
      </div>
      <ul className="ul small sub stack gap-1">
        <li>The link works once and expires in 30 minutes.</li>
        <li>Open it on any device. You'll set a new password there.</li>
        <li>Not there? Check spam or promotions folders.</li>
      </ul>
      <Button
        variant="secondary"
        block
        disabled={left > 0}
        onClick={() => {
          restart();
          announce(`We sent another link to ${maskEmail(email)}`);
        }}
      >
        {left > 0 ? `Resend link (available in ${mss(left)})` : 'Resend link'}
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
    </AuthShell>
  );
}

function SetPassword({ email }: { email: string }) {
  const navigate = useNavigate();
  const { customer } = useSession();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [tried, setTried] = useState(false);
  const checks = passwordChecks(pw, [customer.first, customer.name.split(' ')[1] ?? '', email.split('@')[0]]);
  const allOk = checks.every((c) => c.ok);
  const match = confirm.length > 0 && confirm === pw;
  const pwError = tried && !allOk ? (pw ? 'Your new password needs to meet every rule below.' : 'Enter a new password.') : undefined;
  const confirmError = tried && !match ? (confirm ? "Passwords don't match." : 'Enter the new password again.') : confirm && !match && confirm.length >= pw.length ? "Passwords don't match." : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!allOk || !match) return;
    announce(`Password changed${signOutOthers ? '. Other devices are signed out.' : ''} Sign in with your new password.`);
    navigate(href('auth/sign-in'));
  };

  return (
    <AuthShell title="New password" back={href('auth/sign-in')} onSubmit={submit}>
      <div className="stack gap-1">
        <h1 className="h2">Set a new password</h1>
        <p className="small sub">For {maskEmail(email)}</p>
      </div>
      <div className="field">
        <div className="row between">
          <label className="label" htmlFor="rc-new">
            New password
          </label>
        </div>
        <PasswordInput id="rc-new" value={pw} onChange={setPw} error={!!pwError} describedBy={pwError ? 'rc-new-err' : undefined} autoComplete="new-password" />
        {pwError && (
          <span className="error-text" id="rc-new-err">
            <Icon name="circle-alert" className="ic-sm" />
            {pwError}
          </span>
        )}
      </div>
      <PasswordRules checks={checks} />
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
      <Button type="submit" size="lg" block>
        Save new password
      </Button>
      <p className="xs muted">We'll email you to confirm the change. If you didn't ask for this, contact support right away.</p>
    </AuthShell>
  );
}
