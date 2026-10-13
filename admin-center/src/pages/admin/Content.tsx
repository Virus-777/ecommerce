import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, Drawer, Field, Icon, IconButton, Img, SegmentedControl, Select, StatusBadge, TableWrap, TextInput, type IconName } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, dateTime } from '@/app/parts';

// Design: pages/admin/admin-content.html · view "edit-section" = edit drawer for a homepage section.
// Data: GET /api/admin/content/homepage (sections, draft and review state), /homepage/versions, /pages (campaign
// pages), /homepage/sections/{id}/products (drawer). Writes: PUT /homepage/order (reorder = draft), POST
// /homepage/submit | review | publish | discard-draft, /homepage/versions/{n}/restore, POST/PATCH /homepage/sections,
// /sections/{id}/schedule, /sections/{id}/remove, POST /pages (new campaign page draft), /pages/{id}/publish.
// The layout follows the API's review rule: when a review is required the author sends the draft for review and
// someone else approves it (SAME_REVIEWER) before it is published.

type S = components['schemas'];
type Section = S['content.HomeSectionAdmin'];
type SectionInput = S['content.SectionInput'];
type SourceMode = 'manual' | 'collection' | 'rule';

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
const PRODUCT_KINDS = new Set(['featured_products', 'official_highlights', 'new_arrivals', 'popular_products', 'deals']);

interface SectionEdit {
  heading: string;
  sub: string;
  source: SourceMode;
  productIds: string[];
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
  return {
    heading: c?.heading ?? s?.title ?? '',
    sub: c?.subheading ?? '',
    source: (c?.productSource?.mode as SourceMode | undefined) ?? 'manual',
    productIds: c?.productSource?.productIds ?? [],
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
  const canManage = can('content.homepage.manage');
  const canPublish = can('content.homepage.publish');
  const canPages = can('content.pages.manage');
  const canPagesPublish = can('content.pages.publish');

  const [view, setView] = useView<'edit-section'>();
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SectionEdit>(editOf());
  const [position, setPosition] = useState(0);
  const [headErr, setHeadErr] = useState('');
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; title: string } | null>(null);

  const home = useQuery({ queryKey: ['content', 'homepage'], enabled: canManage, queryFn: () => call(api.GET('/api/admin/content/homepage')) });
  const versions = useQuery({ queryKey: ['content', 'homepage', 'versions'], enabled: canManage, queryFn: () => call(api.GET('/api/admin/content/homepage/versions', { params: { query: { limit: 10 } } })) });
  const pages = useQuery({ queryKey: ['content', 'pages'], enabled: canPages, queryFn: () => call(api.GET('/api/admin/content/pages', { params: { query: { limit: 50 } } })) });

  const sections = [...(home.data?.sections ?? [])].sort((a, b) => a.position - b.position);
  const h = home.data;
  const review = h?.draftReview;
  const open = view === 'edit-section';
  const editing = sections.find((s) => s.id === editId);
  // Opening ?view=edit-section directly edits the first editable section.
  const target = editing ?? (open && editId === null && !draft.heading ? sections.find((s) => !s.locked) : undefined);
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
  });
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
      const body: SectionInput = {
        ...base,
        kind: (base.kind ?? target?.kind ?? 'featured_products') as SectionInput['kind'],
        heading: draft.heading.trim(),
        subheading: draft.sub.trim() || null,
        productSource: base.productSource || !target ? { ...(base.productSource ?? {}), mode: draft.source, productIds: draft.productIds } : base.productSource,
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
      flash(mode === 'draft' ? `${s.title}: draft saved` : `${s.title} scheduled: ${s.schedule.label}`);
      setView('');
    },
  });
  const removeSection = useMutation({
    mutationFn: (s: Section) => call(api.POST('/api/admin/content/homepage/sections/{id}/remove', { params: { path: { id: s.id } }, body: { kind: 'removal', reason: 'Removed from Homepage and pages', immediately: false } })),
    onSuccess: (s) => {
      refresh();
      flash(`${s.title} removed. Restore it from Version history.`);
      setView('');
    },
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
    setDraft(editOf(s));
    setPosition(s ? sections.findIndex((x) => x.id === s.id) : sections.length);
    setHeadErr('');
    saveSection.reset();
    setView('edit-section');
  };
  // Direct ?view=edit-section: fill the drawer from the first editable section once loaded.
  if (open && editId === null && target && !draft.heading && !saveSection.isPending) {
    setEditId(target.id);
    setDraft(editOf(target));
    setPosition(sections.findIndex((x) => x.id === target.id));
  }
  const close = () => setView('');
  const set = <K extends keyof SectionEdit>(k: K, v: SectionEdit[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    if (k === 'heading' && v) setHeadErr('');
  };
  const save = (mode: 'draft' | 'schedule') => {
    if (!draft.heading.trim()) {
      setHeadErr('Enter a heading.');
      return;
    }
    if (mode === 'schedule' && !draft.from) {
      setHeadErr('');
      saveSection.reset();
      document.getElementById('ct-from')?.focus();
      flash('Enter a “Show from” time to schedule the section.', 'info');
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

  if (!canManage) {
    return (
      <AdminLayout active="content">
        <div className="page-head">
          <div className="t">
            <Breadcrumbs items={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Marketing and content' }]} />
            <h1 className="h1">Homepage and pages</h1>
          </div>
        </div>
        <Alert tone="info" title="You don’t have access to the homepage editor">
          Your role can’t manage homepage sections. Ask a Content Manager if you need changes.
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
          <Button size="sm" icon="plus" onClick={() => openEdit()}>
            Add section
          </Button>
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
                  Shown top to bottom · use arrows to reorder · live version {current}
                  {h?.draftVersion ? ` · draft version ${h.draftVersion}` : ''}
                </span>
              </div>
            </div>
            {home.isPending && (
              <div className="card-body">
                <SkeletonLines rows={6} />
              </div>
            )}
            {sections.map((s, i) => (
              <div key={s.id} className={cx('ab-sec', s.locked && 'is-ad', open && s.id === target?.id && 'is-edit')}>
                <span className="handle">
                  <Icon name={s.locked ? 'lock' : 'grip-vertical'} className="ic-sm" />
                </span>
                <span className="row gap-2">
                  <span className="xs muted num">{i + 1}</span>
                  <Icon name={kindOf(s.kind).icon} className="ic-sm" />
                  <b className="small">{s.title}</b>
                  {s.locked ? <Badge tone="outline">Ad position</Badge> : <StatusBadge status={STATUS[s.status] ?? s.status} />}
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
                      <IconButton icon="arrow-up" label={`Move ${s.title} up`} disabled={i === 0 || order.isPending} onClick={() => move(i, -1)} />
                      <IconButton icon="arrow-down" label={`Move ${s.title} down`} disabled={i === sections.length - 1 || order.isPending} onClick={() => move(i, 1)} />
                      <IconButton icon="eye" label={`Preview ${s.title}`} onClick={() => announce(`${s.title}: ${s.description}`)} />
                      <Button variant="ghost" size="sm" to={href('admin/content', 'edit-section')} onClick={(e) => (e.preventDefault(), openEdit(s))}>
                        Edit
                      </Button>
                    </>
                  )}
                </span>
              </div>
            ))}
            <div className="card-foot">
              <span className="ab-note grow">{publishBtn.note}</span>
              <Button variant="ghost" size="sm" disabled={!h?.hasDraft || layout.isPending} onClick={() => layout.mutate('discard')}>
                Discard draft
              </Button>
              <Button size="sm" disabled={!publishBtn.run || layout.isPending} onClick={publishBtn.run}>
                {publishBtn.label}
              </Button>
            </div>
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
            {!canPages ? (
              <div className="card-body">
                <span className="small muted">Your role can’t manage campaign pages.</span>
              </div>
            ) : pages.isError ? (
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
            <Button variant="ghost" size="sm" onClick={() => save('draft')} disabled={saveSection.isPending}>
              Save draft
            </Button>
            <Button size="sm" onClick={() => save('schedule')} disabled={saveSection.isPending}>
              Schedule
            </Button>
          </>
        }
      >
        {(saveSection.isError || removeSection.isError) && (
          <Alert tone="danger" title="The section wasn’t saved">
            {errorMessage(saveSection.error ?? removeSection.error)}
          </Alert>
        )}
        <Field label="Heading" error={headErr}>
          <TextInput id="ct-head" value={draft.heading} error={!!headErr} onChange={(e) => set('heading', e.target.value)} />
        </Field>
        <Field label="Subheading" optional>
          <TextInput id="ct-sub" value={draft.sub} onChange={(e) => set('sub', e.target.value)} />
        </Field>
        {(!target || PRODUCT_KINDS.has(target.kind)) && (
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
          <Field label="Show from" optional>
            <TextInput id="ct-from" type="datetime-local" icon="calendar" value={draft.from} onChange={(e) => set('from', e.target.value)} />
          </Field>
          <Field label="Remove at" optional>
            <TextInput id="ct-to" type="datetime-local" icon="calendar" value={draft.to} onChange={(e) => set('to', e.target.value)} />
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
