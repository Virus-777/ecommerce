import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { OrdersService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "orders", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Query.order → service.getOrderForViewer
 *   Query.orders → service.listOrdersForCustomer
 *   Query.sellerOrder → service.getOrderForSeller
 *   Query.sellerOrders → service.listOrdersForSeller
 *   Query.sellerOrderCounts → service.countSellerOrders
 *   Query.orderAdmin → service.getOrderAdmin
 *   Query.ordersAdmin → service.listOrdersAdmin
 *   Customer.orderCounts → service.countOrdersByTab
 *   Customer.delayedItems → service.listDelayedItemsForCustomer
 *   Seller.orderCounts → service.countOrdersForSellers
 *   Case.order → service.getOrdersByIds
 *   Return.order → service.getOrdersByIds
 *   Case.order → service.getOrdersByIds
 *   Return.order → service.getOrdersByIds
 *   Case.order → service.getOrdersByIds
 *   Return.order → service.getOrdersByIds
 *   RefundRequest.order → service.getOrdersByIds
 */
export const resolvers = (service: OrdersService): ModuleResolvers => {
  void service;
  return {};
};
