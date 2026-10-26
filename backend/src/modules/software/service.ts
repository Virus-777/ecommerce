import type { SoftwarePublicApi } from '../../spec/software.js';
import { SoftwareStatisticsPart } from './service/statistics.js';

export type { SoftwareServiceDeps } from './service/base.js';

/**
 * Softwares use cases: categories, apps, packs, rails, deals and reviews (service/catalog.ts), owning apps:
 * free apps, purchases paid through payments purchase intents, downloads, the library and staff grants
 * (service/purchases.ts), and the customer's software statistics (service/statistics.ts), on the shared base
 * (service/base.ts). The public API is the customer data export.
 */
export class SoftwareService extends SoftwareStatisticsPart implements SoftwarePublicApi {}
