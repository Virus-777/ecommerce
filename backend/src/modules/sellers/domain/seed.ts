/**
 * Seed rows written on boot (every MongoDB install starts from code; docs/04-mongodb-migration.md §3).
 *
 * TEMPLATE_GRANTS: permissions added to a member role template after members may have been invited with it
 * (sellers.template_grants). A member invited while the permission's module was off gets
 * the template without the key; MembersPart.applyTemplateGrants applies each grant once, at the first start where the
 * key is in the catalogue (its module runs), to the open members of the template who lack it.
 */
export const TEMPLATE_GRANTS: readonly { template: 'products_inventory' | 'shipping' | 'customer_service'; permission: string }[] = [
  { template: 'products_inventory', permission: 'fulfillment-service.inbound.manage' },
  { template: 'products_inventory', permission: 'fulfillment-service.fees.view' },
  // unit costs per offer (doc 09 §3.1, October 2026): the template that manages prices sets costs too
  { template: 'products_inventory', permission: 'offers.costs.manage' },
];
