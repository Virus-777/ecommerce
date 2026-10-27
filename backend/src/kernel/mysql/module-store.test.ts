/**
 * `ModuleStore` against a real server (docs/10-mysql-migration.md §10.1, §10.6).
 *
 * Most of what this class promises is about *who sees what, and when*: a transaction's tables and its Kysely
 * handle must be on the same connection, a lock must make a second transaction wait, a claim must roll back
 * with the work it guarded. None of that can be seen from one connection, so the tests that matter here run
 * two at once and check which of them is held up.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnection } from 'mysql2/promise';
import { sql, type Generated } from 'kysely';
import { connectMysql, ModuleStore, type MysqlStore } from './index.js';
import { CLIENT_OPTIONS, startPortableMysql, type PortableMysql } from './portable.js';
import { toPageRequest } from '../lib/pagination.js';
import type { TableDef } from '../spec/define.js';

interface Item {
  id: number;
  name: string;
  n: number;
}

const ITEMS: TableDef = {
  table: 'demo_items',
  key: ['id'],
  idColumn: 'id',
  columns: ['id', 'name', 'n'],
  nullable: [],
  decimal: [],
  binary: [],
  dates: [],
  json: [],
  booleans: [],
  identity: 'id',
  uniqueKeys: [
    { name: 'PRIMARY', columns: ['id'] },
    { name: 'uq_demo_items_name', columns: ['name'] },
  ],
};

/** What the generator will write as `DemoTables`: Kysely sees these and nothing else */
interface DemoTables {
  demo_items: { id: Generated<number>; name: string; n: number };
}

let server: PortableMysql;
let store: MysqlStore;
let demo: ModuleStore<DemoTables>;

beforeAll(async () => {
  server = await startPortableMysql({ dataDir: join(tmpdir(), 'marketly-module-test'), port: 3392, forTests: true });
  const root = await createConnection({ host: '127.0.0.1', port: server.port, user: 'root', ...CLIENT_OPTIONS });
  await root.query('DROP DATABASE IF EXISTS modulecheck');
  await root.query('CREATE DATABASE modulecheck DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin');
  await root.end();

  store = await connectMysql({ url: `mysql://root@127.0.0.1:${server.port}/modulecheck`, poolSize: 6 });
  await store.createKernelTables();
  await store.pool.query(
    'CREATE TABLE `demo_items` (`id` BIGINT NOT NULL AUTO_INCREMENT, `name` VARCHAR(32) NOT NULL, `n` INT NOT NULL, ' +
      'PRIMARY KEY (`id`), UNIQUE KEY `uq_demo_items_name` (`name`)) ENGINE=InnoDB',
  );
  demo = store.module<DemoTables>('demo', { items: ITEMS });
}, 180_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
});

beforeEach(async () => {
  await store.pool.query('TRUNCATE TABLE `demo_items`');
  await store.pool.query('DELETE FROM `kernel_processed_events`');
  await store.pool.query('DELETE FROM `kernel_locks`');
  await store.pool.query('DELETE FROM `kernel_counters`');
});

describe('its tables', () => {
  it('hands out this module\'s tables and refuses anything else', () => {
    expect(demo.table<Item>('items').name).toBe('demo_items');
    expect(demo.table<Item>('items')).toBe(demo.table<Item>('items')); // one per name, not one per call
    expect(() => demo.table('orders')).toThrow(/demo has no table orders/);
  });

  it('runs a transaction\'s tables on the transaction\'s connection', async () => {
    const outside = demo.table<Item>('items');
    await store.transaction(async (tx) => {
      const inside = new ModuleStore<DemoTables>(store, 'demo', { items: ITEMS }, tx);
      await inside.table<Item>('items').insert({ name: 'a', n: 1 });
      expect(await inside.table<Item>('items').count()).toBe(1);
      // the pool-bound store is a different connection and must not see the uncommitted row
      expect(await outside.count()).toBe(0);
    });
    expect(await outside.count()).toBe(1);
  });

  it('undoes every table\'s writes when the transaction throws', async () => {
    await expect(
      demo.transaction(async (tx) => {
        await tx.table<Item>('items').insert({ name: 'a', n: 1 });
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(await demo.table<Item>('items').count()).toBe(0);
  });

  it('joins the transaction it is already in', async () => {
    await demo.transaction(async (tx) => {
      expect(tx.inTransaction).toBe(true);
      await tx.transaction(async (inner) => {
        expect(inner).toBe(tx); // the same one, not a second transaction that could deadlock with it
        await inner.table<Item>('items').insert({ name: 'a', n: 1 });
      });
    });
    expect(await demo.table<Item>('items').count()).toBe(1);
  });
});

describe('lock', () => {
  /**
   * Adds one with a plain read and a plain write — `updateMany`, not `update`, because `update` takes a
   * `FOR UPDATE` of its own and would be the thing keeping these apart. `gate` holds each transaction open
   * until both have begun, so they really do race; without it the first simply finished first and the test
   * passed whether or not the lock was there.
   */
  const addOne = async (gate: Promise<void>, name: string) =>
    demo.transaction(async (tx) => {
      await gate;
      await tx.lock(name);
      const row = await tx.table<Item>('items').findOne({ name: 'counter' });
      await tx.table<Item>('items').updateMany({ name: 'counter' }, { n: row!.n + 1 });
    });

  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeEach(async () => {
    await demo.table<Item>('items').insert({ name: 'counter', n: 0 });
  });

  it('holds the second transaction at the lock until the first commits', async () => {
    // the direct form: watch the second one wait. The counter test below is the consequence of this.
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));

    const first = demo.transaction(async (tx) => {
      await tx.lock('n');
      order.push('first locked');
      await held;
      order.push('first committing');
    });
    while (!order.length) await tick(5);

    const second = demo.transaction(async (tx) => {
      await tx.lock('n');
      order.push('second locked');
    });
    await tick(300);
    expect(order).toEqual(['first locked']); // the second is still waiting on the row the first wrote

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first locked', 'first committing', 'second locked']);
  });

  it('so an unlocked read and write around it is still safe', async () => {
    // both would read 0 and write 1; because the second waits at the lock, it reads 1 and writes 2
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const both = Promise.all([addOne(gate, 'counter'), addOne(gate, 'counter')]);
    await tick(50); // both are inside a transaction now
    open();
    await both;
    expect((await demo.table<Item>('items').findOne({ name: 'counter' }))!.n).toBe(2);
  });

  it('holds up only the transactions on the same name', async () => {
    // each waits for the other to have locked, so if two names blocked each other neither could finish
    let aLocked!: () => void;
    let bLocked!: () => void;
    const a = new Promise<void>((r) => (aLocked = r));
    const b = new Promise<void>((r) => (bLocked = r));
    await Promise.all([
      demo.transaction(async (tx) => {
        await tx.lock('one');
        aLocked();
        await b;
      }),
      demo.transaction(async (tx) => {
        await tx.lock('two');
        bLocked();
        await a;
      }),
    ]);
    const [rows] = await store.pool.query<any[]>('SELECT `name` FROM `kernel_locks` ORDER BY `name`');
    expect(rows.map((r) => r.name)).toEqual(['demo:one', 'demo:two']);
  });

  it('refuses to pretend outside a transaction', async () => {
    await expect(demo.lock('x')).rejects.toThrow(/lock\(x\) outside a transaction/);
  });
});

describe('claim and seen', () => {
  it('claims a key once', async () => {
    expect(await demo.seen('e-1')).toBe(false);
    expect(await demo.claim('e-1')).toBe(true);
    expect(await demo.claim('e-1')).toBe(false);
    expect(await demo.seen('e-1')).toBe(true);
  });

  it('is per module: the same key in two modules is two claims', async () => {
    const other = store.module('other', {});
    expect(await demo.claim('e-1')).toBe(true);
    expect(await other.claim('e-1')).toBe(true);
    expect(await other.seen('e-1')).toBe(true);
  });

  it('commits with the effects, and rolls back with them', async () => {
    // a failed attempt must leave the key free, or the retry would think it had already handled the event
    await expect(
      demo.transaction(async (tx) => {
        expect(await tx.claim('e-1')).toBe(true);
        await tx.table<Item>('items').insert({ name: 'from-event', n: 1 });
        throw new Error('the handler failed');
      }),
    ).rejects.toThrow('the handler failed');
    expect(await demo.seen('e-1')).toBe(false);
    expect(await demo.table<Item>('items').count()).toBe(0);

    await demo.transaction(async (tx) => {
      expect(await tx.claim('e-1')).toBe(true);
      await tx.table<Item>('items').insert({ name: 'from-event', n: 1 });
    });
    expect(await demo.seen('e-1')).toBe(true);
    expect(await demo.table<Item>('items').count()).toBe(1);
  });

  it('a second claim inside a transaction leaves the transaction standing', async () => {
    expect(await demo.claim('e-1')).toBe(true);
    await demo.transaction(async (tx) => {
      expect(await tx.claim('e-1')).toBe(false); // the duplicate fails the statement, not the transaction
      await tx.table<Item>('items').insert({ name: 'still-committed', n: 1 });
    });
    expect(await demo.table<Item>('items').count()).toBe(1);
  });
});

describe('counters', () => {
  it('numbers from this module\'s own counter', async () => {
    expect(await demo.nextValue('ref')).toBe(1);
    expect(await demo.nextValues('ref', 3)).toEqual([2, 3, 4]);
    expect(await store.module('other', {}).nextValue('ref')).toBe(1); // a different module, a different counter
    const [rows] = await store.pool.query<any[]>('SELECT `name` FROM `kernel_counters` ORDER BY `name`');
    expect(rows.map((r) => r.name)).toEqual(['demo.ref', 'other.ref']);
  });
});

describe('the Kysely handle', () => {
  it('reads what the tables wrote, under the session collation', async () => {
    await demo.table<Item>('items').insertMany([
      { name: 'a', n: 1 },
      { name: 'B', n: 2 },
    ]);
    const rows = await demo.db.selectFrom('demo_items').select(['name', 'n']).orderBy('name').execute();
    expect(rows).toEqual([{ name: 'B', n: 2 }, { name: 'a', n: 1 }]); // 0900_bin: capitals sort before lower case

    // The pool's session setup must reach the connections Kysely opens, or §5.2's rules quietly stop
    // applying to them. Asking once proves little — one connection has been set up by hand since
    // connectMysql's version check, and a reused connection would answer correctly either way. So ask on
    // more connections at a time than the pool holds set-up ones, and insist that every one agrees.
    const collations = await Promise.all(
      Array.from({ length: 6 }, () => sql<{ c: string }>`SELECT SLEEP(0.05), @@collation_connection AS c`.execute(demo.db).then((r) => r.rows[0]?.c)),
    );
    expect(collations).toEqual(Array.from({ length: 6 }, () => 'utf8mb4_0900_bin'));
  });

  it('runs inside the transaction, seeing its uncommitted rows', async () => {
    // this is what the one-connection pool is for: a second connection would see none of this
    await demo.transaction(async (tx) => {
      await tx.table<Item>('items').insert({ name: 'a', n: 1 });
      const seen = await tx.db.selectFrom('demo_items').select('name').execute();
      expect(seen.map((r) => r.name)).toEqual(['a']);
      expect(await demo.db.selectFrom('demo_items').select('name').execute()).toEqual([]);
    });
    expect(await demo.db.selectFrom('demo_items').select('name').execute()).toEqual([{ name: 'a' }]);
  });

  it('writes through the transaction and is undone with it', async () => {
    await expect(
      demo.transaction(async (tx) => {
        await tx.db.insertInto('demo_items').values({ name: 'a', n: 1 }).execute();
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(await demo.table<Item>('items').count()).toBe(0);
  });

  it('feeds pageQuery a compiled query, parameters and all', async () => {
    await demo.table<Item>('items').insertMany([
      { name: 'a', n: 5 },
      { name: 'b', n: 1 },
      { name: 'c', n: 9 },
    ]);
    const compiled = demo.db
      .selectFrom('demo_items')
      .selectAll()
      .select(sql<number>`\`n\` * ${10}`.as('rank'))
      .where('n', '>', 1)
      .compile();
    const page = await demo.table<Item>('items').pageQuery(compiled, toPageRequest({ limit: 10 }), { key: 'rank', direction: 'desc' });
    expect(page.items.map((r) => r.name)).toEqual(['c', 'a']);
    expect(page.items[0]).not.toHaveProperty('rank');
  });
});
