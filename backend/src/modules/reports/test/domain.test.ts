import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { cellText, toCsv, toJsonl, toXlsx } from '../domain/files.js';
import { bucketsOf, deltaOf, display, metricIssues, nextRun, presetRange, previousRange } from '../domain/rules.js';

describe('export files', () => {
  const cols = [
    { key: 'ref', label: 'Reference' },
    { key: 'note', label: 'Note, with comma' },
    { key: 'total', label: 'Total' },
  ];
  const rows = [
    { ref: 'MK-1', note: '=HYPERLINK("x")', total: { amount: 1250, currency: 'USD' } },
    { ref: 'MK-2', note: 'He said "hi"', total: -5 },
  ];

  it('CSV: quoted labels and quotes, money as decimals, formulas neutralised, negative numbers kept', () => {
    const text = toCsv(cols, rows).toString('utf8');
    expect(text.startsWith('﻿')).toBe(true);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Reference,"Note, with comma",Total');
    expect(lines[1]).toBe(`MK-1,"'=HYPERLINK(""x"")",12.50`);
    expect(lines[2]).toBe('MK-2,"He said ""hi""",-5');
  });

  it('JSON lines keep only the exported columns', () => {
    const lines = toJsonl([{ key: 'ref', label: 'Reference' }], rows).toString('utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ ref: 'MK-1' }, { ref: 'MK-2' }]);
  });

  it('XLSX: a zip with the workbook parts and the rows as inline strings', () => {
    const buf = toXlsx(cols, rows);
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    const names: string[] = [];
    let sheet = '';
    for (let at = 0; buf.readUInt32LE(at) === 0x04034b50; ) {
      const size = buf.readUInt32LE(at + 18);
      const nameLen = buf.readUInt16LE(at + 26);
      const name = buf.subarray(at + 30, at + 30 + nameLen).toString();
      const data = buf.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
      names.push(name);
      if (name === 'xl/worksheets/sheet1.xml') sheet = buf.readUInt16LE(at + 8) === 8 ? inflateRawSync(data).toString() : data.toString();
      at += 30 + nameLen + size;
    }
    expect(names).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">MK-1</t></is></c>');
    expect(sheet).toContain('<c r="C3"><v>-5</v></c>');
    expect(sheet).toContain('He said &quot;hi&quot;');
    expect(cellText(new Date('2026-10-09T00:00:00Z'))).toBe('2026-10-09T00:00:00.000Z');
  });
});

describe('reporting rules', () => {
  it('presets end today; the comparison is the previous period of the same length; buckets by week start Monday', () => {
    expect(presetRange('last_7_days', '2026-10-09')).toEqual({ from: '2026-10-03', to: '2026-10-09' });
    expect(presetRange('month_to_date', '2026-10-09')).toEqual({ from: '2026-10-01', to: '2026-10-09' });
    expect(previousRange({ from: '2026-10-03', to: '2026-10-09' })).toEqual({ from: '2026-09-26', to: '2026-10-02' });
    expect(bucketsOf({ from: '2026-10-01', to: '2026-10-14' }, 'week')).toEqual(['2026-09-28', '2026-10-05', '2026-10-12']);
    expect(bucketsOf({ from: '2026-09-20', to: '2026-10-02' }, 'month')).toEqual(['2026-09-01', '2026-10-01']);
  });

  it('deltas: percent change, points for percentages, good news depends on the metric', () => {
    expect(deltaOf(120, 100, 'money')).toEqual({ value: 20, unit: 'pct', direction: 'up', good: true });
    expect(deltaOf(80, 100, 'money', false)).toEqual({ value: 20, unit: 'pct', direction: 'down', good: true });
    expect(deltaOf(95.5, 97, 'percent')).toEqual({ value: 1.5, unit: 'pts', direction: 'down', good: false });
    expect(deltaOf(5, 0, 'count')).toBeNull();
  });

  it('display formats', () => {
    expect(display(24130000, 'money', 'USD')).toBe('$241.3k');
    expect(display(7120, 'money', 'USD')).toBe('$71.20');
    expect(display(3418, 'count', 'USD')).toBe('3,418');
    expect(display(2.1, 'percent', 'USD')).toBe('2.1%');
  });

  it('metric validation', () => {
    const ok = { name: 'x', group: 'commerce', definition: 'd', formula: 'f', unit: 'money', dateBasisOptions: ['placement'], defaultDateBasis: 'placement', ownerId: 'o', changeNote: 'n' };
    expect(metricIssues(ok, 'commerce.x')).toEqual([]);
    expect(metricIssues({ ...ok, defaultDateBasis: 'payment' }).map((i) => i.path)).toEqual(['metric.defaultDateBasis']);
  });

  it('schedules: next run at the market time of day', () => {
    const after = new Date('2026-10-09T16:00:00Z'); // 09:00 in Los Angeles
    expect(nextRun({ frequency: 'daily', time: '07:30' }, after, 'America/Los_Angeles').toISOString()).toBe('2026-10-10T14:30:00.000Z');
    expect(nextRun({ frequency: 'weekly', dayOfWeek: 1, time: '07:30' }, after, 'America/Los_Angeles').toISOString()).toBe('2026-10-12T14:30:00.000Z');
    expect(nextRun({ frequency: 'monthly', time: '06:00' }, after, 'America/Los_Angeles').toISOString()).toBe('2026-11-01T14:00:00.000Z'); // DST ended at 02:00 that morning
  });
});
