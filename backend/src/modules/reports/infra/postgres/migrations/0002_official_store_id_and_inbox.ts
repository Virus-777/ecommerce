import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * 1. The Official Store's rows in per-seller facts used the nil uuid; they now use the spec constant
 *    OFFICIAL_STORE_ID (common.json).
 * 2. Idempotent consumers claim their natural keys in the kernel inbox (ctx.inbox) instead of `seen:` rows in
 *    read_model_checkpoints: handled keys move to kernel.processed_events; the values later events need (open
 *    stock-out intervals, the campaign of a redemption or ad charge) stay as `lookup:` rows.
 */
export const m0002OfficialStoreIdAndInbox: Migration = {
  id: '0002_official_store_id_and_inbox',
  sql: /* sql */ `
update reports.fact_service_daily f set seller_id = '00000000-0000-7000-8000-000000000001'
  where f.seller_id = '00000000-0000-0000-0000-000000000000'
    and not exists (select 1 from reports.fact_service_daily x where x.seller_id = '00000000-0000-7000-8000-000000000001' and x.day = f.day);
update reports.fact_marketplace_finance_daily f set seller_id = '00000000-0000-7000-8000-000000000001'
  where f.seller_id = '00000000-0000-0000-0000-000000000000'
    and not exists (select 1 from reports.fact_marketplace_finance_daily x where x.seller_id = '00000000-0000-7000-8000-000000000001' and x.day = f.day);
update reports.fact_returns set seller_id = '00000000-0000-7000-8000-000000000001' where seller_id = '00000000-0000-0000-0000-000000000000';
update reports.fact_refunds set seller_id = null, owner_type = 'official' where seller_id = '00000000-0000-0000-0000-000000000000';

insert into kernel.processed_events (module, key)
  select 'reports', substr(key, 6) from reports.read_model_checkpoints
  where key like 'seen:%' and key not like 'seen:stockout:%'
  on conflict do nothing;
update reports.read_model_checkpoints set key = 'lookup:' || substr(key, 6), state = 'lookup'
  where (key like 'seen:stockout:%' or key like 'seen:redemption:%' or key like 'seen:charge:%') and last_event_id is not null;
delete from reports.read_model_checkpoints where key like 'seen:%';
`,
};
