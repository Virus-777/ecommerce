/**
 * Phones: the standalone phones staff add for the Phone tab (brand, name, overview, storage sizes with prices, colors,
 * full-size photos and a grouped spec sheet), in staff order. They are not catalog products and cannot be ordered:
 * the page's Find in store button opens the store search. Preview photos (the Detail tab's gallery, first = cover)
 * and advertisement images (the Advertisements tab, never also a preview photo) are content_image uploads (at least
 * 1080 px wide) used as content_block usages, like company photos.
 *
 * Before standalone phones staff picked catalog products (phone_picks, id phones); the departments.import-phone-picks
 * job turns those picks into phones once (catalog for the content, search for the price) and then empties them.
 */
import { newId } from '../../../kernel/lib/ids.js';
import type { Json } from '../../../kernel/lib/json.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type * as search from '../../../spec/search.js';
import type { Phone, PhoneAdmin, PhoneCard, PhoneColor, PhoneInput, PhonePhoto, PhonesAdmin, PhonesOrderInput, PhonesPage, PhoneSpecGroup, PhoneStorage } from '../../../spec/departments.js';
import { LIMITS, slugOf } from '../domain/rules.js';
import type { PhoneRow } from '../ports.js';
import { actorKey, DepartmentsBase, invalid, notFound, optionalText, requireText, unique, type By } from './base.js';

const HEX = /^#[0-9a-f]{6}$/i;
const ACTOR_KINDS = new Set<string>(['customer', 'visitor', 'seller', 'staff', 'provider', 'anonymous', 'system']);
/** The import job's updated_by */
const IMPORT_ACTOR = 'system:departments.import-phone-picks';
/** A swatch for a color the import can't name */
const UNKNOWN_HEX = '#9E9E9E';
/** Swatches for color words the import meets on catalog variants */
const NAMED_HEX: Record<string, string> = {
  black: '#222222', white: '#F5F5F5', gray: '#8C918F', grey: '#8C918F', silver: '#C0C0C0', gold: '#D4AF37', blue: '#3B5BA9', navy: '#1F2A44', red: '#C62828', green: '#4E7D5B', mint: '#A8D5BA', purple: '#7E57C2', violet: '#8E86A8', lavender: '#B9A7D9', pink: '#F4A6B7', yellow: '#F2D04B', orange: '#F28C28', titanium: '#8A8D8F', graphite: '#4A4A4A', cream: '#F3EAD3', beige: '#D8C8A8', bronze: '#8C6A43', brown: '#6D4C41',
};

/* ------------------------------------------------------------------ stored shapes (jsonb columns) */

type StoredStorage = { size: string; price: common.Money; was: common.Money | null };
type StoredColor = { name: string; short: string | null; hex: string };
type StoredPhoto = { id: string; alt: string | null };
type StoredGroup = { name: string; rows: { name: string; value: string }[] };
const json = (v: unknown) => v as Json;

const moneyOf = (v: unknown): common.Money | null => {
  const m = v as common.Money | null;
  return m && typeof m === 'object' && Number.isInteger(m.amount) && typeof m.currency === 'string' ? { amount: m.amount, currency: m.currency } : null;
};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object') : []);
const storageOf = (v: unknown): StoredStorage[] =>
  list(v).flatMap((s) => {
    const price = moneyOf(s.price);
    return typeof s.size === 'string' && price ? [{ size: s.size, price, was: moneyOf(s.was) }] : [];
  });
const colorsOf = (v: unknown): StoredColor[] => list(v).flatMap((c) => (typeof c.name === 'string' && typeof c.hex === 'string' ? [{ name: c.name, short: typeof c.short === 'string' && c.short ? c.short : null, hex: c.hex }] : []));
const photosOf = (v: unknown): StoredPhoto[] => list(v).flatMap((p) => (typeof p.id === 'string' ? [{ id: p.id, alt: typeof p.alt === 'string' && p.alt ? p.alt : null }] : []));
const groupsOf = (v: unknown): StoredGroup[] =>
  list(v).flatMap((g) => (typeof g.name === 'string' ? [{ name: g.name, rows: list(g.rows).flatMap((r) => (typeof r.name === 'string' && typeof r.value === 'string' ? [{ name: r.name, value: r.value }] : [])) }] : []));
/** "staff:<id>" back to an actor */
const actorOf = (key: string | null): common.Actor | null => {
  if (!key) return null;
  const at = key.indexOf(':');
  const kind = at < 0 ? key : key.slice(0, at);
  return ACTOR_KINDS.has(kind) ? { kind: kind as common.Actor['kind'], id: at < 0 ? null : key.slice(at + 1) || null } : null;
};

/** The deal on a price: the was price when above it, and the whole percent off (null below 1%) */
export function dealOf(price: common.Money, was: common.Money | null | undefined): { was: common.Money | null; dealPercent: number | null } {
  if (!was || was.currency !== price.currency || was.amount <= price.amount) return { was: null, dealPercent: null };
  const pct = Math.floor(((was.amount - price.amount) / was.amount) * 100);
  return { was, dealPercent: pct > 0 ? pct : null };
}

/** Cuts text to `max` characters (an ellipsis marks the cut) */
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** A product description as an overview: plain text, paragraphs kept, at most phoneOverview characters */
function overviewOf(description: string | null | undefined): string | null {
  const text = String(description ?? '')
    .replace(/<\/(p|h[1-6]|li|div)>|<br\s*\/?>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? clip(text, LIMITS.phoneOverview) : null;
}

type Refs = { large: Map<string, common.MediaRef>; zoom: Map<string, common.MediaRef>; thumb: Map<string, common.MediaRef> };

export class DepartmentsPhones extends DepartmentsBase {
  protected get currency(): string {
    return this.ctx.config.market.currency || 'USD';
  }

  /* ---------------------------------------------------------------- output */

  /** The large, zoom and thumb renditions of the phones' photos and ad images (one media call per size) */
  private async phonePhotoRefs(rows: PhoneRow[]): Promise<Refs> {
    const ids = unique(rows.flatMap((r) => [...photosOf(r.photos), ...photosOf(r.ad_images)].map((p) => p.id)));
    const [large, zoom, thumb] = await Promise.all([this.refsMap(ids, 'large'), this.refsMap(ids, 'zoom'), this.refsMap(ids, 'thumb')]);
    return { large, zoom, thumb };
  }

  /** The pictures of a photos or ad_images column that media still serves, in staff order */
  private photosOut(stored: unknown, refs: Refs): PhonePhoto[] {
    return photosOf(stored).flatMap((p) => {
      const large = refs.large.get(p.id);
      if (!large) return [];
      return [{ id: p.id, url: large.url, zoomUrl: refs.zoom.get(p.id)?.url ?? large.url, thumbUrl: refs.thumb.get(p.id)?.url ?? large.thumbUrl ?? null, width: large.width ?? null, height: large.height ?? null, alt: p.alt ?? large.alt ?? null }];
    });
  }

  private storageOut(row: PhoneRow): PhoneStorage[] {
    return storageOf(row.storage).map((s) => ({ size: s.size, price: s.price, was: dealOf(s.price, s.was).was }));
  }

  private colorsOut(row: PhoneRow): PhoneColor[] {
    return colorsOf(row.colors);
  }

  private groupsOut(row: PhoneRow): PhoneSpecGroup[] {
    return groupsOf(row.spec_groups);
  }

  private async phonesAdmin(rows: PhoneRow[]): Promise<PhoneAdmin[]> {
    const refs = await this.phonePhotoRefs(rows);
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      brand: row.brand,
      name: row.name,
      overview: row.overview,
      storage: this.storageOut(row),
      colors: this.colorsOut(row),
      photos: this.photosOut(row.photos, refs),
      adImages: this.photosOut(row.ad_images, refs),
      specGroups: this.groupsOut(row),
      showServices: row.show_services,
      searchTerm: row.search_term,
      status: row.status,
      position: row.position,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      updatedBy: actorOf(row.updated_by),
    }));
  }

  /** A phone's card: the first storage's price, first size · first color, and the cover photo (medium) */
  private phoneCardOf(row: PhoneRow, covers: Map<string, common.MediaRef>): PhoneCard {
    const [first] = storageOf(row.storage);
    const [color] = colorsOf(row.colors);
    const price = first?.price ?? { amount: 0, currency: this.currency };
    const cover = photosOf(row.photos).find((p) => covers.has(p.id));
    const ref = cover ? covers.get(cover.id)! : null;
    return { id: row.id, slug: row.slug, brand: row.brand, name: row.name, meta: [first?.size, color?.name].filter(Boolean).join(' · '), price, ...dealOf(price, first?.was), image: ref ? { ...ref, alt: cover!.alt ?? ref.alt ?? null } : null };
  }

  /* ---------------------------------------------------------------- store */

  async getPhones(): Promise<PhonesPage> {
    const rows = await this.repo.listPhones({ publishedOnly: true });
    const covers = await this.refsMap(rows.map((r) => photosOf(r.photos)[0]?.id), 'medium');
    return { phones: rows.map((r) => this.phoneCardOf(r, covers)), brands: unique(rows.map((r) => r.brand)) };
  }

  async getPhone(slug: string): Promise<Phone> {
    const row = await this.repo.phoneBySlug(slug);
    if (!row || row.status !== 'published') throw notFound('Phone');
    const refs = await this.phonePhotoRefs([row]);
    return {
      id: row.id,
      slug: row.slug,
      brand: row.brand,
      name: row.name,
      overview: row.overview,
      storage: this.storageOut(row),
      colors: this.colorsOut(row),
      photos: this.photosOut(row.photos, refs),
      adImages: this.photosOut(row.ad_images, refs),
      specGroups: this.groupsOut(row),
      showServices: row.show_services,
      searchTerm: row.search_term ?? row.name,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /* ---------------------------------------------------------------- admin */

  async listPhonesAdmin(): Promise<PhonesAdmin> {
    return { items: await this.phonesAdmin(await this.repo.listPhones()) };
  }

  async getPhoneAdmin(id: string): Promise<PhoneAdmin> {
    const row = await this.repo.getPhone(id);
    if (!row) throw notFound('Phone');
    return (await this.phonesAdmin([row]))[0]!;
  }

  /** A price of the form: whole cents above zero, in the market currency */
  private phoneMoney(m: common.Money | null | undefined, path: string, message: string): common.Money {
    if (!m || !Number.isInteger(m.amount) || m.amount <= 0) throw invalid(path, message);
    if (m.currency !== this.currency) throw invalid(`${path}.currency`, `Use ${this.currency}`);
    return { amount: m.amount, currency: m.currency };
  }

  /** The checked parts of a phone input (spec rows with an empty name or value are left out, then empty groups) */
  private phoneFields(input: PhoneInput) {
    const brand = requireText(input.brand, 'brand', LIMITS.phoneBrand, 'Enter the brand');
    const name = requireText(input.name, 'name', LIMITS.name, 'Name the phone');

    const storageIn = input.storage ?? [];
    if (!storageIn.length) throw invalid('storage', 'Add at least one storage size with its price');
    if (storageIn.length > LIMITS.phoneStorage) throw invalid('storage', `Add at most ${LIMITS.phoneStorage} storage sizes`);
    const sizes = new Set<string>();
    const storage: StoredStorage[] = storageIn.map((s, i) => {
      const size = requireText(s?.size, `storage[${i}].size`, LIMITS.phoneStorageSize, 'Enter the size, e.g. 256 GB');
      if (sizes.has(size.toLowerCase())) throw invalid(`storage[${i}].size`, 'Each size can be listed once');
      sizes.add(size.toLowerCase());
      const price = this.phoneMoney(s.price, `storage[${i}].price`, 'Enter a price above zero');
      const was = s.was == null ? null : this.phoneMoney(s.was, `storage[${i}].was`, 'Enter a was price above zero, or leave it empty');
      if (was && was.amount <= price.amount) throw invalid(`storage[${i}].was`, 'The was price must be above the price');
      return { size, price, was };
    });

    const colorsIn = input.colors ?? [];
    if (colorsIn.length > LIMITS.phoneColors) throw invalid('colors', `Add at most ${LIMITS.phoneColors} colors`);
    const colors: StoredColor[] = colorsIn.map((c, i) => {
      const name = requireText(c?.name, `colors[${i}].name`, LIMITS.phoneColorName, 'Name the color');
      const hex = c.hex?.trim() ?? '';
      if (!HEX.test(hex)) throw invalid(`colors[${i}].hex`, 'Use a color like #8C918F');
      return { name, short: optionalText(c.short, `colors[${i}].short`, LIMITS.phoneColorShort), hex: hex.toUpperCase() };
    });

    const photosIn = input.photos ?? [];
    if (!photosIn.length) throw invalid('photos', 'Add at least one photo');
    if (photosIn.length > LIMITS.phonePhotos) throw invalid('photos', `Add at most ${LIMITS.phonePhotos} photos`);
    const photoIds = new Set<string>();
    const photos: StoredPhoto[] = photosIn.map((p, i) => {
      if (photoIds.has(p.id)) throw invalid(`photos[${i}]`, 'Each photo can be added once');
      photoIds.add(p.id);
      return { id: p.id, alt: optionalText(p.alt, `photos[${i}].alt`, LIMITS.phonePhotoAlt) };
    });

    const adIn = input.adImages ?? [];
    if (adIn.length > LIMITS.phonePhotos) throw invalid('adImages', `Add at most ${LIMITS.phonePhotos} advertisement images`);
    const adIds = new Set<string>();
    const adImages: StoredPhoto[] = adIn.map((p, i) => {
      if (photoIds.has(p.id)) throw invalid(`adImages[${i}]`, 'This image is already a preview photo; use a different image here');
      if (adIds.has(p.id)) throw invalid(`adImages[${i}]`, 'Each image can be added once');
      adIds.add(p.id);
      return { id: p.id, alt: optionalText(p.alt, `adImages[${i}].alt`, LIMITS.phonePhotoAlt) };
    });

    const specGroups: StoredGroup[] = [];
    (input.specGroups ?? []).forEach((g, i) => {
      const rows = (g?.rows ?? []).flatMap((r, j) => {
        const rowName = r?.name?.trim();
        const value = r?.value?.trim();
        if (!rowName || !value) return [];
        if (rowName.length > LIMITS.phoneSpecName) throw invalid(`specGroups[${i}].rows[${j}].name`, `Use at most ${LIMITS.phoneSpecName} characters`);
        if (value.length > LIMITS.phoneSpecValue) throw invalid(`specGroups[${i}].rows[${j}].value`, `Use at most ${LIMITS.phoneSpecValue} characters`);
        return [{ name: rowName, value }];
      });
      if (!rows.length) return;
      if (rows.length > LIMITS.phoneSpecRows) throw invalid(`specGroups[${i}].rows`, `Add at most ${LIMITS.phoneSpecRows} rows to a group`);
      specGroups.push({ name: requireText(g.name, `specGroups[${i}].name`, LIMITS.phoneSpecName, 'Name the group, e.g. Display'), rows });
    });
    if (specGroups.length > LIMITS.phoneSpecGroups) throw invalid('specGroups', `Add at most ${LIMITS.phoneSpecGroups} groups`);

    return {
      brand,
      name,
      overview: optionalText(input.overview, 'overview', LIMITS.phoneOverview),
      storage,
      colors,
      photos,
      adImages,
      specGroups,
      searchTerm: optionalText(input.searchTerm, 'searchTerm', LIMITS.phoneSearchTerm),
    };
  }

  private phoneColumnsOf(f: ReturnType<DepartmentsPhones['phoneFields']>) {
    return { brand: f.brand, name: f.name, overview: f.overview, storage: json(f.storage), colors: json(f.colors), photos: json(f.photos), ad_images: json(f.adImages), spec_groups: json(f.specGroups), search_term: f.searchTerm };
  }

  /** Pictures new to a phone must be at least phonePhotoMinWidth wide (media checks the measured file) */
  private async checkPhotoWidths(files: { id: string; path: string }[], before: StoredPhoto[]) {
    const old = new Set(before.map((p) => p.id));
    for (const p of files) {
      if (old.has(p.id)) continue;
      const result = await this.media.checkImage(p.id, { minWidth: LIMITS.phonePhotoMinWidth, aspectRatios: [], formats: [] });
      const small = result.issues.find((x) => x.code === 'too_small' && x.severity === 'blocking');
      if (small) throw invalid(p.path, `${small.message} Phone photos need to be at least ${LIMITS.phonePhotoMinWidth.toLocaleString('en-US')} px wide.`);
    }
  }

  /** Every picture of a phone with its field path: preview photos, then ad images */
  private phoneFilesOf(f: { photos: StoredPhoto[]; adImages: StoredPhoto[] }) {
    return [...f.photos.map((p, i) => ({ id: p.id, path: `photos[${i}]` })), ...f.adImages.map((p, i) => ({ id: p.id, path: `adImages[${i}]` }))];
  }

  /** The pictures a stored phone uses */
  private storedFiles(row: PhoneRow): StoredPhoto[] {
    return [...photosOf(row.photos), ...photosOf(row.ad_images)];
  }

  /** Puts a phone at a 1-based place, the others keeping their order (positions become 1…n) */
  private async movePhone(id: string, position: number) {
    const ids = (await this.repo.listPhones()).map((r) => r.id).filter((x) => x !== id);
    ids.splice(Math.min(Math.max(position, 1), ids.length + 1) - 1, 0, id);
    await this.repo.setPhonePositions(ids);
  }

  async createPhone(input: PhoneInput, by: By): Promise<PhoneAdmin> {
    const f = this.phoneFields(input);
    const id = newId();
    const now = this.now();
    const slug = await this.slugFor('phones', input.slug, f.name);
    const row: PhoneRow = { id, slug, ...this.phoneColumnsOf(f), show_services: input.showServices ?? true, status: input.status ?? 'published', position: await this.repo.nextPhonePosition(), created_at: now, updated_at: now, updated_by: actorKey(by.actor) };
    const files = this.phoneFilesOf(f);
    await this.withMedia(id, f.name, [], files, async () => {
      await this.checkPhotoWidths(files, []);
      return this.repo.insertPhone(row);
    });
    if (input.position != null) await this.movePhone(id, input.position);
    const saved = (await this.repo.getPhone(id))!;
    await this.audit({ action: 'departments.phones.create', actionLabel: 'Added a phone', target: { type: 'phone', id, label: f.name }, after: saved }, by);
    return (await this.phonesAdmin([saved]))[0]!;
  }

  async updatePhone(id: string, input: PhoneInput, by: By): Promise<PhoneAdmin> {
    const before = await this.repo.getPhone(id);
    if (!before) throw notFound('Phone');
    const f = this.phoneFields(input);
    const slug = input.slug !== undefined && input.slug !== null ? await this.slugFor('phones', input.slug, f.name, id) : before.slug;
    const prev = this.storedFiles(before);
    const patch: Partial<PhoneRow> = { ...this.phoneColumnsOf(f), slug, show_services: input.showServices ?? before.show_services, status: input.status ?? before.status, updated_at: this.now(), updated_by: actorKey(by.actor) };
    const files = this.phoneFilesOf(f);
    await this.withMedia(id, f.name, prev, files, async () => {
      await this.checkPhotoWidths(files, prev);
      return this.repo.updatePhone(id, patch);
    });
    if (input.position != null && input.position !== before.position) await this.movePhone(id, input.position);
    const after = (await this.repo.getPhone(id))!;
    const actionLabel = after.status !== before.status ? (after.status === 'hidden' ? 'Hid a phone' : 'Showed a phone again') : 'Edited a phone';
    await this.audit({ action: 'departments.phones.update', actionLabel, target: { type: 'phone', id, label: f.name }, before, after }, by);
    return (await this.phonesAdmin([after]))[0]!;
  }

  async deletePhone(id: string, by: By): Promise<void> {
    const row = await this.repo.getPhone(id);
    if (!row) throw notFound('Phone');
    await this.repo.deletePhone(id);
    await this.repo.setPhonePositions((await this.repo.listPhones()).map((r) => r.id));
    await this.detachAll(id, this.storedFiles(row));
    await this.audit({ action: 'departments.phones.delete', actionLabel: 'Deleted a phone', target: { type: 'phone', id, label: row.name }, before: row }, by);
  }

  async reorderPhones(input: PhonesOrderInput, by: By): Promise<PhonesAdmin> {
    const rows = await this.repo.listPhones();
    const ids = input.ids ?? [];
    const known = new Set(rows.map((r) => r.id));
    if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((x) => !known.has(x))) throw invalid('ids', 'List every phone once, in the new order');
    await this.repo.setPhonePositions(ids);
    await this.audit({ action: 'departments.phones.reorder', actionLabel: 'Reordered the Phone tab', target: { type: 'phone_list', id: 'phones', label: 'Phone tab' }, before: { ids: rows.map((r) => r.id) }, after: { ids } }, by);
    return this.listPhonesAdmin();
  }

  /* ---------------------------------------------------------------- import of the old picks */

  /**
   * Job departments.import-phone-picks (on boot): once, turns the products picked before standalone phones into
   * phones in the same order, then empties the picks. Waits for a later start while catalog or search is off (no
   * content or price to copy). A phone whose slug already exists counts as imported (another process did it, or a
   * rerun after a crash); products catalog can't read or search shows no price for are skipped and logged.
   */
  async importPhonePicks(): Promise<{ imported: number; skipped: number }> {
    const picks = await this.repo.getPicks();
    const ids = unique(Array.isArray(picks?.product_ids) ? picks.product_ids.filter((x): x is string => typeof x === 'string') : []);
    if (!ids.length) return { imported: 0, skipped: 0 };
    const catalogApi = this.ctx.tryUse('catalog');
    if (!catalogApi || !this.ctx.tryUse('search')) {
      this.ctx.log.warn({ picks: ids.length }, 'departments: phone picks not imported while catalog or search is off; trying again at the next start');
      return { imported: 0, skipped: 0 };
    }
    const cards = new Map((await this.cardsFor(ids)).map((c) => [c.productId, c]));
    let imported = 0;
    let skipped = 0;
    for (const productId of ids) {
      let product: catalog.Product | null = null;
      try {
        product = await catalogApi.getProduct(productId);
      } catch (err) {
        this.ctx.log.warn({ err, productId }, 'departments: picked phone not imported (catalog could not read it)');
      }
      const card = cards.get(productId);
      if (!product || !card) {
        this.ctx.log.warn({ productId }, product ? 'departments: picked phone not imported (no price: the store no longer shows it)' : 'departments: picked phone not imported (product not found)');
        skipped++;
        continue;
      }
      if (await this.importProduct(product, card)) imported++;
      else skipped++;
    }
    await this.repo.savePicks([], IMPORT_ACTOR, this.now());
    this.ctx.log.info({ imported, skipped }, 'departments: phone picks imported as phones');
    return { imported, skipped };
  }

  /** One picked product as a phone; false when a phone with its slug exists already */
  private async importProduct(p: catalog.Product, card: search.ProductCard): Promise<boolean> {
    const name = clip(p.title.trim(), LIMITS.name);
    const slug = slugOf(null, name);
    if (await this.repo.phoneBySlug(slug)) return false;
    const option = (v: catalog.Variant, re: RegExp) => Object.entries(v.options ?? {}).find(([k]) => re.test(k))?.[1]?.trim();
    const price = { amount: card.price.amount, currency: card.price.currency };
    const was = card.wasPrice && card.wasPrice.amount > price.amount ? { amount: card.wasPrice.amount, currency: card.wasPrice.currency } : null;
    const sizes = unique(p.variants.map((v) => option(v, /storage|capacity/i)).filter((s): s is string => Boolean(s))).slice(0, LIMITS.phoneStorage);
    const storage: StoredStorage[] = (sizes.length ? sizes : ['Standard']).map((size) => ({ size: clip(size, LIMITS.phoneStorageSize), price, was }));
    const colorNames = unique(p.variants.map((v) => option(v, /colou?r/i)).filter((s): s is string => Boolean(s))).slice(0, LIMITS.phoneColors);
    const colors: StoredColor[] = colorNames.map((c) => {
      const word = c.toLowerCase().split(/[^a-z]+/).reverse().find((w) => NAMED_HEX[w]);
      return { name: clip(c, LIMITS.phoneColorName), short: null, hex: word ? NAMED_HEX[word]! : UNKNOWN_HEX };
    });
    const specRows = Object.entries(p.specs ?? {})
      .filter(([k, v]) => k.trim() && String(v ?? '').trim())
      .slice(0, LIMITS.phoneSpecRows)
      .map(([k, v]) => ({ name: clip(k.trim(), LIMITS.phoneSpecName), value: clip(String(v).trim(), LIMITS.phoneSpecValue) }));
    const imageIds = unique([...p.images, ...p.variants.flatMap((v) => v.images ?? [])].map((i) => i.id)).slice(0, LIMITS.phonePhotos);

    // product images keep their owner (often the seller): each becomes a content_block usage of the phone
    const id = newId();
    const photos: StoredPhoto[] = [];
    for (const assetId of imageIds) {
      try {
        const asset = await this.media.getAsset(assetId);
        if (!asset || asset.status !== 'ready') continue;
        await this.media.attach(assetId, { module: 'departments', kind: 'content_block', refId: id, refLabel: name }, asset.owner);
        photos.push({ id: assetId, alt: p.images.find((i) => i.id === assetId)?.alt ?? null });
      } catch (err) {
        this.ctx.log.warn({ err, assetId, productId: p.id }, 'departments: a product image was left out of an imported phone');
      }
    }
    const now = this.now();
    const row: PhoneRow = {
      id,
      slug,
      brand: clip((p.brand?.name ?? card.brandName ?? name.split(/\s+/)[0] ?? 'Phone').trim(), LIMITS.phoneBrand),
      name,
      overview: overviewOf(p.description),
      storage: json(storage),
      colors: json(colors),
      photos: json(photos),
      ad_images: json([]),
      spec_groups: json(specRows.length ? [{ name: 'Specifications', rows: specRows }] : []),
      show_services: true,
      search_term: null,
      status: 'published',
      position: await this.repo.nextPhonePosition(),
      created_at: now,
      updated_at: now,
      updated_by: IMPORT_ACTOR,
    };
    let saved: PhoneRow | undefined;
    try {
      saved = await this.repo.insertPhoneIfAbsent(row);
    } finally {
      if (!saved) await this.detachAll(id, photos);
    }
    return Boolean(saved);
  }
}
