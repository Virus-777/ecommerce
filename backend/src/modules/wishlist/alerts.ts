/**
 * Alert evaluation: price drops (offers price events, campaign prices in the job) and back in stock (inventory and
 * offers status events). One notice per alert per alertCooldownHours; price-drop alerts rearm on their own once
 * the cooldown has passed, with the notified price as the new reference, so the same drop never fires twice.
 * Alerts are promotional: a customer who turned wishlist alerts off gets their alerts paused instead of a notice.
 */
import type { ModuleContext } from '../../kernel/module-system/index.js';
import { money } from '../../kernel/lib/money.js';
import type * as common from '../../spec/common.js';
import { wishlistAlertMachine } from './domain/state-machines.js';
import { dropMet, inCooldown, PAUSED } from './domain/rules.js';
import type { AlertCandidate, AlertRow, WishlistRepository } from './ports.js';
import { Lookups } from './views.js';

const SYSTEM = { actor: { kind: 'system' as const, id: 'wishlist', name: 'Wishlist' } };
const BATCH = 500;

/** Where a price or stock change happened */
export interface Change {
  productId: string;
  variantId: string;
  offerId: string;
  sellerId: string | null;
}

/** Whether a change concerns an alert: a saved offer is followed exactly; else the alert's variant and seller limits apply */
export function concerns(a: AlertCandidate, c: Change): boolean {
  if (a.variant_id && a.variant_id !== c.variantId) return false;
  if (a.item_offer_id) return a.item_offer_id === c.offerId;
  if (a.seller_id) return a.seller_id === c.sellerId;
  return true;
}

export class AlertEngine {
  constructor(
    private readonly ctx: ModuleContext<'wishlist'>,
    private readonly repo: WishlistRepository,
  ) {}

  private now() {
    return this.ctx.clock.now();
  }

  /** wishlistAlerts consent per customer (customers decides; unknown customers have none) */
  async consents(customerIds: string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    const customers = this.ctx.use('customers');
    await Promise.all(
      [...new Set(customerIds)].map(async (id) => {
        try {
          out.set(id, (await customers.getMarketingConsent(id)).wishlistAlerts);
        } catch (err) {
          this.ctx.log.debug({ err, customerId: id }, 'wishlist: no marketing consent for customer');
          out.set(id, false);
        }
      }),
    );
    return out;
  }

  /**
   * Fires alerts whose condition is met: each alert is locked and re-checked (state, cooldown, condition), so a
   * repeated event or a job run racing an event never sends a second notice. Publishes after each commit.
   */
  async fire(alerts: AlertCandidate[], at: { change: Change | null; price: common.Money | null; recheck: (a: AlertRow) => boolean }): Promise<number> {
    if (!alerts.length) return 0;
    const [cooldown, consent] = await Promise.all([this.ctx.settings.get('alertCooldownHours'), this.consents(alerts.map((a) => a.customer_id))]);
    let fired = 0;
    for (const candidate of alerts) {
      const now = this.now();
      const result = await this.repo.transaction(async (tx) => {
        const a = await tx.getAlertById(candidate.id, { forUpdate: true });
        if (!a || a.state !== 'active' || inCooldown(a.last_notified_at, now, cooldown) || !at.recheck(a)) return null;
        if (!consent.get(a.customer_id)) {
          await tx.updateAlert(a.id, { state: wishlistAlertMachine.next('active', 'pause'), paused_reason: PAUSED.preferencesOff });
          return null;
        }
        const after = await tx.updateAlert(a.id, {
          state: wishlistAlertMachine.next('active', 'trigger'),
          triggered_at: now,
          triggered_price: at.price?.amount ?? null,
          last_notified_at: now,
          paused_reason: null,
        });
        return { before: a, after };
      });
      if (!result) continue;
      fired++;
      const cur = at.price?.currency ?? this.ctx.config.market.currency;
      this.ctx.events.publish(
        'wishlist.alert.triggered',
        {
          alertId: result.after.id,
          customerId: result.after.customer_id,
          kind: result.after.kind,
          productId: result.after.product_id,
          offerId: at.change?.offerId || null,
          price: at.price,
          previousPrice: result.after.kind === 'price_drop' && result.before.reference_price !== null ? money(result.before.reference_price, cur) : null,
        },
        SYSTEM,
      );
    }
    return fired;
  }

  /** A price changed (offers event or job): price-drop alerts the change concerns */
  async priceChanged(change: Change, price: common.Money, candidates?: AlertCandidate[]): Promise<number> {
    const all = candidates ?? (await this.repo.candidates(change.productId, 'price_drop', ['active']));
    const minDrop = await this.ctx.settings.get('minDropPct');
    const met = (a: AlertRow) => dropMet(price.amount, a.reference_price, a.target_price, minDrop);
    const hits = all.filter((a) => concerns(a, change) && met(a));
    return this.fire(hits, { change, price, recheck: met });
  }

  /** Stock came back or an offer went live again: back-in-stock alerts the change concerns */
  async backInStock(change: Change, price: common.Money | null): Promise<number> {
    const all = await this.repo.candidates(change.productId, 'back_in_stock', ['active']);
    return this.fire(
      all.filter((a) => concerns(a, change)),
      { change, price, recheck: () => true },
    );
  }

  /* ---------------------------------------------------------------- the job */

  /** Price-drop alerts whose cooldown has passed are armed again, with the notified price as the reference */
  async rearmDue(): Promise<number> {
    const cooldown = await this.ctx.settings.get('alertCooldownHours');
    const before = new Date(this.now().getTime() - Math.max(0, cooldown) * 3_600_000);
    let n = 0;
    for (;;) {
      const due = await this.repo.dueForRearm(before, BATCH);
      if (!due.length) break;
      for (const a of due) {
        const done = await this.repo.transaction(async (tx) => {
          const locked = await tx.getAlertById(a.id, { forUpdate: true });
          if (!locked || locked.state !== 'triggered' || locked.kind !== 'price_drop') return false;
          await tx.updateAlert(a.id, { state: wishlistAlertMachine.next('triggered', 'rearm'), reference_price: locked.triggered_price ?? locked.reference_price });
          return true;
        });
        if (done) n++;
      }
      if (due.length < BATCH) break;
    }
    return n;
  }

  /** Alerts paused because wishlist alerts were off come back once the customer turns them on again */
  async resumeConsented(customerIds?: string[]): Promise<number> {
    let n = 0;
    const ids = customerIds ?? (await this.repo.customersPausedFor(PAUSED.preferencesOff, BATCH));
    if (!ids.length) return 0;
    const consent = await this.consents(ids);
    for (const id of ids) {
      if (!consent.get(id)) continue;
      for (const a of await this.repo.pausedFor(id, PAUSED.preferencesOff)) {
        await this.repo.transaction(async (tx) => {
          const locked = await tx.getAlertById(a.id, { forUpdate: true });
          if (!locked || locked.state !== 'paused' || locked.paused_reason !== PAUSED.preferencesOff) return;
          await tx.updateAlert(a.id, { state: wishlistAlertMachine.next('paused', 'resume'), paused_reason: null });
          n++;
        });
      }
    }
    return n;
  }

  /**
   * Every active price-drop alert against the price customers pay now (campaign prices included): catches drops
   * held back by the cooldown, markdowns that publish no offers event, and missed events. Batches by product.
   */
  async evaluatePrices(): Promise<number> {
    const offersApi = this.ctx.use('offers');
    let fired = 0;
    let after: string | null = null;
    for (;;) {
      const batch = await this.repo.activePriceAlertsAfter(after, BATCH);
      if (!batch.length) break;
      after = batch.at(-1)!.id;
      const byProduct = new Map<string, AlertCandidate[]>();
      for (const a of batch) byProduct.set(a.product_id, [...(byProduct.get(a.product_id) ?? []), a]);
      for (const [productId, alerts] of byProduct) {
        const lk = new Lookups(this.ctx);
        let summaries: { id: string; variantId: string }[] = [];
        try {
          summaries = await offersApi.listActiveOffersForProduct(productId);
        } catch (err) {
          this.ctx.log.warn({ err, productId }, 'wishlist: offers of a watched product could not be read');
          continue;
        }
        // saved offers of items may not be in the active list (paused or out of stock): they simply don't count now
        const changes: { change: Change; price: common.Money }[] = [];
        for (const s of summaries) {
          const offer = await lk.offer(s.id);
          if (!offer || offer.status !== 'active') continue;
          changes.push({ change: { productId, variantId: offer.variantId, offerId: offer.id, sellerId: offer.sellerId ?? null }, price: await lk.effectivePrice(offer.id, offer.price) });
        }
        if (!changes.length) continue;
        const minDrop = await this.ctx.settings.get('minDropPct');
        for (const a of alerts) {
          // the lowest price among the offers this alert follows
          const best = changes.filter((c) => concerns(a, c.change)).sort((x, y) => x.price.amount - y.price.amount)[0];
          if (!best || !dropMet(best.price.amount, a.reference_price, a.target_price, minDrop)) continue;
          fired += await this.fire([a], { change: best.change, price: best.price, recheck: (r) => dropMet(best.price.amount, r.reference_price, r.target_price, minDrop) });
        }
      }
      if (batch.length < BATCH) break;
    }
    return fired;
  }
}
