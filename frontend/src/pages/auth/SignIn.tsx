import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSession } from '@/app/session';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Button, Checkbox, Icon, TextInput, announce } from '@/ui';
import { AuthShell, CodeInput, EMAIL_RE, PasswordInput, emptyCode, maskEmail, mss, useResendTimer, useSignedOut } from './data/parts';

// Design: pages/store/auth-sign-in.html
//   view "wrong-password" = the email and password don't match (any password under 8 characters, in this mock)
//   view "two-step-code"  = the code step after a correct password; any 6 digits sign in
// Passwords and codes are never prefilled.

type View = 'wrong-password' | 'two-step-code';
const MIN_PASSWORD = 8;
const MAX_ATTEMPTS = 3;

export default function SignIn() {
  const [view, setView] = useView<View>();
  const { customer } = useSession();
  const [email, setEmail] = useState(customer.email);
  useSignedOut();
  return view === 'two-step-code' ? <TwoStep email={email} onBack={() => setView('')} /> : <Credentials email={email} setEmail={setEmail} wrong={view === 'wrong-password'} setView={setView} />;
}

function Credentials({ email, setEmail, wrong, setView }: { email: string; setEmail: (v: string) => void; wrong: boolean; setView: (v: View | '', o?: { replace?: boolean }) => void }) {
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(true);
  // The design's wrong-password state is the first failure: 2 attempts left.
  const [attemptsLeft, setAttemptsLeft] = useState(wrong ? MAX_ATTEMPTS - 1 : MAX_ATTEMPTS);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const paused = attemptsLeft <= 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (paused) return;
    const next: typeof errors = {};
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter the email address for your account, like name@example.com.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    if (next.email || next.password) return;
    if (password.length < MIN_PASSWORD) {
      setAttemptsLeft((n) => n - 1);
      setPassword('');
      setView('wrong-password', { replace: true });
      announce("That email and password don't match");
      return;
    }
    setView('two-step-code');
  };

  const pwError = errors.password ?? (wrong && !paused ? 'Incorrect password for this email.' : undefined);

  return (
    <AuthShell
      title="Sign in"
      onSubmit={submit}
      after={
        <p className="xs muted center u-mt-sp-4">
          <Link to={href('info/policy', 'privacy')}>Privacy</Link> · <Link to={href('info/policy', 'purchase-terms')}>Purchase terms</Link> · <Link to={href('help/center')}>Help</Link>
        </p>
      }
    >
      <div className="stack gap-1">
        <h1 className="h2 acct-h1">Sign in to Marketly</h1>
        <p className="small sub">Track orders, start returns and check out faster.</p>
      </div>
      {paused ? (
        <Alert tone="danger" title="Sign-in is paused for 15 minutes">
          There were too many incorrect passwords for this email. Try again after 15 minutes, or reset your password now.
        </Alert>
      ) : (
        wrong && (
          <Alert tone="danger" title="That email and password don't match">
            Check your password and try again, or reset it. You have <b>{attemptsLeft === 1 ? '1 attempt' : `${attemptsLeft} attempts`} left</b> before sign-in pauses for 15 minutes to protect your account.
          </Alert>
        )
      )}
      <div className="field">
        <label className="label" htmlFor="si-email">
          Email
        </label>
        <TextInput id="si-email" type="email" value={email} error={!!errors.email} autoComplete="username" aria-describedby={errors.email ? 'si-email-err' : undefined} onChange={(e) => setEmail(e.target.value)} />
        {errors.email && (
          <span className="error-text" id="si-email-err">
            <Icon name="circle-alert" className="ic-sm" />
            {errors.email}
          </span>
        )}
      </div>
      <div className="field">
        <div className="row between">
          <label className="label" htmlFor="si-pass">
            Password
          </label>
          <Link className="small" to={href('auth/recover')}>
            Forgot password?
          </Link>
        </div>
        <PasswordInput id="si-pass" value={password} onChange={setPassword} error={!!pwError} describedBy={pwError ? 'si-pass-err' : undefined} />
        {pwError && (
          <span className="error-text" id="si-pass-err">
            <Icon name="circle-alert" className="ic-sm" />
            {pwError}
          </span>
        )}
      </div>
      <Checkbox id="si-keep" label="Keep me signed in on this device" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
      <Button type="submit" size="lg" block disabled={paused}>
        Sign in
      </Button>
      {(wrong || paused) && (
        <Button variant="soft" block icon="key-round" to={href('auth/recover')}>
          Reset your password
        </Button>
      )}
      <div className="buy-or">or</div>
      <div className="stack gap-2">
        <Button variant="secondary" block onClick={() => announce('Google sign-in opens in a new window')}>
          Continue with Google
        </Button>
        <Button variant="secondary" block onClick={() => announce('Apple sign-in opens in a new window')}>
          Continue with Apple
        </Button>
      </div>
      <p className="small center">
        New to Marketly?{' '}
        <Link className="strong link-inline" to={href('auth/register')}>
          Create an account
        </Link>
      </p>
      <div className="panel row gap-3 nowrap">
        <Icon name="shopping-cart" />
        <div className="stack gap-0 grow">
          <span className="small strong">Checking out?</span>
          <span className="xs muted">No account needed. We'll email a link to manage your order.</span>
        </div>
        <Link className="small strong nowrap" to={href('store/checkout', 'guest-checkout')}>
          Continue as guest
        </Link>
      </div>
    </AuthShell>
  );
}

function TwoStep({ email, onBack }: { email: string; onBack: () => void }) {
  const navigate = useNavigate();
  const { setSignedIn } = useSession();
  const [code, setCode] = useState(emptyCode);
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState('');
  const [left, restart] = useResendTimer(38);
  const [method, setMethod] = useState<'text' | 'app'>('text');

  const verify = (e: FormEvent) => {
    e.preventDefault();
    if (code.some((d) => !d)) {
      setError('Enter all 6 digits of the code.');
      return;
    }
    setSignedIn(true);
    announce('Signed in');
    navigate(href('account/overview'));
  };

  return (
    <AuthShell title="Two-step verification" back={href('auth/sign-in')} onSubmit={verify}>
      <span className="buy-result-icon t-info">
        <Icon name="shield-check" />
      </span>
      <div className="stack gap-1">
        <h1 className="h2 acct-h1">Two-step verification</h1>
        <p className="small sub">
          {method === 'text' ? (
            <>
              Enter the 6-digit code we texted to <b>(•••) •••-••48</b>, or the code from your authenticator app.
            </>
          ) : (
            <>Enter the 6-digit code shown in your authenticator app.</>
          )}{' '}
          Signing in as <b>{maskEmail(email)}</b>.
        </p>
      </div>
      <CodeInput
        idPrefix="si-code"
        legend="Sign-in code"
        value={code}
        onChange={(v) => {
          setCode(v);
          setError('');
        }}
      />
      {error && (
        <span className="error-text" role="alert">
          <Icon name="circle-alert" className="ic-sm" />
          {error}
        </span>
      )}
      <Checkbox id="si-trust" label="Trust this device for 30 days. We won't ask for a code here again until then." checked={trust} onChange={(e) => setTrust(e.target.checked)} />
      <Button type="submit" size="lg" block>
        Verify and sign in
      </Button>
      <div className="row between small">
        {method === 'text' && left > 0 ? (
          <span className="muted">
            <Icon name="clock" className="ic-sm" /> Resend text in {mss(left)}
          </span>
        ) : method === 'text' ? (
          <a
            href="#"
            className="link-inline"
            onClick={(e) => {
              e.preventDefault();
              restart();
              announce('We sent a new code by text');
            }}
          >
            Resend text
          </a>
        ) : (
          <span className="muted">Codes change every 30 seconds</span>
        )}
        <a
          href="#"
          className="link-inline"
          onClick={(e) => {
            e.preventDefault();
            setMethod((m) => (m === 'text' ? 'app' : 'text'));
          }}
        >
          {method === 'text' ? 'Use authenticator app' : 'Text me a code instead'}
        </a>
      </div>
      <div className="panel row gap-3 nowrap">
        <Icon name="key-round" />
        <div className="stack gap-0 grow">
          <span className="small strong">No access to your phone?</span>
          <span className="xs muted">Each backup code from your security settings works once.</span>
        </div>
        <a className="small strong nowrap" href="#">
          Use a backup code
        </a>
      </div>
      <p className="xs muted">
        Lost your phone and your backup codes? Call 1-800-555-0136, Mon–Sat 8 AM–8 PM PT.{' '}
        <a
          href="#"
          className="link-inline"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
        >
          Back to sign in
        </a>
      </p>
    </AuthShell>
  );
}
