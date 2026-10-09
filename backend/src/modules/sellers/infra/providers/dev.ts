/**
 * Deterministic development adapters (no network):
 *   verification: passes unless the subject says otherwise — a legal name containing "fail" fails every
 *     check, "attention" makes them need attention, a tax id ending 0000 fails the tax id match, an owner
 *     without an ID document needs attention, a payout holder that matches no owner or legal name needs attention;
 *   payouts: account numbers ending 0002 are refused by the provider; tokens are a hash of the numbers;
 *   addresses: PO boxes need attention, everything else passes.
 */
import { createHash } from 'node:crypto';
import { newId } from '../../../../kernel/lib/ids.js';
import { isPoBox } from '../../domain/rules.js';
import type { AddressVerifier, CheckKind, CheckResult, CheckSubject, PayoutTokenizer, SellersProviders, VerificationProvider } from '../../ports.js';

const LABEL: Record<CheckKind, string> = {
  identity: 'Owner identity',
  business_registration: 'Business registration',
  tax_id: 'Tax id match',
  payout_account: 'Payout account name match',
  return_address: 'Return address',
  sanctions: 'Sanctions screening',
};

export const devAddressVerifier: AddressVerifier = {
  async verify(address) {
    if (isPoBox(address)) return { result: 'needs_attention', summary: 'PO boxes cannot receive returns; a street address is needed' };
    return { result: 'passed', summary: `Street address found: ${address.line1}, ${address.city}, ${address.region} ${address.postalCode}` };
  },
};

export const devVerificationProvider: VerificationProvider = {
  name: 'dev-kyc',
  async submit(kind, s: CheckSubject) {
    const providerRef = `dev-${kind}-${newId()}`;
    const name = (s.legalName ?? '').toLowerCase();
    const say = (result: CheckResult, summary: string) => ({ providerRef, result, summary });
    if (name.includes('fail')) return say('failed', `${LABEL[kind]}: no match found`);
    if (name.includes('attention')) return say('needs_attention', `${LABEL[kind]}: partial match, review the documents`);
    switch (kind) {
      case 'identity':
        if (!s.owners.length) return say('needs_attention', 'No owners listed');
        if (s.owners.some((o) => o.documentCount === 0)) return say('needs_attention', 'An owner has no ID document');
        return say('passed', `Photo ID matched for ${s.owners.map((o) => o.name).join(', ')}`);
      case 'business_registration':
        return say('passed', `${s.legalName ?? 'Business'} found in the ${s.stateOfRegistration ?? 'state'} registry${s.registryNumber ? ` (${s.registryNumber})` : ''}`);
      case 'tax_id':
        if (s.taxIdLast4 === '0000') return say('failed', 'The tax id does not match the legal name');
        return say('passed', `${(s.taxIdType ?? 'Tax id').toUpperCase()} ending ${s.taxIdLast4 ?? '????'} matches the legal name`);
      case 'payout_account':
        if (s.payoutHolderMatches === false) return say('needs_attention', `Account holder ${s.payoutHolder ?? ''} matches neither the legal name nor an owner`);
        return say('passed', `Account holder ${s.payoutHolder ?? ''} matches`);
      case 'return_address':
        if (!s.returnAddress) return say('needs_attention', 'No return address given');
        return { providerRef, ...(await devAddressVerifier.verify(s.returnAddress)) };
      case 'sanctions':
        return say('passed', 'No sanctions or watch-list matches');
    }
  },
};

export const devPayoutTokenizer: PayoutTokenizer = {
  async tokenize(input) {
    if (input.accountNumber.trim().endsWith('0002')) return { ok: false, reason: 'The bank refused this account' };
    const token = createHash('sha256').update(`${input.routingNumber.trim()}:${input.accountNumber.trim()}`).digest('hex').slice(0, 24);
    return { ok: true, providerDestinationId: `pd_dev_${token}` };
  },
};

export const devProviders: SellersProviders = { verification: devVerificationProvider, payouts: devPayoutTokenizer, addresses: devAddressVerifier };
