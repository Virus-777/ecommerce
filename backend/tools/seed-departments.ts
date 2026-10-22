/**
 * Seeds the sample department pages content (tools/simulate/departments-data.ts) into a running server through the
 * Admin Center API, the way a Content Manager would: blog topics, authors and posts, industries and companies, Play
 * center games and ranking tables, and the Phone tab picks. Only what is missing is added.
 *
 *   SEED_EMAIL=<staff email> SEED_PASSWORD=<password> npx tsx tools/seed-departments.ts [http://localhost:4000]
 *
 * Daily rewards coupons are promotions campaigns, and their creator can't confirm their funding: set
 * SEED_REVIEWER_EMAIL and SEED_REVIEWER_PASSWORD to a second staff member to confirm them in the same run.
 *
 * The staff account needs the departments manage keys (Content Manager, or Business Owner with it). Development
 * servers only: the app session uses the development app proof.
 */
import { seedDepartmentActivity, seedDepartments } from './simulate/departments-data.js';
import { seedFarm } from './simulate/farm-data.js';
import { seedFood, seedFoodReviews } from './simulate/food-data.js';
import { seedRewards } from './simulate/rewards-data.js';
import { seedServices } from './simulate/services-data.js';
import { apiUploader, seedSoftware } from './simulate/software-data.js';

const base = (process.argv[2] ?? process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const email = process.env.SEED_EMAIL;
const password = process.env.SEED_PASSWORD;
if (!email || !password) {
  console.error('Set SEED_EMAIL and SEED_PASSWORD to a staff account that may manage department pages.');
  process.exit(1);
}

async function request(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

/** An app session (development app proof) for the store or the Admin Center */
const appSession = async (audience: 'store' | 'admin') => (await request('POST', '/api/public/identity/app-sessions', { audience, device: { kind: 'web' } }, undefined, { 'x-app-proof': 'dev' })).accessToken as string;

const adminApp = await appSession('admin');
async function staffToken(email: string, password: string): Promise<string> {
  const signedIn = await request('POST', '/api/public/identity/sessions', { email, password, audience: 'admin', keepSignedIn: false, device: { kind: 'web' } }, adminApp);
  if (signedIn.status !== 'signed_in') {
    console.error(`Sign-in of ${email} did not finish (${signedIn.status}); use an account without a pending second step.`);
    process.exit(1);
  }
  return signedIn.tokens.accessToken as string;
}
const staff = await staffToken(email, password);
const reviewerToken = process.env.SEED_REVIEWER_EMAIL && process.env.SEED_REVIEWER_PASSWORD ? await staffToken(process.env.SEED_REVIEWER_EMAIL, process.env.SEED_REVIEWER_PASSWORD) : null;
const visitor = await appSession('store');

const admin = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => request(method, `/api${path}`, body, staff);
const added = await seedDepartments(admin, (path) => request('GET', `/api${path}`, undefined, visitor));
console.log('Department pages content added:', added);
console.log('Services, providers and categories added:', await seedServices(admin));
console.log('Softwares categories, apps, files and packs added:', await seedSoftware(admin, apiUploader(base, staff)));
console.log('Food categories, restaurants and menus added:', await seedFood(admin));
console.log('Food reviews added (sample customers order and rate):', await seedFoodReviews(admin, request, () => appSession('store')));
console.log('Farm dealers added:', await seedFarm(admin));
const reviewer = reviewerToken ? (method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown) => request(method, `/api${path}`, body, reviewerToken) : undefined;
console.log(reviewer ? 'Daily rewards added:' : 'Daily rewards added (campaigns waiting for funding need another staff member: set SEED_REVIEWER_EMAIL and SEED_REVIEWER_PASSWORD, or confirm them in Admin › Promotions and run again):', await seedRewards(admin, { reviewer }));
console.log('Company and game reviews, Play center keys, players and scores added:', await seedDepartmentActivity(admin, request, () => appSession('store')));
