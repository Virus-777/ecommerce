import { Fragment, useRef, useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, Field, Icon, IconButton, Pager, SearchInput, Select, Stat, StatusBadge, TableWrap, Tabs, Textarea, TextInput, type IconName } from '@marketly/web-shared/ui';

// Design: pages/admin/admin-help-content.html · view "edit-policy" = the editor for Return policy version 3.1.

type Kind = 'Policy' | 'Article';
type Status = 'Published' | 'Draft' | 'Scheduled' | 'In review';
interface Item {
  id: string;
  title: string;
  kind: Kind;
  category: string;
  owner: string;
  status: Status;
  effective: string;
  version: string;
  body?: string;
}

const RETURN_BODY = `Holiday returns
Items delivered from Nov 1 to Dec 31, 2026 can be returned until Jan 31, 2027.

Who pays return shipping
The seller pays return shipping for damaged, defective, incorrect or late items. For change-of-mind returns, the seller's listed return terms apply. Sellers can offer more generous terms.`;

const ITEMS: Item[] = [
  { id: 'p1', title: 'Return policy', kind: 'Policy', category: 'Returns', owner: 'Lena Park', status: 'Published', effective: 'Sep 1, 2026', version: 'v3.0' },
  { id: 'p2', title: 'Return policy', kind: 'Policy', category: 'Returns', owner: 'Lena Park', status: 'Draft', effective: 'Nov 1, 2026', version: 'v3.1', body: RETURN_BODY },
  { id: 'p3', title: 'Shipping and delivery policy', kind: 'Policy', category: 'Delivery', owner: 'Theo Grant', status: 'Published', effective: 'Aug 1, 2026', version: 'v2.2' },
  { id: 'p4', title: 'Purchase terms', kind: 'Policy', category: 'Shopping', owner: 'Morgan Hale', status: 'Published', effective: 'Aug 1, 2026', version: 'v3.2' },
  { id: 'p5', title: 'Seller rules and fees', kind: 'Policy', category: 'Sellers', owner: 'Grace Kim', status: 'Scheduled', effective: 'Oct 15, 2026', version: 'v2.1' },
  { id: 'p6', title: 'Advertising and sponsored labels', kind: 'Policy', category: 'Advertising', owner: 'Jamie Brooks', status: 'Published', effective: 'Sep 1, 2026', version: 'v1.0' },
  { id: 'a1', title: 'When will I get my refund?', kind: 'Article', category: 'Refunds', owner: 'Noor Aziz', status: 'Published', effective: 'Sep 20, 2026', version: 'v4' },
  { id: 'a2', title: 'Track a package from another seller', kind: 'Article', category: 'Delivery', owner: 'Noor Aziz', status: 'Published', effective: 'Sep 12, 2026', version: 'v2' },
  { id: 'a3', title: 'Cancel an item before it ships', kind: 'Article', category: 'Cancellations', owner: 'Noor Aziz', status: 'Published', effective: 'Aug 28, 2026', version: 'v3' },
  { id: 'a4', title: 'My payment was declined', kind: 'Article', category: 'Payment', owner: 'Noor Aziz', status: 'In review', effective: '—', version: 'v2' },
];

const OWNER_ROLE: Record<string, string> = { 'Lena Park': 'Returns Manager', 'Theo Grant': 'Shipping Manager', 'Morgan Hale': 'Business Owner', 'Grace Kim': 'Seller Manager', 'Jamie Brooks': 'Advertising Manager', 'Noor Aziz': 'Content Manager' };
const OWNER_TEAM: Record<string, string> = { 'Lena Park': 'Returns', 'Theo Grant': 'Shipping', 'Morgan Hale': 'Business Owner', 'Grace Kim': 'Sellers', 'Jamie Brooks': 'Advertising', 'Noor Aziz': 'Content' };
const CATEGORIES = ['All categories', 'Shopping', 'Delivery', 'Payment', 'Cancellations', 'Returns', 'Refunds', 'Accounts', 'Sellers', 'Advertising'];
const TABS = [
  { label: 'All', value: 'all', count: 57 },
  { label: 'Policies', value: 'policies', count: 9 },
  { label: 'Help articles', value: 'articles', count: 48 },
  { label: 'Drafts and review', value: 'drafts', count: 3 },
];
const PREVIOUS = [
  { v: '3.0', current: true, effective: 'Sep 1, 2026', summary: 'Category exceptions for beauty and opened electronics', by: 'Morgan Hale' },
  { v: '2.1', effective: 'Jul 15, 2026', summary: 'Clarified refund timing by payment method', by: 'Morgan Hale' },
  { v: '2.0', effective: 'Jun 1, 2026', summary: 'Seller return terms can be more generous than baseline', by: 'Morgan Hale' },
];
const FORMATS: Array<{ icon: IconName; label: string; wrap: [string, string] }> = [
  { icon: 'heading-2', label: 'Heading', wrap: ['## ', ''] },
  { icon: 'bold', label: 'Bold', wrap: ['**', '**'] },
  { icon: 'italic', label: 'Italic', wrap: ['_', '_'] },
  { icon: 'list', label: 'Bulleted list', wrap: ['- ', ''] },
  { icon: 'list-ordered', label: 'Numbered list', wrap: ['1. ', ''] },
  { icon: 'link', label: 'Insert link', wrap: ['[', '](https://)'] },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The design's "today" (Oct 8, 2026): effective dates must be 14+ days later. */
const TODAY = new Date(2026, 9, 8);

function parseDay(s: string): Date | null {
  const m = s.match(/([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/);
  if (!m || !MONTHS.includes(m[1])) return null;
  return new Date(Number(m[3]), MONTHS.indexOf(m[1]), Number(m[2]));
}

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

interface Draft {
  itemId: string | null;
  kind: Kind;
  title: string;
  version: string;
  owner: string;
  base: string;
  body: string;
  effective: string;
  summary: string;
  impact: 'new' | 'open';
  notifyCustomers: boolean;
  notifySellers: boolean;
}

const RETURN_DRAFT: Draft = {
  itemId: 'p2',
  kind: 'Policy',
  title: 'Return policy',
  version: '3.1',
  owner: 'Lena Park',
  base: RETURN_BODY,
  body: RETURN_BODY,
  effective: 'Nov 1, 2026, 12:00 AM PT',
  summary: 'Longer return window for holiday deliveries. Late items added to the list where the seller pays return shipping.',
  impact: 'new',
  notifyCustomers: true,
  notifySellers: true,
};

function nextVersion(v: string, kind: Kind) {
  const n = v.replace(/^v/, '');
  if (kind === 'Article') return String(Number(n) + 1);
  const [maj, min] = n.split('.').map(Number);
  return `${maj}.${(min ?? 0) + 1}`;
}

export default function HelpContent() {
  const [view, setView] = useView<'edit-policy'>();
  const [items, setItems] = useState(ITEMS);
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(CATEGORIES[0]);
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Draft>(RETURN_DRAFT);
  const [errors, setErrors] = useState<Partial<Record<'title' | 'body' | 'effective' | 'summary', string>>>({});
  const [sent, setSent] = useState(false);
  const [notice, setNotice] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const editing = view === 'edit-policy';
  const needle = q.trim().toLowerCase();
  const rows = items.filter(
    (r) =>
      (tab === 'all' || (tab === 'policies' && r.kind === 'Policy') || (tab === 'articles' && r.kind === 'Article') || (tab === 'drafts' && (r.status === 'Draft' || r.status === 'In review'))) &&
      (cat === CATEGORIES[0] || r.category === cat) &&
      (!needle || r.title.toLowerCase().includes(needle)),
  );

  const flash = (m: string) => {
    setNotice(m);
    announce(m);
  };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const openEditor = (item?: Item, kind: Kind = 'Policy') => {
    if (item?.id === 'p2') setD(RETURN_DRAFT);
    else if (item) {
      const isDraft = item.status === 'Draft' || item.status === 'In review';
      const body = item.body ?? `${item.title}\n\nCurrent text of ${item.version}. Edit this text to create the next version.`;
      setD({ ...RETURN_DRAFT, itemId: isDraft ? item.id : null, kind: item.kind, title: item.title, owner: item.owner, version: isDraft ? item.version.replace(/^v/, '') : nextVersion(item.version, item.kind), base: body, body, summary: '', effective: item.kind === 'Policy' ? 'Nov 1, 2026, 12:00 AM PT' : '' });
    } else {
      setD({ ...RETURN_DRAFT, itemId: null, kind, title: '', version: kind === 'Policy' ? '1.0' : '1', owner: kind === 'Policy' ? 'Lena Park' : 'Noor Aziz', base: '', body: '', summary: '', effective: kind === 'Policy' ? 'Nov 1, 2026, 12:00 AM PT' : '' });
    }
    setErrors({});
    setSent(false);
    setView('edit-policy');
    window.scrollTo({ top: 0 });
  };

  const format = (wrap: [string, string]) => {
    const ta = bodyRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const next = value.slice(0, s) + wrap[0] + value.slice(s, e) + wrap[1] + value.slice(e);
    set('body', next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + wrap[0].length, e + wrap[0].length);
    });
  };

  const validate = () => {
    const e: typeof errors = {};
    if (!d.title.trim()) e.title = 'Enter a title.';
    if (!d.body.trim()) e.body = 'Enter the text.';
    if (d.kind === 'Policy') {
      const day = parseDay(d.effective);
      const min = new Date(TODAY.getTime() + 14 * 86400000);
      if (!day) e.effective = 'Enter a date, like Nov 1, 2026, 12:00 AM PT.';
      else if (day < min) e.effective = `Choose ${MONTHS[min.getMonth()]} ${min.getDate()}, ${min.getFullYear()} or later: customer-facing changes need 14 days' notice.`;
      if (!d.summary.trim()) e.summary = 'Summarize what changed. Customers see it at the top of the policy.';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const persist = (status: Status) => {
    const row: Item = { id: d.itemId ?? `n${Date.now()}`, title: d.title, kind: d.kind, category: items.find((i) => i.id === d.itemId)?.category ?? (d.kind === 'Policy' ? 'Returns' : 'Shopping'), owner: d.owner, status, effective: d.kind === 'Policy' ? d.effective.replace(/,\s*\d{1,2}:\d{2}.*$/, '') : '—', version: `v${d.version}` };
    setItems((l) => (l.some((i) => i.id === row.id) ? l.map((i) => (i.id === row.id ? row : i)) : [row, ...l]));
    setD((p) => ({ ...p, itemId: row.id }));
  };
  const saveDraft = () => {
    if (!d.title.trim()) return setErrors({ title: 'Enter a title.' });
    persist('Draft');
    announce('Draft saved');
  };
  const send = () => {
    if (!validate()) return announce('Check the highlighted fields.');
    persist('In review');
    setSent(true);
    flash(d.kind === 'Policy' ? `${d.title} ${d.version} sent to Morgan Hale for final approval` : `${d.title} sent for review`);
  };

  const isReturn = d.itemId === 'p2' && d.base === RETURN_BODY;
  const changed = d.body !== d.base;

  if (editing) {
    const ownerTeam = OWNER_TEAM[d.owner] ?? 'Owner';
    return (
      <AdminLayout active="help-content">
        <div className="page-head">
          <div className="t">
            <Breadcrumbs items={[{ label: 'Help and policies', to: href('admin/help-content') }, { label: d.title || (d.kind === 'Policy' ? 'New policy' : 'New article') }]} />
            <h1 className="h1">
              {d.title || (d.kind === 'Policy' ? 'New policy' : 'New article')} · version {d.version}
            </h1>
            <p className="sub small">
              {d.kind === 'Policy' ? `Policy owner ${d.owner}, ${OWNER_ROLE[d.owner] ?? 'Owner'} · content editor Noor Aziz` : 'Help article · editor Noor Aziz, Content Manager'}
            </p>
          </div>
          <div className="actions">
            {sent ? <Badge tone="info">In review</Badge> : <Badge>Draft</Badge>}
            <Button variant="secondary" size="sm" icon="eye" to={d.kind === 'Policy' ? href('info/policy') : href('help/article')}>
              Preview public page
            </Button>
          </div>
        </div>

        {sent && (
          <Alert tone="success" title={d.kind === 'Policy' ? 'Sent for final approval' : 'Sent for review'}>
            {d.kind === 'Policy' ? `Morgan Hale has been asked to approve version ${d.version}. It publishes on ${d.effective} once approved.` : 'The article publishes once Content review approves it.'}{' '}
            <Link to={href('admin/help-content')}>Back to Help and policies</Link>
          </Alert>
        )}

        <div className="ab-main wide">
          <div className="stack gap-4">
            <Card title={d.kind === 'Policy' ? 'Policy text' : 'Article text'}>
              <Field label="Title" error={errors.title}>
                <TextInput id="hp-title" value={d.title} error={!!errors.title} onChange={(e) => set('title', e.target.value)} disabled={sent} />
              </Field>
              <div className="field">
                <label className="label" htmlFor="hp-body">
                  Body
                </label>
                <div className="ab-edbar" role="toolbar" aria-label="Formatting">
                  {FORMATS.map((f) => (
                    <IconButton key={f.label} icon={f.icon} label={f.label} onClick={() => format(f.wrap)} disabled={sent} />
                  ))}
                </div>
                <textarea
                  ref={bodyRef}
                  className={cx('textarea', errors.body && 'is-error')}
                  id="hp-body"
                  rows={8}
                  value={d.body}
                  aria-invalid={errors.body ? true : undefined}
                  aria-describedby={errors.body ? 'hp-body-err' : undefined}
                  onChange={(e) => set('body', e.target.value)}
                  disabled={sent}
                />
                {errors.body && (
                  <span className="error-text" id="hp-body-err">
                    <Icon name="circle-alert" className="ic-sm" />
                    {errors.body}
                  </span>
                )}
              </div>
            </Card>
            {d.kind === 'Policy' && (
              <Card title={`Changes from version ${isReturn ? '3.0' : d.base ? `${d.version} draft start` : 'nothing yet'}`} titleAs="h3">
                {isReturn && !changed ? (
                  <p className="ab-diff">
                    Items can be returned within 30 days of delivery<ins>, except items delivered from Nov 1 to Dec 31, 2026, which can be returned until Jan 31, 2027</ins>. The seller pays return shipping for <del>damaged or incorrect</del>
                    <ins>damaged, defective, incorrect or late</ins> items.
                  </p>
                ) : changed ? (
                  <p className="ab-diff" style={{ whiteSpace: 'pre-wrap' }}>
                    {diffWords(d.base, d.body).map((p, i) => (
                      <Fragment key={i}>{p.t === 'ins' ? <ins>{p.s}</ins> : p.t === 'del' ? <del>{p.s}</del> : p.s}</Fragment>
                    ))}
                  </p>
                ) : (
                  <p className="small muted">No changes yet. Edit the text to see what changes.</p>
                )}
              </Card>
            )}
            {isReturn && (
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
                      {PREVIOUS.map((p) => (
                        <tr key={p.v}>
                          <td>
                            {p.current ? (
                              <>
                                <b>{p.v}</b> · current
                              </>
                            ) : (
                              p.v
                            )}
                          </td>
                          <td>{p.effective}</td>
                          <td>{p.summary}</td>
                          <td>{p.by}</td>
                          <td>
                            <Link className="btn btn-ghost btn-sm" to={href('info/policy')}>
                              <span>View</span>
                              <span className="sr-only"> {p.v}</span>
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
                <>
                  <Button variant="ghost" size="sm" onClick={saveDraft} disabled={sent}>
                    Save draft
                  </Button>
                  <Button size="sm" onClick={send} disabled={sent}>
                    {sent ? 'Sent' : d.kind === 'Policy' ? 'Send for approval' : 'Send for review'}
                  </Button>
                </>
              }
            >
              {d.kind === 'Policy' && (
                <>
                  <Field label="Effective date" hint="At least 14 days after publishing for customer-facing changes" error={errors.effective}>
                    <TextInput id="hp-eff" icon="calendar" value={d.effective} error={!!errors.effective} onChange={(e) => set('effective', e.target.value)} disabled={sent} />
                  </Field>
                  <Field label="Change summary" hint="Shown at the top of the policy page and in the notice" error={errors.summary}>
                    <Textarea id="hp-sum" value={d.summary} onChange={(e) => set('summary', e.target.value)} disabled={sent} />
                  </Field>
                  <fieldset className="stack gap-2 fieldset-reset">
                    <legend className="label">Impact on existing orders</legend>
                    {(
                      [
                        ['new', 'Orders placed from Nov 1 only', 'Earlier orders keep the terms accepted at purchase'],
                        ['open', 'Also extend to open orders', 'Only for changes that favor the customer'],
                      ] as const
                    ).map(([v, t, b], i) => (
                      <label key={v} className={cx('opt-card', d.impact === v && 'is-selected')} htmlFor={`hp-imp-${i + 1}`}>
                        <input type="radio" name="hp-imp" id={`hp-imp-${i + 1}`} checked={d.impact === v} onChange={() => set('impact', v)} disabled={sent} />
                        <span className="stack gap-1 grow">
                          <span className="small strong">{t}</span>
                          <span className="small sub">{b}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </>
              )}
              <label className="check" htmlFor="hp-n1">
                <input type="checkbox" id="hp-n1" checked={d.notifyCustomers} onChange={(e) => set('notifyCustomers', e.target.checked)} disabled={sent} />
                <span>Notify customers with an account</span>
              </label>
              {d.kind === 'Policy' && (
                <label className="check" htmlFor="hp-n2">
                  <input type="checkbox" id="hp-n2" checked={d.notifySellers} onChange={(e) => set('notifySellers', e.target.checked)} disabled={sent} />
                  <span>Notify sellers in Seller Center</span>
                </label>
              )}
              <div className="divider" />
              <ul className="ab-approvals">
                {d.kind === 'Policy' ? (
                  <>
                    <li>
                      <span className="n is-done">
                        <Icon name="check" className="ic-sm" />
                      </span>
                      <span className="ab-cell">
                        <span className="strong">
                          {d.owner} · {ownerTeam}
                        </span>
                        <span className="xs muted">Policy owner · approved Oct 7</span>
                      </span>
                      <Badge tone="success">Approved</Badge>
                    </li>
                    <li>
                      <span className="n is-wait">2</span>
                      <span className="ab-cell">
                        <span className="strong">Morgan Hale · Business Owner</span>
                        <span className="xs muted">{sent ? 'Final approval · requested just now' : 'Final approval'}</span>
                      </span>
                      <Badge tone="warning">Pending</Badge>
                    </li>
                  </>
                ) : (
                  <li>
                    <span className="n is-wait">1</span>
                    <span className="ab-cell">
                      <span className="strong">Content review</span>
                      <span className="xs muted">Another Content editor checks accuracy and links</span>
                    </span>
                    <StatusBadge status={sent ? 'In review' : 'Draft'} />
                  </li>
                )}
              </ul>
            </Card>
          </div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout active="help-content">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Marketing and content' }]} />
          <h1 className="h1">Help and policies</h1>
          <p className="sub small">Content Manager Noor Aziz maintains articles; each policy has a business owner and an approval step</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="plus" onClick={() => openEditor(undefined, 'Article')}>
            New article
          </Button>
          <Button size="sm" icon="file-plus" to={href('admin/help-content', 'edit-policy')} onClick={(e) => (e.preventDefault(), openEditor(items.find((i) => i.id === 'p2')))}>
            New policy version
          </Button>
        </div>
      </div>

      {notice && <Alert tone="success" title={notice} />}

      <div className="ab-kpis k4">
        <div className="card pad">
          <Stat icon="book-open" label="Published articles" value="48" note="8 categories" />
        </div>
        <div className="card pad">
          <Stat icon="scale" label="Policies" value="9" note="1 scheduled · 1 draft" />
        </div>
        <div className="card pad">
          <Stat icon="clock" label="Articles needing review" value="3" note="Older than 90 days" />
        </div>
        <div className="card pad">
          <Stat icon="thumbs-up" label="Helpful rating" value="87%" note="Last 30 days" />
        </div>
      </div>

      <div className="card">
        <div className="u-p-0-sp-4">
          <Tabs items={TABS} active={tab} onChange={(v) => (setTab(v), setPage(1))} />
        </div>
        <div className="card-body u-pb-sp-3">
          <div className="toolbar">
            <SearchInput id="hc-q" placeholder="Search titles" value={q} onChange={setQ} />
            <Select id="hc-cat" aria-label="Category" options={CATEGORIES} value={cat} onChange={(e) => setCat(e.target.value)} />
          </div>
        </div>
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
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.kind === 'Policy' ? (
                      <a
                        className="strong"
                        href={href('admin/help-content', 'edit-policy')}
                        onClick={(e) => {
                          e.preventDefault();
                          openEditor(r);
                        }}
                      >
                        {r.title}
                      </a>
                    ) : (
                      <Link className="strong" to={href('help/article')}>
                        {r.title}
                      </Link>
                    )}
                  </td>
                  <td>{r.kind === 'Policy' ? <Badge tone="info">Policy</Badge> : <Badge>Article</Badge>}</td>
                  <td>{r.category}</td>
                  <td>{r.owner}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>{r.effective}</td>
                  <td>
                    <span className="mono nowrap" title={r.version}>
                      {r.version}
                    </span>
                  </td>
                  <td>
                    {r.kind === 'Policy' ? (
                      <Link className="btn btn-ghost btn-sm" to={href('admin/help-content', 'edit-policy')} onClick={(e) => (e.preventDefault(), openEditor(r))}>
                        <span>Edit</span>
                        <span className="sr-only"> {r.version}</span>
                      </Link>
                    ) : (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEditor(r)}>
                        <span>Edit</span>
                        <span className="sr-only"> {r.version}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
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
          <Pager page={page} total={6} onPage={setPage} />
        </div>
      </div>
    </AdminLayout>
  );
}
