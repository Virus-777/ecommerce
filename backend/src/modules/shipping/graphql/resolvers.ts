import type { ModuleResolvers } from '../../../kernel/graphql/index.js';
import type { ShippingService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "shipping", …)` in graphql/schema.ts).
 * A field without a resolver answers NOT_IMPLEMENTED; fields of this module's own types without
 * @source resolve from the parent object.
 *
 * Fields to resolve:
 *   Query.myShippingSetup → service.getSellerShippingSetup
 *   Query.shipment → service.getShipment
 *   Query.shipmentAdmin → service.getShipment
 *   Query.deliveryExceptions → service.listExceptions
 *   Query.deliveryExceptionCounts → service.countOpenExceptions
 *   OrderGroup.shipments → service.listShipmentsForGroups
 *   OrderGroup.deliveryExceptions → service.listExceptionsForOrder
 *   Order.deliveryExceptions → service.listExceptionsForOrder
 *   Offer.deliveryEstimate → service.estimateOffers
 *   Seller.shippingSummary → service.getSellerShippingSummaries
 *   ReturnReplacement.shipment → service.shipmentsForReplacements
 */
export const resolvers = (service: ShippingService): ModuleResolvers => ({});
