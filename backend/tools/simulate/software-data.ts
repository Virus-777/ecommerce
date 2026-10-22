/**
 * Sample apps for the app's Softwares department (software module): categories, apps with their files, the two
 * packs and the Recommended tab's first rail, from the approved design canvas (Softwares home, Apps, Deals and
 * PixelCraft Studio's detail). Written through the Admin Center API and upserted by slug (an app, category or pack
 * with the same slug is changed to these values; files already on an app are kept), so it is safe to run again.
 * Used by tools/seed-departments.ts.
 *
 * Files: every app gets a small generated icon (a two-tone 512 × 512 PNG, content_image) because publishing needs
 * one, and a package of a few KB (a real ZIP with a read-me, software_package) so downloads work in development.
 * Sizes shown in the app are the sizes of these files (media records what was uploaded), not the sizes on the
 * artboards. Screenshots are left empty. No ratings or reviews are made up.
 *
 * Licences: a paid app's devices count comes from its licence label ("One-time purchase · 2 devices" → 2; no label →
 * not limited). The Android development customer (DEV_CUSTOMER_EMAIL), when that account exists, is given PixelCraft
 * Studio by staff, so My apps and the app page show a licence key in development.
 */
import { crc32, deflateSync } from 'node:zlib';
import type { AdminCall } from './departments-data.js';

const usd = (dollars: number) => ({ amount: Math.round(dollars * 100), currency: 'USD' });
const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The customer the Android app signs in with in development: owns one paid app (a licence key to show) */
export const DEV_CUSTOMER_EMAIL = 'android.dev.0ae9fb@example.com';
/** The paid app the development customer owns */
export const DEV_OWNED_APP = 'PixelCraft Studio';

/** Devices one licence key unlocks, from the licence label; null = not limited */
export const devicesOf = (label: unknown): number | null => {
  const m = /\b(\d{1,3})\s*devices?\b/i.exec(typeof label === 'string' ? label : '');
  return m ? Number(m[1]) : null;
};

/** The sale on the Deals tab: until Oct 31, 2026, 11:59 PM Pacific */
export const SALE_ENDS_AT = '2026-11-01T06:59:00.000Z';

export const SOFTWARE_CATEGORIES = [
  { name: 'AI', icon: 'sparkles' },
  { name: 'Games', icon: 'gamepad-2' },
  { name: 'Education', icon: 'graduation-cap' },
  { name: 'Business', icon: 'briefcase' },
  { name: 'Productivity', icon: 'check-square' },
  { name: 'Security', icon: 'shield' },
  { name: 'Multimedia', icon: 'clapperboard' },
  { name: 'Developer tools', icon: 'code' },
  { name: 'Utilities', icon: 'wrench' },
  { name: 'Browsers', icon: 'globe' },
];

type Platform = 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'web';
const LABEL: Record<Platform, string> = { android: 'Android 10+', ios: 'iOS 16+', windows: 'Windows 10+', macos: 'macOS 13+', linux: 'Linux (64-bit)', web: 'Web browser' };

export interface SampleApp {
  title: string;
  company: string;
  category: string;
  subcategory?: string;
  brief: string;
  description: string;
  price?: number;
  sale?: number;
  platforms: Platform[];
  version: string;
  releasedAt: string;
  whatsNew?: string;
  /** package file name (a .zip) */
  file: string;
  [k: string]: unknown;
}

export const SOFTWARE_APPS: SampleApp[] = [
  { title: 'NoteFlow', company: 'Flowstate Software', category: 'Productivity', subcategory: 'Notes', brief: 'Notes, to-dos and docs that sync across devices', description: 'Write notes, plan to-dos and keep docs in one place. Everything syncs between your phone and computer, and works offline.', platforms: ['android', 'ios', 'windows', 'macos', 'web'], version: '2.8.0', releasedAt: '2026-09-18', whatsNew: 'Shared notebooks and a faster search.', file: 'NoteFlow-2.8.0-setup.zip', whatYouGet: ['Unlimited notes and notebooks', 'To-do lists with reminders', 'Sync across all your devices'] },
  {
    title: 'PixelCraft Studio',
    company: 'Northlight Labs',
    category: 'Multimedia',
    subcategory: 'Photo editing',
    brief: 'Layered photo editing with RAW support',
    description: 'Layered photo editing with full RAW support. Retouch portraits, swap skies and batch-export a whole shoot in one pass — no subscription.',
    whatYouGet: ['Unlimited layers, masks and blend modes', 'RAW import for 900+ camera models', 'Batch export to JPEG, PNG, TIFF and WebP', 'One licence for 2 devices'],
    price: 24.99,
    sale: 12.49,
    licenceLabel: 'One-time purchase · 2 devices',
    platforms: ['windows', 'macos', 'android', 'ios'],
    version: '3.4.1',
    releasedAt: '2026-10-14',
    whatsNew: 'Faster RAW previews, a new sky-replacement brush and fixes for TIFF export on macOS.',
    versionHistory: [
      { version: '3.4.0', date: '2026-09-02', notes: 'Batch export presets and a redesigned layers panel.' },
      { version: '3.3.2', date: '2026-07-18', notes: 'Fixes for RAW files from newer mirrorless cameras.' },
      { version: '3.3.0', date: '2026-05-30', notes: 'Portrait retouch brushes and LUT support.' },
    ],
    notice: 'Batch RAW export needs a graphics card with 4 GB of memory. The licence key is sent to your Marketly inbox after purchase.',
    permissions: [
      { name: 'Storage', desc: 'Open and save photos on this device' },
      { name: 'Network', desc: 'Check the licence and download updates' },
      { name: 'Camera', desc: 'Import shots from a tethered camera' },
    ],
    databasesNote: 'Preset library and LUT packs, needed for offline use',
    databases: ['PixelCraft-Presets-and-LUTs.zip'],
    file: 'PixelCraft-Studio-3.4.1.zip',
  },
  { title: 'Lingo Coach', company: 'Lingo Labs', category: 'Education', subcategory: 'Languages', brief: 'Daily 10-minute lessons in 24 languages', description: 'Short daily lessons with speaking practice and reviews timed to help you remember, in 24 languages.', platforms: ['android', 'ios', 'web'], version: '5.2.0', releasedAt: '2026-08-30', file: 'Lingo-Coach-5.2.0.zip' },
  { title: 'VaultGuard VPN', company: 'VaultGuard Inc.', category: 'Security', subcategory: 'VPN', brief: 'No-log VPN with 60 server locations', description: 'Browse privately on any network. No logs, 60 server locations and a kill switch that keeps you covered if the connection drops.', price: 4.99, sale: 2.99, licenceLabel: 'One-time purchase · 5 devices', platforms: ['android', 'ios', 'windows', 'macos'], version: '4.1.3', releasedAt: '2026-09-05', file: 'VaultGuard-VPN-4.1.3.zip', permissions: [{ name: 'Network', desc: 'Route your traffic through the VPN' }] },
  { title: 'Ledgerly', company: 'Ledgerly Ltd', category: 'Business', subcategory: 'Accounting', brief: 'Invoices, expenses and VAT reports for small shops', description: 'Send invoices, track expenses and get VAT reports ready for your accountant, made for small shops.', price: 9.99, sale: 6.99, platforms: ['windows', 'macos', 'web'], version: '7.0.2', releasedAt: '2026-07-22', file: 'Ledgerly-7.0.2.zip' },
  { title: 'Scribe AI Assistant', company: 'Quillwork AI', category: 'AI', subcategory: 'Writing', brief: 'Drafts emails and summaries from your notes', description: 'Turn rough notes into clear emails, summaries and to-do lists. You check every draft before it goes anywhere.', platforms: ['android', 'ios', 'windows', 'macos'], version: '1.0.0', releasedAt: '2026-10-20', file: 'Scribe-AI-Assistant-1.0.0.zip' },
  { title: 'Habit Garden', company: 'Sprout Apps', category: 'Productivity', subcategory: 'Habits', brief: 'Grow habits with daily check-ins and streaks', description: 'Check in once a day and watch your garden grow. Streaks, gentle reminders and weekly reviews keep you going.', price: 2.99, platforms: ['android', 'ios'], version: '1.2.0', releasedAt: '2026-10-17', file: 'Habit-Garden-1.2.0.zip' },
  { title: 'TaxEasy 2026', company: 'Brightledger', category: 'Business', subcategory: 'Taxes', brief: 'File your 2026 taxes step by step', description: 'Answer simple questions and TaxEasy fills in the forms, checks them and tells you what to send.', price: 14.99, platforms: ['windows', 'macos'], version: '2026.1', releasedAt: '2026-10-15', file: 'TaxEasy-2026.1.zip' },
  { title: 'Skyline Racers', company: 'Redline Games', category: 'Games', subcategory: 'Racing', brief: 'Street racing across 40 city tracks', description: 'Race through 40 city tracks, tune your cars and challenge friends in weekly cups.', platforms: ['android', 'ios', 'windows'], version: '3.6.0', releasedAt: '2026-06-12', file: 'Skyline-Racers-3.6.0.zip' },
  { title: 'Kingdom Tactics', company: 'Ironcrest Studio', category: 'Games', subcategory: 'Strategy', brief: 'Turn-based strategy with 120 campaign maps', description: 'Lead your kingdom through 120 campaign maps of turn-based battles, sieges and diplomacy.', price: 6.99, sale: 3.49, platforms: ['android', 'ios', 'windows', 'macos'], version: '2.3.1', releasedAt: '2026-05-28', file: 'Kingdom-Tactics-2.3.1.zip' },
  { title: 'Puzzle Harbor', company: 'Tidepool Games', category: 'Games', subcategory: 'Puzzle', brief: 'Relaxing harbor puzzles, 600 levels', description: 'Slide boats, sort cargo and clear the harbor across 600 calm puzzle levels.', platforms: ['android', 'ios'], version: '1.9.4', releasedAt: '2026-04-15', file: 'Puzzle-Harbor-1.9.4.zip' },
  { title: 'Orbit Browser', company: 'Orbit Software', category: 'Browsers', brief: 'Fast browser with built-in tab groups', description: 'A fast browser with tab groups, a reading mode and sync between your devices.', platforms: ['android', 'ios', 'windows', 'macos', 'linux'], version: '12.0.1', releasedAt: '2026-09-25', file: 'Orbit-Browser-12.0.1.zip' },
  { title: 'Swift Lite', company: 'Swift Labs', category: 'Browsers', brief: 'A light browser for older phones', description: 'A small, quick browser that saves data and runs well on older phones.', platforms: ['android'], version: '4.4.0', releasedAt: '2026-08-08', file: 'Swift-Lite-4.4.0.zip' },
  { title: 'Privo Secure Browser', company: 'Privo Security', category: 'Browsers', brief: 'Private browsing that blocks trackers', description: 'Blocks trackers and ads, clears your history when you close it and keeps your searches private.', platforms: ['android', 'ios', 'windows', 'macos'], version: '6.1.0', releasedAt: '2026-09-12', file: 'Privo-Secure-Browser-6.1.0.zip' },
  { title: 'CutPro Video', company: 'Framecut Studios', category: 'Multimedia', subcategory: 'Video editing', brief: 'Multi-track video editing up to 8K', description: 'Edit on unlimited tracks up to 8K, grade colour and export for any screen.', price: 49.99, licenceLabel: 'One-time purchase · 2 devices', platforms: ['windows', 'macos'], version: '9.2.0', releasedAt: '2026-09-30', file: 'CutPro-Video-9.2.0.zip' },
  { title: 'DiskCare', company: 'Tidy Systems', category: 'Utilities', subcategory: 'Cleanup', brief: 'Finds duplicates and frees up disk space', description: 'Finds duplicate files, old downloads and caches, and frees up space safely.', price: 19.99, sale: 9.99, platforms: ['windows', 'macos'], version: '5.0.4', releasedAt: '2026-07-02', file: 'DiskCare-5.0.4.zip' },
  { title: 'CodeNest IDE', company: 'CodeNest', category: 'Developer tools', subcategory: 'Code editor', brief: 'Lightweight editor with Git and terminal', description: 'A lightweight code editor with Git, a built-in terminal and extensions for every language.', platforms: ['windows', 'macos', 'linux'], version: '2.14.0', releasedAt: '2026-09-08', file: 'CodeNest-IDE-2.14.0.zip' },
  { title: 'Writer Pro', company: 'Officecraft', category: 'Productivity', subcategory: 'Word processing', brief: 'Documents with styles, comments and PDF export', description: 'Write documents with styles, tracked changes and comments, and export them as PDF or Word files.', price: 29.99, platforms: ['windows', 'macos'], version: '4.0.0', releasedAt: '2026-06-20', file: 'Writer-Pro-4.0.0.zip' },
  { title: 'Sheets Pro', company: 'Officecraft', category: 'Productivity', subcategory: 'Spreadsheets', brief: 'Spreadsheets with pivot tables and charts', description: 'Spreadsheets with formulas, pivot tables and charts that open Excel files as they are.', price: 34.99, platforms: ['windows', 'macos'], version: '4.0.0', releasedAt: '2026-06-20', file: 'Sheets-Pro-4.0.0.zip' },
  { title: 'Slides Pro', company: 'Officecraft', category: 'Productivity', subcategory: 'Presentations', brief: 'Presentations with themes and presenter view', description: 'Build presentations from themes, rehearse with presenter view and export to PDF or video.', price: 34.99, platforms: ['windows', 'macos'], version: '4.0.0', releasedAt: '2026-06-20', file: 'Slides-Pro-4.0.0.zip' },
  { title: 'SoundDesk', company: 'Wavefront Audio', category: 'Multimedia', subcategory: 'Audio', brief: 'Record, mix and master multitrack audio', description: 'Record, mix and master multitrack audio with studio effects and a clean, simple mixer.', price: 39.99, platforms: ['windows', 'macos'], version: '3.1.0', releasedAt: '2026-08-14', file: 'SoundDesk-3.1.0.zip' },
  { title: 'FontBox', company: 'Glyphworks', category: 'Multimedia', subcategory: 'Fonts', brief: 'Manage, preview and activate your fonts', description: 'Keep your fonts organized, preview them with your own text and switch them on when you need them.', price: 14.99, platforms: ['windows', 'macos'], version: '2.5.2', releasedAt: '2026-07-28', file: 'FontBox-2.5.2.zip' },
];

export const SOFTWARE_PACKS = [
  { name: 'Office Pro pack', apps: ['Writer Pro', 'Sheets Pro', 'Slides Pro'], price: 59.99, licenceLabel: 'Lifetime licence', summary: 'Writer, Sheets and Slides Pro — 3 apps for $59.99' },
  { name: 'Creator pack', apps: ['CutPro Video', 'PixelCraft Studio', 'SoundDesk', 'FontBox'], price: 84.99, licenceLabel: 'Lifetime licence', summary: 'CutPro Video, PixelCraft Studio, SoundDesk and FontBox — 4 apps for $84.99' },
];

/** The Recommended for you rail (manual) on the canvas */
export const RECOMMENDED = ['NoteFlow', 'PixelCraft Studio', 'Lingo Coach', 'VaultGuard VPN', 'Ledgerly'];

/* ------------------------------------------------------------------ generated files */

const TINTS: [number, number, number][] = [
  [79, 70, 229],
  [14, 165, 233],
  [16, 185, 129],
  [245, 158, 11],
  [239, 68, 68],
  [168, 85, 247],
];

const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
};

/** A square PNG icon: the tint, a lighter diagonal half and a white disc in the middle */
export function pngIcon(n: number, size = 512): Buffer {
  const [r, g, b] = TINTS[n % TINTS.length]!;
  const light = [r, g, b].map((c) => Math.round(c + (255 - c) * 0.25));
  const rows: Buffer[] = [];
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const disc = (x - c) ** 2 + (y - c) ** 2 < (size * 0.18) ** 2;
      const px = disc ? [255, 255, 255] : x + y > size ? light : [r, g, b];
      row[1 + x * 3] = px[0]!;
      row[2 + x * 3] = px[1]!;
      row[3 + x * 3] = px[2]!;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** A small real ZIP (stored, no compression) holding a read-me and a placeholder payload of a few KB */
export function zipFile(title: string, fileName: string): Buffer {
  const entries = [
    { name: 'README.txt', data: Buffer.from(`${title}\r\n\r\nSample package for the Marketly development server (${fileName}).\r\nIt contains no software.\r\n`, 'utf8') },
    { name: 'payload.bin', data: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + title.length) % 256)) },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5b56, 12); // 2025-10-22
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5b56, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, e.data);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/* ------------------------------------------------------------------ uploads */

/** Uploads one file as staff (platform-owned) and answers its media asset id once it is ready */
export type Uploader = (file: { purpose: 'content_image' | 'software_package'; fileName: string; contentType: string; body: Buffer }) => Promise<string>;

/** An Uploader for a running server: ticket, bytes to the ticket URL, complete, then wait until processed */
export function apiUploader(base: string, token: string): Uploader {
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url.startsWith('http') ? url : `${base}${url}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body) } : {}) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  return async (file) => {
    const ticket = await call('POST', '/api/admin/media/uploads', { upload: { purpose: file.purpose, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.body.length }, ownerKind: 'platform' });
    await call(ticket.method ?? 'PUT', ticket.url, file.body, ticket.headers ?? {});
    await call('POST', `/api/admin/media/uploads/${ticket.uploadId}/complete`);
    for (let i = 0; i < 60; i++) {
      const asset = (await call('GET', `/api/admin/media/assets/${ticket.assetId}`)).asset;
      if (asset.status === 'ready') return ticket.assetId as string;
      if (asset.status === 'rejected') throw new Error(`${file.fileName} was rejected: ${asset.rejectionReason}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${file.fileName} was not processed in time`);
  };
}

/* ------------------------------------------------------------------ seed */

export async function seedSoftware(admin: AdminCall, upload: Uploader): Promise<Record<string, number>> {
  const out = { categories: 0, apps: 0, appsUpdated: 0, files: 0, packs: 0, packsUpdated: 0, rails: 0, granted: 0 };
  // categories, in order
  const cats = (await admin('GET', '/admin/software/categories')) as { id: string; slug: string }[];
  const categoryId = new Map(cats.map((c) => [c.slug, c.id]));
  for (const [i, c] of SOFTWARE_CATEGORIES.entries()) {
    const existing = categoryId.get(slug(c.name));
    if (existing) await admin('PATCH', `/admin/software/categories/${existing}`, { name: c.name, icon: c.icon, position: i + 1, visible: true });
    else {
      const row = await admin('POST', '/admin/software/categories', { name: c.name, icon: c.icon, position: i + 1 });
      categoryId.set(row.slug, row.id);
      out.categories++;
    }
  }

  // apps: upserted by slug; files only when the app has none yet
  const list = (await admin('GET', '/admin/software/apps?limit=100')) as { items: { id: string; slug: string }[] };
  const appId = new Map(list.items.map((a) => [a.slug, a.id]));
  for (const [n, a] of SOFTWARE_APPS.entries()) {
    const { title, company, category, price, sale, platforms, file, databases, ...rest } = a as SampleApp & { databases?: string[] };
    const id = appId.get(slug(title));
    const current = id ? await admin('GET', `/admin/software/apps/${id}`) : null;
    const files: Record<string, unknown> = {};
    if (!current?.icon) {
      files.iconId = await upload({ purpose: 'content_image', fileName: `${slug(title)}-icon.png`, contentType: 'image/png', body: pngIcon(n) });
      out.files++;
    }
    if (!current?.files?.package) {
      files.packageId = await upload({ purpose: 'software_package', fileName: file, contentType: 'application/zip', body: zipFile(title, file) });
      out.files++;
    }
    if (databases?.length && !current?.files?.databases?.length) {
      const ids: string[] = [];
      for (const d of databases) ids.push(await upload({ purpose: 'software_package', fileName: d, contentType: 'application/zip', body: zipFile(`${title} databases`, d) }));
      files.databaseIds = ids;
      out.files += ids.length;
    }
    const body = {
      ...rest,
      ...files,
      title,
      company: { name: company },
      categoryId: categoryId.get(slug(category)),
      free: price == null,
      price: price != null ? usd(price) : null,
      licenceDevices: price != null ? devicesOf(rest.licenceLabel) : null,
      salePrice: sale != null ? usd(sale) : null,
      saleEndsAt: sale != null ? SALE_ENDS_AT : null,
      platforms,
      platformLabels: (rest.platformLabels as string[] | undefined) ?? platforms.map((p) => LABEL[p]),
      status: 'published',
      showInDepartment: true,
      position: n + 1,
    };
    if (id) {
      await admin('PATCH', `/admin/software/apps/${id}`, body);
      out.appsUpdated++;
    } else {
      const row = await admin('POST', '/admin/software/apps', body);
      appId.set(row.slug, row.id);
      out.apps++;
    }
  }

  // packs, upserted by slug
  const packs = (await admin('GET', '/admin/software/packs')) as { id: string; slug: string }[];
  const packId = new Map(packs.map((p) => [p.slug, p.id]));
  for (const [i, p] of SOFTWARE_PACKS.entries()) {
    const body = { name: p.name, summary: p.summary, appIds: p.apps.map((t) => appId.get(slug(t))), price: usd(p.price), licenceLabel: p.licenceLabel, visible: true, position: i + 1 };
    const id = packId.get(slug(p.name));
    if (id) {
      await admin('PATCH', `/admin/software/packs/${id}`, body);
      out.packsUpdated++;
    } else {
      await admin('POST', '/admin/software/packs', body);
      out.packs++;
    }
  }

  // the Recommended for you rail gets the canvas's apps while staff haven't picked any
  const rails = (await admin('GET', '/admin/software/rails')) as { key: string; source: string; appIds: string[]; categoryId?: string | null }[];
  const recommended = rails.find((r) => r.key === 'recommended' && r.source === 'manual');
  if (recommended && !recommended.appIds.length) {
    recommended.appIds = RECOMMENDED.map((t) => appId.get(slug(t))!).filter(Boolean);
    // category rails made before the categories existed point at them now
    for (const r of rails) if (r.source === 'category' && !r.categoryId) r.categoryId = categoryId.get(r.key) ?? null;
    await admin('PUT', '/admin/software/rails', { rails: rails.filter((r) => r.source !== 'category' || r.categoryId) });
    out.rails = 1;
  }

  // the development customer owns a paid app (its licence key shows in My apps); skipped when the account doesn't
  // exist or the staff member may not look customers up
  const owned = appId.get(slug(DEV_OWNED_APP));
  const found = owned ? await admin('GET', `/admin/customers/customers?q=${encodeURIComponent(DEV_CUSTOMER_EMAIL)}&limit=5`).catch(() => null) : null;
  const customer = (found?.items as { id: string; email: string }[] | undefined)?.find((c) => c.email === DEV_CUSTOMER_EMAIL);
  if (owned && customer) {
    const has = await admin('GET', `/admin/software/entitlements?appId=${owned}&customerId=${customer.id}`);
    if (!has.items.length) {
      await admin('POST', '/admin/software/entitlements', { customerId: customer.id, appId: owned, reason: 'Development sample: a paid app with a licence key' });
      out.granted++;
    }
  }
  return out;
}
