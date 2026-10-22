/**
 * Sample Daily rewards (rewards module): the default check-in schedule, the default daily tasks and the four coupons
 * of the DailyRewards artboard, each a single-use code of its own promotions coupon campaign ("Daily rewards: …").
 * Written through the Admin Center API, and only what is missing (a task with the same key, a reward with the same
 * title or a campaign with the same name is kept as it is), so it is safe to run again. Used by
 * tools/seed-departments.ts. The texts and amounts are samples.
 *
 * A campaign goes live through create → submit → confirm funding → schedule. Promotions lets another staff member
 * confirm the funding of a campaign someone created (separation of duties), so pass `o.reviewer` (a second staff
 * account that may confirm campaign funding) to do it all at once; without one the campaigns wait for Finance in
 * Admin › Promotions, their rewards are left out, and running the seed again after the confirmation adds them.
 */
import type { AdminCall } from './departments-data.js';

const usd = (dollars: number) => ({ amount: Math.round(dollars * 100), currency: 'USD' });

export const DEFAULT_SCHEDULE = [10, 10, 15, 15, 20, 20, 100];

export const TASKS = [
  { kind: 'visit_store', title: 'Visit a store page', points: 5, target: 1, path: '/official' },
  { kind: 'write_review', title: 'Write a review', points: 30, target: 1, path: '/account/orders' },
  { kind: 'share_product', title: 'Share a product', points: 10, target: 1 },
  { kind: 'place_order', title: 'Place an order', points: 25, target: 1, visible: false },
];

type Discount = Record<string, unknown>;
/** The DailyRewards artboard's coupons and the campaign behind each */
export const REWARDS: { title: string; condition: string; cost: number; tint: 'deal' | 'brand' | 'info' | 'neutral'; campaign: { name: string; description: string; discount: Discount; electronics?: boolean } }[] = [
  { title: '$5 off', condition: 'On orders over $50', cost: 500, tint: 'deal', campaign: { name: 'Daily rewards: $5 off', description: '$5 off orders over $50', discount: { kind: 'fixed_coupon', amountOff: usd(5), minSpend: usd(50), minSpendScope: 'order' } } },
  { title: 'Free delivery', condition: 'One order, any store', cost: 300, tint: 'brand', campaign: { name: 'Daily rewards: Free delivery', description: 'Free delivery on one order', discount: { kind: 'free_shipping', freeShipping: true } } },
  { title: '10% off', condition: 'Electronics, up to $30', cost: 800, tint: 'info', campaign: { name: 'Daily rewards: 10% off Electronics', description: '10% off electronics, up to $30', discount: { kind: 'percent_coupon', percentOffBps: 1000, maxDiscountPerOrder: usd(30) }, electronics: true } },
  { title: '$15 off', condition: 'On orders over $120', cost: 1400, tint: 'neutral', campaign: { name: 'Daily rewards: $15 off', description: '$15 off orders over $120', discount: { kind: 'fixed_coupon', amountOff: usd(15), minSpend: usd(120), minSpendScope: 'order' } } },
];

const slug = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The Electronics category (by name, anywhere in the tree), else null: the campaign then covers every product */
async function electronicsId(admin: AdminCall): Promise<{ id: string; label: string } | null> {
  const walk = (list: { id: string; name: string; children?: unknown[] }[]): { id: string; label: string } | null => {
    for (const c of list) {
      if (c.name.trim().toLowerCase() === 'electronics') return { id: c.id, label: c.name };
      const inner = walk((c.children ?? []) as never);
      if (inner) return inner;
    }
    return null;
  };
  try {
    return walk(await admin('GET', '/admin/catalog/categories'));
  } catch {
    return null;
  }
}

/** o.reviewer: a second staff member who confirms the campaigns' funding; o.now: the server's time (tests move it) */
export async function seedRewards(admin: AdminCall, o: { reviewer?: AdminCall; now?: () => Date } = {}): Promise<Record<string, number | string[]>> {
  const reviewer = o.reviewer ?? admin;
  const added = { program: 0, tasks: 0, campaigns: 0, rewards: 0, waitingForFunding: [] as string[] };

  const program = await admin('GET', '/admin/rewards/program');
  if (!program.updatedAt) {
    await admin('PUT', '/admin/rewards/program', { checkInPoints: DEFAULT_SCHEDULE, enabled: true });
    added.program++;
  }

  const tasks = new Set(((await admin('GET', '/admin/rewards/tasks')) as { key: string }[]).map((t) => t.key));
  for (const [i, t] of TASKS.entries()) {
    if (tasks.has(slug(t.title))) continue;
    await admin('POST', '/admin/rewards/tasks', { ...t, position: i + 1 });
    added.tasks++;
  }

  const rewards = new Set(((await admin('GET', '/admin/rewards/rewards')) as { title: string }[]).map((r) => r.title));
  const electronics = REWARDS.some((r) => r.campaign.electronics && !rewards.has(r.title)) ? await electronicsId(admin) : null;
  for (const [i, r] of REWARDS.entries()) {
    if (rewards.has(r.title)) continue;
    const found = ((await admin('GET', `/admin/promotions/campaigns?q=${encodeURIComponent(r.campaign.name)}&limit=50`)).items as { id: string; name: string; status: string }[]).filter(
      (c) => c.name === r.campaign.name && c.status !== 'ended' && c.status !== 'cancelled',
    );
    let campaign = found.find((c) => c.status === 'live' || c.status === 'scheduled') ?? found[0];
    if (!campaign) {
      const now = (o.now?.() ?? new Date()).getTime();
      campaign = await admin('POST', '/admin/promotions/campaigns', {
        name: r.campaign.name,
        description: r.campaign.description,
        internalNote: 'Daily rewards coupon: customers get single-use codes for points (Admin › Departments › Daily rewards).',
        discount: r.campaign.discount,
        autoApply: false,
        startsAt: new Date(now - 60_000).toISOString(),
        endsAt: new Date(now + 365 * 86_400_000).toISOString(),
        timeZone: 'America/Los_Angeles',
        scope: r.campaign.electronics && electronics ? { mode: 'categories', include: [{ kind: 'category', id: electronics.id, label: electronics.label }], exclude: [] } : { mode: 'sitewide', include: [], exclude: [] },
        eligibility: { audience: 'signed_in' },
        limits: { budget: usd(2000) },
        funding: { owner: 'platform', costCenter: 'MKT-REWARDS', note: 'Daily rewards coupons, paid for with points' },
        stacking: { withSellerMarkdowns: true, withOtherCoupons: false, withFreeShipping: true, withFlashSalePrices: false },
        terms: 'A Daily rewards coupon: single use, for the customer who swapped points for it.',
      });
      added.campaigns++;
    }
    const id = campaign!.id;
    try {
      if (campaign!.status === 'draft' || campaign!.status === 'changes_requested') campaign = await admin('POST', `/admin/promotions/campaigns/${id}/submit`, { note: 'Daily rewards coupon, platform funded' });
      if (campaign!.status === 'in_review') campaign = await reviewer('POST', `/admin/promotions/campaigns/${id}/confirm-funding`, { comment: 'Daily rewards coupons', costCenter: 'MKT-REWARDS' });
      if (campaign!.status === 'approved') campaign = await admin('POST', `/admin/promotions/campaigns/${id}/schedule`);
    } catch {
      // usually SAME_REVIEWER: another staff member confirms the funding in Admin › Promotions
    }
    if (campaign!.status !== 'live' && campaign!.status !== 'scheduled') {
      added.waitingForFunding.push(r.campaign.name);
      continue;
    }
    await admin('POST', '/admin/rewards/rewards', { title: r.title, condition: r.condition, cost: r.cost, tint: r.tint, campaignId: id, position: i + 1 });
    added.rewards++;
  }
  return added;
}
