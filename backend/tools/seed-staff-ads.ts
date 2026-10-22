/**
 * Seeds sample staff ads (the simple Advertisements page, 2026-10-23) into a running development server through the
 * Admin Center API, the way staff would: a generated banner is uploaded through media, the ad is created with a
 * picked destination, sent for review and approved by two other staff members. One or two ads per slot, including
 * two short Deals carousel banners (750 × 150). Ads whose name already exists are left alone, so it can run again.
 *
 *   SEED_EMAIL=<creator> SEED_PASSWORD=<password> \
 *   SEED_REVIEWER_EMAIL=<reviewer 1> SEED_REVIEWER_PASSWORD=<password> \
 *   SEED_REVIEWER2_EMAIL=<reviewer 2> SEED_REVIEWER2_PASSWORD=<password> \
 *   npx tsx tools/seed-staff-ads.ts [http://localhost:4000]
 *
 * The creator needs advertising.campaigns.manage; the reviewers the Advertising and Content review roles (a Business
 * Owner covers either). Without reviewers the ads stay in review. Development servers only (development app proof).
 */
import sharp from 'sharp';
import { apiUploader } from './simulate/software-data.js';

const base = (process.argv[2] ?? process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const env = (k: string) => process.env[k]?.trim() || null;
if (!env('SEED_EMAIL') || !env('SEED_PASSWORD')) {
  console.error('Set SEED_EMAIL and SEED_PASSWORD to a staff account that may manage ads.');
  process.exit(1);
}

async function request(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const adminApp = (await request('POST', '/api/public/identity/app-sessions', { audience: 'admin', device: { kind: 'web' } }, undefined, { 'x-app-proof': 'dev' })).accessToken as string;
async function staffToken(email: string, password: string): Promise<string> {
  const s = await request('POST', '/api/public/identity/sessions', { email, password, audience: 'admin', keepSignedIn: false, device: { kind: 'web' } }, adminApp);
  if (s.status !== 'signed_in') throw new Error(`Sign-in of ${email} did not finish (${s.status})`);
  return s.tokens.accessToken as string;
}
const creator = await staffToken(env('SEED_EMAIL')!, env('SEED_PASSWORD')!);
const reviewers: string[] = [];
for (const n of ['', '2']) {
  const e = env(`SEED_REVIEWER${n}_EMAIL`);
  const p = env(`SEED_REVIEWER${n}_PASSWORD`);
  if (e && p) reviewers.push(await staffToken(e, p));
}
const admin = (method: string, path: string, body?: unknown, token = creator) => request(method, `/api/admin/advertising${path}`, body, token);
const upload = apiUploader(base, creator);

/* ------------------------------------------------------------------ banners */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** A flat banner: background, a soft circle, a big line and a small one, sized for the slot */
async function banner(w: number, h: number, bg: string, fg: string, big: string, small: string): Promise<Buffer> {
  const portrait = h > w;
  const bigSize = Math.round(Math.min(w, h) * (h <= 160 ? 0.36 : portrait ? 0.12 : 0.2));
  const smallSize = Math.round(bigSize * 0.42);
  const x = portrait ? w / 2 : Math.round(w * 0.07);
  const anchor = portrait ? 'middle' : 'start';
  const yBig = portrait ? Math.round(h * 0.45) : Math.round(h / 2 + bigSize * 0.2);
  const ySmall = yBig + Math.round(bigSize * (h <= 160 ? 0.62 : 0.75));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="${bg}"/>
  <circle cx="${Math.round(w * 0.85)}" cy="${Math.round(h * 0.5)}" r="${Math.round(Math.min(w, h) * 0.45)}" fill="${fg}" opacity="0.14"/>
  <text x="${x}" y="${yBig}" font-family="Segoe UI, Arial" font-size="${bigSize}" font-weight="700" fill="${fg}" text-anchor="${anchor}">${esc(big)}</text>
  <text x="${x}" y="${ySmall}" font-family="Segoe UI, Arial" font-size="${smallSize}" font-weight="600" fill="${fg}" text-anchor="${anchor}" opacity="0.85">${esc(small)}</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/* ------------------------------------------------------------------ the ads */

interface Seed {
  name: string;
  placementKey: string;
  size: [number, number];
  web?: [number, number];
  colors: [string, string];
  big: string;
  small: string;
  alt: string;
  /** a picked destination: the first search result of the kind (q narrows it), or a department key */
  destination: { kind: string; q?: string; targetId?: string; url?: string };
  days: number;
}

const SEEDS: Seed[] = [
  { name: 'Welcome to Marketly (full-screen)', placementKey: 'opening_fullscreen', size: [1080, 1920], web: [1600, 900], colors: ['#0F172A', '#F8FAFC'], big: 'Hello!', small: 'Deals every day', alt: 'Welcome to Marketly: deals every day', destination: { kind: 'department', targetId: 'rewards' }, days: 30 },
  { name: 'Headphones week (home)', placementKey: 'home_banner', size: [750, 400], colors: ['#EEF2FF', '#3730A3'], big: 'Headphones', small: 'New arrivals this week', alt: 'New headphones this week', destination: { kind: 'category', q: 'head' }, days: 21 },
  { name: 'Top apps (Softwares)', placementKey: 'software_top', size: [750, 400], colors: ['#ECFEFF', '#0E7490'], big: 'Top apps', small: 'Hand-picked for you', alt: 'Hand-picked top apps', destination: { kind: 'department', targetId: 'software' }, days: 30 },
  { name: 'Free delivery tonight (Food)', placementKey: 'food_top', size: [750, 400], colors: ['#FFF7ED', '#C2410C'], big: 'Free delivery', small: 'On orders over $25 tonight', alt: 'Free food delivery tonight', destination: { kind: 'restaurant' }, days: 14 },
  { name: 'Hiring now (Companies)', placementKey: 'companies_top', size: [750, 400], colors: ['#F0FDF4', '#15803D'], big: 'Hiring now', small: 'Companies near you', alt: 'Companies hiring near you', destination: { kind: 'department', targetId: 'companies' }, days: 30 },
  { name: 'Weekly prizes (Play center)', placementKey: 'play_top', size: [750, 400], colors: ['#FDF4FF', '#A21CAF'], big: 'Weekly prizes', small: 'Play and climb the rankings', alt: 'Weekly prizes in the Play center', destination: { kind: 'department', targetId: 'play' }, days: 30 },
  { name: 'Flash deals today (Deals 1)', placementKey: 'deals_top', size: [750, 150], colors: ['#FEF2F2', '#B91C1C'], big: 'Flash deals', small: 'Today only', alt: 'Flash deals, today only', destination: { kind: 'deal' }, days: 7 },
  { name: 'Official Store picks (Deals 2)', placementKey: 'deals_top', size: [750, 150], colors: ['#EFF6FF', '#1D4ED8'], big: 'Official Store', small: 'Picks under $50', alt: 'Official Store picks under $50', destination: { kind: 'url', url: '/official' }, days: 14 },
  { name: 'Phones on sale (category)', placementKey: 'category_banner', size: [750, 300], colors: ['#F5F5F4', '#292524'], big: 'Phones', small: 'Unlocked models on sale', alt: 'Unlocked phones on sale', destination: { kind: 'department', targetId: 'phones' }, days: 21 },
  { name: 'Daily rewards (pop-up)', placementKey: 'popup', size: [600, 600], colors: ['#FEFCE8', '#A16207'], big: 'Rewards', small: 'Collect your daily coins', alt: 'Collect your daily reward coins', destination: { kind: 'department', targetId: 'rewards' }, days: 14 },
];

async function destinationOf(d: Seed['destination']): Promise<{ kind: string; targetId?: string; url?: string } | null> {
  if (d.kind === 'url') return { kind: 'url', url: d.url! };
  if (d.targetId) return { kind: d.kind, targetId: d.targetId };
  const found = await admin('GET', `/ads/destinations?kind=${d.kind}&limit=1${d.q ? `&q=${encodeURIComponent(d.q)}` : ''}`);
  const first = found.items?.[0];
  if (first) return { kind: d.kind, targetId: first.targetId };
  // nothing of that kind yet (e.g. no deal running): fall back to its department or the Deals tab
  return d.kind === 'restaurant' ? { kind: 'department', targetId: 'food' } : { kind: 'url', url: '/deals' };
}

const existing = new Set<string>(((await admin('GET', '/ads')).items as { name: string }[]).map((a) => a.name));
const out = { created: 0, live: 0, inReview: 0, skipped: 0 };
const day = 86_400_000;
for (const s of SEEDS) {
  if (existing.has(s.name)) {
    out.skipped++;
    continue;
  }
  const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const imageId = await upload({ purpose: 'ad_creative' as never, fileName: `${slug}.png`, contentType: 'image/png', body: await banner(s.size[0], s.size[1], s.colors[0], s.colors[1], s.big, s.small) });
  const webImageId = s.web ? await upload({ purpose: 'ad_creative' as never, fileName: `${slug}-web.png`, contentType: 'image/png', body: await banner(s.web[0], s.web[1], s.colors[0], s.colors[1], s.big, s.small) }) : null;
  const ad = await admin('POST', '/ads', {
    name: s.name,
    placementKey: s.placementKey,
    imageId,
    ...(webImageId ? { webImageId } : {}),
    alt: s.alt,
    destination: await destinationOf(s.destination),
    endsAt: new Date(Date.now() + s.days * day).toISOString(),
  });
  out.created++;
  await admin('POST', `/ads/${ad.id}/submit`);
  let status = 'in_review';
  for (const t of reviewers) status = (await admin('POST', `/ads/${ad.id}/review`, { decision: 'approve' }, t)).status;
  if (status === 'live' || status === 'scheduled') out.live++;
  else out.inReview++;
  console.log(`${ad.ref} ${s.placementKey.padEnd(18)} ${status.padEnd(10)} ${s.name}`);
}
console.log('Staff ads:', out);
