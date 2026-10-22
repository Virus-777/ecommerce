import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, EmptyState, PageHeader, Pager, TableWrap } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, shortDate, SkeletonLines } from '@/app/parts';
import { DeptPage, HideReviewDialog, PAGE_SIZE, plural, totalPagesOf, type DeptReview, type ReviewTargetType } from './data/departments';

// Admin › Departments › Company and game reviews (designed in React like the Softwares and Food delivery reviews
// tabs). Customers rate companies and Play center games 1–5 stars with an optional text, one review each; staff hide
// or show them here. Hidden reviews leave the app and stop counting in the rating.
// API: GET /api/admin/departments/reviews (target, targetId, hidden, stars), POST …/reviews/{id}/moderate.

type Notify = (title: string, tone?: 'success' | 'danger') => void;
const KIND: Record<ReviewTargetType, { label: string; noun: string }> = { company: { label: 'Companies', noun: 'company' }, game: { label: 'Games', noun: 'game' } };
const targetHref = (r: DeptReview) => (r.target.type === 'game' ? href('admin/departments-play') : href('admin/departments-companies'));

export default function DeptReviews() {
  const { can } = useStaffSession();
  const canView = can('departments.view');
  const canManage = can('departments.reviews.manage');
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null);
  const notify: Notify = (title, tone = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };

  return (
    <DeptPage active="dept-reviews" title="Company and game reviews" canView={canView}>
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Company and game reviews' }]}
        title="Company and game reviews"
        sub={canManage ? 'What customers wrote about the companies in Companies and the games in the Play center · hide a review to take it out of the app' : 'View only: hiding reviews needs the department reviews permission'}
      />
      {notice && <Alert tone={notice.tone} title={notice.title} />}
      <ReviewsList notify={notify} canManage={canManage} />
    </DeptPage>
  );
}

function ReviewsList({ notify, canManage }: { notify: Notify; canManage: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [kind, setKind] = useState<ReviewTargetType | ''>('');
  const [targetId, setTargetId] = useState('');
  const [hidden, setHidden] = useState<'' | 'true' | 'false'>('');
  const [stars, setStars] = useState('');
  const [page, setPage] = useState(1);
  const [hiding, setHiding] = useState<DeptReview | null>(null);
  const [error, setError] = useState('');
  const games = useQuery({ queryKey: ['departments', 'play', 'games'], enabled: kind === 'game', queryFn: () => call(api.GET('/api/admin/departments/play/games')) });
  const companies = useQuery({ queryKey: ['departments', 'companies', 'all'], enabled: kind === 'company', queryFn: () => call(api.GET('/api/admin/departments/companies', { params: { query: { limit: 100 } } })) });
  const targets = kind === 'game' ? (games.data ?? []).map((g) => ({ id: g.id, name: g.title })) : kind === 'company' ? (companies.data?.items ?? []).map((c) => ({ id: c.id, name: c.name })) : [];
  const query = { target: kind || undefined, targetId: (kind && targetId) || undefined, hidden: hidden ? hidden === 'true' : undefined, stars: stars ? Number(stars) : undefined };
  const list = useQuery({
    queryKey: ['departments', 'reviews', query, page],
    queryFn: () => call(api.GET('/api/admin/departments/reviews', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const filtered = !!(kind || hidden || stars);
  const moderate = useMutation({
    mutationFn: ({ r, hide, reason }: { r: DeptReview; hide: boolean; reason?: string | null }) => call(api.POST('/api/admin/departments/reviews/{id}/moderate', { params: { path: { id: r.id } }, body: { hidden: hide, reason: reason ?? null } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['departments'] });
      setHiding(null);
      setError('');
      notify(r.hidden ? `${r.name}’s review of ${r.target.name} is hidden from customers` : `${r.name}’s review of ${r.target.name} shows again`);
    },
    onError: (e, v) => (v.hide ? setError(errorMessage(e)) : notify(`The review wasn’t changed: ${errorMessage(e)}`, 'danger')),
  });

  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <select className="select" id="drv-kind" aria-label="Reviews of" value={kind} onChange={(e) => (setKind(e.target.value as ReviewTargetType | ''), setTargetId(''), setPage(1))}>
            <option value="">Companies and games</option>
            {(Object.keys(KIND) as ReviewTargetType[]).map((k) => (
              <option key={k} value={k}>
                {KIND[k].label}
              </option>
            ))}
          </select>
          {kind && (
            <select className="select" id="drv-target" aria-label={kind === 'game' ? 'Game' : 'Company'} value={targetId} onChange={(e) => (setTargetId(e.target.value), setPage(1))}>
              <option value="">{kind === 'game' ? 'All games' : 'All companies'}</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          <select className="select" id="drv-st" aria-label="Status" value={hidden} onChange={(e) => (setHidden(e.target.value as '' | 'true' | 'false'), setPage(1))}>
            <option value="">All reviews</option>
            <option value="false">Visible</option>
            <option value="true">Hidden</option>
          </select>
          <select className="select" id="drv-stars" aria-label="Stars" value={stars} onChange={(e) => (setStars(e.target.value), setPage(1))}>
            <option value="">All ratings</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {plural(n, 'star')}
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
      <TableWrap label="Reviews table">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Rating</th>
              <th scope="col">Review</th>
              <th scope="col">Of</th>
              <th scope="col">By</th>
              <th scope="col">Written</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.isPending && (
              <tr>
                <td colSpan={7}>
                  <SkeletonLines rows={4} />
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="small nowrap" aria-label={`${r.stars} of 5 stars`}>
                  {'★'.repeat(r.stars)}
                  <span className="muted">{'★'.repeat(5 - r.stars)}</span>
                </td>
                <td className="small">
                  <span className="truncate" style={{ display: 'block', maxWidth: 320 }} title={r.text ?? undefined}>
                    {r.text ?? <span className="muted">No text</span>}
                  </span>
                </td>
                <td>
                  <span className="stack gap-0">
                    <Link className="small" to={targetHref(r)}>
                      {r.target.name}
                    </Link>
                    <span className="xs muted">{r.target.type === 'game' ? 'Game' : 'Company'}</span>
                  </span>
                </td>
                <td>
                  <Link className="small" to={href('admin/customers', 'customer-detail', undefined, { customer: r.customerId })}>
                    {r.name}
                  </Link>
                </td>
                <td className="small nowrap">{shortDate(r.date)}</td>
                <td>
                  {r.hidden ? (
                    <span className="stack gap-0">
                      <Badge icon="eye-off">Hidden</Badge>
                      {r.hiddenReason && <span className="xs muted">{r.hiddenReason}</span>}
                    </span>
                  ) : (
                    <Badge tone="success">Visible</Badge>
                  )}
                </td>
                <td>
                  {canManage && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => (r.hidden ? moderate.mutate({ r, hide: false }) : (setError(''), setHiding(r)))} disabled={moderate.isPending}>
                      {r.hidden ? 'Show' : 'Hide'}
                      <span className="sr-only"> review by {r.name}</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState icon="star" title={filtered ? 'No reviews match' : 'No reviews yet'}>
                    {filtered ? 'Try other filters.' : 'Customers rate a company or a game from its page in the app.'}
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <div className="card-foot between">
        <span className="xs muted">{list.data?.total != null ? plural(list.data.total, 'review') : plural(rows.length, 'review')} · last changed first · hiding one takes it out of the rating.</span>
        <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
      </div>
      <HideReviewDialog open={!!hiding} who={hiding?.name ?? ''} busy={moderate.isPending} error={error} onClose={() => setHiding(null)} onHide={(reason) => hiding && moderate.mutate({ r: hiding, hide: true, reason })} />
    </section>
  );
}
