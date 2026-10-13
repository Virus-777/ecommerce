/** Transfers between warehouses (phase 4). */
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { MovementRef, Transfer, TransferLine } from '../../../spec/inventory.js';
import { transferMachine } from '../domain/state-machines.js';
import { actorText, toTransfer } from '../mappers.js';
import type { Row } from '../ports.js';
import { invalid, notFound, type StaffBy, type Core } from './core.js';

export class Transfers {
  constructor(private readonly core: Core) {}

  async #transferApi(t: Row<'transfers'>): Promise<Transfer> {
    const lines = await this.core.repo.transferLines(t.id);
    const items = await this.core.skus(lines.map((l) => l.stock_item_id));
    return toTransfer(t, lines, new Map([...items].map(([id, i]) => [id, i.sku])));
  }

  async createTransfer(body: { fromLocationId: string; toLocationId: string; lines: TransferLine[]; note?: string | null }, by: StaffBy): Promise<Transfer> {
    if (body.fromLocationId === body.toLocationId) throw invalid('toLocationId', 'Choose two different warehouses');
    const [from, to] = await Promise.all([this.core.repo.get('locations', body.fromLocationId), this.core.repo.get('locations', body.toLocationId)]);
    if (!from || from.owner_type !== 'official' || !from.active) throw invalid('fromLocationId', 'Choose an active company warehouse');
    if (!to || to.owner_type !== 'official' || !to.active) throw invalid('toLocationId', 'Choose an active company warehouse');
    if (!body.lines?.length) throw invalid('lines', 'Add at least one line');
    const items = await this.core.repo.items({ ids: body.lines.map((l) => l.stockItemId) });
    const seen = new Set<string>();
    for (const [i, l] of body.lines.entries()) {
      if (!items.find((it) => it.id === l.stockItemId && it.owner_type === 'official')) throw invalid(`lines[${i}].stockItemId`, 'Unknown company stock item');
      if (seen.has(l.stockItemId)) throw invalid(`lines[${i}].stockItemId`, 'Each stock item appears once');
      seen.add(l.stockItemId);
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw invalid(`lines[${i}].quantity`, 'Quantity must be at least 1');
    }
    const id = newId();
    const ref = await this.core.ctx.refs.next('TRF', { digits: 4 });
    const row = await this.core.repo.transaction(async (tx) => {
      const t = await tx.insert('transfers', { id, ref, from_location_id: from.id, to_location_id: to.id, state: 'draft', created_by: actorText(by.actor), note: body.note?.trim() || null, shipped_at: null, received_at: null });
      await tx.insertTransferLines(body.lines.map((l) => ({ transfer_id: id, stock_item_id: l.stockItemId, quantity: l.quantity, received_quantity: null })));
      return t!;
    });
    const api = await this.#transferApi(row);
    await this.core.audit({ action: 'inventory.transfer.create', actionLabel: 'Planned stock transfer', category: 'inventory', target: { type: 'transfer', id, ref, label: `${from.code} → ${to.code}`, screen: 'ops/inventory' }, after: api, reason: body.note ?? null }, by);
    return api;
  }

  async listTransfers(query: { state?: string }, page: PageRequest): Promise<common.Page<Transfer>> {
    const p = await this.core.repo.pageTransfers(query, page);
    return { ...p, items: await Promise.all(p.items.map((t) => this.#transferApi(t))) };
  }

  async #transfer(id: string) {
    const t = await this.core.repo.get('transfers', id);
    if (!t) throw notFound('Transfer');
    return t;
  }

  async shipTransfer(id: string, by: StaffBy): Promise<Transfer> {
    const t = await this.#transfer(id);
    transferMachine.next(t.state as 'draft', 'ship');
    const ref: MovementRef = { kind: 'transfer', id, label: `Transfer ${t.ref}` };
    await this.core.stock(
      'transfer',
      async (st) => {
        const locked = (await st.tx.get('transfers', id, { forUpdate: true }))!;
        const state = transferMachine.next(locked.state as 'draft', 'ship');
        const lines = await st.tx.transferLines(id);
        await st.lock(lines.map((l) => l.stock_item_id));
        for (const l of lines) {
          await st.move(l.stock_item_id, locked.from_location_id, 'available', 'outside', l.quantity, { reason: 'transfer_shipped', ref, actor: by.actor });
          await st.move(l.stock_item_id, locked.to_location_id, 'outside', 'incoming', l.quantity, { reason: 'transfer_shipped', ref, actor: by.actor });
          await st.tx.insert('incoming_expectations', { id: newId(), stock_item_id: l.stock_item_id, location_id: locked.to_location_id, source_kind: 'transfer', source_id: id, source_ref: locked.ref, quantity_open: l.quantity, expected_date: null });
        }
        await st.tx.update('transfers', id, { state, shipped_at: st.now });
      },
      this.core.meta(by),
    );
    const api = await this.#transferApi((await this.core.repo.get('transfers', id))!);
    await this.core.audit({ action: 'inventory.transfer.ship', actionLabel: 'Sent stock transfer', category: 'inventory', target: { type: 'transfer', id, ref: t.ref, screen: 'ops/inventory' }, before: { state: t.state }, after: { state: api.state } }, by);
    return api;
  }

  async receiveTransfer(id: string, body: { lines: TransferLine[]; note?: string | null }, by: StaffBy): Promise<Transfer> {
    const t = await this.#transfer(id);
    transferMachine.next(t.state as 'in_transit', 'receive');
    const lines = await this.core.repo.transferLines(id);
    const received = new Map<string, number>();
    for (const [i, l] of (body.lines ?? []).entries()) {
      const line = lines.find((x) => x.stock_item_id === l.stockItemId);
      if (!line) throw invalid(`lines[${i}].stockItemId`, 'This stock item is not on the transfer');
      const n = l.receivedQuantity ?? l.quantity;
      if (!Number.isInteger(n) || n < 0 || n > line.quantity) throw invalid(`lines[${i}].receivedQuantity`, `Received must be between 0 and ${line.quantity}`);
      received.set(l.stockItemId, n);
    }
    const ref: MovementRef = { kind: 'transfer', id, label: `Transfer ${t.ref}` };
    await this.core.stock(
      'transfer',
      async (st) => {
        const locked = (await st.tx.get('transfers', id, { forUpdate: true }))!;
        const state = transferMachine.next(locked.state as 'in_transit', 'receive');
        await st.lock(lines.map((l) => l.stock_item_id));
        const expectations = await st.tx.expectations({ sourceKind: 'transfer', sourceId: id }, { forUpdate: true });
        for (const l of lines) {
          const n = received.get(l.stock_item_id) ?? l.quantity;
          if (n > 0) await st.move(l.stock_item_id, locked.to_location_id, 'incoming', 'available', n, { reason: 'transfer_received', note: body.note ?? null, ref, actor: by.actor });
          if (l.quantity - n > 0) await st.move(l.stock_item_id, locked.to_location_id, 'incoming', 'outside', l.quantity - n, { reason: 'transfer_short', note: body.note ?? null, ref, actor: by.actor });
          await st.tx.updateTransferLine(id, l.stock_item_id, { received_quantity: n });
          for (const e of expectations.filter((x) => x.stock_item_id === l.stock_item_id)) await st.tx.update('incoming_expectations', e.id, { quantity_open: 0 });
        }
        await st.tx.update('transfers', id, { state, received_at: st.now });
      },
      this.core.meta(by),
    );
    this.core.ctx.events.publish('inventory.transfer.received', { transferId: id, toLocationId: t.to_location_id }, this.core.meta(by));
    const api = await this.#transferApi((await this.core.repo.get('transfers', id))!);
    await this.core.audit({ action: 'inventory.transfer.receive', actionLabel: 'Received stock transfer', category: 'inventory', target: { type: 'transfer', id, ref: t.ref, screen: 'ops/inventory' }, before: { state: t.state }, after: { state: api.state, lines: api.lines }, reason: body.note ?? null }, by);
    return api;
  }

  async cancelTransfer(id: string, reason: string, by: StaffBy): Promise<Transfer> {
    if (!reason?.trim()) throw invalid('reason', 'Say why the transfer is cancelled');
    const t = await this.#transfer(id);
    const state = transferMachine.next(t.state as 'draft', 'cancel');
    const after = await this.core.repo.update('transfers', id, { state });
    const api = await this.#transferApi(after);
    await this.core.audit({ action: 'inventory.transfer.cancel', actionLabel: 'Cancelled stock transfer', category: 'inventory', target: { type: 'transfer', id, ref: t.ref, screen: 'ops/inventory' }, before: { state: t.state }, after: { state }, reason }, by);
    return api;
  }
}
