import { AppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { zonedTimeToUtc } from '../../kernel/lib/clock.js';
import { isUuid, newId } from '../../kernel/lib/ids.js';
import { toPageRequest, type PageRequest } from '../../kernel/lib/pagination.js';
import type * as common from '../../spec/common.js';
import type {
  AdminConversationRow,
  Conversation,
  ConversationSummary,
  CustomerConversationSummary,
  Message,
  MessageReport,
  MessagingPublicApi,
  ReplyTemplate,
  ReplyTemplateInput,
  ResponseStats,
  SellerStartInput,
  StaffStartInput,
  StartConversationInput,
  Subject,
} from '../../spec/messaging.js';
import type * as orders from '../../spec/orders.js';
import { buyerName, DAY, HOUR, MINUTE, OFFICIAL_STORE_NAME, promotionalPhrase, replyRounds, responseTimeLabel, SUPPORT_LABEL, SUPPORT_TEAM_ID } from './domain/rules.js';
import { conversationMachine, messageReportMachine, sellerReplyMachine } from './domain/state-machines.js';
import type { ConversationKey, ConversationRec, MessageRec, ParticipantRec, ReportRec, TemplateRec } from './ports.js';
import { Core, invalid, meOf, notFound, SYSTEM, type Author, type By, type Cfg, type MessagingServiceDeps, type Prepared, type Viewer } from './service/core.js';

export type { MessagingServiceDeps, Viewer, By };

type CustomerViewer = Extract<Viewer, { kind: 'customer' }>;
type SellerViewer = Extract<Viewer, { kind: 'seller' }>;
type StaffViewer = Extract<Viewer, { kind: 'staff' }>;
type ReportReason = MessageReport['reason'];

const ROUND_LOOKBACK_MS = 14 * DAY;
const JOB_BATCH = 100;
const MAX_BATCHES = 50;

/** A conversation as one viewer sees it, with the summary fields (GraphQL Conversation has both) */
export interface ConversationView {
  conversation: Conversation;
  summary: ConversationSummary;
}

/**
 * Messaging use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to an endpoint, a publicApi function, a consumed event or a job in docs/api/spec/modules/messaging.json.
 */
export class MessagingService implements MessagingPublicApi {
  readonly core: Core;

  constructor(deps: MessagingServiceDeps) {
    this.core = new Core(deps);
  }

  private get repo() {
    return this.core.repo;
  }
  private get ctx() {
    return this.core.ctx;
  }
  private now() {
    return this.core.now();
  }

  /* ================================================================ views */

  async views(v: Viewer, rows: readonly ConversationRec[], o: { live?: boolean } = {}): Promise<ConversationView[]> {
    if (!rows.length) return [];
    const [bundles, cards] = await Promise.all([this.core.bundles(rows), this.core.cards(rows)]);
    const out: ConversationView[] = [];
    for (const b of bundles) {
      const live = o.live ? await this.core.live(v, b.conv) : undefined;
      const may = o.live && v.kind === 'customer' ? (await this.core.customerMayWrite(v, b.conv)).allowed : undefined;
      const x = { cards, ...(live ? { subject: live.subject, dispatchWarning: live.dispatchWarning } : {}), ...(may === undefined ? {} : { mayWrite: may }) };
      out.push({ conversation: this.core.conversationOf(v, b, x), summary: this.core.summaryOf(v, b, x) });
    }
    return out;
  }

  private async one(v: Viewer, c: ConversationRec, live = true): Promise<Conversation> {
    if (live && c.seller_id && !this.core.replyCache.has(c.seller_id)) await this.cacheStats(c.seller_id);
    return (await this.views(v, [c], { live }))[0]!.conversation;
  }

  /** Inbox rows as views (REST lists the summaries, GraphQL the full conversation objects) */
  async inboxViews(v: Viewer, filter: { unreadOnly?: boolean; replyState?: string; orderId?: string; q?: string }, page: PageRequest): Promise<common.Page<ConversationView>> {
    const owner =
      v.kind === 'customer'
        ? ({ kind: 'customer', customerId: v.customerId, guestSessionId: v.guestSessionId } as const)
        : v.kind === 'seller'
          ? ({ kind: 'seller', sellerId: v.sellerId } as const)
          : ({ kind: 'staff', staffId: v.accountId } as const);
    const rows = await this.repo.inbox(owner, { ...filter, overdueFirst: v.kind === 'seller' }, page);
    return { ...rows, items: await this.views(v, rows.items) };
  }

  async messagesFor(v: Viewer, conversationId: string, page: PageRequest): Promise<common.Page<Message>> {
    const c = await this.core.visibleConversation(v, conversationId);
    const rows = await this.repo.messagesPage(c.id, page);
    return { ...rows, items: await this.core.messagesOf(v, rows.items) };
  }

  /* ================================================================ store and seller endpoints */

  /** GET store /conversations */
  async listCustomerConversations(v: CustomerViewer, q: { q?: string; unreadOnly?: boolean; orderId?: string }, page: PageRequest): Promise<common.Page<ConversationSummary>> {
    const p = await this.inboxViews(v, { ...(q.q ? { q: q.q } : {}), ...(q.unreadOnly ? { unreadOnly: true } : {}), ...(q.orderId ? { orderId: q.orderId } : {}) }, page);
    return { ...p, items: p.items.map((x) => x.summary) };
  }

  /** GET seller /conversations: overdue first */
  async listSellerConversations(v: SellerViewer, q: { filter?: string; q?: string; orderId?: string }, page: PageRequest): Promise<common.Page<ConversationSummary>> {
    const f = q.filter ?? 'all';
    const p = await this.inboxViews(
      v,
      {
        ...(q.q ? { q: q.q } : {}),
        ...(q.orderId ? { orderId: q.orderId } : {}),
        ...(f === 'awaiting_reply' ? { replyState: 'awaiting_reply' } : f === 'overdue' ? { replyState: 'overdue' } : {}),
        ...(f === 'unread' ? { unreadOnly: true } : {}),
      },
      page,
    );
    return { ...p, items: p.items.map((x) => x.summary) };
  }

  /** One conversation as a view with live status, or null when the viewer does not take part (GraphQL) */
  async viewOf(v: Viewer, id: string): Promise<ConversationView | null> {
    if (!isUuid(id)) return null;
    const c = await this.repo.get('conversations', id);
    if (!c || !(await this.core.visible(v, c))) return null;
    if (c.seller_id && !this.core.replyCache.has(c.seller_id)) await this.cacheStats(c.seller_id);
    return (await this.views(v, [c], { live: true }))[0]!;
  }

  /** GET /conversations/{id} (store and seller): header with live status and, for sellers, the dispatch warning */
  async getConversationFor(v: Viewer, id: string): Promise<Conversation> {
    return this.one(v, await this.core.visibleConversation(v, id));
  }

  /** POST store /conversations: message a seller (or the Official Store) or Marketly support about an order, item, return or case */
  async startCustomerConversation(v: CustomerViewer, body: StartConversationInput, by: By): Promise<{ conversation: Conversation; message: Message }> {
    const notEligible = (m = 'You can only message about your own orders') => this.core.error('ORDER_NOT_ELIGIBLE', m);
    if (!v.customerId && !v.guestSessionId) throw notEligible();
    const seen = await this.ctx.use('orders').getOrdersByIds({ area: 'store', ...(v.customerId ? { customerId: v.customerId } : { guestSessionId: v.guestSessionId! }) }, [body.orderId]);
    const order = seen[body.orderId] as orders.OrderDetail | null | undefined;
    if (!order) throw notEligible();
    let item: orders.OrderItem | undefined;
    let group: orders.SellerGroup | undefined;
    if (body.orderItemId) {
      item = order.groups.flatMap((g) => g.items).find((i) => i.id === body.orderItemId);
      if (!item) throw notFound('Order item');
      group = order.groups.find((g) => g.id === item!.groupId);
    }
    if (body.with === 'seller') {
      if (body.sellerId) {
        const g = order.groups.find((x) => x.seller.id === body.sellerId);
        if (!g) throw notEligible('This seller is not part of the order');
        if (group && group.id !== g.id) throw notEligible('This item is sold by another seller');
        group = g;
      } else if (!group) {
        // the Official Store has no seller id: it is reached through one of its items, or when it is the only package
        if (order.groups.length !== 1) throw invalid([{ path: 'sellerId', message: 'Choose the seller to message (for the Official Store, choose one of its items)' }]);
        group = order.groups[0];
      }
    }
    const ret = body.returnId ? await this.verifyReturn(order, body.returnId) : null;
    const kase = body.caseId ? await this.verifyCase(order.id, body.caseId) : null;
    const kind = body.with === 'seller' ? 'order' : 'support';
    const sellerId = kind === 'order' ? (group?.seller.id ?? null) : null;
    const may = await this.core.customerMayWrite(v, { case_id: kase?.id ?? null });
    if (!may.allowed) throw new AppError('FORBIDDEN', may.reason);

    const cfg = await this.core.cfg();
    const name = buyerName(order.contact.name);
    const author: Author = {
      kind: 'customer',
      id: meOf(v).id,
      label: name,
      mediaOwner: v.customerId && v.accountId ? { kind: 'customer', id: v.accountId } : { kind: 'guest', id: v.guestSessionId },
      participantName: name,
      participantLabel: 'Buyer',
    };
    const prepared = await this.core.prepare(author, body, cfg);
    const key: ConversationKey = {
      kind,
      customer_id: v.customerId,
      seller_id: sellerId,
      application_id: null,
      order_id: order.id,
      order_item_id: item?.id ?? null,
      return_id: ret?.id ?? null,
      ...(kind === 'support' ? { case_id: kase?.id ?? null } : {}),
    };
    const subject = this.subjectFrom(order, group ?? null, item ?? null, ret, kase, kind === 'support' ? SUPPORT_LABEL : null);
    const participants: Omit<ParticipantRec, 'conversation_id' | 'joined_at'>[] = [
      { kind: 'customer', participant_id: author.id, name, label: 'Buyer', joined_from_case_id: null, last_read_message_id: null, unread_count: 0 },
    ];
    if (sellerId && group) participants.push({ kind: 'seller', participant_id: sellerId, name: group.seller.name, label: 'Seller', joined_from_case_id: null, last_read_message_id: null, unread_count: 0 });
    const conv = await this.findOrCreate(key, { guest_session_id: v.customerId ? null : v.guestSessionId, subject, case_id: kase?.id ?? null }, participants, by);
    return this.finishStart(v, conv.id, author, prepared, cfg, by);
  }

  /** POST seller /conversations: message the buyer of one of the seller's orders */
  async startSellerConversation(v: SellerViewer, body: SellerStartInput, by: By): Promise<{ conversation: Conversation; message: Message }> {
    const notEligible = (m = 'You can only message buyers of your own orders') => this.core.error('ORDER_NOT_ELIGIBLE', m);
    const order = await this.ctx.use('orders').getOrder(body.orderId);
    const group = order?.groups.find((g) => g.seller.id === v.sellerId);
    if (!order || !group) throw notEligible();
    const item = body.orderItemId ? group.items.find((i) => i.id === body.orderItemId) : undefined;
    if (body.orderItemId && !item) throw notEligible('This item is not part of your order');
    const cfg = await this.core.cfg();
    const customerName = buyerName(order.contact.name);
    const participants: Omit<ParticipantRec, 'conversation_id' | 'joined_at'>[] = [
      { kind: 'seller', participant_id: v.sellerId, name: group.seller.name, label: 'Seller', joined_from_case_id: null, last_read_message_id: null, unread_count: 0 },
    ];
    if (order.contact.customerId) participants.unshift({ kind: 'customer', participant_id: order.contact.customerId, name: customerName, label: 'Buyer', joined_from_case_id: null, last_read_message_id: null, unread_count: 0 });
    const author = this.core.authorOf(v, { kind: 'order', seller_id: v.sellerId } as ConversationRec, participants.map((p) => ({ ...p, conversation_id: '', joined_at: this.now() })));
    const prepared = await this.core.prepare(author, body, cfg);
    const key: ConversationKey = { kind: 'order', customer_id: order.contact.customerId ?? null, seller_id: v.sellerId, application_id: null, order_id: order.id, order_item_id: item?.id ?? null, return_id: null };
    const conv = await this.findOrCreate(key, { guest_session_id: null, subject: this.subjectFrom(order, group, item ?? null, null, null, null), case_id: null }, participants, by);
    return this.finishStart(v, conv.id, author, prepared, cfg, by);
  }

  /** POST /conversations/{id}/messages (store and seller) */
  async sendMessage(v: CustomerViewer | SellerViewer, id: string, body: { body: string; mediaIds?: string[] | null; clientMessageId?: string | null }, by: By): Promise<Message> {
    const c = await this.core.visibleConversation(v, id);
    if (!this.core.writes(v, c)) throw notFound();
    if (c.status !== 'open') throw this.lockedError(c);
    const may = await this.core.customerMayWrite(v, c);
    if (!may.allowed) throw new AppError('FORBIDDEN', may.reason);
    const cfg = await this.core.cfg();
    const author = this.core.authorOf(v, c, await this.repo.participantsOf([c.id]));
    const prepared = await this.core.prepare(author, body, cfg);
    const { message } = await this.core.commit(c.id, author, prepared, cfg, by);
    return (await this.core.messagesOf(v, [message]))[0]!;
  }

  /** POST /conversations/{id}/read (store and seller) */
  async markRead(v: CustomerViewer | SellerViewer, id: string, upToMessageId: string): Promise<void> {
    const c = await this.core.visibleConversation(v, id);
    const m = await this.repo.get('messages', upToMessageId);
    if (!m || m.conversation_id !== c.id) throw notFound('Message');
    const me = meOf(v);
    const now = this.now();
    await this.repo.transaction(async (tx) => {
      await tx.insertIgnore('participants', {
        conversation_id: c.id,
        kind: me.kind,
        participant_id: me.id,
        name: v.kind === 'seller' ? 'Seller' : 'Buyer',
        label: v.kind === 'seller' ? 'Seller' : 'Buyer',
        joined_at: now,
        joined_from_case_id: null,
        last_read_message_id: null,
        unread_count: 0,
      });
      const p = await tx.findOne('participants', { conversation_id: c.id, kind: me.kind, participant_id: me.id }, { forUpdate: true });
      const current = p?.last_read_message_id ? await tx.get('messages', p.last_read_message_id) : undefined;
      // reading never moves the marker back
      const upTo = current && (current.at > m.at || (current.at.getTime() === m.at.getTime() && current.id > m.id)) ? current : m;
      const unread = await tx.countUnreadAfter(c.id, { at: upTo.at, id: upTo.id }, me);
      await tx.updateWhere('participants', { conversation_id: c.id, kind: me.kind, participant_id: me.id }, { last_read_message_id: upTo.id, unread_count: unread });
    });
  }

  /** GET store /unread-count */
  async unreadCounts(v: Viewer): Promise<{ conversations: number; messages: number }> {
    const rows = await this.unreadRows(v);
    return { conversations: rows.length, messages: rows.reduce((n, r) => n + r.unread_count, 0) };
  }

  private async unreadRows(v: Viewer): Promise<ParticipantRec[]> {
    const me = meOf(v);
    const ids = v.kind === 'customer' ? [v.customerId, v.guestSessionId].filter((x): x is string => !!x) : [me.id];
    if (!ids.length) return [];
    const rows = await this.repo.find('participants', { kind: me.kind, participant_id: ids, unread_count: { op: '>', value: 0 } });
    if (!rows.length) return [];
    // only conversations the viewer still reaches (a seller's staff conversations, a customer's own threads)
    const convs = await this.repo.getMany('conversations', rows.map((r) => r.conversation_id));
    const ok = new Set<string>();
    for (const c of convs) if (await this.core.visible(v, c)) ok.add(c.id);
    return rows.filter((r) => ok.has(r.conversation_id));
  }

  /** POST /messages/{id}/report (store and seller) */
  async reportMessage(v: CustomerViewer | SellerViewer, messageId: string, body: { reason: ReportReason; note?: string | null }, by: By): Promise<{ reportId: string; status: string }> {
    const m = await this.repo.get('messages', messageId);
    if (!m) throw notFound('Message');
    const c = await this.repo.get('conversations', m.conversation_id);
    if (!c || !(await this.core.visible(v, c))) throw notFound('Message');
    const me = meOf(v);
    if (m.kind === 'system' || !m.author_kind) throw invalid([{ path: 'id', message: 'System notes cannot be reported' }]);
    if (m.author_kind === me.kind && m.author_id === me.id) throw invalid([{ path: 'id', message: 'You cannot report your own message' }]);
    const existing = await this.repo.findOne('message_reports', { message_id: m.id, reporter_kind: me.kind, reporter_id: me.id, status: 'open' });
    if (existing) return { reportId: existing.id, status: existing.status };
    const report = await this.repo.insert('message_reports', {
      id: newId(),
      message_id: m.id,
      conversation_id: c.id,
      reporter_kind: me.kind,
      reporter_id: me.id,
      reason: body.reason,
      note: body.note?.trim() || null,
      status: messageReportMachine.initial,
      outcome: null,
      decided_by: null,
      decided_at: null,
      created_at: this.now(),
    });
    this.core.publish('messaging.message.reported', { reportId: report.id, messageId: m.id, reason: report.reason }, by);
    return { reportId: report.id, status: report.status };
  }

  /** GET seller /response-stats: this month in the market time zone */
  async sellerStatsThisMonth(sellerId: string): Promise<ResponseStats> {
    const today = this.core.today();
    return this.sellerResponseStats(sellerId, { from: `${today.slice(0, 8)}01`, to: today });
  }

  /* ---------------------------------------------------------------- reply templates (phase 2) */

  private templateView = (t: TemplateRec): ReplyTemplate => ({ id: t.id, name: t.name, body: t.body, updatedAt: t.updated_at.toISOString() });

  private async checkTemplate(input: ReplyTemplateInput) {
    const cfg = await this.core.cfg();
    const issues: { path: string; message: string }[] = [];
    if (!input.name?.trim()) issues.push({ path: 'name', message: 'Give the template a name' });
    if ((input.name ?? '').length > 80) issues.push({ path: 'name', message: 'Names can be up to 80 characters' });
    if (!input.body?.trim()) issues.push({ path: 'body', message: 'Write the reply' });
    if ((input.body ?? '').length > cfg.maxLength) issues.push({ path: 'body', message: `Replies can be up to ${cfg.maxLength} characters` });
    const promo = promotionalPhrase(input.body ?? '');
    if (promo) issues.push({ path: 'body', message: `Order messages are for service only; promotional content ("${promo}") is not allowed` });
    if (issues.length) throw invalid(issues);
  }

  async listTemplates(sellerId: string): Promise<ReplyTemplate[]> {
    return (await this.repo.find('reply_templates', { seller_id: sellerId }, { orderBy: [['name', 'asc']] })).map(this.templateView);
  }

  async createTemplate(sellerId: string, input: ReplyTemplateInput): Promise<ReplyTemplate> {
    await this.checkTemplate(input);
    return this.templateView(await this.repo.insert('reply_templates', { id: newId(), seller_id: sellerId, name: input.name.trim(), body: input.body, updated_at: this.now() }));
  }

  async updateTemplate(sellerId: string, id: string, input: ReplyTemplateInput): Promise<ReplyTemplate> {
    const t = await this.repo.get('reply_templates', id);
    if (!t || t.seller_id !== sellerId) throw notFound('Template');
    await this.checkTemplate(input);
    return this.templateView(await this.repo.update('reply_templates', id, { name: input.name.trim(), body: input.body, updated_at: this.now() }));
  }

  async deleteTemplate(sellerId: string, id: string): Promise<void> {
    const n = await this.repo.removeWhere('reply_templates', { id, seller_id: sellerId });
    if (!n) throw notFound('Template');
  }

  /* ================================================================ admin endpoints */

  /** GET admin /conversations: headers only */
  async listAdminConversations(q: { orderId?: string; customerId?: string; sellerId?: string; caseId?: string; filter?: 'overdue' | 'reported' | 'locked' }, page: PageRequest, staff: StaffViewer): Promise<common.Page<AdminConversationRow>> {
    const rows = await this.repo.adminSearch(q, page);
    const [bundles, cards, reports] = await Promise.all([this.core.bundles(rows.items, 1), this.core.cards(rows.items), this.repo.reportCounts(rows.items.map((r) => r.id))]);
    return {
      ...rows,
      items: bundles.map((b) => ({
        id: b.conv.id,
        customerName: b.participants.find((p) => p.kind === 'customer')?.name ?? (b.conv.kind === 'staff_seller' ? '—' : 'Guest'),
        counterparty: this.core.counterpartyOf(staff, b, cards),
        subject: this.core.subjectOf(b.conv),
        status: b.conv.status as AdminConversationRow['status'],
        replyState: b.conv.reply_state as AdminConversationRow['replyState'],
        reportCount: reports.get(b.conv.id) ?? 0,
        lastMessageAt: b.conv.last_message_at.toISOString(),
      })),
    };
  }

  /** GET admin /conversations/{id}/messages: a logged read with a reason */
  async readConversationAsStaff(staff: StaffViewer, id: string, q: { reason: string; caseId?: string }, page: PageRequest, by: By): Promise<common.Page<Message>> {
    const c = await this.repo.get('conversations', id);
    if (!c) throw notFound();
    const reason = q.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Say why you are opening this private conversation' }]);
    await this.repo.insert('staff_access_log', { id: newId(), conversation_id: c.id, staff_id: staff.accountId, reason, case_id: q.caseId ?? null, at: this.now() });
    await this.core.audit(
      {
        action: 'messaging.conversation.read',
        actionLabel: 'Read a private conversation',
        category: 'customers',
        target: { type: 'conversation', id: c.id, ref: this.core.subjectOf(c).orderRef ?? null, label: this.core.subjectOf(c).title, sellerId: c.seller_id },
        reason,
        ...(q.caseId ? { relatedTargets: [{ type: 'case', id: q.caseId }] } : {}),
      },
      by,
    );
    const rows = await this.repo.messagesPage(c.id, page);
    return { ...rows, items: await this.core.messagesOf(staff, rows.items, true) };
  }

  /** POST admin /conversations: Marketly staff with a seller or seller applicant */
  async startStaffConversation(staff: StaffViewer, body: StaffStartInput, by: By): Promise<Conversation> {
    if (!!body.sellerId === !!body.applicationId) throw invalid([{ path: 'sellerId', message: 'Choose either a seller or a seller application' }]);
    if (!body.subject?.trim()) throw invalid([{ path: 'subject', message: 'Add a subject' }]);
    let storeName: string | null = null;
    if (body.sellerId) {
      const sellers = this.ctx.tryUse('sellers');
      if (sellers) {
        const s = await sellers.getSeller(body.sellerId);
        if (!s) throw notFound('Seller');
        storeName = s.storeName;
      }
    }
    let order: orders.OrderDetail | null = null;
    let group: orders.SellerGroup | undefined;
    let items: orders.OrderItem[] = [];
    if (body.orderId) {
      order = await this.ctx.use('orders').getOrder(body.orderId);
      if (!order) throw notFound('Order');
      group = body.sellerId ? order.groups.find((g) => g.seller.id === body.sellerId) : undefined;
      if (body.sellerId && !group) throw invalid([{ path: 'orderId', message: 'The order has no package from this seller' }]);
      storeName ??= group?.seller.name ?? null;
      const ids = body.orderItemIds ?? [];
      items = ids.map((id) => group?.items.find((i) => i.id === id)).filter((i): i is orders.OrderItem => !!i);
      if (items.length !== ids.length) throw invalid([{ path: 'orderItemIds', message: "Choose items from this seller's package" }]);
    } else if (body.orderItemIds?.length) {
      throw invalid([{ path: 'orderId', message: 'Items need their order' }]);
    }
    const ret = body.returnId && order ? await this.verifyReturn(order, body.returnId) : body.returnId ? { id: body.returnId, ref: null, status: null } : null;
    const item = items.length === 1 ? items[0]! : null;
    const cfg = await this.core.cfg();
    const sellerName = storeName ?? (body.applicationId ? 'Seller applicant' : 'Seller');
    const participants: Omit<ParticipantRec, 'conversation_id' | 'joined_at'>[] = [
      { kind: 'staff', participant_id: staff.accountId, name: staff.name ?? SUPPORT_LABEL, label: SUPPORT_LABEL, joined_from_case_id: body.caseId ?? null, last_read_message_id: null, unread_count: 0 },
    ];
    if (body.sellerId) participants.push({ kind: 'seller', participant_id: body.sellerId, name: sellerName, label: 'Seller', joined_from_case_id: null, last_read_message_id: null, unread_count: 0 });
    const key: ConversationKey = {
      kind: 'staff_seller',
      customer_id: null,
      seller_id: body.sellerId ?? null,
      application_id: body.applicationId ?? null,
      order_id: order?.id ?? null,
      order_item_id: item?.id ?? null,
      return_id: ret?.id ?? null,
      case_id: body.caseId ?? null,
    };
    const subjectKind: Subject['kind'] = body.applicationId ? 'application' : ret ? 'return' : body.caseId ? 'case' : item ? 'order_item' : order ? 'order' : 'seller_account';
    const subject: Subject = {
      kind: subjectKind,
      orderId: order?.id ?? null,
      orderRef: order?.ref ?? null,
      orderItemId: item?.id ?? null,
      returnId: ret?.id ?? null,
      returnRef: ret?.ref ?? null,
      caseId: body.caseId ?? null,
      caseRef: null,
      title: body.subject.trim(),
      imageUrl: (item ?? items[0])?.image?.url ?? null,
      packageLabel: group?.packageLabel ?? null,
      statusLabel: item?.stateLabel ?? group?.statusLabel ?? null,
    };
    const author: Author = this.core.authorOf(staff, { kind: 'staff_seller', seller_id: body.sellerId ?? null } as ConversationRec, [], { caseId: body.caseId ?? null });
    const prepared = await this.core.prepare(author, body, cfg);
    const before = await this.repo.findByKey(key);
    const conv = await this.findOrCreate(key, { guest_session_id: null, subject, case_id: body.caseId ?? null, started_by_staff_id: staff.accountId }, participants, by);
    await this.core.commit(conv.id, author, prepared, cfg, by);
    const fresh = (await this.repo.get('conversations', conv.id))!;
    await this.core.audit(
      {
        action: before ? 'messaging.conversation.staff_message' : 'messaging.conversation.staff_start',
        actionLabel: before ? 'Messaged a seller' : 'Started a conversation with a seller',
        category: 'customers',
        target: { type: 'conversation', id: conv.id, ref: subject.orderRef ?? null, label: subject.title, sellerId: body.sellerId ?? null },
        relatedTargets: [
          ...(body.sellerId ? [{ type: 'seller', id: body.sellerId, label: sellerName }] : []),
          ...(body.applicationId ? [{ type: 'seller_application', id: body.applicationId }] : []),
          ...(order ? [{ type: 'order', id: order.id, ref: order.ref }] : []),
        ],
        after: { subject: subject.title },
      },
      by,
    );
    return this.one(staff, fresh, false);
  }

  /** POST admin /conversations/{id}/messages: post as Marketly Support, joining the conversation */
  async sendStaffMessage(staff: StaffViewer, id: string, body: { body: string; mediaIds?: string[] | null; caseId?: string | null }, by: By): Promise<Message> {
    const c = await this.repo.get('conversations', id);
    if (!c) throw notFound();
    if (c.status !== 'open') throw this.lockedError(c);
    const cfg = await this.core.cfg();
    const parts = await this.repo.participantsOf([c.id]);
    const author = this.core.authorOf(staff, c, parts, { caseId: body.caseId ?? null });
    const prepared = await this.core.prepare(author, body, cfg);
    const joining = !parts.some((p) => p.kind === 'staff' && p.participant_id === staff.accountId);
    if (joining) {
      const caseRef = body.caseId ? await this.caseRef(c.order_id, body.caseId) : null;
      await this.core.systemNote(c.id, `${author.participantLabel ?? SUPPORT_LABEL} joined the conversation${caseRef ? ` from case ${caseRef}` : ''}`);
      if (body.caseId && !c.case_id && c.kind !== 'staff_seller') await this.repo.update('conversations', c.id, { case_id: body.caseId });
    }
    const { message } = await this.core.commit(c.id, author, prepared, cfg, by);
    await this.core.audit(
      {
        action: 'messaging.message.staff_post',
        actionLabel: 'Posted as Marketly Support',
        category: 'customers',
        target: { type: 'conversation', id: c.id, ref: this.core.subjectOf(c).orderRef ?? null, label: this.core.subjectOf(c).title, sellerId: c.seller_id },
        ...(body.caseId ? { relatedTargets: [{ type: 'case', id: body.caseId }] } : {}),
        after: { messageId: message.id, joined: joining },
      },
      by,
    );
    return (await this.core.messagesOf(staff, [message], true))[0]!;
  }

  /** POST admin /messages/{id}/hide */
  async hideMessage(staff: StaffViewer, id: string, reason: string, by: By): Promise<Message> {
    const r = reason?.trim();
    if (!r) throw invalid([{ path: 'reason', message: 'Say which rule the message breaks' }]);
    const { before, after } = await this.hide(id, r);
    const c = await this.repo.get('conversations', after.conversation_id);
    await this.core.audit(
      {
        action: 'messaging.message.hide',
        actionLabel: 'Hid a message',
        category: 'customers',
        target: { type: 'message', id: after.id, label: c ? this.core.subjectOf(c).title : null, sellerId: c?.seller_id ?? null },
        relatedTargets: [{ type: 'conversation', id: after.conversation_id }],
        reason: r,
        before: { hidden: before.hidden, hiddenReason: before.hidden_reason },
        after: { hidden: true, hiddenReason: r },
      },
      by,
    );
    return (await this.core.messagesOf(staff, [after], true))[0]!;
  }

  private async hide(id: string, reason: string): Promise<{ before: MessageRec; after: MessageRec }> {
    return this.repo.transaction(async (tx) => {
      const before = await tx.get('messages', id, { forUpdate: true });
      if (!before) throw notFound('Message');
      if (before.kind === 'system') throw invalid([{ path: 'id', message: 'System notes cannot be hidden' }]);
      const after = await tx.update('messages', id, { hidden: true, hidden_reason: reason });
      return { before, after };
    });
  }

  /** POST admin /conversations/{id}/lock: lock (with reason) or unlock */
  async lockConversation(staff: StaffViewer, id: string, body: { locked: boolean; reason: string }, by: By): Promise<Conversation> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const { before, after } = await this.setLock(id, body.locked, reason, by);
    await this.core.audit(
      {
        action: body.locked ? 'messaging.conversation.lock' : 'messaging.conversation.unlock',
        actionLabel: body.locked ? 'Locked a conversation' : 'Unlocked a conversation',
        category: 'customers',
        target: { type: 'conversation', id, ref: this.core.subjectOf(after).orderRef ?? null, label: this.core.subjectOf(after).title, sellerId: after.seller_id },
        reason,
        before: { status: before.status },
        after: { status: after.status },
      },
      by,
    );
    return this.one(staff, after, false);
  }

  private async setLock(id: string, locked: boolean, reason: string, by: By) {
    const res = await this.repo.transaction(async (tx) => {
      const before = await tx.get('conversations', id, { forUpdate: true });
      if (!before) throw notFound();
      const status = conversationMachine.next(before.status as 'open' | 'locked' | 'archived', locked ? 'lock' : 'unlock');
      const after = await tx.update('conversations', id, { status, locked_reason: locked ? reason : null });
      return { before, after };
    });
    if (locked) this.core.publish('messaging.conversation.locked', { conversationId: id, reason }, by);
    return res;
  }

  /** GET admin /reports */
  async listMessageReports(status: string | undefined, page: PageRequest, staff: StaffViewer): Promise<common.Page<MessageReport>> {
    const rows = await this.repo.reportsPage(status, page);
    return { ...rows, items: await this.reportViews(rows.items, staff) };
  }

  private async reportViews(rows: readonly ReportRec[], staff: StaffViewer): Promise<MessageReport[]> {
    if (!rows.length) return [];
    const [messages, convs] = await Promise.all([this.repo.getMany('messages', rows.map((r) => r.message_id)), this.repo.getMany('conversations', rows.map((r) => r.conversation_id))]);
    const views = new Map((await this.core.messagesOf(staff, messages, true)).map((m) => [m.id, m]));
    const subjects = new Map(convs.map((c) => [c.id, this.core.subjectOf(c)]));
    return rows.map((r) => ({
      id: r.id,
      message: views.get(r.message_id)!,
      conversationId: r.conversation_id,
      subject: subjects.get(r.conversation_id) ?? { kind: 'order', title: 'Conversation' },
      reporter: { kind: r.reporter_kind as common.Actor['kind'], id: r.reporter_id },
      reason: r.reason as ReportReason,
      note: r.note,
      status: r.status as MessageReport['status'],
      outcome: r.outcome,
      decidedBy: r.decided_by ? { kind: 'staff', id: r.decided_by } : null,
      decidedAt: r.decided_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /** POST admin /reports/{id}/decide: hide the message, lock the conversation, refer to trust, or dismiss */
  async decideMessageReport(staff: StaffViewer, id: string, body: { action: 'hide_message' | 'lock_conversation' | 'refer_to_trust' | 'dismiss'; reason: string }, by: By): Promise<MessageReport> {
    const reason = body.reason?.trim();
    if (!reason) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const report = await this.repo.get('message_reports', id);
    if (!report) throw notFound('Report');
    const to = messageReportMachine.next(report.status as 'open', body.action === 'dismiss' ? 'dismiss' : 'action');
    let outcome: string;
    if (body.action === 'hide_message') {
      const m = await this.repo.get('messages', report.message_id);
      if (m && !m.hidden) await this.hide(m.id, reason);
      outcome = 'Message hidden';
    } else if (body.action === 'lock_conversation') {
      const c = await this.repo.get('conversations', report.conversation_id);
      if (c?.status === 'open') await this.setLock(c.id, true, reason, by);
      else if (c?.status === 'archived') throw new AppError('ILLEGAL_TRANSITION', 'An archived conversation cannot be locked', { machine: 'Conversation', from: 'archived', event: 'lock' });
      outcome = 'Conversation locked';
    } else if (body.action === 'refer_to_trust') {
      const trust = this.ctx.tryUse('trust');
      if (!trust) throw new AppError('SERVICE_UNAVAILABLE', 'Trust and Risk is not available right now', undefined, 503);
      const m = await this.repo.get('messages', report.message_id);
      const c = await this.repo.get('conversations', report.conversation_id);
      const subject = c ? this.core.subjectOf(c) : null;
      const r = await trust.raiseSignal({
        type: 'abuse',
        detector: 'messaging.report',
        title: `Reported message: ${report.reason.replace(/_/g, ' ')}${subject ? ` (${subject.title})` : ''}`,
        subjects: [
          { type: 'message', id: report.message_id, label: 'Reported message' },
          { type: 'conversation', id: report.conversation_id, ref: subject?.orderRef ?? null, label: subject?.title ?? 'Conversation' },
          ...(m?.author_kind === 'seller' && m.author_id && isUuid(m.author_id) ? [{ type: 'seller' as const, id: m.author_id, label: m.author_label }] : []),
          ...(m?.author_kind === 'customer' && c?.customer_id ? [{ type: 'customer' as const, id: c.customer_id, label: m.author_label }] : []),
        ],
        evidence: [{ kind: 'record_link', text: `Message report ${report.id}: ${reason}`, visibility: 'internal' }],
        dedupeKey: `messaging:report:${report.message_id}`,
      });
      outcome = `Referred to Trust and Risk${r?.ref ? ` (${r.ref})` : ''}`;
    } else {
      outcome = 'Dismissed';
    }
    const after = await this.repo.transaction(async (tx) => {
      const cur = await tx.get('message_reports', id, { forUpdate: true });
      if (!cur) throw notFound('Report');
      messageReportMachine.next(cur.status as 'open', body.action === 'dismiss' ? 'dismiss' : 'action');
      return tx.update('message_reports', id, { status: to, outcome: `${outcome}: ${reason}`, decided_by: staff.accountId, decided_at: this.now() });
    });
    await this.core.audit(
      {
        action: 'messaging.report.decide',
        actionLabel: body.action === 'dismiss' ? 'Dismissed a message report' : 'Actioned a message report',
        category: 'customers',
        target: { type: 'message_report', id, label: report.reason },
        relatedTargets: [
          { type: 'message', id: report.message_id },
          { type: 'conversation', id: report.conversation_id },
        ],
        reason,
        before: { status: report.status },
        after: { status: after.status, action: body.action },
      },
      by,
    );
    return (await this.reportViews([after], staff))[0]!;
  }

  /** GET admin /sellers/{sellerId}/response-stats: default the last 30 days */
  async sellerStatsAdmin(sellerId: string, q: { from?: string; to?: string }): Promise<ResponseStats> {
    const to = q.to ?? this.core.today();
    const from = q.from ?? this.core.today(new Date(zonedTimeToUtc(to, '12:00', this.core.tz).getTime() - 29 * DAY));
    return this.sellerResponseStats(sellerId, { from, to });
  }

  /* ================================================================ public API (in-process) */

  /** One conversation per customer, seller and subject; reused when it exists */
  async findOrStartForOrder(input: { orderId: string; sellerId: string; orderItemId?: string; returnId?: string }): Promise<Conversation> {
    const order = await this.ctx.use('orders').getOrder(input.orderId);
    if (!order) throw notFound('Order');
    const group = order.groups.find((g) => g.seller.id === input.sellerId);
    if (!group) throw this.core.error('ORDER_NOT_ELIGIBLE', 'This seller is not part of the order');
    const item = input.orderItemId ? group.items.find((i) => i.id === input.orderItemId) : undefined;
    if (input.orderItemId && !item) throw notFound('Order item');
    const ret = input.returnId ? ((await this.returnOf(order, input.returnId)) ?? { id: input.returnId, ref: null, status: null }) : null;
    const customerId = order.contact.customerId ?? null;
    const participants: Omit<ParticipantRec, 'conversation_id' | 'joined_at'>[] = [
      { kind: 'seller', participant_id: input.sellerId, name: group.seller.name, label: 'Seller', joined_from_case_id: null, last_read_message_id: null, unread_count: 0 },
    ];
    if (customerId) participants.unshift({ kind: 'customer', participant_id: customerId, name: buyerName(order.contact.name), label: 'Buyer', joined_from_case_id: null, last_read_message_id: null, unread_count: 0 });
    const key: ConversationKey = { kind: 'order', customer_id: customerId, seller_id: input.sellerId, application_id: null, order_id: order.id, order_item_id: item?.id ?? null, return_id: ret?.id ?? null };
    const c = await this.findOrCreate(key, { guest_session_id: null, subject: this.subjectFrom(order, group, item ?? null, ret, null, null), case_id: null }, participants, { actor: SYSTEM });
    const viewer: Viewer = customerId ? { kind: 'customer', customerId, guestSessionId: null, accountId: null } : { kind: 'seller', sellerId: input.sellerId, accountId: null, name: null };
    return this.one(viewer, c, false);
  }

  /** e.g. Marketly Support joined from case CS-261005-3381 */
  async postSystemNote(conversationId: string, text: string): Promise<Message> {
    if (!text?.trim()) throw invalid([{ path: 'text', message: 'The note is empty' }]);
    const m = await this.core.systemNote(conversationId, text.trim());
    return (await this.core.messagesOf(null, [m]))[0]!;
  }

  /** Support joins an order conversation when a case is opened */
  async addStaffParticipant(conversationId: string, staff: common.Actor, caseId: string): Promise<Conversation> {
    const c = await this.repo.get('conversations', conversationId);
    if (!c) throw notFound();
    const caseRef = await this.caseRef(c.order_id, caseId);
    await this.joinFromCase(c, { id: staff.id ?? SUPPORT_TEAM_ID, name: staff.name ?? SUPPORT_LABEL }, caseId, caseRef);
    const viewer: StaffViewer = { kind: 'staff', accountId: staff.id ?? SUPPORT_TEAM_ID, name: staff.name ?? null };
    return this.one(viewer, (await this.repo.get('conversations', c.id))!, false);
  }

  /** Response time for seller performance and reports */
  async sellerResponseStats(sellerId: string, range: common.DateRange): Promise<ResponseStats> {
    if (range.from > range.to) throw invalid([{ path: 'from', message: 'The start date must be on or before the end date' }]);
    const [cfg, inbox] = await Promise.all([this.core.cfg(), this.repo.sellerInbox(sellerId)]);
    const r = await this.replyFigures(sellerId, range, cfg);
    return { targetHours: cfg.targetHours, averageReplyMinutes: r.averageReplyMinutes, repliedWithinTargetPct: r.repliedWithinTargetPct, awaitingReply: inbox.awaiting + inbox.overdue, overdue: inbox.overdue, period: range };
  }

  private async replyFigures(sellerId: string, range: common.DateRange, cfg: Cfg): Promise<{ averageReplyMinutes: number | null; repliedWithinTargetPct: number | null }> {
    const tz = this.core.tz;
    const from = zonedTimeToUtc(range.from, '00:00', tz);
    const to = new Date(zonedTimeToUtc(range.to, '00:00', tz).getTime() + DAY);
    const lines = await this.repo.sellerMessageLines(sellerId, new Date(from.getTime() - ROUND_LOOKBACK_MS), to);
    const now = this.now().getTime();
    const target = cfg.targetHours * HOUR;
    const rounds = replyRounds(lines).filter((x) => x.start >= from && x.start < to);
    const replied = rounds.filter((x) => x.reply);
    const decided = rounds.filter((x) => x.reply || x.start.getTime() + target <= now);
    const within = replied.filter((x) => x.reply!.getTime() - x.start.getTime() <= target);
    return {
      averageReplyMinutes: replied.length ? Math.round(replied.reduce((s, x) => s + (x.reply!.getTime() - x.start.getTime()), 0) / replied.length / MINUTE) : null,
      repliedWithinTargetPct: decided.length ? Math.round((within.length / decided.length) * 1000) / 10 : null,
    };
  }

  /** Badge counts for the account and Seller Center: unread messages */
  async unreadCount(participant: common.Actor): Promise<number> {
    const v = await this.core.viewerOf(participant);
    return v ? (await this.unreadCounts(v)).messages : 0;
  }

  /** Conversations about an order or its items that the participant takes part in (Order.conversations) */
  async listForOrder(orderId: string, participant: common.Actor): Promise<ConversationSummary[]> {
    const v = await this.core.viewerOf(participant);
    return v ? (await this.viewsForOrder(v, orderId)).map((x) => x.summary) : [];
  }

  async viewsForOrder(v: Viewer, orderId: string): Promise<ConversationView[]> {
    const rows = await this.repo.find('conversations', { order_id: orderId }, { orderBy: [['last_message_at', 'desc']] });
    const visible: ConversationRec[] = [];
    for (const c of rows) if (await this.core.visible(v, c)) visible.push(c);
    return this.views(v, visible);
  }

  /** The conversation linked to a return, case or item, batched (Return.conversation) */
  async getForSubject(subject: { kind: 'return' | 'case' | 'order_item'; id: string }, participant: common.Actor): Promise<Conversation | null> {
    const v = await this.core.viewerOf(participant);
    return v ? ((await this.viewForSubject(v, subject))?.conversation ?? null) : null;
  }

  async viewForSubject(v: Viewer, subject: { kind: 'return' | 'case' | 'order_item'; id: string }): Promise<ConversationView | null> {
    if (!isUuid(subject.id)) return null;
    const col = subject.kind === 'return' ? 'return_id' : subject.kind === 'case' ? 'case_id' : 'order_item_id';
    const rows = await this.repo.find('conversations', { [col]: subject.id } as never, { orderBy: [['last_message_at', 'desc']] });
    // customer-seller threads first, then support and staff threads
    rows.sort((a, b) => (a.kind === 'order' ? 0 : 1) - (b.kind === 'order' ? 0 : 1));
    for (const c of rows) if (await this.core.visible(v, c)) return (await this.views(v, [c]))[0]!;
    return null;
  }

  /** Unread counts and who wrote, for the account overview tile and header badge */
  async unreadSummary(participant: common.Actor): Promise<{ conversations: number; messages: number; fromNames: string[] }> {
    const v = await this.core.viewerOf(participant);
    return v ? this.unreadSummaryFor(v) : { conversations: 0, messages: 0, fromNames: [] };
  }

  async unreadSummaryFor(v: Viewer): Promise<{ conversations: number; messages: number; fromNames: string[] }> {
    const rows = await this.unreadRows(v);
    if (!rows.length) return { conversations: 0, messages: 0, fromNames: [] };
    const convs = await this.repo.getMany('conversations', rows.map((r) => r.conversation_id));
    convs.sort((a, b) => b.last_message_at.getTime() - a.last_message_at.getTime());
    const views = await this.views(v, convs);
    return { conversations: rows.length, messages: rows.reduce((n, r) => n + r.unread_count, 0), fromNames: [...new Set(views.map((x) => x.summary.counterparty.name))] };
  }

  /** Unanswered and overdue customer messages for the seller dashboard */
  async sellerInboxSummary(sellerId: string): Promise<{ awaitingReply: number; overdue: number; oldestWaitingSince: string | null; unreadConversations: number; targetHours: number }> {
    const [i, cfg] = await Promise.all([this.repo.sellerInbox(sellerId), this.core.cfg()]);
    return { awaitingReply: i.awaiting + i.overdue, overdue: i.overdue, oldestWaitingSince: i.oldestWaitingSince?.toISOString() ?? null, unreadConversations: i.unreadConversations, targetHours: cfg.targetHours };
  }

  /** Inbox of a customer or seller; the seller inbox lists overdue first */
  async listInbox(participant: common.Actor, filter: { unreadOnly?: boolean; replyState?: string }, page: common.PageInput): Promise<common.Page<ConversationSummary>> {
    const v = await this.core.viewerOf(participant);
    if (!v) return { items: [], nextCursor: null, total: 0 };
    const p = await this.inboxViews(v, filter, toPageRequest(page));
    return { ...p, items: p.items.map((x) => x.summary) };
  }

  /** Conversation header and messages for a participant */
  async getConversation(participant: common.Actor, conversationId: string): Promise<Conversation | null> {
    const v = await this.core.viewerOf(participant);
    if (!v || !isUuid(conversationId)) return null;
    const c = await this.repo.get('conversations', conversationId);
    return c && (await this.core.visible(v, c)) ? this.one(v, c) : null;
  }

  /** Counts, last message time and counterparties of each customer's conversations for the customer 360; never message content */
  async customerConversationSummaries(customerIds: string[]): Promise<Record<string, CustomerConversationSummary>> {
    const ids = [...new Set(customerIds.filter(isUuid))];
    const out: Record<string, CustomerConversationSummary> = {};
    if (!ids.length) return out;
    const convs = await this.repo.find('conversations', { customer_id: ids }, { orderBy: [['last_message_at', 'desc']] });
    const [parts, reports] = await Promise.all([this.repo.participantsOf(convs.filter((c) => c.seller_id).map((c) => c.id)), this.repo.reportCounts(convs.map((c) => c.id))]);
    for (const id of ids) {
      const mine = convs.filter((c) => c.customer_id === id);
      const counterparties = new Map<string, { kind: 'seller' | 'official_store'; sellerId: string | null; name: string; conversationCount: number; lastMessageAt: string }>();
      for (const c of mine) {
        if (c.kind !== 'order') continue;
        const k = c.seller_id ?? 'official';
        const cur = counterparties.get(k);
        if (cur) {
          cur.conversationCount += 1;
          continue;
        }
        const name = c.seller_id ? (parts.find((p) => p.conversation_id === c.id && p.kind === 'seller')?.name ?? 'Seller') : OFFICIAL_STORE_NAME;
        counterparties.set(k, { kind: c.seller_id ? 'seller' : 'official_store', sellerId: c.seller_id, name, conversationCount: 1, lastMessageAt: c.last_message_at.toISOString() });
      }
      out[id] = {
        conversationCount: mine.length,
        openCount: mine.filter((c) => c.status === 'open').length,
        reportedCount: mine.filter((c) => c.status === 'locked' || (reports.get(c.id) ?? 0) > 0).length,
        lastMessageAt: mine[0]?.last_message_at.toISOString() ?? null,
        counterparties: [...counterparties.values()],
      };
    }
    return out;
  }

  /* ================================================================ events consumed */

  /** support.case.opened: If the case concerns an order conversation, add Marketly Support as a participant and post a system note */
  async onCaseOpenedFromSupport(event: EventPayload<'support.case.opened'>): Promise<void> {
    if (!event.orderId) return;
    const rows = await this.repo.find('conversations', { order_id: event.orderId, kind: 'order' });
    const items = new Set(event.orderItemIds ?? []);
    const concerned = rows.filter(
      (c) =>
        (!event.sellerId || c.seller_id === event.sellerId) &&
        (!event.customerId || !c.customer_id || c.customer_id === event.customerId) &&
        (!items.size || !c.order_item_id || items.has(c.order_item_id)),
    );
    if (!concerned.length) {
      this.ctx.log.info({ caseId: event.caseId, orderId: event.orderId }, 'messaging: case opened without an order conversation');
      return;
    }
    for (const c of concerned) await this.joinFromCase(c, { id: SUPPORT_TEAM_ID, name: SUPPORT_LABEL }, event.caseId, event.ref);
  }

  /** Adds Marketly Support as a participant (once per case) and posts the system note */
  private async joinFromCase(c: ConversationRec, staff: { id: string; name: string }, caseId: string, caseRef: string | null) {
    const joined = await this.repo.transaction(async (tx) => {
      const already = await tx.findOne('participants', { conversation_id: c.id, kind: 'staff', joined_from_case_id: caseId });
      if (already) return false;
      const added = await tx.insertIgnore('participants', {
        conversation_id: c.id,
        kind: 'staff',
        participant_id: staff.id,
        name: staff.name,
        label: c.kind === 'order' && !c.seller_id ? OFFICIAL_STORE_NAME : SUPPORT_LABEL,
        joined_at: this.now(),
        joined_from_case_id: caseId,
        last_read_message_id: null,
        unread_count: 0,
      });
      if (!added) await tx.updateWhere('participants', { conversation_id: c.id, kind: 'staff', participant_id: staff.id }, { joined_from_case_id: caseId });
      if (!c.case_id && c.kind !== 'staff_seller') await tx.update('conversations', c.id, { case_id: caseId });
      return true;
    });
    if (joined) await this.core.systemNote(c.id, `${SUPPORT_LABEL} joined from case ${caseRef ?? caseId}`);
  }

  /** orders.order.completed: Schedule archiving of the order's conversations after archiveAfterDays */
  async onOrderCompletedFromOrders(event: EventPayload<'orders.order.completed'>): Promise<void> {
    const cfg = await this.core.cfg();
    const at = new Date(new Date(event.completedAt).getTime() + cfg.archiveAfterDays * DAY);
    const n = await this.repo.updateWhere('conversations', { order_id: event.orderId }, { archive_after: at });
    if (!n) this.ctx.log.debug({ orderId: event.orderId }, 'messaging: completed order has no conversations');
  }

  /** trust.enforcement.recorded: Lock conversations named in an abuse enforcement */
  async onEnforcementRecordedFromTrust(event: EventPayload<'trust.enforcement.recorded'>): Promise<void> {
    if (event.alreadyApplied) return;
    if (event.action !== 'lock_conversation' && event.ownerTeam !== 'messaging') return;
    const targets = (event.targets ?? []) as { type?: string; id?: string }[];
    const ids = new Set<string>();
    for (const t of targets) {
      if (!t?.id || !isUuid(t.id)) continue;
      if (t.type === 'conversation') ids.add(t.id);
      else if (t.type === 'message') {
        const m = await this.repo.get('messages', t.id);
        if (m) ids.add(m.conversation_id);
      }
    }
    const by: By = { actor: SYSTEM };
    const reason = `Trust and Risk enforcement: ${event.reason}`;
    for (const id of ids) {
      const c = await this.repo.get('conversations', id);
      if (!c) {
        this.ctx.log.info({ conversationId: id, enforcementId: event.enforcementId }, 'messaging: enforcement names an unknown conversation');
        continue;
      }
      if (c.status !== 'open') continue; // already locked (or archived: nothing to stop)
      await this.setLock(id, true, reason, by);
      await this.core.audit(
        {
          action: 'messaging.conversation.lock',
          actionLabel: 'Locked a conversation (trust enforcement)',
          category: 'customers',
          target: { type: 'conversation', id, ref: this.core.subjectOf(c).orderRef ?? null, label: this.core.subjectOf(c).title, sellerId: c.seller_id },
          relatedTargets: [{ type: 'trust_enforcement', id: event.enforcementId }],
          reason,
          before: { status: 'open' },
          after: { status: 'locked' },
        },
        by,
      );
    }
  }

  /* ================================================================ jobs */

  /** Job messaging.reply-deadlines (every 10 min): Move awaiting conversations past their due time to overdue and publish messaging.reply.overdue */
  async replyDeadlines(): Promise<void> {
    for (let i = 0; i < MAX_BATCHES; i++) {
      const now = this.now();
      const due = await this.repo.dueAwaiting(now, JOB_BATCH);
      for (const row of due) {
        const moved = await this.repo.transaction(async (tx) => {
          const c = await tx.get('conversations', row.id, { forUpdate: true });
          if (!c || c.reply_state !== 'awaiting_seller' || !c.reply_due_at || c.reply_due_at > now) return null;
          return tx.update('conversations', c.id, { reply_state: sellerReplyMachine.next('awaiting_seller', 'deadlinePasses') });
        });
        if (moved?.seller_id && moved.reply_due_at) {
          this.core.publish('messaging.reply.overdue', { conversationId: moved.id, sellerId: moved.seller_id, orderId: moved.order_id, dueAt: moved.reply_due_at.toISOString() });
        }
      }
      if (due.length < JOB_BATCH) return;
    }
  }

  /** Job messaging.archive (daily 04:00 PT): Archive conversations past archiveAfterDays */
  async archive(): Promise<void> {
    for (let i = 0; i < MAX_BATCHES; i++) {
      const now = this.now();
      const due = await this.repo.dueArchive(now, JOB_BATCH);
      for (const row of due) {
        await this.repo.transaction(async (tx) => {
          const c = await tx.get('conversations', row.id, { forUpdate: true });
          if (!c || c.status !== 'open' || !c.archive_after || c.archive_after > now) return;
          await tx.update('conversations', c.id, { status: conversationMachine.next('open', 'archive') });
        });
      }
      if (due.length < JOB_BATCH) return;
    }
  }

  /** Job messaging.response-stats (hourly): Roll up seller reply times for performance and Seller Center */
  async responseStats(): Promise<void> {
    const since = new Date(this.now().getTime() - 2 * HOUR);
    const sellers = await this.repo.sellersActiveSince(since, 1000);
    for (const id of sellers) await this.cacheStats(id);
  }

  /** 30-day reply figures behind "Usually replies within …" */
  private async cacheStats(sellerId: string) {
    const to = this.core.today();
    const from = this.core.today(new Date(this.now().getTime() - 29 * DAY));
    const r = await this.replyFigures(sellerId, { from, to }, await this.core.cfg());
    this.core.replyCache.set(sellerId, { ...r, at: this.now().getTime() });
  }

  /* ================================================================ helpers */

  private lockedError(c: ConversationRec) {
    return this.core.error('CONVERSATION_LOCKED', c.status === 'locked' ? 'This conversation is locked' : 'This conversation is archived', {
      reason: c.status === 'locked' ? (c.locked_reason ?? 'locked') : 'archived',
    });
  }

  /** The existing conversation for the key (reopened when archived; locked refuses), or a new one with its participants */
  private async findOrCreate(
    key: ConversationKey,
    extra: { guest_session_id: string | null; subject: Subject; case_id: string | null; started_by_staff_id?: string | null },
    participants: Omit<ParticipantRec, 'conversation_id' | 'joined_at'>[],
    by: By,
  ): Promise<ConversationRec> {
    const existing = await this.repo.findByKey(key);
    if (existing) {
      if (existing.status === 'locked') throw this.lockedError(existing);
      if (existing.status === 'archived') {
        return this.repo.transaction(async (tx) => {
          const c = (await tx.get('conversations', existing.id, { forUpdate: true }))!;
          if (c.status !== 'archived') return c;
          return tx.update('conversations', c.id, { status: conversationMachine.next('archived', 'reopen') });
        });
      }
      // people who were not participants yet (e.g. the customer of a seller-started guest thread) join
      for (const p of participants) await this.repo.insertIgnore('participants', { ...p, conversation_id: existing.id, joined_at: this.now() });
      return existing;
    }
    const now = this.now();
    const c = await this.repo.transaction(async (tx) => {
      const row = await tx.insert('conversations', {
        id: newId(),
        kind: key.kind,
        customer_id: key.customer_id,
        guest_session_id: extra.guest_session_id,
        seller_id: key.seller_id,
        order_id: key.order_id,
        order_item_id: key.order_item_id,
        return_id: key.return_id,
        case_id: key.case_id ?? extra.case_id,
        application_id: key.application_id,
        started_by_staff_id: extra.started_by_staff_id ?? null,
        subject: extra.subject as never,
        status: conversationMachine.initial,
        locked_reason: null,
        reply_state: sellerReplyMachine.initial,
        reply_due_at: null,
        awaiting_since: null,
        created_at: now,
        last_message_at: now,
        archive_after: null,
      });
      for (const p of participants) await tx.insertIgnore('participants', { ...p, conversation_id: row.id, joined_at: now });
      return row;
    });
    this.core.publish('messaging.conversation.started', { conversationId: c.id, kind: c.kind, orderId: c.order_id, sellerId: c.seller_id }, by);
    return c;
  }

  private async finishStart(v: Viewer, conversationId: string, author: Author, prepared: Prepared, cfg: Cfg, by: By): Promise<{ conversation: Conversation; message: Message }> {
    const { message } = await this.core.commit(conversationId, author, prepared, cfg, by);
    const c = (await this.repo.get('conversations', conversationId))!;
    const [conversation, msg] = await Promise.all([this.one(v, c, false), this.core.messagesOf(v, [message])]);
    return { conversation, message: msg[0]! };
  }

  private subjectFrom(
    order: orders.OrderDetail,
    group: orders.SellerGroup | null,
    item: orders.OrderItem | null,
    ret: { id: string; ref: string | null; status: string | null } | null,
    kase: { id: string; ref: string | null; status: string | null } | null,
    titleFallback: string | null,
  ): Subject {
    return {
      kind: ret ? 'return' : kase ? 'case' : item ? 'order_item' : 'order',
      orderId: order.id,
      orderRef: order.ref,
      orderItemId: item?.id ?? null,
      returnId: ret?.id ?? null,
      returnRef: ret?.ref ?? null,
      caseId: kase?.id ?? null,
      caseRef: kase?.ref ?? null,
      title: item?.title ?? (ret?.ref ? `Return ${ret.ref}` : null) ?? (titleFallback && kase?.ref ? `Case ${kase.ref}` : null) ?? `Order ${order.ref}`,
      imageUrl: (item ?? group?.items[0])?.image?.url ?? null,
      packageLabel: group?.packageLabel ?? null,
      statusLabel: ret?.status ?? kase?.status ?? item?.stateLabel ?? group?.statusLabel ?? order.statusLabel,
    };
  }

  /** The return on one of the order's items, from returns (null when returns does not know it) */
  private async returnOf(order: orders.OrderDetail, returnId: string): Promise<{ id: string; ref: string | null; status: string | null } | null> {
    const returns = this.ctx.tryUse('returns');
    if (!returns) return null;
    const items = order.groups.flatMap((g) => g.items.map((i) => i.id));
    if (!items.length) return null;
    const states = await returns.returnStateForItems(items);
    const r = states.find((s) => s.returnId === returnId);
    return r ? { id: returnId, ref: r.ref, status: r.status } : null;
  }

  private async verifyReturn(order: orders.OrderDetail, returnId: string) {
    const r = await this.returnOf(order, returnId);
    if (!r) throw notFound('Return');
    return r;
  }

  private async verifyCase(orderId: string, caseId: string): Promise<{ id: string; ref: string | null; status: string | null }> {
    const support = this.ctx.tryUse('support');
    if (!support) throw notFound('Case');
    const k = (await support.casesForOrder(orderId)).find((x) => x.caseId === caseId);
    if (!k) throw notFound('Case');
    return { id: caseId, ref: k.ref, status: k.status };
  }

  private async caseRef(orderId: string | null, caseId: string): Promise<string | null> {
    if (!orderId) return null;
    const cases = await this.core.soft('support', 'case reference', (s) => s.casesForOrder(orderId));
    return cases?.find((x) => x.caseId === caseId)?.ref ?? null;
  }

  /** Small helper for GraphQL: a page request from GraphQL paging args */
  pageRequest(p: common.PageInput | null | undefined): PageRequest {
    return toPageRequest({ ...(p?.cursor ? { cursor: p.cursor } : {}), ...(p?.page ? { page: p.page } : {}), ...(p?.limit ? { limit: p.limit } : {}) });
  }

  /** A seller's 30-day reply label (storefront and GraphQL Seller.replyStats) */
  replyLabelFor(averageReplyMinutes: number | null | undefined) {
    return responseTimeLabel(averageReplyMinutes) ?? 'No replies yet';
  }
}
