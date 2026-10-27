/**
 * Food delivery in the integrated search (search module's `GET /api/store/search/departments`): the listed
 * restaurants, their menu items and the visible food categories that match what the customer typed, as ranked hits
 * with the store path each one opens.
 *
 * Every group is the department's own list answered with `q`, so a hit reads exactly like the card the Food
 * delivery screens show, and paging a group is that list's own cursor.
 */
import { groupFrom, groupFromList, groupPage, line, scoreOf, stars, wanted, WEAK_MATCH } from '../../../kernel/lib/dept-search.js';
import type * as common from '../../../spec/common.js';
import type { FoodCategory, MenuItemCard, RestaurantCard } from '../../../spec/food.js';
import { FoodStatisticsPart } from './statistics.js';

export class FoodSearchPart extends FoodStatisticsPart {
  /** Public API (search): restaurants, dishes and categories matching the typed text. */
  async searchFood(input: common.DeptSearchRequest): Promise<common.DeptSearchResult> {
    const q = input.q.trim();
    if (!q) return { groups: [] };
    const page = groupPage(input);
    const customerId = input.customerId ?? null;
    const [restaurants, dishes, categories] = await Promise.all([
      wanted(input, 'restaurant') ? this.listRestaurants({ q }, page, customerId) : null,
      wanted(input, 'dish') ? this.listItems({ q }, page) : null,
      wanted(input, 'food_category') ? this.listCategories() : null,
    ]);
    const groups = [
      restaurants && groupFrom('restaurant', 'Restaurants', restaurants, (r) => this.restaurantHit(q, r)),
      dishes && groupFrom('dish', 'Dishes', dishes, (i) => this.dishHit(q, i)),
      categories && groupFromList('food_category', 'Categories', categories, input, (c) => this.categoryHit(q, c)),
    ].filter((g): g is common.DeptSearchGroup => Boolean(g));
    return { groups };
  }

  private restaurantHit(q: string, r: RestaurantCard): common.DeptSearchHit {
    return {
      id: r.id,
      kind: 'restaurant',
      title: r.name,
      meta: line(r.cuisine, r.deliveryLabel, r.feeLabel),
      sub: line(r.openLabel, r.distanceLabel ?? r.city),
      image: r.logo ?? r.image ?? null,
      badge: r.promoBadge ?? (r.open ? null : 'Closed'),
      badgeTone: r.promoBadge ? 'brand' : 'neutral',
      priceLabel: stars(r.rating, r.ratingCount),
      wasLabel: null,
      path: `/food/restaurants/${r.slug}`,
      score: scoreOf(q, r.name, [r.cuisine, r.city]) || WEAK_MATCH,
    };
  }

  private dishHit(q: string, i: MenuItemCard): common.DeptSearchHit {
    return {
      id: i.id,
      kind: 'dish',
      title: i.name,
      meta: line(i.restaurantName, stars(i.rating, i.ratingCount)),
      sub: i.description ?? null,
      image: i.image ?? null,
      badge: i.badge ?? i.tag ?? null,
      badgeTone: i.badge ? 'deal' : 'neutral',
      priceLabel: i.priceLabel,
      wasLabel: i.wasLabel ?? null,
      path: `/food/items/${i.id}`,
      score: scoreOf(q, i.name, [i.restaurantName, i.description, ...i.dietTags]) || WEAK_MATCH,
    };
  }

  private categoryHit(q: string, c: FoodCategory): common.DeptSearchHit {
    const score = scoreOf(q, c.name);
    return {
      id: c.id,
      kind: 'food_category',
      title: c.name,
      meta: c.restaurantCount === 1 ? '1 restaurant' : `${c.restaurantCount.toLocaleString('en-US')} restaurants`,
      sub: null,
      image: c.image ?? null,
      badge: null,
      badgeTone: null,
      priceLabel: null,
      wasLabel: null,
      path: `/food/restaurants?category=${c.slug}`,
      score,
    };
  }
}
