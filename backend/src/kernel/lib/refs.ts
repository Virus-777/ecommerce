/**
 * Human references, separate from ids (architecture §5): MK-YYMMDD-NNNNN orders, RT- returns,
 * CS- cases, PO- payouts, PUR- purchase orders, PRD-NNNNN products, CU-NNNNNN customers.
 */
import { sql, type Kysely } from 'kysely';
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

export function createRefGenerator(db: Kysely<any>, clock: Clock, timeZone: string): RefGenerator {
  return {
    async next(prefix, { digits = 5, daily = true } = {}) {
      const day = dateInZone(clock.now(), timeZone).replace(/-/g, '').slice(2);
      const period = daily ? day : '-';
      const row = await sql<{ value: number }>`
        insert into kernel.ref_counters (prefix, period, value) values (${prefix}, ${period}, 1)
        on conflict (prefix, period) do update set value = kernel.ref_counters.value + 1
        returning value`.execute(db);
      const n = String(row.rows[0]!.value).padStart(digits, '0');
      return daily ? `${prefix}-${day}-${n}` : `${prefix}-${n}`;
    },
  };
}
