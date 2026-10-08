import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/identity.js';
import type { IdentityService } from '../service.js';

/**
 * Store API: /api/store/identity/…  (docs/api/modules/identity.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const storeRoutes = (service: IdentityService) => {
  void service;
  return routes(endpoints, 'store', {
    /** GET /security: Sign-in and security page in one call */
    getSecurity: notImplemented,
    /** PUT /password: Change password */
    changePassword: notImplemented,
    /** POST /email-changes: Change sign-in email (sends a code to the new address) */
    requestEmailChange: notImplemented,
    /** POST /reauth: Confirm it's you before a sensitive action */
    reauthenticate: notImplemented,
    /** POST /two-step/setups: Start turning on 2-step verification */
    startTwoStepSetup: notImplemented,
    /** POST /two-step/setups/{id}/confirm: Confirm the first code; returns recovery codes once */
    confirmTwoStepSetup: notImplemented,
    /** POST /two-step/methods/{id}/remove: Turn off a 2-step method */
    removeTwoStepMethod: notImplemented,
    /** POST /two-step/recovery-codes: Replace recovery codes */
    regenerateRecoveryCodes: notImplemented,
    /** GET /devices: Where you're signed in */
    listDevices: notImplemented,
    /** POST /devices/{id}/sign-out: Sign out one device */
    signOutDevice: notImplemented,
    /** POST /devices/sign-out-all: Sign out everywhere */
    signOutEverywhere: notImplemented,
    /** GET /security-activity: Recent security activity */
    listSecurityActivity: notImplemented,
  });
};
