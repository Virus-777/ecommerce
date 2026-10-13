/**
 * The purchasing dashboard: open purchase orders, committed cost, incoming units, late or short, low stock.
 */
import { dateInZone } from '../../../kernel/lib/clock.js';
import { money } from '../../../kernel/lib/money.js';
import type { PurchasingSummary } from '../../../spec/purchasing.js';
import { INCOMING_PO_STATUSES, isLateOrShort, minDate, OPEN_PO_STATUSES, openQty } from '../domain/rules.js';
import { groupBy, units, type Core } from './core.js';
import type { ReorderSuggestions } from './reorder-suggestions.js';

export class Summary {
  constructor(
    private readonly core: Core,
    private readonly reorder: ReorderSuggestions,
  ) {}

  async getSummary(): Promise<PurchasingSummary> {
    const pos = await this.core.repo.purchaseOrdersBy({ statuses: OPEN_PO_STATUSES });
    const ids = pos.map((p) => p.id);
    const [lines, deliveries, stock, suggestions] = await Promise.all([
      this.core.repo.linesOf(ids),
      this.core.repo.deliveriesOf(ids),
      this.core.inventory().getStockSummary(),
      this.reorder.suggestions({}),
    ]);
    const today = this.core.today();
    const byPo = groupBy(lines, (l) => l.purchaseOrderId);
    const delayed = new Set(deliveries.filter((d) => d.status === 'delayed').map((d) => d.purchaseOrderId));
    let incomingUnits = 0;
    const arrivals: string[] = [];
    const late: { ref: string; open: number }[] = [];
    for (const p of pos) {
      const ls = byPo.get(p.id) ?? [];
      if (!INCOMING_PO_STATUSES.includes(p.status)) continue;
      const open = ls.reduce((n, l) => n + openQty(l), 0);
      incomingUnits += open;
      for (const l of ls) if (openQty(l) > 0) arrivals.push(l.expectedDate ?? p.expectedDate ?? '');
      if (isLateOrShort(p.status, p.expectedDate, ls, delayed.has(p.id), today)) late.push({ ref: p.ref, open });
    }
    for (const d of deliveries) if (d.status === 'expected' || d.status === 'delayed') arrivals.push(dateInZone(d.windowFrom, this.core.ctx.config.market.timeZone));
    const nextArrival = minDate(arrivals.filter((d) => d && d >= today));
    return {
      openPurchaseOrders: pos.length,
      committed: money(
        pos.reduce((n, p) => n + p.totalAmount, 0),
        this.core.currency,
      ),
      incomingUnits,
      nextArrival,
      lateOrShort: late.length,
      lateOrShortNote: late.length ? `${late[0]!.ref} · ${units(late[0]!.open)}${late.length > 1 ? ` and ${late.length - 1} more` : ''}` : null,
      lowStockItems: (stock?.lowStockCount ?? 0) + (stock?.outOfStockCount ?? 0),
      reorderSuggested: suggestions.length,
    };
  }
}
