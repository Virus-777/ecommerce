/**
 * `orThrow(row, what)`: the row, or an internal error when it is missing.
 *
 * For reads a repository expects to succeed (a row it has just written or locked): a missing row there is a bug,
 * not a 404, so the error is a plain Error (500) naming what was looked for. Lookups a caller may get wrong still
 * answer NOT_FOUND through ctx.error in the service.
 *
 *   return orThrow(await t.update(id, patch), `access: role ${id}`);
 */
export function orThrow<T>(row: T | null | undefined, what: string): T {
  if (row === null || row === undefined) throw new Error(`${what} not found`);
  return row;
}
