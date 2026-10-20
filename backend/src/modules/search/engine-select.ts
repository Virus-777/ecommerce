/**
 * Wires the search engine chosen by SEARCH_ENGINE (engine-config.ts): the repository (always MongoDB: the read
 * model) and the engine that answers queries. With OpenSearch the repository is the one that also feeds the
 * engine's index (index-feed.ts).
 */
import type { ClientOptions } from '@opensearch-project/opensearch';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type { SearchEngine } from './ports.js';
import { readSearchEngineConfig, type SearchEngineConfig } from './engine-config.js';
import { withIndexFeed } from './index-feed.js';
import { createMongoSearchEngine } from './mongo-engine.js';
import { SearchRepository } from './repository.js';
import { createMongoTermLookup } from './terms.js';
import { createOpenSearchClient, OsApi } from './providers/opensearch/client.js';
import { createOpenSearchEngine } from './providers/opensearch/engine.js';
import { ProductIndex } from './providers/opensearch/products-index.js';

/** Tests: the engine configuration (instead of the environment), client options for OpenSearch (the in-memory fake's Connection) and a no-op sleep */
export const openSearchTesting: { config?: SearchEngineConfig; clientOptions?: Partial<ClientOptions>; sleep?: (ms: number) => Promise<void> } = {};

export function selectSearchEngine(ctx: ModuleContext<'search'>, env: Record<string, string | undefined> = process.env): { repo: SearchRepository; engine: SearchEngine } {
  const cfg = openSearchTesting.config ?? readSearchEngineConfig(env);
  const repo = new SearchRepository(ctx.mongo);
  const terms = createMongoTermLookup(ctx.mongo);
  // filter counts kept per query for SEARCH_FACET_CACHE_MS (default 30 s; 0 = off; always off in tests, which change data and count again)
  const facetCacheMs = env.NODE_ENV === 'test' ? 0 : Math.max(0, Number(env.SEARCH_FACET_CACHE_MS ?? 30_000) || 0);
  const mongo = createMongoSearchEngine(ctx.mongo, terms, { facetCacheMs });
  if (cfg.engine === 'mongo') return { repo, engine: mongo };

  const os = new OsApi(createOpenSearchClient(cfg.opensearch, openSearchTesting.clientOptions));
  const index = new ProductIndex(os, { cfg: cfg.opensearch, log: ctx.log, now: () => ctx.clock.now(), ...(openSearchTesting.sleep ? { sleep: openSearchTesting.sleep } : {}) });
  const engine = createOpenSearchEngine({ os, index, log: ctx.log, terms, repo, termEngine: mongo });
  return {
    repo: withIndexFeed(ctx.mongo, engine.feed, { log: ctx.log, now: () => ctx.clock.now() }),
    engine,
  };
}
