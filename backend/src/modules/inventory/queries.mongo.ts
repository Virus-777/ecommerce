/**
 * The MongoDB half of inventory's queries port (queries.ts): the three pipelines, moved here as they were from
 * repository.ts. Nothing in them is new, and at the cutover this file is deleted whole (Y4).
 *
 * The only addition is the one line each needs to take a *neutral* filter: `whereFilter` turns a `Where` into a
 * MongoDB filter and `table.filter` maps its row names onto document fields (`id` → `_id`), which is the same
 * pair the store facade uses for every ordinary read.
 */
import { whereFilter, type ModuleStore } from '../../kernel/mongo/index.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { Row } from './ports.js';
import type { InventoryQueries, StockQuantityFilter } from './queries.js';

export function mongoInventoryQueries(store: ModuleStore): InventoryQueries {
  const items = store.table<Row<'stock_items'>>('stock_items');
  const levels = store.table<Row<'stock_levels'>>('stock_levels');
  const locations = store.table<Row<'locations'>>('locations');
  const movements = store.table<Row<'stock_movements'>>('stock_movements');

  return {
    async itemIdsByQuantities(where: WhereWithOr<Row<'stock_items'>>, f: StockQuantityFilter): Promise<string[]> {
      // sellable rule (domain/rules sellsFrom): a seller item sells from its service location when set, else from
      // its own location; company stock from company locations
      const sellable = {
        $and: [
          '$$l.sellable',
          '$$l.active',
          {
            $cond: [
              { $eq: ['$owner_type', 'seller'] },
              { $cond: [{ $eq: [{ $ifNull: ['$service_location_id', null] }, null] }, { $eq: ['$$l.loc_owner', 'seller'] }, { $eq: ['$$l.loc_id', '$service_location_id'] }] },
              { $eq: ['$$l.loc_owner', 'official'] },
            ],
          },
        ],
      };
      const conditions: Record<string, unknown>[] = [];
      if (f.state) conditions.push({ _state: f.state });
      if (f.filter === 'low_or_out') conditions.push({ _state: { $ne: 'in_stock' } });
      if (f.filter === 'has_damaged_or_held') conditions.push({ _damaged: { $gt: 0 } });
      if (f.filter === 'has_returned') conditions.push({ _returned: { $gt: 0 } });
      if (f.filter === 'has_incoming') conditions.push({ _incoming: { $gt: 0 } });
      const rows = await items.aggregate<{ _id: string }>([
        { $match: items.filter(whereFilter(where as Readonly<Record<string, unknown>>)) },
        {
          $lookup: {
            from: levels.name,
            localField: '_id',
            foreignField: 'stock_item_id',
            as: 'lv',
            pipeline: [
              { $lookup: { from: locations.name, localField: 'location_id', foreignField: '_id', as: 'loc' } },
              { $unwind: '$loc' },
              { $project: { available: 1, damaged_held: 1, returned: 1, incoming: 1, loc_id: '$loc._id', sellable: '$loc.sellable', active: '$loc.active', loc_owner: '$loc.owner_type' } },
            ],
          },
        },
        {
          $addFields: {
            _sell: { $sum: { $map: { input: { $filter: { input: '$lv', as: 'l', cond: sellable } }, as: 'l', in: '$$l.available' } } },
            _damaged: { $sum: '$lv.damaged_held' },
            _returned: { $sum: '$lv.returned' },
            _incoming: { $sum: '$lv.incoming' },
            _threshold: { $ifNull: ['$low_stock_threshold', f.defaultThreshold] },
          },
        },
        {
          $addFields: {
            _state: {
              $switch: {
                branches: [
                  { case: { $lte: ['$_sell', 0] }, then: 'out_of_stock' },
                  { case: { $and: [{ $ne: ['$_threshold', null] }, { $lte: ['$_sell', '$_threshold'] }] }, then: 'low_stock' },
                ],
                default: 'in_stock',
              },
            },
          },
        },
        { $match: { $and: conditions } },
        { $project: { _id: 1 } },
      ]);
      return rows.map((r) => r._id);
    },

    async recentMovements(itemIds: readonly string[], limit: number): Promise<Row<'stock_movements'>[]> {
      if (!itemIds.length) return [];
      const docs = await movements.aggregate([
        { $match: { stock_item_id: { $in: [...itemIds] } } },
        { $sort: { at: -1, _id: -1 } },
        // the first `limit` of each item in that order
        { $group: { _id: '$stock_item_id', rows: { $firstN: { input: '$$ROOT', n: limit } } } },
        { $unwind: '$rows' },
        { $replaceRoot: { newRoot: '$rows' } },
        { $sort: { at: -1, _id: -1 } },
      ]);
      return docs.map((d) => movements.fromDoc(d));
    },

    async unitsByReasonSince(itemIds: readonly string[], since: Date, reasonCodes: readonly string[]): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      if (!itemIds.length || !reasonCodes.length) return out;
      const rows = await movements.aggregate<{ _id: string; n: number }>([
        { $match: { stock_item_id: { $in: [...itemIds] }, reason_code: { $in: [...reasonCodes] }, at: { $gte: since } } },
        { $group: { _id: '$stock_item_id', n: { $sum: '$quantity' } } },
      ]);
      for (const r of rows) out.set(r._id, Number(r.n));
      return out;
    },
  };
}
