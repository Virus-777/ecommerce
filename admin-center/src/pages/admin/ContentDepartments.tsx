import { useRef, useState } from 'react';
import { errorMessage, exactImageSpec, uploadMedia, useApi, type components } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { Badge, Button, Field, Icon, IconButton, iconFor, Img, ImageCropper, Select, Switch, TextInput, tintClass, type CropWording, type IconName, type ProcessedImage } from '@marketly/web-shared/ui';

// The Departments section of Homepage and pages (it replaced Shop by category): an ordered list of tiles, each with a
// title, an icon or picture, a tint and where it opens (a department page of the app, a category, a store page or a
// web link). The drawer shows the list; editing an item opens its form in the same drawer.

type S = components['schemas'];
export type DepartmentItem = S['content.DepartmentItem'];
type Destination = DepartmentItem['destination'];
type DepartmentKey = NonNullable<Destination['department']>;
export type CategoryOption = { id: string; name: string; visible: boolean };

// Same pages as the API (content domain rules DEPARTMENT_PAGES); built-in pages exist only in the app.
export const DEPARTMENT_PAGES: Array<{ key: DepartmentKey; title: string; path: string; icon: IconName }> = [
  { key: 'phones', title: 'Phones', path: '/phones', icon: 'smartphone' },
  { key: 'farm_machines', title: 'Farm machines', path: '/farm-machines', icon: 'tractor' },
  { key: 'software', title: 'Softwares', path: '/software', icon: 'app-window' },
  { key: 'welfare', title: 'Welfare services', path: '/welfare', icon: 'hand-heart' },
  { key: 'food', title: 'Food delivery', path: '/food', icon: 'utensils' },
  { key: 'booking', title: 'Booking', path: '/booking', icon: 'calendar-check' },
  { key: 'blogs', title: 'Blogs', path: '/blogs', icon: 'newspaper' },
  { key: 'companies', title: 'Companies', path: '/companies', icon: 'building-2' },
  { key: 'play', title: 'Play center', path: '/play', icon: 'gamepad-2' },
  { key: 'rewards', title: 'Daily rewards', path: '/rewards', icon: 'gift' },
];
const PAGE = new Map(DEPARTMENT_PAGES.map((p) => [p.key, p]));

const ICON_CHOICES: IconName[] = ['smartphone', 'tractor', 'app-window', 'hand-heart', 'utensils', 'calendar-check', 'newspaper', 'building-2', 'gamepad-2', 'gift', 'layout-grid', 'store', 'tag', 'sparkles', 'truck', 'heart', 'shirt', 'car', 'baby', 'book-open', 'music', 'camera', 'package', 'coffee', 'pizza', 'plane', 'house', 'dumbbell', 'graduation-cap', 'briefcase', 'stethoscope', 'bike'];
const TINTS = [1, 2, 3, 4, 5, 6];
const OPENS: Array<{ value: Destination['kind']; label: string }> = [
  { value: 'department', label: 'Department page (app)' },
  { value: 'category', label: 'Category' },
  { value: 'path', label: 'Store page' },
  { value: 'url', label: 'Web link' },
];
const MAX_ITEMS = 24;
const IMAGE_SPEC = exactImageSpec(400, 400);
const IMAGE_WORDING: CropWording = { what: 'department pictures', place: 'center the subject in the circle', detail: ['Departments tile', 'the Departments tile'], thumbnail: ['Small screens', 'small screens'] };

/** The ten department pages in order: a new Departments section starts with them */
export const defaultDepartments = (): DepartmentItem[] => DEPARTMENT_PAGES.map((p, i) => ({ title: p.title, icon: p.icon, tint: (i % 6) + 1, destination: { kind: 'department', department: p.key }, visible: true }));

const destinationText = (d: Destination, categories: CategoryOption[]) =>
  d.kind === 'department'
    ? `Department page · ${(d.department && PAGE.get(d.department)?.title) ?? 'not picked'}`
    : d.kind === 'category'
      ? `Category · ${categories.find((c) => c.id === d.categoryId)?.name ?? 'not picked'}`
      : d.kind === 'path'
        ? `Store page · ${d.path || 'no path'}`
        : `Web link · ${d.url || 'no address'}`;

/** What is wrong with an item, the same rules as the API; null when it can be saved */
export function departmentProblem(d: DepartmentItem, categories: CategoryOption[]): string | null {
  const title = d.title.trim();
  if (!title) return 'Give it a title.';
  if (title.length > 40) return 'Use at most 40 characters for the title.';
  if ((d.label?.trim().length ?? 0) > 24) return 'Use at most 24 characters for the short label.';
  const t = d.destination;
  if (t.kind === 'department' && !t.department) return 'Pick a department page.';
  if (t.kind === 'category' && !categories.some((c) => c.id === t.categoryId)) return 'Pick a category.';
  if (t.kind === 'path' && !/^\/(?!\/)\S*$/.test(t.path?.trim() ?? '')) return 'Use a store path that starts with /, e.g. /deals.';
  if (t.kind === 'url' && !/^https?:\/\/[^\s/]+\.\S+$/i.test(t.url?.trim() ?? '')) return 'Use a full web address, e.g. https://example.com.';
  return null;
}

/** A tile as the app draws it: the circle with the picture or icon, the label under it */
function Tile({ item }: { item: DepartmentItem }) {
  return (
    <span className="stack gap-1" style={{ alignItems: 'center', width: 88 }}>
      <Img icon={iconFor(item.icon, 'layout-grid')} tint={String(item.tint ?? 1)} className="tiny round" src={item.image?.url} alt="" />
      <span className="xs strong" style={{ textAlign: 'center' }}>
        {item.label?.trim() || item.title.trim() || 'Untitled'}
      </span>
    </span>
  );
}

export function DepartmentsField({ items, onChange, categories, error }: { items: DepartmentItem[]; onChange: (items: DepartmentItem[]) => void; categories: CategoryOption[]; error?: string }) {
  const [editing, setEditing] = useState<number | null>(null);
  const shown = items.filter((d) => d.visible).length;
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const update = (i: number, d: DepartmentItem) => onChange(items.map((x, k) => (k === i ? d : x)));
  const add = () => {
    const page = DEPARTMENT_PAGES.find((p) => !items.some((d) => d.destination.kind === 'department' && d.destination.department === p.key));
    const item: DepartmentItem = page
      ? { title: page.title, icon: page.icon, tint: (items.length % 6) + 1, destination: { kind: 'department', department: page.key }, visible: true }
      : { title: '', icon: 'layout-grid', tint: (items.length % 6) + 1, destination: { kind: 'category' }, visible: true };
    onChange([...items, item]);
    setEditing(items.length);
  };

  if (editing !== null && items[editing]) {
    return <DepartmentForm item={items[editing]} index={editing} categories={categories} onChange={(d) => update(editing, d)} onRemove={() => (onChange(items.filter((_, k) => k !== editing)), setEditing(null))} onDone={() => setEditing(null)} />;
  }

  return (
    <div className="stack gap-2">
      <span className="label">
        Departments ({shown} shown{items.length > shown ? ` · ${items.length - shown} hidden` : ''})
      </span>
      {items.length > 0 && (
        <ul className="list">
          {items.map((d, i) => {
            const problem = departmentProblem(d, categories);
            const name = d.title.trim() || 'Untitled department';
            return (
              <li key={d.id ?? `new-${i}`}>
                <Img icon={iconFor(d.icon, 'layout-grid')} tint={String(d.tint ?? 1)} className="tiny round" src={d.image?.url} alt="" />
                <span className="grow stack gap-0" style={{ minWidth: 0 }}>
                  <span className="row gap-2" style={{ minWidth: 0 }}>
                    <span className={cx('small strong truncate', !d.visible && 'muted')}>{name}</span>
                    {!d.visible && (
                      <Badge tone="outline" icon="eye-off">
                        Hidden
                      </Badge>
                    )}
                  </span>
                  <span className={cx('xs truncate', problem ? 't-danger-text' : 'muted')} title={problem ?? destinationText(d.destination, categories)}>
                    {problem ?? destinationText(d.destination, categories)}
                  </span>
                </span>
                <IconButton icon={d.visible ? 'eye' : 'eye-off'} label={d.visible ? `Hide ${name}` : `Show ${name}`} onClick={() => update(i, { ...d, visible: !d.visible })} />
                <IconButton icon="arrow-up" label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton icon="arrow-down" label={`Move ${name} down`} disabled={i === items.length - 1} onClick={() => move(i, 1)} />
                <IconButton icon="pencil" label={`Edit ${name}`} onClick={() => setEditing(i)} />
                <IconButton icon="x" label={`Remove ${name}`} onClick={() => onChange(items.filter((_, k) => k !== i))} />
              </li>
            );
          })}
        </ul>
      )}
      {error && <span className="xs t-danger-text">{error}</span>}
      <div className="row gap-2">
        <Button id="ct-adddept" variant="secondary" size="sm" icon="plus" onClick={add} disabled={items.length >= MAX_ITEMS}>
          Add a department
        </Button>
        {items.length >= MAX_ITEMS && <span className="xs muted">A Departments section holds up to {MAX_ITEMS} tiles.</span>}
      </div>
      <span className="xs sub">The app shows the tiles in two rows that scroll sideways. Department pages are app-only for now: the web store shows only categories, store pages and web links.</span>
    </div>
  );
}

function DepartmentForm({ item, index, categories, onChange, onRemove, onDone }: { item: DepartmentItem; index: number; categories: CategoryOption[]; onChange: (d: DepartmentItem) => void; onRemove: () => void; onDone: () => void }) {
  const { session } = useApi();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [tried, setTried] = useState(false);
  const d = item.destination;
  const set = (patch: Partial<DepartmentItem>) => onChange({ ...item, ...patch });
  const setDest = (patch: Partial<Destination>) => set({ destination: { ...d, ...patch } });
  const problem = departmentProblem(item, categories);
  const id = (k: string) => `dept-${index}-${k}`;

  const pickPage = (key: DepartmentKey) => {
    const p = PAGE.get(key)!;
    const prev = d.department ? PAGE.get(d.department) : undefined;
    // a title and icon that still match the previous page follow the new one
    set({ destination: { kind: 'department', department: key }, ...(!item.title.trim() || item.title === prev?.title ? { title: p.title } : {}), ...(!item.icon || item.icon === prev?.icon ? { icon: p.icon } : {}) });
  };

  const upload = async (img: ProcessedImage) => {
    setBusy(true);
    setUploadError('');
    try {
      const alt = item.title.trim();
      const asset = await uploadMedia(session, img.file, 'content_image', alt ? { alt } : {});
      // MediaRef.url must be an absolute URL
      const url = new URL(asset.url || img.thumbUrl, window.location.origin).href;
      set({ image: { id: asset.id, url, alt: alt || null, width: asset.width ?? IMAGE_SPEC.detail.width, height: asset.height ?? IMAGE_SPEC.detail.height } });
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack gap-4">
      <div className="row gap-2">
        <Button variant="ghost" size="sm" icon="arrow-left" onClick={onDone}>
          All departments
        </Button>
        <span className="grow" />
        <Tile item={item} />
      </div>
      <Field label="Title" hint="Up to 40 characters, e.g. Food delivery" error={tried && !item.title.trim() ? 'Give it a title.' : undefined}>
        <TextInput id={id('title')} value={item.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <Field label="Short label" optional hint="Shown under the tile instead of the title, up to 24 characters">
        <TextInput id={id('label')} value={item.label ?? ''} maxLength={24} onChange={(e) => set({ label: e.target.value || null })} />
      </Field>

      <div className="stack gap-2">
        <span className="label">Icon</span>
        <div role="group" aria-label="Icon" style={{ display: 'grid', gridTemplateColumns: 'repeat(8, minmax(0, 1fr))', gap: 6 }}>
          {ICON_CHOICES.map((name) => (
            <button key={name} type="button" className={cx('btn btn-sm', item.icon === name ? 'btn-soft' : 'btn-ghost')} aria-pressed={item.icon === name} aria-label={name} title={name} onClick={() => set({ icon: name })}>
              <Icon name={name} />
            </button>
          ))}
        </div>
      </div>
      <div className="stack gap-2">
        <span className="label">Tint</span>
        <div role="group" aria-label="Tint" className="row gap-2">
          {TINTS.map((t) => (
            <button key={t} type="button" className={cx('imgph tiny', tintClass(String(t)))} style={{ borderRadius: '50%', outline: (item.tint ?? 1) === t ? '2px solid var(--brand)' : undefined, outlineOffset: 2 }} aria-pressed={(item.tint ?? 1) === t} aria-label={`Tint ${t}`} onClick={() => set({ tint: t })} />
          ))}
        </div>
      </div>
      <div className="stack gap-2">
        <span className="label">Picture</span>
        <div className="row gap-2">
          {item.image && <Img icon="image" tint={String(item.tint ?? 1)} className="tiny round" src={item.image.url} alt="" />}
          <Button variant="secondary" size="sm" icon="upload" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Uploading…' : item.image ? 'Replace picture' : 'Upload picture'}
          </Button>
          {item.image && (
            <Button variant="ghost" size="sm" onClick={() => set({ image: null })}>
              Use the icon
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
        <span className="xs sub">Optional. Square, saved at 400 × 400; it fills the circle instead of the icon.</span>
        {uploadError && <span className="xs t-danger-text">{uploadError}</span>}
        {files.length > 0 && <ImageCropper files={files} spec={IMAGE_SPEC} wording={IMAGE_WORDING} onProcessed={(img) => void upload(img)} onClose={() => setFiles([])} />}
      </div>

      <Field label="Opens">
        <Select id={id('opens')} options={OPENS} value={d.kind} onChange={(e) => set({ destination: { kind: e.target.value as Destination['kind'] } })} />
      </Field>
      {d.kind === 'department' && (
        <Field label="Department page" hint={d.department ? `Opens ${PAGE.get(d.department)?.path} in the app` : undefined} error={tried && !d.department ? 'Pick a department page.' : undefined}>
          <Select id={id('page')} value={d.department ?? ''} options={[{ value: '', label: 'Choose a page…' }, ...DEPARTMENT_PAGES.map((p) => ({ value: p.key, label: p.title }))]} onChange={(e) => e.target.value && pickPage(e.target.value as DepartmentKey)} />
        </Field>
      )}
      {d.kind === 'category' && (
        <Field label="Category" hint="An empty or hidden category is left out until customers can see it" error={tried && !categories.some((c) => c.id === d.categoryId) ? 'Pick a category.' : undefined}>
          <Select id={id('category')} value={d.categoryId ?? ''} options={[{ value: '', label: 'Choose a category…' }, ...categories.map((c) => ({ value: c.id, label: c.visible ? c.name : `${c.name} (hidden)` }))]} onChange={(e) => setDest({ categoryId: e.target.value || null })} />
        </Field>
      )}
      {d.kind === 'path' && (
        <Field label="Store path" hint="A page of this store, e.g. /deals or /pages/home-week">
          <TextInput id={id('path')} value={d.path ?? ''} placeholder="/deals" onChange={(e) => setDest({ path: e.target.value })} />
        </Field>
      )}
      {d.kind === 'url' && (
        <Field label="Web address" hint="Opens in the browser">
          <TextInput id={id('url')} type="url" value={d.url ?? ''} placeholder="https://" onChange={(e) => setDest({ url: e.target.value })} />
        </Field>
      )}
      <Switch id={id('visible')} label="Show this department to customers" checked={item.visible} onChange={(e) => set({ visible: e.target.checked })} />

      {/* problems the fields above don't show under themselves */}
      {tried && problem && item.title.trim() && !(d.kind === 'department' && !d.department) && !(d.kind === 'category' && !categories.some((c) => c.id === d.categoryId)) && <span className="xs t-danger-text">{problem}</span>}
      <div className="row gap-2">
        <Button variant="danger-soft" size="sm" onClick={onRemove}>
          Remove department
        </Button>
        <span className="grow" />
        <Button size="sm" onClick={() => (problem ? setTried(true) : onDone())}>
          Done
        </Button>
      </div>
    </div>
  );
}
