import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { harness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const metricBody = (ownerId: string, over: Record<string, unknown> = {}) => ({
  name: 'Delivered sales',
  group: 'commerce',
  definition: 'Item sales of delivered items.',
  formula: 'Sum of item_minor for items with delivered_at in the range',
  unit: 'money',
  dateBasisOptions: ['completion', 'placement'],
  defaultDateBasis: 'completion',
  audience: 'staff',
  ownerId,
  changeNote: 'New metric for the delivery review',
  ...over,
});

describe('report library', () => {
  it('lists the six business groups with their reports and owners; only groups the caller may view', async () => {
    const all = await h.call('GET', '/api/admin/reports/catalogue', h.tokens.staff());
    expect(all.status).toBe(200);
    expect(all.body.map((g: any) => g.key)).toEqual(['commerce', 'company_trading', 'marketplace_finance', 'products_discovery', 'service_sellers', 'customers_marketing_ads']);
    expect(all.body[0].reports.map((r: any) => r.key)).toContain('commerce.sales');
    expect(all.body[0].owner).toMatchObject({ role: 'Order Manager' });
    const commerceOnly = await h.call('GET', '/api/admin/reports/catalogue', h.tokens.staff(['reports.library.view', 'reports.commerce.view']));
    expect(commerceOnly.body.map((g: any) => g.key)).toEqual(['commerce']);
  });

  it('one report with its filters and the definitions it uses; its group permission is needed; seller reports are not here', async () => {
    const r = await h.call('GET', '/api/admin/reports/reports/commerce.sales', h.tokens.staff());
    expect(r.status).toBe(200);
    expect(r.body.report).toMatchObject({ key: 'commerce.sales', permission: 'reports.commerce.view', audience: 'staff' });
    expect(r.body.report.filters.map((f: any) => f.key)).toEqual(expect.arrayContaining(['range', 'dateBasis', 'soldBy']));
    expect(r.body.definitions.map((d: any) => d.key)).toEqual(['commerce.gross_sales', 'commerce.net_sales', 'commerce.orders', 'commerce.average_order_value', 'commerce.units_sold']);
    expect(r.body.definitions[0]).toMatchObject({ status: 'published', version: 1, currencyRule: 'Reporting currency USD; one currency at launch', timeZone: 'America/Los_Angeles' });
    const forbidden = await h.call('GET', '/api/admin/reports/reports/commerce.sales', h.tokens.staff(['reports.library.view']));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.details.permission).toBe('reports.commerce.view');
    expect((await h.call('GET', '/api/admin/reports/reports/seller.order_trend', h.tokens.staff())).status).toBe(404);
  });

  it('sellers get the seller reports only', async () => {
    const r = await h.call('GET', '/api/seller/reports/catalogue', h.tokens.seller(newId()));
    expect(r.status).toBe(200);
    expect(r.body.map((x: any) => x.key).sort()).toEqual(['seller.order_trend', 'seller.product_sales', 'seller.returns_by_reason', 'seller.service_performance']);
  });
});

describe('metric definitions', () => {
  it('the launch set is published with a stated meaning', async () => {
    const r = await h.call('GET', '/api/admin/reports/metrics?launchOnly=true', h.tokens.staff());
    expect(r.status).toBe(200);
    expect(r.body.map((m: any) => m.key).sort()).toEqual(
      ['commerce.average_order_value', 'commerce.gross_sales', 'commerce.net_sales', 'commerce.orders', 'commerce.refunds', 'discovery.unavailable_searches', 'marketplace.fee_income', 'marketplace.seller_sales', 'service.case_backlog', 'service.on_time_dispatch'].sort(),
    );
    expect(r.body.every((m: any) => m.status === 'published' && m.definition && m.owner.name)).toBe(true);
    const fee = r.body.find((m: any) => m.key === 'marketplace.fee_income');
    expect(fee.relatedKeys).toContain('marketplace.seller_sales');
    expect((await h.call('GET', '/api/admin/reports/metrics?group=company_trading', h.tokens.staff())).body.every((m: any) => m.group === 'company_trading')).toBe(true);
  });

  it('create → publish → revise (new draft, the published version stays in use) → publish → retire', async () => {
    const owner = h.person('Maya Chen', 'Reports Analyst');
    const key = `commerce.delivered_${newId().slice(0, 6)}`.replace(/-/g, '_');
    const created = await h.call('POST', '/api/admin/reports/metrics', h.tokens.staff(), { key, metric: metricBody(owner) });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key, status: 'draft', version: 1, owner: { staffId: owner, name: 'Maya Chen', role: 'Reports Analyst' } });
    expect(h.audits.some((a) => a.action === 'reports.metric.create' && a.target.id === key)).toBe(true);
    expect((await h.call('POST', '/api/admin/reports/metrics', h.tokens.staff(), { key, metric: metricBody(owner) })).status).toBe(409);
    expect(await h.service.metric(key)).toBeNull();

    const events: any[] = [];
    h.app.kernel.events.subscribe('test', 'reports.metric.published', (e) => void events.push(e.payload));
    const today = h.clock.now().toISOString().slice(0, 10);
    const published = await h.call('POST', `/api/admin/reports/metrics/${key}/publish`, h.tokens.staff(), { effectiveFrom: '2026-01-01', changeNote: 'First version' });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body).toMatchObject({ status: 'published', version: 1, effectiveFrom: '2026-01-01', changeNote: 'First version' });
    await h.drain();
    expect(events).toContainEqual({ metricKey: key, version: 1, effectiveFrom: '2026-01-01' });
    expect((await h.service.metric(key))?.version).toBe(1);

    const revised = await h.call('PATCH', `/api/admin/reports/metrics/${key}`, h.tokens.staff(), metricBody(owner, { definition: 'Item sales of delivered items, after returns.', changeNote: 'Returns deducted' }));
    expect(revised.status).toBe(200);
    expect(revised.body).toMatchObject({ status: 'draft', version: 2 });
    // the published version stays in use until the draft is published
    expect((await h.service.metric(key))?.definition).toBe('Item sales of delivered items.');
    const later = await h.call('POST', `/api/admin/reports/metrics/${key}/publish`, h.tokens.staff(), { effectiveFrom: '2099-01-01', changeNote: 'Returns deducted' });
    expect(later.body).toMatchObject({ status: 'published', version: 2 });
    expect((await h.service.metric(key))?.version).toBe(1); // v2 takes effect in 2099

    const detail = await h.call('GET', `/api/admin/reports/metrics/${key}`, h.tokens.staff());
    expect(detail.body.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(detail.body.versions[1]).toMatchObject({ definition: 'Item sales of delivered items.', changeNote: 'First version' });

    // a new version can't take effect before the previous one
    await h.call('PATCH', `/api/admin/reports/metrics/${key}`, h.tokens.staff(), metricBody(owner));
    expect((await h.call('POST', `/api/admin/reports/metrics/${key}/publish`, h.tokens.staff(), { effectiveFrom: today, changeNote: 'x' })).status).toBe(400);

    const retired = await h.call('POST', `/api/admin/reports/metrics/${key}/retire`, h.tokens.staff(), { reason: 'Replaced by delivered sales v2' });
    expect(retired.status).toBe(200);
    expect(retired.body.status).toBe('retired');
    const again = await h.call('PATCH', `/api/admin/reports/metrics/${key}`, h.tokens.staff(), metricBody(owner));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ILLEGAL_TRANSITION');
    expect((await h.call('POST', `/api/admin/reports/metrics/${key}/publish`, h.tokens.staff(), { effectiveFrom: today, changeNote: 'x' })).body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('a metric needs a named owner to be published (OWNER_REQUIRED); a metric in use cannot be retired', async () => {
    const owner = h.person('Leo Park');
    const key = `service.ownerless_${newId().slice(0, 6)}`.replace(/-/g, '_');
    expect((await h.call('POST', '/api/admin/reports/metrics', h.tokens.staff(), { key, metric: metricBody(owner, { group: 'service_sellers', unit: 'count' }) })).status).toBe(201);
    h.staff.delete(owner); // the owner left
    const r = await h.call('POST', `/api/admin/reports/metrics/${key}/publish`, h.tokens.staff(), { effectiveFrom: '2026-10-01', changeNote: 'v1' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('OWNER_REQUIRED');

    const inUse = await h.call('POST', '/api/admin/reports/metrics/commerce.gross_sales/retire', h.tokens.staff(), { reason: 'test' });
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('METRIC_IN_USE');
    expect(inUse.body.error.details.reports).toContain('commerce.sales');
  });

  it('validates definitions: key format, group, unit and date bases', async () => {
    const owner = h.person();
    const r = await h.call('POST', '/api/admin/reports/metrics', h.tokens.staff(), { key: 'Bad Key', metric: metricBody(owner, { group: 'sales', unit: 'euros', defaultDateBasis: 'event' }) });
    expect(r.status).toBe(400);
    expect(r.body.error.details.issues.map((i: any) => i.path)).toEqual(expect.arrayContaining(['key', 'metric.group', 'metric.unit', 'metric.defaultDateBasis']));
  });

  it('suggestions: anyone with the library suggests; accepting opens a new draft version for the owner', async () => {
    const s = await h.call('POST', '/api/admin/reports/metrics/commerce.orders/suggestions', h.tokens.staff(['reports.library.view']), { proposed: 'Count orders by acceptance date', reason: 'Matches finance' });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ metricKey: 'commerce.orders', state: 'open' });
    expect((await h.call('POST', '/api/admin/reports/metrics/nope.metric/suggestions', h.tokens.staff(), { proposed: 'x', reason: 'y' })).status).toBe(404);
    const decided = await h.call('POST', `/api/admin/reports/metric-suggestions/${s.body.id}/decide`, h.tokens.staff(), { accept: true, note: 'Good point' });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ state: 'accepted', decisionNote: 'Good point' });
    const metric = await h.call('GET', '/api/admin/reports/metrics/commerce.orders', h.tokens.staff());
    expect(metric.body.metric).toMatchObject({ status: 'draft', version: 2 });
    expect(metric.body.suggestions[0]).toMatchObject({ id: s.body.id, state: 'accepted' });
    expect((await h.service.metric('commerce.orders'))?.version).toBe(1); // still in use until published
    const twice = await h.call('POST', `/api/admin/reports/metric-suggestions/${s.body.id}/decide`, h.tokens.staff(), { accept: false, note: '' });
    expect(twice.status).toBe(409);
    expect(h.audits.some((a) => a.action === 'reports.metric_suggestion.accept')).toBe(true);
  });
});

describe('saved views', () => {
  it('mine plus shared; only the owner deletes', async () => {
    const ana = newId();
    const ben = newId();
    const mine = await h.call('POST', '/api/admin/reports/saved-views', h.tokens.staff(undefined, ana), { reportKey: 'commerce.sales', name: 'Last 30 days, marketplace', query: { preset: 'last_30_days', soldBy: 'marketplace' } });
    expect(mine.status).toBe(201);
    const shared = await h.call('POST', '/api/admin/reports/saved-views', h.tokens.staff(undefined, ana), { reportKey: 'commerce.sales', name: 'Team view', query: { preset: 'last_7_days' }, shared: true });
    expect(shared.status).toBe(201);
    expect((await h.call('POST', '/api/admin/reports/saved-views', h.tokens.staff(undefined, ana), { reportKey: 'commerce.sales', name: 'Bad', query: { currency: 'EUR' } })).status).toBe(400);
    const benList = await h.call('GET', '/api/admin/reports/saved-views?reportKey=commerce.sales', h.tokens.staff(undefined, ben));
    expect(benList.body.map((v: any) => v.id)).toContain(shared.body.id);
    expect(benList.body.map((v: any) => v.id)).not.toContain(mine.body.id);
    expect((await h.call('DELETE', `/api/admin/reports/saved-views/${shared.body.id}`, h.tokens.staff(undefined, ben))).status).toBe(403);
    expect((await h.call('DELETE', `/api/admin/reports/saved-views/${mine.body.id}`, h.tokens.staff(undefined, ben))).status).toBe(404);
    expect((await h.call('DELETE', `/api/admin/reports/saved-views/${mine.body.id}`, h.tokens.staff(undefined, ana))).status).toBe(204);
    expect((await h.call('GET', '/api/admin/reports/saved-views', h.tokens.staff(undefined, ana))).body.map((v: any) => v.id)).not.toContain(mine.body.id);
  });
});

describe('scheduled report emails (phase 2)', () => {
  it('validates, lists, runs the owner export when due and stops', async () => {
    const owner = newId();
    const bad = await h.call('POST', '/api/admin/reports/schedules', h.tokens.staff(undefined, owner), { reportKey: 'commerce.sales', recipients: ['lead@marketly.test'], frequency: 'weekly', time: '25:00', format: 'csv' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues.map((i: any) => i.path)).toEqual(expect.arrayContaining(['dayOfWeek', 'time']));
    const s = await h.call('POST', '/api/admin/reports/schedules', h.tokens.staff(undefined, owner), { reportKey: 'commerce.sales', recipients: ['Lead@Marketly.test'], frequency: 'daily', time: '07:30', format: 'csv' });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body).toMatchObject({ reportKey: 'commerce.sales', recipients: ['lead@marketly.test'], active: true });
    expect(new Date(s.body.nextRunAt).getTime()).toBeGreaterThan(h.clock.now().getTime());
    expect((await h.call('GET', '/api/admin/reports/schedules', h.tokens.staff())).body.map((x: any) => x.id)).toContain(s.body.id);

    const ready: any[] = [];
    h.app.kernel.events.subscribe('test', 'reports.scheduled_report.ready', (e) => void ready.push(e.payload));
    h.clock.advance(26 * 3_600_000);
    await h.app.kernel.jobs.runNow('reports.run-schedules');
    await h.app.kernel.jobs.runNow('reports.run-schedules');
    const mine = await h.call('GET', '/api/admin/reports/exports', h.tokens.staff(undefined, owner));
    const runs = mine.body.items.filter((j: any) => j.reportKey === 'commerce.sales' && j.requestedBy.id === owner);
    expect(runs).toHaveLength(1);
    const next = (await h.call('GET', '/api/admin/reports/schedules', h.tokens.staff())).body.find((x: any) => x.id === s.body.id);
    expect(new Date(next.nextRunAt).getTime()).toBeGreaterThan(h.clock.now().getTime());

    // the file is made by the export runner; then the schedule's recipients are told, once
    expect(ready).toEqual([]);
    await h.app.kernel.jobs.runNow('reports.run-exports');
    await h.app.kernel.jobs.runNow('reports.run-exports');
    await h.app.kernel.events.drain();
    const file = (await h.call('GET', '/api/admin/reports/exports', h.tokens.staff(undefined, owner))).body.items.find((j: any) => j.id === runs[0].id);
    expect(file.state).toBe('ready');
    expect(ready).toEqual([
      {
        scheduleId: s.body.id,
        reportKey: 'commerce.sales',
        reportTitle: expect.any(String),
        exportId: runs[0].id,
        format: 'csv',
        periodLabel: expect.stringMatching(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})? – [A-Z][a-z]{2} \d{1,2}, \d{4}$/),
        recipients: ['lead@marketly.test'],
        expiresAt: file.expiresAt,
      },
    ]);
    expect(ready[0].reportTitle.length).toBeGreaterThan(0);

    expect((await h.call('DELETE', `/api/admin/reports/schedules/${s.body.id}`, h.tokens.staff())).status).toBe(204);
    expect((await h.call('GET', '/api/admin/reports/schedules', h.tokens.staff())).body.map((x: any) => x.id)).not.toContain(s.body.id);
    expect((await h.call('DELETE', `/api/admin/reports/schedules/${s.body.id}`, h.tokens.staff())).status).toBe(404);
    expect(h.audits.some((a) => a.action === 'reports.schedule.stop')).toBe(true);
  });
});
