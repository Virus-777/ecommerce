// Admin › Sellers views "Appeals" and "Launch reviews" (?filter=appeals | launch_reviews, the screen filters the
// backend's work queues sellers.appeals and sellers.launch_reviews link to). No design: they reuse the Sellers card,
// table and phone-card markup.
// Data: GET /api/admin/sellers/appeals (open appeals, earliest decide-by first; reviewerId for "Assigned to me"),
// GET /api/admin/workqueues/items?queueKey=sellers.launch_reviews (sellers that asked for the launch readiness review;
// the sellers list has no filter for it). Writes: through data/seller-decisions (appeal assign/decide, launch review).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Deadline, EmptyState, Select, StatusBadge, TableWrap } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, deadlineLabel, deadlineTone, shortDate } from '@/app/parts';
import { cap, type Appeal } from './seller';
import { AppealDecideDialog, LaunchReviewDialog, useAssignAppeal, useSellerRefresh } from './seller-decisions';

type WorkItem = components['schemas']['workqueues.WorkItem'];
type Done = (title: string, body: string) => void;

const skeleton = (
  <div className="sk-list" aria-hidden="true">
    {Array.from({ length: 4 }, (_, i) => (
      <div key={i} className="sk-row">
        <span className="sk sk-line" />
        <span className="sk sk-line short" />
      </div>
    ))}
  </div>
);
// The seller route takes the store slug or the id.
const sellerHref = (sellerId: string) => href('admin/seller', '', { slug: sellerId });

/* ------------------------------------------------------------------ appeals */

export function AppealsQueue() {
  const { api } = useApi();
  const { can, accountId } = useStaffSession();
  const refresh = useSellerRefresh();
  const [mine, setMine] = useState(false);
  const [flash, setFlash] = useState<{ title: string; body: string } | null>(null);
  const [deciding, setDeciding] = useState<Appeal | null>(null);
  const done: Done = (title, body) => (setFlash({ title, body }), refresh());
  const assign = useAssignAppeal(done);
  const canDecide = can('sellers.appeals.decide');
  const list = useQuery({
    queryKey: ['sellers', 'appeals', mine ? accountId : 'all'],
    queryFn: () => call(api.GET('/api/admin/sellers/appeals', { params: { query: { limit: 100, ...(mine ? { reviewerId: accountId } : {}) } } })),
    enabled: canDecide,
  });
  const rows = list.data?.items ?? [];

  const actions = (ap: Appeal) => (
    <span className="row gap-2 nowrap">
      {ap.reviewer?.id !== accountId && (
        <Button variant="ghost" size="sm" disabled={assign.isPending} onClick={() => assign.mutate({ appealId: ap.id, reviewerId: accountId })}>
          Assign to me
        </Button>
      )}
      <Button variant="secondary" size="sm" onClick={() => setDeciding(ap)}>
        Decide
      </Button>
    </span>
  );
  const about = (ap: Appeal) => `${cap(ap.subject)} ${ap.subjectRef}${ap.level > 1 ? ' · second appeal' : ''}`;

  return (
    <>
      <div className="card-body">
        {flash && (
          <Alert tone="success" title={flash.title}>
            {flash.body}
          </Alert>
        )}
        {assign.isError && (
          <Alert tone="danger" title="We couldn’t assign the appeal">
            {errorMessage(assign.error)}
          </Alert>
        )}
        <div className="toolbar">
          <span className="small sub grow">Appeals are decided by someone who did not make the original decision. Overturning lifts the restriction, ends the suspension or reopens the application.</span>
          <Select id="aa-sl-apl-who" ctl="sm" options={[{ value: 'all', label: 'All open appeals' }, { value: 'mine', label: 'Assigned to me' }]} value={mine ? 'mine' : 'all'} onChange={(e) => setMine(e.target.value === 'mine')} />
        </div>
      </div>
      {!canDecide ? (
        <div className="card-body">
          <Alert tone="info" title="Not available for your role">
            Deciding seller appeals needs the sellers.appeals.decide permission.
          </Alert>
        </div>
      ) : list.isError ? (
        <div className="card-body">
          <LoadError error={list.error} onRetry={() => void list.refetch()} title="We couldn’t load the appeals" />
        </div>
      ) : list.isLoading ? (
        skeleton
      ) : !rows.length ? (
        <EmptyState icon="scale" title={mine ? 'No appeals assigned to you' : 'No open appeals'}>
          Appeals that sellers file in Seller Center appear here.
        </EmptyState>
      ) : (
        <>
          <div className="no-phone">
            <TableWrap label="Appeals table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Appeal</th>
                    <th scope="col">Seller</th>
                    <th scope="col">About</th>
                    <th scope="col">Argument</th>
                    <th scope="col">Reviewer</th>
                    <th scope="col">Decide by</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((ap) => (
                    <tr key={ap.id} className={deadlineTone(ap.decideBy.state) === 'danger' ? 'is-flagged' : undefined}>
                      <td>
                        <span className="stack gap-0">
                          <span className="mono strong nowrap">{ap.ref}</span>
                          <span className="xs muted">{`Filed ${shortDate(ap.submittedAt)}`}</span>
                        </span>
                      </td>
                      <td>
                        <Link className="small strong" to={sellerHref(ap.sellerId)}>
                          {ap.storeName}
                        </Link>
                      </td>
                      <td>
                        <span className="small">{about(ap)}</span>
                      </td>
                      <td>
                        <span className="small u-maxw-28ch u-d-inline-block">{ap.argument}</span>
                      </td>
                      <td>{ap.reviewer?.name ?? <span className="muted">Not assigned</span>}</td>
                      <td>
                        <Deadline tone={deadlineTone(ap.decideBy.state)}>{deadlineLabel(ap.decideBy.dueAt, 'Decide by')}</Deadline>
                      </td>
                      <td>{actions(ap)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
          <div className="only-phone card-pad-phone">
            <div className="aa-mlist">
              {rows.map((ap) => (
                <div key={ap.id} className="aa-mcard">
                  <span className="row between gap-2">
                    <Link className="small strong" to={sellerHref(ap.sellerId)}>
                      {ap.storeName}
                    </Link>
                    <StatusBadge status={cap(ap.state)} />
                  </span>
                  <span className="xs muted">{`${ap.ref} · ${about(ap)}`}</span>
                  <span className="xs sub">{ap.argument}</span>
                  <Deadline tone={deadlineTone(ap.decideBy.state)}>{deadlineLabel(ap.decideBy.dueAt, 'Decide by')}</Deadline>
                  {actions(ap)}
                </div>
              ))}
            </div>
          </div>
          {list.data?.nextCursor && <p className="card-body xs muted">Showing the 100 appeals due first.</p>}
        </>
      )}
      {deciding && <AppealDecideDialog appeal={deciding} onClose={() => setDeciding(null)} onDone={done} />}
    </>
  );
}

/* ------------------------------------------------------------------ launch reviews */

export function LaunchReviewQueue() {
  const { api } = useApi();
  const { can } = useStaffSession();
  const refresh = useSellerRefresh();
  const [flash, setFlash] = useState<{ title: string; body: string } | null>(null);
  const [deciding, setDeciding] = useState<{ sellerId: string; storeName: string } | null>(null);
  const done: Done = (title, body) => (setFlash({ title, body }), refresh());
  const canDecide = can('sellers.applications.decide');
  const list = useQuery({
    queryKey: ['workqueues', 'items', 'sellers.launch_reviews'],
    queryFn: () => call(api.GET('/api/admin/workqueues/items', { params: { query: { queueKey: 'sellers.launch_reviews', state: 'active', sort: 'deadline', limit: 100 } } })),
  });
  const rows: WorkItem[] = list.data?.items ?? [];

  // The queue also holds store-change reviews; only launch_review items are decided here.
  const decide = (w: WorkItem) =>
    w.kind === 'launch_review' && w.sellerId && canDecide ? (
      <Button size="sm" variant="secondary" icon="rocket" onClick={() => setDeciding({ sellerId: w.sellerId!, storeName: w.sellerName ?? 'Seller' })}>
        Decide
      </Button>
    ) : w.sellerId ? (
      <Button size="sm" variant="ghost" to={sellerHref(w.sellerId)}>
        Open seller
      </Button>
    ) : null;

  return (
    <>
      <div className="card-body">
        {flash && (
          <Alert tone="success" title={flash.title}>
            {flash.body}
          </Alert>
        )}
        <span className="small sub">Sellers who finished store setup and asked to go live. Their offers stay hidden until the launch readiness review passes.</span>
      </div>
      {list.isError ? (
        <div className="card-body">
          <LoadError error={list.error} onRetry={() => void list.refetch()} title="We couldn’t load the launch reviews" />
        </div>
      ) : list.isLoading ? (
        skeleton
      ) : !rows.length ? (
        <EmptyState icon="rocket" title="No launch reviews waiting">
          Sellers appear here when they ask for the launch readiness review in Seller Center.
        </EmptyState>
      ) : (
        <>
          <div className="no-phone">
            <TableWrap label="Launch reviews table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Seller</th>
                    <th scope="col">Review</th>
                    <th scope="col">Requested</th>
                    <th scope="col">Assignee</th>
                    <th scope="col">Deadline</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => (
                    <tr key={w.id} className={deadlineTone(w.deadline.state) === 'danger' ? 'is-flagged' : undefined}>
                      <td>{w.sellerId ? <Link className="small strong" to={sellerHref(w.sellerId)}>{w.sellerName ?? 'Seller'}</Link> : <span className="small strong">{w.sellerName ?? '—'}</span>}</td>
                      <td>
                        <span className="stack gap-0">
                          <span className="small">{w.title}</span>
                          {w.summary && <span className="xs muted">{w.summary}</span>}
                        </span>
                      </td>
                      <td>{shortDate(w.openedAt)}</td>
                      <td>{w.assignee?.name ?? <span className="muted">Not assigned</span>}</td>
                      <td>
                        <Deadline tone={deadlineTone(w.deadline.state)}>{deadlineLabel(w.deadline.dueAt)}</Deadline>
                      </td>
                      <td>{decide(w)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
          <div className="only-phone card-pad-phone">
            <div className="aa-mlist">
              {rows.map((w) => (
                <div key={w.id} className="aa-mcard">
                  <span className="small strong">{w.sellerName ?? 'Seller'}</span>
                  <span className="xs muted">{`${w.title} · requested ${shortDate(w.openedAt)}`}</span>
                  <Deadline tone={deadlineTone(w.deadline.state)}>{deadlineLabel(w.deadline.dueAt)}</Deadline>
                  {decide(w)}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {deciding && <LaunchReviewDialog sellerId={deciding.sellerId} storeName={deciding.storeName} onClose={() => setDeciding(null)} onDone={done} />}
    </>
  );
}
