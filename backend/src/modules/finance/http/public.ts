import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/finance.js';
import type { FinanceService } from '../service.js';

/**
 * Public API: /api/public/finance/…  (docs/api/modules/finance.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const publicRoutes = (service: FinanceService) =>
  routes(endpoints, 'public', {
    /** GET /fee-schedule: Published fee rules and an example calculation */
    getPublicFeeSchedule: async () => service.fees.schedule(),
  });
