// Step 1: accept the two Business Owner invitations made by `npm run bootstrap-owner` (password + authenticator),
// keep their TOTP secrets in the state file, and check their roles are active.
import { existsSync, readFileSync } from 'node:fs';
import { totp } from '../lib/codes.mjs';
import { ApiError, sleep } from '../lib/http.mjs';
import { OWNERS, PASSWORD } from '../data.mjs';

/** Parses bootstrap-owner output: "Invited Name <email> as … (account <uuid>)." + "Accept link: …#token=<t>" */
export function parseBootstrap(file) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  const out = {};
  const re = /Invited (.+?) <([^>]+)> as .*?\(account ([0-9a-f-]{36})\)\.?\s*\n\s*Accept link: (\S+)/g;
  for (const m of text.matchAll(re)) {
    const token = new URL(m[4]).hash.replace(/^#token=/, '');
    out[m[2].toLowerCase()] = { name: m[1], email: m[2].toLowerCase(), accountId: m[3], token };
  }
  return out;
}

async function adminVisitor(ctx) {
  // the real bootstrap call (the only one without a token): an admin visitor session
  const r = await ctx.api.req('POST', '/api/public/identity/app-sessions', { headers: { 'x-app-proof': 'dev' }, body: { audience: 'admin', device: { kind: 'web', name: 'Marketly seed' } } });
  return r.body.accessToken;
}

async function accept(ctx, key, inv) {
  const owners = ctx.state.section('owners');
  const saved = owners[key] ?? {};
  if (saved.accepted && saved.accountId === inv.accountId) {
    ctx.log.reused('owner', `${inv.name} (accepted earlier)`);
    return;
  }
  const device = { kind: 'web', name: 'Marketly seed' };
  const v = await adminVisitor(ctx);
  let accepted;
  try {
    accepted = await ctx.api.post('/api/public/identity/invitations/accept', v, { token: inv.token, password: PASSWORD, device });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 410 || err.status === 404 || err.status === 409 || err.code === 'INVITATION_INVALID')) {
      // accepted earlier without the state file: the account is usable if its roles are active
      const me = await ctx.api.get('/api/admin/access/me', ctx.tokens.staff(inv.accountId));
      if (me.account?.status === 'active') {
        owners[key] = { ...saved, accountId: inv.accountId, email: inv.email, name: inv.name, accepted: true, password: saved.password ?? PASSWORD };
        ctx.state.save();
        ctx.log.warn(`${inv.name}: invitation already used and no TOTP secret in the state file; sign-in details are whatever was set then`);
        return;
      }
    }
    throw err;
  }
  const setup = accepted.twoStepSetup;
  if (!setup?.manualEntryKey) {
    owners[key] = { accountId: accepted.account.id, email: inv.email, name: inv.name, password: PASSWORD, accepted: true };
    ctx.state.save();
    ctx.log.created('owner', `${inv.name} (no authenticator step)`);
    return;
  }
  // keep the secret before confirming, so a failure here never loses it
  owners[key] = { accountId: accepted.account.id, email: inv.email, name: inv.name, password: PASSWORD, totpSecret: setup.manualEntryKey, otpauthUri: setup.otpauthUri ?? null, accepted: false };
  ctx.state.save();
  let lastErr;
  for (const offset of [0, 1, -1]) {
    try {
      const done = await ctx.api.post('/api/public/identity/invitations/two-step', v, { token: inv.token, setupId: setup.setupId, code: totp(setup.manualEntryKey, Date.now(), offset), device });
      owners[key].accepted = true;
      owners[key].recoveryCodes = done.recoveryCodes?.codes ?? [];
      ctx.state.save();
      ctx.log.created('owner', `${inv.name} accepted (password + authenticator)`);
      return;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ApiError) || err.code !== 'CODE_INVALID') throw err;
      await sleep(500);
    }
  }
  throw lastErr;
}

export async function ownersStep(ctx) {
  const invites = parseBootstrap(ctx.opts.bootstrapFile);
  for (const [key, o] of Object.entries(OWNERS)) {
    const inv = invites[o.email];
    const saved = ctx.state.section('owners')[key];
    if (!inv) {
      if (saved?.accountId) {
        ctx.log.reused('owner', `${o.name} (from the state file)`);
        continue;
      }
      throw new Error(`No invitation for ${o.email} in ${ctx.opts.bootstrapFile}. Run bootstrap-owner first (see tools/seed/README.md).`);
    }
    if (saved?.accountId && saved.accountId !== inv.accountId) {
      throw new Error(`${o.email}: the state file has account ${saved.accountId} but bootstrap-owner made ${inv.accountId}. The database was reset: delete web-shared/.seed/state.json and run the seed again.`);
    }
    await accept(ctx, key, inv);
  }
  // both are Business Owners now (roles activate on acceptance)
  for (const key of Object.keys(OWNERS)) {
    const o = ctx.owner(key);
    const me = await ctx.api.get('/api/admin/access/me', ctx.tokens.staff(o.accountId));
    const roles = JSON.stringify(me.roles ?? []);
    if (!roles.includes('business_owner')) ctx.log.warn(`${o.name}: Business Owner role not active (${roles.slice(0, 120)})`);
    else ctx.log.info(`${o.name}: Business Owner role active`);
  }
}
