/**
 * Read models: the case as the customer, the seller or staff sees it (CaseView), the dispute review
 * (AdminCaseDetail), list rows and summaries. Order, return, staff and file facts are composed at read time.
 */
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { OrderDetail } from '../../../spec/orders.js';
import type { AdminCaseDetail, AdminCaseRow, Appeal, CaseDecision, CaseItem, CaseMessage, CaseOffer, CaseSummary, CaseView, Evidence, Handler, NamedDeadline, PurchaseTerms, Remedy, SellerCaseRow } from '../../../spec/support.js';
import {
  actionsFor,
  dateLabel,
  dateTimeLabel,
  deadline,
  isOpen,
  nextActionOf,
  OFFICIAL_STORE_NAME,
  relativeLabel,
  remedyTrack,
  reopenRules,
  statusLabel,
  SUPPORT_NAME,
  TEAM_LABEL,
  UNRESOLVED_REMEDY,
  type Area,
} from '../domain/rules.js';
import type { CategoryRec, EvidenceRec, MessageRec, OfferRec, RemedyRec } from '../ports.js';
import { actorFrom, type Agg, type Core } from './core.js';

/** Facts loaded once for a batch of views */
export interface ViewCtx {
  orders: Map<string, OrderDetail | null>;
  staff: Map<string, string>;
  media: Map<string, common.MediaRef>;
  returnRefs: Map<string, string>;
  categories: Map<string, CategoryRec>;
  appealReplyDays: number;
  reopenWindowDays: number;
}

const visibleMessage = (m: MessageRec, area: Area) => area === 'admin' || m.audience === 'all' || (area === 'store' ? m.audience === 'customer' : m.audience === 'seller');
const visibleEvent = (v: string, area: Area) => (area === 'admin' ? v !== 'staff' : v === 'all' || (area === 'store' ? v === 'customer' : v === 'seller'));
const MONEY = (amount: number | null, currency: string | null, fallback: string): common.Money | null => (amount === null ? null : { amount, currency: currency ?? fallback });

export class Views {
  constructor(private readonly core: Core) {}

  /* ---------------------------------------------------------------- batch facts */

  async prepare(aggs: Agg[], o: { orders?: boolean } = {}): Promise<ViewCtx> {
    const orderIds = [...new Set(aggs.map((a) => a.c.order_id).filter((x): x is string => !!x))];
    const mediaIds = aggs.flatMap((a) => [...a.messages.flatMap((m) => m.media_ids), ...a.evidence.flatMap((e) => e.media_ids), ...a.appeals.flatMap((x) => x.media_ids)]);
    const staffIds = aggs.flatMap((a) => [a.c.owner_staff_id, a.c.decision?.decidedBy.kind === 'staff' ? a.c.decision.decidedBy.id : null, ...a.appeals.map((x) => x.reviewer_staff_id)]);
    const orders = new Map<string, OrderDetail | null>();
    const [, staff, media, categories, appealReplyDays, reopenWindowDays] = await Promise.all([
      o.orders === false
        ? Promise.resolve()
        : Promise.all(
            orderIds.map(async (id) => {
              orders.set(id, (await this.core.quiet('order', () => this.core.ctx.use('orders').getOrder(id))) ?? null);
            }),
          ),
      this.core.staffNames(staffIds),
      this.core.mediaRefs(mediaIds),
      this.core.categories(),
      this.core.setting('appealReplyBusinessDays', 3),
      this.core.setting('reopenWindowDays', 30),
    ]);
    const returnRefs = new Map<string, string>();
    for (const a of aggs) if (a.c.return_id && a.c.facts.returnRef) returnRefs.set(a.c.return_id, a.c.facts.returnRef);
    const missing = aggs.filter((a) => a.c.return_id && !returnRefs.has(a.c.return_id));
    if (missing.length) {
      const items = missing.flatMap((a) => a.items.map((i) => i.order_item_id));
      const states = items.length ? await this.core.soft('returns', 'return refs', (r) => r.returnStateForItems(items)) : undefined;
      for (const s of states ?? []) if (s.returnId && s.ref) returnRefs.set(s.returnId, s.ref);
    }
    return { orders, staff, media, returnRefs, categories, appealReplyDays, reopenWindowDays };
  }

  /* ---------------------------------------------------------------- parts */

  actor(a: common.Actor, x: ViewCtx, area: Area): common.Actor {
    const name = a.name ?? (a.kind === 'staff' && a.id ? x.staff.get(a.id) : undefined) ?? null;
    if (area !== 'admin' && a.kind === 'staff') return { kind: 'staff', id: null, name: name ? `${name}, Marketly support` : SUPPORT_NAME };
    return { kind: a.kind, id: a.id ?? null, ...(name ? { name } : {}) };
  }

  refs(ids: string[], x: ViewCtx): common.MediaRef[] {
    return ids.map((id) => x.media.get(id)).filter((r): r is common.MediaRef => !!r);
  }

  handler(agg: Agg, x: ViewCtx, area: Area): Handler {
    const c = agg.c;
    const owner = c.owner_staff_id ? x.staff.get(c.owner_staff_id) : undefined;
    const name = c.handler_kind === 'seller' ? `${c.facts.sellerName ?? 'The seller'} (seller)` : c.handler_kind === 'official_store' ? OFFICIAL_STORE_NAME : owner ? `${owner}, ${SUPPORT_NAME}` : SUPPORT_NAME;
    return {
      kind: c.handler_kind as Handler['kind'],
      name,
      staff: c.owner_staff_id && c.handler_kind === 'marketplace_support' ? { kind: 'staff', id: area === 'admin' ? c.owner_staff_id : null, ...(owner ? { name: owner } : {}) } : null,
      team: TEAM_LABEL[c.team] ?? c.team,
      supportFollowing: c.support_following,
    };
  }

  remedy(r: RemedyRec, currency: string): Remedy {
    const t = remedyTrack(r.kind, r.status, { linked: !!r.replacement_id });
    return {
      id: r.id,
      kind: r.kind as Remedy['kind'],
      amount: MONEY(r.amount, r.currency, currency),
      chargedTo: (r.charged_to as Remedy['chargedTo']) ?? null,
      orderItemIds: r.order_item_ids,
      status: r.status as Remedy['status'],
      statusLabel: t.statusLabel,
      track: t.track,
      currentStep: t.currentStep,
      refundRequestId: r.refund_request_id,
      replacementId: r.replacement_id,
      dueAt: r.due_at?.toISOString() ?? null,
      destination: ['refund', 'partial_refund'].includes(r.kind) ? 'Original payment method' : r.kind === 'goodwill_credit' ? (this.core.ctx.modules.includes('wallet') ? 'Marketly credit' : 'Original payment method') : null,
      note: r.note ?? t.note,
    };
  }

  offer(o: OfferRec): CaseOffer {
    return {
      id: o.id,
      from: o.from_party as CaseOffer['from'],
      kind: o.kind as CaseOffer['kind'],
      amount: MONEY(o.amount, o.currency, this.core.currency),
      shipBy: o.ship_by,
      note: o.note,
      status: o.status as CaseOffer['status'],
      respondBy: o.respond_by?.toISOString() ?? null,
      createdAt: o.created_at.toISOString(),
    };
  }

  message(m: MessageRec, x: ViewCtx, area: Area): CaseMessage {
    const author = this.actor({ kind: m.author_kind as common.Actor['kind'], id: m.author_id }, x, area);
    return {
      id: m.id,
      author: m.role === 'marketly_staff' || m.role === 'internal_note' ? { ...author, ...(area === 'admin' ? {} : { name: m.author_label }) } : author,
      authorLabel: m.author_label,
      role: m.role as CaseMessage['role'],
      audience: m.audience as CaseMessage['audience'],
      body: m.body,
      attachments: this.refs(m.media_ids, x),
      at: m.at.toISOString(),
    };
  }

  evidence(e: EvidenceRec, x: ViewCtx, area: Area): Evidence {
    return { id: e.id, party: e.party as Evidence['party'], kind: e.kind as Evidence['kind'], media: this.refs(e.media_ids, x), note: e.note, addedBy: this.actor(actorFrom(e.added_by), x, area), at: e.at.toISOString() };
  }

  items(agg: Agg, x: ViewCtx): CaseItem[] {
    const order = agg.c.order_id ? x.orders.get(agg.c.order_id) : null;
    return agg.items.map((i) => {
      const s = i.snapshot;
      const group = order?.groups.find((g) => g.items.some((it) => it.id === i.order_item_id));
      const live = group?.items.find((it) => it.id === i.order_item_id);
      return {
        orderItemId: i.order_item_id,
        title: s.title,
        options: s.options ?? {},
        quantity: s.quantity,
        price: s.price,
        imageUrl: s.imageUrl ?? null,
        ownerType: s.ownerType,
        sellerId: s.ownerType === 'official' ? null : (s.sellerId ?? null),
        sellerName: s.sellerName,
        packageLabel: group?.packageLabel ?? s.packageLabel ?? null,
        itemStatus: live?.stateLabel ?? s.itemStatus ?? 'Ordered',
        estimate: group?.estimateLabel ?? null,
      };
    });
  }

  /** Whether the customer may ask Marketly to step in now */
  escalationAvailable(agg: Agg, now: Date = this.core.now()): boolean {
    const c = agg.c;
    if (!['open', 'waiting_on_seller', 'waiting_on_customer', 'reopened'].includes(c.status)) return false;
    if (c.handler_kind === 'official_store') return true;
    if (c.handler_kind !== 'seller') return false;
    const f = c.facts;
    if (f.dispatchOverdue || f.sellerRepliedAt) return true;
    if (c.status === 'waiting_on_seller' && c.next_response_due_at && c.next_response_due_at.getTime() <= now.getTime()) return true;
    if (agg.offers.some((o) => o.status === 'declined' || o.status === 'expired')) return true;
    return agg.remedies.some((r) => (UNRESOLVED_REMEDY as readonly string[]).includes(r.status));
  }

  /* ---------------------------------------------------------------- the case */

  caseView(agg: Agg, area: Area, x: ViewCtx): CaseView {
    const c = agg.c;
    const now = this.core.now();
    const f = c.facts;
    const cat = x.categories.get(c.category_key);
    const next = nextActionOf(this.core.nextFacts(agg), now);
    const party = area === 'store' ? 'customer' : area === 'seller' ? 'seller' : 'marketplace';
    const messages = agg.messages.filter((m) => visibleMessage(m, area));
    const order = c.order_id ? x.orders.get(c.order_id) : null;
    const remedies = agg.remedies.map((r) => this.remedy(r, this.core.currency));
    const appealRec = agg.appeals.at(-1);
    const unresolved = agg.remedies.find((r) => (UNRESOLVED_REMEDY as readonly string[]).includes(r.status));
    const decision: CaseDecision | null = c.decision
      ? {
          outcome: c.decision.outcome,
          reason: c.decision.reason,
          remedies,
          decidedBy: this.actor(c.decision.decidedBy, x, area),
          decidedAt: c.decision.decidedAt,
          publishedAt: c.decision.publishedAt,
          appealDeadline: c.decision.final ? null : c.decision.appealDeadline,
          appealRoute: `A different Marketly team member reviews, replies within ${x.appealReplyDays} business days`,
          final: c.decision.final,
        }
      : null;
    const appeal: Appeal | null = appealRec
      ? {
          id: appealRec.id,
          by: this.actor({ kind: appealRec.by_kind as common.Actor['kind'], id: appealRec.by_id }, x, area),
          reason: appealRec.reason,
          attachments: this.refs(appealRec.media_ids, x),
          submittedAt: appealRec.submitted_at.toISOString(),
          status: appealRec.status as Appeal['status'],
          reviewer: appealRec.reviewer_staff_id ? this.actor({ kind: 'staff', id: appealRec.reviewer_staff_id }, x, area) : null,
          decidedAt: appealRec.decided_at?.toISOString() ?? null,
          outcome: appealRec.outcome,
        }
      : null;
    return {
      id: c.id,
      ref: c.ref,
      kind: c.kind as CaseView['kind'],
      subject: c.subject,
      category: cat ? this.core.categoryView(cat) : { key: c.category_key, label: c.category_key, audience: 'customer', group: 'other', defaultPriority: 'medium', team: 'customer_support', sellerHandlesFirst: false, firstResponseBusinessHours: 4, nextResponseBusinessHours: 8, resolutionBusinessDays: 5, active: false },
      priority: c.priority as CaseView['priority'],
      status: c.status as CaseView['status'],
      statusLabel: statusLabel(c.status, { area, handler: c.handler_kind, sellerReplied: !!f.sellerRepliedAt }),
      openedAt: c.opened_at.toISOString(),
      handledBy: this.handler(agg, x, area),
      nextAction: { ...next, youNeedToAct: next.whoMustAct === party },
      expectedResponse: isOpen(c.status) && (next.whoMustAct === 'seller' || next.whoMustAct === 'marketplace') ? deadline(c.next_response_due_at, now) : null,
      order: c.order_id ? { id: c.order_id, ref: order?.ref ?? f.orderRef ?? '', placedAt: order?.placedAt ?? f.placedAt ?? c.opened_at.toISOString() } : null,
      items: this.items(agg, x),
      returnId: c.return_id,
      returnRef: c.return_id ? (x.returnRefs.get(c.return_id) ?? f.returnRef ?? null) : null,
      messages: messages.map((m) => this.message(m, x, area)),
      attachments: this.refs([...new Set(messages.flatMap((m) => m.media_ids))], x),
      offers: agg.offers.map((o) => this.offer(o)),
      decision,
      remedies,
      appeal,
      reopenUntil: c.reopen_until?.toISOString() ?? null,
      reopenRules: reopenRules({ unresolvedRemedy: unresolved?.kind ?? null, reopenWindowDays: x.reopenWindowDays, reopenUntil: c.reopen_until, status: c.status, timeZone: this.core.tz }),
      timeline: agg.events.filter((e) => visibleEvent(e.visibility, area)).map((e) => ({ at: e.at.toISOString(), label: e.label, detail: e.detail, actor: e.actor_kind === 'system' ? null : this.actor({ kind: e.actor_kind as common.Actor['kind'], id: e.actor_id }, x, area) })),
      can: actionsFor(
        area,
        {
          status: c.status,
          handler: c.handler_kind,
          escalationAvailable: this.escalationAvailable(agg, now),
          decisionFinal: c.decision?.final ?? false,
          hasDecision: !!c.decision,
          appealDeadline: c.appeal_deadline,
          appealed: agg.appeals.length > 0,
          reopenUntil: c.reopen_until,
          openOffer: agg.offers.some((o) => o.status === 'open' && (!o.respond_by || o.respond_by.getTime() > now.getTime())),
        },
        now,
      ),
    };
  }

  async views(aggs: Agg[], area: Area): Promise<CaseView[]> {
    const x = await this.prepare(aggs);
    return aggs.map((a) => this.caseView(a, area, x));
  }

  async view(agg: Agg, area: Area): Promise<CaseView> {
    return (await this.views([agg], area))[0]!;
  }

  /* ---------------------------------------------------------------- dispute review */

  purchaseTerms(agg: Agg, order: OrderDetail | null | undefined): PurchaseTerms | null {
    if (!order) return null;
    const first = agg.items[0];
    const group = order.groups.find((g) => g.items.some((i) => i.id === first?.order_item_id)) ?? order.groups[0];
    const item = group?.items.find((i) => i.id === first?.order_item_id) ?? group?.items[0];
    if (!group || !item) return null;
    const terms = order.policyVersions.find((p) => p.policyKey === 'purchase_terms');
    const discount = item.discounts.reduce((s, d) => s + d.amount.amount, 0);
    const fmt = (m: common.Money) => `$${(m.amount / 100).toFixed(2)}`;
    return {
      snapshotAt: order.acceptedAt ?? order.placedAt,
      termsVersion: terms?.version ?? `offer terms v${item.offer.termsVersion}`,
      item: `${item.title}${item.variantLabel ? ` · ${item.variantLabel}` : ''} × ${item.quantity}`,
      pricePaid: item.paidAmount,
      listPrice: item.offer.compareAtPrice ?? null,
      discountNote: discount ? `${item.discounts.map((d) => d.label).join(', ')}: −${fmt({ amount: discount, currency: item.paidAmount.currency })}` : null,
      promisedDelivery: `${group.delivery.methodName}: arrives ${group.delivery.arrival.from} – ${group.delivery.arrival.to}`,
      dispatchBy: group.delivery.dispatchBy,
      shipping: `${group.delivery.methodName}${group.delivery.free ? ' (free)' : ` ${fmt(group.delivery.price)}`} from ${group.shipsFrom}`,
      returns: item.returnTerms.summary,
      payment: order.progress.payment.methodLabel,
    };
  }

  deadlines(agg: Agg): NamedDeadline[] {
    const c = agg.c;
    const now = this.core.now();
    const out: NamedDeadline[] = [];
    const f = c.facts;
    const push = (label: string, at: Date | string | null | undefined, party: NamedDeadline['party']) => {
      const d = deadline(at ?? null, now);
      if (d) out.push({ label, deadline: d, party });
    };
    if (isOpen(c.status)) {
      const next = nextActionOf(this.core.nextFacts(agg), now);
      if (c.next_response_due_at && next.whoMustAct !== 'none') push(f.infoRequest ? `${f.infoRequest.from === 'seller' ? 'Seller' : 'Customer'} information due` : next.whoMustAct === 'seller' ? 'Seller reply due' : next.whoMustAct === 'customer' ? 'Customer reply due' : 'Marketly response due', c.next_response_due_at, next.whoMustAct === 'customer' ? 'customer' : next.whoMustAct === 'seller' ? 'seller' : 'marketplace');
      if (c.resolution_due_at) push(c.kind === 'dispute' ? 'Decision due' : 'Resolution target', c.resolution_due_at, 'marketplace');
      for (const o of agg.offers.filter((x) => x.status === 'open' && x.respond_by)) push('Customer answers the offer', o.respond_by, 'customer');
      for (const r of agg.remedies.filter((x) => x.due_at && (UNRESOLVED_REMEDY as readonly string[]).includes(x.status))) push(r.kind === 'ship_by_deadline' ? 'Seller ships by' : `${r.kind.replace(/_/g, ' ')} due`, r.due_at, r.kind === 'ship_by_deadline' ? 'seller' : 'marketplace');
    }
    if (c.status === 'decision_made' && c.appeal_deadline && !c.decision?.final) push('Appeal deadline', c.appeal_deadline, 'customer');
    return out;
  }

  async adminDetail(agg: Agg, x?: ViewCtx): Promise<AdminCaseDetail> {
    const ctx = x ?? (await this.prepare([agg]));
    const c = agg.c;
    const f = c.facts;
    const order = c.order_id ? ctx.orders.get(c.order_id) : null;
    const [customer, seller, shipments, holds, refunds, perf, ordersCount, openCases] = await Promise.all([
      c.customer_id && isUuid(c.customer_id) ? this.core.soft('customers', 'customer', (m) => m.getCustomer(c.customer_id!)) : undefined,
      c.seller_id ? this.core.soft('sellers', 'seller', (m) => m.getSeller(c.seller_id!)) : undefined,
      c.order_id ? this.core.soft('shipping', 'shipments', (m) => m.getShipmentsForOrder(c.order_id!)) : undefined,
      this.core.soft('finance', 'holds', (m) => m.holdsForReference([{ kind: 'case', id: c.id }, ...(c.order_id ? [{ kind: 'order', id: c.order_id }] : [])])),
      this.core.soft('returns', 'case refunds', (m) => m.listRefundRequestsForCase(c.id)),
      c.seller_id ? this.core.soft('sellers', 'performance', (m) => m.getPerformance(c.seller_id!)) : undefined,
      c.customer_id && isUuid(c.customer_id) ? this.core.quiet('orders count', () => this.core.ctx.use('orders').countOrdersByTab(c.customer_id!)) : undefined,
      c.customer_id ? this.core.repo.countCases({ customerId: c.customer_id, statuses: ['open', 'waiting_on_seller', 'waiting_on_customer', 'escalated', 'decision_made', 'appealed', 'reopened'] }) : Promise.resolve(0),
    ]);
    const groupItems = new Set(agg.items.map((i) => i.order_item_id));
    const shipmentEvidence: common.TimelineEvent[] = [];
    for (const s of shipments ?? []) {
      if (order && !order.groups.find((g) => g.id === s.groupId)?.items.some((i) => groupItems.has(i.id))) continue;
      const what = `${s.packageLabel}${s.carrierName ? ` · ${s.carrierName}` : ''}${s.trackingNumber ? ` ${s.trackingNumber}` : ''}`;
      if (s.shippedAt) shipmentEvidence.push({ at: s.shippedAt, label: 'Shipped', detail: what });
      if (s.deliveredAt) shipmentEvidence.push({ at: s.deliveredAt, label: 'Delivered', detail: what });
      if (!s.shippedAt && !s.deliveredAt) shipmentEvidence.push({ at: order?.placedAt ?? c.opened_at.toISOString(), label: s.statusLabel, detail: what });
    }
    shipmentEvidence.sort((a, b) => a.at.localeCompare(b.at));
    const approver = (refunds ?? []).map((r) => r.approvedBy).find((a) => !!a) ?? null;
    const sellerOffer = [...agg.offers].reverse().find((o) => o.from_party === 'seller');
    const draft = c.decision_draft?.draft ? { draft: c.decision_draft.draft, savedAt: c.decision_draft.savedAt, savedBy: this.actor(c.decision_draft.savedBy, ctx, 'admin') } : null;
    const pending = c.pending;
    const pendingApproval: common.ApprovalInfo | null = pending
      ? ((await this.core.quiet('approval', () => this.core.ctx.use('access').approvalInfo(pending.requestId))) ?? { required: true, reason: 'Waiting for approval', approvalRequestId: pending.requestId, approvers: [] })
      : null;
    const perfPct = perf?.metrics.find((m) => m.key === 'dispatch_reliability')?.value;
    return {
      case: this.caseView(agg, 'admin', ctx),
      customer: c.customer_id || f.customerName || c.guest_session_id
        ? {
            id: c.customer_id,
            name: customer?.displayName ?? f.customerName ?? 'Guest customer',
            location: f.city ?? (order ? [order.deliveryAddress.city, order.deliveryAddress.region].filter(Boolean).join(', ') : null),
            orders: ordersCount?.all ?? (c.order_id ? 1 : 0),
            openCases,
            email: customer?.email ?? f.contactEmail ?? order?.contact.email ?? null,
            asksFor: f.desiredRemedy ? f.desiredRemedy.replace(/_/g, ' ').replace(/^./, (s) => s.toUpperCase()) : null,
          }
        : null,
      seller: c.seller_id || f.ownerType === 'official'
        ? {
            ownerType: f.ownerType === 'official' ? 'official' : 'seller',
            id: f.ownerType === 'official' ? null : c.seller_id,
            name: f.ownerType === 'official' ? OFFICIAL_STORE_NAME : (seller?.storeName ?? f.sellerName ?? 'Seller'),
            verified: f.ownerType === 'official' ? true : (seller?.verified ?? false),
            location: order?.groups.find((g) => g.items.some((i) => groupItems.has(i.id)))?.shipsFrom ?? null,
            onTimeDispatchPct: typeof perfPct === 'number' ? perfPct : null,
            offers: sellerOffer ? `${sellerOffer.kind.replace(/_/g, ' ')}${sellerOffer.ship_by ? ` by ${sellerOffer.ship_by}` : ''} (${sellerOffer.status})` : null,
          }
        : null,
      owner: c.owner_staff_id ? { kind: 'staff', id: c.owner_staff_id, ...(ctx.staff.get(c.owner_staff_id) ? { name: ctx.staff.get(c.owner_staff_id)! } : {}) } : null,
      team: TEAM_LABEL[c.team] ?? c.team,
      financeReviewer: approver ?? (pending ? { kind: 'staff', id: null, name: `Approval ${pending.ref ?? pending.requestId} pending` } : null),
      purchaseTerms: this.purchaseTerms(agg, order),
      shipmentEvidence,
      evidence: agg.evidence.map((e) => this.evidence(e, ctx, 'admin')),
      deadlines: this.deadlines(agg),
      holds: (holds ?? []).filter((h) => h.status === 'active').map((h) => `${h.sellerName} hold $${(h.amount.amount / 100).toFixed(2)} · review ${dateLabel(h.reviewDate, this.core.tz)}`),
      decisionDraft: draft,
      pendingApproval,
      history: agg.events.map((e) => ({ at: e.at.toISOString(), label: e.label, detail: [e.detail, e.reason].filter(Boolean).join(' · ') || null, actor: e.actor_kind === 'system' ? null : this.actor({ kind: e.actor_kind as common.Actor['kind'], id: e.actor_id }, ctx, 'admin') })),
    };
  }

  /* ---------------------------------------------------------------- rows */

  expectedReply(agg: Agg): string {
    const c = agg.c;
    if (c.status === 'closed') return `Closed ${dateLabel(c.closed_at ?? c.updated_at, this.core.tz)}`;
    if (c.status === 'resolved') return `Resolved ${dateLabel(c.resolved_at ?? c.updated_at, this.core.tz)}`;
    const next = nextActionOf(this.core.nextFacts(agg), this.core.now());
    if (next.whoMustAct === 'customer') return 'Waiting on you';
    if (next.whoMustAct === 'none') return next.label;
    return c.next_response_due_at ? `By ${dateTimeLabel(c.next_response_due_at, this.core.tz)}` : 'Within 1 business day';
  }

  summary(agg: Agg, x: ViewCtx): CaseSummary {
    const c = agg.c;
    const v = this.caseView(agg, 'store', x);
    return {
      id: c.id,
      ref: c.ref,
      kind: c.kind,
      subject: c.subject,
      orderId: c.order_id,
      orderRef: v.order?.ref || null,
      imageUrl: agg.items.find((i) => i.snapshot.imageUrl)?.snapshot.imageUrl ?? null,
      status: c.status,
      statusLabel: v.statusLabel,
      handledBy: v.handledBy,
      nextAction: v.nextAction,
      expectedReply: this.expectedReply(agg),
      open: isOpen(c.status),
      updatedAt: c.updated_at.toISOString(),
    };
  }

  adminRow(agg: Agg, x: ViewCtx): AdminCaseRow {
    const c = agg.c;
    const f = c.facts;
    const now = this.core.now();
    const open = isOpen(c.status);
    const owner = c.owner_staff_id ? x.staff.get(c.owner_staff_id) : undefined;
    return {
      id: c.id,
      ref: c.ref,
      kind: c.kind,
      category: x.categories.get(c.category_key)?.label ?? c.category_key,
      priority: c.priority as AdminCaseRow['priority'],
      customerName: f.customerName ?? null,
      sellerName: f.ownerType === 'official' ? OFFICIAL_STORE_NAME : (f.sellerName ?? null),
      owner: c.owner_staff_id ? { kind: 'staff', id: c.owner_staff_id, ...(owner ? { name: owner } : {}) } : null,
      status: c.status,
      statusLabel: statusLabel(c.status, { area: 'admin', handler: c.handler_kind, sellerReplied: !!f.sellerRepliedAt }),
      nextResponse: open ? deadline(c.next_response_due_at, now) : null,
      deadlineLabel: !open ? `${c.status === 'closed' ? 'Closed' : 'Resolved'} ${dateLabel(c.closed_at ?? c.resolved_at ?? c.updated_at, this.core.tz)}` : relativeLabel(c.next_response_due_at, now),
      orderId: c.order_id,
      orderRef: f.orderRef ?? null,
      reopened: c.reopen_count > 0,
      updatedAt: c.updated_at.toISOString(),
    };
  }

  sellerRow(agg: Agg, x: ViewCtx): SellerCaseRow {
    const c = agg.c;
    const f = c.facts;
    const next = nextActionOf(this.core.nextFacts(agg), this.core.now());
    return {
      id: c.id,
      ref: c.ref,
      kind: c.kind,
      category: x.categories.get(c.category_key)?.label ?? c.category_key,
      subject: c.subject,
      orderRef: f.orderRef ?? null,
      returnRef: c.return_id ? (x.returnRefs.get(c.return_id) ?? f.returnRef ?? null) : null,
      status: c.status,
      statusLabel: statusLabel(c.status, { area: 'seller', handler: c.handler_kind, sellerReplied: !!f.sellerRepliedAt }),
      marketplaceInvolved: c.kind === 'seller_request' || c.handler_kind === 'marketplace_support' || c.support_following,
      nextAction: { ...next, youNeedToAct: next.whoMustAct === 'seller' },
      updatedAt: c.updated_at.toISOString(),
    };
  }
}
