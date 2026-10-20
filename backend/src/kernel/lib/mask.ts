/**
 * Masked contact details shown to the person they belong to ("we sent a code to j••••••••@example.com"). Staff without
 * the permission see the stricter field masks of kernel/auth/masking.ts instead.
 */

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
