import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Parcel data and list price live on the variant (decisions O1/O2): shipping weight and packaged dimensions of one
 * unit (shipping quotes and labels read them with getParcels / getVariants) and the staff-only manufacturer list
 * price. Existing variants have none yet; callers fall back to their own default parcel while weight_grams is null.
 */
export const m0002VariantParcelListPrice: Migration = {
  id: '0002_variant_parcel_list_price',
  sql: /* sql */ `
alter table catalog.variants add column weight_grams int check (weight_grams > 0);
alter table catalog.variants add column length_cm int;
alter table catalog.variants add column width_cm int;
alter table catalog.variants add column height_cm int;
alter table catalog.variants add column list_price_amount bigint;
alter table catalog.variants add column list_price_currency char(3);
`,
};
