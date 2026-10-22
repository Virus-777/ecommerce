/**
 * Software's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from the
 * spec exist, and is recorded in the kernel's migrations collection.
 */
import { randomBytes } from 'node:crypto';
import type { MongoMigration } from '../../kernel/mongo/schema.js';
import { devicesFromLabel, makeLicenceKey } from './domain/rules.js';

interface AppDoc {
  _id: string;
  free: boolean;
  licence_label?: string | null;
  licence_devices?: number | null;
}

interface EntitlementDoc {
  _id: string;
  app_id: string;
  licence_key?: string | null;
}

/**
 * Owner decision 2026-10-22: paid apps come with a licence key. Apps get licence_devices from their licence label
 * ("One-time purchase · 2 devices" → 2; none → not limited), and every entitlement of a paid app made before keys
 * existed gets its key now. Safe to run again: only rows without the field or the key are touched.
 */
export const licenceKeys: MongoMigration = {
  id: '2026-10-22-software-licence-keys',
  async up(db) {
    const apps = db.collection<AppDoc>('software.apps');
    const paid: string[] = [];
    for (const a of await apps.find({}, { projection: { _id: 1, free: 1, licence_label: 1, licence_devices: 1 } }).toArray()) {
      if (!a.free) paid.push(a._id);
      if (a.licence_devices === undefined) await apps.updateOne({ _id: a._id }, { $set: { licence_devices: a.free ? null : devicesFromLabel(a.licence_label) } });
    }
    if (!paid.length) return;
    const entitlements = db.collection<EntitlementDoc>('software.entitlements');
    const now = new Date();
    for (const e of await entitlements.find({ app_id: { $in: paid }, licence_key: null }, { projection: { _id: 1 } }).toArray()) {
      for (let i = 0; i < 10; i++) {
        const key = makeLicenceKey(randomBytes);
        if (await entitlements.findOne({ licence_key: key }, { projection: { _id: 1 } })) continue;
        await entitlements.updateOne({ _id: e._id, licence_key: null }, { $set: { licence_key: key, licence_issued_at: now } });
        break;
      }
    }
  },
};

export const mongoMigrations: readonly MongoMigration[] = [licenceKeys];
