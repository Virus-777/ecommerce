import type { Migration } from '../../../../../kernel/migrations/index.js';
import { createHash } from 'node:crypto';
import { CARRIER_CATALOG, DEFAULT_CARRIERS } from '../../../domain/tracking.js';

/** A stable RFC 4122 UUID (version 8 layout) from a name */
function stableId(name: string): string {
  const h = createHash('sha256').update(name).digest('hex').split('');
  h[12] = '8';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** A dollar-quoted SQL literal (tracking patterns hold backslashes and quotes) */
const lit = (s: string | null) => (s === null ? 'null' : `$q$${s}$q$`);

/**
 * Carriers and their services (decision D-S1) are defined by the carrier adapters and seeded here, so a fresh
 * database knows them before anything boots; staff only enable services and set transit (PATCH). Ids are stable
 * (derived from the code), and an existing row (seeded at boot before this migration) is kept.
 */
const carrierSeed = DEFAULT_CARRIERS.map((code) => {
  const def = CARRIER_CATALOG[code]!;
  const carrier = `insert into shipping.carriers (id, code, name, account_label, status, tracking_mode, credentials_ref, contacts, last_event_at, on_time_rate_30d)
values ('${stableId(`shipping.carrier:${code}`)}', ${lit(code)}, ${lit(def.name)}, ${lit(`Marketly ${def.name} account`)}, 'active', 'webhook', ${lit(`carrier/${code}`)}, '[]'::jsonb, null, null)
on conflict (code) do nothing;`;
  const services = def.services.map(
    (s) => `insert into shipping.carrier_services (id, carrier_id, code, name, transit_min, transit_max, enabled, label_supported, tracking_pattern)
select '${stableId(`shipping.carrier_service:${code}:${s.code}`)}', c.id, ${lit(s.code)}, ${lit(s.name)}, ${s.transit.min}, ${s.transit.max}, true, ${s.labelSupported}, ${lit(s.trackingPattern)}
from shipping.carriers c where c.code = ${lit(code)}
on conflict (carrier_id, code) do nothing;`,
  );
  return [carrier, ...services].join('\n');
}).join('\n');

/**
 * Gap pass 3:
 * - labels: billed_to customer (the customer pays a return label; returns deducts it from the refund), drop_off_by
 *   (the return's drop-off deadline from returns, never invented here).
 * - seller_settings.ships_from: the city and state a seller ships from, read in one query for storefront summaries.
 * - exceptions: one open exception per (group, kind, package) (decision D-S3); exceptions without a package stay
 *   one per group and kind (nulls not distinct).
 * - carriers and carrier services seeded (decision D-S1).
 */
export const m0002Pass3: Migration = {
  id: '0002_pass3',
  sql: /* sql */ `
alter table shipping.labels drop constraint if exists labels_billed_to_check;
alter table shipping.labels add constraint labels_billed_to_check check (billed_to in ('seller', 'company', 'platform', 'customer'));
alter table shipping.labels add column drop_off_by timestamptz;
update shipping.labels set drop_off_by = (storage_key::jsonb->>'dropOffBy')::timestamptz
  where storage_key like '{%' and storage_key::jsonb ? 'dropOffBy' and storage_key::jsonb->>'dropOffBy' is not null;

alter table shipping.seller_settings add column ships_from text;

drop index if exists shipping.exceptions_group_id_kind_idx;
create unique index exceptions_one_open_per_package on shipping.exceptions (group_id, kind, shipment_id) nulls not distinct where status in ('open','in_progress','escalated');

${carrierSeed}
`,
};
