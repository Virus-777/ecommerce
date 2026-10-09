/**
 * StockDirectory over inventory's public API.
 *
 * Inventory has no "get stock items by id" function in its spec (reported as a spec gap). Until it
 * does, SKU, label and owner come from, in order:
 *   1. a short-lived in-process cache (also fed by inventory.stock.low events),
 *   2. what purchasing recorded on earlier purchase order lines (always company stock),
 *   3. inventory.exportRows('inventory.admin.stock', { stockItemIds, ownerType: 'official' }, principal),
 *      reading { stockItemId | id, sku, label, ownerType } from each row.
 * Replace step 3 with the lookup once inventory offers one; nothing else changes.
 */
import type { Clock } from '../../../../kernel/lib/clock.js';
import type * as identity from '../../../../spec/identity.js';
import type { InventoryPublicApi } from '../../../../spec/inventory.js';
import type { StockDirectory, StockInfo } from '../../ports.js';

export const STOCK_DATASET = 'inventory.admin.stock';
const TTL_MS = 10 * 60_000;
const MAX_PAGES = 20;
/** Jobs and event consumers read as the platform */
const PLATFORM: identity.Principal = { kind: 'staff', accountId: null };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** One export row → StockInfo, whatever the exact column names inventory chose. */
export function stockInfoFromRow(row: unknown): StockInfo | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = str(r.stockItemId) ?? str(r.id);
  if (!id) return null;
  const sku = str(r.sku) ?? str(r.companySku) ?? str(r.sellerSku) ?? '';
  const label = str(r.label) ?? ([str(r.product), str(r.variant)].filter(Boolean).join(', ') || sku);
  const ownerType = r.ownerType === 'seller' ? 'seller' : r.ownerType === 'official' ? 'official' : null;
  return { stockItemId: id, sku, label, ownerType };
}

export function createInventoryStockDirectory(deps: {
  inventory: () => InventoryPublicApi;
  knownStock: (ids: readonly string[]) => Promise<Map<string, { sku: string; label: string }>>;
  clock: Clock;
}): StockDirectory {
  const cache = new Map<string, { info: StockInfo; until: number }>();
  const put = (info: StockInfo) => cache.set(info.stockItemId, { info, until: deps.clock.now().getTime() + TTL_MS });

  return {
    remember: put,

    async describe(stockItemIds, viewer) {
      const out = new Map<string, StockInfo>();
      const now = deps.clock.now().getTime();
      let missing: string[] = [];
      for (const id of new Set(stockItemIds)) {
        const hit = cache.get(id);
        if (hit && hit.until > now) out.set(id, hit.info);
        else missing.push(id);
      }
      if (!missing.length) return out;

      const known = await deps.knownStock(missing);
      for (const [id, k] of known) {
        const info: StockInfo = { stockItemId: id, sku: k.sku, label: k.label, ownerType: 'official' };
        out.set(id, info);
        put(info);
      }
      missing = missing.filter((id) => !known.has(id));
      if (!missing.length) return out;

      const wanted = new Set(missing);
      const principal = viewer?.kind === 'staff' ? viewer : PLATFORM;
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES && wanted.size; page++) {
        const res = await deps.inventory().exportRows(STOCK_DATASET, { stockItemIds: missing, ownerType: 'official' }, principal, cursor);
        for (const row of res?.rows ?? []) {
          const info = stockInfoFromRow(row);
          if (!info || !wanted.has(info.stockItemId)) continue;
          wanted.delete(info.stockItemId);
          out.set(info.stockItemId, info);
          put(info);
        }
        cursor = res?.nextCursor;
        if (!cursor) break;
      }
      return out;
    },
  };
}
