/**
 * Suggestion terms (popular queries, category, brand, store and product names) stay in PostgreSQL whichever
 * engine serves product queries: a small table with trigram indexes. The OpenSearch engine asks these for the
 * term side of spelling correction and prefixes (the Postgres engine has the same queries inline).
 */
import { sql, type Kysely } from 'kysely';
import type { SearchDb } from '../../../../spec/search.js';

export interface TermLookup {
  /** A suggestion term is exactly this word */
  isTerm(word: string): Promise<boolean>;
  /** Words of suggestion terms at least `threshold` similar to the word (trigram similarity) */
  similarTermWords(word: string, threshold: number): Promise<{ word: string; similarity: number }[]>;
  /** A word of a suggestion term starts with the prefix */
  hasTermPrefix(prefix: string): Promise<boolean>;
}

const like = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createPostgresTermLookup(db: Kysely<SearchDb>): TermLookup {
  return {
    async isTerm(word) {
      const r = await sql<{ ok: boolean }>`select exists (select 1 from search.suggestion_terms t where lower(t.term) = ${word}) as ok`.execute(db);
      return Boolean(r.rows[0]?.ok);
    },
    async similarTermWords(word, threshold) {
      const r = await sql<{ w: string; s: number }>`
        select v.w, similarity(v.w, ${word}) as s
          from (select distinct regexp_split_to_table(lower(t.term), '\\s+') as w from search.suggestion_terms t) v
         where length(v.w) >= 3 and v.w <> ${word} and similarity(v.w, ${word}) >= ${threshold}
         order by s desc, v.w
         limit 10`.execute(db);
      return r.rows.map((x) => ({ word: x.w, similarity: Number(x.s) }));
    },
    async hasTermPrefix(prefix) {
      const p = like(prefix.toLowerCase());
      const r = await sql<{ ok: boolean }>`
        select exists (select 1 from search.suggestion_terms t where lower(t.term) like ${`${p}%`} or lower(t.term) like ${`% ${p}%`}) as ok`.execute(db);
      return Boolean(r.rows[0]?.ok);
    },
  };
}
