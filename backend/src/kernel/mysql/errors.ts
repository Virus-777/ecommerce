/**
 * Telling MySQL's errors apart (docs/10-mysql-migration.md §10.1, §10.3, §25).
 *
 * The transaction wrapper and `insertIfAbsent` both turn on these, and the difference between them matters more
 * on MySQL than it did on MongoDB:
 *
 * - a **deadlock** or a **lock wait timeout** means "try again": the transaction is already rolled back (with
 *   `innodb_rollback_on_timeout=ON`, which the portable server and §20 both set), so re-running `fn` is safe;
 * - a **duplicate key** fails only its own statement, not the transaction — proved against 8.4.13 — which is why
 *   `insertIfAbsent` and `claim()` can insert and catch instead of reading first;
 * - a **lost connection during COMMIT** leaves the outcome unknown, exactly as MongoDB's
 *   `UnknownTransactionCommitResult` did, so only an idempotent `fn` may be re-run.
 */

/** mysql2 puts the server's error number on `errno`, and its SQLSTATE on `sqlState` */
interface MysqlError {
  errno?: number;
  code?: string;
  sqlState?: string;
  message?: string;
}

const asMysqlError = (err: unknown): MysqlError | undefined => (typeof err === 'object' && err !== null ? (err as MysqlError) : undefined);

export const ER_DUP_ENTRY = 1062;
export const ER_DUP_ENTRY_WITH_KEY_NAME = 1586;
export const ER_LOCK_DEADLOCK = 1213;
export const ER_LOCK_WAIT_TIMEOUT = 1205;
export const ER_CHECK_CONSTRAINT_VIOLATED = 3819;
export const ER_NO_REFERENCED_ROW = 1452;
export const ER_ROW_IS_REFERENCED = 1451;
export const ER_DATA_TOO_LONG = 1406;

const errno = (err: unknown): number | undefined => asMysqlError(err)?.errno;

/** A unique key refused the row. Only this statement failed; the transaction is still usable (§25) */
export const isDuplicateKey = (err: unknown): boolean => errno(err) === ER_DUP_ENTRY || errno(err) === ER_DUP_ENTRY_WITH_KEY_NAME;

/**
 * Which key refused it. MySQL puts the key name in the message — `Duplicate entry 'x' for key 'tbl.uq_name'` —
 * and `insertIfAbsent(row, key)` needs it to tell "the row is already there" from "a different unique key was
 * violated", which is a real error worth raising.
 */
export function duplicateKeyName(err: unknown): string | undefined {
  if (!isDuplicateKey(err)) return undefined;
  const m = /for key '([^']+)'/.exec(asMysqlError(err)?.message ?? '');
  const name = m?.[1];
  return name ? (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name) : undefined;
}

/** Two transactions deadlocked; InnoDB rolled this one back. Safe to run again (§10.3) */
export const isDeadlock = (err: unknown): boolean => errno(err) === ER_LOCK_DEADLOCK;

/** A lock wait passed innodb_lock_wait_timeout. With innodb_rollback_on_timeout=ON the whole transaction is rolled back */
export const isLockTimeout = (err: unknown): boolean => errno(err) === ER_LOCK_WAIT_TIMEOUT;

/** Worth running the transaction again, as MongoDB's TransientTransactionError was */
export const isRetryable = (err: unknown): boolean => isDeadlock(err) || isLockTimeout(err);

/** A CHECK refused the value: an enum outside its list, or a negative where the spec says >= 0 (§6.1) */
export const isCheckViolation = (err: unknown): boolean => errno(err) === ER_CHECK_CONSTRAINT_VIOLATED;

/** A foreign key refused it: the parent is missing (1452) or still has children (1451) */
export const isForeignKeyViolation = (err: unknown): boolean => errno(err) === ER_NO_REFERENCED_ROW || errno(err) === ER_ROW_IS_REFERENCED;

/** A value did not fit its column. Under STRICT_TRANS_TABLES this is an error rather than a silent truncation (§18.3) */
export const isValueTooLong = (err: unknown): boolean => errno(err) === ER_DATA_TOO_LONG;

const LOST_CONNECTION = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'POOL_CLOSED']);

/**
 * The connection went away. During a COMMIT this means the outcome is **unknown**: the server may have committed
 * before the socket died. Only an `fn` that is idempotent through a natural key or `claim()` may be run again
 * (§10.3 rule 3) — which is already the rule for consumers and jobs.
 */
export function isConnectionLost(err: unknown): boolean {
  const e = asMysqlError(err);
  if (!e) return false;
  if (e.code && LOST_CONNECTION.has(e.code)) return true;
  return /connection lost|server has gone away|read ECONNRESET/i.test(e.message ?? '');
}
