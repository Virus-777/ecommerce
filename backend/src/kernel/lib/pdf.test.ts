import { describe, expect, it } from 'vitest';
import { renderPdf } from './pdf.js';

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');
const pageCount = (pdf: string) => Number(/\/Count (\d+)/.exec(pdf)?.[1]);
const shown = (pdf: string) => [...pdf.matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]);
const ys = (pdf: string) => [...pdf.matchAll(/ (-?\d+) Tm/g)].map((m) => Number(m[1]));

describe('pdf', () => {
  it('continues a long page on a new one, never drawing below the bottom margin', () => {
    // a label page holds 24 lines of 10 pt
    const lines = Array.from({ length: 60 }, (_, i) => ({ text: `Item ${i + 1}` }));
    const pdf = text(renderPdf([lines], { page: 'label' }));
    expect(pageCount(pdf)).toBe(3);
    expect(shown(pdf)).toEqual(lines.map((l) => l.text));
    expect(Math.min(...ys(pdf))).toBeGreaterThanOrEqual(18);
    expect(pageCount(text(renderPdf([lines.slice(0, 5), lines.slice(5, 8)])))).toBe(2);
    expect(pageCount(text(renderPdf([])))).toBe(1);
  });

  it('wraps a line wider than the page at spaces', () => {
    const address = 'Ship to Ana Lopez, 410 Pine Street, Apartment 1200, Portland, OR 97204, United States';
    const rows = shown(text(renderPdf([[{ text: address }]], { page: 'label' })));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.join(' ')).toBe(address);
    expect(rows.every((r) => r.length <= 45)).toBe(true);
  });

  it('keeps marks the standard fonts lack as plain text and escapes PDF string characters', () => {
    expect(shown(text(renderPdf([[{ text: '2 × Café (blue) — 3·4' }]])))).toEqual(['2 x Cafe \\(blue\\) - 3-4']);
  });
});
