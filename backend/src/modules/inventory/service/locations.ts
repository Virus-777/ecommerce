/** Company stock locations (warehouse sites). */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { Location, LocationInput } from '../../../spec/inventory.js';
import { toLocation } from '../mappers.js';
import type { Row } from '../ports.js';
import { invalid, notFound, type StaffBy, type Core } from './core.js';

export class Locations {
  constructor(private readonly core: Core) {}

  /** Stock locations with code, name, address and time zone (company warehouses by default), default first */
  async getLocations(opts: { ownerType?: 'official' | 'seller'; sellerId?: string; activeOnly?: boolean } = {}): Promise<Location[]> {
    const ownerType = opts?.ownerType ?? (opts?.sellerId ? 'seller' : 'official');
    if (opts?.sellerId && !isUuid(opts.sellerId)) return [];
    const rows = (await this.core.repo.locations({ ownerType, ...(opts?.sellerId ? { sellerId: opts.sellerId } : {}) })).filter((l) => !opts?.activeOnly || l.active);
    rows.sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.code.localeCompare(b.code));
    return rows.map(toLocation);
  }

  /** The default company location: the Official Store ships-from address, receiving and return default. Null before the first location exists. */
  async getDefaultLocation(): Promise<Location | null> {
    const row = await this.core.officialDefault();
    return row ? toLocation(row) : null;
  }

  async listLocations(): Promise<Location[]> {
    return (await this.core.repo.locations({ ownerType: 'official' })).map(toLocation);
  }

  #checkTimeZone(tz: string) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw invalid('timeZone', 'Not a known time zone');
    }
  }

  /** One sellable warehouse at launch; a second one is operational expansion (phase 4) */
  async #checkSecondSellable(exceptId?: string) {
    if (this.core.ctx.config.launchPhase >= 4) return;
    const others = (await this.core.repo.locations({ ownerType: 'official' })).filter((l) => l.id !== exceptId && l.active && l.sellable && l.kind === 'warehouse');
    if (others.length) throw invalid('sellable', 'A second sellable warehouse is part of operational expansion (launch phase 4)');
  }

  async createLocation(body: LocationInput, by: StaffBy): Promise<Location> {
    const code = body.code?.trim();
    if (!code) throw invalid('code', 'Enter the location code');
    if (!body.name?.trim()) throw invalid('name', 'Enter the location name');
    this.#checkTimeZone(body.timeZone);
    const sellable = body.sellable ?? true;
    const active = body.active ?? true;
    if (sellable && active) await this.#checkSecondSellable();
    if (await this.core.repo.locationByCode(code)) throw new AppError('CONFLICT', `A location with code ${code} already exists`, { code });
    const hasDefault = !!(await this.core.repo.locations({ ownerType: 'official' })).find((l) => l.is_default);
    const row = await this.core.repo.insertIfAbsent(
      'locations',
      { id: newId(), code, name: body.name.trim(), kind: 'warehouse', owner_type: 'official', seller_id: null, address: JSON.stringify(body.address), time_zone: body.timeZone, sellable, active, is_default: !hasDefault && active },
    );
    if (!row) throw new AppError('CONFLICT', `A location with code ${code} already exists`, { code });
    const api = toLocation(row);
    await this.core.audit({ action: 'inventory.location.create', actionLabel: 'Added stock location', category: 'inventory', target: { type: 'location', id: api.id, ref: api.code, label: api.name, screen: 'ops/inventory' }, after: api }, by);
    return api;
  }

  async updateLocation(id: string, body: { name?: string | null; address?: common.Address | null; sellable?: boolean | null; active?: boolean | null }, by: StaffBy): Promise<Location> {
    const before = await this.core.repo.get('locations', id);
    if (!before || before.owner_type !== 'official') throw notFound('Location');
    const patch: Partial<Row<'locations'>> = {};
    if (body.name != null) {
      if (!body.name.trim()) throw invalid('name', 'Enter the location name');
      patch.name = body.name.trim();
    }
    if (body.address != null) patch.address = JSON.stringify(body.address);
    if (body.sellable != null) patch.sellable = body.sellable;
    if (body.active != null) patch.active = body.active;
    const sellable = patch.sellable ?? before.sellable;
    const active = patch.active ?? before.active;
    if (sellable && active && !(before.sellable && before.active)) await this.#checkSecondSellable(id);
    if (before.active && active === false) {
      // company stock and seller stock Fulfilled by Marketly held here
      const totals = [...(await this.core.repo.levelTotals({ ownerType: 'official', locationId: id })), ...(await this.core.repo.levelTotals({ ownerType: 'seller', locationId: id }))];
      const units = totals.reduce((n, l) => n + l.available + l.reserved + l.incoming + l.damaged_held + l.returned, 0);
      if (units > 0) throw invalid('active', `${units} unit${units === 1 ? ' is' : 's are'} still at this location; move them first`);
    }
    const after = await this.core.repo.transaction(async (tx) => {
      let row = await tx.update('locations', id, patch);
      if (row.is_default && !row.active) {
        row = await tx.update('locations', id, { is_default: false });
        const next = (await tx.locations({ ownerType: 'official' })).find((l) => l.active && l.kind === 'warehouse' && l.id !== id);
        if (next) await tx.update('locations', next.id, { is_default: true });
      }
      if (row.active && !(await tx.locations({ ownerType: 'official' })).some((l) => l.is_default && l.active)) row = await tx.update('locations', id, { is_default: true });
      return row;
    });
    const api = toLocation(after);
    await this.core.audit({ action: 'inventory.location.update', actionLabel: 'Changed stock location', category: 'inventory', target: { type: 'location', id, ref: api.code, label: api.name, screen: 'ops/inventory' }, before: toLocation(before), after: api }, by);
    return api;
  }
}
