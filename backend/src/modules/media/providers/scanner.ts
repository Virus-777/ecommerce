/**
 * Development malware scanner: deterministic, no network. A file is infected when its name contains
 * "eicar" or its bytes contain the EICAR test signature (the string every antivirus flags).
 * ClamAV or a scanning provider replaces it behind MalwareScanner.
 */
import type { MalwareScanner } from '../ports.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!';

export function createDevScanner(): MalwareScanner {
  return {
    async scan({ fileName, body }) {
      if (/eicar/i.test(fileName)) return { clean: false, threat: 'Eicar-Test-Signature' };
      if (Buffer.from(body.buffer, body.byteOffset, body.byteLength).includes(EICAR, 0, 'latin1')) return { clean: false, threat: 'Eicar-Test-Signature' };
      return { clean: true };
    },
    async scanStream({ fileName, body }) {
      if (/eicar/i.test(fileName)) return { clean: false, threat: 'Eicar-Test-Signature' };
      // chunk by chunk, keeping the tail of the previous chunk so a signature across two chunks is found
      const keep = EICAR.length - 1;
      let tail = Buffer.alloc(0);
      for await (const chunk of body) {
        const window = Buffer.concat([tail, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
        if (window.includes(EICAR, 0, 'latin1')) return { clean: false, threat: 'Eicar-Test-Signature' };
        tail = window.subarray(Math.max(0, window.length - keep));
      }
      return { clean: true };
    },
  };
}

export { EICAR };
