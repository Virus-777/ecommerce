/**
 * Server-Sent Events for spec endpoints whose response is "event-stream" (docs/api/spec/FORMAT.md): the
 * response stays open and the server writes events as they happen (wire format: docs/api/README.md,
 * "Live notifications").
 *
 * register.ts opens the stream after the middleware has accepted the request (token, caller, permission),
 * then calls the handler with it. The handler sends what it has, subscribes, and returns; the stream stays
 * open until the client goes away or the server ends it:
 *   - every heartbeat (25 s) writes `: ping` (proxies and firewalls drop silent connections) and checks the
 *     caller again: the session or account revoked → `signed_out`; a staff session idle → `session_idle`,
 *     expired → `signed_out` (AuthChain.streamGuard: these checks never count as staff activity);
 *   - a stream given a maxAge ends with `max_age` at the first heartbeat after it;
 *   - server shutdown ends every open stream with `restart` (preClose), so app.close() never waits on one.
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../lib/clock.js';

/** OpenAPI text of an event-stream response (docs/api/tools/build.mjs writes the same) */
export const EVENT_STREAM_TEXT =
  'A stream of Server-Sent Events (text/event-stream, UTF-8): the response stays open and the server writes each event as it happens. The endpoint description names the event types.';

/** Why the server ended a stream: the data of the last event, `end` */
export type StreamEndReason = 'signed_out' | 'session_idle' | 'restart' | 'max_age';

/** How long a client waits before reconnecting after the connection dropped (the `retry:` line) */
const RETRY_MS = 5000;
/** A client that reads nothing for this much buffered output is dropped (it reconnects and catches up) */
const MAX_BUFFERED_BYTES = 1024 * 1024;

export interface EventStream {
  /** One event: `id:` (when given), `event:` and `data:` (JSON, one line) */
  send(event: string, data: unknown, id?: string): void;
  /** A comment line, `: text`, which clients ignore */
  comment(text?: string): void;
  /** Writes `event: end` with the reason, then closes the response */
  end(reason: StreamEndReason): void;
  /** Ends the stream with `max_age` once it has been open this long (checked at each heartbeat) */
  maxAge(ms: number): void;
  /** Runs once when the stream closes, whoever closed it (unsubscribe here) */
  onClose(fn: () => void): void;
  readonly closed: boolean;
}

export interface EventStreamOptions {
  heartbeatMs: number;
  clock: Clock;
  /** Headers every API response carries (security.ts apiResponseHeaders) */
  headers: Record<string, string>;
  /** Asked at every heartbeat: a reason ends the stream, null keeps it open */
  guard(request: FastifyRequest): Promise<StreamEndReason | null>;
  log: FastifyBaseLogger;
}

/** The open streams of this server */
export class EventStreams {
  readonly #open = new Set<Stream>();

  constructor(private readonly o: EventStreamOptions) {}

  /** On shutdown, before the server stops: every stream ends with `restart` (clients reconnect after `retry`) */
  install(app: FastifyInstance) {
    app.addHook('preClose', async () => this.endAll('restart'));
  }

  /** Takes over the response from Fastify and writes the stream's head; the request already passed the middleware */
  open(request: FastifyRequest, reply: FastifyReply): EventStream {
    const stream = new Stream(request, reply, this.o, () => this.#open.delete(stream));
    this.#open.add(stream);
    return stream;
  }

  endAll(reason: StreamEndReason) {
    for (const s of [...this.#open]) s.end(reason);
  }

  get size() {
    return this.#open.size;
  }
}

class Stream implements EventStream {
  #closed = false;
  #checking = false;
  #deadline: number | undefined;
  readonly #timer: NodeJS.Timeout;
  readonly #onClose: (() => void)[] = [];

  constructor(
    private readonly request: FastifyRequest,
    private readonly reply: FastifyReply,
    private readonly o: EventStreamOptions,
    forget: () => void,
  ) {
    reply.hijack(); // Fastify sends nothing from here on: no serializer, no onSend hooks
    const raw = reply.raw;
    // headers set so far by the onRequest hooks (CORS, X-Request-Id) stay
    const kept = Object.fromEntries(Object.entries(reply.getHeaders()).filter(([, v]) => v !== undefined)) as Record<string, string | number | string[]>;
    raw.writeHead(200, {
      ...kept,
      ...o.headers,
      'content-type': 'text/event-stream; charset=utf-8',
      // no-transform: compressing proxies would hold events back
      'cache-control': 'private, no-store, no-transform',
      // nginx: pass every event on at once
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    raw.write(`retry: ${RETRY_MS}\n\n`);
    this.#timer = setInterval(() => void this.#heartbeat(), o.heartbeatMs);
    this.#timer.unref();
    // the client went away, or end() finished the response
    raw.on('close', () => {
      if (this.#closed) return;
      this.#closed = true;
      clearInterval(this.#timer);
      forget();
      for (const fn of this.#onClose.splice(0)) {
        try {
          fn();
        } catch (err) {
          this.o.log.error({ err }, 'event stream: onClose handler failed');
        }
      }
    });
  }

  get closed() {
    return this.#closed;
  }

  send(event: string, data: unknown, id?: string) {
    this.#write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  comment(text = '') {
    this.#write(`: ${text}\n\n`);
  }

  end(reason: StreamEndReason) {
    if (this.#closed || this.reply.raw.writableEnded) return;
    this.send('end', { reason });
    this.reply.raw.end();
  }

  maxAge(ms: number) {
    this.#deadline = this.o.clock.now().getTime() + ms;
  }

  onClose(fn: () => void) {
    if (this.#closed) fn();
    else this.#onClose.push(fn);
  }

  #write(text: string) {
    const raw = this.reply.raw;
    if (this.#closed || raw.writableEnded) return;
    if (raw.writableLength > MAX_BUFFERED_BYTES) {
      raw.destroy(); // a client that stopped reading: it reconnects and catches up with Last-Event-ID
      return;
    }
    raw.write(text);
  }

  async #heartbeat() {
    if (this.#closed || this.#checking) return;
    this.comment('ping');
    if (this.#deadline !== undefined && this.o.clock.now().getTime() >= this.#deadline) return this.end('max_age');
    this.#checking = true;
    try {
      const reason = await this.o.guard(this.request);
      if (reason) this.end(reason);
    } catch (err) {
      // the check could not run (identity unreachable): keep the stream and ask again at the next heartbeat
      this.o.log.warn({ err }, 'event stream: sign-in check failed');
    } finally {
      this.#checking = false;
    }
  }
}
