// Step 1: the two Business Owners accept the staff invitations made by `npm run bootstrap-owner` (link + pass code +
// a new password; staff have no authenticator since 2026-10-14), then each signs in to the Admin Center with email
// and password, and their Business Owner roles are checked.
import { existsSync, readFileSync } from 'node:fs';
import { ApiError } from '../lib/http.mjs';
import { OWNERS, PASSWORD } from '../data.mjs';

const DEVICE = { kind: 'web', name: 'Marketly seed' };

/**
 * Parses the output of `npm run bootstrap-owner`, and of `npm run staff-link` appended to the same file:
 *   Invited Ana Lee <ana@example.com> as Business Owner (account <uuid>).
 *     Link: http://…/invitation#token=<t>
 *     Pass code: ABCD-EFGH
 *   New invitation link and pass code for ana@example.com (the previous ones no longer work). …
 *     Link: …
 *     Pass code: …
 * A later block for the same email replaces the link and pass code (and keeps the account id). Files written
 * before 2026-10-14 ("Accept link:", no pass code) still give the account ids.
 */
export function parseBootstrap(file) {
  if (!existsSync(file)) return {};
  const out = {};
  let cur = null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^Invited (.+?) <([^>]+)> as .*?\(account ([0-9a-f-]{36})\)/))) {
      cur = m[2].toLowerCase();
      out[cur] = { ...out[cur], name: m[1], email: cur, accountId: m[3], token: null, passCode: null };
    } else if ((m = line.match(/^New invitation link and pass code for (\S+?) \(/))) {
      cur = m[1].toLowerCase();
      out[cur] = { email: cur, ...out[cur], token: null, passCode: null };
    } else if (cur && (m = line.match(/^\s+(?:Accept link|Link): (\S+)/))) {
      out[cur].token = new URL(m[1]).hash.replace(/^#token=/, '');
    } else if (cur && (m = line.match(/^\s+Pass code: (\S+)/))) {
      out[cur].passCode = m[1];
    } else if (!/^\s/.test(line)) {
      cur = null; // any other message (a password reset link, the closing note)
    }
  }
  return out;
}

/** An Admin Center visitor session (every call needs a token; this is how the website starts one) */
async function adminVisitor(ctx) {
  const r = await ctx.api.req('POST', '/api/public/identity/app-sessions', { headers: { 'x-app-proof': 'dev' }, body: { audience: 'admin', device: DEVICE } });
  return r.body.accessToken;
}

/** Email + password sign-in to the Admin Center, as its sign-in page does; returns the result status */
async function signIn(ctx, email, password) {
  const r = await ctx.api.post('/api/public/identity/sessions', await adminVisitor(ctx), { email, password, audience: 'admin', keepSignedIn: false, device: DEVICE });
  return r.status;
}

async function accept(ctx, key, inv) {
  const owners = ctx.state.section('owners');
  const saved = owners[key] ?? {};
  if (saved.accepted && saved.accountId === inv.accountId) {
    ctx.log.reused('owner', `${inv.name} (accepted earlier)`);
    return;
  }
  const relink = `npm run staff-link -- --email ${inv.email} >> ${ctx.opts.bootstrapFile}  (in the backend folder, server stopped or not)`;
  if (!inv.token || !inv.passCode) throw new Error(`${inv.email}: no link or pass code in ${ctx.opts.bootstrapFile}. Get new ones: ${relink}`);
  try {
    const r = await ctx.api.post('/api/public/identity/invitations/accept', await adminVisitor(ctx), { token: inv.token, passCode: inv.passCode, password: PASSWORD, device: DEVICE });
    owners[key] = { accountId: r.account?.id ?? inv.accountId, email: inv.email, name: inv.name, password: PASSWORD, accepted: true };
    ctx.state.save();
    ctx.log.created('owner', `${inv.name} accepted the invitation (pass code + password)`);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    // used before, without this state file: fine if the seed's password signs in
    const status = await signIn(ctx, inv.email, PASSWORD).catch(() => null);
    if (status === 'signed_in') {
      owners[key] = { ...saved, accountId: inv.accountId, email: inv.email, name: inv.name, password: PASSWORD, accepted: true };
      ctx.state.save();
      ctx.log.warn(`${inv.name}: invitation not accepted (${err.code}), but the account signs in with the seed's password`);
      return;
    }
    throw new Error(`${inv.email}: invitation not accepted (${err.message}). A wrong or used pass code or an expired link needs new ones: ${relink}`);
  }
}

export async function ownersStep(ctx) {
  const invites = parseBootstrap(ctx.opts.bootstrapFile);
  for (const [key, o] of Object.entries(OWNERS)) {
    const inv = invites[o.email];
    const saved = ctx.state.section('owners')[key];
    if (!inv?.accountId) {
      if (saved?.accountId) {
        ctx.log.reused('owner', `${o.name} (from the state file)`);
        continue;
      }
      throw new Error(`No invitation for ${o.email} in ${ctx.opts.bootstrapFile}. Run bootstrap-owner first (see tools/seed/README.md).`);
    }
    if (saved?.accountId && saved.accountId !== inv.accountId) {
      throw new Error(`${o.email}: the state file has account ${saved.accountId} but bootstrap-owner made ${inv.accountId}. The database was reset: delete web-shared/.seed/state.json and run the seed again.`);
    }
    await accept(ctx, key, { ...inv, name: inv.name ?? o.name });
  }
  for (const key of Object.keys(OWNERS)) {
    const o = ctx.owner(key);
    // the real sign-in: email and password, no second step for staff
    const status = await signIn(ctx, o.email ?? OWNERS[key].email, o.password ?? PASSWORD);
    if (status !== 'signed_in') throw new Error(`${o.name}: Admin Center sign-in answered ${status}, expected signed_in`);
    ctx.log.info(`${o.name}: signs in to the Admin Center with email and password`);
    // later steps act as these accounts with dev staff tokens, so approval limits and two-person rules apply
    const me = await ctx.api.get('/api/admin/access/me', ctx.tokens.staff(o.accountId));
    const roles = JSON.stringify(me.roles ?? []);
    if (!roles.includes('business_owner')) ctx.log.warn(`${o.name}: Business Owner role not active (${roles.slice(0, 120)})`);
    else ctx.log.info(`${o.name}: Business Owner role active`);
  }
}
