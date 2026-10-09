import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/catalog.js';
import type { CatalogService } from '../service.js';

/**
 * Seller API: /api/seller/catalog/…  (docs/api/modules/catalog.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Sellers act for input.sellerId; another seller's product is 404.
 */
export const sellerRoutes = (service: CatalogService) =>
  routes(endpoints, 'seller', {
    /** GET /match: Search the catalog before adding a product */
    matchCatalog: async ({ query, page, sellerId }) => service.matchCatalog(sellerId, query, page),
    /** GET /brands: Brands for the submission form */
    listBrandsSeller: async ({ query, page, sellerId }) => service.listBrandsForSeller(sellerId, query.q, page),
    /** GET /products: This seller's submitted products */
    listOwnProducts: async ({ query, page, sellerId }) => service.listOwnProducts(sellerId, query, page),
    /** GET /products/{id}: One own product with review feedback */
    getOwnProduct: async ({ params, sellerId }) => service.getOwnProduct(sellerId, params.id),
    /** POST /products: Create a product draft */
    createDraft: async ({ body, sellerId, actor, requestId, principal }) => service.createDraft(sellerId, body, { actor, requestId, principal }),
    /** PATCH /products/{id}: Edit a draft or a product with changes requested */
    updateDraft: async ({ params, body, sellerId, actor, requestId, principal }) => service.updateDraft(sellerId, params.id, body, { actor, requestId, principal }),
    /** POST /products/{id}/submit: Submit for review */
    submitProduct: async ({ params, body, sellerId, actor, requestId, principal }) => service.submitOwn(sellerId, params.id, body?.note, { actor, requestId, principal }),
    /** POST /products/{id}/corrections: Suggest a correction to shared product content */
    suggestCorrection: async ({ params, body, sellerId, actor, requestId, principal }) => service.suggestCorrection(sellerId, params.id, body, { actor, requestId, principal }),
    /** GET /categories/{id}/attributes: Attributes (own and inherited) and image standards for a category (drives the submission form) */
    listCategoryAttributes: async ({ params }) => service.categoryAttributes(params.id),
  });
