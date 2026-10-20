/**
 * Pure rules: addresses (hash and mask), retry backoff, quiet hours, deadlines, channel settings,
 * seller member preferences and visibility, signed tokens. No I/O.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { Deadline } from '../../../spec/common.js';
import type { ChannelSetting, MemberPreference, Topic } from '../../../spec/notifications.js';
import { CHANNEL_PHASE, CHANNELS, SELLER_GROUPS, topicVariables, type Channel, type SellerPrefGroup, type TopicDef } from './catalog.js';

/* ------------------------------------------------------------------ addresses */

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const normalizePhone = (phone: string) => phone.replace(/[^\d+]/g, '');

export function normalizeAddress(channel: 'email' | 'sms' | 'push', address: string) {
  if (channel === 'email') return normalizeEmail(address);
  if (channel === 'sms') return normalizePhone(address);
  return address.trim();
}

export const hashAddress = (channel: 'email' | 'sms' | 'push', address: string) =>
  createHash('sha256').update(`${channel}:${normalizeAddress(channel, address)}`).digest('hex');

export function maskAddress(channel: 'email' | 'sms' | 'push', address: string): string {
  const a = normalizeAddress(channel, address);
  if (channel === 'email') {
    const [user = '', domain = ''] = a.split('@');
    return `${user.slice(0, 1)}***@${domain}`;
  }
  if (channel === 'sms') return `***${a.slice(-4)}`;
  return `…${a.slice(-6)}`;
}

export const emailDomain = (email: string) => normalizeEmail(email).split('@')[1] ?? '';

/* ------------------------------------------------------------------ retries */

/** Delay before the next attempt after `attempts` attempts (1-based), from retryBackoffMinutes */
export function backoffMs(attempts: number, backoffMinutes: readonly number[]): number {
  const list = backoffMinutes.length ? backoffMinutes : [1];
  return (list[Math.min(Math.max(attempts, 1), list.length) - 1] ?? 1) * 60_000;
}

/* ------------------------------------------------------------------ time */

function wallClock(at: Date, timeZone: string): { minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { minutes: Number(get('hour')) * 60 + Number(get('minute')), date: `${get('year')}-${get('month')}-${get('day')}` };
}

const toMinutes = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** When a promotional SMS or push may go out: now, or the end of the quiet window (market time) */
export function quietHoursEnd(at: Date, window: { from: string; to: string }, timeZone: string): Date | null {
  const { minutes } = wallClock(at, timeZone);
  const from = toMinutes(window.from);
  const to = toMinutes(window.to);
  const inside = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  if (!inside) return null;
  const wait = (to - minutes + 24 * 60) % (24 * 60);
  const end = new Date(at.getTime() + wait * 60_000);
  end.setUTCSeconds(0, 0);
  return end;
}

export function deadlineOf(dueAt: Date | null | undefined, now: Date): Deadline | null {
  if (!dueAt) return null;
  const left = dueAt.getTime() - now.getTime();
  return { dueAt: dueAt.toISOString(), state: left < 0 ? 'overdue' : left < 24 * 3_600_000 ? 'due_soon' : 'on_time' };
}

export const formatDate = (iso: string | Date | null | undefined, timeZone: string, withTime = false) => {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(d);
};

/* ------------------------------------------------------------------ topic channels */

export type ChannelMap = Record<Channel, boolean>;

export function channelSettings(t: TopicDef, enabled: Partial<ChannelMap>, launchPhase: number): ChannelSetting[] {
  return CHANNELS.map((channel) => {
    const supported = t.supports.includes(channel);
    const available = supported && CHANNEL_PHASE[channel] <= launchPhase && t.phase <= launchPhase;
    const locked = !supported || (channel === 'in_app' && t.category === 'essential');
    return { channel, enabled: supported && (enabled[channel] ?? t.channels[channel]), available, locked };
  });
}

/** Whether a channel is on and live for a topic now */
export const channelLive = (t: TopicDef, enabled: Partial<ChannelMap>, channel: Channel, launchPhase: number) => {
  const s = channelSettings(t, enabled, launchPhase).find((c) => c.channel === channel)!;
  return s.enabled && s.available;
};

export function topicView(t: TopicDef, enabled: Partial<ChannelMap>, launchPhase: number): Topic {
  return {
    key: t.key,
    audience: t.audience,
    category: t.category,
    group: t.group,
    label: t.label,
    description: t.description,
    triggers: t.triggers,
    opens: t.opens,
    channels: channelSettings(t, enabled, launchPhase),
    actionRequired: t.actionRequired,
    staffRoleKeys: t.staffRoleKeys,
    sellerPermission: t.sellerPermission,
    ownerOnly: t.ownerOnly,
    frequencyLabel: t.frequencyLabel,
    variables: topicVariables(t),
    phase: t.phase,
  };
}

/* ------------------------------------------------------------------ seller members */

export interface MemberAccessLike {
  isOwner: boolean;
  permissions: readonly string[];
  role?: string;
}

export type MemberChannel = MemberPreference['channel'];

export function defaultGroups(isOwner: boolean): Record<SellerPrefGroup, boolean> {
  return Object.fromEntries(SELLER_GROUPS.map((g) => [g.key, g.ownerOnly ? isOwner : g.defaultOn])) as Record<SellerPrefGroup, boolean>;
}

export const defaultMemberChannel = (isOwner: boolean): MemberChannel => (isOwner ? 'in_app_and_email' : 'in_app');

/** Groups a member cannot change: the owner's essential groups, owner-only groups for everyone else */
export const lockedGroups = (isOwner: boolean): SellerPrefGroup[] =>
  SELLER_GROUPS.filter((g) => (isOwner ? g.essentialForOwner : g.ownerOnly)).map((g) => g.key);

/** Effective groups (stored preferences, with locks applied) */
export function effectiveGroups(stored: Record<string, unknown> | null | undefined, isOwner: boolean): Record<SellerPrefGroup, boolean> {
  const out = defaultGroups(isOwner);
  for (const g of SELLER_GROUPS) {
    const v = stored?.[g.key];
    if (typeof v === 'boolean') out[g.key] = v;
    if (isOwner && g.essentialForOwner) out[g.key] = true;
    if (!isOwner && g.ownerOnly) out[g.key] = false;
  }
  return out;
}

const holds = (a: MemberAccessLike, permission: string | null | undefined) => !permission || a.isOwner || a.permissions.includes(permission);

/** May this member receive a seller topic (permission, owner-only, preference group)? */
export function memberReceives(t: TopicDef, a: MemberAccessLike, groups: Record<string, boolean>): boolean {
  if (t.audience !== 'seller') return false;
  if (t.ownerOnly && !a.isOwner) return false;
  if (!holds(a, t.sellerPermission)) return false;
  const g = SELLER_GROUPS.find((x) => x.key === t.prefGroup);
  if (g) {
    if (g.ownerOnly && !a.isOwner) return false;
    if (!holds(a, g.permission)) return false;
    if (a.isOwner && g.essentialForOwner) return true;
    return groups[g.key] ?? g.defaultOn;
  }
  return true;
}

/** Owners always get essential notices by email; others follow their channel choice */
export function memberEmails(t: TopicDef, a: MemberAccessLike, channel: MemberChannel): boolean {
  const g = SELLER_GROUPS.find((x) => x.key === t.prefGroup);
  if (a.isOwner && t.category === 'essential' && (t.ownerOnly || !g || g.essentialForOwner)) return true;
  return channel === 'email' || channel === 'in_app_and_email';
}

/* ------------------------------------------------------------------ signed tokens */

const b64 = (s: string) => Buffer.from(s).toString('base64url');

export function signToken(secret: string, payload: Record<string, unknown>): string {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(body).digest('base64url').slice(0, 32);
  return `${body}.${mac}`;
}

export function verifyToken<T>(secret: string, token: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url').slice(0, 32);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ reply-to tokens */

const REPLY_MODULES = { support: 's', messaging: 'm' } as const;
const replyMac = (secret: string, body: string, email: string) =>
  createHmac('sha256', secret).update(`${body}|${normalizeEmail(email)}`).digest('base64url').slice(0, 16).replace(/[-_]/g, 'x');

/**
 * Compact reply-to token for reply+<token>@replyDomain (fits the 64-character local part):
 * module letter, record id (hex), expiry day (base 36) and a MAC over those and the recipient's
 * address, so a reply from another address is not accepted.
 */
export function replyToken(secret: string, module: 'support' | 'messaging', refId: string, email: string, expiresAt: Date): string {
  const body = `${REPLY_MODULES[module]}${refId.replace(/-/g, '').toLowerCase()}${Math.floor(expiresAt.getTime() / 86_400_000).toString(36)}`;
  return `${body}.${replyMac(secret, body, email)}`;
}

export function parseReplyToken(secret: string, token: string, fromEmail: string, now: Date): { module: 'support' | 'messaging'; refId: string } | null {
  const m = /^([sm])([0-9a-f]{32})([0-9a-z]+)\.([A-Za-z0-9]{16})$/.exec(token);
  if (!m) return null;
  const letter = m[1]!;
  const hex = m[2]!;
  const exp = m[3]!;
  const mac = m[4]!;
  const expected = replyMac(secret, `${letter}${hex}${exp}`, fromEmail);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  if (parseInt(exp, 36) * 86_400_000 + 86_400_000 < now.getTime()) return null;
  const refId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { module: letter === 's' ? 'support' : 'messaging', refId };
}
