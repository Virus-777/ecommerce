/**
 * Read models: the checkout as the screens show it, change sets, the confirmation and the support views.
 */
import { isAppError } from '../../../kernel/errors/index.js';
import type * as common from '../../../spec/common.js';
import type * as orders from '../../../spec/orders.js';
import type * as payments from '../../../spec/payments.js';
import type * as shipping from '../../../spec/shipping.js';
import type {
  AddressStep,
  ChangeSet,
  CheckoutLine,
  CheckoutPackage,
  CheckoutSessionAdminRow,
  CheckoutView,
  ConfirmationView,
  DiscountShare,
  LegalInfo,
  PlaceAttempt,
} from '../../../spec/checkout.js';
import {
  CHANGES_INTRO,
  DOUBLE_SUBMIT_NOTE,
  GUEST_NOTE,
  LEGAL_TEXT,
  PARTIAL_NOTE,
  TERMS_NOTE,
  locationNote,
  m,
  packagesNote,
  plural,
  sellerSupportLine,
  stepsOf,
  type LineInfo,
  type StepFacts,
  type StoredChangeSet,
  type StoredQuote,
} from '../domain/rules.js';
import type { ChangeSetRow, LineRow, PackageRow, PlaceRequestRow, SessionRow } from '../ports.js';
import type { Core } from './core.js';
import { byLineOrder } from './quote.js';

const POLICY_KEYS = ['returns', 'shipping', 'purchase_terms'] as const;

const FALLBACK_INFO: LineInfo = {
  title: 'Item',
  variantLabel: '',
  condition: 'New',
  image: null,
  seller: { ownerType: 'seller', id: null, name: 'Seller', slug: '', official: false, verified: false, logo: null },
  categoryId: null,
  brandId: null,
  purchaseLimit: null,
  returnTerms: { summary: 'Returns follow the Marketly return policy.', windowDays: 30, returnShippingPaidBy: 'depends_on_reason', policyVersionId: null },
  responseTargetDays: null,
  dispatch: { businessDays: 1, sameDayCutoff: null, shipsFrom: '' },
};

export class Views {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  info(q: StoredQuote, lineId: string): LineInfo {
    return q.lineInfo[lineId] ?? FALLBACK_INFO;
  }

  line(l: LineRow, q: StoredQuote, currency: string): CheckoutLine {
    const i = this.info(q, l.id);
    const s = q.shippability[l.id];
    const note =
      l.status === 'not_shippable'
        ? (s?.message ?? "Can't ship to this address.") + ' It stays in your cart.'
        : l.status === 'removed'
          ? 'Removed from this order. It stays in your cart.'
          : l.status === 'unavailable'
            ? 'No longer available. It stays in your cart.'
            : null;
    return {
      id: l.id,
      cartItemId: l.cart_item_id,
      offerId: l.offer_id,
      productId: l.product_id,
      variantId: l.variant_id,
      stockItemId: l.stock_item_id,
      title: i.title,
      variantLabel: i.variantLabel,
      condition: i.condition,
      image: i.image,
      quantity: l.quantity,
      unitPrice: m(l.unit_price, currency),
      lineTotal: m(l.unit_price * l.quantity, currency),
      discounts: (Array.isArray(l.discounts) ? l.discounts : []) as unknown as DiscountShare[],
      status: l.status as CheckoutLine['status'],
      note,
    };
  }

  /** Policy versions in force now (content off: none) */
  async policyVersions(): Promise<orders.AcceptedPolicyVersion[]> {
    const content = this.ctx.tryUse('content');
    const refs = content ? await this.core.optional('content.currentPolicyVersions', () => content.currentPolicyVersions([...POLICY_KEYS])) : undefined;
    return (refs ?? [])
      .filter((r): r is typeof r & { policyKey: (typeof POLICY_KEYS)[number] } => (POLICY_KEYS as readonly string[]).includes(r.policyKey))
      .map((r) => ({ policyKey: r.policyKey, versionId: r.versionId, version: r.version, effectiveAt: r.effectiveAt }));
  }

  async legal(): Promise<LegalInfo> {
    const policyVersions = await this.policyVersions();
    return {
      purchaseTermsVersionId: policyVersions.find((p) => p.policyKey === 'purchase_terms')?.versionId ?? null,
      policyVersions,
      purchaseTermsUrl: `${this.ctx.config.publicUrls.store.replace(/\/$/, '')}/help/purchase-terms`,
      text: LEGAL_TEXT,
    };
  }

  async paymentOptions(row: SessionRow, amount: common.Money): Promise<payments.PaymentOptions> {
    const owner = row.customer_id ? { customerId: row.customer_id } : { guestSessionId: row.guest_session_id ?? undefined };
    return this.ctx.use('payments').listOptions(owner, amount);
  }

  async lastPayment(row: SessionRow): Promise<payments.PaymentStatusView | null> {
    const p = this.core.payment(row);
    if (!p.intentId || !['payment_pending', 'payment_failed', 'awaiting_action', 'completed', 'placing'].includes(row.status)) return null;
    try {
      return await this.ctx.use('payments').getIntentStatus(p.intentId, false);
    } catch (err) {
      if (isAppError(err) && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  stepFacts(row: SessionRow, lines: LineRow[], packages: PackageRow[]): StepFacts {
    const account = this.core.account(row);
    const included = lines.filter((l) => l.status === 'included');
    const keys = [...new Set(included.map((l) => l.package_key))];
    const byKey = new Map(packages.map((p) => [p.package_key, p]));
    const p = this.core.payment(row);
    return {
      hasEmail: Boolean(account.email),
      hasAddress: Boolean(row.address),
      notShippable: lines.filter((l) => l.status === 'not_shippable').length,
      included: included.length,
      packagesWithoutOption: keys.flatMap((k, i) => (byKey.get(k)?.selected_option_id ? [] : [`Package ${i + 1} of ${keys.length}`])),
      rejectedCoupons: this.core.quote(row).coupons.filter((c) => c.status !== 'applied').length,
      hasPayment: Boolean(p.method),
      changesPending: row.status === 'changes_pending',
    };
  }

  /** The whole checkout (GET /sessions/{id}) */
  async checkout(row: SessionRow): Promise<CheckoutView> {
    const cur = row.currency;
    const [lines0, packages, open] = await Promise.all([this.core.repo.listLines(row.id), this.core.repo.listPackages(row.id), this.core.repo.openChangeSet(row.id)]);
    const lines = lines0.sort(byLineOrder);
    const q = this.core.quote(row);
    const account = this.core.account(row);
    const payment = this.core.payment(row);
    const address = this.core.address(row);
    const included = lines.filter((l) => l.status === 'included');
    const keys = [...new Set(included.map((l) => l.package_key))];
    const pkgRows = new Map(packages.map((p) => [p.package_key, p]));

    const pkgs: CheckoutPackage[] = keys.map((key, i) => {
      const pl = included.filter((l) => l.package_key === key);
      const info = this.info(q, pl[0]!.id);
      const row2 = pkgRows.get(key);
      const idx = q.totals.shippingByPackage.findIndex((s) => s.packageKey === key);
      const totals = q.totals.perPackage[idx] ?? { items: m(0, cur), discounts: m(0, cur), shipping: m(0, cur), tax: m(0, cur), total: m(0, cur) };
      return {
        key,
        label: `Package ${i + 1} of ${keys.length}`,
        seller: info.seller,
        soldAndShippedBy: `Sold and shipped by ${info.seller.name}`,
        shipsFrom: row2?.ships_from || info.dispatch.shipsFrom,
        lines: pl.map((l) => this.line(l, q, cur)),
        options: (Array.isArray(row2?.options) ? row2!.options : []) as unknown as shipping.DeliveryOption[],
        selectedOptionId: row2?.selected_option_id ?? null,
        returnTerms: row2?.return_terms ?? info.returnTerms.summary,
        sellerSupport: sellerSupportLine(info.seller, info.responseTargetDays),
        totals,
      };
    });

    let addressStep: AddressStep | null = null;
    if (address) {
      const candidates = lines.filter((l) => l.status === 'included' || l.status === 'not_shippable');
      const notShippable = candidates.filter((l) => l.status === 'not_shippable');
      addressStep = {
        address,
        addressId: row.address_id,
        allShippable: notShippable.length === 0,
        message: notShippable.length
          ? `${notShippable.length} of ${plural(candidates.length, 'item')} can't ship to this address. ${notShippable.length === 1 ? 'It stays' : 'They stay'} in your cart.`
          : candidates.length === 1
            ? 'Your item can ship to this address.'
            : `All ${candidates.length} items can ship to this address.`,
        lines: candidates.map((l) => {
          const s = q.shippability[l.id];
          return { lineId: l.id, title: this.info(q, l.id).title, sellerName: this.info(q, l.id).seller.name, shippable: l.status === 'included', reason: l.status === 'included' ? null : (s?.reason ?? null), message: l.status === 'included' ? null : (s?.message ?? null) };
        }),
        locationNote: locationNote(address),
        addressBookNote: q.addressBookNote ?? (row.customer_id ? "Changing the address here doesn't change your address book." : "We'll use this address for this order only."),
      };
    }

    const facts = this.stepFacts(row, lines, packages);
    const { steps, blockers } = stepsOf(facts);
    const [options, legal, lastPayment] = await Promise.all([this.paymentOptions(row, q.totals.total), this.legal(), this.lastPayment(row)]);
    const credit = this.core.credit(row);
    return {
      id: row.id,
      status: row.status as CheckoutView['status'],
      source: row.source as CheckoutView['source'],
      quoteVersion: row.quote_version,
      currency: cur,
      steps,
      account: account.email
        ? { kind: account.kind, customerId: account.customerId, name: account.name, email: account.email, phone: account.phone, createAccountAfter: account.createAccountAfter, marketingOptIn: account.marketingOptIn, note: account.kind === 'guest' ? GUEST_NOTE : null }
        : null,
      address: addressStep,
      packages: pkgs,
      packagesNote: packagesNote(pkgs.length),
      excludedLines: [...q.excluded, ...lines.filter((l) => l.status !== 'included').map((l) => this.line(l, q, cur))],
      coupons: q.coupons,
      credit: credit ? { available: m(credit.available, cur), sourceNote: credit.sourceNote, use: credit.use, applied: q.totals.creditApplied } : null,
      payment: { selected: payment.view, options, chargeNote: options.chargeNote },
      totals: q.totals,
      legal,
      giftNote: row.gift_note,
      readyToPlace: row.status === 'open' && blockers.length === 0,
      blockers,
      doubleSubmitNote: DOUBLE_SUBMIT_NOTE,
      openChangeSetId: open?.id ?? null,
      holdUntil: row.status === 'payment_failed' && row.hold_until ? row.hold_until.toISOString() : null,
      expiresAt: row.expires_at.toISOString(),
      orderId: row.order_id,
      orderRef: row.order_ref,
      lastPayment,
    };
  }

  changeSet(row: ChangeSetRow): ChangeSet {
    const s = row.changes as unknown as StoredChangeSet;
    const cur = s.currency;
    return {
      id: row.id,
      sessionId: row.session_id,
      detectedAt: row.created_at.toISOString(),
      status: row.status as ChangeSet['status'],
      intro: CHANGES_INTRO,
      changes: s.items.map((i) => i.change),
      previousTotal: m(row.previous_total, cur),
      newTotal: m(row.new_total, cur),
      deltas: s.deltas.map((d) => ({ label: d.label, amount: m(d.amount, cur) })),
      partialOrder: s.partialOrder,
      partialNote: s.partialOrder ? PARTIAL_NOTE : null,
    };
  }

  /** Order confirmation; null until the payment is accepted */
  async confirmation(row: SessionRow): Promise<ConfirmationView | null> {
    if (row.status !== 'completed' || !row.order_id) return null;
    const cur = row.currency;
    const q = this.core.quote(row);
    const account = this.core.account(row);
    const payment = this.core.payment(row);
    const [lines0, packages, order] = await Promise.all([this.core.repo.listLines(row.id), this.core.repo.listPackages(row.id), this.core.optional('orders.getOrder', () => this.ctx.use('orders').getOrder(row.order_id!))]);
    const lines = lines0.sort(byLineOrder).filter((l) => l.status === 'included');
    const keys = [...new Set(lines.map((l) => l.package_key))];
    const pkgRows = new Map(packages.map((p) => [p.package_key, p]));
    const units = lines.reduce((s, l) => s + l.quantity, 0);
    const offerAccount = account.kind === 'guest' && account.createAccountAfter && Boolean(await this.ctx.settings.get('offerAccountAfterGuestPurchase'));
    return {
      orderId: row.order_id,
      orderRef: row.order_ref ?? '',
      greetingName: account.name?.split(' ')[0] ?? null,
      email: account.email ?? '',
      charged: q.totals.total,
      paymentLabel: payment.methodLabel ?? payment.view?.label ?? 'Card',
      paymentState: 'accepted',
      deliveryAddress: this.core.address(row)!,
      packages: keys.map((key, i) => {
        const pl = lines.filter((l) => l.package_key === key);
        const info = this.info(q, pl[0]!.id);
        const opt = pkgRows.get(key)?.selected_option as shipping.DeliveryOption | null | undefined;
        const ship = q.totals.shippingByPackage.find((s) => s.packageKey === key);
        return {
          label: `Package ${i + 1} of ${keys.length}`,
          seller: info.seller,
          shipsFrom: pkgRows.get(key)?.ships_from || info.dispatch.shipsFrom,
          arrivalLabel: opt?.arrivalLabel ?? 'Arrival date to be confirmed',
          shippingLabel: `${opt?.methodName ?? 'Standard'} · ${ship && ship.amount.amount > 0 ? new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(ship.amount.amount / 100) : 'Free'}`,
          items: pl.map((l) => {
            const li = this.info(q, l.id);
            return { title: li.title, variantLabel: li.variantLabel, condition: li.condition, quantity: l.quantity, price: m(l.unit_price, cur), image: li.image, status: 'Confirmed' };
          }),
        };
      }),
      packagesNote: keys.length > 1 ? `Your ${plural(units, 'item')} ship in ${keys.length} packages that may arrive on different days.` : `Your ${plural(units, 'item')} ship in 1 package.`,
      totals: q.totals,
      nextSteps: [
        { title: 'Confirmation email', when: 'In a few minutes', body: `We sent your receipt to ${account.email ?? 'your email'}.` },
        { title: 'Sellers prepare your packages', when: keys.length > 1 ? 'Each package on its own schedule' : 'Within the dispatch time shown', body: 'We will email you when each package ships, with its tracking link.' },
        { title: 'Track or change your order', when: 'Any time', body: account.kind === 'guest' ? 'Use the link in your email to view and manage this order.' : 'Find it under Your orders in your account.' },
      ],
      termsNote: TERMS_NOTE,
      receiptDocumentId: order?.documents.find((d) => d.kind === 'receipt')?.id ?? null,
      offerAccountCreation: offerAccount,
    };
  }

  adminRow(row: SessionRow): CheckoutSessionAdminRow {
    const a = this.core.account(row);
    const q = this.core.quote(row);
    const p = this.core.payment(row);
    return {
      id: row.id,
      status: row.status,
      customerName: a.name ?? a.email ?? 'Guest',
      email: a.email ?? '',
      guest: a.kind === 'guest',
      total: q.totals.total,
      packageCount: q.totals.shippingByPackage.length,
      paymentAttempts: row.attempt_count,
      lastDecline: p.decline?.message ?? null,
      orderRef: row.order_ref,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  attempt(r: PlaceRequestRow, currency: string): PlaceAttempt {
    const res = (r.response ?? {}) as { quoteVersion?: number; total?: number };
    return {
      at: r.created_at.toISOString(),
      idempotencyKey: r.idempotency_key,
      outcome: r.outcome ?? 'in_progress',
      paymentIntentId: r.payment_intent_id,
      quoteVersion: res.quoteVersion ?? 0,
      total: m(res.total ?? 0, currency),
    };
  }
}
