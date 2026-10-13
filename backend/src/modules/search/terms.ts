/**
 * Suggestion terms (popular queries, category, brand, store and product names) stay in MongoDB whichever engine
 * serves product queries. The OpenSearch engine asks these for the term side of spelling correction and prefixes
 * (the MongoDB engine uses the same lookups).
 *
 * Similar words are found among the words that start with the same letter as the misspelled one (trigram
 * similarity computed here, as pg_trgm's similarity()): a misspelled first letter is not corrected.
 */
import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { TermRow } from './ports.js';
import { similarity } from './providers/opensearch/trigram.js';
import { escapeRegExp } from './text.js';

export interface TermLookup {
  /** A suggestion term is exactly this word */
  isTerm(word: string): Promise<boolean>;
  /** Words of suggestion terms at least `threshold` similar to the word (trigram similarity) */
  similarTermWords(word: string, threshold: number): Promise<{ word: string; similarity: number }[]>;
  /** A word of a suggestion term starts with the prefix */
  hasTermPrefix(prefix: string): Promise<boolean>;
}

/** Words (lower case, split on white space) of the texts that have a word starting with `first`, keeping only those words */
export const wordsStartingWith = (texts: string[], first: string): string[] => [
  ...new Set(
    texts
      .flatMap((t) => t.toLowerCase().split(/\s+/))
      .filter((w) => w && w.startsWith(first)),
  ),
];

/** Candidates at least `threshold` similar to the word: by similarity, then closest length, then alphabetically */
export function rankSimilar(word: string, candidates: string[], threshold: number): { word: string; similarity: number }[] {
  return candidates
    .filter((w) => w.length >= 3 && w !== word)
    .map((w) => ({ word: w, similarity: similarity(w, word) }))
    .filter((c) => c.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity || Math.abs(a.word.length - word.length) - Math.abs(b.word.length - word.length) || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
}

export function createMongoTermLookup(store: ModuleStore): TermLookup {
  const terms = store.table<TermRow>('suggestion_terms');
  const any = async (filter: Record<string, unknown>) => (await terms.aggregate([{ $match: filter }, { $limit: 1 }, { $project: { _id: 1 } }])).length > 0;
  return {
    // lower(term) = word
    isTerm: (word) => any({ term: { $regex: `^${escapeRegExp(word)}$`, $options: 'i' } }),
    async similarTermWords(word, threshold) {
      const first = word.charAt(0).toLowerCase();
      if (!first) return [];
      const rows = await terms.aggregate<{ term: string }>([{ $match: { term: { $regex: `(^|\\s)${escapeRegExp(first)}`, $options: 'i' } } }, { $project: { _id: 0, term: 1 } }]);
      return rankSimilar(word, wordsStartingWith(rows.map((r) => r.term), first), threshold).slice(0, 10);
    },
    // lower(term) like 'p%' or like '% p%'
    hasTermPrefix: (prefix) => any({ term: { $regex: `(^| )${escapeRegExp(prefix.toLowerCase())}`, $options: 'i' } }),
  };
}
