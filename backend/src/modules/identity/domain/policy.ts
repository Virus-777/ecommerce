/** Password rules (PasswordPolicy) and the sign-in failure counter shared by sign-in and step-up checks. */
import type { PasswordPolicy } from '../../../spec/identity.js';

export type Realm = 'member' | 'staff';
export type PasswordRule = 'min_length' | 'number' | 'uppercase' | 'personal_info' | 'breached';

export const passwordPolicy = (realm: Realm, s: { memberMinPasswordLength: number; staffMinPasswordLength: number }): PasswordPolicy => ({
  minLength: realm === 'staff' ? s.staffMinPasswordLength : s.memberMinPasswordLength,
  requireNumber: true,
  requireUppercase: true,
  disallowNameOrEmail: true,
  rejectBreached: true,
});

/**
 * Offline stand-in for the breached-password range check (the provider is not wired yet): the most
 * common leaked passwords, compared case-insensitively.
 */
const BREACHED = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword1',
  'qwerty123', 'qwerty1234', 'qwertyuiop', '1q2w3e4r5t', '1qaz2wsx3edc', 'iloveyou1', 'iloveyou123', 'letmein123',
  'welcome1', 'welcome123', 'welcome2024', 'welcome2025', 'welcome2026', 'admin1234', 'administrator1', 'changeme1',
  'changeme123', 'trustno1', 'sunshine1', 'football1', 'baseball1', 'superman1', 'dragon123', 'monkey123',
  'abc123456', 'abcd1234', 'aa123456', 'princess1', 'starwars1', 'summer2025', 'summer2026', 'marketly1', 'marketly123',
]);

/** The rules a candidate password breaks (empty = acceptable). `personal`: the email and the person's names. */
export function passwordProblems(password: string, policy: PasswordPolicy, personal: readonly (string | null | undefined)[]): PasswordRule[] {
  const failed: PasswordRule[] = [];
  if ([...password].length < policy.minLength) failed.push('min_length');
  if (policy.requireNumber && !/\d/.test(password)) failed.push('number');
  if (policy.requireUppercase && !/\p{Lu}/u.test(password)) failed.push('uppercase');
  if (policy.disallowNameOrEmail) {
    const lower = password.toLowerCase();
    // the local part of an email and each name, whole and in pieces (j.doe → j, doe); the email domain doesn't count
    const parts = personal
      .map((p) => (p ? p.toLowerCase().split('@')[0]! : ''))
      .flatMap((p) => [p, ...p.split(/[\s._+-]+/)])
      .filter((p) => p.length >= 3);
    if (parts.some((p) => lower.includes(p))) failed.push('personal_info');
  }
  if (policy.rejectBreached && BREACHED.has(password.toLowerCase())) failed.push('breached');
  return failed;
}

/* ------------------------------------------------------------------ failed sign-ins and step-up answers */

export interface FailureState {
  failed_sign_ins: number;
  failed_window_started_at: Date | null;
}

/** Failures that still count (the window is lockoutMinutes long). */
export const failuresInWindow = (a: FailureState, now: Date, lockoutMinutes: number) =>
  a.failed_window_started_at && now.getTime() - a.failed_window_started_at.getTime() < lockoutMinutes * 60_000 ? a.failed_sign_ins : 0;

/** One more wrong answer: the new counter, and whether it reaches the lock. */
export function registerFailure(a: FailureState, now: Date, s: { lockoutMinutes: number; maxFailedSignIns: number }) {
  const current = failuresInWindow(a, now, s.lockoutMinutes);
  const failed = current + 1;
  return {
    failed_sign_ins: failed,
    failed_window_started_at: current === 0 ? now : a.failed_window_started_at,
    lock: failed >= s.maxFailedSignIns,
    attemptsLeft: Math.max(0, s.maxFailedSignIns - failed),
  };
}

/** Whether a lock is in force now (null end = until staff unlock). */
export const lockInForce = (a: { status: string; locked_until: Date | null }, now: Date) => a.status === 'locked' && (a.locked_until === null || a.locked_until > now);

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
