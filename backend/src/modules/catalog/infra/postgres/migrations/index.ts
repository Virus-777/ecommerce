import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002VariantParcelListPrice } from './0002_variant_parcel_list_price.js';
import { m0003PausedAtCheckDismissals } from './0003_paused_at_check_dismissals.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002VariantParcelListPrice, m0003PausedAtCheckDismissals];
