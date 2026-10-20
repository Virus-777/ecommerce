/**
 * Finance's data migrations (module.ts mongoMigrations): each runs once per database, after the collections from
 * the spec exist, and is recorded in the kernel's migrations collection.
 */
import type { MongoMigration } from '../../kernel/mongo/schema.js';
import { detId } from './domain/rules.js';

/**
 * fee_charges.changed_at (2026-10-21, docs/09 §3.2): reports pulls the fees changed since its last run by this
 * column. Charges written before it existed get their created_at, so a full pull (a rebuild) reads them too.
 *
 * Safe to run again: it only touches charges that still have no changed_at.
 */
export const feeChargesChangedAt: MongoMigration = {
  id: '2026-10-21-fee-charges-changed-at',
  async up(db) {
    await db.collection('finance.fee_charges').updateMany({ changed_at: null }, [{ $set: { changed_at: '$created_at' } }]);
  },
};

/**
 * The cost of goods sold of Official Store sales (2026-10-21): finance now books a cost_of_goods trading entry with
 * each Official Store sale. Sales booked before get a placeholder (amount 0, ref_kind cost_pending) with the id the
 * cost row would have had; LedgerPart.fillPendingCosts fills it after boot from orders and inventory (a migration
 * sees only the database, and finance reads other modules only through their public APIs).
 *
 * Runs once (kernel.migrations). Safe to run again: a placeholder is only inserted where no cost row with that id
 * exists; a run after the fill queues the sales that stayed uncosted again, and the next fill resolves them the same way.
 */
/** A trading_entries document as stored (the id in _id) */
type TradingDoc = { _id: string; at: Date; kind: string; amount: number; currency: string; order_id: string | null; order_item_id: string | null; variant_id: string | null; ref_kind: string | null; ref_id: string | null };

export const costOfGoodsPending: MongoMigration = {
  id: '2026-10-21-cost-of-goods-pending',
  async up(db) {
    const entries = db.collection<TradingDoc>('finance.trading_entries');
    const sales = entries.find({ kind: 'sale', ref_kind: 'order_item', order_item_id: { $ne: null }, amount: { $gt: 0 } });
    let batch: Parameters<typeof entries.bulkWrite>[0][number][] = [];
    for await (const sale of sales) {
      // the id LedgerPart.onOrderAccepted gives the cost row: detId('trading:cost_of_goods:<item>')
      const id = detId(`trading:cost_of_goods:${sale.order_item_id}`);
      const placeholder: Omit<TradingDoc, '_id'> = { kind: 'cost_of_goods', amount: 0, currency: sale.currency, at: sale.at, order_id: sale.order_id, order_item_id: sale.order_item_id, variant_id: sale.variant_id, ref_kind: 'cost_pending', ref_id: sale.order_item_id };
      batch.push({ updateOne: { filter: { _id: id }, update: { $setOnInsert: placeholder }, upsert: true } });
      if (batch.length >= 500) {
        await entries.bulkWrite(batch, { ordered: false });
        batch = [];
      }
    }
    if (batch.length) await entries.bulkWrite(batch, { ordered: false });
  },
};

export const mongoMigrations: readonly MongoMigration[] = [feeChargesChangedAt, costOfGoodsPending];
