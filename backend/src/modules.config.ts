/**
 * Which modules run. Add or remove a line to enable or disable a module (architecture §3).
 * The server refuses to start if an enabled module needs one that is off, and names it.
 * Override per process with MODULES=a,b,c.
 *
 * Launch phases follow plan ch. 20: phase 1–2 modules are on at launch; phase 3–4 modules are
 * built from the same design and stay off until their phase.
 */
export const enabledModules: string[] = [
  // Platform
  'access',
  'audit',
  'backups',
  'identity',
  'media',
  'notifications',
  'reports',
  'settings',
  'workqueues',
  // Participants
  'customers',
  'sellers',
  // Catalog and stock
  'catalog',
  'inventory',
  'offers',
  'purchasing',
  'search',
  'warehouse',
  // Buying
  'cart',
  'checkout',
  'orders',
  'payments',
  'shipping',
  // After-sales and money
  'finance',
  'messaging',
  'returns',
  'reviews',
  'support',
  'trust',
  // Growth
  'advertising',
  'content',
  'departments',
  'promotions',
  'services',

  // Later phases (off at launch)
  // 'wallet',              // phase 3: store credit and gift cards
  // 'wishlist',            // phase 3: saved items and alerts
  // 'fulfillment-service', // phase 4: storage and shipping for sellers (Fulfilled by Marketly). Before enabling it, set
  //                        // fulfillment-service.serviceLocationId and serviceShippingProfileId, or rely on the defaults:
  //                        // inventory's default company location and shipping's Official Store default profile (without
  //                        // either, getServiceTerms answers service_unavailable and no offer sells as Fulfilled by Marketly)
];
