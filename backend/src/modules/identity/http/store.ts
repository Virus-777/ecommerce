import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/identity.js';
import type { IdentityService } from '../service.js';
import { caller } from './client.js';

/**
 * Store API: /api/store/identity/…  (docs/api/modules/identity.md)
 * The security endpoints (`account` auth) take any signed-in session, so seller members and staff
 * manage their own sign-in security here too. Everything acts on the caller's own account.
 */
export const storeRoutes = (service: IdentityService) =>
  routes(endpoints, 'store', {
    /** GET /security: Sign-in and security page in one call */
    getSecurity: async ({ principal }) => service.getSecurity(principal),
    /** PUT /password: Change password */
    changePassword: async (input) => service.changePassword(input.body, caller(input)),
    /** POST /email-changes: Change sign-in email (sends a code to the new address) */
    requestEmailChange: async (input) => service.requestEmailChange(input.body.newEmail, caller(input)),
    /** POST /reauth: Confirm it's you before a sensitive action */
    reauthenticate: async (input) => service.reauthenticate(input.body, caller(input)),
    /** POST /two-step/setups: Start turning on 2-step verification */
    startTwoStepSetup: async (input) => service.startTwoStepSetup(input.body, caller(input)),
    /** POST /two-step/setups/{id}/confirm: Confirm the first code; returns recovery codes once */
    confirmTwoStepSetup: async (input) => service.confirmTwoStepSetup(input.params.id, input.body.code, caller(input)),
    /** POST /two-step/methods/{id}/remove: Turn off a 2-step method */
    removeTwoStepMethod: async (input) => service.removeTwoStepMethod(input.params.id, input.body.code, caller(input)),
    /** POST /two-step/recovery-codes: Replace recovery codes */
    regenerateRecoveryCodes: async (input) => service.regenerateRecoveryCodes(caller(input)),
    /** GET /devices: Where you're signed in */
    listDevices: async ({ principal }) => service.listDevices(principal),
    /** POST /devices/{id}/sign-out: Sign out one device */
    signOutDevice: async (input) => service.signOutDevice(input.params.id, caller(input)),
    /** POST /devices/sign-out-all: Sign out everywhere */
    signOutEverywhere: async (input) => service.signOutEverywhere(input.body.keepThisDevice, caller(input)),
    /** GET /security-activity: Recent security activity */
    listSecurityActivity: async ({ principal, query, page }) => service.listSecurityActivity(principal, query, page),
  });
