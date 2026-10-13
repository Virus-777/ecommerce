import type { components } from '@marketly/web-shared/api';
import type { Tone } from '@marketly/web-shared/ui';

// Admin Reviews and Q&A moderation (design: pages/admin/admin-reviews*.html), fed by
// GET /api/admin/reviews/moderation-items (+ /summary, /{id}, /moderation-reasons).

export type ModerationItem = components['schemas']['reviews.ModerationItem'];
export type ModerationDetail = components['schemas']['reviews.ModerationDetail'];
export type ModerationReason = { code: string; label: string; removes: boolean };
export type ContentType = ModerationItem['contentType'];
export type ReasonCode = 'legitimate_experience' | 'personal_information' | 'hate_or_harassment' | 'spam_or_links' | 'off_topic' | 'conflict_of_interest' | 'proven_fake' | 'medical_claim' | 'off_platform_offer' | 'payment_for_review' | 'inaccurate';

export const LEGIT = 'legitimate_experience';

export const KIND_LABEL: Record<ContentType, string> = {
  product_review: 'Product review',
  seller_feedback: 'Seller feedback',
  question: 'Q&A question',
  answer: 'Q&A answer',
  seller_response: 'Seller response',
};
export const NOUN: Record<ContentType, string> = { product_review: 'review', seller_feedback: 'feedback', question: 'question', answer: 'answer', seller_response: 'response' };

/** Which tab a moderation item belongs to. */
export const isReported = (i: ModerationItem) => i.queue === 'reported' || i.queue === 'auto_held' || i.queue === 'appeal';
export const isQa = (i: ModerationItem) => i.queue === 'qa_check';
export const isResponse = (i: ModerationItem) => i.queue === 'response_check';

/** Human label for a reason code ("off_topic" → "Off topic"), using the API's policy reasons when loaded. */
export function reasonLabel(code: string, reasons?: ModerationReason[]): string {
  const r = reasons?.find((x) => x.code === code);
  if (r) return r.label.split(/[:(]/)[0].trim();
  const s = code.replace(/_/g, ' ');
  return s[0]?.toUpperCase() + s.slice(1);
}
export const reasonTone = (code: string): Tone => (/personal|hate|harass|payment|fake|medical/.test(code) ? 'danger' : 'warning');

export type RowAction = 'keep' | 'staff' | 'edit' | 'remove' | 'publish' | 'reject' | 'trust';
export type Edge = '' | 'warn' | 'flagged';

/** Actions a held Q&A answer or seller response offers. */
export function rowActions(i: ModerationItem): RowAction[] {
  if (i.queue === 'response_check') return i.ruleCheck && !i.ruleCheck.passed ? ['reject', 'trust'] : ['publish', 'reject'];
  if (i.author.kind === 'staff') return ['publish', 'remove'];
  const failed = i.ruleCheck && !i.ruleCheck.passed;
  return failed ? ['edit', 'remove'] : ['keep', 'staff', 'remove'];
}

export function rowEdge(i: ModerationItem): Edge {
  if (i.reasons.some((r) => /payment|medical|fake/.test(r))) return 'flagged';
  if (i.ruleCheck && !i.ruleCheck.passed) return 'warn';
  return '';
}

export const AUTHOR_BADGE = (i: ModerationItem): { label: string; tone: Tone } =>
  i.author.kind === 'staff' ? { label: 'Marketly staff', tone: 'brand' } : i.author.kind === 'seller' ? { label: `Seller · ${i.author.displayName}`, tone: 'info' } : { label: 'Customer', tone: '' };
