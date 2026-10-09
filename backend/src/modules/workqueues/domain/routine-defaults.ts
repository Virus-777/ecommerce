/**
 * The daily operating routine installed with the module (plan ch. 18 Operations Center): one check per
 * area for its manager, plus the managers' shared check-in. Admins replace it with PUT /routine-templates.
 * Weekdays are ISO (1 = Monday … 7 = Sunday); due times are market time.
 */
export interface DefaultTemplate {
  title: string;
  areaLabel: string;
  ownerRoles: string[];
  dueTime: string;
  weekdays: number[];
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  { title: 'Review dispatch and delivery', areaLabel: 'Order & Shipping', ownerRoles: ['shipping_manager'], dueTime: '10:00', weekdays: EVERY_DAY },
  { title: 'Check low stock and receiving', areaLabel: 'Inventory & Warehouse', ownerRoles: ['inventory_manager'], dueTime: '10:30', weekdays: WEEKDAYS },
  { title: 'Review returns waiting a decision', areaLabel: 'Returns', ownerRoles: ['returns_manager'], dueTime: '11:00', weekdays: WEEKDAYS },
  { title: 'Run the daily finance checks', areaLabel: 'Finance', ownerRoles: ['finance_manager'], dueTime: '11:00', weekdays: WEEKDAYS },
  { title: 'Clear support cases past target', areaLabel: 'Customer Support', ownerRoles: ['customer_support_manager'], dueTime: '12:00', weekdays: EVERY_DAY },
  { title: 'Review seller applications and appeals', areaLabel: 'Sellers', ownerRoles: ['seller_manager'], dueTime: '14:00', weekdays: WEEKDAYS },
  { title: 'Managers check in', areaLabel: 'Operations', ownerRoles: ['order_manager', 'shipping_manager', 'inventory_manager', 'finance_manager'], dueTime: '09:30', weekdays: WEEKDAYS },
];
