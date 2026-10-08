/**
 * Builds the authorization middleware from the config: keys, revocations, authorities, app proof and
 * rate limits. Used by buildApp() and by tests that run the pipeline on a made-up module.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from '../config/index.js';
import type { Clock } from '../lib/clock.js';
import { appProofVerifier } from './app-proof.js';
import { devAuthorities, type Authorities } from './authorities.js';
import { AuthChain, type WebhookVerifier } from './chain.js';
import type { Principal } from './index.js';
import { memoryRateLimitStore, type RateLimitStore } from './rate-limit.js';
import { RevocationList } from './revocation.js';
import { devSigner, parseJwks, type AccessClaims, type KeyRing } from './tokens.js';

export interface AuthSetup {
  config: Config;
  clock: Clock;
  log: FastifyBaseLogger;
  db: Kysely<any>;
  /** The modules' answers (moduleAuthorities); wrapped with the development ones when DEV_TOKENS is on */
  authorities: Authorities;
  /** Wrap the final authorities (tests) */
  wrap?: (a: Authorities) => Authorities;
  webhookVerifiers: Map<string, WebhookVerifier>;
  ownerOnly: ReadonlySet<string>;
}

const UNLIMITED: RateLimitStore = { hit: () => ({ ok: true, retryAfterSeconds: 0 }) };

/** Public keys that verify tokens; in development and tests also the dev signing key */
export function keyRing(config: Config, log: FastifyBaseLogger): KeyRing {
  const ring: KeyRing = { keys: parseJwks(config.auth.jwks) };
  if (config.devTokens) {
    const dev = devSigner({ jwk: config.devSigning.jwk, file: config.devSigning.file });
    ring.keys.set(dev.kid, dev.publicKey);
    ring.dev = { kid: dev.kid, key: dev.key };
    if (config.env === 'development') log.warn(`development tokens are accepted (DEV_TOKENS, key ${dev.kid}); never enable this outside development`);
  }
  return ring;
}

/** The chain, with revocations loaded once; the caller starts and stops polling with the server. */
export async function createAuthChain(s: AuthSetup): Promise<{ auth: AuthChain; revocations: RevocationList }> {
  const { config, clock } = s;
  const claimsOf = new WeakMap<Principal, AccessClaims>();
  let authorities = config.devTokens ? devAuthorities(s.authorities, (p) => claimsOf.get(p)) : s.authorities;
  if (s.wrap) authorities = s.wrap(authorities);
  const revocations = new RevocationList(authorities, clock, s.log, {
    pollMs: config.auth.revocationPollMs,
    windowMs: 16 * 60_000,
    maxStalenessMs: config.env === 'production' ? 30_000 : undefined,
  });
  await revocations.sync();
  const auth = new AuthChain({
    config,
    clock,
    keys: keyRing(config, s.log),
    revocations,
    authorities,
    appProof: appProofVerifier(config.appProof),
    limits: config.rateLimits ? memoryRateLimitStore(clock) : UNLIMITED,
    webhookVerifiers: s.webhookVerifiers,
    ownerOnly: s.ownerOnly,
    db: s.db,
    claimsOf,
  });
  return { auth, revocations };
}
