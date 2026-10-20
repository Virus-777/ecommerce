import { describe, expect, it } from 'vitest';
import { escapeHtml, slugify, stringList } from './text.js';

describe('text', () => {
  it('slugs: accents dropped, & as and, length capped without a trailing hyphen, fallback for nothing', () => {
    expect(slugify('Home & Garden')).toBe('home-and-garden');
    expect(slugify('Café Crème — Déluxe!')).toBe('cafe-creme-deluxe');
    expect(slugify('abc def ghi', { max: 8 })).toBe('abc-def');
    expect(slugify('!!!', { fallback: 'store' })).toBe('store');
    expect(slugify('!!!')).toBe('');
  });

  it('escapes HTML including single quotes', () => {
    expect(escapeHtml(`<a href="x" title='y'>Tom & Jerry</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;');
  });

  it('keeps only the strings of a stored array', () => {
    expect(stringList(['a', null, 3, 'b'])).toEqual(['a', 'b']);
    expect(stringList(null)).toEqual([]);
    expect(stringList('a')).toEqual([]);
  });
});
