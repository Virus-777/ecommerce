import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly: session_lines.fulfilled_by (the offer's Offer.shipping.fulfilledBy when the line was quoted)
 * and session_packages.fulfilled_by (the package's, which becomes the order group's fulfilledBy).
 *
 * Backfill: until this version no line could be Marketly-fulfilled (fulfillment-service was never enabled), so Official
 * Store rows are official_warehouse and seller rows seller. Package keys of existing sessions keep their earlier form
 * (owner:seller:ships-from): keys are opaque within a session and the stored quote refers to them, so they are not
 * rewritten; new lines get owner:seller:fulfilledBy:ships-from.
 */
export const m0003FulfilledBy: Migration = {
  id: '0003_fulfilled_by',
  sql: /* sql */ `
alter table checkout.session_lines add column fulfilled_by text;
update checkout.session_lines set fulfilled_by = case when owner_type = 'official' then 'official_warehouse' else 'seller' end;
alter table checkout.session_lines alter column fulfilled_by set not null;
alter table checkout.session_lines add constraint session_lines_fulfilled_by_check check (fulfilled_by in ('official_warehouse', 'seller', 'marketly_service'));

alter table checkout.session_packages add column fulfilled_by text;
update checkout.session_packages set fulfilled_by = case when owner_type = 'official' then 'official_warehouse' else 'seller' end;
alter table checkout.session_packages alter column fulfilled_by set not null;
alter table checkout.session_packages add constraint session_packages_fulfilled_by_check check (fulfilled_by in ('official_warehouse', 'seller', 'marketly_service'));
`,
};
