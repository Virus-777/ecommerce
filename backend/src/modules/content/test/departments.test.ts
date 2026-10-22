import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { departmentsRail } from '../migrations.js';
import { harness, newId, uploadImage, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const home = async (device?: string) => (await h.store('GET', `/home${device ? `?device=${device}` : ''}`)).json();
const add = (body: unknown) => h.admin('POST', '/homepage/sections', body);
const dept = (title: string, destination: unknown, extra: Record<string, unknown> = {}) => ({ title, destination, visible: true, ...extra });

describe('Departments section', () => {
  it('saves the items in order and describes them in the admin list', async () => {
    const res = await add({
      kind: 'departments',
      heading: 'Departments',
      departments: [
        dept('Phones', { kind: 'department', department: 'phones' }, { icon: 'smartphone', tint: 1 }),
        dept('Daily rewards', { kind: 'department', department: 'rewards' }, { icon: 'gift', tint: 4, visible: false }),
      ],
    });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s).toMatchObject({ kind: 'departments', title: 'Departments', description: '1 department · 1 hidden' });
    expect(s.config.departments.map((d: any) => [d.title, d.visible])).toEqual([
      ['Phones', true],
      ['Daily rewards', false],
    ]);
    // the server gives new items an id and keeps it on the next save
    const ids = s.config.departments.map((d: any) => d.id);
    expect(ids.every((id: unknown) => typeof id === 'string' && id)).toBe(true);
    const again = (await h.admin('PATCH', `/homepage/sections/${s.id}`, { ...s.config, departments: s.config.departments.reverse() })).json();
    expect(again.config.departments.map((d: any) => d.id)).toEqual([...ids].reverse());
  });

  it('refuses a section without items, bad destinations, tints and icon names', async () => {
    const issue = async (departments: unknown) => {
      const res = await add({ kind: 'departments', departments });
      expect(res.statusCode).toBe(400);
      return res.json().error.details.issues[0].path;
    };
    expect(await issue([])).toBe('departments');
    expect(await issue([dept(' ', { kind: 'department', department: 'phones' })])).toBe('departments[0].title');
    expect(await issue([dept('Phones', { kind: 'department' })])).toBe('departments[0].destination.department');
    expect(await issue([dept('Lamps', { kind: 'category', categoryId: newId() })])).toBe('departments[0].destination.categoryId');
    expect(await issue([dept('Deals', { kind: 'path', path: 'deals' })])).toBe('departments[0].destination.path');
    expect(await issue([dept('Deals', { kind: 'path', path: '//evil.example.com' })])).toBe('departments[0].destination.path');
    expect(await issue([dept('Blog', { kind: 'url', url: 'javascript:alert(1)' })])).toBe('departments[0].destination.url');
    expect(await issue([dept('Phones', { kind: 'department', department: 'phones' }, { tint: 7 })])).toBe('departments[0].tint');
    expect(await issue([dept('Phones', { kind: 'department', department: 'phones' }, { icon: 'Smart Phone' })])).toBe('departments[0].icon');
    // other kinds carry no departments
    const res = await add({ kind: 'deals', departments: [dept('Phones', { kind: 'department', department: 'phones' })] });
    expect(res.json().error.details.issues[0].path).toBe('departments');
  });

  it('resolves tiles for the store: department pages only in the app, hidden items and categories left out', async () => {
    // shoppers see a category while it has stock or says coming soon
    const lamps = (await h.call('POST', '/api/admin/catalog/categories', { name: `Lamps ${newId().slice(0, 4)}`, comingSoon: true })).json();
    const secret = (await h.call('POST', '/api/admin/catalog/categories', { name: `Secret ${newId().slice(0, 4)}`, visible: false })).json();
    const image = await uploadImage(h);
    const s = (
      await add({
        kind: 'departments',
        heading: 'Departments',
        departments: [
          dept('Softwares', { kind: 'department', department: 'software' }, { icon: 'app-window', tint: 3, label: 'Apps' }),
          dept('Lamps', { kind: 'category', categoryId: lamps.id }, { image: { id: image.id, url: image.url } }),
          dept('Secret', { kind: 'category', categoryId: secret.id }),
          dept('Deals', { kind: 'path', path: '/deals' }),
          dept('Our blog', { kind: 'url', url: 'https://blog.example.com' }),
          dept('Hidden', { kind: 'path', path: '/news' }, { visible: false }),
        ],
      })
    ).json();
    expect((await h.admin('POST', '/homepage/publish', { summary: 'Departments' })).statusCode).toBe(200);

    const app = (await home('app')).sections.find((x: any) => x.id === s.id);
    expect(app.departments.map((d: any) => [d.title, d.link.url, d.link.kind])).toEqual([
      ['Softwares', '/software', 'department'],
      ['Lamps', `/c/${lamps.slug}`, 'category'],
      ['Deals', '/deals', 'page'],
      ['Our blog', 'https://blog.example.com', 'external'],
    ]);
    expect(app.departments[0]).toMatchObject({ label: 'Apps', icon: 'app-window', tint: 3, image: null });
    expect(app.departments[1].image.id).toBe(image.id);
    expect(app.categories).toEqual([]);

    // the web store has no department pages yet
    const web = (await home('phone')).sections.find((x: any) => x.id === s.id);
    expect(web.departments.map((d: any) => d.title)).toEqual(['Lamps', 'Deals', 'Our blog']);
  });
});

describe('departments migration', () => {
  it('turns Shop by category into Departments in the rows and the live layout, keeping the categories hidden', async () => {
    const db = h.app.kernel.mongo.db;
    const cat = (await h.call('POST', '/api/admin/catalog/categories', { name: `Camping ${newId().slice(0, 4)}` })).json();
    const id = newId();
    const config = { banner: null, categoryIds: [cat.id, newId()], hidden: false };
    await db.collection('content.home_sections').insertOne({ _id: id, kind: 'category_shortcuts', heading: 'Shop by category', subheading: null, config, status: 'published', draft_position: 99, time_zone: 'America/Los_Angeles', updated_by: 'system', updated_at: new Date() } as never);
    const live = await db.collection('content.versions').findOne({ entity: 'homepage', state: 'live' });
    await db.collection('content.versions').updateOne({ _id: live!._id }, { $push: { 'snapshot.sections': { id, kind: 'category_shortcuts', heading: 'Shop by category', subheading: null, config, status: 'published' } } } as never);

    await departmentsRail.up(db);
    await departmentsRail.up(db); // safe to run again

    const row = await db.collection('content.home_sections').findOne({ _id: id } as never);
    expect(row).toMatchObject({ kind: 'departments', heading: 'Departments' });
    const items = row!.config.departments as any[];
    expect(items.slice(0, 10).map((d) => d.destination.department)).toEqual(['phones', 'farm_machines', 'software', 'welfare', 'food', 'booking', 'blogs', 'companies', 'play', 'rewards']);
    expect(items.slice(0, 10).every((d) => d.visible)).toBe(true);
    // categories that still exist come along hidden; the unknown id is dropped
    expect(items.slice(10).map((d) => [d.title, d.destination.categoryId, d.visible])).toEqual([[cat.name, cat.id, false]]);
    expect(row!.config.categoryIds).toBeNull();

    const after = await db.collection('content.versions').findOne({ _id: live!._id });
    const snap = (after!.snapshot as any).sections.find((x: any) => x.id === id);
    expect(snap.kind).toBe('departments');
    expect(snap.config.departments.map((d: any) => d.id)).toEqual(items.map((d) => d.id));
  });
});
