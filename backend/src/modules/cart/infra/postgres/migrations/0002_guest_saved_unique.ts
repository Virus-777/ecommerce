import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * One saved row per guest session and offer (spec index unique (guest_session_id, offer_id)), so the
 * sign-in merge can move a guest's saved items without duplicates. Existing duplicates keep the most
 * recently saved row (ties: highest id) and the others are deleted first.
 */
export const m0002GuestSavedUnique: Migration = {
  id: '0002_guest_saved_unique',
  sql: /* sql */ `
delete from cart.saved_items s
using cart.saved_items k
where s.guest_session_id is not null
  and k.guest_session_id = s.guest_session_id
  and k.offer_id = s.offer_id
  and (k.saved_at > s.saved_at or (k.saved_at = s.saved_at and k.id > s.id));
create unique index saved_items_guest_offer on cart.saved_items (guest_session_id, offer_id);
`,
};
