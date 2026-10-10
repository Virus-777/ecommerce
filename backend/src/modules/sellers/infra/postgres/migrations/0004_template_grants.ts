import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly (fulfillment-service, phase 4): the products_inventory role template now includes
 * fulfillment-service.inbound.manage and fulfillment-service.fees.view, but member permissions are stored per member,
 * so members invited with the template before keep the old list.
 *
 * SQL cannot tell whether fulfillment-service runs (the seller permission catalogue is built from the enabled modules
 * at start), and a stored key the catalogue does not know makes the member uneditable (updateMember re-validates the
 * stored list). So this migration only records the two grants in template_grants; MembersPart.applyTemplateGrants
 * applies each one once, at the first start where its key is in the catalogue (fulfillment-service enabled), to the
 * open members of the template who lack it.
 */
export const m0004TemplateGrants: Migration = {
  id: '0004_template_grants',
  sql: /* sql */ `
create table sellers.template_grants (
  id uuid primary key,
  template text not null,
  permission text not null,
  created_at timestamptz not null,
  applied_at timestamptz,
  members_updated int
);
comment on table sellers.template_grants is 'Permissions added to a member role template after members were invited with it; applied once, at the first start where the permission''s module runs';
create unique index on sellers.template_grants (template, permission);
insert into sellers.template_grants (id, template, permission, created_at) values
  (gen_random_uuid(), 'products_inventory', 'fulfillment-service.inbound.manage', now()),
  (gen_random_uuid(), 'products_inventory', 'fulfillment-service.fees.view', now());
`,
};
