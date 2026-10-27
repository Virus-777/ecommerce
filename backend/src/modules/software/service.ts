import type { SoftwarePublicApi } from '../../spec/software.js';
import { SoftwareSearchPart } from './service/search.js';

export type { SoftwareServiceDeps } from './service/base.js';

/**
 * Softwares use cases: categories, apps, packs, rails, deals and reviews (service/catalog.ts), owning apps:
 * free apps, purchases paid through payments purchase intents, downloads, the library and staff grants
 * (service/purchases.ts), the customer's software statistics (service/statistics.ts) and this department's part of
 * the integrated search (service/search.ts), on the shared base (service/base.ts). The public API is the
 * integrated search and the customer data export.
 */
export class SoftwareService extends SoftwareSearchPart implements SoftwarePublicApi {}
