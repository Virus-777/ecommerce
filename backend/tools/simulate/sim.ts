/**
 * What every flow shares: the server, the HTTP client, the people helpers, a seeded random source, the run id
 * and the world the flows build up (staff, sellers, products, orders …). Flows read what earlier flows made from
 * `sim.world`.
 */
import { deflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { devClaims } from '../../src/kernel/auth/dev.js';
import { signAccessToken } from '../../src/kernel/auth/tokens.js';
import { FIRST_NAMES, LAST_NAMES, PORTLAND_ADDRESSES, UNITS } from './data.js';
import type { Client, Session } from './http.js';
import type { People, Person, Staff } from './people.js';
import type { Runner } from './runner.js';

export type Scale = 'small' | 'medium';

/** Mulberry32: a small seeded generator, so `--seed` repeats the same choices */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SellerWorld {
  name: string;
  code: string;
  owner: Person;
  ownerCustomer: Session;
  sellerId: string;
  session: Session;
  shippingProfileId: string;
  categoryIds: string[];
  offers: OfferWorld[];
}

export interface OfferWorld {
  offerId: string;
  productId: string;
  variantId: string;
  title: string;
  price: number;
  /** null for the Official Store */
  sellerId: string | null;
  sellerName: string;
  stockItemId?: string;
  sku: string;
}

export interface CustomerWorld {
  person: Person;
  session: Session;
  accountId: string;
  address: Record<string, string>;
  addressId?: string;
}

export interface OrderWorld {
  orderId: string;
  ref: string;
  customer: CustomerWorld | null;
  /** Guest checkout: the email and visitor session */
  guest?: { email: string; session: Session };
  total: number;
  groups: { id: string; sellerId: string | null; fulfilledBy: string; items: { id: string; offerId: string; quantity: number; unitPrice: number }[] }[];
  tracking: string[];
  delivered: boolean;
  /**
   * Kept back by the fulfilment flow: 'cancel' (the customer cancels before it ships), 'open' (not shipped yet, so
   * its stock stays allocated), 'in_transit' (shipped, not delivered yet)
   */
  keep?: 'cancel' | 'open' | 'in_transit';
  /** What later flows did with it */
  cancelled?: boolean;
  returned?: boolean;
}

export interface World {
  owner?: Staff;
  deputy?: Staff;
  staff: Partial<Record<'seller' | 'catalog' | 'orders' | 'finance' | 'financeStaff' | 'support' | 'marketing' | 'marketingReviewer' | 'operations' | 'trust', Staff>>;
  categories: Map<string, string>;
  brands: Map<string, string>;
  sellers: SellerWorld[];
  official: OfferWorld[];
  locationId?: string;
  couponCode?: string;
  campaignId?: string;
  customers: CustomerWorld[];
  orders: OrderWorld[];
  /** The balances each seller saw in Seller Center (finance flow), compared with the ledger by the checks */
  balances: Map<string, { pending: number; available: number; held: number }>;
}

export class Sim {
  readonly random: () => number;
  readonly world: World = { staff: {}, categories: new Map(), brands: new Map(), sellers: [], official: [], customers: [], orders: [], balances: new Map() };
  /** When the run started (the checks look at audit entries since then) */
  readonly startedAt = new Date();
  #seq = 0;

  constructor(
    readonly app: FastifyInstance,
    readonly api: Client,
    readonly people: People,
    readonly run: Runner,
    readonly runId: string,
    readonly scale: Scale,
    seed: number,
    /** Secrets the providers sign their webhooks with (development: the dev secret) */
    readonly webhookSecret: (provider: string) => string,
  ) {
    this.random = rng(seed);
  }

  /** How many of something to make: small, or about 4× for medium */
  n(small: number): number {
    return this.scale === 'medium' ? small * 4 : small;
  }

  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.random() * list.length)]!;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  /** A number unique within the run (SKUs, tracking numbers) */
  seq(): number {
    return ++this.#seq;
  }

  /** A person with a run-tagged email, so a second run never meets the first run's accounts */
  person(domain = 'example.com', first = this.pick(FIRST_NAMES), last = this.pick(LAST_NAMES)): Person {
    const tag = `${first}.${last}.${this.runId}${this.seq()}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
    return {
      firstName: first,
      lastName: last,
      email: `${tag}@${domain}`,
      // the password policy refuses names and emails in passwords (personal_info)
      password: `Willamette-River-${this.int(1000, 9999)}-Ferry!`,
      phone: this.phone(),
    };
  }

  /** A Portland phone number in the 555-01xx range set aside for fiction */
  phone(): string {
    return `+1${this.pick(['503', '971'])}55501${String(this.int(0, 99)).padStart(2, '0')}`;
  }

  /** A Portland-area delivery address */
  address(name: string, phone: string): Record<string, string> {
    const a = this.pick(PORTLAND_ADDRESSES);
    const unit: Record<string, string> = this.random() < 0.3 ? { line2: this.pick(UNITS) } : {};
    return { name, line1: a.line1, ...unit, city: a.city, region: 'OR', postalCode: a.postalCode, country: 'US', phone };
  }

  /** A GTIN-13 with a correct check digit, unique per run (GS1 prefix 08: a US company prefix range) */
  gtin(): string {
    const runDigits = String(parseInt(this.runId, 36) % 100000).padStart(5, '0');
    const body = `08${runDigits}${String(this.seq() % 100000).padStart(5, '0')}`;
    const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
    return body + String((10 - (sum % 10)) % 10);
  }

  /** A UPS tracking number (1Z + 16 letters or digits), unique per run */
  tracking(): string {
    return `1Z${this.runId.toUpperCase().padEnd(6, 'X').slice(0, 6)}${String(Date.now() % 1e6).padStart(6, '0')}${String(this.seq()).padStart(4, '0')}`;
  }

  /**
   * A real PNG (signature, IHDR, zlib-compressed IDAT, IEND, with CRCs): a product photo stand-in of the given size
   * in one colour with a darker band, small enough to upload quickly.
   */
  png(width: number, height: number, rgb: [number, number, number]): Buffer {
    // one scanline per shade (filter byte 0, then RGB per pixel); the image repeats them
    const line = (shade: number) => {
      const row = Buffer.alloc(1 + width * 3);
      for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(rgb[c]! * shade);
      return row;
    };
    const plain = line(1);
    const band = line(0.7);
    const rows = Array.from({ length: height }, (_, y) => (y > height * 0.4 && y < height * 0.6 ? band : plain));
    const u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n >>> 0);
      return b;
    };
    const chunk = (type: string, data: Buffer) => {
      const t = Buffer.from(type, 'latin1');
      return Buffer.concat([u32(data.length), t, data, u32(crc32(Buffer.concat([t, data])))]);
    };
    const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  }

  /** A one-page PDF (seller verification documents) */
  pdf(title: string): Buffer {
    return Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n% ${title}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
  }

  /**
   * The client's side of an upload, as the apps do it: ask for an upload ticket, PUT the bytes to the signed
   * storage URL it names (with development storage that is this API), then complete. The processing job runs
   * now (the development server runs no scheduled jobs). Returns the media asset id.
   */
  async upload(s: Session, area: 'store' | 'seller' | 'admin', file: { purpose: string; fileName: string; contentType: string; body: Buffer }): Promise<string> {
    const request = { purpose: file.purpose, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.body.length };
    // staff upload company files (Official Store images) as the platform's, not their own
    const start = await this.api.call(s, 'POST', `/api/${area}/media/uploads`, area === 'admin' ? { upload: request, ownerKind: 'platform' } : request);
    const ticket = new URL(start.url);
    await this.api.call(s, 'PUT', ticket.pathname + ticket.search, undefined, { raw: { bytes: file.body, contentType: start.headers?.['content-type'] ?? file.contentType }, headers: start.headers ?? {} });
    await this.api.call(s, 'POST', `/api/${area}/media/uploads/${start.uploadId}/complete`);
    await this.app.kernel.jobs.runNow('media.process');
    await this.app.kernel.events.drain();
    return start.assetId as string;
  }

  /** Where a development token was used instead of a real sign-in, and why (listed in the report) */
  readonly devTokenPlaces: string[] = [];

  /**
   * A development token (DEV_TOKENS, development only), for the rare step with no real path. Records the place for
   * the report.
   */
  devToken(kind: 'staff', why: string): { app: 'admin'; client: 'web'; label: string; accessToken: string } {
    const signer = this.app.kernel.devSigner;
    if (!this.app.kernel.config.devTokens || !signer) this.run.fail({ step: 'development token', message: `DEV_TOKENS is off; cannot ${why}` });
    this.devTokenPlaces.push(`${this.run.current.name}: ${kind} dev token to ${why}`);
    const accessToken = signAccessToken(signer, devClaims(kind), { issuer: this.app.kernel.config.auth.issuer, ttlSeconds: 600 });
    return { app: 'admin', client: 'web', label: `dev ${kind} token`, accessToken };
  }

  /** Runs a scheduled job now and waits for its events (JOBS_ENABLED is false on development servers) */
  async job(name: string): Promise<void> {
    // what earlier requests set off must be processed first (an offer going live queues its product for search)
    await this.app.kernel.events.drain();
    await this.app.kernel.jobs.runNow(name);
    await this.app.kernel.events.drain();
  }
}

/** CRC-32 of PNG chunks */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
