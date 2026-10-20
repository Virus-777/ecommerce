#!/usr/bin/env node
/**
 * Marketly API design build.
 *
 *   node docs/api/tools/build.mjs            validate + generate everything
 *   node docs/api/tools/build.mjs --check    validate only
 *   node docs/api/tools/build.mjs --partial  references to modules that don't exist yet are warnings (while specs are being written)
 *   node docs/api/tools/build.mjs --only finance   validate one module (implies --partial)
 *
 * Inputs : docs/api/spec/common.json, docs/api/spec/modules/*.json, design/prototype (screen ids)
 * Outputs: docs/api/openapi.json, docs/api/README.md, docs/api/modules/<module>.md, docs/api/viewer/data.js
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '..');
const specDir = join(apiDir, 'spec');
const repoRoot = join(apiDir, '..', '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const PARTIAL = args.includes('--partial') || Boolean(only);
const CHECK = args.includes('--check') || Boolean(only);

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const soft = (where, msg) => (PARTIAL ? warnings : errors).push(`${where}: ${msg}`);

/* ------------------------------------------------------------------ load */
const common = JSON.parse(readFileSync(join(specDir, 'common.json'), 'utf8'));
const moduleFiles = readdirSync(join(specDir, 'modules')).filter((f) => f.endsWith('.json')).sort();
const modules = [];
for (const f of moduleFiles) {
  try {
    modules.push({ file: f, ...JSON.parse(readFileSync(join(specDir, 'modules', f), 'utf8')) });
  } catch (e) {
    err(f, `invalid JSON: ${e.message}`);
  }
}
const byName = new Map(modules.map((m) => [m.name, m]));

/* Prototype screens (Phase 1) for traceability */
function loadScreens() {
  const proto = join(repoRoot, 'design', 'prototype', 'js');
  if (!existsSync(proto)) return new Map();
  const noop = () => {};
  const ctx = { console: { log: noop, warn: noop, error: noop }, document: { createElement: () => ({ dataset: {}, style: {} }), head: { appendChild: noop } }, location: { hash: '' } };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['core.js', 'data.js', ...readdirSync(join(proto, 'screens')).map((s) => `screens/${s}`)]) {
    try { vm.runInContext(readFileSync(join(proto, f), 'utf8'), ctx); } catch { /* ignore one broken file */ }
  }
  const screens = new Map();
  for (const [area, groups] of Object.entries(ctx.UI.CATALOGUE)) {
    for (const [group, ids] of groups) for (const id of ids) screens.set(id, { id, area, group, title: ctx.UI.screens[id]?.title ?? id });
  }
  // screens designed in React after the prototype (the web apps' catalogue entries without a prototype file)
  for (const [id, area, group, title] of REACT_SCREENS) if (!screens.has(id)) screens.set(id, { id, area, group, title });
  return screens;
}
const REACT_SCREENS = [
  ['store/news', 'store', 'Help and policies', 'News'],
  ['store/news-post', 'store', 'Help and policies', 'News post'],
  ['admin/news', 'admin', 'Marketing and content', 'News'],
];
const SCREENS = loadScreens();

/* ------------------------------------------------------------------ types */
const PRIMS = {
  string: { type: 'string' }, text: { type: 'string' }, int: { type: 'integer' }, number: { type: 'number' }, bool: { type: 'boolean' },
  json: {}, uuid: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' }, url: { type: 'string', format: 'uri' },
  date: { type: 'string', format: 'date' }, datetime: { type: 'string', format: 'date-time' },
};
const COMMON_TYPES = new Set(Object.keys(common.types));

/** A field descriptor { type, desc?, permission?, mask? }, as opposed to an object with a field named "type" */
const DESCRIPTOR_KEYS = new Set(['type', 'desc', 'permission', 'mask']);
const isDescriptor = (e) => !!e && typeof e === 'object' && !Array.isArray(e) && typeof e.type === 'string' && Object.keys(e).every((k) => DESCRIPTOR_KEYS.has(k));

/** Parse a type expression into { schema, optional }. `mod` = owning module (for local types). */
function typeToSchema(expr, mod, where) {
  if (expr && typeof expr === 'object' && !Array.isArray(expr)) {
    if (isDescriptor(expr)) {
      const r = typeToSchema(expr.type, mod, where);
      if (expr.desc) r.schema = { ...r.schema, description: expr.desc };
      return r;
    }
    return { schema: objectSchema(expr, mod, where), optional: false };
  }
  if (typeof expr !== 'string') { err(where, `bad type ${JSON.stringify(expr)}`); return { schema: {}, optional: false }; }
  let t = expr.trim();
  let optional = false;
  if (t.endsWith('?')) { optional = true; t = t.slice(0, -1).trim(); }
  let schema;
  if (t.endsWith('[]')) {
    schema = { type: 'array', items: typeToSchema(t.slice(0, -2), mod, where).schema };
  } else if (/^enum\(.+\)$/.test(t)) {
    schema = { type: 'string', enum: t.slice(5, -1).split('|').map((s) => s.trim()) };
  } else if (/^map<.+>$/.test(t)) {
    schema = { type: 'object', additionalProperties: typeToSchema(t.slice(4, -1), mod, where).schema };
  } else if (/^Page<.+>$/.test(t)) {
    schema = pageSchema(typeToSchema(t.slice(5, -1), mod, where).schema);
  } else if (PRIMS[t]) {
    schema = { ...PRIMS[t] };
  } else if (COMMON_TYPES.has(t)) {
    schema = { $ref: `#/components/schemas/${t}` };
  } else if (t.includes('.')) {
    const [m, name] = t.split('.');
    const target = byName.get(m);
    if (!target) soft(where, `type "${t}": module "${m}" has no spec yet`);
    else if (!target.types?.[name]) err(where, `type "${t}": module "${m}" has no type "${name}"`);
    schema = { $ref: `#/components/schemas/${m}.${name}` };
  } else if (mod?.types?.[t]) {
    schema = { $ref: `#/components/schemas/${mod.name}.${t}` };
  } else {
    err(where, `unknown type "${t}"`);
    schema = {};
  }
  if (optional) schema = schema.$ref ? { anyOf: [schema, { type: 'null' }] } : { ...schema, type: schema.type ? [schema.type, 'null'] : undefined };
  return { schema, optional };
}

function objectSchema(obj, mod, where) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(obj)) {
    const { schema, optional } = typeToSchema(v, mod, `${where}.${k}`);
    properties[k] = schema;
    if (!optional) required.push(k);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

const pageSchema = (item) => ({
  type: 'object',
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', items: item },
    nextCursor: { type: ['string', 'null'], description: 'Pass as ?cursor= for the next batch (app). Null at the end.' },
    page: { type: 'integer' }, totalPages: { type: 'integer' }, total: { type: 'integer' },
  },
});

/* ------------------------------------------------------------------ validate */
const GROUPS = ['Platform', 'Participants', 'Catalog and stock', 'Buying', 'After-sales and money', 'Growth', 'Later phases'];
const AREAS = Object.keys(common.areas);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const AUTHS = Object.keys(common.auth);
const allPermissions = new Map();
const allPublished = new Map();
for (const m of modules) {
  for (const p of m.permissions ?? []) allPermissions.set(p.key, m.name);
  for (const e of m.events?.publishes ?? []) allPublished.set(e.name, m.name);
}
/** Reauth step-up purposes identity issues tokens for (identity ReauthRequest.purpose enum); null when identity is absent */
const reauthPurposes = (() => {
  const t = modules.find((x) => x.name === 'identity')?.types?.ReauthRequest?.purpose;
  const enumOf = /^enum\((.*)\)\??$/.exec(typeof t === 'string' ? t : (t?.type ?? ''));
  return enumOf ? enumOf[1].split('|') : null;
})();
const SETTING_FIELDS = new Set(['key', 'default', 'desc', 'type', 'min', 'max', 'choices', 'unit', 'approval', 'sellerVisible', 'minLeadDays', 'editable']);
const SETTING_TYPES = ['int', 'number', 'bool', 'string', 'money', 'duration', 'time', 'enum', 'json'];
const SETTING_APPROVALS = ['none', 'second_reviewer', 'business_owner'];
/** A request body of raw bytes (any content type) instead of JSON */
const BINARY_BODY = 'binary';
/** A response that stays open and carries Server-Sent Events (text/event-stream) instead of one JSON body */
const EVENT_STREAM = 'event-stream';
/** OpenAPI text of an event-stream response (the backend's kernel/http/event-stream.ts EVENT_STREAM_TEXT is the same) */
const EVENT_STREAM_TEXT = 'A stream of Server-Sent Events (text/event-stream, UTF-8): the response stays open and the server writes each event as it happens. The endpoint description names the event types.';
const fullPath = (m, ep) => common.areas[ep.area].prefix.replace('{module}', m.name) + ep.path;
const seenRoutes = new Map();
for (const [name, c] of Object.entries(common.constants ?? {})) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) err('common.json', `constant "${name}" must be UPPER_SNAKE`);
  if (!['string', 'number', 'boolean'].includes(typeof c?.value)) err('common.json', `constant "${name}" needs a string, number or boolean "value"`);
  if (typeof c?.desc !== 'string' || !c.desc) err('common.json', `constant "${name}" needs a "desc"`);
}

for (const m of modules) {
  const W = m.file;
  if (only && m.name !== only) continue;
  if (m.file !== `${m.name}.json`) err(W, `file name must be ${m.name}.json`);
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(m.name ?? '')) err(W, 'name must be kebab-case');
  for (const k of ['title', 'group', 'phase', 'summary', 'owns', 'endpoints']) if (m[k] === undefined) err(W, `missing "${k}"`);
  if (m.group && !GROUPS.includes(m.group)) err(W, `group must be one of: ${GROUPS.join(', ')}`);
  if (![1, 2, 3, 4].includes(m.phase)) err(W, 'phase must be 1–4');
  for (const d of [...(m.dependsOn ?? []), ...(m.optionalDeps ?? [])]) if (!byName.has(d)) soft(W, `dependency "${d}" has no spec yet`);
  for (const [name, t] of Object.entries(m.types ?? {})) objectSchema(t, m, `${W} types.${name}`);
  for (const p of m.permissions ?? []) {
    if (!p.key.startsWith(`${m.name}.`)) err(W, `permission "${p.key}" must start with "${m.name}."`);
    if (!['staff', 'seller'].includes(p.audience)) err(W, `permission "${p.key}" audience must be staff or seller`);
  }
  for (const a of m.approvalActions ?? []) {
    if (!a.key?.startsWith(`${m.name}.`)) err(W, `approval action "${a.key}" must start with "${m.name}."`);
    if (!['money', 'units', 'percent', 'none'].includes(a.limit)) err(W, `approval action "${a.key}" limit must be money, units, percent or none`);
    if (!['always', 'above-limit', 'never'].includes(a.secondReviewer)) err(W, `approval action "${a.key}" secondReviewer must be always, above-limit or never`);
  }
  for (const s of m.settings ?? []) {
    const S = `${W} setting ${s.key}`;
    if (!/^[a-z][A-Za-z0-9]*$/.test(s.key ?? '')) err(S, 'key must be camelCase');
    if (s.default === undefined) err(S, 'missing "default"');
    if (!s.desc) err(S, 'missing "desc"');
    for (const k of Object.keys(s)) if (!SETTING_FIELDS.has(k)) err(S, `unknown field "${k}"`);
    if (s.type !== undefined && !SETTING_TYPES.includes(s.type)) err(S, `type must be one of ${SETTING_TYPES.join(', ')}`);
    if (s.approval !== undefined && !SETTING_APPROVALS.includes(s.approval)) err(S, `approval must be one of ${SETTING_APPROVALS.join(', ')}`);
    for (const k of ['min', 'max']) if (s[k] !== undefined && typeof s[k] !== 'number') err(S, `${k} must be a number`);
    if (s.min !== undefined && s.max !== undefined && s.min > s.max) err(S, 'min is above max');
    if (s.minLeadDays !== undefined && !(Number.isInteger(s.minLeadDays) && s.minLeadDays >= 0)) err(S, 'minLeadDays must be a whole number of days');
    for (const k of ['sellerVisible', 'editable']) if (s[k] !== undefined && typeof s[k] !== 'boolean') err(S, `${k} must be true or false`);
    if (s.unit !== undefined && typeof s.unit !== 'string') err(S, 'unit must be a string');
    if (s.choices !== undefined && !(Array.isArray(s.choices) && s.choices.length && s.choices.every((c) => typeof c === 'string'))) err(S, 'choices must be a list of strings');
    if (s.type === 'enum' && !s.choices) err(S, 'type enum needs choices');
    if (s.choices && s.type !== 'enum') err(S, 'choices only go with type enum');
    if (s.type === 'enum' && s.choices && s.default !== null && !s.choices.includes(s.default)) err(S, 'default is not one of the choices');
    const isMoney = (v) => !!v && typeof v === 'object' && Number.isInteger(v.amount) && typeof v.currency === 'string';
    const fits = { int: (v) => Number.isInteger(v), number: (v) => typeof v === 'number', bool: (v) => typeof v === 'boolean', string: (v) => typeof v === 'string', duration: (v) => Number.isInteger(v), time: (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v), money: isMoney, enum: () => true, json: () => true }[s.type];
    if (fits && s.default !== null && !fits(s.default)) err(S, `default does not match type ${s.type}`);
    if (typeof s.default === 'number' && ((s.min !== undefined && s.default < s.min) || (s.max !== undefined && s.default > s.max))) err(S, 'default is outside min/max');
  }
  const published = new Set((m.events?.publishes ?? []).map((e) => e.name));
  for (const e of m.events?.publishes ?? []) {
    if (!e.name.startsWith(`${m.name}.`)) err(W, `event "${e.name}" must start with "${m.name}."`);
    if (e.payload) objectSchema(e.payload, m, `${W} event ${e.name}`);
  }
  for (const e of m.events?.consumes ?? []) if (!allPublished.has(e.name)) soft(W, `consumes "${e.name}" which no module publishes`);
  for (const sm of m.stateMachines ?? []) {
    const states = new Set(sm.transitions.flatMap(([a, , b]) => [a, b]));
    if (sm.initial && !states.has(sm.initial)) err(W, `state machine "${sm.name}": initial "${sm.initial}" is not a state`);
  }
  const ids = new Set();
  for (const ep of m.endpoints ?? []) {
    const E = `${W} ${ep.id ?? '(no id)'}`;
    if (!ep.id) err(E, 'missing id');
    if (ids.has(ep.id)) err(E, 'duplicate id');
    ids.add(ep.id);
    if (!AREAS.includes(ep.area)) err(E, `area must be one of ${AREAS.join(', ')}`);
    if (!METHODS.includes(ep.method)) err(E, `method must be one of ${METHODS.join(', ')}`);
    if (!ep.path?.startsWith('/')) err(E, 'path must start with /');
    if (!ep.summary) err(E, 'missing summary');
    if (!AUTHS.includes(ep.auth)) err(E, `auth must be one of ${AUTHS.join(', ')}`);
    const placeholders = [...(ep.path ?? '').matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
    const params = Object.keys(ep.params ?? {});
    if (placeholders.sort().join() !== params.sort().join()) err(E, `path placeholders {${placeholders}} must match params {${params}}`);
    if (ep.permission && !allPermissions.has(ep.permission)) soft(E, `permission "${ep.permission}" is not declared by any module`);
    // Every endpoint requires a token (auth design v3); which kinds fit which area:
    const AREA_AUTHS = { store: ['visitor', 'shopper', 'customer', 'account'], seller: ['seller'], admin: ['staff'], public: ['visitor', 'refresh', 'bootstrap'], webhooks: ['provider'] };
    if (AREA_AUTHS[ep.area] && !AREA_AUTHS[ep.area].includes(ep.auth)) err(E, `${ep.area}-area endpoints need auth ${AREA_AUTHS[ep.area].map((a) => `"${a}"`).join(' or ')}`);
    if (ep.auth === 'bootstrap' && !(m.name === 'identity' && ep.id === 'startAppSession')) err(E, 'only identity.startAppSession may use auth "bootstrap" (the one endpoint that issues the first token)');
    if (ep.stepUp !== undefined) {
      if (ep.stepUp?.kind !== 'reauth' || typeof ep.stepUp?.purpose !== 'string') err(E, 'stepUp must be { kind: "reauth", purpose: string }');
      // the body is inline or one of this module's types; either way it must declare the token field
      const bodyFields = typeof ep.body === 'string' ? m.types?.[ep.body] : ep.body;
      if (!(typeof bodyFields === 'object' && bodyFields && 'reauthToken' in bodyFields)) err(E, 'stepUp needs a reauthToken field in the body');
      if (reauthPurposes && !reauthPurposes.includes(ep.stepUp?.purpose)) err(E, `reauth purpose "${ep.stepUp?.purpose}" must be one of identity ReauthRequest.purpose (${reauthPurposes.join(', ')}): add it there`);
      if (!(ep.errors ?? []).includes('STEP_UP_REQUIRED')) err(E, 'endpoints with stepUp must list STEP_UP_REQUIRED in errors');
    }
    if (ep.sellerContext !== undefined && (ep.sellerContext !== 'optional' || ep.area !== 'seller')) err(E, 'sellerContext can only be "optional", on seller-area endpoints');
    if (ep.scope !== undefined && !['public', 'own-customer', 'own-seller', 'own-member', 'guest-order', 'staff'].includes(ep.scope)) err(E, 'scope must be public | own-customer | own-seller | own-member | guest-order | staff');
    if (ep.rateLimit !== undefined && typeof ep.rateLimit !== 'string') err(E, 'rateLimit must be a class name');
    for (const rule of ep.permissionWhen ?? []) {
      if (!rule?.if || typeof rule.if !== 'object' || !Object.keys(rule.if).every((k) => /^(params|query|body)\.\w+$/.test(k))) err(E, 'permissionWhen[].if keys must be params.<field>, query.<field> or body.<field>');
      if (!allPermissions.has(rule?.permission)) soft(E, `permissionWhen permission "${rule?.permission}" is not declared by any module`);
    }
    for (const code of ep.errors ?? []) if (!common.errors[code] && !m.errorCodes?.[code]) err(E, `error code "${code}" is not in common.json or this module's errorCodes`);
    for (const ev of ep.events ?? []) if (!published.has(ev)) err(E, `event "${ev}" is not in this module's events.publishes`);
    for (const s of ep.screens ?? []) if (SCREENS.size && !SCREENS.has(s)) err(E, `screen "${s}" is not a prototype screen id`);
    for (const k of ['params', 'query']) if (ep[k]) objectSchema(ep[k], m, `${E} ${k}`);
    if (ep.body === BINARY_BODY) {
      if (!['PUT', 'POST'].includes(ep.method)) err(E, 'a binary body needs PUT or POST');
      if (ep.idempotent) err(E, 'a binary body cannot be idempotent (the request hash covers JSON bodies)');
    } else if (ep.body !== undefined) typeToSchema(ep.body, m, `${E} body`);
    if (ep.response === EVENT_STREAM) {
      // a long-lived GET: nothing to page, replay or upload
      if (ep.method !== 'GET') err(E, 'an event-stream response needs GET');
      if (ep.paging) err(E, 'an event-stream response cannot be paged');
      if (ep.idempotent) err(E, 'an event-stream response cannot be idempotent');
      if (ep.body !== undefined) err(E, 'an event-stream endpoint takes no body');
      if (ep.status !== undefined && ep.status !== 200) err(E, 'an event-stream response answers 200');
    } else if (ep.response !== undefined && ep.response !== null) typeToSchema(ep.response, m, `${E} response`);
    const key = `${ep.method} ${fullPath(m, ep).replace(/\{\w+\}/g, '{}')}`;
    if (seenRoutes.has(key)) err(E, `route ${key} is also defined by ${seenRoutes.get(key)}`);
    seenRoutes.set(key, `${m.name}.${ep.id}`);
  }
}

if (warnings.length) console.log(`Warnings (${warnings.length}):\n${warnings.map((w) => `  - ${w}`).join('\n')}\n`);
if (errors.length) {
  console.error(`Errors (${errors.length}):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
const endpointCount = modules.reduce((n, m) => n + (m.endpoints?.length ?? 0), 0);
console.log(`Spec OK: ${modules.length} modules, ${endpointCount} endpoints.`);
if (CHECK) process.exit(0);

/* ------------------------------------------------------------------ OpenAPI */
/** One refresh cookie per app (backend kernel/auth/chain.ts: refreshCookieName, refreshCookieScheme, refreshCookieText) */
const COOKIE_APPS = ['store', 'seller', 'admin'];
const COOKIE_PATH = '/api/public/identity/sessions';
const cookieScheme = (a) => `refreshCookie${a[0].toUpperCase()}${a.slice(1)}`;
const cookieSchemes = Object.fromEntries(COOKIE_APPS.map((a) => [cookieScheme(a), {
  type: 'apiKey', in: 'cookie', name: `__Secure-mk_refresh_${a}`,
  description: `The ${a} website's refresh token (HttpOnly; Secure; SameSite=Strict; Path=${COOKIE_PATH}, sent only to refresh and sign-out, which name the app in the body's audience). Android sends refreshToken in the body instead.`,
}]));
const securityFor = (auth) => ({
  visitor: [{ bearer: [] }], shopper: [{ bearer: [] }], customer: [{ bearer: [] }], account: [{ bearer: [] }],
  seller: [{ bearer: [] }], staff: [{ bearer: [] }], refresh: [...COOKIE_APPS.map((a) => ({ [cookieScheme(a)]: [] })), {}], provider: [{ webhookSignature: [] }],
  bootstrap: [{ appProof: [] }],
}[auth] ?? []);
const BEARER = new Set(['visitor', 'shopper', 'customer', 'account', 'seller', 'staff']);
/** The errors every endpoint can return from the auth middleware (docs/03-auth-middleware.md §3) */
const authErrors = (ep) => [
  'UNAUTHORIZED',
  ...(BEARER.has(ep.auth) ? ['WRONG_AUDIENCE'] : []),
  ...(ep.permission || ep.permissionWhen?.length || ep.auth === 'seller' ? ['FORBIDDEN'] : []),
  ...(ep.stepUp ? ['STEP_UP_REQUIRED'] : []),
];

const schemas = {};
for (const [name, t] of Object.entries(common.types)) schemas[name] = objectSchema(t, null, `common.${name}`);
for (const m of modules) for (const [name, t] of Object.entries(m.types ?? {})) schemas[`${m.name}.${name}`] = objectSchema(t, m, `${m.name}.${name}`);

const paths = {};
const allErrorCodes = (m) => ({ ...common.errors, ...(m.errorCodes ?? {}) });
for (const m of modules) {
  for (const ep of m.endpoints) {
    const p = fullPath(m, ep);
    const parameters = [
      ...Object.entries(ep.params ?? {}).map(([name, t]) => ({ name, in: 'path', required: true, schema: typeToSchema(t, m, '').schema })),
      ...Object.entries(ep.query ?? {}).map(([name, t]) => { const r = typeToSchema(t, m, ''); return { name, in: 'query', required: !r.optional, schema: r.schema }; }),
      ...(ep.paging ? Object.entries(common.pagination.query).map(([name, t]) => ({ name, in: 'query', required: false, description: t.desc, schema: typeToSchema(t, null, '').schema })) : []),
      ...(ep.idempotent ? [{ name: 'Idempotency-Key', in: 'header', required: true, description: common.headers['Idempotency-Key'], schema: { type: 'string' } }] : []),
    ];
    const status = String(ep.status ?? (ep.response === null ? 204 : 200));
    const stream = ep.response === EVENT_STREAM;
    let respSchema = ep.response === null || ep.response === undefined || stream ? null : typeToSchema(ep.response, m, '').schema;
    if (respSchema && ep.paging) respSchema = pageSchema(respSchema);
    const responses = {
      [status]: stream
        ? { description: EVENT_STREAM_TEXT, content: { 'text/event-stream': { schema: { type: 'string' } } } }
        : respSchema
          ? { description: 'Success', content: { 'application/json': { schema: respSchema } } }
          : { description: 'Success, no content' },
    };
    const codes = new Set(['VALIDATION_FAILED', ...authErrors(ep), ...(ep.params ? ['NOT_FOUND'] : []), ...(ep.errors ?? [])]);
    for (const code of codes) {
      const def = allErrorCodes(m)[code];
      if (!def) continue;
      const s = String(def.status);
      responses[s] ??= { description: '', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
      responses[s].description = [responses[s].description, `${code}: ${def.meaning}`].filter(Boolean).join('\n');
    }
    paths[p] ??= {};
    paths[p][ep.method.toLowerCase()] = {
      operationId: `${m.name}.${ep.id}`,
      tags: [`${common.areas[ep.area].title} · ${m.title}`],
      summary: ep.summary,
      description: [ep.desc, ep.permission && `**Permission:** \`${ep.permission}\``, ep.permissionWhen?.length && `**Also needs:** ${ep.permissionWhen.map((r) => `\`${r.permission}\` when ${Object.entries(r.if).map(([k, v]) => `${k} ${String(v).startsWith('!') ? `is not the caller's own (${v.slice(1)})` : `= ${v}`}`).join(' and ')}`).join('; ')}`, ep.stepUp && `**Step-up:** single-use re-auth token in the body (purpose \`${ep.stepUp.purpose}\`)`, ep.sellerContext === 'optional' && '**Seller context:** optional (works before a seller is chosen).', ep.approval && `**Approval:** ${ep.approval}`, ep.idempotent && '**Idempotent:** send an Idempotency-Key.', ep.audited && '**Audited:** recorded in the action history.', ep.events?.length && `**Publishes:** ${ep.events.map((e) => `\`${e}\``).join(', ')}`, ep.screens?.length && `**Screens:** ${ep.screens.join(', ')}`, (ep.phase ?? m.phase) > 1 && `**Launch phase:** ${ep.phase ?? m.phase}`].filter(Boolean).join('\n\n') || undefined,
      security: securityFor(ep.auth),
      parameters: parameters.length ? parameters : undefined,
      requestBody: ep.body === BINARY_BODY
        ? { required: true, description: 'The raw bytes (any content type)', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }
        : ep.body !== undefined ? { required: true, content: { 'application/json': { schema: typeToSchema(ep.body, m, '').schema } } } : undefined,
      responses,
      'x-module': m.name, 'x-area': ep.area, 'x-auth': ep.auth, 'x-permission': ep.permission, 'x-screens': ep.screens, 'x-events': ep.events,
      'x-idempotent': ep.idempotent || undefined, 'x-audited': ep.audited || undefined, 'x-phase': ep.phase ?? m.phase,
      'x-step-up': ep.stepUp, 'x-permission-when': ep.permissionWhen, 'x-seller-context': ep.sellerContext, 'x-scope': ep.scope, 'x-rate-limit': ep.rateLimit,
    };
  }
}

const tagOrder = [];
for (const area of AREAS) for (const m of modules) if (m.endpoints.some((e) => e.area === area)) tagOrder.push({ name: `${common.areas[area].title} · ${m.title}`, description: m.summary });

const openapi = {
  openapi: '3.1.0',
  info: { ...common.info, description: `${common.info.description}\n\n${Object.values(common.areas).map((a) => `- **${a.title}** \`${a.prefix}\`: ${a.audience}. ${a.auth}`).join('\n')}` },
  servers: common.servers,
  tags: tagOrder,
  paths,
  components: {
    schemas,
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', description: common.headers.Authorization },
      ...cookieSchemes,
      appProof: { type: 'apiKey', in: 'header', name: 'X-App-Proof', description: common.headers['X-App-Proof'] },
      webhookSignature: { type: 'apiKey', in: 'header', name: 'X-Signature', description: 'Provider signature, verified per provider' },
    },
  },
};
const clean = (o) => JSON.parse(JSON.stringify(o));
writeFileSync(join(apiDir, 'openapi.json'), JSON.stringify(clean(openapi), null, 2));

/* ------------------------------------------------------------------ Markdown */
const fmtType = (t) => (typeof t === 'string' ? `\`${t}\`` : isDescriptor(t) ?`\`${t.type}\`${t.desc ? ` ${t.desc}` : ''}` : `\`${JSON.stringify(t)}\``);
const fmtShape = (t, status) => (t === undefined ? '' : t === null ? `${status ?? 204} No content` : t === BINARY_BODY ? 'raw bytes' : t === EVENT_STREAM ? 'Server-Sent Events' : typeof t === 'string' ? `\`${t}\`` : `\`{ ${Object.entries(t).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : v.type ?? 'object'}`).join(', ')} }\``);
mkdirSync(join(apiDir, 'modules'), { recursive: true });
const consumersOf = (event) => modules.filter((x) => x.events?.consumes?.some((c) => c.name === event)).map((x) => x.name);

for (const m of modules) {
  const lines = [];
  lines.push(`# ${m.title} (\`${m.name}\`)`, '', m.summary, '');
  lines.push(`- **Group:** ${m.group} · **Launch phase:** ${m.phase} · **Plan chapters:** ${(m.chapters ?? []).join(', ') || '-'}`);
  lines.push(`- **Depends on:** ${(m.dependsOn ?? []).map((d) => `[${d}](${d}.md)`).join(', ') || 'nothing'}${m.optionalDeps?.length ? ` · **Optional:** ${m.optionalDeps.map((d) => `[${d}](${d}.md)`).join(', ')}` : ''}`);
  const usedBy = modules.filter((x) => x.dependsOn?.includes(m.name)).map((x) => `[${x.name}](${x.name}.md)`);
  if (usedBy.length) lines.push(`- **Required by:** ${usedBy.join(', ')}`);
  lines.push('', '## Owns', ...m.owns.map((o) => `- ${o}`));
  if (m.notOwns?.length) lines.push('', '**Not here:**', ...m.notOwns.map((o) => `- ${o}`));
  for (const area of AREAS) {
    const eps = m.endpoints.filter((e) => e.area === area);
    if (!eps.length) continue;
    lines.push('', `## ${common.areas[area].title}`, '', '| Method | Path | Purpose | Auth | Body → Response |', '|---|---|---|---|---|');
    for (const e of eps) {
      const flags = [e.idempotent && 'idempotent', e.audited && 'audited', e.stepUp && `step-up: ${e.stepUp.kind}`, e.permissionWhen?.length && `also ${e.permissionWhen.map((r) => r.permission).join(', ')} when not own`, e.sellerContext === 'optional' && 'before seller is chosen', (e.phase ?? m.phase) > m.phase && `phase ${e.phase}`].filter(Boolean).join(', ');
      lines.push(`| ${e.method} | \`${fullPath(m, e)}\` | ${e.summary}${flags ? ` _(${flags})_` : ''} | ${e.auth}${e.permission ? `<br>\`${e.permission}\`` : ''} | ${[e.body !== undefined && fmtShape(e.body), (e.paging ? `Page<${typeof e.response === 'string' ? e.response : 'item'}>` : fmtShape(e.response, e.status))].filter(Boolean).join(' → ')} |`);
    }
  }
  if (Object.keys(m.types ?? {}).length) {
    lines.push('', '## Types');
    for (const [name, t] of Object.entries(m.types)) {
      lines.push('', `### ${name}`, '', '| Field | Type |', '|---|---|', ...Object.entries(t).map(([k, v]) => `| ${k} | ${fmtType(v)} |`));
    }
  }
  if (m.stateMachines?.length) {
    lines.push('', '## Status flows');
    for (const sm of m.stateMachines) {
      lines.push('', `### ${sm.name} (\`${sm.field}\`)`, '', '```mermaid', 'stateDiagram-v2', `  [*] --> ${sm.initial}`, ...sm.transitions.map(([a, ev, b]) => `  ${a} --> ${b}: ${ev}`), '```');
      if (sm.notes) lines.push('', sm.notes);
    }
  }
  if (m.tables?.length) {
    lines.push('', `## Data (schema \`${m.name.replace(/-/g, '_')}\`)`);
    for (const t of m.tables) {
      lines.push('', `**${t.name}**${t.desc ? `: ${t.desc}` : ''}`, '', '| Column | Type |', '|---|---|', ...Object.entries(t.columns).map(([k, v]) => `| ${k} | ${v} |`));
      if (t.indexes?.length) lines.push('', `Indexes: ${t.indexes.map((i) => `\`${i}\``).join(', ')}`);
    }
  }
  if (m.events?.publishes?.length || m.events?.consumes?.length) {
    lines.push('', '## Events');
    if (m.events.publishes?.length) lines.push('', '| Publishes | When | Payload | Consumed by |', '|---|---|---|---|', ...m.events.publishes.map((e) => `| \`${e.name}\` | ${e.when} | ${fmtShape(e.payload)} | ${consumersOf(e.name).join(', ') || '-'} |`));
    if (m.events.consumes?.length) lines.push('', '| Consumes | From | Does |', '|---|---|---|', ...m.events.consumes.map((e) => `| \`${e.name}\` | ${allPublished.get(e.name) ?? '?'} | ${e.does} |`));
  }
  if (m.publicApi?.length) lines.push('', '## In-process API (for other modules)', '', '| Function | Signature | Used by |', '|---|---|---|', ...m.publicApi.map((f) => `| ${f.name} | \`${f.signature}\`<br>${f.desc ?? ''} | ${(f.usedBy ?? []).join(', ')} |`));
  if (m.permissions?.length) lines.push('', '## Permissions', '', '| Key | Who | Allows |', '|---|---|---|', ...m.permissions.map((p) => `| \`${p.key}\` | ${p.audience} | ${p.desc} |`));
  if (m.approvalActions?.length) lines.push('', '## Approval actions', '', 'Checked through the access module (limits per role, second reviewer).', '', '| Action | Limit | Second reviewer | Approvers | Meaning |', '|---|---|---|---|---|', ...m.approvalActions.map((a) => `| \`${a.key}\` | ${a.limit} | ${a.secondReviewer} | ${a.approvers ?? ''} | ${a.desc} |`));
  if (m.errorCodes && Object.keys(m.errorCodes).length) lines.push('', '## Error codes', '', '| Code | Status | Meaning |', '|---|---|---|', ...Object.entries(m.errorCodes).map(([c, d]) => `| \`${c}\` | ${d.status} | ${d.meaning} |`));
  if (m.jobs?.length) lines.push('', '## Background jobs', '', '| Job | Schedule | Does |', '|---|---|---|', ...m.jobs.map((j) => `| \`${j.name}\` | ${j.schedule} | ${j.does} |`));
  const settingRules = (s) => [
    s.type && `${s.type}${s.type === 'enum' ? ` (${s.choices.join(' \\| ')})` : ''}`,
    s.unit,
    (s.min !== undefined || s.max !== undefined) && `${s.min ?? '…'}–${s.max ?? '…'}`,
    s.approval && s.approval !== 'none' && `approval: ${s.approval.replace('_', ' ')}`,
    s.sellerVisible && 'seller-visible',
    s.minLeadDays && `${s.minLeadDays} d notice`,
    s.editable === false && 'read-only',
  ].filter(Boolean).join(', ');
  if (m.settings?.length) lines.push('', '## Settings', '', '| Key | Default | Rules | Meaning |', '|---|---|---|---|', ...m.settings.map((s) => `| ${s.key} | \`${JSON.stringify(s.default)}\` | ${settingRules(s)} | ${s.desc} |`));
  if (m.integrations?.length) lines.push('', '## Integrations', ...m.integrations.map((i) => `- **${i.name}**: ${i.purpose}`));
  if (m.notes?.length) lines.push('', '## Notes', ...m.notes.map((n) => `- ${n}`));
  const gqlFile = join(apiDir, 'graphql', 'modules', `${m.name}.graphql`);
  if (existsSync(gqlFile)) lines.push('', '## GraphQL (read layer)', '', `This module's fragment of the GraphQL schemas (see [../graphql/README.md](../graphql/README.md)). Writes stay on the REST endpoints above.`, '', '```graphql', readFileSync(gqlFile, 'utf8').trimEnd(), '```');
  writeFileSync(join(apiDir, 'modules', `${m.name}.md`), `${lines.join('\n')}\n`);
}

/* Index */
const idx = [];
idx.push('# Marketly API design', '', `Generated from \`docs/api/spec/\` by \`node docs/api/tools/build.mjs\`. ${modules.length} modules, ${endpointCount.toLocaleString('en-US')} endpoints.`, '');
idx.push('- **GraphQL read layer:** [graphql/README.md](graphql/README.md), composed schemas `graphql/schema.{store,seller,admin}.graphql`, screen queries in `graphql/operations/`', '- **OpenAPI 3.1:** [openapi.json](openapi.json) (open in Swagger UI, Redoc or Postman)', '- **Architecture:** [../02-backend-architecture.md](../02-backend-architecture.md)', '- **Spec format:** [spec/FORMAT.md](spec/FORMAT.md)', '');
const allEndpoints = modules.flatMap((m) => m.endpoints);
const countWhere = (f) => allEndpoints.filter(f).length;
idx.push('## API areas', '', '| Area | Prefix | Who | Auth | Endpoints |', '|---|---|---|---|---|', ...Object.entries(common.areas).map(([k, a]) => `| ${a.title} | \`${a.prefix}\` | ${a.audience} | ${a.auth} | ${countWhere((e) => e.area === k)} |`));
idx.push('', '### Endpoints by auth kind', '', 'Every endpoint needs a token ([../03-auth-middleware.md](../03-auth-middleware.md) §0). The `account` endpoints live under `/api/store/identity` but take a signed-in token of any app, and every app\'s origin may call them.', '', '| Area | Auth kind | Who | Endpoints |', '|---|---|---|---|');
for (const area of AREAS) for (const auth of AUTHS) {
  const n = countWhere((e) => e.area === area && e.auth === auth);
  if (n) idx.push(`| ${common.areas[area].title} | \`${auth}\` | ${common.auth[auth]} | ${n} |`);
}
for (const g of GROUPS) {
  const ms = modules.filter((m) => m.group === g);
  if (!ms.length) continue;
  idx.push('', `## ${g}`, '', '| Module | Phase | Owns | Depends on | Endpoints |', '|---|---|---|---|---|', ...ms.map((m) => `| [${m.name}](modules/${m.name}.md) | ${m.phase} | ${m.summary} | ${(m.dependsOn ?? []).join(', ') || '-'} | ${m.endpoints.length} |`));
}
const level = {};
const lv = (n) => (level[n] ??= 1 + Math.max(-1, ...(byName.get(n)?.dependsOn ?? []).filter((d) => byName.has(d)).map(lv)));
modules.forEach((m) => lv(m.name));
const layers = [];
for (const m of modules) (layers[level[m.name]] ??= []).push(m.name);
idx.push('', '## Dependency layers', '', 'Each module needs only modules in earlier layers (required dependencies; optional ones are listed on each module page).', '', '| Layer | Modules |', '|---|---|', ...layers.map((ms, i) => `| ${i} | ${ms.sort().map((n) => `[${n}](modules/${n}.md)`).join(', ')} |`));
idx.push('', '## Errors', '', 'Every REST error is `{ "error": { "code", "message", "details"? } }` with the status below. Module codes are listed on each module page.', '', '| Code | Status | Meaning |', '|---|---|---|', ...Object.entries(common.errors).map(([c, d]) => `| \`${c}\` | ${d.status} | ${d.meaning} |`));
const identityCodes = byName.get('identity')?.errorCodes ?? {};
const SESSION_CODES = ['APP_PROOF_INVALID', 'REFRESH_TOKEN_INVALID', 'ACCOUNT_LOCKED', 'ACCOUNT_DISABLED'].filter((c) => identityCodes[c]);
if (SESSION_CODES.length) idx.push('', 'Sign-in and session codes from [identity](modules/identity.md) that every app meets:', '', '| Code | Status | Meaning |', '|---|---|---|', ...SESSION_CODES.map((c) => `| \`${c}\` | ${identityCodes[c].status} | ${identityCodes[c].meaning} |`));
idx.push(
  '',
  'Requests the server can\'t read keep their HTTP status with code `VALIDATION_FAILED` and no `details`: 400 (unreadable JSON), 413 (a JSON body over 2 MB) and 415 (an unsupported content type).',
  '',
  'GraphQL answers `{ data, errors }` with `errors[].extensions.code` instead of the `{ error }` envelope, and has four codes of its own: `QUERY_TOO_COMPLEX`, `QUERY_TIMEOUT`, `PERSISTED_QUERY_NOT_FOUND` and `PERSISTED_QUERY_NOT_SUPPORTED`. See [graphql/README.md](graphql/README.md#errors).',
  '',
  '### Refusal details',
  '',
  '| Code | `details` |',
  '|---|---|',
  '| `VALIDATION_FAILED` | `issues: [{ path, message }]`, the path naming the part and field (`body.email`, `querystring.limit`) |',
  '| `UNAUTHORIZED` | `reason`: `token_missing`, `token_expired`, `token_revoked`, `token_malformed`, `token_bad_signature`, `token_unknown_key`, `token_wrong_type`, `token_wrong_issuer`, `token_not_yet_valid`, `token_invalid` (refresh token); `sign_in_required`, `seller_context_required`, `session_idle`; `signature_invalid`, `signature_expired` (webhooks); `link_missing`, `link_invalid` (file links) |',
  '| `FORBIDDEN` | `permission` for a missing permission; otherwise `reason`: `origin_not_allowed`, `x_requested_with_required` (cookie refresh and sign-out), `link_expired` (file links) |',
  '| `WRONG_AUDIENCE` | `tokenAudience`, `area` |',
  '| `STEP_UP_REQUIRED` | `kind` (`reauth`), `purpose` |',
  '| `ILLEGAL_TRANSITION` | `machine`, `from`, `event`, `allowed` |',
  '| `APPROVAL_REQUIRED` | `approvalRequestId` |',
  '| `RATE_LIMITED` | `retryAfterSeconds` (also the `Retry-After` header) |',
  '| `UPGRADE_REQUIRED` | `minVersionCode`, `updateUrl` |',
  '| `NOT_IMPLEMENTED` | `operation`, `reason` (`not_built`, `later_phase`), `phase` |',
  '| `SERVICE_UNAVAILABLE` | `reason`: `sessions_unavailable`, `revocations_stale`, `revocations_unavailable` (admin requests); none when an app proof can\'t be checked |',
  '| `ACCOUNT_LOCKED` | `lockedUntil` (null = until staff unlock), `cause` |',
);
idx.push('', '## Headers', '', '| Header | Use |', '|---|---|', ...Object.entries(common.headers).map(([h, d]) => `| \`${h}\` | ${d} |`));
idx.push('', 'Response headers: `X-Request-Id` (always), `Retry-After` (429), `Idempotent-Replayed: true` (a replayed idempotent request), `WWW-Authenticate` (401 `UNAUTHORIZED`: `Bearer error="invalid_token"` for a bad token, plain `Bearer` otherwise). Browsers can read all four across origins.');
const refreshGrace = byName.get('identity')?.settings?.find((s) => s.key === 'refreshReuseGraceSeconds')?.default;
const pageLimit = common.pagination.query.limit.desc.replace(/^Items per batch, /, '');
idx.push(
  '',
  '## Client rules',
  '',
  'The full design is [../03-auth-middleware.md](../03-auth-middleware.md); these are the rules an app needs.',
  '',
  '### Responses and URLs',
  '',
  '- Success uses the status the endpoint declares (200, 201, 202). An endpoint without a response body answers 204, or 202 where it says so, with an empty body.',
  '- Trailing slashes are ignored: `/api/store/cart/` is `/api/store/cart`.',
  '- `Accept-Language` is ignored; texts are en-US.',
  '- Every `/api`, `/graphql` and `/webhooks` response is `Cache-Control: private, no-store`.',
  '',
  '### Paging',
  '',
  `List endpoints take \`cursor\` (the Android app's infinite scroll) or \`page\` (the website's numbered pages), never both, and \`limit\` (${pageLimit}). The answer is \`{ items, nextCursor, page?, totalPages?, total? }\`; \`nextCursor\` is null at the end. Both \`cursor\` and \`page\`, a \`limit\` out of range, or a cursor the server can't read → 400 \`VALIDATION_FAILED\`. (GraphQL clamps the limit instead.)`,
  '',
  '### Idempotency',
  '',
  'Endpoints marked idempotent need `Idempotency-Key` (1–255 characters; missing → 400 `VALIDATION_FAILED`). Keys are kept 24 hours per operation and caller. The same key with the same request (path parameters, query and body) answers the first response again, same status and body, with `Idempotent-Replayed: true`; with a different request → 422 `IDEMPOTENCY_KEY_REUSED`; while the first request still runs → 409 `CONFLICT`. When the handler fails, the key is freed and a retry runs again. A refused step-up proof frees the key too, so the retry with a fresh proof reuses it. Use one key per user action and reuse it on retries.',
  '',
  '### Step-up',
  '',
  'Endpoints with a step-up need a fresh proof: `reauthToken` in the body, from identity\'s re-auth endpoint of the app (the password; members may use a 2-step code instead). Staff confirm with their password (`POST /api/admin/identity/reauth`); they have no 2-step. A missing or refused proof → 403 `STEP_UP_REQUIRED` with `details.kind` and `details.purpose`, never 400. A re-auth token works once: it is claimed before the request runs and given back if the request fails, so the person can retry without confirming again. A replayed idempotent request does not spend it.',
  '',
  '### Sessions',
  '',
  '- **Start:** `POST /api/public/identity/app-sessions` with `X-App-Proof` returns a visitor access token (15 minutes) and a refresh token. Signing in claims the visitor session.',
  '- **Where the refresh token lives:** the website gets it in its own app\'s cookie, `__Secure-mk_refresh_store`, `__Secure-mk_refresh_seller` or `__Secure-mk_refresh_admin` (HttpOnly; Secure; SameSite=Strict; Path=/api/public/identity/sessions), and `refreshToken` is `""` in the body; Android gets it in the body. With one cookie per app, signing into Seller Center or Admin Center doesn\'t end the store session in the same browser.',
  `- **Refresh** \`POST /api/public/identity/sessions/refresh\`, **sign out** \`POST /api/public/identity/sessions/sign-out\` (204). The website names its app in the body, \`{ "audience": "store" }\` (or \`seller\`, \`admin\`); the server reads that app's cookie first, then \`refreshToken\` in the body. Without \`audience\` no cookie is read (401 \`token_missing\`). Sign-out clears only that app's cookie. With the cookie, the request needs an allowed \`Origin\` and \`X-Requested-With\`, else 403. At most 30 refreshes an hour per session. Each refresh returns a new pair; the previous token sent again within ${refreshGrace ?? 20} s returns the same new pair (two tabs refreshing at once), and later it ends the session.`,
  '- **Refused:** no refresh token → 401 `token_missing`; an unknown, expired, revoked or reused one → 401 `token_invalid` (sign-out with such a token too), as is an app\'s cookie holding another app\'s session. Refresh can also answer `REFRESH_TOKEN_INVALID`, `ACCOUNT_DISABLED` or `ACCOUNT_LOCKED`. In every case, sign in again.',
  '- **When to refresh:** only on 401 `UNAUTHORIZED` whose `details.reason` starts with `token_`. Never on `session_idle` (sign in again), other 401 reasons, `FORBIDDEN`, `WRONG_AUDIENCE` or a GraphQL field refusal.',
  '',
  '### Browsers (CORS)',
  '',
  'Each area allows its own app\'s origins (`CORS_STORE_ORIGINS`, `CORS_SELLER_ORIGINS`, `CORS_ADMIN_ORIGINS`); public endpoints, file links and the `account` endpoints allow every app\'s. Credentials (`Access-Control-Allow-Credentials: true`) are allowed only on the routes that set, clear or read the refresh cookie: refresh and sign-out, `POST /api/public/identity/app-sessions`, `/sessions`, `/sign-in-challenges/{id}/verify`, `/external-sign-ins`, `/verifications/{id}/confirm`, `/invitations/accept`, and `POST /api/seller/identity/session/seller-context`.',
  '',
  '### For frontend developers',
  '',
  '1. Start an app session once, keep the access token in memory, and send `Authorization: Bearer` on every request, GraphQL included. Send `X-Client` (`web`, or `android/<versionName>+<versionCode>`).',
  '2. Website: call the cookie routes above with `credentials: \'include\'`, and on refresh and sign-out add `X-Requested-With` (any value) and a JSON body naming the app, `{ "audience": "store" }` (`seller`, `admin`).',
  '3. Refresh one request at a time, only on 401 with `details.reason` `token_*`, then retry the request once. If the refresh itself is refused, sign in again (visitors: start a new app session).',
  '4. 426 `UPGRADE_REQUIRED`: show the update screen (`details.updateUrl`). 429: wait `Retry-After` seconds. 503: retry with backoff.',
  '5. Send one `Idempotency-Key` per user action on idempotent endpoints, the same on every retry.',
  '6. Show or log the `X-Request-Id` of a failed response when reporting a problem.',
);
if (Object.keys(common.constants ?? {}).length) idx.push('', '## Constants', '', 'Reserved values every module may use (exported from `backend/src/spec/common.ts`).', '', '| Name | Value | Meaning |', '|---|---|---|', ...Object.entries(common.constants).map(([n, c]) => `| \`${n}\` | \`${JSON.stringify(c.value)}\` | ${c.desc} |`));
writeFileSync(join(apiDir, 'README.md'), `${idx.join('\n')}\n`);

/* ------------------------------------------------------------------ Viewer data */
mkdirSync(join(apiDir, 'viewer'), { recursive: true });
const viewerData = {
  common,
  screens: Object.fromEntries([...SCREENS.values()].map((s) => [s.id, s])),
  modules: modules.map(({ file, ...m }) => ({
    ...m,
    requiredBy: modules.filter((x) => x.dependsOn?.includes(m.name)).map((x) => x.name),
    endpoints: m.endpoints.map((e) => ({ ...e, fullPath: fullPath(m, e) })),
    events: {
      publishes: (m.events?.publishes ?? []).map((e) => ({ ...e, consumedBy: consumersOf(e.name) })),
      consumes: (m.events?.consumes ?? []).map((e) => ({ ...e, from: allPublished.get(e.name) ?? null })),
    },
  })),
  stats: { modules: modules.length, endpoints: endpointCount, generatedAt: new Date().toISOString().slice(0, 10) },
};
writeFileSync(join(apiDir, 'viewer', 'data.js'), `/* Generated by docs/api/tools/build.mjs. Do not edit. */\nwindow.API_DATA = ${JSON.stringify(viewerData)};\n`);
// The viewer uses the Marketly design tokens from Phase 1.
const tokens = join(repoRoot, 'design', 'prototype', 'tokens.css');
if (existsSync(tokens)) writeFileSync(join(apiDir, 'viewer', 'tokens.css'), readFileSync(tokens));
console.log(`Wrote openapi.json, README.md, modules/*.md (${modules.length}), viewer/data.js`);
