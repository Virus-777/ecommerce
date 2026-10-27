/**
 * Integrated search (search module, `GET /api/store/search/departments`): the one scoring rule every department
 * module applies to its own records, so sections of different departments can be ranked against each other, and
 * the small helpers that turn a module's own page of cards into a `DeptSearchGroup`. Pure: no I/O.
 */
import type * as common from '../../spec/common.js';
import type { Page, PageRequest } from './pagination.js';

/** A record the module's own filter matched, but on a field the score does not look at (a slug, a search column). */
export const WEAK_MATCH = 30;

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

const words = (s: string): string[] => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const hits = (text: string, fields: readonly (string | null | undefined)[]): boolean =>
  fields.some((f) => f && norm(f).includes(text));

/**
 * How well a record matches what was typed, the same way in every department (docs: integrated search):
 * 100 the title is the query · 85 the title starts with it · 70 a word of the title starts with it ·
 * 55 the title contains it · 35 only a secondary field (cuisine, genre, company, topic, summary) contains it ·
 * 0 nothing matched.
 */
export function scoreOf(q: string, title: string, also: readonly (string | null | undefined)[] = []): number {
  const text = norm(q);
  if (!text) return 0;
  const t = norm(title);
  if (t && t === text) return 100;
  if (t && t.startsWith(text)) return 85;
  if (t && words(t).some((w) => w.startsWith(text))) return 70;
  if (t && t.includes(text)) return 55;
  return hits(text, also) ? 35 : 0;
}

/** Joins the parts of a card's grey line, leaving out the ones the record has not got. */
export const line = (...parts: readonly (string | null | undefined | false)[]): string | null =>
  parts.filter((p): p is string => Boolean(p && String(p).trim())).join(' · ') || null;

/** `★ 4.7 (1,204)`, or null without ratings. */
export const stars = (average: number | null | undefined, count = 0): string | null =>
  average == null ? null : `★ ${average.toFixed(1)}${count ? ` (${count.toLocaleString('en-US')})` : ''}`;

/** The paging a department module answers one group with: the cursor belongs to the group being paged. */
export const groupPage = (input: common.DeptSearchRequest): PageRequest => ({
  mode: 'cursor',
  cursor: input.cursor ?? null,
  limit: Math.min(Math.max(input.limit, 1), 100),
});

/** True when this group was asked for (no `kinds` asks for every group). */
export const wanted = (input: common.DeptSearchRequest, kind: string): boolean => !input.kinds?.length || input.kinds.includes(kind);

/**
 * One group from a module's own page of cards: its hits best match first (the module's own order breaks ties,
 * `Array#sort` being stable), the number of matching records and the cursor for more. Null when nothing matched.
 */
export function groupFrom<T>(
  kind: string,
  title: string,
  page: Page<T>,
  hit: (item: T) => common.DeptSearchHit | null,
  extra: { area?: string } = {},
): common.DeptSearchGroup | null {
  const items = page.items.map(hit).filter((h): h is common.DeptSearchHit => h !== null && h.score > 0);
  if (!items.length) return null;
  items.sort((a, b) => b.score - a.score);
  return {
    kind,
    title,
    ...(extra.area ? { area: extra.area } : {}),
    total: page.total ?? items.length,
    items,
    nextCursor: page.nextCursor ?? null,
  };
}

/** The same for a short fixed list a module keeps in memory (categories, topics, genres). */
export function groupFromList<T>(
  kind: string,
  title: string,
  all: readonly T[],
  input: common.DeptSearchRequest,
  hit: (item: T) => common.DeptSearchHit | null,
  extra: { area?: string } = {},
): common.DeptSearchGroup | null {
  const scored = all.map(hit).filter((h): h is common.DeptSearchHit => h !== null && h.score > 0);
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const start = input.cursor ? Number(Buffer.from(input.cursor, 'base64url').toString('utf8')) || 0 : 0;
  const limit = Math.min(Math.max(input.limit, 1), 100);
  const items = scored.slice(start, start + limit);
  const next = start + limit < scored.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
  return { kind, title, ...(extra.area ? { area: extra.area } : {}), total: scored.length, items, nextCursor: next };
}
