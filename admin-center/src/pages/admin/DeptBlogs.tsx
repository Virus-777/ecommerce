import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { Alert, announce, Avatar, Badge, Button, Checkbox, Dialog, Drawer, EmptyState, Field, Img, PageHeader, Pager, SearchInput, SegmentedControl, Select, StatusBadge, Switch, TableWrap, Tabs, Textarea, TextInput } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, LoadError, shortDate, SkeletonLines } from '@/app/parts';
import { BodyEditor, RichText } from './data/news';
import { DeptPage, PAGE_SIZE, PictureField, plural, POST_STATUS, REPORT_REASON, REPORT_STATUS, slugify, totalPagesOf, type BlogAuthor, type BlogPost, type BlogPostInput, type BlogReply, type BlogReport, type BlogTopic, type MediaRef } from './data/departments';

// Admin › Departments › Blogs (designed in React from the Marketly Departments canvas): staff write posts under author
// profiles; customers like, dislike, reply and report. Tabs: Posts | Topics | Authors | Replies | Reports.
// API: /api/admin/departments/blogs/{posts,topics,authors,replies,reports}.

type Tab = '' | 'topics' | 'authors' | 'replies' | 'reports';
type Notify = (title: string, tone?: 'success' | 'danger') => void;
const TITLE_MAX = 120;
const SUMMARY_MAX = 240;

export default function DeptBlogs() {
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('departments.view');
  const canEdit = can('departments.blogs.manage');
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null);
  const [writing, setWriting] = useState(false);
  const notify: Notify = (title, tone = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };

  const topics = useQuery({ queryKey: ['departments', 'blogs', 'topics'], enabled: canView, queryFn: () => call(api.GET('/api/admin/departments/blogs/topics')) });
  const authors = useQuery({ queryKey: ['departments', 'blogs', 'authors'], enabled: canView, queryFn: () => call(api.GET('/api/admin/departments/blogs/authors')) });
  const openReports = useQuery({ queryKey: ['departments', 'blogs', 'reports', 'open-count'], enabled: canView, queryFn: () => call(api.GET('/api/admin/departments/blogs/reports', { params: { query: { status: 'open', limit: 1 } } })) });

  return (
    <DeptPage active="dept-blogs" title="Blogs" canView={canView}>
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Blogs' }]}
        title="Blogs"
        sub={canEdit ? 'Posts are written by staff under author profiles · customers like, dislike, reply and report' : 'View only: editing needs the Blogs permission'}
        actions={
          canEdit &&
          !view && (
            <Button size="sm" icon="plus" onClick={() => setWriting(true)} disabled={!authors.data?.length}>
              Write a post
            </Button>
          )
        }
      />
      <Tabs
        items={[
          { value: '', label: 'Posts' },
          { value: 'topics', label: 'Topics', count: topics.data?.length },
          { value: 'authors', label: 'Authors', count: authors.data?.length },
          { value: 'replies', label: 'Replies' },
          { value: 'reports', label: 'Reports', count: (openReports.data as { total?: number } | undefined)?.total || undefined },
        ]}
        active={view}
        onChange={(v) => {
          setNotice(null);
          setView(v as Tab);
        }}
        label="Blogs"
      />
      {notice && <Alert tone={notice.tone} title={notice.title} />}
      {canView && !view && authors.isSuccess && !authors.data.length && (
        <Alert tone="info" title="Add an author first">
          Every post is written under an author profile. Add one in the Authors tab.
        </Alert>
      )}
      {view === 'topics' ? (
        <TopicsTab notify={notify} canEdit={canEdit} />
      ) : view === 'authors' ? (
        <AuthorsTab notify={notify} canEdit={canEdit} />
      ) : view === 'replies' ? (
        <RepliesTab notify={notify} canEdit={canEdit} />
      ) : view === 'reports' ? (
        <ReportsTab notify={notify} canEdit={canEdit} />
      ) : (
        <PostsTab notify={notify} canEdit={canEdit} topics={topics.data ?? []} authors={authors.data ?? []} writing={writing} setWriting={setWriting} />
      )}
    </DeptPage>
  );
}

/* ---------------- Posts ---------------- */

type PostDraft = { id: string; title: string; slug: string; summary: string; body: string; cover: MediaRef | null; topicId: string; authorId: string; featured: boolean; status: BlogPost['status'] };
const draftOf = (p?: BlogPost, authorId = ''): PostDraft => ({
  id: p?.id ?? '',
  title: p?.title ?? '',
  slug: p?.slug ?? '',
  summary: p?.summary ?? '',
  body: p?.body ?? '',
  cover: p?.cover ?? null,
  topicId: p?.topic?.id ?? '',
  authorId: p?.author.id ?? authorId,
  featured: p?.featured ?? false,
  status: p?.status ?? 'draft',
});

function PostsTab({ notify, canEdit, topics, authors, writing, setWriting }: { notify: Notify; canEdit: boolean; topics: BlogTopic[]; authors: BlogAuthor[]; writing: boolean; setWriting: (v: boolean) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [topicId, setTopicId] = useState('');
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<PostDraft | null>(null);
  const [preview, setPreview] = useState<'edit' | 'preview'>('edit');
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');

  const query = { q: q.trim() || undefined, status: (status || undefined) as BlogPost['status'] | undefined, topicId: topicId || undefined };
  const list = useQuery({
    queryKey: ['departments', 'blogs', 'posts', query, page],
    queryFn: () => call(api.GET('/api/admin/departments/blogs/posts', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];

  const editing = draft ?? (writing ? draftOf(undefined, authors[0]?.id) : null);
  const setD = (patch: Partial<PostDraft>) => editing && setDraft({ ...editing, ...patch });
  const close = () => {
    setDraft(null);
    setWriting(false);
    setTried(false);
    setError('');
    setPreview('edit');
  };
  const errs = tried && editing ? { title: !editing.title.trim() ? 'Enter a title.' : editing.title.trim().length > TITLE_MAX ? `Use at most ${TITLE_MAX} characters.` : '', summary: editing.summary.trim().length > SUMMARY_MAX ? `Use at most ${SUMMARY_MAX} characters.` : '', body: editing.body.trim() ? '' : 'Write the post.', author: editing.authorId ? '' : 'Pick the author.' } : { title: '', summary: '', body: '', author: '' };

  const save = useMutation({
    mutationFn: async ({ d, status }: { d: PostDraft; status: BlogPost['status'] }) => {
      const body: BlogPostInput = { title: d.title.trim(), slug: d.slug.trim() || null, summary: d.summary.trim() || null, body: d.body, cover: d.cover, topicId: d.topicId || null, authorId: d.authorId, featured: d.featured, status };
      return d.id ? call(api.PATCH('/api/admin/departments/blogs/posts/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/departments/blogs/posts', { body }));
    },
    onSuccess: (p, { status }) => {
      void qc.invalidateQueries({ queryKey: ['departments', 'blogs'] });
      notify(status === 'published' ? `${p.title} is published` : status === 'unpublished' ? `${p.title} is unpublished: customers no longer see it` : `${p.title} saved as a draft`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (d: PostDraft) => call(api.DELETE('/api/admin/departments/blogs/posts/{id}', { params: { path: { id: d.id } } })),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: ['departments', 'blogs'] });
      notify(`${d.title} deleted with its reactions, replies and reports`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (status: BlogPost['status']) => {
    if (!editing) return;
    setTried(true);
    const t = editing.title.trim();
    if (!t || t.length > TITLE_MAX || editing.summary.trim().length > SUMMARY_MAX || !editing.body.trim() || !editing.authorId) return;
    save.mutate({ d: editing, status });
  };

  const busy = save.isPending || remove.isPending;
  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="db-q" placeholder="Search posts" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search posts" />
            <select className="select" id="db-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
              <option value="">All statuses</option>
              {(Object.keys(POST_STATUS) as BlogPost['status'][]).map((s) => (
                <option key={s} value={s}>
                  {POST_STATUS[s]}
                </option>
              ))}
            </select>
            <select className="select" id="db-topic" aria-label="Topic" value={topicId} onChange={(e) => (setTopicId(e.target.value), setPage(1))}>
              <option value="">All topics</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {list.isError && (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        )}
        <TableWrap label="Blog posts table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Post</th>
                <th scope="col">Author</th>
                <th scope="col">Status</th>
                <th scope="col">Published</th>
                <th className="r" scope="col">
                  Likes · dislikes
                </th>
                <th className="r" scope="col">
                  Replies
                </th>
                <th className="r" scope="col">
                  Open reports
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isPending && (
                <tr>
                  <td colSpan={8}>
                    <SkeletonLines rows={5} />
                  </td>
                </tr>
              )}
              {rows.map((p) => (
                <tr key={p.id} className={p.openReportCount ? 'is-warn' : undefined}>
                  <td>
                    <span className="row nowrap gap-3">
                      <span style={{ width: 72, flex: 'none' }}>
                        <Img icon="newspaper" src={p.cover?.url} alt="" className="wide" />
                      </span>
                      <span className="stack gap-0">
                        <span className="small strong">{p.title}</span>
                        <span className="xs muted">
                          {p.topic?.name ?? 'No topic'}
                          {p.featured ? ' · Featured' : ''} · {plural(p.readMinutes, 'min')} read
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className="small">{p.author.name}</td>
                  <td>
                    <StatusBadge status={POST_STATUS[p.status]} />
                  </td>
                  <td className="small">{p.publishedAt ? shortDate(p.publishedAt) : '—'}</td>
                  <td className="r small">
                    {num(p.likeCount)} · {num(p.dislikeCount)}
                  </td>
                  <td className="r small">{num(p.replyCount)}</td>
                  <td className="r small">{p.openReportCount ? <Badge tone="warning">{p.openReportCount}</Badge> : '0'}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setTried(false), setError(''), setDraft(draftOf(p)))}>
                      <span>{canEdit ? 'Edit' : 'View'}</span>
                      <span className="sr-only"> {p.title}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState icon="newspaper" title={q || status || topicId ? 'No posts match' : 'No posts yet'}>
                      {q || status || topicId ? 'Try another search or clear the filters.' : 'Write the first post with “Write a post”.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">Customers see published posts, newest first. A featured post shows large at the top of the app’s list.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>

      <Drawer
        open={!!editing}
        onClose={close}
        className="wide"
        title={editing?.id ? `Edit post: ${editing.title || 'Untitled'}` : 'Write a post'}
        foot={
          canEdit ? (
            <>
              {editing?.id && (
                <Button variant="danger-soft" size="sm" onClick={() => editing && remove.mutate(editing)} disabled={busy}>
                  Delete
                </Button>
              )}
              <span className="grow" />
              {editing?.status === 'published' ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => submit('unpublished')} disabled={busy}>
                    Unpublish
                  </Button>
                  <Button size="sm" onClick={() => submit('published')} disabled={busy}>
                    Save changes
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={() => submit(editing?.status === 'unpublished' ? 'unpublished' : 'draft')} disabled={busy}>
                    Save draft
                  </Button>
                  <Button size="sm" icon="upload" onClick={() => submit('published')} disabled={busy}>
                    Publish
                  </Button>
                </>
              )}
            </>
          ) : undefined
        }
      >
        {editing && (
          <>
            {error && (
              <Alert tone="danger" title="The post wasn’t saved">
                {error}
              </Alert>
            )}
            <SegmentedControl
              items={[
                { label: 'Edit', value: 'edit', icon: 'pencil' },
                { label: 'Preview', value: 'preview', icon: 'eye' },
              ]}
              active={preview}
              onChange={setPreview}
              label="Editor mode"
            />
            {preview === 'preview' ? (
              <article className="stack gap-3">
                {editing.cover && <Img icon="newspaper" src={editing.cover.url} alt="" className="wide" />}
                <h2 className="h2">{editing.title || 'Untitled'}</h2>
                {editing.summary && <p className="sub">{editing.summary}</p>}
                <RichText html={editing.body} />
              </article>
            ) : (
              <>
                <Field label="Title" hint={`${editing.title.trim().length} of ${TITLE_MAX}`} error={errs.title}>
                  <TextInput id="db-title" value={editing.title} error={!!errs.title} disabled={!canEdit} onChange={(e) => setD({ title: e.target.value })} />
                </Field>
                <Field label="Slug" optional hint={`The post’s address: /blogs/${editing.slug.trim() || slugify(editing.title) || '…'}`}>
                  <TextInput id="db-slug" value={editing.slug} placeholder={slugify(editing.title)} disabled={!canEdit} onChange={(e) => setD({ slug: e.target.value })} />
                </Field>
                <Field label="Summary" optional hint={`Shown on cards · ${editing.summary.trim().length} of ${SUMMARY_MAX}`} error={errs.summary}>
                  <Textarea id="db-summary" rows={2} value={editing.summary} disabled={!canEdit} onChange={(e) => setD({ summary: e.target.value })} />
                </Field>
                <div className="grid md2 gap-3">
                  <Field label="Topic" optional>
                    <Select id="db-topic-ed" value={editing.topicId} disabled={!canEdit} options={[{ value: '', label: 'No topic' }, ...topics.map((t) => ({ value: t.id, label: t.visible ? t.name : `${t.name} (hidden)` }))]} onChange={(e) => setD({ topicId: e.target.value })} />
                  </Field>
                  <Field label="Author" error={errs.author}>
                    <Select id="db-author" value={editing.authorId} disabled={!canEdit} options={[{ value: '', label: 'Choose an author…' }, ...authors.map((a) => ({ value: a.id, label: a.name }))]} onChange={(e) => setD({ authorId: e.target.value })} />
                  </Field>
                </div>
                <Switch id="db-featured" label="Feature this post at the top of the list" checked={editing.featured} disabled={!canEdit} onChange={(e) => setD({ featured: e.target.checked })} />
                <PictureField label="Cover" shape="wide" icon="newspaper" value={editing.cover} alt={editing.title.trim()} hint="16 : 9, saved at 1200 × 675. Without a cover, cards show a placeholder." disabled={!canEdit} onChange={(cover) => setD({ cover })} />
                <BodyEditor id="db-body" value={editing.body} error={errs.body} disabled={!canEdit} onChange={(body) => setD({ body })} />
                <span className="xs sub">Headings, bold, italics, lists and links. Customers see the post as in Preview.</span>
              </>
            )}
            {editing.id && (
              <span className="xs muted">
                {POST_STATUS[editing.status]} · {rows.find((r) => r.id === editing.id)?.publishedAt ? `published ${dateTime(rows.find((r) => r.id === editing.id)!.publishedAt!)}` : 'never published'}
              </span>
            )}
          </>
        )}
      </Drawer>
    </>
  );
}

/* ---------------- Topics ---------------- */

type TopicDraft = { id: string; name: string; slug: string; position: string; visible: boolean };

function TopicsTab({ notify, canEdit }: { notify: Notify; canEdit: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['departments', 'blogs', 'topics'], queryFn: () => call(api.GET('/api/admin/departments/blogs/topics')) });
  const rows = [...(list.data ?? [])].sort((a, b) => a.position - b.position);
  const [draft, setDraft] = useState<TopicDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const close = () => (setDraft(null), setTried(false), setError(''));
  const setD = (patch: Partial<TopicDraft>) => draft && setDraft({ ...draft, ...patch });

  const save = useMutation({
    mutationFn: (d: TopicDraft) => {
      const body = { name: d.name.trim(), slug: d.slug.trim() || null, position: d.position ? Number(d.position) : null, visible: d.visible };
      return d.id ? call(api.PATCH('/api/admin/departments/blogs/topics/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/departments/blogs/topics', { body }));
    },
    onSuccess: (t, d) => {
      void qc.invalidateQueries({ queryKey: ['departments', 'blogs'] });
      notify(d.id ? `${t.name} saved` : `${t.name} added`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (t: BlogTopic) => call(api.DELETE('/api/admin/departments/blogs/topics/{id}', { params: { path: { id: t.id } } })),
    onSuccess: (_r, t) => {
      void qc.invalidateQueries({ queryKey: ['departments', 'blogs'] });
      notify(`${t.name} deleted`);
    },
    onError: (e, t) => notify(`${t.name} wasn’t deleted: ${errorMessage(e)}`, 'danger'),
  });

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Topics</h2>
            <span className="xs muted">The app shows visible topics as tabs above the posts, in this order</span>
          </div>
          {canEdit && (
            <Button size="sm" icon="plus" onClick={() => setDraft({ id: '', name: '', slug: '', position: String(rows.length + 1), visible: true })}>
              Add topic
            </Button>
          )}
        </div>
        {list.isError ? (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : (
          <TableWrap label="Blog topics table">
            <table className="table">
              <thead>
                <tr>
                  <th className="r" scope="col">
                    Order
                  </th>
                  <th scope="col">Topic</th>
                  <th className="r" scope="col">
                    Published posts
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.isPending && (
                  <tr>
                    <td colSpan={5}>
                      <SkeletonLines rows={3} />
                    </td>
                  </tr>
                )}
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="r small">{t.position}</td>
                    <td>
                      <span className="stack gap-0">
                        <span className="small strong">{t.name}</span>
                        <span className="xs muted">/{t.slug}</span>
                      </span>
                    </td>
                    <td className="r small">{num(t.postCount)}</td>
                    <td>{t.visible ? <Badge tone="success">Visible</Badge> : <Badge icon="eye-off">Hidden</Badge>}</td>
                    <td>
                      {canEdit && (
                        <span className="row gap-1 nowrap">
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft({ id: t.id, name: t.name, slug: t.slug, position: String(t.position), visible: t.visible })}>
                            Edit<span className="sr-only"> {t.name}</span>
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove.mutate(t)} disabled={remove.isPending || t.postCount > 0} title={t.postCount > 0 ? 'Move or delete its posts first' : undefined}>
                            Delete<span className="sr-only"> {t.name}</span>
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {list.isSuccess && rows.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <EmptyState icon="tag" title="No topics yet">
                        Topics such as Science, Economy or Education group the posts in the app.
                      </EmptyState>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>
      <Dialog
        open={!!draft}
        onClose={close}
        title={draft?.id ? `Edit ${draft.name || 'topic'}` : 'Add topic'}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={() => (setTried(true), draft?.name.trim() && save.mutate(draft))} disabled={save.isPending}>
              {draft?.id ? 'Save topic' : 'Add topic'}
            </Button>
          </>
        }
      >
        {draft && (
          <>
            {error && <Alert tone="danger" title={error} />}
            <Field label="Name" error={tried && !draft.name.trim() ? 'Enter the topic name.' : undefined}>
              <TextInput id="dt-name" value={draft.name} error={tried && !draft.name.trim()} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional>
                <TextInput id="dt-slug" value={draft.slug} placeholder={slugify(draft.name)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Order">
                <TextInput id="dt-pos" type="number" min={1} value={draft.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
            </div>
            <Switch id="dt-visible" label="Show this topic in the app" checked={draft.visible} onChange={(e) => setD({ visible: e.target.checked })} />
          </>
        )}
      </Dialog>
    </>
  );
}

/* ---------------- Authors ---------------- */

type AuthorDraft = { id: string; name: string; slug: string; email: string; bio: string; avatar: MediaRef | null };

function AuthorsTab({ notify, canEdit }: { notify: Notify; canEdit: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['departments', 'blogs', 'authors'], queryFn: () => call(api.GET('/api/admin/departments/blogs/authors')) });
  const rows = list.data ?? [];
  const [draft, setDraft] = useState<AuthorDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const close = () => (setDraft(null), setTried(false), setError(''));
  const setD = (patch: Partial<AuthorDraft>) => draft && setDraft({ ...draft, ...patch });
  const emailBad = !!draft?.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim());

  const save = useMutation({
    mutationFn: (d: AuthorDraft) => {
      const body = { name: d.name.trim(), slug: d.slug.trim() || null, email: d.email.trim() || null, bio: d.bio.trim() || null, avatar: d.avatar };
      return d.id ? call(api.PATCH('/api/admin/departments/blogs/authors/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/departments/blogs/authors', { body }));
    },
    onSuccess: (a, d) => {
      void qc.invalidateQueries({ queryKey: ['departments', 'blogs'] });
      notify(d.id ? `${a.name} saved` : `${a.name} added`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (a: BlogAuthor) => call(api.DELETE('/api/admin/departments/blogs/authors/{id}', { params: { path: { id: a.id } } })),
    onSuccess: (_r, a) => {
      void qc.invalidateQueries({ queryKey: ['departments', 'blogs'] });
      notify(`${a.name} deleted`);
    },
    onError: (e, a) => notify(`${a.name} wasn’t deleted: ${errorMessage(e)}`, 'danger'),
  });

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Authors</h2>
            <span className="xs muted">Customers open an author’s profile from a post: avatar, name, email, posts, likes and reports</span>
          </div>
          {canEdit && (
            <Button size="sm" icon="plus" onClick={() => setDraft({ id: '', name: '', slug: '', email: '', bio: '', avatar: null })}>
              Add author
            </Button>
          )}
        </div>
        {list.isError ? (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : (
          <TableWrap label="Blog authors table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Author</th>
                  <th scope="col">Email</th>
                  <th className="r" scope="col">
                    Posts
                  </th>
                  <th className="r" scope="col">
                    Likes
                  </th>
                  <th className="r" scope="col">
                    Reports upheld
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.isPending && (
                  <tr>
                    <td colSpan={6}>
                      <SkeletonLines rows={3} />
                    </td>
                  </tr>
                )}
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <span className="row nowrap gap-3">
                        {a.avatar ? <Img icon="user-round" src={a.avatar.url} alt="" className="tiny round" /> : <Avatar name={a.name} size="sm" />}
                        <span className="stack gap-0">
                          <span className="small strong">{a.name}</span>
                          <span className="xs muted">/blogs/authors/{a.slug}</span>
                        </span>
                      </span>
                    </td>
                    <td className="small">{a.email ?? '—'}</td>
                    <td className="r small">{num(a.postCount)}</td>
                    <td className="r small">{num(a.likeCount)}</td>
                    <td className="r small">{num(a.reportCount)}</td>
                    <td>
                      {canEdit && (
                        <span className="row gap-1 nowrap">
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft({ id: a.id, name: a.name, slug: a.slug, email: a.email ?? '', bio: a.bio ?? '', avatar: a.avatar ?? null })}>
                            Edit<span className="sr-only"> {a.name}</span>
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove.mutate(a)} disabled={remove.isPending || a.postCount > 0} title={a.postCount > 0 ? 'Delete or move their posts first' : undefined}>
                            Delete<span className="sr-only"> {a.name}</span>
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {list.isSuccess && rows.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState icon="user-round" title="No authors yet">
                        Add the people who write the posts.
                      </EmptyState>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>
      <Dialog
        open={!!draft}
        onClose={close}
        title={draft?.id ? `Edit ${draft.name || 'author'}` : 'Add author'}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={() => (setTried(true), draft?.name.trim() && !emailBad && save.mutate(draft))} disabled={save.isPending}>
              {draft?.id ? 'Save author' : 'Add author'}
            </Button>
          </>
        }
      >
        {draft && (
          <>
            {error && <Alert tone="danger" title={error} />}
            <Field label="Name" error={tried && !draft.name.trim() ? 'Enter the author’s name.' : undefined}>
              <TextInput id="da-name" value={draft.name} error={tried && !draft.name.trim()} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional>
                <TextInput id="da-slug" value={draft.slug} placeholder={slugify(draft.name)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Public email" optional hint="Shown on the profile" error={tried && emailBad ? 'Enter a valid email address.' : undefined}>
                <TextInput id="da-email" type="email" value={draft.email} error={tried && emailBad} onChange={(e) => setD({ email: e.target.value })} />
              </Field>
            </div>
            <Field label="Short bio" optional>
              <Textarea id="da-bio" rows={3} value={draft.bio} onChange={(e) => setD({ bio: e.target.value })} />
            </Field>
            <PictureField label="Avatar" shape="square" icon="user-round" value={draft.avatar} alt={draft.name.trim()} hint="Square, saved at 600 × 600. Without one, the app shows initials." disabled={false} onChange={(avatar) => setD({ avatar })} />
          </>
        )}
      </Dialog>
    </>
  );
}

/* ---------------- Replies ---------------- */

function RepliesTab({ notify, canEdit }: { notify: Notify; canEdit: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [reported, setReported] = useState(false);
  const [page, setPage] = useState(1);
  const query = { status: (status || undefined) as BlogReply['status'] | undefined, reported: reported || undefined };
  const list = useQuery({
    queryKey: ['departments', 'blogs', 'replies', query, page],
    queryFn: () => call(api.GET('/api/admin/departments/blogs/replies', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const moderate = useMutation({
    mutationFn: ({ r, status }: { r: BlogReply; status: BlogReply['status'] }) => call(api.PATCH('/api/admin/departments/blogs/replies/{id}', { params: { path: { id: r.id } }, body: { status } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['departments', 'blogs'] });
      notify(r.status === 'hidden' ? `Reply by ${r.authorName} hidden` : `Reply by ${r.authorName} shown again`);
    },
    onError: (e) => notify(`The reply wasn’t changed: ${errorMessage(e)}`, 'danger'),
  });

  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <select className="select" id="dr-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            <option value="">Visible and hidden</option>
            <option value="visible">Visible</option>
            <option value="hidden">Hidden</option>
          </select>
          <Checkbox id="dr-rep" label="Only replies with open reports" checked={reported} onChange={(e) => (setReported(e.target.checked), setPage(1))} />
        </div>
      </div>
      {list.isError && (
        <div className="card-body">
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        </div>
      )}
      <TableWrap label="Blog replies table">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Reply</th>
              <th scope="col">Post</th>
              <th scope="col">Written</th>
              <th className="r" scope="col">
                Open reports
              </th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.isPending && (
              <tr>
                <td colSpan={6}>
                  <SkeletonLines rows={4} />
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className={r.openReportCount ? 'is-warn' : undefined}>
                <td>
                  <span className="stack gap-0">
                    <span className="small strong">{r.authorName}</span>
                    <span className="small">{r.text}</span>
                  </span>
                </td>
                <td className="small">{r.postTitle}</td>
                <td className="small">{dateTime(r.createdAt)}</td>
                <td className="r small">{r.openReportCount ? <Badge tone="warning">{r.openReportCount}</Badge> : '0'}</td>
                <td>{r.status === 'visible' ? <Badge tone="success">Visible</Badge> : <Badge icon="eye-off">Hidden</Badge>}</td>
                <td>
                  {canEdit && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => moderate.mutate({ r, status: r.status === 'visible' ? 'hidden' : 'visible' })} disabled={moderate.isPending}>
                      {r.status === 'visible' ? 'Hide' : 'Show'}
                      <span className="sr-only"> reply by {r.authorName}</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <EmptyState icon="message-circle" title="No replies here">
                    Customers’ replies to posts show up here.
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <div className="card-foot between">
        <span className="xs muted">Replies show at once. Hide one to take it off the post; showing it again puts it back.</span>
        <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
      </div>
    </section>
  );
}

/* ---------------- Reports ---------------- */

const TARGET_LABEL: Record<BlogReport['targetType'], string> = { post: 'Post', reply: 'Reply', author: 'Author' };
const DECIDE_NOTE: Record<BlogReport['targetType'], string> = { post: 'Upholding unpublishes the post.', reply: 'Upholding hides the reply.', author: 'Upholding counts toward the author’s reports.' };

function ReportsTab({ notify, canEdit }: { notify: Notify; canEdit: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [status, setStatus] = useState<BlogReport['status'] | ''>('open');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['departments', 'blogs', 'reports', status, page],
    queryFn: () => call(api.GET('/api/admin/departments/blogs/reports', { params: { query: { status: status || undefined, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const decide = useMutation({
    mutationFn: ({ r, status }: { r: BlogReport; status: 'upheld' | 'dismissed' }) => call(api.PATCH('/api/admin/departments/blogs/reports/{id}', { params: { path: { id: r.id } }, body: { status } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['departments', 'blogs'] });
      notify(r.status === 'upheld' ? `Report upheld: ${r.targetLabel}` : `Report dismissed: ${r.targetLabel}`);
    },
    onError: (e) => notify(`The report wasn’t decided: ${errorMessage(e)}`, 'danger'),
  });

  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <select className="select" id="drp-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as BlogReport['status'] | ''), setPage(1))}>
            <option value="">All reports</option>
            {(Object.keys(REPORT_STATUS) as BlogReport['status'][]).map((s) => (
              <option key={s} value={s}>
                {REPORT_STATUS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {list.isError && (
        <div className="card-body">
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        </div>
      )}
      <TableWrap label="Blog reports table">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Reported</th>
              <th scope="col">Reason</th>
              <th scope="col">Received</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.isPending && (
              <tr>
                <td colSpan={5}>
                  <SkeletonLines rows={4} />
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="stack gap-0">
                    <span className="xs muted">{TARGET_LABEL[r.targetType]}</span>
                    <span className="small strong">{r.targetLabel}</span>
                  </span>
                </td>
                <td>
                  <span className="stack gap-0">
                    <span className="small">{REPORT_REASON[r.reason]}</span>
                    {r.note && <span className="xs muted">{r.note}</span>}
                  </span>
                </td>
                <td className="small">{dateTime(r.createdAt)}</td>
                <td>
                  <StatusBadge status={REPORT_STATUS[r.status]} tone={r.status === 'open' ? 'warning' : r.status === 'upheld' ? 'danger' : ''} />
                </td>
                <td>
                  {canEdit && r.status === 'open' && (
                    <span className="row gap-1 nowrap" title={DECIDE_NOTE[r.targetType]}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => decide.mutate({ r, status: 'dismissed' })} disabled={decide.isPending}>
                        Dismiss<span className="sr-only"> report about {r.targetLabel}</span>
                      </button>
                      <button type="button" className="btn btn-danger-soft btn-sm" onClick={() => decide.mutate({ r, status: 'upheld' })} disabled={decide.isPending}>
                        Uphold<span className="sr-only"> report about {r.targetLabel}</span>
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <EmptyState icon="circle-check" title={status === 'open' ? 'No open reports' : 'No reports here'}>
                    Reports customers send about posts, replies and authors show up here.
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <div className="card-foot between">
        <span className="xs muted">Upholding a post report unpublishes the post; a reply report hides the reply; an author report counts on the profile.</span>
        <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
      </div>
    </section>
  );
}
