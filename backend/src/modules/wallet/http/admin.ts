import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/wallet.js';
import type { WalletService } from '../service.js';

/**
 * Admin API: /api/admin/wallet/…  (docs/api/modules/wallet.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: WalletService) =>
  routes(endpoints, 'admin', {
    /** GET /customers/{customerId}: A customer's credit balance, lots, goodwill in the last 30 days and pending grants */
    getCustomerWallet: notImplemented,
    /** GET /customers/{customerId}/entries: A customer's credit ledger */
    listCustomerEntries: notImplemented,
    /** POST /goodwill: Grant goodwill credit with a reason */
    grantGoodwillCredit: notImplemented,
    /** GET /goodwill: Goodwill grants for review */
    listGoodwill: notImplemented,
    /** POST /goodwill/{id}/reverse: Reverse an unused goodwill grant */
    reverseGoodwill: notImplemented,
    /** POST /customers/{customerId}/corrections: Correct a balance (positive or negative) with a reason */
    correctCredit: notImplemented,
    /** POST /gift-cards: Issue a batch of gift cards */
    issueGiftCards: notImplemented,
    /** GET /gift-cards: Gift cards */
    listGiftCards: notImplemented,
    /** POST /gift-cards/{id}/void: Void a gift card (lost, fraud) */
    voidGiftCard: notImplemented,
  });
