/**
 * The MySQL half of inventory's queries port (queries.ts).
 *
 * - **`itemIdsByQuantities`** is the read §13.2 points at: the stock list's quantity filters, which MongoDB
 *   answers with a nested `$lookup` and `$map/$filter` sums. Here it is one `GROUP BY` with five conditional
 *   measures over **`inventory_v_stock_rows`** — §9.2's view of levels joined to their item and their location.
 *   Two things about how the view is used, each checked against this reader's real filter rather than assumed
 *   (the lesson `notifications_v_inbox` taught):
 *     - the join to it is a **LEFT** join from `inventory_stock_items`. The view is an inner join of levels to
 *       items, so an item with no level row at all is not in it — and such an item sums to zero units, which
 *       makes it `out_of_stock` and a match for the `state` and `low_or_out` filters. Reading the view alone
 *       would quietly drop exactly the items a low-stock list exists to show.
 *     - the view does not carry **`service_location_id`**, and the sellable rule needs it, so the item's own
 *       columns come from the left side. (It is the view's only missing column for this read; reported.)
 * - **`recentMovements`** is §13.1's "latest n rows per key": `ROW_NUMBER() OVER (PARTITION BY stock_item_id)`.
 * - **`unitsByReasonSince`** is a plain `SUM` per key, which is a `GROUP BY` and nothing more.
 *
 * The rows of the ledger come back through `Table.fromRow`, so the column→row conversion stays written once.
 */
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import type { ModuleStore } from '../../kernel/mysql/module-store.js';
import { whereSql, type Sql } from '../../kernel/mysql/where.js';
import type { WhereWithOr } from '../../kernel/store/index.js';
import type { InventoryTables } from '../../spec/inventory.js';
import type { Row } from './ports.js';
import type { InventoryQueries, StockQuantityFilter } from './queries.js';

/**
 * `inventory_v_stock_rows` (§9.2): one stock level, with its item's and its location's columns beside it. The
 * generator does not parse a view's SELECT list, so the module that reads a view declares its row type — and
 * writing it out is what makes the missing `service_location_id` a compile error rather than a wrong answer.
 */
interface StockRowsView extends Row<'stock_levels'> {
  owner_type: Row<'stock_items'>['owner_type'];
  seller_id: string | null;
  sku: string;
  offer_id: string | null;
  product_id: string;
  variant_id: string;
  condition: string;
  label: string;
  low_stock_threshold: number | null;
  reorder_quantity: number | null;
  unit_cost_amount: number | null;
  currency: string;
  primary_bin_code: string | null;
  low_since: Date | null;
  archived: boolean;
  location_code: string;
  location_name: string;
  location_kind: string;
  location_owner_type: string;
  sellable: boolean;
  location_active: boolean;
  location_is_default: boolean;
}

/** The two owner kinds the sellable rule compares against; bound as values, never written into the SQL text */
const SELLER = 'seller';
const OFFICIAL = 'official';
const IN_STOCK = 'in_stock';

/** A column of the view, and a column of the filtered items beside it: checked against the types above */
const sr = (column: keyof StockRowsView) => sql.ref(`sr.${column}`);
const si = (column: keyof Row<'stock_items'>) => sql.ref(`si.${column}`);

/**
 * A `{ sql, params }` fragment (kernel/mysql/where.ts) as a Kysely fragment: its `?` placeholders become
 * Kysely's own bound values, in order.
 *
 * `whereSql` never writes a value into the SQL text — every value it compares is bound — so every `?` in the
 * text is a placeholder and their number has to match the values. That is checked here rather than assumed: a
 * mismatch would silently shift every parameter after it. This is the second copy of this helper
 * (notifications/queries.mysql.ts has the first), which by §10.5f's own rule means it belongs in the kernel.
 */
function bound(fragment: Sql): RawBuilder<unknown> {
  const text = fragment.sql.split('?');
  if (text.length - 1 !== fragment.params.length) throw new Error(`inventory: a filter fragment with ${text.length - 1} placeholders for ${fragment.params.length} values`);
  const pieces: unknown[] = [sql.raw(text[0]!)];
  fragment.params.forEach((value, i) => pieces.push(sql.val(value), sql.raw(text[i + 1]!)));
  return sql.join(pieces, sql.raw(''));
}

export function mysqlInventoryQueries(store: ModuleStore<InventoryTables>): InventoryQueries {
  const items = store.table<Row<'stock_items'>>('stock_items');
  const movements = store.table<Row<'stock_movements'>>('stock_movements');
  const db = store.db.withTables<{ inventory_v_stock_rows: StockRowsView }>();

  return {
    async itemIdsByQuantities(where: WhereWithOr<Row<'stock_items'>>, f: StockQuantityFilter): Promise<string[]> {
      // the same reading of a filter the table itself uses (a JSON column that cannot be null holds `null` as a
      // document rather than as SQL NULL); the filter goes in a derived table, where its unqualified column
      // names mean the items table and nothing else — `id`, `owner_type` and `seller_id` are all names the view
      // has too
      const filtered = bound(whereSql(where, { json: new Set(items.def.json), jsonNotNull: new Set(items.def.json.filter((c) => !items.def.nullable.includes(c))) }));

      // the sellable rule (domain/rules sellsFrom): a seller item sells from its service location when set, else
      // from its own location; company stock from company locations. Null on every column when the LEFT JOIN
      // found no level row, so the CASE falls to 0 and the item counts as having no sellable units.
      const sellable = sql`${sr('sellable')} AND ${sr('location_active')} AND CASE WHEN ${si('owner_type')} = ${SELLER}
             THEN CASE WHEN ${si('service_location_id')} IS NULL THEN ${sr('location_owner_type')} = ${SELLER} ELSE ${sr('location_id')} = ${si('service_location_id')} END
             ELSE ${sr('location_owner_type')} = ${OFFICIAL} END`;

      // the aliases are the names the MongoDB pipeline gives the same five values, and HAVING reads them
      const state = sql`CASE WHEN ${sql.ref('_sell')} <= 0 THEN 'out_of_stock'
                             WHEN ${sql.ref('_threshold')} IS NOT NULL AND ${sql.ref('_sell')} <= ${sql.ref('_threshold')} THEN 'low_stock'
                             ELSE ${IN_STOCK} END`;
      const conditions: RawBuilder<SqlBool>[] = [];
      if (f.state) conditions.push(sql<SqlBool>`${state} = ${f.state}`);
      if (f.filter === 'low_or_out') conditions.push(sql<SqlBool>`${state} <> ${IN_STOCK}`);
      if (f.filter === 'has_damaged_or_held') conditions.push(sql<SqlBool>`${sql.ref('_damaged')} > 0`);
      if (f.filter === 'has_returned') conditions.push(sql<SqlBool>`${sql.ref('_returned')} > 0`);
      if (f.filter === 'has_incoming') conditions.push(sql<SqlBool>`${sql.ref('_incoming')} > 0`);
      if (!conditions.length) throw new Error('inventory: itemIdsByQuantities with no quantity condition; the item filter answers that list on its own');

      const rows = await db
        .selectFrom(sql<Row<'stock_items'>>`(SELECT * FROM ${sql.table('inventory_stock_items')} WHERE ${filtered})`.as('si'))
        .leftJoin('inventory_v_stock_rows as sr', 'sr.stock_item_id', 'si.id')
        .select([
          'si.id',
          sql<number>`COALESCE(SUM(CASE WHEN ${sellable} THEN ${sr('available')} ELSE 0 END), 0)`.as('_sell'),
          sql<number>`COALESCE(SUM(${sr('damaged_held')}), 0)`.as('_damaged'),
          sql<number>`COALESCE(SUM(${sr('returned')}), 0)`.as('_returned'),
          sql<number>`COALESCE(SUM(${sr('incoming')}), 0)`.as('_incoming'),
          sql<number | null>`COALESCE(${si('low_stock_threshold')}, ${f.defaultThreshold})`.as('_threshold'),
        ])
        // every item column the measures read is grouped, so ONLY_FULL_GROUP_BY has nothing to work out: `id`
        // is unique, so the extra names change no group
        .groupBy(['si.id', 'si.owner_type', 'si.service_location_id', 'si.low_stock_threshold'])
        .having((eb) => eb.and(conditions))
        .execute();
      return rows.map((r) => r.id);
    },

    async recentMovements(itemIds: readonly string[], limit: number): Promise<Row<'stock_movements'>[]> {
      if (!itemIds.length) return [];
      // the ledger's id is a UUIDv7, so (at, id) descending is the order the pipeline's { at: -1, _id: -1 } means
      const { rows } = await sql<Record<string, unknown>>`
        SELECT * FROM (
          SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.\`stock_item_id\` ORDER BY m.\`at\` DESC, m.\`id\` DESC) AS \`_rn\`
            FROM \`inventory_stock_movements\` AS m
           WHERE m.\`stock_item_id\` IN (${sql.join([...itemIds])})
        ) AS r
         WHERE r.\`_rn\` <= ${limit}
         ORDER BY r.\`at\` DESC, r.\`id\` DESC`.execute(store.db);
      return rows.map(({ _rn, ...row }) => movements.fromRow(row));
    },

    async unitsByReasonSince(itemIds: readonly string[], since: Date, reasonCodes: readonly string[]): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      if (!itemIds.length || !reasonCodes.length) return out;
      const rows = await store.db
        .selectFrom('inventory_stock_movements')
        .select(['stock_item_id', (eb) => eb.fn.sum<string>('quantity').as('n')])
        .where('stock_item_id', 'in', [...itemIds])
        .where('reason_code', 'in', [...reasonCodes])
        .where('at', '>=', since)
        .groupBy('stock_item_id')
        .execute();
      // SUM() is DECIMAL, which mysql2 hands over as a string
      for (const r of rows) out.set(r.stock_item_id, Number(r.n));
      return out;
    },
  };
}
