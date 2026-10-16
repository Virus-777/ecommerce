/**
 * Revalidation before charging (plan scenario 2): price, stock, purchase limits, shippability, delivery
 * options and discounts are checked again. Each difference becomes one Change with choices; nothing
 * changes until the customer decides every change. Alternatives from other offers are only listed,
 * never switched automatically.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as offers from '../../../spec/offers.js';
import type * as shipping from '../../../spec/shipping.js';
import type { AlternativeOffer, Change, ChangeDecision, ChangeSet, CheckoutView, RevalidationResult } from '../../../spec/checkout.js';
import { checkoutSessionMachine } from '../domain/state-machines.js';
import { FULFILMENT_LABEL, HEADLINES, OFFICIAL_SELLER, choicesFor, fmt, isoDay, packageKey, plural, shippingOf, type StoredChange, type StoredChangeSet, type StoredQuote } from '../domain/rules.js';
import type { ChangeSetRow, LineRow, Owner, SessionRow } from '../ports.js';
import type { By, Core } from './core.js';
import { included, type Draft, type OfferFacts, type Quoter } from './quote.js';
import type { Views } from './views.js';

export interface Detection {
  items: StoredChange[];
  /** The session with fresh coverage, delivery options and discounts, before any choice */
  fresh: Draft;
  previousTotal: number;
  newTotal: number;
  deltas: { label: string; amount: number }[];
  partialOrder: boolean;
}

const clone = <T>(v: T): T => structuredClone(v);

export function cloneDraft(d: Draft): Draft {
  return { session: d.session, address: d.address ? { ...d.address } : null, lines: d.lines.map((l) => ({ ...l })), packages: new Map([...d.packages].map(([k, p]) => [k, { ...p }])), quote: clone(d.quote), couponCodes: [...d.couponCodes], credit: d.credit ? { ...d.credit } : null };
}

export class Revalidator {
  constructor(
    private readonly core: Core,
    private readonly quoter: Quoter,
    private readonly views: Views,
  ) {}

  private get ctx() {
    return this.core.ctx;
  }

  /* ================================================================ alternatives */

  alternative(v: offers.OfferView, line: LineRow): AlternativeOffer {
    const official = v.seller.official;
    const seller = official ? OFFICIAL_SELLER : { ownerType: 'seller' as const, id: v.seller.sellerId ?? null, name: v.seller.name, slug: v.seller.storeSlug ?? '', official: false, verified: v.seller.verified, logo: null };
    const differentSeller = official ? line.owner_type !== 'official' : (v.seller.sellerId ?? null) !== line.seller_id;
    return {
      offerId: v.offerId,
      seller,
      conditionLabel: v.conditionLabel,
      price: v.price,
      shipping: v.delivery.free ? { amount: 0, currency: v.price.currency } : (v.delivery.shippingCost ?? null),
      arrivalLabel: v.delivery.label,
      available: v.availability.maxPerOrder,
      returnTerms: v.returns.summary,
      differentSeller,
      note: differentSeller ? 'Different seller. Only switched if you pick this.' : 'Another offer from the same seller. Only switched if you pick this.',
    };
  }

  private alternativesFor(line: LineRow, facts: OfferFacts | undefined, fromOffers: offers.OfferView[]): AlternativeOffer[] {
    const seen = new Set<string>([line.offer_id]);
    const out: AlternativeOffer[] = [];
    for (const v of [...fromOffers, ...(facts?.variantOffers ?? [])]) {
      if (seen.has(v.offerId) || v.status !== 'active' || v.availability.maxPerOrder < 1 || !v.delivery.shipsToLocation) continue;
      seen.add(v.offerId);
      out.push(this.alternative(v, line));
      if (out.length >= 3) break;
    }
    return out;
  }

  /* ================================================================ detection */

  async detect(session: SessionRow): Promise<Detection> {
    const cur = session.currency;
    const stored = await this.quoter.draftOf(session);
    const fresh = cloneDraft(stored);
    const lines = stored.lines.filter(included);
    // offer facts, stock and the offers' own check are independent reads: asked at the same time
    const [facts, availability, offerCheck] = await Promise.all([
      this.quoter.facts(lines.map((l) => ({ offerId: l.offer_id }))),
      lines.length ? this.ctx.use('inventory').getAvailability([...new Set(lines.map((l) => l.stock_item_id))]) : Promise.resolve({} as Record<string, { available: number }>),
      lines.length
        ? this.ctx.use('offers').revalidate(
            lines.map((l) => ({ offerId: l.offer_id, quantity: l.quantity, termsVersion: l.terms_version, price: { amount: l.unit_price, currency: cur } })),
            stored.address?.postalCode ?? '',
          )
        : Promise.resolve({ ok: true, changes: [] as offers.OfferChange[] }),
    ]);
    const purchased = await this.purchasedCounts(session, lines, facts);

    const items: StoredChange[] = [];
    const add = (kind: Change['kind'], line: LineRow | null, o: Partial<Change> & { previous: string; current: string }, apply: StoredChange['apply'] = {}, extra: { alternatives?: AlternativeOffer[]; otherOptions?: boolean } = {}) => {
      const info = line ? this.views.info(stored.quote, line.id) : null;
      const alternatives = extra.alternatives ?? [];
      const { choices, defaultChoice } = choicesFor(kind, { alternatives: alternatives.length > 0, otherOptions: extra.otherOptions ?? false });
      items.push({
        change: {
          id: newId(),
          kind,
          lineId: line?.id ?? null,
          packageKey: o.packageKey ?? line?.package_key ?? null,
          headline: HEADLINES[kind],
          title: o.title ?? info?.title ?? '',
          image: info?.image ?? null,
          sellerName: o.sellerName ?? info?.seller.name ?? '',
          previous: o.previous,
          current: o.current,
          previousAmount: o.previousAmount ?? null,
          currentAmount: o.currentAmount ?? null,
          availableQuantity: o.availableQuantity ?? null,
          detail: o.detail ?? null,
          alternatives,
          choices,
          defaultChoice,
          effectOnTotal: o.effectOnTotal ?? { amount: 0, currency: cur },
        },
        apply,
      });
    };

    // lines: offer ended, stock, limits, price
    const windowDays = Number(await this.ctx.settings.get('purchaseLimitWindowDays')) || 30;
    for (const l of lines) {
      const f = facts.get(l.offer_id);
      const offer = f?.offer ?? null;
      const fromOffers = offerCheck.changes.filter((c) => c.offerId === l.offer_id);
      const alts = () => this.alternativesFor(l, f, fromOffers.flatMap((c) => c.alternatives));
      const value = l.unit_price * l.quantity;
      const ended = !offer || offer.status === 'removed' || offer.status === 'paused' || offer.status === 'draft' || offer.status === 'ineligible' || fromOffers.some((c) => c.kind === 'removed' || c.kind === 'seller_restricted');
      if (ended) {
        const msg = fromOffers.find((c) => c.kind === 'removed' || c.kind === 'seller_restricted')?.message ?? 'This offer is no longer available.';
        add('offer_ended', l, { previous: 'Available', current: 'No longer available', detail: msg, effectOnTotal: { amount: -value, currency: cur } }, {}, { alternatives: alts() });
        continue;
      }
      const available = Math.max(0, availability[l.stock_item_id]?.available ?? (offer.status === 'out_of_stock' ? 0 : l.quantity));
      if (available < 1 || offer.status === 'out_of_stock') {
        add('out_of_stock', l, { previous: `${l.quantity} available`, current: 'Out of stock', availableQuantity: 0, effectOnTotal: { amount: -value, currency: cur } }, { available: 0, maxQuantity: 0 }, { alternatives: alts() });
        continue;
      }
      if (available < l.quantity) {
        add('quantity_reduced', l, { previous: `Quantity ${l.quantity}`, current: `Only ${available} available`, availableQuantity: available, detail: `${f?.info?.seller.name ?? 'The seller'} has ${plural(available, 'unit')} left.`, effectOnTotal: { amount: -(l.quantity - available) * l.unit_price, currency: cur } }, { available, maxQuantity: available }, { alternatives: alts() });
      } else if (offer.purchaseLimit) {
        const before = purchased.get(l.offer_id) ?? 0;
        const max = Math.max(0, offer.purchaseLimit - before);
        if (l.quantity > max) {
          add('purchase_limit', l, { previous: `Quantity ${l.quantity}`, current: max > 0 ? `Limit ${max} more` : 'Limit reached', availableQuantity: max, detail: `Limit ${offer.purchaseLimit} per customer${before ? ` in ${windowDays} days (you bought ${before} recently)` : ''}.`, effectOnTotal: { amount: -(l.quantity - max) * l.unit_price, currency: cur } }, { maxQuantity: max });
        }
      }
      if (offer.price.amount !== l.unit_price) {
        const up = offer.price.amount > l.unit_price;
        const qty = Math.min(l.quantity, available);
        add(up ? 'price_increased' : 'price_decreased', l, {
          previous: fmt(l.unit_price, cur),
          current: fmt(offer.price.amount, cur),
          previousAmount: { amount: l.unit_price, currency: cur },
          currentAmount: offer.price,
          detail: `${f?.info?.seller.name ?? 'The seller'} changed the price since you started checkout.`,
          effectOnTotal: { amount: (offer.price.amount - l.unit_price) * qty, currency: cur },
        }, { unitPrice: offer.price.amount }, { alternatives: up ? alts() : [] });
      }
      // return, warranty or dispatch terms changed since the line was quoted: the customer accepts the new terms
      // (the line moves to the current termsVersion and the order snapshots them) or removes the line
      // termsVersion moves on any customer-visible change, a price change included: a moved version is a terms change
      // when the return or dispatch terms differ from what was quoted, or when no price change explains it
      const termsChange = fromOffers.find((c) => c.kind === 'terms');
      const versionMoved = Boolean(termsChange) || offer.termsVersion > l.terms_version;
      const quoted = stored.quote.lineInfo[l.id];
      const now = f?.info;
      const termsDiffer =
        Boolean(quoted && now) &&
        (quoted!.returnTerms.summary !== now!.returnTerms.summary ||
          quoted!.returnTerms.windowDays !== now!.returnTerms.windowDays ||
          quoted!.returnTerms.returnShippingPaidBy !== now!.returnTerms.returnShippingPaidBy ||
          quoted!.dispatch.businessDays !== now!.dispatch.businessDays ||
          quoted!.dispatch.shipsFrom !== now!.dispatch.shipsFrom);
      // who ships it (Fulfilled by Marketly started or stopped): always a terms change, the package and delivery move
      const fulfilledBy = shippingOf(offer).fulfilledBy;
      if (fulfilledBy !== l.fulfilled_by) {
        const sellerName = f?.info?.seller.name ?? 'The seller';
        add('terms_changed', l, {
          previous: FULFILMENT_LABEL[l.fulfilled_by],
          current: FULFILMENT_LABEL[fulfilledBy],
          detail:
            fulfilledBy === 'marketly_service'
              ? `Marketly now ships this item for ${sellerName}, with Marketly's delivery and dispatch terms.`
              : `${sellerName} now ships this item instead of Marketly, with the seller's delivery and dispatch terms.`,
        }, { termsVersion: Math.max(offer.termsVersion, l.terms_version), fulfilledBy }, { alternatives: alts() });
      } else if (versionMoved && (termsDiffer || offer.price.amount === l.unit_price)) {
        add('terms_changed', l, {
          previous: termsChange?.before ?? `Terms version ${l.terms_version}`,
          current: termsChange?.after ?? `Terms version ${offer.termsVersion}`,
          detail: termsChange?.message ?? `${f?.info?.seller.name ?? 'The seller'} changed the return, warranty or dispatch terms for this item.`,
        }, { termsVersion: Math.max(offer.termsVersion, l.terms_version) }, { alternatives: alts() });
      }
    }

    // shippability and delivery options on the fresh draft
    if (fresh.address) {
      await this.quoter.coverage(fresh);
      await this.quoter.shipping(fresh);
      for (const l of fresh.lines) {
        const before = stored.lines.find((x) => x.id === l.id);
        if (before?.status !== 'included' || l.status !== 'not_shippable' || items.some((i) => i.change.lineId === l.id && ['offer_ended', 'out_of_stock'].includes(i.change.kind))) continue;
        const s = fresh.quote.shippability[l.id];
        add('not_shippable', before, { previous: 'Ships to your address', current: s?.message ?? "Can't ship to this address", detail: s?.message ?? null, effectOnTotal: { amount: -before.unit_price * before.quantity, currency: cur } }, {}, { alternatives: this.alternativesFor(before, facts.get(before.offer_id), []) });
      }
      for (const [key, oldPkg] of stored.packages) {
        const prevOpt = oldPkg.selected_option as shipping.DeliveryOption | null;
        if (!prevOpt) continue;
        const pkg = fresh.packages.get(key);
        if (!pkg) continue; // every line of the package left (reported per line)
        const opts = (pkg.options ?? []) as unknown as shipping.DeliveryOption[];
        const now = opts.find((o) => o.id === prevOpt.id);
        const first = stored.lines.find((l) => l.package_key === key && l.status === 'included');
        const sellerName = first ? this.views.info(stored.quote, first.id).seller.name : '';
        const title = `${prevOpt.methodName} delivery`;
        const prevPrice = prevOpt.free ? 0 : prevOpt.price.amount;
        if (!now) {
          const def = opts.find((o) => o.id === pkg.selected_option_id) ?? null;
          add('delivery_option_unavailable', null, { packageKey: key, title, sellerName, previous: prevOpt.arrivalLabel, current: def ? `${def.methodName}: ${def.arrivalLabel}` : 'No delivery option', detail: def ? `${prevOpt.methodName} is no longer offered for this package.` : 'This package has no delivery option now.', effectOnTotal: { amount: (def ? (def.free ? 0 : def.price.amount) : 0) - prevPrice, currency: cur } }, { optionId: def?.id ?? null }, { otherOptions: opts.length > 0 });
          continue;
        }
        pkg.selected_option_id = now.id;
        pkg.selected_option = now as never;
        if (isoDay(now.arrival.to) !== isoDay(prevOpt.arrival.to)) {
          add('delivery_date_changed', null, { packageKey: key, title, sellerName, previous: prevOpt.arrivalLabel, current: now.arrivalLabel, detail: now.notices[0] ?? `${sellerName} now ships on a different date.` }, { optionId: now.id }, { otherOptions: opts.length > 1 });
        }
        const nowPrice = now.free ? 0 : now.price.amount;
        if (nowPrice !== prevPrice) {
          add('shipping_cost_changed', null, { packageKey: key, title, sellerName, previous: prevPrice ? fmt(prevPrice, cur) : 'Free', current: nowPrice ? fmt(nowPrice, cur) : 'Free', previousAmount: { amount: prevPrice, currency: cur }, currentAmount: { amount: nowPrice, currency: cur }, effectOnTotal: { amount: nowPrice - prevPrice, currency: cur } }, { optionId: now.id }, { otherOptions: opts.length > 1 });
        }
      }
    }

    // discounts: what the customer saw against a fresh evaluation at the prices they saw
    const freshQuote = await this.quoter.price(fresh);
    this.discountChanges(stored.quote, freshQuote, cur, add);
    fresh.quote = freshQuote;

    // the total with the default choices (a line that changes who ships it moves package: its delivery is quoted again)
    const withDefaults = cloneDraft(fresh);
    await this.apply(withDefaults, items, new Map(), facts);
    if (withDefaults.address && items.some((i) => i.apply.fulfilledBy)) await this.quoter.shipping(withDefaults);
    const defaultQuote = await this.quoter.price(withDefaults);
    const prev = stored.quote.totals;
    const next = defaultQuote.totals;
    const deltas = [
      { label: 'Items', amount: next.items.amount - prev.items.amount },
      { label: 'Discounts', amount: -(next.discountTotal.amount - prev.discountTotal.amount) },
      { label: 'Shipping', amount: next.shippingTotal.amount - prev.shippingTotal.amount },
      { label: 'Tax', amount: next.taxTotal.amount - prev.taxTotal.amount },
      { label: 'Store credit', amount: -(next.creditApplied.amount - prev.creditApplied.amount) },
    ].filter((d) => d.amount !== 0);
    // anything that moved the total without a named change (e.g. an automatic discount ended)
    if (!items.length && next.total.amount !== prev.total.amount) {
      add('coupon_amount_changed', null, { title: 'Discounts', previous: fmt(prev.total.amount, cur), current: fmt(next.total.amount, cur), previousAmount: prev.total, currentAmount: next.total, detail: 'Your total changed since you last saw it.', effectOnTotal: { amount: next.total.amount - prev.total.amount, currency: cur } });
    }
    const partialOrder = items.some((i) => ['out_of_stock', 'offer_ended', 'not_shippable'].includes(i.change.kind) || i.change.defaultChoice === 'remove');
    return { items, fresh, previousTotal: prev.total.amount, newTotal: next.total.amount, deltas, partialOrder };
  }

  private discountChanges(before: StoredQuote, after: StoredQuote, cur: string, add: (kind: Change['kind'], line: LineRow | null, o: Partial<Change> & { previous: string; current: string }, apply?: StoredChange['apply']) => void) {
    type D = { key: string; code: string | null; label: string; amount: number };
    const collect = (q: StoredQuote) => {
      const out = new Map<string, D>();
      for (const d of q.discounts) {
        const key = (d.code ?? d.label).toUpperCase();
        out.set(key, { key, code: d.code ?? null, label: d.label, amount: (out.get(key)?.amount ?? 0) + d.amount.amount });
      }
      // coupon codes without a line discount (free shipping)
      for (const c of q.coupons) if (c.status === 'applied' && c.amount && !out.has(c.code.toUpperCase())) out.set(c.code.toUpperCase(), { key: c.code.toUpperCase(), code: c.code, label: c.label, amount: c.amount.amount });
      return out;
    };
    const was = collect(before);
    const now = collect(after);
    for (const d of was.values()) {
      const n = now.get(d.key);
      const title = d.code ? `Coupon ${d.code}` : d.label;
      const couponCode = d.code ?? undefined;
      if (!n || n.amount === 0) {
        const reason = after.coupons.find((c) => c.code.toUpperCase() === d.key)?.reason ?? null;
        add('coupon_no_longer_applies', null, { title, sellerName: '', previous: `-${fmt(d.amount, cur)}`, current: 'No discount', previousAmount: { amount: d.amount, currency: cur }, currentAmount: { amount: 0, currency: cur }, detail: reason ?? `${d.label} no longer applies to your order.`, effectOnTotal: { amount: d.amount, currency: cur } }, { couponCode });
      } else if (n.amount !== d.amount) {
        add('coupon_amount_changed', null, { title, sellerName: '', previous: `-${fmt(d.amount, cur)}`, current: `-${fmt(n.amount, cur)}`, previousAmount: { amount: d.amount, currency: cur }, currentAmount: { amount: n.amount, currency: cur }, detail: `${d.label} is worth a different amount now.`, effectOnTotal: { amount: d.amount - n.amount, currency: cur } }, { couponCode });
      }
    }
  }

  private async purchasedCounts(session: SessionRow, lines: LineRow[], facts: Map<string, OfferFacts>): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!session.customer_id) return out;
    const days = Number(await this.ctx.settings.get('purchaseLimitWindowDays')) || 30;
    const limited = lines.filter((l) => facts.get(l.offer_id)?.offer?.purchaseLimit);
    await Promise.all(limited.map(async (l) => out.set(l.offer_id, await this.ctx.use('orders').countPurchased(session.customer_id!, l.offer_id, days))));
    return out;
  }

  /* ================================================================ applying choices */

  /**
   * Applies a choice per change to the draft (the default choice where none is given).
   * Returns how many lines were removed and offers switched.
   */
  async apply(d: Draft, items: StoredChange[], decisions: Map<string, ChangeDecision>, facts: Map<string, OfferFacts>): Promise<{ removed: number; switched: number }> {
    let removed = 0;
    let switched = 0;
    for (const { change, apply } of items) {
      const dec = decisions.get(change.id);
      const choice = dec?.choice ?? change.defaultChoice;
      const line = change.lineId ? d.lines.find((l) => l.id === change.lineId) : undefined;
      const pkg = change.packageKey ? d.packages.get(change.packageKey) : undefined;
      switch (choice) {
        case 'accept':
          if (line && apply.unitPrice !== undefined) {
            line.unit_price = apply.unitPrice;
            const offer = facts.get(line.offer_id)?.offer;
            if (offer) line.terms_version = offer.termsVersion;
          }
          if (line && apply.termsVersion !== undefined) line.terms_version = Math.max(line.terms_version, apply.termsVersion);
          if (line && apply.fulfilledBy) this.refulfil(d, line, facts.get(line.offer_id));
          if (pkg && apply.optionId) pkg.selected_option_id = apply.optionId;
          break;
        case 'remove':
          if (line) {
            if (line.status === 'included' || line.status === 'not_shippable') removed++;
            line.status = 'removed';
          } else if (change.packageKey) {
            for (const l of d.lines.filter((x) => x.package_key === change.packageKey && x.status === 'included')) {
              l.status = 'removed';
              removed++;
            }
          }
          break;
        case 'reduce_quantity': {
          if (!line) break;
          const max = apply.maxQuantity ?? apply.available ?? line.quantity;
          if (dec?.quantity !== undefined && dec.quantity !== null && (dec.quantity < 1 || dec.quantity > max)) {
            throw new AppError('VALIDATION_FAILED', `Choose a quantity from 1 to ${max}`, { issues: [{ path: `decisions.${change.id}.quantity`, message: `1 to ${max}` }] });
          }
          const qty = Math.min(dec?.quantity ?? max, max);
          if (qty < 1) {
            line.status = 'removed';
            removed++;
          } else line.quantity = qty;
          break;
        }
        case 'choose_offer': {
          if (!line) break;
          const offerId = dec?.offerId;
          if (!offerId || !change.alternatives.some((a) => a.offerId === offerId)) throw this.core.error('OFFER_UNAVAILABLE', 'Choose one of the offers listed for this item', { reason: 'not_listed', offerId: offerId ?? null });
          const f = (await this.quoter.facts([{ offerId }])).get(offerId);
          const offer = f?.offer;
          if (!offer || offer.status !== 'active') throw this.core.error('OFFER_UNAVAILABLE', 'That offer is no longer available', { reason: 'not_active', offerId });
          const avail = (await this.ctx.use('inventory').getAvailability([offer.stockItemId]))[offer.stockItemId]?.available ?? 0;
          if (avail < line.quantity) throw this.core.error('OFFER_UNAVAILABLE', avail > 0 ? `Only ${avail} available from ${offer.sellerName}` : `${offer.sellerName} is out of stock`, { reason: 'not_enough_stock', offerId, available: avail });
          const replacement = this.quoter.lineFrom(d.session.id, offer, line.quantity, line.cart_item_id);
          if (f?.info) d.quote.lineInfo[replacement.id] = f.info;
          line.status = 'removed';
          const dup = d.lines.find((l) => l.offer_id === offer.id && l.status === 'included');
          if (dup) dup.quantity += line.quantity;
          else d.lines.push(replacement);
          switched++;
          break;
        }
        case 'keep_without_discount':
          if (apply.couponCode) d.couponCodes = d.couponCodes.filter((c) => c.toUpperCase() !== apply.couponCode!.toUpperCase());
          break;
        case 'choose_other_option': {
          if (!pkg) break;
          const opts = (pkg.options ?? []) as unknown as shipping.DeliveryOption[];
          const pick = dec?.optionId ? opts.find((o) => o.id === dec.optionId) : (opts.find((o) => o.id === apply.optionId) ?? opts.find((o) => o.isDefault) ?? opts[0]);
          if (!pick) throw this.core.error('DELIVERY_OPTION_UNAVAILABLE', 'Choose one of the delivery options listed for this package', { packageKey: change.packageKey, options: opts });
          pkg.selected_option_id = pick.id;
          pkg.selected_option = pick as never;
          break;
        }
      }
    }
    return { removed, switched };
  }

  /**
   * The customer accepted a change of who ships the line: it takes the offer's current fulfilment, profile, dispatch
   * and ships-from (Offer.shipping) and moves to that package; the delivery options are quoted again on save.
   */
  private refulfil(d: Draft, line: LineRow, f: OfferFacts | undefined) {
    if (!f?.offer) return;
    const shipping = shippingOf(f.offer);
    line.fulfilled_by = shipping.fulfilledBy;
    line.profile_id = shipping.profileId;
    line.package_key = packageKey(line.owner_type, line.seller_id, shipping.fulfilledBy, shipping.dispatch.shipsFrom);
    if (f.info) d.quote.lineInfo[line.id] = f.info;
  }

  /* ================================================================ endpoints */

  /** Saves a change set and moves the session to changes_pending */
  async record(session: SessionRow, det: Detection, by: By): Promise<{ session: SessionRow; changeSet: ChangeSetRow }> {
    const now = this.core.now();
    const body: StoredChangeSet = { items: det.items, deltas: det.deltas, partialOrder: det.partialOrder, currency: session.currency };
    const out = await this.core.repo.transaction(async (tx) => {
      const locked = (await tx.getSession(session.id, { forUpdate: true }))!;
      const status = locked.status === 'changes_pending' ? 'changes_pending' : checkoutSessionMachine.next(locked.status as 'open', 'changes_found');
      await tx.supersedeOpenChangeSets(session.id);
      const changeSet = await tx.insertChangeSet({ id: newId(), session_id: session.id, status: 'open', changes: body as never, previous_total: det.previousTotal, new_total: det.newTotal, decisions: null, created_at: now, decided_at: null });
      const s = await tx.updateSession(session.id, { status, updated_at: now });
      return { session: s, changeSet };
    });
    await this.core.log(session.id, 'Changes found', det.items.map((i) => `${i.change.headline}: ${i.change.title}`).join('; '));
    this.core.publish('checkout.changes.detected', { sessionId: session.id, changeSetId: out.changeSet.id, kinds: [...new Set(det.items.map((i) => i.change.kind))], previousTotal: { amount: det.previousTotal, currency: session.currency }, newTotal: { amount: det.newTotal, currency: session.currency } }, by);
    return out;
  }

  /** No differences: keep the fresh delivery options and promotion evaluation (the total is unchanged) */
  async refresh(det: Detection, allowed: string[]): Promise<SessionRow> {
    return this.quoter.save(det.fresh, det.fresh.quote, allowed, {});
  }

  async revalidate(owner: Owner | null, id: string, by: By, view: (s: SessionRow) => Promise<CheckoutView>): Promise<RevalidationResult> {
    const session = await this.core.load(owner, id);
    if (session.status === 'changes_pending') {
      const open = await this.core.repo.openChangeSet(id);
      if (open) return { outcome: 'changes_found', changeSet: this.views.changeSet(open), checkout: await view(session) };
    }
    if (session.status !== 'open' && session.status !== 'changes_pending') {
      throw new AppError('ILLEGAL_TRANSITION', 'This checkout can no longer be checked again', { machine: 'Checkout session', from: session.status, event: 'changes_found', allowed: checkoutSessionMachine.eventsFrom(session.status as 'open') });
    }
    const det = await this.detect(session);
    if (!det.items.length) {
      const saved = await this.refresh(det, ['open', 'changes_pending']);
      return { outcome: 'no_changes', changeSet: null, checkout: await view(saved) };
    }
    const r = await this.record(session, det, by);
    return { outcome: 'changes_found', changeSet: this.views.changeSet(r.changeSet), checkout: await view(r.session) };
  }

  async getChangeSet(owner: Owner | null, id: string, changeSetId: string): Promise<ChangeSet> {
    await this.core.load(owner, id);
    const row = await this.core.repo.getChangeSet(id, changeSetId);
    if (!row) throw this.core.notFound('Change set');
    return this.views.changeSet(row);
  }

  async accept(owner: Owner | null, id: string, changeSetId: string, input: { decisions: ChangeDecision[]; acceptPartialOrder: boolean }, by: By): Promise<SessionRow> {
    const session = await this.core.load(owner, id);
    const row = await this.core.repo.getChangeSet(id, changeSetId);
    if (!row) throw this.core.notFound('Change set');
    const latest = await this.core.repo.latestChangeSet(id);
    if (row.status !== 'open' || latest?.id !== row.id) throw this.core.error('CHANGESET_STALE', 'A newer check replaced these changes. Review the latest ones.', { latestChangeSetId: latest?.id ?? null });
    if (session.status !== 'changes_pending') checkoutSessionMachine.next(session.status as 'open', 'accept_changes');
    const stored = row.changes as unknown as StoredChangeSet;
    const decisions = new Map(input.decisions.map((d) => [d.changeId, d]));
    const missing = stored.items.filter((i) => !decisions.has(i.change.id)).map((i) => i.change.id);
    if (missing.length) throw this.core.error('DECISION_MISSING', `Choose what to do for ${plural(missing.length, 'change')}`, { changeIds: missing });
    const unknown = input.decisions.filter((d) => !stored.items.some((i) => i.change.id === d.changeId));
    const bad = stored.items.filter((i) => !i.change.choices.includes(decisions.get(i.change.id)!.choice));
    if (unknown.length || bad.length) {
      throw new AppError('VALIDATION_FAILED', 'Some choices are not offered for these changes', {
        issues: [...unknown.map((d) => ({ path: `decisions.${d.changeId}`, message: 'Not a change of this set' })), ...bad.map((i) => ({ path: `decisions.${i.change.id}.choice`, message: `Choose one of: ${i.change.choices.join(', ')}` }))],
      });
    }

    const d = await this.quoter.draftOf(session);
    const facts = await this.quoter.facts(d.lines.filter(included).map((l) => ({ offerId: l.offer_id })));
    const { removed, switched } = await this.apply(d, stored.items, decisions, facts);
    const unavailable = stored.items.some((i) => ['out_of_stock', 'offer_ended', 'not_shippable'].includes(i.change.kind) && decisions.get(i.change.id)!.choice !== 'choose_offer');
    const partial = removed > 0 || unavailable;
    if (partial && !input.acceptPartialOrder) {
      throw this.core.error('PARTIAL_ORDER_NOT_ACCEPTED', "Some items won't be bought. Confirm you want the rest of your order and its new total.", { removedLines: removed });
    }
    // facts of switched-in offers were added by apply(); the rest keep their stored facts
    const saved = await this.quoter.requote(d, {
      coverage: true,
      shipping: true,
      allowed: ['changes_pending'],
      patch: { status: checkoutSessionMachine.next('changes_pending', 'accept_changes') },
    });
    await this.core.repo.updateChangeSet(row.id, { status: 'accepted', decisions: input.decisions as never, decided_at: this.core.now() });
    await this.core.log(id, 'Changes accepted', `${plural(stored.items.length, 'change')}; ${removed} removed, ${switched} switched`);
    this.core.publish('checkout.changes.accepted', { sessionId: id, changeSetId: row.id, removedLines: removed, switchedOffers: switched, partialOrder: partial }, by);
    return saved;
  }
}

export const isStockError = (err: unknown) => isAppError(err) && err.code === 'INSUFFICIENT_STOCK';
