import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError, call, useApi } from '@marketly/web-shared/api';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Checkbox, Field, Icon, TextInput, announce } from '@marketly/web-shared/ui';
import {
  AppleButton,
  AuthShell,
  CodeInput,
  DevOutboxHint,
  EMAIL_RE,
  GoogleButton,
  PasswordInput,
  PolicyRules,
  WITH_COOKIE,
  authError,
  deviceInfo,
  emptyCode,
  minutesUntil,
  mss,
  passwordChecks,
  useFinishSignIn,
  useNextQuery,
  usePasswordPolicy,
  useRedirectSignedIn,
  useSecondsUntil,
  type SignInResult,
  type VerificationChallenge,
} from './data/parts';

// Design: pages/store/auth-register.html · view "verify-email" = the code step after "Create account".
// POST /api/public/identity/registrations (always 202: an existing owner gets an email instead of a code), then
// POST …/verifications/{id}/confirm signs the new customer in (visitor token: the guest cart moves along).
// Password rules come from GET …/password-policy. The password is never prefilled.

type Form = { first: string; last: string; email: string; password: string; marketing: boolean };
/** Router state from sign-in when the account exists but the email isn't confirmed (EMAIL_NOT_VERIFIED). */
interface InState {
  challenge?: VerificationChallenge;
  email?: string;
}

export default function Register() {
  const [view, setView] = useView<'verify-email'>();
  const st = (useLocation().state ?? null) as InState | null;
  const [form, setForm] = useState<Form>({ first: '', last: '', email: st?.email ?? '', password: '', marketing: false });
  const [challenge, setChallenge] = useState<VerificationChallenge | null>(st?.challenge ?? null);
  useRedirectSignedIn();

  // The code step needs a live challenge; opened without one it falls back to the form.
  useEffect(() => {
    if (view === 'verify-email' && !challenge) setView('', { replace: true });
  }, [view, challenge, setView]);

  if (view === 'verify-email' && challenge) return <Verify challenge={challenge} setChallenge={setChallenge} />;
  return (
    <CreateAccount
      form={form}
      setForm={setForm}
      onCreated={(c) => {
        setChallenge(c);
        setView('verify-email');
      }}
    />
  );
}

function CreateAccount({ form, setForm, onCreated }: { form: Form; setForm: (f: Form) => void; onCreated: (c: VerificationChallenge) => void }) {
  const { api } = useApi();
  const navigate = useNavigate();
  const nextQuery = useNextQuery();
  const finish = useFinishSignIn();
  const policy = usePasswordPolicy();
  // The purchase terms version shown on the form is recorded with the account (acceptedTermsVersion).
  const terms = useQuery({
    queryKey: ['content', 'policy', 'purchase_terms'],
    queryFn: () => call(api.GET('/api/store/content/policies/{key}', { params: { path: { key: 'purchase_terms' } } })),
    staleTime: 10 * 60_000,
  });
  const [tried, setTried] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm({ ...form, [k]: v });
    setServerErrors((s) => ({ ...s, [k]: undefined }));
  };
  const checks = passwordChecks(form.password, [form.first, form.last, form.email.split('@')[0]], policy.data);
  const errors: Partial<Record<'first' | 'last' | 'email' | 'password', string>> = {};
  if (!form.first.trim()) errors.first = 'Enter your first name.';
  if (!form.last.trim()) errors.last = 'Enter your last name.';
  if (!EMAIL_RE.test(form.email.trim())) errors.email = 'Enter an email address, like name@example.com.';
  if (!form.password) errors.password = 'Create a password.';
  else if (!checks.every((c) => c.ok)) errors.password = 'Your password needs to meet every rule below.';
  const shown = { ...(tried ? errors : {}), ...Object.fromEntries(Object.entries(serverErrors).filter(([, v]) => v)) } as typeof errors;

  const register = useMutation({
    mutationFn: async () => {
      const version = terms.data?.version ?? (await terms.refetch({ throwOnError: true })).data?.version;
      if (!version) throw new Error('Purchase terms unavailable');
      return call(
        api.POST('/api/public/identity/registrations', {
          body: {
            email: form.email.trim(),
            password: form.password,
            firstName: form.first.trim(),
            lastName: form.last.trim(),
            marketingOptIn: form.marketing,
            acceptedTermsVersion: version,
            device: deviceInfo(),
          },
        }),
      );
    },
    onSuccess: (c) => {
      setForm({ ...form, password: '' });
      onCreated(c);
    },
    onError: (e) => {
      if (!(e instanceof ApiError)) return;
      if (e.code === 'WEAK_PASSWORD') setServerErrors({ password: authError(e) });
      else if (e.code === 'VALIDATION_FAILED') {
        const f = e.fieldErrors;
        setServerErrors({ first: f.firstName, last: f.lastName, email: f.email, password: f.password });
      }
    },
  });
  const formError = register.error && !(register.error instanceof ApiError && ['WEAK_PASSWORD', 'VALIDATION_FAILED'].includes(register.error.code)) ? authError(register.error) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errors).length || !policy.data) {
      announce('Check the highlighted fields');
      return;
    }
    if (!register.isPending) register.mutate();
  };

  const onGoogle = (r: SignInResult) => {
    if (r.status === 'signed_in' && r.tokens) finish(r.tokens, 'Signed in with Google');
    else if (r.status === 'second_factor_required' && r.challenge) navigate(href('auth/sign-in', 'two-step-code', undefined, nextQuery), { state: { challenge: r.challenge, email: r.account?.email ?? '' } });
  };

  return (
    <AuthShell title="Create account" back={href('auth/sign-in', undefined, undefined, nextQuery)} onSubmit={submit}>
      <div className="stack gap-1">
        <h1 className="h2">Create your account</h1>
        <p className="small sub">One account for orders from the Official Store and every marketplace seller.</p>
      </div>
      {formError && <Alert tone="danger" title="We couldn't create your account">{formError}</Alert>}
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
      <PolicyRules loading={policy.isPending} error={policy.error} onRetry={() => void policy.refetch()} checks={checks} />
      <Checkbox id="rg-mkt" label="Email me deals, new arrivals and seller promotions. You can turn this off anytime." checked={form.marketing} onChange={(e) => set('marketing', e.target.checked)} />
      <p className="xs muted">Order, delivery and refund updates are always sent, whatever you choose above.</p>
      <Button type="submit" size="lg" block disabled={register.isPending}>
        {register.isPending ? 'Creating account…' : 'Create account'}
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
        <GoogleButton onResult={onGoogle} marketingOptIn={form.marketing} />
        <AppleButton />
      </div>
      <p className="small center">
        Already have an account?{' '}
        <Link className="strong link-inline" to={href('auth/sign-in', undefined, undefined, nextQuery)} state={{ email: form.email.trim() }}>
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}

function Verify({ challenge, setChallenge }: { challenge: VerificationChallenge; setChallenge: (c: VerificationChallenge) => void }) {
  const { api } = useApi();
  const finish = useFinishSignIn();
  const nextQuery = useNextQuery();
  const [code, setCode] = useState(() => emptyCode(challenge.codeLength || 6));
  const [error, setError] = useState('');
  const resendLeft = useSecondsUntil(challenge.resendAvailableAt);

  const confirm = useMutation({
    mutationFn: (value: string) =>
      call(api.POST('/api/public/identity/verifications/{id}/confirm', { params: { path: { id: challenge.id } }, body: { code: value, keepSignedIn: true, device: deviceInfo() }, ...WITH_COOKIE })),
    onSuccess: (r) => {
      if (r.tokens) finish(r.tokens, 'Email verified. Your account is ready.');
      else setError('Your email is verified. Sign in to continue.');
    },
    onError: (e) => {
      setError(authError(e));
      setCode(emptyCode(challenge.codeLength || 6));
    },
  });
  const resend = useMutation({
    mutationFn: () => call(api.POST('/api/public/identity/verifications/{id}/resend', { params: { path: { id: challenge.id } } })),
    onSuccess: (c) => {
      setChallenge(c);
      setCode(emptyCode(c.codeLength || 6));
      setError('');
      announce(`We sent a new code to ${c.emailMasked}`);
    },
    onError: (e) => setError(authError(e)),
  });

  const verify = (e: FormEvent) => {
    e.preventDefault();
    if (confirm.isPending) return;
    if (code.some((d) => !d)) {
      setError(`Enter all ${code.length} digits of the code.`);
      return;
    }
    confirm.mutate(code.join(''));
  };

  return (
    <AuthShell title="Verify email" back={href('auth/register', undefined, undefined, nextQuery)} onSubmit={verify}>
      <span className="buy-result-icon t-info">
        <Icon name="mail-check" />
      </span>
      <div className="stack gap-1">
        <h1 className="h2">Check your email</h1>
        <p className="small sub">
          Enter the {code.length}-digit code we sent to <b>{challenge.emailMasked}</b>. It expires in {minutesUntil(challenge.expiresAt)} minutes.
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
      <Button type="submit" size="lg" block disabled={confirm.isPending}>
        {confirm.isPending ? 'Verifying…' : 'Verify email'}
      </Button>
      <div className="row between small">
        {resendLeft > 0 || resend.isPending ? (
          <span className="muted">
            <Icon name="clock" className="ic-sm" /> Resend code in {mss(resendLeft)}
          </span>
        ) : (
          <a
            href="#"
            className="link-inline"
            onClick={(e) => {
              e.preventDefault();
              resend.mutate();
            }}
          >
            Resend code
          </a>
        )}
        <Link to={href('auth/register', undefined, undefined, nextQuery)} className="link-inline">
          Change email
        </Link>
      </div>
      <p className="xs muted">Can't find it? Check your spam folder. The email comes from no-reply@marketly.example.</p>
      <DevOutboxHint what="code" />
    </AuthShell>
  );
}
