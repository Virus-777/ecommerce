import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { ApiError, call, useApi } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Checkbox, Field, Icon, TextInput, announce } from '@marketly/web-shared/ui';
import {
  AuthShell,
  EMAIL_RE,
  PasswordInput,
  PolicyRules,
  WITH_COOKIE,
  authError,
  deviceInfo,
  passwordChecks,
  useFinishSignIn,
  useNextQuery,
  usePasswordPolicy,
  useRedirectSignedIn,
} from './data/parts';

// Design: pages/store/auth-register.html.
// POST /api/public/identity/registrations creates the account and signs the new customer in on the spot (visitor
// token: the guest cart moves along). There is no email code step; an email that already has an account is
// refused with EMAIL_IN_USE. Password rules come from GET …/password-policy. The password is never prefilled.

type Form = { first: string; last: string; email: string; password: string; marketing: boolean };
/** Router state from sign-in: the email typed there. */
interface InState {
  email?: string;
}

export default function Register() {
  const st = (useLocation().state ?? null) as InState | null;
  const [form, setForm] = useState<Form>({ first: '', last: '', email: st?.email ?? '', password: '', marketing: false });
  useRedirectSignedIn();
  return <CreateAccount form={form} setForm={setForm} />;
}

function CreateAccount({ form, setForm }: { form: Form; setForm: (f: Form) => void }) {
  const { api } = useApi();
  const finish = useFinishSignIn();
  const nextQuery = useNextQuery();
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
      // keepSignedIn: the account this creates stays signed in, as after a sign-in with "Keep me signed in".
      return call(
        api.POST('/api/public/identity/registrations', {
          body: {
            email: form.email.trim(),
            password: form.password,
            firstName: form.first.trim(),
            lastName: form.last.trim(),
            marketingOptIn: form.marketing,
            acceptedTermsVersion: version,
            keepSignedIn: true,
            device: deviceInfo(),
          },
          ...WITH_COOKIE,
        }),
      );
    },
    onSuccess: (r) => {
      setForm({ ...form, password: '' });
      finish(r.tokens, 'Your account is ready.');
    },
    onError: (e) => {
      if (!(e instanceof ApiError)) return;
      if (e.code === 'WEAK_PASSWORD') setServerErrors({ password: authError(e) });
      else if (e.code === 'EMAIL_IN_USE') setServerErrors({ email: 'That email already has an account. Sign in instead.' });
      else if (e.code === 'VALIDATION_FAILED') {
        const f = e.fieldErrors;
        setServerErrors({ first: f.firstName, last: f.lastName, email: f.email, password: f.password });
      }
    },
  });
  const formError =
    register.error && !(register.error instanceof ApiError && ['WEAK_PASSWORD', 'EMAIL_IN_USE', 'VALIDATION_FAILED'].includes(register.error.code)) ? authError(register.error) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errors).length || !policy.data) {
      announce('Check the highlighted fields');
      return;
    }
    if (!register.isPending) register.mutate();
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
      <Field label="Email" hint="We'll use it for order updates and signing in." error={shown.email}>
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
      <p className="small center">
        Already have an account?{' '}
        <Link className="strong link-inline" to={href('auth/sign-in', undefined, undefined, nextQuery)} state={{ email: form.email.trim() }}>
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
