/**
 * The MySQL half of purchasing's queries port (queries.ts). All three are `GROUP BY` or `DISTINCT` statements
 * that Kysely writes out; nothing here needs a window function or a neutral filter.
 *
 * - **`deliveryPerformance`** is the deliveries → purchase orders half of §13.2's "three chained lookups":
 *   one inner join and `GROUP BY po.supplier_id` with four measures, three of them `SUM(<condition>)`. The
 *   join key `purchase_order_id` is NOT NULL with a foreign key behind it, so the inner join drops nothing
 *   that the pipeline's `$lookup` + `$unwind` kept.
 * - **`receiptPerformance`** reads **`purchasing_v_receipt_lines`** (§9.2), the view that replaces the other
 *   two chained lookups: receipt lines → receipts → deliveries → PO lines → POs, every join key NOT NULL with
 *   a foreign key, which is why an inner-join view answers this reader correctly (the `notifications_v_inbox`
 *   lesson: check the view against the real filter). Two things about using it here:
 *     - the view carries `receipt_status` but **not `receipts.submitted_at`**, which is the column this half
 *       filters on, so `purchasing_receipts` is joined back for it. That is the view's one missing column for
 *       this read; reported rather than added, because Y2 changes code and not the spec.
 *     - the view joins `purchasing_deliveries` and `purchasing_purchase_order_lines`, which this half does not
 *       read. They drop no rows (NOT NULL keys with foreign keys), so the answer is the pipeline's answer; the
 *       two extra accesses are the price of having the join written down once, in a nightly job.
 * - **`receiptIdsWithIssues`** is §13.1's "`$expr` comparing two columns → plain `WHERE a <> b`".
 *
 * Every `SUM()` comes back from mysql2 as a DECIMAL string, so each measure is read through `Number`.
 */
import { sql } from 'kysely';
import type { ModuleStore } from '../../kernel/mysql/module-store.js';
import type { PurchasingDb, PurchasingTables } from '../../spec/purchasing.js';
import type { DeliveryPerformance, PurchasingQueries, ReceiptPerformance } from './queries.js';

type T<K extends keyof PurchasingDb> = PurchasingDb[K];

/**
 * `purchasing_v_receipt_lines` (§9.2): one receipt line, with its receiving record's, its delivery's, its
 * purchase-order line's and its purchase order's columns beside it. The generator does not parse a view's
 * SELECT list, so the module that reads a view declares its row type — and writing it out is what makes the
 * missing `submitted_at` a compile error rather than a wrong answer.
 */
interface ReceiptLinesView extends T<'receipt_lines'> {
  receipt_ref: string;
  purchase_order_id: string;
  delivery_id: string;
  location_id: string;
  receipt_status: string;
  receipt_confirmed_at: Date | null;
  carrier: string | null;
  tracking_ref: string | null;
  window_from: Date;
  window_to: Date;
  arrived_at: Date | null;
  delivery_status: string;
  delay_reason: string | null;
  line_sku: string;
  line_label: string;
  qty_ordered: number;
  unit_cost_amount: number;
  expected_date: string | null;
  purchase_order_ref: string;
  supplier_id: string;
  purchase_order_status: string;
}

export function mysqlPurchasingQueries(store: ModuleStore<PurchasingTables>): PurchasingQueries {
  const db = store.db.withTables<{ purchasing_v_receipt_lines: ReceiptLinesView }>();

  return {
    async deliveryPerformance(since: Date): Promise<DeliveryPerformance[]> {
      const rows = await db
        .selectFrom('purchasing_deliveries as d')
        .innerJoin('purchasing_purchase_orders as po', 'po.id', 'd.purchase_order_id')
        .select([
          'po.supplier_id',
          (eb) => eb.fn.countAll<string>().as('deliveries'),
          sql<string>`SUM(CASE WHEN d.\`arrived_at\` <= d.\`window_to\` THEN 1 ELSE 0 END)`.as('on_time'),
          // DATETIME(3) on both columns, so microseconds DIV 1000 is the exact millisecond difference the
          // pipeline's `$subtract` of two dates gives
          sql<string>`SUM(CASE WHEN po.\`sent_at\` IS NULL THEN 0 ELSE TIMESTAMPDIFF(MICROSECOND, po.\`sent_at\`, d.\`arrived_at\`) DIV 1000 END)`.as('lead_ms'),
          sql<string>`SUM(CASE WHEN po.\`sent_at\` IS NULL THEN 0 ELSE 1 END)`.as('lead_n'),
        ])
        // a delivery that has not arrived has `arrived_at` null, which this comparison excludes on either store
        .where('d.arrived_at', '>=', since)
        .groupBy('po.supplier_id')
        .execute();
      return rows.map((r) => ({ supplierId: r.supplier_id, deliveries: Number(r.deliveries), onTime: Number(r.on_time), leadTimeMsTotal: Number(r.lead_ms), leadTimeCount: Number(r.lead_n) }));
    },

    async receiptPerformance(since: Date, statuses: readonly string[]): Promise<ReceiptPerformance[]> {
      if (!statuses.length) return [];
      const rows = await db
        .selectFrom('purchasing_v_receipt_lines as v')
        // the view's one missing column: the receiving record's submitted_at
        .innerJoin('purchasing_receipts as rc', 'rc.id', 'v.receipt_id')
        .select([
          'v.supplier_id',
          sql<string>`SUM(v.\`expected\`)`.as('expected'),
          sql<string>`SUM(v.\`received\`)`.as('received'),
          // a line that was over-received does not cancel another line's shortage, which is the pipeline's $max.
          // No test covers the clamp and none of this module's can: `expected` is the line's open quantity when
          // counting started and `checkOverReceipt` refuses more than that, so `received > expected` needs
          // `overReceiptAllowedPct` above its default of 0 — a setting the module's test app has no settings
          // module to change. Dropping the GREATEST leaves every test green.
          sql<string>`SUM(GREATEST(v.\`expected\` - v.\`received\`, 0))`.as('shortage'),
          sql<string>`SUM(v.\`damaged\`)`.as('damaged'),
        ])
        // the status list cannot change an answer and no test can tell it is here: `submitted_at` is set only by
        // `submit`, and the Receipt machine cancels only from in_progress, so every row with a submitted_at is
        // already awaiting_confirmation or confirmed. It stays because it says what the figures are *about*.
        .where('v.receipt_status', 'in', [...statuses])
        .where('rc.submitted_at', '>=', since)
        .groupBy('v.supplier_id')
        .execute();
      return rows.map((r) => ({ supplierId: r.supplier_id, expected: Number(r.expected), received: Number(r.received), shortage: Number(r.shortage), damaged: Number(r.damaged) }));
    },

    async receiptIdsWithIssues(): Promise<string[]> {
      const rows = await db
        .selectFrom('purchasing_receipt_lines')
        .select('receipt_id')
        .distinct()
        // both columns are NOT NULL, so this is the whole of MongoDB's $expr $ne
        .where(sql<boolean>`\`received\` <> \`expected\` OR \`damaged\` > 0`)
        .execute();
      return rows.map((r) => r.receipt_id);
    },
  };
}
