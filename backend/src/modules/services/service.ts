import type { ServicesPublicApi } from '../../spec/services.js';
import { ServicesSearchPart } from './service/search.js';

export type { ServicesServiceDeps } from './service/base.js';
export type { Viewer } from './service/catalog.js';

/**
 * Services use cases: categories, providers, saved providers and services (service/catalog.ts, with the time slots of
 * bookable services and distances from the customer), the requests, bookings and reviews (service/requests.ts), the
 * registered devices of Post-sale (service/devices.ts), the customer's request statistics (service/statistics.ts)
 * and these areas' part of the integrated search (service/search.ts) on the shared base. The public API is the
 * integrated search and the customer data export; everything else is reached through the HTTP endpoints.
 */
export class ServicesService extends ServicesSearchPart implements ServicesPublicApi {}
