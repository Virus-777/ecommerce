/** media.productImage (the product image spec): its definition and the value rules a change is checked against. */
import { describe, expect, it } from 'vitest';
import { allSpecs } from '../../../kernel/module-system/loader.js';
import { buildCatalogue } from '../domain/catalogue.js';
import { validateValue } from '../domain/values.js';

const catalogue = buildCatalogue(allSpecs, new Set(Object.keys(allSpecs)), { defaultMinLeadDays: 0, sellerVisibleMinLeadDays: 14 });
const def = catalogue.get('media.productImage')!;
const ok = { aspectRatio: '1:1', detailWidth: 800, thumbnailWidth: 320, quality: 80 };
const paths = (value: unknown) => validateValue(def, value).map((i) => i.path);

describe('media.productImage', () => {
  it('is a json setting in the media section, second reviewer, seller-visible, new uploads only', () => {
    expect(def).toMatchObject({
      section: 'media',
      label: 'Product images',
      valueType: 'json',
      default: ok,
      approval: 'second_reviewer',
      applyScopes: ['new_only'],
      sellerVisible: true,
      editable: true,
    });
    expect(validateValue(def, def.default)).toEqual([]);
  });

  it('checks each field, with the issue on the field', () => {
    expect(paths({ ...ok, aspectRatio: '4:5' })).toEqual([]);
    expect(paths({ ...ok, aspectRatio: '3:1' })).toEqual(['value.aspectRatio']);
    expect(paths({ ...ok, aspectRatio: '1:3' })).toEqual(['value.aspectRatio']);
    expect(paths({ ...ok, aspectRatio: '0:1' })).toEqual(['value.aspectRatio']);
    expect(paths({ ...ok, aspectRatio: '40:40' })).toEqual(['value.aspectRatio']);
    expect(paths({ ...ok, aspectRatio: 'square' })).toEqual(['value.aspectRatio']);
    expect(paths({ ...ok, detailWidth: 479 })).toEqual(['value.detailWidth']);
    expect(paths({ ...ok, detailWidth: 2049 })).toEqual(['value.detailWidth']);
    expect(paths({ ...ok, detailWidth: 800.5 })).toEqual(['value.detailWidth']);
    expect(paths({ ...ok, thumbnailWidth: 100 })).toEqual(['value.thumbnailWidth']);
    expect(paths({ ...ok, thumbnailWidth: 700 })).toEqual(['value.thumbnailWidth']);
    // the thumbnail must be smaller than the detail size
    expect(validateValue(def, { ...ok, detailWidth: 500, thumbnailWidth: 500 })).toEqual([{ path: 'value.thumbnailWidth', message: 'Make the thumbnail smaller than the product-page image' }]);
    expect(paths({ ...ok, quality: 49 })).toEqual(['value.quality']);
    expect(paths({ ...ok, quality: 96 })).toEqual(['value.quality']);
    expect(paths({ ...ok, extra: true })).toHaveLength(1);
    expect(paths({ aspectRatio: '1:1' })).toEqual(['value.detailWidth', 'value.thumbnailWidth', 'value.quality']);
  });
});
