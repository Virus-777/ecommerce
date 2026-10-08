import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/advertising.js';
import type { AdvertisingService } from '../service.js';

/**
 * Admin API: /api/admin/advertising/…  (docs/api/modules/advertising.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: AdvertisingService) => {
  void service;
  return routes(endpoints, 'admin', {
    /** GET /dashboard: Live now, upcoming starts, ending soon, waiting approvals, spending and performance */
    adsDashboard: notImplemented,
    /** GET /campaigns: Own promotions and paid ads in every lifecycle status */
    listAdCampaigns: notImplemented,
    /** POST /campaigns: Create an ad campaign draft */
    createAdCampaign: notImplemented,
    /** GET /campaigns/{id}: Campaign with approvals, checks, conflicts, creatives and metrics */
    getAdCampaign: notImplemented,
    /** PATCH /campaigns/{id}: Edit a draft (or an approved campaign, which returns it to draft) */
    updateAdCampaign: notImplemented,
    /** POST /campaigns/{id}/check: Run checks: blocked pages, overlaps, labels, claims vs promotion, availability, links, reach estimate */
    checkAdCampaign: notImplemented,
    /** GET /campaigns/{id}/preview: Desktop and phone preview exactly as visitors see it, with label and close control */
    previewAdCampaign: notImplemented,
    /** POST /campaigns/{id}/submit: Submit for approval */
    submitAdCampaign: notImplemented,
    /** POST /campaigns/{id}/approve: Approve one review step (the campaign is approved when all steps are) */
    approveAdCampaign: notImplemented,
    /** POST /campaigns/{id}/request-changes: Send back to the owner with a reason */
    requestAdChanges: notImplemented,
    /** POST /campaigns/{id}/reject: Reject a request (e.g. promoted offer suspended) */
    rejectAdCampaign: notImplemented,
    /** POST /campaigns/{id}/schedule: Schedule an approved campaign for its start time */
    scheduleAdCampaign: notImplemented,
    /** POST /campaigns/{id}/activate: Activate an approved campaign now */
    activateAdCampaign: notImplemented,
    /** POST /campaigns/{id}/pause: Pause immediately (off the site within 1 minute) */
    pauseAdCampaign: notImplemented,
    /** POST /campaigns/{id}/resume: Resume a paused campaign */
    resumeAdCampaign: notImplemented,
    /** POST /campaigns/{id}/finish: Finish a scheduled, live or paused campaign early */
    finishAdCampaign: notImplemented,
    /** POST /campaigns/{id}/archive: Archive a finished or rejected campaign */
    archiveAdCampaign: notImplemented,
    /** POST /campaigns/{id}/renew: Create a new draft from a finished or ending campaign (renew deliberately) */
    renewAdCampaign: notImplemented,
    /** GET /campaigns/{id}/report: Displays, clicks, dismissals, spend and attributed purchases by day */
    getAdCampaignReport: notImplemented,
    /** GET /reports/performance: Performance across campaigns by placement, with the attribution period stated */
    getAdPerformance: notImplemented,
    /** GET /placements: Placements with pages, formats, caps, rotation and dismissal rules */
    listPlacements: notImplemented,
    /** PATCH /placements/{id}: Edit a placement's rules or turn it on/off */
    updatePlacement: notImplemented,
    /** GET /rules: Global advertising rules */
    getGlobalRules: notImplemented,
    /** PUT /rules: Change global rules (Business Owner approval) */
    updateGlobalRules: notImplemented,
    /** GET /creatives: Creative library grouped by campaign */
    listCreatives: notImplemented,
    /** GET /creatives/summary: Creative counts by review status for the library tabs */
    creativeSummary: notImplemented,
    /** POST /creatives: Add a creative (image or video uploaded through media first, or ad text) */
    createCreative: notImplemented,
    /** GET /creatives/{id}: Creative with checks, reviews and where it is used */
    getCreative: notImplemented,
    /** PATCH /creatives/{id}: Edit ad text or link (approved creatives return to draft) */
    updateCreative: notImplemented,
    /** POST /creatives/{id}/review: Approve, request changes or reject a creative with a reason */
    reviewCreative: notImplemented,
    /** POST /creatives/{id}/check: Re-run the link, availability and label checks */
    recheckCreative: notImplemented,
    /** GET /charges: Seller ad charges (separate from commission) */
    listAdCharges: notImplemented,
    /** POST /charges/{id}/void: Void an accrued charge or credit a posted one (invalid traffic, cancelled delivery) */
    voidAdCharge: notImplemented,
  });
};
