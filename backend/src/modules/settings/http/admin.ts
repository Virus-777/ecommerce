import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/settings.js';
import type { SettingsService } from '../service.js';

/**
 * Admin API: /api/admin/settings/…  (docs/api/modules/settings.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: SettingsService) =>
  routes(endpoints, 'admin', {
    /** GET /overview: Settings page: market, every section and all scheduled changes */
    getOverview: async () => service.overview(),
    /** GET /definitions: Runtime setting definitions */
    listDefinitions: async ({ query }) => service.listDefinitions(query),
    /** GET /values/{key}: One setting: value in force, scheduled versions, recent history */
    getSetting: async ({ params }) => service.getSetting(params.key),
    /** GET /values/{key}/history: All versions of a setting */
    listSettingHistory: async ({ params, page }) => service.settingHistory(params.key, page),
    /** GET /business-calendar: Open hours per day for a date range (business hours minus closures) */
    getBusinessCalendar: async ({ query }) => service.businessDays(query.from, query.to),
    /** POST /changes: Draft a change and see its impact before saving */
    createChange: async ({ body, actor, principal, requestId, can }) => service.createChange(body, { actor, principal, requestId, can }),
    /** PATCH /changes/{id}: Edit a draft (values, effective date, scope, reason) */
    updateChange: async ({ params, body, actor, principal, requestId, can }) => service.updateChange(params.id, body, { actor, principal, requestId, can }),
    /** POST /changes/{id}/preview: Recalculate the impact preview */
    previewChange: async ({ params }) => service.previewChange(params.id),
    /** POST /changes/{id}/submit: Save: schedule, or send for approval */
    submitChange: async ({ params, actor, principal, requestId, can }) => service.submitChange(params.id, { actor, principal, requestId, can }),
    /** POST /changes/{id}/cancel: Cancel a draft, pending or scheduled change */
    cancelChange: async ({ params, body, actor, principal, requestId }) => service.cancelChange(params.id, body.reason, { actor, principal, requestId }),
    /** GET /changes: Setting changes (scheduled by default) */
    listChanges: async ({ query, page }) => service.listChanges(query, page),
    /** GET /changes/{id}: One change with impact, approval and timeline */
    getChange: async ({ params }) => service.getChange(params.id),
    /** GET /feature-flags: Feature flags */
    listFeatureFlags: async () => service.listFeatureFlags(),
    /** PUT /feature-flags/{key}: Turn a feature flag on or off */
    setFeatureFlag: async ({ params, body, actor, requestId }) => service.setFeatureFlag(params.key, body, { actor, requestId }),
  });
