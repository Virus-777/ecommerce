import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/food.js';
import type { FoodService } from '../service.js';

/**
 * Admin API: /api/admin/food/…  (docs/api/modules/food.md)
 * Admin › Departments › Food delivery: categories, restaurants and menus, the orders staff move on the restaurant's
 * behalf, and reviews. Writes are audited.
 */
export const adminRoutes = (service: FoodService) =>
  routes(endpoints, 'admin', {
    /** GET /categories: All food categories in order */
    listCategoriesAdmin: async () => service.listCategoriesAdmin(),
    /** POST /categories: Add a food category */
    createCategory: async ({ body, actor, requestId }) => service.createCategory(body, { actor, requestId }),
    /** PATCH /categories/{id}: Change a food category */
    updateCategory: async ({ params, body, actor, requestId }) => service.updateCategory(params.id, body, { actor, requestId }),
    /** DELETE /categories/{id}: Delete a food category */
    deleteCategory: async ({ params, actor, requestId }) => service.deleteCategory(params.id, { actor, requestId }),
    /** GET /restaurants: Restaurants with filters */
    listRestaurantsAdmin: async ({ query, page }) => service.listRestaurantsAdmin(query, page),
    /** POST /restaurants: Add a restaurant */
    createRestaurant: async ({ body, actor, requestId }) => service.createRestaurant(body, { actor, requestId }),
    /** GET /restaurants/{id}: A restaurant for editing */
    getRestaurantAdmin: async ({ params }) => service.getRestaurantAdmin(params.id),
    /** PATCH /restaurants/{id}: Change a restaurant, pause or hide it */
    updateRestaurant: async ({ params, body, actor, requestId }) => service.updateRestaurant(params.id, body, { actor, requestId }),
    /** DELETE /restaurants/{id}: Delete a restaurant with no orders */
    deleteRestaurant: async ({ params, actor, requestId }) => service.deleteRestaurant(params.id, { actor, requestId }),
    /** GET /restaurants/{id}/menu: A restaurant's sections and items */
    getMenuAdmin: async ({ params }) => service.getMenuAdmin(params.id),
    /** POST /restaurants/{id}/sections: Add a menu section */
    createSection: async ({ params, body, actor, requestId }) => service.createSection(params.id, body, { actor, requestId }),
    /** PATCH /sections/{id}: Rename or reorder a menu section */
    updateSection: async ({ params, body, actor, requestId }) => service.updateSection(params.id, body, { actor, requestId }),
    /** DELETE /sections/{id}: Delete an empty menu section */
    deleteSection: async ({ params, actor, requestId }) => service.deleteSection(params.id, { actor, requestId }),
    /** POST /restaurants/{id}/items: Add a menu item */
    createItem: async ({ params, body, actor, requestId }) => service.createItem(params.id, body, { actor, requestId }),
    /** PATCH /items/{id}: Change a menu item or mark it unavailable */
    updateItem: async ({ params, body, actor, requestId }) => service.updateItem(params.id, body, { actor, requestId }),
    /** DELETE /items/{id}: Delete a menu item */
    deleteItem: async ({ params, actor, requestId }) => service.deleteItem(params.id, { actor, requestId }),
    /** GET /orders: Food orders, newest first */
    listOrdersAdmin: async ({ query, page }) => service.listOrdersAdmin(query, page),
    /** GET /orders/{id}: A food order with its history */
    getOrderAdmin: async ({ params }) => service.getOrderAdmin(params.id),
    /** POST /orders/{id}/status: Accept, decline, prepare, send, deliver or cancel an order */
    moveOrder: async ({ params, body, actor, requestId }) => service.moveOrder(params.id, body, { actor, requestId }),
    /** GET /reviews: Food reviews, newest first */
    listReviewsAdmin: async ({ query, page }) => service.listReviewsAdmin(query, page),
    /** POST /reviews/{id}/moderate: Hide or show a food review */
    moderateReview: async ({ params, body, actor, requestId }) => service.moderateReview(params.id, body, { actor, requestId }),
  });
