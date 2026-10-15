/**
 * Wave 2 (BACKEND-REQUESTS.md): statements by ST- ref (G46), SKUs on statement lines (G47a), the finance overview
 * export rows (G72) and the development read of test-deposit amounts (G11).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, boot, SELLER, USD, type Kit } from './helpers.js';

let k: Kit;
const S = newId();
beforeAll(async () => {
  k = await boot();
});
afterAll(async () => {
  await k?.close();
});

describe('statements (G46, G47a)', () => {
  it('opens a statement by its ST- ref for the seller and staff; other sellers get 404', async () => {
    const open = await k.svc.statements.openStatement(S);
    expect(open?.ref).toMatch(/^ST-/);
    const seller = await k.call('GET', `${SELLER}/statements/${open!.ref}`, k.sellerToken(S));
    expect(seller.status, JSON.stringify(seller.body)).toBe(200);
    expect(seller.body).toMatchObject({ id: open!.id, ref: open!.ref });
    expect((await k.call('GET', `${ADMIN}/statements/${open!.ref}`, k.staff)).body.id).toBe(open!.id);
    expect((await k.call('GET', `${SELLER}/statements/${open!.ref}`, k.sellerToken(newId()))).status).toBe(404);
    expect((await k.call('GET', `${SELLER}/statements/nonsense`, k.sellerToken(S))).status).toBe(404);
  });

  it('puts the seller SKU of the order item on its lines', async () => {
    const order = k.order(S, [{ title: 'Pocket speaker', quantity: 1, price: 5900, sku: 'NW-SPK-01' }, { title: 'Cable', quantity: 1, price: 900 }]);
    await k.accept(order);
    const entries = await k.svc.core.repo.find('ledger_entries', { seller_id: S });
    const built = await k.svc.statements.build(entries);
    const sales = built.sections.find((s) => s.key === 'sales')!.lines;
    expect(sales.map((l) => [l.amount.amount, l.sku])).toEqual(expect.arrayContaining([[5900, 'NW-SPK-01'], [900, null]]));
    const fee = built.sections.find((s) => s.key === 'fees')!.lines.find((l) => l.amount.amount === -590);
    expect(fee?.sku).toBe('NW-SPK-01');
  });
});

describe('finance overview export (G72)', () => {
  it('answers one row per figure for the range', async () => {
    const today = k.svc.core.today();
    const { rows } = await k.svc.exportRows('finance.admin.overview', { from: today, to: today }, { kind: 'staff', accountId: newId() } as never);
    expect(rows[0]).toMatchObject({ figure: expect.stringContaining(`Range ${today} to ${today}`) });
    expect(rows).toContainEqual(expect.objectContaining({ figure: 'Seller sales', value: expect.stringMatching(/^-?\d+\.\d{2}$/) }));
    await expect(k.svc.exportRows('finance.admin.overview', {}, { kind: 'seller', sellerId: S, accountId: newId() } as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('test-deposit amounts in development (G11)', () => {
  it('reads the amounts the development provider sent to the destination waiting for confirmation', async () => {
    const sellerId = newId();
    expect(await k.svc.destinations.devTestDeposits(sellerId)).toBeNull();
    const providerDestinationId = `dest_${sellerId.slice(0, 8)}`;
    await k.emit('sellers.payout_account.changed', { sellerId, changeId: newId(), providerDestinationId, label: 'First Bank •••• 1111', accountHolderName: 'Store LLC', accountType: 'business_checking', previousLabel: null, isInitial: true, requestedBy: { kind: 'seller', id: newId() } });
    const deposits = await k.svc.destinations.devTestDeposits(sellerId);
    expect(deposits).toMatchObject({ sellerId, label: 'First Bank •••• 1111', amounts: k.provider.testDepositsFor(providerDestinationId).map(USD) });
    const ok = await k.call('POST', `${SELLER}/payout-destination/confirm-deposits`, k.sellerToken(sellerId), { amounts: deposits!.amounts });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await k.svc.destinations.devTestDeposits(sellerId)).toBeNull();
  });
});
