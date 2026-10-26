import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError, call, useApi } from '@marketly/web-shared/api';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Checkbox, Icon, TextInput, announce } from '@marketly/web-shared/ui';
import {
  AuthShell,
  CodeInput,
  EMAIL_RE,
  PasswordInput,
  WITH_COOKIE,
  authError,
  deviceInfo,
  emptyCode,
  maskEmail,
  mss,
  useFinishSignIn,
  useNextQuery,
  useRedirectSignedIn,
  useSecondsUntil,
  type SignInChallenge,
  type SignInResult,
} from './data/parts';

// Design: pages/store/auth-sign-in.html
//   view "wrong-password" = POST /api/public/identity/sessions answered INVALID_CREDENTIALS (attempts left from details)
//   view "two-step-code"  = the sign-in answered second_factor_required: verify with totp, sms (phase 2) or a recovery code
// The sign-in is sent with the visitor token, so the guest cart moves to the account. Passwords and codes are never prefilled.

type View = 'wrong-password' | 'two-step-code';
/** Router state other screens pass in: the email typed elsewhere, a 2-step challenge, or "password changed". */
interface InState {
  email?: string;
  challenge?: SignInChallenge;
  passwordChanged?: boolean;
}
interface Pending {
  challenge: SignInChallenge;
  email: string;
}

export default function SignIn() {
  const [view, setView] = useView<View>();
  const navigate = useNavigate();
  const st = (useLocation().state ?? null) as InState | null;
  const nextQuery = useNextQuery();
  const finish = useFinishSignIn();
  const [email, setEmail] = useState(st?.email ?? '');
  const [pending, setPending] = useState<Pending | null>(st?.challenge ? { challenge: st.challenge, email: st.email ?? '' } : null);
  useRedirectSignedIn();

  // The code step needs a live challenge; opened without one (reload, shared link) it falls back to the form.
  useEffect(() => {
    if (view === 'two-step-code' && !pending) setView('', { replace: true });
  }, [view, pending, setView]);

  const onResult = (r: SignInResult, signedInAs: string) => {
    if (r.status === 'signed_in' && r.tokens) finish(r.tokens);
    else if (r.status === 'second_factor_required' && r.challenge) {
      setPending({ challenge: r.challenge, email: signedInAs });
      setView('two-step-code');
    } else if (r.status === 'password_reset_required' && r.passwordResetToken) {
      // Staff required a new password: continue on the recover screen's set-new-password step.
      navigate(`${href('auth/recover', 'set-new-password', undefined, nextQuery)}#token=${encodeURIComponent(r.passwordResetToken)}`);
    } else announce('Sign-in could not be completed. Try again.');
  };

  if (view === 'two-step-code' && pending)
    return (
      <TwoStep
        pending={pending}
        onResult={(r) => onResult(r, pending.email)}
        onBack={() => {
          setPending(null);
          setView('');
        }}
      />
    );
  return <Credentials email={email} setEmail={setEmail} wrong={view === 'wrong-password'} setView={setView} passwordChanged={!!st?.passwordChanged} onResult={onResult} />;
}

function Credentials({
  email,
  setEmail,
  wrong,
  setView,
  passwordChanged,
  onResult,
}: {
  email: string;
  setEmail: (v: string) => void;
  wrong: boolean;
  setView: (v: View | '', o?: { replace?: boolean }) => void;
  passwordChanged: boolean;
  onResult: (r: SignInResult, email: string) => void;
}) {
  const { api } = useApi();
  const navigate = useNavigate();
  const nextQuery = useNextQuery();
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(true);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [lockoutMinutes, setLockoutMinutes] = useState<number | null>(null);
  const [lock, setLock] = useState<{ until: string | null; cause?: string } | null>(null);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const lockLeft = useSecondsUntil(lock?.until);
  const paused = !!lock && (lock.until === null || lock.cause === 'staff_action' || lockLeft > 0);
  const lockMinutes = Math.max(1, Math.ceil(lockLeft / 60));

  const signIn = useMutation({
    mutationFn: (body: { email: string; password: string; keepSignedIn: boolean }) =>
      call(api.POST('/api/public/identity/sessions', { body: { ...body, audience: 'store', device: deviceInfo() }, ...WITH_COOKIE })),
    onSuccess: (r, body) => {
      setPassword('');
      onResult(r, body.email);
    },
    onError: (e) => {
      if (!(e instanceof ApiError)) return;
      if (e.code === 'INVALID_CREDENTIALS') {
        setAttemptsLeft(typeof e.details.attemptsLeft === 'number' ? e.details.attemptsLeft : null);
        setLockoutMinutes(typeof e.details.lockoutMinutes === 'number' ? e.details.lockoutMinutes : null);
        setPassword('');
        setView('wrong-password', { replace: true });
        announce("That email and password don't match");
      } else if (e.code === 'ACCOUNT_LOCKED') {
        setLock({ until: (e.details.lockedUntil as string | null | undefined) ?? null, cause: e.details.cause as string | undefined });
        setPassword('');
        announce('Sign-in is paused for this account');
      }
    },
  });

  // A failed sign-in other than the ones shown in the design's own states.
  const otherError = signIn.error instanceof ApiError && ['INVALID_CREDENTIALS', 'ACCOUNT_LOCKED'].includes(signIn.error.code) ? null : signIn.error ? authError(signIn.error) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (paused || signIn.isPending) return;
    const next: typeof errors = {};
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter the email address for your account, like name@example.com.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    if (next.email || next.password) return;
    signIn.mutate({ email: email.trim(), password, keepSignedIn: keep });
  };

  const pwError = errors.password ?? (wrong && !paused ? 'Incorrect password for this email.' : undefined);
  const recoverState = { email: email.trim() };

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
      {passwordChanged && !wrong && !paused && (
        <Alert tone="success" title="Password changed">
          Sign in with your new password.
        </Alert>
      )}
      {paused ? (
        lock?.until && lock.cause !== 'staff_action' ? (
          <Alert tone="danger" title={`Sign-in is paused for ${lockMinutes === 1 ? '1 minute' : `${lockMinutes} minutes`}`}>
            There were too many incorrect passwords for this email. Try again after {lockMinutes === 1 ? '1 minute' : `${lockMinutes} minutes`}, or reset your password now.
          </Alert>
        ) : (
          <Alert tone="danger" title="Sign-in is paused for this account">
            Contact support to unlock it, or reset your password now.
          </Alert>
        )
      ) : (
        wrong && (
          <Alert tone="danger" title="That email and password don't match">
            Check your password and try again, or reset it.
            {attemptsLeft !== null && (
              <>
                {' '}
                You have <b>{attemptsLeft === 1 ? '1 attempt' : `${attemptsLeft} attempts`} left</b> before sign-in pauses {lockoutMinutes ? `for ${lockoutMinutes === 1 ? '1 minute' : `${lockoutMinutes} minutes`}` : 'for a while'} to protect your account.
              </>
            )}
          </Alert>
        )
      )}
      {otherError && <Alert tone="danger" title="Couldn't sign in">{otherError}</Alert>}
      <div className="field">
        <label className="label" htmlFor="si-email">
          Email
        </label>
        <TextInput
          id="si-email"
          type="email"
          value={email}
          error={!!errors.email}
          autoComplete="username"
          aria-describedby={errors.email ? 'si-email-err' : undefined}
          onChange={(e) => {
            setEmail(e.target.value);
            // The lock and the attempts belong to the account of the email that was tried.
            setLock(null);
            setAttemptsLeft(null);
          }}
        />
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
          <Link className="small" to={href('auth/recover', undefined, undefined, nextQuery)} state={recoverState}>
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
      <Button type="submit" size="lg" block disabled={paused || signIn.isPending}>
        {signIn.isPending ? 'Signing in…' : 'Sign in'}
      </Button>
      {(wrong || paused) && (
        <Button variant="soft" block icon="key-round" onClick={() => navigate(href('auth/recover', undefined, undefined, nextQuery), { state: recoverState })}>
          Reset your password
        </Button>
      )}
      <p className="small center">
        New to Marketly?{' '}
        <Link className="strong link-inline" to={href('auth/register', undefined, undefined, nextQuery)}>
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

type Mode = 'text' | 'app' | 'backup';
const METHOD: Record<Mode, 'sms' | 'totp' | 'recovery_code'> = { text: 'sms', app: 'totp', backup: 'recovery_code' };
const RESEND_SECONDS = 30;

function TwoStep({ pending, onResult, onBack }: { pending: Pending; onResult: (r: SignInResult) => void; onBack: () => void }) {
  const { api } = useApi();
  const { challenge, email } = pending;
  const hasSms = challenge.methods.includes('sms');
  const hasTotp = challenge.methods.includes('totp');
  const hasBackup = challenge.methods.includes('recovery_code');
  const [mode, setMode] = useState<Mode>(hasSms ? 'text' : 'app');
  const [code, setCode] = useState(emptyCode);
  const [backupCode, setBackupCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState('');
  const [finished, setFinished] = useState(false);
  const [smsSentAt, setSmsSentAt] = useState<string | null>(null);
  const resendLeft = useSecondsUntil(smsSentAt ? new Date(new Date(smsSentAt).getTime() + RESEND_SECONDS * 1000).toISOString() : null);

  const sendSms = useMutation({
    mutationFn: () => call(api.POST('/api/public/identity/sign-in-challenges/{id}/send-sms', { params: { path: { id: challenge.id } } })),
    onSuccess: () => {
      setSmsSentAt(new Date().toISOString());
      announce('We sent a code by text');
    },
    onError: (e) => setError(authError(e)),
  });
  // SMS (phase 2): text the code once when the step opens in text mode.
  const sentOnce = useRef(false);
  useEffect(() => {
    if (mode === 'text' && hasSms && !sentOnce.current) {
      sentOnce.current = true;
      sendSms.mutate();
    }
  }, [mode, hasSms, sendSms]);

  const verify = useMutation({
    mutationFn: (body: { method: 'sms' | 'totp' | 'recovery_code'; code: string; rememberDevice: boolean }) =>
      call(api.POST('/api/public/identity/sign-in-challenges/{id}/verify', { params: { path: { id: challenge.id } }, body, ...WITH_COOKIE })),
    onSuccess: onResult,
    onError: (e) => {
      setError(authError(e));
      setCode(emptyCode());
      setBackupCode('');
      // A locked or expired challenge can't be retried: the customer signs in again.
      if (e instanceof ApiError && (e.code === 'CHALLENGE_LOCKED' || e.code === 'CODE_EXPIRED')) setFinished(true);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (finished || verify.isPending) return;
    const value = mode === 'backup' ? backupCode.trim() : code.join('');
    if (mode === 'backup' ? !value : code.some((d) => !d)) {
      setError(mode === 'backup' ? 'Enter one of your backup codes.' : 'Enter all 6 digits of the code.');
      return;
    }
    verify.mutate({ method: METHOD[mode], code: value, rememberDevice: trust });
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setError('');
    setCode(emptyCode());
    setBackupCode('');
  };

  return (
    <AuthShell title="Two-step verification" back={href('auth/sign-in')} onSubmit={submit}>
      <span className="buy-result-icon t-info">
        <Icon name="shield-check" />
      </span>
      <div className="stack gap-1">
        <h1 className="h2 acct-h1">Two-step verification</h1>
        <p className="small sub">
          {mode === 'text' ? (
            <>
              Enter the 6-digit code we texted to <b>{challenge.smsPhoneMasked ?? 'your phone'}</b>
              {hasTotp ? ', or the code from your authenticator app.' : '.'}
            </>
          ) : mode === 'app' ? (
            <>Enter the 6-digit code shown in your authenticator app.</>
          ) : (
            <>Enter one of the backup codes you saved when you turned on two-step verification.</>
          )}{' '}
          {email && (
            <>
              Signing in as <b>{maskEmail(email)}</b>.
            </>
          )}
        </p>
      </div>
      {mode === 'backup' ? (
        <div className="field">
          <label className="label" htmlFor="si-backup">
            Backup code
          </label>
          <TextInput
            id="si-backup"
            value={backupCode}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => {
              setBackupCode(e.target.value);
              setError('');
            }}
          />
        </div>
      ) : (
        <CodeInput
          idPrefix="si-code"
          legend="Sign-in code"
          value={code}
          onChange={(v) => {
            setCode(v);
            setError('');
          }}
        />
      )}
      {error && (
        <span className="error-text" role="alert">
          <Icon name="circle-alert" className="ic-sm" />
          {error}
        </span>
      )}
      <Checkbox id="si-trust" label="Trust this device for 30 days. We won't ask for a code here again until then." checked={trust} onChange={(e) => setTrust(e.target.checked)} />
      <Button type="submit" size="lg" block disabled={finished || verify.isPending}>
        {verify.isPending ? 'Verifying…' : 'Verify and sign in'}
      </Button>
      {mode !== 'backup' && (
        <div className="row between small">
          {mode === 'text' && (resendLeft > 0 || sendSms.isPending) ? (
            <span className="muted">
              <Icon name="clock" className="ic-sm" /> Resend text in {mss(resendLeft)}
            </span>
          ) : mode === 'text' ? (
            <a
              href="#"
              className="link-inline"
              onClick={(e) => {
                e.preventDefault();
                sendSms.mutate();
              }}
            >
              Resend text
            </a>
          ) : (
            <span className="muted">Codes change every 30 seconds</span>
          )}
          {hasSms && hasTotp && (
            <a
              href="#"
              className="link-inline"
              onClick={(e) => {
                e.preventDefault();
                switchMode(mode === 'text' ? 'app' : 'text');
              }}
            >
              {mode === 'text' ? 'Use authenticator app' : 'Text me a code instead'}
            </a>
          )}
        </div>
      )}
      {hasBackup && (
        <div className="panel row gap-3 nowrap">
          <Icon name="key-round" />
          <div className="stack gap-0 grow">
            <span className="small strong">{mode === 'backup' ? 'Have your code?' : 'No access to your phone?'}</span>
            <span className="xs muted">{mode === 'backup' ? 'Use the code from your phone or authenticator app instead.' : 'Each backup code from your security settings works once.'}</span>
          </div>
          <a
            className="small strong nowrap"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              switchMode(mode === 'backup' ? (hasSms ? 'text' : 'app') : 'backup');
            }}
          >
            {mode === 'backup' ? 'Use a sign-in code' : 'Use a backup code'}
          </a>
        </div>
      )}
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
