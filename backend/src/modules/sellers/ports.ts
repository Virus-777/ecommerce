/**
 * What the sellers service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; providers (verification, payout tokenisation,
 * address checks) have deterministic dev adapters in infra/providers/.
 */
import type { PageRequest } from '../../kernel/lib/pagination.js';
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

/** A column condition: a value (=), a list (in), null (is null) or an operator */
export type Cond<V> = V | readonly V[] | { op: '<' | '<=' | '>' | '>=' | '<>' | 'is not'; value: V | null };
export type Where<R> = { [K in keyof R]?: Cond<R[K]> };

export interface FindOptions<R> {
  orderBy?: [keyof R & string, 'asc' | 'desc'][];
  limit?: number;
  forUpdate?: boolean;
}

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

export interface SellersRepository {
  transaction<R>(fn: (tx: SellersRepository) => Promise<R>): Promise<R>;

  /* generic table access */
  get<T extends IdTable>(table: T, id: string, o?: { forUpdate?: boolean }): Promise<Db[T] | undefined>;
  getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Db[T][]>;
  find<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T][]>;
  findOne<T extends Table>(table: T, where: Where<Db[T]>, o?: FindOptions<Db[T]>): Promise<Db[T] | undefined>;
  count<T extends Table>(table: T, where: Where<Db[T]>): Promise<number>;
  insert<T extends Table>(table: T, row: Db[T]): Promise<Db[T]>;
  update<T extends IdTable>(table: T, id: string, patch: Partial<Db[T]>): Promise<Db[T]>;
  remove<T extends IdTable>(table: T, id: string): Promise<void>;
  page<T extends Table>(table: T, where: Where<Db[T]>, page: PageRequest, order: { column: keyof Db[T] & string; direction: 'asc' | 'desc' }): Promise<common.Page<Db[T]>>;

  /* store profiles */
  getProfile(sellerId: string): Promise<ProfileRec | undefined>;
  upsertProfile(row: ProfileRec): Promise<ProfileRec>;

  /* sellers */
  sellerBySlug(slug: string): Promise<SellerRec | undefined>;
  sellersByStoreName(name: string): Promise<SellerRec[]>;
  slugTaken(slug: string): Promise<boolean>;
  listSellers(filter: SellerListFilter, page: PageRequest): Promise<common.Page<SellerRec>>;
  allSellerIds(filter: SellerListFilter, limit: number): Promise<SellerRec[]>;
  countSellersByStatus(): Promise<Record<string, number>>;
  countSellersCreatedSince(since: Date): Promise<number>;
  countBelowDispatch(): Promise<number>;

  /* applications */
  listApplications(filter: ApplicationListFilter, page: PageRequest): Promise<common.Page<ApplicationRec>>;
  latestApplicationOf(accountId: string): Promise<ApplicationRec | undefined>;
  applicationsMatching(signals: { emails: string[]; tokens: string[]; addresses: { line1: string; postalCode: string }[] }, excludeId: string): Promise<ApplicationRec[]>;

  /* members */
  activeMember(sellerId: string, accountId: string): Promise<MemberRec | undefined>;

  /* performance */
  insertPerformanceEvent(row: PerfEventRec): Promise<boolean>;
  performanceFacts(sellerId: string, since: Date): Promise<PerformanceFacts[]>;
  unresolvedCasesPastDeadline(sellerId: string, nowMs: number): Promise<number>;
  latestSnapshots(sellerIds: readonly string[], perSeller: number): Promise<SnapshotRec[]>;

  /* jobs */
  deleteDocumentsDue(today: string, limit: number): Promise<DocumentRec[]>;
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
