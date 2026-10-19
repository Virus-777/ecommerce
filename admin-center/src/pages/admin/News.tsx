import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useIsPhone, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, announce, Badge, Button, Card, Dialog, EmptyState, Field, Icon, Img, PageHeader, Pager, Radio, SearchInput, SegmentedControl, Select, StatusBadge, Switch, TableWrap, Tabs, Textarea, TextInput,
} from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, date, dateTime } from '@/app/parts';
import { useDebounced, useInView } from './data/seller';
import {
  actorName, BodyEditor, categoryIcon, CoverField, isoToWall, RichText, rowStatus, STATUS_LABEL, SUMMARY_MAX, TABS, TITLE_MAX, wallToIso,
  type MediaRef, type NewsAdmin, type NewsCategory, type NewsInput, type NewsRow, type TabKey,
} from './data/news';
import { NEWS_CATEGORIES_KEY, NewsCategoriesDialog } from './data/news-categories';
import './news.css';

// Design: designed in React from docs/06-news.md (§2–§4); no design file. View "" = the posts list, "edit" = the editor
// (?view=edit&id=<id>, or no id for a new post).
// Data: GET /api/admin/content/news (status, categoryId, q; numbered pages on the website, cursor on the phone),
// /news/counts (tab counts), /news-categories (filter and the Manage categories dialog). Editor: GET /news/{id},
// POST /news (new draft), PATCH /news/{id} (edits; a live post gets a new draft), POST /news/{id}/transition (submit,
// approve, requestChanges, schedule, cancelSchedule, publish, unpublish, remove, restore — the Content publication
// machine, as for help articles), POST /news/{id}/preview, /news/{id}/pin, GET /news/{id}/versions,
// POST /news/{id}/versions/{n}/restore. With review on (NewsAdmin.reviewRequired, default) someone other than the
// draft's writer approves it before it is scheduled or published (SAME_REVIEWER).

const LIMIT = 20;
const NEWS_KEY = ['content', 'news'] as const;
type Notice = { tone: 'success' | 'info'; title: string; text?: ReactNode };
type ReviewState = 'none' | 'in_review' | 'approved' | 'changes_requested';
const REVIEW_LABEL: Record<ReviewState, string> = { none: 'Not sent', in_review: 'In review', approved: 'Approved', changes_requested: 'Changes requested' };

function Frame({ crumb, children }: { crumb?: string; children: ReactNode }) {
  return (
    <AdminLayout active="news">
      <PageHeader crumbs={[{ label: 'Marketing and content' }, ...(crumb ? [{ label: 'News', to: href('admin/news') }, { label: crumb }] : [{ label: 'News' }])]} title="News" />
      {children}
    </AdminLayout>
  );
}

/* ---------------- List ---------------- */

function dateCell(r: NewsRow): { label: string; when?: string } {
  if (r.status === 'scheduled' && r.publishAt) return { label: 'Scheduled', when: r.publishAt };
  if (r.archived && r.archiveAt) return { label: 'Archived', when: r.archiveAt };
  if (r.publishedAt) return { label: r.status === 'published' ? 'Published' : 'Last published', when: r.publishedAt };
  return { label: '' };
}

function NewsList({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const { api } = useApi();
  const { can } = useStaffSession();
  const canManage = can('content.news.manage');
  const isPhone = useIsPhone();
  const [tab, setTab] = useState<TabKey>('all');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [page, setPage] = useState(1);
  const [catsOpen, setCatsOpen] = useState(false);
  const term = useDebounced(q.trim(), 300);

  const query = useMemo(() => ({ status: tab === 'all' ? undefined : tab, categoryId: cat || undefined, q: term || undefined }), [tab, cat, term]);
  useEffect(() => setPage(1), [query]);

  const counts = useQuery({ queryKey: [...NEWS_KEY, 'counts'], queryFn: () => call(api.GET('/api/admin/content/news/counts')) });
  const cats = useQuery({ queryKey: NEWS_CATEGORIES_KEY, queryFn: () => call(api.GET('/api/admin/content/news-categories')) });
  const listQ = useQuery({
    queryKey: [...NEWS_KEY, 'list', query, page],
    queryFn: () => call(api.GET('/api/admin/content/news', { params: { query: { ...query, page, limit: LIMIT } } })),
    enabled: !isPhone,
    placeholderData: keepPreviousData,
  });
  const phoneQ = useInfiniteQuery({
    queryKey: [...NEWS_KEY, 'list', 'phone', query],
    queryFn: ({ pageParam }) => call(api.GET('/api/admin/content/news', { params: { query: { ...query, cursor: pageParam || undefined, limit: LIMIT } } })),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isPhone,
  });
  const active = isPhone ? phoneQ : listQ;
  const loaded = isPhone ? !!phoneQ.data : !!listQ.data;
  const rows: NewsRow[] = isPhone ? (phoneQ.data?.pages.flatMap((p) => p.items) ?? []) : (listQ.data?.items ?? []);
  const totalPages = listQ.data?.totalPages ?? 1;
  const more = useInView<HTMLDivElement>(() => void phoneQ.fetchNextPage(), isPhone && phoneQ.hasNextPage && !phoneQ.isFetchingNextPage);

  const catOptions = [{ value: '', label: 'All categories' }, ...[...(cats.data ?? [])].sort((a, b) => a.position - b.position).map((c) => ({ value: c.id, label: c.visible ? c.name : `${c.name} (hidden)` }))];
  const tabs = TABS.map((t) => ({ label: t.label, value: t.value, count: counts.data ? counts.data[t.count] : undefined }));
  const filtered = !!(term || cat || tab !== 'all');

  const titleLink = (r: NewsRow, className: string) => (
    <a
      className={className}
      href={href('admin/news', 'edit', undefined, { id: r.id })}
      onClick={(e) => {
        e.preventDefault();
        onOpen(r.id);
      }}
    >
      {r.title}
    </a>
  );
  const markers = (r: NewsRow) => (
    <>
      {r.awaitingReview && (
        <Badge tone="warning" icon="clock">
          Waiting for review
        </Badge>
      )}
      {(r.status === 'published' || r.status === 'unpublished') && r.draftVersion != null && !r.awaitingReview && <span className="xs muted">Edits in a draft</span>}
    </>
  );
  const empty = (
    <EmptyState icon="newspaper" title={filtered ? 'No posts match these filters' : 'No news yet'}>
      {filtered ? 'Try another tab, category or search.' : canManage ? 'Write the first post with New post.' : 'Posts written by Content appear here.'}
    </EmptyState>
  );

  return (
    <AdminLayout active="news">
      <PageHeader
        crumbs={[{ label: 'Marketing and content' }, { label: 'News' }]}
        title="News"
        sub="Short posts from Marketly to customers: announcements, service updates, events and policy changes"
        actions={
          <>
            <Button variant="secondary" size="sm" icon="settings-2" onClick={() => setCatsOpen(true)}>
              Manage categories
            </Button>
            {canManage && (
              <Button size="sm" icon="plus" onClick={onNew}>
                New post
              </Button>
            )}
          </>
        }
      />
      {counts.isError && <LoadError error={counts.error} onRetry={() => void counts.refetch()} />}

      <section className="card">
        <div className="u-p-0-sp-4">
          <Tabs items={tabs} active={tab} onChange={setTab} label="Post status" />
        </div>
        <div className="card-body u-pb-sp-3">
          <div className="toolbar">
            <SearchInput id="nw-q" placeholder="Search titles" label="Search posts" value={q} onChange={setQ} />
            <Select id="nw-cat" aria-label="Category" options={catOptions} value={cat} onChange={(e) => setCat(e.target.value)} />
          </div>
        </div>
        {active.isError ? (
          <div className="card-body">
            <LoadError error={active.error} onRetry={() => void active.refetch()} />
          </div>
        ) : (
          <>
            <div className="no-phone">
              {loaded && !rows.length ? (
                empty
              ) : (
                <TableWrap label="News posts table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Title</th>
                        <th scope="col">Category</th>
                        <th scope="col">Status</th>
                        <th scope="col">
                          <span className="sr-only">Pinned</span>
                          <Icon name="bookmark" className="ic-sm" />
                        </th>
                        <th scope="col">Owner</th>
                        <th scope="col">Published</th>
                        <th scope="col">Last change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!loaded && (
                        <tr>
                          <td colSpan={7}>
                            <SkeletonLines rows={5} />
                          </td>
                        </tr>
                      )}
                      {rows.map((r) => {
                        const dc = dateCell(r);
                        return (
                          <tr key={r.id}>
                            <td>
                              <span className="stack gap-1 nw-title">
                                {titleLink(r, 'small strong')}
                                <span className="row gap-2">{markers(r)}</span>
                              </span>
                            </td>
                            <td>
                              <Badge tone="outline" icon={categoryIcon(r.category.icon)}>
                                {r.category.name}
                              </Badge>
                            </td>
                            <td>
                              <StatusBadge status={rowStatus(r)} />
                            </td>
                            <td>{r.pinned ? <span title="Pinned"><Icon name="bookmark" className="ic-sm" /><span className="sr-only">Pinned</span></span> : <span className="sr-only">Not pinned</span>}</td>
                            <td>
                              <span className="small">{r.owner.name}</span>
                            </td>
                            <td>
                              {dc.when ? (
                                <span className="stack gap-0">
                                  <span className="small nowrap">{date(dc.when)}</span>
                                  {dc.label !== 'Published' && <span className="xs muted">{dc.label}</span>}
                                </span>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                            <td>
                              <span className="small nowrap">{dateTime(r.updatedAt)}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </div>
            <div className="ac-mlist only-phone">
              {!loaded && <SkeletonLines rows={4} />}
              {loaded && !rows.length && empty}
              {rows.map((r) => {
                const dc = dateCell(r);
                return (
                  <div className={cx('ac-mi', r.awaitingReview && 'is-warn')} key={r.id}>
                    <div className="row between gap-2 nowrap top">
                      {titleLink(r, 'small strong min-w-0')}
                      <span className="row gap-1 nowrap">
                        {r.pinned && <span title="Pinned"><Icon name="bookmark" className="ic-sm" /><span className="sr-only">Pinned</span></span>}
                        <StatusBadge status={rowStatus(r)} />
                      </span>
                    </div>
                    <div className="xs sub">
                      {r.category.name} · {r.owner.name}
                      {dc.when ? ` · ${dc.label} ${date(dc.when)}` : ''} · changed {dateTime(r.updatedAt)}
                    </div>
                    {(r.awaitingReview || r.draftVersion != null) && <div className="row gap-2">{markers(r)}</div>}
                  </div>
                );
              })}
              <div ref={more} />
            </div>
          </>
        )}
        <div className="card-foot between">
          <span className="xs muted">Pinned posts list first in the store (at most 3). Dates are Pacific Time.</span>
          {isPhone ? loaded && rows.length > 0 && <Pager only="phone" end={!phoneQ.hasNextPage} /> : totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} only="website" />}
        </div>
      </section>

      <NewsCategoriesDialog
        open={catsOpen}
        canEdit={canManage}
        onClose={() => setCatsOpen(false)}
        onOpenPost={(id) => {
          setCatsOpen(false);
          onOpen(id);
        }}
      />
    </AdminLayout>
  );
}

/* ---------------- Editor ---------------- */

type Draft = {
  title: string;
  slug: string;
  categoryId: string;
  summary: string;
  body: string;
  cover: MediaRef | null;
  ctaLabel: string;
  ctaUrl: string;
  archiveAt: string;
  changeNote: string;
};
type FieldKey = Exclude<keyof Draft, 'cover' | 'changeNote'> | 'changeNote';
type Errors = Partial<Record<FieldKey, string>>;

const fieldsOf = (a: NewsAdmin | undefined, categories: NewsCategory[]): Draft => ({
  title: a?.post.title ?? '',
  slug: a?.post.slug ?? '',
  categoryId: a?.post.category.id ?? [...categories].sort((x, y) => x.position - y.position).find((c) => c.visible)?.id ?? categories[0]?.id ?? '',
  summary: a?.post.summary ?? '',
  body: a?.post.body ?? '',
  cover: a?.post.cover ?? null,
  ctaLabel: a?.post.cta?.label ?? '',
  ctaUrl: a?.post.cta?.url ?? '',
  archiveAt: isoToWall(a?.archiveAt),
  changeNote: '',
});
const sameFields = (x: Draft, y: Draft) =>
  x.title === y.title && x.slug === y.slug && x.categoryId === y.categoryId && x.summary === y.summary && x.body === y.body && (x.cover?.id ?? null) === (y.cover?.id ?? null) && x.ctaLabel === y.ctaLabel && x.ctaUrl === y.ctaUrl && x.archiveAt === y.archiveAt;

/** API field paths (details.issues) → form fields. */
const FIELD_OF: Record<string, FieldKey> = { title: 'title', slug: 'slug', categoryId: 'categoryId', summary: 'summary', body: 'body', 'cta.url': 'ctaUrl', 'cta.label': 'ctaLabel', cta: 'ctaUrl', archiveAt: 'archiveAt', changeNote: 'changeNote' };

type TransitionAction = 'submit' | 'approve' | 'requestChanges' | 'schedule' | 'cancelSchedule' | 'publish' | 'unpublish' | 'remove' | 'restore' | 'discardDraft';
type Act =
  | { kind: 'save' }
  | { kind: 'transition'; action: TransitionAction; reason?: string; removal?: 'correction' | 'removal'; publishAt?: string; saveFirst?: boolean }
  | { kind: 'pin'; pinned: boolean }
  | { kind: 'restoreVersion'; number: number; reason: string };
type DialogState = null | { type: 'changes' | 'unpublish' | 'remove' | 'schedule' | 'discard' } | { type: 'restoreVersion'; number: number };

const DONE: Record<TransitionAction, string> = {
  submit: 'Sent for review',
  approve: 'Approved',
  requestChanges: 'Changes requested',
  schedule: 'Scheduled',
  cancelSchedule: 'Schedule cancelled',
  publish: 'Published',
  unpublish: 'Unpublished',
  remove: 'Removed',
  restore: 'Restored as a draft',
  discardDraft: 'Draft discarded; the live post is unchanged',
};

function NewsEditor({ id }: { id?: string }) {
  const { api } = useApi();
  const [, setParams] = useSearchParams();
  const [notice, setNotice] = useState<Notice | null>(null);
  // The notice survives the switch from a new post to its id (after the first save), not a switch to another post.
  const [noticeId, setNoticeId] = useState(id);
  if (noticeId !== id) {
    setNoticeId(id);
    if (noticeId) setNotice(null);
  }
  const cats = useQuery({ queryKey: NEWS_CATEGORIES_KEY, queryFn: () => call(api.GET('/api/admin/content/news-categories')) });
  const post = useQuery({ queryKey: [...NEWS_KEY, 'post', id], enabled: !!id, queryFn: () => call(api.GET('/api/admin/content/news/{id}', { params: { path: { id: id! } } })) });
  const err = cats.error ?? (id ? post.error : null);
  if (err) {
    return (
      <Frame crumb="Editor">
        {err instanceof ApiError && err.status === 404 ? (
          <Alert tone="warning" title="This post doesn’t exist">
            <Link to={href('admin/news')}>Back to News</Link>
          </Alert>
        ) : (
          <LoadError error={err} onRetry={() => void (cats.isError ? cats.refetch() : post.refetch())} />
        )}
      </Frame>
    );
  }
  if (!cats.data || (id && !post.data)) {
    return (
      <Frame crumb="Editor">
        <div className="ab-main wide">
          <Card pad>
            <SkeletonLines rows={10} />
          </Card>
          <Card pad>
            <SkeletonLines rows={6} />
          </Card>
        </div>
      </Frame>
    );
  }
  const a = id ? post.data : undefined;
  // Remount on server-side state changes (status, a new or restored draft); plain saves keep the form as typed.
  const key = a ? `${a.post.id}:${a.status}:${a.draftVersion ?? ''}:${a.liveVersion ?? ''}` : 'new';
  return (
    <NewsForm
      key={key}
      a={a}
      categories={cats.data}
      notice={notice}
      onNotice={setNotice}
      onCreated={(newId) => setParams({ view: 'edit', id: newId }, { replace: true })}
    />
  );
}

function NewsForm({ a, categories, notice, onNotice, onCreated }: { a?: NewsAdmin; categories: NewsCategory[]; notice: Notice | null; onNotice: (n: Notice | null) => void; onCreated: (id: string) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can, name: me } = useStaffSession();
  const canManage = can('content.news.manage');
  const canPublish = can('content.news.publish');
  const canRemove = can('content.pages.remove');

  const baseline = fieldsOf(a, categories);
  const [d, setD] = useState<Draft>(baseline);
  const [coverPreview, setCoverPreview] = useState<string | undefined>();
  const [errors, setErrors] = useState<Errors>({});
  const [dialog, setDialog] = useState<DialogState>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((p) => ({ ...p, [k]: v }));
    if (k !== 'cover') setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const status = a?.status;
  const live = status === 'published' || status === 'unpublished';
  const liveDraft = live && a?.draftVersion != null;
  const dr = a?.draftReview ?? null;
  const review: ReviewState = liveDraft ? (dr?.state ?? 'none') : status === 'in_review' ? 'in_review' : status === 'approved' ? 'approved' : dr?.state === 'changes_requested' ? 'changes_requested' : 'none';
  const reviewOn = a?.reviewRequired ?? true;
  // The backend freezes a draft in review, approved or scheduled (and a removed post) until changes are requested,
  // the schedule is cancelled or the post is restored.
  const frozen = status === 'in_review' || status === 'approved' || status === 'scheduled' || status === 'removed' || (liveDraft && (review === 'in_review' || review === 'approved'));
  const canSave = canManage && !frozen;
  const locked = !canSave;
  const dirty = !sameFields(d, baseline);
  const approvedToGo = !reviewOn || review === 'approved';

  const category = categories.find((c) => c.id === d.categoryId);

  const validate = () => {
    const e: Errors = {};
    if (!d.title.trim()) e.title = 'Enter a title.';
    else if (d.title.trim().length > TITLE_MAX) e.title = `Use up to ${TITLE_MAX} characters.`;
    if (d.slug.trim() && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.slug.trim())) e.slug = 'Use lowercase letters, numbers and hyphens.';
    if (!d.categoryId) e.categoryId = 'Choose a category.';
    if (!d.summary.trim()) e.summary = 'Write a short summary. Customers see it on the news cards.';
    else if (d.summary.trim().length > SUMMARY_MAX) e.summary = `Use up to ${SUMMARY_MAX} characters.`;
    if (!d.body.replace(/<[^>]*>/g, '').trim()) e.body = 'Write the post.';
    const label = d.ctaLabel.trim();
    const url = d.ctaUrl.trim();
    if (label && !url) e.ctaUrl = 'Enter where the button goes, e.g. /deals.';
    else if (url && !label) e.ctaLabel = 'Enter the button text, e.g. See the deals.';
    else if (url && !/^(\/(?!\/)|https:\/\/)/i.test(url)) e.ctaUrl = 'Use a store path starting with / or an https:// link.';
    setErrors(e);
    if (Object.keys(e).length) announce('Check the highlighted fields.');
    return Object.keys(e).length === 0;
  };

  const input = (): NewsInput => ({
    title: d.title.trim(),
    slug: d.slug.trim() || null,
    categoryId: d.categoryId,
    summary: d.summary.trim(),
    body: d.body,
    cover: d.cover,
    cta: d.ctaLabel.trim() && d.ctaUrl.trim() ? { label: d.ctaLabel.trim(), url: d.ctaUrl.trim() } : null,
    archiveAt: d.archiveAt ? wallToIso(d.archiveAt) : null,
    changeNote: d.changeNote.trim() || null,
  });

  const run = useMutation({
    mutationFn: async (x: Act) => {
      let r = a;
      if (x.kind === 'save' || (x.kind === 'transition' && x.saveFirst)) {
        r = a ? await call(api.PATCH('/api/admin/content/news/{id}', { params: { path: { id: a.post.id } }, body: input() })) : await call(api.POST('/api/admin/content/news', { body: input() }));
      }
      const id = r!.post.id;
      if (x.kind === 'transition') {
        const body =
          x.action === 'requestChanges' || x.action === 'unpublish'
            ? { action: x.action, reason: x.reason || null }
            : x.action === 'remove'
              ? { action: x.action, kind: x.removal, reason: x.reason }
              : x.action === 'schedule'
                ? { action: x.action, publishAt: x.publishAt }
                : { action: x.action };
        r = await call(api.POST('/api/admin/content/news/{id}/transition', { params: { path: { id } }, body }));
      } else if (x.kind === 'pin') {
        r = await call(api.POST('/api/admin/content/news/{id}/pin', { params: { path: { id } }, body: { pinned: x.pinned } }));
      } else if (x.kind === 'restoreVersion') {
        r = await call(api.POST('/api/admin/content/news/{id}/versions/{number}/restore', { params: { path: { id, number: x.number } }, body: { reason: x.reason } }));
      }
      return r!;
    },
    onSuccess: (r, x) => {
      qc.setQueryData([...NEWS_KEY, 'post', r.post.id], r);
      void qc.invalidateQueries({ queryKey: NEWS_KEY });
      void qc.invalidateQueries({ queryKey: NEWS_CATEGORIES_KEY });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
      setDialog(null);
      setErrors({});
      setD((p) => ({ ...p, changeNote: '' }));
      const n = noticeFor(r, x);
      onNotice(n);
      announce(n.title);
      if (!a) onCreated(r.post.id);
    },
    onError: (e) => {
      if (!(e instanceof ApiError)) return;
      if (e.code === 'SLUG_TAKEN') return setErrors({ slug: e.message || 'Another post uses this address. Choose another.' });
      const fe: Errors = {};
      for (const [path, msg] of Object.entries(e.fieldErrors)) {
        const k = FIELD_OF[path] ?? FIELD_OF[path.split('.')[0]];
        if (k) fe[k] = msg;
      }
      if (Object.keys(fe).length) setErrors(fe);
    },
  });

  const noticeFor = (r: NewsAdmin, x: Act): Notice => {
    if (x.kind === 'save') return { tone: 'success', title: 'Draft saved', text: r.status === 'published' ? 'The live post stays as it is until this draft is published.' : undefined };
    if (x.kind === 'pin') return { tone: 'success', title: x.pinned ? 'Pinned' : 'Unpinned', text: x.pinned ? (r.status === 'published' ? 'The post lists first in the store. At most 3 posts are pinned; pinning a fourth unpins the one pinned longest ago.' : 'The pin applies from the time the post is published.') : undefined };
    if (x.kind === 'restoreVersion') return { tone: 'success', title: `Version ${x.number} restored as a draft`, text: 'Check it, then send it for review or publish it as usual.' };
    const t = DONE[x.action];
    if (x.action === 'submit') return { tone: 'info', title: t, text: r.reviewRequired ? 'Someone else with publish rights approves it before it is scheduled or published.' : undefined };
    if (x.action === 'schedule') return { tone: 'success', title: t, text: r.schedule.publishAt ? `It goes live ${dateTime(r.schedule.publishAt)} (Pacific Time).` : r.schedule.label };
    if (x.action === 'publish') return { tone: 'success', title: t, text: 'Customers see it on the News page and in the Latest news section now.' };
    if (x.action === 'unpublish') return { tone: 'success', title: t, text: 'It left the News page and the homepage section; its link answers “not found”.' };
    return { tone: 'success', title: t };
  };

  const save = (x: Act) => {
    run.reset();
    if ((x.kind === 'save' || (x.kind === 'transition' && x.saveFirst)) && !validate()) return;
    run.mutate(x);
  };
  const transition = (action: TransitionAction, extra: Omit<Extract<Act, { kind: 'transition' }>, 'kind' | 'action'> = {}) => save({ kind: 'transition', action, ...extra });
  const openDialog = (s: DialogState) => {
    run.reset();
    setDialog(s);
  };

  /* ----- what the caller can do now (state machine + permissions) ----- */
  const showSubmit = canSave && reviewOn && (!a || status === 'draft' || live);
  const showApprove = review === 'in_review' && canPublish && !!a?.canApprove;
  const showChanges = (review === 'in_review' || review === 'approved') && canPublish;
  // a live post's unpublished draft can be dropped; the live post stays
  const showDiscard = liveDraft && canManage;
  const goLiveOk = !!a && canPublish && (status === 'approved' || status === 'scheduled' || (status === 'draft' && !reviewOn) || (status === 'published' && liveDraft && approvedToGo) || (status === 'unpublished' && (!liveDraft || approvedToGo)));
  const scheduleOk = !!a && canPublish && (status === 'approved' || (status === 'draft' && !reviewOn) || (status === 'unpublished' && (!liveDraft || approvedToGo)));
  const showCancel = status === 'scheduled' && canPublish;
  const showUnpublish = status === 'published' && canPublish;
  const showRemove = !!a && canRemove && status !== 'removed';
  const showRestorePost = status === 'removed' && canManage;
  // With review off, unsaved edits are saved first and go live with a publish or schedule. With review on, edits make
  // a draft that needs review, so publishing waits until they are saved and sent (or undone).
  const withEdits = canSave && dirty && !reviewOn;
  const editsNeedReview = canSave && dirty && reviewOn;
  const publishLabel = status === 'published' ? 'Publish changes' : status === 'unpublished' && !liveDraft ? 'Publish again' : 'Publish now';

  const pending = run.isPending;
  const runError = run.isError && !dialog ? run.error : null;
  const fieldErrorShown = runError instanceof ApiError && (runError.code === 'SLUG_TAKEN' || Object.keys(runError.fieldErrors).some((p) => FIELD_OF[p] ?? FIELD_OF[p.split('.')[0]]));

  const title = d.title.trim() || (a ? a.post.title : 'New post');
  const version = a ? (a.draftVersion ?? a.liveVersion ?? a.post.version) : null;
  const headBadge = status ? <StatusBadge status={a!.archived ? 'Archived' : STATUS_LABEL[status]} /> : <Badge>New</Badge>;

  return (
    <AdminLayout active="news">
      <PageHeader
        crumbs={[{ label: 'Marketing and content' }, { label: 'News', to: href('admin/news') }, { label: a ? a.post.title : 'New post' }]}
        title={title}
        sub={a ? `News post · version ${version} · owner ${a.owner.name}${a.owner.role ? `, ${a.owner.role}` : ''}` : `News post · written by ${me || 'you'}`}
        actions={
          <>
            {headBadge}
            <Button variant="secondary" size="sm" icon="arrow-left" to={href('admin/news')}>
              All posts
            </Button>
          </>
        }
      />
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.text} <Link to={href('admin/news')}>Back to News</Link>
        </Alert>
      )}
      {!canManage && <Alert tone="info" title="Read only">Your role can view news but not write it.</Alert>}

      <div className="ab-main wide">
        <div className="stack gap-4">
          <Card title="Post">
            {frozen && canManage && (
              <Alert tone="info" title="Editing is paused">
                {status === 'scheduled'
                  ? 'Cancel the schedule to change the post.'
                  : status === 'removed'
                    ? 'Restore the post to change it.'
                    : review === 'approved'
                      ? 'The draft is approved. Publish it, or use Request changes to edit it again.'
                      : 'The draft is in review. It can be edited again once changes are requested.'}
              </Alert>
            )}
            <Field label="Title" hint={`${d.title.length}/${TITLE_MAX}`} error={errors.title}>
              <TextInput id="nw-title" value={d.title} maxLength={TITLE_MAX} error={!!errors.title} onChange={(e) => set('title', e.target.value)} disabled={locked} />
            </Field>
            <Field label="Address" optional hint={`/news/${d.slug.trim() || 'made-from-the-title'} · changing it later keeps the old address working`} error={errors.slug}>
              <TextInput id="nw-slug" prefix="/news/" value={d.slug} error={!!errors.slug} onChange={(e) => set('slug', e.target.value.toLowerCase())} disabled={locked} />
            </Field>
            <Field label="Category" error={errors.categoryId}>
              <Select
                id="nw-cat"
                options={[...(d.categoryId ? [] : [{ value: '', label: 'Choose a category' }]), ...[...categories].sort((x, y) => x.position - y.position).map((c) => ({ value: c.id, label: c.visible ? c.name : `${c.name} (hidden in the store)` }))]}
                value={d.categoryId}
                onChange={(e) => set('categoryId', e.target.value)}
                disabled={locked}
              />
            </Field>
            <Field label="Summary" hint={`${d.summary.length}/${SUMMARY_MAX} · shown on news cards and in link previews`} error={errors.summary}>
              <Textarea id="nw-summary" rows={3} value={d.summary} maxLength={SUMMARY_MAX} onChange={(e) => set('summary', e.target.value)} disabled={locked} className={cx(errors.summary && 'is-error')} />
            </Field>
            <CoverField
              cover={d.cover}
              preview={coverPreview}
              alt={d.title.trim()}
              icon={categoryIcon(category?.icon)}
              disabled={locked}
              onChange={(cover, preview) => {
                set('cover', cover);
                setCoverPreview(preview);
              }}
            />
            <BodyEditor value={d.body} onChange={(v) => set('body', v)} error={errors.body} disabled={locked} />
          </Card>

          <Card title="Button and listing" titleAs="h3">
            <div className="nw-pair">
              <Field label="Button text" optional error={errors.ctaLabel}>
                <TextInput id="nw-cta-label" placeholder="See the deals" value={d.ctaLabel} error={!!errors.ctaLabel} onChange={(e) => set('ctaLabel', e.target.value)} disabled={locked} />
              </Field>
              <Field label="Button link" optional hint="A store path such as /deals, or an https:// link" error={errors.ctaUrl}>
                <TextInput id="nw-cta-url" placeholder="/deals" value={d.ctaUrl} error={!!errors.ctaUrl} onChange={(e) => set('ctaUrl', e.target.value)} disabled={locked} />
              </Field>
            </div>
            <Field label="Remove from the list at" optional hint="Pacific Time. After this the post leaves the News page; its link still opens it, marked Archived." error={errors.archiveAt}>
              <TextInput id="nw-archive" type="datetime-local" icon="calendar" value={d.archiveAt} error={!!errors.archiveAt} onChange={(e) => set('archiveAt', e.target.value)} disabled={locked} />
            </Field>
            <Field label="Change note" optional hint="For version history, e.g. Fixed the cut-off date" error={errors.changeNote}>
              <TextInput id="nw-note" value={d.changeNote} error={!!errors.changeNote} onChange={(e) => set('changeNote', e.target.value)} disabled={locked} />
            </Field>
          </Card>
        </div>

        <div className="stack gap-4">
          <Card
            title="Publishing"
            titleAs="h3"
            foot={
              <>
                {canSave && (
                  <Button variant="ghost" size="sm" onClick={() => save({ kind: 'save' })} disabled={pending}>
                    Save draft
                  </Button>
                )}
                {showSubmit && (
                  <Button size="sm" icon="send" onClick={() => transition('submit', { saveFirst: true })} disabled={pending}>
                    {review === 'changes_requested' ? 'Send for review again' : 'Submit for review'}
                  </Button>
                )}
                {showApprove && (
                  <Button size="sm" icon="check" onClick={() => transition('approve')} disabled={pending}>
                    Approve
                  </Button>
                )}
                {showChanges && (
                  <Button variant="secondary" size="sm" onClick={() => openDialog({ type: 'changes' })} disabled={pending}>
                    Request changes
                  </Button>
                )}
                {scheduleOk && (
                  <Button variant="secondary" size="sm" icon="calendar" onClick={() => (withEdits && !validate() ? undefined : openDialog({ type: 'schedule' }))} disabled={pending || editsNeedReview}>
                    Schedule
                  </Button>
                )}
                {showCancel && (
                  <Button variant="secondary" size="sm" onClick={() => transition('cancelSchedule')} disabled={pending}>
                    Cancel schedule
                  </Button>
                )}
                {goLiveOk && (
                  <Button size="sm" onClick={() => transition('publish', { saveFirst: withEdits })} disabled={pending || editsNeedReview}>
                    {publishLabel}
                  </Button>
                )}
                {showRestorePost && (
                  <Button size="sm" icon="rotate-ccw" onClick={() => transition('restore')} disabled={pending}>
                    Restore as draft
                  </Button>
                )}
                {showDiscard && (
                  <Button variant="ghost" size="sm" onClick={() => openDialog({ type: 'discard' })} disabled={pending}>
                    Discard draft
                  </Button>
                )}
              </>
            }
          >
            {runError && !fieldErrorShown && (
              <Alert tone="danger" title="That didn’t work">
                {errorMessage(runError)}
              </Alert>
            )}
            {runError && fieldErrorShown && <Alert tone="danger" title="Check the highlighted fields">{errorMessage(runError)}</Alert>}
            <dl className="nw-facts">
              <dt>Status</dt>
              <dd>
                {headBadge}
                {liveDraft && <span className="xs muted"> · new draft (version {a!.draftVersion})</span>}
              </dd>
              {a && (
                <>
                  <dt>Schedule</dt>
                  <dd className="small">{a.schedule.label}</dd>
                  <dt>Last published</dt>
                  <dd className="small">{a.lastPublishedAt ? dateTime(a.lastPublishedAt) : 'Never'}</dd>
                </>
              )}
            </dl>
            <div className="divider" />
            <ul className="ab-approvals">
              <li>
                <span className={cx('n', review === 'approved' || (!liveDraft && status === 'published') ? 'is-done' : 'is-wait')}>{review === 'approved' || (!liveDraft && status === 'published') ? <Icon name="check" className="ic-sm" /> : 1}</span>
                <span className="ab-cell">
                  <span className="strong">Second-person review{liveDraft ? ` · version ${a!.draftVersion}` : ''}</span>
                  <span className="xs muted">{reviewOn ? 'Someone other than the writer, with publish rights, approves every post' : 'Review is off for news (Settings › Content); publishers can publish directly'}</span>
                  {a?.draftAuthor && <span className="xs muted">Draft written by {actorName(a.draftAuthor) ?? 'staff'}</span>}
                  {dr && (
                    <span className="xs muted">
                      {dr.state === 'in_review' ? 'Sent for review' : dr.state === 'approved' ? 'Approved' : 'Changes requested'}
                      {actorName(dr.by) ? ` by ${actorName(dr.by)}` : ''} · {dateTime(dr.at)}
                      {dr.state === 'changes_requested' && dr.reason ? `: ${dr.reason}` : ''}
                    </span>
                  )}
                  {review === 'in_review' && canPublish && !a?.canApprove && <span className="xs strong">You wrote this draft; someone else approves it.</span>}
                  {review === 'in_review' && !canPublish && <span className="xs muted">Waiting for someone with publish rights.</span>}
                </span>
                <StatusBadge status={REVIEW_LABEL[review]} tone={review === 'changes_requested' ? 'warning' : undefined} />
              </li>
            </ul>
            {(showUnpublish || showRemove) && (
              <>
                <div className="divider" />
                <div className="row gap-2 wrap">
                  {showUnpublish && (
                    <Button variant="secondary" size="sm" icon="eye-off" onClick={() => openDialog({ type: 'unpublish' })} disabled={pending}>
                      Unpublish
                    </Button>
                  )}
                  {showRemove && (
                    <Button variant="danger-soft" size="sm" icon="trash-2" onClick={() => openDialog({ type: 'remove' })} disabled={pending}>
                      Remove
                    </Button>
                  )}
                </div>
              </>
            )}
            {status === 'approved' && <span className="xs muted">An approved post is published or scheduled as it is.</span>}
            {editsNeedReview && (goLiveOk || scheduleOk) && <span className="xs t-warning-text">You have unsaved edits. Save and submit them for review first, or reload the page to publish the post as it is.</span>}
            {!a && <span className="xs muted">Save the draft to preview it, pin it and see its versions.</span>}
          </Card>

          {a && (
            <Card title="Pin" titleAs="h3">
              <Switch
                id="nw-pin"
                label={a.pinned ? 'Pinned: lists first in the store' : 'Not pinned'}
                checked={a.pinned}
                onChange={(e) => save({ kind: 'pin', pinned: e.target.checked })}
                disabled={!canPublish || pending || status === 'removed'}
              />
              <span className="xs muted">At most 3 posts are pinned; pinning a fourth unpins the one pinned longest ago. Takes effect at once, without review.</span>
            </Card>
          )}

          {a && <NewsPreview a={a} dirty={dirty} />}
          {a && <NewsVersions a={a} canRestore={canManage} blocked={status === 'in_review' || status === 'approved' || status === 'scheduled'} pending={pending} onRestore={(n) => openDialog({ type: 'restoreVersion', number: n })} />}
        </div>
      </div>

      <ActionDialog
        key={dialog ? (dialog.type === 'restoreVersion' ? `rv${dialog.number}` : dialog.type) : 'closed'}
        state={dialog}
        postTitle={title}
        pending={pending}
        error={run.isError && dialog ? errorMessage(run.error) : undefined}
        onClose={() => setDialog(null)}
        onConfirm={({ reason, removal, when }) => {
          if (!dialog) return;
          if (dialog.type === 'changes') transition('requestChanges', { reason });
          else if (dialog.type === 'unpublish') transition('unpublish', { reason });
          else if (dialog.type === 'remove') transition('remove', { reason, removal });
          else if (dialog.type === 'schedule') transition('schedule', { publishAt: wallToIso(when), saveFirst: withEdits });
          else if (dialog.type === 'discard') transition('discardDraft');
          else if (dialog.type === 'restoreVersion') save({ kind: 'restoreVersion', number: dialog.number, reason });
        }}
      />
    </AdminLayout>
  );
}

/* ---------------- Dialogs ---------------- */

function ActionDialog({ state, postTitle, pending, error, onClose, onConfirm }: { state: DialogState; postTitle: string; pending: boolean; error?: string; onClose: () => void; onConfirm: (v: { reason: string; removal: 'correction' | 'removal'; when: string }) => void }) {
  const [reason, setReason] = useState('');
  const [removal, setRemoval] = useState<'correction' | 'removal'>('removal');
  const [when, setWhen] = useState('');
  const [tried, setTried] = useState(false);
  if (!state) return null;
  const t = state.type;
  const cfg = {
    changes: { title: `Request changes to ${postTitle}`, confirm: 'Request changes', reason: 'What needs to change', hint: 'The writer sees this with the draft sent back to them.', required: true },
    unpublish: { title: `Unpublish ${postTitle}`, confirm: 'Unpublish', reason: 'Reason', hint: 'Optional. Kept in Action history. The post leaves the News page at once.', required: false },
    remove: { title: `Remove ${postTitle}`, confirm: 'Remove post', reason: 'Reason', hint: 'Kept in Action history. A removed post loses its pin and its link answers “not found”.', required: true },
    schedule: { title: `Schedule ${postTitle}`, confirm: 'Schedule', reason: '', hint: '', required: false },
    discard: { title: `Discard the draft of ${postTitle}`, confirm: 'Discard draft', reason: '', hint: '', required: false },
    restoreVersion: { title: `Restore version ${state.type === 'restoreVersion' ? state.number : ''}`, confirm: 'Restore as draft', reason: 'Why restore it', hint: 'Restoring makes a new draft from that version. Nothing is overwritten.', required: true },
  }[t];
  const missingReason = tried && cfg.required && !reason.trim();
  const whenError = tried && t === 'schedule' ? (!when ? 'Choose when the post goes live.' : new Date(wallToIso(when)) <= new Date() ? 'Choose a time in the future.' : undefined) : undefined;
  const confirm = () => {
    setTried(true);
    if (cfg.required && !reason.trim()) return;
    if (t === 'schedule' && (!when || new Date(wallToIso(when)) <= new Date())) return;
    onConfirm({ reason: reason.trim(), removal, when });
  };
  return (
    <Dialog
      open
      size="sm"
      onClose={onClose}
      title={cfg.title}
      foot={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant={t === 'remove' || t === 'discard' ? 'danger' : 'primary'} onClick={confirm} disabled={pending}>
            {cfg.confirm}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger" title={error} />}
      {t === 'discard' ? (
        <span className="small">The unpublished changes are dropped and customers keep seeing the live post. The draft stays in Version history.</span>
      ) : t === 'schedule' ? (
        <Field label="Goes live at" hint="Pacific Time" error={whenError}>
          <TextInput id="nw-when" type="datetime-local" icon="calendar" value={when} error={!!whenError} onChange={(e) => setWhen(e.target.value)} />
        </Field>
      ) : (
        <>
          {t === 'remove' && (
            <fieldset className="stack gap-2 fieldset-reset">
              <legend className="label">Kind</legend>
              <Radio id="nw-rm-removal" name="nw-rm" label="Removal: the post should not have been published" checked={removal === 'removal'} onChange={() => setRemoval('removal')} />
              <Radio id="nw-rm-correction" name="nw-rm" label="Correction: it was wrong and will be replaced" checked={removal === 'correction'} onChange={() => setRemoval('correction')} />
            </fieldset>
          )}
          <Field label={cfg.reason} optional={!cfg.required} hint={cfg.hint} error={missingReason ? 'Enter a reason.' : undefined}>
            <Textarea id="nw-reason" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </>
      )}
    </Dialog>
  );
}

/* ---------------- Preview ---------------- */

function NewsPreview({ a, dirty }: { a: NewsAdmin; dirty: boolean }) {
  const { api } = useApi();
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const both = a.draftVersion != null && a.liveVersion != null;
  const [which, setWhich] = useState<'draft' | 'live'>('draft');
  const useDraft = !both || which === 'draft';
  const id = a.post.id;
  const pv = useQuery({
    queryKey: [...NEWS_KEY, 'preview', id, useDraft, a.post.updatedAt, a.status],
    queryFn: () => call(api.POST('/api/admin/content/news/{id}/preview', { params: { path: { id } }, body: { useDraft } })),
  });
  const p = pv.data;
  const content = p && (
    <div className={cx('nw-pv', device === 'phone' && 'is-phone')}>
      <Img icon={categoryIcon(p.category.icon)} src={p.cover?.url} alt={p.cover?.alt ?? ''} className="wide" />
      <div className="row gap-2">
        <Badge tone="brand" icon={categoryIcon(p.category.icon)}>
          {p.category.name}
        </Badge>
        <span className="xs muted">{p.publishedAt ? date(p.publishedAt) : 'Not published yet'}</span>
        {p.pinned && <Badge icon="bookmark">Pinned</Badge>}
      </div>
      <h3 className={device === 'phone' ? 'h4' : 'h3'}>{p.title}</h3>
      <p className="small sub">{p.summary}</p>
      {p.archived && <Alert tone="info" title="This news is archived" />}
      <RichText html={p.body} />
      {p.cta && (
        <span>
          <Button size="sm" title={p.cta.url} onClick={() => announce(`The button goes to ${p.cta?.url}`)}>
            {p.cta.label}
          </Button>
        </span>
      )}
    </div>
  );
  return (
    <Card title="Preview" titleAs="h3" sub={`${device === 'desktop' ? 'Website' : 'Phone and app'} · ${useDraft && a.draftVersion != null ? 'draft' : 'live'}`}>
      {dirty && <span className="xs t-warning-text">Unsaved changes aren’t in the preview. Save the draft to see them.</span>}
      {pv.isError ? (
        <LoadError error={pv.error} onRetry={() => void pv.refetch()} />
      ) : !p ? (
        <SkeletonLines rows={6} />
      ) : device === 'desktop' ? (
        <div className="ab-dframe">
          <div className="ab-dbar" aria-hidden="true">
            <i />
            <i />
            <i />
            <span>{p.url}</span>
          </div>
          {content}
        </div>
      ) : (
        <div className="ab-mframe nw-mframe">{content}</div>
      )}
      <div className="row gap-2 wrap">
        <SegmentedControl
          items={[
            { label: 'Desktop', value: 'desktop', icon: 'monitor' },
            { label: 'Phone', value: 'phone', icon: 'smartphone' },
          ]}
          active={device}
          onChange={setDevice}
          label="Preview device"
        />
        {both && (
          <SegmentedControl
            items={[
              { label: 'Draft', value: 'draft' },
              { label: 'Live', value: 'live' },
            ]}
            active={which}
            onChange={setWhich}
            label="Preview version"
          />
        )}
      </div>
    </Card>
  );
}

/* ---------------- Version history ---------------- */

function NewsVersions({ a, canRestore, blocked, pending, onRestore }: { a: NewsAdmin; canRestore: boolean; blocked: boolean; pending: boolean; onRestore: (n: number) => void }) {
  const { api } = useApi();
  const id = a.post.id;
  const versions = useQuery({
    queryKey: [...NEWS_KEY, 'versions', id],
    queryFn: () => call(api.GET('/api/admin/content/news/{id}/versions', { params: { path: { id }, query: { limit: 50 } } })),
  });
  return (
    <Card title="Version history" titleAs="h3" flush foot={<span className="ab-note grow">{blocked ? 'Finish the review or cancel the schedule before restoring a version.' : 'Restoring makes a new draft. Nothing is overwritten.'}</span>}>
      {versions.isPending ? (
        <div className="card-body">
          <SkeletonLines rows={3} />
        </div>
      ) : versions.isError ? (
        <div className="card-body">
          <LoadError error={versions.error} onRetry={() => void versions.refetch()} />
        </div>
      ) : versions.data.items.length === 0 ? (
        <div className="card-body">
          <span className="small muted">No versions yet.</span>
        </div>
      ) : (
        <ul className="list pad">
          {[...versions.data.items].sort((x, y) => y.number - x.number).map((v) => {
            // The live version is worth restoring only over a newer draft (to start again from the live text).
            const restorable = canRestore && v.state !== 'draft' && !(v.state === 'live' && a.draftVersion == null);
            return (
              <li key={v.id}>
                <span className="grow stack gap-0 min-w-0">
                  <span className="small strong">
                    v{v.number}
                    {v.state === 'live' ? ' · live' : v.state === 'draft' ? ' · draft' : ''}
                    {v.restoredFrom != null ? ` · from v${v.restoredFrom}` : ''}
                  </span>
                  <span className="xs muted">
                    {dateTime(v.publishedAt ?? v.createdAt)} · {actorName(v.author) ?? 'staff'}
                    {v.summary ? ` · ${v.summary}` : ''}
                  </span>
                </span>
                {v.state === 'live' && <Badge tone="brand">Live</Badge>}
                {restorable && (
                  <Button variant="ghost" size="sm" icon="rotate-ccw" onClick={() => onRestore(v.number)} disabled={blocked || pending}>
                    Restore
                    <span className="sr-only"> version {v.number}</span>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ---------------- Page ---------------- */

export default function News() {
  const [view] = useView<'edit'>();
  const [params, setParams] = useSearchParams();
  const { can } = useStaffSession();
  if (!can('content.view')) {
    return (
      <Frame>
        <Alert tone="info" title="You don’t have access to news">
          Viewing news needs the “View content” permission. A Platform Administrator can change your roles in Staff and roles.
        </Alert>
      </Frame>
    );
  }
  const open = (id?: string) => {
    setParams(id ? { view: 'edit', id } : { view: 'edit' });
    window.scrollTo({ top: 0 });
  };
  if (view === 'edit') {
    const id = params.get('id') ?? undefined;
    if (!id && !can('content.news.manage')) {
      return (
        <Frame crumb="New post">
          <Alert tone="info" title="Not available for your role">
            Writing news needs the “Manage news” permission. <Link to={href('admin/news')}>Back to News</Link>
          </Alert>
        </Frame>
      );
    }
    return <NewsEditor id={id} />;
  }
  return <NewsList onOpen={(id) => open(id)} onNew={() => open()} />;
}
