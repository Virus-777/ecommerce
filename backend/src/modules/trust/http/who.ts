/** The caller as the trust use cases see it: reporter, appellant, the party an enforcement affects */
import type { Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import type * as common from '../../../spec/common.js';
import type { By } from '../service/core.js';
import type { Reporter } from '../service/reports.js';
import type { TrustService } from '../service.js';

interface Input {
  principal: Principal | null;
  scope: Scope;
  actor: common.Actor;
  requestId: string;
  can(permission: string): Promise<boolean>;
}

export const byOf = (i: Input): By => ({ actor: i.actor, requestId: i.requestId, principal: i.principal, can: (p) => i.can(p) });

/** A signed-in customer: stored under the customer id when customers knows it, else the account id */
export async function customerOf(service: TrustService, i: Input): Promise<Reporter> {
  const accountId = i.principal?.accountId ?? (i.scope.kind === 'customer' ? i.scope.accountId : null) ?? '';
  const customerId = i.scope.kind === 'customer' ? i.scope.customerId : null;
  const profile = customerId ? await service.core.soft('customers', 'getCustomer', (c) => c.getCustomer(customerId)) : undefined;
  return {
    kind: 'customer',
    id: customerId ?? accountId,
    ids: [...new Set([customerId, accountId].filter((x): x is string => !!x))],
    name: profile?.displayName ?? null,
    mediaOwner: { kind: 'customer', id: accountId || null },
    customerId,
    actor: i.actor,
  };
}

export async function sellerOf(service: TrustService, i: Input & { sellerId: string }): Promise<Reporter> {
  const seller = await service.core.soft('sellers', 'getSeller', (s) => s.getSeller(i.sellerId));
  return {
    kind: 'seller',
    id: i.sellerId,
    ids: [i.sellerId],
    name: seller?.storeName ?? null,
    mediaOwner: { kind: 'seller', id: i.sellerId },
    sellerId: i.sellerId,
    actor: i.actor,
  };
}

export const appellantOf = (r: Reporter) => ({ kind: r.kind, ids: r.ids, id: r.id, name: r.name ?? (r.kind === 'seller' ? 'Seller' : 'Customer'), actor: r.actor, mediaOwner: r.mediaOwner });
