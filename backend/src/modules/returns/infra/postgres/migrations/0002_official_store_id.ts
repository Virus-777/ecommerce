import type { Migration } from '../../../../../kernel/migrations/index.js';
import { OFFICIAL_STORE_ID } from '../../../../../spec/common.js';

/**
 * The Official Store's seller id is now the shared OFFICIAL_STORE_ID (spec common constants). Returns used
 * the nil uuid for EffectiveTerms.sellerId of Official Store terms; the terms frozen on returns keep that
 * id in terms_snapshot.terms.sellerId, so stored snapshots are rewritten to the shared id.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export const m0002OfficialStoreId: Migration = {
  id: '0002_official_store_id',
  sql: /* sql */ `
update returns.returns
   set terms_snapshot = jsonb_set(terms_snapshot, '{terms,sellerId}', to_jsonb('${OFFICIAL_STORE_ID}'::text))
 where terms_snapshot #>> '{terms,sellerId}' = '${NIL_UUID}';
`,
};
