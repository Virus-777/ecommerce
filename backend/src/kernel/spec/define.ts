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
  /** Fresh proof: a single-use re-auth token for this purpose in the body (reauthToken) */
  readonly stepUp?: { readonly kind: 'reauth'; readonly purpose: string };
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
  /** null → no content (or an event stream, below) */
  readonly response: (() => z.ZodType) | null;
  /** event-stream: the response stays open and carries Server-Sent Events (kernel/http/event-stream.ts); GET, status 200 */
  readonly responseFormat?: 'event-stream';
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
  readonly approvalActions: readonly { readonly key: string; readonly desc: string; readonly limit: string; readonly secondReviewer: string; readonly stepUp?: string; readonly approvers?: string }[];
  readonly stateMachines: Readonly<Record<string, StateMachineDef>>;
  readonly events: {
    readonly publishes: Readonly<Record<string, { readonly when: string; readonly payload: () => z.ZodType }>>;
    readonly consumes: Readonly<Record<string, string>>;
  };
  readonly jobs: Readonly<Record<string, { readonly schedule: string; readonly does: string }>>;
  readonly settings: Readonly<Record<string, SettingDecl>>;
  readonly errorCodes: Readonly<Record<string, { readonly status: number; readonly meaning: string }>>;
  /** table → its MongoDB collection: _id field, validator and indexes (tools/lib/mongo.ts, docs/04-mongodb-migration.md) */
  readonly collections: Readonly<Record<string, CollectionDef>>;
  /** table → its MySQL table: columns, types to convert and unique keys (tools/lib/mysql.ts, docs/10-mysql-migration.md) */
  readonly tables?: Readonly<Record<string, TableDef>>;
  readonly endpoints: EndpointTable;
}

export interface MongoIndexDef {
  readonly name: string;
  readonly key: Readonly<Record<string, 1 | -1 | 'text'>>;
  readonly unique?: boolean;
  readonly partial?: Readonly<Record<string, unknown>>;
  readonly collation?: Readonly<{ locale: string; strength: number }>;
}

/** A spec table as a MongoDB collection `<module>.<table>` */
export interface CollectionDef {
  /** The column stored as _id (single-column primary key), else null (generated _id) */
  readonly idField: string | null;
  /** Primary key columns */
  readonly key: readonly string[];
  /** Stored columns (tsvector columns are not) */
  readonly columns: readonly string[];
  readonly nullable: readonly string[];
  /** numeric columns: Decimal128 in MongoDB, strings in JS */
  readonly decimal: readonly string[];
  /** bytea columns: binary in MongoDB, Uint8Array in JS */
  readonly binary: readonly string[];
  /** timestamptz columns */
  readonly dates: readonly string[];
  /** identity / bigserial column numbered from a kernel counter */
  readonly identity: string | null;
  readonly validator: Readonly<Record<string, unknown>>;
  readonly indexes: readonly MongoIndexDef[];
  /** Spec unique indexes MongoDB can't express yet: the module's repository enforces them (docs/04 §2) */
  readonly unenforced: readonly string[];
}

export function defineModuleSpec<const S extends ModuleSpecDef>(spec: S): S {
  return spec;
}

/** One unique key of a table, as `insertIfAbsent` and `upsert` need to know it */
export interface UniqueKeyDef {
  /** The index name MySQL reports in a duplicate-key error (1062); the primary key is `PRIMARY` */
  readonly name: string;
  readonly columns: readonly string[];
  /** A partial unique index (`unique (a) where …`): it only refuses rows its condition covers */
  readonly partial?: boolean;
}

/**
 * A spec table as a MySQL table `<module>_<table>` (docs/10-mysql-migration.md §10.4). The lists of columns by
 * type are what `Table` needs to turn rows into parameters and rows back again: mysql2 reads and writes most
 * types correctly on its own, and these are the ones it cannot know about from the value alone.
 */
export interface TableDef {
  /** `<module>_<table>` (`-` replaced by `_`) */
  readonly table: string;
  /** Primary key columns */
  readonly key: readonly string[];
  /** The single primary key column, else null (get/update/delete by id need one) */
  readonly idColumn: string | null;
  /** Stored columns, in spec order (tsvector columns are not stored) */
  readonly columns: readonly string[];
  readonly nullable: readonly string[];
  /** DECIMAL columns: exact, so strings in JS both ways */
  readonly decimal: readonly string[];
  /** BINARY/BLOB columns: Uint8Array in JS, Buffer on the wire */
  readonly binary: readonly string[];
  /** DATETIME(3) columns: Date in JS (a DATE column is a 'YYYY-MM-DD' string and is not here) */
  readonly dates: readonly string[];
  /** JSON columns, arrays included: mysql2 parses them on the way out but not on the way in */
  readonly json: readonly string[];
  /** TINYINT(1) columns: booleans in JS */
  readonly booleans: readonly string[];
  /** AUTO_INCREMENT column, numbered by the server */
  readonly identity: string | null;
  /** Every unique key, primary key first: a duplicate-key error names one of these */
  readonly uniqueKeys: readonly UniqueKeyDef[];
}
