/**
 * The reads of this module that are not the same question in both databases (docs/10 §10.5e).
 *
 * Everything else lives in repository.ts, written once against `ctx.store`. Three reads cannot be:
 *
 *  - the two halves of the nightly supplier performance job, each a **join plus a `GROUP BY` with four
 *    measures** — on-time arrivals and lead times per supplier over the deliveries, and expected / received /
 *    shortage / damaged per supplier over the receipt lines. Neither is a count, so neither is `countBy`;
 *  - "which receiving records have an issue", which compares **two columns of the same row**
 *    (`received <> expected`). MongoDB needs `$expr` for that and SQL writes it plainly, and the seam has no
 *    spelling for it on purpose (a condition between two columns is not a `Cond`).
 *
 * The job's arithmetic — percentages, averages and the rounding — stays in the repository and the service,
 * which is why these three hand back raw sums per supplier rather than a finished `PerformanceRow`.
 *
 * All three are reads outside a transaction, which is why nothing here takes one. At the cutover
 * `queries.mongo.ts` is deleted whole rather than edited (Y4).
 */

/** Arrivals of one supplier in the window: how many, how many on time, and the lead time of those that have one */
export interface DeliveryPerformance {
  supplierId: string;
  deliveries: number;
  onTime: number;
  /** Total of `arrived_at - sent_at` in milliseconds, over the deliveries whose order has been sent */
  leadTimeMsTotal: number;
  leadTimeCount: number;
}

/** Counted units of one supplier in the window, over the lines of its submitted receiving records */
export interface ReceiptPerformance {
  supplierId: string;
  expected: number;
  received: number;
  shortage: number;
  damaged: number;
}

export interface PurchasingQueries {
  /**
   * Deliveries that arrived at or after `since`, grouped by the supplier of their purchase order.
   *
   * A delivery that has not arrived has `arrived_at` null and is left out by the comparison itself on either
   * store (docs/10 §10.5f: MongoDB's operators are type-bracketed, so a date comparison matches no null).
   */
  deliveryPerformance(since: Date): Promise<DeliveryPerformance[]>;

  /**
   * Lines of receiving records submitted at or after `since` — status `awaiting_confirmation` or `confirmed` —
   * grouped by the supplier of their purchase order. `shortage` counts only the lines that came up short
   * (an over-received line does not cancel another's shortage), which is what `GREATEST(expected - received, 0)`
   * and the pipeline's `$max` both say.
   */
  receiptPerformance(since: Date, statuses: readonly string[]): Promise<ReceiptPerformance[]>;

  /** Ids of receiving records with a line that was short, over-received or damaged (`received <> expected OR damaged > 0`) */
  receiptIdsWithIssues(): Promise<string[]>;
}
