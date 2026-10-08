/**
 * Every list pages two ways (architecture §5): `?cursor=` for the Android app's infinite scroll
 * and `?page=` for the website's numbered pages. Responses: { items, nextCursor, page?, totalPages?, total? }.
 */
import { sql, type SelectQueryBuilder } from 'kysely';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type Page, type PageInput } from '../../spec/common.js';
import { AppError } from '../errors/index.js';

export type { Page, PageInput };

/** Normalized paging request handed to handlers of `paging: true` endpoints. */
export type PageRequest =
  | { mode: 'cursor'; cursor: string | null; limit: number }
  | { mode: 'page'; page: number; limit: number };

export function toPageRequest(input: PageInput | undefined): PageRequest {
  const limit = Math.min(Math.max(input?.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  if (input?.cursor && input.page) throw new AppError('VALIDATION_FAILED', 'Send either cursor or page, not both', { issues: [{ path: 'page', message: 'cursor and page are exclusive' }] });
  if (input?.page) return { mode: 'page', page: input.page, limit };
  return { mode: 'cursor', cursor: input?.cursor ?? null, limit };
}

/** Opaque cursor: base64url of the sort values of the last item. */
export const encodeCursor = (values: readonly unknown[]): string => Buffer.from(JSON.stringify(values)).toString('base64url');

export function decodeCursor(cursor: string): unknown[] {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v)) return v;
  } catch {
    /* fall through */
  }
  throw new AppError('VALIDATION_FAILED', 'Invalid cursor', { issues: [{ path: 'cursor', message: 'not a cursor from this list' }] });
}

/** Builds a page from an in-memory list (small bounded lists, read models, tests). */
export function pageOf<T>(all: readonly T[], req: PageRequest): Page<T> {
  if (req.mode === 'page') {
    const start = (req.page - 1) * req.limit;
    const items = all.slice(start, start + req.limit);
    const totalPages = Math.max(1, Math.ceil(all.length / req.limit));
    return { items, nextCursor: req.page < totalPages ? encodeCursor([start + req.limit]) : null, page: req.page, totalPages, total: all.length };
  }
  const start = req.cursor ? Number(decodeCursor(req.cursor)[0]) : 0;
  const items = all.slice(start, start + req.limit);
  return { items, nextCursor: start + req.limit < all.length ? encodeCursor([start + req.limit]) : null, total: all.length };
}

export interface KeysetOrder {
  /** Column to sort by (qualified if the query joins), e.g. 'created_at' */
  column: string;
  direction: 'asc' | 'desc';
  /** Unique tie-breaker, default 'id' */
  id?: string;
}

/**
 * Pages a Kysely select. Cursor mode uses keyset paging on (column, id); page mode uses
 * offset paging with a total count. Rows must include the sort column and the id.
 */
export async function paginate<DB, TB extends keyof DB, O extends Record<string, unknown>>(
  query: SelectQueryBuilder<DB, TB, O>,
  req: PageRequest,
  order: KeysetOrder,
): Promise<Page<O>> {
  const idCol = order.id ?? 'id';
  const dir = order.direction;
  const cmp = dir === 'desc' ? sql.raw('<') : sql.raw('>');
  const sorted = query.orderBy(sql.ref(order.column), dir).orderBy(sql.ref(idCol), dir);
  const field = (row: O, col: string) => row[col.split('.').pop()!];
  const cursorOf = (row: O) => {
    const v = field(row, order.column);
    return encodeCursor([v instanceof Date ? v.toISOString() : v, field(row, idCol)]);
  };

  if (req.mode === 'page') {
    const countRow = await query
      .clearSelect()
      .clearOrderBy()
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirst();
    const total = Number((countRow as { n?: number } | undefined)?.n ?? 0);
    const items = (await sorted.limit(req.limit).offset((req.page - 1) * req.limit).execute()) as O[];
    const totalPages = Math.max(1, Math.ceil(total / req.limit));
    const last = items.at(-1);
    return { items, nextCursor: req.page < totalPages && last ? cursorOf(last) : null, page: req.page, totalPages, total };
  }

  let q = sorted;
  if (req.cursor) {
    const [v, id] = decodeCursor(req.cursor);
    q = q.where(sql<boolean>`(${sql.ref(order.column)}, ${sql.ref(idCol)}) ${cmp} (${v}, ${id})`);
  }
  const rows = (await q.limit(req.limit + 1).execute()) as O[];
  const items = rows.slice(0, req.limit);
  return { items, nextCursor: rows.length > req.limit ? cursorOf(items.at(-1)!) : null };
}
