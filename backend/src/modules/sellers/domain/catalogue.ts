/**
 * Static content of the sellers module: agreement defaults (used when content is off), the Sell with us
 * programme text, seller role templates and the seller permission catalogue, metric definitions.
 */
import type { AgreementDocument, FulfillmentModel, PermissionEntry, PerformanceTarget, SellerRoleTemplate } from '../../../spec/sellers.js';

export const AGREEMENT_KEYS = ['seller_agreement', 'product_rules', 'fee_schedule', 'service_standards'] as const;
export type AgreementKey = (typeof AGREEMENT_KEYS)[number];

const AGREEMENT_TEXT: Record<AgreementKey, { title: string; summary: string }> = {
  seller_agreement: { title: 'Seller agreement', summary: 'How selling on Marketly works: your obligations, ours, payouts, restrictions and appeals.' },
  product_rules: { title: 'Product rules', summary: 'What may be listed, restricted categories and the documents they need.' },
  fee_schedule: { title: 'Fee schedule', summary: 'Commission per category, charged on the item price after seller-funded discounts, excluding shipping.' },
  service_standards: { title: 'Service standards', summary: 'Dispatch, tracking, cancellation, returns and reply targets your account is measured against.' },
};

/** Versions in force when the content module is off (policyVersionId null). */
export const DEFAULT_AGREEMENT_VERSION = { versionLabel: 'v1.0', effectiveFrom: '2026-01-01' };

export function agreementDocument(
  key: AgreementKey,
  version: { versionLabel: string; policyVersionId?: string | null; effectiveFrom: string },
  baseUrl: string,
): AgreementDocument {
  return {
    key,
    title: AGREEMENT_TEXT[key].title,
    versionLabel: version.versionLabel,
    policyVersionId: version.policyVersionId ?? null,
    effectiveFrom: version.effectiveFrom,
    summary: AGREEMENT_TEXT[key].summary,
    // the published content policy, under the same key content uses (seller_agreement); nothing to link before one is published
    url: version.policyVersionId ? `${baseUrl.replace(/\/$/, '')}/policies/${key}` : null,
    isExample: key === 'fee_schedule',
  };
}

/* ------------------------------------------------------------------ Sell with us */

export const PROGRAM = {
  notAllowed: ['Digital goods', 'Subscriptions', 'Gift cards', 'Perishable food', 'Weapons', 'Recalled items'],
  requirements: [
    { title: 'A US business or sole proprietor', detail: 'Registered business details or your own details if you sell as an individual.' },
    { title: 'Identity of every owner with 25% or more', detail: 'A photo ID for each owner; ID documents are deleted after the review.' },
    { title: 'Tax id and W-9', detail: 'EIN or SSN; only the last 4 digits are ever shown.' },
    { title: 'A US bank account', detail: 'In the business or owner name. Payouts start after the account is verified.' },
    { title: 'A street return address', detail: 'PO boxes cannot receive returns.' },
  ],
  feeNotes: [
    'Commission is charged on the item price after seller-funded discounts, excluding shipping.',
    'No monthly fee during the controlled launch.',
    'Rates shown are examples until the fee schedule is confirmed.',
  ],
  fulfillmentModels: [
    { name: 'You ship', availability: 'launch', detail: 'You pack and ship each order within your dispatch time, with tracking.' },
    { name: 'Marketly fulfilment', availability: 'later', detail: 'Send stock to our warehouse and we ship for you (planned).' },
  ] as FulfillmentModel[],
  steps: ['Seller account', 'Business details', 'Verification', 'Payout account', 'Return address', 'Agreements'],
  verificationLabels: [
    {
      label: 'Verified seller',
      means: 'Marketly checked the business identity, its registration, the payout account and the return address.',
      doesNotMean: 'Product authenticity is not certified by the label.',
    },
  ],
  faq: [
    { q: 'How long does the review take?', a: 'We aim to decide within 5 business days of a complete application.' },
    { q: 'When do my products go live?', a: 'After approval, finish setup and pass the launch readiness review; approved products with stock then go live.' },
    { q: 'Can I appeal a decision?', a: 'Yes, within the appeal window shown with the decision. Someone other than the original reviewer decides.' },
  ],
  contact: { email: 'sellers@marketly.example', phone: '+1 800 555 0140', hours: 'Mon–Fri 9:00–17:00 PT' },
  estimatedMinutes: 25,
  exampleFees: [
    { categoryName: 'Electronics', ratePct: 8 },
    { categoryName: 'Home', ratePct: 12 },
    { categoryName: 'Fashion', ratePct: 15 },
    { categoryName: 'Beauty', ratePct: 12 },
    { categoryName: 'Sports', ratePct: 10 },
  ],
  payoutTiming: { holdDaysAfterDelivery: 7, schedule: 'Weekly', arrival: '1–3 business days after the payout is sent', isExample: true },
};

export const NOT_CHECKED = ['Product authenticity is not certified by the Verified label', 'Product quality and condition claims'];

/* ------------------------------------------------------------------ seller roles and permissions */

export const ROLE_TEMPLATES: Record<Exclude<SellerRoleTemplate['key'], 'owner' | 'custom'>, string[]> = {
  products_inventory: [
    'catalog.products.submit',
    'offers.offers.manage',
    'offers.prices.manage',
    // unit costs for profit figures (doc 09 §3.1): the roles that manage prices
    'offers.costs.manage',
    'offers.bulk.update',
    'offers.offers.export',
    'inventory.stock.adjust',
    'inventory.stock.export',
    'media.assets.upload',
    'promotions.discounts.manage',
    // Fulfilled by Marketly (phase 4): SKUs, inbound shipments, removals and service fees; given only while fulfillment-service runs
    'fulfillment-service.inbound.manage',
    'fulfillment-service.fees.view',
  ],
  shipping: [
    'orders.fulfillment.view',
    'orders.fulfillment.manage',
    'orders.fulfillment.export',
    'shipping.seller-shipments.view',
    'shipping.seller-shipments.manage',
    'shipping.seller-settings.view',
  ],
  customer_service: ['messaging.conversations.reply', 'support.cases.respond', 'returns.requests.respond', 'reviews.responses.post', 'orders.fulfillment.view'],
};

export const ROLE_TEXT: Record<SellerRoleTemplate['key'], { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'Everything, including staff, payout account, business changes and agreements.' },
  products_inventory: { label: 'Products and inventory', description: 'Submit products, manage offers, prices, stock and discounts.' },
  shipping: { label: 'Shipping', description: 'See and fulfil orders, buy labels and manage shipments.' },
  customer_service: { label: 'Customer service', description: 'Reply to buyers, respond to cases and returns, answer reviews.' },
  custom: { label: 'Custom', description: 'Pick single permissions. Owner-only permissions cannot be given.' },
};

const AREA_BY_PREFIX: [RegExp, PermissionEntry['area']][] = [
  [/^catalog\.|^media\./, 'products'],
  [/^offers\./, 'products'],
  [/^inventory\.|^fulfillment-service\.|^warehouse\./, 'inventory'],
  [/^orders\.|^shipping\./, 'orders_shipping'],
  [/^returns\./, 'returns'],
  [/^messaging\.|^support\.|^reviews\.|^customers\./, 'customers'],
  [/^finance\.destinations\.|^sellers\.payout-account\./, 'payouts'],
  [/^finance\.|^payments\./, 'finance'],
  [/^promotions\.|^advertising\.|^content\./, 'marketing'],
  [/^sellers\.staff\./, 'staff'],
  [/^sellers\.account-health\./, 'account_health'],
  [/^sellers\.|^reports\.|^notifications\.|^workqueues\./, 'store'],
];

/** The seller-audience permission catalogue of the running modules */
export function permissionCatalogue(perms: readonly { key: string; audience: string; desc: string; ownerOnly?: boolean; delegable?: boolean }[]): PermissionEntry[] {
  return perms
    .filter((p) => p.audience === 'seller')
    .map((p) => ({
      key: p.key,
      area: AREA_BY_PREFIX.find(([re]) => re.test(p.key))?.[1] ?? 'store',
      label: p.desc,
      level: /\.(view|export)$/.test(p.key) ? ('view' as const) : ('manage' as const),
      ownerOnly: Boolean(p.ownerOnly),
      delegable: p.delegable !== false && !p.ownerOnly,
    }))
    .sort((a, b) => a.area.localeCompare(b.area) || a.key.localeCompare(b.key));
}

/* ------------------------------------------------------------------ performance */

export const METRICS = ['dispatch_reliability', 'cancellation_rate', 'valid_tracking', 'return_rate', 'response_time', 'unresolved_cases', 'policy_violations'] as const;
export type MetricKey = (typeof METRICS)[number];

export const METRIC_INFO: Record<MetricKey, { label: string; definition: string; comparator: 'gte' | 'lte'; unit: PerformanceTarget['unit']; defaultKey: string }> = {
  dispatch_reliability: { label: 'Dispatch reliability', definition: 'Orders dispatched by their deadline ÷ all dispatched or overdue orders', comparator: 'gte', unit: 'percent', defaultKey: 'dispatch_reliability' },
  cancellation_rate: { label: 'Cancellation rate', definition: 'Orders with a seller-caused cancellation ÷ accepted orders', comparator: 'lte', unit: 'percent', defaultKey: 'cancellation_rate' },
  valid_tracking: { label: 'Valid tracking', definition: 'Shipments with carrier-scanned tracking ÷ all shipments', comparator: 'gte', unit: 'percent', defaultKey: 'valid_tracking' },
  return_rate: { label: 'Return rate', definition: 'Return requests ÷ accepted orders', comparator: 'lte', unit: 'percent', defaultKey: 'return_rate' },
  response_time: { label: 'Response time', definition: 'Average hours from a buyer message to the first seller reply', comparator: 'lte', unit: 'hours', defaultKey: 'response_time_hours' },
  unresolved_cases: { label: 'Unresolved cases', definition: 'Open cases past their response deadline', comparator: 'lte', unit: 'count', defaultKey: 'unresolved_cases_past_deadline' },
  policy_violations: { label: 'Policy violations', definition: 'Confirmed policy violations in the violation window', comparator: 'lte', unit: 'count', defaultKey: 'policy_violations' },
};

export function targetDisplay(t: { comparator: string; threshold: number; unit: string }): string {
  const v = t.unit === 'percent' ? `${t.threshold}%` : t.unit === 'hours' ? `${t.threshold} h` : `${t.threshold}`;
  if (t.unit === 'count' && t.threshold === 0) return 'None';
  return `${t.comparator === 'gte' ? 'At least' : 'At most'} ${v}`;
}
