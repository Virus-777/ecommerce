import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/finance.js';
import type { FinanceService } from '../service.js';

/**
 * Webhooks: /webhooks/finance/…  (docs/api/modules/finance.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const webhooksRoutes = (service: FinanceService) =>
  routes(endpoints, 'webhooks', {
    /** POST /payouts: Payout provider status (paid, failed, returned). Duplicates change nothing: the payout's state decides. */
    payoutWebhook: async ({ body }) => {
      await service.payouts.onWebhook(body);
    },
  });
