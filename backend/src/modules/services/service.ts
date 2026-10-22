import type { ServicesPublicApi } from '../../spec/services.js';
import { ServicesDevices } from './service/devices.js';

export type { ServicesServiceDeps } from './service/base.js';
export type { Viewer } from './service/catalog.js';

/**
 * Services use cases: categories, providers, saved providers and services (service/catalog.ts, with the time slots of
 * bookable services and distances from the customer), the requests, bookings and reviews (service/requests.ts) and the
 * registered devices of Post-sale (service/devices.ts) on the shared base. No public API yet: everything is reached
 * through the HTTP endpoints.
 */
export class ServicesService extends ServicesDevices implements ServicesPublicApi {}
