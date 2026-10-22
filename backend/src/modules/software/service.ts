import type { SoftwarePublicApi } from '../../spec/software.js';
import { SoftwarePurchases } from './service/purchases.js';

export type { SoftwareServiceDeps } from './service/base.js';

/**
 * Softwares use cases: categories, apps, packs, rails, deals and reviews (service/catalog.ts) and owning apps:
 * free apps, purchases paid through payments purchase intents, downloads, the library and staff grants
 * (service/purchases.ts), on the shared base (service/base.ts). The public API is the customer data export.
 */
export class SoftwareService extends SoftwarePurchases implements SoftwarePublicApi {}
