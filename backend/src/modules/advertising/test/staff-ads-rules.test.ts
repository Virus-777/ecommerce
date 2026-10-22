/** Pure rules of the staff Advertisements page (domain/staff-ads.ts), the deals_top placement seed and the destinations migration. */
import { describe, expect, it } from 'vitest';
import { PLACEMENT_SEEDS } from '../domain/rules.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import { byPosition, DEPARTMENTS, inferDestination, staffStatus, submitIssues, urlIssue } from '../domain/staff-ads.js';
import { slotSettings, staffAdDestinationsFromPaths } from '../migrations.js';

const now = new Date('2026-10-23T12:00:00Z');
const day = 86_400_000;
const ok = { hasImage: true, imageIssue: null, webImageIssue: null, alt: 'A banner', destination: { available: true, label: 'Headphones' }, startsAt: null, endsAt: new Date(now.getTime() + 10 * day), placementEnabled: true, placementName: 'Deals carousel' };

describe('staff ad rules', () => {
  it('maps campaign statuses to what the page shows', () => {
    expect(staffStatus('draft', [])).toBe('draft');
    expect(staffStatus('draft', ['approved', 'changes_requested'])).toBe('changes_requested');
    expect(staffStatus('approved', [])).toBe('in_review');
    expect(staffStatus('finished', [])).toBe('ended');
    expect(staffStatus('archived', [])).toBe('ended');
    expect(staffStatus('paused', [])).toBe('paused');
  });

  it('checks a submit: image, description, available destination, end within 90 days', () => {
    expect(submitIssues(ok, now)).toEqual([]);
    expect(submitIssues({ ...ok, endsAt: new Date(now.getTime() + 91 * day) }, now).map((i) => i.detail)).toEqual(['An ad runs at most 90 days']);
    // 90 days count from a later start
    expect(submitIssues({ ...ok, startsAt: new Date(now.getTime() + 5 * day), endsAt: new Date(now.getTime() + 94 * day) }, now)).toEqual([]);
    expect(submitIssues({ ...ok, hasImage: false, alt: ' ', destination: { available: false, label: 'Retired' }, endsAt: null }, now).map((i) => i.label)).toEqual(['Image', 'Description', 'Destination', 'End date']);
  });

  it('orders carousels by position, then creation', () => {
    const t = (n: number) => new Date(now.getTime() + n);
    const rows = [
      { id: 'c', position: null, created_at: t(1) },
      { id: 'b', position: 2, created_at: t(0) },
      { id: 'a', position: 1, created_at: t(5) },
      { id: 'd', position: 2, created_at: t(3) },
    ];
    expect([...rows].sort(byPosition).map((r) => r.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('accepts https links and store paths only', () => {
    expect(urlIssue('https://example.com/a')).toBeNull();
    expect(urlIssue('/deals')).toBeNull();
    expect(urlIssue('http://example.com')).toBe('Links must use https');
    expect(urlIssue('')).toBe('Enter the link');
  });

  it('has the ten department pages and a 750 × 150 deals carousel', () => {
    expect(DEPARTMENTS.map((d) => d.key)).toEqual(['phones', 'farm', 'software', 'welfare', 'food', 'booking', 'blogs', 'companies', 'play', 'rewards']);
    const deals = PLACEMENT_SEEDS.find((p) => p.key === 'deals_top')!;
    expect(deals).toMatchObject({ enabled: true, availability: 'launch', eligiblePages: ['deals'], rotation: { mode: 'carousel' } });
    expect(deals.formats).toEqual([expect.objectContaining({ device: 'phone', width: 750, height: 150 })]);
  });
});

describe('destinations read from store paths', () => {
  const id = '01a164c7-4caa-7573-87d3-e5fefb69941e';
  const cases: [string, Record<string, unknown>][] = [
    [`/p/halden-aurora/${id}?offer=${id}`, { kind: 'product', targetId: id, slug: null, path: `/p/halden-aurora/${id}?offer=${id}` }],
    [`/product/${id}?offer=x`, { kind: 'product', targetId: id, path: `/p/item/${id}?offer=x` }],
    ['/c/cookware', { kind: 'category', targetId: null, slug: 'cookware', path: '/c/cookware' }],
    ['/pages/fall-audio-week', { kind: 'collection', slug: 'fall-audio-week', path: '/collection/fall-audio-week' }],
    ['/collections/new-arrivals/', { kind: 'collection', slug: 'new-arrivals', path: '/collection/new-arrivals' }],
    ['/collection/new-arrivals', { kind: 'collection', slug: 'new-arrivals' }],
    ['/deals', { kind: 'deal', targetId: 'tab', path: '/deals' }],
    [`/deals?campaign=${id}`, { kind: 'deal', targetId: id, path: `/deals?campaign=${id}` }],
    ['/phones', { kind: 'department', targetId: 'phones', path: '/phones' }],
    ['/softwares', { kind: 'department', targetId: 'software', path: '/software' }],
    ['/farm-machines', { kind: 'department', targetId: 'farm', path: '/farm-machines' }],
    ['/rewards?from=ad', { kind: 'department', targetId: 'rewards', path: '/rewards' }],
    ['/phones/aurora-x', { kind: 'phone', slug: 'aurora-x', path: '/phones/aurora-x' }],
    ['/food/restaurants/luigis', { kind: 'restaurant', slug: 'luigis', path: '/food/restaurants/luigis' }],
    ['/shop/northwind-audio', { kind: 'seller_store', slug: 'northwind-audio', path: '/shop/northwind-audio' }],
    ['/official', { kind: 'seller_store', targetId: OFFICIAL_STORE_ID, path: '/official' }],
    ['/brand/halden', { kind: 'brand', slug: 'halden', path: '/brand/halden' }],
    ['/news', { kind: 'url', path: '/news' }],
    ['/deals/coupons/1/items', { kind: 'url' }],
    ['/phones/os-install/aurora', { kind: 'url' }],
    ['https://example.com/c/cookware', { kind: 'url', path: 'https://example.com/c/cookware' }],
  ];
  it.each(cases)('%s', (url, expected) => {
    expect(inferDestination(url)).toMatchObject(expected);
  });

  it('the migration converts staff links that name a target and leaves the rest', async () => {
    const rows = [
      { _id: 1, origin: 'staff', destination: { kind: 'url', targetId: null, url: '/softwares' } },
      { _id: 2, origin: 'staff', destination: { kind: 'url', targetId: null, url: '/c/cookware' } },
      { _id: 3, origin: 'staff', destination: { kind: 'url', targetId: null, url: 'https://example.com' } },
      { _id: 4, origin: 'staff', destination: { kind: 'campaign_page', targetId: null, url: '/pages/fall-audio-week' } },
      { _id: 5, origin: 'staff', destination: { kind: 'url', targetId: null, url: '/news' } },
    ];
    const updates: { id: number; set: unknown }[] = [];
    const db = {
      collection: () => ({
        find: (q: any) => ({ toArray: async () => rows.filter((r) => r.origin === q.origin && q['destination.kind'].$in.includes(r.destination.kind)) }),
        updateOne: async (q: any, u: any) => void updates.push({ id: q._id, set: u.$set.destination }),
      }),
    };
    await staffAdDestinationsFromPaths.up(db as never);
    expect(updates).toEqual([
      { id: 1, set: { kind: 'department', targetId: 'software', slug: null, url: '/software' } },
      { id: 2, set: { kind: 'category', targetId: null, slug: 'cookware', url: '/c/cookware' } },
      { id: 4, set: { kind: 'collection', targetId: null, slug: 'fall-audio-week', url: '/collection/fall-audio-week' } },
    ]);
  });
});


describe('the slot settings migration', () => {
  it('renames the slots, keeps their pages within the options and gives carousels a live-ad limit', async () => {
    const rows: any[] = [
      { _id: 'a', key: 'popup', name: 'Promotional pop-up', eligible_pages: ['home', 'product', 'campaign', 'deals'], rotation: { mode: 'priority_then_even', label: 'old' }, max_per_page: 1 },
      { _id: 'b', key: 'home_banner', name: 'Sponsored brand banner', eligible_pages: ['home'], rotation: { mode: 'carousel', carouselSeconds: 6, label: 'Carousel, 6 s each' }, max_per_page: null },
      { _id: 'c', key: 'opening_fullscreen', name: 'Opening full-screen ad', eligible_pages: ['campaign'], rotation: { mode: 'priority_then_even' }, max_per_page: 1 },
    ];
    const sets = new Map<string, any>();
    const db = {
      collection: () => ({
        findOne: async (q: any) => rows.find((r) => r.key === q.key) ?? null,
        updateOne: async (q: any, u: any) => void sets.set(q._id, u.$set),
      }),
    };
    await slotSettings.up(db as never);
    expect(sets.get('a')).toEqual({ name: 'Pop-up', eligible_pages: ['home', 'deals'], rotation: { mode: 'priority_then_even', label: 'Ads take turns in the order on Advertisements' } });
    expect(sets.get('b')).toEqual({ name: 'Home carousel', eligible_pages: ['home'], rotation: { mode: 'carousel', carouselSeconds: 6, label: 'Each ad shows 6 s, in the order on Advertisements' }, max_per_page: 10 });
    // no page left within the options: the slot's options
    expect(sets.get('c')).toMatchObject({ name: 'Full-screen ad', eligible_pages: ['home', 'category', 'deals'] });
  });
});
