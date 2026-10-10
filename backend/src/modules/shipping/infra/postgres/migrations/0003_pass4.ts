import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4, each backfilled from where the data lived:
 * - labels.kind, return_id and qr_code, kept until now as JSON in labels.storage_key ({ asset, qr, kind, returnId,
 *   … }); storage_key becomes the plain media asset id (nullable). Labels without the JSON take kind and return
 *   from their shipment. Carrier and service names come from labels.carrier_service_id.
 * - exceptions.order_item_ids: the items of the package (its shipment lines) when the exception has one, else none
 *   (a group-wide exception); exceptions.owner_role: split off owner_name, which kept "Name, Role".
 */
const UUID = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;

export const m0003Pass4: Migration = {
  id: '0003_pass4',
  sql: /* sql */ `
alter table shipping.labels add column kind text;
alter table shipping.labels add column return_id uuid;
alter table shipping.labels add column qr_code text;
alter table shipping.labels alter column storage_key drop not null;

update shipping.labels l set
  kind = case when m.j->>'kind' in ('outbound', 'replacement', 'return') then m.j->>'kind' end,
  return_id = case when m.j->>'returnId' ~ ${UUID} then (m.j->>'returnId')::uuid end,
  qr_code = nullif(m.j->>'qr', ''),
  storage_key = nullif(m.j->>'asset', '')
from (select id, storage_key::jsonb as j from shipping.labels where storage_key like '{%') m
where m.id = l.id;
update shipping.labels l set kind = coalesce(l.kind, case when s.kind in ('outbound', 'replacement', 'return') then s.kind end), return_id = coalesce(l.return_id, s.return_id)
from shipping.shipments s where s.id = l.shipment_id;
update shipping.labels set kind = 'outbound' where kind is null;
update shipping.labels set storage_key = null where storage_key = '';
alter table shipping.labels alter column kind set not null;
alter table shipping.labels add constraint labels_kind_check check (kind in ('outbound', 'replacement', 'return'));
comment on column shipping.labels.storage_key is 'media asset id of the label file; null when it could not be stored, the label link then points to the seller center';
comment on column shipping.labels.return_id is 'return labels';
comment on column shipping.labels.qr_code is 'return labels with labelMethod prepaid_qr: the code scanned at drop-off, Label.qrCodeUrl';

alter table shipping.exceptions add column order_item_ids uuid[] not null default '{}';
update shipping.exceptions e set order_item_ids = coalesce((select array_agg(distinct l.order_item_id) from shipping.shipment_lines l where l.shipment_id = e.shipment_id), '{}')
where e.shipment_id is not null;
alter table shipping.exceptions alter column order_item_ids drop default;
comment on column shipping.exceptions.order_item_ids is 'the order items the exception is about, as on shipping.shipment.exception';

alter table shipping.exceptions add column owner_role text;
update shipping.exceptions set owner_role = substring(owner_name from '^.*, (.+)$'), owner_name = substring(owner_name from '^(.*), .+$')
where owner_staff_id is not null and owner_name like '%, %';
comment on column shipping.exceptions.owner_role is 'the owner''s primary role label from access, ExceptionOwner.role';
`,
};
