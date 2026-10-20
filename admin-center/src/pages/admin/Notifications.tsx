import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Card, Checkbox, Field, Icon, IconButton, KeyValue, LogoMark, PageHeader, SegmentedControl, Select, Stat, Switch, TableWrap, Textarea, TextInput } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, dateTime, actorLabel } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import {
  AUDIENCE_LABEL, changed, CHANNEL_LABEL, editorContent, EMAIL_FIELDS, emailContent, GROUPS, INAPP_FIELDS, inappContent, MONO_VARS, sampleOf,
  type Channel, type EditorContent, type Template, type TemplateContent, type TemplateDetail, type TemplateVersion, type Topic, type TopicMatrix,
} from './data/notifications';
import { ANNOUNCE_PERMISSION } from './data/seller-announcements';

// Design: pages/admin/admin-notifications.html · view "edit-template" = template editor (?view=edit-template&topic=<topic key>;
// without a topic it opens "customer.shipment.dispatched", the design's example). The editor edits the topic's email and
// in-app templates together: Save draft writes a draft version of each changed channel, Publish publishes them.

type Tab = 'email' | 'inapp';
type Device = 'desktop' | 'phone';
type FieldKey = keyof EditorContent;
interface Notice { tone: 'success' | 'danger'; title: string; text: ReactNode }

const FIELD_ID: Record<FieldKey, string> = { subject: 'nt-subject', preheader: 'nt-pre', body: 'nt-body', button: 'nt-btn', inappTitle: 'nt-ia-title', inappBody: 'nt-ia-body', inappLink: 'nt-ia-link' };
const VAR_RE = /(\{\{[a-z_.]+\}\})/g;
const DEFAULT_TOPIC = 'customer.shipment.dispatched';

/** Template text with sample values; references and tracking numbers in a mono span. */
function fill(text: string, sample: Record<string, string>): ReactNode {
  return text.split(VAR_RE).map((part, i) => {
    const m = /^\{\{([a-z_.]+)\}\}$/.exec(part);
    if (!m) return <Fragment key={i}>{part}</Fragment>;
    const v = sample[m[1]] ?? part;
    return MONO_VARS.includes(m[1]) ? (
      <span className="mono" key={i}>
        {v}
      </span>
    ) : (
      <Fragment key={i}>{v}</Fragment>
    );
  });
}
const fillText = (text: string, sample: Record<string, string>) => text.replace(/\{\{([a-z_.]+)\}\}/g, (all, k: string) => sample[k] ?? all);

type Block = { kind: 'kv'; pairs: Array<[string, string]> } | { kind: 'p'; lines: string[] };
const KV_LINE = /^([^:{}]{1,40}):\s+(\S.*)$/;

/** Message body → preview blocks: blank lines separate paragraphs, "Label: value" lines become a list. */
function parseBody(body: string): { blocks: Block[]; closing: string[] | null } {
  const blocks: Block[] = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const lines = b.split('\n').map((l) => l.trim());
      if (lines.every((l) => KV_LINE.test(l))) return { kind: 'kv', pairs: lines.map((l) => { const m = KV_LINE.exec(l)!; return [m[1], m[2]] as [string, string]; }) };
      return { kind: 'p', lines };
    });
  const last = blocks[blocks.length - 1];
  const closing = blocks.length > 1 && last.kind === 'p' ? (blocks.pop(), last.lines) : null;
  return { blocks, closing };
}

const lines = (ls: string[], sample: Record<string, string>) =>
  ls.map((l, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {fill(l, sample)}
    </Fragment>
  ));

const actorName = (a?: { name?: string | null; kind: string } | null) => actorLabel(a);

export default function Notifications() {
  const [view] = useView<'edit-template'>();
  const [params] = useSearchParams();
  const { api } = useApi();
  const qc = useQueryClient();
  const me = useStaffSession();
  const canView = me.can('notifications.templates.view');
  const canRoute = me.can('notifications.routing.manage');
  const canEdit = me.can('notifications.templates.edit');
  const canPublish = me.can('notifications.templates.publish');
  // Announcements to sellers are sent from Sellers › Announcements (the Seller Manager has no access to templates).
  const announcementsLink = me.can(ANNOUNCE_PERMISSION) ? (
    <Button variant="secondary" size="sm" icon="megaphone" to={href('admin/sellers', '', undefined, { filter: 'announcements' })}>
      Announcements to sellers
    </Button>
  ) : undefined;
  const [notice, setNotice] = useState<Notice | null>(null);
  const flash = (n: Notice) => {
    setNotice(n);
    announce(n.title);
  };

  const matrixQ = useQuery({ queryKey: ['notifications', 'topics'], queryFn: () => call(api.GET('/api/admin/notifications/topics')) as Promise<TopicMatrix>, enabled: canView });
  const matrix = matrixQ.data;

  /* ---------- matrix ---------- */

  const channelM = useMutation({
    mutationFn: (v: { topic: Topic; channel: Channel; on: boolean }) =>
      call(
        api.PUT('/api/admin/notifications/topics/{key}/channels', {
          params: { path: { key: v.topic.key } },
          body: { channels: v.topic.channels.map((c) => (c.channel === v.channel ? { ...c, enabled: v.on } : c)) },
        }),
      ),
    onSuccess: (_t, v) => {
      void qc.invalidateQueries({ queryKey: ['notifications', 'topics'] });
      announce(`${AUDIENCE_LABEL[v.topic.audience]} ${v.topic.label}: ${CHANNEL_LABEL[v.channel]} ${v.on ? 'on' : 'off'}`);
    },
    onError: (e, v) => flash({ tone: 'danger', title: `${v.topic.label}: ${CHANNEL_LABEL[v.channel]} wasn’t changed`, text: errorMessage(e) }),
  });

  const editLink = (t: Topic, className: string) => (
    <Link className={className} to={href('admin/notifications', 'edit-template', undefined, { topic: t.key })}>
      Edit template
    </Link>
  );
  const channelCell = (t: Topic, ch: Channel) => {
    const c = t.channels.find((x) => x.channel === ch);
    if (!c || !c.available) return <Badge>Later</Badge>;
    const pending = channelM.isPending && channelM.variables?.topic.key === t.key && channelM.variables.channel === ch;
    return (
      <input
        type="checkbox"
        aria-label={`${AUDIENCE_LABEL[t.audience]} ${t.label} ${CHANNEL_LABEL[ch]}`}
        checked={pending ? channelM.variables!.on : c.enabled}
        disabled={c.locked || !canRoute || pending}
        title={c.locked ? 'Always on for essential notices' : !canRoute ? 'Changing channels needs the “Manage routing” permission' : undefined}
        onChange={(x) => channelM.mutate({ topic: t, channel: ch, on: x.target.checked })}
      />
    );
  };

  /* ---------- editor ---------- */

  const topicKey = params.get('topic') ?? DEFAULT_TOPIC;
  const editing = view === 'edit-template';
  const tplListQ = useQuery({
    queryKey: ['notifications', 'templates', topicKey],
    queryFn: () => call(api.GET('/api/admin/notifications/templates', { params: { query: { topicKey, limit: 10 } } })),
    enabled: editing && canView,
  });
  const tplOf = (ch: Channel) => (tplListQ.data?.items as Template[] | undefined)?.find((t) => t.channel === ch);
  const emailTpl = tplOf('email');
  const inappTpl = tplOf('in_app');
  const emailQ = useQuery({
    queryKey: ['notifications', 'template', emailTpl?.id],
    queryFn: () => call(api.GET('/api/admin/notifications/templates/{id}', { params: { path: { id: emailTpl!.id } } })) as Promise<TemplateDetail>,
    enabled: editing && !!emailTpl,
  });
  const inappQ = useQuery({
    queryKey: ['notifications', 'template', inappTpl?.id],
    queryFn: () => call(api.GET('/api/admin/notifications/templates/{id}', { params: { path: { id: inappTpl!.id } } })) as Promise<TemplateDetail>,
    enabled: editing && !!inappTpl,
  });
  const email = emailQ.data;
  const inapp = inappQ.data;
  const topic = email?.topic ?? inapp?.topic;
  const loaded = useMemo(
    () => editorContent((email?.draft ?? email?.live)?.content, (inapp?.draft ?? inapp?.live)?.content),
    [email, inapp],
  );
  const [content, setContent] = useState<EditorContent>(loaded);
  const [allowPromo, setAllowPromo] = useState(false);
  const [channel, setChannel] = useState<Tab>('email');
  const [device, setDevice] = useState<Device>('desktop');
  const lastField = useRef<FieldKey | null>(null);
  useEffect(() => {
    setContent(loaded);
    setAllowPromo((email?.draft ?? email?.live)?.content.allowPromotionalContent ?? false);
  }, [loaded, email]);

  const set = (k: FieldKey, v: string) => setContent((c) => ({ ...c, [k]: v }));
  const focusField = (k: FieldKey) => () => {
    lastField.current = k;
  };
  const insertVar = (v: string) => {
    const key = lastField.current ?? (channel === 'email' ? 'body' : 'inappBody');
    const el = document.getElementById(FIELD_ID[key]) as HTMLInputElement | HTMLTextAreaElement | null;
    const cur = content[key];
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? start;
    const token = `{{${v}}}`;
    set(key, cur.slice(0, start) + token + cur.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const required = (topic?.variables ?? []).filter((v) => v.required).map((v) => v.name);
  const emailText = `${content.subject} ${content.body} ${content.button}`;
  const missing: Array<{ channel: string; where: string; vars: string[] }> = [];
  const missE = required.filter((r) => !emailText.includes(`{{${r}}}`));
  if (email && missE.length) missing.push({ channel: 'Email', where: 'Email message', vars: missE });
  const serverIssues = [...(email?.draft?.validation.issues ?? []), ...(inapp?.draft?.validation.issues ?? [])];

  const emailChanged = !!email && (changed(content, loaded, EMAIL_FIELDS) || allowPromo !== ((email.draft ?? email.live)?.content.allowPromotionalContent ?? false));
  const inappChanged = !!inapp && changed(content, loaded, INAPP_FIELDS);

  /** Writes the changed channels as drafts; returns the draft versions to publish. */
  const saveDrafts = async (all: boolean) => {
    const out: Array<{ templateId: string; version: TemplateVersion }> = [];
    const one = async (d: TemplateDetail, nextContent: TemplateContent, dirty: boolean) => {
      if (!dirty && !(all && d.draft)) return;
      let draft = d.draft;
      if (!draft) draft = (await call(api.POST('/api/admin/notifications/templates/{id}/versions', { params: { path: { id: d.template.id } }, body: {} }))) as TemplateVersion;
      if (dirty) draft = (await call(api.PATCH('/api/admin/notifications/templates/{id}/versions/{versionId}', { params: { path: { id: d.template.id, versionId: draft.id } }, body: { content: nextContent } }))) as TemplateVersion;
      out.push({ templateId: d.template.id, version: draft });
    };
    if (email) await one(email, { ...emailContent(content, (email.draft ?? email.live)!.content), allowPromotionalContent: allowPromo }, emailChanged);
    if (inapp) await one(inapp, inappContent(content, (inapp.draft ?? inapp.live)!.content), inappChanged);
    return out;
  };
  const invalidateTpl = () => void qc.invalidateQueries({ queryKey: ['notifications', 'template'] });

  const saveM = useMutation({
    mutationFn: () => saveDrafts(false),
    onSuccess: (saved) => {
      invalidateTpl();
      const bad = saved.filter((s) => !s.version.validation.ok);
      flash(
        saved.length
          ? { tone: 'success', title: `Version ${saved.map((s) => s.version.version).join(' and ')} saved as a draft`, text: bad.length ? 'The draft has problems to fix before it can be published (see Variables).' : 'Recipients keep getting the published version until you publish this one.' }
          : { tone: 'success', title: 'Nothing to save', text: 'The template has no changes.' },
      );
    },
    onError: (e) => flash({ tone: 'danger', title: 'The draft wasn’t saved', text: errorMessage(e) }),
  });
  const publishM = useMutation({
    mutationFn: async () => {
      const drafts = await saveDrafts(true);
      const bad = drafts.filter((d) => !d.version.validation.ok);
      if (bad.length) throw new Error(bad.flatMap((d) => d.version.validation.issues.map((i) => i.message)).join(' '));
      const done: TemplateVersion[] = [];
      for (const d of drafts) done.push((await call(api.POST('/api/admin/notifications/templates/{id}/versions/{versionId}/publish', { params: { path: { id: d.templateId, versionId: d.version.id } }, body: {} }))) as TemplateVersion);
      return done;
    },
    onSuccess: (done) => {
      invalidateTpl();
      void qc.invalidateQueries({ queryKey: ['notifications', 'templates'] });
      flash(
        done.length
          ? { tone: 'success', title: `Version ${done.map((v) => v.version).join(' and ')} published`, text: `${topic?.label ?? 'This notice'} now uses the new version for every new notice.` }
          : { tone: 'success', title: 'Nothing to publish', text: 'The live version already matches the editor.' },
      );
    },
    onError: (e) => flash({ tone: 'danger', title: 'Not published', text: e instanceof ApiError ? errorMessage(e) : e.message }),
  });
  const restoreM = useMutation({
    mutationFn: (versionId: string) => call(api.POST('/api/admin/notifications/templates/{id}/versions', { params: { path: { id: email!.template.id } }, body: { fromVersionId: versionId } })) as Promise<TemplateVersion>,
    onSuccess: (v) => {
      invalidateTpl();
      flash({ tone: 'success', title: `Version ${v.version} started from an older version`, text: 'It is a draft. Publish it to use it.' });
    },
    onError: (e) => flash({ tone: 'danger', title: 'The version wasn’t restored', text: errorMessage(e) }),
  });
  const testM = useMutation({
    mutationFn: () => {
      const v = email!.draft ?? email!.live!;
      return call(api.POST('/api/admin/notifications/templates/{id}/versions/{versionId}/test-send', { params: { path: { id: email!.template.id, versionId: v.id } }, body: {} }));
    },
    onSuccess: () => flash({ tone: 'success', title: `Test sent to ${me.email}`, text: `The ${email?.draft ? 'draft' : 'live'} email version uses the sample values shown in the preview. Save a draft first to test unsaved edits.` }),
    onError: (e) => flash({ tone: 'danger', title: 'The test wasn’t sent', text: errorMessage(e) }),
  });

  if (!canView) {
    return (
      <AdminLayout active="notifications">
        <PageHeader crumbs={[{ label: 'Reports and settings' }, { label: 'Notifications' }]} title="Notification templates" actions={announcementsLink} />
        <Alert tone="info" title="You don’t have access to notification templates">
          Viewing templates needs the “View templates” permission. Ask a Platform Administrator.
        </Alert>
      </AdminLayout>
    );
  }

  if (editing) {
    const loadErr = tplListQ.error ?? emailQ.error ?? inappQ.error;
    const notFound = tplListQ.isSuccess && !emailTpl && !inappTpl;
    const { blocks, closing } = parseBody(content.body);
    const buttonLabel = content.button.split('→')[0].trim();
    const audience = AUDIENCE_LABEL[topic?.audience ?? ''] ?? '';
    const sample = sampleOf(topic);
    const essential = topic?.category === 'essential';
    const live = email?.live ?? inapp?.live;
    const nextN = Math.max(email?.draft?.version ?? (email?.live?.version ?? 0) + 1, inapp?.draft?.version ?? 0);
    const busy = saveM.isPending || publishM.isPending;
    return (
      <AdminLayout active="notifications">
        <PageHeader
          crumbs={[{ label: 'Notification templates', to: href('admin/notifications') }, { label: audience || 'Template' }, { label: topic?.label ?? '' }]}
          title={`Edit template: ${topic?.label ?? ''}`}
          sub={topic ? `${audience} · ${essential ? 'Essential' : 'Promotional'} · version ${live?.version ?? 1} published ${live?.publishedAt ? dateTime(live.publishedAt) : ''} by ${actorName(live?.publishedBy)}` : undefined}
          actions={
            <>
              {email && canEdit && (
                <Button variant="secondary" size="sm" icon="send" onClick={() => testM.mutate()} disabled={testM.isPending}>
                  Send test to {me.email}
                </Button>
              )}
              {canEdit && (
                <Button variant="secondary" size="sm" onClick={() => saveM.mutate()} disabled={busy || !(emailChanged || inappChanged)}>
                  Save draft
                </Button>
              )}
              {canPublish && (
                <Button size="sm" onClick={() => publishM.mutate()} disabled={busy || missing.length > 0}>
                  Publish version {nextN}
                </Button>
              )}
            </>
          }
        />
        {!canEdit && (
          <Alert tone="info" title="View only">
            Editing templates needs the “Edit templates” permission, and publishing needs “Publish templates”.
          </Alert>
        )}
        {notice && (
          <Alert tone={notice.tone} title={notice.title}>
            {notice.text}
          </Alert>
        )}
        {loadErr ? (
          <LoadError error={loadErr} onRetry={() => void (tplListQ.isError ? tplListQ.refetch() : emailQ.isError ? emailQ.refetch() : inappQ.refetch())} />
        ) : notFound ? (
          <Alert tone="warning" title="Template not found">
            There is no template for “{topicKey}”. <Link to={href('admin/notifications')}>Back to notification templates</Link>
          </Alert>
        ) : !topic ? (
          <div className="split half">
            <Card title="Content">
              <SkeletonLines rows={5} />
            </Card>
            <Card title="Preview" titleAs="h3">
              <SkeletonLines rows={5} />
            </Card>
          </div>
        ) : (
          <div className="split half">
            <div className="stack gap-5">
              <Card
                title="Content"
                actions={
                  <SegmentedControl<Tab>
                    items={[
                      ...(email ? [{ label: 'Email', value: 'email' as Tab }] : []),
                      ...(inapp ? [{ label: 'In-app', value: 'inapp' as Tab }] : []),
                    ]}
                    active={email ? channel : 'inapp'}
                    onChange={(c) => {
                      setChannel(c);
                      lastField.current = null;
                    }}
                  />
                }
              >
                {email && channel === 'email' ? (
                  <>
                    <Field label="Subject" hint={`${content.subject.length} characters. Keep under 60 so phones show it in full.`}>
                      <TextInput id="nt-subject" value={content.subject} readOnly={!canEdit} onChange={(e) => set('subject', e.target.value)} onFocus={focusField('subject')} />
                    </Field>
                    <Field label="Preview text">
                      <TextInput id="nt-pre" value={content.preheader} readOnly={!canEdit} onChange={(e) => set('preheader', e.target.value)} onFocus={focusField('preheader')} />
                    </Field>
                    <Field label="Message" hint="Plain language. Do not say the package is delivered or in transit until the carrier confirms a scan.">
                      <Textarea id="nt-body" value={content.body} readOnly={!canEdit} onChange={(e) => set('body', e.target.value)} onFocus={focusField('body')} />
                    </Field>
                    <Field label="Button" hint="Button text → link, e.g. Track package → {{link.url}}">
                      <TextInput id="nt-btn" value={content.button} readOnly={!canEdit} onChange={(e) => set('button', e.target.value)} onFocus={focusField('button')} />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="Title">
                      <TextInput id="nt-ia-title" value={content.inappTitle} readOnly={!canEdit} onChange={(e) => set('inappTitle', e.target.value)} onFocus={focusField('inappTitle')} />
                    </Field>
                    <Field label="Message">
                      <Textarea id="nt-ia-body" value={content.inappBody} readOnly={!canEdit} onChange={(e) => set('inappBody', e.target.value)} onFocus={focusField('inappBody')} />
                    </Field>
                    <Field label="Opens" hint={`The screen the notice opens when tapped (${topic.opens}).`}>
                      <TextInput id="nt-ia-link" value={content.inappLink} readOnly={!canEdit} onChange={(e) => set('inappLink', e.target.value)} onFocus={focusField('inappLink')} />
                    </Field>
                  </>
                )}
              </Card>

              <Card title="Variables" titleAs="h3" sub="Click to insert at the cursor">
                <div className="row gap-2">
                  {topic.variables.map((v) => (
                    <button type="button" className="ac-varbtn" key={v.name} title={v.desc} disabled={!canEdit} onMouseDown={(e) => e.preventDefault()} onClick={() => insertVar(v.name)}>
                      {`{{${v.name}}}`}
                    </button>
                  ))}
                </div>
                {missing.map((m) => (
                  <Alert tone="warning" title={`Required variable missing in ${m.channel} version`} key={m.channel}>
                    The {m.where} does not include{' '}
                    {m.vars.map((v) => (
                      <span className="ac-var" key={v}>{`{{${v}}}`}</span>
                    ))}
                    . Every notice must link to its record.
                  </Alert>
                ))}
                {serverIssues.map((i, n) => (
                  <Alert tone="warning" title="Draft needs a fix" key={n}>
                    {i.message}
                  </Alert>
                ))}
              </Card>

              <Card title="Settings" titleAs="h3">
                <div className="ac-fgrid">
                  <Field label="Language">
                    <Select id="nt-lang" options={[email?.template.language ?? inapp?.template.language ?? 'en-US']} disabled />
                  </Field>
                  <Field label="Sender">
                    <Select id="nt-from" options={[(email?.draft ?? email?.live)?.content.sender ?? 'Marketly']} disabled />
                  </Field>
                </div>
                <Switch id="nt-ess" label="Essential notice: recipients cannot unsubscribe" checked={essential} aria-checked={essential} data-switch="" disabled onChange={() => undefined} />
                <Checkbox id="nt-ads" label="Allow promotional content in this email" checked={allowPromo} disabled={essential || !canEdit || !email} onChange={(e) => setAllowPromo(e.target.checked)} />
                <span className="xs muted">Promotional content is blocked in essential notices. Whether a notice is essential is set by its topic.</span>
              </Card>
            </div>

            <div className="stack gap-4">
              <div className="row between">
                <h2 className="h4">Preview</h2>
                <SegmentedControl<Device>
                  items={[
                    { label: 'Desktop', value: 'desktop', icon: 'monitor' },
                    { label: 'Phone', value: 'phone', icon: 'smartphone' },
                  ]}
                  active={device}
                  onChange={setDevice}
                />
              </div>
              {email && (
                <div className="ac-email">
                  <div className="ac-mail" style={device === 'phone' ? { maxWidth: 360 } : undefined}>
                    <div className="ac-mail-top">
                      <Link className="logo" to={href('store/home')}>
                        <LogoMark />
                        <span>Marketly</span>
                      </Link>
                      {sample['order.ref'] && <span className="xs muted">Order {sample['order.ref']}</span>}
                    </div>
                    <div className="ac-mail-body">
                      <h3 className="h3">{fillText(content.subject, sample)}</h3>
                      {blocks.map((b, i) => (b.kind === 'kv' ? <KeyValue key={i} pairs={b.pairs.map(([k, v]) => [k, fill(v, sample)])} /> : <p key={i}>{lines(b.lines, sample)}</p>))}
                      {buttonLabel && (
                        <span>
                          <Button size="sm">{fillText(buttonLabel, sample)}</Button>
                        </span>
                      )}
                      {closing && <p className="xs sub">{lines(closing, sample)}</p>}
                    </div>
                    <div className="ac-mail-foot">
                      {essential
                        ? "This is an essential update. You can't unsubscribe from order updates. Manage promotional emails in Account › Notifications."
                        : 'You get this email because you opted in to Marketly emails. Unsubscribe or manage promotional emails in Account › Notifications.'}
                    </div>
                  </div>
                </div>
              )}

              {inapp && (
                <Card title="In-app preview" titleAs="h3">
                  <div className="row gap-3 nowrap top">
                    <IconButton icon="bell" label="Notice" />
                    <span className="stack gap-0 grow">
                      <span className="small strong">{fillText(content.inappTitle, sample)}</span>
                      <span className="xs sub">{fillText(content.inappBody, sample)}</span>
                      <span className="xs muted">Just now</span>
                    </span>
                  </div>
                </Card>
              )}

              <Card title="Version history" titleAs="h3" flush>
                <ul className="list pad">
                  {(email ?? inapp)!.versions.map((v) => (
                    <li key={v.id}>
                      <span className="grow stack gap-0">
                        <span className="small strong">
                          Version {v.version}
                          {v.status === 'draft' && ' · draft'}
                        </span>
                        <span className="xs muted">{[actorName(v.by), dateTime(v.at), v.note, v.status === 'published' ? 'live' : undefined].filter(Boolean).join(' · ')}</span>
                      </span>
                      {v.status === 'draft' ? (
                        <Badge>Draft</Badge>
                      ) : v.status === 'published' ? (
                        <Badge tone="success">Published</Badge>
                      ) : v.status === 'discarded' ? (
                        <Badge>Discarded</Badge>
                      ) : canEdit && email && !email.draft ? (
                        <Button variant="ghost" size="sm" onClick={() => restoreM.mutate(v.id)} disabled={restoreM.isPending}>
                          Restore
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        )}
      </AdminLayout>
    );
  }

  const stats = matrix?.stats;
  const promos = matrix?.promotional ?? [];
  const pct = (n?: number | null) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);

  return (
    <AdminLayout active="notifications">
      <PageHeader
        crumbs={[{ label: 'Reports and settings' }, { label: 'Notifications' }]}
        title="Notification templates"
        sub="Who is told what, on which channel. Every notice links to the order, case or action it is about."
        actions={announcementsLink}
      />
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.text}
        </Alert>
      )}
      {!canRoute && (
        <Alert tone="info" title="View only">
          Turning channels on or off needs the “Manage routing” permission.
        </Alert>
      )}
      <div className="ac-kpis">
        <div className="card pad">{stats ? <Stat label="Essential events" value={stats.essentialTopics} note="customers, sellers, staff" /> : <SkeletonLines rows={1} />}</div>
        <div className="card pad">{stats ? <Stat label="Channels live" value={String(stats.channelsLive.length)} note={stats.channelsLive.map((c) => CHANNEL_LABEL[c as Channel] ?? c).join(', ')} /> : <SkeletonLines rows={1} />}</div>
        <div className="card pad">
          {stats ? (
            <Stat label="Email delivery, 7 days" value={pct(stats.emailDeliveryRate7d)} {...(stats.emailDeliveryRateDelta != null ? { delta: `${Math.abs(stats.emailDeliveryRateDelta * 100).toFixed(1)} pts`, dir: stats.emailDeliveryRateDelta >= 0 ? 'up' : 'down', good: stats.emailDeliveryRateDelta >= 0 } : { note: 'no change data yet' })} />
          ) : (
            <SkeletonLines rows={1} />
          )}
        </div>
        <div className="card pad">{stats ? <Stat label="Bounced or blocked" value={stats.bouncedOrBlocked} note="shown on customer record" /> : <SkeletonLines rows={1} />}</div>
      </div>
      <Alert tone="info" title="Essential and promotional messages are separate">
        Customers and sellers cannot turn off essential order, payment, return and account notices. Promotional messages follow their own consent and preferences. SMS and push come later; push will matter for the Android app.
      </Alert>

      {matrixQ.isError && <LoadError error={matrixQ.error} onRetry={() => void matrixQ.refetch()} />}

      {GROUPS.map((g, gi) => {
        const rows = (matrix?.[g.audience] ?? []) as Topic[];
        return (
          <Card
            key={g.audience}
            flush
            titleAs={gi === 0 ? 'h2' : 'h3'}
            title={
              <span className="row gap-2 nowrap">
                <Icon name={g.icon} className="ic-sm" />
                {g.title}
              </span>
            }
            sub={g.sub}
          >
            <div className="ac-matrix no-phone">
              <TableWrap label={`${g.title} table`}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Event</th>
                      <th scope="col">Type</th>
                      <th className="c" scope="col">
                        In-app
                      </th>
                      <th className="c" scope="col">
                        Email
                      </th>
                      <th className="c" scope="col">
                        SMS
                      </th>
                      <th className="c" scope="col">
                        Push
                      </th>
                      <th scope="col">Opens</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrixQ.isPending && (
                      <tr>
                        <td colSpan={8}>
                          <SkeletonLines rows={3} />
                        </td>
                      </tr>
                    )}
                    {rows.map((t) => (
                      <tr key={t.key}>
                        <td>
                          <span className="small strong" title={t.description}>
                            {t.label}
                          </span>
                        </td>
                        <td>
                          {t.category === 'essential' ? (
                            <Badge tone="info" icon="lock">
                              Essential
                            </Badge>
                          ) : (
                            <Badge tone="outline">{t.actionRequired ? 'Action needed' : 'Optional'}</Badge>
                          )}
                        </td>
                        <td className="c">{channelCell(t, 'in_app')}</td>
                        <td className="c">{channelCell(t, 'email')}</td>
                        <td className="c">{channelCell(t, 'sms')}</td>
                        <td className="c">{channelCell(t, 'push')}</td>
                        <td>
                          <span className="xs sub">{t.opens}</span>
                        </td>
                        <td>{editLink(t, 'small strong nowrap')}</td>
                      </tr>
                    ))}
                    {matrixQ.isSuccess && !rows.length && (
                      <tr>
                        <td colSpan={8}>
                          <span className="small muted">No notices for this audience.</span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </TableWrap>
            </div>
            <div className="ac-mlist only-phone">
              {matrixQ.isPending && <SkeletonLines rows={3} />}
              {rows.map((t) => {
                const on = t.channels.filter((c) => c.available && c.enabled).map((c) => CHANNEL_LABEL[c.channel]);
                return (
                  <div className="ac-mi" key={t.key}>
                    <div className="row between gap-2 nowrap top">
                      <span className="small strong min-w-0">{t.label}</span>
                      {t.category === 'essential' ? <Badge tone="info">Essential</Badge> : <Badge tone="outline">Optional</Badge>}
                    </div>
                    <div className="xs sub">
                      {on.length ? on.join(' and ') : 'Off'} · opens {t.opens}
                    </div>
                    <div className="row gap-2 mt-1-5">{editLink(t, 'small strong')}</div>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      <Card flush titleAs="h3" title="Promotional messages" sub="Sent only to people who opted in. Never mixed into essential notices.">
        <div className="no-phone">
          <TableWrap label="Promotional messages table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Message</th>
                  <th scope="col">Audience</th>
                  <th scope="col">Frequency</th>
                  <th scope="col">Consent</th>
                  <th className="c" scope="col">
                    Email
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {matrixQ.isPending && (
                  <tr>
                    <td colSpan={6}>
                      <SkeletonLines rows={2} />
                    </td>
                  </tr>
                )}
                {promos.map((p) => (
                  <tr key={p.key}>
                    <td>
                      <span className="small strong">{p.label}</span>
                    </td>
                    <td>{AUDIENCE_LABEL[p.audience] ?? p.audience}</td>
                    <td>
                      <span className="small">{p.frequencyLabel ?? '—'}</span>
                    </td>
                    <td>
                      <Badge tone="outline">Opt-in required</Badge>
                    </td>
                    <td className="c">{channelCell(p, 'email')}</td>
                    <td>{editLink(p, 'small strong')}</td>
                  </tr>
                ))}
                {matrixQ.isSuccess && !promos.length && (
                  <tr>
                    <td colSpan={6}>
                      <span className="small muted">No promotional messages.</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        </div>
        <div className="ac-mlist only-phone">
          {promos.map((p) => (
            <div className="ac-mi" key={p.key}>
              <div className="row between gap-2 nowrap top">
                <span className="small strong min-w-0">{p.label}</span>
                <Badge tone="outline">Opt-in</Badge>
              </div>
              <div className="xs sub">
                {AUDIENCE_LABEL[p.audience] ?? p.audience} · {p.frequencyLabel ?? 'as needed'}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </AdminLayout>
  );
}
