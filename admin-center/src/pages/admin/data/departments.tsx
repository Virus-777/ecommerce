import { slugify as slugText } from '@marketly/web-shared/lib/format';
import { useRef, useState, type ReactNode } from 'react';
import { errorMessage, resolveProductImageSpec, uploadMedia, useApi, type components } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { Alert, Breadcrumbs, Button, IconButton, ImageCropper, Img, type CropWording, type IconName, type ProcessedImage } from '@marketly/web-shared/ui';

// Helpers of the Admin › Departments pages (DeptPhones, DeptBlogs, DeptCompanies, DeptPlay; designed in React from the
// Marketly Departments canvas): API types, status labels, the access notice, and picture uploads (content_image) with
// a crop: one picture (logo, avatar, icon, cover) or an ordered list (company photos).

type S = components['schemas'];
export type MediaRef = S['MediaRef'];
export type PhonesAdmin = S['departments.PhonesAdmin'];
export type ProductCard = S['search.ProductCard'];
export type BlogTopic = S['departments.BlogTopic'];
export type BlogAuthor = S['departments.BlogAuthorAdmin'];
export type BlogPost = S['departments.BlogPostAdmin'];
export type BlogPostInput = S['departments.BlogPostInput'];
export type BlogReply = S['departments.BlogReplyAdmin'];
export type BlogReport = S['departments.BlogReportAdmin'];
export type Industry = S['departments.Industry'];
export type Company = S['departments.CompanyAdmin'];
export type CompanyInput = S['departments.CompanyInput'];
export type Inquiry = S['departments.InquiryAdmin'];
export type Game = S['departments.GameAdmin'];
export type GameInput = S['departments.GameInput'];
export type RankingTable = S['departments.RankingTable'];
export type Period = RankingTable['period'];

export const PAGE_SIZE = 20;

/** The slug the backend saves when none is given (lowercase words joined by -) */
export const slugify = (s: string) => slugText(s, 'item');
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const totalPagesOf = (d: unknown) => Math.max(1, (d as { totalPages?: number } | undefined)?.totalPages ?? 1);

export const POST_STATUS: Record<BlogPost['status'], string> = { draft: 'Draft', published: 'Published', unpublished: 'Unpublished' };
export const SHOWN_STATUS: Record<'published' | 'hidden', string> = { published: 'Published', hidden: 'Hidden' };
export const INQUIRY_STATUS: Record<Inquiry['status'], string> = { new: 'New', replied: 'Replied', closed: 'Closed' };
export const REPORT_STATUS: Record<BlogReport['status'], string> = { open: 'Open', upheld: 'Upheld', dismissed: 'Dismissed' };
export const REPORT_REASON: Record<BlogReport['reason'], string> = { spam: 'Spam', offensive: 'Offensive', misleading: 'Misleading', other: 'Other' };
export const PERIODS: Array<{ value: Period; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'all_time', label: 'All time' },
];

/** Page frame: breadcrumbs, title and the notice shown without departments.view */
export function DeptPage({ active, title, canView, children }: { active: string; title: string; canView: boolean; children: ReactNode }) {
  if (!canView) {
    return (
      <AdminLayout active={active}>
        <div className="page-head">
          <div className="t">
            <Breadcrumbs items={[{ label: 'Admin' }, { label: 'Departments' }]} />
            <h1 className="h1">{title}</h1>
          </div>
        </div>
        <Alert tone="info" title={`You don’t have access to ${title}`}>
          Viewing the department pages needs the “See the department pages’ content” permission. A Platform Administrator can change your roles in Staff and roles.
        </Alert>
      </AdminLayout>
    );
  }
  return <AdminLayout active={active}>{children}</AdminLayout>;
}

/* ---------------- Picture uploads ---------------- */

export type PictureShape = 'square' | 'wide';
const SPEC: Record<PictureShape, ReturnType<typeof resolveProductImageSpec>> = {
  square: resolveProductImageSpec({ aspectRatio: '1:1', detailWidth: 600, thumbnailWidth: 240, quality: 85 }),
  wide: resolveProductImageSpec({ aspectRatio: '16:9', detailWidth: 1200, thumbnailWidth: 480, quality: 85 }),
};
const WORDING: Record<PictureShape, CropWording> = {
  square: { what: 'pictures', place: 'center the subject', detail: ['Detail page', 'the detail page'], thumbnail: ['Lists', 'lists'] },
  wide: { what: 'pictures', place: 'frame the subject', detail: ['Detail page', 'the detail page'], thumbnail: ['Cards', 'cards'] },
};

/** Uploads a cropped picture (purpose content_image); MediaRef.url must be absolute (the API keeps the picture by id). */
function useUpload(shape: PictureShape, alt: string, onDone: (m: MediaRef) => void) {
  const { session } = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const upload = async (img: ProcessedImage) => {
    setBusy(true);
    setError('');
    try {
      const asset = await uploadMedia(session, img.file, 'content_image', alt ? { alt } : {});
      const url = new URL(asset.url || img.thumbUrl, window.location.origin).href;
      onDone({ id: asset.id, url, alt: alt || null, width: asset.width ?? SPEC[shape].detail.width, height: asset.height ?? SPEC[shape].detail.height });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, upload };
}

function useFilePicker({ onFiles }: { onFiles: (f: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return { open: () => input.current?.click(), el: <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => (onFiles([...(e.target.files ?? [])].slice(0, 1)), (e.target.value = ''))} /> };
}

/** One picture: logo, avatar, game icon (square) or cover (16 : 9). */
export function PictureField({ label, value, onChange, shape, icon, alt, hint, disabled }: { label: string; value: MediaRef | null | undefined; onChange: (m: MediaRef | null) => void; shape: PictureShape; icon: IconName; alt: string; hint: string; disabled: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  const { busy, error, upload } = useUpload(shape, alt, onChange);
  const pick = useFilePicker({ onFiles: setFiles });
  return (
    <div className="stack gap-2">
      <span className="label">{label}</span>
      <div className="row gap-3 items-center">
        <div style={shape === 'wide' ? { width: 220 } : undefined}>
          <Img icon={icon} src={value?.url} alt={value ? alt : ''} className={shape === 'wide' ? 'wide' : 'xl'} />
        </div>
        <div className="stack gap-2">
          <span className="xs sub">{hint}</span>
          {!disabled && (
            <div className="row gap-2 wrap">
              <Button variant="secondary" size="sm" icon="upload" onClick={pick.open} disabled={busy}>
                {busy ? 'Uploading…' : value ? 'Replace' : 'Upload'}
              </Button>
              {value && (
                <Button variant="ghost" size="sm" onClick={() => onChange(null)} disabled={busy}>
                  Remove
                </Button>
              )}
              {pick.el}
            </div>
          )}
          {error && <span className="xs t-danger-text">{error}</span>}
        </div>
      </div>
      {files.length > 0 && <ImageCropper files={files} spec={SPEC[shape]} wording={WORDING[shape]} onProcessed={(img) => void upload(img)} onClose={() => setFiles([])} />}
    </div>
  );
}

/** An ordered list of 16 : 9 pictures (company photos). */
export function PhotosField({ photos, onChange, max, alt, disabled }: { photos: MediaRef[]; onChange: (p: MediaRef[]) => void; max: number; alt: string; disabled: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  const { busy, error, upload } = useUpload('wide', alt, (m) => onChange([...photos, m]));
  const pick = useFilePicker({ onFiles: setFiles });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= photos.length) return;
    const next = [...photos];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="stack gap-2">
      <span className="label">
        Photos ({photos.length} of {max})
      </span>
      {photos.length > 0 && (
        <ul className="list">
          {photos.map((m, i) => (
            <li key={m.id}>
              <Img icon="image" src={m.url} alt="" className="thumb" />
              <span className="grow small">{i === 0 ? 'Photo 1 · first in the carousel' : `Photo ${i + 1}`}</span>
              {!disabled && (
                <>
                  <IconButton icon="arrow-up" label={`Move photo ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon="arrow-down" label={`Move photo ${i + 1} down`} disabled={i === photos.length - 1} onClick={() => move(i, 1)} />
                  <IconButton icon="x" label={`Remove photo ${i + 1}`} onClick={() => onChange(photos.filter((x) => x.id !== m.id))} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <span className="xs sub">16 : 9, saved at 1200 × 675. The first photos show in the carousel, the rest in the gallery.</span>
      {!disabled && photos.length < max && (
        <div className="row gap-2">
          <Button variant="secondary" size="sm" icon="upload" onClick={pick.open} disabled={busy}>
            {busy ? 'Uploading…' : 'Add photo'}
          </Button>
          {pick.el}
        </div>
      )}
      {error && <span className={cx('xs', 't-danger-text')}>{error}</span>}
      {files.length > 0 && <ImageCropper files={files} spec={SPEC.wide} wording={WORDING.wide} onProcessed={(img) => void upload(img)} onClose={() => setFiles([])} />}
    </div>
  );
}
