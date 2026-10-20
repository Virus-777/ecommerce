// Screen catalogue: every screen in the design (design/marketly-ui-final-complete.zip), its route and its views.
// Generated once from the design export's index; edit by hand when screens are added.
// A design file `<file>--<view>.html` is the route `<path>?view=<view>` (see useView in lib/hooks.ts).

export type Area = 'theme' | 'store' | 'seller' | 'admin' | 'ops';
/** The React app that serves a screen: frontend (store), seller-center (seller) or admin-center (admin, incl. Operations). */
export type App = 'store' | 'seller' | 'admin';
/** noDesign: a view added after the design (built in React), so /design/check has no file to compare with. */
export interface ScreenView { slug: string; name: string; noDesign?: boolean }
export interface Screen {
  id: string;
  app: App;
  area: Area;
  group: string;
  title: string;
  /** Route pattern (react-router), relative to its app's base URL. */
  path: string;
  /** Example values for the path params, used by href() and the design index. */
  sample?: Record<string, string>;
  /** Design export file name (pages/<area>/<file>.html), for side-by-side review. Empty for screens added after the design (designed in React). */
  file: string;
  /** Views (design states). The first is the default ('' slug). Empty when the screen has one view. */
  views: readonly ScreenView[];
}

export const AREAS: Array<{ id: Area; name: string }> = [
  { id: 'theme', name: 'Theme' },
  { id: 'store', name: 'Customer Store' },
  { id: 'seller', name: 'Seller Center' },
  { id: 'admin', name: 'Admin Center' },
  { id: 'ops', name: 'Operations' },
];

export const SCREENS = [
  { id: 'theme/foundations', app: 'store', area: 'theme', group: "Design system", title: "Foundations", path: '/design/foundations', file: 'theme-foundations', views: [] },
  { id: 'theme/components', app: 'store', area: 'theme', group: "Design system", title: "Components", path: '/design/components', file: 'theme-components', views: [] },
  { id: 'theme/patterns', app: 'store', area: 'theme', group: "Design system", title: "Patterns and layouts", path: '/design/patterns', file: 'theme-patterns', views: [] },
  { id: 'store/home', app: 'store', area: 'store', group: "Shopping", title: "Home", path: '/', file: 'store-home', views: [] },
  { id: 'store/categories', app: 'store', area: 'store', group: "Shopping", title: "All categories", path: '/categories', file: 'store-categories', views: [] },
  { id: 'store/category', app: 'store', area: 'store', group: "Shopping", title: "Category page", path: '/c/:slug', sample: { slug: 'headphones' }, file: 'store-category', views: [{ slug: '', name: "Default" }, { slug: 'filters-phone-sheet', name: "Filters (phone sheet)" }] },
  { id: 'store/search', app: 'store', area: 'store', group: "Shopping", title: "Search results", path: '/search', file: 'store-search', views: [{ slug: '', name: "Results" }, { slug: 'suggestions-open', name: "Suggestions open" }] },
  { id: 'store/search-empty', app: 'store', area: 'store', group: "Shopping", title: "No results and unavailable", path: '/search/empty', file: 'store-search-empty', views: [{ slug: '', name: "No results" }, { slug: 'product-unavailable', name: "Product unavailable" }] },
  { id: 'store/product', app: 'store', area: 'store', group: "Shopping", title: "Product detail", path: '/p/:slug/:id', sample: { slug: 'halden-aurora-anc', id: '01a134ed-7f21-734a-b19b-40b3883d69d3' }, file: 'store-product', views: [{ slug: '', name: "Official Store offer" }, { slug: 'seller-offer-selected', name: "Seller offer selected" }, { slug: 'no-reviews-yet', name: "No reviews yet" }] },
  { id: 'store/offers', app: 'store', area: 'store', group: "Shopping", title: "All offers", path: '/p/:slug/:id/offers', sample: { slug: 'halden-aurora-anc', id: '01a134ed-7f21-734a-b19b-40b3883d69d3' }, file: 'store-offers', views: [{ slug: '', name: "Total cost" }, { slug: 'fastest-delivery', name: "Fastest delivery" }] },
  { id: 'store/reviews', app: 'store', area: 'store', group: "Shopping", title: "Product reviews", path: '/p/:slug/:id/reviews', sample: { slug: 'halden-aurora-anc', id: '01a134ed-7f21-734a-b19b-40b3883d69d3' }, file: '', views: [{ slug: '', name: "All reviews" }, { slug: 'photos', name: "Review photos" }, { slug: 'report-review', name: "Report a review" }] },
  { id: 'store/questions', app: 'store', area: 'store', group: "Shopping", title: "Questions and answers", path: '/p/:slug/:id/questions', sample: { slug: 'halden-aurora-anc', id: '01a134ed-7f21-734a-b19b-40b3883d69d3' }, file: '', views: [{ slug: '', name: "All questions" }, { slug: 'ask', name: "Ask a question" }, { slug: 'no-match', name: "No matching questions" }] },
  { id: 'store/brand', app: 'store', area: 'store', group: "Shopping", title: "Brand page", path: '/brand/:slug', sample: { slug: 'halden' }, file: 'store-brand', views: [] },
  { id: 'store/brands', app: 'store', area: 'store', group: "Shopping", title: "All brands", path: '/brands', file: '', views: [] },
  { id: 'store/seller', app: 'store', area: 'store', group: "Shopping", title: "Seller storefront", path: '/shop/:slug', sample: { slug: 'northwind-audio' }, file: 'store-seller', views: [] },
  { id: 'store/official', app: 'store', area: 'store', group: "Shopping", title: "Official Store", path: '/official', file: 'store-official', views: [] },
  { id: 'store/deals', app: 'store', area: 'store', group: "Shopping", title: "Deals", path: '/deals', file: 'store-deals', views: [] },
  { id: 'store/collection', app: 'store', area: 'store', group: "Shopping", title: "Campaign and collection", path: '/collection/:slug', sample: { slug: 'new-arrivals' }, file: 'store-collection', views: [{ slug: '', name: "New arrivals" }, { slug: 'best-sellers', name: "Best sellers" }, { slug: 'seasonal', name: "Seasonal" }, { slug: 'curated-collection', name: "Curated collection" }] },
  { id: 'store/not-found', app: 'store', area: 'store', group: "Shopping", title: "Page not found and error", path: '/404', file: 'store-not-found', views: [{ slug: '', name: "404" }, { slug: 'something-went-wrong', name: "Something went wrong" }] },
  { id: 'store/cart', app: 'store', area: 'store', group: "Purchase", title: "Cart", path: '/cart', file: 'store-cart', views: [{ slug: '', name: "Default" }, { slug: 'empty', name: "Empty" }] },
  { id: 'store/checkout', app: 'store', area: 'store', group: "Purchase", title: "Checkout", path: '/checkout', file: 'store-checkout', views: [{ slug: '', name: "Signed in" }, { slug: 'guest-checkout', name: "Guest checkout" }, { slug: 'coupon-rejected', name: "Coupon rejected" }] },
  { id: 'store/checkout-review-changes', app: 'store', area: 'store', group: "Purchase", title: "Checkout: review changes", path: '/checkout/review-changes', file: 'store-checkout-review-changes', views: [] },
  { id: 'store/payment-result', app: 'store', area: 'store', group: "Purchase", title: "Payment result", path: '/checkout/payment', file: 'store-payment-result', views: [{ slug: '', name: "Payment failed" }, { slug: 'checking-payment', name: "Checking payment" }] },
  { id: 'store/confirmation', app: 'store', area: 'store', group: "Purchase", title: "Order confirmation", path: '/checkout/confirmation', file: 'store-confirmation', views: [] },
  { id: 'auth/sign-in', app: 'store', area: 'store', group: "Sign in", title: "Sign in", path: '/sign-in', file: 'auth-sign-in', views: [{ slug: '', name: "Sign in" }, { slug: 'wrong-password', name: "Wrong password" }, { slug: 'two-step-code', name: "Two-step code" }] },
  { id: 'auth/register', app: 'store', area: 'store', group: "Sign in", title: "Create account", path: '/register', file: 'auth-register', views: [{ slug: '', name: "Create account" }, { slug: 'verify-email', name: "Verify email" }] },
  { id: 'auth/recover', app: 'store', area: 'store', group: "Sign in", title: "Reset password", path: '/recover', file: 'auth-recover', views: [{ slug: '', name: "Request link" }, { slug: 'check-your-email', name: "Check your email" }, { slug: 'set-new-password', name: "Set new password" }] },
  { id: 'auth/guest-orders', app: 'store', area: 'store', group: "Sign in", title: "Guest order lookup", path: '/guest-orders', file: 'auth-guest-orders', views: [{ slug: '', name: "Look up" }, { slug: 'found', name: "Found" }] },
  { id: 'account/overview', app: 'store', area: 'store', group: "My account", title: "Account overview", path: '/account', file: 'account-overview', views: [] },
  { id: 'account/orders', app: 'store', area: 'store', group: "My account", title: "Orders", path: '/account/orders', file: 'account-orders', views: [{ slug: '', name: "Orders" }, { slug: 'no-matches', name: "No matches" }] },
  { id: 'account/order', app: 'store', area: 'store', group: "My account", title: "Order details", path: '/account/orders/:ref', sample: { ref: 'MK-260914-48213' }, file: 'account-order', views: [] },
  { id: 'account/tracking', app: 'store', area: 'store', group: "My account", title: "Track package", path: '/account/orders/:ref/tracking', sample: { ref: 'MK-260914-48213' }, file: 'account-tracking', views: [{ slug: '', name: "In transit" }, { slug: 'delivery-failed', name: "Delivery failed" }] },
  { id: 'account/cancel', app: 'store', area: 'store', group: "My account", title: "Cancel items", path: '/account/orders/:ref/cancel', sample: { ref: 'MK-260914-48213' }, file: 'account-cancel', views: [{ slug: '', name: "Select items" }, { slug: 'cancellation-requested', name: "Cancellation requested" }] },
  { id: 'account/returns', app: 'store', area: 'store', group: "My account", title: "Returns and refunds", path: '/account/returns', file: 'account-returns', views: [] },
  { id: 'account/return-new', app: 'store', area: 'store', group: "My account", title: "Request a return", path: '/account/orders/:ref/return', sample: { ref: 'MK-260914-48213' }, file: 'account-return-new', views: [{ slug: '', name: "Choose items" }, { slug: 'reason-and-remedy', name: "Reason and remedy" }, { slug: 'review', name: "Review" }] },
  { id: 'account/return', app: 'store', area: 'store', group: "My account", title: "Return details", path: '/account/returns/:ref', sample: { ref: 'RT-260921-0457' }, file: 'account-return', views: [{ slug: '', name: "Approved: send it back" }, { slug: 'refund-sent', name: "Refund sent" }, { slug: 'replacement-on-the-way', name: "Replacement on the way" }] },
  { id: 'account/messages', app: 'store', area: 'store', group: "My account", title: "Messages", path: '/account/messages', file: 'account-messages', views: [] },
  { id: 'account/notifications', app: 'store', area: 'store', group: "My account", title: "Notifications", path: '/account/notifications', file: 'account-notifications', views: [] },
  { id: 'account/addresses', app: 'store', area: 'store', group: "My account", title: "Addresses", path: '/account/addresses', file: 'account-addresses', views: [{ slug: '', name: "Addresses" }, { slug: 'edit-address', name: "Edit address" }] },
  { id: 'account/profile', app: 'store', area: 'store', group: "My account", title: "Profile", path: '/account/profile', file: 'account-profile', views: [] },
  { id: 'account/security', app: 'store', area: 'store', group: "My account", title: "Sign-in and security", path: '/account/security', file: 'account-security', views: [] },
  { id: 'account/payment-methods', app: 'store', area: 'store', group: "My account", title: "Payment methods", path: '/account/payment-methods', file: 'account-payment-methods', views: [] },
  { id: 'account/review', app: 'store', area: 'store', group: "My account", title: "Write a review", path: '/account/reviews/new', file: 'account-review', views: [] },
  { id: 'account/reviews', app: 'store', area: 'store', group: "My account", title: "Reviews and feedback", path: '/account/reviews', file: 'account-reviews', views: [{ slug: '', name: "Product reviews" }, { slug: 'seller-feedback', name: "Seller feedback" }, { slug: 'reports-you-made', name: "Reports you made" }] },
  { id: 'account/wishlist', app: 'store', area: 'store', group: "My account", title: "Wishlist and alerts", path: '/account/wishlist', file: 'account-wishlist', views: [] },
  { id: 'account/coupons', app: 'store', area: 'store', group: "My account", title: "Coupons and credit", path: '/account/coupons', file: 'account-coupons', views: [] },
  { id: 'account/reports', app: 'store', area: 'store', group: "My account", title: "Reports and appeals", path: '/account/reports', file: '', views: [{ slug: '', name: "Reports" }, { slug: 'requests', name: "Requests for information" }, { slug: 'actions', name: "Actions and appeals" }] },
  { id: 'help/center', app: 'store', area: 'store', group: "Help and policies", title: "Help Center", path: '/help', file: 'help-center', views: [] },
  { id: 'help/article', app: 'store', area: 'store', group: "Help and policies", title: "Help article", path: '/help/articles/:slug', sample: { slug: 'track-a-package' }, file: 'help-article', views: [] },
  { id: 'help/contact', app: 'store', area: 'store', group: "Help and policies", title: "Contact support", path: '/help/contact', file: 'help-contact', views: [] },
  { id: 'help/order-problem', app: 'store', area: 'store', group: "Help and policies", title: "Report an order problem", path: '/help/order-problem', file: 'help-order-problem', views: [] },
  { id: 'help/cases', app: 'store', area: 'store', group: "Help and policies", title: "Support cases", path: '/help/cases', file: 'help-cases', views: [] },
  { id: 'help/case', app: 'store', area: 'store', group: "Help and policies", title: "Support case", path: '/help/cases/:ref', sample: { ref: 'CS-261007-0412' }, file: 'help-case', views: [{ slug: '', name: "Open" }, { slug: 'decision-made', name: "Decision made" }] },
  { id: 'info/policy', app: 'store', area: 'store', group: "Help and policies", title: "Policies", path: '/policies', file: 'info-policy', views: [{ slug: '', name: "Returns" }, { slug: 'shipping', name: "Shipping" }, { slug: 'seller-rules', name: "Seller rules" }, { slug: 'privacy', name: "Privacy" }, { slug: 'purchase-terms', name: "Purchase terms" }] },
  { id: 'store/news', app: 'store', area: 'store', group: "Help and policies", title: "News", path: '/news', file: '', views: [] },
  { id: 'store/news-post', app: 'store', area: 'store', group: "Help and policies", title: "News post", path: '/news/:slug', sample: { slug: 'holiday-shipping-cut-offs' }, file: '', views: [] },
  { id: 'info/about', app: 'store', area: 'store', group: "Help and policies", title: "About us", path: '/about', file: 'info-about', views: [] },
  { id: 'info/unsubscribe', app: 'store', area: 'store', group: "Help and policies", title: "Email preferences", path: '/unsubscribe', file: '', views: [] },
  { id: 'sell/landing', app: 'store', area: 'store', group: "Seller entry", title: "Sell on Marketly", path: '/sell', file: 'sell-landing', views: [] },
  { id: 'sell/apply', app: 'store', area: 'store', group: "Seller entry", title: "Seller application", path: '/sell/apply', file: 'sell-apply', views: [{ slug: '', name: "Seller account" }, { slug: 'business-details', name: "Business details" }, { slug: 'verification', name: "Verification" }, { slug: 'payout-and-return-address', name: "Payout and return address" }, { slug: 'agreement', name: "Agreement" }] },
  { id: 'sell/status', app: 'store', area: 'store', group: "Seller entry", title: "Application status", path: '/sell/status', file: 'sell-status', views: [{ slug: '', name: "Information required" }, { slug: 'approved', name: "Approved" }, { slug: 'rejected', name: "Rejected" }] },
  { id: 'ads/opening', app: 'store', area: 'store', group: "Advertising", title: "Opening full-screen ad", path: '/ads/opening', file: 'ads-opening', views: [{ slug: '', name: "Platform campaign" }, { slug: 'sponsored-brand', name: "Sponsored brand" }] },
  { id: 'ads/popup', app: 'store', area: 'store', group: "Advertising", title: "Promotional pop-up", path: '/ads/popup', file: 'ads-popup', views: [{ slug: '', name: "Coupon" }, { slug: 'announcement', name: "Announcement" }] },
  { id: 'ads/formats', app: 'store', area: 'store', group: "Advertising", title: "Ad placements", path: '/ads/formats', file: 'ads-formats', views: [{ slug: '', name: "All placements" }, { slug: 'sticky-ad', name: "Sticky ad" }, { slug: 'interstitial', name: "Interstitial" }] },
  { id: 'seller/setup', app: 'seller', area: 'seller', group: "Getting started", title: "Setup guide", path: '/setup', file: 'seller-setup', views: [] },
  { id: 'seller/dashboard', app: 'seller', area: 'seller', group: "Seller Center", title: "Seller dashboard", path: '/', file: 'seller-dashboard', views: [] },
  { id: 'seller/products', app: 'seller', area: 'seller', group: "Seller Center", title: "Products and offers", path: '/products', file: 'seller-products', views: [{ slug: '', name: "All products" }, { slug: 'rows-selected', name: "Rows selected" }, { slug: 'add-product', name: "Add product" }] },
  { id: 'seller/catalog-match', app: 'seller', area: 'seller', group: "Seller Center", title: "Find the product in the catalog", path: '/products/match', file: 'seller-catalog-match', views: [{ slug: '', name: "Results" }, { slug: 'no-match', name: "No match" }] },
  { id: 'seller/product-new', app: 'seller', area: 'seller', group: "Seller Center", title: "New product submission", path: '/products/new', file: 'seller-product-new', views: [{ slug: '', name: "Draft" }, { slug: 'changes-requested', name: "Changes requested" }] },
  { id: 'seller/offer', app: 'seller', area: 'seller', group: "Seller Center", title: "Create offer", path: '/offers/new', file: 'seller-offer', views: [{ slug: '', name: "New condition" }, { slug: 'used-condition', name: "Used condition" }] },
  { id: 'seller/inventory', app: 'seller', area: 'seller', group: "Seller Center", title: "Inventory", path: '/inventory', file: 'seller-inventory', views: [{ slug: '', name: "Stock list" }, { slug: 'adjust-stock', name: "Adjust stock" }] },
  { id: 'seller/bulk-update', app: 'seller', area: 'seller', group: "Seller Center", title: "Bulk price and stock update", path: '/inventory/bulk-update', file: 'seller-bulk-update', views: [{ slug: '', name: "Preview" }, { slug: 'applied', name: "Applied" }] },
  { id: 'seller/orders', app: 'seller', area: 'seller', group: "Seller Center", title: "Orders", path: '/orders', file: 'seller-orders', views: [{ slug: '', name: "New" }, { slug: 'preparing', name: "Preparing" }, { slug: 'shipped', name: "Shipped" }, { slug: 'completed', name: "Completed" }, { slug: 'cancellation-requests', name: "Cancellation requests" }] },
  { id: 'seller/order', app: 'seller', area: 'seller', group: "Seller Center", title: "Order detail", path: '/orders/:ref', sample: { ref: 'MK-261008-12077' }, file: 'seller-order', views: [{ slug: '', name: "To ship" }, { slug: 'shipped', name: "Shipped" }] },
  { id: 'seller/shipping', app: 'seller', area: 'seller', group: "Seller Center", title: "Shipping settings", path: '/shipping', file: 'seller-shipping', views: [] },
  { id: 'seller/returns', app: 'seller', area: 'seller', group: "Seller Center", title: "Returns and cases", path: '/returns', file: 'seller-returns', views: [{ slug: '', name: "Return requests" }, { slug: 'received-to-inspect', name: "Received, to inspect" }, { slug: 'disputes', name: "Disputes" }, { slug: 'closed', name: "Closed" }] },
  { id: 'seller/return', app: 'seller', area: 'seller', group: "Seller Center", title: "Return case", path: '/returns/:ref', sample: { ref: 'RT-261005-0212' }, file: 'seller-return', views: [{ slug: '', name: "Respond" }, { slug: 'inspect-and-refund', name: "Inspect and refund" }] },
  { id: 'seller/finance', app: 'seller', area: 'seller', group: "Seller Center", title: "Finance", path: '/finance', file: 'seller-finance', views: [] },
  { id: 'seller/statement', app: 'seller', area: 'seller', group: "Seller Center", title: "Payout statement", path: '/finance/statements/:ref', sample: { ref: 'PO-261001' }, file: 'seller-statement', views: [] },
  { id: 'seller/marketing', app: 'seller', area: 'seller', group: "Seller Center", title: "Marketing and ads", path: '/marketing', file: 'seller-marketing', views: [{ slug: '', name: "Discounts" }, { slug: 'platform-campaigns', name: "Platform campaigns" }, { slug: 'sponsored-ads', name: "Sponsored ads" }] },
  { id: 'seller/ad-request', app: 'seller', area: 'seller', group: "Seller Center", title: "Request a sponsored campaign", path: '/marketing/ad-request', file: 'seller-ad-request', views: [{ slug: '', name: "Set up" }, { slug: 'in-review', name: "In review" }] },
  { id: 'seller/customers', app: 'seller', area: 'seller', group: "Seller Center", title: "Customers", path: '/customers', file: 'seller-customers', views: [{ slug: '', name: "Order messages" }, { slug: 'product-questions', name: "Product questions" }, { slug: 'feedback', name: "Feedback" }] },
  { id: 'seller/reports', app: 'seller', area: 'seller', group: "Seller Center", title: "Seller reports", path: '/reports', file: 'seller-reports', views: [] },
  { id: 'seller/performance', app: 'seller', area: 'seller', group: "Seller Center", title: "Account health", path: '/performance', file: 'seller-performance', views: [] },
  { id: 'seller/store', app: 'seller', area: 'seller', group: "Seller Center", title: "Store profile", path: '/store', file: 'seller-store', views: [] },
  { id: 'seller/staff', app: 'seller', area: 'seller', group: "Seller Center", title: "Staff and permissions", path: '/staff', file: 'seller-staff', views: [{ slug: '', name: "Staff" }, { slug: 'invite-staff', name: "Invite staff" }] },
  { id: 'seller/notifications', app: 'seller', area: 'seller', group: "Seller Center", title: "Notifications", path: '/notifications', file: 'seller-notifications', views: [] },
  { id: 'seller/help', app: 'seller', area: 'seller', group: "Seller Center", title: "Help and support", path: '/help', file: 'seller-help', views: [{ slug: '', name: "Help" }, { slug: 'contact-seller-support', name: "Contact seller support" }] },
  { id: 'seller/help-article', app: 'seller', area: 'seller', group: "Seller Center", title: "Seller help article", path: '/help/articles/:slug', sample: { slug: 'what-a-restriction-affects' }, file: '', views: [{ slug: '', name: "Article" }, { slug: 'not-helpful', name: "Not helpful feedback" }] },
  { id: 'admin/dashboard', app: 'admin', area: 'admin', group: "Overview", title: "Admin dashboard", path: '/', file: 'admin-dashboard', views: [] },
  { id: 'admin/inbox', app: 'admin', area: 'admin', group: "Overview", title: "Notifications", path: '/inbox', file: 'admin-inbox', views: [{ slug: '', name: "All" }, { slug: 'needs-my-action', name: "Needs my action" }] },
  { id: 'admin/orders', app: 'admin', area: 'admin', group: "Commerce", title: "All orders", path: '/orders', file: 'admin-orders', views: [{ slug: '', name: "All orders" }, { slug: 'overdue-dispatch', name: "Overdue dispatch" }] },
  { id: 'admin/order', app: 'admin', area: 'admin', group: "Commerce", title: "Order detail (admin)", path: '/orders/:ref', sample: { ref: 'MK-260914-48213' }, file: 'admin-order', views: [{ slug: '', name: "Overview" }, { slug: 'issue-refund', name: "Issue refund" }] },
  { id: 'admin/returns', app: 'admin', area: 'admin', group: "Commerce", title: "Returns and refunds queue", path: '/returns', file: 'admin-returns', views: [{ slug: '', name: "Queue" }, { slug: 'exception-review', name: "Exception review" }] },
  { id: 'admin/catalog', app: 'admin', area: 'admin', group: "Catalog", title: "Catalog products", path: '/catalog', file: 'admin-catalog', views: [{ slug: '', name: "Products" }, { slug: 'bulk-selection', name: "Bulk selection" }] },
  { id: 'admin/product-review', app: 'admin', area: 'admin', group: "Catalog", title: "Product review queue", path: '/catalog/review', file: 'admin-product-review', views: [{ slug: '', name: "Submission" }, { slug: 'merge-duplicate', name: "Merge duplicate" }] },
  { id: 'admin/categories', app: 'admin', area: 'admin', group: "Catalog", title: "Categories and brands", path: '/categories', file: 'admin-categories', views: [{ slug: '', name: "Categories" }, { slug: 'brands', name: "Brands" }] },
  { id: 'admin/reviews', app: 'admin', area: 'admin', group: "Catalog", title: "Reviews and Q&A moderation", path: '/reviews', file: 'admin-reviews', views: [{ slug: '', name: "Reported content" }, { slug: 'q-a-and-seller-responses', name: "Q&A and seller responses" }] },
  { id: 'admin/official', app: 'admin', area: 'admin', group: "Official store", title: "Official Store offers and trading", path: '/official', file: 'admin-official', views: [{ slug: '', name: "Trading" }, { slug: 'price-change', name: "Price change" }] },
  { id: 'admin/purchasing', app: 'admin', area: 'admin', group: "Official store", title: "Suppliers and purchasing", path: '/purchasing', file: 'admin-purchasing', views: [{ slug: '', name: "Purchase orders" }, { slug: 'purchase-order', name: "Purchase order" }] },
  { id: 'admin/sellers', app: 'admin', area: 'admin', group: "Sellers", title: "Sellers", path: '/sellers', file: 'admin-sellers', views: [] },
  { id: 'admin/seller-application', app: 'admin', area: 'admin', group: "Sellers", title: "Seller application review", path: '/sellers/applications/:ref', sample: { ref: 'APP-2610-0031' }, file: 'admin-seller-application', views: [{ slug: '', name: "Review" }, { slug: 'request-information', name: "Request information" }, { slug: 'reject', name: "Reject" }] },
  { id: 'admin/seller', app: 'admin', area: 'admin', group: "Sellers", title: "Seller detail", path: '/sellers/:slug', sample: { slug: 'northwind-audio' }, file: 'admin-seller', views: [{ slug: '', name: "Profile" }, { slug: 'suspend-seller', name: "Suspend seller" }] },
  { id: 'admin/shipping', app: 'admin', area: 'admin', group: "Shipping", title: "Shipping settings", path: '/shipping', file: 'admin-shipping', views: [{ slug: '', name: "Settings" }, { slug: 'add-service-notice', name: "Add service notice" }] },
  { id: 'admin/finance', app: 'admin', area: 'admin', group: "Finance", title: "Payments and fees", path: '/finance', file: 'admin-finance', views: [{ slug: '', name: "Unexplained amounts" }, { slug: 'disputes-and-chargebacks', name: "Disputes and chargebacks" }, { slug: 'refunds-failing', name: "Refunds failing" }, { slug: 'refunds-to-approve', name: "Refunds to approve", noDesign: true }] },
  { id: 'admin/payouts', app: 'admin', area: 'admin', group: "Finance", title: "Payout run", path: '/payouts', file: 'admin-payouts', views: [{ slug: '', name: "Run review" }, { slug: 'approve-run', name: "Approve run" }] },
  { id: 'admin/customers', app: 'admin', area: 'admin', group: "Customers and service", title: "Customers", path: '/customers', file: 'admin-customers', views: [{ slug: '', name: "List" }, { slug: 'customer-detail', name: "Customer detail" }] },
  { id: 'admin/cases', app: 'admin', area: 'admin', group: "Customers and service", title: "Cases and disputes", path: '/cases', file: 'admin-cases', views: [{ slug: '', name: "Queue" }, { slug: 'bulk-assign', name: "Bulk assign" }] },
  { id: 'admin/case', app: 'admin', area: 'admin', group: "Customers and service", title: "Dispute CS-104882", path: '/cases/:ref', sample: { ref: 'CS-104882' }, file: 'admin-case', views: [{ slug: '', name: "Investigating" }, { slug: 'decision-recorded', name: "Decision recorded" }] },
  { id: 'admin/trust', app: 'admin', area: 'admin', group: "Customers and service", title: "Trust and risk", path: '/trust', file: 'admin-trust', views: [] },
  { id: 'admin/trust-report', app: 'admin', area: 'admin', group: "Customers and service", title: "Trust report", path: '/trust/reports/:ref', sample: { ref: 'TR-3391' }, file: '', views: [{ slug: '', name: "Investigation" }, { slug: 'take-action', name: "Take action" }, { slug: 'decision-recorded', name: "Decision recorded" }] },
  { id: 'admin/promotions', app: 'admin', area: 'admin', group: "Marketing and content", title: "Promotions and coupons", path: '/promotions', file: 'admin-promotions', views: [] },
  { id: 'admin/promotion-new', app: 'admin', area: 'admin', group: "Marketing and content", title: "Create promotion campaign", path: '/promotions/new', file: 'admin-promotion-new', views: [{ slug: '', name: "Setup" }, { slug: 'finance-confirmation', name: "Finance confirmation" }] },
  { id: 'admin/content', app: 'admin', area: 'admin', group: "Marketing and content", title: "Homepage and pages", path: '/content', file: 'admin-content', views: [{ slug: '', name: "Sections" }, { slug: 'edit-section', name: "Edit section" }] },
  { id: 'admin/help-content', app: 'admin', area: 'admin', group: "Marketing and content", title: "Help articles and policies", path: '/help-content', file: 'admin-help-content', views: [{ slug: '', name: "Articles" }, { slug: 'edit-policy', name: "Edit policy" }] },
  { id: 'admin/news', app: 'admin', area: 'admin', group: "Marketing and content", title: "News", path: '/news', file: '', views: [{ slug: '', name: "Posts" }, { slug: 'edit', name: "Edit post" }] },
  { id: 'admin/ads', app: 'admin', area: 'admin', group: "Advertisements", title: "Advertisement Management", path: '/ads', file: 'admin-ads', views: [] },
  { id: 'admin/ad-campaign', app: 'admin', area: 'admin', group: "Advertisements", title: "Create ad campaign", path: '/ads/new', file: 'admin-ad-campaign', views: [{ slug: '', name: "Goal & advertiser" }, { slug: 'placement-audience', name: "Placement & audience" }, { slug: 'schedule-limits', name: "Schedule & limits" }, { slug: 'creative-preview', name: "Creative & preview" }, { slug: 'approval', name: "Approval" }] },
  { id: 'admin/ad-assets', app: 'admin', area: 'admin', group: "Advertisements", title: "Ad creative library", path: '/ads/assets', file: 'admin-ad-assets', views: [{ slug: '', name: "Library" }, { slug: 'review-creative', name: "Review creative" }] },
  { id: 'admin/ad-placements', app: 'admin', area: 'admin', group: "Advertisements", title: "Ad placements and rules", path: '/ads/placements', file: 'admin-ad-placements', views: [] },
  { id: 'admin/reports', app: 'admin', area: 'admin', group: "Reports and settings", title: "Reports", path: '/reports', file: 'admin-reports', views: [] },
  { id: 'admin/report', app: 'admin', area: 'admin', group: "Reports and settings", title: "Report detail", path: '/reports/:key', sample: { key: 'seller-sales-and-earned-fees' }, file: '', views: [{ slug: '', name: "Report" }, { slug: 'export', name: "Export" }, { slug: 'definitions', name: "Metric definitions" }] },
  { id: 'admin/staff', app: 'admin', area: 'admin', group: "Reports and settings", title: "Staff and roles", path: '/staff', file: 'admin-staff', views: [{ slug: '', name: "Roles and people" }, { slug: 'edit-role', name: "Edit role" }] },
  { id: 'admin/settings', app: 'admin', area: 'admin', group: "Reports and settings", title: "Settings", path: '/settings', file: 'admin-settings', views: [{ slug: '', name: "All settings" }, { slug: 'review-change', name: "Review change" }] },
  { id: 'admin/notifications', app: 'admin', area: 'admin', group: "Reports and settings", title: "Notifications", path: '/notifications', file: 'admin-notifications', views: [{ slug: '', name: "Matrix" }, { slug: 'edit-template', name: "Edit template" }] },
  { id: 'admin/audit', app: 'admin', area: 'admin', group: "Reports and settings", title: "Action history", path: '/audit', file: 'admin-audit', views: [] },
  { id: 'admin/backups', app: 'admin', area: 'admin', group: "Reports and settings", title: "Backups", path: '/backups', file: '', views: [] },
  { id: 'admin/audit-entry', app: 'admin', area: 'admin', group: "Reports and settings", title: "Action history entry", path: '/audit/:id', sample: { id: 'AE-261008-0932' }, file: '', views: [] },
  { id: 'ops/queues', app: 'admin', area: 'ops', group: "Work queues", title: "My work queues", path: '/ops', file: 'ops-queues', views: [] },
  { id: 'ops/inventory', app: 'admin', area: 'ops', group: "Work queues", title: "Official Store stock", path: '/ops/inventory', file: 'ops-inventory', views: [{ slug: '', name: "Stock" }, { slug: 'adjust-stock', name: "Adjust stock" }] },
  { id: 'ops/receiving', app: 'admin', area: 'ops', group: "Work queues", title: "Receiving", path: '/ops/receiving', file: 'ops-receiving', views: [{ slug: '', name: "Expected" }, { slug: 'receiving-pur-2610-0042', name: "Receiving PUR-2610-0042" }] },
  { id: 'ops/pick-pack', app: 'admin', area: 'ops', group: "Work queues", title: "Pick and pack", path: '/ops/pick-pack', file: 'ops-pick-pack', views: [{ slug: '', name: "Pick list" }, { slug: 'packing-station', name: "Packing station" }] },
  { id: 'ops/dispatch', app: 'admin', area: 'ops', group: "Work queues", title: "Dispatch and delivery exceptions", path: '/ops/dispatch', file: 'ops-dispatch', views: [{ slug: '', name: "Late dispatch" }, { slug: 'seller-cannot-fulfill', name: "Seller cannot fulfill" }, { slug: 'missing-tracking', name: "Missing tracking" }, { slug: 'lost-or-damaged', name: "Lost or damaged" }, { slug: 'delivery-failed', name: "Delivery failed" }] },
  { id: 'ops/return-inspection', app: 'admin', area: 'ops', group: "Work queues", title: "Return inspection", path: '/ops/return-inspection', file: 'ops-return-inspection', views: [{ slug: '', name: "Queue" }, { slug: 'inspecting-rt-261005-0212', name: "Inspecting RT-261005-0212" }, { slug: 'parcels', name: "Parcels at the dock", noDesign: true }] },
  { id: 'ops/finance-checks', app: 'admin', area: 'ops', group: "Work queues", title: "Daily finance checks", path: '/ops/finance-checks', file: 'ops-finance-checks', views: [] },
] as const satisfies readonly Screen[];

export type ScreenId = (typeof SCREENS)[number]['id'];

export const SCREEN_BY_ID = Object.fromEntries(SCREENS.map((s) => [s.id, s])) as unknown as Record<ScreenId, Screen>;
