import type { ScreenId } from '@marketly/web-shared/routes';
import type { IconName } from '@marketly/web-shared/ui';
import type { AdImpression } from '@/api/ads';

// Sample content for theme-patterns.html.

export interface OfferDemo {
  price: number;
  shipping: string;
  seller: string;
  badge: { tone: 'brand' | 'info'; icon: IconName; label: string };
  lines: Array<{ icon: IconName; text: string; strong?: string; after?: string }>;
}

export const OFFERS: OfferDemo[] = [
  {
    price: 189,
    shipping: 'Free shipping',
    seller: 'Marketly Official',
    badge: { tone: 'brand', icon: 'badge-check', label: 'Official' },
    lines: [
      { icon: 'truck', text: 'Arrives ', strong: 'Thu, Oct 15', after: ' · Ships today' },
      { icon: 'undo-2', text: '30-day free returns' },
      { icon: 'shield-check', text: '2-year manufacturer warranty' },
    ],
  },
  {
    price: 184,
    shipping: '+ $6.99 shipping',
    seller: 'Northwind Audio',
    badge: { tone: 'info', icon: 'shield-check', label: 'Verified' },
    lines: [
      { icon: 'truck', text: 'Arrives ', strong: 'Fri, Oct 16', after: ' · Ships in 1 business day' },
      { icon: 'undo-2', text: '30-day returns, buyer pays return shipping' },
      { icon: 'shield-check', text: '2-year manufacturer warranty' },
    ],
  },
];

export const APP_VS_WEB: Array<{ icon: IconName; title: string; points: string[] }> = [
  {
    icon: 'smartphone',
    title: 'Android app (phone)',
    points: [
      'Bottom tab bar: Home, Categories, Deals, Cart, Account',
      'App bar with back button on every sub-page',
      'Sticky action bar for Add to cart, Checkout, Submit',
      'Lists load more as you scroll; no page numbers',
      'Help, policies, About, selling and app settings live in the Account tab',
      'No footer, no promo strip, no breadcrumbs',
    ],
  },
  {
    icon: 'monitor',
    title: 'Website (tablet and desktop)',
    points: [
      'Header with search, account, orders and cart',
      'Category bar: Deals, Official Store, New arrivals, Brands',
      'Breadcrumbs on catalogue pages',
      'Footer with help, policies, selling and company links',
      'Numbered pages on long lists',
      'Account pages use a side menu on desktop',
    ],
  },
];

export const STORE_NAV_DEMO: Array<{ label: string; icon?: IconName; id: ScreenId; view?: string; active?: boolean; deal?: boolean }> = [
  { label: 'All categories', icon: 'menu', id: 'store/categories' },
  { label: 'Deals', icon: 'tag', id: 'store/deals', active: true, deal: true },
  { label: 'Official Store', icon: 'badge-check', id: 'store/official' },
  { label: 'New arrivals', id: 'store/collection' },
  { label: 'Best sellers', id: 'store/collection', view: 'best-sellers' },
  { label: 'Brands', id: 'store/brand' },
];

export const TABBAR_DEMO: Array<{ label: string; icon: IconName; id: ScreenId; count?: number; active?: boolean }> = [
  { label: 'Home', icon: 'house', id: 'store/home', active: true },
  { label: 'Categories', icon: 'layout-grid', id: 'store/categories' },
  { label: 'Deals', icon: 'tag', id: 'store/deals' },
  { label: 'Cart', icon: 'shopping-cart', id: 'store/cart', count: 4 },
  { label: 'Account', icon: 'user-round', id: 'account/overview' },
];

export const SELLER_NAV_DEMO: Array<{ label: string; icon: IconName; id: ScreenId; count?: number; urgent?: boolean; active?: boolean }> = [
  { label: 'Setup guide', icon: 'list-checks', id: 'seller/setup' },
  { label: 'Dashboard', icon: 'layout-dashboard', id: 'seller/dashboard' },
  { label: 'Products and offers', icon: 'package', id: 'seller/products' },
  { label: 'Inventory', icon: 'boxes', id: 'seller/inventory', count: 3 },
  { label: 'Orders', icon: 'shopping-bag', id: 'seller/orders', count: 4, urgent: true, active: true },
  { label: 'Shipping', icon: 'truck', id: 'seller/shipping' },
  { label: 'Returns and cases', icon: 'undo-2', id: 'seller/returns', count: 2 },
  { label: 'Finance', icon: 'wallet', id: 'seller/finance' },
  { label: 'Marketing and ads', icon: 'megaphone', id: 'seller/marketing' },
  { label: 'Customers', icon: 'message-square', id: 'seller/customers', count: 5 },
  { label: 'Reports', icon: 'chart-column', id: 'seller/reports' },
  { label: 'Account health', icon: 'gauge', id: 'seller/performance' },
  { label: 'Store and settings', icon: 'store', id: 'seller/store' },
  { label: 'Notifications', icon: 'bell', id: 'seller/notifications', count: 4 },
  { label: 'Help and support', icon: 'life-buoy', id: 'seller/help' },
];

/** A sample banner creative (750 × 400): a flat colour with a headline, as an SVG data URL (no files needed). */
const bannerArt = (bg: string, ink: string, eyebrow: string, title: string) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="640" viewBox="0 0 1200 640"><rect width="1200" height="640" fill="${bg}"/>` +
      `<circle cx="1040" cy="520" r="300" fill="${ink}" opacity="0.12"/><text x="80" y="250" font-family="Inter, Arial, sans-serif" font-size="44" font-weight="700" fill="${ink}" opacity="0.8">${eyebrow}</text>` +
      `<text x="80" y="350" font-family="Inter, Arial, sans-serif" font-size="88" font-weight="800" fill="${ink}">${title}</text></svg>`,
  );

/** Home banner carousel sample: two image creatives and one text-only creative (empty tokens: no ad events). */
export const AD_CAROUSEL_DEMO: AdImpression[] = [
  { impressionToken: '', campaignId: 'demo-1', creativeId: 'demo-1', placementKey: 'home_banner', label: 'Ad', advertiserName: 'Marketly', headline: 'Fall flash deals', buttonText: 'Shop the deals', destination: '#', dismissible: false, image: { id: 'demo-1', url: bannerArt('#1F6F5C', '#FFFFFF', 'FALL FLASH DEALS', 'Up to 40% off') } },
  { impressionToken: '', campaignId: 'demo-2', creativeId: 'demo-2', placementKey: 'home_banner', label: 'Sponsored', advertiserName: 'Northwind Audio', headline: 'Northwind Aurora headphones', buttonText: 'Shop now', destination: '#', dismissible: false, image: { id: 'demo-2', url: bannerArt('#F3E3D3', '#5A2E12', 'NORTHWIND AUDIO', 'Hear every detail') } },
  { impressionToken: '', campaignId: 'demo-3', creativeId: 'demo-3', placementKey: 'home_banner', label: 'Sponsored', advertiserName: 'Casa Verde Home', eyebrow: 'Kitchen week', headline: 'Cookware for every kitchen', body: 'A text-only creative shows as the sponsored brand block.', buttonText: 'See the range', destination: '#', dismissible: false },
];
