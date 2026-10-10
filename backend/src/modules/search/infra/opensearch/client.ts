/**
 * The OpenSearch client (@opensearch-project/opensearch) and a thin request helper. Requests go through the
 * client's transport with explicit paths and bodies, so what is sent is exactly what query.ts builds (and what
 * the test fake answers). The transport retries connection errors and 502/503/504 itself (maxRetries).
 */
import { Client, type ClientOptions } from '@opensearch-project/opensearch';
import type { OpenSearchConfig } from '../config.js';

export function createOpenSearchClient(cfg: OpenSearchConfig, overrides: Partial<ClientOptions> = {}): Client {
  const auth = cfg.auth;
  return new Client({
    nodes: cfg.nodes,
    ...(auth && 'username' in auth ? { auth: { username: auth.username, password: auth.password } } : {}),
    ...(auth && 'apiKey' in auth ? { headers: { authorization: `ApiKey ${auth.apiKey}` } } : {}),
    requestTimeout: cfg.requestTimeoutMs,
    maxRetries: 2,
    ...overrides,
  });
}

/** An error answer from OpenSearch: status and the error body */
export class OpenSearchError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
  get type(): string | undefined {
    return (this.body as { error?: { type?: string } })?.error?.type;
  }
}

export interface OsResponse<T> {
  status: number;
  body: T;
}

export class OsApi {
  constructor(readonly client: Client) {}

  /** A JSON request; statuses in `ignore` are answered instead of thrown */
  async request<T = any>(method: string, path: string, body?: unknown, opts: { querystring?: Record<string, unknown>; ignore?: number[] } = {}): Promise<OsResponse<T>> {
    try {
      const r = await this.client.transport.request(
        { method, path, ...(body !== undefined ? { body: body as never } : {}), ...(opts.querystring ? { querystring: opts.querystring } : {}) },
        { ...(opts.ignore ? { ignore: opts.ignore } : {}) },
      );
      return { status: r.statusCode ?? 200, body: r.body as T };
    } catch (err) {
      throw toError(err);
    }
  }

  /** An NDJSON request (_bulk, _msearch) */
  async ndjson<T = any>(path: string, lines: object[], querystring?: Record<string, unknown>): Promise<OsResponse<T>> {
    try {
      const r = await this.client.transport.request({ method: 'POST', path, bulkBody: lines as never, ...(querystring ? { querystring } : {}) });
      return { status: r.statusCode ?? 200, body: r.body as T };
    } catch (err) {
      throw toError(err);
    }
  }

  async close() {
    await this.client.close();
  }
}

function toError(err: unknown): Error {
  const meta = (err as { meta?: { statusCode?: number; body?: unknown } })?.meta;
  if (meta?.statusCode) {
    const reason = (meta.body as { error?: { reason?: string; type?: string } })?.error;
    return new OpenSearchError(meta.statusCode, meta.body, `OpenSearch answered ${meta.statusCode}${reason?.type ? ` ${reason.type}` : ''}${reason?.reason ? `: ${reason.reason}` : ''}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
