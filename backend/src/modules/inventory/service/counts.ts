/** Stock counts (phase 4): counted quantities become count-correction adjustments. */
import { inventoryError } from '../errors.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { CountLine, StockCount } from '../../../spec/inventory.js';
import { stockCountMachine } from '../domain/state-machines.js';
import { actorText, toCount } from '../mappers.js';
import type { Row } from '../ports.js';
import { levelQty } from '../stock-tx.js';
import { invalid, notFound, type StaffBy, type Core } from './core.js';
import type { Adjustments } from './adjustments.js';

export class Counts {
  constructor(private readonly core: Core, private readonly adjustments: Adjustments) {}

  async #countApi(c: Row<'stock_counts'>): Promise<StockCount> {
    const lines = await this.core.repo.countLines(c.id);
    const items = await this.core.skus(lines.map((l) => l.stock_item_id));
    return toCount(c, lines, new Map([...items].map(([id, i]) => [id, i.sku])));
  }

  async createCount(body: { locationId: string; scope: string }, by: StaffBy): Promise<StockCount> {
    const location = await this.core.repo.get('locations', body.locationId);
    if (!location || location.owner_type !== 'official') throw invalid('locationId', 'Choose a company stock location');
    const scope = body.scope?.trim();
    if (!scope) throw invalid('scope', 'Enter a zone, bin prefix or SKU list');
    // company stock and seller items Fulfilled by Marketly from this location (counted by the same staff)
    const levels = [...(await this.core.repo.levelTotals({ ownerType: 'official', locationId: location.id })), ...(await this.core.repo.levelTotals({ ownerType: 'seller', locationId: location.id }))];
    const items = (await this.core.repo.items({ ids: levels.map((l) => l.stock_item_id) })).filter((i) => i.owner_type === 'official' || i.service_location_id === location.id);
    const skus = scope.split(/[\s,;]+/).filter(Boolean);
    const bySku = items.filter((i) => skus.includes(i.sku));
    const chosen = bySku.length ? bySku : items.filter((i) => (i.primary_bin_code ?? '').toUpperCase().startsWith(scope.toUpperCase()));
    if (!chosen.length) throw invalid('scope', 'No stock items at this location match the scope');
    const id = newId();
    const row = await this.core.repo.transaction(async (tx) => {
      const c = await tx.insert('stock_counts', { id, location_id: location.id, scope, state: 'open', created_by: actorText(by.actor), submitted_at: null });
      await tx.insertCountLines(
        chosen.map((i) => {
          const l = levels.find((x) => x.stock_item_id === i.id)!;
          return { count_id: id, stock_item_id: i.id, bin_code: i.primary_bin_code, expected: l.available + l.reserved, counted: null };
        }),
      );
      return c!;
    });
    return this.#countApi(row);
  }

  async recordCountLines(id: string, lines: CountLine[]): Promise<StockCount> {
    const c = await this.core.repo.get('stock_counts', id);
    if (!c) throw notFound('Stock count');
    if (c.state !== 'open') stockCountMachine.next(c.state as 'open', 'cancel'); // ILLEGAL_TRANSITION once submitted
    const own = await this.core.repo.countLines(id);
    for (const [i, l] of (lines ?? []).entries()) {
      if (!own.find((x) => x.stock_item_id === l.stockItemId)) throw invalid(`lines[${i}].stockItemId`, 'This stock item is not in the count');
      if (l.counted !== null && l.counted !== undefined && (!Number.isInteger(l.counted) || l.counted < 0)) throw invalid(`lines[${i}].counted`, 'Counted must be a whole number, 0 or more');
    }
    await this.core.repo.transaction(async (tx) => {
      const locked = (await tx.get('stock_counts', id, { forUpdate: true }))!;
      if (locked.state !== 'open') stockCountMachine.next(locked.state as 'open', 'cancel');
      for (const l of lines ?? []) await tx.updateCountLine(id, l.stockItemId, { counted: l.counted ?? null });
    });
    return this.#countApi((await this.core.repo.get('stock_counts', id))!);
  }

  async submitCount(id: string, by: StaffBy): Promise<StockCount> {
    const c = await this.core.repo.get('stock_counts', id);
    if (!c) throw notFound('Stock count');
    const submitted = stockCountMachine.next(c.state as 'open', 'submit');
    const lines = await this.core.repo.countLines(id);
    const levels = await this.core.repo.levels(lines.map((l) => l.stock_item_id));
    // all differences are checked before any becomes an adjustment
    const diffs: { item: Row<'stock_items'>; diff: number }[] = [];
    const items = await this.core.skus(lines.map((l) => l.stock_item_id));
    for (const l of lines) {
      if (l.counted === null) continue;
      const level = levelQty(levels.find((x) => x.stock_item_id === l.stock_item_id && x.location_id === c.location_id));
      const diff = l.counted - (level.available + level.reserved);
      if (diff < 0 && -diff > level.available) throw inventoryError('RESERVED_NOT_ADJUSTABLE', `${items.get(l.stock_item_id)?.sku}: the count is short of the reserved units; report a discrepancy for the order`, { stockItemId: l.stock_item_id });
      if (diff !== 0) diffs.push({ item: items.get(l.stock_item_id)!, diff });
    }
    await this.core.repo.update('stock_counts', id, { state: submitted, submitted_at: this.core.now() });
    for (const d of diffs) {
      await this.adjustments.requestAdjustment(d.item, { locationId: c.location_id, fromGroup: d.diff > 0 ? 'outside' : 'available', toGroup: d.diff > 0 ? 'available' : 'outside', quantity: Math.abs(d.diff), reasonCode: 'count_correction', note: `Stock count ${c.scope}` }, by);
    }
    const after = await this.core.repo.update('stock_counts', id, { state: stockCountMachine.next(submitted, 'apply') });
    const api = await this.#countApi(after);
    await this.core.audit({ action: 'inventory.count.submit', actionLabel: 'Submitted stock count', category: 'inventory', target: { type: 'stock_count', id, ref: c.scope, screen: 'ops/inventory' }, after: { differences: diffs.map((d) => ({ sku: d.item.sku, difference: d.diff })) } }, by);
    return api;
  }
}
