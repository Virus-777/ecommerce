/**
 * Content's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import { newId } from '../../kernel/lib/ids.js';
import type { MongoMigration } from '../../kernel/mongo/schema.js';
import { defaultDepartmentItems } from './domain/rules.js';

/**
 * News for customers (docs/06-news.md, 2026-10-18): the starting news categories. Staff rename, hide, reorder or
 * delete them in Admin › News; this only adds them to a database that has no news categories yet.
 */
export const newsCategories: MongoMigration = {
  id: '2026-10-18-news-categories',
  async up(db) {
    const col = db.collection('content.news_categories');
    if (await col.countDocuments({}, { limit: 1 })) return;
    const seed = [
      { slug: 'announcements', name: 'Announcements', icon: 'megaphone' },
      { slug: 'service-updates', name: 'Service updates', icon: 'truck' },
      { slug: 'events', name: 'Events', icon: 'calendar' },
      { slug: 'policy-changes', name: 'Policy changes', icon: 'shield-check' },
    ];
    await col.insertMany(seed.map((c, i) => ({ _id: newId(), ...c, position: i + 1, visible: true, previous_slugs: [] })) as never[]);
  },
};

/**
 * Departments (2026-10-21): the homepage Shop by category section becomes the Departments rail. Each
 * category_shortcuts section, in the draft rows and in the live and draft layouts, turns into a departments section
 * with the ten department pages; its categories stay in the list as hidden items, so staff can show them again.
 * Older layout versions keep category_shortcuts, which still shows if one is restored.
 */
export const departmentsRail: MongoMigration = {
  id: '2026-10-21-departments-rail',
  async up(db) {
    const rows = db.collection('content.home_sections');
    const versions = db.collection('content.versions');
    const old = await rows.find({ kind: 'category_shortcuts' }).toArray();
    const layouts = await versions.find({ entity: 'homepage', state: { $in: ['live', 'draft'] }, 'snapshot.sections.kind': 'category_shortcuts' }).toArray();
    if (!old.length && !layouts.length) return;
    const names = new Map((await db.collection('catalog.categories').find({}, { projection: { name: 1 } }).toArray()).map((c) => [String(c._id), String(c.name ?? '')]));
    // one set of items per section, shared by its row and its layout copies
    const items = new Map<string, unknown[]>();
    const itemsOf = (sectionId: string, categoryIds: unknown) => {
      let list = items.get(sectionId);
      if (!list) {
        const ids = Array.isArray(categoryIds) ? categoryIds.map(String) : [];
        list = [
          ...defaultDepartmentItems(newId),
          ...ids.filter((id) => names.get(id)).map((id, i) => ({ id: newId(), title: names.get(id)!.slice(0, 40), label: null, icon: null, image: null, tint: (i % 6) + 1, destination: { kind: 'category', categoryId: id }, visible: false })),
        ];
        items.set(sectionId, list);
      }
      return list;
    };
    const heading = (h: unknown) => (!h || h === 'Shop by category' ? 'Departments' : h);
    const convert = <T extends { kind?: unknown; heading?: unknown; config?: Record<string, unknown> | null }>(s: T, sectionId: string): T => ({
      ...s,
      kind: 'departments',
      heading: heading(s.heading),
      config: { ...(s.config ?? {}), categoryIds: null, departments: itemsOf(sectionId, s.config?.categoryIds) },
    });
    for (const r of old) {
      const next = convert(r as never as { kind: string; heading: unknown; config: Record<string, unknown> }, String(r._id));
      await rows.updateOne({ _id: r._id }, { $set: { kind: next.kind, heading: next.heading, config: next.config, updated_at: new Date() } });
    }
    for (const v of layouts) {
      const sections = ((v.snapshot as { sections?: { id: string; kind: string }[] })?.sections ?? []).map((s) => (s.kind === 'category_shortcuts' ? convert(s as never as { id: string; kind: string; config: Record<string, unknown> }, s.id) : s));
      await versions.updateOne({ _id: v._id }, { $set: { 'snapshot.sections': sections } });
    }
  },
};

export const mongoMigrations: readonly MongoMigration[] = [newsCategories, departmentsRail];
