import { RichText as SharedRichText, type ContentLink } from '@marketly/web-shared/ui';
import { actorLabel } from '@/app/parts';
import { fromZonedInput, zonedInput } from '@marketly/web-shared/lib/dates';
import { useRef, useState } from 'react';
import { errorMessage, resolveProductImageSpec, uploadMedia, useApi, type components } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { Button, Icon, IconButton, ImageCropper, Img, type CropWording, type IconName, type ProcessedImage } from '@marketly/web-shared/ui';

// Helpers of the News page (pages/admin/News.tsx; designed in React from docs/06-news.md): types, status labels,
// Pacific-time conversions for datetime-local inputs, the body editor (the help article toolbar + textarea), the
// cover upload with a 16 : 9 crop, and the rich-text renderer for the preview.

type S = components['schemas'];
export type NewsAdmin = S['content.NewsAdmin'];
export type NewsRow = S['content.NewsAdminSummary'];
export type NewsCategory = S['content.NewsCategory'];
export type NewsInput = S['content.NewsInput'];
export type NewsStatus = NewsAdmin['status'];
export type MediaRef = S['MediaRef'];
export const TITLE_MAX = 90;
export const SUMMARY_MAX = 200;
export const CATEGORY_NAME_MAX = 30;

export const STATUS_LABEL: Record<NewsStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  published: 'Published',
  unpublished: 'Unpublished',
  removed: 'Removed',
};

/** List status: a published post past its archive time shows "Archived". */
export const rowStatus = (r: { status: NewsStatus; archived: boolean }) => (r.archived ? 'Archived' : STATUS_LABEL[r.status]);

/** List tabs ↔ the API's status filter and the counts of GET /news/counts. */
export type TabKey = 'all' | 'draft' | 'in_review' | 'scheduled' | 'published' | 'archived';
export const TABS: Array<{ value: TabKey; label: string; count: keyof S['content.NewsStatusCounts'] }> = [
  { value: 'all', label: 'All', count: 'all' },
  { value: 'draft', label: 'Drafts', count: 'draft' },
  { value: 'in_review', label: 'In review', count: 'inReview' },
  { value: 'scheduled', label: 'Scheduled', count: 'scheduled' },
  { value: 'published', label: 'Published', count: 'published' },
  { value: 'archived', label: 'Archived', count: 'archived' },
];

/** Content icons a category can show when a post has no cover. */
export const CATEGORY_ICONS: Array<{ value: IconName; label: string }> = [
  { value: 'megaphone', label: 'Megaphone' },
  { value: 'truck', label: 'Truck' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'shield-check', label: 'Shield' },
  { value: 'store', label: 'Store' },
  { value: 'tag', label: 'Tag' },
  { value: 'gift', label: 'Gift' },
  { value: 'star', label: 'Star' },
  { value: 'zap', label: 'Lightning' },
  { value: 'newspaper', label: 'Newspaper' },
];
const ICON_SET = new Set<string>(CATEGORY_ICONS.map((i) => i.value));
/** A category's icon, or the newspaper when it has none (or one this app doesn't know). */
export const categoryIcon = (icon?: string | null): IconName => (icon && ICON_SET.has(icon) ? (icon as IconName) : 'newspaper');

export const actorName = (a: unknown) => actorLabel(a as { kind?: string; name?: string | null } | null) || undefined;

/* ---------------- Market time (PT) for datetime-local inputs ---------------- */

export const TZ = 'America/Los_Angeles';

/** "2026-10-20T09:00" in Pacific Time → ISO instant. */
export const wallToIso = (wall: string) => fromZonedInput(wall, TZ) ?? '';
/** ISO instant → "2026-10-20T09:00" in Pacific Time ('' for none). */
export const isoToWall = (iso?: string | null) => zonedInput(iso, TZ);

/* ---------------- Body editor (same toolbar + textarea as help articles) ---------------- */

const FORMATS: Array<{ icon: IconName; label: string; wrap: [string, string] }> = [
  { icon: 'heading-2', label: 'Heading', wrap: ['<h2>', '</h2>'] },
  { icon: 'bold', label: 'Bold', wrap: ['<strong>', '</strong>'] },
  { icon: 'italic', label: 'Italic', wrap: ['<em>', '</em>'] },
  { icon: 'list', label: 'Bulleted list', wrap: ['<ul><li>', '</li></ul>'] },
  { icon: 'list-ordered', label: 'Numbered list', wrap: ['<ol><li>', '</li></ol>'] },
  { icon: 'link', label: 'Insert link', wrap: ['<a href="https://">', '</a>'] },
];

export function BodyEditor({ id = 'nw-body', value, onChange, error, disabled }: { id?: string; value: string; onChange: (v: string) => void; error?: string; disabled: boolean }) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const format = (wrap: [string, string]) => {
    const ta = bodyRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    onChange(v.slice(0, s) + wrap[0] + v.slice(s, e) + wrap[1] + v.slice(e));
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + wrap[0].length, e + wrap[0].length);
    });
  };
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        Body
      </label>
      <div className="ab-edbar" role="toolbar" aria-label="Formatting">
        {FORMATS.map((f) => (
          <IconButton key={f.label} icon={f.icon} label={f.label} onClick={() => format(f.wrap)} disabled={disabled} />
        ))}
      </div>
      <textarea
        ref={bodyRef}
        className={cx('textarea', error && 'is-error')}
        id={id}
        rows={10}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      {error && (
        <span className="error-text" id={`${id}-err`}>
          <Icon name="circle-alert" className="ic-sm" />
          {error}
        </span>
      )}
    </div>
  );
}

/* ---------------- Cover image (16 : 9, 1200 × 675) ---------------- */

const COVER_SPEC = resolveProductImageSpec({ aspectRatio: '16:9', detailWidth: 1200, thumbnailWidth: 480, quality: 85 });
const COVER_WORDING: CropWording = { what: 'news covers', place: 'frame the subject', detail: ['Post page', 'the post page'], thumbnail: ['News cards', 'news cards'] };

/** Upload with a 16 : 9 crop (purpose content_image). `onChange` gets the MediaRef for NewsInput.cover and a preview URL. */
export function CoverField({ cover, preview, alt, icon, disabled, onChange }: { cover: MediaRef | null; preview?: string; alt: string; icon: IconName; disabled: boolean; onChange: (cover: MediaRef | null, preview?: string) => void }) {
  const { session } = useApi();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const upload = async (img: ProcessedImage) => {
    setBusy(true);
    setError('');
    try {
      const asset = await uploadMedia(session, img.file, 'content_image', alt ? { alt } : {});
      // MediaRef.url must be an absolute URL; the backend resolves the cover by its id.
      const url = new URL(asset.url || img.thumbUrl, window.location.origin).href;
      onChange({ id: asset.id, url, alt: alt || null, width: asset.width ?? COVER_SPEC.detail.width, height: asset.height ?? COVER_SPEC.detail.height }, img.thumbUrl);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack gap-2">
      <span className="label">Cover image</span>
      <div className="nw-cover">
        <Img icon={icon} src={preview ?? cover?.url} alt={cover ? alt : ''} className="wide" />
      </div>
      <span className="xs sub">16 : 9, saved at 1200 × 675. Without a cover, cards show the category icon.</span>
      {!disabled && (
        <div className="row gap-2 wrap">
          <Button variant="secondary" size="sm" icon="upload" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Uploading…' : cover ? 'Replace cover' : 'Upload cover'}
          </Button>
          {cover && (
            <Button variant="ghost" size="sm" onClick={() => onChange(null)} disabled={busy}>
              Remove cover
            </Button>
          )}
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(e) => {
              setFiles([...(e.target.files ?? [])].slice(0, 1));
              e.target.value = '';
            }}
          />
        </div>
      )}
      {error && <span className="xs t-danger-text">{error}</span>}
      {files.length > 0 && <ImageCropper files={files} spec={COVER_SPEC} wording={COVER_WORDING} onProcessed={(img) => void upload(img)} onClose={() => setFiles([])} />}
    </div>
  );
}

/* ---------------- Rich text for the preview ---------------- */

// The store's renderer (web-shared ui/RichText), so the preview shows the post as customers will see it. Links
// don't navigate from the preview: they show their target on hover.
const PreviewLink: ContentLink = ({ url, className, children }) => (
  <span className={className} title={url}>
    {children}
  </span>
);

export const RichText = ({ html }: { html: string }) => <SharedRichText html={html} link={PreviewLink} tableLabel="Table in the post" />;
