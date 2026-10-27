/**
 * Carriers a seller ships with itself — its own van, a local courier — that Marketly has no account with.
 *
 * They sit in their own collection rather than as seller rows in `carriers`: that table is read from two dozen
 * places (staff lists, the storefront shipping section, estimates, label quotes, polling), and a seller's
 * private courier must not be able to surface in any of them. The price is the three joins below, which are
 * explicit and easy to audit; the alternative was a scope check at every one of those reads.
 *
 * Tracking is manual by definition: no feed exists for a carrier Marketly has no integration with, so a number
 * is only checked against the seller's own pattern (when it gives one) and never advanced by a carrier scan.
 */
import { randomBytes } from 'node:crypto';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { Carrier, SellerCarrier, SellerCarrierInput } from '../../../spec/shipping.js';
import type { SellerCarrierRec } from '../ports.js';
import { invalid, notFound, type Core } from './core.js';

type Issue = { path: string; message: string };

/** Codes of a seller's own carriers start with this, which keeps them apart from the platform's (ups, usps …). */
export const OWN_CARRIER_PREFIX = 'own-';

export const isOwnCarrierCode = (code: string | null | undefined): boolean => Boolean(code?.startsWith(OWN_CARRIER_PREFIX));

const NAME_MAX = 60;
const TEMPLATE_MAX = 300;

/** The tracking page for one number, or null when the seller gave no template. */
export function ownTrackingUrl(rec: Pick<SellerCarrierRec, 'tracking_url_template'>, trackingNumber: string | null | undefined): string | null {
  const template = rec.tracking_url_template?.trim();
  if (!template || !trackingNumber) return null;
  return template.replace('{n}', encodeURIComponent(trackingNumber));
}

/**
 * A seller's own carrier as the record-shipment form reads any carrier. It carries one service of its own name,
 * so the form's service list has nothing to choose and the app shows just the carrier.
 */
export function ownCarrierAsCarrier(rec: SellerCarrierRec): Carrier {
  return {
    id: rec.id,
    code: rec.code,
    name: rec.name,
    accountLabel: 'Your own carrier',
    status: 'active',
    trackingMode: 'manual',
    trackingConnected: false,
    lastEventAt: null,
    onTimeRate30d: null,
    services: [
      {
        id: rec.id,
        carrierId: rec.id,
        code: 'own',
        name: rec.name,
        transit: { min: 1, max: 7 },
        enabled: true,
        labelSupported: false,
        trackingPattern: rec.tracking_pattern?.trim() || null,
      },
    ],
    contacts: [],
  };
}

const view = (rec: SellerCarrierRec): SellerCarrier => ({
  id: rec.id,
  code: rec.code,
  name: rec.name,
  trackingUrlTemplate: rec.tracking_url_template,
  trackingPattern: rec.tracking_pattern,
  createdAt: rec.created_at.toISOString(),
  updatedAt: rec.updated_at.toISOString(),
});

/** Checks a name and the two optional fields, and hands back the trimmed values. */
function clean(body: SellerCarrierInput): { name: string; template: string | null; pattern: string | null } {
  const issues: Issue[] = [];
  const name = body.name?.trim() ?? '';
  if (!name) issues.push({ path: 'name', message: 'Name the carrier, e.g. Speedy Local Courier' });
  else if (name.length > NAME_MAX) issues.push({ path: 'name', message: `Keep the name under ${NAME_MAX} characters` });

  const template = body.trackingUrlTemplate?.trim() || null;
  if (template) {
    if (template.length > TEMPLATE_MAX) issues.push({ path: 'trackingUrlTemplate', message: `Keep the link under ${TEMPLATE_MAX} characters` });
    else if (!/^https:\/\//i.test(template)) issues.push({ path: 'trackingUrlTemplate', message: 'The tracking link must start with https://' });
    else if (!template.includes('{n}')) issues.push({ path: 'trackingUrlTemplate', message: 'Put {n} where the tracking number goes, e.g. https://courier.example/track/{n}' });
  }

  const pattern = body.trackingPattern?.trim() || null;
  if (pattern) {
    // The pattern is run against every number the seller enters, so a broken or catastrophic one is refused here
    // rather than at save time on an order.
    if (pattern.length > 120) issues.push({ path: 'trackingPattern', message: 'Keep the pattern under 120 characters' });
    else {
      try {
        new RegExp(pattern);
      } catch {
        issues.push({ path: 'trackingPattern', message: 'That is not a valid pattern. Leave it empty to accept any number.' });
      }
    }
  }
  if (issues.length) throw invalid(issues);
  return { name, template, pattern };
}

export class OwnCarriers {
  constructor(private readonly core: Core) {}

  private get repo() {
    return this.core.repo;
  }

  /** The seller's own carriers, oldest first, for the settings screen and the three join points. */
  async list(sellerId: string): Promise<SellerCarrier[]> {
    const rows = await this.recordsOf(sellerId);
    return rows.map(view);
  }

  /** The seller's own carriers as the carrier list and the record-shipment form read any carrier. */
  async carriers(sellerId: string): Promise<Carrier[]> {
    const rows = await this.recordsOf(sellerId);
    return rows.map(ownCarrierAsCarrier);
  }

  /** The raw rows; the shipment and setup paths need the template and pattern, not the view. */
  recordsOf(sellerId: string): Promise<SellerCarrierRec[]> {
    return this.repo.find('seller_carriers', { seller_id: sellerId }, { orderBy: [['created_at', 'asc']] });
  }

  /** One of this seller's own carriers by code, or undefined when the code is not theirs. */
  async byCode(sellerId: string | null | undefined, code: string): Promise<SellerCarrierRec | undefined> {
    if (!sellerId || !isOwnCarrierCode(code)) return undefined;
    const rows = await this.repo.find('seller_carriers', { seller_id: sellerId, code: code.trim().toLowerCase() }, { limit: 1 });
    return rows[0];
  }

  /** The carrier of a shipment already recorded, for views; looked up by code alone, without a seller. */
  async byCodeAnySeller(code: string | null | undefined): Promise<SellerCarrierRec | undefined> {
    if (!code || !isOwnCarrierCode(code)) return undefined;
    const rows = await this.repo.find('seller_carriers', { code: code.trim().toLowerCase() }, { limit: 1 });
    return rows[0];
  }

  async add(sellerId: string, body: SellerCarrierInput): Promise<SellerCarrier> {
    const { name, template, pattern } = clean(body);
    await this.assertNameFree(sellerId, name, null);
    const now = this.core.now();
    const row = await this.repo.insert('seller_carriers', {
      id: newId(),
      seller_id: sellerId,
      code: await this.freeCode(),
      name,
      tracking_url_template: template,
      tracking_pattern: pattern,
      created_at: now,
      updated_at: now,
    });
    return view(row);
  }

  async update(sellerId: string, id: string, body: SellerCarrierInput): Promise<SellerCarrier> {
    const row = await this.mine(sellerId, id);
    const { name, template, pattern } = clean(body);
    await this.assertNameFree(sellerId, name, id);
    const saved = await this.repo.update('seller_carriers', row.id, {
      name,
      tracking_url_template: template,
      tracking_pattern: pattern,
      updated_at: this.core.now(),
    });
    return view(saved);
  }

  /**
   * Takes the carrier off the list. Packages already sent with it keep the name and tracking link copied onto
   * the shipment when it was recorded, so removing one never rewrites history.
   */
  async remove(sellerId: string, id: string): Promise<void> {
    const row = await this.mine(sellerId, id);
    await this.repo.removeWhere('seller_carriers', { id: row.id });
  }

  private async mine(sellerId: string, id: string): Promise<SellerCarrierRec> {
    const row = await this.repo.get('seller_carriers', id);
    if (!row || row.seller_id !== sellerId) throw notFound('Carrier');
    return row;
  }

  /** Two carriers with the same name would be indistinguishable in the ship form. */
  private async assertNameFree(sellerId: string, name: string, exceptId: string | null): Promise<void> {
    const rows = await this.recordsOf(sellerId);
    if (rows.some((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError('CONFLICT', `You already have a carrier called ${name}`, { name });
    }
  }

  /**
   * A code no carrier uses: tracking numbers are de-duplicated by (carrier code, number) across the platform.
   * Random, not taken from an id: a UUIDv7 opens with the timestamp, so ids minted close together share a prefix.
   */
  private async freeCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = `${OWN_CARRIER_PREFIX}${randomBytes(5).toString('hex')}`;
      const [mine, platform] = await Promise.all([this.repo.find('seller_carriers', { code }, { limit: 1 }), this.repo.find('carriers', { code }, { limit: 1 })]);
      if (!mine.length && !platform.length) return code;
    }
    throw new AppError('CONFLICT', 'Could not allocate a carrier code; try again');
  }
}
