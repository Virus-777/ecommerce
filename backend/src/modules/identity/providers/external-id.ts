import type { ExternalIdentityVerifier } from '../ports.js';

/**
 * Development and tests only: deterministic ID tokens instead of Google / Apple.
 *   dev:<email>                 a verified email
 *   dev:<email>:<first>:<last>  with names
 *   dev-unverified:<email>      the provider does not vouch for the email
 * Anything else is refused. No network.
 */
export const devExternalIdentityVerifier: ExternalIdentityVerifier = {
  async verify(provider, idToken) {
    const m = /^(dev|dev-unverified):([^:\s]+@[^:\s]+)(?::([^:]*):([^:]*))?$/.exec(idToken);
    if (!m) return null;
    const email = m[2]!;
    return { provider, subject: `${provider}|${email.toLowerCase()}`, email, emailVerified: m[1] === 'dev', firstName: m[3] || null, lastName: m[4] || null };
  },
};
