import type { IconName } from '@marketly/web-shared/ui';
import { DataTable, RichText } from '../../help/data/html';

// Policies come from the content API (GET /api/store/content/policies, …/policies/{key}): versioned
// records whose body is staff-authored HTML. This file maps the design's ?view slugs to policy keys, gives
// each policy kind its nav icon and short name (client-side, as the API has none), and renders a body
// through the allowlist HTML renderer (help/data/html.tsx).

export type PolicySlug = '' | 'shipping' | 'seller-rules' | 'privacy' | 'purchase-terms';

/** Design views in nav order → policy key. */
export const VIEW_KEYS: Array<{ slug: PolicySlug; key: string }> = [
  { slug: '', key: 'returns' },
  { slug: 'shipping', key: 'shipping' },
  { slug: 'seller-rules', key: 'seller_rules' },
  { slug: 'privacy', key: 'privacy' },
  { slug: 'purchase-terms', key: 'purchase_terms' },
];

const KIND_ICON: Record<string, IconName> = { returns: 'undo-2', shipping: 'truck', seller_rules: 'store', privacy: 'lock', purchase_terms: 'file-text', advertising: 'megaphone' };
const SHORT: Record<string, string> = { returns: 'Returns', shipping: 'Shipping', seller_rules: 'Seller rules', privacy: 'Privacy', purchase_terms: 'Purchase terms' };

export const policyIcon = (kind: string): IconName => KIND_ICON[kind] ?? 'file-text';
/** Short name for crumbs, the phone picker and the app bar. */
export const policyShort = (key: string, title: string) => SHORT[key] ?? title.replace(/\s+policy$/i, '');

/** The policy body (HTML) and any structured tables. */
export function PolicyBody({ title, body, tables }: { title: string; body: string; tables?: unknown[] | null }) {
  return (
    <>
      <RichText html={body} tableLabel={`${title} table`} />
      {(tables ?? []).map((t, i) => (
        <DataTable key={i} table={t} label={`${title} table ${i + 1}`} />
      ))}
    </>
  );
}
