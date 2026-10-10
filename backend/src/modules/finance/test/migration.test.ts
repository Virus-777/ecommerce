/**
 * Migration 0004 (gap pass 4) backfills its columns and tables from where pass 3 kept the data: capture recon
 * items, trading_entries rows with platform ref_kinds, fee rule treatment.categoryNames and zero-amount
 * new_seller holds. Run against that state: the 0004 objects are dropped, legacy rows inserted, and the
 * migration's SQL applied again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0004Pass4 } from '../infra/postgres/migrations/0004_pass4.js';
import { boot, type Kit } from './helpers.js';

let k: Kit;
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

const DROP_0004 = `
drop table finance.captures; drop table finance.discount_funding; drop table finance.platform_costs; drop table finance.store_credit_liability;
alter table finance.recon_items drop column credit;
alter table finance.fee_category_rates drop column category_name;
alter table finance.seller_accounts drop column new_seller_until, drop column new_seller_extra_days;
alter table finance.amounts_owed drop column write_off_amount, drop column write_off_reason, drop column approval_request_id;`;

describe('migration 0004', () => {
  it('backfills captures, credit, marketplace facts, category names and the new-seller period', async () => {
    const db = k.app.kernel.database;
    const repo = k.svc.core.repo;
    await db.exec(DROP_0004);
    const at = new Date('2026-09-01T12:00:00Z').toISOString();
    const ids = { capture: newId(), unexplained: newId(), item: newId(), item2: newId(), redemption: newId(), order: newId(), grant: newId(), used: newId(), expired: newId(), label: newId(), claim: newId(), owed: newId(), rule: newId(), category: newId(), seller: newId() };
    const t = (id: string, refKind: string, refId: string, amount: number, kind = 'discount', orderId: string | null = null) =>
      `('${id}', '${at}', '${kind}', ${amount}, 'USD', ${orderId ? `'${orderId}'` : 'null'}, null, null, '${refKind}', '${refId}')`;
    await db.exec(`
insert into finance.recon_days (date, status, owner_staff_id, backup_staff_id, due_at, checklist) values ('2026-09-01', 'open', '${newId()}', null, '${at}', '[]') on conflict do nothing;
insert into finance.recon_items (id, date, "check", ref_kind, ref_id, subject, description, expected, actual, difference, currency, detected_at, status) values
  ('${ids.item}', '2026-09-01', 'payments_vs_orders', 'capture', '${ids.capture}', 'MK-260901-10001', 'Card capture $70.00 plus store credit $1,030.00 against the order total $1,100.00', 7000, 7000, 0, 'USD', '${at}', 'matched'),
  ('${ids.item2}', '2026-09-01', 'unexplained_amount', 'capture', '${ids.unexplained}', 'ch_123', 'Captured payment with no matching order (store credit $5.00 also applied)', 0, 2000, 2000, 'USD', '${at}', 'open');
insert into finance.trading_entries (id, at, kind, amount, currency, order_id, order_item_id, variant_id, ref_kind, ref_id) values
  ${t(newId(), 'coupon_redemption', ids.redemption, 1000, 'discount', ids.order)},
  ${t(newId(), 'coupon_seller_part', ids.redemption, 500, 'discount', ids.order)},
  ${t(newId(), 'wallet_liability', ids.grant, 2500)},
  ${t(newId(), 'wallet_credit', ids.grant, 2500)},
  ${t(newId(), 'wallet_liability', ids.order, -800, 'discount', ids.order)},
  ${t(newId(), 'wallet_liability', ids.expired, -300)},
  ${t(newId(), 'wallet_breakage', ids.expired, -300)},
  ${t(newId(), 'platform_label', ids.label, 900, 'shipping_expense', ids.order)},
  ${t(newId(), 'platform_claim', ids.claim, 400, 'supplier_credit', ids.order)},
  ${t(newId(), 'platform_write_off', ids.owed, 1200, 'write_off')},
  ${t(newId(), 'sale', newId(), 5000, 'sale', ids.order)};
insert into finance.fee_rule_sets (id, version, status, basis, include_shipping, platform_discounts_reduce_fee, default_rate_bps, treatment, agreement_version, effective_from, reason, approval_request_id, created_by, created_at)
  values ('${ids.rule}', 'v-mig', 'draft', 'after_seller_discounts', false, false, 1000, '{"returns": "fee_returned_pro_rata", "categoryNames": {"${ids.category}": "Electronics"}}', '2026-01', '${at}', 'Test', null, '{"kind":"system"}', '${at}');
insert into finance.fee_category_rates (rule_set_id, category_id, rate_bps) values ('${ids.rule}', '${ids.category}', 800), ('${ids.rule}', '${newId()}', 900);
insert into finance.holds (id, seller_id, amount, released_amount, currency, reason_code, reason, review_date, ref_kind, ref_id, status, placed_by, placed_at)
  values ('${newId()}', '${ids.seller}', 0, 0, 'USD', 'new_seller', 'New seller: earnings become available 9 extra days after delivery during your first 30 days', '2026-10-01', 'seller', '${ids.seller}', 'active', '{"kind":"system"}', '${at}');
`);
    await db.exec(m0004Pass4.sql);

    // captures and recon credit: expected becomes the order total, the credit is read from the description
    expect(await repo.get('captures', ids.capture)).toMatchObject({ card_amount: 7000, credit_amount: 103000, recon_item_id: ids.item, order_id: null });
    expect(await repo.get('recon_items', ids.item)).toMatchObject({ expected: 110000, actual: 7000, credit: 103000, difference: 0, status: 'matched' });
    expect(await repo.get('captures', ids.unexplained)).toMatchObject({ card_amount: 2000, credit_amount: 500, provider_ref: 'ch_123' });
    expect(await repo.get('recon_items', ids.item2)).toMatchObject({ expected: 0, credit: 500, difference: 2500 });
    // marketplace facts left trading_entries, with their ids
    expect((await repo.find('discount_funding', { redemption_id: ids.redemption })).map((r) => [r.funded_by, r.kind, r.amount])).toEqual(expect.arrayContaining([['platform', 'redeemed', 1000], ['seller', 'redeemed', 500]]));
    const liability = await repo.find('store_credit_liability', {});
    expect(liability.map((r) => [r.kind, r.amount]).sort()).toEqual([['expired', -300], ['granted', 2500], ['used', -800]]);
    expect(liability.find((r) => r.kind === 'used')).toMatchObject({ wallet_entry_id: null, order_id: ids.order });
    const costs = await repo.find('platform_costs', {});
    expect(costs.map((r) => [r.kind, r.amount, r.ref_kind]).sort()).toEqual([['carrier_claim', -400, 'claim'], ['credit_breakage', -300, 'wallet_entry'], ['goodwill_credit', 2500, 'wallet_entry'], ['label', 900, 'label'], ['write_off', 1200, 'amount_owed']]);
    expect((await repo.find('trading_entries', {})).map((r) => r.kind)).toEqual(['sale']);
    // category names from the rule set treatment
    const rates = await repo.find('fee_category_rates', { rule_set_id: ids.rule });
    expect(rates.map((r) => r.category_name).sort()).toEqual(['Category', 'Electronics']);
    expect((await repo.get('fee_rule_sets', ids.rule))!.treatment).toEqual({ returns: 'fee_returned_pro_rata' });
    // the new-seller period on the account; the rule hold is gone
    expect(await repo.findOne('seller_accounts', { seller_id: ids.seller })).toMatchObject({ new_seller_until: '2026-10-01', new_seller_extra_days: 9 });
    expect(await repo.find('holds', { seller_id: ids.seller })).toEqual([]);
  });
});
