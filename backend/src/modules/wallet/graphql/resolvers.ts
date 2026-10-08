import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { WalletService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "wallet", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Customer.wallet → service.getBalance
 *   Customer.walletAdmin → service.getCustomerWallet
 */
export const resolvers = (service: WalletService): ModuleResolvers => {
  void service;
  return {};
};
