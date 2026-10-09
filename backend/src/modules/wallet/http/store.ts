import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/wallet.js';
import type { WalletService } from '../service.js';
import { byOf, callerKey, ownCustomer } from './by.js';

/**
 * Store API: /api/store/wallet/…  (docs/api/modules/wallet.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * A customer only ever reaches their own wallet (the customer id comes from the token's record scope).
 */
export const storeRoutes = (service: WalletService) =>
  routes(endpoints, 'store', {
    /** GET /credit: Store credit balance, lots with expiry and recent history */
    getMyCredit: async ({ scope }) => {
      const customerId = ownCustomer(scope);
      if (!customerId) return service.ledger.overview(scope.kind === 'customer' ? scope.accountId : '');
      return service.ledger.overview(customerId);
    },
    /** GET /credit/entries: Credit history */
    listMyCreditEntries: async ({ scope, page }) => {
      const customerId = ownCustomer(scope);
      if (!customerId) return { items: [], nextCursor: null };
      return service.ledger.entriesPage(customerId, {}, page, { staff: false });
    },
    /** POST /gift-cards/redeem: Add a gift card to store credit */
    redeemGiftCard: async (i) => {
      const customerId = ownCustomer(i.scope);
      if (!customerId) throw new AppError('NOT_FOUND', 'Customer account not found');
      return service.giftCards.redeem(i.body.code, customerId, byOf(i));
    },
    /** POST /gift-cards/check: Check a gift card balance */
    checkGiftCard: async ({ body, scope, principal }) => service.giftCards.check(body.code, callerKey(scope, principal)),
    /** GET /loyalty: Loyalty points (experiment; NOT_IMPLEMENTED until a program is defined) */
    getMyLoyalty: async ({ scope }) => {
      const customerId = ownCustomer(scope);
      if (!customerId) throw new AppError('NOT_FOUND', 'Customer account not found');
      return service.loyalty(customerId);
    },
  });
