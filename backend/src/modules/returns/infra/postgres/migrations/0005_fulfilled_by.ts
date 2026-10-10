import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly (decision D7): returns.fulfilled_by is the order group's fulfilledBy, copied at request.
 * Returns requested before it were never Marketly-fulfilled (fulfillment-service did not route orders yet):
 * Official Store returns are backfilled official_warehouse, seller returns seller.
 */
export const m0005FulfilledBy: Migration = {
  id: '0005_fulfilled_by',
  sql: /* sql */ `
alter table returns.returns add column fulfilled_by text;
update returns.returns set fulfilled_by = case when owner_type = 'official' then 'official_warehouse' else 'seller' end where fulfilled_by is null;
alter table returns.returns alter column fulfilled_by set not null;
alter table returns.returns add constraint returns_fulfilled_by_check check (fulfilled_by in ('official_warehouse', 'seller', 'marketly_service'));
comment on column returns.returns.fulfilled_by is 'official_warehouse|seller|marketly_service (the order group''s, copied at request)';
`,
};
