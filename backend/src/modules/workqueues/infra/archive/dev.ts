import type { ArchiveStore } from '../../ports.js';

/** Development cold storage: archived batches kept in memory (no network, no files) */
export function createDevArchiveStore(): ArchiveStore & { batches: { at: string; items: unknown[] }[] } {
  const batches: { at: string; items: unknown[] }[] = [];
  return {
    batches,
    async put(batch) {
      batches.push(batch);
      if (batches.length > 100) batches.shift();
    },
  };
}
