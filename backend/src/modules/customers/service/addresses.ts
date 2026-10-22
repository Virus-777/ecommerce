/**
 * Address book: saved addresses, the default one, address validation, and the addresses checkout reads and
 * remembers.
 */
import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { AddressInput, AddressValidation, SavedAddress } from '../../../spec/customers.js';
import { checkAddress, cleanAddress, hardIssues, sameAddress } from '../domain/address.js';
import * as map from '../mappers.js';
import type { AddressValidationProvider, CustomerRow } from '../ports.js';
import { type Core, type By, invalid, notFound } from './core.js';
import type { Geocoding } from './geocoding.js';
import type { Profiles } from './profiles.js';

export class Addresses {
  constructor(
    readonly core: Core,
    readonly profiles: Profiles,
    readonly geocoding: Geocoding,
  ) {}

  async listAddresses(scope: Scope): Promise<SavedAddress[]> {
    const c = await this.profiles.ownCustomer(scope);
    return (await this.core.repo.listAddresses(c.id)).map(map.savedAddress);
  }

  /** Same checks as POST /addresses/validate (provider when configured) */
  async validateAddress(address: common.Address): Promise<AddressValidation> {
    const v = checkAddress(address);
    const provider = this.core.deps.addressProvider;
    if (!v.valid || !provider) return v;
    let found: Awaited<ReturnType<AddressValidationProvider['normalise']>> | undefined;
    try {
      found = await provider.normalise(cleanAddress(address));
    } catch (err) {
      this.core.ctx.log.warn({ err, provider: provider.name }, 'customers: address provider failed; format rules only');
      return v;
    }
    if (found === null) {
      return { ...v, issues: [...v.issues, { field: 'line1', code: 'not_found', message: 'We couldn’t find this address; check the street and ZIP code' }] };
    }
    const poBox = v.poBox || found.poBox;
    const issues = poBox && !v.poBox ? [...v.issues, { field: 'line1', code: 'po_box_not_allowed' as const, message: 'We can’t deliver to PO boxes; use a street address' }] : v.issues;
    const changed = !sameAddress(found.address, address) || JSON.stringify(found.address) !== JSON.stringify(cleanAddress(address));
    return { ...v, issues, poBox, deliverable: v.deliverable && !poBox, suggestion: changed ? found.address : null };
  }

  /** Validated, cleaned address for saving: VALIDATION_FAILED for format problems, ADDRESS_UNDELIVERABLE outside the region */
  private async addressForSave(address: common.Address): Promise<common.Address> {
    const v = await this.validateAddress(address);
    const hard = hardIssues(v);
    if (hard.length) throw new AppError('VALIDATION_FAILED', hard[0]!.message, { issues: hard.map((i) => ({ path: `address.${i.field}`, ...i })) });
    if (!v.deliverable) {
      const why = v.issues.filter((i) => i.code === 'outside_service_region' || i.code === 'po_box_not_allowed');
      throw new AppError('ADDRESS_UNDELIVERABLE', why[0]?.message ?? 'We can’t deliver to this address', { issues: why.map((i) => ({ path: `address.${i.field}`, ...i })) });
    }
    return cleanAddress(address);
  }

  private static label(v: string | null | undefined) {
    const t = v?.replace(/\s+/g, ' ').trim();
    if (t && t.length > 40) throw invalid('label', 'Use at most 40 characters for the label');
    return t || null;
  }

  private static instructions(v: string | null | undefined) {
    const t = v?.trim();
    if (t && t.length > 500) throw invalid('deliveryInstructions', 'Use at most 500 characters for delivery instructions');
    return t || null;
  }

  private addressColumns(a: common.Address) {
    return { name: a.name, line1: a.line1, line2: a.line2 ?? null, city: a.city, region: a.region, postal_code: a.postalCode, country: a.country, phone: a.phone ?? null };
  }

  private async addAddress(c: CustomerRow, input: AddressInput, by: By): Promise<SavedAddress> {
    const address = await this.addressForSave(input.address);
    const label = Addresses.label(input.label);
    const instructions = Addresses.instructions(input.deliveryInstructions);
    const max = await this.core.ctx.settings.get('maxAddresses');
    const now = this.core.now();
    // placed on the map before the transaction (the provider may be remote); a failure leaves it to the backfill
    const geo = await this.geocoding.columnsFor(address, now);
    const row = await this.core.repo.transaction(async (repo) => {
      await repo.getCustomer(c.id, { forUpdate: true });
      const n = await repo.countAddresses(c.id);
      if (n >= max) throw new AppError('ADDRESS_LIMIT_REACHED', `You can save up to ${max} addresses. Remove one to add another.`, { max });
      const makeDefault = input.makeDefault === true || n === 0;
      if (makeDefault) await repo.clearDefaultAddress(c.id, now);
      const a = await repo.insertAddress({
        id: newId(),
        customer_id: c.id,
        label,
        ...this.addressColumns(address),
        delivery_instructions: instructions,
        is_default: makeDefault,
        validated_at: now,
        ...geo,
        last_used_at: null,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      });
      if (makeDefault) await repo.updateCustomer(c.id, { default_address_id: a.id, updated_at: now });
      return a;
    });
    this.core.ctx.events.publish('customers.address.saved', { customerId: c.id, addressId: row.id, isDefault: row.is_default }, this.core.meta(by));
    return map.savedAddress(row);
  }

  async createAddress(scope: Scope, body: AddressInput, by: By): Promise<SavedAddress> {
    return this.addAddress(await this.profiles.ownCustomer(scope), body, by);
  }

  async updateAddress(scope: Scope, id: string, body: AddressInput, by: By): Promise<SavedAddress> {
    const c = await this.profiles.ownCustomer(scope);
    if (!(await this.core.repo.getAddress(c.id, id))) throw notFound('Address');
    const address = await this.addressForSave(body.address);
    const label = Addresses.label(body.label);
    const instructions = Addresses.instructions(body.deliveryInstructions);
    const now = this.core.now();
    const geo = await this.geocoding.columnsFor(address, now);
    const row = await this.core.repo.transaction(async (repo) => {
      const a = await repo.getAddress(c.id, id, { forUpdate: true });
      if (!a) throw notFound('Address');
      if (body.makeDefault && !a.is_default) {
        await repo.clearDefaultAddress(c.id, now);
        await repo.updateCustomer(c.id, { default_address_id: a.id, updated_at: now });
      }
      return repo.updateAddress(a.id, {
        label,
        ...this.addressColumns(address),
        delivery_instructions: instructions,
        is_default: a.is_default || body.makeDefault === true,
        validated_at: now,
        ...geo,
        updated_at: now,
      });
    });
    // accepted orders keep the copy made at checkout
    this.core.ctx.events.publish('customers.address.saved', { customerId: c.id, addressId: row.id, isDefault: row.is_default }, this.core.meta(by));
    return map.savedAddress(row);
  }

  async deleteAddress(scope: Scope, id: string): Promise<void> {
    const c = await this.profiles.ownCustomer(scope);
    const now = this.core.now();
    await this.core.repo.transaction(async (repo) => {
      const a = await repo.getAddress(c.id, id, { forUpdate: true });
      if (!a) throw notFound('Address');
      await repo.updateAddress(a.id, { deleted_at: now, is_default: false, updated_at: now });
      if (!a.is_default) return;
      // the most recently used remaining address becomes the default
      const rest = (await repo.listAddresses(c.id)).sort(
        (x, y) => (y.last_used_at?.getTime() ?? -1) - (x.last_used_at?.getTime() ?? -1) || y.created_at.getTime() - x.created_at.getTime(),
      );
      const next = rest[0];
      if (next) await repo.updateAddress(next.id, { is_default: true, updated_at: now });
      await repo.updateCustomer(c.id, { default_address_id: next?.id ?? null, updated_at: now });
    });
  }

  async makeDefaultAddress(scope: Scope, id: string): Promise<SavedAddress[]> {
    const c = await this.profiles.ownCustomer(scope);
    const now = this.core.now();
    await this.core.repo.transaction(async (repo) => {
      const a = await repo.getAddress(c.id, id, { forUpdate: true });
      if (!a) throw notFound('Address');
      if (a.is_default) return;
      await repo.clearDefaultAddress(c.id, now);
      await repo.updateAddress(a.id, { is_default: true, updated_at: now });
      await repo.updateCustomer(c.id, { default_address_id: a.id, updated_at: now });
    });
    return (await this.core.repo.listAddresses(c.id)).map(map.savedAddress);
  }

  /** Returns a copy of a saved address. Checkout stores that copy on the order; later edits never change it (plan ch. 7). */
  async getAddressForOrder(customerId: string, addressId: string): Promise<common.Address> {
    const a = isUuid(customerId) && isUuid(addressId) ? await this.core.repo.getAddress(customerId, addressId) : undefined;
    if (!a) throw notFound('Address');
    return { ...map.addressOf(a) };
  }

  /** Save an address entered at checkout when the customer ticks 'save to my addresses' (an identical saved address is reused) */
  async rememberCheckoutAddress(customerId: string, address: common.Address, label?: string): Promise<SavedAddress> {
    const c = isUuid(customerId) ? await this.core.repo.getCustomer(customerId) : undefined;
    if (!c) throw notFound('Customer');
    const same = (await this.core.repo.listAddresses(c.id)).find((a) => sameAddress(map.addressOf(a), address));
    if (same) {
      const l = Addresses.label(label);
      if (!l || l === same.label) return map.savedAddress(same);
      return map.savedAddress(await this.core.repo.updateAddress(same.id, { label: l, updated_at: this.core.now() }));
    }
    return this.addAddress(c, { address, label: label ?? null, makeDefault: false }, { actor: { kind: 'customer', id: c.user_id } });
  }
}
