/**
 * Shapes of the generated spec files (src/spec/*.ts). The generator writes plain data in these
 * shapes; the kernel reads them to register routes, check wiring and validate events.
 */
import type { z } from 'zod';

export type Area = 'store' | 'seller' | 'admin' | 'public' | 'webhooks';
export type AuthKind = 'anyone' | 'shopper' | 'customer' | 'seller' | 'staff' | 'provider';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One endpoint of docs/api/spec/modules/<module>.json (format: docs/api/spec/FORMAT.md). */
export interface EndpointDef {
  readonly area: Area;
  readonly method: HttpMethod;
  /** Relative to the area prefix: /api/<area>/<module><path> */
  readonly path: string;
  readonly auth: AuthKind;
  readonly permission?: string;
  readonly summary: string;
  readonly desc?: string;
  readonly params?: () => z.ZodType;
  readonly query?: () => z.ZodType;
  /** Adds cursor/page/limit to the query and wraps the response in Page<…> */
  readonly paging?: boolean;
  readonly body?: () => z.ZodType;
  /** null → no content */
  readonly response: (() => z.ZodType) | null;
  readonly status: number;
  readonly errors?: readonly string[];
  /** Idempotency-Key header required */
  readonly idempotent?: boolean;
  readonly audited?: boolean;
  readonly approval?: string;
  readonly events?: readonly string[];
  readonly screens?: readonly string[];
  /** Launch phase (plan ch. 20). Above the configured LAUNCH_PHASE the endpoint answers NOT_IMPLEMENTED. */
  readonly phase: number;
}

export type EndpointTable = Record<string, EndpointDef>;

/** Keeps the literal types of an endpoint table (areas, auth kinds, schemas) for typed handlers. */
export const defineEndpoints = <const T extends EndpointTable>(endpoints: T): T => endpoints;

export interface StateMachineDef {
  readonly field: string;
  readonly initial: string | null;
  readonly transitions: readonly (readonly [string, string, string])[];
}

export interface ModuleSpecDef {
  readonly name: string;
  readonly title: string;
  readonly group: string;
  readonly phase: number;
  readonly chapters: readonly number[];
  readonly summary: string;
  readonly dependsOn: readonly string[];
  readonly optionalDeps: readonly string[];
  readonly publicApi: readonly string[];
  readonly permissions: readonly { readonly key: string; readonly audience: string; readonly desc: string }[];
  readonly approvalActions: readonly { readonly key: string; readonly desc: string; readonly limit: string; readonly secondReviewer: string; readonly approvers?: string }[];
  readonly stateMachines: Readonly<Record<string, StateMachineDef>>;
  readonly events: {
    readonly publishes: Readonly<Record<string, { readonly when: string; readonly payload: () => z.ZodType }>>;
    readonly consumes: Readonly<Record<string, string>>;
  };
  readonly jobs: Readonly<Record<string, { readonly schedule: string; readonly does: string }>>;
  readonly settings: Readonly<Record<string, { readonly default: unknown; readonly desc: string }>>;
  readonly errorCodes: Readonly<Record<string, { readonly status: number; readonly meaning: string }>>;
  /** table → column → { type, nullable } as declared in the spec (used to detect migration drift) */
  readonly tables: Readonly<Record<string, Readonly<Record<string, { readonly type: string; readonly nullable: boolean }>>>>;
  readonly endpoints: EndpointTable;
}

export function defineModuleSpec<const S extends ModuleSpecDef>(spec: S): S {
  return spec;
}
