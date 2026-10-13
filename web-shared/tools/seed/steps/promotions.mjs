// Step 6: promotions. Platform campaigns go draft → submit (Olivia) → confirm funding (Morgan, as Finance) →
// schedule; a past start makes them live at once. No budgets (a budget adds the promotions.budgets.approve check).
//   - WELCOME20: $20 off orders of $100+, code, one use per customer
//   - "$5 off your first Official Store order": clip-only coupon (no code, not automatic)
//   - "Home Week flash deals": a flash sale with 4 offers (deal price, deal stock, limit) on the Deals page
//   - Casa Verde Home's own "15% off Mosswood bedding" discount (seller-funded, on its bedding offers)
import { ApiError } from '../lib/http.mjs';
import { TZ, usd } from '../data.mjs';

export const OFFICIAL_STORE_ID = '00000000-0000-7000-8000-000000000001';
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

const STACKING = { withSellerMarkdowns: true, withOtherCoupons: false, withFreeShipping: true, withFlashSalePrices: false };

async function findCampaign(ctx, name) {
  const r = await ctx.api.get(`/api/admin/promotions/campaigns?q=${encodeURIComponent(name)}&limit=50`, ctx.staff);
  return (r.items ?? []).find((c) => c.name === name && !['cancelled', 'ended'].includes(c.status)) ?? null;
}

/** draft → in_review → approved → scheduled/live, from wherever the campaign is */
async function launch(ctx, campaign) {
  const { api } = ctx;
  let c = campaign;
  const step = async (path, token, body) => {
    try {
      c = await api.post(`/api/admin/promotions/campaigns/${c.id}/${path}`, token, body);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) throw err;
      c = await api.get(`/api/admin/promotions/campaigns/${c.id}`, ctx.staff);
    }
  };
  if (c.status === 'draft' || c.status === 'changes_requested') await step('submit', ctx.staff, { note: 'Platform funded, no budget cap for the launch period' });
  if (c.status === 'in_review') await step('confirm-funding', ctx.approver, { comment: 'Within the marketing budget', costCenter: 'MKT-LAUNCH' });
  if (c.status === 'approved') await step('schedule', ctx.staff, undefined);
  return c;
}

async function platformCampaign(ctx, key, body, after) {
  const { api, state, log } = ctx;
  let c = state.get(`campaign.${key}`) ? await api.get(`/api/admin/promotions/campaigns/${state.get(`campaign.${key}`)}`, ctx.staff) : await findCampaign(ctx, body.name);
  if (!c) {
    c = await api.post('/api/admin/promotions/campaigns', ctx.staff, body);
    log.created('campaign', `${body.name}${body.code ? ` (code ${body.code})` : ''}`);
  }
  state.set(`campaign.${key}`, c.id);
  if (after && c.status === 'draft') await after(c);
  c = await launch(ctx, c);
  log.info(`${body.name}: ${c.status}`);
  return c;
}

const offerId = (ctx, key) => ctx.state.get(`offer.${key}`)?.id;

export async function promotionsStep(ctx) {
  const now = Date.now();
  await platformCampaign(ctx, 'welcome20', {
    name: 'WELCOME20: $20 off $100+',
    description: '$20 off orders of $100 or more',
    discount: { kind: 'fixed_coupon', amountOff: usd(2000), minSpend: usd(10000), minSpendScope: 'order' },
    code: 'WELCOME20',
    autoApply: false,
    startsAt: iso(now - 60_000),
    endsAt: iso(now + 120 * DAY),
    timeZone: TZ,
    scope: { mode: 'sitewide', include: [], exclude: [] },
    eligibility: { audience: 'everyone' },
    limits: { perCustomer: 1 },
    funding: { owner: 'platform', costCenter: 'MKT-LAUNCH' },
    stacking: STACKING,
    deals: { show: true, section: 'coupons' },
    terms: 'One use per customer on orders of $100 or more before discounts. Marketly pays the discount, so sellers receive their full price.',
  });

  await platformCampaign(ctx, 'officialFive', {
    name: '$5 off your first Official Store order',
    description: 'Official Store items over $25 · first Official Store order only',
    discount: { kind: 'fixed_coupon', amountOff: usd(500), minSpend: usd(2500), minSpendScope: 'eligible_items' },
    code: null,
    autoApply: false,
    startsAt: iso(now - 60_000),
    endsAt: iso(now + 80 * DAY),
    timeZone: TZ,
    scope: { mode: 'sellers', include: [{ kind: 'official_store', id: OFFICIAL_STORE_ID, label: 'Marketly Official Store' }], exclude: [] },
    eligibility: { audience: 'signed_in' },
    limits: { perCustomer: 1 },
    funding: { owner: 'platform', costCenter: 'MKT-LAUNCH' },
    stacking: STACKING,
    deals: { show: true, section: 'coupons' },
    terms: 'Clip the coupon, then it applies at checkout to Official Store items over $25.',
  });

  // flash sale: platform funded and inviting nobody, so seller offers count without consent (promotions notes)
  const items = [
    { key: 'kestrel27.std', dealPrice: 27900, dealStock: 10, purchaseLimit: 1 },
    { key: 'speaker.teal', dealPrice: 4900, dealStock: 40, purchaseLimit: 2 },
    { key: 'duvet.sage', dealPrice: 9900, dealStock: 15, purchaseLimit: 2 },
    { key: 'skillet.26', dealPrice: 4900, dealStock: 30, purchaseLimit: 2 },
  ].filter((i) => offerId(ctx, i.key));
  if (items.length) {
    const scopeOf = (i) => ({ kind: 'offer', id: offerId(ctx, i.key), label: i.key });
    await platformCampaign(
      ctx,
      'flash',
      {
        name: 'Home Week flash deals',
        description: 'Limited deal stock at flash prices while Home Week runs',
        discount: { kind: 'flash_sale' },
        autoApply: true,
        startsAt: iso(now - 60_000),
        endsAt: iso(now + 6 * DAY),
        timeZone: TZ,
        scope: { mode: 'offers', include: items.map(scopeOf), exclude: [] },
        eligibility: { audience: 'everyone' },
        limits: {},
        funding: { owner: 'platform', costCenter: 'MKT-HOMEWEEK' },
        stacking: { withSellerMarkdowns: false, withOtherCoupons: true, withFreeShipping: true, withFlashSalePrices: true },
        deals: { show: true, section: 'flash' },
        terms: 'Deal prices last while deal stock lasts; then the regular price applies. Was prices are each offer’s lowest price in the 30 days before the sale.',
      },
      async (c) => {
        await ctx.api.put(`/api/admin/promotions/campaigns/${c.id}/flash-items`, ctx.staff, { items: items.map((i) => ({ offerId: offerId(ctx, i.key), dealPrice: usd(i.dealPrice), dealStock: i.dealStock, purchaseLimit: i.purchaseLimit })), reason: 'Home Week selection' });
        ctx.log.info(`flash sale: ${items.length} items`);
      },
    );
  } else ctx.log.warn('flash sale skipped: no offers yet (run official and sellers first)');

  // seller discount: Casa Verde funds 15% off its Mosswood bedding
  const casa = ctx.state.section('sellers').casaverde;
  const bedding = ['duvet.sage', 'duvet.oat', 'sheets.white'].map((k) => offerId(ctx, k)).filter(Boolean);
  if (casa?.sellerId && bedding.length) {
    const t = ctx.sellerToken('casaverde');
    const name = '15% off Mosswood bedding';
    let id = ctx.state.get('campaign.casaBedding');
    if (!id) {
      const mine = await ctx.api.get('/api/seller/promotions/discounts?limit=50', t);
      id = (mine.items ?? []).map((i) => i.campaign ?? i).find((c) => c.name === name && !['cancelled', 'ended'].includes(c.status))?.id;
    }
    if (!id) {
      const created = await ctx.api.post('/api/seller/promotions/discounts', t, {
        name,
        kind: 'percent_coupon',
        discount: { kind: 'percent_coupon', percentOffBps: 1500, minSpend: usd(10000), minSpendScope: 'eligible_items' },
        offerIds: bedding,
        startsAt: iso(now - 60_000),
        endsAt: iso(now + 6 * DAY),
        timeZone: TZ,
        perCustomer: 1,
        combinesWithPlatformCoupons: true,
        showOnDeals: true,
      });
      id = (created.campaign ?? created).id;
      ctx.log.created('seller discount', `${name} (Casa Verde Home)`);
    }
    ctx.state.set('campaign.casaBedding', id);
    try {
      const s = await ctx.api.post(`/api/seller/promotions/discounts/${id}/schedule`, t, undefined);
      ctx.log.info(`${name}: ${(s.campaign ?? s).status}`);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) throw err;
    }
  }
}
