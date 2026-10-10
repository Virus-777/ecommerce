import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSession } from '@/app/session';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Button, Checkbox, Field, Icon, TextInput, announce } from '@/ui';
import { AuthShell, CodeInput, EMAIL_RE, PasswordInput, PasswordRules, emptyCode, maskEmail, mss, passwordChecks, useResendTimer, useSignedOut } from './data/parts';

// Design: pages/store/auth-register.html · view "verify-email" = the code step after "Create account"
// (any 6 digits verify in this mock). The password is never prefilled.

export default function Register() {
  const [view, setView] = useView<'verify-email'>();
  const [form, setForm] = useState({ first: 'Jordan', last: 'Lee', email: 'jordan.lee@example.com', password: '', marketing: false });
  useSignedOut();
  return view === 'verify-email' ? <Verify email={form.email} /> : <CreateAccount form={form} setForm={setForm} onCreated={() => setView('verify-email')} />;
}

type Form = { first: string; last: string; email: string; password: string; marketing: boolean };

function CreateAccount({ form, setForm, onCreated }: { form: Form; setForm: (f: Form) => void; onCreated: () => void }) {
  const [tried, setTried] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const checks = passwordChecks(form.password, [form.first, form.last, form.email.split('@')[0]]);
  const errors: Partial<Record<'first' | 'last' | 'email' | 'password', string>> = {};
  if (!form.first.trim()) errors.first = 'Enter your first name.';
  if (!form.last.trim()) errors.last = 'Enter your last name.';
  if (!EMAIL_RE.test(form.email.trim())) errors.email = 'Enter an email address, like name@example.com.';
  if (!checks.every((c) => c.ok)) errors.password = form.password ? 'Your password needs to meet every rule below.' : 'Create a password.';
  const shown = tried ? errors : {};

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errors).length) {
      announce('Check the highlighted fields');
      return;
    }
    onCreated();
  };

  return (
    <AuthShell title="Create account" back={href('auth/sign-in')} onSubmit={submit}>
      <div className="stack gap-1">
        <h1 className="h2">Create your account</h1>
        <p className="small sub">One account for orders from the Official Store and every marketplace seller.</p>
      </div>
      <div className="grid c2">
        <Field label="First name" error={shown.first}>
          <TextInput id="rg-first" value={form.first} error={!!shown.first} autoComplete="given-name" onChange={(e) => set('first', e.target.value)} />
        </Field>
        <Field label="Last name" error={shown.last}>
          <TextInput id="rg-last" value={form.last} error={!!shown.last} autoComplete="family-name" onChange={(e) => set('last', e.target.value)} />
        </Field>
      </div>
      <Field label="Email" hint="We'll send a code to confirm it." error={shown.email}>
        <TextInput id="rg-email" type="email" value={form.email} error={!!shown.email} autoComplete="email" onChange={(e) => set('email', e.target.value)} />
      </Field>
      <div className="field">
        <div className="row between">
          <label className="label" htmlFor="rg-pass">
            Password
          </label>
        </div>
        <PasswordInput id="rg-pass" value={form.password} onChange={(v) => set('password', v)} error={!!shown.password} describedBy={shown.password ? 'rg-pass-err' : undefined} autoComplete="new-password" />
        {shown.password && (
          <span className="error-text" id="rg-pass-err">
            <Icon name="circle-alert" className="ic-sm" />
            {shown.password}
          </span>
        )}
      </div>
      <PasswordRules checks={checks} />
      <Checkbox id="rg-mkt" label="Email me deals, new arrivals and seller promotions. You can turn this off anytime." checked={form.marketing} onChange={(e) => set('marketing', e.target.checked)} />
      <p className="xs muted">Order, delivery and refund updates are always sent, whatever you choose above.</p>
      <Button type="submit" size="lg" block>
        Create account
      </Button>
      <p className="xs muted">
        By creating an account, you agree to the{' '}
        <Link to={href('info/policy', 'purchase-terms')} className="link-inline">
          Purchase terms
        </Link>{' '}
        and confirm you've read the{' '}
        <Link to={href('info/policy', 'privacy')} className="link-inline">
          Privacy policy
        </Link>
        .
      </p>
      <div className="buy-or">or</div>
      <div className="stack gap-2">
        <Button variant="secondary" block onClick={() => announce('Google sign-up opens in a new window')}>
          Continue with Google
        </Button>
        <Button variant="secondary" block onClick={() => announce('Apple sign-up opens in a new window')}>
          Continue with Apple
        </Button>
      </div>
      <p className="small center">
        Already have an account?{' '}
        <Link className="strong link-inline" to={href('auth/sign-in')}>
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}

function Verify({ email }: { email: string }) {
  const navigate = useNavigate();
  const { setSignedIn } = useSession();
  const [code, setCode] = useState(emptyCode);
  const [error, setError] = useState('');
  const [left, restart] = useResendTimer(42);

  const verify = (e: FormEvent) => {
    e.preventDefault();
    if (code.some((d) => !d)) {
      setError('Enter all 6 digits of the code.');
      return;
    }
    setSignedIn(true);
    announce('Email verified. Your account is ready.');
    navigate(href('account/overview'));
  };

  return (
    <AuthShell title="Verify email" back={href('auth/register')} onSubmit={verify}>
      <span className="buy-result-icon t-info">
        <Icon name="mail-check" />
      </span>
      <div className="stack gap-1">
        <h1 className="h2">Check your email</h1>
        <p className="small sub">
          Enter the 6-digit code we sent to <b>{maskEmail(email)}</b>. It expires in 10 minutes.
        </p>
      </div>
      <CodeInput
        idPrefix="rg-code"
        legend="Verification code"
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
      <Button type="submit" size="lg" block>
        Verify email
      </Button>
      <div className="row between small">
        {left > 0 ? (
          <span className="muted">
            <Icon name="clock" className="ic-sm" /> Resend code in {mss(left)}
          </span>
        ) : (
          <a
            href="#"
            className="link-inline"
            onClick={(e) => {
              e.preventDefault();
              restart();
              setCode(emptyCode());
              announce(`We sent a new code to ${maskEmail(email)}`);
            }}
          >
            Resend code
          </a>
        )}
        <Link to={href('auth/register')} className="link-inline">
          Change email
        </Link>
      </div>
      <p className="xs muted">Can't find it? Check your spam folder. The email comes from no-reply@marketly.example.</p>
    </AuthShell>
  );
}
