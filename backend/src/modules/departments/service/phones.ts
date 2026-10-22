/**
 * Phones: the products staff pick one by one for the Phone tab (one phone_picks row, id phones), shown as the same
 * product cards as everywhere else (search.getProductCards). Picks the store no longer shows are left out of the cards.
 */
import type * as search from '../../../spec/search.js';
import type { PhonesAdmin, PhonesInput, PhonesPage } from '../../../spec/departments.js';
import { LIMITS } from '../domain/rules.js';
import { actorKey, DepartmentsBase, invalid, iso, type By } from './base.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DepartmentsPhones extends DepartmentsBase {
  /** The picked product ids in order */
  protected async pickedIds(): Promise<string[]> {
    const row = await this.repo.getPicks();
    return Array.isArray(row?.product_ids) ? (row.product_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  }

  /** Product cards in the picks' order (search keeps only products it still shows) */
  protected async cardsFor(ids: string[], postalCode?: string): Promise<search.ProductCard[]> {
    if (!ids.length) return [];
    const searchApi = this.ctx.tryUse('search');
    const cards = await this.soft('search.getProductCards', searchApi && (() => searchApi.getProductCards(ids, postalCode ? { postalCode } : undefined)), [] as search.ProductCard[]);
    const byId = new Map(cards.map((c) => [c.productId, c]));
    return ids.map((id) => byId.get(id)).filter((c): c is search.ProductCard => Boolean(c));
  }

  async getPhones(q: { postalCode?: string }): Promise<PhonesPage> {
    return { products: await this.cardsFor(await this.pickedIds(), q.postalCode) };
  }

  async getPhonesAdmin(): Promise<PhonesAdmin> {
    const row = await this.repo.getPicks();
    const productIds = await this.pickedIds();
    return { productIds, products: await this.cardsFor(productIds), updatedAt: iso(row?.updated_at) };
  }

  async setPhones(input: PhonesInput, by: By): Promise<PhonesAdmin> {
    const ids = input.productIds ?? [];
    if (!ids.length) throw invalid('productIds', 'Pick at least one phone');
    if (ids.length > LIMITS.phonePicks) throw invalid('productIds', `Pick at most ${LIMITS.phonePicks} phones`);
    ids.forEach((id, i) => {
      if (!UUID.test(id)) throw invalid(`productIds[${i}]`, 'Not a product id');
    });
    if (new Set(ids).size !== ids.length) throw invalid('productIds', 'Each phone can be picked once');
    const before = await this.pickedIds();
    await this.repo.savePicks(ids, actorKey(by.actor), this.now());
    const out = await this.getPhonesAdmin();
    await this.audit({ action: 'departments.phones.set', actionLabel: 'Changed the Phone tab picks', target: { type: 'phone_picks', id: 'phones', label: 'Phone tab' }, before: { productIds: before }, after: { productIds: ids } }, by);
    return out;
  }
}
