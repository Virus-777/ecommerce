/**
 * Feature flags (pure): the runtime switches inside enabled modules, and how a rollout decides
 * whether a flag is on for a subject. Flags never replace module enablement: a flag of a disabled
 * module is always off.
 */
import { createHash } from 'node:crypto';

export type Rollout = 'everyone' | 'staff_only' | 'percentage';

export interface FlagDeclaration {
  key: string;
  module: string;
  label: string;
  description: string;
  /** Exposed in app-config.features */
  public: boolean;
  plannedPhase: number | null;
}

/**
 * Flags the modules use. Module specs have no place to declare flags yet, so the list lives here
 * (spec gap: settings.sync-definitions "upsert feature flags declared by enabled modules").
 */
export const FLAG_CATALOGUE: FlagDeclaration[] = [
  { key: 'wishlist', module: 'wishlist', label: 'Wishlist', description: 'Saved items, lists and price-drop and back-in-stock alerts in the store and the Android app.', public: true, plannedPhase: 3 },
  { key: 'paidSellerAds', module: 'advertising', label: 'Paid seller ads', description: 'Sellers can buy sponsored placements for their products.', public: true, plannedPhase: 3 },
  { key: 'externalSignIn', module: 'identity', label: 'Continue with Google or Apple', description: 'Members can sign in with a Google or Apple account.', public: true, plannedPhase: null },
  { key: 'bundleDeals', module: 'promotions', label: 'Bundles and quantity deals', description: 'Bundle and quantity-tier discount rules in promotions.', public: false, plannedPhase: 3 },
];

export interface FlagState {
  enabled: boolean;
  rollout: Rollout;
  percentage: number | null;
}

/** Stable 0–99 bucket of a subject for a flag (the same account always lands in the same bucket). */
export function bucketOf(flagKey: string, subjectId: string): number {
  return createHash('sha256').update(`${flagKey}:${subjectId}`).digest().readUInt32BE(0) % 100;
}

/** Whether a flag is on for a subject. Without a subject only an everyone rollout counts. */
export function evaluateFlag(key: string, state: FlagState, moduleEnabled: boolean, subject?: { accountId?: string; realm?: string }): boolean {
  if (!moduleEnabled || !state.enabled) return false;
  switch (state.rollout) {
    case 'everyone':
      return true;
    case 'staff_only':
      return subject?.realm === 'staff' || subject?.realm === 'admin';
    case 'percentage':
      if (!subject?.accountId) return false;
      return bucketOf(key, subject.accountId) < (state.percentage ?? 0);
  }
}
