#!/usr/bin/env node
// Marketly seed: fills a running backend with sample data through its HTTP API only.
// Usage: npm run seed [-- --only owners,taxonomy] [--api http://127.0.0.1:4000] [--backend E:/Work/Ecommerce-api/backend] [--force] [--reset]
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from './lib/http.mjs';
import { Context } from './lib/context.mjs';
import { log } from './lib/log.mjs';
import { State } from './lib/state.mjs';
import { Tokens } from './lib/tokens.mjs';
import { ownersStep } from './steps/owners.mjs';
import { taxonomyStep } from './steps/taxonomy.mjs';
import { mediaStep } from './steps/media.mjs';
import { officialStep } from './steps/official.mjs';
import { sellersStep } from './steps/sellers.mjs';
import { promotionsStep } from './steps/promotions.mjs';
import { contentStep } from './steps/content.mjs';
import { customersStep } from './steps/customers.mjs';
import { ordersStep } from './steps/orders.mjs';
import { reviewsStep } from './steps/reviews.mjs';
import { designStep } from './steps/design.mjs';
import { verifyStep } from './steps/verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webShared = resolve(here, '..', '..');

const STEPS = [
  ['owners', 'Business Owners accept their invitations', ownersStep],
  ['taxonomy', 'Categories and brands', taxonomyStep],
  ['media', 'Product photos and banners (Official Store)', mediaStep],
  ['official', 'Official Store: location, products, offers, stock', officialStep],
  ['sellers', 'Sellers: application, approval, products, offers', sellersStep],
  ['promotions', 'Coupons, flash sale, seller discount', promotionsStep],
  ['content', 'Homepage, navigation, help, policies, About', contentStep],
  ['customers', 'Customers with addresses', customersStep],
  ['orders', 'Orders: checkout, shipping, delivery, cancellations, returns', ordersStep],
  ['reviews', 'Reviews, seller feedback, questions and answers', reviewsStep],
  ['design', 'States the store design shows, and the design check samples', designStep],
  ['verify', 'Check the store side with a visitor token', verifyStep],
];

function parseArgs(argv) {
  const o = { api: 'http://127.0.0.1:4000', backend: 'E:/Work/Ecommerce-api/backend', only: null, force: false, reset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--api') o.api = val();
    else if (a === '--backend') o.backend = val();
    else if (a === '--only') o.only = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--force') o.force = true;
    else if (a === '--reset') o.reset = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node tools/seed/index.mjs [--only ${STEPS.map((s) => s[0]).join(',')}] [--api <url>] [--backend <dir>] [--force] [--reset]`);
      process.exit(0);
    } else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.stateFile = join(webShared, '.seed', 'state.json');
  opts.bootstrapFile = join(webShared, '.seed', 'bootstrap-owner.txt');
  if (opts.reset && existsSync(opts.stateFile)) rmSync(opts.stateFile);
  const unknown = (opts.only ?? []).filter((s) => !STEPS.some(([k]) => k === s));
  if (unknown.length) throw new Error(`Unknown step(s): ${unknown.join(', ')}`);

  const state = new State(opts.stateFile);
  const api = new Api(opts.api, log);
  const tokens = new Tokens(opts.backend);
  if (!tokens.key) log.warn(`No dev signing key at ${opts.backend}/.data/dev-signing-key.json: falling back to "npm run token" in that folder`);
  const ctx = new Context({ api, tokens, state, log, opts });

  console.log(`Marketly seed → ${opts.api}  (state: ${opts.stateFile})`);
  const failed = [];
  for (const [key, title, fn] of STEPS) {
    const selected = opts.only ? opts.only.includes(key) : true;
    if (!selected) continue;
    if (!opts.only && !opts.force && state.isDone(key)) {
      log.step(`${key}: ${title}`, 'done earlier, skipped; use --only or --force to run it again');
      continue;
    }
    log.step(`${key}: ${title}`);
    try {
      await fn(ctx);
      state.markDone(key);
    } catch (err) {
      failed.push(key);
      console.error(`\n  ✖ ${key} failed: ${err.stack ?? err.message}`);
      // later steps depend on owners, taxonomy and sellers: stop there
      if (['owners', 'taxonomy', 'official', 'sellers', 'customers'].includes(key)) break;
    }
  }

  console.log(`\nDone in ${log.elapsed()} · ${api.calls} requests`);
  const counts = Object.entries(log.counts).map(([k, n]) => `${k} ${n}`).join(', ');
  if (counts) console.log(`Created this run: ${counts}`);
  if (log.warnings.length) console.log(`Warnings (${log.warnings.length}):\n${log.warnings.map((w) => `  - ${w}`).join('\n')}`);
  if (failed.length) {
    console.log(`Failed steps: ${failed.join(', ')} (fix and run again; finished work is kept in the state file)`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
