import type { IconName } from '@/ui';

// Sample data for pages/admin/AdAssets.tsx (design: pages/admin/admin-ad-assets.html).

export type CreativeStatus = 'In review' | 'Changes requested' | 'Approved' | 'Rejected' | 'Draft';
export type LinkCheck = 'ok' | 'warn' | 'broken' | 'none';

export interface Creative {
  id: string;
  file: string;
  status: CreativeStatus;
  /** Preview: an image tile (shape class + tint), the ad text, or a video still. */
  preview: { kind: 'img'; shape?: 'wide' | 'tall' | 'band'; tint: string; tag: 'Ad' | 'Sponsored' } | { kind: 'txt'; text: string } | { kind: 'video'; tint: string };
  format: string;
  /** Format filter value. */
  formatGroup: string;
  desc: string;
  size: string;
  check: { state: LinkCheck; text: string };
  note?: string;
}

export interface CreativeGroup {
  id: string;
  name: string;
  advertiser: string;
  source: 'own' | 'seller' | 'brand';
  usedIn: string;
  campaignStatus?: string;
  extra?: string;
  /** Review drawer details. */
  review?: {
    advertiser: string;
    destination: string;
    period: string;
    headline: string;
    text: string;
    button: string;
    checks: Array<{ tone: 'ok' | 'warn'; t: string; d?: string }>;
    notes: Array<{ who: string; team: string; tone: 'brand' | 'warning'; when: string; text: string; me?: boolean }>;
    comment: string;
  };
  creatives: Creative[];
}

const FALL_HEADLINE = 'Fall Home Sale: 20% off bedding and lighting';
const FALL_TEXT = 'Oct 16–25 · Casa Verde Home, Mosswood and the Official Store';

export const GROUPS: CreativeGroup[] = [
  {
    id: 'g1',
    name: 'Fall Home Sale opening ad',
    advertiser: 'Marketly',
    source: 'own',
    usedIn: 'Fall Home Sale opening ad',
    campaignStatus: 'In review',
    review: {
      advertiser: 'Marketly · own promotion',
      destination: 'marketly.com/campaign/fall-home-sale',
      period: 'Oct 16–25',
      headline: FALL_HEADLINE,
      text: FALL_TEXT,
      button: 'Shop the sale',
      checks: [
        { tone: 'ok', t: 'Claims: "20% off" matches the Fall Home Sale discount' },
        { tone: 'ok', t: 'Link works: campaign page loads in preview and publishes at ad start' },
        { tone: 'warn', t: 'Products available: 212 of 214 offers in stock', d: '2 Mosswood offers are hidden from the campaign page' },
        { tone: 'ok', t: 'Label present: "Ad" on desktop and phone' },
        { tone: 'ok', t: 'Close control visible, 44 px on phone, keyboard reachable' },
      ],
      notes: [
        { who: 'Jamie Brooks', team: 'Advertising', tone: 'brand', when: 'Oct 8, 9:20 AM · approved', text: 'Placement, sizes and frequency are fine. Overlap with Home Week is handled by priority.' },
        { who: 'Noor Aziz', team: 'Content', tone: 'warning', when: 'Your review', text: 'Copy matches the campaign page. Checking the phone crop on the lamp image.', me: true },
      ],
      comment: 'Phone crop checked. Approved.',
    },
    creatives: [
      { id: 'a1', file: 'fall-home-desktop.jpg', status: 'In review', preview: { kind: 'img', shape: 'wide', tint: '1', tag: 'Ad' }, format: 'Opening full-screen · desktop', formatGroup: 'Opening full-screen', desc: '', size: '1600 × 900 · 412 KB', check: { state: 'ok', text: 'Campaign page publishes Oct 16, 12:00 AM' }, note: 'Advertising approved placement. Waiting on Content.' },
      { id: 'a2', file: 'fall-home-mobile.jpg', status: 'In review', preview: { kind: 'img', shape: 'tall', tint: '1', tag: 'Ad' }, format: 'Opening full-screen · phone', formatGroup: 'Opening full-screen', desc: '', size: '1080 × 1920 · 538 KB', check: { state: 'ok', text: 'Campaign page publishes Oct 16, 12:00 AM' } },
      { id: 'a3', file: 'Ad text', status: 'In review', preview: { kind: 'txt', text: FALL_HEADLINE }, format: 'Headline, text, button', formatGroup: 'Ad text', desc: '', size: '44 / 60 characters', check: { state: 'warn', text: '2 linked offers out of stock, hidden' } },
    ],
  },
  {
    id: 'g2',
    name: 'Kestrel 27" monitor sponsored product',
    advertiser: 'Pixel & Port',
    source: 'seller',
    usedIn: 'Kestrel 27" monitor sponsored product',
    campaignStatus: 'In review',
    review: {
      advertiser: 'Pixel & Port · seller paid',
      destination: 'marketly.com/p/kestrel-27-4k-monitor',
      period: 'Oct 12 – Nov 8',
      headline: 'Kestrel 27" 4K monitor',
      text: 'Sold by Pixel & Port · Sponsored',
      button: 'View product',
      checks: [
        { tone: 'warn', t: 'Claims: "Best 4K monitor of 2026" is not supported', d: 'Remove the claim or cite a source' },
        { tone: 'ok', t: 'Link works: product page loads, 18 in stock' },
        { tone: 'ok', t: 'Label present: "Sponsored" on the product card' },
        { tone: 'ok', t: 'Seller named: Pixel & Port' },
      ],
      notes: [{ who: 'Noor Aziz', team: 'Content', tone: 'warning', when: 'Oct 7, 4:05 PM · changes requested', text: '"Best 4K monitor of 2026" is not supported. Remove the claim or cite a source.', me: true }],
      comment: '',
    },
    creatives: [
      { id: 'b1', file: 'kestrel27-card.png', status: 'Changes requested', preview: { kind: 'img', tint: '1', tag: 'Sponsored' }, format: 'Sponsored product card', formatGroup: 'Sponsored product', desc: '', size: '1000 × 1000 · 220 KB', check: { state: 'ok', text: 'Product page works · 18 in stock' }, note: 'Noor Aziz: "Best 4K monitor of 2026" is not supported. Remove the claim or cite a source.' },
      { id: 'b2', file: 'Ad text', status: 'Changes requested', preview: { kind: 'txt', text: FALL_HEADLINE }, format: 'Card title and seller line', formatGroup: 'Ad text', desc: '', size: '38 / 50 characters', check: { state: 'ok', text: 'Seller named: Pixel & Port' }, note: 'Same claim appears in the title.' },
    ],
  },
  {
    id: 'g3',
    name: 'Halden Aurora banner',
    advertiser: 'Halden (brand)',
    source: 'brand',
    usedIn: 'Halden Aurora banner',
    campaignStatus: 'Live',
    creatives: [
      { id: 'c1', file: 'aurora-banner-desktop.jpg', status: 'Approved', preview: { kind: 'img', shape: 'band', tint: '2', tag: 'Ad' }, format: 'Home banner · desktop', formatGroup: 'Banner', desc: '', size: '1440 × 360 · 301 KB', check: { state: 'ok', text: 'Product page works · 142 in stock' }, note: 'Approved Sep 29 by Jamie Brooks and Noor Aziz.' },
      { id: 'c2', file: 'aurora-banner-phone.jpg', status: 'Approved', preview: { kind: 'img', shape: 'wide', tint: '1', tag: 'Ad' }, format: 'Home banner · phone', formatGroup: 'Banner', desc: '', size: '750 × 500 · 188 KB', check: { state: 'ok', text: 'Product page works' } },
    ],
  },
  {
    id: 'g4',
    name: 'Trailhead Ridge store feature',
    advertiser: 'Trailhead Outfitters',
    source: 'seller',
    usedIn: 'Trailhead Ridge store feature',
    campaignStatus: 'Paused',
    creatives: [
      { id: 'd1', file: 'ridge-store-feature.jpg', status: 'Approved', preview: { kind: 'img', shape: 'band', tint: '2', tag: 'Ad' }, format: 'Sponsored store · desktop and phone', formatGroup: 'Sponsored store', desc: '', size: '1200 × 300 · 264 KB', check: { state: 'warn', text: 'Featured backpack has 6 left. Campaign paused below 10.' } },
    ],
  },
  {
    id: 'g5',
    name: 'Gadget Grove robot vacuum banner',
    advertiser: 'Gadget Grove',
    source: 'seller',
    usedIn: 'Not used',
    creatives: [
      { id: 'e1', file: 's2-vacuum-banner.jpg', status: 'Rejected', preview: { kind: 'img', shape: 'band', tint: '2', tag: 'Ad' }, format: 'Category banner · desktop', formatGroup: 'Banner', desc: '', size: '1200 × 240 · 245 KB', check: { state: 'broken', text: 'Promoted offer suspended (TR-3391)' }, note: 'Rejected Oct 6: seller restricted and the offer is under counterfeit review. Seller can appeal.' },
    ],
  },
  {
    id: 'g6',
    name: 'Home Week brand video',
    advertiser: 'Marketly',
    source: 'own',
    usedIn: 'Not used',
    extra: 'video ads come later',
    creatives: [
      { id: 'f1', file: 'home-week-15s.mp4', status: 'Draft', preview: { kind: 'video', tint: '4' }, format: 'Video · 15 s, captions included', formatGroup: 'Video', desc: '', size: '1920 × 1080 · 8.4 MB', check: { state: 'none', text: 'Stored for later. No video placement is on.' } },
    ],
  },
];

export const CHECK_STYLE: Record<LinkCheck, { cls: string; icon: IconName }> = {
  ok: { cls: 't-success-text', icon: 'circle-check' },
  warn: { cls: 't-warning-text', icon: 'triangle-alert' },
  broken: { cls: 't-danger-text', icon: 'circle-x' },
  none: { cls: 'muted', icon: 'info' },
};

export const REASONS = ['No changes needed', 'Unsupported claim', 'Broken or wrong link', 'Promoted product unavailable', 'Label missing or hidden', 'Image quality or crop'];
