/**
 * Row types and filters of the identity module (its collections are read and written by repository.ts), and the
 * ID-token verifier it calls for Continue with Google / Apple.
 */
import type { IdentityDb } from '../../spec/identity.js';

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
