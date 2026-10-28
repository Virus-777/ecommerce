/**
 * The unlocked read-modify-write detector (docs/10-mysql-migration.md §11.2 rule 2).
 *
 * MongoDB aborted the second writer of a document, so a value read without a lock and written back was still
 * safe: the transaction ran again and read the new value. InnoDB makes the second writer **wait** and then
 * overwrite, so the same code silently loses the first transaction's change. There is no error, no warning and
 * nothing in the log — the row simply ends up with one of the two values instead of both. That is the one class
 * of bug this migration can introduce without anything failing, which is why it gets a detector of its own
 * rather than a rule in a document.
 *
 * What it does: inside a transaction, every row `Table` reads **without** `forUpdate` is remembered with the
 * place that read it. If that same transaction later writes that row with a value, `Table` throws
 * {@link UnlockedReadModifyWrite} — the table, the row and the file:line of the read. It is on in tests and in
 * development and off in production, where a false positive would cost a request (`setDetector`).
 *
 * A row the transaction has already locked is not remembered, because it is not at risk:
 *
 *  - read with `forUpdate` (the lock the rule asks for);
 *  - inserted by this transaction (the insert holds an exclusive lock on the row until it commits);
 *  - already written by this transaction, for the same reason.
 *
 * Reading a row with `forUpdate` **after** reading it without one does not clear it. The lock is taken, but a
 * value computed from the first read is as stale as it ever was, so `find(…, { forUpdate: true })` followed by
 * a write of that row still reports the read that came before it. Lock the read that the value comes from.
 *
 * Writing it with an expression — `inc(…)`, `decToZero(…)`, `expr(…)` — is never flagged: the server computes
 * the new value from the stored one, which is the other half of rule 1.
 *
 * `lock(name)` stands the detector down for that transaction. A transaction that takes a named lock has
 * serialised itself against every other holder of that name (rule 5), which is what the lock is for, and that
 * is the one case where an unlocked read-modify-write is deliberate rather than an oversight.
 *
 * **What it cannot see**, and neither can anything else automatic:
 *
 *  - a read-modify-write that never opens a transaction. Three of the four worst cases the census found are of
 *    that kind (Appendix C), including the catalog brand race of 2026-10-28. There is no transaction to attach
 *    a memory to, so those are found by reading the code, which is why Appendix C is re-read whenever modules
 *    are added.
 *  - a write whose rows it cannot name: `updateMany` with a filter that does not pin the primary key (and
 *    `deleteMany`, which loses no update anyway). The check needs a row to match the read against.
 *  - a read through `db` (Kysely), `pageQuery` or a hand-written statement. `Table.find` is the path a
 *    repository reads values through; the others are reads for pages and reports, not for values that go back
 *    into the row.
 */

/** The code of the error, as §11.2 names it */
export const UNLOCKED_READ_MODIFY_WRITE = 'UNLOCKED_READ_MODIFY_WRITE';

export class UnlockedReadModifyWrite extends Error {
  readonly code = UNLOCKED_READ_MODIFY_WRITE;
  constructor(
    readonly table: string,
    readonly id: string,
    readonly site: string,
  ) {
    super(
      `${UNLOCKED_READ_MODIFY_WRITE}: ${table} row ${id} was read at ${site} without forUpdate and is written in the same transaction. ` +
        'Read it with { forUpdate: true }, write it with an expression (inc/decToZero/expr), or serialise on lock(name) — §11.2 rule 1.',
    );
    this.name = 'UnlockedReadModifyWrite';
  }
}

interface Scope {
  /** Rows this transaction holds a lock on: read with forUpdate, inserted, or already written */
  locked: Set<string>;
  /** Rows read without a lock, and where they were read */
  unlocked: Map<string, string>;
  /** lock(name) was taken: the transaction is serialised by name, so the detector stands down */
  serialised: boolean;
}

/**
 * One scope per transaction, keyed by its connection. The connection *is* the transaction here: `Table` is
 * handed one and every statement of that transaction runs on it. A WeakMap because a connection the pool drops
 * takes its scope with it; and `beginScope` empties it, because a pooled connection is reused by the next
 * transaction and a scope that outlived its own would accuse the next one of what this one read.
 */
const scopes = new WeakMap<object, Scope>();

/** Rows remembered per transaction before it stops remembering: a read of a hundred thousand rows is not a value */
const MAX_TRACKED = 20_000;

let enabled = process.env.NODE_ENV !== 'production';

/** Whether the detector is watching. Asked on every read inside a transaction, so it is a field read */
export const detecting = (): boolean => enabled;

/** Turns it on or off; answers the previous setting, so a test can put it back */
export function setDetector(on: boolean): boolean {
  const was = enabled;
  enabled = on;
  return was;
}

/** A transaction has begun on this connection: whatever an earlier one left behind is gone */
export function beginScope(conn: object): void {
  if (!enabled) return;
  scopes.set(conn, { locked: new Set(), unlocked: new Map(), serialised: false });
}

/** The transaction has ended: committed, rolled back, or about to be run again */
export function endScope(conn: object): void {
  scopes.delete(conn);
}

/** `lock(name)` was taken by this transaction */
export function serialisedScope(conn: object): void {
  const scope = scopes.get(conn);
  if (scope) scope.serialised = true;
}

/** Rows this transaction read: with a lock they are safe, without one they are remembered */
export function readRows(conn: object, keys: readonly string[], forUpdate: boolean): void {
  const scope = scopes.get(conn);
  if (!scope || scope.serialised) return;
  if (forUpdate) {
    // the lock is added, and an earlier unlocked read of the same row is *not* forgotten: locking a row after
    // reading it does not make a value computed from that first read current again
    for (const key of keys) scope.locked.add(key);
    return;
  }
  for (const key of keys) {
    if (scope.locked.has(key) || scope.unlocked.has(key)) continue;
    if (scope.unlocked.size >= MAX_TRACKED) return;
    scope.unlocked.set(key, callSite());
  }
}

/** Rows this transaction wrote without reading them first: an insert, or `INSERT … ON DUPLICATE KEY UPDATE` */
export function lockedByWrite(conn: object, keys: readonly string[]): void {
  const scope = scopes.get(conn);
  if (!scope) return;
  for (const key of keys) {
    scope.locked.add(key);
    scope.unlocked.delete(key);
  }
}

/**
 * About to write these rows with a value. One of them read without a lock in this transaction is the bug.
 * Afterwards they count as locked: the write itself holds them until the transaction ends.
 */
export function writingRows(conn: object, table: string, keys: readonly string[]): void {
  const scope = scopes.get(conn);
  if (!scope || scope.serialised) return;
  for (const key of keys) {
    const site = scope.unlocked.get(key);
    if (site !== undefined) throw new UnlockedReadModifyWrite(table, key.slice(table.length + 1), site);
  }
  lockedByWrite(conn, keys);
}

/** `table#value` (`table#a|b` for a composite key): the name a row is remembered by */
export const rowKey = (table: string, values: readonly unknown[]): string =>
  `${table}#${values.map((v) => (v instanceof Date ? v.toISOString() : String(v))).join('|')}`;

/**
 * The rows a filter names, or undefined when it names none in particular. Every primary key column has to be
 * pinned to a value: `{ id: x }`, `{ id: [a, b] }` while the key is one column, or every column of a composite
 * one. A condition (`{ op: '<' }`), a missing column or an `or` means the write has no one row to match a read
 * against, and the detector then says nothing rather than guessing.
 */
export function keysFromWhere(table: string, key: readonly string[], where: Record<string, unknown>): string[] | undefined {
  if (where.or !== undefined) return undefined;
  const values: unknown[] = [];
  let list: unknown[] | undefined;
  for (const column of key) {
    const v = where[column];
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v)) {
      // a list of values is only unambiguous while it is the key's only column
      if (key.length > 1) return undefined;
      if (v.some((x) => x === null || x === undefined || typeof x === 'object')) return undefined;
      list = v;
      continue;
    }
    if (typeof v === 'object' && !(v instanceof Date)) return undefined;
    values.push(v);
  }
  if (!list) return [rowKey(table, values)];
  return list.map((v) => rowKey(table, [v]));
}

/**
 * The place that read the row: the first frame outside this folder, as `src/…/file.ts:line:col`. A stack is
 * only ever taken for a row that is being remembered, so an unlocked read costs one `Error` and a locked read
 * costs nothing.
 */
function callSite(): string {
  const stack = new Error().stack ?? '';
  for (const line of stack.split('\n').slice(2)) {
    // the files that make up the store itself, rather than the whole folder: a test of the detector lives here
    // too, and it is as much a caller as a repository is
    if (/[\\/]kernel[\\/]mysql[\\/](detect|table|module-store|index)\.ts/.test(line) || line.includes('node:internal') || line.includes('node_modules')) continue;
    const at = /\(?([^()\s]+:\d+:\d+)\)?$/.exec(line.trim())?.[1];
    if (at) return at.replace(/^file:\/+/, '').replace(/^.*[\\/](?=src[\\/])/, '');
  }
  return 'an unknown place';
}
