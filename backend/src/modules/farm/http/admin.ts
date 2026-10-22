import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/farm.js';
import type { FarmService } from '../service.js';

/**
 * Admin API: /api/admin/farm/…  (docs/api/modules/farm.md)
 * Admin › Departments › Farm orders: the dealers, and the orders staff move on the dealer's behalf. Writes are audited.
 */
export const adminRoutes = (service: FarmService) =>
  routes(endpoints, 'admin', {
    /** GET /dealers: Dealers in order */
    listDealers: async ({ query }) => service.listDealers(query),
    /** POST /dealers: Add a dealer */
    createDealer: async ({ body, actor, requestId }) => service.createDealer(body, { actor, requestId }),
    /** GET /dealers/{id}: A dealer for editing */
    getDealer: async ({ params }) => service.getDealer(params.id),
    /** PATCH /dealers/{id}: Change a dealer, move its pin or switch it off */
    updateDealer: async ({ params, body, actor, requestId }) => service.updateDealer(params.id, body, { actor, requestId }),
    /** DELETE /dealers/{id}: Delete a dealer with no orders */
    deleteDealer: async ({ params, actor, requestId }) => service.deleteDealer(params.id, { actor, requestId }),
    /** GET /orders: Farm orders, newest first */
    listOrdersAdmin: async ({ query, page }) => service.listOrdersAdmin(query, page),
    /** GET /orders/{id}: A farm order with its history */
    getOrderAdmin: async ({ params }) => service.getOrderAdmin(params.id),
    /** POST /orders/{id}/status: Confirm with a delivery date, reject, send out, deliver, cancel or reschedule an order */
    moveOrder: async ({ params, body, actor, requestId }) => service.moveOrder(params.id, body, { actor, requestId }),
  });
