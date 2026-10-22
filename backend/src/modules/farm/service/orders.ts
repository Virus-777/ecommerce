/**
 * Farm orders: a picked machine with its attachments, priced from the store's product cards (departments), sent to
 * the nearest dealer and delivered to the customer's farm. Pay in full goes through payments purchase intents
 * (authorized when placed, captured when the dealer confirms, voided when rejected, cancelled or expired);
 * installments and pay on delivery take no card. Staff move orders through the Farm order state machine on the
 * dealer's behalf; customers cancel before confirmation.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isIsoDate } from '../../../kernel/lib/dates.js';
import { newId } from '../../../kernel/lib/ids.js';
import { money, type Money } from '../../../kernel/lib/money.js';
import type { Page, PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as departments from '../../../spec/departments.js';
import type { CancelInput, FarmLocation, FarmOrder, FarmOrderAdmin, FarmQuote, OrderAction, OrderAttachment, OrderMachine, PlaceOrderInput, QuoteInput, RetryPaymentInput, StatusChange } from '../../../spec/farm.js';
import type * as payments from '../../../spec/payments.js';
import type * as search from '../../../spec/search.js';
import {
  ADMIN_ACTIONS,
  dayLabel,
  deliveryLabel,
  deliveryWindow,
  inWindow,
  isPhone,
  LIMITS,
  locationLabel,
  makeRef,
  moneyLabel,
  OPEN_STATUSES,
  PAST_STATUSES,
  PAYMENT_OPTIONS,
  paymentLabel,
  paymentOptionsFor,
  balanceLabel,
  cardAmountOf,
  depositLabel,
  depositOf,
  percentOf,
  statusLabel,
  summaryLabel,
  type AdminAction,
  type OrderStatus,
  type PaymentOption,
} from '../domain/rules.js';
import { farmOrderMachine } from '../domain/state-machines.js';
import type { DealerRow, DealerSnapshot, OrderRow, StoredAttachment, StoredChange, StoredLocation, StoredMachine } from '../ports.js';
import type { FarmRepository } from '../repository.js';
import { invalid, notFound, optionalText, present, requireText, unique, type By } from './base.js';
import { FarmDealers } from './dealers.js';

type Event = Parameters<typeof farmOrderMachine.next>[1];
/** How long a payment may wait in a bank challenge before the order is dropped */
const CHALLENGE_MINUTES = 30;
const JOB_BATCH = 100;
const SYSTEM = 'Marketly';
const ACTION_LABEL: Record<AdminAction, string> = { confirm: 'Confirmed', reject: 'Rejected', dispatch: 'Sent out', deliver: 'Delivered', cancel: 'Cancelled', reschedule: 'Rescheduled' };

const historyOf = (v: unknown): StoredChange[] => (Array.isArray(v) ? (v as StoredChange[]).filter((h) => h && typeof h.status === 'string' && typeof h.at === 'string').map((h) => ({ status: h.status, at: h.at, by: h.by ?? null, note: h.note ?? null })) : []);
const machineOf = (v: unknown): StoredMachine => v as StoredMachine;
const attachmentsOf = (v: unknown): StoredAttachment[] => (Array.isArray(v) ? (v as StoredAttachment[]) : []);
const dealerSnapOf = (v: unknown): DealerSnapshot => v as DealerSnapshot;
const locationOf = (v: unknown): StoredLocation => v as StoredLocation;
const orderable = (c: search.ProductCard) => c.availability !== 'out_of_stock';

/** The machine and attachments the customer picked, priced now */
interface Priced {
  machine: departments.FarmMachine;
  chosen: search.ProductCard[];
  /** chosen ids that are not attachments of the machine any more, or out of stock */
  unavailable: string[];
  machinePrice: number;
  attachmentsTotal: number;
  total: number;
  currency: string;
}

export class FarmOrders extends FarmDealers {
  /* ---------------------------------------------------------------- pricing */

  /** A picked machine with its attachments priced now; NOT_FOUND when it isn't picked, the store hides it or departments is off */
  private async machine(productId: string): Promise<departments.FarmMachine> {
    const api = this.departments;
    if (!api) throw notFound('Machine');
    return api.getFarmMachine(productId);
  }

  private price(machine: departments.FarmMachine, attachmentIds: readonly string[] | null | undefined): Priced {
    const ids = unique(attachmentIds ?? []);
    if (ids.length > LIMITS.attachments) throw invalid('attachmentIds', `Pick at most ${LIMITS.attachments} attachments`);
    const byId = new Map(machine.attachments.map((a) => [a.productId, a]));
    const chosen: search.ProductCard[] = [];
    const unavailable: string[] = [];
    for (const id of ids) {
      const a = byId.get(id);
      if (a && orderable(a)) chosen.push(a);
      else unavailable.push(id);
    }
    const currency = machine.product.price.currency || this.currency;
    const machinePrice = machine.product.price.amount;
    const attachmentsTotal = chosen.reduce((s, a) => s + a.price.amount, 0);
    return { machine, chosen, unavailable, machinePrice, attachmentsTotal, total: machinePrice + attachmentsTotal, currency };
  }

  private async months() {
    return this.intSetting('installmentMonths', 12, 2);
  }

  /** Pay on delivery's deposit share, 1 to 100 */
  private async depositPercent() {
    return Math.min(100, await this.intSetting('depositPercent', 10, 1));
  }

  /** The pay-on-delivery deposit and balance of an order (null for the other options) */
  private depositOut(o: OrderRow) {
    if (o.payment_option !== 'pay_on_delivery') return { deposit: null, balance: null, depositLabel: null, balanceLabel: null };
    const deposit = money(o.card_amount, o.currency);
    const balance = money(o.total - o.card_amount, o.currency);
    return { deposit, balance, depositLabel: depositLabel(deposit, o.captured), balanceLabel: balanceLabel(balance) };
  }

  /** The delivery window for a dealer: its lead time (else the setting) to maxAheadDays */
  private async windowFor(d: DealerRow | null) {
    const lead = d?.lead_days ?? (await this.intSetting('leadDays', 3));
    const ahead = await this.intSetting('maxAheadDays', 90, 1);
    return deliveryWindow(this.today(), lead, ahead);
  }

  async quoteOrder(customerId: string | null, input: QuoteInput): Promise<FarmQuote> {
    const machine = await this.machine(input.productId);
    const p = this.price(machine, input.attachmentIds);
    const location = await this.farmLocation(input.location, customerId, false);
    const customerPoint = await this.customerPoint(customerId);
    const pick = await this.dealerFor(location?.point ?? null, customerPoint);
    const window = await this.windowFor(pick?.dealer ?? null);
    const months = await this.months();
    const percent = await this.depositPercent();
    const total = money(p.total, p.currency);
    const deposit = money(depositOf(p.total, percent), p.currency);
    const balance = money(p.total - deposit.amount, p.currency);
    const problems: string[] = [];
    if (!orderable(machine.product)) problems.push('This machine is out of stock');
    if (p.unavailable.length) problems.push(p.unavailable.length === 1 ? 'An attachment is no longer available' : 'Some attachments are no longer available');
    if (!pick) problems.push('No dealer takes farm orders yet');
    const chosenIds = new Set(p.chosen.map((a) => a.productId));
    return {
      machine: machine.product,
      highlights: machine.highlights,
      machineLabel: [...machine.highlights, ...(pick ? [pick.dealer.name] : [])].join(' · '),
      attachments: machine.attachments.map((a) => ({ product: a, selected: chosenIds.has(a.productId), priceLabel: `+${moneyLabel(a.price)}`, available: orderable(a) })),
      dealer: pick ? this.dealerCard(pick.dealer.id, this.snapshotOf(pick.dealer), pick.from) : null,
      machinePrice: money(p.machinePrice, p.currency),
      attachmentsTotal: money(p.attachmentsTotal, p.currency),
      deliveryFee: money(0, p.currency),
      total,
      summaryLabel: summaryLabel(p.chosen.length),
      earliestDeliveryDate: window.earliest,
      latestDeliveryDate: window.latest,
      paymentOptions: paymentOptionsFor(total, months, percent),
      depositPercent: percent,
      deposit,
      balance,
      depositLabel: depositLabel(deposit),
      balanceLabel: balanceLabel(balance),
      canOrder: problems.length === 0,
      problems,
    };
  }

  /**
   * Saved cards and a new-card session for the card amount of a farm order (priced here, like a quote): the total
   * for pay in full, the deposit for pay on delivery. payments' chargeNote describes checkout orders, so it is
   * replaced with how the farm hold works.
   */
  async getPaymentOptions(customerId: string, q: { option: 'pay_in_full' | 'pay_on_delivery'; productId: string; attachmentIds?: string[] | null }): Promise<payments.PaymentOptions> {
    if (q.option !== 'pay_in_full' && q.option !== 'pay_on_delivery') throw invalid('option', 'Installments take no card');
    const p = this.price(await this.machine(q.productId), q.attachmentIds);
    const percent = await this.depositPercent();
    const amount = money(cardAmountOf(q.option, p.total, percent), p.currency);
    const options = await this.payments.listOptions({ customerId }, amount);
    const chargeNote =
      q.option === 'pay_in_full'
        ? "We hold the full amount on your card when you order and charge it when the dealer confirms your delivery date. If the dealer can't take the order or you cancel before then, the hold is released."
        : `We hold the ${percent}% deposit on your card when you order and charge it when the dealer confirms. You pay the rest to the dealer when the machine arrives. If the dealer can't take the order or you cancel before then, the hold is released.`;
    return { ...options, chargeNote };
  }

  /* ---------------------------------------------------------------- output */

  private machineOut(o: OrderRow): OrderMachine {
    const m = machineOf(o.machine);
    return { productId: m.productId, slug: m.slug, title: m.title, image: m.image, highlights: m.highlights ?? [], price: money(m.price, o.currency) };
  }
  private attachmentsOut(o: OrderRow): OrderAttachment[] {
    return attachmentsOf(o.attachments).map((a) => ({ productId: a.productId, title: a.title, image: a.image, price: money(a.price, o.currency), priceLabel: `+${moneyLabel(money(a.price, o.currency))}` }));
  }
  private locationOut(o: OrderRow): FarmLocation {
    const l = locationOf(o.location);
    return { name: l.name, line1: l.line1, line2: l.line2, city: l.city, region: l.region, postalCode: l.postalCode, country: l.country, label: locationLabel(l), point: l.point, pinned: l.pinned };
  }

  /** The payment of each order (payments' customer-facing view), when it has one */
  private async paymentsOf(rows: OrderRow[], refresh = false): Promise<Map<string, payments.PurchasePaymentStatus>> {
    const out = new Map<string, payments.PurchasePaymentStatus>();
    for (const o of rows) {
      if (!o.intent_id) continue;
      const p = await this.soft('payments.getPurchaseStatus', () => this.payments.getPurchaseStatus(o.intent_id!, refresh), null);
      if (p) out.set(o.id, p);
    }
    return out;
  }

  private async dealersOf(rows: OrderRow[]) {
    return new Map((await this.repo.dealersByIds(unique(rows.map((o) => o.dealer_id)))).map((d) => [d.id, d]));
  }

  /** The dealer of an order now (its current hours and phone), or the copy taken when it was placed */
  private orderDealer(o: OrderRow, d: DealerRow | undefined) {
    const snap = d ? this.snapshotOf(d) : dealerSnapOf(o.dealer);
    return this.dealerCard(o.dealer_id, snap, locationOf(o.location).point);
  }

  protected async ordersOut(rows: OrderRow[]): Promise<FarmOrder[]> {
    if (!rows.length) return [];
    const [dealers, pays, months] = await Promise.all([this.dealersOf(rows), this.paymentsOf(rows), this.months()]);
    return rows.map((o) => {
      const dealer = this.orderDealer(o, dealers.get(o.dealer_id));
      const pay = pays.get(o.id);
      return {
        id: o.id,
        ref: o.ref,
        status: o.status,
        statusLabel: statusLabel(o.status, dealer.name, o.delivery_date),
        machine: this.machineOut(o),
        attachments: this.attachmentsOut(o),
        machinePrice: money(o.machine_price, o.currency),
        attachmentsTotal: money(o.attachments_total, o.currency),
        deliveryFee: money(0, o.currency),
        total: money(o.total, o.currency),
        summaryLabel: summaryLabel(attachmentsOf(o.attachments).length),
        paymentOption: o.payment_option,
        paymentLabel: paymentLabel(o.payment_option, o.method_label ?? pay?.methodLabel ?? null, months, percentOf(o.card_amount, o.total)),
        cardAmount: money(o.card_amount, o.currency),
        ...this.depositOut(o),
        dealer,
        requestedDeliveryDate: o.requested_date,
        deliveryDate: o.delivery_date,
        deliveryDateConfirmed: o.date_confirmed,
        deliveryLabel: deliveryLabel(o.delivery_date, o.date_confirmed, o.status),
        location: this.locationOut(o),
        contactName: o.contact_name,
        contactPhone: o.contact_phone,
        notes: o.notes,
        dealerNote: o.dealer_note,
        // customers see when the status changed, not who changed it
        history: historyOf(o.history).map((h): StatusChange => ({ status: h.status, at: h.at, by: null, note: h.note })),
        payment: pay ?? null,
        canCancel: o.status === 'placed' || o.status === 'payment_failed',
        placedAt: o.placed_at?.toISOString() ?? null,
        confirmedAt: o.confirmed_at?.toISOString() ?? null,
        deliveredAt: o.delivered_at?.toISOString() ?? null,
        createdAt: o.created_at.toISOString(),
      };
    });
  }

  /** The moves staff can make now */
  private actionsOf(o: OrderRow): AdminAction[] {
    return ADMIN_ACTIONS.filter((a) => {
      if (a === 'reschedule') return o.status === 'confirmed';
      if (a === 'cancel' && o.captured) return false;
      return farmOrderMachine.can(o.status as never, a as Event);
    });
  }

  protected async ordersAdmin(rows: OrderRow[]): Promise<FarmOrderAdmin[]> {
    if (!rows.length) return [];
    const [dealers, pays, months] = await Promise.all([this.dealersOf(rows), this.paymentsOf(rows), this.months()]);
    const customers = new Map<string, { id: string; name: string | null; email: string | null }>();
    for (const id of unique(rows.map((o) => o.customer_id))) {
      const c = await this.soft('customers.getCustomer', () => this.customers.getCustomer(id), null);
      customers.set(id, { id, name: c?.displayName ?? null, email: c?.email ?? null });
    }
    return rows.map((o) => {
      const d = dealers.get(o.dealer_id);
      const snap = d ? this.snapshotOf(d) : dealerSnapOf(o.dealer);
      const pay = pays.get(o.id);
      return {
        id: o.id,
        ref: o.ref,
        status: o.status,
        statusLabel: statusLabel(o.status, snap.name, o.delivery_date),
        machine: this.machineOut(o),
        attachments: this.attachmentsOut(o),
        machinePrice: money(o.machine_price, o.currency),
        attachmentsTotal: money(o.attachments_total, o.currency),
        total: money(o.total, o.currency),
        paymentOption: o.payment_option,
        paymentLabel: paymentLabel(o.payment_option, o.method_label ?? pay?.methodLabel ?? null, months, percentOf(o.card_amount, o.total)),
        cardAmount: money(o.card_amount, o.currency),
        deposit: this.depositOut(o).deposit,
        balance: this.depositOut(o).balance,
        dealer: { id: o.dealer_id, name: snap.name, phone: snap.phone ?? null },
        customer: customers.get(o.customer_id)!,
        requestedDeliveryDate: o.requested_date,
        deliveryDate: o.delivery_date,
        deliveryDateConfirmed: o.date_confirmed,
        location: this.locationOut(o),
        contactName: o.contact_name,
        contactPhone: o.contact_phone,
        notes: o.notes,
        dealerNote: o.dealer_note,
        staffNote: o.staff_note,
        history: historyOf(o.history),
        methodLabel: o.method_label ?? pay?.methodLabel ?? null,
        paymentState: pay?.state ?? null,
        intentId: o.intent_id,
        placedAt: o.placed_at?.toISOString() ?? null,
        confirmedAt: o.confirmed_at?.toISOString() ?? null,
        deliveredAt: o.delivered_at?.toISOString() ?? null,
        createdAt: o.created_at.toISOString(),
        actions: this.actionsOf(o),
      };
    });
  }

  /* ---------------------------------------------------------------- moves */

  private publishPlaced(o: OrderRow, by: By) {
    this.ctx.events.publish(
      'farm.order.placed',
      { orderId: o.id, ref: o.ref, customerId: o.customer_id, dealerId: o.dealer_id, dealerName: dealerSnapOf(o.dealer).name, machineName: machineOf(o.machine).title, paymentOption: o.payment_option, total: money(o.total, o.currency), cardAmount: money(o.card_amount, o.currency), deliveryDate: o.delivery_date },
      by,
    );
  }

  private publishStatus(o: OrderRow, note: string | null, by: By, rescheduled = false) {
    this.ctx.events.publish(
      'farm.order.status_changed',
      { orderId: o.id, ref: o.ref, customerId: o.customer_id, dealerName: dealerSnapOf(o.dealer).name, machineName: machineOf(o.machine).title, status: o.status, paymentOption: o.payment_option, total: money(o.total, o.currency), cardAmount: money(o.card_amount, o.currency), deliveryDate: o.delivery_date, rescheduled, note },
      by,
    );
  }

  /**
   * Moves an order along the state machine and records it in its history (inside its own transaction unless `tx`
   * is given). `expect` refuses the move when the order is no longer as read. Returns the new row, or undefined when
   * `quiet` and the move no longer applies.
   */
  private async move(id: string, event: Event, o: { by: string | null; note?: string | null; patch?: Partial<OrderRow>; quiet?: boolean; tx?: FarmRepository; expect?: (row: OrderRow) => boolean }): Promise<OrderRow | undefined> {
    const run = async (tx: FarmRepository) => {
      const row = await tx.getOrder(id, { forUpdate: true });
      if (!row) throw notFound('Order');
      if (o.expect && !o.expect(row)) {
        if (o.quiet) return undefined;
        throw new AppError('ILLEGAL_TRANSITION', 'This order has moved on; refresh it', { machine: 'Farm order', from: row.status, event });
      }
      let to: string;
      try {
        to = farmOrderMachine.next(row.status as never, event) as string;
      } catch (err) {
        if (o.quiet) return undefined;
        throw err;
      }
      const now = this.now();
      const history = [...historyOf(row.history), { status: to, at: now.toISOString(), by: o.by, note: o.note ?? null }];
      return tx.updateOrder(id, { ...o.patch, status: to as OrderStatus, history: history as never, updated_at: now });
    };
    return o.tx ? run(o.tx) : this.repo.transaction(run);
  }

  /** The payment went through: the order is placed (once, whoever sees it first) */
  protected async markPaid(orderId: string, intentId: string, methodLabel: string | null, by: By, claimKey?: string): Promise<OrderRow | undefined> {
    const after = await this.repo.transaction(async (tx) => {
      if (claimKey && !(await tx.claim(claimKey))) return undefined;
      const row = await tx.getOrder(orderId, { forUpdate: true });
      if (!row || row.status !== 'payment_pending' || (row.intent_id && row.intent_id !== intentId)) return undefined;
      return this.move(orderId, 'pay', { by: null, tx, patch: { intent_id: intentId, placed_at: this.now(), ...(methodLabel ? { method_label: methodLabel } : {}) } });
    });
    if (after) this.publishPlaced(after, by);
    return after;
  }

  /** The card was declined: the order waits for another try */
  protected async markFailed(orderId: string, intentId: string, by: By, claimKey?: string): Promise<OrderRow | undefined> {
    const after = await this.repo.transaction(async (tx) => {
      if (claimKey && !(await tx.claim(claimKey))) return undefined;
      const row = await tx.getOrder(orderId, { forUpdate: true });
      if (!row || row.status !== 'payment_pending' || row.intent_id !== intentId) return undefined;
      return this.move(orderId, 'fail', { by: null, tx });
    });
    if (after) this.publishStatus(after, null, by);
    return after;
  }

  /** What an authorization answered, applied to the order */
  private async settle(orderId: string, result: payments.AuthorizeResult, by: By): Promise<void> {
    await this.repo.updateOrder(orderId, { intent_id: result.intentId, method_label: result.methodLabel || null, updated_at: this.now() });
    if (result.state === 'accepted') await this.markPaid(orderId, result.intentId, result.methodLabel, by);
    else if (result.state === 'failed') await this.markFailed(orderId, result.intentId, by);
    // requires_action and pending_check: the order waits in payment_pending (complete-action, refresh or the payments events finish it)
  }

  /** Payments' latest answer for a waiting order, applied */
  private async applyStatus(o: OrderRow, p: payments.PurchasePaymentStatus | null, by: By) {
    if (!p || o.status !== 'payment_pending' || o.intent_id !== p.intentId) return;
    if (p.state === 'accepted' || p.state === 'captured') await this.markPaid(o.id, p.intentId, p.methodLabel, by);
    else if (p.state === 'failed') await this.markFailed(o.id, p.intentId, by);
  }

  private async voidPayment(o: OrderRow, reason: string) {
    if (!o.intent_id || o.captured) return;
    try {
      await this.payments.voidIntent(o.intent_id, reason);
    } catch (err) {
      // the authorization lapses on its own; staff see the payment state on the order
      this.ctx.log.warn({ err, orderId: o.id, intentId: o.intent_id }, 'farm: could not void the payment');
    }
  }

  /* ---------------------------------------------------------------- customers: placing and paying */

  private async freshRef(): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const ref = makeRef();
      if (!(await this.repo.refTaken(ref))) return ref;
    }
    throw new AppError('CONFLICT', 'Could not make an order reference; try again');
  }

  private async authorize(o: OrderRow, method: payments.MethodSelection, returnUrl: string, key: string): Promise<payments.AuthorizeResult> {
    return this.payments.authorizePurchase(
      { module: 'farm', refId: o.id, ref: o.ref, customerId: o.customer_id, amount: money(o.card_amount, o.currency), method, description: o.payment_option === 'pay_on_delivery' ? `${machineOf(o.machine).title} deposit` : machineOf(o.machine).title, returnUrl },
      `farm:${o.id}:${o.attempts}:${key}`,
    );
  }

  async placeOrder(customerId: string, input: PlaceOrderInput, idempotencyKey: string, by: By): Promise<FarmOrder> {
    const key = `${customerId}:${idempotencyKey}`;
    let order = await this.repo.orderByKey(key);
    if (!order) {
      order = await this.createOrder(customerId, input, key);
      if (order.status === 'placed') this.publishPlaced(order, by);
    }
    if (order.status === 'payment_pending' && !order.intent_id && input.method && input.returnUrl) {
      let result: payments.AuthorizeResult;
      try {
        result = await this.authorize(order, input.method, input.returnUrl, idempotencyKey);
      } catch (err) {
        // nothing was authorized: the order goes away for another try
        const now = await this.repo.getOrder(order.id);
        if (now && !now.intent_id && now.status === 'payment_pending') await this.repo.deleteOrder(order.id);
        throw err;
      }
      await this.settle(order.id, result, by);
    }
    return this.getOrder(customerId, order.id, false);
  }

  private async createOrder(customerId: string, input: PlaceOrderInput, key: string): Promise<OrderRow> {
    const option = input.paymentOption as PaymentOption;
    if (!(PAYMENT_OPTIONS as readonly string[]).includes(option)) throw invalid('paymentOption', 'Pick a payment option');
    if (option !== 'installments') {
      if (!input.method) throw invalid('method', option === 'pay_in_full' ? 'Add a card to pay in full' : 'Add a card for the deposit');
      if (!input.returnUrl) throw invalid('returnUrl', 'A return address is required to pay by card');
    }
    const contactName = requireText(input.contactName, 'contactName', LIMITS.name, 'Add a contact name');
    const contactPhone = requireText(input.contactPhone, 'contactPhone', LIMITS.phone, 'Add a contact phone');
    if (!isPhone(contactPhone)) throw invalid('contactPhone', 'Enter a phone number');
    const notes = optionalText(input.notes, 'notes', LIMITS.notes);
    if (!isIsoDate(input.deliveryDate)) throw invalid('deliveryDate', 'Pick a delivery date');

    let machine: departments.FarmMachine;
    try {
      machine = await this.machine(input.productId);
    } catch (err) {
      if (isAppError(err) && err.code === 'NOT_FOUND') throw this.ctx.error('MACHINE_UNAVAILABLE', "This machine can't be ordered now.");
      throw err;
    }
    if (!orderable(machine.product)) throw this.ctx.error('MACHINE_UNAVAILABLE', `${machine.product.title} is out of stock.`);
    const p = this.price(machine, input.attachmentIds);
    if (p.unavailable.length) throw this.ctx.error('ATTACHMENT_UNAVAILABLE', p.unavailable.length === 1 ? 'An attachment is no longer available.' : 'Some attachments are no longer available.', { productIds: p.unavailable });
    if (p.chosen.some((a) => a.price.currency !== p.currency)) throw this.ctx.error('MACHINE_UNAVAILABLE', "This machine can't be ordered with these attachments.");
    if (input.expectedTotal.amount !== p.total || input.expectedTotal.currency !== p.currency) throw this.ctx.error('PRICE_CHANGED', 'Prices changed; check the new total.', { total: money(p.total, p.currency) });

    const location = (await this.farmLocation(input.location, customerId, true))!;
    const pick = await this.dealerFor(location.point, await this.customerPoint(customerId));
    if (!pick) throw this.ctx.error('NO_DEALER', 'No dealer takes farm orders yet.');
    const window = await this.windowFor(pick.dealer);
    if (!inWindow(input.deliveryDate, window)) throw this.ctx.error('DELIVERY_DATE_UNAVAILABLE', `Pick a delivery date from ${dayLabel(window.earliest)} to ${dayLabel(window.latest)}.`, window);

    const now = this.now();
    const cardAmount = cardAmountOf(option, p.total, await this.depositPercent());
    const card = cardAmount > 0;
    const status: OrderStatus = card ? 'payment_pending' : 'placed';
    const storedMachine: StoredMachine = { productId: machine.product.productId, slug: machine.product.slug ?? null, title: machine.product.title, image: machine.product.image ?? null, highlights: machine.highlights, price: p.machinePrice };
    const storedAttachments: StoredAttachment[] = p.chosen.map((a) => ({ productId: a.productId, title: a.title, image: a.image ?? null, price: a.price.amount }));
    return this.repo.insertOrder({
      id: newId(),
      ref: await this.freshRef(),
      customer_id: customerId,
      dealer_id: pick.dealer.id,
      dealer: this.snapshotOf(pick.dealer) as never,
      machine: storedMachine as never,
      attachments: storedAttachments as never,
      machine_price: p.machinePrice,
      attachments_total: p.attachmentsTotal,
      total: p.total,
      card_amount: cardAmount,
      currency: p.currency,
      payment_option: option,
      requested_date: input.deliveryDate,
      delivery_date: input.deliveryDate,
      date_confirmed: false,
      location: location as never,
      contact_name: contactName,
      contact_phone: contactPhone,
      notes,
      status,
      history: [{ status, at: now.toISOString(), by: null, note: null }] as never,
      dealer_note: null,
      staff_note: null,
      intent_id: null,
      attempts: 1,
      method_label: null,
      captured: false,
      placed_at: card ? null : now,
      confirmed_at: null,
      dispatched_at: null,
      delivered_at: null,
      idempotency_key: key,
      created_at: now,
      updated_at: now,
    });
  }

  async listMyOrders(customerId: string, q: { state?: 'open' | 'past' }, page: PageRequest): Promise<Page<FarmOrder>> {
    const statuses = q.state === 'open' ? OPEN_STATUSES : q.state === 'past' ? PAST_STATUSES : undefined;
    const res = await this.repo.pageCustomerOrders(customerId, statuses, page);
    return { ...res, items: await this.ordersOut(res.items) };
  }

  private async mine(customerId: string, id: string): Promise<OrderRow> {
    const o = await this.repo.getOrder(id);
    if (!o || o.customer_id !== customerId) throw notFound('Order');
    return o;
  }

  async getOrder(customerId: string, id: string, refresh = false, by?: By): Promise<FarmOrder> {
    let o = await this.mine(customerId, id);
    if (refresh && o.status === 'payment_pending' && o.intent_id) {
      const p = await this.soft('payments.getPurchaseStatus', () => this.payments.getPurchaseStatus(o.intent_id!, true), null);
      await this.applyStatus(o, p, by ?? { actor: { kind: 'customer', id: customerId } });
      o = (await this.repo.getOrder(id))!;
    }
    return (await this.ordersOut([o]))[0]!;
  }

  async completeOrderAction(customerId: string, id: string, resultToken: string, idempotencyKey: string, by: By): Promise<FarmOrder> {
    const o = await this.mine(customerId, id);
    if (o.status !== 'payment_pending' || !o.intent_id) throw new AppError('ILLEGAL_TRANSITION', 'This order has no payment waiting for your bank', { machine: 'Farm order', from: o.status, event: 'complete_action' });
    const result = await this.payments.completeAction(o.intent_id, resultToken, `farm:${o.id}:action:${idempotencyKey}`);
    await this.settle(o.id, result, by);
    return this.getOrder(customerId, id);
  }

  async retryOrderPayment(customerId: string, id: string, input: RetryPaymentInput, idempotencyKey: string, by: By): Promise<FarmOrder> {
    const o = await this.mine(customerId, id);
    farmOrderMachine.next(o.status as never, 'retry');
    const moved = (await this.move(id, 'retry', { by: null, expect: (row) => row.status === 'payment_failed', patch: { attempts: o.attempts + 1, intent_id: null } }))!;
    let result: payments.AuthorizeResult;
    try {
      result = await this.authorize(moved, input.method, input.returnUrl, idempotencyKey);
    } catch (err) {
      // nothing was authorized: back to payment failed, as before the try
      await this.repo.updateOrder(id, { status: 'payment_failed', attempts: o.attempts, intent_id: o.intent_id, history: o.history, updated_at: this.now() });
      throw err;
    }
    await this.settle(id, result, by);
    return this.getOrder(customerId, id);
  }

  async cancelOrder(customerId: string, id: string, body: CancelInput, by: By): Promise<FarmOrder> {
    const o = await this.mine(customerId, id);
    if (o.status !== 'placed' && o.status !== 'payment_failed') throw new AppError('ILLEGAL_TRANSITION', 'The dealer has confirmed your order; call them to change it', { machine: 'Farm order', from: o.status, event: 'cancel' });
    const reason = optionalText(body.reason, 'reason', LIMITS.reason);
    const after = (await this.move(id, 'cancel', { by: 'customer', note: reason, expect: (row) => row.status === o.status }))!;
    await this.voidPayment(after, 'Cancelled by the customer');
    this.publishStatus(after, reason, by);
    return this.getOrder(customerId, id);
  }

  /* ---------------------------------------------------------------- staff */

  async listOrdersAdmin(q: { status?: string; state?: 'open' | 'past'; dealerId?: string; paymentOption?: string; q?: string }, page: PageRequest): Promise<Page<FarmOrderAdmin>> {
    let statuses: string[] | undefined = q.state === 'open' ? OPEN_STATUSES : q.state === 'past' ? PAST_STATUSES : undefined;
    if (q.status) statuses = statuses ? statuses.filter((s) => s === q.status) : [q.status];
    const text = q.q?.trim();
    let customerIds: string[] = [];
    if (text && !/^FM-/i.test(text)) {
      const found = await this.soft('customers.searchCustomers', () => this.customers.searchCustomers({ search: text }, { limit: 50 }), null);
      customerIds = found?.items.map((c) => c.id) ?? [];
    }
    const res = await this.repo.pageAdminOrders({ ...(statuses ? { statuses } : {}), ...(q.dealerId ? { dealerId: q.dealerId } : {}), ...(q.paymentOption ? { paymentOption: q.paymentOption } : {}), ...(text ? { q: text, customerIds } : {}) }, page);
    return { ...res, items: await this.ordersAdmin(res.items) };
  }

  async getOrderAdmin(id: string): Promise<FarmOrderAdmin> {
    const o = await this.repo.getOrder(id);
    if (!o) throw notFound('Order');
    return (await this.ordersAdmin([o]))[0]!;
  }

  /** A delivery date staff set: a day, today or later */
  private staffDate(v: string | null | undefined, path: string): string {
    if (!isIsoDate(v)) throw invalid(path, 'Pick the delivery date');
    if (v < this.today()) throw invalid(path, 'Pick today or a later day');
    return v;
  }

  async moveOrder(id: string, input: OrderAction, by: By): Promise<FarmOrderAdmin> {
    const o = await this.repo.getOrder(id);
    if (!o) throw notFound('Order');
    const action = input.action as AdminAction;
    if (!(ADMIN_ACTIONS as readonly string[]).includes(action)) throw invalid('action', 'Unknown action');
    const note = optionalText(input.note, 'note', LIMITS.reason);
    const staffNote = optionalText(input.staffNote, 'staffNote', LIMITS.staffNote);
    const who = by.actor.name || 'Staff';
    if (action === 'reschedule') return this.reschedule(o, input.deliveryDate, note, staffNote, who, by);
    farmOrderMachine.next(o.status as never, action);
    if (action === 'cancel' && o.captured) throw this.ctx.error('REFUND_NOT_AVAILABLE', "The card was already charged and refunds of farm orders aren't in the app yet.");
    const now = this.now();
    const patch: Partial<OrderRow> = {};
    if (staffNote) patch.staff_note = staffNote;
    if (action === 'confirm') {
      const date = this.staffDate(input.deliveryDate ?? o.requested_date, 'deliveryDate');
      if (o.card_amount > 0) {
        await this.capture(o);
        patch.captured = true;
      }
      Object.assign(patch, { delivery_date: date, date_confirmed: true, confirmed_at: now });
    }
    if (action === 'reject' || action === 'cancel') patch.dealer_note = note;
    if (action === 'confirm' && note) patch.dealer_note = note;
    if (action === 'dispatch') patch.dispatched_at = now;
    if (action === 'deliver') patch.delivered_at = now;
    const after = (await this.move(id, action, { by: who, note, patch, expect: (row) => row.status === o.status }))!;
    if (action === 'reject' || action === 'cancel') await this.voidPayment(after, action === 'reject' ? 'Rejected by the dealer' : 'Cancelled by Marketly staff');
    this.publishStatus(after, note, by);
    await this.audit({ action: `farm.order.${action}`, actionLabel: `${ACTION_LABEL[action]} farm order ${after.ref}`, target: { type: 'farm_order', id, ref: after.ref, label: after.ref }, before: { status: o.status, deliveryDate: o.delivery_date }, after: { status: after.status, deliveryDate: after.delivery_date }, reason: note }, by);
    return this.getOrderAdmin(id);
  }

  /** A new delivery date for a confirmed order (the status stays) */
  private async reschedule(o: OrderRow, day: string | null | undefined, note: string | null, staffNote: string | null, who: string, by: By): Promise<FarmOrderAdmin> {
    if (o.status !== 'confirmed') throw new AppError('ILLEGAL_TRANSITION', 'Only a confirmed order can be rescheduled', { machine: 'Farm order', from: o.status, event: 'reschedule' });
    const date = this.staffDate(day, 'deliveryDate');
    const after = await this.repo.transaction(async (tx) => {
      const row = await tx.getOrder(o.id, { forUpdate: true });
      if (!row || row.status !== 'confirmed') throw new AppError('ILLEGAL_TRANSITION', 'This order has moved on; refresh it', { machine: 'Farm order', from: row?.status, event: 'reschedule' });
      const now = this.now();
      const history = [...historyOf(row.history), { status: 'confirmed', at: now.toISOString(), by: who, note: note ? `Delivery moved to ${dayLabel(date)} · ${note}` : `Delivery moved to ${dayLabel(date)}` }];
      return (await tx.updateOrder(o.id, { delivery_date: date, history: history as never, ...(note ? { dealer_note: note } : {}), ...(staffNote ? { staff_note: staffNote } : {}), updated_at: now }))!;
    });
    this.publishStatus(after, note, by, true);
    await this.audit({ action: 'farm.order.reschedule', actionLabel: `Rescheduled farm order ${after.ref}`, target: { type: 'farm_order', id: o.id, ref: after.ref, label: after.ref }, before: { deliveryDate: o.delivery_date }, after: { deliveryDate: date }, reason: note }, by);
    return this.getOrderAdmin(o.id);
  }

  /** Charges the authorized card when the dealer confirms; PAYMENT_CAPTURE_FAILED leaves the order placed */
  private async capture(o: OrderRow) {
    if (!o.intent_id) throw this.ctx.error('PAYMENT_CAPTURE_FAILED', 'This order has no card payment to charge.');
    try {
      await this.payments.capturePurchase(o.intent_id);
    } catch (err) {
      // a capture that went through before (a retried confirmation) is fine
      const p = await this.soft('payments.getPurchaseStatus', () => this.payments.getPurchaseStatus(o.intent_id!, false), null);
      if (p?.state === 'captured') return;
      this.ctx.log.warn({ err, orderId: o.id, intentId: o.intent_id }, 'farm: capture failed');
      throw this.ctx.error('PAYMENT_CAPTURE_FAILED', "The card couldn't be charged; the order stays placed. Try again or reject it.", isAppError(err) ? { reason: err.message } : undefined);
    }
  }

  /* ---------------------------------------------------------------- events, jobs, export */

  async onPurchaseAuthorizedFromPayments(e: EventPayload<'payments.purchase.authorized'>, eventId?: string): Promise<void> {
    if (e.module !== 'farm') return;
    const o = await this.repo.getOrder(e.refId);
    if (!o) {
      this.ctx.log.warn({ intentId: e.intentId, refId: e.refId }, 'farm: authorized payment for an unknown order');
      return;
    }
    await this.markPaid(o.id, e.intentId, e.methodLabel, { actor: { kind: 'system' } }, `purchase-authorized:${eventId ?? e.intentId}`);
  }

  async onPurchaseFailedFromPayments(e: EventPayload<'payments.purchase.failed'>, eventId?: string): Promise<void> {
    if (e.module !== 'farm') return;
    const o = await this.repo.getOrder(e.refId);
    if (!o) {
      this.ctx.log.warn({ intentId: e.intentId, refId: e.refId }, 'farm: failed payment for an unknown order');
      return;
    }
    await this.markFailed(o.id, e.intentId, { actor: { kind: 'system' } }, `purchase-failed:${eventId ?? e.intentId}`);
  }

  /** Cancels placed orders the dealer didn't confirm in time, and drops orders left in a bank challenge */
  async expireUnconfirmed(): Promise<void> {
    const by: By = { actor: { kind: 'system' } };
    const now = this.now();
    const confirmBy = new Date(now.getTime() - (await this.intSetting('confirmHours', 48, 1)) * 3_600_000);
    let cursor: { at: Date; id: string } | null = null;
    for (;;) {
      const batch: OrderRow[] = await this.repo.staleOrders('placed', 'placed_at', confirmBy, cursor, JOB_BATCH);
      for (const o of batch) {
        const note = "The dealer didn't confirm the order in time";
        const after = await this.move(o.id, 'expire', { by: SYSTEM, note, quiet: true, expect: (row) => row.status === 'placed', patch: { dealer_note: note } });
        if (!after) continue;
        await this.voidPayment(after, 'Not confirmed in time');
        this.publishStatus(after, note, by);
      }
      if (batch.length < JOB_BATCH) break;
      const last: OrderRow = batch[batch.length - 1]!;
      cursor = { at: last.placed_at!, id: last.id };
    }
    const challengeBy = new Date(now.getTime() - CHALLENGE_MINUTES * 60_000);
    cursor = null;
    for (;;) {
      const batch: OrderRow[] = await this.repo.staleOrders('payment_pending', 'updated_at', challengeBy, cursor, JOB_BATCH);
      for (const o of batch) {
        const p = o.intent_id ? await this.soft('payments.getPurchaseStatus', () => this.payments.getPurchaseStatus(o.intent_id!, false), null) : null;
        if (p && p.state !== 'requires_action') {
          // a missed answer from payments: apply it; a pending check stays with payments
          await this.applyStatus(o, p, by);
          continue;
        }
        if (o.intent_id && !p) continue;
        const note = "The payment wasn't confirmed in time";
        const after = await this.move(o.id, 'abandon', { by: SYSTEM, note, quiet: true, expect: (row) => row.status === 'payment_pending' && row.intent_id === o.intent_id });
        if (!after) continue;
        await this.voidPayment(after, 'Bank challenge not finished');
        this.publishStatus(after, note, by);
      }
      if (batch.length < JOB_BATCH) break;
      const last: OrderRow = batch[batch.length - 1]!;
      cursor = { at: last.updated_at, id: last.id };
    }
  }

  async exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const ids = unique([input.customerId, input.accountId].filter(present));
    const orders = (await Promise.all(ids.map((id) => this.repo.customerOrders(id)))).flat();
    if (!orders.length) return [];
    const months = await this.months();
    return [
      {
        key: 'farm_orders',
        title: 'Farm orders',
        module: 'farm',
        records: orders.map((o) => ({
          reference: o.ref,
          dealer: dealerSnapOf(o.dealer).name,
          machine: { name: machineOf(o.machine).title, price: money(o.machine_price, o.currency) },
          attachments: attachmentsOf(o.attachments).map((a) => ({ name: a.title, price: money(a.price, o.currency) })),
          total: money(o.total, o.currency) as Money,
          payment: paymentLabel(o.payment_option, o.method_label, months, percentOf(o.card_amount, o.total)),
          cardAmount: money(o.card_amount, o.currency),
          ...(o.payment_option === 'pay_on_delivery' ? { deposit: money(o.card_amount, o.currency), balanceOnDelivery: money(o.total - o.card_amount, o.currency) } : {}),
          requestedDeliveryDate: o.requested_date,
          deliveryDate: o.delivery_date,
          farmLocation: { ...locationOf(o.location), label: locationLabel(locationOf(o.location)) },
          contactName: o.contact_name,
          contactPhone: o.contact_phone,
          notes: o.notes,
          status: o.status,
          placedAt: o.placed_at?.toISOString() ?? null,
          confirmedAt: o.confirmed_at?.toISOString() ?? null,
          deliveredAt: o.delivered_at?.toISOString() ?? null,
          createdAt: o.created_at.toISOString(),
        })),
      },
    ];
  }
}

