// Building blocks shared by the sign-in, register, recover and guest order screens: the auth card shell,
// password field with show/hide, code entry, password rules from the server's policy, resend timers,
// error copy for the identity error codes, finishing a sign-in (adopt tokens, claim the guest cart, go on)
// and "Continue with Google" (development: the backend's dev ID tokens).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { ApiError, call, errorMessage, useApi, useSessionState, type components } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Dialog, Field, Icon, TextInput, announce } from '@marketly/web-shared/ui';

export type SignInResult = components['schemas']['identity.SignInResult'];
export type SignInChallenge = components['schemas']['identity.SignInChallenge'];
export type VerificationChallenge = components['schemas']['identity.VerificationChallenge'];
export type PasswordPolicy = components['schemas']['identity.PasswordPolicy'];
type DeviceInfo = components['schemas']['identity.DeviceInfo'];
type SessionTokens = components['schemas']['identity.SessionTokens'];

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** jordan.lee@example.com -> jo•••@example.com */
export const maskEmail = (email: string) => {
  const [local, domain] = email.trim().split('@');
  return domain ? `${local.slice(0, 2)}•••@${domain}` : email;
};

/** The identity routes that set the refresh cookie must send credentials (API-INTEGRATION-BRIEF §1.2). */
export const WITH_COOKIE = { credentials: 'include' } as const;

const INSTALLATION_KEY = 'marketly.installationId';

/**
 * DeviceInfo for sign-in calls. A stable installation id per browser keeps one device record and lets
 * "Trust this device" skip 2-step later (identity: rememberDevice needs device.installationId).
 */
export function deviceInfo(): DeviceInfo {
  let installationId: string | null = null;
  try {
    installationId = localStorage.getItem(INSTALLATION_KEY);
    if (!installationId) {
      installationId = crypto.randomUUID();
      localStorage.setItem(INSTALLATION_KEY, installationId);
    }
  } catch {
    installationId = null;
  }
  return installationId ? { kind: 'web', installationId } : { kind: 'web' };
}

/** `?next=` when it is a path inside this app (never another origin). */
export function useNext(): string | null {
  const [params] = useSearchParams();
  const next = params.get('next');
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : null;
}

/** Keeps `?next=` on links between the auth screens. */
export function useNextQuery(): Record<string, string> | undefined {
  const next = useNext();
  return next ? { next } : undefined;
}

/** Signed-in customers who open sign-in or register go on to `?next=` or their account. */
export function useRedirectSignedIn() {
  const { signedIn } = useSession();
  const next = useNext();
  const navigate = useNavigate();
  useEffect(() => {
    if (signedIn) navigate(next ?? href('account/overview'), { replace: true });
  }, [signedIn, next, navigate]);
}

/** The token in the URL fragment of an emailed link (`#token=…`), removed from the address bar once read. */
export function useHashToken(): string | null {
  const { hash } = useLocation();
  const [token] = useState(() => new URLSearchParams(hash.replace(/^#/, '')).get('token'));
  useEffect(() => {
    if (token && window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, [token]);
  return token;
}

/**
 * After sign-in, 2-step verification or registration: adopt the customer tokens, ask cart for the one-time
 * merge message (the guest cart moves to the customer asynchronously), then go to `?next=` or the account.
 */
export function useFinishSignIn() {
  const { api } = useApi();
  const { adopt, refreshCart } = useSession();
  const state = useSessionState();
  const navigate = useNavigate();
  const next = useNext();
  return useCallback(
    (tokens: SessionTokens, message = 'Signed in') => {
      const guestSessionId = state.kind === 'visitor' ? state.claims?.sid : undefined;
      adopt(tokens);
      announce(message);
      navigate(next ?? href('account/overview'), { replace: true });
      if (guestSessionId) {
        const merge = (retry: boolean) =>
          call(api.POST('/api/store/cart/cart/merge', { body: { guestSessionId } }))
            .then((r) => {
              refreshCart();
              if (r.report.message) announce(r.report.message);
            })
            .catch((e: unknown) => {
              // 404 until cart has recorded the claim event: try once more, then just re-read the badge.
              if (retry && e instanceof ApiError && e.status === 404) setTimeout(() => merge(false), 1500);
              else refreshCart();
            });
        setTimeout(() => merge(true), 600);
      }
    },
    [api, adopt, refreshCart, state.kind, state.claims, navigate, next],
  );
}

/** User-facing copy for the identity error codes (identity.md, Error codes); other errors use errorMessage. */
export function authError(e: unknown): string {
  if (!(e instanceof ApiError)) return errorMessage(e);
  const d = e.details;
  switch (e.code) {
    case 'INVALID_CREDENTIALS':
      return "That email and password don't match.";
    case 'ACCOUNT_LOCKED':
      return lockedMessage(d.lockedUntil as string | null | undefined, d.cause as string | undefined);
    case 'ACCOUNT_DISABLED':
      return 'This account is closed or disabled. Contact support if you think this is a mistake.';
    case 'CODE_INVALID':
      return typeof d.attemptsLeft === 'number' ? `That code isn't right. ${d.attemptsLeft === 1 ? '1 attempt' : `${d.attemptsLeft} attempts`} left.` : "That code isn't right.";
    case 'CODE_EXPIRED':
      return 'This code has expired. Ask for a new one.';
    case 'CHALLENGE_LOCKED':
      return 'Too many wrong codes. Start again to get a new code.';
    case 'RESEND_TOO_SOON':
      return 'Wait a moment before asking for another code.';
    case 'WEAK_PASSWORD':
      return weakPasswordMessage(d.failed as string[] | undefined);
    case 'PASSWORD_REUSED':
      return 'You used this password recently. Choose a different one.';
    case 'RESET_LINK_INVALID':
      return 'This reset link was already used, replaced by a newer one or has expired.';
    case 'ORDER_LINK_INVALID':
      return 'This order link has expired. Look up your order below, or email yourself new links.';
    case 'GUEST_ORDER_NOT_FOUND':
      return "We couldn't find that order.";
    case 'GUEST_ORDER_SIGN_IN_REQUIRED':
      return 'Sign in to see this order. It belongs to a Marketly account.';
    case 'METHOD_NOT_AVAILABLE':
      return 'That verification method isn’t available yet. Use your authenticator app or a backup code.';
    case 'NOT_IMPLEMENTED':
      return 'Sign-in with Google isn’t available right now. Sign in with your email and password.';
    default:
      return errorMessage(e);
  }
}

/** "Sign-in is paused …" from ACCOUNT_LOCKED details. */
export function lockedMessage(lockedUntil: string | null | undefined, cause?: string): string {
  if (!lockedUntil || cause === 'staff_action') return 'Sign-in is paused for this account. Contact support to unlock it, or reset your password.';
  const minutes = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60_000));
  return `There were too many incorrect passwords for this email. Try again in ${minutes === 1 ? '1 minute' : `${minutes} minutes`}, or reset your password now.`;
}

const RULE_COPY: Record<string, string> = {
  min_length: 'it is too short',
  number: 'it needs a number',
  uppercase: 'it needs an uppercase letter',
  personal_info: 'it contains your name or email',
  breached: 'it has appeared in a data breach',
};

export function weakPasswordMessage(failed: string[] | undefined): string {
  const parts = (failed ?? []).map((f) => RULE_COPY[f]).filter(Boolean);
  return parts.length ? `Choose a stronger password: ${parts.join(', ')}.` : 'Choose a stronger password.';
}

/**
 * Store chrome for auth screens (no promo, footer or tab bar) + the centred auth card.
 * With onSubmit the card body is the <form> (keeps the design's flex layout of .card-body).
 */
export function AuthShell({ title, back, after, onSubmit, children }: { title: string; back?: string; after?: ReactNode; onSubmit?: (e: FormEvent) => void; children: ReactNode }) {
  return (
    <StoreLayout promo={false} footer={false} tabbar={false} appbar={{ title, back }}>
      <div className="container page">
        <div className="buy-auth">
          <section className="card">
            {onSubmit ? (
              <form className="card-body" onSubmit={onSubmit} noValidate>
                {children}
              </form>
            ) : (
              <div className="card-body">{children}</div>
            )}
          </section>
          {after}
        </div>
      </div>
    </StoreLayout>
  );
}

/** Password input with a Show/Hide toggle (.buy-pass). */
export function PasswordInput({ id, value, onChange, error, describedBy, autoComplete = 'current-password' }: { id: string; value: string; onChange: (v: string) => void; error?: boolean; describedBy?: string; autoComplete?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className={cx('buy-pass', error && 'is-error')}>
      <input className="input" id={id} type={shown ? 'text' : 'password'} value={value} autoComplete={autoComplete} aria-invalid={error || undefined} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="btn btn-ghost btn-sm" aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} onClick={() => setShown((s) => !s)}>
        <Icon name={shown ? 'eye-off' : 'eye'} className="ic-sm" />
        <span>{shown ? 'Hide' : 'Show'}</span>
      </button>
    </span>
  );
}

/** Single-digit inputs (.buy-code): typing moves on, Backspace moves back, pasting fills all. */
export function CodeInput({ idPrefix, value, onChange, legend }: { idPrefix: string; value: string[]; onChange: (v: string[]) => void; legend: string }) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const focus = (i: number) => refs.current[Math.max(0, Math.min(value.length - 1, i))]?.focus();
  const set = (i: number, raw: string) => {
    const d = raw.replace(/\D/g, '');
    const next = [...value];
    if (d.length > 1) {
      d.slice(0, value.length - i).split('').forEach((c, k) => (next[i + k] = c));
      onChange(next);
      focus(i + d.length);
      return;
    }
    next[i] = d;
    onChange(next);
    if (d) focus(i + 1);
  };
  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !value[i] && i > 0) {
      e.preventDefault();
      const next = [...value];
      next[i - 1] = '';
      onChange(next);
      focus(i - 1);
    } else if (e.key === 'ArrowLeft') focus(i - 1);
    else if (e.key === 'ArrowRight') focus(i + 1);
  };
  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    set(i, e.clipboardData.getData('text'));
  };
  return (
    <fieldset className="stack gap-2 fieldset-reset">
      <legend className="label u-mb-sp-2">{legend}</legend>
      <div className="buy-code">
        {value.map((v, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${idPrefix}-${i}`}
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            maxLength={1}
            value={v}
            aria-label={`Digit ${i + 1} of ${value.length}`}
            onChange={(e) => set(i, e.target.value)}
            onKeyDown={(e) => onKey(i, e)}
            onPaste={(e) => onPaste(i, e)}
            onFocus={(e) => e.target.select()}
          />
        ))}
      </div>
    </fieldset>
  );
}

export const emptyCode = (length = 6) => Array.from({ length }, () => '');

/** The member password policy (GET /api/public/identity/password-policy?realm=member). */
export function usePasswordPolicy(enabled = true) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['identity', 'password-policy', 'member'],
    queryFn: () => call(api.GET('/api/public/identity/password-policy', { params: { query: { realm: 'member' } } })),
    staleTime: 10 * 60_000,
    enabled,
  });
}

/**
 * The live password rules (.buy-rules) from the server's policy. "Not your email or name" is checked against
 * what the form knows; the breached-password check runs on the server only (WEAK_PASSWORD `breached`).
 */
export function passwordChecks(pw: string, avoid: string[], policy: PasswordPolicy | undefined) {
  if (!policy) return [];
  const lower = pw.toLowerCase();
  const personal = avoid.map((a) => a.trim().toLowerCase()).filter((a) => a.length >= 3);
  const checks = [{ label: `At least ${policy.minLength} characters`, ok: pw.length >= policy.minLength }];
  if (policy.requireNumber) checks.push({ label: 'One number', ok: /\d/.test(pw) });
  if (policy.requireUppercase) checks.push({ label: 'One uppercase letter', ok: /[A-Z]/.test(pw) });
  if (policy.disallowNameOrEmail) checks.push({ label: 'Not your email or name', ok: pw.length > 0 && !personal.some((a) => lower.includes(a)) });
  return checks;
}

export function PasswordRules({ checks }: { checks: Array<{ label: string; ok: boolean }> }) {
  return (
    <ul className="buy-rules" aria-label="Password requirements">
      {checks.map((c) => (
        <li key={c.label} className={c.ok ? 'is-ok' : ''}>
          <Icon name={c.ok ? 'circle-check' : 'circle'} className="ic-sm" />
          <span>
            {c.label}
            <span className="sr-only">{c.ok ? ' (met)' : ' (not met yet)'}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Password rules, a skeleton while the policy loads, or an alert with retry when it failed to load. */
export function PolicyRules({ loading, error, onRetry, checks }: { loading: boolean; error: unknown; onRetry: () => void; checks: Array<{ label: string; ok: boolean }> }) {
  if (loading)
    return (
      <div className="stack gap-1" aria-hidden="true">
        <span className="sk sk-line" />
        <span className="sk sk-line" />
      </div>
    );
  if (error)
    return (
      <Alert tone="danger" title="We couldn't load the password rules">
        {errorMessage(error)}{' '}
        <button type="button" className="link-inline" onClick={onRetry}>
          Try again
        </button>
      </Alert>
    );
  return <PasswordRules checks={checks} />;
}

/** Seconds left until an ISO time (resend timers driven by the server's resendAvailableAt). */
export function useSecondsUntil(iso: string | null | undefined): number {
  const target = iso ? new Date(iso).getTime() : 0;
  const calc = useCallback(() => Math.max(0, Math.ceil((target - Date.now()) / 1000)), [target]);
  const [left, setLeft] = useState(calc);
  useEffect(() => {
    setLeft(calc());
    const t = setInterval(() => setLeft(calc()), 1000);
    return () => clearInterval(t);
  }, [calc]);
  return left;
}

export const mss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Minutes until an ISO time, at least 1. */
export const minutesUntil = (iso: string) => Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));

/**
 * Development only: verification codes and emailed links go to the backend's in-memory dev outbox, which has
 * no HTTP route yet (BACKEND-REQUESTS R1).
 */
export function DevOutboxHint({ what }: { what: string }) {
  if (!import.meta.env.DEV) return null;
  return (
    <p className="xs muted">
      <Icon name="info" className="ic-sm" /> Development: the {what} goes to the backend's dev outbox, not a real inbox (readable once the dev outbox endpoint exists).
    </p>
  );
}

/**
 * "Continue with Google". Google isn't configured: in development it opens a small dialog and signs in with the
 * backend's dev ID token (`dev:<email>:<first>:<last>`); elsewhere it is disabled with a note.
 * onResult gets the SignInResult (signed_in, or second_factor_required for accounts with 2-step).
 */
export function GoogleButton({ onResult, marketingOptIn }: { onResult: (r: SignInResult) => void; marketingOptIn?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!import.meta.env.DEV)
    return (
      <>
        <Button variant="secondary" block disabled aria-describedby="google-unavailable">
          Continue with Google
        </Button>
        <span className="xs muted center" id="google-unavailable">
          Sign-in with Google isn't available yet.
        </span>
      </>
    );
  return (
    <>
      <Button variant="secondary" block onClick={() => setOpen(true)}>
        Continue with Google
      </Button>
      <DevGoogleDialog open={open} onClose={() => setOpen(false)} onResult={onResult} marketingOptIn={marketingOptIn} />
    </>
  );
}

/** Apple sign-in has no verifier in any environment yet. */
export function AppleButton() {
  return (
    <>
      <Button variant="secondary" block disabled aria-describedby="apple-unavailable">
        Continue with Apple
      </Button>
      <span className="xs muted center" id="apple-unavailable">
        Sign-in with Apple isn't available yet.
      </span>
    </>
  );
}

const NAME_PART_RE = /[:\s]/;

function DevGoogleDialog({ open, onClose, onResult, marketingOptIn }: { open: boolean; onClose: () => void; onResult: (r: SignInResult) => void; marketingOptIn?: boolean }) {
  const { api } = useApi();
  const [form, setForm] = useState({ email: '', first: '', last: '' });
  const [tried, setTried] = useState(false);
  const emailError = tried && !EMAIL_RE.test(form.email.trim()) ? 'Enter an email address, like name@example.com.' : undefined;
  const nameError = (v: string) => (tried && NAME_PART_RE.test(v.trim()) ? 'Use one word, without spaces or colons.' : undefined);
  const signIn = useMutation({
    mutationFn: () => {
      const first = form.first.trim();
      const last = form.last.trim();
      const names = first || last ? `:${first}:${last}` : '';
      return call(
        api.POST('/api/public/identity/external-sign-ins', {
          body: { provider: 'google', idToken: `dev:${form.email.trim()}${names}`, audience: 'store', device: deviceInfo(), marketingOptIn: marketingOptIn ?? false },
          ...WITH_COOKIE,
        }),
      );
    },
    onSuccess: (r) => {
      onClose();
      onResult(r);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // The dialog is portalled, but React events still bubble to the page's own <form>.
    e.stopPropagation();
    setTried(true);
    if (!EMAIL_RE.test(form.email.trim()) || NAME_PART_RE.test(form.first.trim()) || NAME_PART_RE.test(form.last.trim())) return;
    signIn.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Development sign-in"
      size="sm"
      foot={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="dev-google" disabled={signIn.isPending}>
            {signIn.isPending ? 'Signing in…' : 'Continue'}
          </Button>
        </>
      }
    >
      <form id="dev-google" className="stack gap-3" onSubmit={submit} noValidate>
        <p className="small sub">Google isn't configured in development. Enter any email: the backend's dev ID token signs in to that account, or creates a verified one without a password.</p>
        {signIn.isError && (
          <Alert tone="danger" title="Couldn't sign in">
            {authError(signIn.error)}
          </Alert>
        )}
        <Field label="Email" error={emailError}>
          <TextInput id="dg-email" type="email" value={form.email} error={!!emailError} autoComplete="email" onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <div className="grid c2">
          <Field label="First name" optional error={nameError(form.first)}>
            <TextInput id="dg-first" value={form.first} error={!!nameError(form.first)} autoComplete="given-name" onChange={(e) => setForm({ ...form, first: e.target.value })} />
          </Field>
          <Field label="Last name" optional error={nameError(form.last)}>
            <TextInput id="dg-last" value={form.last} error={!!nameError(form.last)} autoComplete="family-name" onChange={(e) => setForm({ ...form, last: e.target.value })} />
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
