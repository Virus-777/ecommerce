/**
 * The partial-index condition language (docs/10 §6.1, Appendix A). The last test is the important one: it runs
 * every condition the spec actually uses through the parser, so "the language is closed" is a fact rather than a
 * claim. If someone adds a condition the translation cannot express, that test fails before the DDL is wrong.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCondition, partialKeyPart, q } from './mysql-where.js';

const at = 'test.t';

describe('condition forms', () => {
  it('reads IS NULL and IS NOT NULL', () => {
    expect(parseCondition('deleted_at is null', at).sql).toBe('`deleted_at` IS NULL');
    expect(parseCondition('approval_request_id is not null', at).sql).toBe('`approval_request_id` IS NOT NULL');
  });

  it('reads equality and inequality against a literal', () => {
    expect(parseCondition("status = 'active'", at).sql).toBe("`status` = 'active'");
    expect(parseCondition("status <> 'cancelled'", at).sql).toBe("`status` <> 'cancelled'");
  });

  it('reads a numeric comparison', () => {
    expect(parseCondition('results = 0', at).sql).toBe('`results` = 0');
  });

  it('reads IN lists', () => {
    expect(parseCondition("state in ('open','assigned')", at).sql).toBe("`state` IN ('open', 'assigned')");
  });

  it('reads a bare boolean column as true', () => {
    expect(parseCondition('active', at).sql).toBe('`active` = 1');
    expect(parseCondition('visible_to_seller', at).sql).toBe('`visible_to_seller` = 1');
  });

  it('reads a conjunction, and reports each column once in order', () => {
    const c = parseCondition("is_default and deleted_at is null", at);
    expect(c.sql).toBe('`is_default` = 1 AND `deleted_at` IS NULL');
    expect(c.columns).toEqual(['is_default', 'deleted_at']);
  });

  it('quotes a column that is a reserved word', () => {
    // `condition` and `open` are reserved; the output quotes every identifier so no word list can go stale
    expect(parseCondition("condition = 'new' and status <> 'removed'", at).sql).toBe("`condition` = 'new' AND `status` <> 'removed'");
    expect(parseCondition('open', at).sql).toBe('`open` = 1');
  });

  it('refuses a form it cannot express, naming the clause and the place', () => {
    expect(() => parseCondition("status = 'a' or status = 'b'", at)).toThrow(/test\.t.*cannot translate/);
    expect(() => parseCondition('amount > 0', at)).toThrow(/not one of/);
    expect(() => parseCondition('lower(email) = x', at)).toThrow(/cannot translate/);
  });

  it('refuses OR with advice, because a partial key cannot express it', () => {
    expect(() => parseCondition("a is null or b is null", at)).toThrow(/split it into two indexes|cannot translate/);
  });
});

describe('the functional key part', () => {
  it('wraps the first key column so rows outside the condition hold NULL', () => {
    const c = parseCondition("status = 'active'", at);
    expect(partialKeyPart(c, q('customer_id'))).toBe("(IF(`status` = 'active', `customer_id`, NULL))");
  });

  it('wraps a COALESCE expression just as well (nulls not distinct)', () => {
    const c = parseCondition("kind <> 'support'", at);
    expect(partialKeyPart(c, "(COALESCE(`kind`, ''))")).toBe("(IF(`kind` <> 'support', (COALESCE(`kind`, '')), NULL))");
  });
});

describe('every condition the spec uses', () => {
  it('is inside the language', () => {
    const dir = '../docs/api/spec/modules';
    const seen = new Set<string>();
    const failures: string[] = [];
    for (const f of readdirSync(dir)) {
      const mod = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      for (const t of mod.tables ?? []) {
        for (const index of t.indexes ?? []) {
          const m = /\bwhere\s+(.+)$/i.exec(String(index));
          if (!m) continue;
          const where = m[1]!.trim();
          seen.add(where);
          try {
            parseCondition(where, `${mod.name}.${t.name}`);
          } catch (err) {
            failures.push(`${mod.name}.${t.name}: ${(err as Error).message}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
    // a floor, not an exact count: it should notice if the spec's partial indexes vanish, not break when one is added
    expect(seen.size).toBeGreaterThanOrEqual(50);
  });
});
