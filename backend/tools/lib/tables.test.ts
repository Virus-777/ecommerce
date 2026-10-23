/**
 * The table notation of docs/api/spec/FORMAT.md, as lib/tables.ts reads it. The MySQL generator of Y1 reads the
 * same parse (docs/10-mysql-migration.md §17.1), so the notation is a contract and has a test of its own.
 */
import { describe, expect, it } from 'vitest';
import { parseColumn } from './tables.js';

/** parseColumn with a throwaway problem list; `problems` is asserted where it matters */
const col = (notation: string, name = 'c') => {
  const problems: string[] = [];
  return { c: parseColumn(name, notation, 'test.t.c', problems), problems };
};

describe('column notation', () => {
  it('reads the plain forms', () => {
    expect(col('uuid pk').c).toMatchObject({ sqlType: 'uuid', pk: true, nullable: false, unique: false });
    expect(col('text?').c).toMatchObject({ sqlType: 'text', nullable: true });
    expect(col('numeric(12,2)').c).toMatchObject({ sqlType: 'numeric(12,2)' });
    expect(col('int check >= 0').c.check).toBe('c >= 0');
    expect(col('text (open|closed)').c.enumValues).toEqual(['open', 'closed']);
    expect(col('text (MK-YYMMDD-NNNNN)').c).toMatchObject({ enumValues: null, comment: 'MK-YYMMDD-NNNNN' });
  });

  it('reads the text sizes', () => {
    expect(col('varchar(120)').c.sqlType).toBe('varchar(120)');
    expect(col('mediumtext?').c).toMatchObject({ sqlType: 'mediumtext', nullable: true });
    expect(col('longtext').c.sqlType).toBe('longtext');
    for (const n of ['varchar(120)', 'mediumtext', 'longtext']) expect(col(n).problems).toEqual([]);
  });

  it('reads ci, on its own and beside other flags', () => {
    expect(col('text ci').c.caseInsensitive).toBe(true);
    expect(col('text unique ci').c).toMatchObject({ unique: true, caseInsensitive: true });
    expect(col('text ci unique').c).toMatchObject({ unique: true, caseInsensitive: true });
    expect(col('text').c.caseInsensitive).toBe(false);
    expect(col('text ci').problems).toEqual([]);
  });

  it('defaults a reference to restrict, and reads cascade and nofk', () => {
    expect(col('uuid → orders').c).toMatchObject({ ref: 'orders', refOption: 'restrict' });
    expect(col('uuid → orders cascade').c).toMatchObject({ ref: 'orders', refOption: 'cascade' });
    expect(col('uuid? → stock_items nofk').c).toMatchObject({ ref: 'stock_items', refOption: 'nofk', nullable: true });
    for (const n of ['uuid → orders cascade', 'uuid? → stock_items nofk']) expect(col(n).problems).toEqual([]);
  });

  it('does not let a check expression swallow a flag after it', () => {
    // `check` runs to the end of the notation, so it is stripped last
    const { c, problems } = col('int check >= 0');
    expect(c.check).toBe('c >= 0');
    expect(problems).toEqual([]);
  });

  it('reports a flag it does not know, rather than ignoring it', () => {
    expect(col('text wat').problems).toEqual(['test.t.c: unknown column flags "wat" in "text wat"']);
  });

  it('reports a cascade or nofk with nothing to point at', () => {
    // no `→ table`, so there is no key for the option to belong to
    expect(col('uuid cascade').problems.join(' ')).toContain('unknown column flags');
  });

  it('keeps the other comment forms working beside the new flags', () => {
    expect(col('bigint (identity)').c.identity).toBe(true);
    expect(col('uuid pk (1)').c.check).toBe('c = 1');
    expect(col('text ci (a|b)').c).toMatchObject({ caseInsensitive: true, enumValues: ['a', 'b'] });
  });
});
