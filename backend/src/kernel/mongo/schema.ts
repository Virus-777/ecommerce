/**
 * Collections, validators and indexes from the generated Mongoose schemas (docs/04-mongodb-migration.md §3). Applied
 * at startup outside production (MIGRATE_ON_START) and by `npm run migrate`; idempotent. Per collection: created with
 * its database validator (the backstop for writes that bypass Mongoose validation), the validator kept equal to the
 * spec, and the indexes synced to the schema (Model.syncIndexes: missing ones created, ones the schema no longer
 * declares dropped). A module whose definitions did not change since the last run is skipped (hash in
 * kernel.migrations), so a restart costs one read per module.
 *
 * Data changes (backfills, renames) are a module's `mongoMigrations`: { id, up(db) }, each run once, in order.
 */
import { createHash } from 'node:crypto';
import type { Model } from 'mongoose';
import type { CollectionDef } from '../spec/define.js';
import type { Db, ModuleSchemas, MongoStore } from './index.js';
import { kernelSchemas, type KernelCollection } from './schemas.js';

export interface MongoMigration {
  id: string;
  up(db: Db): Promise<void>;
}

export interface MongoUnit {
  module: string;
  collections: Readonly<Record<string, CollectionDef>>;
  schemas: ModuleSchemas;
  migrations?: readonly MongoMigration[];
}

async function ensureCollection(db: Db, model: Model<any>, validator: Record<string, unknown> | undefined, existing: Set<string>) {
  const name = model.collection.collectionName;
  if (!existing.has(name)) {
    await model.createCollection(validator ? { validator, validationLevel: 'strict', validationAction: 'error' } : {});
    existing.add(name);
  } else if (validator) {
    await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
  }
  await model.syncIndexes();
}

const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** Applies the kernel's and the modules' collections, then pending data migrations. Returns what ran. */
export async function migrateMongo(store: MongoStore, units: readonly MongoUnit[], log: (msg: string) => void = () => {}): Promise<string[]> {
  const db = store.db;
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const applied: string[] = [];
  const done = store.kernel('migrations');
  const recorded = async (id: string) => ((await done.findOne({ _id: id }, null, { lean: true }).catch(() => null)) as { hash?: string } | null) ?? undefined;

  const kernelHash = hashOf(Object.fromEntries(Object.entries(kernelSchemas).map(([n, s]) => [n, [s.obj, s.indexes()]])));
  if ((await recorded('kernel/schema'))?.hash !== kernelHash) {
    for (const name of Object.keys(kernelSchemas) as KernelCollection[]) await ensureCollection(db, store.kernel(name), undefined, existing);
    await done.updateOne({ _id: 'kernel/schema' }, { $set: { hash: kernelHash, at: new Date() } }, { upsert: true });
    applied.push('kernel/schema');
  }

  for (const unit of units) {
    const hash = hashOf(unit.collections);
    if ((await recorded(`${unit.module}/schema`))?.hash !== hash) {
      for (const [table, def] of Object.entries(unit.collections)) {
        const schema = unit.schemas[table];
        if (!schema) throw new Error(`${unit.module}: no Mongoose schema for ${table} (npm run gen)`);
        await ensureCollection(db, store.model(`${unit.module}.${table}`, schema), def.validator as Record<string, unknown>, existing);
      }
      await done.updateOne({ _id: `${unit.module}/schema` }, { $set: { hash, at: new Date() } }, { upsert: true });
      applied.push(`${unit.module}/schema`);
      log(`schema ${unit.module}: ${Object.keys(unit.collections).length} collections`);
    }
    for (const m of unit.migrations ?? []) {
      const id = `${unit.module}/${m.id}`;
      if (await recorded(id)) continue;
      await m.up(db);
      await done.create({ _id: id, at: new Date() });
      applied.push(id);
      log(`migrated ${id}`);
    }
  }
  return applied;
}
