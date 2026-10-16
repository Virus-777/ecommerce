import { ApiError, errorMessage, mediaFileName, type components } from '@marketly/web-shared/api';

// Types, labels and rules for the Store customers screen (messaging + reviews APIs).

type S = components['schemas'];
export type ConversationSummary = S['messaging.ConversationSummary'];
export type Conversation = S['messaging.Conversation'];
export type Message = S['messaging.Message'];
export type ReplyTemplate = S['messaging.ReplyTemplate'];
export type ResponseStats = S['messaging.ResponseStats'];
export type QuestionRow = S['reviews.SellerQuestionRow'];
export type Answer = S['reviews.Answer'];
export type FeedbackRow = S['reviews.SellerFeedbackRow'];
export type FeedbackSummary = S['reviews.SellerFeedbackSummary'];
export type SellerResponse = S['reviews.SellerResponse'];

export type InboxFilter = 'all' | 'awaiting_reply' | 'overdue' | 'unread';
export const INBOX_FILTERS: { value: InboxFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'awaiting_reply', label: 'Awaiting reply' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'unread', label: 'Unread' },
];

/** Limits the API enforces (messaging settings messageMaxLength / maxAttachments / maxAttachmentMb; reviews service). */
export const MESSAGE_MAX_LENGTH = 4000;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_MB = 10;
export const ATTACHMENT_TYPES = 'image/jpeg,image/png,image/webp,image/heic,application/pdf';
export const ANSWER_MIN_LENGTH = 2;
export const ANSWER_MAX_LENGTH = 1000;
export const RESPONSE_MAX_LENGTH = 2000;
export const TEMPLATE_NAME_MAX = 80;

/* ---------------------------------------------------------------- dates (market time zone) */

const TZ = 'America/Los_Angeles';
const fmt = (iso: string | Date, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, ...o });
const sameYear = (iso: string) => fmt(iso, { year: 'numeric' }) === fmt(new Date(), { year: 'numeric' });

/** "Oct 7" (with the year when it isn't this year) */
export const shortDate = (iso: string) => fmt(iso, { month: 'short', day: 'numeric', ...(sameYear(iso) ? {} : { year: 'numeric' }) });
/** "Oct 7, 7:40 PM" */
export const dateTime = (iso: string) => `${shortDate(iso)}, ${fmt(iso, { hour: 'numeric', minute: '2-digit' })}`;

/** "9 h 30 min" / "45 min" */
export function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

/* ---------------------------------------------------------------- order messages */

/** The buyer is waiting for the seller. */
export const awaiting = (c: Pick<ConversationSummary, 'replyState'>) => c.replyState === 'awaiting_seller' || c.replyState === 'overdue';

/** Deadline tone of a conversation waiting for a reply: overdue → danger, due soon → warning, otherwise plain text. */
export function dueTone(c: Pick<ConversationSummary, 'replyState' | 'replyDue'>): 'danger' | 'warning' | undefined {
  if (c.replyState === 'overdue' || c.replyDue?.state === 'overdue') return 'danger';
  if (c.replyState === 'awaiting_seller' && c.replyDue?.state === 'due_soon') return 'warning';
  return undefined;
}

/** Reply label for a full conversation (the summary carries the server's replyLabel). */
export function replyLabel(c: Pick<Conversation, 'replyState' | 'replyDue'>): string {
  if (!c.replyDue) return '';
  return c.replyState === 'overdue' ? `Reply was due ${dateTime(c.replyDue.dueAt)}` : `Reply by ${dateTime(c.replyDue.dueAt)}`;
}

/** Order, return or case reference shown under the buyer's name. */
export const subjectRef = (s: ConversationSummary['subject']) => s.orderRef ?? s.returnRef ?? s.caseRef ?? '';

/** What the conversation is about, without repeating the order number ("Order MK-…" titles show the package instead). */
export function subjectLine(s: ConversationSummary['subject']): string {
  const ref = subjectRef(s);
  if (ref && s.title.includes(ref)) return s.packageLabel ?? '';
  return [s.title, s.packageLabel].filter(Boolean).join(' · ');
}

export function subjectNoun(s: ConversationSummary['subject']): string {
  return s.kind === 'return' ? 'return' : s.kind === 'case' ? 'case' : s.kind === 'order_item' ? 'item' : 'order';
}

/** File name of an attachment: the uploaded file name, else alt text, else the last path segment of its URL. */
export function attachmentName(a: Message['attachments'][number], i: number): string {
  if (a.fileName) return mediaFileName(a);
  if (a.alt) return a.alt;
  try {
    const last = decodeURIComponent(new URL(a.url).pathname.split('/').pop() ?? '');
    if (last && /\.[a-z0-9]{2,5}$/i.test(last) && !/^(original|thumb|small|medium|large)\./.test(last)) return last;
  } catch {
    /* not a URL */
  }
  return `Attachment ${i + 1}`;
}

export const MESSAGE_REPORT_REASONS: { value: 'abusive' | 'spam_or_promotion' | 'off_platform_contact' | 'fraud' | 'other'; label: string }[] = [
  { value: 'abusive', label: 'Abusive or threatening' },
  { value: 'spam_or_promotion', label: 'Spam or promotion' },
  { value: 'off_platform_contact', label: 'Asks to deal outside Marketly' },
  { value: 'fraud', label: 'Suspected fraud' },
  { value: 'other', label: 'Something else' },
];

/* ---------------------------------------------------------------- public text (answers and responses) */

/** Public text must not carry contact details or outside links (design rules; the API also checks and holds). */
export function publicTextError(t: string, empty: string, what = 'Public answers'): string {
  if (!t.trim()) return empty;
  if (/https?:\/\/|www\.|\.(com|net|org)\b/i.test(t)) return `Remove the link. ${what} can’t contain outside links.`;
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(t) || /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(t)) return 'Remove the contact details. Keep the conversation on Marketly.';
  return '';
}

/** The seller's own answer on a question (latest first). */
export const ownAnswer = (row: QuestionRow, sellerId: string): Answer | undefined =>
  row.question.answers.filter((a) => a.label === 'seller' && a.by.sellerId === sellerId).sort((a, b) => b.answeredAt.localeCompare(a.answeredAt))[0];

export const ANSWER_STATUS: Record<Answer['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'info' | '' }> = {
  published: { label: 'Published', tone: 'success' },
  pending_review: { label: 'In review', tone: 'warning' },
  edit_requested: { label: 'Edit requested', tone: 'danger' },
  removed: { label: 'Removed', tone: '' },
};

export const RESPONSE_STATUS: Record<SellerResponse['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'info' }> = {
  published: { label: 'Published', tone: 'success' },
  pending: { label: 'Pending', tone: 'info' },
  held: { label: 'Held for review', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'danger' },
};

export const FEEDBACK_REPORT_REASONS: { value: S['reviews.ReportInput']['reason']; label: string }[] = [
  { value: 'off_topic', label: 'About the product, not my service' },
  { value: 'personal_information', label: 'Contains personal information' },
  { value: 'hate_or_harassment', label: 'Hate or harassment' },
  { value: 'spam_or_links', label: 'Spam or links' },
  { value: 'offensive', label: 'Offensive language' },
  { value: 'fake_or_paid', label: 'Fake or paid feedback' },
  { value: 'inaccurate', label: 'Factually wrong' },
  { value: 'other', label: 'Something else' },
];

/** Copy for write errors: known codes from the messaging and reviews docs, field errors, else the server message. */
export function writeError(e: unknown, field?: string): string {
  if (e instanceof ApiError) {
    if (e.code === 'VALIDATION_FAILED' && field && e.fieldErrors[field]) return e.fieldErrors[field];
    switch (e.code) {
      case 'CONVERSATION_LOCKED':
        return e.details.reason === 'archived' ? 'This conversation is archived and takes no new messages.' : 'Marketly locked this conversation. You can still read it, but not reply.';
      case 'NOT_AN_OFFER_SELLER':
        return 'Only sellers with an offer on this product can answer as the seller.';
      case 'RESPONSE_ALREADY_EXISTS':
        return 'You already responded to this feedback. Reload to edit your response.';
      case 'RESPONSE_EDIT_WINDOW_CLOSED':
        return 'The edit window for this response has closed.';
      case 'ALREADY_REPORTED':
        return 'You already reported this. Marketly will let you know the outcome.';
      case 'ILLEGAL_TRANSITION':
        return 'This can’t be edited right now. Reload to see its current state.';
      case 'FORBIDDEN':
        return 'Your role doesn’t allow this. Ask the store owner for access.';
    }
  }
  return errorMessage(e);
}
