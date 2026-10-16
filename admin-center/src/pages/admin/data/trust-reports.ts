// Detail for admin/trust-report (designed in React; blueprint: reports/Best ecommerce site UX patterns.md,
// "Trust and risk report detail"), built from GET /api/admin/trust/reports/{id}. The design's five actions map
// onto the trust API: Clear = dismiss; Request info = an evidence request to the reported seller or customer;
// Restrict listing, Hold payouts and Suspend = an enforcement recommendation routed to the owning team
// (Trust recommends, owners act).
import type { components } from '@marketly/web-shared/api';
import type { IconName, TimelineEvent } from '@marketly/web-shared/ui';
import { DISMISS_REASONS, OWNER_TEAM, type TrustReportDetail, type TrustSubject } from './trust';

type S = components['schemas'];
export type RecommendationInput = S['trust.RecommendationInput'];
export type RecAction = RecommendationInput['action'];

export type TrustActionKey = 'clear' | 'request-info' | 'restrict-listing' | 'hold-payouts' | 'suspend';
export type Reversible = 'yes' | 'partly' | 'no';

/** The fixed action set. Trust performs Clear and Request info; the others go to the owning team. */
export interface TrustActionDef {
  key: TrustActionKey;
  label: string;
  icon: IconName;
  byTrust: boolean;
  reversible: Reversible;
  undo: string;
  reasons: string[];
  /** Primary button label in the dialog. */
  submit: string;
}

export const TRUST_ACTIONS: TrustActionDef[] = [
  { key: 'clear', label: 'Clear', icon: 'circle-check', byTrust: true, reversible: 'yes', undo: 'Can be undone: the report can be reopened with a reason.', reasons: [...DISMISS_REASONS, 'Seller proved the items are genuine'], submit: 'Clear report' },
  { key: 'request-info', label: 'Request info', icon: 'message-circle-question', byTrust: true, reversible: 'yes', undo: 'Nothing else changes while it is open. The request stays open until it is answered or expires.', reasons: ['Proof of authenticity needed', 'Supplier cannot be verified', 'Identity check needed', 'More detail needed from the reported party'], submit: 'Send request' },
  { key: 'restrict-listing', label: 'Restrict listing', icon: 'eye-off', byTrust: false, reversible: 'yes', undo: 'Can be undone: Catalog can lift the restriction and the offer returns as it was.', reasons: ['Suspected counterfeit', 'Listing policy violation', 'Product safety risk', 'Misleading listing'], submit: 'Send to Catalog' },
  { key: 'hold-payouts', label: 'Hold payouts', icon: 'wallet', byTrust: false, reversible: 'yes', undo: 'Can be undone: Finance releases the hold and the money goes out in the next payout run. A hold never takes money away.', reasons: ['Pending counterfeit review', 'Refund and chargeback exposure', 'Suspected fraud', 'Identity not verified'], submit: 'Send to Finance' },
  { key: 'suspend', label: 'Suspend', icon: 'ban', byTrust: false, reversible: 'partly', undo: 'Only partly: a suspension can be lifted on appeal, but cancelled orders and lost search ranking are not restored.', reasons: ['Confirmed counterfeit goods', 'Repeated policy violations', 'Confirmed fraud', 'Identity could not be verified'], submit: 'Send to Seller Manager' },
];

export const actionDef = (k: TrustActionKey) => TRUST_ACTIONS.find((a) => a.key === k)!;

/** What an action means for this report and how it is sent to the API. `unavailable` explains why it does not apply. */
export type CaseAction =
  | {
      what: string;
      consequence: string;
      owner: string;
      submit: string;
      /** Recommendation to draft and route (owner actions). */
      rec?: { action: RecAction; targets: TrustSubject[] };
      /** Evidence request recipient (Request info). */
      to?: TrustSubject;
      done?: string;
    }
  | { unavailable: string };

export const available = (c: CaseAction): c is Exclude<CaseAction, { unavailable: string }> => !('unavailable' in c);

export interface RiskFactorView {
  dir: 'raises' | 'lowers';
  title: string;
  detail: string;
  weight: 'Strong' | 'Moderate' | 'Weak';
}

const humanize = (s: string) => {
  const t = s.replace(/[_.]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function factorsOf(d: TrustReportDetail): RiskFactorView[] {
  return [...d.riskFactors]
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .map((f) => {
      const w = Math.abs(f.weight);
      return { dir: f.weight < 0 ? 'lowers' : 'raises', title: humanize(f.factor), detail: f.detail, weight: w >= 20 ? 'Strong' : w >= 8 ? 'Moderate' : 'Weak' };
    });
}

const CLOSED = new Set(['resolved', 'dismissed', 'merged']);
export const isClosed = (d: Pick<TrustReportDetail, 'status'>) => CLOSED.has(d.status);

const first = (d: TrustReportDetail, ...types: string[]) => d.subjects.find((s) => types.includes(s.type));
const all = (d: TrustReportDetail, ...types: string[]) => d.subjects.filter((s) => types.includes(s.type));
const hasRec = (d: TrustReportDetail, action: string) => d.recommendations.find((r) => r.action === action && (r.state === 'pending' || r.state === 'sent_to_owner' || r.state === 'completed'));

/** The five actions for this report, from its subjects and what is already in place. */
export function actionsFor(d: TrustReportDetail): Record<TrustActionKey, CaseAction> {
  const closed = isClosed(d);
  const seller = first(d, 'seller');
  const customer = first(d, 'customer');
  const listings = all(d, 'offer');
  const products = all(d, 'product');
  const party = seller ?? customer;
  const doneNote = (action: string) => {
    const r = hasRec(d, action);
    return r ? `${r.label} (${r.state === 'completed' ? 'completed' : 'already sent to the owner'})` : undefined;
  };
  const closedNote = { unavailable: `The report is ${d.status}. Reopen it before acting.` };
  return {
    clear: closed
      ? closedNote
      : { what: `Close ${d.ref} with no further action`, consequence: 'The report closes and the reporter is told the outcome. Actions other teams already took stay in place until they reverse them.', owner: 'Trust and Risk', submit: 'Clear report' },
    'request-info': closed
      ? closedNote
      : party
        ? { what: `Ask ${party.label} for proof or an explanation`, consequence: `${party.label} gets a request with a 5-day deadline. Listings, orders and payouts stay as they are while we wait.`, owner: 'Trust and Risk', submit: 'Send request', to: party }
        : { unavailable: 'No seller or customer is a subject of this report, so there is nobody to ask.' },
    'restrict-listing': closed
      ? closedNote
      : listings.length || products.length
        ? {
            what: listings.length ? `Suspend ${listings.length === 1 ? listings[0].label : `${listings.length} listings`}` : `Suspend ${products.length === 1 ? products[0].label : `${products.length} products`}`,
            consequence: 'The listing is hidden from search and product pages. Open orders, returns and buyer help continue.',
            owner: OWNER_TEAM.catalog,
            submit: 'Send to Catalog',
            rec: listings.length ? { action: 'suspend_offer', targets: listings } : { action: 'suspend_product', targets: products },
            done: doneNote(listings.length ? 'suspend_offer' : 'suspend_product'),
          }
        : { unavailable: 'No listing or product is a subject of this report.' },
    'hold-payouts': closed
      ? closedNote
      : seller
        ? { what: `Hold payouts to ${seller.label}`, consequence: 'Finance places a hold on new earnings until the review date. The seller sees the hold and the reason in Seller Center.', owner: OWNER_TEAM.finance, submit: 'Send to Finance', rec: { action: 'hold_payout', targets: [seller] }, done: doneNote('hold_payout') }
        : { unavailable: 'No seller is a subject of this report, so there are no payouts to hold.' },
    suspend: closed
      ? closedNote
      : seller
        ? { what: `Suspend ${seller.label}`, consequence: 'All offers are hidden and new orders stop. Open orders must still ship or are refunded; returns and buyer help continue.', owner: OWNER_TEAM.sellers, submit: 'Send to Seller Manager', rec: { action: 'suspend_seller', targets: [seller] }, done: doneNote('suspend_seller') }
        : customer
          ? { what: `Restrict ${customer.label}`, consequence: 'The account cannot place orders. Open orders, refunds and help are not affected.', owner: OWNER_TEAM.customers, submit: 'Send to Support', rec: { action: 'restrict_customer_account', targets: all(d, 'customer') }, done: doneNote('restrict_customer_account') }
          : { unavailable: 'No seller or customer account is a subject of this report.' },
  };
}

/**
 * The report's next step as the API states it (TrustReport.nextStep: label and detail), with the action on this
 * page that carries it out, when there is one: ask for proof, recommend an owner action, or clear the report.
 */
export function nextStepOf(d: TrustReportDetail, actions: Record<TrustActionKey, CaseAction>): { key: string; label: string; detail: string | null; action: TrustActionKey | null } | null {
  const n = d.nextStep;
  if (!n) return null;
  const pick = (...keys: TrustActionKey[]) => keys.find((k) => available(actions[k]) && !(actions[k] as { done?: unknown }).done) ?? null;
  const action =
    n.key === 'gather_evidence' ? pick('request-info')
    : n.key === 'add_recommendation' ? pick('restrict-listing', 'suspend', 'hold-payouts')
    : n.key === 'resolve' ? 'clear'
    : null;
  return { key: n.key, label: n.label, detail: n.detail ?? null, action };
}

const SUSPEND_REASON: Record<string, string> = {
  'Confirmed counterfeit goods': 'counterfeit_risk',
  'Repeated policy violations': 'policy_violation',
  'Confirmed fraud': 'fraud_risk',
  'Identity could not be verified': 'verification_lapsed',
};
const CUSTOMER_REASON: Record<string, string> = {
  'Confirmed fraud': 'payment_fraud_review',
  'Identity could not be verified': 'suspected_takeover',
  'Repeated policy violations': 'policy_violation',
};

const isoDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Action parameters the owner reviews (Recommendation.params). */
export function paramsFor(action: RecAction, reason: string, note: string): Record<string, unknown> {
  const text = note.trim() ? `${reason}. ${note.trim()}` : reason;
  switch (action) {
    case 'suspend_seller':
      return { reasonCode: SUSPEND_REASON[reason] ?? 'other', reason: text, reviewDate: isoDate(14), openOrders: 'seller_keeps_fulfilling' };
    case 'restrict_customer_account':
      return { reasonCode: CUSTOMER_REASON[reason] ?? 'other' };
    case 'suspend_offer':
      return { mode: 'hold', reviewDate: isoDate(14) };
    case 'hold_payout':
      return { reviewDate: isoDate(14) };
    default:
      return {};
  }
}

export const reasonCode = (r: string) => r.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Report timeline as the design's Timeline events, oldest first; the last open step is current. */
export function timelineOf(d: TrustReportDetail, fmt: (iso: string) => string): TimelineEvent[] {
  const ev: TimelineEvent[] = d.timeline.map((e) => ({
    t: e.label,
    d: `${fmt(e.at)}${e.actor?.name ? ` · ${e.actor.name}` : ''}`,
    state: /escalat/i.test(e.label) ? 'warn' : 'done',
    body: e.detail ?? undefined,
  }));
  if (!isClosed(d)) ev.push({ t: d.assignee ? 'Waiting for a decision' : 'Unassigned: waiting for a reviewer', d: d.deadline ? `Due ${fmt(d.deadline.dueAt)}` : 'Now', state: 'current' });
  return ev;
}
