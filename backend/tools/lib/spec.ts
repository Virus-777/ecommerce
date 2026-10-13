/**
 * Loads the API design (docs/api/spec) for the generator and the check tools.
 * The spec is the source of truth; the backend never defines routes, types, tables,
 * events or permissions that are not in it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const repoDir = resolve(backendDir, '..');
export const apiDir = join(repoDir, 'docs', 'api');
export const specDir = join(apiDir, 'spec');
export const gqlDir = join(apiDir, 'graphql');

export type TypeExpr = string | { type: string; desc?: string } | { [field: string]: TypeExpr };
export type ObjectExpr = Record<string, TypeExpr>;

export interface EndpointSpec {
  id: string;
  area: 'store' | 'seller' | 'admin' | 'public' | 'webhooks';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  desc?: string;
  auth: 'visitor' | 'shopper' | 'customer' | 'account' | 'seller' | 'staff' | 'refresh' | 'provider' | 'bootstrap';
  permission?: string;
  params?: ObjectExpr;
  query?: ObjectExpr;
  paging?: boolean;
  /** A type, or "binary": the raw request bytes (any content type), received as a Uint8Array */
  body?: TypeExpr;
  response?: TypeExpr | null;
  status?: number;
  errors?: string[];
  idempotent?: boolean;
  audited?: boolean;
  approval?: string;
  events?: string[];
  screens?: string[];
  phase?: number;
  stepUp?: { kind: 'reauth' | 'code'; purpose: string };
  sellerContext?: 'optional';
  permissionWhen?: { if: Record<string, string>; permission: string }[];
  scope?: EndpointScope;
  rateLimit?: string;
}

/** Which records a caller reaches (docs/03-auth-middleware.md §7) */
export type EndpointScope = 'public' | 'own-customer' | 'own-seller' | 'own-member' | 'guest-order' | 'staff';

export interface TableSpec {
  name: string;
  desc?: string;
  columns: Record<string, string>;
  /** "(a, b)", "unique (a) where …", "unique nulls not distinct (a, b)", "pk (a, b)", "gin(expr)" (lib/tables.ts, lib/mongo.ts) */
  indexes?: string[];
  /** Owner column, for readers of the spec (FORMAT.md rule 9); false = not a tenant table. Services filter by it. */
  tenant?: string | false;
}

/** A runtime setting a module reads through ctx.settings; the settings module shows and changes it (docs/api/spec/FORMAT.md "Settings") */
export interface SettingSpec {
  key: string;
  default: unknown;
  desc: string;
  type?: SettingType;
  min?: number;
  max?: number;
  /** enum: the allowed values */
  choices?: string[];
  unit?: string;
  /** Who approves a change: none, a second reviewer, or the Business Owner */
  approval?: SettingApproval;
  /** Changes are announced to sellers before they take effect */
  sellerVisible?: boolean;
  /** Earliest effective date after saving, in days */
  minLeadDays?: number;
  /** False = shown read-only (default true) */
  editable?: boolean;
}

export const SETTING_TYPES = ['int', 'number', 'bool', 'string', 'money', 'duration', 'time', 'enum', 'json'] as const;
export type SettingType = (typeof SETTING_TYPES)[number];
export const SETTING_APPROVALS = ['none', 'second_reviewer', 'business_owner'] as const;
export type SettingApproval = (typeof SETTING_APPROVALS)[number];

export interface ModuleSpec {
  name: string;
  title: string;
  group: string;
  phase: number;
  chapters?: number[];
  summary: string;
  owns: string[];
  notOwns?: string[];
  dependsOn?: string[];
  optionalDeps?: string[];
  publicApi?: { name: string; signature: string; desc: string; usedBy?: string[] }[];
  types?: Record<string, ObjectExpr>;
  tables?: TableSpec[];
  stateMachines?: { name: string; field: string; initial?: string; transitions: [string, string, string][]; notes?: string }[];
  endpoints: EndpointSpec[];
  events?: {
    publishes?: { name: string; when: string; payload?: ObjectExpr }[];
    consumes?: { name: string; does: string }[];
  };
  permissions?: { key: string; audience: 'staff' | 'seller'; desc: string; ownerOnly?: boolean; delegable?: boolean }[];
  approvalActions?: { key: string; desc: string; limit: string; secondReviewer: string; approvers?: string }[];
  jobs?: { name: string; schedule: string; does: string }[];
  settings?: SettingSpec[];
  integrations?: { name: string; purpose: string }[];
  errorCodes?: Record<string, { status: number; meaning: string }>;
  notes?: string[];
}

export interface CommonSpec {
  info: { title: string; version: string; description: string };
  servers?: { url: string; description?: string }[];
  areas: Record<string, { prefix: string; title: string; audience: string; auth: string }>;
  auth: Record<string, string>;
  types: Record<string, ObjectExpr>;
  pagination: { query: ObjectExpr };
  errors: Record<string, { status: number; meaning: string }>;
  headers: Record<string, string>;
  /** Reserved values every module may use (e.g. OFFICIAL_STORE_ID) */
  constants?: Record<string, { value: string | number | boolean; desc: string }>;
}

export function loadCommon(): CommonSpec {
  return JSON.parse(readFileSync(join(specDir, 'common.json'), 'utf8'));
}

export function loadModules(): ModuleSpec[] {
  return readdirSync(join(specDir, 'modules'))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(specDir, 'modules', f), 'utf8')) as ModuleSpec);
}

/** A text source with LF line endings, whatever the checkout (core.autocrlf) wrote: generated code must not depend on it */
export const readText = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

export function loadFragment(module: string): string | null {
  const p = join(gqlDir, 'modules', `${module}.graphql`);
  return existsSync(p) ? readText(p) : null;
}

/** kebab-case module name → identifiers */
export const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
export const pascal = (s: string) => {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

/** Dotted or snake_case words → PascalCase: 'orders.order.price_changed' → 'OrdersOrderPriceChanged' */
export const pascalWords = (s: string) => s.split(/[._-]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');

/** A property key as written in TypeScript: bare when it is an identifier, quoted otherwise */
export const propKey = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

/** Text that is safe inside a comment, on one line */
export const commentText = (text: string) => text.replace(/\s+/g, ' ').replace(/\*\//g, '*\\/');

/** A one-line JSDoc comment */
export const doc = (text: string | undefined, indent = '') => (text ? `${indent}/** ${commentText(text)} */\n` : '');

/** One handler per consumed event, even when the spec lists an event twice with two reactions. */
export function mergeConsumes(mod: ModuleSpec) {
  const byName = new Map<string, string[]>();
  for (const c of mod.events?.consumes ?? []) byName.set(c.name, [...(byName.get(c.name) ?? []), c.does]);
  return [...byName].map(([name, does]) => ({ name, does: does.join(' Also: ') }));
}
