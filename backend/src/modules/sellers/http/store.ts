import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/sellers.js';
import type { SellersService } from '../service.js';

/**
 * Store API: /api/store/sellers/…  (docs/api/modules/sellers.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 * Applicants act for their own member account (principal.accountId), never an id from the body.
 */
export const storeRoutes = (service: SellersService) => {
  const apps = service.applications;
  return routes(endpoints, 'store', {
    getSellerProgram: async ({ principal }) => apps.getSellerProgram(principal),
    startApplication: async ({ principal, body, actor, requestId }) => apps.startApplication(principal.accountId!, body, { actor, requestId, principal }),
    getMyApplication: async ({ principal }) => apps.getMyApplication(principal.accountId!),
    updateApplication: async ({ principal, params, body, actor, requestId }) => apps.updateApplication(principal.accountId!, params.id, body, { actor, requestId, principal }),
    addApplicationDocument: async ({ principal, params, body, actor, requestId }) => apps.addApplicationDocument(principal.accountId!, params.id, body, { actor, requestId, principal }),
    removeApplicationDocument: async ({ principal, params, actor, requestId }) => {
      await apps.removeApplicationDocument(principal.accountId!, params.id, params.documentId, { actor, requestId, principal });
    },
    submitApplication: async ({ principal, params, body, actor, requestId }) => apps.submitApplication(principal.accountId!, params.id, body, { actor, requestId, principal }),
    respondToInformationRequest: async ({ principal, params, body, actor, requestId }) => apps.respondToInformationRequest(principal.accountId!, params.id, body, { actor, requestId, principal }),
    saveInformationResponseDraft: async ({ principal, params, body }) => apps.saveResponseDraft(principal.accountId!, params.id, body.items),
    withdrawApplication: async ({ principal, params, body, actor, requestId }) => apps.withdrawApplication(principal.accountId!, params.id, body?.reason, { actor, requestId, principal }),
    appealApplicationDecision: async ({ principal, params, body, actor, requestId }) => apps.appealApplicationDecision(principal.accountId!, params.id, body, { actor, requestId, principal }),
    getStorefront: async ({ params }) => service.storefront.getStorefront(params.slug),
    getStorefrontCollection: async ({ params }) => service.storefront.getStorefrontCollection(params.slug, params.collectionId),
  });
};
