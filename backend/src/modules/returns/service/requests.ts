/**
 * The customer's return journey: returnable items, eligibility with a refund estimate, the request (one
 * return per seller), and what the customer does afterwards: answer a question, withdraw, get or email
 * the label, add tracking, ask Marketly to step in.
 */
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import { newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import type { OrderDetail, OrderItem, SellerGroup } from '../../../spec/orders.js';
import type {
  EffectiveTerms,
  EligibilityGroup,
  EligibilityRequest,
  EligibilityResult,
  ItemEligibility,
  RemedyOption,
  ReturnableItem,
  ReturnCreateInput,
  ReturnDestination,
  ReturnShipment,
} from '../../../spec/returns.js';
import { returnMachine, returnShipmentMachine } from '../domain/state-machines.js';
import {
  ACTIVE_STATUSES,
  addBusinessDays,
  computeBreakdown,
  is,
  itemVerdict,
  reasonGroupOf,
  reasonVerdict,
  type ItemVerdict,
  type ReturnStatus,
} from '../domain/rules.js';
import type { ItemRec, ReturnMeta, ReturnRec } from '../ports.js';
import { illegal, invalid, invalidField, notFound, SYSTEM, unavailable, type Agg, type By, type Core } from './core.js';
import type { Decisions } from './decisions.js';
import type { Handling } from './handling.js';
import type { Policies } from './policies.js';
import type { Views } from './views.js';

/** The order group's fulfilment, copied to the return (official_warehouse for Official Store groups) */
function fulfilledByOf(group: SellerGroup): ReturnRec['fulfilled_by'] {
  if (group.seller.ownerType === 'official') return 'official_warehouse';
  return group.fulfilledBy === 'marketly_service' ? 'marketly_service' : 'seller';
}

/** A seller's group Marketly fulfils: Marketly handles its returns (decision D7) */
const isServiceGroup = (group: SellerGroup) => fulfilledByOf(group) === 'marketly_service';

export interface Shopper {
  customerId?: string | null;
  guestSessionId?: string | null;
  /** Signed-in account (notifications) */
  accountId?: string | null;
}

interface ItemCtx {
  item: OrderItem;
  group: SellerGroup;
  verdict: ItemVerdict;
  openReturn: { id: string; ref: string } | null;
}

interface GroupPlan {
  group: SellerGroup;
  sellerId: string | null;
  sellerName: string;
  terms: EffectiveTerms;
  destination: ReturnDestination;
  payer: { paidBy: 'seller' | 'customer' | 'platform'; customerFee: number; originalShippingRefunded: boolean };
  lines: { ctx: ItemCtx; quantity: number; ok: boolean; reason: string | null; message: string }[];
  remedies: RemedyOption[];
  eligibility: EligibilityGroup;
}

export class Requests {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly policies: Policies,
    private readonly decisions: Decisions,
    private readonly handling: Handling,
  ) {}

  /* ---------------------------------------------------------------- the order */

  /** The order a shopper may return from, or NOT_FOUND */
  async orderFor(orderId: string, who: Shopper): Promise<OrderDetail> {
    const order = await this.core.ctx.use('orders').getOrder(orderId);
    if (!order) throw notFound('Order');
    if (who.customerId && order.contact.customerId === who.customerId) return order;
    if (who.guestSessionId && (await this.core.soft('identity', 'guest order access', (i) => i.hasGuestOrderAccess(who.guestSessionId!, order.id)))) return order;
    throw notFound('Order');
  }

  /** Every item of the order with its verdict now */
  async itemsOf(order: OrderDetail): Promise<ItemCtx[]> {
    const items = order.groups.flatMap((g) => g.items.map((item) => ({ item, group: g })));
    const ids = items.map((x) => x.item.id);
    const placed = new Date(order.placedAt);
    const categories = [...new Set(items.map((x) => x.item.categoryId).filter((c): c is string => !!c))];
    const [used, rows, baseline, exceptions] = await Promise.all([
      this.core.repo.usedQuantities(ids),
      this.core.repo.find('return_items', { order_item_id: ids }),
      this.core.baselineAt(placed),
      Promise.all(categories.map(async (c) => [c, await this.policies.activeException(c, placed)] as const)).then((x) => new Map(x)),
    ]);
    const open = rows.length ? await this.core.repo.find('returns', { id: [...new Set(rows.map((r) => r.return_id))], status: [...ACTIVE_STATUSES, 'rejected'] }, { orderBy: [['requested_at', 'desc']] }) : [];
    const now = this.core.now();
    return items.map(({ item, group }) => {
      const mine = open.filter((o) => rows.some((r) => r.return_id === o.id && r.order_item_id === item.id));
      const ret = mine.find((o) => o.status !== 'rejected') ?? mine[0];
      const openReturn = ret ? { id: ret.id, ref: ret.ref, rejected: ret.status === 'rejected' } : null;
      const verdict = itemVerdict(
        {
          orderItemId: item.id,
          state: item.state,
          quantity: item.quantity,
          deliveredAt: item.deliveredAt ?? null,
          returnWindowEndsAt: item.returnWindowEndsAt ?? null,
          windowDays: item.returnTerms.windowDays,
          used: used.get(item.id) ?? 0,
          openReturn,
        },
        now,
        // damaged, defective or wrong items: the category exception's fault window when the item's category has one
        (item.categoryId ? exceptions.get(item.categoryId)?.fault_returns_window_days : null) ?? baseline.windowDays,
        this.core.tz,
      );
      return { item, group, verdict, openReturn };
    });
  }

  itemView(c: ItemCtx) {
    const i = c.item;
    return {
      orderItemId: i.id,
      productId: i.product.productId,
      variantId: i.product.variantId,
      title: i.title,
      options: i.product.options ?? {},
      sku: i.offer.sellerSku ?? null,
      imageUrl: i.image?.url ?? i.product.imageUrl ?? null,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
    };
  }

  async returnableItems(orderId: string, who: Shopper): Promise<{ orderId: string; orderRef: string; placedAt: string; items: ReturnableItem[] }> {
    const order = await this.orderFor(orderId, who);
    const items = await this.itemsOf(order);
    return {
      orderId: order.id,
      orderRef: order.ref,
      placedAt: order.placedAt,
      items: items.map((c) => ({
        item: this.itemView(c),
        ownerType: c.group.seller.ownerType,
        sellerId: c.group.seller.ownerType === 'seller' ? (c.group.seller.id ?? null) : null,
        sellerName: c.group.seller.name,
        quantityPurchased: c.item.quantity,
        quantityReturnable: c.verdict.quantityReturnable,
        itemState: c.item.stateLabel,
        deliveredAt: c.item.deliveredAt ?? null,
        returnBy: c.verdict.returnBy?.toISOString() ?? null,
        eligible: c.verdict.eligible,
        ineligibleReason: c.verdict.reason,
        message: c.verdict.message,
        openReturnId: c.openReturn?.id ?? null,
        openReturnRef: c.openReturn?.ref ?? null,
      })),
    };
  }

  /** Public eligibility per order item, batched (only items of orders returns can read) */
  async eligibilityFor(orderItems: { orderId: string; itemIds: string[] }[]) {
    const out = new Map<string, ItemCtx>();
    for (const o of orderItems) {
      const order = await this.core.ctx.use('orders').getOrder(o.orderId);
      if (!order) continue;
      for (const c of await this.itemsOf(order)) if (o.itemIds.includes(c.item.id)) out.set(c.item.id, c);
    }
    return out;
  }

  /* ---------------------------------------------------------------- eligibility */

  /** Official Store and Fulfilled by Marketly returns go to the Marketly returns dock; seller returns to the seller's return address */
  private async destination(sellerId: string | null, sellerName: string, service: boolean): Promise<ReturnDestination> {
    if (!sellerId || service) {
      const address = await this.core.officialReturnAddress();
      return { kind: 'marketly_warehouse', name: address.name, address };
    }
    const terms = await this.core.sellerTerms(sellerId);
    return { kind: 'seller_address', name: sellerName, address: terms?.return_address ?? { name: sellerName, line1: 'Return address on file with the seller', city: '', region: '', postalCode: '', country: 'US' } };
  }

  /** The terms a group's items were bought with: the baseline and seller terms at purchase, the items' frozen window */
  async termsAtPurchase(order: OrderDetail, group: SellerGroup, items: OrderItem[]): Promise<EffectiveTerms> {
    const placed = new Date(order.placedAt);
    const sellerId = group.seller.ownerType === 'seller' ? (group.seller.id ?? null) : null;
    const baseline = await this.core.baselineAt(placed);
    // the category of the item with the shortest window decides the group's category exception
    const strictest = [...items].sort((a, b) => a.returnTerms.windowDays - b.returnTerms.windowDays)[0];
    const categoryId = strictest?.categoryId ?? null;
    const terms = await this.policies.resolveTerms(sellerId, categoryId, null, { baseline, at: placed, terms: sellerId ? await this.core.sellerTerms(sellerId, placed) : null });
    const windows = items.map((i) => i.returnTerms.windowDays);
    const windowDays = windows.length ? Math.min(...windows) : terms.windowDays;
    const changeOfMindAllowed = windowDays > 0;
    return {
      ...terms,
      windowDays,
      changeOfMindAllowed,
      summary: items[0]?.returnTerms.summary || terms.summary,
      source: terms.source === 'category_exception' || (!categoryId && windowDays < baseline.windowDays) ? 'category_exception' : terms.source,
    };
  }

  private async remedyOptions(terms: EffectiveTerms, lines: { ctx: ItemCtx; quantity: number }[], who: Shopper): Promise<RemedyOption[]> {
    const offered = new Set(terms.remedies);
    let inStock = true;
    if (offered.has('replacement') || offered.has('exchange')) {
      const ids = lines.map((l) => l.ctx.item.stockItemId);
      const avail = await this.core.quiet('availability', () => this.core.ctx.use('inventory').getAvailability(ids));
      inStock = !!avail && lines.every((l) => (avail[l.ctx.item.stockItemId]?.available ?? 0) >= l.quantity);
    }
    const wallet = this.core.walletOn() && !!who.customerId;
    const opt = (kind: RemedyOption['kind'], available: boolean, description: string, unavailableReason: string | null): RemedyOption => ({ kind, available, description, unavailableReason: available ? null : unavailableReason });
    return [
      opt('refund', true, 'Money back to your original payment method', null),
      opt('replacement', offered.has('replacement') && inStock, 'The same item sent again at no charge', offered.has('replacement') ? 'Out of stock' : 'Not offered by this seller'),
      opt('exchange', offered.has('exchange') && inStock, 'Another size or color at the same price', offered.has('exchange') ? 'Out of stock' : 'Not offered by this seller'),
      opt('store_credit', wallet, 'Marketly store credit, usually faster', this.core.walletOn() ? 'Sign in to get store credit' : 'Store credit is not available yet'),
    ];
  }

  private async plan(order: OrderDetail, req: { items: { orderItemId: string; quantity: number }[]; reason?: string | null; remedy?: string | null }, who: Shopper, strictQuantities: boolean): Promise<GroupPlan[]> {
    if (!req.items.length) throw invalidField('items', 'Choose at least one item');
    const all = await this.itemsOf(order);
    const now = this.core.now();
    const issues: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    const picked: { ctx: ItemCtx; quantity: number }[] = [];
    req.items.forEach((l, n) => {
      const ctx = all.find((c) => c.item.id === l.orderItemId);
      if (!ctx) throw notFound('Order item');
      if (seen.has(l.orderItemId)) issues.push({ path: `items.${n}.orderItemId`, message: 'Each item once' });
      seen.add(l.orderItemId);
      if (!Number.isInteger(l.quantity) || l.quantity < 1) issues.push({ path: `items.${n}.quantity`, message: 'At least one unit' });
      picked.push({ ctx, quantity: l.quantity });
    });
    if (issues.length) throw invalid(issues);
    const over = picked.filter((p) => p.ctx.verdict.eligible && p.quantity > p.ctx.verdict.quantityReturnable);
    if (over.length || (strictQuantities && picked.some((p) => p.quantity > p.ctx.item.quantity))) {
      throw this.core.error('QUANTITY_EXCEEDS_RETURNABLE', 'You selected more units than can be returned', {
        items: picked.map((p) => ({ orderItemId: p.ctx.item.id, quantity: p.quantity, quantityReturnable: p.ctx.verdict.quantityReturnable })),
      });
    }
    const fee = await this.core.fee();
    const byGroup = new Map<string, { ctx: ItemCtx; quantity: number }[]>();
    for (const p of picked) byGroup.set(p.ctx.group.id, [...(byGroup.get(p.ctx.group.id) ?? []), p]);
    const paid = await this.views.amounts.paidLines(order.id);
    const out: GroupPlan[] = [];
    for (const lines of byGroup.values()) {
      const group = lines[0]!.ctx.group;
      const sellerId = group.seller.ownerType === 'seller' ? (group.seller.id ?? null) : null;
      const sellerName = group.seller.ownerType === 'official' ? OFFICIAL_STORE_NAME : group.seller.name;
      // Fulfilled by Marketly (D7): the seller's terms and window; Marketly handles the return and receives it
      const service = isServiceGroup(group);
      const terms = await this.termsAtPurchase(order, group, lines.map((l) => l.ctx.item));
      const destination = await this.destination(sellerId, sellerName, service);
      const reason = req.reason ?? 'changed_mind';
      const payer = this.policies.payerFor(terms, reason, group.seller.ownerType, fee);
      const checked = lines.map((l) => {
        const v = reasonVerdict(l.ctx.verdict, req.reason ?? null, now, this.core.tz);
        return { ...l, ok: v.ok, reason: v.ok ? null : v.reason, message: v.ok ? l.ctx.verdict.message : v.message };
      });
      const remedies = await this.remedyOptions(terms, lines, who);
      const rem = await this.views.amounts.remaining(order.id, lines.map((l) => l.ctx.item.id), false);
      const b = computeBreakdown({
        lines: checked
          .filter((l) => l.ok)
          .map((l) => ({
            paid: paid.get(l.ctx.item.id) ?? { orderItemId: l.ctx.item.id, quantity: l.ctx.item.quantity, itemAmount: l.ctx.item.lineSubtotal.amount, discountShare: 0, shippingShare: 0, taxShare: 0, paid: l.ctx.item.paidAmount.amount },
            quantity: l.quantity,
            remaining: rem?.items.get(l.ctx.item.id)?.remaining ?? null,
          })),
        currency: order.totals.total.currency,
        originalShippingRefunded: payer.originalShippingRefunded,
        returnShippingDeduction: payer.paidBy === 'customer' ? payer.customerFee : 0,
        deductions: [],
      });
      const returnBys = checked.map((l) => (req.reason && reasonGroupOf(req.reason) !== 'change_of_mind' ? l.ctx.verdict.faultReturnBy : l.ctx.verdict.returnBy)).filter((d): d is Date => !!d);
      const returnBy = returnBys.length ? new Date(Math.min(...returnBys.map((d) => d.getTime()))) : now;
      const wantedRemedy = req.remedy ?? 'refund';
      const items: ItemEligibility[] = checked.map((l) => ({ orderItemId: l.ctx.item.id, quantity: l.quantity, eligible: l.ok, ineligibleReason: l.reason, message: l.message }));
      const currency = order.totals.total.currency;
      const destinationLabel = wantedRemedy === 'store_credit' ? 'Marketly store credit' : order.progress.payment.methodLabel || 'Original payment method';
      out.push({
        group,
        sellerId,
        sellerName,
        terms,
        destination,
        payer,
        lines: checked,
        remedies,
        eligibility: {
          ownerType: group.seller.ownerType,
          sellerId,
          sellerName,
          eligible: checked.every((l) => l.ok),
          items,
          returnBy: returnBy.toISOString(),
          destination,
          shippingPaidBy: payer.paidBy,
          returnShippingCost: payer.paidBy === 'customer' ? money(payer.customerFee, currency) : null,
          labelMethod: 'prepaid_qr',
          remedies,
          responseBy: group.seller.ownerType === 'official' ? OFFICIAL_STORE_NAME : service ? 'Marketly' : sellerName,
          responseDueBusinessDays: terms.responseTargetBusinessDays,
          estimate: this.views.amounts.breakdown(b, currency, [], destinationLabel, true),
          terms,
        },
      });
    }
    return out;
  }

  async checkEligibility(body: EligibilityRequest, who: Shopper): Promise<EligibilityResult> {
    const order = await this.orderFor(body.orderId, who);
    const groups = await this.plan(order, body, who, false);
    return { orderId: order.id, groups: groups.map((g) => g.eligibility) };
  }

  /* ---------------------------------------------------------------- the request */

  async create(body: ReturnCreateInput, who: Shopper, by: By): Promise<Agg[]> {
    const order = await this.orderFor(body.orderId, who);
    const max = Number(await this.core.ctx.settings.get('maxPhotosPerReturn')) || 6;
    const mediaIds = body.mediaIds ?? [];
    if (mediaIds.length > max) throw invalidField('mediaIds', `Add at most ${max} photos or videos`);
    if (body.remedy === 'exchange' && !body.exchangeVariantId) throw invalidField('exchangeVariantId', 'Choose the size or color you want instead');
    const groups = await this.plan(order, body, who, true);
    const bad = groups.flatMap((g) => g.lines.filter((l) => !l.ok));
    if (bad.length) {
      if (bad.every((l) => l.reason === 'window_closed')) {
        const returnBy = bad.map((l) => l.ctx.verdict.changeOfMindReturnBy ?? l.ctx.verdict.faultReturnBy).find(Boolean);
        throw this.core.error('RETURN_WINDOW_CLOSED', bad[0]!.message, { returnBy: returnBy?.toISOString() ?? null });
      }
      throw this.core.error('RETURN_NOT_ELIGIBLE', 'Some items cannot be returned', { items: bad.map((l) => ({ orderItemId: l.ctx.item.id, reason: l.reason, message: l.message })) });
    }
    for (const g of groups) {
      const option = g.remedies.find((r) => r.kind === body.remedy);
      if (!option?.available) throw this.core.error('REMEDY_NOT_AVAILABLE', option?.unavailableReason ?? `${body.remedy} is not offered`, { remedy: body.remedy, sellerId: g.sellerId });
      // an exchange: another variant of the same product, same seller, same price (offers)
      if (body.remedy === 'exchange' && body.exchangeVariantId) {
        const first = g.lines[0]!.ctx.item;
        await this.handling.exchangeOffer({ ownerType: g.group.seller.ownerType, sellerId: g.sellerId, productId: first.product.productId, unitPrice: first.unitPrice.amount, variantId: body.exchangeVariantId });
      }
    }
    const baseline = await this.core.baseline();
    const now = this.core.now();
    const prepared: { ret: ReturnRec; items: ItemRec[] }[] = [];
    for (const g of groups) {
      const id = newId();
      const ref = await this.core.returnRef();
      const responseDays = g.terms.responseTargetBusinessDays || baseline.sellerResponseBusinessDays;
      const returnBys = g.lines.map((l) => l.ctx.verdict.faultReturnBy).filter((d): d is Date => !!d);
      const meta: ReturnMeta = {
        groupId: g.group.id,
        sellerName: g.sellerName,
        customerName: order.contact.name,
        contactEmail: order.contact.email,
        city: order.deliveryAddress.city ?? null,
        deliveryAddress: order.deliveryAddress,
        paymentIntentId: order.paymentIntentId ?? null,
        paymentMethodLabel: order.progress.payment.methodLabel || null,
        placedAt: order.placedAt,
        returnBy: returnBys.length ? new Date(Math.max(...returnBys.map((d) => d.getTime()))).toISOString() : null,
        destination: g.destination,
        reasonGroup: reasonGroupOf(body.reason),
        customerFee: g.payer.paidBy === 'customer' ? g.payer.customerFee : 0,
        targets: {
          responseBusinessDays: responseDays,
          infoReplyDays: baseline.infoReplyDays,
          dropOffDays: baseline.dropOffDays,
          inspectionBusinessDays: baseline.inspectionTargetBusinessDays,
          refundBusinessDays: baseline.refundTargetBusinessDays,
        },
        carrierServiceId: null,
        images: Object.fromEntries(g.lines.map((l) => [l.ctx.item.id, l.ctx.item.image?.url ?? l.ctx.item.product.imageUrl ?? null])),
        stockItems: Object.fromEntries(g.lines.map((l) => [l.ctx.item.id, l.ctx.item.stockItemId])),
        offers: Object.fromEntries(g.lines.map((l) => [l.ctx.item.id, l.ctx.item.offer.offerId])),
        categories: Object.fromEntries(g.lines.map((l) => [l.ctx.item.id, l.ctx.item.categoryId ?? null])),
      };
      const official = g.group.seller.ownerType === 'official';
      const service = isServiceGroup(g.group);
      prepared.push({
        ret: {
          id,
          ref,
          order_id: order.id,
          order_ref: order.ref,
          customer_id: order.contact.customerId ?? null,
          guest_session_id: who.guestSessionId && !who.customerId ? who.guestSessionId : null,
          owner_type: g.group.seller.ownerType,
          seller_id: g.sellerId,
          fulfilled_by: fulfilledByOf(g.group),
          status: 'requested',
          reason: body.reason,
          details: body.details?.trim() ?? '',
          media_ids: mediaIds,
          remedy: body.remedy,
          exchange_variant_id: body.remedy === 'exchange' ? (body.exchangeVariantId ?? null) : null,
          handled_by: official ? 'official_store' : service ? 'marketplace_support' : 'seller',
          terms_snapshot: { terms: g.terms, meta },
          shipping_paid_by: g.payer.paidBy,
          response_due_at: addBusinessDays(now, responseDays, this.core.tz),
          info_request: null,
          decision: null,
          platform_handling: service,
          escalation: null,
          owner_staff_id: null,
          case_id: null,
          conversation_id: null,
          exception: null,
          inspector: null,
          inspection_started_at: null,
          requested_at: now,
          received_at: null,
          completed_at: null,
          updated_at: now,
        },
        items: g.lines.map((l) => ({
          id: newId(),
          return_id: id,
          order_item_id: l.ctx.item.id,
          product_id: l.ctx.item.product.productId,
          variant_id: l.ctx.item.product.variantId,
          title: l.ctx.item.title,
          options: l.ctx.item.product.options ?? {},
          sku: l.ctx.item.offer.sellerSku ?? null,
          quantity: l.quantity,
          unit_price: l.ctx.item.unitPrice.amount,
          currency: l.ctx.item.unitPrice.currency,
        })),
      });
    }
    // photos belong to the request: every seller's return uses them
    const owner = who.customerId ? { kind: 'customer' as const, id: who.accountId ?? null } : { kind: 'guest' as const, id: who.guestSessionId ?? null };
    for (const p of prepared) await this.handling.attach(mediaIds, 'return_evidence', p.ret.id, `Return ${p.ret.ref}`, owner);
    await this.core.repo.transaction(async (tx) => {
      const used = await tx.usedQuantities(prepared.flatMap((p) => p.items.map((i) => i.order_item_id)));
      for (const p of prepared) {
        for (const i of p.items) {
          const c = groups.flatMap((g) => g.lines).find((l) => l.ctx.item.id === i.order_item_id)!;
          if ((used.get(i.order_item_id) ?? 0) + i.quantity > c.ctx.item.quantity) throw this.core.error('QUANTITY_EXCEEDS_RETURNABLE', 'Another return already covers these units', { items: [{ orderItemId: i.order_item_id, quantity: i.quantity }] });
        }
        await tx.insert('returns', p.ret);
        await tx.insertMany('return_items', p.items);
        await this.core.timeline(tx, p.ret.id, [
          { kind: 'requested', label: 'Return requested', detail: `${p.items.reduce((n, i) => n + i.quantity, 0)} item(s): ${p.items.map((i) => i.title).join(', ')}`, visibility: 'customer', actor: by.actor },
          ...(this.core.isService(p.ret) ? [{ kind: 'fulfilled_by_marketly', label: 'Fulfilled by Marketly: Marketly handles this return', detail: 'It comes back to the Marketly returns dock and Marketly inspects it; the refund is funded by the seller.', visibility: 'seller' as const }] : []),
        ]);
      }
    });
    for (const p of prepared) {
      this.core.publish(
        'returns.return.requested',
        { returnId: p.ret.id, ...this.core.refs(p.ret), ...this.core.owner(p.ret), orderItemIds: p.items.map((i) => i.order_item_id), reason: p.ret.reason, responseDueAt: p.ret.response_due_at!.toISOString() },
        by,
      );
    }
    // Official Store returns, and Fulfilled by Marketly returns (inside the seller's window, D7), may be approved automatically
    const [autoOfficial, autoService] = await Promise.all([this.core.ctx.settings.get('autoApproveOfficialWithinWindow'), this.core.ctx.settings.get('autoApproveServiceWithinWindow')]);
    for (const p of prepared.filter((x) => (x.ret.owner_type === 'official' && autoOfficial) || (this.core.isService(x.ret) && autoService))) {
      try {
        const agg = (await this.core.load(p.ret.id))!;
        await this.decisions.approve(p.ret.id, { labelMethod: 'prepaid_qr', note: 'Approved automatically: inside the return window' }, { actor: SYSTEM, requestId: by.requestId }, 'auto', agg);
      } catch (err) {
        this.core.ctx.log.warn({ err, returnId: p.ret.id }, `returns: automatic approval failed; the return waits for ${p.ret.owner_type === 'official' ? 'the Official Store team' : 'Marketly staff (Fulfilled by Marketly)'}`);
      }
    }
    return [...(await this.core.loadMany(prepared.map((p) => p.ret.id))).values()].sort((a, b) => a.ret.ref.localeCompare(b.ret.ref));
  }

  /* ---------------------------------------------------------------- after the request */

  async reply(agg: Agg, body: { reply: string; mediaIds?: string[] | null }, who: Shopper, by: By): Promise<void> {
    if (!body.reply?.trim()) throw invalidField('reply', 'Write your answer');
    const r = agg.ret;
    returnMachine.next(r.status as ReturnStatus, 'provideInfo');
    const mediaIds = body.mediaIds ?? [];
    const max = Number(await this.core.ctx.settings.get('maxPhotosPerReturn')) || 6;
    if (mediaIds.length > max) throw invalidField('mediaIds', `Add at most ${max} photos or videos`);
    await this.handling.attach(mediaIds, 'return_evidence', r.id, `Return ${r.ref}`, who.customerId ? { kind: 'customer', id: who.accountId ?? null } : { kind: 'guest', id: who.guestSessionId ?? null });
    const now = this.core.now();
    await this.core.write(r.id, by, async (tx, a) => {
      const status = returnMachine.next(a.ret.status as ReturnStatus, 'provideInfo');
      const info = a.ret.info_request!;
      const remaining = Math.max(info.remainingMs, 4 * 3_600_000);
      await tx.update('returns', r.id, {
        status,
        info_request: { ...info, reply: body.reply.trim(), replyMediaIds: mediaIds, repliedAt: now.toISOString() },
        response_due_at: new Date(now.getTime() + remaining),
        updated_at: now,
      });
      await this.core.timeline(tx, r.id, [{ kind: 'info_replied', label: 'You answered the question', detail: body.reply.trim(), visibility: 'customer', actor: by.actor }]);
    });
  }

  async withdraw(agg: Agg, reason: string | null | undefined, by: By): Promise<void> {
    const r = agg.ret;
    const shipment = this.core.shipmentOf(agg);
    if (shipment && shipment.status !== 'label_issued') throw illegal('The item is already on its way back', { from: r.status });
    returnMachine.next(r.status as ReturnStatus, 'withdraw');
    await this.cancel(r.id, 'withdraw', reason?.trim() || 'Withdrawn by the customer', by);
  }

  /** withdraw (customer), expire (jobs) or a closing case decision */
  async cancel(id: string, event: 'withdraw' | 'expire', reason: string, by: By): Promise<void> {
    const labelToVoid = await this.core.write(id, by, async (tx, a, batch) => {
      const status = returnMachine.next(a.ret.status as ReturnStatus, event);
      const now = this.core.now();
      await tx.update('returns', id, { status, completed_at: now, updated_at: now });
      const sh = this.core.shipmentOf(a);
      let label: string | null = null;
      if (sh && sh.status === 'label_issued') {
        await tx.update('return_shipments', sh.id, { status: returnShipmentMachine.next('label_issued', 'expire') });
        if (sh.method !== 'customer_arranged') label = sh.label_id ?? sh.id;
      }
      await this.core.timeline(tx, id, [{ kind: 'cancelled', label: 'Return cancelled', detail: reason, visibility: 'customer', actor: by.actor }]);
      batch.push('returns.return.cancelled', { returnId: id, ...this.core.refs(a.ret), by: by.actor, reason });
      return label;
    });
    if (labelToVoid) await this.core.quiet('void label', () => this.core.ctx.use('shipping').voidLabel(labelToVoid, reason));
  }

  async label(agg: Agg, near: string | null | undefined): Promise<ReturnShipment> {
    const r = agg.ret;
    const s = this.core.shipmentOf(agg);
    if (!s || !is(['approved', 'in_transit', 'received', 'awaiting_remedy', 'completed'], r.status)) throw illegal('The return label is ready once the return is approved', { from: r.status });
    const meta = r.terms_snapshot.meta;
    const zip = near?.trim() || meta.deliveryAddress?.postalCode || this.core.ctx.config.market.defaultLocation.postalCode;
    let points: ReturnShipment['dropOffPoints'] = [];
    const carrierServiceId = s.carrier_service_id ?? meta.carrierServiceId ?? null;
    if (s.method !== 'customer_arranged' && s.status === 'label_issued' && carrierServiceId) {
      const found = await this.core.quiet('drop-off points', () => this.core.ctx.use('shipping').findDropOffPoints(carrierServiceId, zip, 5));
      points = (found ?? []).map((p) => ({ name: p.name, address: [p.address.line1, p.address.city, p.address.region].filter(Boolean).join(', '), distanceMiles: p.distanceMiles, hours: p.hours }));
    }
    return this.views.shipment(s, agg, points);
  }

  async emailLabel(agg: Agg, who: Shopper): Promise<void> {
    const r = agg.ret;
    const s = this.core.shipmentOf(agg);
    if (!s || s.method === 'customer_arranged' || !is(['approved', 'in_transit'], r.status)) throw illegal('There is no drop-off code to send', { from: r.status });
    const notifications = this.core.ctx.tryUse('notifications');
    if (!notifications) throw unavailable('Email');
    const recipient = who.accountId ? { kind: 'customer' as const, accountId: who.accountId } : r.terms_snapshot.meta.contactEmail ? { kind: 'guest_email' as const, email: r.terms_snapshot.meta.contactEmail } : null;
    if (!recipient) throw unavailable('Email');
    await notifications.notify({
      topic: 'customer.return.label_ready',
      recipients: [recipient],
      context: { return: { ref: r.ref }, label: { url: s.label_url, qrCodeUrl: s.qr_code_url, dropOffBy: s.drop_off_by?.toISOString() ?? null } },
      link: { kind: 'return', id: r.id, ref: r.ref, label: 'Get label', screen: 'account/return' },
    });
  }

  async addTracking(agg: Agg, body: { carrier: string; trackingNumber: string }, by: By): Promise<void> {
    const r = agg.ret;
    const s = this.core.shipmentOf(agg);
    if (!body.carrier?.trim() || !body.trackingNumber?.trim()) throw invalid([...(!body.carrier?.trim() ? [{ path: 'carrier', message: 'Choose the carrier' }] : []), ...(!body.trackingNumber?.trim() ? [{ path: 'trackingNumber', message: 'Enter the tracking number' }] : [])]);
    if (!s || s.method !== 'customer_arranged') throw illegal('Tracking is added only for returns you send yourself', { from: r.status });
    returnMachine.next(r.status as ReturnStatus, 'dropOff');
    returnShipmentMachine.next(s.status as never, 'dropOff');
    const meta = r.terms_snapshot.meta;
    const tracked = await this.core.ctx.use('shipping').registerReturnTracking({ returnId: r.id, orderId: r.order_id, groupId: meta.groupId, carrierCode: body.carrier.trim(), trackingNumber: body.trackingNumber.trim(), to: meta.destination.address });
    await this.core.write(r.id, by, async (tx, a, batch) => {
      const status = returnMachine.next(a.ret.status as ReturnStatus, 'dropOff');
      const sh = this.core.shipmentOf(a)!;
      await tx.update('returns', r.id, { status, updated_at: this.core.now() });
      await tx.update('return_shipments', sh.id, { status: returnShipmentMachine.next(sh.status as never, 'dropOff'), carrier: tracked.carrierName ?? body.carrier.trim(), tracking_number: body.trackingNumber.trim(), shipping_shipment_id: tracked.id });
      await this.core.timeline(tx, r.id, [{ kind: 'shipment_dropped_off', label: 'You sent the return', detail: `${body.carrier.trim()} ${body.trackingNumber.trim()}`, visibility: 'customer', actor: by.actor }]);
      batch.push('returns.return.shipped', { returnId: r.id, ...this.core.refs(a.ret), trackingNumber: body.trackingNumber.trim() });
    });
  }

  async escalate(agg: Agg, body: { reason: 'seller_no_response' | 'customer_disagrees' | 'refund_late' | 'other'; note?: string | null }, who: Shopper, by: By): Promise<void> {
    const r = agg.ret;
    if (!is(['requested', 'info_requested', 'approved', 'in_transit', 'received', 'awaiting_remedy', 'rejected'], r.status)) throw illegal('This return is closed', { from: r.status });
    if (r.escalation) return; // Marketly is already involved
    const can = this.views.escalation(agg);
    if (!can.ok) throw this.core.error('ESCALATION_NOT_AVAILABLE', 'You can ask Marketly to step in once the deadline passes', { availableFrom: can.availableFrom });
    const reason = r.status === 'rejected' && body.reason === 'customer_disagrees' ? 'customer_disagrees' : body.reason;
    const opened = await this.core.soft('support', 'open case', (s) =>
      s.openCase({
        kind: 'dispute',
        category: 'return',
        orderId: r.order_id,
        orderItemIds: agg.items.map((i) => i.order_item_id),
        ...(r.customer_id ? { customerId: r.customer_id } : {}),
        ...(r.seller_id ? { sellerId: r.seller_id } : {}),
        returnId: r.id,
        subject: `Return ${r.ref}`,
        message: body.note?.trim() || `The customer asked Marketly to step in (${reason.replace(/_/g, ' ')}).`,
        openedBy: by.actor,
      }),
    );
    const now = this.core.now();
    await this.core.write(r.id, by, async (tx, a, batch) => {
      if (a.ret.escalation) return;
      await tx.update('returns', r.id, {
        escalation: { at: now.toISOString(), by: by.actor, reason, note: body.note?.trim() || null, caseId: opened?.id ?? null, caseRef: opened?.ref ?? null },
        case_id: opened?.id ?? a.ret.case_id,
        platform_handling: a.ret.owner_type === 'seller' ? true : a.ret.platform_handling,
        handled_by: 'marketplace_support',
        updated_at: now,
      });
      await this.core.timeline(tx, r.id, [{ kind: 'escalated', label: 'You asked Marketly to step in', detail: opened ? `Case ${opened.ref}` : null, visibility: 'customer', actor: by.actor }]);
      batch.push('returns.return.escalated', { returnId: r.id, ...this.core.refs(a.ret), ownerType: a.ret.owner_type, sellerId: a.ret.seller_id, reason, by: by.actor });
    });
    if (opened) await this.core.repo.find('return_evidence', { return_id: r.id, case_id: null }).then((rows) => Promise.all(rows.map((e) => this.core.repo.update('return_evidence', e.id, { case_id: opened.id }))));
    void who;
  }
}
