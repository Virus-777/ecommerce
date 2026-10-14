/**
 * App proof for the bootstrap endpoint (the one endpoint without a token): evidence that the request
 * comes from a real Marketly app. X-App-Proof carries `turnstile:<token>` from the website's bot challenge
 * or `play:<token>` from Play Integrity on Android. Development and tests accept `dev`.
 *
 * Offline servers (APP_PROOF_LOCAL_NETWORK): both checks need the internet, so a request from a private network
 * address (the staff network) needs no proof. Any other address still does, so a server exposed by mistake does not
 * open its session start to the internet. Behind a proxy, set TRUST_PROXY so the address is the caller's.
 */
import { BlockList, isIP } from 'node:net';
import { AppError } from '../errors/index.js';

/** Loopback and private ranges (RFC 1918, IPv6 unique-local and link-local) */
const LOCAL_NETWORK = new BlockList();
LOCAL_NETWORK.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL_NETWORK.addSubnet('10.0.0.0', 8, 'ipv4');
LOCAL_NETWORK.addSubnet('172.16.0.0', 12, 'ipv4');
LOCAL_NETWORK.addSubnet('192.168.0.0', 16, 'ipv4');
LOCAL_NETWORK.addAddress('::1', 'ipv6');
LOCAL_NETWORK.addSubnet('fc00::', 7, 'ipv6');
LOCAL_NETWORK.addSubnet('fe80::', 10, 'ipv6');

/** Whether an address is on this machine or the local network (an IPv4 address written as ::ffff:a.b.c.d included) */
export function isLocalNetworkAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) return LOCAL_NETWORK.check(v4, 'ipv4');
  if (isIP(ip) === 6) return LOCAL_NETWORK.check(ip, 'ipv6');
  return false;
}

export interface AppProofVerifier {
  verify(proof: string | undefined, ip: string): Promise<boolean>;
}

export interface AppProofConfig {
  /** Accept the literal proof `dev` (development and tests only) */
  allowDev: boolean;
  turnstileSecret?: string;
  /** Play Integrity verdicts are decoded by a verifier the deployment supplies (Google service account) */
  playIntegrity?: (token: string) => Promise<boolean>;
  /** Offline servers: a request from the local network needs no proof (APP_PROOF_LOCAL_NETWORK) */
  localNetwork?: boolean;
}

export function appProofVerifier(c: AppProofConfig): AppProofVerifier {
  return {
    async verify(proof, ip) {
      if (c.localNetwork && isLocalNetworkAddress(ip)) return true;
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
