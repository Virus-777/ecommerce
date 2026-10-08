import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { PaymentsService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "payments", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Order.payment → service.getPaymentForOrder
 *   Order.refunds → service.listRefundsForOrder
 *   Order.refundable → service.remainingRefundable
 *   Order.paymentDisputes → service.listDisputesForOrder
 *   Customer.paymentMethods → service.listSavedMethods
 */
export const resolvers = (service: PaymentsService): ModuleResolvers => {
  void service;
  return {};
};
