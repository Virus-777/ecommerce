/**
 * Runtime configuration from environment variables (see .env.example). Validated at startup.
 */
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** postgres://… ; empty = in-process PGlite (in memory, or in PGLITE_DIR) */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(),
  /** Run pending migrations when the server starts (production runs `npm run migrate` instead) */
  MIGRATE_ON_START: z.string().optional(),
  /** Plan ch. 20: endpoints of a later phase answer NOT_IMPLEMENTED. Phases 1–2 are designed for launch. */
  LAUNCH_PHASE: z.coerce.number().int().min(1).max(4).default(2),
  MARKET_TIME_ZONE: z.string().default('America/Los_Angeles'),
  MARKET_CURRENCY: z.string().default('USD'),
  /** Validate every response against its spec schema (on by default outside production) */
  RESPONSE_VALIDATION: z.string().optional(),
  /** Run scheduled jobs in this process */
  JOBS_ENABLED: z.string().optional(),
  /** Store and seller GraphQL accept persisted query ids only (on in production) */
  GRAPHQL_PERSISTED_ONLY: z.string().optional(),
  /** Accept development tokens signed with DEV_TOKEN_SECRET (never in production) */
  DEV_TOKENS: z.string().optional(),
  DEV_TOKEN_SECRET: z.string().default('marketly-dev-only-secret'),
  /** Comma-separated module list overriding src/modules.config.ts (tests, partial deployments) */
  MODULES: z.string().optional(),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string | undefined;
  pgliteDir: string | undefined;
  migrateOnStart: boolean;
  launchPhase: number;
  market: { timeZone: string; currency: string };
  responseValidation: boolean;
  jobsEnabled: boolean;
  graphqlPersistedOnly: boolean;
  devTokens: boolean;
  devTokenSecret: string;
  modules: string[] | undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<Config> = {}): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const e = parsed.data;
  const prod = e.NODE_ENV === 'production';
  const flag = (v: string | undefined, def: boolean) => bool(def).parse(v);
  const config: Config = {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.NODE_ENV === 'test' ? 'silent' : e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL || undefined,
    pgliteDir: e.PGLITE_DIR || undefined,
    migrateOnStart: flag(e.MIGRATE_ON_START, !prod),
    launchPhase: e.LAUNCH_PHASE,
    market: { timeZone: e.MARKET_TIME_ZONE, currency: e.MARKET_CURRENCY },
    responseValidation: flag(e.RESPONSE_VALIDATION, !prod),
    jobsEnabled: flag(e.JOBS_ENABLED, false),
    graphqlPersistedOnly: flag(e.GRAPHQL_PERSISTED_ONLY, prod),
    devTokens: !prod && flag(e.DEV_TOKENS, e.NODE_ENV !== 'production'),
    devTokenSecret: e.DEV_TOKEN_SECRET,
    modules: e.MODULES ? e.MODULES.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    ...overrides,
  };
  if (prod && config.devTokens) throw new Error('DEV_TOKENS cannot be enabled in production');
  return config;
}
