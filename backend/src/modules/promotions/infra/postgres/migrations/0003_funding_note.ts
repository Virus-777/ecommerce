import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4: campaigns.funding_note gets its own column. Until now the note was kept inside the deals jsonb as
 * { placement, fundingNote }. Backfill: the note moves to the column and deals becomes the Deals placement itself
 * (SQL null when there was none). Rows already in the new shape (no placement / fundingNote keys) are left alone.
 */
export const m0003FundingNote: Migration = {
  id: '0003_funding_note',
  sql: /* sql */ `
alter table promotions.campaigns add column funding_note text;
comment on column promotions.campaigns.funding_note is 'Funding note shown to Finance, e.g. Official Store items are a company cost';
update promotions.campaigns
   set funding_note = nullif(deals->>'fundingNote', ''),
       deals = nullif(deals->'placement', 'null'::jsonb)
 where deals is not null and jsonb_typeof(deals) = 'object' and (deals ? 'placement' or deals ? 'fundingNote');
`,
};
