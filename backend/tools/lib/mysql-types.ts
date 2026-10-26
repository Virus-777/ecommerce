/**
 * Spec column type → MySQL column definition (docs/10-mysql-migration.md §5.1–5.2).
 *
 * Two rules decide a column's text size and collation, and both are deliberate:
 *
 * - **size**: the spec may say `varchar(n)`, `mediumtext` or `longtext`. Otherwise an indexed or enum column
 *   becomes `VARCHAR(255)` — short enough that a key fits InnoDB's 3,072-byte limit with utf8mb4's 4 bytes per
 *   character — and anything else becomes `TEXT`, which lives off the row page and costs nothing when unused.
 * - **collation**: `utf8mb4_0900_bin` everywhere by default, so unique keys and sorts compare as MongoDB does
 *   (§5.2); `ci` columns get `utf8mb4_0900_as_ci`; ids, codes and addresses are `ascii` because they cannot
 *   contain anything else and a 1-byte charset makes their keys four times smaller.
 */
import type { Column } from './tables.js';
import { q } from './mysql-where.js';

/** utf8mb4 is 4 bytes per character, and an InnoDB key may be 3,072 bytes */
export const MAX_INDEXED_CHARS = 768;
export const DEFAULT_INDEXED_TEXT = 255;

const ASCII = 'CHARACTER SET ascii COLLATE ascii_bin';

/** A column type as MySQL, without the NULL/DEFAULT parts */
export function mysqlType(c: Column, o: { indexed: boolean; at: string }): string {
  const base = c.sqlType.replace(/\(.*\)/, '').replace(/\[\]$/, '');
  const isArray = c.sqlType.endsWith('[]');
  const size = /\((\d+(?:,\d+)?)\)/.exec(c.sqlType)?.[1];

  if (isArray) return 'JSON'; // §8.1: a JSON array, with a multi-valued index where it is queried
  switch (base) {
    case 'uuid':
      return `CHAR(36) ${ASCII}`;
    case 'char':
      if (!size) throw new Error(`${o.at}: char needs a length, e.g. char(3)`);
      return `CHAR(${size}) ${ASCII}`;
    case 'inet':
      return `VARCHAR(45) ${ASCII}`;
    case 'varchar': {
      if (!size) throw new Error(`${o.at}: varchar needs a length, e.g. varchar(120)`);
      if (o.indexed && Number(size) > MAX_INDEXED_CHARS) {
        throw new Error(`${o.at}: varchar(${size}) is indexed, and ${size} utf8mb4 characters exceed InnoDB's 3,072-byte key limit (max ${MAX_INDEXED_CHARS})`);
      }
      return `VARCHAR(${size})`;
    }
    case 'mediumtext':
      if (o.indexed) throw new Error(`${o.at}: a mediumtext column cannot be indexed whole; give it a varchar(n) size or a FULLTEXT index`);
      return 'MEDIUMTEXT';
    case 'longtext':
      if (o.indexed) throw new Error(`${o.at}: a longtext column cannot be indexed whole; give it a varchar(n) size or a FULLTEXT index`);
      return 'LONGTEXT';
    case 'text':
      // an enum is short by nature; §6.1 keeps enums as VARCHAR with a CHECK rather than MySQL's ENUM type
      if (c.enumValues) return `VARCHAR(${Math.max(32, ...c.enumValues.map((v) => v.length))})`;
      return o.indexed ? `VARCHAR(${DEFAULT_INDEXED_TEXT})` : 'TEXT';
    case 'int':
    case 'integer':
      return 'INT';
    case 'smallint':
      return 'SMALLINT';
    case 'bigint':
    case 'bigserial':
    case 'serial':
      return 'BIGINT';
    case 'numeric':
      if (!size || !size.includes(',')) throw new Error(`${o.at}: numeric needs precision and scale, e.g. numeric(12,2)`);
      return `DECIMAL(${size})`;
    case 'bool':
    case 'boolean':
      return 'TINYINT(1)';
    case 'date':
      return 'DATE';
    case 'time':
      return 'TIME';
    case 'timestamptz':
    case 'timestamp':
      // not TIMESTAMP, which stops in 2038; (3) matches the millisecond precision of a MongoDB date (§5.1)
      return 'DATETIME(3)';
    case 'jsonb':
    case 'json':
      return 'JSON';
    case 'bytea':
      // §5.1: a hash is fixed-width, an encrypted value is not. Anything else is a decision, not a default
      if (/(^|_)(hash|prev_hash)$/.test(c.name)) return 'BINARY(32)';
      if (/_encrypted$/.test(c.name)) return 'BLOB';
      throw new Error(
        `${o.at}: bytea column "${c.name}" is neither a *hash (BINARY(32)) nor *_encrypted (BLOB). ` +
          `Decide its MySQL type in docs/10 §5.1 and add the rule here rather than letting it default.`,
      );
    default:
      throw new Error(`${o.at}: no MySQL type for spec type "${c.sqlType}"`);
  }
}

/** The collation clause a text column needs, or '' when the table default is right */
export function collationOf(c: Column): string {
  const base = c.sqlType.replace(/\(.*\)/, '').replace(/\[\]$/, '');
  if (['uuid', 'char', 'inet'].includes(base)) return ''; // already ascii_bin in the type
  const isText = ['text', 'varchar', 'mediumtext', 'longtext'].includes(base);
  if (!isText) return '';
  // §5.2: as_ci ignores case but not accents, which is the rule MongoDB's strength-2 collation applied
  return c.caseInsensitive ? ' COLLATE utf8mb4_0900_as_ci' : '';
}

/** The full column line of a CREATE TABLE */
export function columnDdl(c: Column, o: { indexed: boolean; at: string }): string {
  if (c.sqlType.startsWith('tsvector')) throw new Error(`${o.at}: tsvector is not stored; the search engine owns it (§5.1)`);
  const parts = [q(c.name), mysqlType(c, o) + collationOf(c)];
  parts.push(c.nullable ? 'NULL' : 'NOT NULL');
  if (c.identity) parts.push('AUTO_INCREMENT');
  return parts.join(' ');
}

/** The CHECK constraints a column implies: its enum values, and any `check >= 0` from the spec */
export function checksOf(c: Column, table: string): { name: string; sql: string }[] {
  const out: { name: string; sql: string }[] = [];
  if (c.enumValues) {
    const list = c.enumValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
    out.push({ name: `ck_${table}_${c.name}`, sql: `${q(c.name)} IN (${list})` });
  }
  if (c.check) {
    // the spec writes "<column> >= 0"; the column name is already the first token
    const expr = c.check.replace(new RegExp(`^${c.name}\\b`), q(c.name));
    out.push({ name: `ck_${table}_${c.name}_range`, sql: expr });
  }
  return out;
}
