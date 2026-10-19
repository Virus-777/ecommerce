import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, resolveProductImageSpec, uploadMedia, useApi, type components } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, DateTimeField, Drawer, Field, Icon, IconButton, Img, ImageCropper, SegmentedControl, Select, StatusBadge, TableWrap, Textarea, TextInput, type CropWording, type IconName, type ProcessedImage } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, dateTime } from '@/app/parts';
import { flattenTree, type ApiCategory } from './data/categories';

// Design: pages/admin/admin-content.html · view "edit-section" = edit drawer for a homepage section.
// Data: GET /api/admin/content/homepage (sections, draft and review state), /homepage/versions, /pages (campaign
// pages), /homepage/sections/{id}/products (drawer). Writes: PUT /homepage/order (reorder = draft), POST
// /homepage/submit | review | publish | discard-draft, /homepage/versions/{n}/restore, POST/PATCH /homepage/sections,
// /sections/{id}/schedule, /sections/{id}/remove, POST /pages (new campaign page draft), /pages/{id}/publish.
// The drawer edits what a section holds: banner copy, button and images (uploaded as content_image), the category
// list (GET /api/admin/catalog/categories) and manual products. Flash deals hold nothing: they come from Promotions.
// The layout follows the API's review rule: when a review is required the author sends the draft for review and
// someone else approves it (SAME_REVIEWER) before it is published.

type S = components['schemas'];
type Section = S['content.HomeSectionAdmin'];
type SectionInput = S['content.SectionInput'];
type SourceMode = 'manual' | 'collection' | 'rule';
type MediaRef = S['MediaRef'];

const KIND: Record<string, { icon: IconName; wire: string }> = {
  campaign_banner: { icon: 'image', wire: 'w-hero' },
  category_shortcuts: { icon: 'layout-grid', wire: 'w-cats' },
  deals: { icon: 'tag', wire: 'w-deals' },
  official_highlights: { icon: 'badge-check', wire: 'w-off' },
  featured_products: { icon: 'sparkles', wire: 'w-feat' },
  featured_sellers: { icon: 'store', wire: 'w-sell' },
  new_arrivals: { icon: 'sparkles', wire: 'w-feat' },
  popular_products: { icon: 'sparkles', wire: 'w-feat' },
  brand_collections: { icon: 'tag', wire: 'w-feat' },
  recently_viewed: { icon: 'clock', wire: 'w-feat' },
  collection_teaser: { icon: 'gift', wire: 'w-feat' },
  promise_strip: { icon: 'shield-check', wire: 'w-cats' },
  ad_position: { icon: 'megaphone', wire: 'w-ad' },
};
const kindOf = (k: string) => KIND[k] ?? { icon: 'layout-grid' as IconName, wire: 'w-feat' };

const STATUS: Record<string, string> = { draft: 'Draft', scheduled: 'Scheduled', published: 'Published', unpublished: 'Unpublished', removed: 'Removed', in_review: 'In review', approved: 'Approved' };

const SOURCES: Array<{ value: SourceMode; label: string }> = [
  { value: 'manual', label: 'Manual selection' },
  { value: 'collection', label: 'Collection' },
  { value: 'rule', label: 'Rule' },
];
const TIME_ZONES = [
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
];
const OWNER_ROLES = ['Content', 'Marketing', 'Official Store', 'Sellers'];
// Same set as the API (content domain rules): deals are filled by Promotions, not by a product source.
const PRODUCT_KINDS = new Set(['featured_products', 'official_highlights', 'new_arrivals', 'popular_products', 'collection_teaser']);
// Kinds "Add section" can create here: each one's contents can be filled in the drawer.
const NEW_KINDS: Array<{ value: SectionInput['kind']; label: string }> = [
  { value: 'campaign_banner', label: 'Campaign banner' },
  { value: 'category_shortcuts', label: 'Shop by category' },
  { value: 'deals', label: 'Flash deals' },
];
const MAX_BANNER_IMAGES = 3; // the storefront hero shows three tiles
const BANNER_SPEC = resolveProductImageSpec({ aspectRatio: '1:1', detailWidth: 800, thumbnailWidth: 320, quality: 85 });
const BANNER_WORDING: CropWording = { what: 'banner images', place: 'frame the subject', detail: ['Homepage banner', 'the homepage banner'], thumbnail: ['Small screens', 'small screens'] };

interface SectionEdit {
  kind: string;
  heading: string;
  sub: string;
  source: SourceMode;
  productIds: string[];
  categoryIds: string[];
  eyebrow: string;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  images: MediaRef[];
  /** datetime-local, in tz */
  from: string;
  to: string;
  tz: string;
  owner: string;
}

/** Offset of a time zone from UTC at an instant, in minutes. */
function tzOffset(tz: string, at: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
  return (Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - at.getTime()) / 60000;
}
const wallToIso = (wall: string, tz: string) => {
  const g = new Date(`${wall}:00Z`);
  return new Date(g.getTime() - tzOffset(tz, g) * 60000).toISOString();
};
const isoToWall = (iso: string | null | undefined, tz: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() + tzOffset(tz, d) * 60000).toISOString().slice(0, 16);
};

const editOf = (s?: Section): SectionEdit => {
  const c = s?.config;
  const tz = c?.timeZone ?? s?.schedule.timeZone ?? TIME_ZONES[0].value;
  const b = c?.banner;
  return {
    kind: s?.kind ?? NEW_KINDS[0].value,
    heading: c?.heading ?? s?.title ?? '',
    sub: c?.subheading ?? '',
    source: (c?.productSource?.mode as SourceMode | undefined) ?? 'manual',
    productIds: c?.productSource?.productIds ?? [],
    categoryIds: c?.categoryIds ?? [],
    eyebrow: b?.eyebrow ?? '',
    headline: b?.headline ?? '',
    body: b?.body ?? '',
    ctaLabel: b?.primaryCta.label ?? 'Shop now',
    ctaUrl: b?.primaryCta.url ?? '/deals',
    images: b?.images ?? [],
    from: isoToWall(c?.showFrom ?? s?.schedule.publishAt, tz),
    to: isoToWall(c?.removeAt ?? s?.schedule.unpublishAt, tz),
    tz,
    owner: c?.ownerRole ?? s?.owner.role ?? 'Content',
  };
};

const actorName = (a: unknown) => (a as { name?: string; kind?: string } | null)?.name ?? ((a as { kind?: string } | null)?.kind === 'system' ? 'System' : 'Staff');

export default function Content() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canView = can('content.view');
  const canManage = can('content.homepage.manage');
  const canPublish = can('content.homepage.publish');
  const canPages = can('content.pages.manage');
  const canPagesPublish = can('content.pages.publish');

  const [view, setView] = useView<'edit-section'>();
  const [editId, setEditId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<SectionEdit>(editOf());
  const [position, setPosition] = useState(0);
  const [errs, setErrs] = useState<Partial<Record<'heading' | 'headline' | 'ctaLabel' | 'ctaUrl' | 'categories' | 'from' | 'to', string>>>({});
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; title: string } | null>(null);

  const home = useQuery({ queryKey: ['content', 'homepage'], enabled: canView, queryFn: () => call(api.GET('/api/admin/content/homepage')) });
  const versions = useQuery({ queryKey: ['content', 'homepage', 'versions'], enabled: canView, queryFn: () => call(api.GET('/api/admin/content/homepage/versions', { params: { query: { limit: 10 } } })) });
  const pages = useQuery({ queryKey: ['content', 'pages'], enabled: canView, queryFn: () => call(api.GET('/api/admin/content/pages', { params: { query: { limit: 50 } } })) });

  const sections = [...(home.data?.sections ?? [])].sort((a, b) => a.position - b.position);
  const h = home.data;
  const review = h?.draftReview;
  const open = view === 'edit-section';
  const editing = sections.find((s) => s.id === editId);
  // Opening ?view=edit-section directly edits the first editable section.
  const target = editing ?? (open && !adding && editId === null && !draft.heading ? sections.find((s) => !s.locked) : undefined);
  const kind = target?.kind ?? draft.kind;
  // The API schedules only sections that never went live (draft → scheduled). A live section's Show from and Remove
  // at are saved with the draft and apply once the layout is published.
  const canSchedule = !target || target.status === 'draft';
  const categories = useQuery({
    queryKey: ['catalog', 'categories', 'admin'],
    enabled: open && kind === 'category_shortcuts',
    queryFn: () => call(api.GET('/api/admin/catalog/categories')),
  });
  // "Parent › Child" names, in catalog order
  const catList = (() => {
    const flat = flattenTree((categories.data ?? []) as ApiCategory[]);
    const byId = new Map(flat.map((c) => [c.id, c]));
    const path = (id: string | null): string => {
      const c = id ? byId.get(id) : undefined;
      return c ? (c.parent ? `${path(c.parent)} › ${c.name}` : c.name) : '';
    };
    return flat.map((c) => ({ id: c.id, name: path(c.id), visible: c.visible, image: c.image }));
  })();
  const products = useQuery({
    queryKey: ['content', 'section-products', target?.id],
    enabled: open && !!target && PRODUCT_KINDS.has(target.kind),
    queryFn: () => call(api.GET('/api/admin/content/homepage/sections/{id}/products', { params: { path: { id: target!.id }, query: { limit: 24 } } })),
  });

  const flash = (title: string, tone: 'success' | 'info' = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['content'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  const order = useMutation({
    mutationFn: (ids: string[]) => call(api.PUT('/api/admin/content/homepage/order', { body: { sectionIds: ids } })),
    onSuccess: (d) => qc.setQueryData(['content', 'homepage'], d),
    // a dropped order is shown at once (see dragFinish); on failure show the server's order again
    onError: () => void qc.invalidateQueries({ queryKey: ['content', 'homepage'] }),
  });

  // Dragging a section by its handle: the row moves as the pointer passes another row's middle, and dropping saves
  // the order like the arrows do. Window listeners (not pointer capture) because React moves the row's node.
  // live.current is the drag as of the last pointer event (a drop can follow a move before React re-renders)
  const [drag, setDrag] = useState<{ id: string; ids: string[] } | null>(null);
  const live = useRef(drag);
  const setLive = (d: typeof drag) => {
    live.current = d;
    setDrag(d);
  };
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const shown = drag ? drag.ids.map((id) => sections.find((s) => s.id === id)).filter((s): s is Section => !!s) : sections;
  const dragStart = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || order.isPending) return;
    e.preventDefault();
    setLive({ id, ids: sections.map((s) => s.id) });
  };
  const dragMove = useRef<(y: number) => void>(() => {});
  dragMove.current = (y) => {
    const d = live.current;
    if (!d) return;
    const others = d.ids.filter((id) => id !== d.id);
    const at = others.filter((id) => {
      const r = rowEls.current.get(id)?.getBoundingClientRect();
      return !!r && r.top + r.height / 2 < y;
    }).length;
    const ids = [...others.slice(0, at), d.id, ...others.slice(at)];
    if (ids.some((id, k) => id !== d.ids[k])) setLive({ ...d, ids });
  };
  const dragFinish = useRef<(save: boolean) => void>(() => {});
  dragFinish.current = (save) => {
    const d = live.current;
    if (!d) return;
    setLive(null);
    const { id, ids } = d;
    if (!save || ids.every((x, k) => x === sections[k]?.id)) return;
    qc.setQueryData(['content', 'homepage'], (d: typeof h) => d && { ...d, sections: d.sections.map((s) => ({ ...s, position: ids.indexOf(s.id) })) });
    order.mutate(ids);
    announce(`${sections.find((s) => s.id === id)?.title ?? 'Section'} moved to position ${ids.indexOf(id) + 1}`);
  };
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => dragMove.current(e.clientY);
    const up = () => dragFinish.current(true);
    const cancel = () => dragFinish.current(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && cancel();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
    };
  }, [dragging]);

  const layout = useMutation({
    mutationFn: async (kind: 'submit' | 'publish' | 'approve' | 'discard') => {
      if (kind === 'submit') return call(api.POST('/api/admin/content/homepage/submit', { body: { summary: 'Homepage layout changes' } }));
      if (kind === 'discard') return call(api.POST('/api/admin/content/homepage/discard-draft'));
      if (kind === 'approve') await call(api.POST('/api/admin/content/homepage/review', { body: { approve: true } }));
      return call(api.POST('/api/admin/content/homepage/publish', { body: { summary: 'Published homepage layout changes' } }));
    },
    onSuccess: (d, kind) => {
      qc.setQueryData(['content', 'homepage'], d);
      refresh();
      flash(kind === 'submit' ? 'Sent for review. The layout is published after someone else approves it.' : kind === 'discard' ? 'Draft discarded' : `Published as version ${d.liveVersion ?? ''}`.trim(), kind === 'submit' ? 'info' : 'success');
    },
  });
  const restore = useMutation({
    mutationFn: (n: number) => call(api.POST('/api/admin/content/homepage/versions/{number}/restore', { params: { path: { number: n } }, body: { reason: `Restored v${n} from Version history`, publish: true } })),
    onSuccess: (d, n) => {
      qc.setQueryData(['content', 'homepage'], d);
      refresh();
      flash(`v${n} restored as version ${d.liveVersion ?? ''}`.trim());
    },
  });
  const pageAct = useMutation({
    mutationFn: (v: { kind: 'new' } | { kind: 'publish'; id: string }) =>
      v.kind === 'new'
        ? call(api.POST('/api/admin/content/pages', { body: { kind: 'campaign', title: 'Untitled campaign page', blocks: [] } }))
        : call(api.POST('/api/admin/content/pages/{id}/publish', { params: { path: { id: v.id } } })),
    onSuccess: (p, v) => {
      void qc.invalidateQueries({ queryKey: ['content', 'pages'] });
      announce(v.kind === 'new' ? 'Campaign page draft added' : `${p.summary.title} published again`);
    },
  });

  const saveSection = useMutation({
    mutationFn: async (mode: 'draft' | 'schedule') => {
      const base = (target?.config ?? {}) as Partial<SectionInput>;
      const k = (base.kind ?? kind) as SectionInput['kind'];
      const url = draft.ctaUrl.trim();
      const body: SectionInput = {
        ...base,
        kind: k,
        heading: draft.heading.trim(),
        subheading: draft.sub.trim() || null,
        productSource: PRODUCT_KINDS.has(k) && (base.productSource || !target) ? { ...(base.productSource ?? {}), mode: draft.source, productIds: draft.productIds } : base.productSource,
        banner:
          k === 'campaign_banner'
            ? {
                ...(base.banner ?? {}),
                eyebrow: draft.eyebrow.trim() || null,
                headline: draft.headline.trim(),
                body: draft.body.trim() || null,
                images: draft.images,
                // the link kind only stays while the link does
                primaryCta: { label: draft.ctaLabel.trim(), url, kind: base.banner?.primaryCta.url === url ? base.banner.primaryCta.kind : null },
              }
            : base.banner,
        categoryIds: k === 'category_shortcuts' ? draft.categoryIds : base.categoryIds,
        showFrom: draft.from ? wallToIso(draft.from, draft.tz) : null,
        removeAt: draft.to ? wallToIso(draft.to, draft.tz) : null,
        timeZone: draft.tz,
        ownerRole: draft.owner,
        position: position + 1,
      };
      let s = target
        ? await call(api.PATCH('/api/admin/content/homepage/sections/{id}', { params: { path: { id: target.id } }, body }))
        : await call(api.POST('/api/admin/content/homepage/sections', { body }));
      if (mode === 'schedule') s = await call(api.POST('/api/admin/content/homepage/sections/{id}/schedule', { params: { path: { id: s.id } }, body: { showFrom: wallToIso(draft.from, draft.tz), removeAt: draft.to ? wallToIso(draft.to, draft.tz) : null, timeZone: draft.tz } }));
      return { s, mode };
    },
    onSuccess: ({ s, mode }) => {
      refresh();
      flash(mode === 'draft' ? `${s.title}: saved to the draft layout. Customers see it once the layout is published.` : `${s.title} scheduled: ${s.schedule.label}`);
      close();
    },
  });
  const removeSection = useMutation({
    mutationFn: (s: Section) => call(api.POST('/api/admin/content/homepage/sections/{id}/remove', { params: { path: { id: s.id } }, body: { kind: 'removal', reason: 'Removed from Homepage and pages', immediately: false } })),
    onSuccess: (s) => {
      refresh();
      flash(`${s.title} removed. Restore it from Version history.`);
      close();
    },
  });

  // Hiding takes the section off the store now; showing it again waits for the layout to be published.
  const visibility = useMutation({
    mutationFn: ({ s, hidden }: { s: Section; hidden: boolean }) => call(api.POST('/api/admin/content/homepage/sections/{id}/visibility', { params: { path: { id: s.id } }, body: { hidden } })),
    onSuccess: (s, v) => {
      refresh();
      flash(v.hidden ? `${s.title} is hidden from customers now` : `${s.title} will show again once the layout is published`, v.hidden ? 'success' : 'info');
    },
    onError: (e, v) => flash(`${v.s.title} wasn’t ${v.hidden ? 'hidden' : 'shown'}: ${errorMessage(e)}`, 'info'),
  });

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const ids = sections.map((s) => s.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    order.mutate(ids);
    announce(`${sections[i].title} moved ${dir < 0 ? 'up' : 'down'}`);
  };

  const openEdit = (s?: Section) => {
    setEditId(s?.id ?? null);
    setAdding(!s);
    setDraft(editOf(s));
    setPosition(s ? sections.findIndex((x) => x.id === s.id) : sections.length);
    setErrs({});
    saveSection.reset();
    setView('edit-section');
  };
  // Direct ?view=edit-section: fill the drawer from the first editable section once loaded.
  if (open && !adding && editId === null && target && !draft.heading && !saveSection.isPending) {
    setEditId(target.id);
    setDraft(editOf(target));
    setPosition(sections.findIndex((x) => x.id === target.id));
  }
  const close = () => {
    setAdding(false);
    setView('');
  };
  const set = <K extends keyof SectionEdit>(k: K, v: SectionEdit[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    if (k in errs) setErrs((e) => ({ ...e, [k]: undefined }));
    if (k === 'categoryIds') setErrs((e) => ({ ...e, categories: undefined }));
  };
  const moveCat = (i: number, dir: -1 | 1) => {
    const ids = [...draft.categoryIds];
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    set('categoryIds', ids);
  };
  const save = (mode: 'draft' | 'schedule') => {
    const e: typeof errs = {};
    if (!draft.heading.trim()) e.heading = kind === 'campaign_banner' ? 'Enter a name.' : 'Enter a heading.';
    if (kind === 'campaign_banner') {
      if (!draft.headline.trim()) e.headline = 'Enter a headline.';
      if (!draft.ctaLabel.trim()) e.ctaLabel = 'Enter the button text.';
      // same rule as the API: a store path, or an http(s), mailto or tel link
      if (!/^(\/(?!\/)|https?:\/\/|mailto:|tel:)/i.test(draft.ctaUrl.trim())) e.ctaUrl = 'Use a store path such as /deals, or a full https:// link.';
    }
    if (kind === 'category_shortcuts' && !draft.categoryIds.length) e.categories = 'Add at least one category.';
    // wall times in one time zone: the strings compare in time order
    if (draft.from && draft.to && draft.to <= draft.from) e.to = 'The removal time must be after “Show from”.';
    setErrs(e);
    if (Object.keys(e).length) {
      document.getElementById(e.heading ? 'ct-head' : e.headline ? 'ct-headline' : e.ctaLabel ? 'ct-cta' : e.ctaUrl ? 'ct-url' : e.categories ? 'ct-addcat' : 'ct-to')?.focus();
      return;
    }
    if (mode === 'schedule' && !draft.from) {
      saveSection.reset();
      setErrs({ from: 'Enter when the section starts showing, or use Save draft.' });
      document.getElementById('ct-from')?.focus();
      return;
    }
    saveSection.mutate(mode);
  };

  const posOpts = [
    { value: '0', label: '1 · top of the page' },
    ...sections.filter((s) => s.id !== target?.id).map((s, i) => ({ value: String(i + 1), label: `${i + 2} · after ${s.title}` })),
  ];

  const wire = sections.filter((s) => s.status !== 'draft' && s.status !== 'removed').map((s) => ({ cls: kindOf(s.kind).wire, text: s.locked ? `Ad · ${s.title} (Advertising)` : open && s.id === target?.id ? `${draft.heading || '…'}` : s.title }));
  const current = h?.liveVersion ?? versions.data?.items[0]?.number ?? 0;

  // Publishing the layout follows the review state.
  const st = review?.state ?? 'not_required';
  const publishBtn = !h?.hasDraft
    ? { label: 'Publish order', run: undefined as undefined | (() => void), note: 'Reordering saves a draft. Customers see it after you publish.' }
    : st === 'not_submitted' || st === 'changes_requested'
      ? { label: 'Send for review', run: () => layout.mutate('submit'), note: st === 'changes_requested' ? `Changes requested${review?.note ? `: ${review.note}` : ''}. Send it again when ready.` : 'Draft changes need a review before customers see them.' }
      : st === 'in_review'
        ? canPublish
          ? { label: 'Approve and publish', run: () => layout.mutate('approve'), note: `Sent for review ${review?.submittedAt ? dateTime(review.submittedAt) : ''}. Someone other than the author approves it.` }
          : { label: 'Waiting for review', run: undefined, note: 'Sent for review. A Content Manager approves it before it is published.' }
        : canPublish
          ? { label: 'Publish order', run: () => layout.mutate('publish'), note: 'Draft changes saved. Customers see them after you publish.' }
          : { label: 'Publish order', run: undefined, note: 'Draft changes saved. A Content Manager publishes them.' };

  if (!canView) {
    return (
      <AdminLayout active="content">
        <div className="page-head">
          <div className="t">
            <Breadcrumbs items={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Marketing and content' }]} />
            <h1 className="h1">Homepage and pages</h1>
          </div>
        </div>
        <Alert tone="info" title="You don’t have access to Homepage and pages">
          Viewing the homepage layout and campaign pages needs the “View content” permission. A Platform Administrator can change your roles in Staff and permissions.
        </Alert>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout active="content">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Marketing and content' }]} />
          <h1 className="h1">Homepage and pages</h1>
          <p className="sub small">Owner {h?.owner?.name ?? 'Content team'}{h?.owner?.role ? `, ${h.owner.role}` : ''} · ad positions and timing belong to Advertising · times in PT</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="eye" to={href('store/home')}>
            Preview homepage
          </Button>
          {canManage && (
            <Button size="sm" icon="plus" onClick={() => openEdit()}>
              Add section
            </Button>
          )}
        </div>
      </div>

      {notice && <Alert tone={notice.tone} title={notice.title} />}
      {(order.isError || layout.isError || restore.isError) && (
        <Alert tone="danger" title="That change wasn’t saved">
          {errorMessage(order.error ?? layout.error ?? restore.error)}
        </Alert>
      )}
      {home.isError && <LoadError error={home.error} onRetry={() => void home.refetch()} />}

      <div className="ab-main">
        <div className="stack gap-5">
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Homepage sections</h2>
                <span className="xs muted">
                  Shown top to bottom · drag or use arrows to reorder · live version {current}
                  {h?.draftVersion ? ` · draft version ${h.draftVersion}` : ''}
                </span>
              </div>
            </div>
            {home.isPending && (
              <div className="card-body">
                <SkeletonLines rows={6} />
              </div>
            )}
            {shown.map((s, i) => (
              <div
                key={s.id}
                ref={(el) => void (el ? rowEls.current.set(s.id, el) : rowEls.current.delete(s.id))}
                className={cx('ab-sec', s.locked && 'is-ad', open && s.id === target?.id && 'is-edit', drag?.id === s.id && 'is-dragging')}
              >
                {canManage && !s.locked ? (
                  // pointer only: keyboard and screen reader users reorder with the arrow buttons
                  <span className="handle can-drag" title="Drag to reorder" aria-hidden="true" onPointerDown={(e) => dragStart(e, s.id)}>
                    <Icon name="grip-vertical" className="ic-sm" />
                  </span>
                ) : (
                  <span className="handle">
                    <Icon name={s.locked ? 'lock' : 'grip-vertical'} className="ic-sm" />
                  </span>
                )}
                <span className="row gap-2">
                  <span className="xs muted num">{i + 1}</span>
                  <Icon name={kindOf(s.kind).icon} className="ic-sm" />
                  <b className="small">{s.title}</b>
                  {s.locked ? <Badge tone="outline">Ad position</Badge> : <StatusBadge status={STATUS[s.status] ?? s.status} />}
                  {s.hidden ? (
                    <Badge tone="outline" icon="eye-off">
                      Hidden
                    </Badge>
                  ) : (
                    s.hiddenLive && (
                      <Badge tone="warning" icon="eye-off">
                        Hidden until published
                      </Badge>
                    )
                  )}
                </span>
                <span className="meta">
                  <span>
                    {s.description}
                    {s.unavailableHidden ? ` · ${s.unavailableHidden} unavailable hidden` : ''}
                  </span>
                  <span>
                    <Icon name="user-round" className="ic-sm" /> {s.owner.name} · {s.owner.role}
                  </span>
                  <span>
                    <Icon name="calendar" className="ic-sm" /> {s.schedule.label}
                  </span>
                </span>
                <span className="acts">
                  {s.locked ? (
                    <Link className="small strong" to={href('admin/ads')}>
                      {s.managedIn ?? 'Managed in Advertisements'}
                    </Link>
                  ) : (
                    <>
                      {canManage && <IconButton icon="arrow-up" label={`Move ${s.title} up`} disabled={i === 0 || order.isPending} onClick={() => move(i, -1)} />}
                      {canManage && <IconButton icon="arrow-down" label={`Move ${s.title} down`} disabled={i === sections.length - 1 || order.isPending} onClick={() => move(i, 1)} />}
                      {canManage && (
                        <IconButton
                          icon={s.hidden ? 'eye-off' : 'eye'}
                          label={s.hidden ? `Show ${s.title}` : `Hide ${s.title}`}
                          disabled={visibility.isPending}
                          onClick={() => visibility.mutate({ s, hidden: !s.hidden })}
                        />
                      )}
                      {canManage && (
                        <Button variant="ghost" size="sm" to={href('admin/content', 'edit-section')} onClick={(e) => (e.preventDefault(), openEdit(s))}>
                          Edit
                        </Button>
                      )}
                    </>
                  )}
                </span>
              </div>
            ))}
            {canManage ? (
              <div className="card-foot">
                <span className="ab-note grow">{publishBtn.note}</span>
                <Button variant="ghost" size="sm" disabled={!h?.hasDraft || layout.isPending} onClick={() => layout.mutate('discard')}>
                  Discard draft
                </Button>
                <Button size="sm" disabled={!publishBtn.run || layout.isPending} onClick={publishBtn.run}>
                  {publishBtn.label}
                </Button>
              </div>
            ) : (
              <div className="card-foot">
                <span className="ab-note grow">View only: a Content Manager edits and publishes the homepage.</span>
              </div>
            )}
          </section>

          <Card
            title="Campaign pages"
            titleAs="h3"
            sub="Each page has a publish time and a removal time"
            flush
            actions={
              canPages ? (
                <Button variant="secondary" size="sm" icon="plus" onClick={() => pageAct.mutate({ kind: 'new' })} disabled={pageAct.isPending}>
                  New campaign page
                </Button>
              ) : undefined
            }
          >
            {pageAct.isError && (
              <div className="card-body">
                <Alert tone="danger" title="The page wasn’t changed">
                  {errorMessage(pageAct.error)}
                </Alert>
              </div>
            )}
            {pages.isError ? (
              <div className="card-body">
                <LoadError error={pages.error} onRetry={() => void pages.refetch()} />
              </div>
            ) : (
              <TableWrap label="Campaign pages table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Page</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Publish</th>
                      <th scope="col">Remove</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pages.isPending && (
                      <tr>
                        <td colSpan={6}>
                          <SkeletonLines rows={3} />
                        </td>
                      </tr>
                    )}
                    {(pages.data?.items ?? []).map((p) => {
                      const storeUrl = href('store/home').replace(/\/$/, '') + p.url;
                      return (
                        <tr key={p.id}>
                          <td>
                            <span className="ab-cell">
                              <span className="strong">{p.title}</span>
                              <span className="xs muted">{p.url}</span>
                            </span>
                          </td>
                          <td>{p.owner.name}</td>
                          <td>{p.schedule.publishAt ? dateTime(p.schedule.publishAt) : p.status === 'published' ? 'Live' : 'Not set'}</td>
                          <td>{p.schedule.unpublishAt ? dateTime(p.schedule.unpublishAt) : 'Not set'}</td>
                          <td>
                            <StatusBadge status={STATUS[p.status] ?? p.status} />
                          </td>
                          <td>
                            {p.status === 'unpublished' && canPagesPublish && p.allowedActions.includes('publish') ? (
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => pageAct.mutate({ kind: 'publish', id: p.id })} disabled={pageAct.isPending}>
                                <Icon name="rotate-ccw" />
                                <span>Restore</span>
                                <span className="sr-only"> {p.title}</span>
                              </button>
                            ) : (
                              <a className="btn btn-ghost btn-sm" href={storeUrl}>
                                <Icon name="eye" />
                                <span>Preview</span>
                                <span className="sr-only"> {p.title}</span>
                              </a>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {pages.isSuccess && !pages.data.items.length && (
                      <tr>
                        <td colSpan={6} className="muted">
                          No campaign pages yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
        </div>

        <div className="stack gap-5">
          <Card title="Preview" titleAs="h3" sub={`${device === 'desktop' ? 'Desktop' : 'Phone'} homepage · ${h?.hasDraft ? 'draft' : 'live'}`}>
            <div className="ab-wire" aria-label="Homepage layout preview" style={device === 'phone' ? { maxWidth: 220, marginInline: 'auto', width: '100%' } : undefined}>
              {wire.map((w, i) => (
                <div key={i} className={w.cls}>
                  {w.text}
                </div>
              ))}
            </div>
            <SegmentedControl
              items={[
                { label: 'Desktop', value: 'desktop', icon: 'monitor' },
                { label: 'Phone', value: 'phone', icon: 'smartphone' },
              ]}
              active={device}
              onChange={setDevice}
              label="Preview device"
            />
          </Card>
          <Card title="Version history" titleAs="h3" flush foot={<span className="ab-note grow">Restoring creates a new version. Nothing is overwritten.</span>}>
            {versions.isPending ? (
              <div className="card-body">
                <SkeletonLines rows={3} />
              </div>
            ) : versions.isError ? (
              <div className="card-body">
                <LoadError error={versions.error} onRetry={() => void versions.refetch()} />
              </div>
            ) : (
              <ul className="list pad">
                {versions.data.items.map((v) => (
                  <li key={v.id}>
                    <span className="grow stack gap-0">
                      <span className="small strong">
                        v{v.number}
                        {v.state === 'live' ? ' · live' : v.state === 'draft' ? ' · draft' : ''}
                      </span>
                      <span className="xs muted">
                        {dateTime(v.publishedAt ?? v.createdAt)} · {actorName(v.author)} · {v.summary}
                      </span>
                    </span>
                    {v.state === 'live' ? (
                      <Badge tone="brand">Current</Badge>
                    ) : v.state === 'superseded' && canPublish ? (
                      <Button variant="ghost" size="sm" icon="rotate-ccw" onClick={() => restore.mutate(v.number)} disabled={restore.isPending}>
                        Restore
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Drawer
        open={open}
        onClose={close}
        title={target ? `Edit section: ${target.title}` : 'Add section'}
        foot={
          <>
            <Button variant="danger-soft" size="sm" onClick={() => (target ? removeSection.mutate(target) : close())} disabled={removeSection.isPending}>
              {target ? 'Remove section' : 'Discard'}
            </Button>
            <span className="grow" />
            {canSchedule ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => save('draft')} disabled={saveSection.isPending}>
                  Save draft
                </Button>
                <Button size="sm" onClick={() => save('schedule')} disabled={saveSection.isPending}>
                  Schedule
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => save('draft')} disabled={saveSection.isPending}>
                Save changes
              </Button>
            )}
          </>
        }
      >
        {(saveSection.isError || removeSection.isError) && (
          <Alert tone="danger" title="The section wasn’t saved">
            {errorMessage(saveSection.error ?? removeSection.error)}
          </Alert>
        )}
        {!target && (
          <Field label="Type">
            <Select id="ct-kind" options={NEW_KINDS} value={draft.kind} onChange={(e) => set('kind', e.target.value)} />
          </Field>
        )}
        {kind === 'campaign_banner' ? (
          <Field label="Name" hint="Only staff see this name. Customers see the headline." error={errs.heading}>
            <TextInput id="ct-head" value={draft.heading} error={!!errs.heading} onChange={(e) => set('heading', e.target.value)} />
          </Field>
        ) : (
          <>
            <Field label="Heading" error={errs.heading}>
              <TextInput id="ct-head" value={draft.heading} error={!!errs.heading} onChange={(e) => set('heading', e.target.value)} />
            </Field>
            <Field label="Subheading" optional>
              <TextInput id="ct-sub" value={draft.sub} onChange={(e) => set('sub', e.target.value)} />
            </Field>
          </>
        )}
        {kind === 'campaign_banner' && (
          <>
            <Field label="Small line above the headline" optional>
              <TextInput id="ct-eyebrow" value={draft.eyebrow} placeholder="Ends Sunday" onChange={(e) => set('eyebrow', e.target.value)} />
            </Field>
            <Field label="Headline" error={errs.headline}>
              <TextInput id="ct-headline" value={draft.headline} error={!!errs.headline} onChange={(e) => set('headline', e.target.value)} />
            </Field>
            <Field label="Text" optional>
              <Textarea id="ct-body" rows={3} value={draft.body} onChange={(e) => set('body', e.target.value)} />
            </Field>
            <div className="ab-form-grid">
              <Field label="Button text" error={errs.ctaLabel}>
                <TextInput id="ct-cta" value={draft.ctaLabel} error={!!errs.ctaLabel} onChange={(e) => set('ctaLabel', e.target.value)} />
              </Field>
              <Field label="Button link" hint="A store path such as /deals, or a full https:// link" error={errs.ctaUrl}>
                <TextInput id="ct-url" value={draft.ctaUrl} error={!!errs.ctaUrl} onChange={(e) => set('ctaUrl', e.target.value)} />
              </Field>
            </div>
            <BannerImages images={draft.images} alt={draft.headline.trim()} onChange={(v) => set('images', v)} />
            {target?.config?.linkedPromotionId && <span className="xs muted">This banner follows a promotion campaign and hides by itself when the campaign ends.</span>}
          </>
        )}
        {kind === 'category_shortcuts' && (
          <div className="stack gap-2">
            <span className="label">Categories ({draft.categoryIds.length})</span>
            {categories.isPending ? (
              <SkeletonLines rows={3} />
            ) : categories.isError ? (
              <LoadError error={categories.error} onRetry={() => void categories.refetch()} />
            ) : (
              <>
                {draft.categoryIds.length > 0 && (
                  <ul className="list">
                    {draft.categoryIds.map((id, i) => {
                      const c = catList.find((x) => x.id === id);
                      return (
                        <li key={id}>
                          <Img icon="layout-grid" tint="1" className="tiny" src={c?.image?.url} alt="" />
                          <span className="grow stack gap-0">
                            <span className="small truncate">{c?.name ?? 'Deleted category'}</span>
                            {(!c || !c.visible) && <span className="xs muted">Hidden from customers, so it isn’t shown</span>}
                          </span>
                          <IconButton icon="arrow-up" label={`Move ${c?.name ?? 'category'} up`} disabled={i === 0} onClick={() => moveCat(i, -1)} />
                          <IconButton icon="arrow-down" label={`Move ${c?.name ?? 'category'} down`} disabled={i === draft.categoryIds.length - 1} onClick={() => moveCat(i, 1)} />
                          <IconButton icon="x" label={`Remove ${c?.name ?? 'category'}`} onClick={() => set('categoryIds', draft.categoryIds.filter((x) => x !== id))} />
                        </li>
                      );
                    })}
                  </ul>
                )}
                <Field label="Add a category" error={errs.categories}>
                  <Select
                    id="ct-addcat"
                    value=""
                    options={[{ value: '', label: 'Choose a category…' }, ...catList.filter((c) => !draft.categoryIds.includes(c.id)).map((c) => ({ value: c.id, label: c.visible ? c.name : `${c.name} (hidden)` }))]}
                    onChange={(e) => e.target.value && set('categoryIds', [...draft.categoryIds, e.target.value])}
                  />
                </Field>
              </>
            )}
          </div>
        )}
        {kind === 'deals' && (
          <Alert tone="info" title="Flash deals fill themselves">
            This section shows up to 4 flash sales that are live in Promotions. To add or remove deals, start or stop a flash sale in <Link to={href('admin/promotions')}>Promotions</Link>.
          </Alert>
        )}
        {PRODUCT_KINDS.has(kind) && (
          <Field label="Product source" hint={target?.config?.productSource?.rule?.description ?? undefined}>
            <Select id="ct-src" options={SOURCES} value={draft.source} disabled={!!target && draft.source !== 'manual'} onChange={(e) => set('source', e.target.value as SourceMode)} />
          </Field>
        )}
        {target && PRODUCT_KINDS.has(target.kind) && draft.source === 'manual' && (
          <div className="stack gap-2">
            <span className="label">Products ({draft.productIds.length})</span>
            {products.isPending ? (
              <SkeletonLines rows={3} />
            ) : (
              <ul className="list">
                {(products.data?.items ?? [])
                  .filter((p) => draft.productIds.includes(p.productId))
                  .slice(0, 4)
                  .map((p) => (
                    <li key={p.productId}>
                      <Img icon="package" tint="1" className="tiny" src={p.image?.url} alt="" />
                      <span className="grow stack gap-0">
                        <span className="small truncate">{p.title}</span>
                        <span className="xs muted">
                          {p.sellerName ?? 'No seller'} · {p.available ? `${p.stock} in stock` : (p.hiddenReason ?? 'Hidden')}
                        </span>
                      </span>
                      <IconButton icon="x" label={`Remove ${p.title}`} onClick={() => set('productIds', draft.productIds.filter((x) => x !== p.productId))} />
                    </li>
                  ))}
              </ul>
            )}
            {draft.productIds.length > 4 && <span className="xs muted">+ {draft.productIds.length - 4} more · unavailable products are hidden automatically</span>}
            <span className="xs muted">Adding products from the catalog isn’t available in this drawer yet.</span>
          </div>
        )}
        <div className="ab-form-grid">
          <Field label="Show from" optional error={errs.from}>
            <DateTimeField id="ct-from" value={draft.from} error={!!errs.from} placeholder="Right away" onChange={(v) => set('from', v)} />
          </Field>
          <Field label="Remove at" optional error={errs.to}>
            <DateTimeField id="ct-to" value={draft.to} after={draft.from || undefined} error={!!errs.to} placeholder="No end" onChange={(v) => set('to', v)} />
          </Field>
        </div>
        <Field label="Time zone">
          <Select id="ct-tz" options={TIME_ZONES} value={draft.tz} onChange={(e) => set('tz', e.target.value)} />
        </Field>
        <Field label="Position">
          <Select id="ct-pos" options={posOpts} value={String(Math.min(position, posOpts.length - 1))} onChange={(e) => setPosition(Number(e.target.value))} />
        </Field>
        <Field label="Owner">
          <Select id="ct-own" options={OWNER_ROLES.includes(draft.owner) ? OWNER_ROLES : [draft.owner, ...OWNER_ROLES]} value={draft.owner} onChange={(e) => set('owner', e.target.value)} />
        </Field>
        <Alert tone="info" title="Saved to the draft layout">
          Customers see this section at the scheduled time once the layout is published. Version {current} stays available to restore.
        </Alert>
      </Drawer>
    </AdminLayout>
  );
}

/** Banner images (up to three, 1 : 1 crop, uploaded as content_image). The API keeps them by id. */
function BannerImages({ images, alt, onChange }: { images: MediaRef[]; alt: string; onChange: (images: MediaRef[]) => void }) {
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
      // MediaRef.url must be an absolute URL
      const url = new URL(asset.url || img.thumbUrl, window.location.origin).href;
      onChange([...images, { id: asset.id, url, alt: alt || null, width: asset.width ?? BANNER_SPEC.detail.width, height: asset.height ?? BANNER_SPEC.detail.height }]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack gap-2">
      <span className="label">
        Images ({images.length} of {MAX_BANNER_IMAGES})
      </span>
      {images.length > 0 && (
        <ul className="list">
          {images.map((m, i) => (
            <li key={m.id}>
              <Img icon="image" tint="1" className="thumb" src={m.url} alt="" />
              <span className="grow small">Image {i + 1}</span>
              <IconButton icon="x" label={`Remove image ${i + 1}`} onClick={() => onChange(images.filter((x) => x.id !== m.id))} />
            </li>
          ))}
        </ul>
      )}
      <span className="xs sub">Square, saved at 800 × 800. Without images, the banner shows icons.</span>
      {images.length < MAX_BANNER_IMAGES && (
        <div className="row gap-2">
          <Button variant="secondary" size="sm" icon="upload" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Uploading…' : 'Add image'}
          </Button>
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
      {files.length > 0 && <ImageCropper files={files} spec={BANNER_SPEC} wording={BANNER_WORDING} onProcessed={(img) => void upload(img)} onClose={() => setFiles([])} />}
    </div>
  );
}
