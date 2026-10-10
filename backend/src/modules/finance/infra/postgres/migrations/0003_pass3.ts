import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 3:
 * - holds.trust_report_id: a hold placed for a trust recommendation keeps the report through an approval, so
 *   finance.hold.placed carries trustReportId when the approved hold is finally placed.
 * - One live payout run per cutoff: finance.payout-run.create now runs every 15 minutes and checks the cutoff
 *   itself; the index makes a concurrent or repeated run fail instead of creating a second run (a cancelled
 *   run may be recreated by staff).
 * - Store-credit liability lookups by kind and time (daily store_credit check).
 */
export const m0003Pass3: Migration = {
  id: '0003_pass3',
  sql: /* sql */ `
alter table finance.holds add column if not exists trust_report_id uuid;
create unique index if not exists payout_runs_one_live_per_cutoff on finance.payout_runs (cutoff_at) where status <> 'cancelled';
create index if not exists trading_entries_ref_kind_at on finance.trading_entries (ref_kind, at);
`,
};
