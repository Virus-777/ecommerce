import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/catalog.js';
import type { CatalogService } from '../service.js';

/**
 * Store API: /api/store/catalog/…  (docs/api/modules/catalog.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: CatalogService) =>
  routes(endpoints, 'store', {
    /** GET /categories: Visible category tree with in-stock counts and images */
    listCategories: notImplemented,
    /** GET /categories/{slug}: Category with breadcrumb, subcategories and filterable attributes */
    getCategory: notImplemented,
    /** GET /brands: Active brands, optionally the popular brands of one category */
    listBrands: notImplemented,
    /** GET /brands/{slug}: Brand page header (logo, banner, description, product count) */
    getBrand: notImplemented,
    /** GET /products/{id}: Product detail (shared content only) */
    getProduct: notImplemented,
  });
