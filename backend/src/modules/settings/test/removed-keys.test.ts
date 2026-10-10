/**
 * Settings migrations that drop keys a module removed from its spec. Fulfilled by Marketly (D12):
 * fulfillment-service.warehouseAddress goes (stored values and open change keys); other keys stay.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { migrations } from '../infra/postgres/migrations/index.js';
import { m0004RemovedFsWarehouseAddress } from '../infra/postgres/migrations/0004_removed_fs_warehouse_address.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});

const REMOVED = 'fulfillment-service.warehouseAddress';
const KEPT = 'fulfillment-service.serviceDispatchBusinessDays';

describe('migration 0004: fulfillment-service.warehouseAddress removed', () => {
  it('is the last settings migration', () => {
    expect(migrations.at(-1)).toBe(m0004RemovedFsWarehouseAddress);
  });

  it('a fresh install has nothing stored under the key', async () => {
    const db = h.app.kernel.database.kysely;
    const rows = await sql<{ n: number }>`select count(*)::int as n from settings.values where key = ${REMOVED}`.execute(db);
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('drops stored values and open change keys of the removed key on an existing install, idempotently, and keeps other keys', async () => {
    const db = h.app.kernel.database.kysely;
    const now = new Date();
    const changeId = newId();
    // an install from before the removal: both keys were registered (fulfillment-service is off here) and a change touched them
    for (const key of [REMOVED, KEPT]) {
      await sql`insert into settings.definitions (key, module, section, label, description, value_type, schema, default_value, editable, approval, min_lead_days, apply_scopes, seller_visible, public, example_value, edit_permission, registered_at, unavailable_since)
        values (${key}, 'fulfillment-service', 'fulfillment-service', ${key}, 'old', 'string', '{}'::jsonb, 'null'::jsonb, true, 'none', 0, '["new_only"]'::jsonb, false, false, false, 'settings.changes.propose', ${now}, ${now})
        on conflict (key) do nothing`.execute(db);
    }
    await sql`insert into settings.changes (id, ref, status, items, effective_at, apply_scope, reason, impact, created_by_kind, created_by_id, created_at, version)
      values (${changeId}, ${`SC-${changeId.slice(0, 8)}`}, 'applied', '[]'::jsonb, ${now}, 'new_only', 'old change', '{}'::jsonb, 'staff', 'someone', ${now}, 1)`.execute(db);
    for (const [key, value] of [
      [REMOVED, '"Marketly Fulfillment Center, 100 Dock Rd, Reno, NV"'],
      [KEPT, '2'],
    ] as const) {
      await sql`insert into settings.values (id, key, version, value, effective_from, effective_to, apply_scope, change_id, changed_by_kind, changed_by_id, approved_by_id, reason, created_at)
        values (${newId()}, ${key}, 1, ${value}::jsonb, ${now}, null, 'new_only', null, 'system', 'seed', null, 'old install', ${now})`.execute(db);
      await sql`insert into settings.change_keys (change_id, key, open) values (${changeId}, ${key}, false)`.execute(db);
    }
    await h.app.kernel.database.exec(m0004RemovedFsWarehouseAddress.sql!);
    await h.app.kernel.database.exec(m0004RemovedFsWarehouseAddress.sql!); // running it again changes nothing
    const count = async (table: 'values' | 'change_keys', key: string) =>
      (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(`settings.${table}`)} where key = ${key}`.execute(db)).rows[0]!.n;
    expect(await count('values', REMOVED)).toBe(0);
    expect(await count('change_keys', REMOVED)).toBe(0);
    expect(await count('values', KEPT)).toBe(1);
    expect(await count('change_keys', KEPT)).toBe(1);
  });
});
