/**
 * Saved payment methods and checkout payment options. Only provider tokens and display data are stored
 * (brand, last 4, expiry, label, a copy of the billing address); card numbers stay with the provider.
 * Removing a method detaches it at the provider; payments keep their MethodSnapshot, so receipts and refunds
 * of earlier orders are unaffected.
 */
import { newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { PaymentOptions, SavedPaymentMethod, SetupSession } from '../../../spec/payments.js';
import { brandName, isExpired, validExpiry } from '../domain/rules.js';
import { ProviderError, type CardDetails, type SavedMethodRec } from '../ports.js';
import { invalid, notFound, type By, type Cfg, type Core } from './core.js';
import type { Views } from './views.js';

type Billing = SavedMethodRec['billing_address'];

export class Methods {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  private async active(customerId: string): Promise<SavedMethodRec[]> {
    const rows = await this.repo.find('saved_methods', { customer_id: customerId, removed_at: null }, { orderBy: [['created_at', 'desc']] });
    return rows.sort((a, b) => Number(b.is_default) - Number(a.is_default));
  }

  async listSavedMethods(customerId: string): Promise<SavedPaymentMethod[]> {
    const today = this.core.today();
    return (await this.active(customerId)).map((m) => this.views.savedMethod(m, today));
  }

  /** The customer's own method, else NOT_FOUND (another customer's card is never confirmed to exist) */
  private async own(customerId: string, methodId: string): Promise<SavedMethodRec> {
    const m = await this.repo.get('saved_methods', methodId);
    if (!m || m.customer_id !== customerId || m.removed_at) throw notFound('Payment method');
    return m;
  }

  private chargeNote(cfg: Cfg) {
    return cfg.captureMode === 'per_group_on_dispatch'
      ? 'Each package is charged when it ships. Each seller is paid by Marketly after delivery.'
      : 'Your card is charged once, when the order is accepted. Each seller is paid by Marketly after delivery.';
  }

  async setup(customerId: string | null): Promise<SetupSession> {
    try {
      const s = await this.core.call('setup', {}, () => this.core.provider.createSetup({ customerId, idempotencyKey: newId() }));
      return { provider: this.core.provider.code, clientSecret: s.clientSecret, publishableKey: this.core.provider.publishableKey, expiresAt: s.expiresAt.toISOString() };
    } catch (err) {
      return this.core.unavailable(err);
    }
  }

  async listOptions(owner: { customerId?: string; guestSessionId?: string }, amount: common.Money): Promise<PaymentOptions> {
    if (!Number.isSafeInteger(amount.amount) || amount.amount < 0) throw invalid([{ path: 'amount', message: 'Enter an amount of zero or more' }]);
    const cfg = await this.core.cfg();
    const [savedMethods, newCard] = await Promise.all([owner.customerId ? this.listSavedMethods(owner.customerId) : Promise.resolve([]), this.setup(owner.customerId ?? null)]);
    return {
      acceptedBrands: cfg.acceptedCardBrands,
      savedMethods: savedMethods.filter((m) => cfg.acceptedCardBrands.includes(m.brand.toLowerCase()) && (m.kind !== 'digital_wallet' || cfg.walletsEnabled)),
      walletAvailable: cfg.walletsEnabled,
      walletKinds: cfg.walletsEnabled ? ['apple_pay', 'google_pay'] : [],
      newCard,
      chargeNote: this.chargeNote(cfg),
    };
  }

  private async billing(customerId: string, body: { billingAddressId?: string | null; billingAddress?: common.Address | null }): Promise<Billing | undefined> {
    if (body.billingAddress) return { ...body.billingAddress };
    if (body.billingAddressId) {
      const customers = this.core.ctx.tryUse('customers');
      if (!customers) throw invalid([{ path: 'billingAddressId', message: 'Saved addresses are not available right now; enter the address' }]);
      // a copy: later address-book edits never change the card's billing address
      const a = await customers.getAddressForOrder(customerId, body.billingAddressId).catch(() => null);
      if (!a) throw invalid([{ path: 'billingAddressId', message: 'Choose one of your saved addresses' }]);
      return { ...a };
    }
    return undefined;
  }

  private async store(customerId: string, found: { methodId: string; card: CardDetails }, o: { label?: string | null; billing?: Billing; makeDefault?: boolean | null }, by: By): Promise<SavedMethodRec> {
    const cfg = await this.core.cfg();
    if (!cfg.acceptedCardBrands.includes(found.card.brand.toLowerCase())) {
      await this.core.provider.detach(found.methodId).catch(() => {});
      throw this.core.error('PAYMENT_METHOD_INVALID', `We don't accept ${brandName(found.card.brand)} cards.`);
    }
    const label = o.label?.trim() || `${brandName(found.card.brand)} •••• ${found.card.last4}`;
    const now = this.core.now();
    const saved = await this.repo.transaction(async (tx) => {
      const existing = await tx.find('saved_methods', { customer_id: customerId, removed_at: null }, { forUpdate: true });
      const makeDefault = Boolean(o.makeDefault) || !existing.length;
      if (makeDefault) await tx.updateWhere('saved_methods', { customer_id: customerId, removed_at: null, is_default: true }, { is_default: false });
      return tx.insert('saved_methods', {
        id: newId(),
        customer_id: customerId,
        provider: this.core.provider.code,
        provider_method_id: found.methodId,
        kind: found.card.kind,
        brand: found.card.brand.toLowerCase(),
        last4: found.card.last4,
        exp_month: found.card.expMonth,
        exp_year: found.card.expYear,
        label: label.slice(0, 80),
        billing_address: o.billing ?? {},
        is_default: makeDefault,
        removed_at: null,
        created_at: now,
      });
    });
    this.core.publish('payments.method.saved', { customerId, methodId: saved.id, brand: saved.brand }, by);
    return saved;
  }

  async save(customerId: string, body: { setupToken: string; label?: string | null; billingAddressId?: string | null; billingAddress?: common.Address | null; makeDefault?: boolean | null }, by: By): Promise<SavedPaymentMethod> {
    if (!body.setupToken?.trim()) throw this.core.error('PAYMENT_METHOD_INVALID', 'Add the card again.');
    const billing = await this.billing(customerId, body);
    let found: { methodId: string; card: CardDetails } | null;
    try {
      found = await this.core.call('setup', {}, () => this.core.provider.confirmSetup(body.setupToken.trim()), (r) => ({ outcome: r ? 'ok' : 'declined', providerRef: r?.methodId ?? null }));
    } catch (err) {
      return this.core.unavailable(err);
    }
    if (!found) throw this.core.error('PAYMENT_METHOD_INVALID', 'The card could not be confirmed. Add it again.');
    const saved = await this.store(customerId, found, { label: body.label, billing, makeDefault: body.makeDefault }, by);
    return this.views.savedMethod(saved, this.core.today());
  }

  /** Save for later at checkout (after the authorization succeeded); a failure never fails the payment */
  async saveForLater(customerId: string, token: string, label: string | null, billing: common.Address | null): Promise<void> {
    try {
      const found = await this.core.call('setup', {}, () => this.core.provider.attachToken(token, customerId), (r) => ({ outcome: r ? 'ok' : 'declined', providerRef: r?.methodId ?? null }));
      if (found) await this.store(customerId, found, { label, billing: billing ?? undefined }, { actor: { kind: 'customer', id: customerId } });
    } catch (err) {
      this.core.ctx.log.warn({ err }, 'payments: card could not be saved for later');
    }
  }

  async update(customerId: string, methodId: string, body: { label?: string | null; billingAddressId?: string | null; billingAddress?: common.Address | null; expMonth?: number | null; expYear?: number | null }): Promise<SavedPaymentMethod> {
    const m = await this.own(customerId, methodId);
    const patch: Partial<SavedMethodRec> = {};
    if (body.label !== undefined && body.label !== null) {
      if (!body.label.trim()) throw invalid([{ path: 'label', message: 'Give the card a name' }]);
      patch.label = body.label.trim().slice(0, 80);
    }
    const billing = await this.billing(customerId, body);
    if (billing) patch.billing_address = billing;
    if (body.expMonth != null || body.expYear != null) {
      const month = body.expMonth ?? m.exp_month;
      const year = body.expYear ?? m.exp_year;
      if (!validExpiry(month, year)) throw this.core.error('PAYMENT_METHOD_INVALID', 'Enter a valid expiry date.');
      if (isExpired(month, year, this.core.today())) throw this.core.error('PAYMENT_METHOD_INVALID', 'That expiry date has passed.');
      patch.exp_month = month;
      patch.exp_year = year;
    }
    const after = Object.keys(patch).length ? await this.repo.update('saved_methods', m.id, patch) : m;
    return this.views.savedMethod(after, this.core.today());
  }

  async makeDefault(customerId: string, methodId: string): Promise<SavedPaymentMethod> {
    const m = await this.own(customerId, methodId);
    if (isExpired(m.exp_month, m.exp_year, this.core.today())) throw this.core.error('PAYMENT_METHOD_EXPIRED');
    const after = await this.repo.transaction(async (tx) => {
      await tx.updateWhere('saved_methods', { customer_id: customerId, removed_at: null, is_default: true }, { is_default: false });
      return tx.update('saved_methods', m.id, { is_default: true });
    });
    return this.views.savedMethod(after, this.core.today());
  }

  async remove(customerId: string, methodId: string, by: By): Promise<void> {
    const m = await this.own(customerId, methodId);
    try {
      await this.core.call('detach', {}, () => this.core.provider.detach(m.provider_method_id), () => ({ outcome: 'ok', providerRef: m.provider_method_id }));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      // removed for the customer now; the token is unusable without the customer and detaching is retried by support
      this.core.ctx.log.warn({ err, methodId }, 'payments: card removed but not detached at the provider');
    }
    await this.repo.transaction(async (tx) => {
      const x = (await tx.get('saved_methods', m.id, { forUpdate: true }))!;
      if (x.removed_at) return;
      await tx.update('saved_methods', x.id, { removed_at: this.core.now(), is_default: false });
      if (x.is_default) {
        const next = (await tx.find('saved_methods', { customer_id: customerId, removed_at: null }, { orderBy: [['created_at', 'desc']] })).find((y) => !isExpired(y.exp_month, y.exp_year, this.core.today()));
        if (next) await tx.update('saved_methods', next.id, { is_default: true });
      }
    });
    this.core.publish('payments.method.removed', { customerId, methodId: m.id }, by);
  }

  /** method.updated webhook and the card updater: new expiry (or last 4) for a saved method */
  async applyCardUpdate(provider: string, u: { methodId: string; expMonth: number; expYear: number; last4?: string | null }): Promise<boolean> {
    if (!validExpiry(u.expMonth, u.expYear)) return false;
    const rows = await this.repo.find('saved_methods', { provider, provider_method_id: u.methodId, removed_at: null });
    for (const m of rows) await this.repo.update('saved_methods', m.id, { exp_month: u.expMonth, exp_year: u.expYear, ...(u.last4 && /^\d{4}$/.test(u.last4) ? { last4: u.last4 } : {}) });
    return rows.length > 0;
  }

  /**
   * payments.card-expiry: provider card-updater results first; a default card that stays expired stops being
   * the default (another valid card takes over), so checkout never preselects an expired card.
   */
  async cardExpiry(): Promise<void> {
    const today = this.core.today();
    let after: string | null = null;
    for (;;) {
      const batch: SavedMethodRec[] = await this.repo.find('saved_methods', { removed_at: null, provider: this.core.provider.code, ...(after ? { id: { op: '>', value: after } } : {}) }, { orderBy: [['id', 'asc']], limit: 200 });
      if (!batch.length) break;
      after = batch.at(-1)!.id;
      try {
        const updates = await this.core.provider.cardUpdates(batch.map((m) => m.provider_method_id));
        for (const u of updates) await this.applyCardUpdate(this.core.provider.code, u);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        this.core.ctx.log.warn({ err }, 'payments: card updater unavailable');
      }
      if (batch.length < 200) break;
    }
    const defaults = await this.repo.find('saved_methods', { removed_at: null, is_default: true });
    for (const d of defaults) {
      if (!isExpired(d.exp_month, d.exp_year, today)) continue;
      const next = (await this.active(d.customer_id)).find((m) => m.id !== d.id && !isExpired(m.exp_month, m.exp_year, today));
      if (!next) continue;
      await this.repo.transaction(async (tx) => {
        await tx.update('saved_methods', d.id, { is_default: false });
        await tx.update('saved_methods', next.id, { is_default: true });
      });
    }
  }
}
