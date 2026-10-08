/** Words people see: masked destinations, device labels and security activity lines. Pure. */

/** j••••••••@example.com */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  const local = email.slice(0, at);
  return `${local[0]}${'•'.repeat(Math.max(3, local.length - 1))}${email.slice(at)}`;
}

/** (503) •••-0148 for North American numbers, otherwise +44 •••• 0148 */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  if (e164.startsWith('+1') && digits.length === 11) return `(${digits.slice(1, 4)}) •••-${last4}`;
  const cc = /^\+(\d{1,3})/.exec(e164)?.[1];
  return `${cc ? `+${cc} ` : ''}•••• ${last4}`;
}

export const isE164 = (phone: string) => /^\+[1-9]\d{6,14}$/.test(phone);

/** 'Chrome on Windows' from a User-Agent (the website sends no device name). */
export function deviceLabelFromUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Web browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Windows NT/.test(ua)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? (os ? `Browser on ${os}` : 'Web browser');
}

export function deviceLabel(device: { kind: 'web' | 'android'; name?: string | null; appVersion?: string | null }, userAgent: string | null | undefined): string {
  if (device.name?.trim()) return device.name.trim().slice(0, 120);
  if (device.kind === 'android') return 'Marketly app on Android';
  return deviceLabelFromUserAgent(userAgent);
}

/* ------------------------------------------------------------------ security activity */

export type SecurityKind =
  | 'signed_in'
  | 'signed_in_new_device'
  | 'sign_in_failed'
  | 'sign_in_blocked'
  | 'signed_out'
  | 'signed_out_everywhere'
  | 'session_revoked'
  | 'refresh_token_reused'
  | 'password_changed'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'forced_password_reset'
  | 'email_verified'
  | 'email_changed'
  | 'two_step_enabled'
  | 'two_step_disabled'
  | 'recovery_codes_regenerated'
  | 'account_locked'
  | 'account_unlocked'
  | 'account_disabled'
  | 'account_enabled'
  | 'seller_context_switched'
  | 'seller_access_granted'
  | 'seller_access_revoked';

const AUDIENCE_NAME: Record<string, string> = { store: 'the store', seller: 'Seller Center', admin: 'Admin Center' };
const minutes = (m: unknown) => (typeof m === 'number' ? `${m} min` : 'a while');

/** The line shown in the security activity list, from the row's kind and detail. */
export function securityLabel(kind: string, detail: Record<string, unknown>, audience: string | null): string {
  const where = audience ? ` to ${AUDIENCE_NAME[audience] ?? audience}` : '';
  switch (kind as SecurityKind) {
    case 'signed_in':
      return `Signed in${where}${detail.method === 'two_step' ? ' with 2-step verification' : ''}`;
    case 'signed_in_new_device':
      return `Signed in${where} from a new device`;
    case 'sign_in_failed':
      if (detail.reason === 'second_factor') return 'Wrong 2-step code';
      if (detail.reason === 'step_up') return 'Wrong password or code when confirming it was you';
      return typeof detail.attemptsLeft === 'number' ? `Wrong password (${detail.attemptsLeft} attempts left)` : 'Wrong password';
    case 'sign_in_blocked':
      return detail.cause === 'disabled' ? 'Sign-in refused: the account is disabled' : 'Sign-in blocked while the account is locked';
    case 'signed_out':
      return detail.device ? `Signed out of ${String(detail.device)}` : 'Signed out';
    case 'signed_out_everywhere':
      return typeof detail.sessions === 'number' ? `Signed out everywhere (${detail.sessions} sessions)` : 'Signed out everywhere';
    case 'session_revoked':
      return typeof detail.sessions === 'number' ? `${detail.sessions} sessions signed out` : 'Session signed out';
    case 'refresh_token_reused':
      return 'A sign-in token was used twice; that session was signed out';
    case 'password_changed':
      return 'Password changed';
    case 'password_reset_requested':
      return detail.forced ? 'Password reset link sent by staff' : 'Password reset link requested';
    case 'password_reset_completed':
      return 'Password reset';
    case 'forced_password_reset':
      return 'Staff required a new password at next sign-in';
    case 'email_verified':
      return 'Email address confirmed';
    case 'email_changed':
      return 'Sign-in email changed';
    case 'two_step_enabled':
      return detail.method === 'sms' ? '2-step verification by text message turned on' : '2-step verification with an authenticator app turned on';
    case 'two_step_disabled':
      return detail.byStaff ? '2-step verification reset by staff' : '2-step verification method removed';
    case 'recovery_codes_regenerated':
      return 'New recovery codes created';
    case 'account_locked':
      return detail.cause === 'failed_sign_ins' ? `${detail.failures ?? 'Too many'} wrong passwords, sign-in blocked for ${minutes(detail.minutes)}` : 'Account locked by staff';
    case 'account_unlocked':
      return detail.cause === 'expired' ? 'Lock ended' : 'Account unlocked';
    case 'account_disabled':
      return 'Account disabled';
    case 'account_enabled':
      return 'Account enabled';
    case 'seller_context_switched':
      return detail.sellerName ? `Switched to ${String(detail.sellerName)}` : 'Switched seller account';
    case 'seller_access_granted':
      return detail.sellerName ? `Can now act for ${String(detail.sellerName)}` : 'Seller access granted';
    case 'seller_access_revoked':
      return detail.sellerName ? `No longer acts for ${String(detail.sellerName)}` : 'Seller access removed';
    default:
      return kind.replace(/_/g, ' ');
  }
}
