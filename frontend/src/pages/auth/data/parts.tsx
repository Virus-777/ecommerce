// Building blocks shared by the sign-in, register and recover screens: the auth card shell,
// password field with show/hide, 6-digit code entry, password rules and resend timers.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { Icon } from '@/ui';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** jordan.lee@example.com -> jo•••@example.com */
export const maskEmail = (email: string) => {
  const [local, domain] = email.trim().split('@');
  return domain ? `${local.slice(0, 2)}•••@${domain}` : email;
};

/** Auth pages are for signed-out visitors: the header shows "Hello, Sign in" (as in the design). */
export function useSignedOut() {
  const { setSignedIn } = useSession();
  useEffect(() => setSignedIn(false), [setSignedIn]);
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

/** Six single-digit inputs (.buy-code): typing moves on, Backspace moves back, pasting fills all. */
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

export const emptyCode = () => Array.from({ length: 6 }, () => '');

/** The four password rules with met / not-met state (.buy-rules). */
export function passwordChecks(pw: string, avoid: string[]) {
  const lower = pw.toLowerCase();
  const personal = avoid.map((a) => a.trim().toLowerCase()).filter((a) => a.length >= 3);
  return [
    { label: 'At least 10 characters', ok: pw.length >= 10 },
    { label: 'One number', ok: /\d/.test(pw) },
    { label: 'One uppercase letter', ok: /[A-Z]/.test(pw) },
    { label: 'Not your email or name', ok: pw.length > 0 && !personal.some((a) => lower.includes(a)) },
  ];
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

/** Countdown in seconds with a restart (resend timers). */
export function useResendTimer(seconds: number): [number, () => void] {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  const restart = useCallback(() => setLeft(seconds), [seconds]);
  return [left, restart];
}

export const mss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
