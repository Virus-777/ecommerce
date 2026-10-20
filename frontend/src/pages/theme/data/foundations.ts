import type { IconName } from '@marketly/web-shared/ui';

// Design tokens documented on theme-foundations.html. Hex values are light · dark.

export interface Swatch {
  token: string;
  hex: string;
  use: string;
  /** Utility class used by the design instead of an inline background. */
  cls?: string;
}

export interface SwatchGroup {
  title: string;
  swatches: Swatch[];
}

export const SWATCH_GROUPS: SwatchGroup[] = [
  {
    title: 'Surfaces',
    swatches: [
      { token: '--bg', hex: '#F5F7F6 · #0D1412', use: 'Page background' },
      { token: '--surface', hex: '#FFFFFF · #141D1A', use: 'Cards, sheets, header' },
      { token: '--surface-2', hex: '#EFF3F1 · #1A2521', use: 'Subtle fills, table header', cls: 'u-bg-surface-2' },
      { token: '--surface-3', hex: '#E3E9E6 · #22302B', use: 'Tracks, neutral badges' },
      { token: '--border', hex: '#DAE2DE · #2A3833', use: 'Dividers, card edges' },
      { token: '--border-strong', hex: '#BFCAC5 · #3B4C46', use: 'Inputs, outlines' },
    ],
  },
  {
    title: 'Text',
    swatches: [
      { token: '--text', hex: '#13201C · #E7EEEB', use: 'Primary text' },
      { token: '--text-2', hex: '#44514C · #B6C3BE', use: 'Secondary text' },
      { token: '--text-3', hex: '#5F6C67 · #8F9D98', use: 'Captions, meta (AA on white)' },
    ],
  },
  {
    title: 'Brand · sea green',
    swatches: [
      { token: '--brand', hex: '#0B6E5F · #3CC2A6', use: 'Primary buttons, active nav' },
      { token: '--brand-hover', hex: '#085A4E · #5BD3BA', use: 'Hover / pressed' },
      { token: '--brand-soft', hex: '#E2F1ED · #12332C', use: 'Selected rows, Official panels' },
      { token: '--brand-text', hex: '#08604F · #63D6BD', use: 'Links, brand text' },
      { token: '--on-brand', hex: '#FFFFFF · #04201A', use: 'Text on brand fill', cls: 'u-bg-on-brand' },
    ],
  },
  {
    title: 'Deal · warm orange (prices and promotions only)',
    swatches: [
      { token: '--deal', hex: '#C2410C · #F07A3E', use: 'Discount badges, sale fills' },
      { token: '--deal-soft', hex: '#FFF0E6 · #3A2015', use: 'Deal sections' },
      { token: '--deal-text', hex: '#B03A09 · #FF9C66', use: 'Sale prices' },
    ],
  },
  {
    title: 'Status (always with icon or label)',
    swatches: [
      { token: '--success', hex: '#157A3F · #4FCB82', use: 'Delivered, paid, approved' },
      { token: '--warning', hex: '#9A5A06 · #EDB04F', use: 'Delayed, held, needs info' },
      { token: '--danger', hex: '#B42318 · #FF7E72', use: 'Failed, overdue, suspended' },
      { token: '--info', hex: '#1F5BC4 · #82AAFF', use: 'In progress, verified seller' },
      { token: '--star', hex: '#D98E04 · #F0B23A', use: 'Ratings' },
    ],
  },
  {
    title: 'Charts (validated for colour-blind readers)',
    swatches: [
      { token: '--chart-1', hex: '#0F8A73 · #25A587', use: 'Official Store series' },
      { token: '--chart-2', hex: '#C77F14 · #BD7C1C', use: 'Marketplace sellers series' },
      { token: '--chart-3', hex: '#3B6FD6 · #5B8DEB', use: 'Third series' },
      { token: '--chart-4', hex: '#C2477F · #D1609A', use: 'Fourth series' },
      { token: '--chart-5', hex: '#7A5BD0 · #9580E6', use: 'Fifth series' },
      { token: '--chart-6', hex: '#D0503C · #E0644E', use: 'Sixth series (more fold into Other)' },
      { token: '--chart-compare', hex: '#7F8D88 · #6F7F79', use: 'Comparison period, dashed' },
      { token: '--chart-positive', hex: '#2F6BCF · #5B8DEB', use: 'Waterfall plus steps' },
      { token: '--chart-negative', hex: '#C8472F · #E0644E', use: 'Waterfall minus steps' },
    ],
  },
];

/** Type scale: spec label and the class of the sample (the price sample is rendered separately). */
export const TYPE_SCALE: Array<{ spec: string; cls?: string; sample: string }> = [
  { spec: 'display-lg · 38/1.1 · 700', cls: 'display d-xl', sample: 'Autumn Home Week' },
  { spec: 'display-md · 30/1.15 · 700', cls: 'display d-lg', sample: 'Sold and shipped by Marketly' },
  { spec: 'title-lg · 24/1.2 · 700', cls: 'h1', sample: 'Order details' },
  { spec: 'title-md · 20/1.25 · 700', cls: 'h2', sample: 'Package 2 of 3' },
  { spec: 'title-sm · 17/1.35 · 600', cls: 'h3', sample: 'Delivery address' },
  { spec: 'body · 15/1.5 · 400', sample: 'Arrives Thu, Oct 15. Free returns within 30 days of delivery.' },
  { spec: 'body-sm · 13/1.45 · 400', cls: 'small sub', sample: 'Ships from Portland, OR. Seller responds within 24 hours.' },
  { spec: 'label · 13/1.3 · 600', cls: 'label', sample: 'Card number' },
  { spec: 'caption · 12/1.35 · 500', cls: 'xs muted', sample: 'Updated 9:40 AM PT' },
  { spec: 'overline · 11 · 700 · +0.08em', cls: 'eyebrow', sample: 'Seller Center' },
  { spec: 'code · 13 · Plex Mono', cls: 'mono', sample: 'MK-260914-48213 · SKU HAL-AUR-BLK' },
];

/** 4 px base grid: token and width in px. */
export const SPACING: Array<[string, number]> = [
  ['--sp-1', 4],
  ['--sp-2', 8],
  ['--sp-3', 12],
  ['--sp-4', 16],
  ['--sp-5', 20],
  ['--sp-6', 24],
  ['--sp-7', 32],
  ['--sp-8', 40],
  ['--sp-9', 48],
  ['--sp-10', 64],
];

export const RADII = ['r-xs', 'r-sm', 'r-md', 'r-lg', 'r-xl', 'r-pill'];
export const SHADOWS = ['sh-1', 'sh-2', 'sh-3'];

export const BREAKPOINTS: Array<{ range: string; width: string; label: string; cls?: string }> = [
  { range: '0–767', width: '30%', label: 'Phone · Android app · 1–2 columns' },
  { range: '768–1023', width: '55%', label: 'Tablet · 3 product columns · top navigation' },
  { range: '1024–1279', width: '78%', label: 'Desktop · sidebars appear · 4 product columns' },
  { range: '1280+', width: '100%', label: 'Wide · 5 product columns · max content 1240 px', cls: 'u-w-100pct' },
];

export const ICON_SAMPLES: IconName[] = [
  'house', 'layout-grid', 'tag', 'shopping-cart', 'user-round', 'search', 'heart', 'truck', 'package', 'undo-2', 'badge-check', 'shield-check',
  'store', 'wallet', 'message-square', 'bell', 'life-buoy', 'megaphone', 'boxes', 'chart-column', 'settings', 'clock', 'triangle-alert', 'circle-check',
];
