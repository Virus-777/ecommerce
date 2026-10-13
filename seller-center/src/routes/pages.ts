// Lazy page modules of this app, one per screen id (see the catalogue in @marketly/web-shared/routes).
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ScreenId } from '@marketly/web-shared/routes';

export const PAGES: Partial<Record<ScreenId, LazyExoticComponent<ComponentType>>> = {
  'seller/setup': lazy(() => import('../pages/Setup')),
  'seller/dashboard': lazy(() => import('../pages/Dashboard')),
  'seller/products': lazy(() => import('../pages/Products')),
  'seller/catalog-match': lazy(() => import('../pages/CatalogMatch')),
  'seller/product-new': lazy(() => import('../pages/ProductNew')),
  'seller/offer': lazy(() => import('../pages/Offer')),
  'seller/inventory': lazy(() => import('../pages/Inventory')),
  'seller/bulk-update': lazy(() => import('../pages/BulkUpdate')),
  'seller/orders': lazy(() => import('../pages/Orders')),
  'seller/order': lazy(() => import('../pages/Order')),
  'seller/shipping': lazy(() => import('../pages/Shipping')),
  'seller/returns': lazy(() => import('../pages/Returns')),
  'seller/return': lazy(() => import('../pages/Return')),
  'seller/finance': lazy(() => import('../pages/Finance')),
  'seller/statement': lazy(() => import('../pages/Statement')),
  'seller/marketing': lazy(() => import('../pages/Marketing')),
  'seller/ad-request': lazy(() => import('../pages/AdRequest')),
  'seller/customers': lazy(() => import('../pages/Customers')),
  'seller/reports': lazy(() => import('../pages/Reports')),
  'seller/performance': lazy(() => import('../pages/Performance')),
  'seller/store': lazy(() => import('../pages/Store')),
  'seller/staff': lazy(() => import('../pages/Staff')),
  'seller/notifications': lazy(() => import('../pages/Notifications')),
  'seller/help': lazy(() => import('../pages/Help')),
  'seller/help-article': lazy(() => import('../pages/HelpArticle')),
};
