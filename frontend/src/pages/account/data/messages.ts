// Messaging helpers for the account screens (conversations with sellers, the Official Store and Marketly
// Support). Data comes from /api/store/messaging/*; these map it onto the design's tiles and links.
import type { components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { productHref } from './orders';

export type ConversationSummary = components['schemas']['messaging.ConversationSummary'];
export type Message = components['schemas']['messaging.Message'];
type Subject = ConversationSummary['subject'];
type Counterparty = ConversationSummary['counterparty'];

/** Messaging settings (messaging.md "Settings"): files per message, MB per file, characters per message. */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_MB = 10;
export const MESSAGE_MAX_LENGTH = 4000;
/** message_attachment accepts images and PDF (media/domain/rules.ts). */
export const ATTACHMENT_TYPES = 'image/jpeg,image/png,image/webp,image/heic,application/pdf';

/** Logo tile for a seller or counterparty: initials and a stable tint ('brand' for Marketly). */
export function sellerTile(name: string, marketly = false): { initials: string; tint: string } {
  const initials =
    name
      .replace(/&/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?';
  if (marketly) return { initials: initials.slice(0, 1), tint: 'brand' };
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { initials, tint: String((h % 6) + 1) };
}

export const isMarketly = (c: Counterparty) => c.kind === 'official_store' || c.kind === 'marketplace_support';

/** "About order MK-… · Package 3 of 3" parts for the conversation's subject. */
export function aboutOf(s: Subject): { label: string; ref: string | null; extra: string | null } {
  if (s.kind === 'case') return { label: 'About case', ref: s.caseRef ?? null, extra: s.orderRef ? `Order ${s.orderRef}` : null };
  if (s.kind === 'return') return { label: 'About return', ref: s.returnRef ?? null, extra: s.orderRef ? `Order ${s.orderRef}` : null };
  // Pre-sale question about a product (no order): POST messaging/product-conversations (G4).
  if (s.kind === 'product') return { label: 'About a product', ref: null, extra: null };
  return { label: 'About order', ref: s.orderRef ?? null, extra: s.packageLabel ?? null };
}

/** Subject line in the inbox: "MK-260914-48213 · Linen duvet cover". */
export const subjectLine = (s: Subject) => [s.caseRef ? `Case ${s.caseRef}` : (s.returnRef ?? s.orderRef), s.title].filter(Boolean).join(' · ');

/** Link to the record the conversation is about (a product question opens the product page). */
export function aboutLink(s: Subject): string {
  if (s.kind === 'product' && s.productId) return productHref(s.productId, s.title);
  if (s.caseRef) return href('help/case', '', { ref: s.caseRef });
  if (s.returnRef) return href('account/return', '', { ref: s.returnRef });
  if (s.orderRef) return href('account/order', '', { ref: s.orderRef });
  return href('account/orders');
}

/** "Usually replies within 4 hours · Sacramento, CA" */
export const counterpartyMeta = (c: Counterparty) => [c.responseTimeLabel, c.location].filter(Boolean).join(' · ');

/** File name for an attachment: MediaRef.fileName; older records without one fall back to the alt text or the URL's last segment. */
export function attachmentName(a: Message['attachments'][number], i: number): string {
  if (a.fileName) return a.fileName;
  if (a.alt) return a.alt;
  try {
    const last = decodeURIComponent(new URL(a.url).pathname.split('/').pop() ?? '');
    if (last && /\.[a-z0-9]{2,5}$/i.test(last) && !/^(original|thumb|small|medium|large)\./.test(last)) return last;
  } catch {
    /* not a URL */
  }
  return `Attachment ${i + 1}`;
}
