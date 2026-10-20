import { LoadError as SharedLoadError } from '@marketly/web-shared/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { AccountLayout } from '@/layouts';
import { ApiError, call, errorMessage, mediaFileName, useApi, useUploads, type components } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { Alert, Badge, Button, Dialog, EmptyState, Field, FileDrop, Icon, StatusBadge, Tabs, Textarea, announce, type IconName, type Tone } from '@marketly/web-shared/ui';
import { UploadList } from '../help/data/UploadList';
import { date, dateLong, dateTime } from './data/when';

// Reports and appeals (no design: built from Account › Reviews and feedback, same rows and dialogs).
//   view ""         = reports I made to Trust and Risk: status, outcome, "Add photos or details" while open
//                     GET /api/store/trust/reports (cursor, Show more), GET …/reports/{id}, POST …/reports/{id}/evidence
//   view "requests" = information Trust and Risk asked me for, answered before the deadline (text + files)
//                     GET /api/store/trust/evidence-requests, POST …/evidence-requests/{id}/answer
//   view "actions"  = Trust and Risk actions on my account, with Appeal, and my appeals
//                     GET /api/store/trust/enforcements, GET/POST /api/store/trust/appeals
// Deep links (notifications and emails): ?report=<id> (report result), ?request=<id> (the "Send what we
// asked for" notice, view requests: opens the answer form while it can still be answered),
// ?appeal=<id> (appeal result, view actions). The linked item is highlighted and scrolled to.
// Files upload as case_evidence (a media purpose trust evidence accepts), up to 5 per answer.

type View = 'requests' | 'actions';
type MyReport = components['schemas']['trust.MyReport'];
type EvidenceRequest = components['schemas']['trust.EvidenceRequest'];
type MyEnforcement = components['schemas']['trust.MyEnforcement'];
type TrustAppeal = components['schemas']['trust.TrustAppeal'];
type MediaRef = components['schemas']['MediaRef'];

const REPORT_STATUS: Record<MyReport['statusLabel'], { label: string; tone?: Tone }> = {
  received: { label: 'Received', tone: 'info' },
  under_review: { label: 'Under review', tone: 'info' },
  decision_made: { label: 'Decision made' },
  action_taken: { label: 'Action taken', tone: 'success' },
  no_violation: { label: 'No violation found' },
};
/** A report the reporter can still add to (a closed report answers 409: send a new report instead). */
const reportOpen = (r: MyReport) => r.statusLabel === 'received' || r.statusLabel === 'under_review';

const REQUEST_STATE: Record<EvidenceRequest['state'], { label: string; tone?: Tone }> = {
  open: { label: 'Waiting for you', tone: 'warning' },
  answered: { label: 'Answered', tone: 'success' },
  expired: { label: 'Deadline passed', tone: 'danger' },
  cancelled: { label: 'No longer needed' },
};
/** Open and before its deadline (the API refuses later answers). */
const answerable = (r: EvidenceRequest) => r.state === 'open' && Date.parse(r.dueAt) > Date.now();

const APPEAL_STATE: Record<TrustAppeal['state'], { label: string; tone?: Tone }> = {
  open: { label: 'Appeal sent', tone: 'info' },
  under_review: { label: 'Appeal under review', tone: 'info' },
  upheld: { label: 'Decision kept' },
  overturned: { label: 'Decision overturned', tone: 'success' },
  partly_overturned: { label: 'Partly overturned', tone: 'success' },
  withdrawn: { label: 'Withdrawn' },
};
/** Appealable, not appealed yet and before the deadline. */
const canAppeal = (e: MyEnforcement) => e.appealable && !e.appealId && (!e.appealDeadline || Date.parse(e.appealDeadline) > Date.now());

const APPEAL_ERRORS: Record<string, string> = {
  APPEAL_WINDOW_CLOSED: 'The deadline to appeal this action has passed.',
  APPEAL_ALREADY_OPEN: 'You’ve already appealed this action. We’ll tell you the result.',
  NOT_APPEALABLE: 'This action can’t be appealed.',
};

const LIMIT = 20;

function ListError({ error, retry, what }: { error: unknown; retry: () => void; what: string }) {
  return <SharedLoadError error={error} onRetry={retry} title={`We couldn’t load ${what}`} />;
}

const cardSkeleton = (
  <div className="card pad stack gap-2" aria-hidden="true">
    <span className="sk sk-line short" />
    <span className="sk sk-line" />
    <span className="sk sk-line" />
  </div>
);

/** Files sent with an answer or an appeal. */
function Files({ media }: { media: MediaRef[] }) {
  if (!media.length) return null;
  return (
    <span className="row gap-3 xs">
      {media.map((m) => (
        <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="row gap-1">
          <Icon name="paperclip" className="ic-sm" />
          {mediaFileName(m)}
        </a>
      ))}
    </span>
  );
}

/** Scrolls the deep-linked row into view once it is on the page. */
function useScrollTo(id: string | null, ready: boolean) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !ready || done.current === id) return;
    done.current = id;
    document.getElementById(`tr-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [id, ready]);
}

export default function Reports() {
  const { api } = useApi();
  const [rawView, setView] = useView<View>();
  const view: View | '' = rawView === 'requests' || rawView === 'actions' ? rawView : '';
  const [params] = useSearchParams();
  const linkedReport = params.get('report');
  const linkedRequest = params.get('request');
  const linkedAppeal = params.get('appeal');
  const [notice, setNotice] = useState('');

  const reports = useInfiniteQuery({
    queryKey: ['trust', 'reports', 'mine', { limit: LIMIT }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => call(api.GET('/api/store/trust/reports', { params: { query: { limit: LIMIT, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    getNextPageParam: (last) => last.nextCursor,
  });
  const reportRows = reports.data?.pages.flatMap((p) => p.items) ?? [];
  // A report named by a notification that isn't in the first batch.
  const linked = useQuery({
    queryKey: ['trust', 'reports', 'one', linkedReport],
    queryFn: () => call(api.GET('/api/store/trust/reports/{id}', { params: { path: { id: linkedReport! } } })),
    enabled: !!linkedReport && reports.isSuccess && !reportRows.some((r) => r.id === linkedReport),
  });
  const requests = useQuery({ queryKey: ['trust', 'evidence-requests'], queryFn: () => call(api.GET('/api/store/trust/evidence-requests')) });
  const enforcements = useQuery({ queryKey: ['trust', 'enforcements'], queryFn: () => call(api.GET('/api/store/trust/enforcements')) });
  const appeals = useQuery({ queryKey: ['trust', 'appeals'], queryFn: () => call(api.GET('/api/store/trust/appeals')) });

  const [addTo, setAddTo] = useState<MyReport | null>(null);
  const [answer, setAnswer] = useState<EvidenceRequest | null>(null);
  const [appeal, setAppeal] = useState<MyEnforcement | null>(null);

  // ?request=<id> from the "Send what we asked for" notice: open the answer form once.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !linkedRequest || !requests.data) return;
    autoOpened.current = true;
    const r = requests.data.find((x) => x.id === linkedRequest);
    if (r && answerable(r)) setAnswer(r);
  }, [linkedRequest, requests.data]);

  useScrollTo(linkedReport, view === '' && (reportRows.length > 0 || linked.isSuccess));
  useScrollTo(linkedRequest, view === 'requests' && requests.isSuccess);
  useScrollTo(linkedAppeal, view === 'actions' && appeals.isSuccess);

  const allReports = linked.data && !reportRows.some((r) => r.id === linked.data.id) ? [linked.data, ...reportRows] : reportRows;
  const waiting = (requests.data ?? []).filter(answerable).length;
  const appealsById = new Map((appeals.data ?? []).map((a) => [a.id, a]));

  const switchTab = (v: View | '') => {
    setNotice('');
    setView(v);
  };

  return (
    <AccountLayout active="reports" title="Reports and appeals">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Reports and appeals</h1>
          <p className="small sub">Listings, sellers and messages you reported to Marketly’s Trust and Risk team, what they asked you for, and any action on your account.</p>
        </div>
      </div>
      <Tabs<View | ''>
        active={view}
        onChange={switchTab}
        items={[
          { value: '', label: 'Your reports', count: reports.data ? (reports.data.pages[0]?.total ?? reportRows.length) : undefined },
          { value: 'requests', label: 'Requests for information', count: waiting || undefined },
          { value: 'actions', label: 'Actions and appeals', count: enforcements.data?.length || undefined },
        ]}
      />
      <div className="stack gap-4">
        {notice && <Alert tone="success" title={notice} />}

        {view === '' && (
          <>
            <p className="small sub">The sellers and people you report never see your name. Reports on reviews and answers are under Reviews and feedback.</p>
            {reports.isError && <ListError error={reports.error} retry={() => void reports.refetch()} what="your reports" />}
            {reports.isPending && cardSkeleton}
            {reports.isSuccess && !allReports.length && (
              <div className="card">
                <EmptyState icon="shield-check" as="h2" title="You haven’t reported anything">
                  To report a listing, a seller or a message, use Report on the product page, the offers list, the seller’s store or the message.
                </EmptyState>
              </div>
            )}
            {allReports.length > 0 && (
              <section className="card">
                {allReports.map((r) => (
                  <ReportRow key={r.id} r={r} active={r.id === linkedReport} onAdd={() => setAddTo(r)} />
                ))}
              </section>
            )}
            {reports.hasNextPage && (
              <Button variant="ghost" size="sm" onClick={() => void reports.fetchNextPage()} disabled={reports.isFetchingNextPage}>
                {reports.isFetchingNextPage ? 'Loading…' : 'Show more reports'}
              </Button>
            )}
          </>
        )}

        {view === 'requests' && (
          <>
            <p className="small sub">When Trust and Risk needs proof or an explanation from you, for example about an order or a message, it shows here with a deadline. Answer before the deadline so we can take it into account.</p>
            {requests.isError && <ListError error={requests.error} retry={() => void requests.refetch()} what="requests for information" />}
            {requests.isPending && cardSkeleton}
            {requests.isSuccess && !requests.data.length && (
              <div className="card">
                <EmptyState icon="file-question-mark" as="h2" title="Nothing to answer">
                  We’ll send you a notification and an email if we need information from you.
                </EmptyState>
              </div>
            )}
            {requests.data && requests.data.length > 0 && (
              <section className="card">
                {requests.data.map((r) => (
                  <RequestRow key={r.id} r={r} active={r.id === linkedRequest} onAnswer={() => setAnswer(r)} />
                ))}
              </section>
            )}
          </>
        )}

        {view === 'actions' && (
          <>
            <p className="small sub">Actions Marketly took on your account after a Trust and Risk review, why, and what still works. You can appeal most actions before the deadline; someone who didn’t make the decision reviews it.</p>
            {enforcements.isError && <ListError error={enforcements.error} retry={() => void enforcements.refetch()} what="actions on your account" />}
            {appeals.isError && <ListError error={appeals.error} retry={() => void appeals.refetch()} what="your appeals" />}
            {(enforcements.isPending || appeals.isPending) && cardSkeleton}
            {enforcements.isSuccess && !enforcements.data.length && (
              <div className="card">
                <EmptyState icon="shield-check" as="h2" title="No actions on your account">
                  Your account is in good standing.
                </EmptyState>
              </div>
            )}
            {enforcements.data && enforcements.data.length > 0 && (
              <section className="card">
                {enforcements.data.map((e) => (
                  <ActionRow key={e.id} e={e} appeal={e.appealId ? appealsById.get(e.appealId) : undefined} onAppeal={() => setAppeal(e)} />
                ))}
              </section>
            )}
            {appeals.data && appeals.data.length > 0 && (
              <>
                <h2 className="h3">Your appeals</h2>
                <section className="card">
                  {appeals.data.map((a) => (
                    <AppealRow key={a.id} a={a} active={a.id === linkedAppeal} />
                  ))}
                </section>
              </>
            )}
          </>
        )}
      </div>

      <AddDetailsDialog report={addTo} onClose={() => setAddTo(null)} onDone={(r) => setNotice(`Your details were added to report ${r.ref}.`)} />
      <AnswerDialog request={answer} onClose={() => setAnswer(null)} onDone={() => setNotice('Thanks, we’ve received your answer. Trust and Risk will take it into account.')} />
      <AppealDialog enforcement={appeal} onClose={() => setAppeal(null)} onDone={(a) => setNotice(`Appeal ${a.ref} sent. We’ll tell you the result by ${dateLong(a.decideBy.dueAt)}.`)} />
    </AccountLayout>
  );
}

/* ---------------- Rows ---------------- */

function Row({ id, icon, tone, active, children }: { id: string; icon: IconName; tone?: 'info' | 'warning'; active?: boolean; children: ReactNode }) {
  return (
    <div id={`tr-${id}`} className={cx('acct-row', active && 'acct-active')}>
      <span className={cx('acct-ic', tone && `t-${tone}`)}>
        <Icon name={icon} className="ic-sm" />
      </span>
      <span className="stack gap-1 grow min-w-0">{children}</span>
    </div>
  );
}

function ReportRow({ r, active, onAdd }: { r: MyReport; active: boolean; onAdd: () => void }) {
  const s = REPORT_STATUS[r.statusLabel] ?? { label: r.statusLabel };
  return (
    <Row id={r.id} icon="shield-alert" tone="info" active={active}>
      <span className="row between gap-2 top">
        <span className="small strong">{r.what}</span>
        <StatusBadge status={s.label} tone={s.tone} />
      </span>
      <span className="xs sub">{r.about}</span>
      <span className="xs muted">
        You said: {r.youSaid} · reported {date(r.reportedAt)} · <span className="mono">{r.ref}</span>
      </span>
      <span className="xs">
        <span className="strong">Outcome:</span>{' '}
        <span className="sub">
          {r.outcome ?? `Our Trust and Risk team is checking it.${r.expectedBy ? ` Expected by ${dateLong(`${r.expectedBy}T12:00:00Z`)}.` : ''}`}
          {r.caseRef && (
            <>
              {' '}
              Case <span className="mono">{r.caseRef}</span>.
            </>
          )}
        </span>
      </span>
      {reportOpen(r) && (
        <span>
          <Button variant="ghost" size="sm" icon="image-plus" onClick={onAdd}>
            Add photos or details
          </Button>
        </span>
      )}
    </Row>
  );
}

function RequestRow({ r, active, onAnswer }: { r: EvidenceRequest; active: boolean; onAnswer: () => void }) {
  const late = r.state === 'open' && !answerable(r);
  const s = late ? REQUEST_STATE.expired : (REQUEST_STATE[r.state] ?? { label: r.state });
  return (
    <Row id={r.id} icon="file-question-mark" tone={answerable(r) ? 'warning' : undefined} active={active}>
      <span className="row between gap-2 top">
        <span className="small strong">
          {r.reportRef ? (
            <>
              About <span className="mono">{r.reportRef}</span>
            </>
          ) : (
            'Information we need'
          )}
          {r.to.label ? ` · ${r.to.label}` : ''}
        </span>
        <StatusBadge status={s.label} tone={s.tone} />
      </span>
      <span className="small">{r.question}</span>
      {r.state === 'open' && !late ? (
        <span className={cx('row gap-2 xs', r.deadline.state === 'on_time' ? 'muted' : 'strong')}>
          <Icon name="clock" className="ic-sm" /> Answer by {dateTime(r.dueAt)}
          {r.deadline.state === 'due_soon' && <Badge tone="warning">Due soon</Badge>}
        </span>
      ) : r.state === 'answered' ? (
        <>
          <span className="xs">
            <span className="strong">You answered{r.answeredAt ? ` ${date(r.answeredAt)}` : ''}:</span> <span className="sub">{r.answer}</span>
          </span>
          <Files media={r.answerMedia} />
        </>
      ) : (
        <span className="xs muted">{late || r.state === 'expired' ? `The deadline was ${dateTime(r.dueAt)}.` : 'Trust and Risk cancelled this request. You don’t need to do anything.'}</span>
      )}
      {answerable(r) && (
        <span>
          <Button size="sm" icon="send" onClick={onAnswer}>
            Answer
          </Button>
        </span>
      )}
    </Row>
  );
}

function ActionRow({ e, appeal, onAppeal }: { e: MyEnforcement; appeal?: TrustAppeal; onAppeal: () => void }) {
  const a = appeal ? APPEAL_STATE[appeal.state] : null;
  return (
    <Row id={e.id} icon="gavel" tone="warning">
      <span className="row between gap-2 top">
        <span className="small strong">{e.title}</span>
        {a ? <StatusBadge status={a.label} tone={a.tone} /> : <span className="xs muted mono">{e.ref}</span>}
      </span>
      <span className="xs sub">{e.reason}</span>
      {e.targets.length > 0 && <span className="xs muted">Applies to: {e.targets.map((t) => t.label).join(', ')}</span>}
      {e.effects.length > 0 && (
        <ul className="xs sub stack gap-0">
          {e.effects.map((x) => (
            <li key={x}>· {x}</li>
          ))}
        </ul>
      )}
      <span className="xs muted">
        Recorded {date(e.recordedAt)}
        {canAppeal(e) && e.appealDeadline ? ` · appeal by ${dateTime(e.appealDeadline)}` : ''}
        {!e.appealable ? ' · this action can’t be appealed' : ''}
      </span>
      {/* Where to appeal when it isn't here (e.g. the deadline passed); the API explains it. */}
      {e.appealable && !e.appealId && !canAppeal(e) && e.appealRoute && <span className="xs muted">{e.appealRoute}</span>}
      {canAppeal(e) && (
        <span>
          <Button variant="secondary" size="sm" icon="scale" onClick={onAppeal}>
            Appeal
          </Button>
        </span>
      )}
    </Row>
  );
}

function AppealRow({ a, active }: { a: TrustAppeal; active: boolean }) {
  const s = APPEAL_STATE[a.state] ?? { label: a.state };
  // decision is { outcome, explanation, decidedBy, decidedAt, changes } (typed json in the API)
  const decision = (a.decision ?? null) as { explanation?: string; decidedAt?: string } | null;
  const waiting = a.state === 'open' || a.state === 'under_review';
  return (
    <Row id={a.id} icon="scale" active={active}>
      <span className="row between gap-2 top">
        <span className="small strong">
          Appeal <span className="mono">{a.ref}</span> · {a.decisionAppealed}
        </span>
        <StatusBadge status={s.label} tone={s.tone} />
      </span>
      <span className="xs muted">
        You wrote: {a.argument} · sent {date(a.filedAt)}
      </span>
      <Files media={a.evidence} />
      <span className="xs">
        <span className="strong">Result:</span>{' '}
        <span className="sub">
          {waiting ? `Someone who didn’t make the original decision is reviewing it. Expected by ${dateLong(a.decideBy.dueAt)}.` : (decision?.explanation ?? s.label)}
          {!waiting && decision?.decidedAt ? ` (${date(decision.decidedAt)})` : ''}
        </span>
      </span>
    </Row>
  );
}

/* ---------------- Dialogs: text + files ---------------- */

interface TextFilesProps {
  open: boolean;
  onClose: () => void;
  title: string;
  intro: ReactNode;
  label: string;
  hint: string;
  submitLabel: string;
  minLength?: number;
  pending: boolean;
  error: string;
  onSubmit: (text: string, mediaIds: string[]) => void;
}

/** The shared form of the three dialogs: a text and up to 5 photos or PDFs. */
function TextFilesDialog({ open, onClose, title, intro, label, hint, submitLabel, minLength = 1, pending, error, onSubmit }: TextFilesProps) {
  const [text, setText] = useState('');
  const [local, setLocal] = useState('');
  const files = useUploads('case_evidence', { max: 5, accept: /\.(jpe?g|png|pdf)$|^image\/(jpeg|png)$|^application\/pdf$/i });
  useEffect(() => {
    if (!open) return;
    setText('');
    setLocal('');
    files.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () => {
    if (text.trim().length < minLength) return setLocal(minLength > 1 ? `Write at least ${minLength} characters.` : 'Write your answer.');
    if (files.uploading) return setLocal('Wait for the files to finish uploading.');
    if (files.failed) return setLocal('Remove the files that couldn’t be uploaded, or try them again.');
    onSubmit(text.trim(), files.assetIds);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      foot={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="send" onClick={submit} disabled={pending}>
            {pending ? 'Sending…' : submitLabel}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="small sub">{intro}</div>
      <Field label={label} hint={`${text.length}/2000. ${hint}`} error={local || undefined}>
        <Textarea
          id="tr-text"
          rows={4}
          maxLength={2000}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setLocal('');
          }}
        />
      </Field>
      <div className="stack gap-2">
        <span className="label">
          Photos or documents <span className="muted">(optional)</span>
        </span>
        <FileDrop title="Add photos, screenshots or PDFs" hint="JPG, PNG or PDF, up to 10 MB each, 5 files max" accept="image/jpeg,image/png,application/pdf" onFiles={files.add} />
        <UploadList uploads={files} />
      </div>
    </Dialog>
  );
}

function AddDetailsDialog({ report, onClose, onDone }: { report: MyReport | null; onClose: () => void; onDone: (r: MyReport) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: (v: { id: string; text: string; mediaIds: string[] }) =>
      call(api.POST('/api/store/trust/reports/{id}/evidence', { params: { path: { id: v.id } }, body: { text: v.text, mediaIds: v.mediaIds.length ? v.mediaIds : null } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['trust', 'reports'] });
      announce(`Details added to report ${r.ref}.`);
      onDone(r);
      onClose();
    },
  });
  useEffect(() => {
    if (report) add.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.id]);
  const error = add.error instanceof ApiError && add.error.status === 409 ? 'This report is closed. If something changed, send a new report from the listing or the seller’s store.' : add.error ? errorMessage(add.error) : '';
  return (
    <TextFilesDialog
      open={!!report}
      onClose={onClose}
      title="Add photos or details"
      intro={
        <>
          Added to report <span className="mono">{report?.ref}</span> about {report?.about}. The seller or person you reported doesn’t see your name.
        </>
      }
      label="What else should we know?"
      hint="For example what happened, when, and the order number."
      submitLabel="Add to report"
      pending={add.isPending}
      error={error}
      onSubmit={(text, mediaIds) => report && add.mutate({ id: report.id, text, mediaIds })}
    />
  );
}

function AnswerDialog({ request, onClose, onDone }: { request: EvidenceRequest | null; onClose: () => void; onDone: () => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: (v: { id: string; answer: string; mediaIds: string[] }) =>
      call(api.POST('/api/store/trust/evidence-requests/{id}/answer', { params: { path: { id: v.id } }, body: { answer: v.answer, mediaIds: v.mediaIds.length ? v.mediaIds : null } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trust', 'evidence-requests'] });
      // the API closes the "Send what we asked for" notice once answered: refresh the inbox and its badge
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      announce('Answer sent.');
      onDone();
      onClose();
    },
  });
  useEffect(() => {
    if (request) send.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);
  const error =
    send.error instanceof ApiError && send.error.status === 409
      ? 'This request can’t be answered any more: the deadline passed or it was already answered.'
      : send.error
        ? errorMessage(send.error)
        : '';
  return (
    <TextFilesDialog
      open={!!request}
      onClose={onClose}
      title="Send what we asked for"
      intro={
        <>
          <span className="strong">{request?.question}</span>
          <br />
          Answer by {request ? dateTime(request.dueAt) : ''}. Trust and Risk adds your answer and files to its review.
        </>
      }
      label="Your answer"
      hint="Stick to the facts; don’t include card numbers or passwords."
      submitLabel="Send answer"
      pending={send.isPending}
      error={error}
      onSubmit={(text, mediaIds) => request && send.mutate({ id: request.id, answer: text, mediaIds })}
    />
  );
}

function AppealDialog({ enforcement, onClose, onDone }: { enforcement: MyEnforcement | null; onClose: () => void; onDone: (a: TrustAppeal) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: (v: { enforcementId: string; argument: string; evidenceIds: string[] }) =>
      call(api.POST('/api/store/trust/appeals', { body: { enforcementId: v.enforcementId, argument: v.argument, evidenceIds: v.evidenceIds.length ? v.evidenceIds : null } })),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ['trust', 'appeals'] });
      void qc.invalidateQueries({ queryKey: ['trust', 'enforcements'] });
      announce(`Appeal ${a.ref} sent.`);
      onDone(a);
      onClose();
    },
  });
  useEffect(() => {
    if (enforcement) send.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enforcement?.id]);
  const error = send.error ? ((send.error instanceof ApiError && APPEAL_ERRORS[send.error.code]) || errorMessage(send.error)) : '';
  return (
    <TextFilesDialog
      open={!!enforcement}
      onClose={onClose}
      title="Appeal this action"
      intro={
        <>
          <span className="strong">{enforcement?.title}</span>
          <br />
          Tell us why the decision should change. Someone who didn’t make it reviews your appeal
          {enforcement?.appealDeadline ? `. Appeal by ${dateTime(enforcement.appealDeadline)}` : ''}.
        </>
      }
      label="Why should we look again?"
      hint="At least 10 characters. Add anything that shows what really happened."
      submitLabel="Send appeal"
      minLength={10}
      pending={send.isPending}
      error={error}
      onSubmit={(text, evidenceIds) => enforcement && send.mutate({ enforcementId: enforcement.id, argument: text, evidenceIds })}
    />
  );
}
