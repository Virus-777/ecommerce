/**
 * Builds the authorization middleware from the config: keys, revocations, authorities, app proof and
 * rate limits. Used by buildApp() and by tests that run the pipeline on a made-up module.
 */
import type { FastifyBaseLogger } from 'fastify';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Config } from '../config/index.js';
import type { Clock } from '../lib/clock.js';
import { appProofVerifier } from './app-proof.js';
import { devAuthorities, type Authorities } from './authorities.js';
import { AuthChain, type FileLinkAuth, type WebhookVerifier } from './chain.js';
import type { Principal } from './index.js';
import { memoryRateLimitStore, UNLIMITED, type RateLimitStore } from './rate-limit.js';
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
  /** Where the middleware counts (RATE_LIMIT_STORE); default memory */
  limits?: RateLimitStore;
  /** Signed file links (GET /files/…), when a module serves files */
  fileLinks?: FileLinkAuth;
}


/**
 * The key identity signs access and visitor tokens with: AUTH_SIGNING_JWK, else (development and
 * tests) the dev key. Every server verifies with the public part (keyRing).
 */
export function tokenSigner(config: Config): { kid: string; key: KeyObject; publicKey: KeyObject } {
  const jwk = config.auth.signingJwk;
  if (jwk) {
    if (!jwk.kid) throw new Error('AUTH_SIGNING_JWK needs a kid');
    const key = createPrivateKey({ key: jwk, format: 'jwk' });
    return { kid: jwk.kid, key, publicKey: createPublicKey(key) };
  }
  if (!config.devTokens) throw new Error('AUTH_SIGNING_JWK is required to issue tokens outside development');
  return devSigner({ jwk: config.devSigning.jwk, file: config.devSigning.file });
}

/** Public keys that verify tokens; in development and tests also the dev signing key */
export function keyRing(config: Config, log: FastifyBaseLogger): KeyRing {
  const ring: KeyRing = { keys: parseJwks(config.auth.jwks) };
  if (config.auth.signingJwk) {
    const own = tokenSigner(config);
    ring.keys.set(own.kid, own.publicKey);
  }
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
    limits: config.rateLimits ? (s.limits ?? memoryRateLimitStore(clock)) : UNLIMITED,
    webhookVerifiers: s.webhookVerifiers,
    ownerOnly: s.ownerOnly,
    db: s.db,
    claimsOf,
    fileLinks: s.fileLinks,
  });
  return { auth, revocations };
}
