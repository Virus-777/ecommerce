import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/offers.js';
import type { OffersService } from '../service.js';

/**
 * Admin API: /api/admin/offers/…  (docs/api/modules/offers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: OffersService) => {
  const official = { ownerType: 'official' as const, sellerId: null };
  const detail = async (id: string) => service.views.adminDetail(await service.core.offerRow(id));
  return routes(endpoints, 'admin', {
    /** GET /offers: All offers with filters (seller, product, status, eligibility) */
    listOffersAdmin: async ({ query, page }) => service.views.adminList(query, page),
    /** GET /offers/{id}: Offer with status log, price history and price changes */
    getOfferAdmin: async ({ params }) => detail(params.id),
    /** POST /offers/{id}/remove: Remove an offer with a reason */
    removeOffer: async ({ params, body, principal, actor, requestId }) => detail((await service.manage.remove(params.id, body, { actor, requestId, principal })).id),
    /** POST /offers/{id}/hold: Hold an offer during an investigation */
    holdOffer: async ({ params, body, principal, actor, requestId }) => detail((await service.manage.hold(params.id, body, { actor, requestId, principal })).id),
    /** POST /offers/{id}/release-hold: Release a staff hold */
    releaseOfferHold: async ({ params, body, principal, actor, requestId }) => detail((await service.manage.releaseHold(params.id, body.reason, { actor, requestId, principal })).id),
    /** POST /offers/{id}/reinstate: Reinstate a removed offer as Paused */
    reinstateOffer: async ({ params, body, principal, actor, requestId }) => detail((await service.manage.reinstate(params.id, body.reason, { actor, requestId, principal })).id),
    /** GET /official/offers: Official Store offers with price, cost, margin and sellable stock */
    listOfficialOffers: async ({ query, page }) => service.views.officialList(query, page),
    /** POST /official/offers: Create an Official Store offer linked to a company stock item */
    createOfficialOffer: async ({ body, principal, actor, requestId }) => detail((await service.manage.createOfficialOffer(body, { actor, requestId, principal })).id),
    /** PATCH /official/offers/{id}: Edit Official Store offer terms (not price; use price changes) */
    updateOfficialOffer: async ({ params, body, principal, actor, requestId }) => detail((await service.manage.updateOfficial(params.id, body, { actor, requestId, principal })).id),
    /** POST /official/offers/{id}/publish: Publish an Official Store offer */
    publishOfficialOffer: async ({ params, principal, actor, requestId }) => detail((await service.manage.publishOfficial(params.id, { actor, requestId, principal })).id),
    /** POST /official/offers/{id}/pause: Hide an Official Store offer */
    pauseOfficialOffer: async ({ params, body, principal, actor, requestId }) => detail((await service.manage.officialStatus(params.id, 'pause', body.reason, { actor, requestId, principal })).id),
    /** POST /official/offers/{id}/resume: Show a hidden Official Store offer again */
    resumeOfficialOffer: async ({ params, principal, actor, requestId }) => detail((await service.manage.officialStatus(params.id, 'resume', null, { actor, requestId, principal })).id),
    /** POST /official/offers/{id}/price-changes: Change an Official Store price (now or scheduled) with a reason */
    requestOfficialPriceChange: async ({ params, body, principal, actor, requestId }) => (await service.pricing.toPriceChanges([await service.pricing.requestOfficial(params.id, body, { actor, requestId, principal })]))[0]!,
    /** GET /price-changes: Pending, scheduled and recent price changes */
    listPriceChanges: async ({ query, page }) => service.pricing.listChanges(query, page),
    /** POST /price-changes/{id}/cancel: Cancel a scheduled or pending price change */
    cancelPriceChange: async ({ params, body, principal, actor, requestId }) => (await service.pricing.toPriceChanges([await service.pricing.cancel(params.id, body.reason, { actor, requestId, principal })]))[0]!,
    /** POST /official/bulk-updates: Upload an Official Store price file for preview */
    createOfficialBulkUpdate: async ({ body, principal, actor, requestId }) => service.bulk.create(official, body.fileId, { actor, requestId, principal }, body.reason),
    /** GET /official/bulk-updates/{id}: Official Store bulk job state and totals */
    getOfficialBulkUpdate: async ({ params }) => service.bulk.get(official, params.id),
    /** GET /official/bulk-updates/{id}/rows: Official Store bulk preview rows */
    listOfficialBulkUpdateRows: async ({ params, query, page }) => service.bulk.rows(official, params.id, query.result, page),
    /** POST /official/bulk-updates/{id}/apply: Apply valid rows; rows above the price-change limit become approval requests */
    applyOfficialBulkUpdate: async ({ params, principal, actor, requestId }) => service.bulk.apply(official, params.id, { actor, requestId, principal }),
    /** GET /featured-rule: Current, scheduled and past versions of the featured-offer rule */
    getFeaturedRuleAdmin: async () => service.featured.ruleAdmin(),
    /** POST /featured-rule/versions: Publish a new version of the featured-offer rule with an effective date */
    publishFeaturedRule: async ({ body, principal, actor, requestId }) => service.featured.publishRule(body, { actor, requestId, principal }),
    /** GET /products/{productId}/featured-decision: Why an offer is (or is not) featured for a variant and location */
    explainFeaturedOffer: async ({ params, query }) => service.featured.explain(params.productId, query.variantId, query.postalCode, query.conditionGroup ?? 'new'),
    /** POST /featured-decisions/recompute: Recompute featured decisions for a product (or everything) */
    recomputeFeatured: async ({ body, principal, actor, requestId }) => service.featured.queueRecompute(body?.productId ?? null, { actor, requestId, principal }),
  });
};
