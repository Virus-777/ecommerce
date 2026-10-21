/**
 * Seeds the sample department pages content (tools/simulate/departments-data.ts) into a running server through the
 * Admin Center API, the way a Content Manager would: blog topics, authors and posts, industries and companies, Play
 * center games and ranking tables, and the Phone tab picks. Only what is missing is added.
 *
 *   SEED_EMAIL=<staff email> SEED_PASSWORD=<password> npx tsx tools/seed-departments.ts [http://localhost:4000]
 *
 * The staff account needs the departments manage keys (Content Manager, or Business Owner with it). Development
 * servers only: the app session uses the development app proof.
 */
import { seedDepartments } from './simulate/departments-data.js';

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
const signedIn = await request('POST', '/api/public/identity/sessions', { email, password, audience: 'admin', keepSignedIn: false, device: { kind: 'web' } }, adminApp);
if (signedIn.status !== 'signed_in') {
  console.error(`Sign-in did not finish (${signedIn.status}); use an account without a pending second step.`);
  process.exit(1);
}
const staff = signedIn.tokens.accessToken as string;
const visitor = await appSession('store');

const added = await seedDepartments(
  (method, path, body) => request(method, `/api${path}`, body, staff),
  (path) => request('GET', `/api${path}`, undefined, visitor),
);
console.log('Department pages content added:', added);
