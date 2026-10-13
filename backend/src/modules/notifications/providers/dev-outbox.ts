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
