/**
 * Human references, separate from ids (architecture §5): MK-YYMMDD-NNNNN orders, RT- returns,
 * CS- cases, PO- payouts, PUR- purchase orders, PRD-NNNNN products, CU-NNNNNN customers.
 */
import type { ResultSetHeader } from 'mysql2/promise';
import type { MongoStore } from '../mongo/index.js';
import type { MysqlStore } from '../mysql/index.js';
import { dateInZone, type Clock } from './clock.js';

export interface RefOptions {
  /** Digits of the running number, default 5 */
  digits?: number;
  /** Restart numbering every market day and include YYMMDD (default true) */
  daily?: boolean;
}

export interface RefGenerator {
  next(prefix: string, opts?: RefOptions): Promise<string>;
}

/** References numbered in MongoDB (kernel.ref_counters), shared by every instance */
export function mongoRefGenerator(store: MongoStore, clock: Clock, timeZone: string): RefGenerator {
  const counters = store.kernel('ref_counters');
  return {
    async next(prefix, { digits = 5, daily = true } = {}) {
      const day = dateInZone(clock.now(), timeZone).replace(/-/g, '').slice(2);
      const period = daily ? day : '-';
      const row = await counters.findOneAndUpdate({ _id: `${prefix}|${period}` }, { $inc: { value: 1 }, $setOnInsert: { prefix, period } }, { upsert: true, new: true, lean: true });
      const n = String((row as unknown as { value: number }).value).padStart(digits, '0');
      return daily ? `${prefix}-${day}-${n}` : `${prefix}-${n}`;
    },
  };
}

/** The same references numbered in MySQL (`kernel_ref_counters`, docs/10 §12), shared by every instance */
export function mysqlRefGenerator(store: MysqlStore, clock: Clock, timeZone: string): RefGenerator {
  return {
    async next(prefix, { digits = 5, daily = true } = {}) {
      const day = dateInZone(clock.now(), timeZone).replace(/-/g, '').slice(2);
      const period = daily ? day : '-';
      // One statement, like the MongoDB upsert above, and the new number rides back on `insertId` rather than
      // in a second read. On the insert branch `affectedRows` is 1 and `insertId` is meaningless — a plain
      // INSERT sets no LAST_INSERT_ID, so on a pooled connection it still holds whatever the last statement
      // there left behind — but the first reference of a period is 1 by definition. (Same trap as nextValues.)
      //
      // On the pool, outside any transaction the caller is in: the row lock then lasts microseconds instead of
      // until the caller commits, and a number taken by a transaction that rolls back is skipped, which is
      // what MongoDB did too. A reference is therefore never reused, and the series may have gaps.
      const [res] = await store.pool.query<ResultSetHeader>(
        'INSERT INTO `kernel_ref_counters` (`prefix`, `period`, `value`) VALUES (?, ?, 1) AS new ' +
          'ON DUPLICATE KEY UPDATE `value` = LAST_INSERT_ID(`kernel_ref_counters`.`value` + 1)',
        [prefix, period],
      );
      const value = res.affectedRows === 1 ? 1 : Number(res.insertId);
      if (!Number.isFinite(value) || value < 1) throw new Error(`kernel_ref_counters: ${prefix}|${period} answered ${String(res.insertId)}`);
      const n = String(value).padStart(digits, '0');
      return daily ? `${prefix}-${day}-${n}` : `${prefix}-${n}`;
    },
  };
}
