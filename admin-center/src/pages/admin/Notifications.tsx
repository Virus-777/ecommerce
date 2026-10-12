import { Fragment, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Card, Checkbox, Field, Icon, IconButton, Img, KeyValue, LogoMark, PageHeader, SegmentedControl, Select, Stat, Switch, TableWrap, Textarea, TextInput } from '@marketly/web-shared/ui';
import {
  EVENTS, GROUPS, initialTemplate, ME, MONO_VARS, PROMOS, SAMPLE, SAMPLE_ITEM, SAMPLE_SHORT, STAFF_TITLE, TEST_EMAIL, VARIABLES,
  type NoticeEvent, type PromoMessage, type TemplateContent, type TemplateState, type Version,
} from './data/notifications';

// Design: pages/admin/admin-notifications.html · view "edit-template" = template editor for "Dispatched, with tracking".
// The design file's h1 is already "Notification templates" (matches the sidebar label, REVIEW #2).

type Channel = 'email' | 'inapp';
type Device = 'desktop' | 'phone';
type FieldKey = keyof TemplateContent;
interface Notice { tone: 'success' | 'danger'; title: string; text: ReactNode }

const FIELD_ID: Record<FieldKey, string> = { subject: 'nt-subject', preheader: 'nt-pre', body: 'nt-body', button: 'nt-btn', inappTitle: 'nt-ia-title', inappBody: 'nt-ia-body', inappLink: 'nt-ia-link' };
const VAR_RE = /(\{\{[a-z_.]+\}\})/g;

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

type Block = { kind: 'items' } | { kind: 'kv'; pairs: Array<[string, string]> } | { kind: 'p'; lines: string[] };
const KV_LINE = /^([^:{}]{1,40}):\s+(\S.*)$/;

/** Message body → preview blocks: blank lines separate paragraphs, "Label: value" lines become a list, {{package.items}} alone shows the items. */
function parseBody(body: string): { blocks: Block[]; closing: string[] | null } {
  const blocks: Block[] = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      if (b === '{{package.items}}') return { kind: 'items' };
      const lines = b.split('\n').map((l) => l.trim());
      if (lines.every((l) => KV_LINE.test(l))) return { kind: 'kv', pairs: lines.map((l) => { const m = KV_LINE.exec(l)!; return [m[1], m[2]] as [string, string]; }) };
      return { kind: 'p', lines };
    });
  // The closing paragraph sits under the button as small print.
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

const shortName = (name: string) => name.split(',')[0];
const now = () => `today ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;

export default function Notifications() {
  const [view] = useView<'edit-template'>();
  const [events, setEvents] = useState<NoticeEvent[]>(EVENTS);
  const [promos, setPromos] = useState<PromoMessage[]>(PROMOS);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Editor: the design's edit-template view is "Dispatched, with tracking".
  const [editId, setEditId] = useState('c-dispatched');
  const [templates, setTemplates] = useState<Record<string, TemplateState>>({});
  const [content, setContent] = useState<TemplateContent>(() => initialTemplate('Dispatched, with tracking', 'c-dispatched', false).versions[0].content);
  const [essential, setEssential] = useState(true);
  const [allowPromo, setAllowPromo] = useState(false);
  const [channel, setChannel] = useState<Channel>('email');
  const [device, setDevice] = useState<Device>('desktop');
  const lastField = useRef<FieldKey | null>(null);

  const flash = (n: Notice) => {
    setNotice(n);
    announce(n.title);
  };

  const editingEvent = events.find((e) => e.id === editId);
  const editingPromo = promos.find((p) => p.id === editId);
  const target = editingEvent ?? editingPromo ?? events[2];
  const isPromo = !editingEvent && !!editingPromo;
  const tplOf = (id: string, name: string, promo: boolean) => templates[id] ?? initialTemplate(name, id, promo);
  const tpl = tplOf(target.id, target.name, isPromo);

  const openTemplate = (id: string, name: string, promo: boolean) => {
    const t = tplOf(id, name, promo);
    setEditId(id);
    setContent({ ...t.versions[0].content });
    setEssential(t.essential);
    setAllowPromo(t.promo);
    setChannel('email');
    lastField.current = null;
    setNotice(null);
  };

  /* ---------- matrix ---------- */

  const toggleEmail = (id: string, on: boolean) => {
    setEvents((l) => l.map((e) => (e.id === id ? { ...e, email: on } : e)));
    const e = events.find((x) => x.id === id);
    if (e) announce(`${e.audience} ${e.name}: email ${on ? 'on' : 'off'}`);
  };
  const togglePromo = (id: string, on: boolean) => setPromos((l) => l.map((p) => (p.id === id ? { ...p, email: on } : p)));
  const editLink = (id: string, name: string, promo: boolean, className: string) => (
    <Link className={className} to={href('admin/notifications', 'edit-template')} onClick={() => openTemplate(id, name, promo)}>
      Edit template
    </Link>
  );

  /* ---------- editor ---------- */

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

  const emailText = `${content.body} ${content.button}`;
  const inappText = `${content.inappTitle} ${content.inappBody} ${content.inappLink}`;
  const missing: Array<{ channel: string; where: string }> = [];
  if (!emailText.includes('{{order.url}}') && !emailText.includes('{{tracking.url}}')) missing.push({ channel: 'Email', where: 'Email message' });
  if (!inappText.includes('{{order.url}}')) missing.push({ channel: 'In-app', where: 'In-app message' });

  const published = tpl.versions.find((v) => v.status === 'Published');
  const draftVersion = tpl.versions.find((v) => v.status === 'Draft');
  const nextN = draftVersion ? draftVersion.n : Math.max(...tpl.versions.map((v) => v.n)) + 1;

  const store = (versions: Version[]) => setTemplates((t) => ({ ...t, [target.id]: { versions, essential, promo: allowPromo } }));
  const saveDraft = () => {
    const v: Version = { n: nextN, who: ME, when: now(), note: draftVersion?.note ?? 'draft saved', status: 'Draft', content: { ...content } };
    store(draftVersion ? tpl.versions.map((x) => (x.status === 'Draft' ? v : x)) : [v, ...tpl.versions]);
    flash({ tone: 'success', title: `Version ${nextN} saved as a draft`, text: 'Customers keep getting the published version until you publish this one.' });
  };
  const publish = () => {
    if (missing.length) {
      flash({
        tone: 'danger',
        title: `Version ${nextN} not published`,
        text: (
          <>
            Add <span className="ac-var">{'{{order.url}}'}</span> to the {missing.map((m) => m.where).join(' and ')} first. Every notice must link to its order.
          </>
        ),
      });
      return;
    }
    const v: Version = { n: nextN, who: ME, when: now(), note: draftVersion?.note, status: 'Published', content: { ...content } };
    const rest = tpl.versions.filter((x) => x.status !== 'Draft').map((x) => (x.status === 'Published' ? { ...x, status: '' as const } : x));
    store([v, ...rest]);
    flash({ tone: 'success', title: `Version ${nextN} published`, text: `${target.name} now uses version ${nextN} for every new notice.` });
  };
  const restore = (v: Version) => {
    setContent({ ...v.content });
    flash({ tone: 'success', title: `Version ${v.n} loaded into the editor`, text: 'Save a draft or publish to use it.' });
  };
  const sendTest = () => flash({ tone: 'success', title: `Test sent to ${TEST_EMAIL}`, text: 'Email and in-app versions use the sample order MK-261008-12544.' });

  if (view === 'edit-template') {
    const { blocks, closing } = parseBody(content.body);
    const buttonLabel = content.button.split('→')[0].trim();
    const audience = target.audience;
    return (
      <AdminLayout active="notifications">
        <PageHeader
          crumbs={[{ label: 'Notification templates', to: href('admin/notifications') }, { label: audience }, { label: shortName(target.name) }]}
          title={`Edit template: ${target.name}`}
          sub={`${audience} · ${isPromo ? 'Promotional' : 'Essential'} · version ${published?.n ?? 1} published ${published?.when ?? ''} by ${published?.who ?? ''}, ${STAFF_TITLE[published?.who ?? ''] ?? ''}`}
          actions={
            <>
              <Button variant="secondary" size="sm" icon="send" onClick={sendTest}>
                Send test to {TEST_EMAIL}
              </Button>
              <Button variant="secondary" size="sm" onClick={saveDraft}>
                Save draft
              </Button>
              <Button size="sm" onClick={publish}>
                Publish version {nextN}
              </Button>
            </>
          }
        />
        {notice && (
          <Alert tone={notice.tone} title={notice.title}>
            {notice.text}
          </Alert>
        )}
        <div className="split half">
          <div className="stack gap-5">
            <Card
              title="Content"
              actions={
                <SegmentedControl<Channel>
                  items={[
                    { label: 'Email', value: 'email' },
                    { label: 'In-app', value: 'inapp' },
                  ]}
                  active={channel}
                  onChange={(c) => {
                    setChannel(c);
                    lastField.current = null;
                  }}
                />
              }
            >
              {channel === 'email' ? (
                <>
                  <Field label="Subject" hint={`${content.subject.length} characters. Keep under 60 so phones show it in full.`}>
                    <TextInput id="nt-subject" value={content.subject} onChange={(e) => set('subject', e.target.value)} onFocus={focusField('subject')} />
                  </Field>
                  <Field label="Preview text">
                    <TextInput id="nt-pre" value={content.preheader} onChange={(e) => set('preheader', e.target.value)} onFocus={focusField('preheader')} />
                  </Field>
                  <Field label="Message" hint="Plain language. Do not say the package is delivered or in transit until the carrier confirms a scan.">
                    <Textarea id="nt-body" value={content.body} onChange={(e) => set('body', e.target.value)} onFocus={focusField('body')} />
                  </Field>
                  <Field label="Button">
                    <TextInput id="nt-btn" value={content.button} onChange={(e) => set('button', e.target.value)} onFocus={focusField('button')} />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Title">
                    <TextInput id="nt-ia-title" value={content.inappTitle} onChange={(e) => set('inappTitle', e.target.value)} onFocus={focusField('inappTitle')} />
                  </Field>
                  <Field label="Message">
                    <Textarea id="nt-ia-body" value={content.inappBody} onChange={(e) => set('inappBody', e.target.value)} onFocus={focusField('inappBody')} />
                  </Field>
                  <Field label="Opens" hint="The screen the notice opens when tapped.">
                    <TextInput id="nt-ia-link" value={content.inappLink} onChange={(e) => set('inappLink', e.target.value)} onFocus={focusField('inappLink')} />
                  </Field>
                </>
              )}
            </Card>

            <Card title="Variables" titleAs="h3" sub="Click to insert at the cursor">
              <div className="row gap-2">
                {VARIABLES.map((v) => (
                  <button type="button" className="ac-varbtn" key={v} onMouseDown={(e) => e.preventDefault()} onClick={() => insertVar(v)}>
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
              {missing.map((m) => (
                <Alert tone="warning" title={`Required variable missing in ${m.channel} version`} key={m.channel}>
                  The {m.where} does not include <span className="ac-var">{'{{order.url}}'}</span>. Every notice must link to its order.
                </Alert>
              ))}
            </Card>

            <Card title="Settings" titleAs="h3">
              <div className="ac-fgrid">
                <Field label="Language">
                  <Select id="nt-lang" options={['English (US)']} />
                </Field>
                <Field label="Sender">
                  <Select id="nt-from" options={['Marketly Orders <orders@marketly.example>']} />
                </Field>
              </div>
              <Switch id="nt-ess" label="Essential notice: recipients cannot unsubscribe" checked={essential} aria-checked={essential} data-switch="" onChange={(e) => setEssential(e.target.checked)} />
              <Checkbox id="nt-ads" label="Allow promotional content in this email" checked={allowPromo} onChange={(e) => setAllowPromo(e.target.checked)} />
              <span className="xs muted">Promotional content is blocked in essential notices.</span>
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
            <div className="ac-email">
              <div className="ac-mail" style={device === 'phone' ? { maxWidth: 360 } : undefined}>
                <div className="ac-mail-top">
                  <Link className="logo" to={href('store/home')}>
                    <LogoMark />
                    <span>Marketly</span>
                  </Link>
                  <span className="xs muted">Order {SAMPLE['order.ref']}</span>
                </div>
                <div className="ac-mail-body">
                  <h3 className="h3">{fillText(content.subject, SAMPLE)}</h3>
                  {blocks.map((b, i) =>
                    b.kind === 'items' ? (
                      <div className="row gap-3 nowrap panel" key={i}>
                        <Img icon={SAMPLE_ITEM.icon} tint={SAMPLE_ITEM.tint} className="tiny" />
                        <span className="stack gap-0 grow">
                          <span className="small strong">{SAMPLE_ITEM.name}</span>
                          <span className="xs muted">{SAMPLE_ITEM.meta}</span>
                        </span>
                      </div>
                    ) : b.kind === 'kv' ? (
                      <KeyValue key={i} pairs={b.pairs.map(([k, v]) => [k, fill(v, SAMPLE)])} />
                    ) : (
                      <p key={i}>{lines(b.lines, SAMPLE)}</p>
                    ),
                  )}
                  {buttonLabel && (
                    <span>
                      <Button size="sm">{fillText(buttonLabel, SAMPLE)}</Button>
                    </span>
                  )}
                  {closing && <p className="xs sub">{lines(closing, SAMPLE)}</p>}
                </div>
                <div className="ac-mail-foot">
                  {essential
                    ? "This is an essential order update for jordan.lee@example.com. You can't unsubscribe from order updates. Manage promotional emails in Account › Notifications. Marketly, Inc. · Portland, OR"
                    : 'You get this email because jordan.lee@example.com opted in to Marketly emails. Unsubscribe or manage promotional emails in Account › Notifications. Marketly, Inc. · Portland, OR'}
                </div>
              </div>
            </div>

            <Card title="In-app preview" titleAs="h3">
              <div className="row gap-3 nowrap top">
                <IconButton icon="truck" label="Shipment" />
                <span className="stack gap-0 grow">
                  <span className="small strong">{fillText(content.inappTitle, SAMPLE_SHORT)}</span>
                  <span className="xs sub">{fillText(content.inappBody, SAMPLE_SHORT)}</span>
                  <span className="xs muted">Just now</span>
                </span>
              </div>
            </Card>

            <Card title="Version history" titleAs="h3" flush>
              <ul className="list pad">
                {tpl.versions.map((v) => (
                  <li key={v.n}>
                    <span className="grow stack gap-0">
                      <span className="small strong">
                        Version {v.n}
                        {v.status === 'Draft' && ' · draft'}
                      </span>
                      <span className="xs muted">{[v.who, v.when, v.note, v.status === 'Published' ? 'live' : undefined].filter(Boolean).join(' · ')}</span>
                    </span>
                    {v.status === 'Draft' ? (
                      <Badge>Draft</Badge>
                    ) : v.status === 'Published' ? (
                      <Badge tone="success">Published</Badge>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => restore(v)}>
                        Restore
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout active="notifications">
      <PageHeader
        crumbs={[{ label: 'Reports and settings' }, { label: 'Notifications' }]}
        title="Notification templates"
        sub="Who is told what, on which channel. Every notice links to the order, case or action it is about."
        actions={
          <Button variant="secondary" size="sm" icon="send" onClick={() => flash({ tone: 'success', title: `Test notice sent to ${TEST_EMAIL}`, text: 'Check the in-app inbox and email for the sample order MK-261008-12544.' })}>
            Send test notice
          </Button>
        }
      />
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.text}
        </Alert>
      )}
      <div className="ac-kpis">
        <div className="card pad">
          <Stat label="Essential events" value={events.length} note="customers, sellers, staff" />
        </div>
        <div className="card pad">
          <Stat label="Channels live" value="2" note="In-app and email" />
        </div>
        <div className="card pad">
          <Stat label="Email delivery, 7 days" value="99.2%" delta="0.1 pts" dir="up" good />
        </div>
        <div className="card pad">
          <Stat label="Bounced or blocked" value="38" note="shown on customer record" />
        </div>
      </div>
      <Alert tone="info" title="Essential and promotional messages are separate">
        Customers and sellers cannot turn off essential order, payment, return and account notices. Promotional messages follow their own consent and preferences. SMS and push come later; push will matter for the Android app.
      </Alert>

      {GROUPS.map((g, gi) => {
        const rows = events.filter((e) => e.audience === g.audience);
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
                    {rows.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <span className="small strong">{e.name}</span>
                        </td>
                        <td>
                          <Badge tone="info" icon="lock">
                            Essential
                          </Badge>
                        </td>
                        <td className="c">
                          <input type="checkbox" aria-label={`${e.audience} ${e.name} in-app`} defaultChecked disabled />
                        </td>
                        <td className="c">
                          <input type="checkbox" aria-label={`${e.audience} ${e.name} email`} checked={e.email} onChange={(x) => toggleEmail(e.id, x.target.checked)} />
                        </td>
                        <td className="c">
                          <Badge>Later</Badge>
                        </td>
                        <td className="c">
                          <Badge>Later</Badge>
                        </td>
                        <td>
                          <span className="xs sub">{e.opens}</span>
                        </td>
                        <td>{editLink(e.id, e.name, false, 'small strong nowrap')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </div>
            <div className="ac-mlist only-phone">
              {rows.map((e) => (
                <div className="ac-mi" key={e.id}>
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">{e.name}</span>
                    <Badge tone="info">Essential</Badge>
                  </div>
                  <div className="xs sub">
                    {e.email ? 'In-app and email' : 'In-app only'} · opens {e.opens}
                  </div>
                  <div className="row gap-2 mt-1-5">{editLink(e.id, e.name, false, 'small strong')}</div>
                </div>
              ))}
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
                {promos.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="small strong">{p.name}</span>
                    </td>
                    <td>{p.audience}</td>
                    <td>
                      <span className="small">{p.frequency}</span>
                    </td>
                    <td>
                      <Badge tone="outline">Opt-in required</Badge>
                    </td>
                    <td className="c">
                      <input type="checkbox" aria-label={`${p.name} email`} checked={p.email} disabled={p.disabled} onChange={(x) => togglePromo(p.id, x.target.checked)} />
                    </td>
                    <td>{editLink(p.id, p.name, true, 'small strong')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </div>
        <div className="ac-mlist only-phone">
          {promos.map((p) => (
            <div className="ac-mi" key={p.id}>
              <div className="row between gap-2 nowrap top">
                <span className="small strong min-w-0">{p.name}</span>
                <Badge tone="outline">Opt-in</Badge>
              </div>
              <div className="xs sub">
                {p.audience} · {p.frequency}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </AdminLayout>
  );
}
