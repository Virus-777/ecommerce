/**
 * The customer's food basket: one restaurant's food at a time, lines merged when the item, its choices and its note
 * are the same, and prices, the delivery fee, the minimum order and what stops the order worked out on every read.
 */
import { newId } from '../../../kernel/lib/ids.js';
import { money, type Money } from '../../../kernel/lib/money.js';
import type * as payments from '../../../spec/payments.js';
import type { Basket, BasketLine, BasketLineInput, BasketLineUpdate, LineOptionInput } from '../../../spec/food.js';
import { checkChoices, choicesPriced, groupsOf, LIMITS, lineKey } from '../domain/rules.js';
import type { BasketRow, ItemRow, RestaurantRow, StoredLine } from '../ports.js';
import { invalid, notFound, optionalText, stringsOf } from './base.js';
import { FoodCatalog } from './catalog.js';

/** A stored line priced now: what it costs, whether it can be ordered, and the item behind it */
export interface PricedLine {
  stored: StoredLine;
  item: ItemRow | undefined;
  name: string;
  unitPrice: number;
  optionsLabel: string | null;
  available: boolean;
  problem: string | null;
}

/** The basket priced now, with its restaurant row (when it holds anything) */
export interface PricedBasket {
  basket: Basket;
  restaurant: RestaurantRow | undefined;
  lines: PricedLine[];
}

const linesOf = (v: unknown): StoredLine[] =>
  (Array.isArray(v) ? (v as StoredLine[]) : [])
    .filter((l) => l && typeof l.id === 'string' && typeof l.itemId === 'string' && Number.isInteger(l.quantity))
    .map((l) => ({ id: l.id, itemId: l.itemId, quantity: l.quantity, options: Array.isArray(l.options) ? l.options.map((o) => ({ groupId: o.groupId, choiceIds: stringsOf(o.choiceIds) })) : [], note: l.note ?? null, name: l.name ?? '', unitPrice: Number(l.unitPrice ?? 0) }));

export class FoodBasket extends FoodCatalog {
  private emptyBasket(): Basket {
    const zero = money(0, this.currency);
    return { restaurant: null, lines: [], itemCount: 0, subtotal: zero, deliveryFee: zero, total: zero, minOrder: null, missingForMinimum: null, canOrder: false, problems: [] };
  }

  /** The basket priced now (empty when it holds nothing or its restaurant is gone) */
  protected async pricedBasket(customerId: string): Promise<PricedBasket> {
    const row = await this.repo.basketOf(customerId);
    const stored = linesOf(row?.lines);
    const restaurant = row?.restaurant_id && stored.length ? await this.repo.getRestaurant(row.restaurant_id) : undefined;
    if (!restaurant) return { basket: this.emptyBasket(), restaurant: undefined, lines: [] };
    const items = new Map((await this.repo.itemsByIds([...new Set(stored.map((l) => l.itemId))])).map((i) => [i.id, i]));
    const lines = stored.map((l) => this.priceLine(l, items.get(l.itemId), restaurant.id));
    const refs = await this.refsMap([restaurant.image_id, restaurant.logo_id, ...lines.map((l) => (l.item ? stringsOf(l.item.photo_ids)[0] : null))]);
    const cur = restaurant.currency;
    const subtotal = lines.filter((l) => l.available).reduce((s, l) => s + l.unitPrice * l.stored.quantity, 0);
    const free = restaurant.free_delivery_over != null && subtotal >= restaurant.free_delivery_over;
    const fee = free ? 0 : restaurant.delivery_fee;
    const missing = restaurant.min_order != null && subtotal < restaurant.min_order ? restaurant.min_order - subtotal : 0;
    const problems: string[] = [];
    const state = this.openState(restaurant);
    if (restaurant.status !== 'published') problems.push(`${restaurant.name} isn't taking orders now`);
    else if (!state.open) problems.push(`${restaurant.name} is closed now${state.opensLabel ? ` · ${state.opensLabel}` : ''}`);
    for (const l of lines) if (l.problem && !problems.includes(l.problem)) problems.push(l.problem);
    const out: BasketLine[] = lines.map((l) => {
      const photo = l.item ? stringsOf(l.item.photo_ids)[0] : null;
      return {
        id: l.stored.id,
        itemId: l.stored.itemId,
        name: l.name,
        image: photo ? (refs.get(photo) ?? null) : null,
        optionsLabel: l.optionsLabel,
        options: l.stored.options,
        note: l.stored.note,
        unitPrice: money(l.unitPrice, cur),
        quantity: l.stored.quantity,
        total: money(l.unitPrice * l.stored.quantity, cur),
        available: l.available,
      };
    });
    return {
      restaurant,
      lines,
      basket: {
        restaurant: this.restaurantCard(restaurant, refs),
        lines: out,
        itemCount: lines.reduce((s, l) => s + l.stored.quantity, 0),
        subtotal: money(subtotal, cur),
        deliveryFee: money(fee, cur),
        total: money(subtotal + fee, cur),
        minOrder: restaurant.min_order == null ? null : money(restaurant.min_order, cur),
        missingForMinimum: missing > 0 ? money(missing, cur) : null,
        canOrder: problems.length === 0 && missing === 0 && lines.length > 0,
        problems,
      },
    };
  }

  /** A stored line against the menu now: the item's price plus its choices, or why it can't be ordered */
  private priceLine(l: StoredLine, item: ItemRow | undefined, restaurantId: string): PricedLine {
    if (!item || item.restaurant_id !== restaurantId || !item.available) {
      const name = item?.name ?? l.name;
      return { stored: l, item, name, unitPrice: l.unitPrice, optionsLabel: null, available: false, problem: `${name} is no longer available` };
    }
    const groups = groupsOf(item.option_groups, item.currency);
    const checked = checkChoices(groups, l.options);
    const priced = choicesPriced(groups, l.options);
    if ('problem' in checked) return { stored: l, item, name: item.name, unitPrice: item.price + priced.delta, optionsLabel: priced.label, available: false, problem: `${item.name} changed on the menu; add it again` };
    return { stored: l, item, name: item.name, unitPrice: item.price + priced.delta, optionsLabel: priced.label, available: true, problem: null };
  }

  async getBasket(customerId: string): Promise<Basket> {
    return (await this.pricedBasket(customerId)).basket;
  }

  private checkQuantity(q: number, path = 'quantity') {
    if (!Number.isInteger(q) || q < 1 || q > LIMITS.maxQuantity) throw invalid(path, `Use 1 to ${LIMITS.maxQuantity}`);
  }

  /** Lines with the same item, choices and note added together (at most 20 of one) */
  private merged(lines: StoredLine[]): StoredLine[] {
    const out: StoredLine[] = [];
    for (const l of lines) {
      const same = out.find((x) => lineKey(x.itemId, x.options, x.note) === lineKey(l.itemId, l.options, l.note));
      if (!same) {
        out.push({ ...l });
        continue;
      }
      same.quantity += l.quantity;
      if (same.quantity > LIMITS.maxQuantity) throw invalid('quantity', `You can add at most ${LIMITS.maxQuantity} of one item`);
    }
    return out;
  }

  private async saveLines(customerId: string, before: BasketRow | undefined, restaurantId: string | null, lines: StoredLine[], tx = this.repo) {
    await tx.saveBasket({ id: before?.id ?? newId(), customer_id: customerId, restaurant_id: lines.length ? restaurantId : null, lines: lines as never, updated_at: this.now() });
  }

  async addToBasket(customerId: string, input: BasketLineInput): Promise<Basket> {
    this.checkQuantity(input.quantity);
    const note = optionalText(input.note, 'note', LIMITS.note);
    const item = await this.repo.getItem(input.itemId);
    if (!item) throw notFound('Menu item');
    const restaurant = await this.repo.getRestaurant(item.restaurant_id);
    if (!restaurant || restaurant.status !== 'published') throw this.ctx.error('RESTAURANT_UNAVAILABLE', `${restaurant?.name ?? 'This restaurant'} isn't taking orders now.`);
    if (!item.available) throw this.ctx.error('ITEM_UNAVAILABLE', `${item.name} is no longer available.`, { itemIds: [item.id] });
    const groups = groupsOf(item.option_groups, item.currency);
    const checked = checkChoices(groups, input.options);
    if ('problem' in checked) throw this.ctx.error('OPTIONS_INVALID', checked.problem.message, { groupId: checked.problem.groupId });
    const options: LineOptionInput[] = checked.options;
    const unitPrice = item.price + choicesPriced(groups, options).delta;
    await this.repo.transaction(async (tx) => {
      const row = await tx.basketOf(customerId, { forUpdate: true });
      let lines = linesOf(row?.lines);
      if (lines.length && row?.restaurant_id && row.restaurant_id !== restaurant.id) {
        const other = await tx.getRestaurant(row.restaurant_id);
        if (other && !input.replace) throw this.ctx.error('OTHER_RESTAURANT', `Your basket has food from ${other.name}.`, { restaurantName: other.name });
        lines = [];
      }
      lines = this.merged([...lines, { id: newId(), itemId: item.id, quantity: input.quantity, options, note, name: item.name, unitPrice }]);
      await this.saveLines(customerId, row, restaurant.id, lines, tx);
    });
    return this.getBasket(customerId);
  }

  async updateBasketLine(customerId: string, lineId: string, input: BasketLineUpdate): Promise<Basket> {
    if (input.quantity !== 0) this.checkQuantity(input.quantity);
    const note = input.note === undefined ? undefined : optionalText(input.note, 'note', LIMITS.note);
    await this.repo.transaction(async (tx) => {
      const row = await tx.basketOf(customerId, { forUpdate: true });
      const lines = linesOf(row?.lines);
      const line = lines.find((l) => l.id === lineId);
      if (!row || !line) throw notFound('Basket line');
      const next = input.quantity === 0 ? lines.filter((l) => l.id !== lineId) : this.merged(lines.map((l) => (l.id === lineId ? { ...l, quantity: input.quantity, ...(note !== undefined ? { note } : {}) } : l)));
      await this.saveLines(customerId, row, row.restaurant_id, next, tx);
    });
    return this.getBasket(customerId);
  }

  async clearBasket(customerId: string): Promise<Basket> {
    const row = await this.repo.basketOf(customerId);
    if (row) await this.saveLines(customerId, row, null, []);
    return this.emptyBasket();
  }

  async getPaymentOptions(customerId: string): Promise<payments.PaymentOptions> {
    const { basket } = await this.pricedBasket(customerId);
    if (!basket.lines.length) throw this.ctx.error('BASKET_EMPTY', 'Your basket is empty.');
    // payments' chargeNote describes checkout orders; a food order is held now and charged on delivery
    const options = await this.payments.listOptions({ customerId }, basket.total as Money);
    return { ...options, chargeNote: 'We hold the amount on your card when you order and charge it when your food is delivered. If the restaurant declines or you cancel, the hold is released.' };
  }
}
