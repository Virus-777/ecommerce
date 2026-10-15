/**
 * Pure rules of the reviews module (no I/O): automatic content checks, the seller response rule check,
 * feedback scoring, display names, labels, rating distributions and the moderation reason catalogue.
 */
import { escapeRegExp } from '../../../kernel/lib/text.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import type { ModerationReason, RatingBucket } from '../../../spec/reviews.js';

/** The Official Store's seller id (spec constant) where a column needs a seller id (product_reviews.seller_id, seller_feedback.seller_id …) */
export { OFFICIAL_STORE_ID };
export { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
/** Moderator id of decisions taken by the system or Trust and Risk (moderation_decisions.moderator_id is required) */
export const SYSTEM_MODERATOR_ID = '00000000-0000-0000-0000-000000000000';

export const isSellerId = (s: unknown): s is string => s === OFFICIAL_STORE_ID || (typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s));
export const isOfficial = (sellerId: string | null | undefined) => !sellerId || sellerId === OFFICIAL_STORE_ID;
export const sellerKey = (sellerId: string | null | undefined) => (isOfficial(sellerId) ? OFFICIAL_STORE_ID : sellerId!);

export type ContentType = 'product_review' | 'seller_feedback' | 'question' | 'answer' | 'seller_response';
export type ReportReason =
  | 'off_topic'
  | 'personal_information'
  | 'hate_or_harassment'
  | 'spam_or_links'
  | 'conflict_of_interest'
  | 'fake_or_paid'
  | 'inaccurate'
  | 'medical_claim'
  | 'offensive'
  | 'harms_sales'
  | 'other';

/* ---------------------------------------------------------------- automatic checks */

export interface CheckFailure {
  /** Shown to moderators and in RuleCheck.failures */
  label: string;
  /** Report reason the failure files under (system reports) */
  reason: ReportReason;
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE = /(?:\+?\d[\s().-]?){9,}\d/;
const LINK = /\bhttps?:\/\/|\bwww\.|(?<![@\w.-])[a-z0-9-]+\.(?:com|net|org|io|co|shop|store|biz|info|me|ly|us)\b/i;
const PROFANITY = /\b(?:fuck\w*|shit\w*|bitch\w*|asshole\w*|bastard\w*|cunt\w*|dickhead\w*|motherfuck\w*)\b/i;
const INSULT = /\b(?:idiot|stupid|moron|liar|loser|dumb|pathetic|clown|scammer)\b/i;
const PAYMENT_FOR_REVIEW =
  /\b(?:paid|pay(?:ment)?|refund(?:ed)?|gift ?card|voucher|coupon|discount|free (?:product|item)|compensat\w*|reimburs\w*)\b[^.!?]{0,60}\b(?:review|rating|feedback|stars?)\b|\b(?:review|rating|feedback|stars?)\b[^.!?]{0,60}\b(?:paid|refund(?:ed)?|gift ?card|voucher|coupon|free (?:product|item)|compensat\w*|reimburs\w*)\b/i;
const CHANGE_FOR_REWARD =
  /\b(?:refund|gift|voucher|coupon|discount|credit|free|compensat\w*|money back)\b[^.!?]{0,80}\b(?:change|remove|delete|update|edit|revise|take down|raise)\b[^.!?]{0,40}\b(?:review|rating|feedback|stars?)\b|\b(?:change|remove|delete|update|edit|revise|take down|raise)\b[^.!?]{0,40}\b(?:review|rating|feedback|stars?)\b[^.!?]{0,80}\b(?:refund|gift|voucher|coupon|discount|credit|free|compensat\w*|money back)\b/i;
const OFF_PLATFORM = /\b(?:whats ?app|telegram|wechat|signal me|dm me|text me|call me|e-?mail me|contact me (?:directly|at)|buy (?:it )?directly|outside (?:of )?marketly|off marketly|my (?:own )?(?:website|shop|store) at)\b/i;
const MEDICAL = /\b(?:cures?|cured|treats?|heals?|prevents?|reverses?)\b[^.!?]{0,40}\b(?:cancer|diabetes|covid|disease|infection|depression|arthritis|virus|illness|asthma|insomnia|anxiety)\b/i;
const ORDER_DETAILS = /\b(?:MK|RT)-\d{6}-\d{4,6}\b|\border\s*(?:#|no\.?|number)\s*\w+/i;
const ADDRESS = /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Way|Pl|Place)\b\.?/;

const add = (out: CheckFailure[], cond: boolean, label: string, reason: ReportReason) => {
  if (cond && !out.some((f) => f.label === label)) out.push({ label, reason });
};

/** Product reviews and seller feedback: contact details, links, profanity, payment offers */
export function reviewChecks(...texts: (string | null | undefined)[]): CheckFailure[] {
  const t = texts.filter(Boolean).join('\n');
  const out: CheckFailure[] = [];
  add(out, EMAIL.test(t) || PHONE.test(t), 'Contains contact details', 'personal_information');
  add(out, LINK.test(t), 'Contains a link', 'spam_or_links');
  add(out, PROFANITY.test(t), 'Contains profanity', 'offensive');
  add(out, PAYMENT_FOR_REVIEW.test(t), 'Mentions payment for a review', 'fake_or_paid');
  return out;
}

/** Questions and answers: links, contact details, medical claims, off-platform offers, profanity */
export function qaChecks(text: string): CheckFailure[] {
  const out: CheckFailure[] = [];
  add(out, LINK.test(text), 'Contains a link', 'spam_or_links');
  add(out, EMAIL.test(text) || PHONE.test(text), 'Contains contact details', 'personal_information');
  add(out, MEDICAL.test(text), 'Makes a medical claim', 'medical_claim');
  add(out, OFF_PLATFORM.test(text), 'Asks shoppers to contact or buy off Marketly', 'spam_or_links');
  add(out, PROFANITY.test(text), 'Contains profanity', 'offensive');
  return out;
}

/**
 * Seller response rule check: names beyond what the customer shows, addresses, order details, offers of
 * refunds or gifts for changing feedback, links, contact details and insults.
 */
export function responseChecks(text: string, customer: { shownName: string; privateNames: string[] }): CheckFailure[] {
  const out: CheckFailure[] = [];
  const lower = text.toLowerCase();
  const shown = customer.shownName.toLowerCase();
  const extraName = customer.privateNames
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length >= 3 && !shown.includes(n))
    .some((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`, 'i').test(lower));
  add(out, extraName, "Names the customer beyond what the review shows", 'personal_information');
  add(out, ADDRESS.test(text), 'Contains an address', 'personal_information');
  add(out, ORDER_DETAILS.test(text), 'Mentions order details', 'personal_information');
  add(out, CHANGE_FOR_REWARD.test(text) || PAYMENT_FOR_REVIEW.test(text), 'Offers payment to change a review', 'fake_or_paid');
  add(out, LINK.test(text), 'Contains a link', 'spam_or_links');
  add(out, EMAIL.test(text) || PHONE.test(text), 'Contains contact details', 'personal_information');
  add(out, INSULT.test(text) || PROFANITY.test(text), 'Uses insulting language', 'hate_or_harassment');
  return out;
}

/** Order-specific questions belong in order messages */
export const isOrderSpecific = (text: string) =>
  ORDER_DETAILS.test(text) || /\b(?:my order|my package|my parcel|my delivery|my refund|my tracking|where is my)\b/i.test(text);

/** Mentions of seller service in a product review (moderation hint: such reviews stay, feedback belongs elsewhere) */
export const mentionsSellerService = (text: string) =>
  /\b(?:shipping|shipped|delivery|delivered|arrived|dispatch\w*|packag\w*|seller|courier|late|slow to ship|customer service)\b/i.test(text);

/* ---------------------------------------------------------------- feedback scoring */

/**
 * Overall feedback score 1–5 from the dimensions: the mean of dispatch and (when given) communication,
 * capped at 2 when the item was not as described.
 */
export function overallScore(d: { asDescribed: boolean; dispatchRating: number; communicationRating?: number | null }): number {
  const parts = [d.dispatchRating, ...(d.communicationRating != null ? [d.communicationRating] : [])];
  const avg = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
  const score = Math.min(5, Math.max(1, avg));
  return d.asDescribed ? score : Math.min(score, 2);
}

export function sentimentOf(overall: number, positiveThreshold: number): 'positive' | 'neutral' | 'negative' {
  if (overall >= positiveThreshold) return 'positive';
  if (overall >= positiveThreshold - 1) return 'neutral';
  return 'negative';
}

/* ---------------------------------------------------------------- names and labels */

/** "Sam Rivera" → "Sam R." */
export function shortName(full: string | null | undefined): string {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Marketly customer';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts.at(-1)![0]!.toUpperCase()}.`;
}

export const ANONYMOUS_REVIEWER = 'Marketly customer';
export const ANONYMOUS_ASKER = 'a shopper';

export const REVIEW_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  pending: 'Checking',
  published: 'Published',
  held: 'Hidden: under review',
  edit_requested: 'Edit requested',
  removed: 'Removed',
  deleted: 'Deleted',
};

export const FEEDBACK_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  pending: 'Checking',
  published: 'Published',
  held: 'Hidden: under review',
  removed: 'Removed',
  deleted: 'Deleted',
};

export const REPORT_REASON_LABEL: Record<string, string> = {
  off_topic: 'Off topic',
  personal_information: 'Personal information',
  hate_or_harassment: 'Hate or harassment',
  spam_or_links: 'Spam or links',
  conflict_of_interest: 'Conflict of interest',
  fake_or_paid: 'Fake or paid',
  inaccurate: 'Inaccurate',
  medical_claim: 'Medical claim',
  offensive: 'Offensive',
  harms_sales: 'Harms sales',
  other: 'Other',
};

/** Policy reasons for moderation decisions. legitimate_experience only keeps; harms sales is never a removal reason. */
export const MODERATION_REASONS: ModerationReason[] = [
  { code: 'legitimate_experience', label: "Legitimate experience (keep): describes the author's own experience", removes: false },
  { code: 'personal_information', label: 'Shares personal information', removes: true },
  { code: 'hate_or_harassment', label: 'Hate speech or harassment', removes: true },
  { code: 'spam_or_links', label: 'Spam, links or advertising', removes: true },
  { code: 'off_topic', label: 'Off topic (not about this product or seller)', removes: true },
  { code: 'conflict_of_interest', label: 'Conflict of interest (written by the seller, staff or a competitor)', removes: true },
  { code: 'proven_fake', label: 'Proven fake review', removes: true },
  { code: 'medical_claim', label: 'Unsupported medical claim', removes: true },
  { code: 'off_platform_offer', label: 'Asks shoppers to contact or buy outside Marketly', removes: true },
  { code: 'payment_for_review', label: 'Paid or incentivised review', removes: true },
  { code: 'inaccurate', label: 'Inaccurate or misleading', removes: true },
];

export const reasonLabel = (code: string | null | undefined) => MODERATION_REASONS.find((r) => r.code === code)?.label ?? (code ? (REPORT_REASON_LABEL[code] ?? code) : '');
export const removesContent = (code: string) => MODERATION_REASONS.find((r) => r.code === code)?.removes ?? false;

/** Plain explanations of decisions for authors (reporters are never named) */
export const AUTHOR_TEXT: Record<string, string> = {
  legitimate_experience: 'It describes your own experience, so it stays.',
  personal_information: 'It shares personal information.',
  hate_or_harassment: 'It contains hateful or harassing language.',
  spam_or_links: 'It contains links, contact details or advertising.',
  off_topic: "It isn't about the product or the purchase.",
  conflict_of_interest: 'It was written with a conflict of interest.',
  proven_fake: 'Trust and Risk found it was not a genuine review.',
  medical_claim: 'It makes a medical claim we cannot allow.',
  off_platform_offer: 'It asks shoppers to contact you or buy outside Marketly.',
  payment_for_review: 'It was paid for or offered something in return.',
  inaccurate: 'It contains inaccurate or misleading information.',
};

/** Decision verb (ModerationDecisionInput.decision) → outcome (ModerationOutcome.decision) */
export const OUTCOME_OF: Record<string, 'kept' | 'removed' | 'edit_requested' | 'published'> = {
  keep: 'kept',
  remove: 'removed',
  request_edit: 'edit_requested',
  publish: 'published',
  reject_response: 'removed',
};

/** Decision verb → label for staff lists (ModerationDecisionView.outcomeLabel) */
export const DECISION_LABEL: Record<string, string> = {
  keep: 'Kept',
  remove: 'Removed',
  request_edit: 'Edit requested',
  publish: 'Published',
  reject_response: 'Response rejected',
};

/** Decisions against the author: they can be appealed */
export const ADVERSE = new Set(['remove', 'request_edit', 'reject_response']);

export function reporterOutcomeText(decision: string, reasonCode: string, contentNoun: string): string {
  switch (decision) {
    case 'remove':
    case 'reject_response':
      return `We removed this ${contentNoun}: ${(AUTHOR_TEXT[reasonCode] ?? reasonLabel(reasonCode)).replace(/^It /, 'it ')}`;
    case 'request_edit':
      return `We asked the author to edit this ${contentNoun}. It stays hidden until it is fixed.`;
    case 'publish':
    case 'keep':
    default:
      return reasonCode === 'legitimate_experience'
        ? `We reviewed this ${contentNoun} and kept it: it describes the author's own experience.`
        : `We reviewed this ${contentNoun} and kept it: it does not break our rules.`;
  }
}

export const CONTENT_NOUN: Record<ContentType, string> = {
  product_review: 'review',
  seller_feedback: 'feedback',
  question: 'question',
  answer: 'answer',
  seller_response: 'seller response',
};

/* ---------------------------------------------------------------- summaries */

export function distribution(counts: Record<string, number>, total: number): RatingBucket[] {
  return [5, 4, 3, 2, 1].map((stars) => {
    const count = counts[String(stars)] ?? 0;
    return { stars, count, pct: total ? Math.round((count * 100) / total) : 0 };
  });
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const pct = (n: number, total: number) => (total ? Math.round((n * 100) / total) : null);

export const thousands = (n: number) => n.toLocaleString('en-US');

export function feedbackLabel(positivePct: number | null, count: number): string {
  if (!count || positivePct == null) return 'No feedback yet';
  return `${positivePct}% positive · ${thousands(count)} rating${count === 1 ? '' : 's'}`;
}

/** "1 d", "6 h", "15 min" */
export function ageLabel(from: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${Math.max(min, 1)} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export const DAY = 86_400_000;
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY);

export const excerpt = (text: string | null | undefined, max = 280) => {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** "Color: Midnight black" from variant options */
export const variantLabelOf = (options: Record<string, string> | null | undefined) =>
  Object.entries(options ?? {})
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `${k.charAt(0).toUpperCase()}${k.slice(1)}: ${v}`)
    .join(', ') || null;

export const REVIEW_GUIDELINES = [
  'Describe the product and your own experience with it.',
  'Delivery, packaging and seller service belong in seller feedback, not in the product review.',
  "Don't include personal information, links, prices or contact details.",
  'Reviews are never removed for being negative; offers of payment or gifts for a review are not allowed.',
];
