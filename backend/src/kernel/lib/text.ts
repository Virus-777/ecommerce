/**
 * Small text helpers shared by every module (one copy instead of one per repository).
 */

/** Escapes the characters that mean something in a regular expression, so `s` matches itself literally */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
