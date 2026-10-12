/**
 * Install seed (applied on boot, insert-if-absent): the launch placements and the first version of the global
 * rules (version 1, by
 * 'system', dated 2026-01-01). Placements and rules edited later through the API are never overwritten.
 */
import type { PlacementRec, RulesRec } from '../ports.js';
import { DEFAULT_RULES, PLACEMENT_SEEDS } from './rules.js';

const SEEDED_AT = new Date('2026-01-01T00:00:00Z');

export const placementSeedRows = (): PlacementRec[] =>
  PLACEMENT_SEEDS.map(
    (p) =>
      ({
        id: p.id,
        key: p.key,
        name: p.name,
        kind: p.kind,
        enabled: p.enabled,
        availability: p.availability,
        eligible_pages: p.eligiblePages,
        formats: p.formats,
        frequency_cap: p.frequencyCap,
        trigger: p.trigger,
        rotation: p.rotation,
        dismissal: p.dismissal,
        max_per_page: p.maxPerPage ?? null,
        positions: p.positions,
        label: p.label,
        description: p.description,
        version: 1,
        updated_by: 'system',
        updated_at: SEEDED_AT,
      }) as unknown as PlacementRec,
  );

export const rulesSeedRow = (): RulesRec =>
  ({ version: 1, rules: { ...DEFAULT_RULES, state: 'approved' }, effective_at: SEEDED_AT, approval_request_id: null, created_by: 'system', created_at: SEEDED_AT }) as unknown as RulesRec;
