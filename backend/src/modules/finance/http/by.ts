import type { Principal } from '../../../kernel/auth/index.js';
import type * as common from '../../../spec/common.js';
import type { By } from '../service/core.js';

/** Who acts, from a handler's input */
export const byOf = (i: { actor: common.Actor; requestId: string; principal: Principal | null; can(permission: string): Promise<boolean> }): By => ({ actor: i.actor, requestId: i.requestId, principal: i.principal, can: (p) => i.can(p) });
