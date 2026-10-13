/**
 * Which search engine serves queries, from the environment (documented in backend/.env.example and
 * docs/02-backend-architecture.md §9). Read by module.ts at startup.
 *
 *   SEARCH_ENGINE=mongo        MongoDB: stemmed words and prefixes over the read-model collections (default: development, tests)
 *   SEARCH_ENGINE=opensearch   OpenSearch (production): its own index fed from the read model
 */
import { z } from 'zod';

const schema = z
  .object({
    SEARCH_ENGINE: z.enum(['mongo', 'opensearch']).default('mongo'),
    /** One node or a comma-separated list: https://search.internal:9200 */
    OPENSEARCH_URL: z.string().optional(),
    OPENSEARCH_USERNAME: z.string().optional(),
    OPENSEARCH_PASSWORD: z.string().optional(),
    /** Sent as `Authorization: ApiKey <key>` (an API-key gateway or OpenSearch API keys); instead of a username and password */
    OPENSEARCH_API_KEY: z.string().optional(),
    /** Index and alias names start with it: <prefix>-products (alias) → <prefix>-products-<timestamp> */
    OPENSEARCH_INDEX_PREFIX: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lower case letters, digits, - and _')
      .default('marketly'),
    OPENSEARCH_SHARDS: z.coerce.number().int().min(1).default(1),
    OPENSEARCH_REPLICAS: z.coerce.number().int().min(0).default(1),
    /** Refresh after writes: false (near real time, about 1 s), wait_for (tests, small deployments) */
    OPENSEARCH_REFRESH: z.enum(['false', 'wait_for', 'true']).default('false'),
    OPENSEARCH_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
    /** Bulk write attempts for rejected (429) or failed (5xx) items before the products are queued for search.process-dirty */
    OPENSEARCH_BULK_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    /** How long a server trusts what it knows about a running full reindex; a reindex waits this long (+1 s) before rebuilding */
    OPENSEARCH_ALIAS_CACHE_MS: z.coerce.number().int().min(0).default(5_000),
  })
  .superRefine((e, ctx) => {
    if (e.SEARCH_ENGINE !== 'opensearch') return;
    if (!e.OPENSEARCH_URL) ctx.addIssue({ code: 'custom', path: ['OPENSEARCH_URL'], message: 'required when SEARCH_ENGINE=opensearch' });
    if (Boolean(e.OPENSEARCH_USERNAME) !== Boolean(e.OPENSEARCH_PASSWORD)) ctx.addIssue({ code: 'custom', path: ['OPENSEARCH_PASSWORD'], message: 'OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD go together' });
    if (e.OPENSEARCH_API_KEY && e.OPENSEARCH_USERNAME) ctx.addIssue({ code: 'custom', path: ['OPENSEARCH_API_KEY'], message: 'use either an API key or a username and password' });
  });

export interface OpenSearchConfig {
  nodes: string[];
  auth: { username: string; password: string } | { apiKey: string } | null;
  indexPrefix: string;
  shards: number;
  replicas: number;
  refresh: 'false' | 'wait_for' | 'true';
  requestTimeoutMs: number;
  bulkAttempts: number;
  aliasCacheMs: number;
}

export type SearchEngineConfig = { engine: 'mongo' } | { engine: 'opensearch'; opensearch: OpenSearchConfig };

export function readSearchEngineConfig(env: Record<string, string | undefined> = process.env): SearchEngineConfig {
  // empty values count as unset (a blank line in .env)
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== '')));
  if (!parsed.success) throw new Error(`Invalid search engine configuration:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  if (e.SEARCH_ENGINE === 'mongo') return { engine: 'mongo' };
  return {
    engine: 'opensearch',
    opensearch: {
      nodes: e
        .OPENSEARCH_URL!.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      auth: e.OPENSEARCH_API_KEY ? { apiKey: e.OPENSEARCH_API_KEY } : e.OPENSEARCH_USERNAME ? { username: e.OPENSEARCH_USERNAME, password: e.OPENSEARCH_PASSWORD! } : null,
      indexPrefix: e.OPENSEARCH_INDEX_PREFIX,
      shards: e.OPENSEARCH_SHARDS,
      replicas: e.OPENSEARCH_REPLICAS,
      refresh: e.OPENSEARCH_REFRESH,
      requestTimeoutMs: e.OPENSEARCH_REQUEST_TIMEOUT_MS,
      bulkAttempts: e.OPENSEARCH_BULK_ATTEMPTS,
      aliasCacheMs: e.OPENSEARCH_ALIAS_CACHE_MS,
    },
  };
}
