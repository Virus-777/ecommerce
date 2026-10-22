/**
 * Registered devices for Post-sale: customers register their phones (brand, model, IMEI, purchase date, an optional
 * Marketly order), staff verify them with the end of the warranty cover or reject them, and a verified device under
 * cover makes covered-by-warranty post-sale services $0 (catalog.coveredPrice, requests.createRequest). Devices are
 * keyed by the customers-module id. Customers only ever get the IMEI's last 4 digits back.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isIsoDate } from '../../../kernel/lib/dates.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { Page, PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Device, DeviceAdmin, DeviceAdminUpdate, DeviceInput, DeviceVerifyInput, StatusChange } from '../../../spec/services.js';
import { addMonthsToDay, COVER_MONTHS, DEVICE_LIMIT, deviceLabel, imeiDigits, isValidImei, LIMITS, longDateLabel, monthYearLabel } from '../domain/rules.js';
import { registeredDeviceMachine } from '../domain/state-machines.js';
import type { DeviceRow } from '../ports.js';
import { actorKey, invalid, notFound, optionalText, requireText, unique, type By } from './base.js';
import { ServicesRequests } from './requests.js';

type DeviceStatus = Device['status'];
const historyOf = (v: unknown): StatusChange[] => (Array.isArray(v) ? (v as StatusChange[]).filter((h) => h && typeof h.status === 'string' && typeof h.at === 'string') : []);

export class ServicesDevices extends ServicesRequests {
  /* ---------------------------------------------------------------- output */

  private covered(d: DeviceRow): boolean {
    return d.status === 'verified' && d.covered_until != null && d.covered_until >= this.today();
  }

  private statusLabelOf(d: DeviceRow): string {
    if (d.status === 'pending') return 'Waiting for verification';
    if (d.status === 'rejected') return 'Not verified';
    if (!d.covered_until) return 'Verified';
    return this.covered(d) ? `Covered to ${monthYearLabel(d.covered_until)}` : `Cover ended ${monthYearLabel(d.covered_until)}`;
  }

  private deviceOut(d: DeviceRow): Device {
    const covered = this.covered(d);
    return {
      id: d.id,
      brand: d.brand,
      model: d.model,
      storage: d.storage,
      label: deviceLabel(d.model, d.storage),
      imeiLast4: d.imei_last4,
      imeiLabel: `IMEI ending ${d.imei_last4}`,
      purchaseDate: d.purchase_date,
      purchaseLabel: `Bought ${longDateLabel(d.purchase_date)}`,
      orderRef: d.order_ref,
      status: d.status,
      statusLabel: this.statusLabelOf(d),
      covered,
      coveredUntil: d.covered_until,
      coverageLabel: covered ? `Covered to ${monthYearLabel(d.covered_until!)}` : null,
      rejectReason: d.status === 'rejected' ? d.reject_reason : null,
      canEdit: d.status !== 'verified',
      createdAt: d.created_at.toISOString(),
    };
  }

  private async devicesAdmin(rows: DeviceRow[]): Promise<DeviceAdmin[]> {
    if (!rows.length) return [];
    const customers = this.ctx.tryUse('customers');
    const ids = unique(rows.map((d) => d.customer_id));
    const [counts, names] = await Promise.all([
      this.repo.deviceRequestCounts(rows.map((d) => d.id)),
      Promise.all(ids.map(async (id) => [id, (await this.soft('customers.getCustomer', customers && (() => customers.getCustomer(id)), null))?.displayName ?? null] as const)).then((l) => new Map(l)),
    ]);
    return rows.map((d) => ({
      id: d.id,
      customerId: d.customer_id,
      customerName: names.get(d.customer_id) ?? null,
      brand: d.brand,
      model: d.model,
      storage: d.storage,
      label: deviceLabel(d.model, d.storage),
      imei: d.imei,
      imeiLast4: d.imei_last4,
      purchaseDate: d.purchase_date,
      orderRef: d.order_ref,
      status: d.status,
      coveredUntil: d.covered_until,
      suggestedCoveredUntil: addMonthsToDay(d.purchase_date, COVER_MONTHS),
      covered: this.covered(d),
      rejectReason: d.reject_reason,
      staffNote: d.staff_note,
      verifiedAt: d.verified_at?.toISOString() ?? null,
      verifiedBy: d.verified_by,
      requestCount: counts.get(d.id) ?? 0,
      history: historyOf(d.history),
      createdAt: d.created_at.toISOString(),
      updatedAt: d.updated_at.toISOString(),
    }));
  }

  /* ---------------------------------------------------------------- validation */

  private checkImei(value: string | null | undefined): string {
    const digits = imeiDigits(value);
    if (!digits) throw invalid('imei', 'Enter the IMEI (dial *#06# to see it)');
    if (!/^\d{15}$/.test(digits)) throw invalid('imei', 'An IMEI has 15 digits');
    if (!isValidImei(digits)) throw invalid('imei', 'This IMEI is not valid; check the digits');
    return digits;
  }

  private checkPurchaseDate(value: string | null | undefined): string {
    if (!value || !isIsoDate(value)) throw invalid('purchaseDate', 'Use a date like 2026-10-02');
    if (value > this.today()) throw invalid('purchaseDate', 'The purchase date can’t be in the future');
    if (value < '2000-01-01') throw invalid('purchaseDate', 'Use a date from 2000');
    return value;
  }

  private checkOrderRef(value: string | null | undefined): string | null {
    const v = optionalText(value, 'orderRef', 40);
    if (v && !/^[A-Za-z0-9-]+$/.test(v)) throw invalid('orderRef', 'Use the order reference as shown in your orders, e.g. MK-48213');
    return v ? v.toUpperCase() : null;
  }

  private deviceFields(input: DeviceInput) {
    const imei = this.checkImei(input.imei);
    return {
      brand: requireText(input.brand, 'brand', 40),
      model: requireText(input.model, 'model', LIMITS.short),
      storage: optionalText(input.storage, 'storage', 20),
      imei,
      imei_last4: imei.slice(-4),
      purchase_date: this.checkPurchaseDate(input.purchaseDate),
      order_ref: this.checkOrderRef(input.orderRef),
    };
  }

  private async checkImeiFree(imei: string, exceptId?: string) {
    if (await this.repo.imeiTaken(imei, exceptId)) throw this.ctx.error('IMEI_TAKEN', 'This phone is already registered.');
  }

  /* ---------------------------------------------------------------- customers */

  async listMyDevices(customerId: string): Promise<Device[]> {
    return (await this.repo.customerDevices(customerId)).map((d) => this.deviceOut(d));
  }

  private async myDevice(customerId: string, id: string): Promise<DeviceRow> {
    const d = await this.repo.getDevice(id);
    if (!d || d.customer_id !== customerId) throw notFound('Device');
    return d;
  }

  async getMyDevice(customerId: string, id: string): Promise<Device> {
    return this.deviceOut(await this.myDevice(customerId, id));
  }

  async registerDevice(customerId: string, input: DeviceInput): Promise<Device> {
    const f = this.deviceFields(input);
    if ((await this.repo.countCustomerDevices(customerId)) >= DEVICE_LIMIT) throw this.ctx.error('DEVICE_LIMIT', `You can register up to ${DEVICE_LIMIT} devices; remove one first.`);
    await this.checkImeiFree(f.imei);
    const now = this.now();
    const row = await this.repo.insertDevice({ id: newId(), customer_id: customerId, ...f, status: 'pending', covered_until: null, reject_reason: null, staff_note: null, verified_at: null, verified_by: null, history: [{ status: 'pending', at: now.toISOString(), by: 'customer' }] as never, created_at: now, updated_at: now });
    return this.deviceOut(row);
  }

  async updateMyDevice(customerId: string, id: string, input: DeviceInput): Promise<Device> {
    const d = await this.myDevice(customerId, id);
    if (d.status === 'verified') throw this.ctx.error('DEVICE_LOCKED', 'A verified device can’t be changed; remove it and register it again, or contact support.');
    const f = this.deviceFields(input);
    await this.checkImeiFree(f.imei, id);
    const now = this.now();
    // changing a rejected device sends it to staff again
    const resubmit = d.status === 'rejected';
    const status = resubmit ? (registeredDeviceMachine.next('rejected' as never, 'resubmit') as DeviceStatus) : d.status;
    const row = (await this.repo.updateDevice(id, { ...f, status, ...(resubmit ? { reject_reason: null, history: [...historyOf(d.history), { status, at: now.toISOString(), by: 'customer' }] as never } : {}), updated_at: now }))!;
    return this.deviceOut(row);
  }

  async removeMyDevice(customerId: string, id: string): Promise<void> {
    await this.myDevice(customerId, id);
    await this.repo.deleteDevice(id);
  }

  /* ---------------------------------------------------------------- staff */

  async listDevicesAdmin(q: { status?: 'pending' | 'verified' | 'rejected'; customerId?: string; q?: string }, page: PageRequest): Promise<Page<DeviceAdmin>> {
    const res = await this.repo.pageAdminDevices(q, page);
    return { ...res, items: await this.devicesAdmin(res.items) };
  }

  async getDeviceAdmin(id: string): Promise<DeviceAdmin> {
    const d = await this.repo.getDevice(id);
    if (!d) throw notFound('Device');
    return (await this.devicesAdmin([d]))[0]!;
  }

  private checkCoveredUntil(value: string | null | undefined, purchaseDate: string): string | null {
    if (value == null) return null;
    if (!isIsoDate(value)) throw invalid('coveredUntil', 'Use a date like 2027-10-02');
    if (value < purchaseDate) throw invalid('coveredUntil', 'The cover can’t end before the purchase date');
    return value;
  }

  async verifyDevice(id: string, input: DeviceVerifyInput, by: By): Promise<DeviceAdmin> {
    const d = await this.repo.getDevice(id);
    if (!d) throw notFound('Device');
    const status = registeredDeviceMachine.next(d.status as never, 'verify') as DeviceStatus;
    const coveredUntil = this.checkCoveredUntil(input.coveredUntil, d.purchase_date) ?? addMonthsToDay(d.purchase_date, COVER_MONTHS);
    const now = this.now();
    const who = actorKey(by.actor);
    const row = (await this.repo.updateDevice(id, {
      status,
      covered_until: coveredUntil,
      reject_reason: null,
      verified_at: now,
      verified_by: who,
      ...(input.staffNote !== undefined ? { staff_note: optionalText(input.staffNote, 'staffNote', LIMITS.notes) } : {}),
      history: [...historyOf(d.history), { status, at: now.toISOString(), by: who }] as never,
      updated_at: now,
    }))!;
    const label = deviceLabel(row.model, row.storage);
    this.ctx.events.publish('services.device.verified', { deviceId: id, customerId: row.customer_id, label, coveredUntil }, by);
    await this.audit({ action: 'services.device.verify', actionLabel: `Verified ${label}`, target: { type: 'service_device', id, label }, before: { status: d.status, coveredUntil: d.covered_until }, after: { status, coveredUntil } }, by);
    return this.getDeviceAdmin(id);
  }

  async rejectDevice(id: string, body: { reason: string; staffNote?: string | null }, by: By): Promise<DeviceAdmin> {
    const d = await this.repo.getDevice(id);
    if (!d) throw notFound('Device');
    const reason = requireText(body.reason, 'reason', 300, 'Say why, so the customer can fix it');
    const status = registeredDeviceMachine.next(d.status as never, 'reject') as DeviceStatus;
    const now = this.now();
    const who = actorKey(by.actor);
    await this.repo.updateDevice(id, {
      status,
      reject_reason: reason,
      ...(body.staffNote !== undefined ? { staff_note: optionalText(body.staffNote, 'staffNote', LIMITS.notes) } : {}),
      history: [...historyOf(d.history), { status, at: now.toISOString(), by: who }] as never,
      updated_at: now,
    });
    const label = deviceLabel(d.model, d.storage);
    this.ctx.events.publish('services.device.rejected', { deviceId: id, customerId: d.customer_id, label, reason }, by);
    await this.audit({ action: 'services.device.reject', actionLabel: d.status === 'verified' ? `Withdrew the verification of ${label}` : `Rejected ${label}`, target: { type: 'service_device', id, label }, before: { status: d.status }, after: { status, reason } }, by);
    return this.getDeviceAdmin(id);
  }

  async updateDeviceAdmin(id: string, input: DeviceAdminUpdate, by: By): Promise<DeviceAdmin> {
    const d = await this.repo.getDevice(id);
    if (!d) throw notFound('Device');
    const patch: Partial<DeviceRow> = {};
    if (input.brand != null) patch.brand = requireText(input.brand, 'brand', 40);
    if (input.model != null) patch.model = requireText(input.model, 'model', LIMITS.short);
    if (input.storage !== undefined) patch.storage = optionalText(input.storage, 'storage', 20);
    if (input.imei != null) {
      patch.imei = this.checkImei(input.imei);
      patch.imei_last4 = patch.imei.slice(-4);
      if (patch.imei !== d.imei && d.status !== 'rejected') await this.checkImeiFree(patch.imei, id);
    }
    if (input.purchaseDate != null) patch.purchase_date = this.checkPurchaseDate(input.purchaseDate);
    if (input.orderRef !== undefined) patch.order_ref = this.checkOrderRef(input.orderRef);
    if (input.staffNote !== undefined) patch.staff_note = optionalText(input.staffNote, 'staffNote', LIMITS.notes);
    const purchase = patch.purchase_date ?? d.purchase_date;
    if (input.coveredUntil !== undefined) {
      if (d.status !== 'verified') throw new AppError('ILLEGAL_TRANSITION', 'Set the cover when verifying the device', { machine: 'Registered device', from: d.status, event: 'cover' });
      patch.covered_until = this.checkCoveredUntil(input.coveredUntil, purchase) ?? addMonthsToDay(purchase, COVER_MONTHS);
    } else if (patch.purchase_date && d.covered_until && d.covered_until < purchase) {
      throw invalid('purchaseDate', 'The purchase date is after the end of the cover; change the cover too');
    }
    const row = (await this.repo.updateDevice(id, { ...patch, updated_at: this.now() }))!;
    const label = deviceLabel(row.model, row.storage);
    // the history keeps the IMEI's last 4 digits only
    await this.audit({ action: 'services.device.update', actionLabel: `Changed ${label}`, target: { type: 'service_device', id, label }, before: { brand: d.brand, model: d.model, storage: d.storage, imeiLast4: d.imei_last4, purchaseDate: d.purchase_date, orderRef: d.order_ref, coveredUntil: d.covered_until }, after: { brand: row.brand, model: row.model, storage: row.storage, imeiLast4: row.imei_last4, purchaseDate: row.purchase_date, orderRef: row.order_ref, coveredUntil: row.covered_until } }, by);
    return this.getDeviceAdmin(id);
  }

  /* ---------------------------------------------------------------- personal data export */

  /**
   * The customer's own records for the personal data export (customers.build-data-exports): requests and reviews by the
   * account id, saved providers and devices by the customers-module id and the account id they fall back to. The full
   * IMEI is the customer's own data; staff notes and who changed a status are left out.
   */
  async exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const owners = unique([input.customerId, input.accountId].filter(Boolean));
    const [requests, reviews, saves, devices] = await Promise.all([
      this.repo.allCustomerRequests(input.accountId),
      this.repo.allCustomerReviews(input.accountId),
      Promise.all(owners.map((id) => this.repo.savedProviders(id))).then((l) => l.flat()),
      Promise.all(owners.map((id) => this.repo.customerDevices(id))).then((l) => l.flat()),
    ]);
    const [services, providers] = await Promise.all([
      this.repo.servicesByIds(unique([...requests.map((r) => r.service_id), ...reviews.map((r) => r.service_id)])),
      this.repo.providersByIds(unique([...requests.map((r) => r.provider_id), ...saves.map((r) => r.provider_id)])),
    ]);
    const serviceTitle = new Map(services.map((x) => [x.id, x.title]));
    const provider = new Map(providers.map((x) => [x.id, x]));
    const refOf = new Map(requests.map((r) => [r.id, r.ref]));
    const out: common.CustomerDataSection[] = [];
    if (requests.length)
      out.push({
        key: 'services_requests',
        title: 'Service requests and bookings',
        module: 'services',
        records: requests.map((r) => {
          const staff = (Array.isArray(provider.get(r.provider_id)?.staff) ? (provider.get(r.provider_id)!.staff as unknown as { id: string; name: string }[]) : []).find((x) => x && x.id === r.staff_id);
          const device = r.device as { label?: string; imeiLast4?: string; covered?: boolean } | null;
          return {
            reference: r.ref,
            area: r.area,
            service: serviceTitle.get(r.service_id) ?? null,
            provider: provider.get(r.provider_id)?.name ?? null,
            slotStart: r.slot_start?.toISOString() ?? null,
            slotEnd: r.slot_end?.toISOString() ?? null,
            staffMember: staff?.name ?? null,
            contact: r.contact,
            details: r.details,
            device: device ? { label: device.label ?? null, imeiLast4: device.imeiLast4 ?? null, coveredByWarranty: device.covered === true } : null,
            status: r.status,
            providerNote: r.provider_note,
            history: historyOf(r.history).map((h) => ({ status: h.status, at: h.at })),
            createdAt: r.created_at.toISOString(),
          };
        }),
      });
    if (reviews.length) out.push({ key: 'services_reviews', title: 'Service reviews', module: 'services', records: reviews.map((r) => ({ request: refOf.get(r.request_id) ?? null, service: serviceTitle.get(r.service_id) ?? null, stars: r.rating, text: r.text, shownAs: r.author_name, hidden: r.status === 'hidden', date: r.created_at.toISOString() })) });
    if (saves.length) out.push({ key: 'services_saved_providers', title: 'Saved providers', module: 'services', records: saves.map((r) => ({ provider: provider.get(r.provider_id)?.name ?? null, savedAt: r.created_at.toISOString() })) });
    if (devices.length)
      out.push({
        key: 'services_devices',
        title: 'Registered devices',
        module: 'services',
        records: devices.map((d) => ({ brand: d.brand, model: d.model, storage: d.storage, imei: d.imei, purchaseDate: d.purchase_date, orderRef: d.order_ref, status: d.status, coveredUntil: d.covered_until, rejectReason: d.reject_reason, registeredAt: d.created_at.toISOString() })),
      });
    return out;
  }
}
