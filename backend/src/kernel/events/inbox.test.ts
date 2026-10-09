import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../db/index.js';
import { migrate } from '../migrations/index.js';
import { moduleInbox } from './inbox.js';

let db: Database;
beforeAll(async () => {
  db = await createDatabase();
  await migrate(db, []);
});
afterAll(async () => {
  await db.close();
});

describe('inbox', () => {
  it('lets a module handle a key once; other modules keep their own claims', async () => {
    const orders = moduleInbox('orders');
    expect(await orders.claim(db.kysely, 'evt-1')).toBe(true);
    expect(await orders.claim(db.kysely, 'evt-1')).toBe(false);
    expect(await moduleInbox('finance').claim(db.kysely, 'evt-1')).toBe(true);
    expect(await orders.seen(db.kysely, 'evt-1')).toBe(true);
  });

  it('commits the claim with the effects: a failed attempt leaves the key free for the retry', async () => {
    const inbox = moduleInbox('customers');
    await expect(
      db.kysely.transaction().execute(async (trx) => {
        expect(await inbox.claim(trx, 'order-placed:1')).toBe(true);
        throw new Error('effect failed');
      }),
    ).rejects.toThrow('effect failed');
    expect(await inbox.seen(db.kysely, 'order-placed:1')).toBe(false);
    expect(await inbox.claim(db.kysely, 'order-placed:1')).toBe(true);
  });
});
