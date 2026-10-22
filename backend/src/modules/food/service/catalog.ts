/**
 * What staff keep and customers browse: food categories, restaurants (hours, delivery terms, promotion) and their
 * menus (sections and items with sizes and extras). Lists are small (a market's restaurants), so they are read whole,
 * filtered and sorted here, and paged with pageOf.
 */
import { isTimeZone } from '../../../kernel/lib/dates.js';
import { newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import { pageOf, type Page, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type {
  FoodCategory,
  FoodCategoryInput,
  MenuItem,
  MenuItemAdmin,
  MenuItemCard,
  MenuItemInput,
  MenuSection,
  MenuSectionAdmin,
  MenuSectionInput,
  OpeningDay,
  OptionGroup,
  Restaurant,
  RestaurantAdmin,
  RestaurantCard,
  RestaurantInput,
} from '../../../spec/food.js';
import {
  averageOf,
  daysOf,
  defaultHours,
  deliveryLabel,
  discountBadge,
  feeLabel,
  groupsOf,
  INSTRUCTIONS_HINT,
  isHhmm,
  LIMITS,
  LISTED,
  lowestUnitPrice,
  moneyLabel,
  OPEN_STATUSES,
  ratingOf,
  searchTextOf,
  WEEKDAYS,
} from '../domain/rules.js';
import type { CategoryRow, ItemRow, RestaurantRow, SectionRow } from '../ports.js';
import { FoodBase, invalid, notFound, optionalText, present, requireText, stringsOf, textList, unique, type By, type Refs } from './base.js';

const RESTAURANT_STATUSES = ['draft', 'published', 'paused', 'hidden'] as const;
const ICON = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GROUP_ID = /^[A-Za-z0-9_-]{1,40}$/;

const photoIdsOf = (v: unknown) => stringsOf(v);
const isListed = (r: RestaurantRow | undefined): r is RestaurantRow => Boolean(r && LISTED.includes(r.status));

export class FoodCatalog extends FoodBase {
  /* ---------------------------------------------------------------- cards */

  protected restaurantRefs(rows: RestaurantRow[], withPhotos = false): Promise<Refs> {
    return this.refsMap(rows.flatMap((r) => [r.image_id, r.logo_id, ...(withPhotos ? photoIdsOf(r.photo_ids) : [])]));
  }

  protected itemCard(i: ItemRow, r: RestaurantRow, refs: Refs): MenuItemCard {
    const first = photoIdsOf(i.photo_ids)[0];
    return {
      id: i.id,
      restaurantId: r.id,
      restaurantName: r.name,
      restaurantSlug: r.slug,
      name: i.name,
      description: i.description,
      image: first ? (refs.get(first) ?? null) : null,
      price: money(i.price, i.currency),
      priceLabel: moneyLabel(money(i.price, i.currency)),
      wasLabel: i.was_price != null && i.was_price > i.price ? moneyLabel(money(i.was_price, i.currency)) : null,
      badge: discountBadge(i.price, i.was_price),
      tag: i.tag,
      dietTags: stringsOf(i.diet_tags),
      rating: averageOf(i.rating_sum, i.rating_count),
      ratingCount: i.rating_count,
      available: i.available,
      hasOptions: groupsOf(i.option_groups, i.currency).length > 0,
    };
  }

  /** Listed restaurants (published, and paused ones shown closed) by id */
  protected async listedRestaurants(): Promise<Map<string, RestaurantRow>> {
    return new Map((await this.repo.listRestaurants({ statuses: LISTED })).map((r) => [r.id, r]));
  }

  /* ---------------------------------------------------------------- store */

  async listCategories(): Promise<FoodCategory[]> {
    const [cats, restaurants] = await Promise.all([this.repo.listCategories({ visibleOnly: true }), this.repo.listRestaurants({ statuses: LISTED })]);
    return this.categoriesOut(cats, restaurants);
  }

  private async categoriesOut(cats: CategoryRow[], restaurants: RestaurantRow[]): Promise<FoodCategory[]> {
    const refs = await this.refsMap(cats.map((c) => c.image_id));
    return cats.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      icon: c.icon,
      image: c.image_id ? (refs.get(c.image_id) ?? null) : null,
      position: c.position,
      visible: c.visible,
      restaurantCount: restaurants.filter((r) => stringsOf(r.category_ids).includes(c.id)).length,
    }));
  }

  async listRestaurants(q: { category?: string; q?: string; sort?: 'recommended' | 'rating' | 'delivery_time' | 'fee' }, page: PageRequest): Promise<Page<RestaurantCard>> {
    let list = [...(await this.listedRestaurants()).values()];
    if (q.category) {
      const cat = await this.repo.categoryBySlug(q.category);
      list = cat && cat.visible ? list.filter((r) => stringsOf(r.category_ids).includes(cat.id)) : [];
    }
    const text = q.q?.trim().toLowerCase();
    if (text) list = list.filter((r) => r.search_text.includes(text));
    const now = this.now();
    const open = new Map(list.map((r) => [r.id, this.openState(r, now).open]));
    const key: Record<string, (r: RestaurantRow) => number> = {
      recommended: () => 0,
      rating: (r) => -(averageOf(r.rating_sum, r.rating_count) ?? 0),
      delivery_time: (r) => r.delivery_min * 1000 + r.delivery_max,
      fee: (r) => r.delivery_fee,
    };
    const by = key[q.sort ?? 'recommended'] ?? key.recommended!;
    list.sort((a, b) => Number(open.get(b.id)) - Number(open.get(a.id)) || by(a) - by(b) || a.position - b.position || a.name.localeCompare(b.name));
    const paged = pageOf(list, page);
    const refs = await this.restaurantRefs(paged.items);
    return { ...paged, items: paged.items.map((r) => this.restaurantCard(r, refs, now)) };
  }

  async getRestaurant(slug: string): Promise<Restaurant> {
    const r = await this.repo.restaurantBySlug(slug);
    if (!isListed(r)) throw notFound('Restaurant');
    const [sections, items] = await Promise.all([this.repo.listSections(r.id), this.repo.listItems({ restaurantId: r.id })]);
    const refs = await this.refsMap([r.image_id, r.logo_id, ...photoIdsOf(r.photo_ids), ...items.map((i) => photoIdsOf(i.photo_ids)[0])]);
    const card = this.restaurantCard(r, refs);
    const popular = items.filter((i) => i.popular);
    const out: MenuSection[] = [];
    // Popular takes the restaurant's id (no section row has it)
    if (popular.length) out.push({ id: r.id, name: 'Popular', items: popular.map((i) => this.itemCard(i, r, refs)) });
    for (const s of sections) {
      const own = items.filter((i) => i.section_id === s.id);
      if (own.length) out.push({ id: s.id, name: s.name, items: own.map((i) => this.itemCard(i, r, refs)) });
    }
    const fee = money(r.delivery_fee, r.currency);
    const state = this.openState(r);
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      cuisine: r.cuisine,
      image: card.image ?? null,
      logo: card.logo ?? null,
      photos: photoIdsOf(r.photo_ids).map((id) => refs.get(id)).filter(present),
      address: r.address,
      city: r.city,
      phone: r.phone,
      ratings: ratingOf(r.rating_sum, r.rating_count, r.rating_stars),
      deliveryLabel: deliveryLabel(r.delivery_min, r.delivery_max),
      deliveryFee: fee,
      feeLabel: feeLabel(fee),
      freeDeliveryOver: r.free_delivery_over == null ? null : money(r.free_delivery_over, r.currency),
      minOrder: r.min_order == null ? null : money(r.min_order, r.currency),
      minOrderLabel: r.min_order ? `Min. order ${moneyLabel(money(r.min_order, r.currency))}` : null,
      promoText: r.promo_text,
      promoBadge: r.promo_badge,
      open: state.open,
      openLabel: state.label,
      hours: daysOf(r.hours),
      sections: out,
    };
  }

  async listItems(q: { recommended?: boolean; category?: string; q?: string }, page: PageRequest): Promise<Page<MenuItemCard>> {
    const restaurants = await this.listedRestaurants();
    let ids = [...restaurants.keys()];
    if (q.category) {
      const cat = await this.repo.categoryBySlug(q.category);
      ids = cat && cat.visible ? ids.filter((id) => stringsOf(restaurants.get(id)!.category_ids).includes(cat.id)) : [];
    }
    let items = ids.length ? await this.repo.listItems({ restaurantIds: ids, availableOnly: true, ...(q.recommended ? { recommended: true } : {}) }) : [];
    const text = q.q?.trim().toLowerCase();
    if (text) items = items.filter((i) => i.search_text.includes(text) || restaurants.get(i.restaurant_id)!.name.toLowerCase().includes(text));
    items.sort((a, b) => restaurants.get(a.restaurant_id)!.position - restaurants.get(b.restaurant_id)!.position || a.position - b.position || a.name.localeCompare(b.name));
    const paged = pageOf(items, page);
    const refs = await this.refsMap(paged.items.map((i) => photoIdsOf(i.photo_ids)[0]));
    return { ...paged, items: paged.items.map((i) => this.itemCard(i, restaurants.get(i.restaurant_id)!, refs)) };
  }

  async getItem(id: string): Promise<MenuItem> {
    const i = await this.repo.getItem(id);
    const r = i ? await this.repo.getRestaurant(i.restaurant_id) : undefined;
    if (!i || !isListed(r)) throw notFound('Menu item');
    const refs = await this.refsMap([r.image_id, r.logo_id, ...photoIdsOf(i.photo_ids)]);
    const card = this.itemCard(i, r, refs);
    return {
      id: i.id,
      restaurant: this.restaurantCard(r, refs),
      name: i.name,
      description: i.description,
      photos: photoIdsOf(i.photo_ids).map((p) => refs.get(p)).filter(present),
      price: card.price,
      priceLabel: card.priceLabel,
      wasLabel: card.wasLabel ?? null,
      badge: card.badge ?? null,
      tag: i.tag,
      dietTags: card.dietTags,
      rating: card.rating ?? null,
      ratingCount: card.ratingCount,
      available: i.available,
      optionGroups: groupsOf(i.option_groups, i.currency),
      instructionsHint: INSTRUCTIONS_HINT,
    };
  }

  /* ---------------------------------------------------------------- admin: categories */

  async listCategoriesAdmin(): Promise<FoodCategory[]> {
    const [cats, restaurants] = await Promise.all([this.repo.listCategories(), this.repo.listRestaurants()]);
    return this.categoriesOut(cats, restaurants);
  }

  private async categoryOut(c: CategoryRow): Promise<FoodCategory> {
    return (await this.categoriesOut([c], await this.repo.listRestaurants()))[0]!;
  }

  private async categoryFields(input: FoodCategoryInput, exceptId?: string) {
    const name = requireText(input.name, 'name', LIMITS.short);
    const slug = await this.slugFor('categories', input.slug, name, exceptId);
    const icon = optionalText(input.icon, 'icon', 40);
    if (icon && !ICON.test(icon)) throw invalid('icon', 'Use a Lucide icon name like pizza');
    return { name, slug, icon };
  }

  async createCategory(input: FoodCategoryInput, by: By): Promise<FoodCategory> {
    const f = await this.categoryFields(input);
    const id = newId();
    const now = this.now();
    const position = input.position ?? (await this.repo.maxCategoryPosition()) + 1;
    const image = input.imageId ?? null;
    const row = await this.withMedia('category_image', id, f.name, [], image ? [{ id: image, path: 'imageId' }] : [], () =>
      this.repo.insertCategory({ id, ...f, image_id: image, position, visible: input.visible ?? true, created_at: now, updated_at: now }),
    );
    const out = await this.categoryOut(row);
    await this.audit({ action: 'food.category.create', actionLabel: 'Added a food category', target: { type: 'food_category', id, label: row.name }, after: out }, by);
    return out;
  }

  async updateCategory(id: string, input: FoodCategoryInput, by: By): Promise<FoodCategory> {
    const before = await this.repo.getCategory(id);
    if (!before) throw notFound('Category');
    const f = await this.categoryFields(input, id);
    const image = input.imageId === undefined ? before.image_id : input.imageId;
    const row = await this.withMedia('category_image', id, f.name, before.image_id ? [before.image_id] : [], image ? [{ id: image, path: 'imageId' }] : [], async () =>
      (await this.repo.updateCategory(id, { ...f, image_id: image, ...(input.position != null ? { position: input.position } : {}), ...(input.visible != null ? { visible: input.visible } : {}), updated_at: this.now() }))!,
    );
    const out = await this.categoryOut(row);
    await this.audit({ action: 'food.category.update', actionLabel: 'Changed a food category', target: { type: 'food_category', id, label: row.name }, before, after: out }, by);
    return out;
  }

  async deleteCategory(id: string, by: By): Promise<void> {
    const c = await this.repo.getCategory(id);
    if (!c) throw notFound('Category');
    // restaurants lose the category
    for (const r of await this.repo.restaurantsInCategory(id)) {
      await this.repo.updateRestaurant(r.id, { category_ids: stringsOf(r.category_ids).filter((x) => x !== id) as never, updated_at: this.now() });
      await this.refreshSearch(r.id);
    }
    await this.repo.deleteCategory(id);
    await this.detachAll('category_image', id, [c.image_id]);
    await this.audit({ action: 'food.category.delete', actionLabel: 'Deleted a food category', target: { type: 'food_category', id, label: c.name }, before: c }, by);
  }

  /* ---------------------------------------------------------------- admin: restaurants */

  protected async restaurantsAdmin(rows: RestaurantRow[]): Promise<RestaurantAdmin[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [open, refs, items] = await Promise.all([this.repo.orderCounts(ids, OPEN_STATUSES), this.restaurantRefs(rows, true), this.repo.listItems({ restaurantIds: ids })]);
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      cuisine: r.cuisine,
      categoryIds: stringsOf(r.category_ids),
      image: r.image_id ? (refs.get(r.image_id) ?? null) : null,
      logo: r.logo_id ? (refs.get(r.logo_id) ?? null) : null,
      photos: photoIdsOf(r.photo_ids).map((id) => refs.get(id)).filter(present),
      address: r.address,
      city: r.city,
      phone: r.phone,
      hours: daysOf(r.hours),
      timeZone: this.zoneOf(r),
      deliveryMinMinutes: r.delivery_min,
      deliveryMaxMinutes: r.delivery_max,
      deliveryFee: money(r.delivery_fee, r.currency),
      freeDeliveryOver: r.free_delivery_over == null ? null : money(r.free_delivery_over, r.currency),
      minOrder: r.min_order == null ? null : money(r.min_order, r.currency),
      promoText: r.promo_text,
      promoBadge: r.promo_badge,
      status: r.status,
      position: r.position,
      ratings: ratingOf(r.rating_sum, r.rating_count, r.rating_stars),
      itemCount: items.filter((i) => i.restaurant_id === r.id).length,
      openOrders: open.get(r.id) ?? 0,
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  async listRestaurantsAdmin(q: { status?: string; categoryId?: string; q?: string }, page: PageRequest): Promise<Page<RestaurantAdmin>> {
    let list = await this.repo.listRestaurants(q.status ? { statuses: [q.status] } : {});
    if (q.categoryId) list = list.filter((r) => stringsOf(r.category_ids).includes(q.categoryId!));
    const text = q.q?.trim().toLowerCase();
    if (text) list = list.filter((r) => r.search_text.includes(text) || r.slug.includes(text));
    const paged = pageOf(list, page);
    return { ...paged, items: await this.restaurantsAdmin(paged.items) };
  }

  async getRestaurantAdmin(id: string): Promise<RestaurantAdmin> {
    const r = await this.repo.getRestaurant(id);
    if (!r) throw notFound('Restaurant');
    return (await this.restaurantsAdmin([r]))[0]!;
  }

  /** Seven days, Monday first; a closing time earlier than the opening time closes past midnight */
  private checkHours(list: OpeningDay[] | null | undefined): OpeningDay[] {
    if (!list) return defaultHours();
    const seen = new Set<string>();
    const out: OpeningDay[] = WEEKDAYS.map((weekday) => ({ weekday, open: false, from: null, to: null }));
    list.forEach((d, i) => {
      const at = `hours[${i}]`;
      if (!(WEEKDAYS as readonly string[]).includes(d.weekday)) throw invalid(`${at}.weekday`, 'Use mon to sun');
      if (seen.has(d.weekday)) throw invalid(`${at}.weekday`, 'Each day once');
      seen.add(d.weekday);
      if (!d.open) return;
      if (!isHhmm(d.from) || !isHhmm(d.to)) throw invalid(`${at}.from`, 'Use times like 11:00 and 22:30');
      if (d.from === d.to) throw invalid(`${at}.to`, 'Closing time must differ from opening time');
      out[WEEKDAYS.indexOf(d.weekday)] = { weekday: d.weekday, open: true, from: d.from, to: d.to };
    });
    return out;
  }

  private async restaurantFields(input: RestaurantInput, before?: RestaurantRow) {
    const keep = <K extends keyof RestaurantInput, T>(k: K, prev: T, read: (v: NonNullable<RestaurantInput[K]> | null) => T): T => (input[k] === undefined && before ? prev : read((input[k] ?? null) as never));
    const name = requireText(input.name, 'name', LIMITS.name);
    const slug = await this.slugFor('restaurants', input.slug ?? (before ? before.slug : null), name, before?.id);
    const cuisine = requireText(input.cuisine, 'cuisine', LIMITS.cuisine);
    const categoryIds = keep('categoryIds', stringsOf(before?.category_ids), (v) => unique((v as string[] | null) ?? []));
    if (categoryIds.length) {
      const found = new Set((await this.repo.categoriesByIds(categoryIds)).map((c) => c.id));
      const missing = categoryIds.findIndex((id) => !found.has(id));
      if (missing >= 0) throw invalid(`categoryIds[${missing}]`, 'Category not found');
    }
    const min = input.deliveryMinMinutes;
    const max = input.deliveryMaxMinutes;
    if (!Number.isInteger(min) || min < 1 || min > LIMITS.deliveryMinutes) throw invalid('deliveryMinMinutes', `Use 1 to ${LIMITS.deliveryMinutes} minutes`);
    if (!Number.isInteger(max) || max < min || max > LIMITS.deliveryMinutes) throw invalid('deliveryMaxMinutes', 'Use at least the shortest time');
    const fee = this.checkMoney(input.deliveryFee, 'deliveryFee');
    if (!fee) throw invalid('deliveryFee', 'Enter the delivery fee (0 for free delivery)');
    const timeZone = keep('timeZone', before?.time_zone ?? this.tz, (v) => (v as string | null)?.trim() || this.tz);
    if (!isTimeZone(timeZone)) throw invalid('timeZone', 'Use an IANA time zone, e.g. America/Los_Angeles');
    const status = input.status ?? before?.status ?? 'draft';
    if (!(RESTAURANT_STATUSES as readonly string[]).includes(status)) throw invalid('status', 'Unknown status');
    const photoIds = keep('photoIds', photoIdsOf(before?.photo_ids), (v) => unique((v as string[] | null) ?? []));
    if (photoIds.length > LIMITS.photos) throw invalid('photoIds', `Use at most ${LIMITS.photos} photos`);
    return {
      name,
      slug,
      cuisine,
      category_ids: categoryIds,
      image_id: keep('imageId', before?.image_id ?? null, (v) => (v as string | null) ?? null),
      logo_id: keep('logoId', before?.logo_id ?? null, (v) => (v as string | null) ?? null),
      photo_ids: photoIds,
      address: keep('address', before?.address ?? null, (v) => optionalText(v as string | null, 'address', LIMITS.address)),
      city: keep('city', before?.city ?? null, (v) => optionalText(v as string | null, 'city', LIMITS.city)),
      phone: keep('phone', before?.phone ?? null, (v) => optionalText(v as string | null, 'phone', LIMITS.phone)),
      hours: keep('hours', daysOf(before?.hours), (v) => this.checkHours(v as OpeningDay[] | null)),
      time_zone: timeZone,
      delivery_min: min,
      delivery_max: max,
      delivery_fee: fee.amount,
      free_delivery_over: keep('freeDeliveryOver', before?.free_delivery_over ?? null, (v) => this.checkMoney(v as common.Money | null, 'freeDeliveryOver')?.amount ?? null),
      min_order: keep('minOrder', before?.min_order ?? null, (v) => this.checkMoney(v as common.Money | null, 'minOrder')?.amount ?? null),
      currency: this.currency,
      promo_text: keep('promoText', before?.promo_text ?? null, (v) => optionalText(v as string | null, 'promoText', LIMITS.promoText)),
      promo_badge: keep('promoBadge', before?.promo_badge ?? null, (v) => optionalText(v as string | null, 'promoBadge', LIMITS.promoBadge)),
      status: status as RestaurantRow['status'],
    };
  }

  private restaurantMedia(f: { image_id: string | null; logo_id: string | null; photo_ids: string[] }) {
    return [...(f.image_id ? [{ id: f.image_id, path: 'imageId' }] : []), ...(f.logo_id ? [{ id: f.logo_id, path: 'logoId' }] : []), ...f.photo_ids.map((id, i) => ({ id, path: `photoIds[${i}]` }))];
  }

  async createRestaurant(input: RestaurantInput, by: By): Promise<RestaurantAdmin> {
    const f = await this.restaurantFields(input);
    const id = newId();
    const now = this.now();
    const position = input.position ?? (await this.repo.maxRestaurantPosition()) + 1;
    const cats = await this.repo.categoriesByIds(f.category_ids);
    await this.withMedia('content_block', id, f.name, [], this.restaurantMedia(f), () =>
      this.repo.insertRestaurant({
        id,
        ...f,
        category_ids: f.category_ids as never,
        photo_ids: f.photo_ids as never,
        hours: f.hours as never,
        position,
        rating_sum: 0,
        rating_count: 0,
        rating_stars: [0, 0, 0, 0, 0] as never,
        search_text: searchTextOf(f.name, f.cuisine, f.city, ...cats.map((c) => c.name)),
        created_at: now,
        updated_at: now,
      }),
    );
    const out = await this.getRestaurantAdmin(id);
    await this.audit({ action: 'food.restaurant.create', actionLabel: 'Added a restaurant', target: { type: 'food_restaurant', id, label: f.name }, after: out }, by);
    return out;
  }

  async updateRestaurant(id: string, input: RestaurantInput, by: By): Promise<RestaurantAdmin> {
    const before = await this.repo.getRestaurant(id);
    if (!before) throw notFound('Restaurant');
    const f = await this.restaurantFields(input, before);
    const prev = [before.image_id, before.logo_id, ...photoIdsOf(before.photo_ids)].filter((x): x is string => Boolean(x));
    await this.withMedia('content_block', id, f.name, prev, this.restaurantMedia(f), () =>
      this.repo.updateRestaurant(id, { ...f, category_ids: f.category_ids as never, photo_ids: f.photo_ids as never, hours: f.hours as never, ...(input.position != null ? { position: input.position } : {}), updated_at: this.now() }),
    );
    await this.refreshSearch(id);
    const out = await this.getRestaurantAdmin(id);
    await this.audit({ action: 'food.restaurant.update', actionLabel: before.status !== f.status ? `Marked a restaurant ${f.status}` : 'Changed a restaurant', target: { type: 'food_restaurant', id, label: f.name }, before: { name: before.name, status: before.status }, after: out }, by);
    return out;
  }

  async deleteRestaurant(id: string, by: By): Promise<void> {
    const r = await this.repo.getRestaurant(id);
    if (!r) throw notFound('Restaurant');
    if (await this.repo.countOrders({ restaurantId: id })) throw this.ctx.error('IN_USE', 'Orders use this restaurant; hide it instead.');
    const items = await this.repo.listItems({ restaurantId: id });
    await this.repo.transaction(async (tx) => {
      await tx.deleteItemsOf(id);
      await tx.deleteSectionsOf(id);
      await tx.deleteRestaurant(id);
    });
    await this.detachAll('content_block', id, [r.image_id, r.logo_id, ...photoIdsOf(r.photo_ids)]);
    for (const i of items) await this.detachAll('content_block', i.id, photoIdsOf(i.photo_ids));
    await this.audit({ action: 'food.restaurant.delete', actionLabel: 'Deleted a restaurant', target: { type: 'food_restaurant', id, label: r.name }, before: { name: r.name, status: r.status } }, by);
  }

  /** The restaurant's search words: its name, cuisine, city, categories and dishes */
  protected async refreshSearch(restaurantId: string) {
    const r = await this.repo.getRestaurant(restaurantId);
    if (!r) return;
    const [cats, items] = await Promise.all([this.repo.categoriesByIds(stringsOf(r.category_ids)), this.repo.listItems({ restaurantId })]);
    await this.repo.updateRestaurant(restaurantId, { search_text: searchTextOf(r.name, r.cuisine, r.city, ...cats.map((c) => c.name), ...items.map((i) => i.name)) });
  }

  /* ---------------------------------------------------------------- admin: menu */

  protected async itemsAdmin(rows: ItemRow[]): Promise<MenuItemAdmin[]> {
    const refs = await this.refsMap(rows.flatMap((i) => photoIdsOf(i.photo_ids)));
    return rows.map((i) => ({
      id: i.id,
      restaurantId: i.restaurant_id,
      sectionId: i.section_id,
      name: i.name,
      description: i.description,
      photos: photoIdsOf(i.photo_ids).map((id) => refs.get(id)).filter(present),
      price: money(i.price, i.currency),
      wasPrice: i.was_price == null ? null : money(i.was_price, i.currency),
      tag: i.tag,
      dietTags: stringsOf(i.diet_tags),
      popular: i.popular,
      recommended: i.recommended,
      optionGroups: groupsOf(i.option_groups, i.currency),
      available: i.available,
      position: i.position,
      ratings: ratingOf(i.rating_sum, i.rating_count, i.rating_stars),
      updatedAt: i.updated_at.toISOString(),
    }));
  }

  private async sectionsAdmin(sections: SectionRow[], items: ItemRow[]): Promise<MenuSectionAdmin[]> {
    const all = await this.itemsAdmin(items);
    return sections.map((s) => ({ id: s.id, restaurantId: s.restaurant_id, name: s.name, position: s.position, items: all.filter((i) => i.sectionId === s.id) }));
  }

  async getMenuAdmin(restaurantId: string): Promise<MenuSectionAdmin[]> {
    if (!(await this.repo.getRestaurant(restaurantId))) throw notFound('Restaurant');
    const [sections, items] = await Promise.all([this.repo.listSections(restaurantId), this.repo.listItems({ restaurantId })]);
    return this.sectionsAdmin(sections, items);
  }

  async createSection(restaurantId: string, input: MenuSectionInput, by: By): Promise<MenuSectionAdmin> {
    const r = await this.repo.getRestaurant(restaurantId);
    if (!r) throw notFound('Restaurant');
    const name = requireText(input.name, 'name', LIMITS.short);
    const row = await this.repo.insertSection({ id: newId(), restaurant_id: restaurantId, name, position: input.position ?? (await this.repo.maxSectionPosition(restaurantId)) + 1 });
    await this.audit({ action: 'food.section.create', actionLabel: `Added the menu section ${name} at ${r.name}`, target: { type: 'food_section', id: row.id, label: name }, after: row }, by);
    return (await this.sectionsAdmin([row], []))[0]!;
  }

  async updateSection(id: string, input: MenuSectionInput, by: By): Promise<MenuSectionAdmin> {
    const before = await this.repo.getSection(id);
    if (!before) throw notFound('Section');
    const name = requireText(input.name, 'name', LIMITS.short);
    const row = (await this.repo.updateSection(id, { name, ...(input.position != null ? { position: input.position } : {}) }))!;
    await this.audit({ action: 'food.section.update', actionLabel: 'Changed a menu section', target: { type: 'food_section', id, label: name }, before, after: row }, by);
    const items = (await this.repo.listItems({ restaurantId: row.restaurant_id })).filter((i) => i.section_id === id);
    return (await this.sectionsAdmin([row], items))[0]!;
  }

  async deleteSection(id: string, by: By): Promise<void> {
    const s = await this.repo.getSection(id);
    if (!s) throw notFound('Section');
    if (await this.repo.countItems({ sectionId: id })) throw this.ctx.error('IN_USE', 'Move or delete its items first.');
    await this.repo.deleteSection(id);
    await this.audit({ action: 'food.section.delete', actionLabel: 'Deleted a menu section', target: { type: 'food_section', id, label: s.name }, before: s }, by);
  }

  /**
   * Option groups as staff enter them: ids unique (groups, and choices inside a group), min ≤ max, a required group
   * picks at least one, max 1 is a single choice, at most `max` defaults, and the cheapest allowed picks still leave
   * a price above 0.
   */
  private checkGroups(list: OptionGroup[] | null | undefined, price: number): OptionGroup[] {
    const groups = list ?? [];
    if (groups.length > LIMITS.groups) throw invalid('optionGroups', `Use at most ${LIMITS.groups} option groups`);
    const ids = new Set<string>();
    const out = groups.map((g, gi) => {
      const at = `optionGroups[${gi}]`;
      const id = g.id?.trim() ?? '';
      if (!GROUP_ID.test(id)) throw invalid(`${at}.id`, 'Use letters, digits, - and _ (up to 40)');
      if (ids.has(id)) throw invalid(`${at}.id`, 'Each group id once');
      ids.add(id);
      const name = requireText(g.name, `${at}.name`, 40);
      const choices = g.choices ?? [];
      if (!choices.length) throw invalid(`${at}.choices`, 'Add at least one choice');
      if (choices.length > LIMITS.choices) throw invalid(`${at}.choices`, `Use at most ${LIMITS.choices} choices`);
      if (!Number.isInteger(g.min) || g.min < 0) throw invalid(`${at}.min`, 'Use 0 or more');
      if (!Number.isInteger(g.max) || g.max < 1) throw invalid(`${at}.max`, 'Use 1 or more');
      if (g.min > g.max) throw invalid(`${at}.min`, 'The minimum can’t be above the maximum');
      if (g.max > choices.length) throw invalid(`${at}.max`, 'The maximum can’t be above the number of choices');
      if (g.required && g.min < 1) throw invalid(`${at}.min`, 'A required group picks at least 1');
      const choiceIds = new Set<string>();
      const outChoices = choices.map((c, ci) => {
        const cat = `${at}.choices[${ci}]`;
        const cid = c.id?.trim() ?? '';
        if (!GROUP_ID.test(cid)) throw invalid(`${cat}.id`, 'Use letters, digits, - and _ (up to 40)');
        if (choiceIds.has(cid)) throw invalid(`${cat}.id`, 'Each choice id once');
        choiceIds.add(cid);
        const delta = c.priceDelta ?? { amount: 0, currency: this.currency };
        if (!Number.isInteger(delta.amount)) throw invalid(`${cat}.priceDelta.amount`, 'Use a whole amount in cents');
        if (delta.currency && delta.currency !== this.currency) throw invalid(`${cat}.priceDelta.currency`, `Use ${this.currency}`);
        return { id: cid, name: requireText(c.name, `${cat}.name`, LIMITS.short), priceDelta: money(delta.amount, this.currency), default: Boolean(c.default), available: c.available !== false };
      });
      if (outChoices.filter((c) => c.default).length > g.max) throw invalid(`${at}.choices`, g.max === 1 ? 'Mark one choice as the default' : `Mark at most ${g.max} defaults`);
      return { id, name, required: Boolean(g.required), min: g.min, max: g.max, choices: outChoices };
    });
    if (lowestUnitPrice(price, out) <= 0) throw invalid('optionGroups', 'The cheapest choices must leave a price above 0');
    return out;
  }

  private async itemFields(restaurantId: string, input: MenuItemInput, before?: ItemRow) {
    const keep = <K extends keyof MenuItemInput, T>(k: K, prev: T, read: (v: NonNullable<MenuItemInput[K]> | null) => T): T => (input[k] === undefined && before ? prev : read((input[k] ?? null) as never));
    const section = await this.repo.getSection(input.sectionId);
    if (!section || section.restaurant_id !== restaurantId) throw invalid('sectionId', 'Pick a section of this restaurant');
    const name = requireText(input.name, 'name', LIMITS.name);
    const price = this.checkMoney(input.price, 'price', { positive: true });
    if (!price) throw invalid('price', 'Enter the price');
    const was = keep('wasPrice', before?.was_price ?? null, (v) => this.checkMoney(v as common.Money | null, 'wasPrice')?.amount ?? null);
    if (was != null && was <= price.amount) throw invalid('wasPrice', 'The earlier price must be above the price');
    const photoIds = keep('photoIds', photoIdsOf(before?.photo_ids), (v) => unique((v as string[] | null) ?? []));
    if (photoIds.length > LIMITS.itemPhotos) throw invalid('photoIds', `Use at most ${LIMITS.itemPhotos} photos`);
    const description = keep('description', before?.description ?? null, (v) => optionalText(v as string | null, 'description', LIMITS.description));
    const tag = keep('tag', before?.tag ?? null, (v) => optionalText(v as string | null, 'tag', LIMITS.tag));
    const dietTags = keep('dietTags', stringsOf(before?.diet_tags), (v) => textList(v as string[] | null, 'dietTags', LIMITS.dietTags, LIMITS.tag));
    const groups = this.checkGroups(input.optionGroups === undefined && before ? groupsOf(before.option_groups, before.currency) : input.optionGroups, price.amount);
    return {
      section_id: section.id,
      name,
      description,
      photo_ids: photoIds,
      price: price.amount,
      was_price: was,
      currency: this.currency,
      tag,
      diet_tags: dietTags,
      popular: input.popular ?? before?.popular ?? false,
      recommended: input.recommended ?? before?.recommended ?? false,
      option_groups: groups,
      available: input.available ?? before?.available ?? true,
      search_text: searchTextOf(name, description, tag, ...dietTags),
    };
  }

  async createItem(restaurantId: string, input: MenuItemInput, by: By): Promise<MenuItemAdmin> {
    const r = await this.repo.getRestaurant(restaurantId);
    if (!r) throw notFound('Restaurant');
    const f = await this.itemFields(restaurantId, input);
    const id = newId();
    const now = this.now();
    const position = input.position ?? (await this.repo.maxItemPosition(f.section_id)) + 1;
    const row = await this.withMedia('content_block', id, f.name, [], f.photo_ids.map((p, i) => ({ id: p, path: `photoIds[${i}]` })), () =>
      this.repo.insertItem({ id, restaurant_id: restaurantId, ...f, photo_ids: f.photo_ids as never, diet_tags: f.diet_tags as never, option_groups: f.option_groups as never, position, rating_sum: 0, rating_count: 0, rating_stars: [0, 0, 0, 0, 0] as never, created_at: now, updated_at: now }),
    );
    await this.refreshSearch(restaurantId);
    const out = (await this.itemsAdmin([row]))[0]!;
    await this.audit({ action: 'food.item.create', actionLabel: `Added ${f.name} to ${r.name}`, target: { type: 'food_item', id, label: f.name }, after: out }, by);
    return out;
  }

  async updateItem(id: string, input: MenuItemInput, by: By): Promise<MenuItemAdmin> {
    const before = await this.repo.getItem(id);
    if (!before) throw notFound('Menu item');
    const f = await this.itemFields(before.restaurant_id, input, before);
    const moved = f.section_id !== before.section_id;
    const position = input.position ?? (moved ? (await this.repo.maxItemPosition(f.section_id)) + 1 : before.position);
    const row = await this.withMedia('content_block', id, f.name, photoIdsOf(before.photo_ids), f.photo_ids.map((p, i) => ({ id: p, path: `photoIds[${i}]` })), async () =>
      (await this.repo.updateItem(id, { ...f, photo_ids: f.photo_ids as never, diet_tags: f.diet_tags as never, option_groups: f.option_groups as never, position, updated_at: this.now() }))!,
    );
    await this.refreshSearch(before.restaurant_id);
    const out = (await this.itemsAdmin([row]))[0]!;
    const label = before.available !== f.available ? `Marked ${f.name} ${f.available ? 'available' : 'unavailable'}` : `Changed ${f.name}`;
    await this.audit({ action: 'food.item.update', actionLabel: label, target: { type: 'food_item', id, label: f.name }, before: { name: before.name, price: before.price, available: before.available }, after: out }, by);
    return out;
  }

  async deleteItem(id: string, by: By): Promise<void> {
    const i = await this.repo.getItem(id);
    if (!i) throw notFound('Menu item');
    // past orders keep their copy of the line; baskets show it as no longer available
    await this.repo.deleteItem(id);
    await this.detachAll('content_block', id, photoIdsOf(i.photo_ids));
    await this.refreshSearch(i.restaurant_id);
    await this.audit({ action: 'food.item.delete', actionLabel: `Deleted ${i.name}`, target: { type: 'food_item', id, label: i.name }, before: { name: i.name, price: i.price } }, by);
  }
}
