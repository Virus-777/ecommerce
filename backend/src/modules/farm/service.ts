import type { FarmPublicApi } from '../../spec/farm.js';
import { FarmOrders } from './service/orders.js';

export type { FarmServiceDeps } from './service/base.js';

/**
 * Farm use cases: dealers and the nearest dealer (service/dealers.ts), and farm orders with their quotes, card
 * payments, staff moves, the payments event consumers, the expiry job and the data export (service/orders.ts), on the
 * shared base (service/base.ts).
 */
export class FarmService extends FarmOrders implements FarmPublicApi {}
