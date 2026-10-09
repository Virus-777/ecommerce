/**
 * Rows → API types, batched: enrollments with seller names and used capacity, SKU enrollments with the stock
 * held by Marketly per group, inbound shipments with lines, discrepancy, fees, timeline and labels, fulfillment
 * requests, service returns, removal orders, fee schedules and fee charges.
 */
import type * as common from '../../../spec/common.js';
import type { Enrollment, FeeCharge, FeeSchedule, FulfillmentRequest, InboundLine, InboundShipment, OwnedStock, RemovalOrder, ServiceReturn, SkuEnrollment } from '../../../spec/fulfillment-service.js';
import { renderPdf, type PdfLine } from '../domain/pdf.js';
import { actorOf, ageBuckets, CHARGE_LABEL, cubicFeet, EXAMPLE_SCHEDULE, onHandBlocks, physicalUnits, plural, qty, rateFor, round4 } from '../domain/rules.js';
import type { Balances, ChargeRec, EnrollmentRec, InboundLineRec, InboundRec, LedgerRec, RemovalRec, RequestRec, ScheduleRec, ServiceReturnRec, SkuRec } from '../ports.js';
import { iso, num, Part } from './core.js';

const OPEN_SKU_STATES = ['pending', 'approved', 'active'];

export class Views extends Part {
  /* ---------------------------------------------------------------- stock held by Marketly */

  /** OwnedStock per SKU enrollment from the ownership ledger */
  async stock(skus: readonly SkuRec[]): Promise<Map<string, OwnedStock>> {
    const ids = skus.map((s) => s.id);
    const [balances, inflows] = await Promise.all([this.repo.balances(ids), this.repo.inflows(ids)]);
    return this.stockFrom(skus, balances, inflows);
  }

  stockFrom(skus: readonly SkuRec[], balances: Balances, inflows: readonly LedgerRec[]): Map<string, OwnedStock> {
    const now = this.now();
    const out = new Map<string, OwnedStock>();
    for (const s of skus) {
      const onHand = physicalUnits(balances, s.id);
      const blocks = onHandBlocks(
        onHand,
        inflows.filter((f) => f.sku_enrollment_id === s.id),
      );
      out.set(s.id, {
        available: qty(balances, s.id, 'available'),
        reserved: qty(balances, s.id, 'reserved'),
        inbound: qty(balances, s.id, 'inbound'),
        receiving: qty(balances, s.id, 'receiving'),
        unsellable: qty(balances, s.id, 'unsellable'),
        returned: qty(balances, s.id, 'returned'),
        removalPending: qty(balances, s.id, 'removal_pending'),
        volumeCubicFeet: round4(onHand * cubicFeet(s.dimensions)),
        agedDays: ageBuckets(blocks, now),
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------- enrollments */

  /** Used capacity per seller: SKUs pending or enrolled and the volume of units in our warehouse */
  async usage(sellerIds: readonly string[]): Promise<Map<string, { skus: number; cubicFeet: number }>> {
    const out = new Map<string, { skus: number; cubicFeet: number }>();
    if (!sellerIds.length) return out;
    const skus = await this.repo.find('sku_enrollments', { seller_id: [...new Set(sellerIds)] });
    const balances = await this.repo.balances(skus.map((s) => s.id));
    for (const id of sellerIds) out.set(id, { skus: 0, cubicFeet: 0 });
    for (const s of skus) {
      const u = out.get(s.seller_id)!;
      if (OPEN_SKU_STATES.includes(s.state)) u.skus += 1;
      u.cubicFeet = round4(u.cubicFeet + physicalUnits(balances, s.id) * cubicFeet(s.dimensions));
    }
    return out;
  }

  async enrollments(rows: readonly EnrollmentRec[]): Promise<Enrollment[]> {
    const ids = rows.map((r) => r.seller_id);
    const [names, usage] = await Promise.all([this.core.sellerNames(ids), this.usage(ids)]);
    return rows.map((r) => ({
      id: r.id,
      sellerId: r.seller_id,
      sellerName: names.get(r.seller_id) ?? 'Seller',
      state: r.state as Enrollment['state'],
      termsVersion: r.terms_version,
      feeScheduleVersion: r.fee_schedule_version,
      acceptedAt: iso(r.accepted_at),
      acceptedBy: actorOf(r.accepted_by),
      capacity: { maxCubicFeet: num(r.max_cubic_feet), usedCubicFeet: usage.get(r.seller_id)?.cubicFeet ?? 0, maxSkus: r.max_skus, usedSkus: usage.get(r.seller_id)?.skus ?? 0 },
      reason: r.reason,
      reviewer: actorOf(r.reviewer_id),
      createdAt: r.created_at.toISOString(),
      decidedAt: iso(r.decided_at),
    }));
  }

  async enrollment(row: EnrollmentRec): Promise<Enrollment> {
    return (await this.enrollments([row]))[0]!;
  }

  /* ---------------------------------------------------------------- SKU enrollments */

  async skus(rows: readonly SkuRec[]): Promise<SkuEnrollment[]> {
    const [items, stock] = await Promise.all([this.core.stockItems(rows.map((r) => r.offer_id)), this.stock(rows)]);
    return rows.map((r) => {
      const item = items.get(r.offer_id);
      return {
        id: r.id,
        offerId: r.offer_id,
        productId: r.product_id,
        title: item?.label ?? r.sku,
        sku: r.sku,
        image: item?.image ?? null,
        dimensionsCm: r.dimensions,
        weightGrams: r.weight_grams,
        sizeTier: r.size_tier as SkuEnrollment['sizeTier'],
        barcode: r.barcode,
        labelRequired: r.label_required,
        restricted: r.restricted,
        restrictionReason: r.restriction_reason,
        state: r.state as SkuEnrollment['state'],
        stock: stock.get(r.id) ?? null,
      };
    });
  }

  async sku(row: SkuRec): Promise<SkuEnrollment> {
    return (await this.skus([row]))[0]!;
  }

  /** SKU, title and size tier of SKU enrollments for lines */
  async skuInfo(ids: readonly string[]): Promise<Map<string, { sku: string; title: string; rec: SkuRec }>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, { sku: string; title: string; rec: SkuRec }>();
    if (!unique.length) return out;
    const rows = await this.repo.find('sku_enrollments', { id: unique });
    const items = await this.core.stockItems(rows.map((r) => r.offer_id));
    for (const r of rows) out.set(r.id, { sku: r.sku, title: items.get(r.offer_id)?.label ?? r.sku, rec: r });
    return out;
  }

  /* ---------------------------------------------------------------- inbound shipments */

  lineOf(l: InboundLineRec, info: { sku: string; title: string } | undefined, complete: boolean): InboundLine {
    return {
      skuEnrollmentId: l.sku_enrollment_id,
      sku: info?.sku ?? '',
      title: info?.title ?? info?.sku ?? 'Item',
      expected: l.expected,
      received: l.received,
      damaged: l.damaged,
      missing: complete ? Math.max(0, l.expected - l.received) : 0,
      extra: Math.max(0, l.received - l.expected),
    };
  }

  async inbounds(rows: readonly InboundRec[], o: { labels?: boolean } = {}): Promise<InboundShipment[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const refs = rows.map((r) => r.ref);
    const [lines, discrepancies, charges, ledger] = await Promise.all([
      this.repo.find('inbound_lines', { inbound_id: ids }),
      this.repo.find('discrepancies', { inbound_id: ids }),
      this.repo.find('fee_charges', { reference: refs }, { orderBy: [['id', 'asc']] }),
      this.repo.find('ownership_ledger', { reference: refs, seller_id: [...new Set(rows.map((r) => r.seller_id))] }, { orderBy: [['at', 'asc']] }),
    ]);
    const info = await this.skuInfo(lines.map((l) => l.sku_enrollment_id));
    const evidence = await this.photos(discrepancies.flatMap((d) => d.evidence_media_ids));
    const out: InboundShipment[] = [];
    for (const r of rows) {
      const complete = r.state === 'received' || r.state === 'closed';
      const own = lines.filter((l) => l.inbound_id === r.id);
      const disc = discrepancies.find((d) => d.inbound_id === r.id);
      const moves = ledger.filter((m) => m.reference === r.ref && m.seller_id === r.seller_id);
      out.push({
        id: r.id,
        ref: r.ref,
        sellerId: r.seller_id,
        state: r.state as InboundShipment['state'],
        destination: r.destination,
        shipFrom: r.ship_from,
        boxes: r.boxes,
        carrier: r.carrier,
        tracking: r.tracking,
        expectedArrival: r.expected_arrival,
        arrivedAt: iso(r.arrived_at),
        receivedAt: iso(r.received_at),
        lines: own.map((l) => this.lineOf(l, info.get(l.sku_enrollment_id), complete)),
        discrepancy: disc
          ? {
              summary: disc.summary,
              evidence: disc.evidence_media_ids.map((id) => evidence.get(id)).filter((m): m is common.MediaRef => Boolean(m)),
              sellerResponse: disc.seller_response as 'pending' | 'accepted' | 'claimed',
              claimNote: disc.claim_note,
              decision: disc.decision,
              decidedBy: actorOf(disc.decided_by),
            }
          : null,
        labels: o.labels ? await this.labels(r, own, info) : [],
        fees: charges.filter((c) => c.reference === r.ref && c.seller_id === r.seller_id).map((c) => this.charge(c)),
        timeline: this.inboundTimeline(r, moves, disc),
      });
    }
    return out;
  }

  async inbound(row: InboundRec, o: { labels?: boolean } = {}): Promise<InboundShipment> {
    return (await this.inbounds([row], o))[0]!;
  }

  inboundTimeline(r: InboundRec, moves: readonly LedgerRec[], disc: { decision: string | null; decided_at: Date | null; decided_by: string | null } | undefined): common.TimelineEvent[] {
    const events: common.TimelineEvent[] = [{ at: r.created_at.toISOString(), label: 'Inbound shipment planned' }];
    const actorFor = (m: LedgerRec): common.Actor => ({ kind: m.actor_kind as common.Actor['kind'], id: m.actor_id, name: null });
    const byTime = new Map<string, LedgerRec[]>();
    for (const m of moves) {
      const k = `${m.movement}@${m.at.toISOString()}`;
      byTime.set(k, [...(byTime.get(k) ?? []), m]);
    }
    for (const group of byTime.values()) {
      const m = group[0]!;
      const units = group.reduce((n, x) => n + x.quantity, 0);
      const at = m.at.toISOString();
      if (m.movement === 'inbound_expected') events.push({ at, label: 'Submitted', detail: `${plural(units, 'unit')} expected`, actor: actorFor(m) });
      else if (m.movement === 'inbound_cancelled') events.push({ at, label: 'Cancelled', detail: m.reason, actor: actorFor(m) });
      else if (m.movement === 'arrived') events.push({ at, label: 'Arrived at the warehouse', detail: m.reason, actor: actorFor(m) });
      else if (m.movement === 'received') events.push({ at, label: 'Units received', detail: `${plural(units, 'unit')} available to sell`, actor: actorFor(m) });
      else if (m.movement === 'received_damaged') events.push({ at, label: 'Damaged units received', detail: `${plural(units, 'unit')} held as unsellable`, actor: actorFor(m) });
      else if (m.movement === 'missing') events.push({ at, label: 'Units missing', detail: `${plural(units, 'unit')} not in the shipment`, actor: actorFor(m) });
      else if (m.movement === 'adjusted') events.push({ at, label: 'Stock adjusted', detail: m.reason, actor: actorFor(m) });
    }
    if (r.arrived_at && !moves.some((m) => m.movement === 'arrived')) events.push({ at: r.arrived_at.toISOString(), label: 'Arrived at the warehouse' });
    if (r.received_at) events.push({ at: r.received_at.toISOString(), label: 'Receiving completed' });
    if (disc?.decided_at) events.push({ at: disc.decided_at.toISOString(), label: 'Discrepancy resolved', detail: disc.decision, actor: actorOf(disc.decided_by) });
    return events.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Box and unit labels to print (a PDF stored with media for an hour; media off → none) */
  async labels(r: InboundRec, lines: readonly InboundLineRec[], info: Map<string, { sku: string; title: string; rec: SkuRec }>): Promise<common.MediaRef[]> {
    if (!['submitted', 'in_transit', 'arrived', 'receiving'].includes(r.state)) return [];
    const media = this.ctx.tryUse('media');
    if (!media) return [];
    const pages: PdfLine[][] = [];
    for (let i = 1; i <= r.boxes; i++) {
      pages.push([
        { text: 'MARKETLY FULFILLMENT - INBOUND', size: 12, bold: true },
        { text: r.ref, size: 22, bold: true, gap: 6 },
        { text: `Box ${i} of ${r.boxes}`, size: 14, gap: 4 },
        { text: 'Ship to:', bold: true, gap: 10 },
        { text: r.destination.name },
        { text: r.destination.line1 },
        { text: [r.destination.city, r.destination.region, r.destination.postalCode].filter(Boolean).join(' ') },
        { text: 'From:', bold: true, gap: 10 },
        { text: r.ship_from.name },
        { text: [r.ship_from.city, r.ship_from.region].filter(Boolean).join(', ') },
      ]);
    }
    for (const l of lines) {
      const s = info.get(l.sku_enrollment_id);
      if (!s?.rec.label_required) continue;
      pages.push([
        { text: 'UNIT LABEL', size: 10, bold: true },
        { text: unitCode(s.rec), size: 20, bold: true, gap: 6 },
        { text: s.title.slice(0, 48), gap: 4 },
        { text: `SKU ${s.sku}` },
        { text: `Print ${l.expected} and stick one on each unit`, gap: 8 },
      ]);
    }
    try {
      const bytes = renderPdf(pages);
      const asset = await media.storeGeneratedFile({ owner: { kind: 'seller', id: r.seller_id }, fileName: `${r.ref}-labels.pdf`, contentType: 'application/pdf', body: new Blob([Buffer.from(bytes)]).stream(), ttlHours: 1, purpose: 'label' });
      return await media.refs([asset.id]);
    } catch (err) {
      this.ctx.log.warn({ err, inboundId: r.id }, 'fulfillment-service: labels not generated');
      return [];
    }
  }

  async photos(ids: readonly string[]): Promise<Map<string, common.MediaRef>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const refs = (await this.core.soft('media', 'evidence refs', (m) => m.refs(unique, 'small'))) ?? [];
    return new Map(refs.map((r) => [r.id, r]));
  }

  /* ---------------------------------------------------------------- fulfillment requests, returns, removals */

  request(r: RequestRec): FulfillmentRequest {
    const now = this.now().getTime();
    const due = r.dispatch_by.getTime();
    const done = r.state === 'shipped' || r.state === 'cancelled';
    const state = done || due - now > 4 * 3_600_000 ? 'on_time' : due < now ? 'overdue' : 'due_soon';
    return {
      id: r.id,
      orderId: r.order_id,
      orderRef: r.items[0]?.orderRef ?? '',
      sellerGroupId: r.seller_group_id,
      sellerId: r.seller_id,
      state: r.state as FulfillmentRequest['state'],
      items: r.items.map((i) => ({ orderItemId: i.orderItemId, offerId: i.offerId, skuEnrollmentId: i.skuEnrollmentId, sku: i.sku, title: i.title, quantity: i.quantity - i.cancelled, cancelled: i.cancelled, picked: i.picked })),
      warehouseTaskId: r.warehouse_task_id,
      shipmentId: r.shipment_id,
      dispatchBy: { dueAt: r.dispatch_by.toISOString(), state },
      createdAt: r.created_at.toISOString(),
    };
  }

  async returns(rows: readonly ServiceReturnRec[]): Promise<ServiceReturn[]> {
    // the 'returned' movement that brought the units in carries the service return's id and the return ref
    const receipts = rows.length ? await this.repo.find('ownership_ledger', { id: rows.map((r) => r.id) }) : [];
    const refs = new Map(receipts.map((m) => [m.id, m.reference ?? '']));
    const photos = await this.photos(rows.flatMap((r) => r.evidence_media_ids));
    return rows.map((r) => ({
      id: r.id,
      returnId: r.return_id,
      returnRef: refs.get(r.id) ?? '',
      sellerId: r.seller_id,
      skuEnrollmentId: r.sku_enrollment_id,
      quantity: r.quantity,
      outcome: r.outcome as ServiceReturn['outcome'],
      inspectionNote: r.inspection_note,
      evidence: r.evidence_media_ids.map((id) => photos.get(id)).filter((m): m is common.MediaRef => Boolean(m)),
      inspectedAt: iso(r.inspected_at),
    }));
  }

  async removals(rows: readonly RemovalRec[]): Promise<RemovalOrder[]> {
    const info = await this.skuInfo(rows.flatMap((r) => r.lines.map((l) => l.skuEnrollmentId)));
    const schedule = await this.core.currentSchedule();
    const charged = rows.length ? await this.repo.find('fee_charges', { reference: rows.map((r) => r.ref), type: ['removal', 'disposal'] }) : [];
    return rows.map((r) => {
      const done = r.state === 'completed';
      const fees = charged.filter((c) => c.reference === r.ref && c.seller_id === r.seller_id && c.state !== 'reversed');
      let fee: common.Money | null = null;
      if (fees.length) fee = this.core.money(fees.reduce((n, c) => n + c.amount, 0), fees[0]!.currency);
      else if (r.state !== 'cancelled') {
        // estimate from the schedule in force
        let amount = 0;
        let currency = 'USD';
        for (const l of r.lines) {
          const rate = rateFor(schedule.rates, r.kind === 'dispose' ? 'disposal_per_unit' : 'removal_per_unit', info.get(l.skuEnrollmentId)?.rec.size_tier ?? 'any');
          if (rate) {
            amount += rate.amount * l.quantity;
            currency = rate.currency;
          }
        }
        fee = amount ? this.core.money(amount, currency) : null;
      }
      return {
        id: r.id,
        ref: r.ref,
        sellerId: r.seller_id,
        kind: r.kind as RemovalOrder['kind'],
        state: r.state as RemovalOrder['state'],
        lines: r.lines.map((l) => ({
          skuEnrollmentId: l.skuEnrollmentId,
          sku: info.get(l.skuEnrollmentId)?.sku ?? '',
          title: info.get(l.skuEnrollmentId)?.title ?? 'Item',
          expected: l.quantity,
          received: done ? l.quantity : 0,
          damaged: l.fromGroup === 'unsellable' ? l.quantity : 0,
          missing: 0,
          extra: 0,
        })),
        shipTo: r.ship_to,
        tracking: r.tracking,
        fee,
        createdAt: r.created_at.toISOString(),
      };
    });
  }

  /* ---------------------------------------------------------------- fees */

  schedule(r: ScheduleRec): FeeSchedule {
    return { id: r.id, version: r.version, effectiveAt: r.effective_at.toISOString(), rates: r.rates, state: r.state as FeeSchedule['state'], isExample: r.version === EXAMPLE_SCHEDULE.version && !r.approval_request_id };
  }

  charge(c: ChargeRec): FeeCharge {
    return {
      id: c.id,
      sellerId: c.seller_id,
      type: c.type,
      period: c.period,
      reference: c.reference,
      units: num(c.units),
      rate: this.core.money(c.rate, c.currency),
      amount: this.core.money(c.amount, c.currency),
      state: c.state as FeeCharge['state'],
      postedAt: iso(c.posted_at),
      reason: c.reason,
    };
  }

  chargeLabel = (type: string) => CHARGE_LABEL[type] ?? type;
}

/** The code printed on unit labels when the seller sends no scannable barcode */
export const unitCode = (s: Pick<SkuRec, 'id' | 'barcode'>) => s.barcode ?? `MKF-${s.id.replace(/-/g, '').slice(-10).toUpperCase()}`;

