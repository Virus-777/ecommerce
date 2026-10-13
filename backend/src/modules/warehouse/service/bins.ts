/** Bins, bin assignments of stock items and box types. */
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Bin, BinAssignment, BinAssignmentInput, BoxType } from '../../../spec/warehouse.js';
import { BIN_KINDS, binBarcode, normalizeCode, STORAGE_KINDS, validDimensions, zoneOf } from '../domain/rules.js';
import type { Where } from '../../../kernel/mongo/index.js';
import type { BinRec } from '../ports.js';
import { Batch, invalid, invalidField, notFound, type By, type Core } from './core.js';
import { binView, boxView } from './views.js';

const MAX_CODES = 500;

export class Bins {
  constructor(private readonly core: Core) {}

  private get repo() {
    return this.core.repo;
  }

  async list(q: { locationId?: string; q?: string; zone?: string; kind?: string }, page: PageRequest): Promise<common.Page<Bin>> {
    const where: Where<BinRec> = {};
    if (q.locationId) where.location_id = q.locationId;
    if (q.zone) where.zone = q.zone.trim().toUpperCase();
    if (q.kind) where.kind = q.kind;
    const result = await this.repo.page('bins', where, page, { order: { column: 'code', direction: 'asc' }, ...(q.q?.trim() ? { search: { columns: ['code', 'barcode'], term: q.q } } : {}) });
    const counts = await this.repo.assignmentCounts(result.items.map((b) => b.id));
    return { ...result, items: result.items.map((b) => binView(b, counts.get(b.id) ?? 0)) };
  }

  async view(b: BinRec): Promise<Bin> {
    return binView(b, (await this.repo.assignmentCounts([b.id])).get(b.id) ?? 0);
  }

  async create(body: { locationId: string; codes: string[]; kind: Bin['kind'] }, by: By): Promise<Bin[]> {
    if (!BIN_KINDS.includes(body.kind)) throw invalidField('kind', 'Choose pick, bulk, returns, quarantine, packing or dock');
    const codes = (body.codes ?? []).map(normalizeCode).filter(Boolean);
    if (!codes.length) throw invalidField('codes', 'Enter at least one bin code');
    if (codes.length > MAX_CODES) throw invalidField('codes', `Create at most ${MAX_CODES} bins at a time`);
    const bad = codes.find((c) => c.length > 40 || !/^[A-Z0-9][A-Z0-9._/-]*$/.test(c));
    if (bad) throw invalidField('codes', `${bad} is not a bin code (letters, digits and dashes, e.g. A-03-2)`);
    const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
    if (dupes.length) throw invalidField('codes', `${dupes[0]} is listed twice`);
    const created = await this.repo.transaction(async (tx) => {
      const taken = await tx.find('bins', { location_id: body.locationId, code: codes });
      if (taken.length) throw this.core.error('BIN_CODE_TAKEN', `${taken.map((b) => b.code).join(', ')} already exist${taken.length === 1 ? 's' : ''} at this location`, { codes: taken.map((b) => b.code) });
      const rows: BinRec[] = codes.map((code) => ({ id: newId(), location_id: body.locationId, code, zone: zoneOf(code), kind: body.kind, barcode: binBarcode(body.locationId, code), active: true }));
      // barcodes are unique across sites; a clash (same site suffix) falls back to the bin id
      const clash = new Set((await tx.find('bins', { barcode: rows.map((r) => r.barcode) })).map((b) => b.barcode));
      for (const r of rows) if (clash.has(r.barcode)) r.barcode = `BIN-${r.id.replace(/-/g, '').toUpperCase()}`;
      await tx.insertMany('bins', rows);
      return rows;
    });
    await this.core.audit(
      {
        action: 'warehouse.bins.create',
        actionLabel: created.length === 1 ? 'Created a bin' : `Created ${created.length} bins`,
        category: 'inventory',
        target: { type: 'bin', id: created[0]!.id, ref: created[0]!.code, label: created.length === 1 ? `${body.kind} bin ${created[0]!.code}` : `${created.length} ${body.kind} bins`, screen: 'ops/inventory' },
        after: { locationId: body.locationId, kind: body.kind, codes },
      },
      by,
    );
    return created.map((b) => binView(b, 0));
  }

  async update(id: string, body: { kind?: Bin['kind'] | null; active?: boolean | null }, by: By): Promise<Bin> {
    if (body.kind != null && !BIN_KINDS.includes(body.kind)) throw invalidField('kind', 'Choose pick, bulk, returns, quarantine, packing or dock');
    const { before, after } = await this.repo.transaction(async (tx) => {
      const before = await tx.get('bins', id, { forUpdate: true });
      if (!before) throw notFound('Bin');
      const patch: Partial<BinRec> = {};
      if (body.kind != null && body.kind !== before.kind) patch.kind = body.kind;
      if (body.active != null && body.active !== before.active) patch.active = body.active;
      const assigned = await tx.count('bin_assignments', { bin_id: id });
      if (assigned && (patch.active === false || (patch.kind && !STORAGE_KINDS.includes(patch.kind)))) {
        throw this.core.error('BIN_NOT_EMPTY', `${before.code} still has ${assigned} stock item${assigned === 1 ? '' : 's'} assigned. Move them to another bin first.`, { assignedItems: assigned });
      }
      const after = Object.keys(patch).length ? await tx.update('bins', id, patch) : before;
      return { before, after };
    });
    if (before.kind !== after.kind || before.active !== after.active) {
      await this.core.audit(
        {
          action: 'warehouse.bins.update',
          actionLabel: after.active ? 'Changed a bin' : 'Deactivated a bin',
          category: 'inventory',
          target: { type: 'bin', id, ref: after.code, label: `Bin ${after.code}`, screen: 'ops/inventory' },
          before: { kind: before.kind, active: before.active },
          after: { kind: after.kind, active: after.active },
        },
        by,
      );
    }
    return this.view(after);
  }

  async assignments(stockItemId: string): Promise<BinAssignment[]> {
    const rows = await this.repo.find('bin_assignments', { stock_item_id: stockItemId });
    if (!rows.length) return [];
    const [bins, info] = await Promise.all([this.repo.find('bins', { id: rows.map((r) => r.bin_id) }), this.core.stockInfo([stockItemId])]);
    const i = info.get(stockItemId);
    return rows
      .map((r) => ({ stockItemId, sku: i?.sku ?? '', label: i?.label ?? '', binId: r.bin_id, binCode: bins.find((b) => b.id === r.bin_id)?.code ?? '', primary: r.primary_bin }))
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.binCode.localeCompare(b.binCode));
  }

  /** Replaces the bins of a company stock item (exactly one primary); pending picks follow the new primary bin */
  async setStockItemBins(stockItemId: string, body: { bins: BinAssignmentInput[] }, by: By): Promise<BinAssignment[]> {
    const input = body.bins ?? [];
    const info = (await this.core.stockInfo([stockItemId])).get(stockItemId);
    if (!info) throw notFound('Stock item');
    const ids = input.map((b) => b.binId);
    if (new Set(ids).size !== ids.length) throw invalidField('bins', 'Each bin can be listed once');
    let primaries = input.filter((b) => b.primary).length;
    if (input.length === 1 && primaries === 0) primaries = 1;
    if (input.length && primaries !== 1) throw invalidField('bins', 'Mark exactly one bin as the primary bin');
    const primaryId = input.length === 1 ? input[0]!.binId : input.find((b) => b.primary)?.binId;
    const now = this.core.now();
    const batch = new Batch(by);
    const { before, bins } = await this.repo.transaction(async (tx) => {
      const bins = ids.length ? await tx.find('bins', { id: ids }) : [];
      const issues: { path: string; message: string }[] = [];
      input.forEach((b, i) => {
        const bin = bins.find((x) => x.id === b.binId);
        if (!bin) issues.push({ path: `bins.${i}.binId`, message: 'Unknown bin' });
        else if (!bin.active) issues.push({ path: `bins.${i}.binId`, message: `${bin.code} is not active` });
        else if (!STORAGE_KINDS.includes(bin.kind)) issues.push({ path: `bins.${i}.binId`, message: `${bin.code} is a ${bin.kind} bin; stock is stored in pick or bulk bins` });
      });
      if (issues.length) throw invalid(issues);
      const before = await tx.find('bin_assignments', { stock_item_id: stockItemId }, { forUpdate: true });
      await tx.removeWhere('bin_assignments', { stock_item_id: stockItemId });
      // the primary first: the partial unique index allows one primary per stock item
      for (const b of [...input].sort((x, y) => Number(y.binId === primaryId) - Number(x.binId === primaryId))) {
        const kept = before.find((r) => r.bin_id === b.binId);
        await tx.insert('bin_assignments', { stock_item_id: stockItemId, bin_id: b.binId, primary_bin: b.binId === primaryId, assigned_at: kept?.assigned_at ?? now });
      }
      const primary = bins.find((x) => x.id === primaryId);
      if (primary) {
        // lines not picked yet are picked from the new primary bin
        const open = await tx.find('fulfillments', { status: ['awaiting_pick', 'picking', 'on_hold'], location_id: primary.location_id });
        if (open.length) await tx.updateWhere('fulfillment_lines', { fulfillment_id: open.map((f) => f.id), stock_item_id: stockItemId, state: 'pending', picked: 0 }, { bin_code: primary.code });
      }
      for (const b of input) {
        const bin = bins.find((x) => x.id === b.binId)!;
        const prev = before.find((r) => r.bin_id === b.binId);
        if (!prev || prev.primary_bin !== (b.binId === primaryId)) batch.push('warehouse.bin.assigned', { stockItemId, binId: bin.id, binCode: bin.code, primary: b.binId === primaryId });
      }
      return { before, bins };
    });
    this.core.flush(batch);
    const after = await this.assignments(stockItemId);
    const codeOf = async (id: string) => bins.find((b) => b.id === id)?.code ?? (await this.repo.get('bins', id))?.code ?? id;
    await this.core.audit(
      {
        action: 'warehouse.bins.assign',
        actionLabel: 'Changed the bins of a stock item',
        category: 'inventory',
        target: { type: 'stock_item', id: stockItemId, ref: info.sku, label: info.label, screen: 'ops/inventory' },
        before: await Promise.all(before.map(async (r) => ({ binCode: await codeOf(r.bin_id), primary: r.primary_bin }))),
        after: after.map((a) => ({ binCode: a.binCode, primary: a.primary })),
      },
      by,
    );
    return after;
  }

  /** Primary bin, or a free bin in the item's zone (else any free pick bin) at the location */
  async suggest(stockItemId: string, locationId: string): Promise<Bin | null> {
    const assigned = await this.repo.find('bin_assignments', { stock_item_id: stockItemId });
    const bins = assigned.length ? await this.repo.find('bins', { id: assigned.map((a) => a.bin_id), active: true }) : [];
    const here = bins.filter((b) => b.location_id === locationId);
    const primary = here.find((b) => assigned.find((a) => a.bin_id === b.id)?.primary_bin) ?? here.sort((a, b) => a.code.localeCompare(b.code))[0];
    if (primary) return this.view(primary);
    const zones = [...new Set(bins.map((b) => b.zone))];
    const candidates = await this.repo.find('bins', { location_id: locationId, active: true, kind: ['pick', 'bulk'] }, { orderBy: [['code', 'asc']], limit: 500 });
    if (!candidates.length) return null;
    const counts = await this.repo.assignmentCounts(candidates.map((b) => b.id));
    const free = candidates.filter((b) => !counts.get(b.id));
    const pick = free.find((b) => zones.includes(b.zone) && b.kind === 'pick') ?? free.find((b) => zones.includes(b.zone)) ?? (zones.length ? undefined : (free.find((b) => b.kind === 'pick') ?? free[0]));
    return pick ? binView(pick, 0) : null;
  }

  /** A bin at a location by its scanned barcode or code */
  async byScan(code: string, locationId?: string | null): Promise<BinRec | undefined> {
    const c = normalizeCode(code);
    if (!c) return undefined;
    const byBarcode = (await this.repo.find('bins', { barcode: c }))[0] ?? (await this.repo.find('bins', { barcode: code.trim() }))[0];
    if (byBarcode && (!locationId || byBarcode.location_id === locationId)) return byBarcode;
    const byCode = await this.repo.find('bins', { code: c, ...(locationId ? { location_id: locationId } : {}) }, { limit: 2 });
    return byCode.length === 1 ? byCode[0] : (byCode.find((b) => b.active) ?? undefined);
  }

  /* ---------------------------------------------------------------- box types */

  async boxTypes(): Promise<BoxType[]> {
    return (await this.repo.find('box_types', { active: true }, { orderBy: [['name', 'asc']] })).map(boxView);
  }

  /** Replaces the list: listed types are created or updated, the others are retired (kept for packages that used them) */
  async putBoxTypes(body: { boxTypes: BoxType[] }, by: By): Promise<BoxType[]> {
    const list = body.boxTypes ?? [];
    const issues: { path: string; message: string }[] = [];
    const names = new Set<string>();
    list.forEach((b, i) => {
      if (!b.name?.trim()) issues.push({ path: `boxTypes.${i}.name`, message: 'Enter a name' });
      else if (b.active !== false && names.has(b.name.trim().toLowerCase())) issues.push({ path: `boxTypes.${i}.name`, message: `${b.name} is listed twice` });
      else if (b.active !== false) names.add(b.name.trim().toLowerCase());
      if (!validDimensions(b.dimensions)) issues.push({ path: `boxTypes.${i}.dimensions`, message: 'Enter length, width and height above zero' });
      if (b.maxWeight && !(b.maxWeight.value > 0)) issues.push({ path: `boxTypes.${i}.maxWeight`, message: 'Maximum weight must be above zero' });
    });
    if (new Set(list.map((b) => b.id)).size !== list.length) issues.push({ path: 'boxTypes', message: 'Each box type id can be listed once' });
    if (issues.length) throw invalid(issues);
    const before = await this.repo.find('box_types', {});
    await this.repo.transaction(async (tx) => {
      for (const b of list) {
        const row = { name: b.name.trim(), kind: b.kind, dimensions: b.dimensions, max_weight: b.maxWeight ?? null, active: b.active !== false };
        if (before.some((x) => x.id === b.id)) await tx.update('box_types', b.id, row);
        else await tx.insert('box_types', { id: b.id, ...row });
      }
      const keep = list.map((b) => b.id);
      const retired = before.filter((x) => !keep.includes(x.id) && x.active).map((x) => x.id);
      if (retired.length) await tx.updateWhere('box_types', { id: retired }, { active: false });
    });
    await this.core.audit(
      {
        action: 'warehouse.box_types.replace',
        actionLabel: 'Changed packing box sizes',
        category: 'settings',
        target: { type: 'setting', id: 'warehouse.box_types', label: 'Box and mailer sizes', screen: 'ops/pick-pack' },
        before: before.filter((b) => b.active).map(boxView),
        after: list,
      },
      by,
    );
    return this.boxTypes();
  }
}
