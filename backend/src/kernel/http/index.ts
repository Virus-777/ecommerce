/**
 * Typed handlers for spec endpoints. A module's http/<area>.ts calls
 *
 *   routes(endpoints, 'store', { getWishlist: async ({ query, principal }) => …, … })
 *
 * and the compiler checks there is exactly one handler per endpoint of that area, that params,
 * query and body have the spec's types, and that the handler returns the spec's response type.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Actor, Page } from '../../spec/common.js';
import type { Principal, SellerMemberAccess } from '../auth/index.js';
import type { Scope } from '../auth/scope.js';
import { notImplemented as notImplementedError } from '../errors/index.js';
import type { PageRequest } from '../lib/pagination.js';
import type { Area, EndpointDef, EndpointTable } from '../spec/define.js';

type Out<F> = F extends () => infer S ? (S extends z.ZodType ? z.output<S> : never) : undefined;

export type ParamsOf<E extends EndpointDef> = E['params'] extends () => z.ZodType ? Out<E['params']> : Record<string, never>;
export type QueryOf<E extends EndpointDef> = E['query'] extends () => z.ZodType ? Out<E['query']> : Record<string, never>;
export type BodyOf<E extends EndpointDef> = E['body'] extends () => z.ZodType ? Out<E['body']> : undefined;
export type ResponseOf<E extends EndpointDef> = E['response'] extends () => z.ZodType
  ? E['paging'] extends true
    ? Page<Out<E['response']>>
    : Out<E['response']>
  : void;

export interface HandlerInput<E extends EndpointDef> {
  params: ParamsOf<E>;
  query: QueryOf<E>;
  body: BodyOf<E>;
  /** Paging request for `paging: true` endpoints: cursor mode (app) or page mode (website) */
  page: E['paging'] extends true ? PageRequest : undefined;
  /** The verified caller. Every endpoint requires a token; only refresh, webhook and bootstrap calls have no principal */
  principal: E['auth'] extends 'provider' | 'refresh' | 'bootstrap' ? null : Principal;
  /** Seller-area calls: the seller the session acts for (seller-area paths never contain it) */
  sellerId: E['area'] extends 'seller' ? string : undefined;
  sellerAccess: E['area'] extends 'seller' ? SellerMemberAccess : undefined;
  /** Which records the caller reaches; read tenant tables through scoped(ctx.db, scope, spec.tenantTables) */
  scope: Scope;
  /** Whether the caller holds a permission (field-level decisions; endpoint permissions are already checked) */
  can(permission: string): Promise<boolean>;
  /** Who did it, for audit entries, timelines and events */
  actor: Actor;
  requestId: string;
  /** Idempotency-Key header (required on idempotent endpoints; replays are answered by the kernel) */
  idempotencyKey: E['idempotent'] extends true ? string : undefined;
  /** Operation id, e.g. wishlist.saveItem */
  operationId: string;
  request: FastifyRequest;
  reply: FastifyReply;
}

export type Handler<E extends EndpointDef> = (input: HandlerInput<E>) => Promise<ResponseOf<E>>;

export type AreaHandlers<T extends EndpointTable, A extends Area> = {
  [K in keyof T as T[K]['area'] extends A ? K : never]: Handler<T[K]>;
};

export interface RouteSet {
  readonly area: Area;
  readonly endpoints: EndpointTable;
  readonly handlers: Readonly<Record<string, Handler<any>>>;
}

export function routes<T extends EndpointTable, A extends Area>(endpoints: T, area: A, handlers: AreaHandlers<T, A>): RouteSet {
  return { area, endpoints, handlers: handlers as Record<string, Handler<any>> };
}

/** Placeholder for an endpoint that is designed but not built: answers 501 NOT_IMPLEMENTED. */
export const notImplemented = async (input: { operationId: string }): Promise<never> => {
  throw notImplementedError(input.operationId);
};

/** Placeholders of a route set that are still unbuilt (for npm run modules). */
export const isPlaceholder = (h: unknown) => h === notImplemented;
