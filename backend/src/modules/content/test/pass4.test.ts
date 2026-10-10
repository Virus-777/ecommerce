/**
 * Gap pass 4: drafts and scheduled pages can be removed (the schedule goes too), collectionProducts takes the
 * common PageInput, policies have a slug key and a kind (migration backfill), and the navigation's company line
 * and legal name come from settings.storeInfo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, buildTestApp, callers } from '../../../testing/app.js';
import { m0003PolicyKind } from '../infra/postgres/migrations/0003_policy_kind.js';
import { DAY, harness, inMs, MIN, newId, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const page = (over: Record<string, unknown> = {}) => ({
  kind: 'campaign',
  title: `Page ${newId().slice(-8)}`,
  blocks: [{ id: 'intro', type: 'text', body: '<p>Hello</p>', products: [] }],
  ...over,
});

describe('removing content that is not live', () => {
  it('a draft can be removed', async () => {
    const id = (await h.admin('POST', '/pages', page())).json().summary.id;
    const res = await h.admin('POST', `/pages/${id}/remove`, { kind: 'removal', reason: 'Campaign cancelled' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().summary.status).toBe('removed');
  });

  it('a scheduled page can be removed and never goes live', async () => {
    const id = (await h.admin('POST', '/pages', page())).json().summary.id;
    await h.admin('POST', `/pages/${id}/schedule`, { publishAt: inMs(h, DAY), timeZone: 'America/Los_Angeles' });
    const res = await h.admin('POST', `/pages/${id}/remove`, { kind: 'removal', reason: 'Wrong prices in the copy' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().summary).toMatchObject({ status: 'removed', schedule: { publishAt: null } });
    h.clock.advance(DAY + MIN);
    await h.app.kernel.jobs.runNow('content.run-schedules');
    expect((await h.admin('GET', `/pages/${id}`)).json().summary.status).toBe('removed');
  });
});

describe('collectionProducts', () => {
  it('pages with the common PageInput (cursor and limit)', async () => {
    const a = h.card({ title: 'Lamp A' });
    const b = h.card({ title: 'Lamp B' });
    for (const c of [a, b]) h.cards.set(c.productId, c);
    const created = await h.admin('POST', '/pages', { kind: 'collection', collectionKind: 'curated', title: `Lamps ${newId().slice(-6)}`, blocks: [{ id: 'grid', type: 'product_grid', productSource: { mode: 'manual', productIds: [a.productId, b.productId] }, products: [] }] });
    const id = created.json().summary.id;
    await h.admin('POST', `/pages/${id}/publish`);
    const first = await h.service.collectionProducts(id, { paging: { limit: 1 } });
    expect(first.items.map((t) => t.title)).toEqual(['Lamp A']);
    const next = await h.service.collectionProducts(id, { paging: { limit: 1, cursor: first.nextCursor ?? undefined } });
    expect(next.items.map((t) => t.title)).toEqual(['Lamp B']);
  });
});

describe('migration 0003', () => {
  it('adds policies.kind and fills it from the key', async () => {
    const owner = newId();
    const created = await h.admin('POST', '/policies', { key: 'cookies', title: 'Cookie policy', ownerStaffId: owner, audience: 'customer' });
    expect(created.statusCode, created.body).toBe(201);
    await h.app.kernel.database.exec(`alter table content.policies drop constraint policies_kind_check; alter table content.policies drop column kind;
      insert into content.policies (id, key, title, owner_staff_id, editor_staff_id, audience) values ('${newId()}', 'legacy-odd', 'Odd', '${owner}', null, 'customer');`);
    await h.app.kernel.database.exec(m0003PolicyKind.sql);
    const rows = await h.app.kernel.database.kysely.withSchema('content').selectFrom('policies' as never).select(['key' as never, 'kind' as never]).execute();
    const byKey = new Map((rows as { key: string; kind: string }[]).map((r) => [r.key, r.kind]));
    expect(byKey.get('cookies')).toBe('cookies');
    expect(byKey.get('legacy-odd')).toBe('other');
  });
});

describe('navigation company facts', () => {
  it('come from settings.storeInfo (market.companyLine and market.legalName)', async () => {
    const app = await buildTestApp({ only: ['content', 'settings'], clock: h.clock });
    try {
      const settings = app.kernel.boot.apis.get('settings') as { storeInfo(): Promise<{ market: { legalName: string; companyLine: string } }> };
      const { market } = await settings.storeInfo();
      expect(market.companyLine).toBeTruthy();
      const res = await app.inject({ method: 'GET', url: '/api/store/content/navigation', headers: auth(callers.visitor()) });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ legalName: market.legalName, companyLine: market.companyLine });
    } finally {
      await app.close();
    }
    // settings off: the fallback still names the company
    const off = (await h.store('GET', '/navigation')).json();
    expect(off).toMatchObject({ legalName: 'Marketly', companyLine: expect.stringMatching(/^© \d{4} Marketly$/) });
  });
});
