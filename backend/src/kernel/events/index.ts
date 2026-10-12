/**
 * In-process typed event bus (architecture §1 "Events"). Modules react to each other through
 * events instead of reading each other's tables. A module may publish only the events in its
 * spec's events.publishes and subscribe only to those in its events.consumes.
 *
 * Delivery is asynchronous and isolated: a failing subscriber is logged and never fails the publisher.
 * An outbox table replaces this in-memory dispatch later without changing module code.
 */
import type { FastifyBaseLogger } from 'fastify';
import { setImmediate, setTimeout } from 'node:timers/promises';
import type { z } from 'zod';
import type { Actor } from '../../spec/common.js';
import { isNotImplemented } from '../errors/index.js';
import { systemClock, type Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import type { ModuleSpecDef } from '../spec/define.js';
import type { EventMap } from './event-map.js';

/** PostgreSQL deadlock_detected and serialization_failure: the transaction was rolled back and may simply run again */
const TRANSIENT_DB_ERRORS = new Set(['40P01', '40001']);
const HANDLER_ATTEMPTS = 3;

export type { EventMap };
export type EventName = keyof EventMap & string;
export type EventPayload<N extends EventName> = EventMap[N];

export interface EventEnvelope<N extends EventName = EventName> {
  id: string;
  name: N;
  at: string;
  /** Module that published it */
  source: string;
  payload: EventMap[N];
  actor?: Actor;
  requestId?: string;
}

export interface PublishMeta {
  actor?: Actor;
  requestId?: string;
}

type Handler = (e: EventEnvelope) => unknown;

export class EventBus {
  readonly #handlers = new Map<string, { module: string; fn: Handler }[]>();
  readonly #schemas = new Map<string, () => z.ZodType>();
  readonly #pending = new Set<Promise<void>>();
  readonly #log: FastifyBaseLogger;
  readonly #validate: boolean;
  readonly #clock: Clock;

  constructor(log: FastifyBaseLogger, opts: { validatePayloads: boolean; clock?: Clock }) {
    this.#log = log;
    this.#validate = opts.validatePayloads;
    this.#clock = opts.clock ?? systemClock;
  }

  /** Payload schemas of every event the specs declare, used to check what modules publish. */
  registerSpecs(specs: Iterable<ModuleSpecDef>) {
    for (const spec of specs) for (const [name, e] of Object.entries(spec.events.publishes)) this.#schemas.set(name, e.payload);
  }

  subscribe(module: string, name: string, fn: Handler) {
    this.#handlers.set(name, [...(this.#handlers.get(name) ?? []), { module, fn }]);
  }

  publish(source: string, name: string, payload: unknown, meta: PublishMeta = {}): EventEnvelope {
    if (this.#validate) {
      const schema = this.#schemas.get(name);
      if (!schema) throw new Error(`Event ${name} is not declared in any spec`);
      const r = schema().safeParse(payload);
      if (!r.success) throw new Error(`Event ${name} payload does not match the spec: ${r.error.message}`);
    }
    const envelope = { id: newId(), name, at: this.#clock.now().toISOString(), source, payload, ...meta } as EventEnvelope;
    const handlers = this.#handlers.get(name);
    if (handlers?.length) {
      const delivery = this.#deliver(envelope, handlers).finally(() => this.#pending.delete(delivery));
      this.#pending.add(delivery);
    }
    return envelope;
  }

  async #deliver(envelope: EventEnvelope, handlers: { module: string; fn: Handler }[]) {
    await setImmediate(); // after the publisher's own work, like the outbox will
    await Promise.all(
      handlers.map(async (h) => {
        try {
          await this.#withRetry(envelope, h);
        } catch (err) {
          const level = isNotImplemented(err) ? 'debug' : 'error';
          this.#log[level]({ err, event: envelope.name, subscriber: h.module }, `subscriber ${h.module} failed on ${envelope.name}`);
        }
      }),
    );
  }

  /**
   * A handler that lost a deadlock or a serialization conflict had its transaction rolled back, so it runs again
   * (handlers are idempotent: their inbox claims commit with their effects). Other errors are not retried.
   */
  async #withRetry(envelope: EventEnvelope, h: { module: string; fn: Handler }) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await h.fn(envelope);
      } catch (err) {
        if (!TRANSIENT_DB_ERRORS.has((err as { code?: string })?.code ?? '') || attempt >= HANDLER_ATTEMPTS) throw err;
        this.#log.warn({ event: envelope.name, subscriber: h.module, code: (err as { code?: string }).code, attempt }, `subscriber ${h.module} retries ${envelope.name}`);
        await setTimeout(10 * attempt + Math.floor(Math.random() * 20));
      }
    }
  }

  /** Wait until every delivery started so far has finished (tests, graceful shutdown). */
  async drain() {
    while (this.#pending.size) await Promise.all(this.#pending);
  }
}

/** The bus as one module sees it. */
export interface ModuleEvents<Own extends string = string, Consumed extends string = string> {
  publish<N extends Own & EventName>(name: N, payload: EventMap[N], meta?: PublishMeta): EventEnvelope<N>;
  on<N extends Consumed & EventName>(name: N, handler: (e: EventEnvelope<N>) => unknown): void;
}

export function moduleEvents(bus: EventBus, spec: ModuleSpecDef): ModuleEvents {
  const { name: module, events } = spec;
  return {
    publish(name, payload, meta) {
      if (!(name in events.publishes)) throw new Error(`Module ${module} cannot publish ${name}: not in its spec events.publishes`);
      return bus.publish(module, name, payload, meta) as never;
    },
    on(name, handler) {
      if (!(name in events.consumes)) throw new Error(`Module ${module} subscribes to ${name}, which is not in its spec events.consumes`);
      bus.subscribe(module, name, handler as Handler);
    },
  };
}
