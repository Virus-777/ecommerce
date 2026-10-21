/**
 * What staff keep and customers browse: categories per area, providers (hours, staff, contacts) and their services,
 * plus the free time slots of bookable services. Lists are small (a market's providers), so they are read whole,
 * filtered and sorted here, and paged with pageOf.
 */
import { addCalendarDays, isIsoDate, isTimeZone } from '../../../kernel/lib/dates.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { money, type Money } from '../../../kernel/lib/money.js';
import { pageOf, type Page, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type {
  AvailabilityDay,
  Contacts,
  GeoPoint,
  HandoverOption,
  OpeningDay,
  PriceRow,
  Provider,
  ProviderAdmin,
  ProviderCard,
  ProviderInput,
  ProviderStaff,
  Service,
  ServiceAdmin,
  ServiceCard,
  ServiceCategory,
  ServiceCategoryInput,
  ServiceCategoryRef,
  ServiceInput,
  ServiceReview,
  ServiceStep,
} from '../../../spec/services.js';
import { AREAS, dayLabel, daysOf, HANDOVER_MODES, hoursOut, isHhmm, LIMITS, minutesOf, overlaps, PRICE_UNITS, ratingOf, slotsOfDay, slugOf, timeLabel, WEEKDAYS, weekdayIndex, weekdayLabel, type Area } from '../domain/rules.js';
import type { CategoryRow, ProviderRow, RequestRow, ReviewRow, ServiceRow } from '../ports.js';
import { actorKey, invalid, iso, mediaList, mediaOf, notFound, optionalText, requireText, ServicesBase, stringsOf, textList, unique, type By, type StoredMedia } from './base.js';

type Refs = Map<string, common.MediaRef>;
type Slot = { start: Date; end: Date };

const priceOf = (s: ServiceRow): Money | null => (s.from_price == null ? null : money(s.from_price, s.currency));
const contactsOf = (v: unknown): Contacts => {
  const c = (v && typeof v === 'object' ? v : {}) as Contacts;
  return { phone: c.phone ?? null, email: c.email ?? null, website: c.website ?? null, address: c.address ?? null };
};
const geoOf = (v: unknown): GeoPoint | null => (v && typeof v === 'object' && typeof (v as GeoPoint).lat === 'number' && typeof (v as GeoPoint).lng === 'number' ? { lat: (v as GeoPoint).lat, lng: (v as GeoPoint).lng } : null);
const staffOf = (v: unknown): ProviderStaff[] => (Array.isArray(v) ? (v as ProviderStaff[]).filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string').map((s) => ({ id: s.id, name: s.name, role: s.role ?? null })) : []);
const rowsOf = (v: unknown): PriceRow[] => (Array.isArray(v) ? (v as PriceRow[]).filter((r) => r && typeof r.label === 'string' && typeof r.price === 'string').map((r) => ({ label: r.label, detail: r.detail ?? null, price: r.price })) : []);
const stepsOf = (v: unknown): ServiceStep[] => (Array.isArray(v) ? (v as ServiceStep[]).filter((s) => s && typeof s.title === 'string').map((s) => ({ title: s.title, detail: s.detail ?? null })) : []);
const handoverOf = (v: unknown): HandoverOption[] => (Array.isArray(v) ? (v as HandoverOption[]).filter((h) => h && (HANDOVER_MODES as readonly string[]).includes(h.mode)).map((h) => ({ mode: h.mode, fee: h.fee ?? null, note: h.note ?? null })) : []);
const zoneOf = (p: ProviderRow, fallback: string) => {
  const tz = (p.hours as { timeZone?: unknown } | null)?.timeZone;
  return typeof tz === 'string' && isTimeZone(tz) ? tz : fallback;
};
const reviewOut = (r: ReviewRow): ServiceReview => ({ id: r.id, rating: r.rating, text: r.text, authorName: r.author_name, createdAt: r.created_at.toISOString() });

export class ServicesCatalog extends ServicesBase {
  /* ---------------------------------------------------------------- cards */

  protected categoryRef(c: CategoryRow | undefined): ServiceCategoryRef | null {
    return c ? { id: c.id, slug: c.slug, name: c.name } : null;
  }

  protected async categoryMap(): Promise<Map<string, CategoryRow>> {
    return new Map((await this.repo.listCategories()).map((c) => [c.id, c]));
  }

  protected refsOf(providers: ProviderRow[], services: ServiceRow[], withPhotos = false): Promise<Refs> {
    return this.refsMap([
      ...providers.flatMap((p) => [mediaOf(p.logo)?.id, mediaOf(p.cover)?.id, ...(withPhotos ? mediaList(p.photos).map((m) => m.id) : [])]),
      ...services.flatMap((s) => [mediaOf(s.image)?.id, ...(withPhotos ? mediaList(s.photos).map((m) => m.id) : [])]),
    ]);
  }

  protected serviceCard(s: ServiceRow, p: ProviderRow, cats: Map<string, CategoryRow>, refs: Refs): ServiceCard {
    const image = mediaOf(s.image);
    return {
      id: s.id,
      slug: s.slug,
      area: s.area as ServiceCard['area'],
      title: s.title,
      summary: s.summary,
      image: image ? (refs.get(image.id) ?? null) : null,
      category: this.categoryRef(s.category_id ? cats.get(s.category_id) : undefined),
      provider: { id: p.id, slug: p.slug, name: p.name, verified: p.verified },
      badge: s.badge,
      fromPrice: priceOf(s),
      priceUnit: s.price_unit as ServiceCard['priceUnit'],
      durationLabel: s.duration_label,
      supportedLabel: s.supported_label,
      coverage: s.coverage,
      tags: stringsOf(s.tags),
      rating: ratingOf(s.rating_sum, s.rating_count, s.rating_stars),
    };
  }

  protected providerCard(p: ProviderRow, cats: Map<string, CategoryRow>, refs: Refs, extra: { fromPrice?: Money | null; nextFree?: string | null } = {}): ProviderCard {
    const logo = mediaOf(p.logo);
    const cover = mediaOf(p.cover);
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      logo: logo ? (refs.get(logo.id) ?? null) : null,
      cover: cover ? (refs.get(cover.id) ?? null) : null,
      kind: p.kind,
      category: this.categoryRef(p.category_id ? cats.get(p.category_id) : undefined),
      city: p.city,
      verified: p.verified,
      rating: ratingOf(p.rating_sum, p.rating_count, p.rating_stars),
      fromPrice: extra.fromPrice ?? null,
      nextFree: extra.nextFree ?? null,
    };
  }

  /** The lowest price of published services (free services count as no price) */
  protected lowestPrice(services: ServiceRow[]): Money | null {
    const priced = services.filter((s) => s.status === 'published' && s.from_price != null && s.price_unit !== 'free');
    if (!priced.length) return null;
    const low = priced.reduce((a, b) => (b.from_price! < a.from_price! ? b : a));
    return priceOf(low);
  }

  /** Provider cards with their lowest price and, for booking, the next free slot today or tomorrow */
  protected async providerCards(providers: ProviderRow[], area?: string): Promise<ProviderCard[]> {
    if (!providers.length) return [];
    const [cats, services] = await Promise.all([this.categoryMap(), this.repo.listServices({ providerIds: providers.map((p) => p.id), publishedOnly: true, ...(area ? { area } : {}) })]);
    const refs = await this.refsOf(providers, []);
    const byProvider = new Map<string, ServiceRow[]>();
    for (const s of services) byProvider.set(s.provider_id, [...(byProvider.get(s.provider_id) ?? []), s]);
    return Promise.all(
      providers.map(async (p) => {
        const own = byProvider.get(p.id) ?? [];
        const bookable = own.filter((s) => s.slot_minutes);
        const nextFree = bookable.length ? await this.nextFreeLabel(p, bookable) : null;
        return this.providerCard(p, cats, refs, { fromPrice: this.lowestPrice(own), nextFree });
      }),
    );
  }

  /* ---------------------------------------------------------------- availability */

  /**
   * Bookings that hold the time of a slot for a service: open bookings of the same service, and open bookings of
   * the provider's other services that took a staff member (a person busy with one service is busy for all).
   */
  private relevant(held: RequestRow[], serviceId: string) {
    return held.filter((h) => h.service_id === serviceId || h.staff_id);
  }

  /**
   * Whether a slot is free, and the staff member who would take it. With staff: the chosen one must be free, or any
   * one is; without staff the provider takes one booking at a time.
   */
  protected freeFor(slot: Slot, staff: ProviderStaff[], held: RequestRow[], staffId?: string | null): { free: boolean; staffId: string | null } {
    const busy = held.filter((h) => h.slot_start && h.slot_end && overlaps(slot, { start: h.slot_start, end: h.slot_end }));
    if (!staff.length) return { free: busy.length === 0, staffId: null };
    const busyStaff = new Set(busy.map((h) => h.staff_id).filter((x): x is string => Boolean(x)));
    // bookings made before the provider listed staff hold one person each
    const unnamed = busy.filter((h) => !h.staff_id).length;
    const freeStaff = staff.filter((s) => !busyStaff.has(s.id));
    const left = freeStaff.length - unnamed;
    if (staffId) return { free: left >= 1 && freeStaff.some((s) => s.id === staffId), staffId };
    return { free: left >= 1, staffId: freeStaff[0]?.id ?? null };
  }

  /** Free slots day by day from `from` (YYYY-MM-DD in the provider's zone) */
  protected async availabilityOf(s: ServiceRow, p: ProviderRow, from: string, days: number, staffId?: string | null): Promise<AvailabilityDay[]> {
    if (!s.slot_minutes) return [];
    const tz = zoneOf(p, this.tz);
    const week = daysOf((p.hours as { days?: unknown } | null)?.days);
    const staff = staffOf(p.staff);
    const start = zonedTimeToUtc(from, '00:00', tz);
    const end = zonedTimeToUtc(addCalendarDays(from, days), '00:00', tz);
    const held = this.relevant(await this.repo.heldSlots(p.id, start, end), s.id);
    const now = this.now();
    const out: AvailabilityDay[] = [];
    for (let i = 0; i < days; i++) {
      const day = addCalendarDays(from, i);
      const hours = week[weekdayIndex(day)]!;
      const slots = slotsOfDay(day, hours, s.slot_minutes, tz).map((slot) => ({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
        label: timeLabel(slot.start, tz),
        available: slot.start > now && this.freeFor(slot, staff, held, staffId).free,
      }));
      out.push({ date: day, weekdayLabel: weekdayLabel(day), open: hours.open && slots.length > 0, slots });
    }
    return out;
  }

  /** The first free slot within `days` days, or null */
  protected async firstFree(s: ServiceRow, p: ProviderRow, days: number): Promise<Slot | null> {
    const list = await this.availabilityOf(s, p, this.today(zoneOf(p, this.tz)), days);
    for (const d of list) {
      const slot = d.slots.find((x) => x.available);
      if (slot) return { start: new Date(slot.start), end: new Date(slot.end) };
    }
    return null;
  }

  /** "Next free: Today 3:30 PM" across a provider's bookable services, looking at today and tomorrow */
  protected async nextFreeLabel(p: ProviderRow, bookable: ServiceRow[]): Promise<string | null> {
    const tz = zoneOf(p, this.tz);
    let best: Date | null = null;
    for (const s of bookable) {
      const f = await this.firstFree(s, p, 2);
      if (f && (!best || f.start < best)) best = f.start;
    }
    if (!best) return null;
    const today = this.today(tz);
    const day = dateInZone(best, tz) === today ? 'Today' : 'Tomorrow';
    return `Next free: ${day} ${timeLabel(best, tz)}`;
  }

  /** The slot a booking asks for, checked against the provider's hours; SLOT_TAKEN when it is not free */
  protected async checkSlot(s: ServiceRow, p: ProviderRow, startIso: string, staffId: string | null | undefined, exceptRequestId?: string): Promise<{ slot: Slot; staffId: string | null }> {
    const tz = zoneOf(p, this.tz);
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) throw invalid('slotStart', 'Pick one of the free times');
    const day = dateInZone(start, tz);
    const week = daysOf((p.hours as { days?: unknown } | null)?.days);
    const slot = slotsOfDay(day, week[weekdayIndex(day)]!, s.slot_minutes!, tz).find((x) => x.start.getTime() === start.getTime());
    if (!slot) throw invalid('slotStart', 'Pick one of the free times');
    if (slot.start <= this.now()) throw this.ctx.error('SLOT_TAKEN', 'That time has passed; pick another.');
    const staff = staffOf(p.staff);
    if (staffId && !staff.some((x) => x.id === staffId)) throw invalid('staffId', 'Pick one of the listed staff');
    const held = this.relevant(await this.repo.heldSlots(p.id, slot.start, slot.end, exceptRequestId), s.id);
    const f = this.freeFor(slot, staff, held, staffId);
    if (!f.free) throw this.ctx.error('SLOT_TAKEN', 'That time was just booked; pick another.');
    return { slot, staffId: f.staffId };
  }

  /* ---------------------------------------------------------------- store: categories, services, providers */

  private areaOf(area: string): Area {
    if (!(AREAS as readonly string[]).includes(area)) throw invalid('area', 'Unknown area');
    return area as Area;
  }

  async listCategories(q: { area: string }): Promise<ServiceCategory[]> {
    const area = this.areaOf(q.area);
    const [cats, services, providers] = await Promise.all([this.repo.listCategories({ area, visibleOnly: true }), this.repo.listServices({ area, publishedOnly: true }), this.repo.listProviders({ publishedOnly: true })]);
    const live = new Set(providers.map((p) => p.id));
    return cats.map((c) => ({
      id: c.id,
      area: c.area as Area,
      slug: c.slug,
      name: c.name,
      icon: c.icon,
      position: c.position,
      visible: c.visible,
      serviceCount: area === 'booking' ? providers.filter((p) => p.category_id === c.id).length : services.filter((s) => s.category_id === c.id && live.has(s.provider_id)).length,
    }));
  }

  /** Published services of an area whose provider is published, with their providers */
  private async liveServices(area: Area): Promise<{ services: ServiceRow[]; providers: Map<string, ProviderRow> }> {
    const services = await this.repo.listServices({ area, publishedOnly: true });
    const providers = new Map((await this.repo.providersByIds(unique(services.map((s) => s.provider_id)))).filter((p) => p.status === 'published').map((p) => [p.id, p]));
    return { services: services.filter((s) => providers.has(s.provider_id)), providers };
  }

  async listServices(q: { area: string; category?: string; q?: string; sort?: 'recommended' | 'price' | 'rating' }, page: PageRequest): Promise<Page<ServiceCard>> {
    const area = this.areaOf(q.area);
    let { services, providers } = await this.liveServices(area);
    if (q.category) {
      const cat = await this.repo.categoryBySlug(area, q.category);
      services = cat ? services.filter((s) => s.category_id === cat.id) : [];
    }
    const text = q.q?.trim().toLowerCase();
    if (text) services = services.filter((s) => [s.title, s.summary ?? '', providers.get(s.provider_id)!.name, s.supported_label ?? ''].some((t) => t.toLowerCase().includes(text)));
    if (q.sort === 'price') services = [...services].sort((a, b) => (a.price_unit === 'free' ? 0 : (a.from_price ?? Number.MAX_SAFE_INTEGER)) - (b.price_unit === 'free' ? 0 : (b.from_price ?? Number.MAX_SAFE_INTEGER)));
    if (q.sort === 'rating') services = [...services].sort((a, b) => (b.rating_count ? b.rating_sum / b.rating_count : 0) - (a.rating_count ? a.rating_sum / a.rating_count : 0));
    const cats = await this.categoryMap();
    const paged = pageOf(services, page);
    const refs = await this.refsOf([], paged.items);
    return { ...paged, items: paged.items.map((s) => this.serviceCard(s, providers.get(s.provider_id)!, cats, refs)) };
  }

  async getService(slug: string): Promise<Service> {
    const s = await this.repo.serviceBySlug(slug);
    const p = s && s.status === 'published' ? await this.repo.getProvider(s.provider_id) : undefined;
    if (!s || !p || p.status !== 'published') throw notFound('Service');
    const [cats, refs, reviews, [card]] = await Promise.all([this.categoryMap(), this.refsOf([p], [s], true), this.repo.newestReviews(s.id, 3), this.providerCards([p], s.area)]);
    const tz = zoneOf(p, this.tz);
    const first = s.slot_minutes ? await this.firstFree(s, p, LIMITS.days) : null;
    return {
      ...this.serviceCard(s, p, cats, refs),
      photos: mediaList(s.photos).map((m) => refs.get(m.id)).filter((m): m is common.MediaRef => Boolean(m)),
      provider: card!,
      description: s.description,
      included: stringsOf(s.included),
      requirements: stringsOf(s.requirements),
      supported: stringsOf(s.supported),
      osVersions: stringsOf(s.os_versions),
      handover: handoverOf(s.handover),
      priceTable: rowsOf(s.price_table),
      priceTableTitle: s.price_table_title,
      terms: stringsOf(s.terms),
      steps: stepsOf(s.steps),
      slotMinutes: s.slot_minutes,
      durationMinutes: s.duration_minutes,
      firstAvailable: first ? `First available ${dayLabel(first.start, tz)} · ${timeLabel(first.start, tz)}` : null,
      reviews: reviews.map(reviewOut),
    };
  }

  async listServiceReviews(id: string, page: PageRequest): Promise<Page<ServiceReview>> {
    const s = await this.repo.getService(id);
    if (!s || s.status !== 'published') throw notFound('Service');
    const res = await this.repo.pageVisibleReviews(id, page);
    return { ...res, items: res.items.map(reviewOut) };
  }

  async listProviders(q: { area: string; category?: string; q?: string }, page: PageRequest): Promise<Page<ProviderCard>> {
    const area = this.areaOf(q.area);
    const { services, providers } = await this.liveServices(area);
    let list = [...providers.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (q.category) {
      const cat = await this.repo.categoryBySlug(area, q.category);
      list = cat ? list.filter((p) => p.category_id === cat.id || services.some((s) => s.provider_id === p.id && s.category_id === cat.id)) : [];
    }
    const text = q.q?.trim().toLowerCase();
    if (text) list = list.filter((p) => [p.name, p.kind ?? '', p.city ?? ''].some((t) => t.toLowerCase().includes(text)));
    const paged = pageOf(list, page);
    return { ...paged, items: await this.providerCards(paged.items, area) };
  }

  async getProvider(slug: string, q: { area?: string }): Promise<Provider> {
    const p = await this.repo.providerBySlug(slug);
    if (!p || p.status !== 'published') throw notFound('Provider');
    const area = q.area ? this.areaOf(q.area) : undefined;
    const services = await this.repo.listServices({ providerId: p.id, publishedOnly: true, ...(area ? { area } : {}) });
    const [cats, refs, [card]] = await Promise.all([this.categoryMap(), this.refsOf([p], services, true), this.providerCards([p], area)]);
    return {
      ...card!,
      photos: mediaList(p.photos).map((m) => refs.get(m.id)).filter((m): m is common.MediaRef => Boolean(m)),
      description: p.description,
      since: p.since,
      contacts: contactsOf(p.contacts),
      location: geoOf(p.location),
      hours: hoursOut(p.hours, this.tz, this.today(zoneOf(p, this.tz))),
      staff: staffOf(p.staff),
      replyTime: p.reply_time,
      services: services.map((s) => this.serviceCard(s, p, cats, refs)),
    };
  }

  async getAvailability(id: string, q: { from?: string; days?: number; staffId?: string }): Promise<AvailabilityDay[]> {
    const s = await this.repo.getService(id);
    const p = s && s.status === 'published' ? await this.repo.getProvider(s.provider_id) : undefined;
    if (!s || !p || p.status !== 'published') throw notFound('Service');
    if (q.from && !isIsoDate(q.from)) throw invalid('from', 'Use a date like 2026-10-22');
    const days = q.days ?? 7;
    if (!Number.isInteger(days) || days < 1 || days > LIMITS.days) throw invalid('days', `Use 1 to ${LIMITS.days} days`);
    if (q.staffId && !staffOf(p.staff).some((x) => x.id === q.staffId)) throw invalid('staffId', 'Pick one of the listed staff');
    const today = this.today(zoneOf(p, this.tz));
    const from = q.from && q.from > today ? q.from : today;
    return this.availabilityOf(s, p, from, days, q.staffId ?? null);
  }

  /* ---------------------------------------------------------------- admin: categories */

  private async categoriesOut(rows: CategoryRow[]): Promise<ServiceCategory[]> {
    const [services, providers] = await Promise.all([this.repo.listServices(), this.repo.listProviders()]);
    return rows.map((c) => ({ id: c.id, area: c.area as Area, slug: c.slug, name: c.name, icon: c.icon, position: c.position, visible: c.visible, serviceCount: c.area === 'booking' ? providers.filter((p) => p.category_id === c.id && p.status === 'published').length : services.filter((s) => s.category_id === c.id && s.status === 'published').length }));
  }

  async listCategoriesAdmin(q: { area?: string }): Promise<ServiceCategory[]> {
    return this.categoriesOut(await this.repo.listCategories(q.area ? { area: this.areaOf(q.area) } : {}));
  }

  private async categoryFields(input: ServiceCategoryInput, exceptId?: string) {
    const area = this.areaOf(input.area);
    const name = requireText(input.name, 'name', LIMITS.short);
    const slug = slugOf(input.slug, name);
    const other = await this.repo.categoryBySlug(area, slug);
    if (other && other.id !== exceptId) throw this.ctx.error('SLUG_TAKEN', `Another ${area.replace('_', ' ')} category already uses the slug ${slug}`);
    const icon = optionalText(input.icon, 'icon', 40);
    if (icon && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(icon)) throw invalid('icon', 'Use a Lucide icon name like wrench');
    return { area, name, slug, icon };
  }

  async createCategory(input: ServiceCategoryInput, by: By): Promise<ServiceCategory> {
    const f = await this.categoryFields(input);
    const row = await this.repo.insertCategory({ id: newId(), ...f, position: input.position ?? (await this.repo.countCategories(f.area)) + 1, visible: input.visible ?? true });
    const [out] = await this.categoriesOut([row]);
    await this.audit({ action: 'services.category.create', actionLabel: 'Added a service category', target: { type: 'service_category', id: row.id, label: row.name }, after: out }, by);
    return out!;
  }

  async updateCategory(id: string, input: ServiceCategoryInput, by: By): Promise<ServiceCategory> {
    const before = await this.repo.getCategory(id);
    if (!before) throw notFound('Category');
    const f = await this.categoryFields(input, id);
    const row = (await this.repo.updateCategory(id, { ...f, ...(input.position != null ? { position: input.position } : {}), ...(input.visible != null ? { visible: input.visible } : {}) }))!;
    const [out] = await this.categoriesOut([row]);
    await this.audit({ action: 'services.category.update', actionLabel: 'Changed a service category', target: { type: 'service_category', id, label: row.name }, before, after: out }, by);
    return out!;
  }

  async deleteCategory(id: string, by: By): Promise<void> {
    const c = await this.repo.getCategory(id);
    if (!c) throw notFound('Category');
    if ((await this.repo.countServices({ categoryId: id })) || (await this.repo.countProvidersInCategory(id))) throw this.ctx.error('IN_USE', 'Services or providers still use this category; move them first.');
    await this.repo.deleteCategory(id);
    await this.audit({ action: 'services.category.delete', actionLabel: 'Deleted a service category', target: { type: 'service_category', id, label: c.name }, before: c }, by);
  }

  /* ---------------------------------------------------------------- admin: providers */

  private async providersAdmin(rows: ProviderRow[]): Promise<ProviderAdmin[]> {
    if (!rows.length) return [];
    const ids = rows.map((p) => p.id);
    const [services, open, refs] = await Promise.all([this.repo.listServices({ providerIds: ids }), this.repo.openRequestCounts('provider_id', ids), this.refsOf(rows, [], true)]);
    return rows.map((p) => {
      const own = services.filter((s) => s.provider_id === p.id);
      const logo = mediaOf(p.logo);
      const cover = mediaOf(p.cover);
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        logo: logo ? (refs.get(logo.id) ?? null) : null,
        cover: cover ? (refs.get(cover.id) ?? null) : null,
        kind: p.kind,
        categoryId: p.category_id,
        areas: unique(own.map((s) => s.area)) as ProviderAdmin['areas'],
        city: p.city,
        verified: p.verified,
        photos: mediaList(p.photos).map((m) => refs.get(m.id)).filter((m): m is common.MediaRef => Boolean(m)),
        description: p.description,
        since: p.since,
        contacts: contactsOf(p.contacts),
        location: geoOf(p.location),
        hours: hoursOut(p.hours, this.tz, this.today(zoneOf(p, this.tz))),
        staff: staffOf(p.staff),
        replyTime: p.reply_time,
        status: p.status as ProviderAdmin['status'],
        serviceCount: own.length,
        openRequestCount: open.get(p.id) ?? 0,
        createdAt: p.created_at.toISOString(),
        updatedAt: p.updated_at.toISOString(),
      };
    });
  }

  async listProvidersAdmin(q: { area?: string; status?: 'published' | 'hidden'; q?: string }, page: PageRequest): Promise<Page<ProviderAdmin>> {
    let list = await this.repo.listProviders();
    if (q.status) list = list.filter((p) => p.status === q.status);
    if (q.area) {
      const area = this.areaOf(q.area);
      const [services, cats] = await Promise.all([this.repo.listServices({ area }), this.repo.listCategories({ area })]);
      const withService = new Set(services.map((s) => s.provider_id));
      const areaCats = new Set(cats.map((c) => c.id));
      list = list.filter((p) => withService.has(p.id) || (p.category_id && areaCats.has(p.category_id)));
    }
    const text = q.q?.trim().toLowerCase();
    if (text) list = list.filter((p) => [p.name, p.kind ?? '', p.city ?? ''].some((t) => t.toLowerCase().includes(text)));
    const paged = pageOf(list, page);
    return { ...paged, items: await this.providersAdmin(paged.items) };
  }

  async getProviderAdmin(id: string): Promise<ProviderAdmin> {
    const p = await this.repo.getProvider(id);
    if (!p) throw notFound('Provider');
    return (await this.providersAdmin([p]))[0]!;
  }

  private checkHours(v: ProviderInput['hours']): { days: OpeningDay[]; timeZone: string | null } {
    if (!v) return { days: daysOf(null).map((d, i) => (i < 5 ? { ...d, open: true, from: '09:00', to: '17:00' } : d)), timeZone: null };
    const days = v.days ?? [];
    const seen = new Set<string>();
    const out: OpeningDay[] = WEEKDAYS.map((weekday) => ({ weekday, open: false, from: null, to: null }));
    days.forEach((d, i) => {
      const at = `hours.days[${i}]`;
      if (!(WEEKDAYS as readonly string[]).includes(d.weekday)) throw invalid(`${at}.weekday`, 'Use mon to sun');
      if (seen.has(d.weekday)) throw invalid(`${at}.weekday`, 'Each day once');
      seen.add(d.weekday);
      if (!d.open) return;
      if (!isHhmm(d.from) || !isHhmm(d.to)) throw invalid(`${at}.from`, 'Use times like 09:00 and 17:30');
      if (minutesOf(d.to) <= minutesOf(d.from)) throw invalid(`${at}.to`, 'Closing time must be after opening time');
      out[WEEKDAYS.indexOf(d.weekday)] = { weekday: d.weekday, open: true, from: d.from, to: d.to };
    });
    const tz = v.timeZone?.trim() || null;
    if (tz && !isTimeZone(tz)) throw invalid('hours.timeZone', 'Use an IANA time zone, e.g. America/Los_Angeles');
    return { days: out, timeZone: tz };
  }

  private checkStaff(list: ProviderInput['staff']): ProviderStaff[] {
    const staff = list ?? [];
    if (staff.length > LIMITS.staff) throw invalid('staff', `Use at most ${LIMITS.staff} people`);
    const ids = new Set<string>();
    return staff.map((s, i) => {
      const name = requireText(s.name, `staff[${i}].name`, 60);
      let id = s.id?.trim() || newId();
      if (ids.has(id)) id = newId();
      ids.add(id);
      return { id, name, role: optionalText(s.role, `staff[${i}].role`, 40) };
    });
  }

  private checkContacts(c: Contacts | null | undefined): Contacts {
    const website = optionalText(c?.website, 'contacts.website', 200);
    if (website && !/^https?:\/\//i.test(website)) throw invalid('contacts.website', 'Use a full web address, e.g. https://example.com');
    return { phone: optionalText(c?.phone, 'contacts.phone', 40), email: optionalText(c?.email, 'contacts.email', 120), website, address: optionalText(c?.address, 'contacts.address', LIMITS.address) };
  }

  private checkGeo(g: GeoPoint | null | undefined): GeoPoint | null {
    if (!g) return null;
    if (!(g.lat >= -90 && g.lat <= 90)) throw invalid('location.lat', 'Latitude is between -90 and 90');
    if (!(g.lng >= -180 && g.lng <= 180)) throw invalid('location.lng', 'Longitude is between -180 and 180');
    return { lat: g.lat, lng: g.lng };
  }

  private pictures(input: { logo?: common.MediaRef | null; cover?: common.MediaRef | null; photos?: common.MediaRef[] | null; image?: common.MediaRef | null }) {
    const photos = (input.photos ?? []).map((m) => ({ id: m.id }));
    if (photos.length > LIMITS.photos) throw invalid('photos', `Use at most ${LIMITS.photos} photos`);
    const one = (m: common.MediaRef | null | undefined) => (m ? { id: m.id } : null);
    return { logo: one(input.logo), cover: one(input.cover), image: one(input.image), photos };
  }

  private mediaPaths(m: { logo?: StoredMedia | null; cover?: StoredMedia | null; image?: StoredMedia | null; photos: StoredMedia[] }) {
    return [...(m.logo ? [{ id: m.logo.id, path: 'logo' }] : []), ...(m.cover ? [{ id: m.cover.id, path: 'cover' }] : []), ...(m.image ? [{ id: m.image.id, path: 'image' }] : []), ...m.photos.map((p, i) => ({ id: p.id, path: `photos[${i}]` }))];
  }

  private async providerFields(input: ProviderInput, exceptId?: string) {
    const name = requireText(input.name, 'name', LIMITS.name);
    const slug = await this.slugFor('providers', input.slug, name, exceptId);
    if (input.categoryId && !(await this.repo.getCategory(input.categoryId))) throw invalid('categoryId', 'Category not found');
    const year = new Date(this.now()).getUTCFullYear();
    if (input.since != null && (!Number.isInteger(input.since) || input.since < 1800 || input.since > year)) throw invalid('since', `Use a year from 1800 to ${year}`);
    return {
      name,
      slug,
      kind: optionalText(input.kind, 'kind', LIMITS.kind),
      category_id: input.categoryId ?? null,
      city: optionalText(input.city, 'city', LIMITS.city),
      verified: input.verified ?? false,
      description: optionalText(input.description, 'description', 4000),
      since: input.since ?? null,
      contacts: this.checkContacts(input.contacts),
      location: this.checkGeo(input.location),
      hours: this.checkHours(input.hours),
      staff: this.checkStaff(input.staff),
      reply_time: optionalText(input.replyTime, 'replyTime', 60),
      status: input.status ?? 'published',
    };
  }

  async createProvider(input: ProviderInput, by: By): Promise<ProviderAdmin> {
    const f = await this.providerFields(input);
    const media = this.pictures(input);
    const id = newId();
    const now = this.now();
    await this.withMedia(id, f.name, [], this.mediaPaths(media), () =>
      this.repo.insertProvider({ id, ...f, logo: media.logo, cover: media.cover, photos: media.photos, contacts: f.contacts as never, location: f.location as never, hours: f.hours as never, staff: f.staff as never, rating_sum: 0, rating_count: 0, rating_stars: [0, 0, 0, 0, 0], created_at: now, updated_at: now }),
    );
    const out = await this.getProviderAdmin(id);
    await this.audit({ action: 'services.provider.create', actionLabel: 'Added a provider', target: { type: 'service_provider', id, label: f.name }, after: out }, by);
    return out;
  }

  async updateProvider(id: string, input: ProviderInput, by: By): Promise<ProviderAdmin> {
    const before = await this.repo.getProvider(id);
    if (!before) throw notFound('Provider');
    const f = await this.providerFields({ ...input, hours: input.hours === undefined ? ({ days: daysOf((before.hours as { days?: unknown })?.days), timeZone: (before.hours as { timeZone?: string })?.timeZone ?? null } as never) : input.hours, staff: input.staff === undefined ? staffOf(before.staff) : input.staff, status: input.status ?? (before.status as ProviderInput['status']) }, id);
    const media = this.pictures({ logo: input.logo === undefined ? (mediaOf(before.logo) as never) : input.logo, cover: input.cover === undefined ? (mediaOf(before.cover) as never) : input.cover, photos: input.photos === undefined ? (mediaList(before.photos) as never) : input.photos });
    const prev = [mediaOf(before.logo), mediaOf(before.cover), ...mediaList(before.photos)].filter((m): m is StoredMedia => Boolean(m));
    await this.withMedia(id, f.name, prev, this.mediaPaths(media), () => this.repo.updateProvider(id, { ...f, logo: media.logo, cover: media.cover, photos: media.photos, contacts: f.contacts as never, location: f.location as never, hours: f.hours as never, staff: f.staff as never, updated_at: this.now() }));
    const out = await this.getProviderAdmin(id);
    await this.audit({ action: 'services.provider.update', actionLabel: 'Changed a provider', target: { type: 'service_provider', id, label: f.name }, before: { name: before.name, status: before.status }, after: out }, by);
    return out;
  }

  async deleteProvider(id: string, by: By): Promise<void> {
    const p = await this.repo.getProvider(id);
    if (!p) throw notFound('Provider');
    if (await this.repo.countServices({ providerId: id })) throw this.ctx.error('IN_USE', 'Delete or move its services first.');
    await this.repo.deleteProvider(id);
    await this.detachAll(id, [mediaOf(p.logo), mediaOf(p.cover), ...mediaList(p.photos)].filter((m): m is StoredMedia => Boolean(m)));
    await this.audit({ action: 'services.provider.delete', actionLabel: 'Deleted a provider', target: { type: 'service_provider', id, label: p.name }, before: { name: p.name } }, by);
  }

  /* ---------------------------------------------------------------- admin: services */

  protected async servicesAdmin(rows: ServiceRow[]): Promise<ServiceAdmin[]> {
    if (!rows.length) return [];
    const [providers, open, refs] = await Promise.all([this.repo.providersByIds(unique(rows.map((s) => s.provider_id))), this.repo.openRequestCounts('service_id', rows.map((s) => s.id)), this.refsOf([], rows, true)]);
    const names = new Map(providers.map((p) => [p.id, p.name]));
    return rows.map((s) => {
      const image = mediaOf(s.image);
      return {
        id: s.id,
        slug: s.slug,
        area: s.area as ServiceAdmin['area'],
        title: s.title,
        summary: s.summary,
        image: image ? (refs.get(image.id) ?? null) : null,
        photos: mediaList(s.photos).map((m) => refs.get(m.id)).filter((m): m is common.MediaRef => Boolean(m)),
        categoryId: s.category_id,
        providerId: s.provider_id,
        providerName: names.get(s.provider_id) ?? '',
        badge: s.badge,
        fromPrice: priceOf(s),
        priceUnit: s.price_unit as ServiceAdmin['priceUnit'],
        durationLabel: s.duration_label,
        supportedLabel: s.supported_label,
        coverage: s.coverage,
        tags: stringsOf(s.tags),
        description: s.description,
        included: stringsOf(s.included),
        requirements: stringsOf(s.requirements),
        supported: stringsOf(s.supported),
        osVersions: stringsOf(s.os_versions),
        handover: handoverOf(s.handover),
        priceTable: rowsOf(s.price_table),
        priceTableTitle: s.price_table_title,
        terms: stringsOf(s.terms),
        steps: stepsOf(s.steps),
        slotMinutes: s.slot_minutes,
        durationMinutes: s.duration_minutes,
        status: s.status as ServiceAdmin['status'],
        position: s.position,
        rating: ratingOf(s.rating_sum, s.rating_count, s.rating_stars),
        openRequestCount: open.get(s.id) ?? 0,
        createdAt: s.created_at.toISOString(),
        updatedAt: s.updated_at.toISOString(),
      };
    });
  }

  async listServicesAdmin(q: { area?: string; providerId?: string; categoryId?: string; status?: 'published' | 'hidden'; q?: string }, page: PageRequest): Promise<Page<ServiceAdmin>> {
    let list = await this.repo.listServices({ ...(q.area ? { area: this.areaOf(q.area) } : {}), ...(q.providerId ? { providerId: q.providerId } : {}), ...(q.categoryId ? { categoryId: q.categoryId } : {}) });
    if (q.status) list = list.filter((s) => s.status === q.status);
    const text = q.q?.trim().toLowerCase();
    if (text) list = list.filter((s) => [s.title, s.summary ?? ''].some((t) => t.toLowerCase().includes(text)));
    const paged = pageOf(list, page);
    return { ...paged, items: await this.servicesAdmin(paged.items) };
  }

  async getServiceAdmin(id: string): Promise<ServiceAdmin> {
    const s = await this.repo.getService(id);
    if (!s) throw notFound('Service');
    return (await this.servicesAdmin([s]))[0]!;
  }

  private checkMoney(m: common.Money | null | undefined, path: string): Money | null {
    if (!m) return null;
    if (!Number.isInteger(m.amount) || m.amount < 0) throw invalid(`${path}.amount`, 'Use a whole amount in cents, 0 or more');
    return money(m.amount, m.currency || this.currency);
  }

  private async serviceFields(input: ServiceInput, exceptId?: string) {
    const area = this.areaOf(input.area);
    const title = requireText(input.title, 'title', LIMITS.title);
    const slug = await this.slugFor('services', input.slug, title, exceptId);
    const provider = await this.repo.getProvider(input.providerId);
    if (!provider) throw invalid('providerId', 'Provider not found');
    if (input.categoryId) {
      const cat = await this.repo.getCategory(input.categoryId);
      if (!cat) throw invalid('categoryId', 'Category not found');
      if (cat.area !== area) throw invalid('categoryId', 'Pick a category of the same area');
    }
    const unit = input.priceUnit ?? 'fixed';
    if (!(PRICE_UNITS as readonly string[]).includes(unit)) throw invalid('priceUnit', 'Unknown price unit');
    const price = this.checkMoney(input.fromPrice, 'fromPrice');
    if (input.slotMinutes != null && (!Number.isInteger(input.slotMinutes) || input.slotMinutes < 15 || input.slotMinutes > 480)) throw invalid('slotMinutes', 'Use 15 to 480 minutes');
    if (input.durationMinutes != null && (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 1440)) throw invalid('durationMinutes', 'Use 5 to 1,440 minutes');
    const modes = new Set<string>();
    const handover = (input.handover ?? []).map((h, i) => {
      if (!(HANDOVER_MODES as readonly string[]).includes(h.mode)) throw invalid(`handover[${i}].mode`, 'Unknown hand-over option');
      if (modes.has(h.mode)) throw invalid(`handover[${i}].mode`, 'Each option once');
      modes.add(h.mode);
      return { mode: h.mode, fee: this.checkMoney(h.fee, `handover[${i}].fee`), note: optionalText(h.note, `handover[${i}].note`, LIMITS.short) };
    });
    const priceTable = (input.priceTable ?? []).map((r, i) => ({ label: requireText(r.label, `priceTable[${i}].label`, LIMITS.short), detail: optionalText(r.detail, `priceTable[${i}].detail`, LIMITS.short), price: requireText(r.price, `priceTable[${i}].price`, 40) }));
    if (priceTable.length > LIMITS.priceRows) throw invalid('priceTable', `Use at most ${LIMITS.priceRows} rows`);
    const steps = (input.steps ?? []).map((s, i) => ({ title: requireText(s.title, `steps[${i}].title`, LIMITS.short), detail: optionalText(s.detail, `steps[${i}].detail`, LIMITS.listItem) }));
    if (steps.length > LIMITS.steps) throw invalid('steps', `Use at most ${LIMITS.steps} steps`);
    return {
      area,
      title,
      slug,
      provider_id: provider.id,
      category_id: input.categoryId ?? null,
      summary: optionalText(input.summary, 'summary', LIMITS.summary),
      badge: optionalText(input.badge, 'badge', 30),
      from_price: price?.amount ?? null,
      currency: price?.currency ?? this.currency,
      price_unit: unit,
      duration_label: optionalText(input.durationLabel, 'durationLabel', 40),
      supported_label: optionalText(input.supportedLabel, 'supportedLabel', LIMITS.short),
      coverage: optionalText(input.coverage, 'coverage', LIMITS.short),
      tags: textList(input.tags, 'tags', 6, 30),
      description: optionalText(input.description, 'description', 4000),
      included: textList(input.included, 'included', LIMITS.listItems, LIMITS.listItem),
      requirements: textList(input.requirements, 'requirements', LIMITS.listItems, LIMITS.listItem),
      supported: textList(input.supported, 'supported', 40, LIMITS.short),
      os_versions: textList(input.osVersions, 'osVersions', 12, 40),
      handover,
      price_table: priceTable,
      price_table_title: optionalText(input.priceTableTitle, 'priceTableTitle', 60),
      terms: textList(input.terms, 'terms', LIMITS.listItems, LIMITS.listItem),
      steps,
      slot_minutes: input.slotMinutes ?? null,
      duration_minutes: input.durationMinutes ?? null,
      status: input.status ?? 'published',
    };
  }

  async createService(input: ServiceInput, by: By): Promise<ServiceAdmin> {
    const f = await this.serviceFields(input);
    const media = this.pictures(input);
    const id = newId();
    const now = this.now();
    const position = input.position ?? (await this.repo.maxServicePosition(f.area)) + 1;
    await this.withMedia(id, f.title, [], this.mediaPaths(media), () =>
      this.repo.insertService({ id, ...f, tags: f.tags as never, included: f.included as never, requirements: f.requirements as never, supported: f.supported as never, os_versions: f.os_versions as never, handover: f.handover as never, price_table: f.price_table as never, terms: f.terms as never, steps: f.steps as never, image: media.image, photos: media.photos, position, rating_sum: 0, rating_count: 0, rating_stars: [0, 0, 0, 0, 0], created_at: now, updated_at: now }),
    );
    const out = await this.getServiceAdmin(id);
    await this.audit({ action: 'services.service.create', actionLabel: 'Added a service', target: { type: 'service', id, label: f.title }, after: out }, by);
    return out;
  }

  async updateService(id: string, input: ServiceInput, by: By): Promise<ServiceAdmin> {
    const before = await this.repo.getService(id);
    if (!before) throw notFound('Service');
    const f = await this.serviceFields({ ...input, status: input.status ?? (before.status as ServiceInput['status']) }, id);
    const media = this.pictures({ image: input.image === undefined ? (mediaOf(before.image) as never) : input.image, photos: input.photos === undefined ? (mediaList(before.photos) as never) : input.photos });
    const prev = [mediaOf(before.image), ...mediaList(before.photos)].filter((m): m is StoredMedia => Boolean(m));
    await this.withMedia(id, f.title, prev, this.mediaPaths(media), () =>
      this.repo.updateService(id, { ...f, tags: f.tags as never, included: f.included as never, requirements: f.requirements as never, supported: f.supported as never, os_versions: f.os_versions as never, handover: f.handover as never, price_table: f.price_table as never, terms: f.terms as never, steps: f.steps as never, image: media.image, photos: media.photos, ...(input.position != null ? { position: input.position } : {}), updated_at: this.now() }),
    );
    const out = await this.getServiceAdmin(id);
    await this.audit({ action: 'services.service.update', actionLabel: 'Changed a service', target: { type: 'service', id, label: f.title }, before: { title: before.title, status: before.status }, after: out }, by);
    return out;
  }

  async deleteService(id: string, by: By): Promise<void> {
    const s = await this.repo.getService(id);
    if (!s) throw notFound('Service');
    // requests keep pointing at their service (customers' history), so a service with any request is hidden instead
    if (await this.repo.countRequests({ serviceId: id })) throw this.ctx.error('IN_USE', 'Requests use this service; hide it instead.');
    await this.repo.deleteService(id);
    await this.detachAll(id, [mediaOf(s.image), ...mediaList(s.photos)].filter((m): m is StoredMedia => Boolean(m)));
    await this.audit({ action: 'services.service.delete', actionLabel: 'Deleted a service', target: { type: 'service', id, label: s.title }, before: { title: s.title } }, by);
  }

  /** Used by requests: by.actor as history text */
  protected byKey(by: By) {
    return actorKey(by.actor);
  }

  protected isoOf = iso;
}
