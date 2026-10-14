import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { appProofVerifier, isLocalNetworkAddress } from './app-proof.js';

describe('app proof on an offline server (APP_PROOF_LOCAL_NETWORK)', () => {
  it('knows the local network addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.20', '::1', '::ffff:192.168.1.20', 'fd12:3456::1', 'fe80::1']) {
      expect(isLocalNetworkAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '::ffff:8.8.8.8', '2001:db8::1', 'not-an-ip', '']) {
      expect(isLocalNetworkAddress(ip), ip).toBe(false);
    }
  });

  it('lets a local network caller start a session without a proof, and nobody else', async () => {
    const offline = appProofVerifier({ allowDev: false, localNetwork: true });
    expect(await offline.verify(undefined, '192.168.1.20')).toBe(true);
    expect(await offline.verify('dev', '10.0.0.5')).toBe(true); // what the Admin Center sends today
    expect(await offline.verify(undefined, '203.0.113.7')).toBe(false);
    expect(await offline.verify('dev', '203.0.113.7')).toBe(false);
  });

  it('is off unless the setting is on', async () => {
    expect(await appProofVerifier({ allowDev: false }).verify(undefined, '192.168.1.20')).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test' }).appProof.localNetwork).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', APP_PROOF_LOCAL_NETWORK: 'true' }).appProof.localNetwork).toBe(true);
  });
});
