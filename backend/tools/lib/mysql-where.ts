/**
 * The condition language of a partial index in the spec (`unique (a) where <cond>`), and its MySQL form.
 *
 * MySQL has no partial indexes. A partial **unique** key becomes a functional key part
 * `IF(<cond>, <first column>, NULL)`: MySQL never compares a key that contains NULL, so rows outside the
 * condition are not checked — which is exactly what a partial unique index means (docs/10 §6.1, Appendix A).
 * A partial **non-unique** index becomes a plain index with the condition's columns added, so the condition is
 * still filtered inside the index.
 *
 * The language is deliberately tiny, and every form below appears in the spec today (56 distinct conditions over
 * 70 indexes). Anything else throws rather than being guessed at: a silently mistranslated condition would make a
 * unique key apply to the wrong rows, which is a data bug nobody would see until it bit.
 *
 *   col is null | col is not null | col = 'lit' | col <> 'lit' | col = <number>
 *   col in ('a','b',…) | col            (a bare boolean column, meaning true)
 *   <term> and <term> and …             (conjunction only; there is no `or` in the spec)
 */

/** MySQL reserved words are quoted; so is everything else, uniformly, so the output never depends on a word list */
export const q = (ident: string) => `\`${ident.replace(/`/g, '``')}\``;

export interface Term {
  column: string;
  /** The SQL this term becomes, with the column already quoted */
  sql: string;
}

const LITERAL = /^'((?:[^']|'')*)'$/;

/** One term of a condition → its SQL, or undefined when the form is not part of the language */
function parseTerm(text: string): Term | undefined {
  const t = text.trim();

  let m = /^([a-z_][a-z0-9_]*)\s+is\s+not\s+null$/i.exec(t);
  if (m) return { column: m[1]!, sql: `${q(m[1]!)} IS NOT NULL` };

  m = /^([a-z_][a-z0-9_]*)\s+is\s+null$/i.exec(t);
  if (m) return { column: m[1]!, sql: `${q(m[1]!)} IS NULL` };

  m = /^([a-z_][a-z0-9_]*)\s+in\s*\((.+)\)$/i.exec(t);
  if (m) {
    const values = m[2]!.split(',').map((v) => v.trim());
    if (!values.length || !values.every((v) => LITERAL.test(v))) return undefined;
    return { column: m[1]!, sql: `${q(m[1]!)} IN (${values.join(', ')})` };
  }

  m = /^([a-z_][a-z0-9_]*)\s*(<>|!=|=)\s*(.+)$/i.exec(t);
  if (m) {
    const [, col, op, raw] = m as unknown as [string, string, string, string];
    const value = raw.trim();
    const ok = LITERAL.test(value) || /^-?\d+(\.\d+)?$/.test(value);
    if (!ok) return undefined;
    return { column: col, sql: `${q(col)} ${op === '!=' ? '<>' : op} ${value}` };
  }

  // a bare boolean column: `where active`, `where visible_to_seller`
  m = /^([a-z_][a-z0-9_]*)$/i.exec(t);
  if (m) return { column: m[1]!, sql: `${q(m[1]!)} = 1` };

  return undefined;
}

export interface ParsedCondition {
  /** The whole condition as MySQL, e.g. "`status` IN ('a','b') AND `deleted_at` IS NULL" */
  sql: string;
  /** The columns the condition reads, in order, de-duplicated: what a non-unique partial index must also carry */
  columns: string[];
  terms: Term[];
}

/**
 * Parses a spec `where` clause. Throws with the clause and the place it came from when it is outside the
 * language — the generator then refuses to emit, which is the behaviour we want: a wrong translation here is
 * invisible until it lets through a duplicate it should have refused.
 */
export function parseCondition(where: string, at: string): ParsedCondition {
  const parts = where.split(/\s+and\s+/i);
  const terms: Term[] = [];
  for (const part of parts) {
    const term = parseTerm(part);
    if (!term) {
      throw new Error(
        `${at}: cannot translate the index condition "${where.trim()}" — the part "${part.trim()}" is not one of ` +
          `"col is [not] null", "col = 'x'", "col <> 'x'", "col = <number>", "col in ('a','b')" or a bare boolean column. ` +
          `Add the form to tools/lib/mysql-where.ts (and to docs/10 Appendix A) rather than working around it in the spec.`,
      );
    }
    terms.push(term);
  }
  if (/\bor\b/i.test(where)) {
    throw new Error(`${at}: the index condition "${where.trim()}" uses "or", which the partial-key translation cannot express; split it into two indexes`);
  }
  const columns: string[] = [];
  for (const t of terms) if (!columns.includes(t.column)) columns.push(t.column);
  return { sql: terms.map((t) => t.sql).join(' AND '), columns, terms };
}

/**
 * The functional key part that makes a unique key partial: the first key column is NULL for every row outside
 * the condition, and MySQL does not compare keys containing NULL (docs/10 Appendix A).
 */
export function partialKeyPart(condition: ParsedCondition, firstKeyExpr: string): string {
  return `(IF(${condition.sql}, ${firstKeyExpr}, NULL))`;
}
