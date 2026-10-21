import type { ServicesPublicApi } from '../../spec/services.js';
import { ServicesRequests } from './service/requests.js';

export type { ServicesServiceDeps } from './service/base.js';

/**
 * Services use cases: categories, providers and services (service/catalog.ts, with the time slots of bookable
 * services) and the requests, bookings and reviews (service/requests.ts) on the shared base. No public API yet:
 * everything is reached through the HTTP endpoints.
 */
export class ServicesService extends ServicesRequests implements ServicesPublicApi {}
