import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/catalog.js';
import type { CatalogService } from '../service.js';

/**
 * Seller API: /api/seller/catalog/…  (docs/api/modules/catalog.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: CatalogService) =>
  routes(endpoints, 'seller', {
    /** GET /match: Search the catalog before adding a product */
    matchCatalog: notImplemented,
    /** GET /brands: Brands for the submission form */
    listBrandsSeller: notImplemented,
    /** GET /products: This seller's submitted products */
    listOwnProducts: notImplemented,
    /** GET /products/{id}: One own product with review feedback */
    getOwnProduct: notImplemented,
    /** POST /products: Create a product draft */
    createDraft: notImplemented,
    /** PATCH /products/{id}: Edit a draft or a product with changes requested */
    updateDraft: notImplemented,
    /** POST /products/{id}/submit: Submit for review */
    submitProduct: notImplemented,
    /** POST /products/{id}/corrections: Suggest a correction to shared product content */
    suggestCorrection: notImplemented,
    /** GET /categories/{id}/attributes: Attributes (own and inherited) and image standards for a category (drives the submission form) */
    listCategoryAttributes: notImplemented,
  });
