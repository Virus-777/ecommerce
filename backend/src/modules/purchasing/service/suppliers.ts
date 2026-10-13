/**
 * Suppliers and their price lists (one preferred supplier per SKU), the preferred supplier other modules ask for,
 * and the nightly supplier performance figures.
 */
import { newId } from '../../../kernel/lib/ids.js';
import { money } from '../../../kernel/lib/money.js';
import type { Page, PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Supplier, SupplierDetail, SupplierInput, SupplierItem, SupplierItemInput } from '../../../spec/purchasing.js';
import { ACTIVE_CLAIM_STATUSES, days, invalid, invalidMany, locationOf, pct } from '../domain/rules.js';
import type { SupplierItemRow, SupplierRow } from '../ports.js';
import { clean, notFound, required, type Caller, type Core } from './core.js';

const DEFAULT_PAYMENT_TERMS = 'Net 30 from invoice';
const RECENT_POS = 10;

export class Suppliers {
  constructor(private readonly core: Core) {}

  /** Used when a return outcome is 'return to supplier' */
  async getPreferredSupplier(stockItemId: string): Promise<{ supplierId: string; name: string; supplierSku: string | null; unitCost: common.Money; returnAuthorizationRequired: boolean } | null> {
    const items = await this.core.repo.itemsForStock({ stockItemIds: [stockItemId] });
    const best = items[0]; // preferred first, then cheapest
    if (!best) return null;
    const supplier = await this.core.repo.getSupplier(best.supplierId);
    if (!supplier) return null;
    return { supplierId: supplier.id, name: supplier.name, supplierSku: best.supplierSku, unitCost: money(best.unitCostAmount, best.currency), returnAuthorizationRequired: supplier.returnAuthorizationRequired };
  }

  async listSuppliers(query: { q?: string; active?: boolean }, page: PageRequest): Promise<Page<Supplier>> {
    const p = await this.core.repo.listSuppliers(query, page);
    return { ...p, items: await this.core.views.suppliers(p.items) };
  }

  async getSupplier(id: string): Promise<SupplierDetail> {
    const s = await this.core.repo.getSupplier(id);
    if (!s) throw notFound('Supplier');
    const [items, perf, open, pos, claims, windowDays] = await Promise.all([
      this.core.repo.supplierItems(id),
      this.core.repo.performanceOf([id]),
      this.core.repo.openPurchaseOrderCounts([id]),
      this.core.repo.purchaseOrdersBy({ supplierId: id, limit: RECENT_POS }),
      this.core.repo.claimsBy({ supplierId: id, statuses: ACTIVE_CLAIM_STATUSES }),
      this.core.ctx.settings.get('performanceWindowDays'),
    ]);
    const p = perf.get(id);
    return {
      supplier: this.core.views.supplier(s, open.get(id) ?? 0, p),
      items: await this.core.views.supplierItems(items),
      performance: {
        windowDays: p?.windowDays ?? windowDays,
        onTimePct: p?.onTimePct ?? null,
        avgLeadTimeDays: p?.avgLeadTimeDays ?? null,
        shortageRatePct: p?.shortageRatePct ?? null,
        damageRatePct: p?.damageRatePct ?? null,
        deliveries: p?.deliveries ?? 0,
      },
      recentPurchaseOrders: await this.core.views.purchaseOrderRows(pos),
      openClaims: await this.core.views.claims(claims, { suppliers: [s] }),
    };
  }

  async createSupplier(input: SupplierInput, by: Caller): Promise<Supplier> {
    const name = required(input.name, 'name', 'Enter the supplier name');
    if (input.leadTimeDays != null && input.leadTimeDays < 0) throw invalid('leadTimeDays', 'Lead time cannot be negative');
    const row = await this.core.repo.insertSupplier({
      id: newId(),
      name,
      location: locationOf(input.address) || null,
      contactName: clean(input.contactName),
      email: clean(input.email),
      phone: clean(input.phone),
      address: input.address ?? null,
      paymentTerms: clean(input.paymentTerms) ?? DEFAULT_PAYMENT_TERMS,
      leadTimeDays: input.leadTimeDays ?? 0,
      returnAuthorizationRequired: input.returnAuthorizationRequired ?? false,
      active: input.active ?? true,
      notes: clean(input.notes),
      createdAt: this.core.now(),
    });
    await this.core.audit({ action: 'purchasing.supplier.create', actionLabel: 'Added supplier', category: 'other', target: supplierTarget(row), after: supplierSnapshot(row) }, by);
    return this.core.views.supplier(row, 0);
  }

  async updateSupplier(id: string, input: SupplierInput, by: Caller): Promise<Supplier> {
    const name = required(input.name, 'name', 'Enter the supplier name');
    if (input.leadTimeDays != null && input.leadTimeDays < 0) throw invalid('leadTimeDays', 'Lead time cannot be negative');
    const { before, after } = await this.core.repo.transaction(async (tx) => {
      const before = await tx.getSupplier(id, { forUpdate: true });
      if (!before) throw notFound('Supplier');
      const patch: Partial<SupplierRow> = { name };
      if (input.contactName !== undefined) patch.contactName = clean(input.contactName);
      if (input.email !== undefined) patch.email = clean(input.email);
      if (input.phone !== undefined) patch.phone = clean(input.phone);
      if (input.address !== undefined) {
        patch.address = input.address ?? null;
        patch.location = locationOf(input.address) || null;
      }
      if (input.paymentTerms !== undefined) patch.paymentTerms = clean(input.paymentTerms) ?? before.paymentTerms;
      if (input.leadTimeDays != null) patch.leadTimeDays = input.leadTimeDays;
      if (input.notes !== undefined) patch.notes = clean(input.notes);
      if (input.active != null) patch.active = input.active;
      if (input.returnAuthorizationRequired != null) patch.returnAuthorizationRequired = input.returnAuthorizationRequired;
      return { before, after: await tx.updateSupplier(id, patch) };
    });
    const deactivated = before.active && !after.active;
    await this.core.audit(
      {
        action: deactivated ? 'purchasing.supplier.deactivate' : 'purchasing.supplier.update',
        actionLabel: deactivated ? 'Deactivated supplier' : !before.active && after.active ? 'Reactivated supplier' : 'Edited supplier',
        category: 'other',
        target: supplierTarget(after),
        before: supplierSnapshot(before),
        after: supplierSnapshot(after),
      },
      by,
    );
    const [open, perf] = await Promise.all([this.core.repo.openPurchaseOrderCounts([id]), this.core.repo.performanceOf([id])]);
    return this.core.views.supplier(after, open.get(id) ?? 0, perf.get(id));
  }

  async putSupplierItems(id: string, items: SupplierItemInput[], by: Caller): Promise<SupplierItem[]> {
    const supplier = await this.core.repo.getSupplier(id);
    if (!supplier) throw notFound('Supplier');
    const issues: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    (items ?? []).forEach((it, i) => {
      if (seen.has(it.stockItemId)) issues.push({ path: `items.${i}.stockItemId`, message: 'This item is already on the price list' });
      seen.add(it.stockItemId);
      if (it.unitCost.currency !== this.core.currency) issues.push({ path: `items.${i}.unitCost.currency`, message: `Buying costs are in ${this.core.currency}` });
      if (it.unitCost.amount < 0) issues.push({ path: `items.${i}.unitCost.amount`, message: 'Unit cost cannot be negative' });
      if (it.minOrderQuantity != null && it.minOrderQuantity < 1) issues.push({ path: `items.${i}.minOrderQuantity`, message: 'Minimum order is at least 1' });
      if (it.leadTimeDays != null && it.leadTimeDays < 0) issues.push({ path: `items.${i}.leadTimeDays`, message: 'Lead time cannot be negative' });
    });
    if (issues.length) throw invalidMany('Some price list rows are invalid', issues);
    if (items.length) await this.core.requireCompanyStock(items.map((i) => i.stockItemId));
    const now = this.core.now();
    const rows: SupplierItemRow[] = items.map((it) => ({
      supplierId: id,
      stockItemId: it.stockItemId,
      supplierSku: clean(it.supplierSku),
      unitCostAmount: it.unitCost.amount,
      currency: it.unitCost.currency,
      minOrderQty: it.minOrderQuantity ?? null,
      leadTimeDays: it.leadTimeDays ?? null,
      preferred: it.preferred ?? false,
      updatedAt: now,
    }));
    const before = await this.core.repo.transaction(async (tx) => {
      if (!(await tx.getSupplier(id, { forUpdate: true }))) throw notFound('Supplier');
      const before = await tx.supplierItems(id);
      await tx.replaceSupplierItems(id, rows);
      // one preferred supplier per SKU: choosing this one unsets the others
      await tx.clearPreferred(rows.filter((r) => r.preferred).map((r) => r.stockItemId), id);
      return before;
    });
    await this.core.audit(
      {
        action: 'purchasing.supplier.price_list_replace',
        actionLabel: 'Replaced supplier price list',
        category: 'other',
        target: supplierTarget(supplier),
        before: before.map(itemSnapshot),
        after: rows.map(itemSnapshot),
        beforeText: `${before.length} item${before.length === 1 ? '' : 's'}`,
        afterText: `${rows.length} item${rows.length === 1 ? '' : 's'}`,
      },
      by,
    );
    return this.core.views.supplierItems(await this.core.repo.supplierItems(id));
  }

  /** Job purchasing.supplier-performance (nightly 02:30 market time): Recompute on-time %, average lead time, shortage and damage rates per supplier over the window */
  async supplierPerformance(): Promise<number> {
    const windowDays = await this.core.ctx.settings.get('performanceWindowDays');
    const now = this.core.now();
    const inputs = new Map((await this.core.repo.performanceInputs(new Date(now.getTime() - windowDays * 86_400_000))).map((i) => [i.supplierId, i]));
    const ids = await this.core.repo.supplierIds();
    for (const id of ids) {
      const i = inputs.get(id);
      await this.core.repo.savePerformance({
        supplierId: id,
        windowDays,
        onTimePct: i ? pct(i.onTime, i.deliveries) : null,
        avgLeadTimeDays: i && i.leadTimeCount ? days(i.leadTimeMsTotal / i.leadTimeCount) : null,
        shortageRatePct: i ? pct(i.shortage, i.expected) : null,
        damageRatePct: i ? pct(i.damaged, i.received) : null,
        deliveries: i?.deliveries ?? 0,
        computedAt: now,
      });
    }
    return ids.length;
  }
}

const supplierTarget = (s: SupplierRow) => ({ type: 'supplier', id: s.id, label: s.name, screen: 'admin/purchasing' });
const supplierSnapshot = (s: SupplierRow) => ({ name: s.name, contactName: s.contactName, email: s.email, phone: s.phone, paymentTerms: s.paymentTerms, leadTimeDays: s.leadTimeDays, active: s.active });
const itemSnapshot = (i: SupplierItemRow) => ({ stockItemId: i.stockItemId, supplierSku: i.supplierSku, unitCost: { amount: i.unitCostAmount, currency: i.currency }, minOrderQuantity: i.minOrderQty, leadTimeDays: i.leadTimeDays, preferred: i.preferred });
