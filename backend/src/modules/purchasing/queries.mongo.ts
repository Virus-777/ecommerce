/**
 * The MongoDB half of purchasing's queries port (queries.ts): the two performance pipelines and the one
 * `$expr` comparison, moved here as they were from repository.ts. Nothing in them is new, and at the cutover
 * this file is deleted whole (Y4).
 */
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { PurchasingDb } from '../../spec/purchasing.js';
import type { DeliveryPerformance, PurchasingQueries, ReceiptPerformance } from './queries.js';

type T<K extends keyof PurchasingDb> = PurchasingDb[K];

export function mongoPurchasingQueries(store: ModuleStore): PurchasingQueries {
  const deliveries = store.table<T<'deliveries'>>('deliveries');
  const receipts = store.table<T<'receipts'>>('receipts');
  const receiptLines = store.table<T<'receipt_lines'>>('receipt_lines');
  const pos = store.table<T<'purchase_orders'>>('purchase_orders');

  return {
    async deliveryPerformance(since: Date): Promise<DeliveryPerformance[]> {
      const rows = await deliveries.aggregate<{ _id: string; deliveries: number; on_time: number; lead_ms: number; lead_n: number }>([
        { $match: { arrived_at: { $gte: since } } },
        { $lookup: { from: pos.name, localField: 'purchase_order_id', foreignField: '_id', as: 'po' } },
        { $unwind: '$po' },
        {
          $group: {
            _id: '$po.supplier_id',
            deliveries: { $sum: 1 },
            on_time: { $sum: { $cond: [{ $lte: ['$arrived_at', '$window_to'] }, 1, 0] } },
            lead_ms: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$po.sent_at', null] }, null] }, 0, { $subtract: ['$arrived_at', '$po.sent_at'] }] } },
            lead_n: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$po.sent_at', null] }, null] }, 0, 1] } },
          },
        },
      ]);
      return rows.map((r) => ({ supplierId: r._id, deliveries: Number(r.deliveries), onTime: Number(r.on_time), leadTimeMsTotal: Number(r.lead_ms), leadTimeCount: Number(r.lead_n) }));
    },

    async receiptPerformance(since: Date, statuses: readonly string[]): Promise<ReceiptPerformance[]> {
      const rows = await receipts.aggregate<{ _id: string; expected: number; received: number; shortage: number; damaged: number }>([
        { $match: { status: { $in: [...statuses] }, submitted_at: { $gte: since } } },
        { $lookup: { from: pos.name, localField: 'purchase_order_id', foreignField: '_id', as: 'po' } },
        { $unwind: '$po' },
        { $lookup: { from: receiptLines.name, localField: '_id', foreignField: 'receipt_id', as: 'l' } },
        { $unwind: '$l' },
        {
          $group: {
            _id: '$po.supplier_id',
            expected: { $sum: '$l.expected' },
            received: { $sum: '$l.received' },
            shortage: { $sum: { $max: [{ $subtract: ['$l.expected', '$l.received'] }, 0] } },
            damaged: { $sum: '$l.damaged' },
          },
        },
      ]);
      return rows.map((r) => ({ supplierId: r._id, expected: Number(r.expected), received: Number(r.received), shortage: Number(r.shortage), damaged: Number(r.damaged) }));
    },

    receiptIdsWithIssues(): Promise<string[]> {
      // $expr is what MongoDB needs to compare two fields of the same document; SQL writes it as it reads
      return receiptLines.distinct<string>('receipt_id', { $or: [{ $expr: { $ne: ['$received', '$expected'] } }, { damaged: { $gt: 0 } }] });
    },
  };
}
