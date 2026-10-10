import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Pass 3 (spec table conversations, conversation_aliases):
 *  1. conversations.locked_by_enforcement_id: the trust lock_conversation enforcement that locked it (reversing that
 *     enforcement unlocks it).
 *  2. conversation_aliases: ids of duplicate conversations merged into another; lookups by an old id resolve to the
 *     kept conversation.
 *  3. Guests are keyed by the order, not the session (decision D-M2): the customer-side participant and messages of a
 *     guest conversation become the guest participant `order:<orderId>`; every guest conversation gets that participant.
 *  4. case_id is a link, not part of the key, except for support conversations: duplicates under the new keys are
 *     folded into the oldest (participants, messages, reports, access log move; the removed ids are recorded as aliases),
 *     and the kept conversations get their reply state, reply deadline and unread counts recomputed from the merged
 *     messages (the 0003 merge kept the oldest row's reply state as it was).
 *  5. Two partial unique keys replace the single one.
 */
export const m0004Pass3KeysGuestsAliases: Migration = {
  id: '0004_pass3_keys_guests_aliases',
  sql: /* sql */ `
alter table messaging.conversations add column locked_by_enforcement_id uuid;
create index on messaging.conversations (locked_by_enforcement_id) where locked_by_enforcement_id is not null;

create table messaging.conversation_aliases (
  old_id uuid primary key,
  conversation_id uuid not null references messaging.conversations (id),
  merged_at timestamptz not null
);
create index on messaging.conversation_aliases (conversation_id);

-- 3. guests: one participant per order
with g as (
  select m.id, row_number() over (partition by m.conversation_id, m.client_message_id order by m.at, m.id) as n
  from messaging.messages m join messaging.conversations c on c.id = m.conversation_id
  where c.customer_id is null and c.order_id is not null and m.author_kind = 'customer' and m.client_message_id is not null
)
update messaging.messages m set client_message_id = null from g where g.id = m.id and g.n > 1;
update messaging.messages m set author_kind = 'guest', author_id = 'order:' || c.order_id
from messaging.conversations c
where m.conversation_id = c.id and c.customer_id is null and c.order_id is not null and m.author_kind = 'customer';
insert into messaging.participants (conversation_id, kind, participant_id, name, label, joined_at, joined_from_case_id, last_read_message_id, unread_count)
select c.id, 'guest', 'order:' || c.order_id,
  coalesce((select p.name from messaging.participants p where p.conversation_id = c.id and p.kind = 'customer' order by p.joined_at limit 1), 'Buyer'),
  'Buyer',
  coalesce((select min(p.joined_at) from messaging.participants p where p.conversation_id = c.id and p.kind = 'customer'), c.created_at),
  null,
  (select p.last_read_message_id from messaging.participants p where p.conversation_id = c.id and p.kind = 'customer' order by p.joined_at desc limit 1),
  coalesce((select min(p.unread_count) from messaging.participants p where p.conversation_id = c.id and p.kind = 'customer'), 0)
from messaging.conversations c
where c.customer_id is null and c.order_id is not null and c.kind in ('order', 'support')
on conflict (conversation_id, kind, participant_id) do nothing;
delete from messaging.participants p using messaging.conversations c
where p.conversation_id = c.id and c.customer_id is null and c.order_id is not null and p.kind = 'customer';

-- 4. duplicates under the new keys
create temporary table conversation_dupes_p3 on commit drop as
select id, keeper from (
  select id, first_value(id) over w as keeper, row_number() over w as n
  from messaging.conversations where kind <> 'support'
  window w as (partition by kind, customer_id, seller_id, application_id, order_id, order_item_id, return_id order by created_at, id)
) r where n > 1
union all
select id, keeper from (
  select id, first_value(id) over w as keeper, row_number() over w as n
  from messaging.conversations where kind = 'support'
  window w as (partition by kind, customer_id, order_id, case_id order by created_at, id)
) r where n > 1;

insert into messaging.participants (conversation_id, kind, participant_id, name, label, joined_at, joined_from_case_id, last_read_message_id, unread_count)
select distinct on (d.keeper, p.kind, p.participant_id)
  d.keeper, p.kind, p.participant_id, p.name, p.label, p.joined_at, p.joined_from_case_id, p.last_read_message_id, 0
from messaging.participants p
join conversation_dupes_p3 d on d.id = p.conversation_id
order by d.keeper, p.kind, p.participant_id, p.joined_at
on conflict (conversation_id, kind, participant_id) do update
  set joined_at = least(messaging.participants.joined_at, excluded.joined_at),
      joined_from_case_id = coalesce(messaging.participants.joined_from_case_id, excluded.joined_from_case_id);
delete from messaging.participants p using conversation_dupes_p3 d where p.conversation_id = d.id;

with grouped as (
  select m.id,
    row_number() over (partition by coalesce(d.keeper, m.conversation_id), m.author_id, m.client_message_id order by (d.id is not null), m.at, m.id) as n
  from messaging.messages m
  left join conversation_dupes_p3 d on d.id = m.conversation_id
  where m.client_message_id is not null
    and (d.id is not null or m.conversation_id in (select keeper from conversation_dupes_p3))
)
update messaging.messages m set client_message_id = null from grouped g where g.id = m.id and g.n > 1;
update messaging.messages m set conversation_id = d.keeper from conversation_dupes_p3 d where m.conversation_id = d.id;
update messaging.message_reports r set conversation_id = d.keeper from conversation_dupes_p3 d where r.conversation_id = d.id;
update messaging.staff_access_log l set conversation_id = d.keeper from conversation_dupes_p3 d where l.conversation_id = d.id;

create temporary table conversation_merged_p3 on commit drop as
select d.keeper, max(c.last_message_at) as last_message_at, (array_agg(c.case_id order by c.created_at) filter (where c.case_id is not null))[1] as case_id,
  -- the reply deadlines the duplicates were waiting on (kept when the merged waiting round started there)
  array_agg(c.awaiting_since) filter (where c.awaiting_since is not null and c.reply_due_at is not null) as waits,
  array_agg(c.reply_due_at) filter (where c.awaiting_since is not null and c.reply_due_at is not null) as dues
from conversation_dupes_p3 d join messaging.conversations c on c.id = d.id
group by d.keeper;

insert into messaging.conversation_aliases (old_id, conversation_id, merged_at)
select id, keeper, now() from conversation_dupes_p3
on conflict (old_id) do nothing;
-- aliases that pointed at a row merged now follow it
update messaging.conversation_aliases a set conversation_id = d.keeper from conversation_dupes_p3 d where a.conversation_id = d.id;
delete from messaging.conversations c using conversation_dupes_p3 d where c.id = d.id;

-- the kept row: latest activity, and the case as a link (after the duplicates are gone, so the old key cannot collide)
update messaging.conversations k set
  last_message_at = greatest(k.last_message_at, s.last_message_at),
  case_id = coalesce(k.case_id, s.case_id)
from conversation_merged_p3 s
where k.id = s.keeper;

-- reply state of the kept conversations, from the merged messages (the Official Store's reply is a staff message)
with k as (select distinct keeper as id from conversation_dupes_p3),
replies as (
  select c.id,
    max(m.at) filter (where m.kind = 'text' and ((c.seller_id = '00000000-0000-7000-8000-000000000001' and m.author_kind = 'staff') or (c.seller_id <> '00000000-0000-7000-8000-000000000001' and m.author_kind = 'seller'))) as last_reply
  from messaging.conversations c
  join k on k.id = c.id
  left join messaging.messages m on m.conversation_id = c.id
  where c.kind = 'order' and c.seller_id is not null
  group by c.id
),
waiting as (
  select r.id, r.last_reply, min(m.at) as first_wait
  from replies r
  left join messaging.messages m on m.conversation_id = r.id and m.kind = 'text' and m.author_kind in ('customer', 'guest') and (r.last_reply is null or m.at > r.last_reply)
  group by r.id, r.last_reply
),
due as (
  select w.id, w.last_reply, w.first_wait,
    case
      when w.first_wait is null then null
      when c.awaiting_since = w.first_wait and c.reply_due_at is not null then c.reply_due_at
      when s.waits is not null and w.first_wait = any (s.waits) then s.dues[array_position(s.waits, w.first_wait)]
      else w.first_wait + interval '24 hours'
    end as due_at
  from waiting w
  join messaging.conversations c on c.id = w.id
  left join conversation_merged_p3 s on s.keeper = w.id
)
update messaging.conversations c set
  awaiting_since = x.first_wait,
  reply_due_at = x.due_at,
  reply_state = case
    when x.first_wait is null then (case when x.last_reply is null then 'none' else 'replied' end)
    when x.due_at < now() then 'overdue'
    else 'awaiting_seller' end
from due x
where x.id = c.id;

-- unread counts of the kept conversations, from each participant's read marker
update messaging.participants p set unread_count = (
  select count(*)::int from messaging.messages m
  where m.conversation_id = p.conversation_id
    and not (coalesce(m.author_kind, '') = p.kind and coalesce(m.author_id, '') = p.participant_id)
    and (p.last_read_message_id is null or (m.at, m.id) > (select lm.at, lm.id from messaging.messages lm where lm.id = p.last_read_message_id))
)
where p.conversation_id in (select keeper from conversation_dupes_p3);

-- 5. keys
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
create unique index conversations_key_idx on messaging.conversations (kind, customer_id, seller_id, application_id, order_id, order_item_id, return_id) nulls not distinct where kind <> 'support';
create unique index conversations_support_key_idx on messaging.conversations (kind, customer_id, order_id, case_id) nulls not distinct where kind = 'support';
`,
};
