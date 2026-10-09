import { describe, expect, it } from 'vitest';
import { money } from '../../../kernel/lib/money.js';
import { concerns } from '../alerts.js';
import { alertCondition, dropMet, firstName, inCooldown, priceHint, shareToken, verifyShareToken } from '../domain/rules.js';
import type { AlertCandidate } from '../ports.js';

describe('wishlist rules', () => {
  it('counts a drop of at least minDropPct below the reference, and at or below the target when set', () => {
    expect(dropMet(18700, 18900, null, 1)).toBe(true); // 200 ≥ 189
    expect(dropMet(18800, 18900, null, 1)).toBe(false); // 100 < 189: too small for 'any drop'
    expect(dropMet(18900, 18900, null, 0)).toBe(false);
    expect(dropMet(15000, 18900, 15900, 1)).toBe(true);
    expect(dropMet(16000, 18900, 15900, 1)).toBe(false); // above the target
    expect(dropMet(15000, null, 15900, 1)).toBe(true);
    expect(dropMet(15000, null, null, 1)).toBe(false);
  });

  it('applies the cooldown', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    expect(inCooldown(null, now, 24)).toBe(false);
    expect(inCooldown(new Date('2026-10-09T00:00:00Z'), now, 24)).toBe(true);
    expect(inCooldown(new Date('2026-10-08T11:00:00Z'), now, 24)).toBe(false);
  });

  it('gives honest price hints', () => {
    const r = (lowest: number, highest: number, current: number) => ({ lowest: money(lowest), highest: money(highest), current: money(current), unchanged: lowest === highest && highest === current });
    expect(priceHint(null, money(100), 30)).toMatchObject({ kind: 'none' });
    expect(priceHint(r(4200, 4200, 4200), money(4200), 30)).toMatchObject({ kind: 'unchanged', label: 'Same price for 30 days' });
    expect(priceHint(r(29900, 32900, 29900), money(29900), 30)).toMatchObject({ kind: 'lowest_in_window', label: 'Lowest in 30 days' });
    expect(priceHint(r(13900, 16500, 15000), money(15000), 30)).toMatchObject({ kind: 'typical_range', label: 'Typical price $139.00–$165.00', low: money(13900), high: money(16500) });
    expect(priceHint(r(13900, 16500, 15000), money(13000), 30).kind).toBe('lowest_in_window'); // a campaign price below the window's lowest
  });

  it('words alert conditions', () => {
    expect(alertCondition({ kind: 'price_drop', targetPrice: null, referencePrice: money(32900), options: {}, sellerName: null })).toBe('Any drop below $329.00');
    expect(alertCondition({ kind: 'price_drop', targetPrice: money(29900), referencePrice: money(32900), options: {}, sellerName: 'Kestrel' })).toBe('At or below $299.00, from Kestrel');
    expect(alertCondition({ kind: 'back_in_stock', targetPrice: null, referencePrice: null, options: { Color: 'Olive' }, sellerName: 'Trailhead Outfitters' })).toBe('Olive, from Trailhead Outfitters');
    expect(alertCondition({ kind: 'back_in_stock', targetPrice: null, referencePrice: null, options: {}, sellerName: null })).toBe('Any seller');
    expect(firstName('Ana Lopez')).toBe('Ana');
    expect(firstName('')).toBeNull();
  });

  it('signs share links and rejects forged ones', () => {
    const t = shareToken('k1', 'abc123');
    expect(verifyShareToken('k1', t)).toBe('abc123');
    expect(verifyShareToken('k2', t)).toBeNull();
    expect(verifyShareToken('k1', 'abc124' + t.slice(6))).toBeNull();
    expect(verifyShareToken('k1', 'nodot')).toBeNull();
  });

  it('follows the saved offer, else the variant and seller limits', () => {
    const a = (o: Partial<AlertCandidate>) => ({ variant_id: null, seller_id: null, item_offer_id: null, ...o }) as AlertCandidate;
    const c = { productId: 'p', variantId: 'v1', offerId: 'o1', sellerId: 's1' };
    expect(concerns(a({}), c)).toBe(true);
    expect(concerns(a({ variant_id: 'v2' }), c)).toBe(false);
    expect(concerns(a({ item_offer_id: 'o2', seller_id: 's1' }), c)).toBe(false);
    expect(concerns(a({ item_offer_id: 'o1' }), c)).toBe(true);
    expect(concerns(a({ seller_id: 's2' }), c)).toBe(false);
    expect(concerns(a({ seller_id: null }), { ...c, sellerId: null })).toBe(true);
  });
});
