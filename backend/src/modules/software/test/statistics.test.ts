import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, newId, usd, type Kit } from './helpers.js';

/**
 * GET /api/store/software/statistics: what the customer paid for apps and packs in a period, what reached their
 * library, and the breakdowns. Money is counted on the day the payment went through, app counts on the day each
 * app was added, and a pack is split across its apps by what each would cost on its own.
 */
let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.app.close();
});

const RETURN = 'https://store.example/software/return';
const card = (token = 'tok_visa') => ({ kind: 'new_card', providerToken: token });
/** The harness signs tokens on the test clock with a short life, so each call takes a freshly minted one */
const buyer = () => {
  const id = newId();
  return { id, get token() { return k.customer(id); } };
};
/** Noon in the market zone on `day` */
const at = (day: string) => k.clock.set(new Date(`${day}T20:00:00Z`));
const stats = (who: { token: Record<string, string> }, query = '') => k.store('GET', `/statistics${query}`, undefined, who.token);

/** Buys an app or a pack on `day` (noon in the market zone) */
async function buy(who: { token: Record<string, string> }, day: string, body: Record<string, unknown>) {
  at(day);
  const res = await k.store('POST', '/purchases', { method: card(), returnUrl: RETURN, ...body }, { ...who.token, 'idempotency-key': newId() });
  if (res.status !== 201 && res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

describe('software statistics', () => {
  it('counts what was paid, what reached the library, and splits a pack across its apps', async () => {
    const office = await k.category('Productivity');
    const media = await k.category('Multimedia');
    const writer = await k.makeApp({ title: 'Writer Pro', company: { name: 'Officecraft' }, categoryId: office.id, free: false, price: usd(2999) });
    const sheets = await k.makeApp({ title: 'Sheets Pro', company: { name: 'Officecraft' }, categoryId: office.id, free: false, price: usd(3499) });
    const cut = await k.makeApp({ title: 'CutPro Video', company: { name: 'Framecut Studios' }, categoryId: media.id, free: false, price: usd(4999) });
    const noteflow = await k.makeApp({ title: 'NoteFlow', company: { name: 'Flowstate Software' }, categoryId: office.id });
    const disk = await k.makeApp({ title: 'DiskCare', company: { name: 'Tidy Systems' }, categoryId: media.id, free: false, price: usd(1999) });
    const pack = await k.admin('POST', '/packs', { name: 'Office Pro pack', appIds: [writer.id, sheets.id], price: usd(5999) });
    expect(pack.status).toBe(201);

    const c = buyer();
    // Tue 2030-02-05: the pack, $59.99 for two apps worth $29.99 and $34.99
    const packBuy = await buy(c, '2030-02-05', { packId: pack.body.id, expectedAmount: usd(5999) });
    // Wed 2030-02-06: one app on its own
    await buy(c, '2030-02-06', { appId: cut.id, expectedAmount: usd(4999) });
    // Thu 2030-02-07: a free app, and a payment that fails
    at('2030-02-07');
    expect((await k.store('POST', `/apps/${noteflow.slug}/entitlements`, undefined, c.token)).status).toBe(200);
    const failed = await k.store('POST', '/purchases', { appId: disk.id, expectedAmount: usd(1999), method: card('tok_declined'), returnUrl: RETURN }, { ...c.token, 'idempotency-key': newId() });
    expect(failed.body.status, JSON.stringify(failed.body)).toBe('failed');

    at('2030-02-10');
    const { status, body } = await stats(c, '?range=last_30_days&grain=day');
    expect(status).toBe(200);

    expect(body.totals).toMatchObject({
      paid: usd(5999 + 4999),
      notPaid: usd(1999),
      purchases: 2,
      appsAdded: 4, // Writer and Sheets from the pack, CutPro, NoteFlow
      paidApps: 3,
      freeApps: 1,
      packs: 1,
      licenceKeys: 3,
      averagePurchase: usd(5499),
    });
    expect(body.totals.largestPurchase).toMatchObject({ ref: packBuy.ref, title: 'Office Pro pack', amount: usd(5999) });

    // the pack's $59.99 splits by list price: Writer 29.99/64.98 → $27.68, Sheets → $32.31 (the last row rounds)
    expect(body.byCategory.map((r: any) => [r.label, r.amount.amount])).toEqual([
      ['Multimedia', 4999],
      ['Productivity', 5999],
    ].sort((a, b) => (b[1] as number) - (a[1] as number)));
    expect(body.byCompany.map((r: any) => [r.label, r.amount.amount])).toEqual([
      ['Officecraft', 5999],
      ['Framecut Studios', 4999],
    ]);
    expect(body.bySource.map((r: any) => [r.key, r.label, r.count])).toEqual([
      ['pack', 'In a pack', 2],
      ['purchase', 'Bought on their own', 1],
      ['free', 'Free', 1],
    ]);
    expect(body.series.filter((p: any) => p.amount.amount > 0).map((p: any) => [p.start, p.amount.amount, p.count])).toEqual([
      ['2030-02-05', 5999, 1],
      ['2030-02-06', 4999, 1],
    ]);
    expect(body.byWeekday.filter((d: any) => d.count > 0).map((d: any) => [d.weekday, d.amount.amount])).toEqual([
      ['tue', 5999],
      ['wed', 4999],
    ]);
    expect(body.topApps.map((a: any) => [a.title, a.apps, a.amount.amount])).toEqual([
      ['Office Pro pack', 2, 5999],
      ['CutPro Video', 1, 4999],
    ]);
    // a pack row names no single app
    expect(body.topApps[0].appId).toBeNull();
    expect(body.topApps[1].company).toBe('Framecut Studios');
  });

  it('answers an empty report, and leaves a payment still being checked out of it', async () => {
    const c = buyer();
    at('2030-02-10');
    const { body } = await stats(c, '?range=last_30_days');
    expect(body.totals).toMatchObject({ paid: usd(0), notPaid: usd(0), purchases: 0, appsAdded: 0, averagePurchase: usd(0), largestPurchase: null, averageRating: null });
    expect(body.byCategory).toEqual([]);
    expect(body.topApps).toEqual([]);
    expect(body.previous).toMatchObject({ amount: usd(0), count: 0, changePct: null });
    expect(body.series.every((p: any) => p.secondary === null)).toBe(true);
  });

  it('refuses a half-given or over-long custom period, and needs a customer', async () => {
    const c = buyer();
    expect((await stats(c, '?to=2030-02-10')).status).toBe(400);
    expect((await stats(c, '?from=2020-01-01&to=2030-01-01')).status).toBe(400);
    expect((await k.store('GET', '/statistics')).status).toBe(401);
  });
});
