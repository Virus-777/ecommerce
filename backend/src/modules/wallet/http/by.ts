import { AppError } from '../../../kernel/errors/index.js';
import type { Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import type * as common from '../../../spec/common.js';
import type { By } from '../service.js';

/** Who acts, from a handler's input */
export const byOf = (i: { actor: common.Actor; requestId: string; principal: Principal | null }): By => ({ actor: i.actor, requestId: i.requestId, principal: i.principal });

/** The signed-in customer's own wallet: the customer record id (record scope comes from the token, never the request) */
export function ownCustomer(scope: Scope): string | null {
  if (scope.kind !== 'customer') throw new AppError('NOT_FOUND', 'Store credit not found');
  return scope.customerId;
}

/** Gift card lookups are counted per caller: the customer, else the visitor session */
export function callerKey(scope: Scope, principal: Principal | null): string {
  if (scope.kind === 'customer') return `customer:${scope.customerId ?? scope.accountId}`;
  if (scope.kind === 'visitor') return `visitor:${scope.visitorSessionId}`;
  return `session:${principal?.sessionId ?? 'unknown'}`;
}
