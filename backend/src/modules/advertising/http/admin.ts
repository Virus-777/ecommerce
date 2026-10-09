import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/advertising.js';
import { invalid } from '../service/core.js';
import type { AdvertisingService } from '../service.js';

/**
 * Admin API: /api/admin/advertising/…  (docs/api/modules/advertising.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: AdvertisingService) => {
  const c = service.campaigns;
  const cr = service.creatives;
  return routes(endpoints, 'admin', {
    /** GET /dashboard: Live now, upcoming starts, ending soon, waiting approvals, spending and performance */
    adsDashboard: async ({ query }) => {
      const { liveList: _live, ...dash } = await service.reports.dashboard(query);
      return dash;
    },
    /** GET /campaigns: Own promotions and paid ads in every lifecycle status */
    listAdCampaigns: async ({ query, page }) => c.list(query, page),
    /** POST /campaigns: Create an ad campaign draft */
    createAdCampaign: async ({ body, actor, requestId, principal }) => c.create(body, { actor, requestId, principal }),
    /** GET /campaigns/{id}: Campaign with approvals, checks, conflicts, creatives and metrics */
    getAdCampaign: async ({ params }) => c.view(params.id),
    /** PATCH /campaigns/{id}: Edit a draft (or an approved campaign, which returns it to draft) */
    updateAdCampaign: async ({ params, body, actor, requestId, principal }) => c.update(params.id, body, { actor, requestId, principal }),
    /** POST /campaigns/{id}/check: Run checks: blocked pages, overlaps, labels, claims vs promotion, availability, links, reach estimate */
    checkAdCampaign: async ({ params }) => c.check(params.id),
    /** GET /campaigns/{id}/preview: Desktop and phone preview exactly as visitors see it, with label and close control */
    previewAdCampaign: async ({ params, query }) => c.preview(params.id, query.theme ?? 'light'),
    /** POST /campaigns/{id}/submit: Submit for approval */
    submitAdCampaign: async ({ params, body, actor, requestId, principal }) => {
      const by = { actor, requestId, principal };
      const after = await c.submit(params.id, body.noteToReviewers ?? null, by);
      await service.core.audit({ action: 'advertising.campaign.submit', actionLabel: `Submitted ${after.ref} for approval`, target: c.target(after), reason: body.noteToReviewers ?? null }, by);
      return c.view(params.id);
    },
    /** POST /campaigns/{id}/approve: Approve one review step (the campaign is approved when all steps are) */
    approveAdCampaign: async ({ params, body, actor, requestId, principal }) => c.approve(params.id, body, { actor, requestId, principal }),
    /** POST /campaigns/{id}/request-changes: Send back to the owner with a reason */
    requestAdChanges: async ({ params, body, actor, requestId, principal }) => c.requestChanges(params.id, body, { actor, requestId, principal }),
    /** POST /campaigns/{id}/reject: Reject a request (e.g. promoted offer suspended) */
    rejectAdCampaign: async ({ params, body, actor, requestId, principal }) => {
      await c.reject(params.id, body.reason, { actor, requestId, principal });
      return c.view(params.id);
    },
    /** POST /campaigns/{id}/schedule: Schedule an approved campaign for its start time */
    scheduleAdCampaign: async ({ params, actor, requestId, principal }) => c.schedule(params.id, { actor, requestId, principal }),
    /** POST /campaigns/{id}/activate: Activate an approved campaign now */
    activateAdCampaign: async ({ params, actor, requestId, principal }) => c.activate(params.id, { actor, requestId, principal }),
    /** POST /campaigns/{id}/pause: Pause immediately (off the site within 1 minute) */
    pauseAdCampaign: async ({ params, body, actor, requestId, principal }) => {
      await c.pause(params.id, body.reason, { actor, requestId, principal }, { audit: true });
      return c.view(params.id);
    },
    /** POST /campaigns/{id}/resume: Resume a paused campaign */
    resumeAdCampaign: async ({ params, body, actor, requestId, principal }) => {
      await c.resume(params.id, body.reason ?? null, { actor, requestId, principal }, { audit: true });
      return c.view(params.id);
    },
    /** POST /campaigns/{id}/finish: Finish a scheduled, live or paused campaign early */
    finishAdCampaign: async ({ params, body, actor, requestId, principal }) => {
      if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
      await c.finish(params.id, 'stopped_early', body.reason.trim(), { actor, requestId, principal }, { audit: true });
      return c.view(params.id);
    },
    /** POST /campaigns/{id}/archive: Archive a finished or rejected campaign */
    archiveAdCampaign: async ({ params, actor, requestId, principal }) => c.archive(params.id, { actor, requestId, principal }),
    /** POST /campaigns/{id}/renew: Create a new draft from a finished or ending campaign (renew deliberately) */
    renewAdCampaign: async ({ params, body, actor, requestId, principal }) => c.renew(params.id, body, { actor, requestId, principal }),
    /** GET /campaigns/{id}/report: Displays, clicks, dismissals, spend and attributed purchases by day */
    getAdCampaignReport: async ({ params, query }) => service.reports.campaignReport(params.id, query),
    /** GET /reports/performance: Performance across campaigns by placement, with the attribution period stated */
    getAdPerformance: async ({ query }) => service.reports.performance(query),
    /** GET /placements: Placements with pages, formats, caps, rotation and dismissal rules */
    listPlacements: async () => service.setup.listPlacements(),
    /** PATCH /placements/{id}: Edit a placement's rules or turn it on/off */
    updatePlacement: async ({ params, body, actor, requestId, principal }) => service.setup.updatePlacement(params.id, body, { actor, requestId, principal }),
    /** GET /rules: Global advertising rules */
    getGlobalRules: async () => service.setup.getRules(),
    /** PUT /rules: Change global rules (Business Owner approval) */
    updateGlobalRules: async ({ body, actor, requestId, principal }) => service.setup.proposeRules(body, { actor, requestId, principal }),
    /** GET /creatives: Creative library grouped by campaign */
    listCreatives: async ({ query, page }) => cr.list(query, page),
    /** GET /creatives/summary: Creative counts by review status for the library tabs */
    creativeSummary: async ({ query }) => cr.summary(query),
    /** POST /creatives: Add a creative (image or video uploaded through media first, or ad text) */
    createCreative: async ({ body, actor, requestId, principal }) => cr.create(body, { actor, requestId, principal }),
    /** GET /creatives/{id}: Creative with checks, reviews and where it is used */
    getCreative: async ({ params }) => cr.get(params.id),
    /** PATCH /creatives/{id}: Edit ad text or link (approved creatives return to draft) */
    updateCreative: async ({ params, body, actor, requestId, principal }) => cr.update(params.id, body, { actor, requestId, principal }),
    /** POST /creatives/{id}/review: Approve, request changes or reject a creative with a reason */
    reviewCreative: async ({ params, body, actor, requestId, principal }) => cr.review(params.id, body, { actor, requestId, principal }),
    /** POST /creatives/{id}/check: Re-run the link, availability and label checks */
    recheckCreative: async ({ params }) => cr.recheck(params.id),
    /** GET /charges: Seller ad charges (separate from commission) */
    listAdCharges: async ({ query, page }) => service.billing.list(query, page),
    /** POST /charges/{id}/void: Void an accrued charge or credit a posted one (invalid traffic, cancelled delivery) */
    voidAdCharge: async ({ params, body, actor, requestId, principal }) => service.billing.void(params.id, body.reason, { actor, requestId, principal }),
  });
};
