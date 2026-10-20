/**
 * Shared plumbing of the messaging use cases: time, settings, events, audit, optional modules, who the caller is
 * (Viewer), record scope, the views (Conversation, ConversationSummary, Message) and posting a message (content
 * filter, attachments, read state, reply state, events).
 */
import { AppError, isAppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type * as media from '../../../spec/media.js';
import type { Conversation, ConversationSummary, Counterparty, Message, Participant, Subject } from '../../../spec/messaging.js';
import type * as orders from '../../../spec/orders.js';
import type * as sellers from '../../../spec/sellers.js';
import {
  deadline,
  groupSellerId,
  itemSummary,
  isOfficialConversation,
  marketplaceSellerId,
  HIDDEN_NOTE,
  HOUR,
  maskContent,
  OFFICIAL_STORE_NAME,
  preview,
  promotionalPhrase,
  replyLabel,
  responseTimeLabel,
  RULES_NOTE,
  shortDateTime,
  SUPPORT_LABEL,
  type Redaction,
} from '../domain/rules.js';
import { sellerReplyMachine } from '../domain/state-machines.js';
import type { ConversationRec, MessageLine, MessageRec, ParticipantRec } from '../ports.js';
import type { MessagingRepository } from '../repository.js';

export interface MessagingServiceDeps {
  repo: MessagingRepository;
  ctx: ModuleContext<'messaging'>;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
}

/** The caller, resolved to the ids conversations are keyed by */
export type Viewer =
  | { kind: 'customer'; customerId: string | null; guestSessionId: string | null; accountId: string | null }
  | { kind: 'seller'; sellerId: string; accountId: string | null; name: string | null }
  | { kind: 'staff'; accountId: string; name: string | null };

/** Who writes a message */
export interface Author {
  kind: 'customer' | 'guest' | 'seller' | 'staff';
  id: string;
  label: string;
  /** Media owner the attachments must belong to */
  mediaOwner: media.MediaOwner;
  /** Staff joining from a case */
  caseId?: string | null;
  participantName?: string;
  participantLabel?: string;
}

export interface MessageInputLike {
  body: string;
  mediaIds?: string[] | null;
  clientMessageId?: string | null;
}

/** A message checked and masked, ready to store */
export interface Prepared {
  id: string;
  body: string;
  original: string | null;
  redactions: Redaction[];
  mediaIds: string[];
  clientMessageId: string | null;
}

/** Settings read before a transaction (settings use their own connection) */
export interface Cfg {
  targetHours: number;
  mask: boolean;
  maxAttachments: number;
  maxAttachmentMb: number;
  maxLength: number;
  archiveAfterDays: number;
}

export const SYSTEM: common.Actor = { kind: 'system', id: null };

type OwnEvent = keyof EventMap & `messaging.${string}`;
type Optional = Parameters<ModuleContext<'messaging'>['tryUse']>[0];

export const notFound = (what = 'Conversation') => new AppError('NOT_FOUND', `${what} not found`);
export const invalid = (issues: { path: string; message: string }[], message = 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });

const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] || null;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** The guest participant of a guest order's conversations (decision D-M2: keyed by the order, not the session) */
export const guestKey = (orderId: string) => `order:${orderId}`;

/**
 * The participant key of a viewer (messages are authored under the same key). A guest is the order's guest
 * participant in a conversation about that order; without a conversation the session id stands in (legacy rows).
 */
export function meOf(v: Viewer, c?: { order_id: string | null } | null): { kind: string; id: string } {
  if (v.kind === 'seller') return { kind: 'seller', id: v.sellerId };
  if (v.kind === 'staff') return { kind: 'staff', id: v.accountId };
  if (v.customerId) return { kind: 'customer', id: v.customerId };
  if (c?.order_id) return { kind: 'guest', id: guestKey(c.order_id) };
  return { kind: 'customer', id: v.guestSessionId ?? '' };
}

/** Everything a conversation view needs, loaded for a set of conversations at once */
export interface Bundle {
  conv: ConversationRec;
  participants: ParticipantRec[];
  /** Newest first */
  recent: MessageLine[];
}

export interface ViewExtras {
  cards?: Map<string, sellers.SellerSummary>;
  /** 30-day average reply minutes per seller (seller_reply_stats) */
  replyStats?: Map<string, number | null>;
  /** Live subject (order, item, return or case status) */
  subject?: Subject;
  dispatchWarning?: string | null;
  /** False when the customer may not send now (messaging restriction) */
  mayWrite?: boolean;
}

export class Core {
  readonly repo: MessagingRepository;
  readonly ctx: ModuleContext<'messaging'>;

  constructor(deps: MessagingServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
  }

  now = () => this.ctx.clock.now();
  get tz() {
    return this.ctx.config.market.timeZone;
  }
  today = (at: Date = this.now()) => dateInZone(at, this.tz);
  error = (code: string, message?: string, details?: unknown) => this.ctx.error(code, message, details);

  async cfg(): Promise<Cfg> {
    const s = this.ctx.settings;
    const [targetHours, mask, maxAttachments, maxAttachmentMb, maxLength, archiveAfterDays] = await Promise.all([
      s.get('sellerReplyTargetHours'),
      s.get('maskContactDetails'),
      s.get('maxAttachments'),
      s.get('maxAttachmentMb'),
      s.get('messageMaxLength'),
      s.get('archiveAfterDays'),
    ]);
    return {
      targetHours: Number(targetHours ?? 24),
      mask: mask !== false,
      maxAttachments: Number(maxAttachments ?? 5),
      maxAttachmentMb: Number(maxAttachmentMb ?? 10),
      maxLength: Number(maxLength ?? 4000),
      archiveAfterDays: Number(archiveAfterDays ?? 180),
    };
  }

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      // the change is committed; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }

  /** An optional module's answer for display; off, not built or failing → undefined (the view degrades) */
  async soft<M extends Optional, R>(module: M, what: string, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, module, what }, 'messaging: optional source failed');
      return undefined;
    }
  }

  /** Orders' answer for display; failing → undefined */
  async orderOf(orderId: string | null): Promise<orders.OrderDetail | undefined> {
    if (!orderId) return undefined;
    try {
      return (await this.ctx.use('orders').getOrder(orderId)) ?? undefined;
    } catch (err) {
      this.ctx.log.warn({ err, orderId }, 'messaging: order unavailable');
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- viewers and record scope */

  /**
   * A public-API participant as a Viewer. Customer actors carry the customers-module id (the customer participant's
   * id; account ids are not accepted, decision: customer id and account id stay separate). Seller actors carry the
   * seller id, staff the staff account id, visitors the guest session id.
   */
  async viewerOf(p: common.Actor): Promise<Viewer | null> {
    if (!p?.id) return null;
    if (p.kind === 'seller') return { kind: 'seller', sellerId: p.id, accountId: null, name: p.name ?? null };
    if (p.kind === 'staff') return { kind: 'staff', accountId: p.id, name: p.name ?? null };
    if (p.kind === 'visitor') return { kind: 'customer', customerId: null, guestSessionId: p.id, accountId: null };
    if (p.kind !== 'customer') return null;
    return { kind: 'customer', customerId: p.id, guestSessionId: null, accountId: null };
  }

  /** Whether the viewer takes part in the conversation (another tenant's conversation is simply not found) */
  async visible(v: Viewer, c: ConversationRec): Promise<boolean> {
    if (v.kind === 'seller') return c.seller_id === v.sellerId && (c.kind === 'order' || c.kind === 'staff_seller');
    if (v.kind === 'staff') return (await this.repo.count('participants', { conversation_id: c.id, kind: 'staff', participant_id: v.accountId })) > 0;
    // a seller applicant's conversation with Marketly staff: the applicant takes part as a customer participant
    if (c.kind === 'staff_seller') return !!(v.customerId && c.application_id && (await this.repo.count('participants', { conversation_id: c.id, kind: 'customer', participant_id: v.customerId })) > 0);
    if (c.kind !== 'order' && c.kind !== 'support') return false;
    if (v.customerId && c.customer_id === v.customerId) return true;
    if (v.guestSessionId && c.guest_session_id === v.guestSessionId) return true;
    // a guest order: any session with guest order access to it (the order is the key, decision D-M2)
    if (v.guestSessionId && !c.customer_id && c.order_id) return this.guestReaches(v.guestSessionId, c.order_id);
    return false;
  }

  /** Whether a guest session reaches an order (guest order access) */
  async guestReaches(guestSessionId: string, orderId: string): Promise<boolean> {
    const seen = await this.ctx.use('orders').getOrdersByIds({ area: 'store', guestSessionId }, [orderId]);
    return !!seen[orderId];
  }

  /** A conversation by id; an id merged into another conversation resolves to the kept one (conversation_aliases) */
  async conversation(id: string, o: { forUpdate?: boolean } = {}): Promise<ConversationRec | undefined> {
    const c = await this.repo.get('conversations', id, o);
    if (c) return c;
    const kept = await this.repo.aliasOf(id);
    return kept ? this.repo.get('conversations', kept, o) : undefined;
  }

  async visibleConversation(v: Viewer, id: string, o: { forUpdate?: boolean } = {}): Promise<ConversationRec> {
    const c = await this.conversation(id, o);
    if (!c || !(await this.visible(v, c))) throw notFound();
    return c;
  }

  /* ---------------------------------------------------------------- views */

  async bundles(rows: readonly ConversationRec[], perConversation = 20): Promise<Bundle[]> {
    const ids = rows.map((r) => r.id);
    const [parts, recent] = await Promise.all([this.repo.participantsOf(ids), this.repo.recentMessages(ids, perConversation)]);
    const partsOf = groupBy(parts, (p) => p.conversation_id);
    const recentOf = groupBy(recent, (m) => m.conversation_id);
    return rows.map((conv) => ({ conv, participants: partsOf.get(conv.id) ?? [], recent: recentOf.get(conv.id) ?? [] }));
  }

  /** Storefront cards (name, logo, verified, location) of the sellers in these conversations */
  async cards(rows: readonly ConversationRec[]): Promise<Map<string, sellers.SellerSummary>> {
    const ids = [...new Set(rows.map((r) => marketplaceSellerId(r.seller_id)).filter((x): x is string => !!x))];
    if (!ids.length) return new Map();
    const list = await this.soft('sellers', 'seller cards', (s) => s.getStorefrontCard(ids));
    return new Map((list ?? []).map((c) => [c.id, c]));
  }

  subjectOf(c: ConversationRec): Subject {
    return c.subject as unknown as Subject;
  }

  private sellerName(b: Bundle, cards?: Map<string, sellers.SellerSummary>) {
    const c = b.conv;
    return (marketplaceSellerId(c.seller_id) && cards?.get(c.seller_id!)?.storeName) || b.participants.find((p) => p.kind === 'seller')?.name || 'Seller';
  }

  counterpartyOf(v: Viewer, b: Bundle, cards?: Map<string, sellers.SellerSummary>, replyStats?: Map<string, number | null>): Counterparty {
    const c = b.conv;
    const support: Counterparty = { kind: 'marketplace_support', name: SUPPORT_LABEL, verified: true };
    const seller = (): Counterparty => {
      if (isOfficialConversation(c)) return { kind: 'official_store', name: OFFICIAL_STORE_NAME, verified: true };
      if (!c.seller_id) return support;
      const card = cards?.get(c.seller_id);
      return {
        kind: 'seller',
        id: c.seller_id,
        name: this.sellerName(b, cards),
        logoUrl: card?.logo?.url ?? null,
        verified: card?.verified ?? null,
        responseTimeLabel: responseTimeLabel(replyStats?.get(c.seller_id)),
        location: card?.location ?? null,
      };
    };
    const customer = (): Counterparty => {
      // the buyer: a signed-in customer, or the guest of a guest order (shown by the name they checked out with)
      const p = b.participants.find((x) => x.kind === 'customer' || x.kind === 'guest');
      return { kind: 'customer', id: c.customer_id ?? null, name: p?.name ?? 'Buyer' };
    };
    if (v.kind === 'customer') return c.kind === 'support' || c.kind === 'staff_seller' ? support : seller();
    if (v.kind === 'seller') return c.kind === 'staff_seller' ? support : customer();
    // staff: the business side of the conversation (the seller, the Official Store) or the customer of a support thread
    if (c.kind === 'support') return customer();
    if (c.kind === 'staff_seller' && !c.seller_id) return { kind: 'seller', name: this.subjectOf(c).title };
    return seller();
  }

  participantsView(b: Bundle): Participant[] {
    return b.participants.map((p) => ({
      kind: p.kind as Participant['kind'],
      id: p.participant_id,
      name: p.name,
      label: p.label,
      joinedAt: p.joined_at.toISOString(),
      joinedFromCaseId: p.joined_from_case_id,
      lastReadMessageId: p.last_read_message_id,
    }));
  }

  privacyNote(v: Viewer, b: Bundle, cp: Counterparty): string {
    const c = b.conv;
    if (c.kind === 'staff_seller') return v.kind === 'seller' ? 'Only your team and Marketly staff can see it' : v.kind === 'customer' ? 'Only you and Marketly staff can see it' : 'Only the seller team and Marketly staff can see it';
    if (c.kind === 'support') return v.kind === 'customer' ? 'Only you and Marketly support can see it' : 'Only the customer and Marketly support can see it';
    if (v.kind === 'customer') return `Only you, ${cp.name} and Marketly support can see it`;
    if (v.kind === 'seller') return 'Only you, the buyer and Marketly support can see it';
    return 'Only the buyer, the seller and Marketly support can see it';
  }

  /** Time from the start of the last answered round to the seller's reply (recent messages, newest first) */
  lastReplyMs(recent: readonly MessageLine[]): number | null {
    const i = recent.findIndex((m) => m.kind === 'text' && m.author_kind === 'seller');
    if (i < 0) return null;
    let start: Date | null = null;
    for (let j = i + 1; j < recent.length; j++) {
      const m = recent[j]!;
      if (m.author_kind === 'seller') break;
      if (m.author_kind === 'customer' || m.author_kind === 'guest') start = m.at;
    }
    return start ? recent[i]!.at.getTime() - start.getTime() : null;
  }

  private mine(v: Viewer, b: Bundle) {
    const me = meOf(v, b.conv);
    return b.participants.find((p) => p.kind === me.kind && p.participant_id === me.id);
  }

  /** Whether this kind of caller writes in this kind of conversation */
  writes(v: Viewer, c: ConversationRec): boolean {
    if (v.kind === 'customer') return c.kind === 'order' || c.kind === 'support' || (c.kind === 'staff_seller' && !!c.application_id);
    if (v.kind === 'seller') return c.kind === 'order' || c.kind === 'staff_seller';
    return true;
  }

  summaryOf(v: Viewer, b: Bundle, x: ViewExtras = {}): ConversationSummary {
    const c = b.conv;
    const me = meOf(v, b.conv);
    const last = b.recent[0];
    const mine = this.mine(v, b);
    const unreadCount = mine?.unread_count ?? 0;
    const now = this.now();
    return {
      id: c.id,
      counterparty: this.counterpartyOf(v, b, x.cards, x.replyStats),
      subject: x.subject ?? this.subjectOf(c),
      lastMessagePreview: !last ? '' : last.hidden ? 'Message removed' : last.body ? preview(last.body) : 'Sent an attachment',
      lastMessageAt: c.last_message_at.toISOString(),
      lastFromMe: !!last && last.author_kind === me.kind && last.author_id === me.id,
      unread: unreadCount > 0,
      unreadCount,
      replyState: c.reply_state as ConversationSummary['replyState'],
      replyDue: c.reply_state === 'awaiting_seller' || c.reply_state === 'overdue' ? deadline(c.reply_due_at, now, c.reply_state === 'overdue') : null,
      replyLabel: v.kind === 'customer' ? null : replyLabel(c, this.lastReplyMs(b.recent), now, this.tz),
      status: c.status as ConversationSummary['status'],
    };
  }

  conversationOf(v: Viewer, b: Bundle, x: ViewExtras = {}): Conversation {
    const c = b.conv;
    const cp = this.counterpartyOf(v, b, x.cards, x.replyStats);
    const now = this.now();
    return {
      id: c.id,
      kind: c.kind as Conversation['kind'],
      counterparty: cp,
      participants: this.participantsView(b),
      subject: x.subject ?? this.subjectOf(c),
      status: c.status as Conversation['status'],
      lockedReason: c.status === 'locked' ? c.locked_reason : null,
      replyState: c.reply_state as Conversation['replyState'],
      replyDue: c.reply_state === 'awaiting_seller' || c.reply_state === 'overdue' ? deadline(c.reply_due_at, now, c.reply_state === 'overdue') : null,
      dispatchWarning: v.kind === 'seller' ? (x.dispatchWarning ?? null) : null,
      privacyNote: this.privacyNote(v, b, cp),
      rulesNote: RULES_NOTE,
      canSend: c.status === 'open' && this.writes(v, c) && x.mayWrite !== false,
      createdAt: c.created_at.toISOString(),
      lastMessageAt: c.last_message_at.toISOString(),
    };
  }

  /** Live subject (item, group, return or case status) and the seller's dispatch warning, from the owning modules */
  async live(v: Viewer, c: ConversationRec): Promise<{ subject: Subject; dispatchWarning: string | null }> {
    const subject = { ...this.subjectOf(c) };
    const order = await this.orderOf(c.order_id);
    let dispatchWarning: string | null = null;
    if (order) {
      const item = c.order_item_id ? order.groups.flatMap((g) => g.items).find((i) => i.id === c.order_item_id) : undefined;
      const group = item ? order.groups.find((g) => g.id === item.groupId) : order.groups.find((g) => (c.seller_id ? groupSellerId(g) === c.seller_id : g.seller.ownerType === 'official'));
      subject.statusLabel = item?.stateLabel ?? group?.statusLabel ?? order.statusLabel;
      // conversations started before the item summary was kept (G45b)
      subject.itemSummary ??= itemSummary(item ? [item] : (group?.items ?? order.groups.flatMap((g) => g.items)));
      if (v.kind === 'seller' && group && group.dispatchDeadline.state === 'overdue' && ['new', 'preparing', 'delayed', 'partly_shipped'].includes(group.status)) {
        dispatchWarning = `Dispatch deadline was ${shortDateTime(new Date(group.dispatchDeadline.dueAt), this.tz)}. It is now overdue.`;
      }
    }
    if (c.return_id) {
      const items = order?.groups.flatMap((g) => g.items.map((i) => i.id)) ?? [];
      const states = items.length ? await this.soft('returns', 'return status', (r) => r.returnStateForItems(items)) : undefined;
      const r = states?.find((s) => s.returnId === c.return_id);
      if (r?.status) subject.statusLabel = r.status;
    } else if (c.case_id && c.kind === 'support') {
      const cases = c.order_id ? await this.soft('support', 'case status', (s) => s.casesForOrder(c.order_id!)) : undefined;
      const k = cases?.find((x) => x.caseId === c.case_id);
      if (k) subject.statusLabel = k.status;
    }
    return { subject, dispatchWarning };
  }

  /** Customer messaging restriction (replies inside a case thread stay allowed) */
  async customerMayWrite(v: Viewer, c: { case_id: string | null }): Promise<{ allowed: boolean; reason?: string; until?: string | null }> {
    if (v.kind !== 'customer' || !v.customerId || c.case_id) return { allowed: true };
    const customers = this.ctx.tryUse('customers');
    if (!customers) return { allowed: true };
    const r = await customers.canSendMessages(v.customerId);
    return r.allowed ? { allowed: true } : { allowed: false, reason: r.reason ?? 'Messaging is restricted on this account', until: r.until ?? null };
  }

  /** MESSAGING_RESTRICTED (403) when the customer's account may not message sellers now */
  async assertMayWrite(v: Viewer, c: { case_id: string | null }): Promise<void> {
    const may = await this.customerMayWrite(v, c);
    if (!may.allowed) throw this.error('MESSAGING_RESTRICTED', may.reason, { reason: may.reason, endsAt: may.until ?? null });
  }

  async mediaRefs(ids: readonly string[]): Promise<Map<string, common.MediaRef>> {
    if (!ids.length) return new Map();
    const refs = await this.soft('media', 'attachments', (m) => m.refs([...new Set(ids)], 'medium'));
    return new Map((refs ?? []).map((r) => [r.id, r]));
  }

  messageOf(v: Viewer | null, m: MessageRec, refs: Map<string, common.MediaRef>, staffView = false, reported = false): Message {
    const me = v ? meOf(v) : null;
    // a guest sees the guest participant's messages of the order conversation as their own
    const guest = v?.kind === 'customer' && !v.customerId;
    const fromMe = guest ? m.author_kind === 'guest' || (!!me && m.author_kind === me.kind && m.author_id === me.id) : !!me && m.author_kind === me.kind && m.author_id === me.id;
    const ids = (m.media_ids as string[] | null) ?? [];
    const showContent = staffView || !m.hidden;
    return {
      id: m.id,
      conversationId: m.conversation_id,
      kind: m.kind as Message['kind'],
      // a guest participant is a visitor as an Actor
      author: m.author_kind ? { kind: (m.author_kind === 'guest' ? 'visitor' : m.author_kind) as common.Actor['kind'], id: m.author_id, name: m.author_label } : null,
      authorLabel: fromMe ? 'You' : m.author_label,
      fromMe,
      body: showContent ? (staffView ? (m.original_body ?? m.body) : m.body) : '',
      attachments: showContent ? ids.map((id) => refs.get(id)).filter((r): r is common.MediaRef => !!r) : [],
      redactions: ((m.redactions as string[] | null) ?? []) as Message['redactions'],
      hidden: m.hidden,
      hiddenReason: m.hidden ? (staffView ? m.hidden_reason : HIDDEN_NOTE) : null,
      clientMessageId: m.client_message_id,
      viewerReported: reported,
      at: m.at.toISOString(),
    };
  }

  async messagesOf(v: Viewer | null, rows: readonly MessageRec[], staffView = false): Promise<Message[]> {
    const [refs, reported] = await Promise.all([this.mediaRefs(rows.flatMap((m) => (m.media_ids as string[] | null) ?? [])), staffView || !v || v.kind === 'staff' ? new Set<string>() : this.reportedBy(v, rows)]);
    return rows.map((m) => this.messageOf(v, m, refs, staffView, reported.has(m.id)));
  }

  /** The messages the viewer already reported (G56a): reports under the viewer's participant key in each conversation */
  private async reportedBy(v: Viewer, rows: readonly MessageRec[]): Promise<Set<string>> {
    if (!rows.length) return new Set();
    const [convs, reports] = await Promise.all([this.repo.getMany('conversations', [...new Set(rows.map((m) => m.conversation_id))]), this.repo.find('message_reports', { message_id: rows.map((m) => m.id) })]);
    if (!reports.length) return new Set();
    const me = new Map(convs.map((c) => [c.id, meOf(v, c)]));
    return new Set(reports.filter((r) => me.get(r.conversation_id)?.kind === r.reporter_kind && me.get(r.conversation_id)?.id === r.reporter_id).map((r) => r.message_id));
  }

  /* ---------------------------------------------------------------- authors */

  authorOf(v: Viewer, c: ConversationRec, participants: readonly ParticipantRec[], o: { caseId?: string | null } = {}): Author {
    if (v.kind === 'customer') {
      const me = meOf(v, c);
      const p = participants.find((x) => x.kind === me.kind && x.participant_id === me.id) ?? participants.find((x) => x.kind === 'customer' || x.kind === 'guest');
      return {
        kind: me.kind as 'customer' | 'guest',
        id: me.id,
        label: p?.name ?? 'Buyer',
        mediaOwner: v.customerId && v.accountId ? { kind: 'customer', id: v.accountId } : { kind: 'guest', id: v.guestSessionId },
        participantName: p?.name ?? 'Buyer',
        participantLabel: 'Buyer',
      };
    }
    if (v.kind === 'seller') {
      const store = participants.find((x) => x.kind === 'seller')?.name ?? 'Seller';
      const first = firstName(v.name);
      return { kind: 'seller', id: v.sellerId, label: first ? `${first}, ${store}` : store, mediaOwner: { kind: 'seller', id: v.sellerId }, participantName: store, participantLabel: 'Seller' };
    }
    const team = isOfficialConversation(c) ? OFFICIAL_STORE_NAME : SUPPORT_LABEL;
    const first = firstName(v.name);
    return {
      kind: 'staff',
      id: v.accountId,
      label: first ? `${first}, ${team}` : team,
      mediaOwner: { kind: 'staff', id: v.accountId },
      caseId: o.caseId ?? null,
      participantName: v.name ?? team,
      participantLabel: team,
    };
  }

  /* ---------------------------------------------------------------- posting */

  /** Content rules, attachments and masking, checked before anything is written */
  async prepare(author: Author, input: MessageInputLike, cfg: Cfg): Promise<Prepared> {
    const text = input.body ?? '';
    const mediaIds = [...new Set(input.mediaIds ?? [])];
    const issues: { path: string; message: string }[] = [];
    if (!text.trim() && !mediaIds.length) issues.push({ path: 'body', message: 'Write a message or add a file' });
    if (text.length > cfg.maxLength) issues.push({ path: 'body', message: `Messages can be up to ${cfg.maxLength} characters` });
    if (author.kind === 'seller') {
      const promo = promotionalPhrase(text);
      if (promo) issues.push({ path: 'body', message: `Order messages are for service only; promotional content ("${promo}") is not allowed` });
    }
    if (mediaIds.length > cfg.maxAttachments) issues.push({ path: 'mediaIds', message: `Up to ${cfg.maxAttachments} files per message` });
    if (issues.length) throw invalid(issues);
    if (mediaIds.length) {
      const m = this.ctx.tryUse('media');
      if (!m) throw invalid([{ path: 'mediaIds', message: 'Attachments are not available right now' }]);
      const maxBytes = cfg.maxAttachmentMb * 1024 * 1024;
      const assets = await Promise.all(mediaIds.map((id) => m.getAsset(id)));
      assets.forEach((a, i) => {
        const path = `mediaIds[${i}]`;
        if (!a || !sameOwner(a.owner, author.mediaOwner)) issues.push({ path, message: 'File not found' });
        else if (a.purpose !== 'message_attachment') issues.push({ path, message: 'Upload the file as a message attachment' });
        else if (a.status !== 'ready') issues.push({ path, message: 'The file is still processing or was rejected' });
        else if (a.sizeBytes > maxBytes) issues.push({ path, message: `Files can be up to ${cfg.maxAttachmentMb} MB` });
      });
      if (issues.length) throw invalid(issues, 'Some attachments cannot be sent');
    }
    const masked = cfg.mask ? maskContent(text, this.allowedHosts()) : { body: text, redactions: [] as Redaction[] };
    return {
      id: newId(),
      body: masked.body,
      original: masked.body !== text ? text : null,
      redactions: masked.redactions,
      mediaIds,
      clientMessageId: input.clientMessageId?.trim() || null,
    };
  }

  allowedHosts(): string[] {
    const urls = this.ctx.config.publicUrls;
    return [...new Set([hostOf(urls.store), hostOf(urls.seller), hostOf(urls.admin), 'marketly.com'].filter((h): h is string => !!h && h !== 'localhost'))];
  }

  /**
   * Stores a prepared message: checks the conversation still takes messages, joins the author, moves the
   * reply state, counts unread for the others. A resend with the same clientMessageId returns the first message.
   * Publishes messaging.message.sent after the commit.
   */
  async commit(conversationId: string, author: Author, p: Prepared, cfg: Cfg, by: By): Promise<{ message: MessageRec; conv: ConversationRec; created: boolean }> {
    if (p.clientMessageId) {
      const dup = await this.repo.findOne('messages', { conversation_id: conversationId, author_id: author.id, client_message_id: p.clientMessageId });
      if (dup) return { message: dup, conv: (await this.repo.get('conversations', conversationId))!, created: false };
    }
    const now = this.now();
    let joined = false;
    const out = await this.repo
      .transaction(async (tx) => {
        const c = await tx.get('conversations', conversationId, { forUpdate: true });
        if (!c) throw notFound();
        if (c.status !== 'open') throw this.error('CONVERSATION_LOCKED', c.status === 'locked' ? 'This conversation is locked' : 'This conversation is archived', { reason: c.status === 'locked' ? (c.locked_reason ?? 'locked') : 'archived' });
        joined = await tx.addParticipant({
          conversation_id: c.id,
          kind: author.kind,
          participant_id: author.id,
          name: author.participantName ?? author.label,
          label: author.participantLabel ?? author.label,
          joined_at: now,
          joined_from_case_id: author.caseId ?? null,
          last_read_message_id: null,
          unread_count: 0,
        });
        const message = await tx.insert('messages', {
          id: p.id,
          conversation_id: c.id,
          kind: 'text',
          author_kind: author.kind,
          author_id: author.id,
          author_label: author.label,
          body: p.body,
          original_body: p.original,
          media_ids: p.mediaIds,
          redactions: p.redactions,
          hidden: false,
          hidden_reason: null,
          client_message_id: p.clientMessageId,
          at: now,
        });
        const patch: Partial<ConversationRec> = { last_message_at: now };
        // customer–seller and customer–Official Store conversations have a reply state (D-M1); for the Official
        // Store the reply is a staff message
        let replyMove: 'awaiting' | 'replied' | null = null;
        if (c.kind === 'order' && c.seller_id) {
          const official = isOfficialConversation(c);
          const state = c.reply_state as 'none' | 'awaiting_seller' | 'replied' | 'overdue';
          const replier = official ? 'staff' : 'seller';
          if ((author.kind === 'customer' || author.kind === 'guest') && sellerReplyMachine.can(state, 'customerWrites')) {
            patch.reply_state = sellerReplyMachine.next(state, 'customerWrites');
            patch.awaiting_since = now;
            patch.reply_due_at = new Date(now.getTime() + cfg.targetHours * HOUR);
            replyMove = 'awaiting';
          } else if (author.kind === replier && sellerReplyMachine.can(state, 'sellerReplies')) {
            patch.reply_state = sellerReplyMachine.next(state, 'sellerReplies');
            patch.awaiting_since = null;
            patch.reply_due_at = null;
            replyMove = 'replied';
          }
        }
        const conv = await tx.update('conversations', c.id, patch);
        await tx.bumpUnread(c.id, { kind: author.kind, id: author.id });
        await tx.updateWhere('participants', { conversation_id: c.id, kind: author.kind, participant_id: author.id }, { last_read_message_id: message.id, unread_count: 0 });
        return { message, conv, replyMove };
      })
      .catch(async (err) => {
        // a concurrent resend with the same clientMessageId lost the race: answer with the first message
        if (p.clientMessageId && !isAppError(err)) {
          const dup = await this.repo.findOne('messages', { conversation_id: conversationId, author_id: author.id, client_message_id: p.clientMessageId });
          if (dup) return { message: dup, conv: (await this.repo.get('conversations', conversationId))!, dup: true };
        }
        throw err;
      });
    if ('dup' in out) return { message: out.message, conv: out.conv, created: false };
    if (p.mediaIds.length) {
      const m = this.ctx.tryUse('media');
      for (const id of p.mediaIds) {
        await m
          ?.attach(id, { module: 'messaging', kind: 'message_attachment', refId: out.message.id, refLabel: this.subjectOf(out.conv).title }, author.mediaOwner)
          .catch((err) => this.ctx.log.warn({ err, assetId: id, messageId: out.message.id }, 'messaging: attachment usage not recorded'));
      }
    }
    await this.publishSent(out.conv, out.message, author, by);
    if (out.replyMove) await this.officialReplyItem(out.conv, out.replyMove);
    if (joined && author.kind === 'staff') this.ctx.log.info({ conversationId, staffId: author.id }, 'messaging: staff joined a conversation');
    return { message: out.message, conv: out.conv, created: true };
  }

  /**
   * messaging.message.sent with who receives it: the other participant kinds (official_store for the Official Store
   * team), the customer, a guest's order contact email, the applicant's account, the seller, staff participants.
   */
  async publishSent(c: ConversationRec, m: MessageRec, author: Author, by: By) {
    const parts = await this.repo.participantsOf([c.id]);
    const official = isOfficialConversation(c);
    type Kind = 'customer' | 'guest' | 'seller' | 'official_store' | 'staff';
    const kinds = new Set<Kind>(parts.filter((x) => !(x.kind === author.kind && x.participant_id === author.id)).map((x) => x.kind as Kind));
    // the Official Store team answers Official Store conversations (staff topic), not the support staff in it
    if (official && author.kind !== 'staff') kinds.add('official_store');
    // conversations without a seller side participant still reach the people who answer them
    if (!kinds.size) kinds.add(author.kind === 'customer' || author.kind === 'guest' ? 'staff' : 'customer');
    const guest = parts.some((p) => p.kind === 'guest') && !c.customer_id;
    const contactEmail = guest && c.order_id && author.kind !== 'guest' ? ((await this.orderOf(c.order_id))?.contact.email ?? null) : null;
    const applicant = c.application_id ? await this.soft('sellers', 'application participant', (s) => s.getApplicationParticipant(c.application_id!)) : undefined;
    const customerId = c.customer_id ?? parts.find((p) => p.kind === 'customer' && p.participant_id !== author.id && isUuid(p.participant_id))?.participant_id ?? null;
    this.publish(
      'messaging.message.sent',
      {
        messageId: m.id,
        conversationId: c.id,
        conversationKind: c.kind as 'order' | 'support' | 'staff_seller',
        authorKind: author.kind,
        recipientKinds: [...kinds],
        customerId,
        contactEmail: contactEmail && /@/.test(contactEmail) ? contactEmail : null,
        applicantAccountId: applicant?.applicantAccountId ?? null,
        sellerId: c.seller_id ?? null,
        officialStore: official,
        staffIds: [...new Set(parts.filter((p) => p.kind === 'staff' && !(author.kind === 'staff' && p.participant_id === author.id) && isUuid(p.participant_id)).map((p) => p.participant_id))],
        orderId: c.order_id,
        caseId: c.case_id,
      },
      by,
    );
  }

  /**
   * Official Store conversations (D-M1): while staff owe a reply an official_store_reply work item is open in
   * official_store.messages (dedupe official_store_reply:<conversationId>, due at reply_due_at); a staff reply
   * resolves it.
   */
  async officialReplyItem(c: ConversationRec, move: 'awaiting' | 'replied') {
    if (!isOfficialConversation(c)) return;
    const key = `official_store_reply:${c.id}`;
    if (move === 'replied') {
      await this.soft('workqueues', 'resolve official reply', (w) => w.resolveBySource(key, { note: 'Official Store replied', by: SYSTEM }));
      return;
    }
    const subject = this.subjectOf(c);
    await this.soft('workqueues', 'raise official reply', (w) =>
      w.raise({
        queueKey: 'official_store.messages',
        kind: 'official_store_reply',
        sourceModule: 'messaging',
        title: `Reply to the customer: ${subject.title}`,
        summary: `${subject.orderRef ? `Order ${subject.orderRef}. ` : ''}The customer is waiting for the ${OFFICIAL_STORE_NAME}.`,
        subject: { type: 'conversation', id: c.id, ref: subject.orderRef ?? null, label: subject.title },
        ...(c.customer_id ? { customerId: c.customer_id } : {}),
        ...(c.reply_due_at ? { dueAt: c.reply_due_at.toISOString() } : {}),
        priority: 'normal',
        dedupeKey: key,
        links: [{ label: 'Open conversation', screen: 'admin/official', id: c.id }],
      }),
    );
  }

  /** A system note (e.g. support joined from a case): unread for everyone, no reply-state change, no notice */
  async systemNote(conversationId: string, text: string): Promise<MessageRec> {
    const now = this.now();
    return this.repo.transaction(async (tx) => {
      const c = await tx.get('conversations', conversationId, { forUpdate: true });
      if (!c) throw notFound();
      const m = await tx.insert('messages', {
        id: newId(),
        conversation_id: c.id,
        kind: 'system',
        author_kind: null,
        author_id: null,
        author_label: 'Marketly',
        body: text,
        original_body: null,
        media_ids: [],
        redactions: [],
        hidden: false,
        hidden_reason: null,
        client_message_id: null,
        at: now,
      });
      await tx.update('conversations', c.id, { last_message_at: now });
      await tx.bumpUnread(c.id, null);
      return m;
    });
  }
}

/** Rows per key, in their order */
export function groupBy<T, K>(rows: readonly T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const list = out.get(key(r));
    if (list) list.push(r);
    else out.set(key(r), [r]);
  }
  return out;
}

function sameOwner(a: media.MediaOwner, b: media.MediaOwner): boolean {
  return a.kind === b.kind && (a.id ?? null) === (b.id ?? null);
}
