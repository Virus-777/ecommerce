/**
 * What the development adapters "sent", newest last. Tests and developers read it to see the
 * emails, texts and push notices the platform would have delivered (including verification codes,
 * which are never stored anywhere else). Development and tests only: no network.
 */
import type { OutboundEmail, OutboundPush, OutboundSms } from '../ports.js';

export interface DevSent<T> {
  providerMessageId: string;
  at: string;
  message: T;
}

const MAX = 2_000;

export const devOutbox = {
  email: [] as DevSent<OutboundEmail>[],
  sms: [] as DevSent<OutboundSms>[],
  push: [] as DevSent<OutboundPush>[],
  clear() {
    this.email.length = 0;
    this.sms.length = 0;
    this.push.length = 0;
  },
  /** Emails sent to an address (case-insensitive) */
  emailsTo(address: string) {
    return this.email.filter((e) => e.message.to.toLowerCase() === address.toLowerCase());
  },
};

export function record<T>(list: DevSent<T>[], providerMessageId: string, message: T) {
  list.push({ providerMessageId, at: new Date().toISOString(), message });
  if (list.length > MAX) list.splice(0, list.length - MAX);
}

let counter = 0;
export const devMessageId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++counter).toString(36)}`;

/* ---------------------------------------------------------------- GET /api/dev/outbox (http/dev.ts) */

export type DevChannel = 'email' | 'sms' | 'push';

/** One message as GET /api/dev/outbox shows it */
export interface DevOutboxItem {
  providerMessageId: string;
  at: string;
  channel: DevChannel;
  /** Email address, phone number or push token */
  to: string;
  subject: string | null;
  text: string;
  html: string | null;
  topic: string;
  /** The template variables the message was rendered from (codes, links, names) */
  data: Record<string, unknown>;
  /** Every URL in the message (text, then html), once each */
  links: string[];
}

export interface DevOutboxQuery {
  to?: string;
  channel?: DevChannel;
  since?: Date;
  limit: number;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

/** Every http(s) URL in the texts, in order, once each (&amp; decoded, trailing punctuation dropped) */
export function linksIn(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of (text ?? '').matchAll(URL_PATTERN)) {
      found.add(match[0].replace(/&amp;/g, '&').replace(/[.,;:!?)\]]+$/, ''));
    }
  }
  return [...found];
}

type AnySent = DevSent<OutboundEmail | OutboundSms | OutboundPush>;

function itemOf(channel: DevChannel, sent: AnySent): DevOutboxItem {
  const m = sent.message;
  const email = channel === 'email' ? (m as OutboundEmail) : null;
  const push = channel === 'push' ? (m as OutboundPush) : null;
  const text = push ? push.body : (m as OutboundEmail | OutboundSms).text;
  const html = email?.html ?? null;
  return {
    providerMessageId: sent.providerMessageId,
    at: sent.at,
    channel,
    to: push ? push.token : (m as OutboundEmail | OutboundSms).to,
    subject: email?.subject ?? push?.title ?? null,
    text,
    html,
    topic: m.tags.topicKey,
    data: m.templateData ?? {},
    links: linksIn(text, html),
  };
}

/** The recorded messages, newest first, filtered by recipient (case-insensitive), channel and time */
export function listDevOutbox(q: DevOutboxQuery): DevOutboxItem[] {
  const channels: DevChannel[] = q.channel ? [q.channel] : ['email', 'sms', 'push'];
  const to = q.to?.trim().toLowerCase();
  const since = q.since?.getTime();
  // each list is oldest first: reversed, a stable sort keeps the newest first within the same millisecond
  const items = channels.flatMap((c) => (devOutbox[c] as AnySent[]).map((s) => itemOf(c, s)).reverse());
  return items
    .filter((i) => (!to || i.to.toLowerCase() === to) && (since === undefined || new Date(i.at).getTime() >= since))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, q.limit);
}
