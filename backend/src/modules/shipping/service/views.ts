/**
 * Rows → API types, in one place per type. Loads what a view needs in batches (lines, events, labels,
 * exceptions, seller names) so lists stay at a fixed number of queries.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { money } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type {
  Carrier,
  CarrierClaim,
  CarrierService,
  Closure,
  DeliveryException,
  FreeShippingRule,
  Label,
  ServiceNotice,
  Shipment,
  ShipmentSummary,
  ShippingMethod,
  ShippingProfile,
  TrackingEvent,
  Zone,
} from '../../../spec/shipping.js';
import { deadlineLabel, deadlineState, rangeLabel } from '../domain/calendar.js';
import { KIND_LABEL, MARKETLY_REQUIRED_RESPONSE, OPEN_STATUSES, REQUIRED_RESPONSE, RESOLUTION_LABEL, RESPONSE_LABEL, ESCALATION_LABEL, type ExceptionKind } from '../domain/exceptions.js';
import { CARRIER_CATALOG, statusLabel, trackingUrlOf } from '../domain/tracking.js';
import type { CarrierRec, ClaimRec, ClosureRec, CorrectionRec, EventRec, ExceptionLogRec, ExceptionRec, LabelRec, LineRec, MethodRec, NoticeRec, ProfileRec, RuleRec, ServiceRec, ShipmentRec, ZoneRec } from '../ports.js';
import { iso, type Core } from './core.js';

/** Who pays a label (labels.billed_to) */
export type BilledTo = 'seller' | 'company' | 'platform' | 'customer';

/** The carrier and service a label was bought for (labels.carrier_service_id) */
export async function labelCarrier(core: Core, l: Pick<LabelRec, 'carrier_service_id'>): Promise<{ carrierCode: string; carrierName: string; serviceName: string }> {
  const service = await core.repo.get('carrier_services', l.carrier_service_id);
  const carrier = service ? await core.repo.get('carriers', service.carrier_id) : undefined;
  return { carrierCode: carrier?.code ?? 'other', carrierName: carrier?.name ?? 'Carrier', serviceName: service?.name ?? 'Carrier service' };
}

export interface ShipmentParts {
  lines: Map<string, LineRec[]>;
  events: Map<string, EventRec[]>;
  corrections: Map<string, CorrectionRec[]>;
  labels: Map<string, LabelRec>;
  openExceptions: Map<string, ExceptionRec[]>;
  packagesInOrder: Map<string, number>;
  names: Map<string, string>;
}

const group = <T, K>(rows: readonly T[], key: (r: T) => K) => {
  const m = new Map<K, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
};

export const carrierNameOf = (code: string | null | undefined, carriers?: readonly CarrierRec[]) =>
  code ? (carriers?.find((c) => c.code === code)?.name ?? CARRIER_CATALOG[code]?.name ?? code.toUpperCase()) : null;

export class Views {
  constructor(private readonly core: Core) {}

  /* ---------------------------------------------------------------- setup */

  service(s: ServiceRec): CarrierService {
    return { id: s.id, carrierId: s.carrier_id, code: s.code, name: s.name, transit: { min: s.transit_min, max: s.transit_max }, enabled: s.enabled, labelSupported: s.label_supported, trackingPattern: s.tracking_pattern };
  }

  carrier(c: CarrierRec, services: readonly ServiceRec[], o: { staff: boolean; enabledOnly?: boolean }): Carrier {
    const mode = c.tracking_mode as Carrier['trackingMode'];
    return {
      id: c.id,
      code: c.code,
      name: c.name,
      accountLabel: o.staff ? c.account_label : null,
      status: c.status as Carrier['status'],
      trackingMode: mode,
      trackingConnected: c.status === 'active' && mode !== 'manual' && Boolean(c.credentials_ref),
      lastEventAt: iso(c.last_event_at),
      onTimeRate30d: c.on_time_rate_30d != null ? Number(c.on_time_rate_30d) : null,
      services: services.filter((s) => s.carrier_id === c.id && (!o.enabledOnly || s.enabled)).map((s) => this.service(s)),
      contacts: o.staff ? c.contacts : [],
    };
  }

  method(m: MethodRec): ShippingMethod {
    return { id: m.id, code: m.code as ShippingMethod['code'], name: m.name, customerLabel: m.customer_label, transit: { min: m.transit_min, max: m.transit_max }, carrierServiceIds: m.carrier_service_ids, active: m.active, position: m.position };
  }

  zone(z: ZoneRec): Zone {
    return {
      id: z.id,
      name: z.name,
      kind: z.kind as Zone['kind'],
      regions: z.regions,
      postalPrefixes: z.postal_prefixes,
      addressKinds: z.address_kinds as Zone['addressKinds'],
      transitByMethod: z.transit_by_method,
      status: z.status as Zone['status'],
      customerMessage: z.customer_message,
    };
  }

  closure(c: ClosureRec): Closure {
    return { id: c.id, name: c.name, from: c.from_date, to: c.to_date };
  }

  profile(p: ProfileRec, offersUsing = 0): ShippingProfile {
    return {
      id: p.lineage_id,
      ownerType: p.owner_type as ShippingProfile['ownerType'],
      sellerId: p.seller_id,
      name: p.name,
      isDefault: p.is_default,
      methods: p.methods,
      freeShippingThreshold: p.free_threshold != null ? money(p.free_threshold, p.currency) : null,
      freeShippingMethodCode: p.free_method_code,
      version: p.version,
      status: p.status as ShippingProfile['status'],
      effectiveFrom: p.effective_from.toISOString(),
      offersUsing,
      updatedAt: p.updated_at.toISOString(),
      updatedBy: p.updated_by,
    };
  }

  notice(n: NoticeRec): ServiceNotice {
    return {
      id: n.id,
      title: n.title,
      kind: n.kind as ServiceNotice['kind'],
      from: n.from_date,
      to: n.to_date,
      carrierCodes: n.carrier_codes,
      carrierServiceIds: n.carrier_service_ids,
      regions: n.regions,
      postalPrefixes: n.postal_prefixes,
      zoneIds: n.zone_ids,
      sellerScope: n.seller_scope as ServiceNotice['sellerScope'],
      effect: n.effect,
      customerMessage: n.customer_message,
      showFrom: iso(n.show_from),
      surfaces: n.surfaces as ServiceNotice['surfaces'],
      status: n.status as ServiceNotice['status'],
      createdBy: n.created_by,
      updatedAt: n.updated_at.toISOString(),
    };
  }

  rule(r: RuleRec): FreeShippingRule {
    return {
      id: r.id,
      name: r.name,
      scope: r.scope as FreeShippingRule['scope'],
      minOrderValue: r.min_order_value != null ? money(r.min_order_value, this.core.currency) : null,
      methodCode: r.method_code,
      fundedBy: r.funded_by as FreeShippingRule['fundedBy'],
      window: r.starts_on || r.ends_on ? { from: r.starts_on ?? r.ends_on!, to: r.ends_on ?? '9999-12-31' } : null,
      status: r.status as FreeShippingRule['status'],
    };
  }

  /* ---------------------------------------------------------------- shipments */

  async parts(rows: readonly ShipmentRec[]): Promise<ShipmentParts> {
    const ids = rows.map((r) => r.id);
    const orderIds = [...new Set(rows.map((r) => r.order_id))];
    const repo = this.core.repo;
    const [lines, events, corrections, labels, exceptions, inOrders, names] = await Promise.all([
      ids.length ? repo.find('shipment_lines', { shipment_id: ids }) : [],
      ids.length ? repo.find('tracking_events', { shipment_id: ids }, { orderBy: [['at', 'desc'], ['id', 'desc']] }) : [],
      ids.length ? repo.find('tracking_corrections', { shipment_id: ids }, { orderBy: [['at', 'asc']] }) : [],
      ids.length ? repo.find('labels', { shipment_id: ids }, { orderBy: [['purchased_at', 'asc']] }) : [],
      ids.length ? repo.find('exceptions', { shipment_id: ids, status: OPEN_STATUSES }) : [],
      orderIds.length ? repo.find('shipments', { order_id: orderIds, kind: ['outbound', 'replacement'], status: { op: '<>', value: 'cancelled' } }) : [],
      this.core.sellerNames(rows.map((r) => r.seller_id)),
    ]);
    const counts = new Map<string, number>();
    for (const s of inOrders) counts.set(s.order_id, (counts.get(s.order_id) ?? 0) + 1);
    const labelBy = new Map<string, LabelRec>();
    for (const l of labels) if (l.shipment_id && (!labelBy.has(l.shipment_id) || l.status !== 'voided')) labelBy.set(l.shipment_id, l);
    return {
      lines: group(lines, (l) => l.shipment_id),
      events: group(events, (e) => e.shipment_id),
      corrections: group(corrections, (c) => c.shipment_id),
      labels: labelBy,
      openExceptions: group(exceptions, (e) => e.shipment_id!),
      packagesInOrder: counts,
      names,
    };
  }

  packageLabel(s: ShipmentRec, parts: ShipmentParts) {
    if (s.kind === 'return') return 'Return parcel';
    const total = Math.max(parts.packagesInOrder.get(s.order_id) ?? 1, s.package_no);
    // "Shipment x of y": shipments of the order (orders' "Package x of y" is the seller group, decision G26d)
    return `Shipment ${s.package_no} of ${total}`;
  }

  contents(lines: readonly LineRec[]) {
    return lines.map((l) => ({ orderItemId: l.order_item_id, title: l.title, variantLabel: l.variant_label, quantity: l.quantity }));
  }

  event(e: EventRec): TrackingEvent {
    return { at: e.at.toISOString(), code: e.code as TrackingEvent['code'], label: e.label, detail: e.detail, location: e.location, source: e.source as TrackingEvent['source'] };
  }

  summary(s: ShipmentRec, parts: ShipmentParts): ShipmentSummary {
    const lines = parts.lines.get(s.id) ?? [];
    return {
      id: s.id,
      kind: s.kind as ShipmentSummary['kind'],
      orderId: s.order_id,
      orderRef: s.order_ref,
      groupId: s.group_id,
      packageLabel: this.packageLabel(s, parts),
      sellerName: this.core.nameOf(parts.names, s.owner_type, s.seller_id),
      carrierName: carrierNameOf(s.carrier_code),
      trackingNumber: s.tracking_number,
      status: s.status,
      statusLabel: statusLabel(s.status, s.tracking_state, s.kind),
      estimatedArrival: s.estimated_arrival,
      shippedAt: iso(s.shipped_at),
      deliveredAt: iso(s.delivered_at),
      itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    };
  }

  async label(l: LabelRec, principal?: Principal | null): Promise<Label> {
    const meta = await labelCarrier(this.core, l);
    const fallback = `${this.core.ctx.config.publicUrls.seller.replace(/\/$/, '')}/shipping/labels/${l.id}.pdf`;
    const asset = l.storage_key;
    const link = asset ? await this.core.soft('media', 'label link', (m) => m.signedDownload(asset, principal ?? { kind: 'staff', accountId: null }, 'Shipping label')) : undefined;
    return {
      id: l.id,
      shipmentId: l.shipment_id,
      groupId: l.group_id,
      carrierServiceId: l.carrier_service_id,
      carrierName: meta.carrierName,
      serviceName: meta.serviceName,
      cost: money(l.cost, l.currency),
      trackingNumber: l.tracking_number,
      labelUrl: link?.url ?? fallback,
      qrCodeUrl: l.qr_code ? `${this.core.ctx.config.publicUrls.store.replace(/\/$/, '')}/returns/drop-off/${encodeURIComponent(l.qr_code)}` : null,
      dropOffCode: l.qr_code ?? null,
      dropOffBy: iso(l.drop_off_by),
      format: l.format as Label['format'],
      status: l.status as Label['status'],
      purchasedBy: l.purchased_by,
      purchasedAt: l.purchased_at.toISOString(),
      voidedAt: iso(l.voided_at),
    };
  }

  async shipment(s: ShipmentRec, parts: ShipmentParts, principal?: Principal | null): Promise<Shipment> {
    const label = parts.labels.get(s.id);
    return {
      id: s.id,
      kind: s.kind as Shipment['kind'],
      orderId: s.order_id,
      orderRef: s.order_ref,
      groupId: s.group_id,
      returnId: s.return_id,
      ownerType: s.owner_type as Shipment['ownerType'],
      sellerId: s.seller_id,
      sellerName: this.core.nameOf(parts.names, s.owner_type, s.seller_id),
      packageLabel: this.packageLabel(s, parts),
      carrierCode: s.carrier_code,
      carrierName: carrierNameOf(s.carrier_code),
      serviceName: s.service_name,
      trackingNumber: s.tracking_number,
      trackingUrl: trackingUrlOf(s.carrier_code, s.tracking_number),
      trackingState: s.tracking_state as Shipment['trackingState'],
      status: s.status as Shipment['status'],
      statusLabel: statusLabel(s.status, s.tracking_state, s.kind),
      contents: this.contents(parts.lines.get(s.id) ?? []),
      shipFrom: s.ship_from,
      label: label ? await this.label(label, principal) : null,
      shippedAt: iso(s.shipped_at),
      dispatchedOnTime: s.dispatched_on_time,
      estimatedArrival: s.estimated_arrival,
      deliveredAt: iso(s.delivered_at),
      failedDelivery: s.failed_delivery,
      events: (parts.events.get(s.id) ?? []).map((e) => this.event(e)),
      corrections: (parts.corrections.get(s.id) ?? []).map((c) => ({ at: c.at.toISOString(), from: c.from_value, to: c.to_value, reason: c.reason, by: c.by, customerNotified: c.customer_notified })),
      openExceptionIds: (parts.openExceptions.get(s.id) ?? []).map((e) => e.id),
      recordedBy: s.recorded_by,
      createdAt: s.created_at.toISOString(),
    };
  }

  async shipments(rows: readonly ShipmentRec[], principal?: Principal | null): Promise<Shipment[]> {
    const parts = await this.parts(rows);
    return Promise.all(rows.map((r) => this.shipment(r, parts, principal)));
  }

  async summaries(rows: readonly ShipmentRec[]): Promise<ShipmentSummary[]> {
    const parts = await this.parts(rows);
    return rows.map((r) => this.summary(r, parts));
  }

  /* ---------------------------------------------------------------- exceptions */

  async exceptions(rows: readonly ExceptionRec[]): Promise<DeliveryException[]> {
    if (!rows.length) return [];
    const [logs, names] = await Promise.all([
      this.core.repo.find('exception_log', { exception_id: rows.map((r) => r.id) }, { orderBy: [['at', 'asc'], ['id', 'asc']] }),
      this.core.sellerNames(rows.map((r) => r.seller_id)),
    ]);
    const byEx = group(logs, (l) => l.exception_id);
    const now = this.core.now();
    return rows.map((e) => this.exception(e, byEx.get(e.id) ?? [], names, now));
  }

  exception(e: ExceptionRec, logs: readonly ExceptionLogRec[], names: Map<string, string>, now: Date): DeliveryException {
    const kind = e.kind as ExceptionKind;
    const open = OPEN_STATUSES.includes(e.status);
    return {
      id: e.id,
      kind,
      orderId: e.order_id,
      orderRef: e.order_ref,
      groupId: e.group_id,
      shipmentId: e.shipment_id,
      ownerType: e.owner_type as DeliveryException['ownerType'],
      sellerId: e.seller_id,
      sellerName: this.core.nameOf(names, e.owner_type, e.seller_id),
      itemsSummary: e.items_summary,
      orderItemIds: e.order_item_ids ?? [],
      items: (e.order_item_ids ?? []).map((id) => ({ orderItemId: id, quantity: ((e.item_quantities as { order_item_id: string; quantity: number }[] | null) ?? []).find((q) => q.order_item_id === id)?.quantity ?? null })),
      situation: e.situation,
      requiredResponse: (e.fulfilled_by === 'marketly_service' ? MARKETLY_REQUIRED_RESPONSE[kind] : undefined) ?? REQUIRED_RESPONSE[kind] ?? '',
      nextStep: e.next_step,
      customerNotifiedAt: iso(e.customer_notified_at),
      sellerNotifiedAt: iso(e.seller_notified_at),
      owner: e.owner_staff_id || e.owner_name ? { staffId: e.owner_staff_id, name: e.owner_name ?? 'Staff member', role: e.owner_role } : null,
      deadline: { dueAt: e.due_at.toISOString(), state: open ? deadlineState(e.due_at, now) : 'on_time' },
      deadlineLabel: open ? deadlineLabel(e.due_at, now, this.core.tz) : e.status === 'resolved' ? 'Resolved' : 'Closed',
      status: e.status as DeliveryException['status'],
      escalatedTo: e.escalated_to as DeliveryException['escalatedTo'],
      sellerResponse: e.seller_response,
      resolution: e.resolution,
      claimId: e.claim_id,
      caseRef: e.case_ref,
      history: logs.map((l) => ({ at: l.at.toISOString(), label: logLabel(l.action, kind), detail: l.detail, actor: l.actor })),
      openedBy: e.opened_by,
      openedAt: e.opened_at.toISOString(),
    };
  }

  /* ---------------------------------------------------------------- claims */

  async claims(rows: readonly ClaimRec[]): Promise<CarrierClaim[]> {
    if (!rows.length) return [];
    const [carriers, shipments, evidence] = await Promise.all([
      this.core.repo.find('carriers', {}),
      this.core.repo.find('shipments', { id: [...new Set(rows.map((r) => r.shipment_id))] }),
      this.core.soft('media', 'claim evidence', (m) => m.refs([...new Set(rows.flatMap((r) => r.evidence_ids))])),
    ]);
    const refs = new Map((evidence ?? []).map((r) => [r.id, r]));
    const out: CarrierClaim[] = [];
    for (const c of rows) {
      const approval = c.approval_request_id ? ((await this.core.soft('access', 'approval info', (a) => a.approvalInfo(c.approval_request_id!))) ?? { required: true, reason: 'Finance approval requested', approvalRequestId: c.approval_request_id, approvers: ['Finance Manager'] }) : null;
      out.push({
        id: c.id,
        claimNumber: c.claim_number,
        carrierCode: c.carrier_code,
        carrierName: carrierNameOf(c.carrier_code, carriers) ?? c.carrier_code,
        orderId: c.order_id,
        orderRef: shipments.find((s) => s.id === c.shipment_id)?.order_ref ?? '',
        shipmentId: c.shipment_id,
        exceptionId: c.exception_id,
        amount: money(c.amount, c.currency),
        filedBy: c.filed_by as CarrierClaim['filedBy'],
        sellerId: c.seller_id,
        filedAt: c.filed_at,
        status: c.status as CarrierClaim['status'],
        owner: c.owner,
        evidence: c.evidence_ids.map((id) => refs.get(id)).filter((r): r is common.MediaRef => Boolean(r)),
        approval,
        paidAmount: c.paid_amount != null ? money(c.paid_amount, c.currency) : null,
        decidedAt: iso(c.decided_at),
        note: c.note,
      });
    }
    return out;
  }

  estimateLabel = (r: common.DateRange | null | undefined) => (r ? rangeLabel(r) : null);
}

const ACTION_LABEL: Record<string, string> = {
  opened: 'Exception opened',
  assigned: 'Owner assigned',
  seller_notified: 'Seller reminded',
  customer_notified: 'Customer updated',
  tracking_requested: 'Tracking requested from the seller',
  escalated: 'Escalated',
  resolved: 'Resolved',
  closed: 'Closed automatically',
  deadline_moved: 'Deadline moved',
  claim_filed: 'Carrier claim filed',
  marked_for_escalation: 'Seller restricted: marked for escalation',
  missed_deadline: 'Seller missed another deadline',
};

function logLabel(action: string, kind: ExceptionKind): string {
  if (action.startsWith('seller_responded:')) return RESPONSE_LABEL[action.slice('seller_responded:'.length)] ?? 'Seller replied';
  if (action.startsWith('escalated:')) return `Escalated to ${ESCALATION_LABEL[action.slice('escalated:'.length)] ?? 'a team'}`;
  if (action.startsWith('resolved:')) return `Resolved: ${RESOLUTION_LABEL[action.slice('resolved:'.length)] ?? 'outcome recorded'}`;
  if (action === 'opened') return `${KIND_LABEL[kind] ?? 'Exception'} opened`;
  return ACTION_LABEL[action] ?? action.replace(/_/g, ' ');
}
