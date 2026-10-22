/**
 * Advertising's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from
 * the spec exist, and is recorded in the kernel's migrations collection.
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';
import { CAROUSEL_MAX_LIVE, pageOptionsOf, SLOT_NAMES, slotRotationLabel, STAFF_AD_SLOTS } from './domain/rules.js';
import { inferDestination } from './domain/staff-ads.js';

/**
 * The home banner carousel shows every live ad (owner decision 2026-10-18): the launch placement capped it at 3
 * (max_per_page 3, rotation.maxInRotation 3). On a database seeded before that, this clears both limits, but only
 * while they are still the seeded 3s: a limit staff set in Placements and rules is kept.
 *
 * Safe to run again: it only touches a home_banner placement that still has the old limits.
 */
export const homeBannerShowsAllAds: MongoMigration = {
  id: '2026-10-18-home-banner-shows-all-ads',
  async up(db) {
    await db
      .collection('advertising.placements')
      .updateOne(
        { key: 'home_banner', max_per_page: 3, 'rotation.maxInRotation': 3 },
        { $set: { max_per_page: null, 'rotation.maxInRotation': null, 'rotation.label': 'Carousel, 6 s each' } },
      );
  },
};

/**
 * Staff ads (2026-10-23): carousels serve by campaigns.position, and destinations are picked kinds resolved to store
 * paths. Campaigns made before get a position in creation order per placement (1, 2, 3…; only where none is set), and
 * staff destinations of the wizard's kinds become typed links (kind url, the same path), which the new page edits.
 *
 * Safe to run again: rows that already have a position, or a destination of a picked kind or url, are left alone.
 */
export const staffAdPositionsAndLinks: MongoMigration = {
  id: '2026-10-23-staff-ad-positions-and-links',
  async up(db) {
    const campaigns = db.collection('advertising.campaigns');
    const rows = await campaigns.find({}, { projection: { _id: 1, placement_id: 1, position: 1, created_at: 1 } }).sort({ placement_id: 1, created_at: 1, _id: 1 }).toArray();
    const next = new Map<string, number>();
    for (const r of rows) if (typeof r.position === 'number') next.set(String(r.placement_id), Math.max(next.get(String(r.placement_id)) ?? 0, r.position));
    for (const r of rows) {
      if (typeof r.position === 'number') continue;
      const key = String(r.placement_id);
      const position = (next.get(key) ?? 0) + 1;
      next.set(key, position);
      await campaigns.updateOne({ _id: r._id, position: { $in: [null] } }, { $set: { position } });
    }
    const picked = ['url', 'product', 'category', 'department', 'restaurant', 'deal', 'collection', 'seller_store', 'brand', 'phone'];
    await campaigns.updateMany({ origin: 'staff', 'destination.kind': { $nin: picked } }, [{ $set: { destination: { kind: 'url', targetId: null, url: { $ifNull: ['$destination.url', ''] } } } }]);
    // wizard destinations of kinds that are now picked (product, brand…) had no resolved label: keep them as links too
    await campaigns.updateMany({ origin: 'staff', 'destination.kind': { $in: ['product', 'seller_store', 'brand', 'collection'] }, 'destination.label': { $exists: false } }, [{ $set: { destination: { kind: 'url', targetId: null, url: { $ifNull: ['$destination.url', ''] } } } }]);
  },
};

/**
 * Store paths saved as links (kind url, and the wizard's offer and campaign_page kinds) become the destination they
 * name (domain/staff-ads.ts inferDestination): /p/{slug}/{id} and /product/{id} a product, /c/{slug} a category,
 * /pages|/collections|/collection/{slug} a collection, /deals the Deals tab and /deals?campaign={id} a deal, the ten
 * department paths (and the old /softwares) a department, /phones/{slug} a phone, /food/restaurants/{slug} a
 * restaurant, /shop/{slug} and /official a store, /brand/{slug} a brand. Ids in the path are kept; slugs are kept as
 * destination.slug and looked up when the ad is read (this migration reads no other module's data). The path becomes
 * the canonical one the app opens. Other store paths and https addresses stay links. Staff campaigns only (seller
 * requests keep their promoted offer).
 *
 * Safe to run again: only links whose path names something change, and a converted row is no longer a link.
 */
export const staffAdDestinationsFromPaths: MongoMigration = {
  id: '2026-10-23-staff-ad-destinations-from-paths',
  async up(db) {
    const campaigns = db.collection('advertising.campaigns');
    const rows = await campaigns.find({ origin: 'staff', 'destination.kind': { $in: ['url', 'offer', 'campaign_page'] } }, { projection: { _id: 1, destination: 1 } }).toArray();
    for (const r of rows) {
      const url = (r.destination as { url?: string } | null)?.url ?? '';
      const inf = inferDestination(url);
      if (inf.kind === 'url') continue;
      await campaigns.updateOne({ _id: r._id, 'destination.url': url }, { $set: { destination: { kind: inf.kind, targetId: inf.targetId, slug: inf.slug, url: inf.path } } });
    }
  },
};

/**
 * Slot settings (2026-10-23): the slots of the Advertisements page get the names of its tabs, show only on the pages
 * the app and website ask for them (eligible pages within pageOptionsOf; the pop-up loses product and campaign
 * pages, the full-screen ad campaign and collection pages), carousels allow 10 live ads where no limit was set, and
 * the rotation lines say how the slot plays its ads. Other slots are left alone.
 *
 * Safe to run again: it writes the same values.
 */
export const slotSettings: MongoMigration = {
  id: '2026-10-23-ad-slot-settings',
  async up(db) {
    const placements = db.collection('advertising.placements');
    for (const key of STAFF_AD_SLOTS) {
      const p = await placements.findOne({ key });
      if (!p) continue;
      const options = pageOptionsOf(key);
      const kept = ((p.eligible_pages ?? []) as string[]).filter((x) => options.includes(x));
      const rotation = (p.rotation ?? {}) as { mode?: string; carouselSeconds?: number | null; maxInRotation?: number | null };
      const carousel = rotation.mode === 'carousel';
      await placements.updateOne(
        { _id: p._id },
        {
          $set: {
            name: SLOT_NAMES[key]!,
            eligible_pages: kept.length ? kept : options,
            rotation: { ...rotation, label: slotRotationLabel(key, rotation as never) },
            ...(carousel && !p.max_per_page ? { max_per_page: CAROUSEL_MAX_LIVE } : {}),
          },
        },
      );
    }
  },
};

export const mongoMigrations: readonly MongoMigration[] = [homeBannerShowsAllAds, staffAdPositionsAndLinks, staffAdDestinationsFromPaths, slotSettings];
