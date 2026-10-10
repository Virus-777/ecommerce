/**
 * Shapes of the generated spec files (src/spec/*.ts). The generator writes plain data in these
 * shapes; the kernel reads them to register routes, check wiring and validate events.
 */
import type { z } from 'zod';

export type Area = 'store' | 'seller' | 'admin' | 'public' | 'webhooks';
/** Every endpoint requires a token (docs/03-auth-middleware.md §0); the kind says which */
export type AuthKind = 'visitor' | 'shopper' | 'customer' | 'account' | 'seller' | 'staff' | 'refresh' | 'provider' | 'bootstrap';
/** Which records a caller reaches (§7) */
export type EndpointScope = 'public' | 'own-customer' | 'own-seller' | 'own-member' | 'guest-order' | 'staff';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One endpoint of docs/api/spec/modules/<module>.json (format: docs/api/spec/FORMAT.md). */
export interface EndpointDef {
  readonly area: Area;
  readonly method: HttpMethod;
  /** Relative to the area prefix: /api/<area>/<module><path> */
  readonly path: string;
  readonly auth: AuthKind;
  readonly permission?: string;
  /** Extra permission when the request is about someone else, e.g. { if: { 'query.view': 'all' } } or { 'body.accountId': '!self' } */
  readonly permissionWhen?: readonly { readonly if: Readonly<Record<string, string>>; readonly permission: string }[];
  /** Fresh proof: reauth = reauthToken in the body; code = X-Step-Up-Code header */
  readonly stepUp?: { readonly kind: 'reauth' | 'code'; readonly purpose: string };
  /** Seller area: allowed before a seller is chosen */
  readonly sellerContext?: 'optional';
  readonly scope: EndpointScope;
  /** Named rate-limit class (sign-in, registration, password-reset, code, bootstrap) */
  readonly rateLimit?: string;
  /** Response fields masked for staff and sellers without the permission */
  readonly sensitive?: readonly { readonly path: readonly string[]; readonly permission: string; readonly mask: string }[];
  readonly summary: string;
  readonly desc?: string;
  readonly params?: () => z.ZodType;
  readonly query?: () => z.ZodType;
  /** Adds cursor/page/limit to the query and wraps the response in Page<…> */
  readonly paging?: boolean;
  readonly body?: () => z.ZodType;
  /** binary: the body is the raw request bytes (any content type), handed to the handler as a stream (never buffered) */
  readonly bodyFormat?: 'binary';
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

/**
 * A module's runtime setting (docs/api/spec/FORMAT.md "Settings"). Only default and desc are always
 * present; the settings module infers what the spec leaves out.
 */
export interface SettingDecl {
  readonly default: unknown;
  readonly desc: string;
  readonly type?: 'int' | 'number' | 'bool' | 'string' | 'money' | 'duration' | 'time' | 'enum' | 'json';
  readonly min?: number;
  readonly max?: number;
  /** type enum: the allowed values */
  readonly choices?: readonly string[];
  readonly unit?: string;
  readonly approval?: 'none' | 'second_reviewer' | 'business_owner';
  readonly sellerVisible?: boolean;
  readonly minLeadDays?: number;
  /** false = shown read-only (default true) */
  readonly editable?: boolean;
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
  readonly permissions: readonly { readonly key: string; readonly audience: string; readonly desc: string; readonly ownerOnly?: boolean; readonly delegable?: boolean }[];
  readonly approvalActions: readonly { readonly key: string; readonly desc: string; readonly limit: string; readonly secondReviewer: string; readonly approvers?: string }[];
  readonly stateMachines: Readonly<Record<string, StateMachineDef>>;
  readonly events: {
    readonly publishes: Readonly<Record<string, { readonly when: string; readonly payload: () => z.ZodType }>>;
    readonly consumes: Readonly<Record<string, string>>;
  };
  readonly jobs: Readonly<Record<string, { readonly schedule: string; readonly does: string }>>;
  readonly settings: Readonly<Record<string, SettingDecl>>;
  readonly errorCodes: Readonly<Record<string, { readonly status: number; readonly meaning: string }>>;
  /** table → column → { type, nullable } as declared in the spec (used to detect migration drift) */
  readonly tables: Readonly<Record<string, Readonly<Record<string, { readonly type: string; readonly nullable: boolean }>>>>;
  /** table → owner column per caller kind (seller_id, customer_id, guest_session_id) */
  readonly tenantTables: Readonly<Record<string, Readonly<{ seller?: string; customer?: string; visitor?: string }>>>;
  readonly endpoints: EndpointTable;
}

export function defineModuleSpec<const S extends ModuleSpecDef>(spec: S): S {
  return spec;
}
