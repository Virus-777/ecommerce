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
  /** Address to listen on; default 0.0.0.0 in production, 127.0.0.1 elsewhere (development tokens are only served on loopback) */
  HOST: z.string().optional(),
  PORT: z.coerce.number().int().default(4000),
  /** Internal port for /health (check script, monitoring); plain HTTP, not the public listener */
  HEALTH_PORT: z.coerce.number().int().optional(),
  /** Address of the health listener: default 127.0.0.1 (this machine only) */
  HEALTH_HOST: z.string().optional(),
  /** HTTPS: the certificate (PEM, with any intermediate after it) and its private key (PEM). Both or neither. */
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  /** With HTTPS: a plain-HTTP port (e.g. 80) that only answers 301 to the https address */
  HTTP_REDIRECT_PORT: z.coerce.number().int().optional(),
  /** Folder with the built Admin Center (index.html, assets/); served on this address outside /api, /graphql, /files … */
  ADMIN_APP_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** mongodb://…/marketly?replicaSet=rs0 (a replica set: transactions need one); empty = an embedded replica set (development, tests) */
  MONGODB_URI: z.string().optional(),
  /** Embedded MongoDB only: keep its data in this folder between restarts */
  MONGO_DATA_DIR: z.string().optional(),
  /** Embedded MongoDB with MONGO_DATA_DIR: its fixed port (the replica set stored in the folder names it) */
  MONGO_PORT: z.coerce.number().int().min(1).max(65535).default(27018),
  /** A transaction slower than this (ms), or run more than once, logs a warning with its module, duration and attempts */
  TX_SLOW_MS: z.coerce.number().int().min(1).default(200),
  /** Apply the MongoDB schema and pending data migrations when the server starts (production runs `npm run migrate` instead) */
  MIGRATE_ON_START: flag,
  /** Plan ch. 20: endpoints of a later phase answer NOT_IMPLEMENTED. Phases 1–2 are designed for launch. */
  LAUNCH_PHASE: z.coerce.number().int().min(1).max(4).default(2),
  MARKET_TIME_ZONE: z.string().default('America/Los_Angeles'),
  MARKET_CURRENCY: z.string().default('USD'),
  /** Delivery location used before the shopper gives one (prices with shipping, delivery estimates) */
  MARKET_DEFAULT_POSTAL_CODE: z.string().default('97205'),
  MARKET_DEFAULT_LOCATION_LABEL: z.string().default('Portland'),
  /** Validate every response against its spec schema (on by default outside production) */
  RESPONSE_VALIDATION: flag,
  /** Work jobs and keep their schedules in this process */
  JOBS_ENABLED: flag,
  /** mongo: queue in MongoDB, each run once across instances; inprocess: timers in each process. Default mongo with MONGODB_URI */
  JOBS_BACKEND: z.enum(['inprocess', 'mongo']).optional(),
  /** Identifies a deployment (image tag, commit): "on boot" jobs run once per deploy and module set */
  DEPLOY_ID: z.string().optional(),
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
  /** Public address of this API, for links to files it serves (GET /files/…); default http://localhost:PORT */
  API_URL: z.url().optional(),
  /** Where media keeps files: local (the server's disk, MEDIA_STORAGE_DIR) or memory (lost on restart); default local, memory in tests */
  MEDIA_STORAGE: z.enum(['local', 'memory']).optional(),
  MEDIA_STORAGE_DIR: z.string().default('.data/media'),
  /**
   * Backups (deploy/linux): the backup folder (read), the backup service's request and status folder, and where
   * uploaded backups go. Without BACKUP_OPS_DIR (development machines) backups are unavailable in the Admin Center.
   */
  BACKUP_DIR: z.string().default('/var/backups/marketly'),
  BACKUP_OPS_DIR: z.string().optional(),
  BACKUP_UPLOAD_DIR: z.string().optional(),
  /**
   * How media decodes and resizes images: sharp (real decoding, resizing and encoding; default) or dev (reads file
   * headers only and copies bytes: the default in tests, whose fixtures are header-only images)
   */
  MEDIA_IMAGE_PROCESSOR: z.enum(['sharp', 'dev']).optional(),
  /** Webhook signing secrets per provider: {"stripe":"…","carrier":"…"} (development and tests default to "dev-webhook-secret") */
  WEBHOOK_SECRETS: z.string().optional(),
  /** How often each server pulls session revocations from identity */
  REVOCATION_POLL_MS: z.coerce.number().int().min(500).default(3000),
  /** Development and tests only: sign and accept tokens with a per-machine dev key */
  DEV_TOKENS: flag,
  DEV_SIGNING_KEY_FILE: z.string().default('.data/dev-signing-key.json'),
  /** Rate limits by IP, caller and sign-in style classes (off only for contract tests and load tests) */
  RATE_LIMITS: flag,
  /** Where rate-limit windows are counted: mongo (shared by every instance) or memory (per process). Default mongo with MONGODB_URI */
  RATE_LIMIT_STORE: z.enum(['memory', 'mongo']).optional(),
  /** gzip or brotli for the text and JSON answers over COMPRESSION_THRESHOLD bytes; off where a proxy in front already compresses */
  COMPRESSION: flag,
  /** Answers below this many bytes go out as they are: the encoding costs more than the few bytes it would save */
  COMPRESSION_THRESHOLD: z.coerce.number().int().min(0).default(1024),
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
  /** Offline servers: an app started from a private network address needs no app proof (kernel/auth/app-proof.ts) */
  APP_PROOF_LOCAL_NETWORK: flag,
  /** Comma-separated module list overriding src/modules.config.ts (tests, partial deployments) */
  MODULES: z.string().optional(),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  healthPort: number;
  healthHost: string;
  /** HTTPS certificate and key files (PEM); undefined = plain HTTP (development, or a proxy terminates TLS) */
  tls: { certFile: string; keyFile: string } | undefined;
  /** Plain-HTTP port answering 301 to the https address (HTTPS only) */
  httpRedirectPort: number | undefined;
  /** Folder of the built Admin Center served by this server (undefined = not served) */
  adminAppDir: string | undefined;
  logLevel: string;
  /** MongoDB: the server (undefined = embedded replica set) and, for the embedded one, its data folder; slowTransactionMs: see TX_SLOW_MS */
  mongo: { uri: string | undefined; dataDir: string | undefined; port: number; slowTransactionMs: number };
  migrateOnStart: boolean;
  launchPhase: number;
  market: { timeZone: string; currency: string; defaultLocation: { postalCode: string; label: string } };
  responseValidation: boolean;
  jobsEnabled: boolean;
  jobsBackend: 'inprocess' | 'mongo';
  deployId: string | undefined;
  graphqlPersistedOnly: boolean;
  /** Event streams (kernel/http/event-stream.ts): a `: ping` and a sign-in check this often. Not an env setting; tests make it short */
  eventStreamHeartbeatMs: number;
  auth: { jwks: string | undefined; issuer: string; revocationPollMs: number; signingJwk?: Jwk & { kid?: string } };
  /** Root secret for module-signed links and tokens (derive per purpose with secretFor) */
  appSecret: string;
  publicUrls: { store: string; seller: string; admin: string };
  /** Public address of this API (no trailing slash): signed file links point here */
  apiUrl: string;
  /** File storage for media: the server's disk (local, under dir) or memory (tests); image processing: sharp or dev (tests) */
  media: { storage: 'local' | 'memory'; dir: string; imageProcessor: 'sharp' | 'dev' };
  /** Backups: null where the server has no backup service (BACKUP_OPS_DIR unset) */
  backups: { dir: string; opsDir: string; uploadDir: string } | null;
  /** Webhook HMAC secrets per provider; `*` applies to any provider (development and tests only) */
  webhookSecrets: Record<string, string>;
  /** Development and tests: sign and accept dev-key tokens */
  devTokens: boolean;
  devSigning: { file: string; jwk?: Jwk };
  rateLimits: boolean;
  rateLimitStore: 'memory' | 'mongo';
  /** gzip/brotli on the way out, with the smallest answer worth encoding (COMPRESSION_THRESHOLD); null = every answer goes out as it is */
  compression: { threshold: number } | null;
  trustProxy: boolean | number | string[];
  cors: { store: string[]; seller: string[]; admin: string[] };
  docsEnabled: boolean;
  appProof: { allowDev: boolean; turnstileSecret: string | undefined; localNetwork: boolean };
  modules: string[] | undefined;
}

/** localhost, 127.0.0.0/8 or ::1: reachable from this machine only */
export const isLoopbackHost = (host: string) => /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i.test(host.trim());

/** The embedded replica set (no MONGODB_URI), or a MongoDB server on loopback or a local socket (mongodb://%2Ftmp%2Fmongodb-27017.sock) */
export function isLocalMongo(uri: string | undefined): boolean {
  if (!uri) return true;
  try {
    // several hosts (mongodb://a,b/…) do not parse as one URL: refused, to be safe
    const host = decodeURIComponent(new URL(uri).hostname);
    return host.startsWith('/') || isLoopbackHost(host);
  } catch {
    return false;
  }
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
    host: e.HOST ?? (prod ? '0.0.0.0' : '127.0.0.1'),
    port: e.PORT,
    healthPort: e.HEALTH_PORT ?? e.PORT + 1,
    healthHost: e.HEALTH_HOST || '127.0.0.1',
    tls: e.TLS_CERT_FILE && e.TLS_KEY_FILE ? { certFile: e.TLS_CERT_FILE, keyFile: e.TLS_KEY_FILE } : undefined,
    httpRedirectPort: e.HTTP_REDIRECT_PORT,
    adminAppDir: e.ADMIN_APP_DIR || undefined,
    logLevel: e.NODE_ENV === 'test' ? 'silent' : e.LOG_LEVEL,
    mongo: { uri: e.MONGODB_URI || undefined, dataDir: e.MONGO_DATA_DIR || undefined, port: e.MONGO_PORT, slowTransactionMs: e.TX_SLOW_MS },
    migrateOnStart: e.MIGRATE_ON_START ?? !prod,
    launchPhase: e.LAUNCH_PHASE,
    market: {
      timeZone: e.MARKET_TIME_ZONE,
      currency: e.MARKET_CURRENCY,
      defaultLocation: { postalCode: e.MARKET_DEFAULT_POSTAL_CODE, label: e.MARKET_DEFAULT_LOCATION_LABEL },
    },
    responseValidation: e.RESPONSE_VALIDATION ?? !prod,
    jobsEnabled: e.JOBS_ENABLED ?? false,
    jobsBackend: e.JOBS_BACKEND ?? (e.MONGODB_URI ? 'mongo' : 'inprocess'),
    deployId: e.DEPLOY_ID || undefined,
    graphqlPersistedOnly: e.GRAPHQL_PERSISTED_ONLY ?? prod,
    // under the 30–60 s idle timeouts of common proxies and firewalls
    eventStreamHeartbeatMs: 25_000,
    auth: { jwks: e.AUTH_JWKS || undefined, issuer: e.AUTH_ISSUER, revocationPollMs: e.REVOCATION_POLL_MS, signingJwk: e.AUTH_SIGNING_JWK ? JSON.parse(e.AUTH_SIGNING_JWK) : undefined },
    appSecret: e.APP_SECRET ?? (devTokens ? 'dev-app-secret-not-for-production-use-0000' : ''),
    publicUrls: {
      store: (e.STORE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
      seller: (e.SELLER_URL ?? 'http://localhost:3001').replace(/\/$/, ''),
      admin: (e.ADMIN_URL ?? 'http://localhost:3002').replace(/\/$/, ''),
    },
    apiUrl: (e.API_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, ''),
    media: {
      storage: e.MEDIA_STORAGE ?? (e.NODE_ENV === 'test' ? 'memory' : 'local'),
      dir: e.MEDIA_STORAGE_DIR,
      imageProcessor: e.MEDIA_IMAGE_PROCESSOR ?? (e.NODE_ENV === 'test' ? 'dev' : 'sharp'),
    },
    backups: e.BACKUP_OPS_DIR ? { dir: e.BACKUP_DIR, opsDir: e.BACKUP_OPS_DIR, uploadDir: e.BACKUP_UPLOAD_DIR ?? `${e.BACKUP_OPS_DIR.replace(/[\/]+$/, '')}/uploads` } : null,
    webhookSecrets: { ...(devTokens ? { '*': 'dev-webhook-secret' } : {}), ...(e.WEBHOOK_SECRETS ? JSON.parse(e.WEBHOOK_SECRETS) : {}) },
    devTokens,
    devSigning: { file: e.DEV_SIGNING_KEY_FILE },
    rateLimits: e.RATE_LIMITS ?? true,
    rateLimitStore: e.RATE_LIMIT_STORE ?? (e.MONGODB_URI ? 'mongo' : 'memory'),
    compression: (e.COMPRESSION ?? true) ? { threshold: e.COMPRESSION_THRESHOLD } : null,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    cors: { store: e.CORS_STORE_ORIGINS, seller: e.CORS_SELLER_ORIGINS, admin: e.CORS_ADMIN_ORIGINS },
    docsEnabled: e.DOCS_ENABLED ?? e.NODE_ENV === 'development',
    appProof: { allowDev: devTokens, turnstileSecret: e.TURNSTILE_SECRET || undefined, localNetwork: e.APP_PROOF_LOCAL_NETWORK ?? false },
    modules: e.MODULES ? e.MODULES.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    ...overrides,
  };
  if (prod && config.devTokens) throw new Error('DEV_TOKENS cannot be enabled in production');
  if (prod && config.docsEnabled) throw new Error('DOCS_ENABLED cannot be enabled in production (/docs is served without a token)');
  // development tokens, the dev key and the default secrets are for this machine only (docs/03 §16)
  if (config.devTokens && !isLoopbackHost(config.host)) {
    throw new Error(`DEV_TOKENS are only served on a loopback HOST (got ${config.host}); use HOST=127.0.0.1, or DEV_TOKENS=false with AUTH_SIGNING_JWK, AUTH_JWKS and APP_SECRET`);
  }
  if (config.devTokens && !isLocalMongo(config.mongo.uri)) {
    throw new Error('DEV_TOKENS are only allowed with a local MongoDB (embedded, or MONGODB_URI on localhost); use DEV_TOKENS=false with AUTH_SIGNING_JWK, AUTH_JWKS and APP_SECRET');
  }
  if (!e.APP_SECRET && !config.devTokens && !prod && !isLoopbackHost(config.host)) {
    throw new Error(`APP_SECRET is required on a non-loopback HOST (${config.host})`);
  }
  if (prod && config.appProof.allowDev) throw new Error('The "dev" app proof cannot be accepted in production');
  if (prod && !config.appSecret) throw new Error('APP_SECRET is required in production (signs unsubscribe, reply and download links)');
  if (prod && !(e.STORE_URL && e.SELLER_URL && e.ADMIN_URL)) throw new Error('STORE_URL, SELLER_URL and ADMIN_URL are required in production (links in emails)');
  if (prod && !e.API_URL) throw new Error('API_URL is required in production (links to the files the API serves)');
  if (prod && config.media.storage === 'memory') throw new Error('MEDIA_STORAGE=memory loses every file on restart; use local in production');
  if (prod && !config.rateLimits) throw new Error('RATE_LIMITS cannot be turned off in production');
  if (prod && !config.mongo.uri) throw new Error('MONGODB_URI is required in production (a MongoDB replica set)');
  if (prod && !config.auth.jwks) throw new Error('AUTH_JWKS is required in production (the public keys that verify tokens)');
  // HTTPS (deploy/linux/README.md): the staff refresh cookie is __Secure-…, which browsers keep only over HTTPS
  if (Boolean(e.TLS_CERT_FILE) !== Boolean(e.TLS_KEY_FILE)) throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE (HTTPS), or neither');
  if (config.httpRedirectPort !== undefined) {
    if (!config.tls) throw new Error('HTTP_REDIRECT_PORT redirects to HTTPS: set TLS_CERT_FILE and TLS_KEY_FILE too');
    if (config.httpRedirectPort === config.port || config.httpRedirectPort === config.healthPort) throw new Error('HTTP_REDIRECT_PORT must differ from PORT and HEALTH_PORT');
  }
  if (prod && !config.tls && !isLoopbackHost(config.host) && config.trustProxy === false) {
    throw new Error(
      `Production on HOST ${config.host} needs HTTPS: set TLS_CERT_FILE and TLS_KEY_FILE (deploy/linux/make-cert.sh makes them), ` +
        'or TRUST_PROXY when a proxy in front of this server terminates HTTPS',
    );
  }
  return config;
}
