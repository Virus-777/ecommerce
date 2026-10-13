// Step 8: customers through the dev Google sign-in (verified accounts without a password; see README), with
// profile phone, saved addresses (Jordan: Home default + Work) and marketing consent.
import { CUSTOMERS } from '../data.mjs';

export async function customersStep(ctx) {
  const { api, log } = ctx;
  const saved = ctx.state.section('customers');
  for (const c of CUSTOMERS) {
    saved[c.key] ??= {};
    const r = saved[c.key];
    if (!r.accountId) {
      r.accountId = await ctx.externalAccount(c.email, c.first, c.last, Boolean(c.marketing?.emailPromotions));
      r.email = c.email;
      ctx.state.save();
      log.created('customer', `${c.first} ${c.last} <${c.email}>`);
    }
    const t = ctx.tokens.customer(r.accountId);
    if (!r.profile) {
      await api.patch('/api/store/customers/profile', t, { firstName: c.first, lastName: c.last, phone: c.phone });
      if (c.marketing) await api.put('/api/store/customers/marketing-preferences', t, { ...c.marketing, source: 'profile' });
      r.profile = true;
      ctx.state.save();
    }
    r.addresses ??= {};
    const existing = await api.get('/api/store/customers/addresses', t);
    for (const a of c.addresses) {
      const match = existing.find((x) => x.address.line1 === a.address.line1 && x.address.postalCode === a.address.postalCode);
      if (match) {
        r.addresses[a.key] = match.id;
        continue;
      }
      const created = await api.post('/api/store/customers/addresses', t, { label: a.label, address: a.address, makeDefault: a.makeDefault });
      r.addresses[a.key] = created.id;
      log.created('address', `${c.first} ${c.last}: ${a.label}, ${a.address.line1}, ${a.address.city} ${a.address.postalCode}`);
    }
    ctx.state.save();
  }
}
