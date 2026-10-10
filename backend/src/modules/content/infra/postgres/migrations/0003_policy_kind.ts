import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4: a policy's key is its URL slug and no longer doubles as its kind. policies.kind holds what the policy
 * governs (returns, shipping, privacy, purchase_terms, seller_rules, advertising, cookies, other), so several
 * policies can be of kind other. Backfill: until now the key could only be one of the kinds, so kind = key
 * (anything else, which the old validation never let in, becomes other).
 */
export const m0003PolicyKind: Migration = {
  id: '0003_policy_kind',
  sql: /* sql */ `
alter table content.policies add column kind text;
update content.policies
   set kind = case when key in ('returns', 'shipping', 'privacy', 'purchase_terms', 'seller_rules', 'advertising', 'cookies', 'other') then key else 'other' end;
alter table content.policies alter column kind set not null;
alter table content.policies add constraint policies_kind_check check (kind in ('returns', 'shipping', 'privacy', 'purchase_terms', 'seller_rules', 'advertising', 'cookies', 'other'));
comment on column content.policies.key is 'URL slug';
`,
};
