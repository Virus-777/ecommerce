/**
 * Dealers: the farm machine dealers staff keep in Admin (address and map point, hours, phone, message phone or email,
 * lead time, active, order), and the customer's nearest dealer for Farm machines' "Your nearest dealer".
 */
import { newId } from '../../../kernel/lib/ids.js';
import type { DealerAdmin, DealerInput, NearestDealer } from '../../../spec/farm.js';
import { isEmail, isPhone, LIMITS, OPEN_STATUSES } from '../domain/rules.js';
import type { DealerRow } from '../ports.js';
import { FarmBase, invalid, notFound, optionalText, pointOf, requireText, type By } from './base.js';

export class FarmDealers extends FarmBase {
  /* ---------------------------------------------------------------- customers */

  /** The nearest active dealer to the customer's geocoded default address, else the market default without a distance */
  async getNearestDealer(customerId: string | null): Promise<NearestDealer> {
    const from = await this.customerPoint(customerId);
    const pick = await this.dealerFor(from);
    if (!pick) return { dealer: null, basis: 'market_default' };
    return { dealer: this.dealerCard(pick.dealer.id, this.snapshotOf(pick.dealer), pick.nearest ? from : null), basis: pick.nearest ? 'your_address' : 'market_default' };
  }

  /* ---------------------------------------------------------------- staff */

  private async dealersAdmin(rows: DealerRow[]): Promise<DealerAdmin[]> {
    const counts = await this.repo.orderCounts(rows.map((d) => d.id), OPEN_STATUSES);
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      address: { line1: d.line1, line2: d.line2, city: d.city, region: d.region, postalCode: d.postal_code, country: d.country },
      point: pointOf(d.point),
      pinned: d.pinned,
      hours: d.hours,
      phone: d.phone,
      messagePhone: d.message_phone,
      messageEmail: d.message_email,
      leadDays: d.lead_days,
      active: d.active,
      position: d.position,
      openOrders: counts.get(d.id)?.open ?? 0,
      orderCount: counts.get(d.id)?.all ?? 0,
      createdAt: d.created_at.toISOString(),
      updatedAt: d.updated_at.toISOString(),
    }));
  }

  async listDealers(q: { q?: string; active?: boolean }): Promise<DealerAdmin[]> {
    let rows = await this.repo.listDealers();
    if (q.active != null) rows = rows.filter((d) => d.active === q.active);
    const text = q.q?.trim().toLowerCase();
    if (text) rows = rows.filter((d) => [d.name, d.city, d.line1, d.phone].some((s) => s.toLowerCase().includes(text)));
    return this.dealersAdmin(rows);
  }

  async getDealer(id: string): Promise<DealerAdmin> {
    const d = await this.repo.getDealer(id);
    if (!d) throw notFound('Dealer');
    return (await this.dealersAdmin([d]))[0]!;
  }

  /** The checked fields of a dealer form, with its point: the pin, else the geocoded address (null when unknown) */
  private async dealerFields(input: DealerInput) {
    const a = input.address;
    if (!a || typeof a !== 'object') throw invalid('address', 'Add the address');
    const address = {
      line1: requireText(a.line1, 'address.line1', LIMITS.line),
      line2: optionalText(a.line2, 'address.line2', LIMITS.line),
      city: requireText(a.city, 'address.city', LIMITS.city),
      region: requireText(a.region, 'address.region', LIMITS.region),
      postal_code: optionalText(a.postalCode, 'address.postalCode', LIMITS.postalCode),
      country: (optionalText(a.country, 'address.country', 2) ?? this.country).toUpperCase(),
    };
    const phone = requireText(input.phone, 'phone', LIMITS.phone);
    if (!isPhone(phone)) throw invalid('phone', 'Enter a phone number');
    const messagePhone = optionalText(input.messagePhone, 'messagePhone', LIMITS.phone);
    if (messagePhone && !isPhone(messagePhone)) throw invalid('messagePhone', 'Enter a phone number');
    const messageEmail = optionalText(input.messageEmail, 'messageEmail', LIMITS.email);
    if (messageEmail && !isEmail(messageEmail)) throw invalid('messageEmail', 'Enter an email address');
    if (input.leadDays != null && (!Number.isInteger(input.leadDays) || input.leadDays < 0 || input.leadDays > LIMITS.leadDays)) throw invalid('leadDays', `Use 0 to ${LIMITS.leadDays} days`);
    if (input.position != null && !Number.isInteger(input.position)) throw invalid('position', 'Use a whole number');
    const pin = input.point != null ? pointOf(input.point) : null;
    if (input.point != null && !pin) throw invalid('point', 'Not a point on the map');
    const point = pin ?? (await this.geocode({ line1: address.line1, city: address.city, region: address.region, postalCode: address.postal_code, country: address.country }));
    return {
      name: requireText(input.name, 'name', LIMITS.name),
      ...address,
      point: point as never,
      pinned: Boolean(pin),
      hours: requireText(input.hours, 'hours', LIMITS.hours),
      phone,
      message_phone: messagePhone,
      message_email: messageEmail,
      lead_days: input.leadDays ?? null,
    };
  }

  async createDealer(input: DealerInput, by: By): Promise<DealerAdmin> {
    const fields = await this.dealerFields(input);
    const now = this.now();
    const row = await this.repo.insertDealer({ id: newId(), ...fields, active: input.active ?? true, position: input.position ?? (await this.repo.maxDealerPosition()) + 1, created_at: now, updated_at: now });
    await this.audit({ action: 'farm.dealer.create', actionLabel: `Added dealer ${row.name}`, category: 'content', target: { type: 'farm_dealer', id: row.id, label: row.name }, after: { name: row.name, city: row.city, active: row.active } }, by);
    return this.getDealer(row.id);
  }

  async updateDealer(id: string, input: DealerInput, by: By): Promise<DealerAdmin> {
    const before = await this.repo.getDealer(id);
    if (!before) throw notFound('Dealer');
    const fields = await this.dealerFields(input);
    const after = (await this.repo.updateDealer(id, { ...fields, active: input.active ?? before.active, position: input.position ?? before.position, updated_at: this.now() }))!;
    await this.audit(
      {
        action: 'farm.dealer.update',
        actionLabel: `Changed dealer ${after.name}`,
        category: 'content',
        target: { type: 'farm_dealer', id, label: after.name },
        before: { name: before.name, line1: before.line1, city: before.city, point: before.point, hours: before.hours, phone: before.phone, active: before.active, leadDays: before.lead_days },
        after: { name: after.name, line1: after.line1, city: after.city, point: after.point, hours: after.hours, phone: after.phone, active: after.active, leadDays: after.lead_days },
      },
      by,
    );
    return this.getDealer(id);
  }

  async deleteDealer(id: string, by: By): Promise<void> {
    const d = await this.repo.getDealer(id);
    if (!d) throw notFound('Dealer');
    if ((await this.repo.countOrders(id)) > 0) throw this.ctx.error('IN_USE', `${d.name} has farm orders; switch it off instead.`);
    await this.repo.deleteDealer(id);
    await this.audit({ action: 'farm.dealer.delete', actionLabel: `Deleted dealer ${d.name}`, category: 'content', target: { type: 'farm_dealer', id, label: d.name }, before: { name: d.name, city: d.city } }, by);
  }
}
