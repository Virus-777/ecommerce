/**
 * Row types and list filters of the sellers module (its collections are read and written by repository.ts), and the
 * providers it calls (verification, payout tokenisation, address checks), with deterministic development versions
 * in providers/dev.ts.
 */
import type * as common from '../../spec/common.js';
import type { SellersDb } from '../../spec/sellers.js';

export type Db = SellersDb;
export type Table = keyof Db & string;
/** Tables keyed by `id` (store_profiles is keyed by seller_id) */
export type IdTable = Exclude<Table, 'store_profiles'>;

export type SellerRec = Db['sellers'];
export type ApplicationRec = Db['applications'];
export type DocumentRec = Db['application_documents'];
export type CheckRec = Db['verification_checks'];
export type InfoRequestRec = Db['information_requests'];
export type RiskReviewRec = Db['risk_reviews'];
export type AcceptanceRec = Db['agreement_acceptances'];
export type ProfileRec = Db['store_profiles'];
export type CollectionRec = Db['featured_collections'];
export type ClaimRec = Db['public_claims'];
export type ChangeRequestRec = Db['change_requests'];
export type MemberRec = Db['members'];
export type PerfEventRec = Db['performance_events'];
export type SnapshotRec = Db['performance_snapshots'];
export type TargetRec = Db['performance_targets'];
export type WarningRec = Db['warnings'];
export type RestrictionRec = Db['restrictions'];
export type SuspensionRec = Db['suspensions'];
export type AppealRec = Db['appeals'];
export type NoteRec = Db['seller_notes'];
export type AccountEventRec = Db['account_events'];
export type InvitationRec = Db['seller_invitations'];
export type PayoutChangeRec = Db['payout_changes'];
export type PendingChangeRec = Db['pending_changes'];
export type TemplateGrantRec = Db['template_grants'];

export interface SellerListFilter {
  q?: string;
  statuses?: string[];
  verified?: boolean;
  onTimeBelow?: number;
  categoryId?: string;
  sort?: 'name' | 'newest' | 'on_time';
}

export interface ApplicationListFilter {
  state?: string;
  reviewerId?: string;
  riskLevel?: string;
  overdue?: boolean;
  q?: string;
  now: Date;
}

/** Raw performance facts per seller in a window */
export interface PerformanceFacts {
  kind: string;
  n: number;
  total: number;
}

/* ------------------------------------------------------------------ providers */

export type CheckKind = 'identity' | 'business_registration' | 'tax_id' | 'payout_account' | 'return_address' | 'sanctions';
export type CheckResult = 'pending' | 'passed' | 'needs_attention' | 'failed';

/** What a check is about (no raw tax ids or bank numbers ever leave the module) */
export interface CheckSubject {
  applicationId: string;
  legalName: string | null;
  storeName: string | null;
  owners: { name: string; documentCount: number }[];
  registryNumber: string | null;
  stateOfRegistration: string | null;
  taxIdType: string | null;
  taxIdLast4: string | null;
  payoutHolder: string | null;
  payoutHolderMatches: boolean | null;
  returnAddress: common.Address | null;
}

/** KYC/KYB provider: photo ID match, registry lookup, tax id match, sanctions screening. Results may come back later by webhook. */
export interface VerificationProvider {
  readonly name: string;
  submit(kind: CheckKind, subject: CheckSubject): Promise<{ providerRef: string; result: CheckResult; summary: string }>;
}

/** Payout provider tokenisation: bank numbers are exchanged for a destination token at entry */
export interface PayoutTokenizer {
  tokenize(input: { accountHolderName: string; accountType: string; routingNumber: string; accountNumber: string }): Promise<{ ok: true; providerDestinationId: string } | { ok: false; reason: string }>;
}

/** Street address and PO box check for return addresses */
export interface AddressVerifier {
  verify(address: common.Address): Promise<{ result: CheckResult; summary: string }>;
}

export interface SellersProviders {
  verification: VerificationProvider;
  payouts: PayoutTokenizer;
  addresses: AddressVerifier;
}
