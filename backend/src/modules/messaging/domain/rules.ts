/**
 * Pure messaging rules: the content filter (contact details and outside links masked, promotional content refused),
 * reply deadlines and the labels the inbox shows. No I/O.
 */
import { OFFICIAL_STORE_ID, OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import type * as common from '../../../spec/common.js';

/** Seller id of the Official Store (spec constant): conversations with the Official Store store it as seller_id */
export { OFFICIAL_STORE_ID };
/** The seller id a conversation keeps for an order package: the seller's, or OFFICIAL_STORE_ID for the Official Store */
export const groupSellerId = (g: { seller: { ownerType: string; id?: string | null } }): string | null => (g.seller.ownerType === 'official' ? OFFICIAL_STORE_ID : (g.seller.id ?? null));
/** A marketplace seller's id: null for the Official Store and for conversations without a seller */
export const marketplaceSellerId = (sellerId: string | null | undefined): string | null => (sellerId && sellerId !== OFFICIAL_STORE_ID ? sellerId : null);
/** An order conversation with the Official Store (null seller ids are rows written before the Official Store had an id) */
export const isOfficialConversation = (c: { kind: string; seller_id: string | null }): boolean => c.kind === 'order' && (!c.seller_id || c.seller_id === OFFICIAL_STORE_ID);

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const SUPPORT_LABEL = 'Marketly Support';
/** Display name of the Official Store (spec constant) */
export { OFFICIAL_STORE_NAME };
/** The support team as a participant when a case joins a conversation before a named agent posts */
export const SUPPORT_TEAM_ID = 'marketly-support';
export const RULES_NOTE = 'Keep payments and contact details on Marketly. No promotional messages.';
export const HIDDEN_NOTE = 'Removed by Marketly because it breaks the messaging rules.';
/** A reply deadline within this window shows as due soon */
export const DUE_SOON_MS = 2 * HOUR;

export type Redaction = 'contact_details' | 'link';
/* ---------------------------------------------------------------- content filter */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// phone numbers: 10 digits with optional country code and separators; references such as MK-261009-00012 are not phones
const PHONE = /(?<![\w-])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}(?![\w-])/g;
const URL_LIKE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const BARE_DOMAIN = /(?<![@\w.-])(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|shop|store|biz|info|me|us|app|link|ly|site|online)\b(?:\/[^\s<>"')]*)?/gi;

export const CONTACT_MASK = '[contact details hidden]';
export const LINK_MASK = '[link hidden]';

const hostOf = (s: string): string | null => {
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Masks email addresses, phone numbers and links outside Marketly. `allowedHosts` are Marketly's own
 * addresses (links to an order or help page stay). Returns the masked body and what was masked.
 */
export function maskContent(body: string, allowedHosts: readonly string[]): { body: string; redactions: Redaction[] } {
  const found = new Set<Redaction>();
  const allowed = (s: string) => {
    const h = hostOf(s);
    return !!h && allowedHosts.some((a) => h === a || h.endsWith(`.${a}`));
  };
  let out = body.replace(EMAIL, () => {
    found.add('contact_details');
    return CONTACT_MASK;
  });
  out = out.replace(URL_LIKE, (m) => {
    if (allowed(m)) return m;
    found.add('link');
    return LINK_MASK;
  });
  out = out.replace(BARE_DOMAIN, (m) => {
    if (allowed(m)) return m;
    found.add('link');
    return LINK_MASK;
  });
  out = out.replace(PHONE, () => {
    found.add('contact_details');
    return CONTACT_MASK;
  });
  return { body: out, redactions: [...found].sort() as Redaction[] };
}

/** Phrases that make a seller message promotional (order messages are for service only) */
const PROMOTIONAL = [
  /\b(?:coupon|promo|discount|voucher)\s*codes?\b/i,
  /\buse\s+(?:the\s+)?code\b/i,
  /\b\d{1,2}\s?%\s*off\b/i,
  /\b(?:flash\s+sale|sale\s+ends|limited[-\s]time\s+offer|special\s+offer|exclusive\s+deal)\b/i,
  /\b(?:follow|like)\s+us\s+on\b/i,
  /\b(?:subscribe|sign\s+up)\s+(?:to|for)\s+(?:our|my)\s+(?:newsletter|mailing\s+list)\b/i,
  /\b(?:check\s+out|browse|shop)\s+(?:our|my)\s+(?:other|new|latest)\s+(?:products|items|collection|arrivals|deals)\b/i,
  /\bbuy\s+(?:directly|direct)\s+from\s+(?:us|me)\b/i,
];

/** The first promotional phrase found, or null */
export function promotionalPhrase(body: string): string | null {
  for (const re of PROMOTIONAL) {
    const m = re.exec(body);
    if (m) return m[0];
  }
  return null;
}

export const preview = (body: string, max = 120) => {
  const one = body.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/* ---------------------------------------------------------------- reply deadlines and labels */

export function deadline(dueAt: Date | null, now: Date, overdue = false): common.Deadline | null {
  if (!dueAt) return null;
  const left = dueAt.getTime() - now.getTime();
  return { dueAt: dueAt.toISOString(), state: overdue || left <= 0 ? 'overdue' : left <= DUE_SOON_MS ? 'due_soon' : 'on_time' };
}

/** 95 minutes → "1 h 35 min", 30 → "30 min", 26 h → "1 d 2 h" */
export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / MINUTE));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 && h < 10 ? `${h} h ${min % 60} min` : `${h} h`;
  const days = Math.floor(h / 24);
  return h % 24 ? `${days} d ${h % 24} h` : `${days} d`;
}

/** e.g. Oct 9, 8:15 AM in the market time zone */
export function shortDateTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
}

/** Seller view: Overdue 2 h / Reply by Oct 9, 8:15 AM / Replied in 1 h */
export function replyLabel(
  c: { reply_state: string; reply_due_at: Date | null },
  lastReplyMs: number | null,
  now: Date,
  timeZone: string,
): string | null {
  if (c.reply_state === 'overdue' && c.reply_due_at) return `Overdue ${duration(now.getTime() - c.reply_due_at.getTime())}`;
  if (c.reply_state === 'awaiting_seller' && c.reply_due_at) return `Reply by ${shortDateTime(c.reply_due_at, timeZone)}`;
  if (c.reply_state === 'replied' && lastReplyMs !== null) return `Replied in ${duration(lastReplyMs)}`;
  return null;
}

/** Customer view of a seller's typical reply time, e.g. Usually replies within 4 hours */
export function responseTimeLabel(averageReplyMinutes: number | null | undefined): string | null {
  if (averageReplyMinutes === null || averageReplyMinutes === undefined) return null;
  if (averageReplyMinutes < 60) return 'Usually replies within an hour';
  const h = Math.ceil(averageReplyMinutes / 60);
  if (h < 24) return `Usually replies within ${h} hour${h === 1 ? '' : 's'}`;
  const days = Math.ceil(h / 24);
  return `Usually replies within ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Reply rounds from a seller conversation's messages (oldest first): a round starts with the first
 * customer message after a seller reply and ends with the next seller message.
 */
export function replyRounds(lines: readonly { conversation_id: string; author_kind: string | null; at: Date }[]): { conversationId: string; start: Date; reply: Date | null }[] {
  const open = new Map<string, Date>();
  const rounds: { conversationId: string; start: Date; reply: Date | null }[] = [];
  for (const m of lines) {
    if (m.author_kind === 'customer' || m.author_kind === 'guest') {
      if (!open.has(m.conversation_id)) open.set(m.conversation_id, m.at);
    } else if (m.author_kind === 'seller') {
      const start = open.get(m.conversation_id);
      if (start) {
        rounds.push({ conversationId: m.conversation_id, start, reply: m.at });
        open.delete(m.conversation_id);
      }
    }
  }
  for (const [conversationId, start] of open) rounds.push({ conversationId, start, reply: null });
  return rounds;
}

/** The items a conversation is about (G45b): Linen duvet cover, 2 × Linen duvet cover, or Linen duvet cover + 2 more items */
export function itemSummary(items: readonly { title: string; quantity: number }[]): string | null {
  const first = items[0];
  if (!first) return null;
  if (items.length === 1) return first.quantity > 1 ? `${first.quantity} × ${first.title}` : first.title;
  const more = items.length - 1;
  return `${first.title} + ${more} more item${more === 1 ? '' : 's'}`;
}

/** Customer-facing short name: Sam Rivera → Sam R. */
export function buyerName(full: string | null | undefined): string {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Buyer';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.` : parts[0]!;
}
