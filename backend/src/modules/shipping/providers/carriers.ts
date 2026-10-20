/**
 * Deterministic carrier adapter for development and tests: no network.
 *   Rates: base price per speed class plus weight; Alaska/Hawaii/territory ZIPs cost more.
 *   Labels: tracking numbers in each carrier's format, derived from the reference; a 4×6 PDF.
 *     Parcels whose weight ends in 13 g are refused (simulates a carrier error); over 68 kg is refused.
 *   Tracking polls: an 'accepted' scan one hour after the ship time.
 *   Webhooks: aggregator JSON { events: [{ id, trackingNumber, code|status, at, description, location }] } or one event.
 */
import { createHash } from 'node:crypto';
import { money } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import { renderPdf } from '../../../kernel/lib/pdf.js';
import { CarrierRefused, CarrierUnreachable, type CarrierPort, type CarrierScan } from '../ports.js';

const BASE: Record<string, number> = { ground: 795, two_day: 1495, overnight: 2995, freight: 8900 };
const PER_KG: Record<string, number> = { ground: 90, two_day: 180, overnight: 350, freight: 60 };

const digits = (seed: string, n: number) => {
  let out = '';
  let i = 0;
  while (out.length < n) out += BigInt(`0x${createHash('sha256').update(`${seed}:${i++}`).digest('hex')}`).toString().slice(0, 30);
  return out.slice(0, n);
};
const alnum = (seed: string, n: number) => {
  const abc = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';
  const h = createHash('sha256').update(seed).digest();
  return Array.from({ length: n }, (_, i) => abc[h[i % h.length]! % abc.length]).join('');
};

export function devTrackingNumber(carrierCode: string, seed: string): string {
  switch (carrierCode) {
    case 'ups':
      return `1Z${alnum(seed, 6)}${digits(seed, 10)}`;
    case 'usps':
      return `9400${digits(seed, 18)}`;
    case 'fedex':
      return digits(seed, 12).replace(/^0/, '7');
    case 'ontrac':
      return `C${digits(seed, 14)}`;
    default:
      return `MK${digits(seed, 12)}`;
  }
}

const remote = (zip: string) => /^(99[5-9]|96[7-9]|00[6-9])/.test(zip);

export function devCarrierAdapter(): CarrierPort {
  return {
    async rate(input) {
      const kg = Math.max(1, Math.ceil((input.parcel.weightGrams || 1000) / 1000));
      if (input.parcel.weightGrams > 68_000) throw new CarrierRefused('The parcel is over the carrier weight limit (68 kg)');
      const amount = (BASE[input.speed] ?? BASE.ground!) + (kg - 1) * (PER_KG[input.speed] ?? 90) + (remote(input.toPostalCode) ? 1200 : 0);
      return money(amount, input.currency);
    },

    async buyLabel(input) {
      // test hooks: a weight ending in 13 g is a carrier that does not answer, 14 g one that refuses the address
      if (input.parcel.weightGrams % 1000 === 13) throw new CarrierUnreachable(`${input.carrierName} did not answer the label request`);
      if (input.parcel.weightGrams % 1000 === 14) throw new CarrierRefused(`${input.carrierName} could not validate the delivery address`);
      if (input.parcel.weightGrams > 68_000) throw new CarrierRefused('The parcel is over the carrier weight limit (68 kg)');
      const trackingNumber = devTrackingNumber(input.carrierCode, input.reference);
      const to = input.to;
      const from = input.from;
      const pdf = renderPdf([[
        { text: input.serviceName.toUpperCase(), size: 16, bold: true },
        { text: `TRACKING #: ${trackingNumber}`, size: 11, bold: true },
        { text: 'SHIP FROM', size: 8, bold: true },
        ...(from ? [{ text: [from.name, from.line1].filter(Boolean).join(', ') }, { text: [from.city, from.region, from.postalCode].filter(Boolean).join(' ') }] : [{ text: 'Sender on file' }]),
        { text: 'SHIP TO', size: 8, bold: true },
        { text: [to.name, to.line1].filter(Boolean).join(', ') || 'Recipient' },
        { text: [to.city, to.region, to.postalCode].filter(Boolean).join(' ') },
        { text: `Weight: ${(input.parcel.weightGrams / 1000).toFixed(2)} kg   Ref: ${input.reference}`, size: 8 },
        { text: 'DEVELOPMENT LABEL - NOT VALID FOR SHIPPING', size: 8 },
      ]], { page: 'label' });
      const qrCode = input.qr ? `QR-${alnum(`${input.reference}:qr`, 12)}` : null;
      if (input.format === 'zpl') {
        // thermal printers: a minimal ZPL label with the same facts
        const zpl = `^XA^CF0,40^FO40,40^FD${input.serviceName.toUpperCase()}^FS^CF0,30^FO40,100^FDTRACKING # ${trackingNumber}^FS^FO40,150^FDREF ${input.reference}^FS^FO40,200^FDDEVELOPMENT LABEL^FS^XZ`;
        return { trackingNumber, pdf: new TextEncoder().encode(zpl), qrCode };
      }
      return { trackingNumber, pdf, qrCode };
    },

    async voidLabel() {
      return { refunded: true };
    },

    async track(input) {
      if (!input.shippedAt) return [];
      const at = new Date(input.shippedAt.getTime() + 3_600_000);
      if (at.getTime() > input.now.getTime()) return [];
      return [{ id: `${input.trackingNumber}:accepted`, trackingNumber: input.trackingNumber, code: 'accepted', at: at.toISOString(), description: `Picked up by ${input.carrierCode.toUpperCase()}`, location: null }];
    },

    async dropOffPoints(input) {
      const zip = input.postalCode.slice(0, 5) || '00000';
      const kinds = ['Store', 'Access Point', 'Drop Box', 'Center', 'Locker'];
      return Array.from({ length: Math.max(0, Math.min(input.limit, 5)) }, (_, i) => ({
        name: `${input.carrierName} ${kinds[i]} #${100 + i}`,
        address: { name: `${input.carrierName} ${kinds[i]}`, line1: `${120 + i * 37} Main St`, city: 'Nearby', region: '', postalCode: zip, country: 'US' } as common.Address,
        hours: i === 2 ? 'Daily, last pickup 5:00 PM' : 'Mon–Fri 8:00 AM–7:00 PM, Sat 9:00 AM–3:00 PM',
        distanceMiles: Math.round((0.6 + i * 1.3) * 10) / 10,
        acceptsQr: input.qr ? i !== 2 : i % 2 === 0,
      }));
    },

    parseWebhook(carrierCode, body, headerEventId) {
      const b = (body ?? {}) as Record<string, unknown>;
      const list = Array.isArray(b.events) ? (b.events as Record<string, unknown>[]) : Array.isArray(body) ? (body as Record<string, unknown>[]) : [b];
      const out: CarrierScan[] = [];
      list.forEach((e, i) => {
        const trackingNumber = String(e.trackingNumber ?? e.tracking_number ?? e.tracking ?? '').trim();
        if (!trackingNumber) return;
        const id = String(e.id ?? e.eventId ?? (headerEventId ? `${headerEventId}:${i}` : `${carrierCode}:${trackingNumber}:${e.at ?? e.time ?? i}:${e.code ?? e.status ?? ''}`));
        const at = new Date(String(e.at ?? e.time ?? e.occurredAt ?? ''));
        out.push({
          id,
          trackingNumber,
          code: String(e.code ?? e.status ?? 'info'),
          at: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
          description: typeof e.description === 'string' ? e.description : typeof e.detail === 'string' ? e.detail : null,
          location: typeof e.location === 'string' ? e.location : null,
        });
      });
      return out;
    },
  };
}
