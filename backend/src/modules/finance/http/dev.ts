/**
 * Development-only finance route (BACKEND-REQUESTS G11):
 *
 *   GET /api/dev/finance/test-deposits?sellerId=<uuid>   the test-deposit amounts of the seller's payout account
 *                                                         waiting for confirmation (development payout provider)
 *
 * Served by the kernel only while DEV_TOKENS is on, outside the API spec and hidden from OpenAPI (ctx.http.devRoutes,
 * kernel/http/dev-routes.ts); any valid token may call it. 404 when nothing waits for confirmation.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { DevRoute } from '../../../kernel/http/dev-routes.js';
import type { FinanceService } from '../service.js';

export const devRoutes = (service: FinanceService): DevRoute[] => [
  {
    method: 'GET',
    path: '/test-deposits',
    summary: 'test-deposit amounts of a payout account waiting for confirmation',
    handler: async ({ query }) => {
      const sellerId = String(query.sellerId ?? '').trim();
      if (!sellerId) throw new AppError('VALIDATION_FAILED', 'Invalid query: sellerId is required', { issues: [{ path: 'sellerId', message: 'required' }] });
      const deposits = await service.destinations.devTestDeposits(sellerId);
      if (!deposits) throw new AppError('NOT_FOUND', 'No payout account is waiting for test deposits');
      return deposits;
    },
  },
];
