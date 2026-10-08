import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/settings.js';
import type { SettingsService } from '../service.js';

/**
 * Admin API: /api/admin/settings/…  (docs/api/modules/settings.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: SettingsService) =>
  routes(endpoints, 'admin', {
    /** GET /overview: Settings page: market, every section and all scheduled changes */
    getOverview: notImplemented,
    /** GET /definitions: Runtime setting definitions */
    listDefinitions: notImplemented,
    /** GET /values/{key}: One setting: value in force, scheduled versions, recent history */
    getSetting: notImplemented,
    /** GET /values/{key}/history: All versions of a setting */
    listSettingHistory: notImplemented,
    /** GET /business-calendar: Open hours per day for a date range (business hours minus closures) */
    getBusinessCalendar: notImplemented,
    /** POST /changes: Draft a change and see its impact before saving */
    createChange: notImplemented,
    /** PATCH /changes/{id}: Edit a draft (values, effective date, scope, reason) */
    updateChange: notImplemented,
    /** POST /changes/{id}/preview: Recalculate the impact preview */
    previewChange: notImplemented,
    /** POST /changes/{id}/submit: Save: schedule, or send for approval */
    submitChange: notImplemented,
    /** POST /changes/{id}/cancel: Cancel a draft, pending or scheduled change */
    cancelChange: notImplemented,
    /** GET /changes: Setting changes (scheduled by default) */
    listChanges: notImplemented,
    /** GET /changes/{id}: One change with impact, approval and timeline */
    getChange: notImplemented,
    /** GET /feature-flags: Feature flags */
    listFeatureFlags: notImplemented,
    /** PUT /feature-flags/{key}: Turn a feature flag on or off */
    setFeatureFlag: notImplemented,
  });
