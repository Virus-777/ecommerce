/**
 * Wires the search engine chosen by SEARCH_ENGINE (infra/config.ts): the repository (always PostgreSQL: the
 * read model) and the engine that answers queries. With OpenSearch the repository is wrapped so its writes
 * feed the engine's index (infra/index-feed.ts).
 */
import type { ClientOptions } from '@opensearch-project/opensearch';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type { SearchEngine, SearchRepository } from '../ports.js';
import { readSearchEngineConfig, type SearchEngineConfig } from './config.js';
import { withIndexFeed } from './index-feed.js';
import { createOpenSearchClient, OsApi } from './opensearch/client.js';
import { createOpenSearchEngine } from './opensearch/engine.js';
import { ProductIndex } from './opensearch/products-index.js';
import { createPostgresSearchEngine } from './postgres/engine.js';
import { createPostgresSearchRepository } from './postgres/repository.js';
import { createPostgresTermLookup } from './postgres/terms.js';

/** Tests: the engine configuration (instead of the environment), client options for OpenSearch (the in-memory fake's Connection) and a no-op sleep */
export const openSearchTesting: { config?: SearchEngineConfig; clientOptions?: Partial<ClientOptions>; sleep?: (ms: number) => Promise<void> } = {};

export function createSearchAdapters(ctx: ModuleContext<'search'>, env: Record<string, string | undefined> = process.env): { repo: SearchRepository; engine: SearchEngine } {
  const cfg = openSearchTesting.config ?? readSearchEngineConfig(env);
  const repo = createPostgresSearchRepository(ctx.db, ctx.inbox);
  const postgres = createPostgresSearchEngine(ctx.db);
  if (cfg.engine === 'postgres') return { repo, engine: postgres };

  const os = new OsApi(createOpenSearchClient(cfg.opensearch, openSearchTesting.clientOptions));
  const index = new ProductIndex(os, { cfg: cfg.opensearch, log: ctx.log, now: () => ctx.clock.now(), ...(openSearchTesting.sleep ? { sleep: openSearchTesting.sleep } : {}) });
  const engine = createOpenSearchEngine({ os, index, log: ctx.log, terms: createPostgresTermLookup(ctx.db), repo, termEngine: postgres });
  return {
    repo: withIndexFeed(repo, engine.feed, { log: ctx.log, now: () => ctx.clock.now() }),
    engine,
  };
}
