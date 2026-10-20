import { fromZonedInput, zonedInput } from '@marketly/web-shared/lib/dates';
import { Fragment, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, Dialog, Field, Icon, IconButton, Pager, SearchInput, Select, Stat, StatusBadge, TableWrap, Tabs, Textarea, TextInput, type IconName } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, date, dateTime } from '@/app/parts';

// Design: pages/admin/admin-help-content.html · view "edit-policy" = the editor for a policy version (or a help article).
// Data: GET /api/admin/content/help/summary (KPIs, tab counts), /help/items (the list), /help/categories, /policies.
// Editor (?view=edit-policy&policy=<id> or &article=<id>, or &new=article): policy versions from
// GET /policies/{id}/versions (base text = the current version); Save draft = POST /policies/{id}/versions (first time)
// + PATCH /policy-versions/{id}; Send for approval = POST /policy-versions/{id}/submit (policy owner, then the Business
// Owner through an approval request); POST /approve (policy owner), /schedule (approved). Articles: GET/PATCH/POST
// /help/articles, POST /help/articles/{id}/transition.

type S = components['schemas'];
type Item = S['content.ContentListItem'];
type PolicyVersion = S['content.PolicyVersion'];
type ArticleAdmin = S['content.HelpArticleAdmin'];
// HelpArticleAdmin.draftReview: the review of the unpublished draft of a live (published or unpublished) article;
// null when there is no draft or it was never sent for review.
type DraftReview = S['content.HelpArticleDraftReview'];
const draftReviewOf = (a?: ArticleAdmin) => a?.draftReview ?? null;
/** Where an article's pending version is in review; 'none' = not sent (or nothing pending). */
type ReviewState = 'none' | DraftReview['state'];
const LIVE_DRAFT_TEXT: Record<ReviewState, string> = { none: 'edits not sent for review', in_review: 'edits in review', approved: 'edits approved', changes_requested: 'changes requested' };
const REVIEW_LABEL: Record<ReviewState, string> = { none: 'Not sent', in_review: 'In review', approved: 'Approved', changes_requested: 'Changes requested' };
const REVIEW_TONE: Record<ReviewState, 'info' | 'success' | 'danger' | undefined> = { none: undefined, in_review: 'info', approved: 'success', changes_requested: 'danger' };

const PAGE = 10;
/** Used until the policyNoticeDays setting has loaded (or when the caller can't read settings). */
const DEFAULT_NOTICE_DAYS = 14;
const NOTICE_SETTING = 'content.policyNoticeDays';
const TZ = 'America/Los_Angeles';

const STATUS: Record<string, string> = {
  current: 'Published',
  published: 'Published',
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  superseded: 'Superseded',
  withdrawn: 'Withdrawn',
  unpublished: 'Unpublished',
  removed: 'Removed',
};
const OPEN_STATES = new Set(['draft', 'in_review', 'approved', 'scheduled']);
type TabKey = 'all' | 'policies' | 'articles' | 'drafts';

const FORMATS: Array<{ icon: IconName; label: string; wrap: [string, string] }> = [
  { icon: 'heading-2', label: 'Heading', wrap: ['<h2>', '</h2>'] },
  { icon: 'bold', label: 'Bold', wrap: ['<strong>', '</strong>'] },
  { icon: 'italic', label: 'Italic', wrap: ['<em>', '</em>'] },
  { icon: 'list', label: 'Bulleted list', wrap: ['<ul><li>', '</li></ul>'] },
  { icon: 'list-ordered', label: 'Numbered list', wrap: ['<ol><li>', '</li></ol>'] },
  { icon: 'link', label: 'Insert link', wrap: ['<a href="https://">', '</a>'] },
];

/** Word-level diff (LCS) for the live "Changes" card. */
function diffWords(a: string, b: string) {
  const x = a.split(/(\s+)/);
  const y = b.split(/(\s+)/);
  const L = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: Array<{ t: 'same' | 'ins' | 'del'; s: string }> = [];
  let i = 0;
  let j = 0;
  const push = (t: 'same' | 'ins' | 'del', s: string) => (out.length && out[out.length - 1].t === t ? (out[out.length - 1].s += s) : out.push({ t, s }));
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) (push('same', x[i]), i++, j++);
    else if (L[i + 1][j] >= L[i][j + 1]) push('del', x[i++]);
    else push('ins', y[j++]);
  }
  while (i < x.length) push('del', x[i++]);
  while (j < y.length) push('ins', y[j++]);
  return out;
}

const wallToIso = (wall: string) => fromZonedInput(wall, TZ) ?? '';
const isoToWall = (iso?: string | null) => zonedInput(iso, TZ);
const nextVersion = (v?: string | null) => {
  const [maj, min] = (v ?? '0.9').split('.').map(Number);
  return `${maj || 0}.${(min ?? 0) + 1}`;
};
const actorName = (a: unknown) => (a as { name?: string } | null | undefined)?.name;

/* ---------------- Shared editor parts ---------------- */

function BodyEditor({ value, onChange, error, disabled }: { value: string; onChange: (v: string) => void; error?: string; disabled: boolean }) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const format = (wrap: [string, string]) => {
    const ta = bodyRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    onChange(v.slice(0, s) + wrap[0] + v.slice(s, e) + wrap[1] + v.slice(e));
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + wrap[0].length, e + wrap[0].length);
    });
  };
  return (
    <div className="field">
      <label className="label" htmlFor="hp-body">
        Body
      </label>
      <div className="ab-edbar" role="toolbar" aria-label="Formatting">
        {FORMATS.map((f) => (
          <IconButton key={f.label} icon={f.icon} label={f.label} onClick={() => format(f.wrap)} disabled={disabled} />
        ))}
      </div>
      <textarea
        ref={bodyRef}
        className={cx('textarea', error && 'is-error')}
        id="hp-body"
        rows={8}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'hp-body-err' : undefined}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      {error && (
        <span className="error-text" id="hp-body-err">
          <Icon name="circle-alert" className="ic-sm" />
          {error}
        </span>
      )}
    </div>
  );
}

function EditorHead({ title, sub, badge, preview, crumb }: { title: string; sub: string; badge: ReactNode; preview: string; crumb: string }) {
  return (
    <div className="page-head">
      <div className="t">
        <Breadcrumbs items={[{ label: 'Help and policies', to: href('admin/help-content') }, { label: crumb }]} />
        <h1 className="h1">{title}</h1>
        <p className="sub small">{sub}</p>
      </div>
      <div className="actions">
        {badge}
        <Button variant="secondary" size="sm" icon="eye" to={preview}>
          Preview public page
        </Button>
      </div>
    </div>
  );
}

/** Asks why changes are needed: the backend requires a reason (articles) or note (policies) to send work back. */
function ReasonDialog({ open, title, hint, pending, error, onClose, onConfirm }: { open: boolean; title: string; hint: string; pending: boolean; error?: string; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const missing = tried && !reason.trim();
  return (
    <Dialog
      open={open}
      size="sm"
      onClose={onClose}
      title={title}
      foot={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setTried(true);
              if (reason.trim()) onConfirm(reason.trim());
            }}
            disabled={pending}
          >
            Request changes
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger" title={error} />}
      <Field label="What needs to change" hint={hint} error={missing ? 'Say what needs to change.' : undefined}>
        <Textarea id="hp-reason" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function EditorFrame({ children }: { children: ReactNode }) {
  return (
    <AdminLayout active="help-content">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Help and policies', to: href('admin/help-content') }, { label: 'Editor' }]} />
          <h1 className="h1">Help and policies</h1>
        </div>
      </div>
      {children}
    </AdminLayout>
  );
}

/* ---------------- Policy editor ---------------- */

type PolicyErrors = Partial<Record<'title' | 'body' | 'effective' | 'summary', string>>;

function PolicyEditor({ policyId, onSwitch }: { policyId: string; onSwitch: (id: string) => void }) {
  const { api } = useApi();
  const policies = useQuery({ queryKey: ['content', 'policies'], queryFn: () => call(api.GET('/api/admin/content/policies')) });
  const versions = useQuery({ queryKey: ['content', 'policy-versions', policyId], queryFn: () => call(api.GET('/api/admin/content/policies/{id}/versions', { params: { path: { id: policyId } } })) });
  const err = policies.error ?? versions.error;
  if (err) {
    return (
      <EditorFrame>
        <LoadError error={err} onRetry={() => void (policies.isError ? policies.refetch() : versions.refetch())} />
      </EditorFrame>
    );
  }
  if (!policies.data || !versions.data) {
    return (
      <EditorFrame>
        <div className="ab-main wide">
          <Card pad>
            <SkeletonLines rows={8} />
          </Card>
          <Card pad>
            <SkeletonLines rows={5} />
          </Card>
        </div>
      </EditorFrame>
    );
  }
  const summary = policies.data.find((p) => p.id === policyId);
  if (!summary) {
    return (
      <EditorFrame>
        <Alert tone="warning" title="This policy doesn’t exist">
          <Link to={href('admin/help-content')}>Back to Help and policies</Link>
        </Alert>
      </EditorFrame>
    );
  }
  const working = versions.data.find((v) => OPEN_STATES.has(v.state));
  return <PolicyForm key={working?.id ?? `new-${policyId}`} policies={policies.data} summary={summary} versions={versions.data} working={working} onSwitch={onSwitch} />;
}

function PolicyForm({
  policies, summary, versions, working, onSwitch,
}: {
  policies: S['content.PolicySummary'][];
  summary: S['content.PolicySummary'];
  versions: PolicyVersion[];
  working?: PolicyVersion;
  onSwitch: (id: string) => void;
}) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can, name: me, accountId } = useStaffSession();
  const canEdit = can('content.policies.edit');
  // The owner step is decided by the policy's owner, or by someone who manages all policies (backend: FORBIDDEN otherwise).
  const canApprove = can('content.policies.approve') && (summary.owner.staffId === accountId || can('content.policies.manage'));
  const current = versions.find((v) => v.state === 'current');
  // Notice period for customer-facing changes (setting content.policyNoticeDays). A shorter notice is allowed: the
  // backend then asks the Business Owner to approve the schedule, so the form only warns.
  const noticeSetting = useQuery({
    queryKey: ['settings', 'value', NOTICE_SETTING],
    enabled: can('settings.view'),
    queryFn: () => call(api.GET('/api/admin/settings/values/{key}', { params: { path: { key: NOTICE_SETTING } } })),
  });
  const noticeValue = Number(noticeSetting.data?.current.value);
  const noticeDays = Number.isFinite(noticeValue) && noticeValue >= 0 ? noticeValue : DEFAULT_NOTICE_DAYS;
  // The backend applies the notice to changes of a published policy whose audience isn't sellers only. The summary
  // has no audience field, so seller rules stand in for seller-only policies.
  const needsNotice = !!current && summary.kind !== 'seller_rules';
  const [askChanges, setAskChanges] = useState(false);
  const base = current?.body ?? '';
  const [d, setD] = useState(() => ({
    title: working?.title ?? summary.title,
    version: working?.version ?? nextVersion(current?.version),
    body: working?.body ?? base,
    effective: isoToWall(working?.effectiveAt),
    summary: working?.changeSummary ?? '',
    impact: working?.impact ?? ('new_orders_only' as const),
    notifyCustomers: working?.notifyCustomers ?? true,
    notifySellers: working?.notifySellers ?? summary.kind === 'seller_rules',
  }));
  const [errors, setErrors] = useState<PolicyErrors>({});
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; title: string; text: ReactNode } | null>(null);
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => {
    setD((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const state = working?.state ?? 'new';
  const locked = !canEdit || (state !== 'new' && state !== 'draft');

  const validate = () => {
    const e: PolicyErrors = {};
    if (!d.title.trim()) e.title = 'Enter a title.';
    if (!d.body.trim()) e.body = 'Enter the text.';
    if (!d.effective) e.effective = 'Choose the date and time the new version takes effect.';
    else if (new Date(wallToIso(d.effective)) < new Date()) e.effective = 'Choose a date and time in the future.';
    if (!d.summary.trim()) e.summary = 'Summarize what changed. Customers see it at the top of the policy.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['content'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
  };
  const persist = async () => {
    const v = working ?? (await call(api.POST('/api/admin/content/policies/{id}/versions', { params: { path: { id: summary.id } }, body: { version: d.version } })));
    return call(
      api.PATCH('/api/admin/content/policy-versions/{id}', {
        params: { path: { id: v.id } },
        body: { title: d.title.trim(), body: d.body, effectiveAt: d.effective ? wallToIso(d.effective) : null, changeSummary: d.summary.trim() || null, impact: d.impact, notifyCustomers: d.notifyCustomers, notifySellers: d.notifySellers },
      }),
    );
  };
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const v = await persist();
      return submit ? call(api.POST('/api/admin/content/policy-versions/{id}/submit', { params: { path: { id: v.id } } })) : v;
    },
    onSuccess: (v, submit) => {
      refresh();
      if (submit) {
        const approvers = v.approval?.approvers?.length ? v.approval.approvers.join(', ') : 'the policy owner, then the Business Owner';
        setNotice({ tone: 'success', title: 'Sent for approval', text: <>Version {v.version} goes to {approvers}. It takes effect on {v.effectiveAt ? dateTime(v.effectiveAt) : 'its effective date'} once approved and scheduled. </> });
        announce(`${v.title} ${v.version} sent for approval`);
      } else {
        setNotice({ tone: 'success', title: 'Draft saved', text: `Version ${v.version} is saved as a draft.` });
        announce('Draft saved');
      }
    },
  });
  const act = useMutation({
    mutationFn: ({ kind, note }: { kind: 'approve' | 'changes' | 'schedule'; note?: string }) => {
      const id = working!.id;
      if (kind === 'schedule') return call(api.POST('/api/admin/content/policy-versions/{id}/schedule', { params: { path: { id } }, body: { effectiveAt: working!.effectiveAt ?? wallToIso(d.effective) } }));
      // Sending a version back needs a note for the editor (backend: VALIDATION_FAILED without it).
      return call(api.POST('/api/admin/content/policy-versions/{id}/approve', { params: { path: { id } }, body: kind === 'approve' ? { approve: true } : { approve: false, note } }));
    },
    onSuccess: (v, { kind }) => {
      setAskChanges(false);
      refresh();
      const pending = v.approval?.required && v.state === 'in_review';
      setNotice({
        tone: pending ? 'info' : 'success',
        title: kind === 'schedule' ? 'Scheduled' : kind === 'changes' ? 'Changes requested' : pending ? 'Sent for final approval' : 'Approved',
        text: kind === 'schedule' ? `Version ${v.version} takes effect ${v.effectiveAt ? dateTime(v.effectiveAt) : ''}.` : pending ? `${v.approval?.reason ?? 'The Business Owner gives the final approval.'}` : `Version ${v.version}: ${STATUS[v.state] ?? v.state}.`,
      });
    },
  });

  const saveDraft = () => {
    if (!d.title.trim()) return setErrors({ title: 'Enter a title.' });
    save.mutate(false);
  };
  const send = () => {
    if (!validate()) return announce('Check the highlighted fields.');
    save.mutate(true);
  };

  const changed = d.body !== base;
  const owner = summary.owner;
  const approvals = working?.approvals ?? [];
  const step = (role: 'policy_owner' | 'business_owner') => approvals.find((a) => a.role === role);
  const ownerStep = step('policy_owner');
  const boStep = step('business_owner');
  const previous = versions.filter((v) => v.state === 'current' || v.state === 'superseded');
  const sentState = state === 'in_review' || state === 'approved' || state === 'scheduled';

  return (
    <AdminLayout active="help-content">
      <EditorHead
        crumb={d.title}
        title={`${d.title} · version ${d.version}`}
        sub={`Policy owner ${owner.name}, ${owner.role}${summary.editor ? ` · content editor ${summary.editor.name}` : ''}`}
        badge={sentState ? <Badge tone="info">{STATUS[state]}</Badge> : <Badge>Draft</Badge>}
        preview={href('info/policy')}
      />

      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.text} <Link to={href('admin/help-content')}>Back to Help and policies</Link>
        </Alert>
      )}
      {!canEdit && <Alert tone="info" title="Read only">Your role can’t edit policies.</Alert>}

      <div className="ab-main wide">
        <div className="stack gap-4">
          <Card title="Policy text">
            {!working && policies.length > 1 && (
              <Field label="Policy">
                <Select id="hp-policy" options={policies.map((p) => ({ value: p.id, label: p.title }))} value={summary.id} onChange={(e) => onSwitch(e.target.value)} />
              </Field>
            )}
            <Field label="Title" error={errors.title}>
              <TextInput id="hp-title" value={d.title} error={!!errors.title} onChange={(e) => set('title', e.target.value)} disabled={locked} />
            </Field>
            <BodyEditor value={d.body} onChange={(v) => set('body', v)} error={errors.body} disabled={locked} />
          </Card>
          <Card title={`Changes from version ${current?.version ?? 'nothing yet'}`} titleAs="h3">
            {changed ? (
              <p className="ab-diff" style={{ whiteSpace: 'pre-wrap' }}>
                {diffWords(base, d.body).map((p, i) => (
                  <Fragment key={i}>{p.t === 'ins' ? <ins>{p.s}</ins> : p.t === 'del' ? <del>{p.s}</del> : p.s}</Fragment>
                ))}
              </p>
            ) : (
              <p className="small muted">No changes yet. Edit the text to see what changes.</p>
            )}
          </Card>
          {previous.length > 0 && (
            <Card title="Previous versions" titleAs="h3" flush>
              <TableWrap label="Previous versions table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Version</th>
                      <th scope="col">Effective</th>
                      <th scope="col">Summary</th>
                      <th scope="col">Approved by</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {previous.map((p) => (
                      <tr key={p.id}>
                        <td>
                          {p.state === 'current' ? (
                            <>
                              <b>{p.version}</b> · current
                            </>
                          ) : (
                            p.version
                          )}
                        </td>
                        <td>{p.effectiveAt ? date(p.effectiveAt) : '—'}</td>
                        <td>{p.changeSummary ?? '—'}</td>
                        <td>{actorName(p.approvals.find((a) => a.role === 'business_owner')?.reviewer) ?? actorName(p.approvals.find((a) => a.state === 'approved')?.reviewer) ?? '—'}</td>
                        <td>
                          <Link className="btn btn-ghost btn-sm" to={href('info/policy')}>
                            <span>View</span>
                            <span className="sr-only"> {p.version}</span>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          )}
        </div>

        <div className="stack gap-4 ab-sticky">
          <Card
            title="Publishing"
            titleAs="h3"
            foot={
              state === 'approved' && canEdit ? (
                <Button size="sm" icon="calendar" onClick={() => act.mutate({ kind: 'schedule' })} disabled={act.isPending}>
                  Schedule
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={saveDraft} disabled={locked || save.isPending}>
                    Save draft
                  </Button>
                  <Button size="sm" onClick={send} disabled={locked || save.isPending}>
                    {sentState ? 'Sent' : 'Send for approval'}
                  </Button>
                </>
              )
            }
          >
            {(save.isError || (act.isError && !askChanges)) && (
              <Alert tone="danger" title="That didn’t work">
                {errorMessage(save.error ?? act.error)}
              </Alert>
            )}
            <Field label="Effective date" hint={needsNotice ? `Customer-facing changes need ${noticeDays} days' notice · Pacific Time` : 'Pacific Time'} error={errors.effective}>
              <TextInput id="hp-eff" type="datetime-local" icon="calendar" value={d.effective} error={!!errors.effective} onChange={(e) => set('effective', e.target.value)} disabled={locked} />
            </Field>
            {needsNotice && d.effective && !errors.effective && new Date(wallToIso(d.effective)).getTime() < Date.now() + noticeDays * 86_400_000 && (
              <Alert tone="warning" title={`Less than ${noticeDays} days' notice`}>
                Scheduling this date needs the Business Owner&rsquo;s approval. Choose a later date to avoid it.
              </Alert>
            )}
            <Field label="Change summary" hint="Shown at the top of the policy page and in the notice" error={errors.summary}>
              <Textarea id="hp-sum" value={d.summary} onChange={(e) => set('summary', e.target.value)} disabled={locked} />
            </Field>
            <fieldset className="stack gap-2 fieldset-reset">
              <legend className="label">Impact on existing orders</legend>
              {(
                [
                  ['new_orders_only', `Orders placed from ${d.effective ? date(wallToIso(d.effective)) : 'the effective date'} only`, 'Earlier orders keep the terms accepted at purchase'],
                  ['extend_open_orders', 'Also extend to open orders', 'Only for changes that favor the customer'],
                ] as const
              ).map(([v, t, b], i) => (
                <label key={v} className={cx('opt-card', d.impact === v && 'is-selected')} htmlFor={`hp-imp-${i + 1}`}>
                  <input type="radio" name="hp-imp" id={`hp-imp-${i + 1}`} checked={d.impact === v} onChange={() => set('impact', v)} disabled={locked} />
                  <span className="stack gap-1 grow">
                    <span className="small strong">{t}</span>
                    <span className="small sub">{b}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="check" htmlFor="hp-n1">
              <input type="checkbox" id="hp-n1" checked={d.notifyCustomers} onChange={(e) => set('notifyCustomers', e.target.checked)} disabled={locked} />
              <span>Notify customers with an account</span>
            </label>
            <label className="check" htmlFor="hp-n2">
              <input type="checkbox" id="hp-n2" checked={d.notifySellers} onChange={(e) => set('notifySellers', e.target.checked)} disabled={locked} />
              <span>Notify sellers in Seller Center</span>
            </label>
            <div className="divider" />
            <ul className="ab-approvals">
              {[
                { n: 1, s: ownerStep, who: `${owner.name} · ${owner.role}`, what: 'Policy owner' },
                { n: 2, s: boStep, who: 'Business Owner', what: 'Final approval' },
              ].map(({ n, s, who, what }) => {
                const done = s?.state === 'approved';
                const back = s?.state === 'changes_requested';
                const waiting = state === 'in_review' && s?.state === 'waiting';
                const reviewer = actorName(s?.reviewer);
                const canDecideOwner = n === 1 && waiting && canApprove;
                return (
                  <li key={n}>
                    <span className={cx('n', done ? 'is-done' : 'is-wait')}>{done ? <Icon name="check" className="ic-sm" /> : n}</span>
                    <span className="ab-cell">
                      <span className="strong">{n === 2 && reviewer ? `${reviewer} · Business Owner` : who}</span>
                      <span className="xs muted">
                        {what}
                        {s?.at ? ` · ${done ? 'approved' : back ? 'changes requested' : 'updated'} ${dateTime(s.at)}` : sentState && !done ? ' · requested' : ''}
                        {s?.note ? ` · ${s.note}` : ''}
                      </span>
                      {canDecideOwner && (
                        <span className="row gap-2">
                          <Button size="sm" onClick={() => act.mutate({ kind: 'approve' })} disabled={act.isPending}>
                            Approve
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              act.reset();
                              setAskChanges(true);
                            }}
                            disabled={act.isPending}
                          >
                            Request changes
                          </Button>
                        </span>
                      )}
                      {n === 2 && waiting && ownerStep?.state === 'approved' && (
                        <Link className="xs" to={href('admin/inbox')}>
                          Decided from the approval request in the Inbox
                        </Link>
                      )}
                    </span>
                    {done ? <Badge tone="success">Approved</Badge> : back ? <Badge tone="danger">Changes requested</Badge> : sentState ? <Badge tone="warning">Pending</Badge> : <Badge>Not sent</Badge>}
                  </li>
                );
              })}
            </ul>
            {!working && <span className="xs muted">Saving starts version {d.version} as a draft{me ? ` by ${me}` : ''}, copied from the current text.</span>}
          </Card>
        </div>
      </div>
      <ReasonDialog
        key={askChanges ? 'open' : 'closed'}
        open={askChanges}
        title={`Request changes to ${d.title} ${d.version}`}
        hint="The editor sees this note with the version sent back to draft."
        pending={act.isPending}
        error={act.isError ? errorMessage(act.error) : undefined}
        onClose={() => setAskChanges(false)}
        onConfirm={(note) => act.mutate({ kind: 'changes', note })}
      />
    </AdminLayout>
  );
}

/* ---------------- Article editor ---------------- */

function ArticleEditor({ articleId }: { articleId?: string }) {
  const { api } = useApi();
  const cats = useQuery({ queryKey: ['content', 'help-categories'], queryFn: () => call(api.GET('/api/admin/content/help/categories')) });
  const art = useQuery({ queryKey: ['content', 'article', articleId], enabled: !!articleId, queryFn: () => call(api.GET('/api/admin/content/help/articles/{id}', { params: { path: { id: articleId! } } })) });
  const err = cats.error ?? art.error;
  if (err) {
    return (
      <EditorFrame>
        <LoadError error={err} onRetry={() => void (cats.isError ? cats.refetch() : art.refetch())} />
      </EditorFrame>
    );
  }
  if (!cats.data || (articleId && !art.data)) {
    return (
      <EditorFrame>
        <Card pad>
          <SkeletonLines rows={8} />
        </Card>
      </EditorFrame>
    );
  }
  return <ArticleForm key={art.data?.article.id ?? 'new'} a={art.data} categories={cats.data} />;
}

function ArticleForm({ a, categories }: { a?: ArticleAdmin; categories: S['content.HelpCategory'][] }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [, setParams] = useSearchParams();
  const { can, name: me } = useStaffSession();
  const canEdit = can('content.help.manage');
  const [d, setD] = useState(() => ({ title: a?.article.title ?? '', body: a?.article.body ?? '', categoryId: a?.article.category.id ?? categories[0]?.id ?? '' }));
  const [errors, setErrors] = useState<Partial<Record<'title' | 'body' | 'category', string>>>({});
  const [notice, setNotice] = useState('');
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => {
    setD((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const status = a?.status ?? 'draft';
  // A live article keeps status published (or unpublished) while its next version is drafted; that draft's review is
  // tracked separately in draftReview. First publication still runs on status alone.
  const draftReview = draftReviewOf(a);
  const liveDraft = !!a && (status === 'published' || status === 'unpublished') && a.draftVersion != null;
  const review: ReviewState = liveDraft ? (draftReview?.state ?? 'none') : status === 'in_review' ? 'in_review' : status === 'approved' ? 'approved' : 'none';
  const inReview = review === 'in_review';
  const approved = review === 'approved';
  const locked = !canEdit || inReview || status === 'scheduled';
  // The review step shows a tick once the pending version is approved, or when the live article has nothing pending.
  const stepDone = approved || (!liveDraft && status === 'published');
  const base = a?.article.body ?? '';
  const [askChanges, setAskChanges] = useState(false);

  const refresh = (r: ArticleAdmin) => {
    qc.setQueryData(['content', 'article', r.article.id], r);
    void qc.invalidateQueries({ queryKey: ['content'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const body = { title: d.title.trim(), body: d.body, categoryId: d.categoryId };
      let r = a ? await call(api.PATCH('/api/admin/content/help/articles/{id}', { params: { path: { id: a.article.id } }, body })) : await call(api.POST('/api/admin/content/help/articles', { body }));
      if (submit) r = await call(api.POST('/api/admin/content/help/articles/{id}/transition', { params: { path: { id: r.article.id } }, body: { action: 'submit' } }));
      return { r, submit };
    },
    onSuccess: ({ r, submit }) => {
      refresh(r);
      if (!a) setParams((p) => ({ ...Object.fromEntries([...p].filter(([k]) => k !== 'new')), article: r.article.id }), { replace: true });
      setNotice(submit ? 'Sent for review' : 'Draft saved');
      announce(submit ? `${r.article.title} sent for review` : 'Draft saved');
    },
  });
  const transition = useMutation({
    // requestChanges needs a reason (backend: VALIDATION_FAILED without it); it comes from the reason dialog.
    mutationFn: ({ action, reason }: { action: 'approve' | 'requestChanges' | 'publish'; reason?: string }) =>
      call(api.POST('/api/admin/content/help/articles/{id}/transition', { params: { path: { id: a!.article.id } }, body: action === 'requestChanges' ? { action, reason } : { action } })),
    onSuccess: (r, { action }) => {
      setAskChanges(false);
      refresh(r);
      setNotice(action === 'publish' ? 'Published' : action === 'approve' ? 'Approved' : 'Changes requested');
      announce(action === 'publish' ? `${r.article.title} published` : action === 'approve' ? 'Approved' : 'Changes requested');
    },
  });
  const validate = () => {
    const e: typeof errors = {};
    if (!d.title.trim()) e.title = 'Enter a title.';
    if (!d.body.trim()) e.body = 'Enter the text.';
    if (!d.categoryId) e.category = 'Choose a category.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const changed = d.body !== base;

  return (
    <AdminLayout active="help-content">
      <EditorHead
        crumb={d.title || 'New article'}
        title={`${d.title || 'New article'}${a ? ` · version ${a.draftVersion ?? a.liveVersion ?? a.article.version}` : ''}`}
        sub={`Help article · editor ${a?.owner.name ?? me ?? 'Content'}${a?.owner.role ? `, ${a.owner.role}` : ''}`}
        badge={
          liveDraft ? (
            <Badge tone={REVIEW_TONE[review]}>{`${STATUS[status]} · ${LIVE_DRAFT_TEXT[review]}`}</Badge>
          ) : status === 'in_review' ? (
            <Badge tone="info">In review</Badge>
          ) : (
            <Badge>{STATUS[status] ?? status}</Badge>
          )
        }
        preview={a ? href('help/article', '', { slug: a.article.slug }) : href('help/article')}
      />
      {notice && (
        <Alert tone="success" title={notice}>
          {notice === 'Sent for review' ? (liveDraft || status === 'published' ? 'The live article stays as it is until another Content editor approves the changes and they are published. ' : 'The article can be published once another Content editor approves it. ') : ''}
          <Link to={href('admin/help-content')}>Back to Help and policies</Link>
        </Alert>
      )}
      <div className="ab-main wide">
        <div className="stack gap-4">
          <Card title="Article text">
            <Field label="Title" error={errors.title}>
              <TextInput id="hp-title" value={d.title} error={!!errors.title} onChange={(e) => set('title', e.target.value)} disabled={locked} />
            </Field>
            <Field label="Category" error={errors.category}>
              <Select id="hp-cat" options={categories.map((c) => ({ value: c.id, label: `${c.name}${c.audience === 'seller' ? ' (sellers)' : ''}` }))} value={d.categoryId} onChange={(e) => set('categoryId', e.target.value)} disabled={locked} />
            </Field>
            <BodyEditor value={d.body} onChange={(v) => set('body', v)} error={errors.body} disabled={locked} />
          </Card>
          {a && (
            <Card title={`Changes from version ${a.liveVersion ?? a.article.version}`} titleAs="h3">
              {changed ? (
                <p className="ab-diff" style={{ whiteSpace: 'pre-wrap' }}>
                  {diffWords(base, d.body).map((p, i) => (
                    <Fragment key={i}>{p.t === 'ins' ? <ins>{p.s}</ins> : p.t === 'del' ? <del>{p.s}</del> : p.s}</Fragment>
                  ))}
                </p>
              ) : (
                <p className="small muted">No changes yet. Edit the text to see what changes.</p>
              )}
            </Card>
          )}
        </div>
        <div className="stack gap-4 ab-sticky">
          <Card
            title="Publishing"
            titleAs="h3"
            foot={
              approved && canEdit ? (
                <Button size="sm" onClick={() => transition.mutate({ action: 'publish' })} disabled={transition.isPending}>
                  {liveDraft ? 'Publish changes' : 'Publish'}
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={() => (d.title.trim() ? save.mutate(false) : setErrors({ title: 'Enter a title.' }))} disabled={locked || save.isPending}>
                    Save draft
                  </Button>
                  {/* Saving first, then submit: for a live article this sends its draft (draftReview), otherwise the article. */}
                  <Button size="sm" onClick={() => validate() && save.mutate(true)} disabled={locked || save.isPending}>
                    {inReview ? 'Sent' : review === 'changes_requested' ? 'Send for review again' : 'Send for review'}
                  </Button>
                </>
              )
            }
          >
            {(save.isError || (transition.isError && !askChanges)) && (
              <Alert tone="danger" title="That didn’t work">
                {errorMessage(save.error ?? transition.error)}
              </Alert>
            )}
            {a && (
              <span className="xs muted">
                {a.schedule.label}
                {a.helpfulPct != null ? ` · ${Math.round(a.helpfulPct)}% found it helpful (${a.feedbackCount})` : ''}
                {a.reviewDueAt ? ` · review due ${date(a.reviewDueAt)}` : ''}
              </span>
            )}
            <div className="divider" />
            <ul className="ab-approvals">
              <li>
                <span className={cx('n', stepDone ? 'is-done' : 'is-wait')}>{stepDone ? <Icon name="check" className="ic-sm" /> : 1}</span>
                <span className="ab-cell">
                  <span className="strong">Content review{liveDraft ? ` · version ${a!.draftVersion}` : ''}</span>
                  <span className="xs muted">{liveDraft ? `Another Content editor checks the changes before they replace live version ${a!.liveVersion ?? a!.article.version}` : 'Another Content editor checks accuracy and links'}</span>
                  {inReview && a?.draftAuthor?.name && <span className="xs muted">Written by {a.draftAuthor.name}</span>}
                  {liveDraft && draftReview && (
                    <span className="xs muted">
                      {draftReview.state === 'in_review' ? 'Sent for review' : draftReview.state === 'approved' ? 'Approved' : 'Changes requested'}
                      {actorName(draftReview.by) ? ` by ${actorName(draftReview.by)}` : ''} · {dateTime(draftReview.at)}
                      {draftReview.state === 'changes_requested' && draftReview.reason ? `: ${draftReview.reason}` : ''}
                    </span>
                  )}
                  {inReview && canEdit && a && !a.canApprove && <span className="xs muted">You wrote this version, so another Content editor approves it.</span>}
                  {inReview && canEdit && (
                    <span className="row gap-2">
                      {/* canApprove: in review and the caller isn't the draft's author (SAME_REVIEWER otherwise). */}
                      {a?.canApprove && (
                        <Button size="sm" onClick={() => transition.mutate({ action: 'approve' })} disabled={transition.isPending}>
                          Approve
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          transition.reset();
                          setAskChanges(true);
                        }}
                        disabled={transition.isPending}
                      >
                        Request changes
                      </Button>
                    </span>
                  )}
                </span>
                <StatusBadge status={liveDraft ? REVIEW_LABEL[review] : (STATUS[status] ?? status)} />
              </li>
            </ul>
          </Card>
        </div>
      </div>
      <ReasonDialog
        key={askChanges ? 'open' : 'closed'}
        open={askChanges}
        title={`Request changes to ${d.title || 'this article'}`}
        hint="The writer sees this with the draft sent back to them."
        pending={transition.isPending}
        error={transition.isError ? errorMessage(transition.error) : undefined}
        onClose={() => setAskChanges(false)}
        onConfirm={(reason) => transition.mutate({ action: 'requestChanges', reason })}
      />
    </AdminLayout>
  );
}

/* ---------------- List ---------------- */

export default function HelpContent() {
  const [view, setView] = useView<'edit-policy'>();
  const [params, setParams] = useSearchParams();
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('content.view');
  const canHelp = can('content.help.manage');
  const canPolicies = can('content.policies.edit');

  const [tab, setTab] = useState<TabKey>('all');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [page, setPage] = useState(1);

  const summary = useQuery({ queryKey: ['content', 'help-summary'], enabled: canView, queryFn: () => call(api.GET('/api/admin/content/help/summary')) });
  const items = useQuery({ queryKey: ['content', 'help-items'], enabled: canView, queryFn: () => call(api.GET('/api/admin/content/help/items', { params: { query: { limit: 100 } } })) });
  const policies = useQuery({ queryKey: ['content', 'policies'], enabled: canView, queryFn: () => call(api.GET('/api/admin/content/policies')) });

  const openEditor = (p: Record<string, string>) => {
    setParams({ view: 'edit-policy', ...p });
    window.scrollTo({ top: 0 });
  };

  if (view === 'edit-policy') {
    const article = params.get('article');
    const isNew = params.get('new') === 'article';
    if (article || isNew) return <ArticleEditor articleId={article ?? undefined} />;
    const policyId = params.get('policy') ?? policies.data?.find((p) => p.key === 'returns')?.id ?? policies.data?.[0]?.id;
    if (policyId) return <PolicyEditor key={policyId} policyId={policyId} onSwitch={(id) => setParams({ view: 'edit-policy', policy: id }, { replace: true })} />;
    return (
      <EditorFrame>
        {!canPolicies ? (
          <Alert tone="info" title="Not available for your role">
            Editing policies needs the policy editor permission. A Platform Administrator can change your roles in Staff and permissions.
          </Alert>
        ) : policies.isError ? (
          <LoadError error={policies.error} onRetry={() => void policies.refetch()} />
        ) : policies.isSuccess ? (
          <Alert tone="info" title="No policies yet">
            <Button variant="link" onClick={() => setView('')}>
              Back to Help and policies
            </Button>
          </Alert>
        ) : (
          <Card pad>
            <SkeletonLines rows={6} />
          </Card>
        )}
      </EditorFrame>
    );
  }

  const all: Item[] = items.data?.items ?? [];
  const categories = [...new Set(all.map((r) => r.category))].sort();
  const needle = q.trim().toLowerCase();
  const isDraft = (r: Item) => OPEN_STATES.has(r.status);
  const inTab = (t: TabKey) => (r: Item) => t === 'all' || (t === 'policies' && r.type === 'policy') || (t === 'articles' && r.type === 'article') || (t === 'drafts' && isDraft(r));
  const rows = all.filter((r) => inTab(tab)(r) && (!cat || r.category === cat) && (!needle || r.title.toLowerCase().includes(needle)));
  const pageRows = rows.slice((page - 1) * PAGE, page * PAGE);
  const sm = summary.data;
  // HelpSummary.tabs is typed unknown in the OpenAPI document (G20).
  const smTabs = (sm?.tabs ?? {}) as Partial<Record<'all' | 'articles' | 'policies' | 'needsReview', number>>;
  const tabs = [
    { label: 'All', value: 'all' as const, count: smTabs.all ?? all.length },
    { label: 'Policies', value: 'policies' as const, count: smTabs.policies ?? all.filter(inTab('policies')).length },
    { label: 'Help articles', value: 'articles' as const, count: smTabs.articles ?? all.filter(inTab('articles')).length },
    { label: 'Drafts and review', value: 'drafts' as const, count: all.filter(inTab('drafts')).length },
  ];
  const open = (r: Item) => (r.type === 'policy' ? openEditor({ policy: r.id }) : openEditor({ article: r.id }));

  if (!canView) {
    return (
      <AdminLayout active="help-content">
        <div className="page-head">
          <div className="t">
            <Breadcrumbs items={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Marketing and content' }]} />
            <h1 className="h1">Help and policies</h1>
          </div>
        </div>
        <Alert tone="info" title="You don’t have access to help content">
          Viewing help articles and policies needs the “View content” permission. A Platform Administrator can change your roles in Staff and permissions.
        </Alert>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout active="help-content">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Marketing and content' }]} />
          <h1 className="h1">Help and policies</h1>
          <p className="sub small">Content maintains articles; each policy has a business owner and an approval step</p>
        </div>
        <div className="actions">
          {canHelp && (
            <Button variant="secondary" size="sm" icon="plus" onClick={() => openEditor({ new: 'article' })}>
              New article
            </Button>
          )}
          {canPolicies && (
            <Button size="sm" icon="file-plus" to={href('admin/help-content', 'edit-policy')} onClick={(e) => (e.preventDefault(), openEditor({}))}>
              New policy version
            </Button>
          )}
        </div>
      </div>

      {summary.isError && <LoadError error={summary.error} onRetry={() => void summary.refetch()} />}

      <div className="ab-kpis k4">
        {sm ? (
          <>
            <div className="card pad">
              <Stat icon="book-open" label="Published articles" value={String(sm.publishedArticles)} note={`${sm.categories} categories`} />
            </div>
            <div className="card pad">
              <Stat icon="scale" label="Policies" value={String(sm.policies)} note={`${sm.policiesScheduled} scheduled · ${sm.policiesDraft} draft`} />
            </div>
            <div className="card pad">
              <Stat icon="clock" label="Articles needing review" value={String(sm.articlesNeedingReview)} note="Past their review date" />
            </div>
            <div className="card pad">
              <Stat icon="thumbs-up" label="Helpful rating" value={sm.helpfulPct != null ? `${Math.round(sm.helpfulPct)}%` : '—'} note={`Last ${sm.helpfulWindowDays ?? 30} days`} />
            </div>
          </>
        ) : (
          Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="card pad">
              <SkeletonLines rows={1} />
            </div>
          ))
        )}
      </div>

      <div className="card">
        <div className="u-p-0-sp-4">
          <Tabs items={tabs} active={tab} onChange={(v) => (setTab(v), setPage(1))} />
        </div>
        <div className="card-body u-pb-sp-3">
          <div className="toolbar">
            <SearchInput id="hc-q" placeholder="Search titles" value={q} onChange={(v) => (setQ(v), setPage(1))} />
            <Select id="hc-cat" aria-label="Category" options={[{ value: '', label: 'All categories' }, ...categories.map((c) => ({ value: c, label: c }))]} value={cat} onChange={(e) => (setCat(e.target.value), setPage(1))} />
          </div>
        </div>
        {items.isError && (
          <div className="card-body">
            <LoadError error={items.error} onRetry={() => void items.refetch()} />
          </div>
        )}
        <TableWrap label="Help and policies table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Type</th>
                <th scope="col">Category</th>
                <th scope="col">Owner</th>
                <th scope="col">Status</th>
                <th scope="col">Effective date</th>
                <th scope="col">Version</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.isPending && (
                <tr>
                  <td colSpan={8}>
                    <SkeletonLines rows={5} />
                  </td>
                </tr>
              )}
              {pageRows.map((r) => (
                <tr key={r.type + r.id}>
                  <td>
                    <a
                      className="strong"
                      href={href('admin/help-content', 'edit-policy')}
                      onClick={(e) => {
                        e.preventDefault();
                        open(r);
                      }}
                    >
                      {r.title}
                    </a>
                  </td>
                  <td>{r.type === 'policy' ? <Badge tone="info">Policy</Badge> : <Badge>Article</Badge>}</td>
                  <td>{r.category}</td>
                  <td>{r.owner.name}</td>
                  <td>
                    <StatusBadge status={STATUS[r.status] ?? r.status} />
                  </td>
                  <td>{r.effectiveAt ? date(r.effectiveAt) : '—'}</td>
                  <td>
                    <span className="mono nowrap" title={r.version}>
                      v{r.version}
                    </span>
                  </td>
                  <td>
                    {(r.type === 'policy' ? !canPolicies : !canHelp) ? null : (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => open(r)}>
                        <span>Edit</span>
                        <span className="sr-only"> {r.title}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {items.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    Nothing matches these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot">
          <span className="ab-note grow">Policies show their effective date publicly. Orders keep the terms accepted at purchase.</span>
          {rows.length > PAGE && <Pager page={page} total={Math.ceil(rows.length / PAGE)} onPage={setPage} />}
        </div>
      </div>
    </AdminLayout>
  );
}
