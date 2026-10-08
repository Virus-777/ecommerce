import { describe, expect, it } from 'vitest';
import { allSpecs, specOf } from '../module-system/loader.js';
import { EventBus, moduleEvents, type EventEnvelope } from './index.js';

const merged = { keptProductId: '0190f5a0-0000-7000-8000-000000000001', duplicateProductId: '0190f5a0-0000-7000-8000-000000000002', reason: 'Same GTIN' };
const silent = { debug() {}, error() {}, warn() {}, info() {}, child() {} } as never;

function bus() {
  const b = new EventBus(silent, { validatePayloads: true });
  b.registerSpecs(Object.values(allSpecs));
  return b;
}

describe('event bus', () => {
  it('delivers spec events to the modules that consume them', async () => {
    const b = bus();
    const got: EventEnvelope[] = [];
    moduleEvents(b, specOf('wishlist')!).on('catalog.product.merged', (e) => void got.push(e));
    const sent = moduleEvents(b, specOf('catalog')!).publish('catalog.product.merged', merged);
    await b.drain();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: sent.id, name: 'catalog.product.merged', source: 'catalog' });
  });

  it('refuses payloads that do not match the spec', () => {
    const catalog = moduleEvents(bus(), specOf('catalog')!);
    expect(() => catalog.publish('catalog.product.merged', { wrong: true } as never)).toThrow(/does not match the spec/);
  });

  it('keeps modules to the events their spec declares', () => {
    const cart = moduleEvents(bus(), specOf('cart')!);
    expect(() => cart.publish('orders.order.placed' as never, {} as never)).toThrow(/not in its spec events.publishes/);
    expect(() => cart.on('finance.payout.sent' as never, () => {})).toThrow(/not in its spec events.consumes/);
  });

  it('never fails the publisher when a subscriber fails', async () => {
    const b = bus();
    b.subscribe('x', 'catalog.product.merged', () => {
      throw new Error('boom');
    });
    expect(() => b.publish('catalog', 'catalog.product.merged', merged)).not.toThrow();
    await b.drain();
  });
});
