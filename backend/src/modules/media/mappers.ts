/** Rows (snake_case) to API types (camelCase), in one place per type. */
import type { ImageCheckResult, MediaAsset, MediaOwner, Rendition, Usage } from '../../spec/media.js';
import type { AssetRow, RenditionRow, UsageRow } from './ports.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const ownerOf = (row: Pick<AssetRow, 'owner_kind' | 'owner_id' | 'owner_label'>): MediaOwner => ({
  kind: row.owner_kind as MediaOwner['kind'],
  id: row.owner_id,
  label: row.owner_label,
});

export const toRendition = (r: RenditionRow, url = r.url): Rendition => ({
  size: r.size as Rendition['size'],
  url,
  width: r.width,
  height: r.height,
  format: r.format,
  bytes: Number(r.bytes),
});

export const toUsage = (u: UsageRow): Usage => ({
  module: u.module,
  kind: u.kind,
  refId: u.ref_id,
  refLabel: u.ref_label,
  evidence: u.evidence,
  attachedAt: u.attached_at.toISOString(),
  detachedAt: iso(u.detached_at),
});

export const checkOf = (row: Pick<AssetRow, 'check_result'>): ImageCheckResult | null => (row.check_result ? (row.check_result as unknown as ImageCheckResult) : null);

export function toAsset(row: AssetRow, extra: { url: string | null; renditions: Rendition[]; usageCount: number }): MediaAsset {
  return {
    id: row.id,
    kind: row.kind as MediaAsset['kind'],
    purpose: row.purpose,
    status: row.status as MediaAsset['status'],
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    pageCount: row.page_count,
    alt: row.alt,
    title: row.title,
    owner: ownerOf(row),
    visibility: row.visibility as MediaAsset['visibility'],
    url: extra.url,
    renditions: extra.renditions,
    check: checkOf(row),
    rejectionReason: row.rejection_reason,
    inUse: extra.usageCount > 0,
    usageCount: extra.usageCount,
    retainUntil: iso(row.retain_until),
    removedAt: row.status === 'removed' ? iso(row.removed_at) : null,
    removedReason: row.status === 'removed' ? row.removed_reason : null,
    showPlaceholder: row.status === 'removed' ? row.show_placeholder : null,
    createdAt: row.created_at.toISOString(),
    readyAt: iso(row.ready_at),
  };
}
