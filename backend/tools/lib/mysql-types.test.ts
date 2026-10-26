/**
 * Spec type → MySQL type (docs/10-mysql-migration.md §5.1–5.2). As with the condition language, the test that
 * matters runs the whole spec through the mapper: 471 tables and 5,603 columns either all map or the generator
 * cannot run, and this says which it is before any DDL is emitted.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collationOf, columnDdl, checksOf, mysqlType } from './mysql-types.js';
import { parseColumn, type Column } from './tables.js';

const col = (notation: string, name = 'c'): Column => parseColumn(name, notation, 'test.t.c', []);
const type = (notation: string, indexed = false, name = 'c') => mysqlType(col(notation, name), { indexed, at: 'test.t.c' });

describe('column types', () => {
  it('maps ids and codes to ascii, so their keys are a quarter of the size', () => {
    expect(type('uuid pk')).toBe('CHAR(36) CHARACTER SET ascii COLLATE ascii_bin');
    expect(type('char(3)')).toBe('CHAR(3) CHARACTER SET ascii COLLATE ascii_bin');
    expect(type('inet?')).toBe('VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin');
  });

  it('sizes text by whether it is indexed', () => {
    expect(type('text', false)).toBe('TEXT');
    expect(type('text', true)).toBe('VARCHAR(255)');
    expect(type('varchar(120)')).toBe('VARCHAR(120)');
    expect(type('mediumtext')).toBe('MEDIUMTEXT');
    expect(type('longtext')).toBe('LONGTEXT');
  });

  it('sizes an enum to its longest value, never below 32', () => {
    expect(type('text (open|closed)')).toBe('VARCHAR(32)');
    const long = 'a_very_long_enum_value_beyond_thirty_two_chars';
    expect(type(`text (${long}|b)`)).toBe(`VARCHAR(${long.length})`);
  });

  it('keeps money and quantities exact, and dates to the millisecond', () => {
    expect(type('numeric(12,2)')).toBe('DECIMAL(12,2)');
    expect(type('int')).toBe('INT');
    expect(type('bigint')).toBe('BIGINT');
    expect(type('bool')).toBe('TINYINT(1)');
    expect(type('date')).toBe('DATE');
    expect(type('time')).toBe('TIME');
    expect(type('timestamptz')).toBe('DATETIME(3)'); // not TIMESTAMP: that stops in 2038
    expect(type('jsonb')).toBe('JSON');
  });

  it('maps an array column to JSON (§8.1)', () => {
    expect(type('text[]')).toBe('JSON');
    expect(type('uuid[]')).toBe('JSON');
  });

  it('splits bytea by what it holds, and refuses to guess', () => {
    expect(type('bytea', false, 'hash')).toBe('BINARY(32)');
    expect(type('bytea', false, 'prev_hash')).toBe('BINARY(32)');
    expect(type('bytea?', false, 'secret_encrypted')).toBe('BLOB');
    expect(() => type('bytea', false, 'blob_of_something')).toThrow(/neither a \*hash.*nor \*_encrypted/);
  });

  it('refuses what it cannot size or store', () => {
    expect(() => type('varchar')).toThrow(/needs a length/);
    expect(() => type('numeric')).toThrow(/needs precision and scale/);
    expect(() => type('mediumtext', true)).toThrow(/cannot be indexed whole/);
    expect(() => type('varchar(900)', true)).toThrow(/3,072-byte key limit/);
    expect(() => columnDdl(col('tsvector'), { indexed: false, at: 'test.t.c' })).toThrow(/not stored/);
  });
});

describe('collation (§5.2)', () => {
  it('leaves a plain text column on the table default, which is utf8mb4_0900_bin', () => {
    expect(collationOf(col('text'))).toBe('');
  });

  it('marks a ci column as_ci: case-insensitive but still accent-sensitive', () => {
    expect(collationOf(col('text ci'))).toBe(' COLLATE utf8mb4_0900_as_ci');
  });

  it('says nothing for a column that is already ascii or not text', () => {
    for (const n of ['uuid', 'char(3)', 'inet', 'int', 'jsonb', 'timestamptz']) expect(collationOf(col(n))).toBe('');
  });
});

describe('column lines and checks', () => {
  it('writes nullability and auto-increment', () => {
    expect(columnDdl(col('uuid pk'), { indexed: true, at: 'x' })).toBe('`c` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL');
    expect(columnDdl(col('text?'), { indexed: false, at: 'x' })).toBe('`c` TEXT NULL');
    expect(columnDdl(col('text ci'), { indexed: true, at: 'x' })).toBe('`c` VARCHAR(255) COLLATE utf8mb4_0900_as_ci NOT NULL');
    expect(columnDdl(col('bigint (identity)'), { indexed: false, at: 'x' })).toBe('`c` BIGINT NOT NULL AUTO_INCREMENT');
  });

  it('turns an enum into a CHECK rather than MySQL ENUM (§6.1)', () => {
    const checks = checksOf(col('text (open|closed)'), 'things');
    expect(checks).toEqual([{ name: 'ck_things_c', sql: "`c` IN ('open', 'closed')" }]);
  });

  it('keeps a range check from the spec', () => {
    expect(checksOf(col('int check >= 0'), 'things')[0]!.sql).toBe('`c` >= 0');
  });
});

describe('the whole spec', () => {
  it('maps every column of every table', () => {
    const dir = '../docs/api/spec/modules';
    const failures: string[] = [];
    let columns = 0;
    let tables = 0;
    for (const f of readdirSync(dir)) {
      const mod = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      for (const t of mod.tables ?? []) {
        tables++;
        // a column counts as indexed when any index names it, which is what decides a text column's size
        const indexed = new Set<string>();
        for (const i of t.indexes ?? []) for (const m of String(i).matchAll(/[a-z_][a-z0-9_]+/g)) indexed.add(m[0]);
        for (const [name, notation] of Object.entries(t.columns ?? {})) {
          columns++;
          const at = `${mod.name}.${t.name}.${name}`;
          const parsed = parseColumn(name, String(notation), at, []);
          if (parsed.sqlType.startsWith('tsvector')) continue; // not stored
          try {
            columnDdl(parsed, { indexed: indexed.has(name) || parsed.unique || parsed.pk, at });
          } catch (err) {
            failures.push((err as Error).message);
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(tables).toBeGreaterThanOrEqual(471);
    expect(columns).toBeGreaterThanOrEqual(5600);
  });
});
