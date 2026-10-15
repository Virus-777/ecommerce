/**
 * Offers' data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';
import { DEFAULT_RULE, OFFICIAL_TIE_REASON } from './domain/rules.js';
import { actorText } from './mappers.js';

interface RuleDoc {
  _id: number;
  parameters?: { tieBreakers?: string[] } & Record<string, unknown>;
  effective_from: Date;
}

/**
 * Owner decision G17b (2026-10-16): the lowest delivered total wins and the Official Store wins an exact tie. A new
 * install starts with that rule (DEFAULT_RULE). An install that already has rule versions gets it as a new version,
 * in force from now: the version in force keeps its dispatch standard, window and competing conditions, takes the new
 * wording and tie-breakers, and drops the delivery-day adjustment. Featured decisions made under the earlier version
 * keep it; the recompute job redoes them under the new one (rows on another rule version are recomputed).
 *
 * Safe to run again: it does nothing once any version lists the official_store tie-breaker.
 */
export const featuredRuleOfficialTie: MongoMigration = {
  id: '2026-10-16-featured-rule-official-tie',
  async up(db) {
    const rules = db.collection<RuleDoc>('offers.featured_rules');
    const rows = await rules.find({}).sort({ _id: 1 }).toArray();
    if (!rows.length) return; // a new install seeds DEFAULT_RULE on first use
    if (rows.some((r) => r.parameters?.tieBreakers?.includes('official_store'))) return;
    const now = new Date();
    // Staff already scheduled a later version (at most one can wait): it gets the Official Store tie-breaker first and
    // brings the decision in when it takes effect. A version inserted now would rank above it and keep it from ever
    // becoming current (the current rule is the highest version in force).
    const scheduled = rows.find((r) => r.effective_from > now);
    if (scheduled) {
      const tieBreakers = ['official_store', ...(scheduled.parameters?.tieBreakers ?? []).filter((t) => t !== 'official_store')];
      await rules.updateOne({ _id: scheduled._id }, { $set: { 'parameters.tieBreakers': tieBreakers } });
      return;
    }
    const inForce = rows.at(-1)!;
    await rules.insertOne({
      _id: inForce._id + 1,
      text: DEFAULT_RULE.text,
      steps: DEFAULT_RULE.steps,
      parameters: { ...DEFAULT_RULE.parameters, ...inForce.parameters, deliveryDayAdjustmentPct: 0, tieBreakers: [...DEFAULT_RULE.parameters.tieBreakers] },
      effective_from: now,
      reason: OFFICIAL_TIE_REASON,
      published_by: actorText({ kind: 'system', id: null }),
      published_at: now,
    } as never);
  },
};

export const mongoMigrations: readonly MongoMigration[] = [featuredRuleOfficialTie];
