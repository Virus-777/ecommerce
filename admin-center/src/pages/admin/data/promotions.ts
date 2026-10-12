// Sample data for admin/promotions (design: pages/admin/admin-promotions.html). Shaped like the promotions API.

export type PromoFunding = 'Platform' | 'Seller' | 'Shared';

export interface Promotion {
  id: string;
  name: string;
  scope: string;
  type: string;
  period: string;
  funding: PromoFunding;
  /** Platform share in percent for shared funding (50 = 50/50). */
  split?: number;
  used: number;
  budget: number;
  redemptions: number;
  status: 'Live' | 'Paused' | 'Scheduled' | 'In review' | 'Finished' | 'Draft';
  /** Design view of the campaign editor this row opens in. */
  editorView?: 'finance-confirmation';
}

export const PROMOTIONS: Promotion[] = [
  { id: 'pr-1', name: 'Home Week markdowns', scope: 'Bedding, lighting, cookware', type: 'Markdown', period: 'Oct 6 – Oct 19', funding: 'Shared', split: 50, used: 3920, budget: 8000, redemptions: 612, status: 'Live' },
  { id: 'pr-2', name: 'WELCOME20', scope: '$20 off first order of $100+', type: 'Fixed coupon', period: 'Aug 1 – Dec 31', funding: 'Platform', used: 7440, budget: 15000, redemptions: 372, status: 'Live' },
  { id: 'pr-3', name: 'AUDIO15', scope: '15% off Halden audio · Northwind Audio', type: '% coupon', period: 'Oct 1 – Oct 31', funding: 'Seller', used: 1105, budget: 2500, redemptions: 98, status: 'Live' },
  { id: 'pr-4', name: 'Kestrel SSD flash sale', scope: '400 units · limit 2 per customer', type: 'Flash sale', period: 'Oct 9, 9 AM – 9 PM', funding: 'Shared', split: 70, used: 0, budget: 4000, redemptions: 0, status: 'Scheduled' },
  { id: 'pr-5', name: 'Spend $75, save $10', scope: 'Whole store except Official clearance', type: 'Min-spend', period: 'Oct 10 – Oct 12', funding: 'Platform', used: 0, budget: 5000, redemptions: 0, status: 'Scheduled' },
  { id: 'pr-6', name: 'Free shipping weekend', scope: 'Seller-shipped orders over $25', type: 'Free shipping', period: 'Oct 16 – Oct 18', funding: 'Platform', used: 0, budget: 3000, redemptions: 0, status: 'Scheduled' },
  { id: 'pr-7', name: 'Fall Home Sale', scope: '20% off bedding and lighting', type: '% coupon', period: 'Oct 16 – Oct 25', funding: 'Shared', split: 50, used: 0, budget: 12000, redemptions: 0, status: 'In review', editorView: 'finance-confirmation' },
  { id: 'pr-8', name: 'Back to campus', scope: '10% off computers and storage', type: '% coupon', period: 'Aug 15 – Sep 15', funding: 'Platform', used: 9310, budget: 10000, redemptions: 1104, status: 'Finished' },
];

export const PROMO_TYPES = ['Markdown', '% coupon', 'Fixed coupon', 'Min-spend', 'Free shipping', 'Flash sale'];

export interface PromoResult {
  name: string;
  sales: number;
  cost: number;
  margin: string;
  sellers: string;
}

export const PROMO_RESULTS: PromoResult[] = [
  { name: 'Home Week markdowns', sales: 48210, cost: 3920, margin: '−3.1 pts', sellers: '6 joined' },
  { name: 'WELCOME20', sales: 37480, cost: 7440, margin: '−1.8 pts', sellers: 'Not affected' },
  { name: 'AUDIO15', sales: 10550, cost: 1105, margin: 'Seller funded', sellers: '1 seller' },
  { name: 'Back to campus (ended)', sales: 92640, cost: 9310, margin: '−2.2 pts', sellers: '4 joined' },
];

export const DAILY_DISCOUNT_COST = {
  labels: ['Oct 1', 'Oct 2', 'Oct 3', 'Oct 4', 'Oct 5', 'Oct 6', 'Oct 7', 'Oct 8'],
  data: [920, 1040, 1310, 1620, 1580, 1890, 1960, 1550],
};
