import type { FarmPublicApi } from '../../spec/farm.js';
import { FarmStatisticsPart } from './service/statistics.js';

export type { FarmServiceDeps } from './service/base.js';

/**
 * Farm use cases: dealers and the nearest dealer (service/dealers.ts), farm orders with their quotes, card
 * payments, staff moves, the payments event consumers, the expiry job and the data export (service/orders.ts), and
 * the customer's machine statistics (service/statistics.ts), on the shared base (service/base.ts).
 */
export class FarmService extends FarmStatisticsPart implements FarmPublicApi {}
