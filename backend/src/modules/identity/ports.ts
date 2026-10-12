/**
 * What the identity service needs from the outside world, database-agnostic.
 * The MongoDB adapter lives in infra/mongo/.
 */
import type { Page } from '../../spec/common.js';
import type { IdentityDb } from '../../spec/identity.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';

type T = IdentityDb;
export type AccountRow = T['accounts'];
export type TwoStepMethodRow = T['two_step_methods'];
export type ChallengeRow = T['challenges'];
export type PasswordResetRow = T['password_resets'];
export type DeviceRow = T['devices'];
export type SessionRow = T['sessions'];
export type SellerAccessRow = T['seller_access'];
export type InvitationRow = T['invitations'];
export type GuestSessionRow = T['guest_sessions'];
export type GuestGrantRow = T['guest_order_grants'];
export type OrderLinkRow = T['order_links'];
export type SecurityEventRow = T['security_events'];
export type ReauthTokenRow = T['reauth_tokens'];
/** A sign-in attempt to record: the repository numbers it (identity column) */
export type SignInAttemptInsert = Omit<T['sign_in_attempts'], 'id'>;
export type RecoveryCodeRow = T['recovery_codes'];

export type Audience = 'store' | 'seller' | 'admin';
export type Realm = 'member' | 'staff';

export interface ForUpdate {
  forUpdate?: boolean;
}

export interface AccountFilter {
  realm: Realm;
  q?: string | null;
  status?: string | null;
  twoStepEnabled?: boolean | null;
}

export interface SecurityEventFilter {
  since?: Date;
  until?: Date;
  result?: string | null;
  kind?: string | null;
}

export interface SessionSelector {
  accountId: string;
  audience?: Audience;
  deviceId?: string;
  sellerId?: string;
  exceptSessionId?: string | null;
  sessionIds?: string[];
}

/** A device and the areas it has live sessions for */
export interface DeviceWithSessions extends DeviceRow {
  audiences: Audience[];
  sessionIds: string[];
}

/** What a Google or Apple ID token proves, once its signature, audience and expiry are checked */
export interface ExternalIdentity {
  provider: 'google' | 'apple';
  subject: string;
  email: string;
  emailVerified: boolean;
  firstName?: string | null;
  lastName?: string | null;
}

/** Verifies "Continue with Google / Apple" ID tokens (phase 2). Null when the token is not valid. */
export interface ExternalIdentityVerifier {
  verify(provider: 'google' | 'apple', idToken: string): Promise<ExternalIdentity | null>;
}

/** Persistence for this module's own collections (identity.*). */
export interface IdentityRepository {
  /** Runs fn in one transaction with a repository bound to it */
  transaction<R>(fn: (repo: IdentityRepository) => Promise<R>): Promise<R>;

  /* accounts */
  getAccount(id: string, o?: ForUpdate): Promise<AccountRow | undefined>;
  getAccounts(ids: readonly string[]): Promise<AccountRow[]>;
  findAccount(realm: Realm, emailNormalized: string, o?: ForUpdate): Promise<AccountRow | undefined>;
  findAccountsByEmail(emailNormalized: string): Promise<AccountRow[]>;
  insertAccount(row: AccountRow): Promise<void>;
  updateAccount(id: string, patch: Partial<AccountRow>): Promise<AccountRow>;
  listAccounts(filter: AccountFilter, page: PageRequest): Promise<Page<AccountRow>>;
  /** Unverified member accounts created before `before`, deleted with everything they own */
  deleteUnverifiedAccounts(before: Date, limit: number): Promise<number>;

  /* passwords */
  addPasswordHistory(row: { id: string; account_id: string; password_hash: string; created_at: Date }): Promise<void>;
  recentPasswordHashes(accountId: string, limit: number): Promise<string[]>;

  /* 2-step */
  activeMethods(accountIds: readonly string[]): Promise<TwoStepMethodRow[]>;
  insertMethod(row: TwoStepMethodRow): Promise<void>;
  updateMethod(id: string, patch: Partial<TwoStepMethodRow>): Promise<void>;
  removeAllMethods(accountId: string, at: Date): Promise<number>;
  replaceRecoveryCodes(accountId: string, rows: RecoveryCodeRow[]): Promise<void>;
  /** Marks an unused code used; false when there is none with that hash */
  useRecoveryCode(accountId: string, codeHash: string, at: Date): Promise<boolean>;
  remainingRecoveryCodes(accountIds: readonly string[]): Promise<Map<string, number>>;
  deleteRecoveryCodes(accountId: string): Promise<void>;

  /* challenges */
  insertChallenge(row: ChallengeRow): Promise<void>;
  getChallenge(id: string, o?: ForUpdate): Promise<ChallengeRow | undefined>;
  updateChallenge(id: string, patch: Partial<ChallengeRow>): Promise<ChallengeRow>;
  /** Pending challenges of an account and purpose move to expired (superseded) */
  supersedeChallenges(accountId: string, purpose: ChallengeRow['purpose'], exceptId?: string): Promise<void>;
  /** Pending email changes (new address) per account */
  pendingEmailChanges(accountIds: readonly string[], now: Date): Promise<Map<string, string>>;

  /* password resets */
  insertReset(row: PasswordResetRow): Promise<void>;
  findResetByHash(hash: string, o?: ForUpdate): Promise<PasswordResetRow | undefined>;
  updateReset(id: string, patch: Partial<PasswordResetRow>): Promise<void>;
  /** Unused links of an account stop working (a new request replaces them) */
  invalidateResets(accountId: string, at: Date): Promise<void>;
  latestReset(accountId: string): Promise<PasswordResetRow | undefined>;

  /* devices */
  findDeviceByInstallation(accountId: string, installationId: string): Promise<DeviceRow | undefined>;
  findWebDevice(accountId: string, userAgent: string | null): Promise<DeviceRow | undefined>;
  countDevices(accountId: string): Promise<number>;
  insertDevice(row: DeviceRow): Promise<void>;
  updateDevice(id: string, patch: Partial<DeviceRow>): Promise<void>;
  getDevice(id: string): Promise<DeviceRow | undefined>;
  /** Devices with live sessions, most recently active first */
  devicesOf(accountIds: readonly string[], now: Date): Promise<Map<string, DeviceWithSessions[]>>;
  clearDeviceTrust(accountId: string): Promise<void>;

  /* sessions */
  insertSession(row: SessionRow): Promise<void>;
  getSession(id: string, o?: ForUpdate): Promise<SessionRow | undefined>;
  /** The session whose current or previous refresh token has this hash */
  findSessionByRefreshHash(hash: string, o?: ForUpdate): Promise<SessionRow | undefined>;
  updateSession(id: string, patch: Partial<SessionRow>): Promise<void>;
  /** Live sessions (not revoked, not expired), oldest refresh first */
  liveSessions(accountId: string, now: Date, audience?: Audience): Promise<SessionRow[]>;
  /** Revokes the live sessions matched; returns their ids */
  revokeSessions(sel: SessionSelector, reason: string, at: Date): Promise<string[]>;

  /* seller access */
  activeSellerAccess(accountId: string): Promise<SellerAccessRow[]>;
  getSellerAccess(accountId: string, sellerId: string): Promise<SellerAccessRow | undefined>;
  upsertSellerAccess(row: SellerAccessRow): Promise<void>;
  updateSellerAccess(accountId: string, sellerId: string, patch: Partial<SellerAccessRow>): Promise<void>;
  sellerCounts(accountIds: readonly string[]): Promise<Map<string, number>>;
  activeSellerAccessOf(accountIds: readonly string[]): Promise<Map<string, SellerAccessRow[]>>;

  /* invitations */
  insertInvitation(row: InvitationRow): Promise<void>;
  getInvitation(id: string, o?: ForUpdate): Promise<InvitationRow | undefined>;
  findInvitationByHash(hash: string, o?: ForUpdate): Promise<InvitationRow | undefined>;
  updateInvitation(id: string, patch: Partial<InvitationRow>): Promise<InvitationRow>;
  listInvitations(filter: { purpose: InvitationRow['purpose']; status?: string | null }, page: PageRequest): Promise<Page<InvitationRow>>;
  /** Pending invitations to the same person and context are revoked when a new one is sent */
  revokePendingInvitations(sel: { email: string; purpose: InvitationRow['purpose']; contextRef: string | null }, reason: string, at: Date): Promise<void>;
  latestInvitations(accountIds: readonly string[]): Promise<Map<string, InvitationRow>>;

  /* visitor (guest) sessions */
  insertGuestSession(row: GuestSessionRow): Promise<void>;
  getGuestSession(id: string, o?: ForUpdate): Promise<GuestSessionRow | undefined>;
  findGuestSessionByRefreshHash(hash: string, o?: ForUpdate): Promise<GuestSessionRow | undefined>;
  updateGuestSession(id: string, patch: Partial<GuestSessionRow>): Promise<void>;
  upsertGrant(row: GuestGrantRow): Promise<void>;
  liveGrantOrderIds(guestSessionId: string, now: Date): Promise<string[]>;
  hasLiveGrant(guestSessionId: string, orderId: string, now: Date): Promise<boolean>;

  /* order links */
  insertOrderLink(row: OrderLinkRow): Promise<void>;
  findOrderLinkByHash(hash: string, o?: ForUpdate): Promise<OrderLinkRow | undefined>;
  updateOrderLink(id: string, patch: Partial<OrderLinkRow>): Promise<void>;

  /* security activity */
  insertSecurityEvent(row: SecurityEventRow): Promise<void>;
  listSecurityEvents(accountId: string, filter: SecurityEventFilter, page: PageRequest): Promise<Page<SecurityEventRow>>;
  /** Newest first, at most `limit` per account */
  recentSecurityEvents(accountIds: readonly string[], limit: number, since?: Date): Promise<Map<string, SecurityEventRow[]>>;

  /* sign-in attempts */
  insertSignInAttempt(row: SignInAttemptInsert): Promise<void>;
  failedAttemptsSince(emailNormalized: string, since: Date): Promise<Date[]>;

  /* re-auth tokens */
  insertReauthToken(row: ReauthTokenRow): Promise<void>;
  getReauthToken(hash: string): Promise<ReauthTokenRow | undefined>;
  /** true when this call marked it (it was unused) */
  markReauthUsed(hash: string, at: Date): Promise<boolean>;
  clearReauthUsed(hash: string): Promise<void>;

  /* revocation feed */
  revokedSessionsSince(since: Date): Promise<{ id: string; at: Date }[]>;
  claimedGuestSessionsSince(since: Date): Promise<{ id: string; at: Date }[]>;
  accountRevocationsSince(since: Date): Promise<{ id: string; at: Date }[]>;

  /* jobs: bounded batches, return how many rows they touched */
  deleteExpiredChallenges(now: Date, limit: number): Promise<number>;
  deleteExpiredResets(now: Date, limit: number): Promise<number>;
  deleteExpiredReauthTokens(now: Date, limit: number): Promise<number>;
  deleteExpiredOrderLinks(now: Date, limit: number): Promise<number>;
  deleteExpiredGrants(now: Date, limit: number): Promise<number>;
  /** Visitor sessions past their TTL that no longer carry a live order grant */
  deleteExpiredGuestSessions(now: Date, limit: number): Promise<number>;
  expirePendingInvitations(now: Date, limit: number): Promise<number>;
  expireSessions(now: Date, staffIdleBefore: Date, limit: number): Promise<number>;
  pruneRevokedSessions(before: Date, limit: number): Promise<number>;
  deleteSecurityEventsBefore(before: Date, limit: number): Promise<number>;
  deleteSignInAttemptsBefore(before: Date, limit: number): Promise<number>;
}
