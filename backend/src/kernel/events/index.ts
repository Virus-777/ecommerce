/**
 * In-process typed event bus (architecture §1 "Events"). Modules react to each other through
 * events instead of reading each other's tables. A module may publish only the events in its
 * spec's events.publishes and subscribe only to those in its events.consumes.
 *
 * Delivery is asynchronous and isolated: a failing subscriber is logged and never fails the publisher.
 * An outbox table replaces this in-memory dispatch later without changing module code.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { Actor } from '../../spec/common.js';
import { isAppError } from '../errors/index.js';
import { newId } from '../lib/ids.js';
import type { EventMap } from './event-map.js';

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
  readonly #pending = new Set<Promise<unknown>>();
  readonly #log: FastifyBaseLogger;
  readonly #validate: boolean;

  constructor(log: FastifyBaseLogger, opts: { validatePayloads: boolean }) {
    this.#log = log;
    this.#validate = opts.validatePayloads;
  }

  /** Payload schemas from the specs, used to check what modules publish. */
  registerSchema(name: string, schema: () => z.ZodType) {
    this.#schemas.set(name, schema);
  }

  knows(name: string) {
    return this.#schemas.has(name);
  }

  subscribe(module: string, name: string, fn: Handler) {
    const list = this.#handlers.get(name) ?? [];
    list.push({ module, fn });
    this.#handlers.set(name, list);
  }

  subscribers(name: string) {
    return (this.#handlers.get(name) ?? []).map((h) => h.module);
  }

  publish(source: string, name: string, payload: unknown, meta: PublishMeta = {}): EventEnvelope {
    if (this.#validate) {
      const schema = this.#schemas.get(name);
      if (!schema) throw new Error(`Event ${name} is not declared in any spec`);
      const r = schema().safeParse(payload);
      if (!r.success) throw new Error(`Event ${name} payload does not match the spec: ${r.error.message}`);
    }
    const envelope = { id: newId(), name, at: new Date().toISOString(), source, payload, ...meta } as EventEnvelope;
    for (const h of this.#handlers.get(name) ?? []) {
      const p = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => h.fn(envelope))
        .catch((err: unknown) => {
          const level = isAppError(err) && err.code === 'NOT_IMPLEMENTED' ? 'debug' : 'error';
          this.#log[level]({ err, event: name, subscriber: h.module }, `subscriber ${h.module} failed on ${name}`);
        })
        .finally(() => this.#pending.delete(p));
      this.#pending.add(p);
    }
    return envelope;
  }

  /** Wait until every delivery started so far has finished (tests, graceful shutdown). */
  async drain() {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }
}

/** The bus as one module sees it. */
export interface ModuleEvents<Own extends string = string, Consumed extends string = string> {
  publish<N extends Own & EventName>(name: N, payload: EventMap[N], meta?: PublishMeta): EventEnvelope<N>;
  on<N extends Consumed & EventName>(name: N, handler: (e: EventEnvelope<N>) => unknown): void;
}

export function moduleEvents(bus: EventBus, module: string, publishes: readonly string[], consumes: readonly string[]): ModuleEvents {
  const own = new Set(publishes);
  const consumed = new Set(consumes);
  return {
    publish(name, payload, meta) {
      if (!own.has(name)) throw new Error(`Module ${module} cannot publish ${name}: not in its spec events.publishes`);
      return bus.publish(module, name, payload, meta) as never;
    },
    on(name, handler) {
      if (!consumed.has(name)) throw new Error(`Module ${module} subscribes to ${name}, which is not in its spec events.consumes`);
      bus.subscribe(module, name, handler as Handler);
    },
  };
}
