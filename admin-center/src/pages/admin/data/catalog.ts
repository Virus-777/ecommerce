import type { components } from '@marketly/web-shared/api';

// Admin Products table (design: pages/admin/admin-catalog.html), fed by GET /api/admin/catalog/products
// and /products/stats. Labels and the row edge are derived from the API's states.

export type ProductAdmin = components['schemas']['catalog.ProductAdmin'];
export type CategoryNode = components['schemas']['catalog.Category'];
export type ReviewStateKey = ProductAdmin['reviewState'];
export type PublicationKey = ProductAdmin['publication'];

export const REVIEW_LABEL: Record<ReviewStateKey, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
};
export const PUBLICATION_LABEL: Record<PublicationKey, string> = { active: 'Active', hidden: 'Hidden', suspended: 'Suspended' };

export const CATALOG_TABS = [
  { value: 'all', label: 'All', stat: 'all' },
  { value: 'active', label: 'Active', stat: 'active' },
  { value: 'hidden', label: 'Hidden', stat: 'hidden' },
  { value: 'suspended', label: 'Suspended', stat: 'suspended' },
  { value: 'missing', label: 'Missing content', stat: 'missingContent' },
  { value: 'duplicates', label: 'Duplicates suspected', stat: 'duplicatesSuspected' },
] as const;
export type CatalogTab = (typeof CATALOG_TABS)[number]['value'];

/** Query filters a tab adds to GET /catalog/products. */
export const TAB_QUERY: Record<CatalogTab, { publication?: PublicationKey; missingContent?: boolean; duplicateSuspected?: boolean }> = {
  all: {},
  active: { publication: 'active' },
  hidden: { publication: 'hidden' },
  suspended: { publication: 'suspended' },
  missing: { missingContent: true },
  duplicates: { duplicateSuspected: true },
};

/** Flattened category tree for the filter select ("Electronics › Headphones"). */
export function flattenCategories(tree: CategoryNode[], prefix = ''): Array<{ id: string; label: string }> {
  return tree.flatMap((c) => {
    const label = prefix ? `${prefix} › ${c.name}` : c.name;
    return [{ id: c.id, label }, ...flattenCategories((c.children ?? []) as CategoryNode[], label)];
  });
}

/** Row edge: flagged = urgent (red), warn = at risk (amber). */
export function rowEdge(p: ProductAdmin): 'flagged' | 'warn' | undefined {
  if (p.publication === 'suspended' || p.reviewState === 'rejected') return 'flagged';
  if (p.duplicateSuspected || p.contentScore < 70 || p.reviewState === 'changes_requested') return 'warn';
  return undefined;
}

/** Still in the review flow: links to the review queue instead of the store page. */
export const inReview = (p: ProductAdmin) => p.reviewState !== 'approved';
