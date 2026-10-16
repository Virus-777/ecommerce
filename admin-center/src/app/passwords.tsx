import { useEffect, useState } from 'react';
import { ApiError, errorMessage, type components } from '@marketly/web-shared/api';
import { Icon } from '@marketly/web-shared/ui';

// Shared by the public staff pages (accept an invitation, reset a password): the token from a link's fragment,
// the password rules the server sends, and readable messages for its password errors.

export type PasswordPolicy = components['schemas']['identity.PasswordPolicy'];

/**
 * Reads `#token=…` once and removes it from the address bar (history.replaceState), so the token never stays in
 * the URL, history or a shared screenshot. It goes in request bodies only.
 */
export function useHashToken(): string {
  const [token] = useState(() => {
    const t = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    // Kept in memory for this page: React's development double render (and a remount) would otherwise read the
    // address again after the fragment is gone.
    if (t) captured = { path: window.location.pathname, token: t };
    return captured?.path === window.location.pathname ? captured.token : '';
  });
  useEffect(() => {
    if (window.location.hash) history.replaceState(history.state, '', window.location.pathname + window.location.search);
  }, []);
  return token;
}

let captured: { path: string; token: string } | null = null;

const FAILED_TEXT: Record<string, (p?: PasswordPolicy) => string> = {
  min_length: (p) => `Use at least ${p?.minLength ?? 12} characters.`,
  number: () => 'Add a number.',
  uppercase: () => 'Add a capital letter.',
  personal_info: () => 'Don’t use your name or email address.',
  breached: () => 'This password appears in known data breaches. Choose another.',
};

/** The message for a password the server refused (WEAK_PASSWORD lists the failed rules in details.failed). */
export function passwordError(e: unknown, policy?: PasswordPolicy): string {
  if (e instanceof ApiError && e.code === 'WEAK_PASSWORD') {
    const failed = (e.details.failed as string[] | undefined) ?? [];
    return failed.map((f) => FAILED_TEXT[f]?.(policy) ?? f).join(' ') || 'Choose a stronger password.';
  }
  if (e instanceof ApiError && e.code === 'PASSWORD_REUSED') return 'Choose a password you have not used recently.';
  return errorMessage(e);
}

/** Checks the rules the browser can check (length, number, capital, name/email) before sending. */
export function checkPassword(pw: string, policy: PasswordPolicy | undefined, personal: string[] = []): string[] {
  const min = policy?.minLength ?? 12;
  const out: string[] = [];
  if (pw.length < min) out.push(FAILED_TEXT.min_length(policy));
  if ((policy?.requireNumber ?? true) && !/\d/.test(pw)) out.push(FAILED_TEXT.number());
  if ((policy?.requireUppercase ?? true) && !/[A-Z]/.test(pw)) out.push(FAILED_TEXT.uppercase());
  if ((policy?.disallowNameOrEmail ?? true) && personal.some((w) => w.length >= 3 && pw.toLowerCase().includes(w.toLowerCase()))) out.push(FAILED_TEXT.personal_info());
  return out;
}

/** The rules as a checklist under the password field. */
export function PasswordRules({ policy, password }: { policy?: PasswordPolicy; password: string }) {
  const min = policy?.minLength ?? 12;
  const rules = [
    { ok: password.length >= min, text: `At least ${min} characters` },
    ...((policy?.requireNumber ?? true) ? [{ ok: /\d/.test(password), text: 'A number' }] : []),
    ...((policy?.requireUppercase ?? true) ? [{ ok: /[A-Z]/.test(password), text: 'A capital letter' }] : []),
    ...((policy?.disallowNameOrEmail ?? true) ? [{ ok: null, text: 'Not your name or email' }] : []),
    ...((policy?.rejectBreached ?? true) ? [{ ok: null, text: 'Not a password from a known data breach' }] : []),
  ];
  return (
    <ul className="stack gap-1 xs" aria-label="Password rules">
      {rules.map((r) => (
        <li key={r.text} className={r.ok ? 't-success-text row gap-1' : 'muted row gap-1'}>
          <Icon name={r.ok ? 'circle-check' : 'circle'} className="ic-sm" />
          {r.text}
        </li>
      ))}
    </ul>
  );
}
