/**
 * App proof for the bootstrap endpoint (the one endpoint without a token): evidence that the request
 * comes from a real Marketly app. X-App-Proof carries `turnstile:<token>` from the website's bot challenge
 * or `play:<token>` from Play Integrity on Android. Development and tests accept `dev`.
 */
import { AppError } from '../errors/index.js';

export interface AppProofVerifier {
  verify(proof: string | undefined, ip: string): Promise<boolean>;
}

export interface AppProofConfig {
  /** Accept the literal proof `dev` (development and tests only) */
  allowDev: boolean;
  turnstileSecret?: string;
  /** Play Integrity verdicts are decoded by a verifier the deployment supplies (Google service account) */
  playIntegrity?: (token: string) => Promise<boolean>;
}

export function appProofVerifier(c: AppProofConfig): AppProofVerifier {
  return {
    async verify(proof, ip) {
      if (!proof) return false;
      if (proof === 'dev') return c.allowDev;
      const [kind, token] = [proof.slice(0, proof.indexOf(':')), proof.slice(proof.indexOf(':') + 1)];
      if (kind === 'turnstile') {
        if (!c.turnstileSecret) throw new AppError('SERVICE_UNAVAILABLE', 'Website app proof is not configured');
        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: c.turnstileSecret, response: token, remoteip: ip }),
        });
        return res.ok && Boolean(((await res.json()) as { success?: boolean }).success);
      }
      if (kind === 'play') {
        if (!c.playIntegrity) throw new AppError('SERVICE_UNAVAILABLE', 'Android app proof is not configured');
        return c.playIntegrity(token);
      }
      return false;
    },
  };
}
