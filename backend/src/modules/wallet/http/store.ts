import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/wallet.js';
import type { WalletService } from '../service.js';

/**
 * Store API: /api/store/wallet/…  (docs/api/modules/wallet.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: WalletService) => {
  void service;
  return routes(endpoints, 'store', {
    /** GET /credit: Store credit balance, lots with expiry and recent history */
    getMyCredit: notImplemented,
    /** GET /credit/entries: Credit history */
    listMyCreditEntries: notImplemented,
    /** POST /gift-cards/redeem: Add a gift card to store credit */
    redeemGiftCard: notImplemented,
    /** POST /gift-cards/check: Check a gift card balance */
    checkGiftCard: notImplemented,
    /** GET /loyalty: Loyalty points (experiment; NOT_IMPLEMENTED until a program is defined) */
    getMyLoyalty: notImplemented,
  });
};
