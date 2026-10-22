import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { Alert, announce, Badge, Button, EmptyState, Field, Icon, PageHeader, sameOriginFile, Textarea } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { actorLabel, date, dateTime, LoadError, shortDate, SkeletonLines } from '@/app/parts';
import { codeOf } from './data/departments';
import { ADS_KEY, ADS_LIST, adHref, doneSteps, kindChip, slotOf, STEP_LABEL, stepLine, type AdDestination, type AdImage, type StaffAd, type StaffAdChange } from './data/staff-ads';

// Admin › Advertisements › Review a change (designed from the Marketly canvas: AdminAdReview). A scheduled, live or
// paused ad's pending change side by side with the live version: Live now | After the change, "Changed" on the fields
// the change touches (changedFields). The reviewer approves, asks for changes (note) or rejects (note):
// POST /api/admin/advertising/ads/{id}/review. The last approval switches the live ad over; a rejection keeps it.

export default function AdReview() {
  const { id = '' } = useParams();
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('advertising.campaigns.view') || can('advertising.campaigns.manage') || can('advertising.campaigns.review');
  const ad = useQuery({ queryKey: ['advertising', 'staff-ad', id], enabled: canView && !!id, queryFn: () => call(api.GET('/api/admin/advertising/ads/{id}', { params: { path: { id } } })) });
  const crumbs = [{ label: 'Admin' }, { label: 'Advertisements', to: ADS_LIST }];
  return (
    <AdminLayout active="ads">
      {!canView ? (
        <>
          <PageHeader crumbs={crumbs} title="Review a change" />
          <Alert tone="info" title="You don’t have access to Advertisements">
            Seeing ads needs an advertising permission (view, manage or review ads). A Platform Administrator can change your roles in Staff and roles.
          </Alert>
        </>
      ) : ad.data ? (
        ad.data.pendingChange ? (
          <ChangeReview ad={ad.data} change={ad.data.pendingChange} routeId={id} />
        ) : (
          <>
            <PageHeader crumbs={crumbs} title={`Review a change: ${ad.data.name}`} />
            <section className="card">
              <div className="card-body">
                <EmptyState icon="circle-check" title="No change is waiting for review" as="h2" action={<Button to={adHref(ad.data.id)}>Open the ad</Button>}>
                  The change may have been approved, rejected or withdrawn already.
                </EmptyState>
              </div>
            </section>
          </>
        )
      ) : ad.isError ? (
        <>
          <PageHeader crumbs={crumbs} title="Review a change" />
          {codeOf(ad.error) === 'NOT_FOUND' ? (
            <section className="card">
              <div className="card-body">
                <EmptyState icon="megaphone" title="This ad doesn’t exist" as="h2" action={<Button to={ADS_LIST}>Back to Advertisements</Button>}>
                  It may have been deleted.
                </EmptyState>
              </div>
            </section>
          ) : (
            <LoadError error={ad.error} onRetry={() => void ad.refetch()} />
          )}
        </>
      ) : (
        <>
          <PageHeader crumbs={crumbs} title="Review a change" />
          <SkeletonLines rows={8} />
        </>
      )}
    </AdminLayout>
  );
}

const cell = { padding: '12px 16px', borderTop: '1px solid var(--border)' } as const;
const opens = (d?: AdDestination | null) => (d ? `${kindChip(d)} · ${d.label}` : '—');
const dealText = (name?: string | null, stop?: boolean | null) => (name ? `${name}${stop ? ' · stops when it ends' : ''}` : '—');

function ChangeReview({ ad, change: pc, routeId }: { ad: StaffAd; change: StaffAdChange; routeId: string }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useStaffSession();
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const slot = slotOf(ad.placementKey);
  const has = (f: string) => pc.changedFields.includes(f);
  const reviewable = can('advertising.campaigns.review') && ad.allowedActions.includes('review') && pc.review.canReview && pc.state === 'in_review';
  const next = pc.review.steps.find((s) => s.state === 'waiting');
  const taken = pc.review.steps.filter((s) => s.state !== 'waiting');
  const author = actorLabel(pc.createdBy);
  const first = author.split(' ')[0] || 'the author';

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'request_changes' | 'reject') => call(api.POST('/api/admin/advertising/ads/{id}/review', { params: { path: { id: ad.id } }, body: { decision, note: note.trim() || null } })),
    onSuccess: (saved, decision) => {
      qc.setQueryData(['advertising', 'staff-ad', saved.id], saved);
      qc.setQueryData(['advertising', 'staff-ad', routeId], saved);
      void qc.invalidateQueries({ queryKey: ADS_KEY });
      const msg =
        decision === 'approve'
          ? saved.pendingChange
            ? `${ad.name}: change approved, waiting for the other review.`
            : `${ad.name}: change approved. The live ad shows the new version now.`
          : decision === 'reject'
            ? `${ad.name}: change rejected. The live version keeps running.`
            : `${ad.name}: changes asked. ${first} gets your note.`;
      announce(msg);
      navigate(ADS_LIST, { state: { notice: msg } });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const withNote = (decision: 'request_changes' | 'reject') => {
    if (note.trim()) return decide.mutate(decision);
    setError(decision === 'reject' ? 'Write a note saying why you reject the change.' : 'Write a note saying what should change.');
    document.getElementById('rv-note')?.focus();
  };

  const since = ad.status === 'live' ? `live since ${shortDate(ad.startsAt ?? ad.createdAt)}` : ad.status === 'scheduled' ? `scheduled for ${ad.startsAt ? shortDate(ad.startsAt) : 'approval'}` : ad.status;
  const image = (img: AdImage | null | undefined, ratio: string) =>
    img?.url ? (
      <div style={{ width: 300, maxWidth: '100%', aspectRatio: ratio, borderRadius: 12, overflow: 'hidden', background: 'var(--surface-2)' }}>
        <img src={sameOriginFile(img.url)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </div>
    ) : (
      <span className="small muted">—</span>
    );
  const ratio = slot ? `${slot.phone.width} / ${slot.phone.height}` : '16 / 9';
  const webRatio = slot?.web ? `${slot.web.width} / ${slot.web.height}` : '16 / 9';
  type Row = { key: string; label: string; live: ReactNode; after: ReactNode; changed: boolean; block?: boolean };
  const rows: Row[] = [
    { key: 'image', label: 'Image', live: image(ad.image, ratio), after: image(has('image') ? pc.image : ad.image, ratio), changed: has('image'), block: true },
    ...(slot?.web && (ad.webImage || pc.webImage) ? [{ key: 'webImage', label: 'Website image', live: image(ad.webImage, webRatio), after: image(has('webImage') ? pc.webImage : ad.webImage, webRatio), changed: has('webImage'), block: true }] : []),
    { key: 'alt', label: 'Describe the image', live: ad.alt || '—', after: (has('alt') ? pc.alt : ad.alt) || '—', changed: has('alt') },
    ...(has('name') ? [{ key: 'name', label: 'Ad name', live: ad.name, after: pc.name || '—', changed: true }] : []),
    { key: 'destination', label: 'Opens', live: opens(ad.destination), after: opens(has('destination') ? pc.destination : ad.destination), changed: has('destination') },
    ...(has('startsAt') ? [{ key: 'startsAt', label: 'Starts', live: ad.startsAt ? date(ad.startsAt) : 'As soon as approved', after: pc.startsAt ? date(pc.startsAt) : 'As soon as approved', changed: true }] : []),
    { key: 'endsAt', label: 'Ends', live: ad.endsAt ? date(ad.endsAt) : '—', after: ad.endsAt ? date(ad.endsAt) : '—', changed: false },
    { key: 'deal', label: 'Deal', live: dealText(ad.dealName, ad.stopWithDeal), after: has('deal') ? dealText(pc.dealName, pc.stopWithDeal) : dealText(ad.dealName, ad.stopWithDeal), changed: has('deal') },
  ];

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Admin' }, { label: 'Advertisements', to: ADS_LIST }]}
        title={`Review a change: ${ad.name}`}
        sub={`${ad.placementName} · ${since} · change by ${author}, ${dateTime(pc.createdAt)} · the current version keeps running until this is approved`}
        actions={<Badge tone={pc.state === 'in_review' ? 'warning' : ''}>{pc.state !== 'in_review' ? (pc.state === 'changes_requested' ? 'Changes asked' : 'Not submitted yet') : next ? `${STEP_LABEL[next.step]} · ${doneSteps(pc.review)} of 2 done` : 'Reviewed'}</Badge>}
      />
      {error && <Alert tone="danger" title={error} />}

      <section className="card" style={{ overflow: 'hidden' }}>
        <div role="table" aria-label="Live now and after the change" style={{ display: 'grid', gridTemplateColumns: '160px minmax(0, 1fr) minmax(0, 1fr)' }}>
          <div role="row" style={{ display: 'contents' }}>
            <span role="columnheader" style={{ padding: '12px 16px', background: 'var(--surface-2)' }}>
              <span className="sr-only">Field</span>
            </span>
            <span role="columnheader" className="small strong" style={{ padding: '12px 16px', background: 'var(--surface-2)' }}>
              Live now
            </span>
            <span role="columnheader" className="small strong" style={{ padding: '12px 16px', background: 'var(--surface-2)', color: 'var(--brand-text)' }}>
              After the change
            </span>
          </div>
          {rows.map((r) => (
            <div role="row" key={r.key} style={{ display: 'contents' }}>
              <span role="rowheader" className="small muted" style={{ ...cell, padding: r.block ? 16 : cell.padding }}>
                {r.label}
              </span>
              <span role="cell" className="small" style={{ ...cell, padding: r.block ? 16 : cell.padding }}>
                {r.live}
              </span>
              <span role="cell" className="small" style={{ ...cell, padding: r.block ? 16 : cell.padding, background: r.changed ? 'var(--brand-soft)' : undefined }}>
                {r.after}
                {r.changed ? (
                  <>
                    {r.block ? <br /> : ' '}
                    <span style={{ display: 'inline-flex', marginTop: r.block ? 8 : 0 }}>
                      <Badge tone="brand">Changed</Badge>
                    </span>
                  </>
                ) : (
                  !r.block && <span className="xs muted"> (same)</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="h4">Your review</h2>
          {taken.length > 0 && <span className="xs muted">{taken.map(stepLine).join(' · ')}</span>}
        </div>
        <div className="card-body" style={{ gap: 12 }}>
          {taken.some((s) => s.note) && (
            <ul className="list">
              {taken
                .filter((s) => s.note)
                .map((s) => (
                  <li key={s.step}>
                    <Icon name="message-square" className="ic-sm" />
                    <span className="small grow">
                      {STEP_LABEL[s.step]}: “{s.note}”
                    </span>
                  </li>
                ))}
            </ul>
          )}
          {reviewable ? (
            <>
              <Field label={<>Note to {first} <span className="opt">(needed to ask for changes)</span></>}>
                <Textarea id="rv-note" rows={2} style={{ minHeight: 72 }} placeholder="What should change" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <div className="row gap-2">
                <Button size="sm" onClick={() => decide.mutate('approve')} disabled={decide.isPending}>
                  Approve change
                </Button>
                <Button variant="secondary" size="sm" onClick={() => withNote('request_changes')} disabled={decide.isPending}>
                  Ask for changes
                </Button>
                <Button variant="ghost" size="sm" className="t-danger-text" onClick={() => withNote('reject')} disabled={decide.isPending}>
                  Reject change
                </Button>
              </div>
              <span className="xs muted">Approving the last review switches the live ad to the new version. Rejecting keeps the live version as it is.</span>
            </>
          ) : (
            <span className="small" style={{ color: 'var(--text-2)' }}>
              {pc.state !== 'in_review'
                ? 'This change isn’t waiting for review: its author still has to submit it.'
                : !can('advertising.campaigns.review')
                  ? 'Reviewing ads needs the review ads permission.'
                  : 'You can’t take a review step on this change: you made it, or you already took the other step.'}{' '}
              <Button variant="link" size="sm" to={adHref(ad.id)}>
                Open the ad
              </Button>
            </span>
          )}
        </div>
      </section>
    </>
  );
}
