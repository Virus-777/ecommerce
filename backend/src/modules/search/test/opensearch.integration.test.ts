/**
 * Opt-in: the OpenSearch adapter against a real cluster. Runs only when OPENSEARCH_URL is set (credentials
 * from OPENSEARCH_USERNAME/OPENSEARCH_PASSWORD or OPENSEARCH_API_KEY); every run uses throwaway indices
 * (prefix it-<time>-<random>) and deletes them afterwards. Writes use refresh=wait_for.
 *
 *   OPENSEARCH_URL=http://localhost:9200 npx vitest run src/modules/search/test/opensearch.integration.test.ts
 *   docker run -p 9200:9200 -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true opensearchproject/opensearch:2
 *
 * This is where what the in-memory fake cannot prove is checked: the Painless scripts compile and score as
 * their JavaScript twins, the analyzers, mapping and aggregations are accepted, aliases swap.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createOpenSearchClient, OsApi } from '../infra/opensearch/client.js';
import { MAPPING_VERSION } from '../infra/opensearch/mapping.js';
import { ProductIndex } from '../infra/opensearch/products-index.js';
import { engineContract } from './engine-contract.js';
import { dropLiveIndices, liveOpenSearchConfig } from './helpers.js';

const live = Boolean(process.env.OPENSEARCH_URL);
const silentLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => silentLog } as never;

describe.runIf(live)('OpenSearch cluster at OPENSEARCH_URL', () => {
  const cfg = live ? liveOpenSearchConfig() : undefined!;
  const os = live ? new OsApi(createOpenSearchClient(cfg)) : undefined!;
  afterAll(async () => {
    if (!live) return;
    await dropLiveIndices(cfg);
    await os.close();
  });

  it('creates the versioned index with the mapping, writes with the versioned script, swaps on reindex', async () => {
    const index = new ProductIndex(os, { cfg, log: silentLog });
    const first = await index.ensure();
    const mapping = await os.request('GET', `/${first}/_mapping`);
    expect(mapping.body[first].mappings._meta).toEqual({ mappingVersion: MAPPING_VERSION });
    const r = await index.write([], ['nothing-here']);
    expect(r).toEqual({ failed: [] });
    await index.beginRebuild();
    await index.finishRebuild(true, []);
    expect(await index.aliasTarget(`${cfg.indexPrefix}-products`)).not.toBe(first);
    expect(await index.describe()).toMatch(/^opensearch \((green|yellow), index /);
  });
});

if (live) engineContract('opensearch-live');
