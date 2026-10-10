/**
 * Plugs the fake into the real OpenSearch client: a Connection class (client option `Connection`) that answers
 * each serialized HTTP request from a FakeOpenSearch instead of the network. Everything above the socket —
 * request building, NDJSON serialization, response parsing, error mapping, retries — is the client's own code.
 */
import { Connection } from '@opensearch-project/opensearch';
import { Readable } from 'node:stream';
import type { ClientOptions } from '@opensearch-project/opensearch';
import { FakeOpenSearch } from './fake.js';

export function fakeConnection(fake: FakeOpenSearch): typeof Connection {
  class FakeConnection extends Connection {
    override request(params: any, callback: (err: Error | null, response: any) => void): any {
      const qs = typeof params.querystring === 'string' ? params.querystring : '';
      const query = Object.fromEntries(new URLSearchParams(qs));
      const body = params.body === undefined || params.body === null ? undefined : Buffer.isBuffer(params.body) ? params.body.toString('utf8') : String(params.body);
      let answer: { status: number; body: unknown };
      try {
        answer = fake.handle(params.method, params.path, query, body);
      } catch (err) {
        answer = { status: 500, body: { error: { type: 'fake_failure', reason: err instanceof Error ? err.message : String(err) }, status: 500 } };
      }
      const response = new Readable({ read() {} }) as Readable & { statusCode: number; headers: Record<string, string> };
      response.statusCode = answer.status;
      response.headers = { 'content-type': 'application/json; charset=UTF-8' };
      process.nextTick(() => {
        callback(null, response);
        response.push(params.method === 'HEAD' ? '' : JSON.stringify(answer.body));
        response.push(null);
      });
      return { abort() {}, on() {}, once() {}, removeListener() {} };
    }
  }
  return FakeConnection;
}

/** Client options that route the client to the fake */
export function fakeClientOptions(fake: FakeOpenSearch): Partial<ClientOptions> {
  return { Connection: fakeConnection(fake), maxRetries: 0 };
}

export { FakeOpenSearch };
