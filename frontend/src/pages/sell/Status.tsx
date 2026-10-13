import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { ApiError, call, errorMessage, useApi, useUploads } from '@marketly/web-shared/api';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Dialog, EmptyState, Field, FileDrop, Icon, IconButton, KeyValue, Select, StatusBadge, Textarea, TextInput, Timeline, type IconName, type TimelineEvent } from '@marketly/web-shared/ui';
import { dateLong, dayDate, dayDateYear, daysUntil, humanize } from '../help/data/format';
import { LoadError, Loading, SkLines } from '../help/data/states';
import { UploadList } from '../help/data/UploadList';
import { APPLICATION_KEY, e164, sections, US_STATES, useApplication, type SellerApplication } from './data/application';
import { contactLine, useSellerProgram } from './data/program';

// Design: pages/store/sell-status.html (Information required) · views "approved", "rejected". The state shown
// follows the application, not the URL view.
// Data: GET /api/store/sellers/applications/current (state, information request, decision, setup summary,
// timeline). Information request: documents upload (purpose verification_document) and attach at once with
// POST …/{id}/documents { mediaId, kind, infoRequestItemId } (DELETE …/documents/{documentId} removes one);
// a return-address item saves with PATCH …/{id} { step: return_address }; "Send for review" →
// POST …/{id}/respond { items: [{ itemId, documentIds?, note? }] }. Rejection appeal →
// POST …/{id}/appeal { argument, evidenceIds }. Seller team contact: GET /api/store/sellers/program.

type App = SellerApplication;
type Item = NonNullable<App['informationRequest']>['items'][number];

const STATE_LABEL: Record<App['state'], string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  information_required: 'Information required',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};
const NEEDED_FOR: Record<string, string> = { account: 'Account', business: 'Business details', verification: 'Verification', payout: 'Payout', return_address: 'Return address', agreement: 'Agreement', category: 'Category approval' };
const PAYOUT_TONE: Record<string, 'success' | 'warning' | 'danger' | ''> = { verified: 'success', verification_pending: 'warning', change_under_review: 'warning', not_added: '', blocked: 'danger' };
const STEP_ICON: Record<string, IconName> = { done: 'circle-check', action_needed: 'circle-alert', pending: 'clock', locked: 'lock', not_started: 'circle' };

function Head({ app, status, title, sub }: { app: App; status: string; title: string; sub: ReactNode }) {
  const legal = sections(app).business?.legalName ?? sections(app).account?.storeName;
  return (
    <div className="stack gap-2">
      <span className="row gap-2">
        <span className="xs muted">
          Application <span className="mono">{app.ref}</span>
          {legal ? ` · ${legal}` : ''}
        </span>
        <StatusBadge status={status} />
      </span>
      <h1 className="h1">{title}</h1>
      <p className="sub">{sub}</p>
    </div>
  );
}

function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <span className="error-text">
      <Icon name="circle-alert" className="ic-sm" />
      {children}
    </span>
  );
}

interface AddressDraft {
  line1: string;
  city: string;
  state: string;
  zip: string;
}

/** One requested item: a document upload (attached as soon as it is processed), a street return address or a written answer. */
function ItemCard({ app, item, n, note, setNote, address, setAddress, errors }: { app: App; item: Item; n: number; note: string; setNote: (v: string) => void; address: AddressDraft; setAddress: (a: AddressDraft) => void; errors: Record<string, string> }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [attachError, setAttachError] = useState('');
  const [removing, setRemoving] = useState('');
  const uploads = useUploads('verification_document', {
    max: 5,
    accept: /\.(pdf|jpe?g|png)$/i,
    onReady: (u) => {
      call(api.POST('/api/store/sellers/applications/{id}/documents', { params: { path: { id: app.id } }, body: { mediaId: u.assetId!, kind: (item.documentKind ?? 'other') as 'other', infoRequestItemId: item.id } })).then(
        () => {
          uploads.remove(u.key);
          void qc.invalidateQueries({ queryKey: APPLICATION_KEY });
        },
        (e) => setAttachError(errorMessage(e)),
      );
    },
  });
  const requestedAt = app.informationRequest?.requestedAt ?? '';
  const sent = app.documents.filter((d) => d.kind === item.documentKind && d.uploadedAt > requestedAt);
  const done = item.status !== 'open';
  const H = n === 1 ? 'h2' : 'h3';
  const remove = async (id: string) => {
    setRemoving(id);
    try {
      await call(api.DELETE('/api/store/sellers/applications/{id}/documents/{documentId}', { params: { path: { id: app.id, documentId: id } } }));
      await qc.invalidateQueries({ queryKey: APPLICATION_KEY });
    } catch (e) {
      setAttachError(errorMessage(e));
    } finally {
      setRemoving('');
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <div className="stack gap-0">
          <H className="h4">
            {n}. {item.title}
          </H>
          <span className="xs muted">Needed for: {NEEDED_FOR[item.neededFor] ?? humanize(item.neededFor)}</span>
        </div>
        {done && <Badge tone="success">{humanize(item.status)}</Badge>}
      </div>
      <div className="card-body">
        <p className="small sub">{item.detail}</p>
        {!done && item.documentKind && (
          <>
            {sent.map((d) => (
              <div key={d.id} className="panel row gap-3">
                <Icon name="file-check" />
                <span className="small grow">{d.fileName}</span>
                <Badge tone="success" icon="check">
                  Uploaded
                </Badge>
                <IconButton icon="x" size="sm" label={`Remove ${d.fileName}`} onClick={() => void remove(d.id)} disabled={removing === d.id} />
              </div>
            ))}
            <UploadList uploads={uploads} icon="file-check" />
            <FileDrop title={`Upload ${item.title.charAt(0).toLowerCase()}${item.title.slice(1)}`} hint="PDF, JPG or PNG up to 10 MB" accept="application/pdf,image/jpeg,image/png" onFiles={uploads.add} />
            <ErrorText>{attachError || errors[item.id]}</ErrorText>
          </>
        )}
        {!done && !item.documentKind && item.neededFor === 'return_address' && (
          <>
            <Field label="Street address" error={errors[`${item.id}.line1`]}>
              <TextInput id={`st-ret1-${item.id}`} value={address.line1} error={!!errors[`${item.id}.line1`]} onChange={(e) => setAddress({ ...address, line1: e.target.value })} />
            </Field>
            <div className="grid md3">
              <Field label="City" error={errors[`${item.id}.city`]}>
                <TextInput id={`st-retc-${item.id}`} value={address.city} error={!!errors[`${item.id}.city`]} onChange={(e) => setAddress({ ...address, city: e.target.value })} />
              </Field>
              <Field label="State" error={errors[`${item.id}.state`]}>
                <Select id={`st-rets-${item.id}`} options={[{ value: '', label: 'Choose a state' }, ...US_STATES.map(([value, label]) => ({ value, label }))]} value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} />
              </Field>
              <Field label="ZIP code" error={errors[`${item.id}.zip`]}>
                <TextInput id={`st-retz-${item.id}`} value={address.zip} inputMode="numeric" error={!!errors[`${item.id}.zip`]} onChange={(e) => setAddress({ ...address, zip: e.target.value })} />
              </Field>
            </div>
          </>
        )}
        {!done && !item.documentKind && item.neededFor !== 'return_address' && (
          <Field label="Your answer" error={errors[item.id]}>
            <Textarea id={`st-note-${item.id}`} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
      </div>
    </section>
  );
}

function InfoRequired({ app }: { app: App }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const req = app.informationRequest!;
  const items = req.items;
  const open = items.filter((i) => i.status === 'open');
  const ret = sections(app).returnAddress;
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [addresses, setAddresses] = useState<Record<string, AddressDraft>>({});
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(false);
  const addressOf = (id: string): AddressDraft => addresses[id] ?? { line1: '', city: '', state: ret?.address?.region ?? '', zip: '' };
  const requestedAt = req.requestedAt;
  const docsFor = (i: Item) => app.documents.filter((d) => d.kind === i.documentKind && d.uploadedAt > requestedAt).map((d) => d.id);

  const errors: Record<string, string> = {};
  if (tried) {
    for (const i of open) {
      if (i.documentKind) {
        if (!docsFor(i).length) errors[i.id] = `Upload the ${i.title.charAt(0).toLowerCase()}${i.title.slice(1)}.`;
      } else if (i.neededFor === 'return_address') {
        const a = addressOf(i.id);
        if (!a.line1.trim()) errors[`${i.id}.line1`] = 'Enter a street address.';
        else if (/\bp\.?\s*o\.?\s*box\b/i.test(a.line1)) errors[`${i.id}.line1`] = "PO boxes can't receive carrier returns. Use a street address.";
        if (!a.city.trim()) errors[`${i.id}.city`] = 'Enter a city.';
        if (!a.state) errors[`${i.id}.state`] = 'Choose a state.';
        if (!/^\d{5}$/.test(a.zip.trim())) errors[`${i.id}.zip`] = 'Enter a 5-digit ZIP code, like 97202.';
      } else if (!(notes[i.id] ?? '').trim()) errors[i.id] = 'Write a short answer.';
    }
  }
  const n = Object.keys(errors).length;

  const saveAddress = async () => {
    const item = open.find((i) => !i.documentKind && i.neededFor === 'return_address');
    if (!item) return;
    const a = addressOf(item.id);
    const contact = ret?.contactName ?? sections(app).account?.contactName ?? '';
    const phone = ret?.phone ?? sections(app).account?.contactPhone ?? '';
    await call(
      api.PATCH('/api/store/sellers/applications/{id}', {
        params: { path: { id: app.id } },
        body: { step: 'return_address', returnAddress: { sameAsBusiness: false, contactName: contact, phone: e164(phone), address: { name: contact, line1: a.line1.trim(), city: a.city.trim(), region: a.state, postalCode: a.zip.trim(), country: 'US' } } },
      }),
    );
  };
  const draft = useMutation({
    mutationFn: async () => {
      const item = open.find((i) => !i.documentKind && i.neededFor === 'return_address');
      if (item && addressOf(item.id).line1.trim()) await saveAddress();
    },
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: APPLICATION_KEY });
    },
  });
  const respond = useMutation({
    mutationFn: async () => {
      await saveAddress();
      return call(
        api.POST('/api/store/sellers/applications/{id}/respond', {
          params: { path: { id: app.id } },
          body: { items: open.map((i) => ({ itemId: i.id, ...(i.documentKind ? { documentIds: docsFor(i) } : {}), ...(notes[i.id]?.trim() ? { note: notes[i.id].trim() } : {}) })) },
        }),
      );
    },
    onSuccess: (next) => qc.setQueryData(APPLICATION_KEY, next),
  });
  const send = () => {
    setTried(true);
    setSaved(false);
    // Recompute with tried = true.
    const bad = open.some((i) => (i.documentKind ? !docsFor(i).length : i.neededFor === 'return_address' ? !/^\d{5}$/.test(addressOf(i.id).zip.trim()) || !addressOf(i.id).line1.trim() || !addressOf(i.id).city.trim() || !addressOf(i.id).state || /\bp\.?\s*o\.?\s*box\b/i.test(addressOf(i.id).line1) : !(notes[i.id] ?? '').trim()));
    if (!bad) respond.mutate();
  };
  const left = daysUntil(req.dueAt);
  const by = req.requestedBy?.name;

  return (
    <>
      <Alert tone={req.deadline?.state === 'on_time' ? 'warning' : 'danger'} title={`Deadline: ${dayDateYear(req.dueAt)}`}>
        {left > 0 ? `${left} day${left === 1 ? '' : 's'} left` : 'Due today'} · Requested on {dayDate(req.requestedAt)}
        {by ? ` by ${by}` : ''}
      </Alert>
      {req.message && <p className="small">{req.message}</p>}
      {n > 0 && (
        <Alert tone="danger" title={`Check ${n} thing${n > 1 ? 's' : ''} before sending`}>
          {Object.values(errors).join(' ')}
        </Alert>
      )}
      {(respond.isError || draft.isError) && (
        <Alert tone="danger" title="We couldn’t send this">
          {respond.error instanceof ApiError && Object.keys(respond.error.fieldErrors).length ? Object.values(respond.error.fieldErrors).join(' ') : errorMessage(respond.error ?? draft.error)}
        </Alert>
      )}
      {saved && n === 0 && (
        <Alert tone="success" title="Draft saved">
          Uploaded documents are kept with your application. Come back any time before {dayDateYear(req.dueAt)} to send it.
        </Alert>
      )}
      {items.map((i, idx) => (
        <ItemCard
          key={i.id}
          app={app}
          item={i}
          n={idx + 1}
          note={notes[i.id] ?? ''}
          setNote={(v) => setNotes((s) => ({ ...s, [i.id]: v }))}
          address={addressOf(i.id)}
          setAddress={(a) => setAddresses((s) => ({ ...s, [i.id]: a }))}
          errors={errors}
        />
      ))}
      <div className="card">
        <div className="card-foot">
          <Button variant="ghost" onClick={() => draft.mutate()} disabled={draft.isPending || respond.isPending}>
            Save draft
          </Button>
          <Button icon="send" onClick={send} disabled={respond.isPending || open.length === 0}>
            {respond.isPending ? 'Sending…' : 'Send for review'}
          </Button>
        </div>
      </div>
    </>
  );
}

export default function Status() {
  const { api } = useApi();
  const qc = useQueryClient();
  const location = useLocation();
  const { signedIn, ready } = useSession();
  const appQ = useApplication();
  const program = useSellerProgram();
  const [appealOpen, setAppealOpen] = useState(false);
  const [appealMsg, setAppealMsg] = useState('');
  const [appealTried, setAppealTried] = useState(false);
  const evidence = useUploads('verification_document', { max: 5, accept: /\.(pdf|jpe?g|png)$/i });
  const appeal = useMutation({
    mutationFn: () => call(api.POST('/api/store/sellers/applications/{id}/appeal', { params: { path: { id: appQ.data!.id } }, body: { argument: appealMsg.trim(), evidenceIds: evidence.assetIds.length ? evidence.assetIds : undefined } })),
    onSuccess: () => {
      setAppealOpen(false);
      void qc.invalidateQueries({ queryKey: APPLICATION_KEY });
    },
  });
  const appealErrors = appealTried ? { doc: evidence.uploading ? 'Wait for the upload to finish.' : evidence.failed ? 'Remove the file that failed to upload.' : undefined, msg: appealMsg.trim() ? undefined : 'Tell us what our check got wrong.' } : {};
  const submitAppeal = () => {
    setAppealTried(true);
    if (!appealMsg.trim() || evidence.uploading || evidence.failed) return;
    appeal.mutate();
  };

  const layout = (main: ReactNode, aside?: ReactNode) => (
    <StoreLayout appbar={{ title: 'Application status', back: href('sell/landing') }} footer={false}>
      <div className="container page">
        {aside ? (
          <div className="split">
            <div className="stack gap-5">{main}</div>
            <aside className="stack gap-4">{aside}</aside>
          </div>
        ) : (
          main
        )}
      </div>
    </StoreLayout>
  );

  if (ready && !signedIn) {
    return layout(
      <EmptyState icon="user-round" title="Sign in to see your application" as="h1" action={<Button to={href('auth/sign-in', '', undefined, { next: location.pathname })}>Sign in</Button>}>
        Your seller application is linked to the Marketly account you applied with.
      </EmptyState>,
    );
  }
  if (appQ.isError) return layout(<LoadError error={appQ.error} retry={() => void appQ.refetch()} title="We couldn’t load your application" />);
  if (!appQ.isSuccess) {
    return layout(
      <>
        <Loading label="Loading your application" />
        <span className="sk sk-line h-30" aria-hidden="true" />
        <SkLines n={6} />
      </>,
    );
  }
  const app = appQ.data;
  if (!app) {
    return layout(
      <EmptyState icon="store" title="You haven’t applied to sell yet" as="h1" action={<Button to={href('sell/apply')}>Start your application</Button>}>
        See what you need on the{' '}
        <a href={href('sell/landing')} className="link-inline">
          Sell on Marketly
        </a>{' '}
        page first.
      </EmptyState>,
    );
  }

  const s = sections(app);
  const p = program.data;
  const contact = contactLine(p?.contact ?? null);
  const d = app.decision;
  const decider = (d?.decidedBy as { name?: string | null } | undefined)?.name;
  const status = app.appealId && app.state === 'rejected' ? 'Appealed' : STATE_LABEL[app.state];
  const cats = (s.business?.categoryIds ?? []).map((id) => p?.launchCategories.find((c) => c.id === id)?.name ?? '').filter(Boolean);

  // Progress: what happened (API timeline), then what comes next.
  const past: TimelineEvent[] = app.timeline.map((e, i) => {
    const last = i === app.timeline.length - 1;
    const warn = last && app.state === 'information_required';
    const danger = last && app.state === 'rejected';
    return { t: e.label, d: dayDate(e.at), body: e.detail ?? undefined, state: danger ? 'danger' : warn ? 'warn' : last && !['approved', 'rejected', 'withdrawn', 'expired'].includes(app.state) ? 'current' : 'done' };
  });
  const future: TimelineEvent[] =
    app.state === 'draft'
      ? [{ t: 'Submitted' }, { t: 'Under review' }, { t: 'Decision' }]
      : app.state === 'submitted'
        ? [{ t: 'Under review', d: app.decisionTargetAt ? `Decision expected by ${dayDate(app.decisionTargetAt)}` : undefined }, { t: 'Decision' }]
        : app.state === 'under_review'
          ? [{ t: 'Decision', d: app.decisionTargetAt ? `Expected by ${dayDate(app.decisionTargetAt)}` : undefined }]
          : app.state === 'information_required'
            ? [{ t: 'Under review', d: 'After you reply' }, { t: 'Decision' }]
            : [];

  const aside = (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h3 className="h4">Application progress</h3>
          </div>
        </div>
        <div className="card-body">
          <Timeline events={[...past, ...future]} />
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h3 className="h4">Your application</h3>
          </div>
        </div>
        <div className="card-body">
          <KeyValue
            pairs={[
              ['Applicant', s.account?.contactName ?? '–'],
              ['Business', s.business?.legalName ?? s.account?.storeName ?? '–'],
              ...(cats.length ? ([['Categories', cats.join(', ')]] as Array<[string, string]>) : []),
              ['Submitted', app.submittedAt ? dayDateYear(app.submittedAt) : 'Not yet'],
            ]}
          />
        </div>
      </section>
      {contact && (
        <div className="card pad stack gap-1">
          <span className="small strong">Questions?</span>
          <span className="xs muted">{contact}</span>
        </div>
      )}
    </>
  );

  let main: ReactNode;
  if (app.state === 'approved') {
    const ss = app.setupSummary;
    const pa = ss?.productApproval;
    const pr = ss?.payoutReadiness;
    main = (
      <>
        <Head app={app} status="Approved" title="You're approved to sell on Marketly" sub={`Approved${decider ? ` by ${decider}` : ''}${d?.decidedAt ? ` on ${dayDate(d.decidedAt)}` : ''}. Finish setting up your store before your offers can go live.`} />
        {ss && (
          <div className="buy-indic">
            <div>
              <span className="xs muted">Account status</span>
              <Badge tone="success">Approved</Badge>
              <span className="small">{ss.accountStatus}</span>
            </div>
            <div>
              <span className="xs muted">Product approval</span>
              <Badge tone={pa && pa.approved > 0 ? 'success' : undefined}>{pa && pa.approved > 0 ? `${pa.approved} approved` : pa && pa.inReview > 0 ? 'In review' : 'Draft'}</Badge>
              <span className="small">
                {pa ? `${pa.inReview} in review, ${pa.drafts} draft${pa.drafts === 1 ? '' : 's'}. Each product or offer is reviewed before it's published.` : "Each product or offer is reviewed before it's published."}
              </span>
            </div>
            <div>
              <span className="xs muted">Payout readiness</span>
              <Badge tone={PAYOUT_TONE[pr?.state ?? ''] || undefined}>{humanize(pr?.state ?? 'not_added')}</Badge>
              <span className="small">{pr?.note}</span>
            </div>
          </div>
        )}
        {d?.conditions && d.conditions.length > 0 && (
          <Alert tone="warning" title="Approved with conditions">
            {d.conditions.map((c) => (c as { title?: string }).title).filter(Boolean).join('. ')}
          </Alert>
        )}
        <Alert tone="info" title="Approval alone doesn't publish anything">
          Customers see your offers only after your store setup is complete and each offer is approved.
        </Alert>
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4">Next: finish setup{ss ? ` (${ss.completed} of ${ss.total} done)` : ''}</h2>
            </div>
          </div>
          <div className="card-body">
            <ul className="stack gap-2 small">
              {(ss?.steps ?? []).map((st) => (
                <li key={st.key} className="row gap-2 nowrap">
                  <Icon name={STEP_ICON[st.state] ?? 'circle'} className="ic-sm" />
                  <span>
                    {st.title}
                    {st.state === 'done' && <span className="sr-only"> (done)</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="card-foot">
            <Button iconRight="arrow-right" to={href('seller/setup')}>
              Finish setup in Seller Center
            </Button>
          </div>
        </section>
      </>
    );
  } else if (app.state === 'rejected') {
    const appealed = Boolean(app.appealId);
    const canAppeal = !appealed && d?.appealDeadline && new Date(d.appealDeadline).getTime() > Date.now();
    main = (
      <>
        <Head app={app} status={status} title="We couldn't approve your application" sub={`Reviewed${decider ? ` by ${decider}` : ''}${d?.decidedAt ? ` on ${dayDate(d.decidedAt)}` : ''}.`} />
        {appealed && (
          <Alert tone="success" title="Appeal sent">
            A different reviewer checks your appeal and replies by email.
          </Alert>
        )}
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4">Reason</h2>
            </div>
          </div>
          <div className="card-body">
            <p className="small">{d?.explanation}</p>
            {d?.ruleRef && <span className="xs muted">Rule: {d.ruleRef}.</span>}
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h3 className="h4">What you can do</h3>
            </div>
          </div>
          <div className="card-body">
            <ul className="stack gap-3 small">
              {d?.appealDeadline && (
                <li className="buy-feature">
                  <Icon name="scale" />
                  <span className="stack gap-0">
                    <span className="strong">Appeal by {dayDate(d.appealDeadline)}</span>
                    <span className="xs muted">If our check was wrong, send the correct documents. A different reviewer looks at it.</span>
                  </span>
                </li>
              )}
              <li className="buy-feature">
                <Icon name="calendar-clock" />
                <span className="stack gap-0">
                  <span className="strong">{d?.notEligibleToReapply ? 'Reapplying isn’t possible' : d?.canReapplyFrom ? `Reapply from ${dayDateYear(d.canReapplyFrom)}` : 'You can reapply'}</span>
                  <span className="xs muted">{d?.notEligibleToReapply ? 'This decision rules out a new application.' : 'Start a new application once the reason above is resolved.'}</span>
                </span>
              </li>
              {contact && (
                <li className="buy-feature">
                  <Icon name="mail" />
                  <span className="stack gap-0">
                    <span className="strong">Ask us a question</span>
                    <span className="xs muted">{contact}</span>
                  </span>
                </li>
              )}
            </ul>
          </div>
          <div className="card-foot">
            {p?.contact?.email && (
              <Button variant="ghost" href={`mailto:${p.contact.email}?subject=${encodeURIComponent(`Application ${app.ref}`)}`}>
                Contact the seller team
              </Button>
            )}
            <Button variant="secondary" icon="scale" onClick={() => setAppealOpen(true)} disabled={!canAppeal}>
              {appealed ? 'Appeal sent' : 'Appeal this decision'}
            </Button>
          </div>
        </section>
        <p className="xs muted">Your uploaded documents are kept for the appeal period and then deleted.</p>
      </>
    );
  } else if (app.state === 'information_required' && app.informationRequest) {
    const nOpen = app.informationRequest.items.filter((i) => i.status === 'open').length;
    main = (
      <>
        <Head
          app={app}
          status="Information required"
          title={`We need ${nOpen === 1 ? '1 more thing' : `${nOpen} more things`} to review your application`}
          sub={`Your application is on hold until we get ${nOpen === 1 ? 'it' : 'these'}. Send ${nOpen === 1 ? 'it' : 'them'} by ${dayDateYear(app.informationRequest.dueAt)}, or the application closes and you'll need to start again.`}
        />
        <InfoRequired app={app} />
      </>
    );
  } else if (app.state === 'submitted' || app.state === 'under_review') {
    main = (
      <>
        <Head
          app={app}
          status={STATE_LABEL[app.state]}
          title={app.informationRequest?.respondedAt ? 'Thanks, your application is back in review' : 'Your application is in review'}
          sub={`A Seller Manager reviews your application${app.decisionTargetAt ? `, usually by ${dayDate(app.decisionTargetAt)}` : ''}.`}
        />
        <Alert tone="success" title={app.informationRequest?.respondedAt ? 'Sent for review' : 'Application submitted'}>
          We email you at {s.account?.workEmail ?? 'your work email'} when there's a decision or if we need anything else.
        </Alert>
      </>
    );
  } else if (app.state === 'draft') {
    main = (
      <>
        <Head app={app} status="Draft" title="Your application isn't submitted yet" sub={`${app.percentComplete}% complete. Your draft was saved ${dateLong(app.draftSavedAt)}.`} />
        <div>
          <Button iconRight="arrow-right" to={href('sell/apply')}>
            Continue your application
          </Button>
        </div>
      </>
    );
  } else {
    main = (
      <>
        <Head app={app} status={STATE_LABEL[app.state]} title={app.state === 'expired' ? 'Your application closed' : 'You withdrew your application'} sub={app.state === 'expired' ? 'The requested information didn’t arrive before the deadline.' : 'You can start a new application at any time.'} />
        <div>
          <Button to={href('sell/apply')}>Start a new application</Button>
        </div>
      </>
    );
  }

  return (
    <>
      {layout(main, aside)}
      <Dialog
        open={appealOpen}
        onClose={() => setAppealOpen(false)}
        title="Appeal this decision"
        foot={
          <>
            <Button variant="ghost" onClick={() => setAppealOpen(false)}>
              Cancel
            </Button>
            <Button icon="scale" onClick={submitAppeal} disabled={appeal.isPending}>
              {appeal.isPending ? 'Sending…' : 'Send appeal'}
            </Button>
          </>
        }
      >
        <p className="small sub">A different reviewer checks the case.{d?.appealDeadline ? ` You can appeal until ${dayDate(d.appealDeadline)}.` : ''}</p>
        <div className="field">
          <span className="label">
            Supporting documents <span className="opt">(optional)</span>
          </span>
          <UploadList uploads={evidence} icon="file-check" />
          <FileDrop title="Upload documents" hint="PDF, JPG or PNG up to 10 MB" accept="application/pdf,image/jpeg,image/png" onFiles={evidence.add} />
          <ErrorText>{appealErrors.doc}</ErrorText>
        </div>
        <Field label="What did our check get wrong?" error={appealErrors.msg ?? (appeal.isError ? errorMessage(appeal.error) : undefined)}>
          <Textarea id="st-appeal" value={appealMsg} maxLength={5000} onChange={(e) => setAppealMsg(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}
