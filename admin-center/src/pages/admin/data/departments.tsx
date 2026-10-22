import { slugify as slugText } from '@marketly/web-shared/lib/format';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { call, errorMessage, resolveProductImageSpec, uploadMedia, useApi, type components } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { Alert, Breadcrumbs, Button, Dialog, Field, IconButton, ImageCropper, Img, Textarea, type CropWording, type IconName, type ProcessedImage } from '@marketly/web-shared/ui';

// Helpers of the Admin › Departments pages (DeptPhones, DeptBlogs, DeptCompanies, DeptPlay; designed in React from the
// Marketly Departments canvas): API types, status labels, the access notice, drag to reorder, and picture uploads
// (content_image) with a crop: one picture (logo, avatar, icon, cover) or an ordered list (company photos).

type S = components['schemas'];
export type MediaRef = S['MediaRef'];
export type PhoneAdmin = S['departments.PhoneAdmin'];
export type PhoneInput = S['departments.PhoneInput'];
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
export type FarmAdmin = S['departments.FarmAdmin'];
export type FarmType = S['departments.FarmType'];
export type FarmMachineInput = S['departments.FarmMachineInput'];
export type ServiceArea = S['services.ServiceCategory']['area'];
export type ServiceCategory = S['services.ServiceCategory'];
export type Provider = S['services.ProviderAdmin'];
export type ProviderInput = S['services.ProviderInput'];
export type OpeningDay = S['services.OpeningDay'];
export type ProviderStaff = S['services.ProviderStaff'];
export type Service = S['services.ServiceAdmin'];
export type ServiceInput = S['services.ServiceInput'];
export type HandoverOption = S['services.HandoverOption'];
export type PriceRow = S['services.PriceRow'];
export type ServiceStep = S['services.ServiceStep'];
export type ServiceRequest = S['services.RequestAdmin'];
export type RequestStatus = ServiceRequest['status'];
export type RequestUpdate = S['services.RequestUpdate'];
export type ServiceReview = S['services.ReviewAdmin'];
export type Money = S['Money'];
export type SoftwareCategory = S['software.SoftwareCategory'];
export type AppRow = S['software.AppAdminRow'];
export type AppAdmin = S['software.AppAdmin'];
export type AppInput = S['software.AppInput'];
export type AppFile = S['software.AppFile'];
export type AppStatus = AppAdmin['status'];
export type Platform = AppAdmin['platforms'][number];
export type VersionEntry = S['software.VersionEntry'];
export type AppPermission = S['software.AppPermission'];
export type Pack = S['software.PackAdmin'];
export type PackInput = S['software.PackInput'];
export type Rail = S['software.RailAdmin'];
export type SoftwarePurchase = S['software.PurchaseAdmin'];
export type PurchaseStatus = SoftwarePurchase['status'];
export type AppReview = S['software.ReviewAdmin'];
export type FoodCategory = S['food.FoodCategory'];
export type Restaurant = S['food.RestaurantAdmin'];
export type RestaurantInput = S['food.RestaurantInput'];
export type RestaurantStatus = Restaurant['status'];
export type FoodDay = S['food.OpeningDay'];
export type MenuSection = S['food.MenuSectionAdmin'];
export type MenuItem = S['food.MenuItemAdmin'];
export type MenuItemInput = S['food.MenuItemInput'];
export type OptionGroup = S['food.OptionGroup'];
export type FoodOrder = S['food.FoodOrderAdmin'];
export type FoodOrderStatus = FoodOrder['status'];
export type FoodAction = FoodOrder['actions'][number];
export type FoodReview = S['food.ReviewAdmin'];
export type RewardsProgram = S['rewards.ProgramAdmin'];
export type RewardTask = S['rewards.TaskAdmin'];
export type TaskKind = RewardTask['kind'];
export type Reward = S['rewards.RewardAdmin'];
export type RewardTint = Reward['tint'];
export type Redemption = S['rewards.RedemptionAdmin'];
export type CustomerPoints = S['rewards.CustomerPoints'];
export type GamePrize = S['departments.GamePrizeAdmin'];
export type GameKey = S['departments.GameKey'];
export type PrizeAward = S['departments.PrizeAward'];
export type PlayerLookup = S['departments.PlayerLookup'];
export type DeptReview = S['departments.ReviewAdmin'];
export type ReviewTargetType = DeptReview['target']['type'];
export type Entitlement = S['software.EntitlementAdmin'];
export type GeoPoint = S['customers.GeoPoint'];

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

/** The four service areas: which department page they belong to (services spec notes) */
export const AREA: Record<ServiceArea, { title: string; nav: string; icon: IconName; noun: string }> = {
  os_install: { title: 'OS install', nav: 'dept-os-install', icon: 'wrench', noun: 'OS install' },
  post_sale: { title: 'Post-sale services', nav: 'dept-post-sale', icon: 'shield-check', noun: 'post-sale service' },
  welfare: { title: 'Welfare services', nav: 'dept-welfare', icon: 'hand-heart', noun: 'welfare service' },
  booking: { title: 'Booking', nav: 'dept-booking', icon: 'calendar-check', noun: 'booking' },
};
export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: 'brand' | 'info' | 'warning' | 'success' | 'danger' | '' }> = {
  requested: { label: 'Requested', tone: 'brand' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  in_progress: { label: 'In progress', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: '' },
  declined: { label: 'Declined', tone: 'danger' },
};
export const PRICE_UNIT: Record<Service['priceUnit'], string> = { fixed: 'Fixed price', hour: 'Per hour', visit: 'Per visit', night: 'Per night', free: 'Free' };
export const HANDOVER: Record<HandoverOption['mode'], string> = { dropoff: 'Drop-off', pickup: 'Pickup', at_home: 'At home', online: 'Online' };
export const WEEKDAYS: Array<{ value: OpeningDay['weekday']; label: string }> = [
  { value: 'mon', label: 'Monday' },
  { value: 'tue', label: 'Tuesday' },
  { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' },
  { value: 'fri', label: 'Friday' },
  { value: 'sat', label: 'Saturday' },
  { value: 'sun', label: 'Sunday' },
];
/** Dollars typed in a field ↔ API money (minor units, USD) */
export const toMoney = (dollars: string): Money | null => (dollars.trim() && !Number.isNaN(Number(dollars)) ? { amount: Math.round(Number(dollars) * 100), currency: 'USD' } : null);
export const moneyText = (m: Money | null | undefined) => (m ? String(m.amount / 100) : '');
export const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
type BadgeTone = 'brand' | 'info' | 'warning' | 'success' | 'danger' | 'outline' | '';

/* ---------------- Softwares, Food delivery and Daily rewards (Phase 3) ---------------- */

export const APP_STATUS: Record<AppStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'outline' },
  in_review: { label: 'In review', tone: 'warning' },
  published: { label: 'Published', tone: 'success' },
  hidden: { label: 'Hidden', tone: 'outline' },
};
export const PLATFORMS: Array<{ value: Platform; label: string }> = [
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
  { value: 'web', label: 'Web' },
];
export const platformLabel = (p: Platform) => PLATFORMS.find((x) => x.value === p)?.label ?? p;
export const PURCHASE_STATUS: Record<PurchaseStatus, { label: string; tone: BadgeTone }> = {
  pending_payment: { label: 'Waiting for payment', tone: 'info' },
  requires_action: { label: 'Needs the bank’s check', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  failed: { label: 'Payment failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: '' },
};
export const FOOD_ORDER_STATUS: Record<FoodOrderStatus, { label: string; tone: BadgeTone }> = {
  payment_pending: { label: 'Waiting for payment', tone: 'info' },
  payment_failed: { label: 'Payment failed', tone: 'danger' },
  placed: { label: 'New', tone: 'brand' },
  accepted: { label: 'Accepted', tone: 'info' },
  preparing: { label: 'Preparing', tone: 'warning' },
  on_the_way: { label: 'On the way', tone: 'warning' },
  delivered: { label: 'Delivered', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: '' },
  declined: { label: 'Declined', tone: 'danger' },
};
export const RESTAURANT_STATUS: Record<RestaurantStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'outline' },
  published: { label: 'Published', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  hidden: { label: 'Hidden', tone: 'outline' },
};
export const TASK_KIND: Record<TaskKind, { label: string; hint: string }> = {
  visit_store: { label: 'Visit a store page', hint: 'Counts store pages the customer opens (/stores/…)' },
  share_product: { label: 'Share a product', hint: 'Counts products shared from the product page' },
  write_review: { label: 'Write a review', hint: 'Counts reviews the customer writes' },
  place_order: { label: 'Place an order', hint: 'Counts orders the customer places' },
};
export const TINTS: Array<{ value: RewardTint; label: string }> = [
  { value: 'deal', label: 'Deal (orange)' },
  { value: 'brand', label: 'Brand (green)' },
  { value: 'info', label: 'Info (blue)' },
  { value: 'neutral', label: 'Neutral (grey)' },
];
/** File sizes the way the API labels them: 1,000-based units, one decimal above 1 GB (software spec notes) */
export const sizeLabel = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : bytes >= 1e3 ? `${Math.round(bytes / 1e3)} KB` : `${bytes} B`);
/** The API's VALIDATION_FAILED issues by field path (details.issues), '' when the error has none */
export const fieldErrorsOf = (e: unknown): Record<string, string> => (e && typeof e === 'object' && 'fieldErrors' in e ? ((e as { fieldErrors: Record<string, string> }).fieldErrors ?? {}) : {});
/** An error's code (IN_USE, PAYMENT_CAPTURE_FAILED…) */
export const codeOf = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '');

/** Page frame: breadcrumbs, title and the notice shown without the view permission (departments.view unless `need` names another) */
export function DeptPage({ active, title, canView, need, children }: { active: string; title: string; canView: boolean; need?: string; children: ReactNode }) {
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
          Viewing {need ? 'this page' : 'the department pages'} needs the “{need ?? 'See the department pages’ content'}” permission. A Platform Administrator can change your roles in Staff and roles.
        </Alert>
      </AdminLayout>
    );
  }
  return <AdminLayout active={active}>{children}</AdminLayout>;
}

/* ---------------- Lists of short lines ---------------- */

/** An ordered list of short text lines (what's included, requirements, highlights…): add, edit, move, remove. */
export function LinesField({ id, label, hint, lines, onChange, placeholder, max = 30, disabled }: { id: string; label: string; hint?: string; lines: string[]; onChange: (l: string[]) => void; placeholder?: string; max?: number; disabled: boolean }) {
  const [text, setText] = useState('');
  const add = () => {
    const v = text.trim();
    if (!v || lines.length >= max) return;
    onChange([...lines, v]);
    setText('');
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= lines.length) return;
    const next = [...lines];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="stack gap-2">
      <span className="label">
        {label} <span className="muted">({lines.length})</span>
      </span>
      {hint && <span className="xs sub">{hint}</span>}
      {lines.length > 0 && (
        <ul className="list">
          {lines.map((l, i) => (
            <li key={`${i}-${l}`}>
              <input className="input grow" aria-label={`${label} ${i + 1}`} value={l} disabled={disabled} onChange={(e) => onChange(lines.map((x, k) => (k === i ? e.target.value : x)))} />
              {!disabled && (
                <>
                  <IconButton icon="arrow-up" label={`Move line ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon="arrow-down" label={`Move line ${i + 1} down`} disabled={i === lines.length - 1} onClick={() => move(i, 1)} />
                  <IconButton icon="x" label={`Remove line ${i + 1}`} onClick={() => onChange(lines.filter((_, k) => k !== i))} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && lines.length < max && (
        <div className="row gap-2">
          <input className="input grow" id={id} placeholder={placeholder ?? 'Add a line'} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
          <Button variant="secondary" size="sm" icon="plus" onClick={add} disabled={!text.trim()}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------------- Drag to reorder ---------------- */

/**
 * Drag to reorder by a handle, as Content › Homepage sections does it: the item moves as the pointer passes another
 * row's middle (or, in a grid, enters another cell), and dropping calls onSort with the new order. Window listeners
 * (not pointer capture) because React moves the item's node; Escape cancels. The handle is a button, so keyboard and
 * screen reader users move the item one place with the arrow keys.
 */
export function useDragSort({ keys, onSort, grid, disabled }: { keys: string[]; onSort: (keys: string[], moved: string) => void; grid?: boolean; disabled?: boolean }) {
  const [drag, setDrag] = useState<{ key: string; keys: string[] } | null>(null);
  // live.current is the drag as of the last pointer event (a drop can follow a move before React re-renders)
  const live = useRef(drag);
  const setLive = (d: typeof drag) => {
    live.current = d;
    setDrag(d);
  };
  const items = useRef(new Map<string, HTMLElement>());
  const handles = useRef(new Map<string, HTMLElement>());
  const move = useRef<(x: number, y: number) => void>(() => {});
  move.current = (x, y) => {
    const d = live.current;
    if (!d) return;
    const rect = (k: string) => items.current.get(k)?.getBoundingClientRect();
    const others = d.keys.filter((k) => k !== d.key);
    let at: number;
    if (grid) {
      const over = d.keys.find((k) => {
        const r = rect(k);
        return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      if (!over || over === d.key) return;
      at = d.keys.indexOf(over);
    } else {
      at = others.filter((k) => {
        const r = rect(k);
        return !!r && r.top + r.height / 2 < y;
      }).length;
    }
    const next = [...others.slice(0, at), d.key, ...others.slice(at)];
    if (next.some((k, i) => k !== d.keys[i])) setLive({ ...d, keys: next });
  };
  const finish = useRef<(save: boolean) => void>(() => {});
  finish.current = (save) => {
    const d = live.current;
    if (!d) return;
    setLive(null);
    if (save && d.keys.some((k, i) => k !== keys[i])) onSort(d.keys, d.key);
  };
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => move.current(e.clientX, e.clientY);
    const up = () => finish.current(true);
    const cancel = () => finish.current(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && cancel();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
    };
  }, [dragging]);
  const start = (e: ReactPointerEvent, key: string) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    setLive({ key, keys });
  };
  const shift = (key: string, by: number) => {
    const i = keys.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= keys.length) return;
    const next = [...keys];
    [next[i], next[j]] = [next[j], next[i]];
    onSort(next, key);
    // React moves the focused handle's node: keep the focus on it
    requestAnimationFrame(() => handles.current.get(key)?.focus());
  };
  return {
    /** The keys in the order to show (the dragged order while dragging) */
    order: drag?.keys ?? keys,
    dragged: drag?.key ?? null,
    /** ref of an item (row or cell) the pointer is measured against */
    item: (key: string) => (el: HTMLElement | null) => void (el ? items.current.set(key, el) : items.current.delete(key)),
    /** starts a drag from anywhere on an item (e.g. a photo) */
    start,
    /** props of the handle button: pointer drag and arrow keys */
    handle: (key: string) => ({
      ref: (el: HTMLElement | null) => void (el ? handles.current.set(key, el) : handles.current.delete(key)),
      onPointerDown: (e: ReactPointerEvent) => start(e, key),
      onKeyDown: (e: ReactKeyboardEvent) => {
        const by = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0;
        if (!by || disabled) return;
        e.preventDefault();
        shift(key, by);
      },
      style: { cursor: disabled ? undefined : drag?.key === key ? 'grabbing' : 'grab', touchAction: 'none' } as const,
    }),
  };
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
export function PhotosField({ photos, onChange, max, alt, disabled, label = 'Photos', hint = '16 : 9, saved at 1200 × 675. The first photos show in the carousel, the rest in the gallery.' }: { photos: MediaRef[]; onChange: (p: MediaRef[]) => void; max: number; alt: string; disabled: boolean; label?: string; hint?: string }) {
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
        {label} ({photos.length} of {max})
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
      <span className="xs sub">{hint}</span>
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

/* ---------------- Coupon campaigns ---------------- */

/** Platform coupon campaigns (percent and fixed amount): the codes a reward or a prize tier hands out */
export function useCouponCampaigns(enabled: boolean) {
  const { api } = useApi();
  const get = (kind: string) => call(api.GET('/api/admin/promotions/campaigns', { params: { query: { kind, ownerKind: 'platform', limit: 100 } } }));
  return useQuery({
    queryKey: ['promotions', 'campaigns', 'coupons'],
    enabled,
    queryFn: async () => {
      const [pct, fixed] = await Promise.all([get('percent_coupon'), get('fixed_coupon')]);
      return [...pct.items, ...fixed.items].sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

/* ---------------- Review moderation ---------------- */

/** Hide a review with an optional reason (Softwares and Food delivery reviews; POST …/reviews/{id}/moderate). */
export function HideReviewDialog({ open, who, busy, error, onClose, onHide }: { open: boolean; who: string; busy: boolean; error?: string; onClose: () => void; onHide: (reason: string | null) => void }) {
  const [reason, setReason] = useState('');
  const close = () => (setReason(''), onClose());
  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Hide ${who}’s review`}
      foot={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => onHide(reason.trim() || null)} disabled={busy}>
            Hide review
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger" title={error} />}
      <p className="small sub" style={{ margin: 0 }}>
        Hidden reviews leave the app and stop counting in the rating. You can show it again later.
      </p>
      <Field label="Reason" optional hint="Only staff see it, e.g. Spam or Personal details">
        <Textarea id="rv-hide-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}
