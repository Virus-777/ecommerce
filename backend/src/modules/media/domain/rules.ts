/**
 * Pure media rules (no I/O): which caller may upload what, type and size limits, visibility,
 * ownership, which usages fit which files, evidence retention and when a file may be deleted.
 */
import type { MediaOwner, UploadRequest, UsageInput } from '../../../spec/media.js';

export type Purpose = UploadRequest['purpose'];
export type GeneratedPurpose = 'export' | 'statement' | 'report' | 'correction_report' | 'data_export' | 'label' | 'gift_card_codes';
export type UsageKind = UsageInput['kind'];
export type AssetKind = 'image' | 'video' | 'document' | 'spreadsheet';
export type OwnerKind = MediaOwner['kind'];
export type FileType = 'jpeg' | 'png' | 'webp' | 'heic' | 'gif' | 'mp4' | 'mov' | 'pdf' | 'csv' | 'xlsx';

export const GENERATED_PURPOSES: readonly GeneratedPurpose[] = ['export', 'statement', 'report', 'correction_report', 'data_export', 'label', 'gift_card_codes'];
/** Generated files whose download links are recorded with a reason (the owning module checks access first) */
export const SENSITIVE_GENERATED: readonly string[] = ['gift_card_codes'];
export const isGeneratedPurpose = (p: string): p is GeneratedPurpose => (GENERATED_PURPOSES as readonly string[]).includes(p);

/* ------------------------------------------------------------------ who may upload what */

/** Store (customers): return photos, case evidence, review photos, message attachments, seller application documents */
const STORE_PURPOSES: readonly Purpose[] = ['return_evidence', 'case_evidence', 'review_photo', 'message_attachment', 'verification_document'];
/** Guests (store visitors with a guest session) may upload return and case evidence for their guest order */
const GUEST_PURPOSES: readonly Purpose[] = ['return_evidence', 'case_evidence'];
/**
 * Seller Center: product images and video, store logo and banner, ad creatives, documents, inspection photos,
 * return evidence (a return's evidence before any case: the return_evidence usage takes only this purpose),
 * case evidence, bulk files
 */
const SELLER_PURPOSES: readonly Purpose[] = [
  'product_image',
  'product_video',
  'brand_logo',
  'store_logo',
  'store_banner',
  'offer_photo',
  'ad_creative',
  'ad_video',
  'verification_document',
  'return_evidence',
  'case_evidence',
  'inspection_photo',
  'message_attachment',
  'bulk_file',
  'other_document',
];
/** Staff: everything except customers' review photos */
const STAFF_PURPOSES: readonly Purpose[] = [
  'product_image',
  'product_video',
  'brand_logo',
  'store_logo',
  'store_banner',
  'offer_photo',
  'ad_creative',
  'ad_video',
  'content_image',
  'verification_document',
  'return_evidence',
  'case_evidence',
  'message_attachment',
  'inspection_photo',
  'bulk_file',
  'other_document',
];

export type Uploader = 'customer' | 'guest' | 'seller' | 'staff';

export function allowedPurposes(uploader: Uploader): readonly Purpose[] {
  switch (uploader) {
    case 'customer':
      return STORE_PURPOSES;
    case 'guest':
      return GUEST_PURPOSES;
    case 'seller':
      return SELLER_PURPOSES;
    case 'staff':
      return STAFF_PURPOSES;
  }
}

/** Staff evidence uploads belong to the staff member; content, ads and Official Store files to the platform. */
const STAFF_OWNED_PURPOSES: readonly Purpose[] = ['return_evidence', 'case_evidence', 'inspection_photo', 'verification_document', 'message_attachment', 'other_document'];
export const defaultStaffOwnerKind = (purpose: Purpose): 'platform' | 'staff' => (STAFF_OWNED_PURPOSES.includes(purpose) ? 'staff' : 'platform');

/* ------------------------------------------------------------------ visibility */

const PUBLIC_PURPOSES: readonly string[] = ['product_image', 'product_video', 'brand_logo', 'store_logo', 'store_banner', 'offer_photo', 'ad_creative', 'ad_video', 'content_image', 'review_photo'];
/** Public files get CDN renditions; originals, documents, evidence and generated files stay private. */
export const visibilityOf = (purpose: string): 'public' | 'private' => (PUBLIC_PURPOSES.includes(purpose) ? 'public' : 'private');

/* ------------------------------------------------------------------ types and limits */

const CONTENT_TYPES: Record<string, FileType> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const EXTENSIONS: Record<string, FileType> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  heic: 'heic',
  heif: 'heic',
  gif: 'gif',
  mp4: 'mp4',
  mov: 'mov',
  pdf: 'pdf',
  csv: 'csv',
  xlsx: 'xlsx',
};

export const MIME_OF: Record<FileType, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The file type a declared content type stands for; generic types (octet-stream) fall back to the file extension. */
export function fileTypeOf(contentType: string, fileName: string): FileType | null {
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  const byMime = CONTENT_TYPES[mime];
  if (byMime) return byMime;
  if (mime === '' || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
    return (ext && EXTENSIONS[ext]) || null;
  }
  return null;
}

export function kindOf(type: FileType): AssetKind {
  switch (type) {
    case 'jpeg':
    case 'png':
    case 'webp':
    case 'heic':
    case 'gif':
      return 'image';
    case 'mp4':
    case 'mov':
      return 'video';
    case 'csv':
    case 'xlsx':
      return 'spreadsheet';
    case 'pdf':
      return 'document';
  }
}

export interface PurposeLimit {
  maxMB: number;
  types: string[];
}

const IMAGE_TYPES = ['jpeg', 'png', 'webp', 'heic'];
const MB = 1024 * 1024;

/**
 * Limits for purposes the limitsByPurpose setting doesn't list ("others default to 20 MB images,
 * 25 MB documents"). Videos follow product_video; evidence and attachments are documents (25 MB).
 */
function fallbackLimit(purpose: Purpose, configured: Record<string, PurposeLimit>): PurposeLimit {
  switch (purpose) {
    case 'ad_video':
    case 'product_video':
      return configured.product_video ?? { maxMB: 500, types: ['mp4', 'mov'] };
    case 'case_evidence':
      return { maxMB: 25, types: [...IMAGE_TYPES, 'mp4', 'pdf'] };
    case 'message_attachment':
      return { maxMB: 25, types: [...IMAGE_TYPES, 'pdf'] };
    case 'other_document':
    case 'verification_document':
      return { maxMB: 25, types: ['pdf', ...IMAGE_TYPES, 'csv', 'xlsx'] };
    case 'bulk_file':
      return { maxMB: 25, types: ['csv', 'xlsx'] };
    case 'return_evidence':
      return { maxMB: 25, types: [...IMAGE_TYPES, 'mp4'] };
    default:
      return { maxMB: 20, types: IMAGE_TYPES };
  }
}

export function limitFor(purpose: Purpose, configured: Record<string, PurposeLimit>): { maxBytes: number; types: string[] } {
  const l = configured[purpose] ?? fallbackLimit(purpose, configured);
  return { maxBytes: Math.round(l.maxMB * MB), types: l.types };
}

/* ------------------------------------------------------------------ usages */

/** Usages that make a file evidence: kept for evidenceRetentionDays after their last use */
export const EVIDENCE_KINDS: readonly string[] = [
  'verification_document',
  'return_evidence',
  'case_evidence',
  'order_evidence',
  'inspection_photo',
  'correction_evidence',
  'trust_evidence',
  'dispute_evidence',
  'supplier_document',
];
export const isEvidenceKind = (kind: string) => EVIDENCE_KINDS.includes(kind);

/** Which upload purposes each usage accepts ("the purpose does not fit the usage" otherwise; spec notes, Usage kinds) */
export const USAGE_PURPOSES: Record<UsageKind, readonly string[]> = {
  product_image: ['product_image'],
  variant_image: ['product_image'],
  product_video: ['product_video'],
  offer_photo: ['offer_photo', 'product_image'],
  brand_logo: ['brand_logo'],
  brand_banner: ['store_banner', 'content_image'],
  category_image: ['content_image', 'product_image'],
  store_logo: ['store_logo'],
  store_banner: ['store_banner'],
  ad_creative: ['ad_creative', 'ad_video'],
  content_block: ['content_image', 'product_image', 'product_video', 'ad_creative'],
  help_article: ['content_image'],
  verification_document: ['verification_document', 'other_document'],
  return_evidence: ['return_evidence'],
  case_evidence: ['case_evidence', 'return_evidence', 'inspection_photo', 'message_attachment', 'verification_document'],
  // orders keep the product snapshot image of past orders
  order_evidence: ['product_image', 'offer_photo', 'product_video'],
  inspection_photo: ['inspection_photo'],
  correction_evidence: ['product_image', 'other_document', 'verification_document', 'case_evidence'],
  trust_evidence: ['case_evidence', 'return_evidence', 'inspection_photo', 'message_attachment', 'verification_document', 'other_document', 'product_image'],
  dispute_evidence: ['case_evidence', 'return_evidence', 'inspection_photo', 'message_attachment', 'other_document'],
  supplier_document: ['other_document', 'inspection_photo', 'bulk_file'],
  review_photo: ['review_photo'],
  message_attachment: ['message_attachment'],
  bulk_file: ['bulk_file'],
  generated: GENERATED_PURPOSES,
};

export const purposeFitsUsage = (purpose: string, kind: UsageKind): boolean => USAGE_PURPOSES[kind]?.includes(purpose) ?? false;
export const purposesForUsage = (kind: UsageKind): readonly string[] => USAGE_PURPOSES[kind] ?? [];

export const sameOwner = (a: { kind: string; id?: string | null }, b: { kind: string; id?: string | null }) => a.kind === b.kind && (a.id ?? null) === (b.id ?? null);

/* ------------------------------------------------------------------ deletion */

export interface DeleteCheck {
  deletable: boolean;
  code?: 'ASSET_IN_USE' | 'ASSET_RETAINED';
  reason?: string;
}

export const KIND_NOUN: Record<UsageKind, [string, string]> = {
  product_image: ['product', 'products'],
  variant_image: ['variant', 'variants'],
  product_video: ['product', 'products'],
  offer_photo: ['offer', 'offers'],
  brand_logo: ['brand', 'brands'],
  brand_banner: ['brand', 'brands'],
  category_image: ['category', 'categories'],
  store_logo: ['store logo', 'store logos'],
  store_banner: ['store banner', 'store banners'],
  ad_creative: ['ad', 'ads'],
  content_block: ['page', 'pages'],
  help_article: ['help article', 'help articles'],
  verification_document: ['verification', 'verifications'],
  return_evidence: ['return', 'returns'],
  case_evidence: ['case', 'cases'],
  order_evidence: ['order', 'orders'],
  inspection_photo: ['inspection', 'inspections'],
  correction_evidence: ['catalog correction', 'catalog corrections'],
  trust_evidence: ['trust case', 'trust cases'],
  dispute_evidence: ['payment dispute', 'payment disputes'],
  supplier_document: ['purchase order', 'purchase orders'],
  review_photo: ['review', 'reviews'],
  message_attachment: ['message', 'messages'],
  bulk_file: ['bulk update', 'bulk updates'],
  generated: ['record', 'records'],
};

const EVIDENCE_LABEL: Record<string, string> = {
  verification_document: 'verification evidence',
  return_evidence: 'return evidence',
  case_evidence: 'case evidence',
  order_evidence: 'order evidence',
  inspection_photo: 'inspection evidence',
  correction_evidence: 'catalog correction evidence',
  trust_evidence: 'trust evidence',
  dispute_evidence: 'payment dispute evidence',
  supplier_document: 'supplier document',
};

/** "Used by 2 products, 1 ad" from the active usages */
export function usedByText(usages: readonly { kind: string }[]): string {
  const counts = new Map<string, number>();
  for (const u of usages) {
    const [one, many] = KIND_NOUN[u.kind as UsageKind] ?? ['record', 'records'];
    const key = `${one}\u0000${many}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts].map(([key, n]) => {
    const [one, many] = key.split('\u0000') as [string, string];
    return `${n} ${n === 1 ? one : many}`;
  });
  return `Used by ${parts.join(', ')}`;
}

export function monthYear(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone }).format(at);
}

/**
 * A file in use can't be deleted (ASSET_IN_USE); evidence can't be deleted before retainUntil (ASSET_RETAINED).
 * The status rules (only ready or rejected files can be deleted) are the state machine's.
 */
export function deleteCheck(
  asset: { retainUntil: Date | null },
  activeUsages: readonly { kind: string }[],
  evidenceKinds: readonly string[],
  now: Date,
  timeZone: string,
): DeleteCheck {
  const reasons: string[] = [];
  let code: DeleteCheck['code'];
  if (activeUsages.length) {
    reasons.push(usedByText(activeUsages));
    code = 'ASSET_IN_USE';
  }
  if (asset.retainUntil && asset.retainUntil > now) {
    const kind = evidenceKinds.at(-1);
    reasons.push(`Kept as ${(kind && EVIDENCE_LABEL[kind]) || 'evidence'} until ${monthYear(asset.retainUntil, timeZone)}`);
    code ??= 'ASSET_RETAINED';
  }
  return reasons.length ? { deletable: false, code, reason: reasons.join(' · ') } : { deletable: true };
}

/** retainUntil after an evidence use: never earlier than before */
export function extendRetention(current: Date | null, from: Date, days: number): Date {
  const next = new Date(from.getTime() + days * 86_400_000);
  return current && current > next ? current : next;
}

/** Hard limits that reject a file whatever the purpose (decompression bombs, broken headers) */
export const MAX_IMAGE_SIDE = 30_000;
export const MAX_IMAGE_PIXELS = 150_000_000;
