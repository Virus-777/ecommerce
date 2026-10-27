/**
 * The view half of the generator (docs/10-mysql-migration.md §9.1–9.2).
 *
 * The server has the last word — migrate asks it whether it could merge each view and refuses one it could not —
 * but that answer is MySQL warning 1354, "View merge algorithm can't be used here for now", which names neither
 * the view nor what is wrong with it. These checks run with no server and say which word did it.
 */
import { describe, expect, it } from 'vitest';
import { moduleViews, viewName } from './mysql.js';
import type { ModuleSpec, ViewSpec } from './spec.js';

const spec = (views: ViewSpec[], tables = ['orders', 'seller_groups']): ModuleSpec =>
  ({ name: 'orders', tables: tables.map((name) => ({ name, columns: {} })), views }) as unknown as ModuleSpec;

const view = (sql: string): ViewSpec => ({ name: 'rows', desc: 'test', sql });

describe('a view is a join shape', () => {
  it('becomes CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER, named <module>_v_<name>', () => {
    const { views, problems } = moduleViews(spec([view('SELECT g.* FROM orders_seller_groups g JOIN orders_orders o ON o.id = g.order_id')]));
    expect(problems).toEqual([]);
    expect(views).toHaveLength(1);
    expect(views[0]!.name).toBe('orders_v_rows');
    expect(views[0]!.ddl).toBe(
      'CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW `orders_v_rows` AS SELECT g.* FROM orders_seller_groups g JOIN orders_orders o ON o.id = g.order_id',
    );
  });

  it('keeps a multi-line definition on its own lines, and drops a trailing semicolon', () => {
    const { views } = moduleViews(spec([view('SELECT *\nFROM orders_orders;\n')]));
    expect(views[0]!.ddl).toBe('CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW `orders_v_rows` AS\nSELECT *\nFROM orders_orders');
  });

  it('is prefixed with the module, with dashes replaced', () => {
    expect(viewName('fulfillment-service', 'inbound_rows')).toBe('fulfillment_service_v_inbound_rows');
  });
});

describe('what it may not do', () => {
  // each of these makes MySQL build a temporary table on every read, which is the one thing §9.1 says views are
  // not for. Proved against 8.4.13 on 2026-10-28: every one of them warns 1354 at CREATE
  const refused: [string, string][] = [
    ['GROUP BY', 'SELECT seller_id, order_id FROM orders_seller_groups GROUP BY seller_id, order_id'],
    ['HAVING', 'SELECT seller_id FROM orders_seller_groups HAVING seller_id IS NOT NULL'],
    ['DISTINCT', 'SELECT DISTINCT seller_id FROM orders_seller_groups'],
    ['UNION', 'SELECT id FROM orders_orders UNION SELECT id FROM orders_seller_groups'],
    ['LIMIT', 'SELECT id FROM orders_orders LIMIT 100'],
    ['an aggregate', 'SELECT MAX(placed_at) last_placed FROM orders_orders'],
    ['a window function', 'SELECT id, ROW_NUMBER() OVER (ORDER BY placed_at) rn FROM orders_orders'],
  ];

  for (const [what, sql] of refused) {
    it(`refuses ${what}, and says so`, () => {
      const { problems } = moduleViews(spec([view(sql)]));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`orders view rows: ${what} keeps MySQL from merging`);
      expect(problems[0]).toContain('summary table');
    });
  }

  it('refuses a view that reads another module, and names the table', () => {
    const { problems } = moduleViews(spec([view('SELECT o.id, c.email FROM orders_orders o JOIN customers_customers c ON c.id = o.customer_id')]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('reads customers_customers');
    expect(problems[0]).toContain("not this module's");
  });

  it('counts every table it reads, not just the first', () => {
    const { problems } = moduleViews(
      spec([view('SELECT * FROM orders_orders o JOIN payments_intents p ON p.order_id = o.id JOIN wallet_entries w ON w.order_id = o.id')]),
    );
    expect(problems[0]).toContain('reads payments_intents, wallet_entries');
    expect(problems[0]).toContain('are not this module');
  });

  it('says both things about a view that is wrong twice', () => {
    const { problems } = moduleViews(spec([view('SELECT DISTINCT c.id FROM customers_customers c')]));
    expect(problems).toHaveLength(2);
  });
});
