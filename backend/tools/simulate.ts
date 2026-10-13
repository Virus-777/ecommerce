#!/usr/bin/env tsx
/**
 * Drives the whole marketplace with realistic traffic over real HTTP, then checks the database.
 *
 *   npm run simulate                       small: 3 sellers, ~20 products, 8 customers, ~15 orders
 *   npm run simulate -- --scale medium     about 4× as much
 *   npm run simulate -- --seed 42          the same random choices as an earlier run with seed 42
 *
 * It builds the app in this process on the database of MONGODB_URI (the local replica set), listens on a free
 * port and sends every API call with fetch, the way the store, Seller Center, Admin Center and the outside
 * providers (card processor, carriers) would. Each run tags what it creates (emails, store names, SKUs) with a run
 * id, so runs never clash, and leaves its data in place to look at. Afterwards it checks the database read-only
 * (tools/simulate/checks.ts) and prints a report, also written to .data/simulate-report.json. Exit code 1 when
 * any step or check failed.
 *
 * In process, besides HTTP, only what a real client gets out of band: the development outbox (emailed codes and
 * links), running a scheduled job now (development servers run no jobs), waiting for event consumers, and
 * read-only database access for the checks. Each use says why.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.js';
import { isLocalMongo } from '../src/kernel/config/index.js';
import type { MongoStore } from '../src/kernel/mongo/index.js';
import { runChecks, type CheckResult } from './simulate/checks.js';
import { FLOWS } from './simulate/flows/index.js';
import { saveOwners } from './simulate/flows/staff.js';
import { Client } from './simulate/http.js';
import { People } from './simulate/people.js';
import { Runner } from './simulate/runner.js';
import { Sim, type Scale } from './simulate/sim.js';

const { values } = parseArgs({ options: { scale: { type: 'string', default: 'small' }, seed: { type: 'string' } } });
const scale = values.scale as Scale;
if (scale !== 'small' && scale !== 'medium') {
  console.error('Usage: npm run simulate -- [--scale small|medium] [--seed <n>]');
  process.exit(1);
}

/* ---------------------------------------------------------------- refuse anything but a local development database */

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: NODE_ENV is production. The simulator writes test data.');
  process.exit(1);
}
if (!process.env.MONGODB_URI || !isLocalMongo(process.env.MONGODB_URI)) {
  console.error('Refusing to run: MONGODB_URI must name a MongoDB server on this machine (localhost / 127.0.0.1). The simulator writes test data.');
  process.exit(1);
}
// The simulator sends many requests from one address in a short time; the rate limits would refuse them like a
// flood. The dev server on port 4000 runs with RATE_LIMITS=false for the same reason. Set before buildApp reads it.
process.env.RATE_LIMITS = 'false';

/** What the simulator does in process instead of over HTTP, and why (printed in the report file) */
const DEV_SHORTCUTS = [
  'Business Owner bootstrap (first run only): AccessService.bootstrapBusinessOwner, the operator command tools/bootstrap-owner.ts runs; there is no API for it. It returns the owners\' invitation links and pass codes',
  'Staff invitation pass codes: each new hire gets a link and pass code from tools/lib/staff-link.ts, what npm run staff-link prints for the operator (the Admin Center never shows a pass code)',
  'Mailbox: emailed codes, invitation links and seller invitation codes are read from the development outbox (notifications/providers/dev-outbox.ts)',
  'Bank statement: the two payout test deposits are computed like the development payout provider sends them (finance/providers/payouts.ts testDepositsFor)',
  'Scheduled jobs run now with app.kernel.jobs.runNow (JOBS_ENABLED is false on development servers): media processing, search indexing, notifications dispatch, refunds, payout runs, reports',
  'app.kernel.events.drain() after each change: waits for event consumers the way a client would wait a moment',
  'Webhook secrets read from the server config (the simulator plays the card processor and the carrier, which hold them)',
  'Database checks: read-only queries through the app’s MongoDB connection',
];

const runId = Date.now().toString(36).slice(-6);
const seed = values.seed ? Number(values.seed) : Math.floor(Math.random() * 1e9);

/** A free TCP port on loopback, so signed links (uploads) can name this server before it listens */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Documents per collection (read-only), for the before/after counts */
async function counts(db: MongoStore['db']): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const c of (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).sort()) out[c] = await db.collection(c).countDocuments();
  return out;
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const t0 = Date.now();
// Jobs: no schedules run here (JOBS_ENABLED off, like the development server), and the in-process job runner
// makes runNow run a job right here. With the MongoDB job queue runNow would only enqueue it and wait for a
// worker instance, and the development server has none.
const app = await buildApp({ config: { logLevel: 'warn', port, apiUrl: base, jobsEnabled: false, jobsBackend: 'inprocess' } });
await app.listen({ host: '127.0.0.1', port });
const config = app.kernel.config;
console.log(`Marketly simulator: run ${runId}, scale ${scale}, seed ${seed}, ${app.kernel.modules.length} modules on ${base} (database ${new URL(config.mongo.uri!).pathname.slice(1) || 'test'})\n`);

const db = app.kernel.mongo.db;
const before = await counts(db);
const runner = new Runner();
const origins = { store: config.cors.store[0] ?? config.publicUrls.store, seller: config.cors.seller[0] ?? config.publicUrls.seller, admin: config.cors.admin[0] ?? config.publicUrls.admin };
// waiting for event consumers after each change: in a real deployment the app would see the effect a moment later
const api = new Client(base, origins, runner, () => app.kernel.events.drain());
const people = new People(app, api, runner);
// webhooks are signed with the provider's secret from WEBHOOK_SECRETS (development: the dev secret); the
// simulator plays the provider, so it signs with the same secret the server verifies with. Never printed.
const secretOf = (provider: string) => config.webhookSecrets[provider] ?? config.webhookSecrets['*'] ?? '';
const sim = new Sim(app, api, people, runner, runId, scale, seed, secretOf);

let checks: CheckResult[] = [];
let exitCode = 1;
try {
  for (const f of FLOWS) await runner.flow(f.name, f.needs, () => f.run(sim));
  console.log('\nDatabase checks');
  checks = await runChecks(db, sim);
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : `: ${c.detail}`}`);
  const after = await counts(db);
  exitCode = report(before, after, checks);
} finally {
  saveOwners(sim.world);
  await app.close();
}
process.exit(exitCode);

/* ---------------------------------------------------------------- report */

function report(before: Record<string, number>, after: Record<string, number>, checks: CheckResult[]): number {
  const flows = runner.flows;
  console.log('\nFlows');
  console.table(Object.fromEntries(flows.map((f) => [f.name, { steps: f.steps, passed: f.passed, failed: f.failed, ms: f.ms, skipped: f.skipped ?? '' }])));
  const changed = Object.keys(after)
    .filter((c) => (after[c] ?? 0) !== (before[c] ?? 0))
    .map((c) => ({ collection: c, before: before[c] ?? 0, after: after[c]!, added: after[c]! - (before[c] ?? 0) }));
  console.log(`Documents per collection (${changed.length} collections changed; all counts in the report file)`);
  console.table(Object.fromEntries(changed.map((c) => [c.collection, { before: c.before, after: c.after, added: c.added }])));

  const failedSteps = flows.reduce((n, f) => n + f.failed, 0);
  const failedChecks = checks.filter((c) => !c.ok).length;
  const skipped = flows.filter((f) => f.skipped).length;
  const totals = {
    flows: flows.length,
    flowsPassed: flows.filter((f) => !f.skipped && f.failed === 0).length,
    flowsSkipped: skipped,
    steps: flows.reduce((n, f) => n + f.steps, 0),
    stepsFailed: failedSteps,
    checks: checks.length,
    checksFailed: failedChecks,
    httpRequests: [...api.calls.values()].reduce((a, b) => a + b, 0),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  console.log('\nTotals', totals);
  console.log(`\nDevelopment tokens used: ${sim.devTokenPlaces.length ? '' : 'none'}`);
  for (const p of sim.devTokenPlaces) console.log(`  - ${p}`);
  console.log('In process instead of HTTP (why: see outOfBand in the report file): bootstrap, mailbox, test deposits, jobs, event drain, webhook secrets, checks');
  if (api.notes.length) {
    console.log('\nNotes (not failures):');
    for (const n of api.notes) console.log(`  - ${n}`);
  }
  if (failedSteps) {
    console.log('\nFailed steps:');
    for (const f of flows.flatMap((x) => x.failures)) console.log(`  [${f.flow}] ${f.step}: ${f.method ? `${f.method} ${f.url} → ${f.status} ` : ''}${f.message.split('\n')[0]} ${f.body === undefined ? '' : JSON.stringify(f.body).slice(0, 300)}`);
  }
  mkdirSync('.data', { recursive: true });
  writeFileSync(
    '.data/simulate-report.json',
    JSON.stringify({ runId, seed, scale, base, at: new Date().toISOString(), totals, flows, checks, devTokens: sim.devTokenPlaces, notes: api.notes, outOfBand: DEV_SHORTCUTS, requests: Object.fromEntries([...api.calls].sort()), collections: { before, after, changed } }, null, 2),
  );
  console.log('\nReport: .data/simulate-report.json');
  return failedSteps || failedChecks ? 1 : 0;
}
