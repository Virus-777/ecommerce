import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/catalog.js';
import type { CatalogService } from '../service.js';

/**
 * Store API: /api/store/catalog/…  (docs/api/modules/catalog.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: CatalogService) =>
  routes(endpoints, 'store', {
    /** GET /categories: Visible category tree with in-stock counts and images */
    listCategories: async () => service.listCategories({ includeHidden: false }),
    /** GET /categories/{slug}: Category with breadcrumb, subcategories and filterable attributes */
    getCategory: async ({ params }) => {
      const c = await service.getCategoryBySlug(params.slug);
      if (!c) throw new AppError('NOT_FOUND', 'Category not found');
      return c;
    },
    /** GET /brands: Active brands, optionally the popular brands of one category */
    listBrands: async ({ query, page }) => service.listBrandsStore(query, page),
    /** GET /brands/{slug}: Brand page header (logo, banner, description, product count) */
    getBrand: async ({ params }) => {
      const b = await service.getBrandBySlug(params.slug);
      if (!b) throw new AppError('NOT_FOUND', 'Brand not found');
      return b;
    },
    /** GET /products/{id}: Product detail (shared content only) */
    getProduct: async ({ params }) => service.storeProduct(params.id),
  });
