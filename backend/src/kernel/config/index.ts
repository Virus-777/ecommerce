/**
 * Runtime configuration from environment variables (see .env.example). Validated at startup.
 */
import type { Jwk } from '../auth/tokens.js';
import { z } from 'zod';

/** true/false, 1/0, yes/no, on/off */
const flag = z.stringbool().optional();
const list = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4000),
  /** Internal port for /health (load balancer); not the public listener */
  HEALTH_PORT: z.coerce.number().int().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** postgres://… ; empty = in-process PGlite (in memory, or in PGLITE_DIR) */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(),
  /** Run pending migrations when the server starts (production runs `npm run migrate` instead) */
  MIGRATE_ON_START: flag,
  /** Plan ch. 20: endpoints of a later phase answer NOT_IMPLEMENTED. Phases 1–2 are designed for launch. */
  LAUNCH_PHASE: z.coerce.number().int().min(1).max(4).default(2),
  MARKET_TIME_ZONE: z.string().default('America/Los_Angeles'),
  MARKET_CURRENCY: z.string().default('USD'),
  /** Validate every response against its spec schema (on by default outside production) */
  RESPONSE_VALIDATION: flag,
  /** Run scheduled jobs in this process */
  JOBS_ENABLED: flag,
  /** Store and seller GraphQL accept persisted query ids only (on in production) */
  GRAPHQL_PERSISTED_ONLY: flag,
  /** Public keys that verify access and visitor tokens: {"keys":[{kty:"OKP",crv:"Ed25519",x,kid}]} */
  AUTH_JWKS: z.string().optional(),
  AUTH_ISSUER: z.string().default('marketly-identity'),
  /** Identity's private signing key (Ed25519 JWK with kid); its public part is trusted automatically. Development uses the dev key. */
  AUTH_SIGNING_JWK: z.string().optional(),
  /** Root secret for links and tokens modules sign themselves (unsubscribe, reply-to, storage URLs, checkpoints); see kernel/lib/secrets.ts */
  APP_SECRET: z.string().min(32).optional(),
  /** Public addresses of the apps, for links in emails and documents */
  STORE_URL: z.url().optional(),
  SELLER_URL: z.url().optional(),
  ADMIN_URL: z.url().optional(),
  /** Webhook signing secrets per provider: {"stripe":"…","carrier":"…"} (development and tests default to "dev-webhook-secret") */
  WEBHOOK_SECRETS: z.string().optional(),
  /** How often each server pulls session revocations from identity */
  REVOCATION_POLL_MS: z.coerce.number().int().min(500).default(3000),
  /** Development and tests only: sign and accept tokens with a per-machine dev key */
  DEV_TOKENS: flag,
  DEV_SIGNING_KEY_FILE: z.string().default('.data/dev-signing-key.json'),
  /** Rate limits by IP, caller and sign-in style classes (off only for contract tests and load tests) */
  RATE_LIMITS: flag,
  /** Proxies in front of the server: a hop count, "true", or comma-separated addresses/CIDRs */
  TRUST_PROXY: z.string().optional(),
  /** Allowed browser origins per app (comma-separated) */
  CORS_STORE_ORIGINS: list,
  CORS_SELLER_ORIGINS: list,
  CORS_ADMIN_ORIGINS: list,
  /** Swagger UI at /docs (development only by default) */
  DOCS_ENABLED: flag,
  /** Cloudflare Turnstile secret for the website's app proof */
  TURNSTILE_SECRET: z.string().optional(),
  /** Comma-separated module list overriding src/modules.config.ts (tests, partial deployments) */
  MODULES: z.string().optional(),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  healthPort: number;
  logLevel: string;
  databaseUrl: string | undefined;
  pgliteDir: string | undefined;
  migrateOnStart: boolean;
  launchPhase: number;
  market: { timeZone: string; currency: string };
  responseValidation: boolean;
  jobsEnabled: boolean;
  graphqlPersistedOnly: boolean;
  auth: { jwks: string | undefined; issuer: string; revocationPollMs: number; signingJwk?: Jwk & { kid?: string } };
  /** Root secret for module-signed links and tokens (derive per purpose with secretFor) */
  appSecret: string;
  publicUrls: { store: string; seller: string; admin: string };
  /** Webhook HMAC secrets per provider; `*` applies to any provider (development and tests only) */
  webhookSecrets: Record<string, string>;
  /** Development and tests: sign and accept dev-key tokens */
  devTokens: boolean;
  devSigning: { file: string; jwk?: Jwk };
  rateLimits: boolean;
  trustProxy: boolean | number | string[];
  cors: { store: string[]; seller: string[]; admin: string[] };
  docsEnabled: boolean;
  appProof: { allowDev: boolean; turnstileSecret: string | undefined };
  modules: string[] | undefined;
}

const parseTrustProxy = (v: string | undefined): Config['trustProxy'] => {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim());
};

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<Config> = {}): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  const prod = e.NODE_ENV === 'production';
  const devTokens = !prod && (e.DEV_TOKENS ?? true);
  const config: Config = {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    healthPort: e.HEALTH_PORT ?? e.PORT + 1,
    logLevel: e.NODE_ENV === 'test' ? 'silent' : e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL || undefined,
    pgliteDir: e.PGLITE_DIR || undefined,
    migrateOnStart: e.MIGRATE_ON_START ?? !prod,
    launchPhase: e.LAUNCH_PHASE,
    market: { timeZone: e.MARKET_TIME_ZONE, currency: e.MARKET_CURRENCY },
    responseValidation: e.RESPONSE_VALIDATION ?? !prod,
    jobsEnabled: e.JOBS_ENABLED ?? false,
    graphqlPersistedOnly: e.GRAPHQL_PERSISTED_ONLY ?? prod,
    auth: { jwks: e.AUTH_JWKS || undefined, issuer: e.AUTH_ISSUER, revocationPollMs: e.REVOCATION_POLL_MS, signingJwk: e.AUTH_SIGNING_JWK ? JSON.parse(e.AUTH_SIGNING_JWK) : undefined },
    appSecret: e.APP_SECRET ?? (devTokens ? 'dev-app-secret-not-for-production-use-0000' : ''),
    publicUrls: {
      store: (e.STORE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
      seller: (e.SELLER_URL ?? 'http://localhost:3001').replace(/\/$/, ''),
      admin: (e.ADMIN_URL ?? 'http://localhost:3002').replace(/\/$/, ''),
    },
    webhookSecrets: { ...(devTokens ? { '*': 'dev-webhook-secret' } : {}), ...(e.WEBHOOK_SECRETS ? JSON.parse(e.WEBHOOK_SECRETS) : {}) },
    devTokens,
    devSigning: { file: e.DEV_SIGNING_KEY_FILE },
    rateLimits: e.RATE_LIMITS ?? true,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    cors: { store: e.CORS_STORE_ORIGINS, seller: e.CORS_SELLER_ORIGINS, admin: e.CORS_ADMIN_ORIGINS },
    docsEnabled: e.DOCS_ENABLED ?? e.NODE_ENV === 'development',
    appProof: { allowDev: devTokens, turnstileSecret: e.TURNSTILE_SECRET || undefined },
    modules: e.MODULES ? e.MODULES.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    ...overrides,
  };
  if (prod && config.devTokens) throw new Error('DEV_TOKENS cannot be enabled in production');
  if (prod && config.appProof.allowDev) throw new Error('The "dev" app proof cannot be accepted in production');
  if (prod && !config.appSecret) throw new Error('APP_SECRET is required in production (signs unsubscribe, reply and download links)');
  if (prod && !(e.STORE_URL && e.SELLER_URL && e.ADMIN_URL)) throw new Error('STORE_URL, SELLER_URL and ADMIN_URL are required in production (links in emails)');
  if (prod && !config.rateLimits) throw new Error('RATE_LIMITS cannot be turned off in production');
  if (prod && !config.auth.jwks) throw new Error('AUTH_JWKS is required in production (the public keys that verify tokens)');
  return config;
}
