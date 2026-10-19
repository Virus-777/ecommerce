// Labels and helpers for the admin "Trust and risk" screens (admin/trust, admin/trust-report), mapping the
// trust module's API (GET /api/admin/trust/overview, /reports, /reports/{id}, /appeals) onto the design.
import type { components } from '@marketly/web-shared/api';
import { href, type ScreenId } from '@marketly/web-shared/routes';
import type { IconName, Tone } from '@marketly/web-shared/ui';
import { screenHref } from '@/app/parts';

type S = components['schemas'];
export type ReportRow = S['trust.ReportRow'];
export type TrustReportDetail = S['trust.TrustReport'];
export type TrustSubject = S['trust.TrustSubject'];
export type TrustOverview = S['trust.TrustOverview'];
export type TrustAppeal = S['trust.TrustAppeal'];
export type Recommendation = S['trust.Recommendation'];
export type EvidenceItem = S['trust.EvidenceItem'];

/** The four report types the design shows as tabs (API type keys). Other types appear under All open only. */
export type ReportType = 'counterfeit' | 'suspicious_orders' | 'fake_reviews' | 'abuse';

export const REPORT_TYPES: Record<ReportType, { label: string; icon: IconName }> = {
  counterfeit: { label: 'Counterfeit', icon: 'badge-alert' },
  suspicious_orders: { label: 'Suspicious orders', icon: 'credit-card' },
  fake_reviews: { label: 'Fake reviews', icon: 'star' },
  abuse: { label: 'Abuse', icon: 'message-square-warning' },
};

const OTHER_TYPES: Record<string, string> = {
  prohibited_item: 'Prohibited item',
  misleading_listing: 'Misleading listing',
  seller_application: 'Seller application',
  account_risk: 'Account risk',
  other: 'Other',
};

export const typeOf = (t: string): { label: string; icon: IconName } =>
  REPORT_TYPES[t as ReportType] ?? { label: OTHER_TYPES[t] ?? t.replace(/_/g, ' '), icon: 'shield-alert' };

export const isTabType = (t: string): t is ReportType => t in REPORT_TYPES;

export interface TrustKpi {
  icon: IconName;
  label: string;
  /** Which report type (or 'all' / 'appeals') the count comes from. */
  source: ReportType | 'all' | 'appeals';
  /** Note when the API sends none for the type. */
  note: string;
}

export const TRUST_KPIS: TrustKpi[] = [
  { icon: 'shield-alert', label: 'Open reports', source: 'all', note: '' },
  { icon: 'badge-alert', label: 'Counterfeit', source: 'counterfeit', note: 'Brand and customer reports' },
  { icon: 'credit-card', label: 'Suspicious orders', source: 'suspicious_orders', note: 'Payment risk rules' },
  { icon: 'star', label: 'Fake reviews', source: 'fake_reviews', note: 'Review pattern check' },
  { icon: 'message-square-warning', label: 'Abuse', source: 'abuse', note: 'Messaging' },
  { icon: 'scale', label: 'Appeals waiting', source: 'appeals', note: '' },
];

/** Report status as the design's StatusBadge labels. */
export const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  under_review: 'Under review',
  escalated: 'Escalated',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  merged: 'Merged',
};

/** Recommendation states as the design's routed-action badges. */
export const REC_STATE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  sent_to_owner: { label: 'Sent to owner', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  declined: { label: 'Declined', tone: '' },
  withdrawn: { label: 'Withdrawn', tone: '' },
};

export const OWNER_TEAM: Record<string, string> = {
  catalog: 'Catalog',
  sellers: 'Seller Manager',
  support: 'Support',
  finance: 'Finance',
  orders: 'Orders',
  reviews: 'Catalog · reviews moderation',
  customers: 'Support · customer accounts',
  messaging: 'Support · messaging',
};

export const ownerLabel = (r: Pick<Recommendation, 'ownerTeam' | 'owner'>) => `${OWNER_TEAM[r.ownerTeam] ?? r.ownerTeam}${r.owner?.name ? ` · ${r.owner.name}` : ''}`;

export const APPEAL_STATUS: Record<string, string> = {
  open: 'Open',
  under_review: 'Under review',
  upheld: 'Resolved',
  overturned: 'Resolved',
  partly_overturned: 'Resolved',
  withdrawn: 'Withdrawn',
};

/** Evidence check results as the design's evidence list tones. */
export type EvidenceTone = 'fail' | 'warn' | 'info' | 'ok';
export const evidenceTone = (e: Pick<EvidenceItem, 'result'>): EvidenceTone => (e.result as EvidenceTone | null | undefined) ?? 'info';

const SUBJECT_ICON: Record<string, IconName> = {
  seller: 'store',
  product: 'package',
  offer: 'package',
  order: 'shopping-bag',
  customer: 'user-round',
  review: 'star',
  question: 'message-square',
  answer: 'message-square',
  message: 'message-square',
  conversation: 'message-square',
  application: 'file-text',
  storefront_claim: 'badge-check',
  payment: 'credit-card',
};
export const subjectIcon = (t: string): IconName => SUBJECT_ICON[t] ?? 'link';

const SUBJECT_KIND: Record<string, string> = {
  seller: 'Seller',
  product: 'Product',
  offer: 'Listing',
  order: 'Order',
  customer: 'Customer',
  review: 'Review',
  question: 'Question',
  answer: 'Answer',
  message: 'Message',
  conversation: 'Conversation',
  application: 'Application',
  storefront_claim: 'Storefront claim',
  payment: 'Payment',
};
export const subjectKind = (t: string) => SUBJECT_KIND[t] ?? t;

const LIST_SCREEN: Partial<Record<string, ScreenId>> = {
  seller: 'admin/sellers',
  product: 'admin/catalog',
  offer: 'admin/catalog',
  order: 'admin/orders',
  customer: 'admin/customers',
  review: 'admin/reviews',
  question: 'admin/reviews',
  answer: 'admin/reviews',
  application: 'admin/sellers',
  payment: 'admin/finance',
};

/** Where a subject opens in the Admin Center: its detail screen when the URL can carry it (sellers by `slug`,
 * /sellers/:slug; others by `ref`), else its list. */
export function subjectHref(s: Pick<TrustSubject, 'type' | 'ref' | 'label' | 'screen' | 'slug'>): string {
  const ref = s.ref ?? undefined;
  const slug = s.slug ?? (s.type === 'seller' ? undefined : ref);
  if (s.screen && (ref || slug)) {
    const h = screenHref(s.screen, null, Object.fromEntries(Object.entries({ ref, slug, key: ref, id: ref }).filter((e): e is [string, string] => !!e[1])));
    if (h) return h;
  }
  const q = ref ?? s.label;
  return href(LIST_SCREEN[s.type] ?? 'admin/trust', '', undefined, q ? { q } : undefined);
}

/** Collapses many subjects of one type (e.g. 8 orders) into one linked-record chip like the design's "6 orders". */
export function linkedRecords(subjects: TrustSubject[], caseRefs: string[] = []): Array<{ icon: IconName; label: string; to: string }> {
  const byType = new Map<string, TrustSubject[]>();
  for (const s of subjects) byType.set(s.type, [...(byType.get(s.type) ?? []), s]);
  const out: Array<{ icon: IconName; label: string; to: string }> = [];
  for (const [type, list] of byType) {
    if (list.length > 2) {
      out.push({ icon: subjectIcon(type), label: `${list.length} ${subjectKind(type).toLowerCase()}s`, to: href(LIST_SCREEN[type] ?? 'admin/trust') });
    } else {
      for (const s of list) out.push({ icon: subjectIcon(type), label: s.statusLabel ? `${s.label} · ${s.statusLabel}` : s.label, to: subjectHref(s) });
    }
  }
  for (const c of caseRefs) out.push({ icon: 'life-buoy', label: c, to: href('admin/case', '', { ref: c }) });
  return out;
}

export const DISMISS_REASONS = ['Evidence does not support the report', 'Duplicate of another report', 'Resolved by the seller', 'Reported in error'];

/** What the reporter is told when a report is dismissed (dismiss needs a reporter-facing message). */
const REPORTER_OUTCOME: Record<string, string> = {
  'Evidence does not support the report': 'We reviewed your report and the evidence did not show a breach of our rules, so no action was taken.',
  'Duplicate of another report': 'Your report was combined with another report about the same problem, which we are handling.',
  'Resolved by the seller': 'The problem you reported has been fixed, so no further action was needed.',
  'Reported in error': 'We reviewed your report and closed it without action.',
};
export const reporterOutcomeFor = (reason: string) => REPORTER_OUTCOME[reason] ?? 'We reviewed your report and closed it without action.';

/** "Reported Oct 5 by … · assigned to …" line under a report title. */
export function reportMeta(r: Pick<ReportRow, 'createdAt' | 'source' | 'reporterLabel' | 'assignee'>, date: (iso: string) => string): string {
  const verb = r.source === 'automated' ? 'Detected' : 'Reported';
  return `${verb} ${date(r.createdAt)} by ${r.reporterLabel}${r.assignee ? ` · assigned to ${r.assignee.name}` : ' · unassigned'}`;
}
