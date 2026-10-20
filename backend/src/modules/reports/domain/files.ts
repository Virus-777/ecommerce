/**
 * Export files without extra dependencies: CSV (RFC 4180, UTF-8 with BOM so spreadsheets read accents),
 * JSON lines, and a minimal Office Open XML workbook (one sheet, inline strings, stored zip).
 */
import { crc32 } from 'node:zlib';
import { csvCell } from '../../../kernel/lib/csv.js';

export interface ExportColumn {
  key: string;
  label: string;
  permission?: string;
}

export type ExportFormat = 'csv' | 'xlsx' | 'jsonl';

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jsonl: 'application/x-ndjson',
};

/** Registered columns as stored ({ key, label, permission? }); anything else is ignored */
export function columnsOf(raw: unknown): ExportColumn[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    if (!c || typeof c !== 'object') return [];
    const o = c as Record<string, unknown>;
    if (typeof o.key !== 'string' || !o.key) return [];
    return [{ key: o.key, label: typeof o.label === 'string' ? o.label : o.key, ...(typeof o.permission === 'string' && o.permission ? { permission: o.permission } : {}) }];
  });
}

/** Columns of the rows themselves when the owner registered none */
export function columnsFromRows(rows: unknown[]): ExportColumn[] {
  const keys: string[] = [];
  for (const r of rows.slice(0, 50)) if (r && typeof r === 'object') for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  return keys.map((key) => ({ key, label: key }));
}

/** A cell as text: money { amount, currency } as 12.34, dates as ISO, objects as JSON */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.amount === 'number' && typeof o.currency === 'string' && Object.keys(o).length <= 3) return (o.amount / 100).toFixed(2);
    return JSON.stringify(v);
  }
  return String(v);
}

/** Text that a spreadsheet would run as a formula is prefixed with ' (negative numbers stay numbers): kernel csvCell */
const csvField = (raw: string) => csvCell(raw);

export function toCsv(columns: ExportColumn[], rows: unknown[]): Buffer {
  const lines = [columns.map((c) => csvField(c.label)).join(',')];
  for (const r of rows) {
    const o = (r ?? {}) as Record<string, unknown>;
    lines.push(columns.map((c) => csvField(cellText(o[c.key]))).join(','));
  }
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

export function toJsonl(columns: ExportColumn[], rows: unknown[]): Buffer {
  const keys = columns.map((c) => c.key);
  return Buffer.from(rows.map((r) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, (r as Record<string, unknown> | null)?.[k] ?? null])))).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

/* ---------------------------------------------------------------- xlsx */

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cellXml(ref: string, v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
  const text = cellText(v);
  if (!text) return '';
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

function sheetXml(columns: ExportColumn[], rows: unknown[]): string {
  const out: string[] = [];
  out.push(`<row r="1">${columns.map((c, i) => cellXml(`${colName(i)}1`, c.label)).join('')}</row>`);
  rows.forEach((r, ri) => {
    const o = (r ?? {}) as Record<string, unknown>;
    out.push(`<row r="${ri + 2}">${columns.map((c, i) => cellXml(`${colName(i)}${ri + 2}`, o[c.key])).join('')}</row>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${out.join('')}</sheetData></worksheet>`;
}

/** A stored (uncompressed) zip archive */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time, date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, f.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

export function toXlsx(columns: ExportColumn[], rows: unknown[], sheetName = 'Export'): Buffer {
  const b = (s: string) => Buffer.from(s, 'utf8');
  return zip([
    { name: '[Content_Types].xml', data: b('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
    { name: '_rels/.rels', data: b('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: 'xl/workbook.xml', data: b(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: b('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: 'xl/worksheets/sheet1.xml', data: b(sheetXml(columns, rows)) },
  ]);
}

export function renderFile(format: ExportFormat, columns: ExportColumn[], rows: unknown[]): Buffer {
  if (format === 'jsonl') return toJsonl(columns, rows);
  if (format === 'xlsx') return toXlsx(columns, rows);
  return toCsv(columns, rows);
}
