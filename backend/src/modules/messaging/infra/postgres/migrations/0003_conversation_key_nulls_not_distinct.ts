import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * The conversation key (spec table conversations) is now
 * `unique nulls not distinct (kind, customer_id, seller_id, application_id, order_id, order_item_id, return_id, case_id)`.
 * The old index left out kind, application_id and case_id and counted nulls as distinct, so two rows could share
 * a key (two Seller Center threads about the same seller account, two threads on a whole order). Before the index
 * is built, every duplicate is folded into the oldest row of its key (created_at, then id):
 *   - participants move to it (unread counts add up; someone already there keeps their row),
 *   - messages, reports and staff access log entries move to it (a client message id that would repeat for the
 *     same author is cleared on the moved message),
 *   - its last_message_at becomes the latest of the group, and the duplicate rows are deleted.
 */
export const m0003ConversationKeyNullsNotDistinct: Migration = {
  id: '0003_conversation_key_nulls_not_distinct',
  sql: /* sql */ `
create temporary table conversation_dupes on commit drop as
select id, keeper from (
  select id, first_value(id) over w as keeper, row_number() over w as n
  from messaging.conversations
  window w as (partition by kind, customer_id, seller_id, application_id, order_id, order_item_id, return_id, case_id order by created_at, id)
) r
where n > 1;

insert into messaging.participants (conversation_id, kind, participant_id, name, label, joined_at, joined_from_case_id, last_read_message_id, unread_count)
select distinct on (d.keeper, p.kind, p.participant_id)
  d.keeper, p.kind, p.participant_id, p.name, p.label, p.joined_at, p.joined_from_case_id, p.last_read_message_id,
  (sum(p.unread_count) over (partition by d.keeper, p.kind, p.participant_id))::int
from messaging.participants p
join conversation_dupes d on d.id = p.conversation_id
order by d.keeper, p.kind, p.participant_id, p.joined_at
on conflict (conversation_id, kind, participant_id) do update
  set unread_count = messaging.participants.unread_count + excluded.unread_count,
      joined_at = least(messaging.participants.joined_at, excluded.joined_at);
delete from messaging.participants p using conversation_dupes d where p.conversation_id = d.id;

with grouped as (
  select m.id,
    row_number() over (partition by coalesce(d.keeper, m.conversation_id), m.author_id, m.client_message_id order by (d.id is not null), m.at, m.id) as n
  from messaging.messages m
  left join conversation_dupes d on d.id = m.conversation_id
  where m.client_message_id is not null
    and (d.id is not null or m.conversation_id in (select keeper from conversation_dupes))
)
update messaging.messages m set client_message_id = null from grouped g where g.id = m.id and g.n > 1;
update messaging.messages m set conversation_id = d.keeper from conversation_dupes d where m.conversation_id = d.id;
update messaging.message_reports r set conversation_id = d.keeper from conversation_dupes d where r.conversation_id = d.id;
update messaging.staff_access_log l set conversation_id = d.keeper from conversation_dupes d where l.conversation_id = d.id;

update messaging.conversations k set last_message_at = s.last_message_at
from (
  select d.keeper, max(c.last_message_at) as last_message_at
  from conversation_dupes d join messaging.conversations c on c.id = d.id
  group by d.keeper
) s
where k.id = s.keeper and s.last_message_at > k.last_message_at;
delete from messaging.conversations c using conversation_dupes d where c.id = d.id;

do $$
declare idx text;
begin
  for idx in
    select i.relname from pg_index x join pg_class i on i.oid = x.indexrelid
    where x.indrelid = 'messaging.conversations'::regclass and x.indisunique and not x.indisprimary
  loop
    execute format('drop index messaging.%I', idx);
  end loop;
end $$;
create unique index conversations_key_idx on messaging.conversations (kind, customer_id, seller_id, application_id, order_id, order_item_id, return_id, case_id) nulls not distinct;
`,
};
