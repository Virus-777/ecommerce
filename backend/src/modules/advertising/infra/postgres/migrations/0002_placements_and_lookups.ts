import type { Migration } from '../../../../../kernel/migrations/index.js';
import { DEFAULT_RULES, PLACEMENT_SEEDS } from '../../../domain/rules.js';

const q = (v: unknown) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const j = (v: unknown) => (v === null || v === undefined ? 'null' : `${q(JSON.stringify(v))}::jsonb`);

const placements = PLACEMENT_SEEDS.map(
  (p) =>
    `(${q(p.id)}, ${q(p.key)}, ${q(p.name)}, ${q(p.kind)}, ${p.enabled}, ${q(p.availability)}, ${j(p.eligiblePages)}, ${j(p.formats)}, ${j(p.frequencyCap)}, ${j(p.trigger)}, ${j(p.rotation)}, ${j(p.dismissal)}, ${p.maxPerPage ?? 'null'}, ${j(p.positions)}, ${q(p.label)}, ${q(p.description)}, 1, 'system', '2026-01-01T00:00:00Z')`,
).join(',\n  ');

/**
 * The launch placements (plan ch. 16/20: opening full-screen, banners, pop-ups; sponsored product as a pilot;
 * sponsored store/brand, floating, interstitial and video ship off), the first version of the global rules,
 * and lookup indexes for serving, attribution, timelines and billing.
 */
export const m0002PlacementsAndLookups: Migration = {
  id: '0002_placements_and_lookups',
  sql: /* sql */ `
insert into advertising.placements (id, key, name, kind, enabled, availability, eligible_pages, formats, frequency_cap, trigger, rotation, dismissal, max_per_page, positions, label, description, version, updated_by, updated_at) values
  ${placements}
on conflict (key) do nothing;
insert into advertising.global_rules (version, rules, effective_at, approval_request_id, created_by, created_at)
values (1, ${j({ ...DEFAULT_RULES, state: 'approved' })}, '2026-01-01T00:00:00Z', null, 'system', '2026-01-01T00:00:00Z')
on conflict (version) do nothing;
create index on advertising.ad_events (customer_id, kind, at) where customer_id is not null;
create index on advertising.ad_events (placement_key, kind, at);
create index on advertising.campaign_items (campaign_id);
create index on advertising.campaign_creatives (creative_id);
create index on advertising.approval_steps (campaign_id, submission);
create index on advertising.creative_reviews (creative_id, at);
create index on advertising.campaign_log (campaign_id, at);
create index on advertising.attributions (campaign_id, attributed_at);
create index on advertising.attributions (order_id);
create index on advertising.ad_charges (state, day);
create index on advertising.frequency_state (window_started_at);
`,
};
