/**
 * CSV cells for files people open in spreadsheets. Text a spreadsheet would run as a formula — starting with = + @, a
 * tab or a carriage return, or - not starting a number — gets a leading ' (CSV formula injection; negative numbers
 * stay numbers). A cell is quoted when it holds a quote, comma, line break or that guard, or always with { quote }.
 */
const FORMULA = /^(?:[=+@\t\r]|-(?![\d.]))/;

export function csvCell(value: unknown, o: { quote?: boolean } = {}): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const s = FORMULA.test(raw) ? `'${raw}` : raw;
  return o.quote || (/[",\r\n']/.test(s) && (s !== raw || /[",\r\n]/.test(s))) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV line of cells (no line break) */
export const csvLine = (cells: readonly unknown[], o: { quote?: boolean } = {}): string => cells.map((c) => csvCell(c, o)).join(',');
