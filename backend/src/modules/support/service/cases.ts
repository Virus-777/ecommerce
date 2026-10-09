/**
 * Opening cases (customer, seller, staff, other modules), the conversation, seller offers, evidence,
 * escalation, information requests, assignment, priority and category changes.
 */
import { zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type * as media from '../../../spec/media.js';
import type { OrderDetail } from '../../../spec/orders.js';
import type { CaseCategory, CaseCategoryInput, CaseCreateInput, CaseOfferInput, Evidence, EvidenceInput, SellerRequestInput, StaffCaseInput } from '../../../spec/support.js';
import { caseMachine, caseOfferMachine } from '../domain/state-machines.js';
import {
  CLOSED_STATUSES,
  KINDS,
  OFFICIAL_STORE_NAME,
  PRIORITIES,
  PROBLEM_CATEGORY,
  PROBLEM_LABEL,
  resolveCategoryKey,
  SUPPORT_NAME,
  TEAM_LABEL,
  TEAM_ROLES,
  UNRESOLVED_REMEDY,
  type CaseKind,
  type CaseStatus,
  type HandlerKind,
  type Priority,
  type Team,
} from '../domain/rules.js';
import type { CaseFacts, CaseRec, CategoryRec, EvidenceRec, ItemRec, RemedyRec } from '../ports.js';
import { actorText, illegal, invalid, invalidField, notFound, type Agg, type By, type Core } from './core.js';
import type { Views } from './views.js';

/** The shopper behind a store request: a signed-in customer or a guest (visitor) session */
export interface Shopper {
  customerId?: string | null;
  accountId?: string | null;
  guestSessionId?: string | null;
}

/** Everything needed to open a case, whoever opens it */
interface Draft {
  kind: CaseKind;
  category: CategoryRec;
  priority?: Priority | null;
  subject: string;
  message: string;
  mediaIds: string[];
  customerId: string | null;
  guestSessionId: string | null;
  sellerId: string | null;
  order: OrderDetail | null;
  orderItemIds: string[];
  returnId: string | null;
  openedBy: common.Actor;
  author: { role: 'customer' | 'seller' | 'marketly_staff' | 'system'; label: string };
  replyChannel: string | null;
  facts: CaseFacts;
  ownerId: string | null;
  team?: Team | null;
  evidenceParty: 'customer' | 'seller' | 'staff';
  mediaOwner: media.MediaOwner | null;
}

const priorityFactor: Record<string, number> = { urgent: 0.5, high: 0.75, medium: 1, low: 1.5 };

export class Cases {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  /* ================================================================ opening */

  /** Order facts and item snapshots for the items a case is about (all of one seller package owner) */
  private itemsOf(order: OrderDetail, ids: string[]) {
    const all = order.groups.flatMap((g) => g.items.map((i) => ({ g, i })));
    const chosen = ids.map((id) => all.find((x) => x.i.id === id));
    const missing = ids.filter((_, n) => !chosen[n]);
    if (missing.length) throw invalidField('orderItemIds', 'Some items are not part of this order');
    const found = chosen.filter((x): x is NonNullable<typeof x> => !!x);
    const owners = new Set(found.map((x) => (x.g.seller.ownerType === 'official' ? 'official' : `seller:${x.g.seller.id}`)));
    if (owners.size > 1) throw invalidField('orderItemIds', 'Report items from one seller at a time');
    return found;
  }

  /** The least busy available member of the team's roles; the role lead when nobody is listed */
  async pickOwner(team: string): Promise<string | null> {
    const roles = TEAM_ROLES[team as Team] ?? TEAM_ROLES.customer_support;
    const access = this.core.ctx.use('access');
    const lists = await Promise.all(roles.map((r) => this.core.quiet('role members', () => access.membersOfRole(r))));
    const members = [...new Map(lists.flatMap((l) => l ?? []).filter((m) => !m.away).map((m) => [m.accountId, m])).values()];
    if (members.length) {
      const load = await this.core.repo.openPerOwner(
        members.map((m) => m.accountId),
        this.core.now(),
      );
      return [...members].sort((a, b) => (load.get(a.accountId)?.open ?? 0) - (load.get(b.accountId)?.open ?? 0))[0]!.accountId;
    }
    const lead = await this.core.quiet('role lead', () => access.resolveRecipients(roles[0]!));
    return lead?.leadAccountId ?? lead?.accountIds[0] ?? null;
  }

  async checkOwner(ownerId: string, path = 'ownerId'): Promise<string> {
    const ref = isUuid(ownerId) ? await this.core.quiet('staff', () => this.core.ctx.use('access').getStaffRef(ownerId)) : null;
    if (!ref) throw invalidField(path, 'Choose a staff member who can own cases');
    return ref.name;
  }

  /** Response target from now for Marketly, scaled by priority */
  async marketplaceDue(category: CategoryRec, priority: string, first: boolean, from: Date = this.core.now()): Promise<Date> {
    const hours = (first ? category.first_response_business_hours : category.next_response_business_hours) * (priorityFactor[priority] ?? 1);
    return this.core.addBusinessHours(from, hours);
  }

  private async open(d: Draft, by: By): Promise<Agg> {
    const now = this.core.now();
    const id = newId();
    const picked = d.order && d.orderItemIds.length ? this.itemsOf(d.order, d.orderItemIds) : [];
    const group = picked[0]?.g ?? (d.order && d.sellerId ? d.order.groups.find((g) => g.seller.id === d.sellerId) : undefined) ?? (d.order?.groups.length === 1 ? d.order.groups[0] : undefined);
    const ownerType = group?.seller.ownerType ?? d.facts.ownerType ?? (d.sellerId ? 'seller' : null);
    const sellerId = d.sellerId ?? (ownerType === 'seller' ? (group?.seller.id ?? null) : null);
    const sellerName = ownerType === 'official' ? OFFICIAL_STORE_NAME : (group?.seller.name ?? d.facts.sellerName ?? (sellerId ? ((await this.core.soft('sellers', 'seller', (s) => s.getSeller(sellerId)))?.storeName ?? null) : null));

    const handler: HandlerKind =
      d.kind === 'dispute' || d.kind === 'seller_request'
        ? 'marketplace_support'
        : d.kind === 'order_problem' && ownerType === 'seller' && sellerId && d.category.seller_handles_first
          ? 'seller'
          : ownerType === 'official'
            ? 'official_store'
            : 'marketplace_support';
    let status: CaseStatus = caseMachine.initial as CaseStatus;
    if (handler === 'seller') status = caseMachine.next(status, 'sendToSeller') as CaseStatus;
    if (d.kind === 'dispute') status = caseMachine.next(status, 'escalate') as CaseStatus;
    const priority = d.priority ?? (d.category.default_priority as Priority);
    const team = (d.team ?? d.category.team) as Team;

    const [sellerDays, disputeDays] = await Promise.all([this.core.setting('sellerReplyBusinessDays', 2), this.core.setting('disputeDecisionBusinessDays', 5)]);
    const firstDue = handler === 'seller' ? await this.core.addBusinessDays(now, sellerDays) : await this.marketplaceDue(d.category, priority, true, now);
    const resolutionDue = await this.core.addBusinessDays(now, d.kind === 'dispute' ? disputeDays : d.category.resolution_business_days);
    const ref = await this.core.caseRef();
    const ownerId = d.ownerId ?? (d.kind === 'dispute' ? await this.pickOwner(team) : null);
    if (d.mediaOwner) await this.core.attach(d.mediaIds, id, `Case ${ref}`, d.mediaOwner);

    // a return escalation brings the return's evidence along (later additions on the return are not synced)
    const copied = d.returnId ? ((await this.core.soft('returns', 'return evidence', (r) => r.listEvidence(d.returnId!))) ?? []) : [];

    const facts: CaseFacts = {
      ...d.facts,
      ownerType: ownerType ?? null,
      sellerName: sellerName ?? d.facts.sellerName ?? null,
      orderRef: d.order?.ref ?? d.facts.orderRef ?? null,
      placedAt: d.order?.placedAt ?? d.facts.placedAt ?? null,
      customerName: d.facts.customerName ?? d.order?.contact.name ?? null,
      contactEmail: d.facts.contactEmail ?? d.order?.contact.email ?? null,
      city: d.facts.city ?? (d.order ? d.order.deliveryAddress.city : null),
      ...(d.kind === 'dispute' ? { escalation: { at: now.toISOString(), by: d.openedBy, reason: 'opened_as_dispute', to: team } } : {}),
    };
    const items: ItemRec[] = picked.map(({ g, i }) => ({
      case_id: id,
      order_item_id: i.id,
      snapshot: {
        title: i.title,
        options: i.product.options ?? {},
        quantity: i.quantity,
        price: i.unitPrice,
        paid: i.paidAmount,
        imageUrl: i.image?.url ?? i.product.imageUrl ?? null,
        ownerType: g.seller.ownerType,
        sellerId: g.seller.ownerType === 'official' ? null : (g.seller.id ?? null),
        sellerName: g.seller.ownerType === 'official' ? OFFICIAL_STORE_NAME : g.seller.name,
        packageLabel: g.packageLabel,
        groupId: g.id,
        productId: i.product.productId,
        variantId: i.product.variantId,
        itemStatus: i.stateLabel,
      },
    }));

    const row: CaseRec = {
      id,
      ref,
      kind: d.kind,
      category_key: d.category.key,
      priority,
      status,
      subject: d.subject,
      customer_id: d.customerId,
      guest_session_id: d.guestSessionId,
      seller_id: sellerId,
      order_id: d.order?.id ?? null,
      return_id: d.returnId,
      handler_kind: handler,
      owner_staff_id: ownerId,
      team,
      support_following: handler === 'seller' || d.kind === 'dispute',
      next_action: { label: '', whoMustAct: 'none', note: null, facts },
      first_response_due_at: firstDue,
      next_response_due_at: firstDue,
      resolution_due_at: resolutionDue,
      waiting_on: handler === 'seller' ? 'seller' : 'marketplace',
      reply_channel: d.replyChannel,
      decision: null,
      decision_draft: null,
      appeal_deadline: null,
      reopen_until: null,
      reopen_count: 0,
      opened_by: actorText(d.openedBy),
      opened_at: now,
      first_replied_at: null,
      resolved_at: null,
      closed_at: null,
      updated_at: now,
    };

    await this.core.repo.transaction(async (tx) => {
      await tx.insert('cases', row);
      await tx.insertMany('case_items', items);
      const a: Agg = { c: row, items, messages: [], evidence: [], offers: [], remedies: [], appeals: [], events: [] };
      a.messages.push(await this.core.message(tx, id, { author: d.openedBy, authorLabel: d.author.label, role: d.author.role, audience: 'all', body: d.message, mediaIds: d.mediaIds }, now));
      const evidence: EvidenceRec[] = [];
      if (d.mediaIds.length) evidence.push({ id: newId(), case_id: id, party: d.evidenceParty, kind: 'photo', media_ids: d.mediaIds, note: 'Attached when the case was opened', added_by: actorText(d.openedBy), at: now });
      for (const e of copied) {
        evidence.push({ id: newId(), case_id: id, party: e.party, kind: e.kind, media_ids: e.media.map((m) => m.id), note: `From return ${facts.returnRef ?? ''}`.trim() + (e.note ? `: ${e.note}` : ''), added_by: actorText(e.addedBy), at: new Date(e.addedAt) });
      }
      await tx.insertMany('case_evidence', evidence);
      await this.core.timeline(tx, id, [
        { kind: 'opened', label: 'Case opened', detail: d.subject, visibility: 'all', actor: d.openedBy },
        ...(handler === 'seller' ? [{ kind: 'sent_to_seller', label: `Sent to ${sellerName ?? 'the seller'}`, detail: 'The seller answers first. If they miss the deadline, Marketly steps in.', visibility: 'all' as const }] : []),
        ...(d.kind === 'dispute' ? [{ kind: 'dispute_opened', label: 'Marketly support is reviewing the case', detail: TEAM_LABEL[team] ?? team, visibility: 'all' as const }] : []),
        ...(ownerId ? [{ kind: 'assigned', label: 'Owner assigned', detail: ownerId, visibility: 'staff' as const }] : []),
        ...(copied.length ? [{ kind: 'evidence_copied', label: `${copied.length} evidence item${copied.length === 1 ? '' : 's'} copied from the return`, visibility: 'staff' as const }] : []),
      ]);
      await this.core.save(tx, a, {});
      return a;
    });

    this.core.publish(
      'support.case.opened',
      {
        caseId: id,
        ref,
        kind: d.kind,
        category: d.category.key,
        priority,
        customerId: d.customerId && isUuid(d.customerId) ? d.customerId : null,
        sellerId,
        orderId: d.order?.id ?? null,
        orderItemIds: items.map((i) => i.order_item_id),
        handler,
        nextResponseDueAt: firstDue.toISOString(),
      },
      by,
    );
    if (d.kind === 'dispute') this.core.publish('support.case.escalated', { caseId: id, ref, to: team, reason: 'Opened as a dispute', sellerId, orderId: d.order?.id ?? null }, by);
    if (ownerId) this.core.publish('support.case.assigned', { caseId: id, ownerId, team }, by);
    return (await this.core.load(id))!;
  }

  private async duplicateCheck(orderItemIds: string[]) {
    if (!orderItemIds.length) return;
    const open = await this.core.repo.casesForItems(orderItemIds, true);
    if (!open.length) return;
    const existing = (await this.core.repo.get('cases', open[0]!.caseId))!;
    throw this.core.error('DUPLICATE_CASE', `This item already has an open case (${existing.ref}). Add a message there instead.`, { caseId: existing.id, ref: existing.ref });
  }

  /** An order the shopper may see, or NOT_FOUND */
  async shopperOrder(orderId: string, who: Shopper): Promise<OrderDetail> {
    const order = isUuid(orderId) ? await this.core.ctx.use('orders').getOrder(orderId) : null;
    if (!order) throw notFound('Order');
    if (who.customerId && order.contact.customerId === who.customerId) return order;
    if (who.guestSessionId && !order.contact.customerId) {
      const ok = await this.core.soft('identity', 'guest order access', (i) => i.hasGuestOrderAccess(who.guestSessionId!, order.id));
      if (ok) return order;
    }
    throw notFound('Order');
  }

  async createForShopper(body: CaseCreateInput, who: Shopper, by: By): Promise<Agg> {
    const cats = await this.core.categories();
    let category = cats.get(body.category);
    if ((!category || !category.active || category.audience !== 'customer') && body.problemType) category = cats.get(PROBLEM_CATEGORY[body.problemType] ?? '');
    if (!category || !category.active || category.audience !== 'customer') throw invalidField('category', 'Choose one of the help topics');
    if (body.kind === 'order_problem' && !body.orderId) throw invalidField('orderId', 'Choose the order with the problem');
    if (body.replyChannel === 'phone' && !body.callbackPhone?.trim()) throw invalidField('callbackPhone', 'Enter the number we should call');
    if (!body.message?.trim()) throw invalidField('message', 'Tell us what happened');
    await this.core.checkAttachments(body.mediaIds);
    const order = body.orderId ? await this.shopperOrder(body.orderId, who) : null;
    const ids = [...new Set(body.orderItemIds ?? [])];
    if (body.kind === 'order_problem' && !ids.length) throw invalidField('orderItemIds', 'Choose the items with the problem');
    if (order && ids.length) this.itemsOf(order, ids);
    await this.duplicateCheck(ids);
    const first = order?.groups.flatMap((g) => g.items).find((i) => ids.includes(i.id));
    const subject = body.subject?.trim() || (body.problemType ? `${PROBLEM_LABEL[body.problemType] ?? 'Problem'}${first ? `: ${first.title}` : ''}` : `${category.label}${order ? ` · ${order.ref}` : ''}`);
    const name = order?.contact.name ?? (who.customerId ? (await this.core.soft('customers', 'customer', (c) => c.getCustomer(who.customerId!)))?.displayName : null) ?? (who.customerId ? 'Customer' : 'Guest');
    return this.open(
      {
        kind: body.kind,
        category,
        subject,
        message: body.message.trim(),
        mediaIds: body.mediaIds ?? [],
        customerId: who.customerId ?? null,
        guestSessionId: who.customerId ? null : (who.guestSessionId ?? null),
        sellerId: null,
        order,
        orderItemIds: ids,
        returnId: null,
        openedBy: by.actor,
        author: { role: 'customer', label: name },
        replyChannel: body.replyChannel ?? null,
        facts: { problemType: body.problemType ?? null, desiredRemedy: body.desiredRemedy ?? null, callbackPhone: body.callbackPhone?.trim() || null, customerName: name },
        ownerId: null,
        evidenceParty: 'customer',
        mediaOwner: who.guestSessionId && !who.customerId ? { kind: 'guest', id: who.guestSessionId } : { kind: 'customer', id: who.accountId ?? by.actor.id ?? null },
      },
      by,
    );
  }

  async createSellerRequest(body: SellerRequestInput, sellerId: string, by: By): Promise<Agg> {
    const category = await this.core.category(body.category);
    if (!category || !category.active || category.audience !== 'seller') throw invalidField('category', 'Choose one of the seller support topics');
    if (!body.subject?.trim()) throw invalidField('subject', 'Add a subject');
    if (!body.message?.trim()) throw invalidField('message', 'Tell us what you need');
    await this.core.checkAttachments(body.mediaIds);
    const reference = body.reference?.trim() || null;
    let order: OrderDetail | null = null;
    let returnId: string | null = null;
    let returnRef: string | null = null;
    if (reference && /^MK-/i.test(reference)) order = (await this.core.quiet('order by ref', async () => (await this.core.ctx.use('orders').getOrderForSeller(sellerId, reference.toUpperCase()))?.order ?? null)) ?? null;
    if (reference && /^RT-/i.test(reference)) {
      const r = await this.core.soft('returns', 'return by ref', (m) => m.getReturnForSeller(sellerId, reference.toUpperCase()));
      if (r) {
        returnId = r.detail.id;
        returnRef = r.detail.ref;
        order = order ?? (await this.core.quiet('order', () => this.core.ctx.use('orders').getOrder(r.detail.orderId))) ?? null;
      }
    }
    const store = (await this.core.soft('sellers', 'seller', (s) => s.getSeller(sellerId)))?.storeName ?? 'Seller';
    return this.open(
      {
        kind: 'seller_request',
        category,
        subject: body.subject.trim(),
        message: body.message.trim(),
        mediaIds: body.mediaIds ?? [],
        customerId: null,
        guestSessionId: null,
        sellerId,
        order,
        orderItemIds: [],
        returnId,
        openedBy: by.actor,
        author: { role: 'seller', label: `${store} (seller)` },
        replyChannel: body.replyChannel,
        facts: { reference, returnRef, sellerName: store, ownerType: 'seller', customerName: null, contactEmail: null, city: null },
        ownerId: null,
        evidenceParty: 'seller',
        mediaOwner: { kind: 'seller', id: sellerId },
      },
      by,
    );
  }

  async createForStaff(body: StaffCaseInput, by: By): Promise<Agg> {
    const category = await this.core.category(body.category);
    if (!category) throw invalidField('category', 'Choose a case category');
    if (!(KINDS as readonly string[]).includes(body.kind)) throw invalidField('kind', 'Choose the kind of case');
    if (body.kind === 'seller_request' && !body.sellerId) throw invalidField('sellerId', 'Choose the seller');
    if (body.kind === 'order_problem' && !body.orderId) throw invalidField('orderId', 'Choose the order');
    if (!body.subject?.trim() || !body.message?.trim()) throw invalid([...(!body.subject?.trim() ? [{ path: 'subject', message: 'Add a subject' }] : []), ...(!body.message?.trim() ? [{ path: 'message', message: 'Add the first message' }] : [])]);
    if (body.ownerId) await this.checkOwner(body.ownerId);
    const order = body.orderId ? await this.core.ctx.use('orders').getOrder(body.orderId) : null;
    if (body.orderId && !order) throw notFound('Order');
    const ids = [...new Set(body.orderItemIds ?? [])];
    if (order && ids.length) this.itemsOf(order, ids);
    if (body.kind !== 'seller_request') await this.duplicateCheck(ids);
    const staffName = by.actor.name ?? (by.actor.id ? (await this.core.staffNames([by.actor.id])).get(by.actor.id) : undefined);
    const customerId = body.customerId ?? order?.contact.customerId ?? null;
    const customer = customerId ? await this.core.soft('customers', 'customer', (c) => c.getCustomer(customerId)) : undefined;
    return this.open(
      {
        kind: body.kind,
        category,
        priority: body.priority ?? null,
        subject: body.subject.trim(),
        message: body.message.trim(),
        mediaIds: [],
        customerId: body.kind === 'seller_request' ? null : customerId,
        guestSessionId: null,
        sellerId: body.sellerId ?? null,
        order,
        orderItemIds: ids,
        returnId: body.returnId ?? null,
        openedBy: by.actor,
        author: { role: 'marketly_staff', label: staffName ? `${staffName}, ${SUPPORT_NAME}` : SUPPORT_NAME },
        replyChannel: null,
        facts: { customerName: customer?.displayName ?? null, contactEmail: customer?.email ?? null },
        ownerId: body.ownerId ?? null,
        evidenceParty: 'staff',
        mediaOwner: null,
      },
      by,
    );
  }

  /**
   * In-process opening (return escalation, delivery exception, failed refund). An existing case for the same
   * return, or an open case on the same items, is returned (and linked to the return) instead of a second one.
   */
  async openFromModule(input: { kind: string; category: string; orderId?: string; orderItemIds?: string[]; customerId?: string; sellerId?: string; returnId?: string; subject: string; message: string; openedBy: common.Actor }): Promise<Agg> {
    const kind = (KINDS as readonly string[]).includes(input.kind) ? (input.kind as CaseKind) : input.kind === 'return' || input.kind === 'return_dispute' ? 'dispute' : null;
    if (!kind) throw invalidField('kind', 'Unknown case kind');
    const by: By = { actor: input.openedBy };
    if (input.returnId) {
      const linked = (await this.core.repo.find('cases', { return_id: input.returnId }, { orderBy: [['opened_at', 'desc']] }))[0];
      if (linked) return (await this.core.load(linked.id))!;
    }
    const order = input.orderId ? await this.core.ctx.use('orders').getOrder(input.orderId) : null;
    if (input.orderId && !order) throw notFound('Order');
    let ids = [...new Set(input.orderItemIds ?? [])];
    if (order && ids.length) ids = ids.filter((id) => order.groups.some((g) => g.items.some((i) => i.id === id)));
    const overlapping = ids.length ? await this.core.repo.casesForItems(ids, true) : [];
    if (overlapping.length) {
      const existing = (await this.core.load(overlapping[0]!.caseId))!;
      if (input.returnId && !existing.c.return_id) await this.linkReturn(existing, input.returnId, kind, input.message, by);
      return (await this.core.load(existing.c.id))!;
    }
    const cats = await this.core.categories();
    const audience = kind === 'seller_request' ? 'seller' : 'customer';
    const category = cats.get(resolveCategoryKey(input.category, new Set([...cats.values()].filter((c) => c.audience === audience).map((c) => c.key)), audience))!;
    const returnRef = input.returnId ? ((await this.core.soft('returns', 'return ref', (r) => r.returnStateForItems(ids)))?.find((s) => s.returnId === input.returnId)?.ref ?? null) : null;
    const customerId = input.customerId ?? order?.contact.customerId ?? null;
    return this.open(
      {
        kind,
        category,
        subject: input.subject?.trim() || category.label,
        message: input.message?.trim() || input.subject,
        mediaIds: [],
        customerId: kind === 'seller_request' ? null : customerId,
        guestSessionId: null,
        sellerId: input.sellerId ?? null,
        order,
        orderItemIds: ids,
        returnId: input.returnId ?? null,
        openedBy: input.openedBy,
        author: { role: input.openedBy.kind === 'customer' ? 'customer' : input.openedBy.kind === 'seller' ? 'seller' : input.openedBy.kind === 'staff' ? 'marketly_staff' : 'system', label: input.openedBy.kind === 'customer' ? (order?.contact.name ?? 'Customer') : input.openedBy.kind === 'system' ? 'Marketly' : (input.openedBy.name ?? SUPPORT_NAME) },
        replyChannel: null,
        facts: { returnRef },
        ownerId: null,
        team: input.returnId ? 'returns' : null,
        evidenceParty: 'staff',
        mediaOwner: null,
      },
      by,
    );
  }

  /** A return escalated about items that already have an open case: the case takes the return and becomes the dispute */
  private async linkReturn(agg: Agg, returnId: string, kind: CaseKind, note: string, by: By) {
    const [ownerId, disputeDays] = await Promise.all([agg.c.owner_staff_id ? Promise.resolve(agg.c.owner_staff_id) : this.pickOwner('returns'), this.core.setting('disputeDecisionBusinessDays', 5)]);
    const due = await this.core.addBusinessDays(this.core.now(), disputeDays);
    const escalated = await this.core.write(agg.c.id, by, async (tx, a, batch) => {
      if (a.c.return_id) return false;
      const canEscalate = caseMachine.can(a.c.status as CaseStatus, 'escalate');
      const status = canEscalate ? caseMachine.next(a.c.status as CaseStatus, 'escalate') : a.c.status;
      await this.core.save(
        tx,
        a,
        {
          return_id: returnId,
          status,
          kind: kind === 'dispute' || canEscalate ? 'dispute' : a.c.kind,
          team: 'returns',
          handler_kind: 'marketplace_support',
          support_following: true,
          owner_staff_id: ownerId,
          ...(canEscalate ? { next_response_due_at: due, resolution_due_at: due, waiting_on: 'marketplace' } : {}),
        },
        canEscalate ? { escalation: { at: this.core.now().toISOString(), by: by.actor, reason: 'return_escalated', to: 'returns', note } } : {},
      );
      await this.core.timeline(tx, a.c.id, [{ kind: 'return_linked', label: 'The return was escalated: Marketly support is reviewing', detail: note, visibility: 'all', actor: by.actor }]);
      if (canEscalate) batch.push('support.case.escalated', { caseId: a.c.id, ref: a.c.ref, to: 'returns', reason: 'The return was escalated', sellerId: a.c.seller_id, orderId: a.c.order_id });
      if (ownerId && ownerId !== agg.c.owner_staff_id) batch.push('support.case.assigned', { caseId: a.c.id, ownerId, team: 'returns' });
      return canEscalate;
    });
    return escalated;
  }

  /* ================================================================ conversation */

  async customerReply(agg: Agg, body: { body: string; mediaIds?: string[] | null }, who: Shopper, by: By): Promise<void> {
    if (!this.core.isOpen(agg.c)) throw illegal('This case is closed. Reopen it to add a message.', { from: agg.c.status, event: 'customerReplied' });
    if (!body.body?.trim()) throw invalidField('body', 'Write a message');
    await this.core.checkAttachments(body.mediaIds);
    const mediaIds = body.mediaIds ?? [];
    await this.core.attach(mediaIds, agg.c.id, `Case ${agg.c.ref}`, who.guestSessionId && !who.customerId ? { kind: 'guest', id: who.guestSessionId } : { kind: 'customer', id: who.accountId ?? by.actor.id ?? null });
    const cat = (await this.core.category(agg.c.category_key))!;
    const [sellerDue, staffDue] = await Promise.all([this.core.addBusinessDays(this.core.now(), await this.core.setting('sellerReplyBusinessDays', 2)), this.marketplaceDue(cat, agg.c.priority, false)]);
    await this.core.write(agg.c.id, by, async (tx, a, batch) => {
      if (!this.core.isOpen(a.c)) throw illegal('This case is closed. Reopen it to add a message.', { from: a.c.status });
      const patch: Partial<CaseRec> = {};
      const facts: Partial<CaseFacts> = {};
      let status = a.c.status as CaseStatus;
      if (status === 'waiting_on_customer') {
        status = caseMachine.next(status, 'customerReplied') as CaseStatus;
        facts.infoRequest = null;
        if (a.c.handler_kind === 'seller') {
          status = caseMachine.next(status, 'sendToSeller') as CaseStatus;
          Object.assign(patch, { next_response_due_at: sellerDue, waiting_on: 'seller' });
        } else Object.assign(patch, { next_response_due_at: staffDue, waiting_on: 'marketplace' });
        patch.status = status;
      } else if (a.c.handler_kind !== 'seller' && ['open', 'reopened', 'escalated'].includes(status) && !a.c.next_response_due_at) {
        patch.next_response_due_at = staffDue;
      }
      const m = await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: a.c.next_action.facts?.customerName ?? 'Customer', role: 'customer', audience: 'all', body: body.body.trim(), mediaIds });
      if (mediaIds.length) await tx.insert('case_evidence', { id: newId(), case_id: a.c.id, party: 'customer', kind: 'photo', media_ids: mediaIds, note: null, added_by: actorText(by.actor), at: this.core.now() });
      if (patch.status && patch.status !== a.c.status) await this.core.timeline(tx, a.c.id, [{ kind: 'customer_replied', label: 'Customer replied', visibility: 'all', actor: by.actor }]);
      await this.core.save(tx, a, patch, facts);
      batch.push('support.case.message_added', { caseId: a.c.id, messageId: m.id, audience: 'all', authorRole: 'customer' });
    });
  }

  validateOffer(offer: CaseOfferInput, agg: Agg) {
    if ((offer.kind === 'refund' || offer.kind === 'partial_refund') && agg.c.order_id === null) throw invalidField('offer.kind', 'A refund offer needs an order');
    if (offer.kind === 'partial_refund' && !(offer.amount && offer.amount.amount > 0)) throw invalidField('offer.amount', 'Enter the amount you offer');
    if (offer.amount && offer.amount.amount < 0) throw invalidField('offer.amount', 'The amount cannot be negative');
    const paid = agg.items.reduce((s, i) => s + (i.snapshot.paid?.amount ?? i.snapshot.price.amount * i.snapshot.quantity), 0);
    if (offer.amount && paid && offer.amount.amount > paid) throw invalidField('offer.amount', 'The offer is more than the customer paid for these items');
    if (offer.kind === 'ship_by_date') {
      if (!offer.shipBy) throw invalidField('offer.shipBy', 'Choose the date you will ship by');
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: this.core.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.core.now());
      if (offer.shipBy < today) throw invalidField('offer.shipBy', 'Choose a date from today on');
    }
  }

  async sellerReply(agg: Agg, body: { body: string; mediaIds?: string[] | null; offer?: CaseOfferInput | null }, sellerId: string, by: By): Promise<void> {
    if (!this.core.isOpen(agg.c)) throw illegal('This case is closed', { from: agg.c.status, event: 'sellerReplied' });
    if (!body.body?.trim()) throw invalidField('body', 'Write a message');
    await this.core.checkAttachments(body.mediaIds);
    if (body.offer) {
      if (agg.c.kind === 'seller_request') throw invalidField('offer', 'Offers are made to customers');
      this.validateOffer(body.offer, agg);
    }
    const mediaIds = body.mediaIds ?? [];
    await this.core.attach(mediaIds, agg.c.id, `Case ${agg.c.ref}`, { kind: 'seller', id: sellerId });
    const cat = (await this.core.category(agg.c.category_key))!;
    const [respondBy, staffDue] = await Promise.all([this.core.addBusinessDays(this.core.now(), await this.core.setting('sellerReplyBusinessDays', 2)), this.marketplaceDue(cat, agg.c.priority, false)]);
    await this.core.write(agg.c.id, by, async (tx, a, batch) => {
      if (!this.core.isOpen(a.c)) throw illegal('This case is closed', { from: a.c.status });
      const now = this.core.now();
      const patch: Partial<CaseRec> = {};
      const facts: Partial<CaseFacts> = {};
      if (a.c.status === 'waiting_on_seller') {
        patch.status = caseMachine.next('waiting_on_seller', 'sellerReplied');
        Object.assign(patch, a.c.handler_kind === 'seller' ? { next_response_due_at: null, waiting_on: 'customer' } : { next_response_due_at: staffDue, waiting_on: 'marketplace' });
        if (a.c.next_action.facts?.infoRequest?.from === 'seller') facts.infoRequest = null;
      } else if (a.c.kind === 'seller_request' && a.c.handler_kind !== 'seller' && !a.c.next_response_due_at) patch.next_response_due_at = staffDue;
      if (a.c.kind !== 'seller_request') {
        facts.sellerRepliedAt = a.c.next_action.facts?.sellerRepliedAt ?? now.toISOString();
        if (a.c.handler_kind === 'seller' && !a.c.first_replied_at) patch.first_replied_at = now;
      }
      const label = `${a.c.next_action.facts?.sellerName ?? 'Seller'} (seller)`;
      const m = await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: label, role: 'seller', audience: 'all', body: body.body.trim(), mediaIds });
      if (mediaIds.length) a.evidence.push(await tx.insert('case_evidence', { id: newId(), case_id: a.c.id, party: 'seller', kind: 'photo', media_ids: mediaIds, note: null, added_by: actorText(by.actor), at: now }));
      if (body.offer) {
        for (const o of a.offers.filter((x) => x.status === 'open' && x.from_party === 'seller')) {
          o.status = caseOfferMachine.next('open', 'withdraw');
          await tx.update('case_offers', o.id, { status: o.status, responded_at: now });
        }
        a.offers.push(
          await tx.insert('case_offers', {
            id: newId(),
            case_id: a.c.id,
            from_party: 'seller',
            kind: body.offer.kind,
            amount: body.offer.amount?.amount ?? null,
            currency: body.offer.amount ? body.offer.amount.currency || this.core.currency : null,
            ship_by: body.offer.shipBy ?? null,
            note: body.offer.note?.trim() || null,
            status: 'open',
            respond_by: respondBy,
            created_at: now,
            responded_at: null,
          }),
        );
        await this.core.timeline(tx, a.c.id, [{ kind: 'offer_made', label: `${a.c.next_action.facts?.sellerName ?? 'The seller'} made an offer`, detail: body.offer.kind.replace(/_/g, ' '), visibility: 'all', actor: by.actor }]);
      }
      await this.core.save(tx, a, patch, facts);
      batch.push('support.case.message_added', { caseId: a.c.id, messageId: m.id, audience: 'all', authorRole: 'seller' });
    });
  }

  async staffMessage(agg: Agg, body: { body: string; audience: 'all' | 'customer' | 'seller' | 'internal'; mediaIds?: string[] | null; nextResponseDueAt?: string | null }, by: By): Promise<void> {
    if (!body.body?.trim()) throw invalidField('body', 'Write a message');
    if (body.audience === 'seller' && !agg.c.seller_id) throw invalidField('audience', 'This case has no seller');
    if (body.audience === 'customer' && agg.c.kind === 'seller_request') throw invalidField('audience', 'This case has no customer');
    if (body.nextResponseDueAt && new Date(body.nextResponseDueAt).getTime() <= this.core.now().getTime()) throw invalidField('nextResponseDueAt', 'Choose a time in the future');
    await this.core.checkAttachments(body.mediaIds);
    const mediaIds = body.mediaIds ?? [];
    await this.core.attach(mediaIds, agg.c.id, `Case ${agg.c.ref}`, { kind: 'staff', id: by.actor.id ?? null });
    const cat = (await this.core.category(agg.c.category_key))!;
    const staffDue = body.nextResponseDueAt ? new Date(body.nextResponseDueAt) : await this.marketplaceDue(cat, agg.c.priority, false);
    const name = by.actor.name ?? (by.actor.id ? (await this.core.staffNames([by.actor.id])).get(by.actor.id) : undefined);
    const internal = body.audience === 'internal';
    await this.core.write(agg.c.id, by, async (tx, a, batch) => {
      const now = this.core.now();
      const patch: Partial<CaseRec> = {};
      if (!internal) {
        if (!a.c.first_replied_at) patch.first_replied_at = now;
        if (this.core.isOpen(a.c) && a.c.handler_kind !== 'seller' && ['open', 'reopened', 'escalated', 'appealed'].includes(a.c.status)) patch.next_response_due_at = staffDue;
        else if (body.nextResponseDueAt && this.core.isOpen(a.c)) patch.next_response_due_at = staffDue;
      }
      const m = await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: internal ? `${name ?? 'Staff'} (internal note)` : `${name ?? 'Marketly'}, ${SUPPORT_NAME}`, role: internal ? 'internal_note' : 'marketly_staff', audience: body.audience, body: body.body.trim(), mediaIds });
      if (mediaIds.length && !internal) await tx.insert('case_evidence', { id: newId(), case_id: a.c.id, party: 'staff', kind: 'photo', media_ids: mediaIds, note: null, added_by: actorText(by.actor), at: now });
      await this.core.save(tx, a, patch);
      if (!internal) batch.push('support.case.message_added', { caseId: a.c.id, messageId: m.id, audience: body.audience, authorRole: 'marketly_staff' });
    });
  }

  /* ================================================================ offers */

  async respondToOffer(agg: Agg, offerId: string, body: { accept: boolean; note?: string | null }, by: By, remedies: { fromOffer: (agg: Agg, offer: Agg['offers'][number], by: By) => Promise<Omit<RemedyRec, 'id' | 'case_id'> | null> }): Promise<void> {
    const offer = agg.offers.find((o) => o.id === offerId);
    if (!offer) throw notFound('Offer');
    const now = this.core.now();
    if (offer.status === 'expired' || offer.status === 'withdrawn' || (offer.status === 'open' && offer.respond_by && offer.respond_by.getTime() <= now.getTime())) throw this.core.error('OFFER_EXPIRED', 'This offer expired or was withdrawn', { offerId, status: offer.status === 'open' ? 'expired' : offer.status });
    caseOfferMachine.next(offer.status as never, body.accept ? 'accept' : 'decline');
    if (!this.core.isOpen(agg.c)) throw illegal('This case is closed', { from: agg.c.status });
    const remedy = body.accept ? await remedies.fromOffer(agg, offer, by) : null;
    await this.core.write(agg.c.id, by, async (tx, a, batch) => {
      const o = a.offers.find((x) => x.id === offerId)!;
      if (o.status !== 'open') throw illegal('The offer was already answered', { from: o.status });
      o.status = caseOfferMachine.next('open', body.accept ? 'accept' : 'decline');
      await tx.update('case_offers', o.id, { status: o.status, responded_at: now });
      const patch: Partial<CaseRec> = {};
      if (remedy) {
        const row = await tx.insert('case_remedies', { id: newId(), case_id: a.c.id, ...remedy });
        a.remedies.push(row);
        if (row.kind === 'ship_by_deadline' && caseMachine.can(a.c.status as CaseStatus, 'sendToSeller')) Object.assign(patch, { status: caseMachine.next(a.c.status as CaseStatus, 'sendToSeller'), next_response_due_at: row.due_at, waiting_on: 'seller' });
      }
      if (body.note?.trim()) {
        const m = await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: a.c.next_action.facts?.customerName ?? 'Customer', role: 'customer', audience: 'all', body: body.note.trim() });
        batch.push('support.case.message_added', { caseId: a.c.id, messageId: m.id, audience: 'all', authorRole: 'customer' });
      }
      await this.core.timeline(tx, a.c.id, [{ kind: body.accept ? 'offer_accepted' : 'offer_declined', label: body.accept ? 'The customer accepted the offer' : 'The customer declined the offer', detail: o.kind.replace(/_/g, ' '), visibility: 'all', actor: by.actor }]);
      await this.core.save(tx, a, patch);
    });
  }

  /* ================================================================ evidence */

  async addEvidence(agg: Agg, input: EvidenceInput, party: 'seller' | 'staff', by: By): Promise<Evidence> {
    if (party === 'seller' && !this.core.isOpen(agg.c)) throw illegal('Evidence can be added while the case is open', { from: agg.c.status, event: 'addEvidence' });
    if (!input.mediaIds?.length) throw invalidField('mediaIds', 'Add at least one file');
    await this.core.checkAttachments(input.mediaIds);
    await this.core.attach(input.mediaIds, agg.c.id, `Case ${agg.c.ref}`, party === 'seller' ? { kind: 'seller', id: agg.c.seller_id } : { kind: 'staff', id: by.actor.id ?? null });
    const row = await this.core.write(agg.c.id, by, async (tx, a) => {
      const e = await tx.insert('case_evidence', { id: newId(), case_id: a.c.id, party, kind: input.kind, media_ids: [...new Set(input.mediaIds)], note: input.note?.trim() || null, added_by: actorText(by.actor), at: this.core.now() });
      await this.core.timeline(tx, a.c.id, [{ kind: 'evidence_added', label: party === 'seller' ? 'The seller added evidence' : 'Marketly added evidence', detail: `${input.kind} · ${input.mediaIds.length} file${input.mediaIds.length === 1 ? '' : 's'}`, visibility: party === 'seller' ? 'seller' : 'staff', actor: by.actor }]);
      await this.core.save(tx, a, {});
      return e;
    });
    if (party === 'staff') await this.core.audit({ action: 'support.case.evidence', actionLabel: 'Added case evidence', target: this.target(agg), after: { kind: input.kind, mediaIds: input.mediaIds, note: input.note ?? null } }, by);
    const x = await this.views.prepare([{ ...agg, evidence: [row] }], { orders: false });
    return this.views.evidence(row, x, 'admin');
  }

  target(agg: Agg) {
    return { type: 'case', id: agg.c.id, ref: agg.c.ref, label: `Case ${agg.c.ref}: ${agg.c.subject}`, screen: 'admin/case', ...(agg.c.seller_id ? { sellerId: agg.c.seller_id } : {}) };
  }

  /* ================================================================ escalation */

  /** Marketly steps in: the case becomes a dispute handled by Marketly support (customer, staff, jobs) */
  async escalate(agg: Agg, o: { reason: string; to: string; note?: string | null; convertToDispute?: boolean; team?: Team | null; label: string; customerVisible?: string }, by: By): Promise<void> {
    const sameState = agg.c.status === 'escalated';
    if (!sameState) caseMachine.next(agg.c.status as CaseStatus, 'escalate');
    const team = (o.team ?? agg.c.team) as Team;
    const [disputeDays, cat] = await Promise.all([this.core.setting('disputeDecisionBusinessDays', 5), this.core.category(agg.c.category_key)]);
    const teamChanged = team !== agg.c.team;
    const ownerId = o.to === 'support_lead' ? ((await this.core.quiet('lead', () => this.core.ctx.use('access').resolveRecipients('customer_support_manager')))?.leadAccountId ?? agg.c.owner_staff_id) : teamChanged || !agg.c.owner_staff_id ? ((await this.pickOwner(team)) ?? agg.c.owner_staff_id) : agg.c.owner_staff_id;
    const staffDue = await this.marketplaceDue(cat!, agg.c.priority, !agg.c.first_replied_at);
    const decisionDue = await this.core.addBusinessDays(this.core.now(), disputeDays);
    await this.core.write(agg.c.id, by, async (tx, a, batch) => {
      const now = this.core.now();
      const already = a.c.status === 'escalated';
      const status = already ? a.c.status : caseMachine.next(a.c.status as CaseStatus, 'escalate');
      const dispute = o.convertToDispute || (a.c.kind === 'order_problem' && !already && o.convertToDispute !== false);
      await this.core.save(
        tx,
        a,
        {
          status,
          kind: dispute ? 'dispute' : a.c.kind,
          handler_kind: 'marketplace_support',
          support_following: true,
          team,
          owner_staff_id: ownerId,
          next_response_due_at: staffDue,
          resolution_due_at: dispute ? decisionDue : (a.c.resolution_due_at ?? decisionDue),
          waiting_on: 'marketplace',
        },
        { escalation: { at: now.toISOString(), by: by.actor, reason: o.reason, to: o.to, note: o.note ?? null }, infoRequest: null },
      );
      await this.core.timeline(tx, a.c.id, [
        { kind: 'escalated', label: o.label, detail: o.note ?? null, visibility: o.customerVisible === 'staff' ? 'staff' : 'all', actor: by.actor, reason: o.reason },
        ...(ownerId && ownerId !== agg.c.owner_staff_id ? [{ kind: 'assigned', label: 'Owner assigned', detail: ownerId, visibility: 'staff' as const }] : []),
      ]);
      batch.push('support.case.escalated', { caseId: a.c.id, ref: a.c.ref, to: o.to, reason: o.note?.trim() ? `${o.reason}: ${o.note.trim()}` : o.reason, sellerId: a.c.seller_id, orderId: a.c.order_id });
      if (ownerId && ownerId !== agg.c.owner_staff_id) batch.push('support.case.assigned', { caseId: a.c.id, ownerId, team });
    });
  }

  async customerEscalate(agg: Agg, body: { reason: 'seller_no_reply' | 'disagree_with_seller' | 'refund_late' | 'other'; note?: string | null }, by: By): Promise<void> {
    const c = agg.c;
    if (!this.core.isOpen(c)) throw illegal('This case is closed', { from: c.status, event: 'escalate' });
    if (c.handler_kind === 'marketplace_support' || c.status === 'escalated') throw illegal('Marketly support is already handling this case', { from: c.status, event: 'escalate' });
    caseMachine.next(c.status as CaseStatus, 'escalate');
    if (c.handler_kind === 'seller') {
      const now = this.core.now();
      const f = c.next_action.facts ?? {};
      const deadlinePassed = c.status !== 'waiting_on_seller' || (c.next_response_due_at !== null && c.next_response_due_at.getTime() <= now.getTime());
      const unresolvedRefund = agg.remedies.some((r) => ['refund', 'partial_refund', 'replacement', 'ship_by_deadline'].includes(r.kind) && (UNRESOLVED_REMEDY as readonly string[]).includes(r.status));
      const sellerAnswered = !!f.sellerRepliedAt || agg.offers.length > 0;
      const ok =
        !!f.dispatchOverdue ||
        (body.reason === 'refund_late' ? unresolvedRefund : body.reason === 'disagree_with_seller' ? sellerAnswered || deadlinePassed : deadlinePassed || (body.reason === 'other' && sellerAnswered));
      if (!ok) throw this.core.error('ESCALATION_NOT_AVAILABLE', body.reason === 'refund_late' ? 'There is no promised refund on this case yet' : `${f.sellerName ?? 'The seller'} can still reply. You can ask Marketly to step in once the deadline passes.`, { availableFrom: c.status === 'waiting_on_seller' ? (c.next_response_due_at?.toISOString() ?? null) : null });
    }
    await this.escalate(agg, { reason: body.reason, to: 'customer_support', note: body.note?.trim() || null, label: 'You asked Marketly to step in', convertToDispute: c.kind === 'order_problem' }, by);
    if (body.note?.trim()) {
      await this.core.write(agg.c.id, by, async (tx, a, batch) => {
        const m = await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: a.c.next_action.facts?.customerName ?? 'Customer', role: 'customer', audience: 'all', body: body.note!.trim() });
        batch.push('support.case.message_added', { caseId: a.c.id, messageId: m.id, audience: 'all', authorRole: 'customer' });
      });
    }
  }

  async staffEscalate(agg: Agg, body: { to: 'returns' | 'finance' | 'trust' | 'seller_management' | 'support_lead'; reason: string; convertToDispute?: boolean | null }, by: By): Promise<void> {
    if (!body.reason?.trim()) throw invalidField('reason', 'Say why the case is escalated');
    const team: Team = body.to === 'support_lead' ? (agg.c.team as Team) : body.to;
    await this.escalate(agg, { reason: body.reason.trim(), to: body.to, label: `Escalated to ${TEAM_LABEL[body.to] ?? body.to}`, convertToDispute: body.convertToDispute ?? false, team, note: null, customerVisible: 'staff' }, by);
    await this.core.write(agg.c.id, by, async (tx, a) => {
      await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: 'Escalation (internal note)', role: 'internal_note', audience: 'internal', body: `Escalated to ${TEAM_LABEL[body.to] ?? body.to}: ${body.reason.trim()}` });
    });
    await this.core.audit({ action: 'support.case.escalate', actionLabel: `Escalated a case to ${TEAM_LABEL[body.to] ?? body.to}`, target: this.target(agg), reason: body.reason, before: { status: agg.c.status, team: agg.c.team, kind: agg.c.kind }, after: { to: body.to, convertToDispute: body.convertToDispute ?? false } }, by);
  }

  /* ================================================================ information requests */

  async requestInfo(agg: Agg, body: { from: 'customer' | 'seller'; question: string; dueAt: string }, by: By): Promise<void> {
    if (!body.question?.trim()) throw invalidField('question', 'Write the question');
    const due = new Date(body.dueAt);
    if (Number.isNaN(due.getTime()) || due.getTime() <= this.core.now().getTime()) throw invalidField('dueAt', 'Choose a deadline in the future');
    if (body.from === 'seller' && !agg.c.seller_id) throw invalidField('from', 'This case has no seller');
    if (body.from === 'customer' && agg.c.kind === 'seller_request') throw invalidField('from', 'This case has no customer');
    caseMachine.next(agg.c.status as CaseStatus, body.from === 'customer' ? 'requestInfo' : 'sendToSeller');
    const name = by.actor.name ?? (by.actor.id ? (await this.core.staffNames([by.actor.id])).get(by.actor.id) : undefined);
    await this.core.write(agg.c.id, by, async (tx, a, batch) => {
      const status = caseMachine.next(a.c.status as CaseStatus, body.from === 'customer' ? 'requestInfo' : 'sendToSeller');
      const m = await this.core.message(tx, a.c.id, { author: by.actor, authorLabel: `${name ?? 'Marketly'}, ${SUPPORT_NAME}`, role: 'marketly_staff', audience: body.from, body: body.question.trim() });
      await this.core.timeline(tx, a.c.id, [{ kind: 'info_requested', label: body.from === 'customer' ? 'Marketly asked the customer for information' : 'Marketly asked the seller for information', detail: `Reply by ${due.toISOString()}`, visibility: body.from, actor: by.actor }]);
      await this.core.save(tx, a, { status, next_response_due_at: due, waiting_on: body.from, ...(a.c.first_replied_at ? {} : { first_replied_at: this.core.now() }) }, { infoRequest: { from: body.from, question: body.question.trim(), dueAt: due.toISOString(), askedAt: this.core.now().toISOString(), askedBy: by.actor } });
      batch.push('support.case.message_added', { caseId: a.c.id, messageId: m.id, audience: body.from, authorRole: 'marketly_staff' });
    });
    await this.core.audit({ action: 'support.case.request_info', actionLabel: `Asked the ${body.from} for information`, target: this.target(agg), after: { from: body.from, question: body.question, dueAt: due.toISOString() } }, by);
  }

  /* ================================================================ assignment, priority, category */

  async assign(caseId: string, ownerId: string, o: { reason?: string | null; priority?: Priority | null; ownerName?: string }, by: By): Promise<Agg> {
    const ownerName = o.ownerName ?? (await this.checkOwner(ownerId));
    const before = await this.core.load(caseId);
    if (!before) throw notFound();
    const cat = (await this.core.category(before.c.category_key))!;
    const due = o.priority && o.priority !== before.c.priority ? await this.recalculatedDue(before, cat, o.priority) : undefined;
    await this.core.write(caseId, by, async (tx, a, batch) => {
      const changed = a.c.owner_staff_id !== ownerId;
      await this.core.save(tx, a, { owner_staff_id: ownerId, ...(o.priority ? { priority: o.priority } : {}), ...(due !== undefined ? { next_response_due_at: due } : {}) });
      await this.core.timeline(tx, a.c.id, [
        ...(changed ? [{ kind: 'assigned', label: `Assigned to ${ownerName}`, detail: o.reason ?? null, visibility: 'staff' as const, actor: by.actor, reason: o.reason ?? null }] : []),
        ...(o.priority && o.priority !== before.c.priority ? [{ kind: 'priority', label: `Priority ${before.c.priority} → ${o.priority}`, visibility: 'staff' as const, actor: by.actor }] : []),
      ]);
      if (changed) batch.push('support.case.assigned', { caseId: a.c.id, ownerId, team: a.c.team });
    });
    await this.core.audit({ action: 'support.case.assign', actionLabel: `Assigned case to ${ownerName}`, target: this.target(before), reason: o.reason ?? null, before: { ownerId: before.c.owner_staff_id, priority: before.c.priority }, after: { ownerId, priority: o.priority ?? before.c.priority } }, by);
    return (await this.core.load(caseId))!;
  }

  async bulkAssign(body: { caseIds: string[]; ownerId: string; priority?: Priority | null }, by: By): Promise<{ assigned: number; failed: string[] }> {
    const ownerName = await this.checkOwner(body.ownerId);
    const failed: string[] = [];
    let assigned = 0;
    for (const id of [...new Set(body.caseIds)]) {
      try {
        const agg = isUuid(id) ? await this.core.load(id) : undefined;
        if (!agg || !this.core.isOpen(agg.c)) throw notFound();
        await this.assign(id, body.ownerId, { priority: body.priority ?? null, ownerName, reason: 'Bulk assignment' }, by);
        assigned++;
      } catch {
        failed.push(id);
      }
    }
    return { assigned, failed };
  }

  /** The response deadline of a case Marketly must answer, recalculated for a priority */
  private async recalculatedDue(agg: Agg, cat: CategoryRec, priority: string): Promise<Date | null | undefined> {
    if (!this.core.isOpen(agg.c) || agg.c.handler_kind === 'seller' || !['open', 'reopened', 'escalated', 'appealed'].includes(agg.c.status)) return undefined;
    const lastParty = [...agg.messages].reverse().find((m) => m.role === 'customer' || m.role === 'seller');
    const from = lastParty && lastParty.at > agg.c.opened_at ? lastParty.at : agg.c.opened_at;
    return this.marketplaceDue(cat, priority, !agg.c.first_replied_at, from);
  }

  async setPriority(caseId: string, priority: Priority, reason: string, by: By, o: { category?: string | null } = {}): Promise<Agg> {
    const before = await this.core.load(caseId);
    if (!before) throw notFound();
    const catKey = o.category ?? before.c.category_key;
    const cat = await this.core.category(catKey);
    if (!cat) throw invalidField('category', 'Choose a case category');
    if ((cat.audience === 'seller') !== (before.c.kind === 'seller_request')) throw invalidField('category', before.c.kind === 'seller_request' ? 'Choose a seller support topic' : 'Choose a customer topic');
    const due = priority !== before.c.priority || catKey !== before.c.category_key ? await this.recalculatedDue(before, cat, priority) : undefined;
    await this.core.write(caseId, by, async (tx, a) => {
      await this.core.save(tx, a, { priority, category_key: catKey, ...(due !== undefined ? { next_response_due_at: due } : {}) });
      await this.core.timeline(tx, a.c.id, [
        ...(priority !== before.c.priority ? [{ kind: 'priority', label: `Priority ${before.c.priority} → ${priority}`, detail: reason, visibility: 'staff' as const, actor: by.actor, reason }] : []),
        ...(catKey !== before.c.category_key ? [{ kind: 'category', label: `Category ${before.c.category_key} → ${catKey}`, detail: reason, visibility: 'staff' as const, actor: by.actor, reason }] : []),
      ]);
    });
    await this.core.audit({ action: 'support.case.update', actionLabel: 'Changed case category or priority', target: this.target(before), reason, before: { priority: before.c.priority, category: before.c.category_key }, after: { priority, category: catKey } }, by);
    return (await this.core.load(caseId))!;
  }

  async updateCase(agg: Agg, body: { category?: string | null; priority?: Priority | null; reason: string }, by: By): Promise<Agg> {
    if (!body.reason?.trim()) throw invalidField('reason', 'Give a reason');
    if (!body.category && !body.priority) throw invalidField('priority', 'Change the category or the priority');
    if (body.priority && !(PRIORITIES as readonly string[]).includes(body.priority)) throw invalidField('priority', 'Choose a priority');
    return this.setPriority(agg.c.id, body.priority ?? (agg.c.priority as Priority), body.reason.trim(), by, { category: body.category ?? null });
  }

  async bulkSetPriority(body: { caseIds: string[]; priority: Priority; reason: string }, by: By): Promise<{ updated: number; failed: string[] }> {
    if (!body.reason?.trim()) throw invalidField('reason', 'Give a reason');
    const failed: string[] = [];
    let updated = 0;
    for (const id of [...new Set(body.caseIds)]) {
      try {
        const agg = isUuid(id) ? await this.core.load(id) : undefined;
        if (!agg || (CLOSED_STATUSES as readonly string[]).includes(agg.c.status)) throw notFound();
        await this.setPriority(id, body.priority, body.reason.trim(), by);
        updated++;
      } catch {
        failed.push(id);
      }
    }
    return { updated, failed };
  }

  async updateCategory(key: string, body: CaseCategoryInput, by: By): Promise<CaseCategory> {
    if (!/^[a-z][a-z0-9_]{1,47}$/.test(key)) throw invalidField('key', 'Use lowercase letters, digits and underscores');
    const issues: { path: string; message: string }[] = [];
    if (!body.label?.trim()) issues.push({ path: 'label', message: 'Add a label' });
    if (!body.reason?.trim()) issues.push({ path: 'reason', message: 'Give a reason' });
    for (const k of ['firstResponseBusinessHours', 'nextResponseBusinessHours', 'resolutionBusinessDays'] as const) if (!Number.isInteger(body[k]) || body[k] < 1 || body[k] > 1000) issues.push({ path: k, message: 'Use a whole number from 1' });
    if (issues.length) throw invalid(issues);
    const before = await this.core.category(key);
    const row = await this.core.repo.upsertCategory({
      key,
      label: body.label.trim(),
      audience: before?.audience ?? (body.team === 'seller_management' ? 'seller' : 'customer'),
      group_key: before?.group_key ?? 'other',
      default_priority: body.defaultPriority,
      team: body.team,
      seller_handles_first: body.sellerHandlesFirst,
      first_response_business_hours: body.firstResponseBusinessHours,
      next_response_business_hours: body.nextResponseBusinessHours,
      resolution_business_days: body.resolutionBusinessDays,
      active: body.active,
      updated_by: actorText(by.actor),
      updated_at: this.core.now(),
    });
    this.core.invalidateCategories();
    await this.core.audit(
      {
        action: before ? 'support.category.update' : 'support.category.create',
        actionLabel: before ? `Changed case category ${row.label}` : `Created case category ${row.label}`,
        category: 'settings',
        target: { type: 'case_category', id: key, label: row.label, screen: 'admin/settings' },
        reason: body.reason,
        before: before ? this.core.categoryView(before) : null,
        after: this.core.categoryView(row),
      },
      by,
    );
    return this.core.categoryView(row);
  }

  /* ================================================================ helpers for offers turned into remedies */

  /** End of the ship-by date in the market time zone */
  shipByEnd(date: string): Date {
    return zonedTimeToUtc(date, '23:59', this.core.tz);
  }
}
