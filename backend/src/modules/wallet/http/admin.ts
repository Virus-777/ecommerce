import { AppError } from '../../../kernel/errors/index.js';
import { routes, notImplemented } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/wallet.js';
import type { WalletService } from '../service.js';
import { byOf } from './by.js';

/**
 * Admin API: /api/admin/wallet/…  (docs/api/modules/wallet.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: WalletService) => {
  /** A customer id that customers does not know is NOT_FOUND */
  const known = async (customerId: string) => {
    if (!(await service.core.customer(customerId))) throw new AppError('NOT_FOUND', 'Customer not found');
    return customerId;
  };
  return routes(endpoints, 'admin', {
    /** GET /customers/{customerId}: A customer's credit balance, lots, goodwill in the last 30 days and pending grants */
    getCustomerWallet: async ({ params }) => service.getCustomerWallet(await known(params.customerId)),
    /** GET /customers/{customerId}/entries: A customer's credit ledger */
    listCustomerEntries: async ({ params, query, page }) => service.ledger.entriesPage(await known(params.customerId), { kind: query.kind }, page, { staff: true }),
    /** POST /goodwill: Grant goodwill credit with a reason */
    grantGoodwillCredit: async (i) => service.staff.grant(i.body, byOf(i), i.idempotencyKey, { http: true }),
    /** GET /goodwill: Goodwill grants for review */
    listGoodwill: async ({ query, page }) => service.staff.list(query, page),
    /** POST /goodwill/{id}/reverse: Reverse an unused goodwill grant */
    reverseGoodwill: async (i) => service.staff.reverse(i.params.id, i.body.reason, byOf(i)),
    /** POST /customers/{customerId}/corrections: Correct a balance (positive or negative) with a reason */
    correctCredit: async (i) => service.staff.correct(i.params.customerId, i.body, byOf(i), i.idempotencyKey),
    /** POST /gift-cards: Issue a batch of gift cards */
    issueGiftCards: async (i) => service.giftCards.issue(i.body, byOf(i), i.idempotencyKey),
    /** GET /gift-cards: Gift cards */
    listGiftCards: async ({ query, page }) => service.giftCards.list(query, page),
    /** POST /gift-cards/{id}/void: Void a gift card (lost, fraud) */
    voidGiftCard: async (i) => service.giftCards.void(i.params.id, i.body.reason, byOf(i)),
    /** GET /gift-cards/batches/{id}/codes: Download a batch's gift card codes once (TODO pass 3: implement) */
    getGiftCardCodes: notImplemented,
  });
};
