import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { STAFF } from '@marketly/web-shared/data/staff';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Deadline, Dialog, Icon, LazyLoad, PageHeader, Pager, Radio, SearchInput, Select, Stat, StatusBadge, TableWrap, Tabs, type IconName } from '@marketly/web-shared/ui';
import { ASSIGNEES, CASES, CASE_CATEGORIES, CASE_TOTALS, type CasePriority, type CaseRow } from './data/cases';

// Design: pages/admin/admin-cases.html · view "bulk-assign" = Unassigned tab with its rows selected and the bulk bar.

type TabKey = keyof typeof CASE_TOTALS;
type SortKey = 'deadline' | 'newest' | 'priority';

const KPIS: Array<{ icon: IconName; label: string; value: string; note: string }> = [
  { icon: 'life-buoy', label: 'Open cases', value: '31', note: '8 opened today' },
  { icon: 'alarm-clock', label: 'Past response target', value: '5', note: 'Oldest overdue 4 h' },
  { icon: 'user-x', label: 'Unassigned', value: '6', note: 'Assign within 1 h' },
  { icon: 'scale', label: 'Open disputes', value: '4', note: 'Decision target 5 business days' },
];

const TAB_LABEL: Record<TabKey, string> = { all: 'All open', mine: 'My cases', unassigned: 'Unassigned', overdue: 'Overdue', disputes: 'Disputes' };

const inTab = (tab: TabKey, c: CaseRow) =>
  tab === 'all' ||
  (tab === 'mine' && c.owner === STAFF.admin.name) ||
  (tab === 'unassigned' && !c.owner) ||
  (tab === 'overdue' && c.next.tone === 'danger') ||
  (tab === 'disputes' && /dispute/i.test(c.category));

const PRIORITY_RANK: Record<CasePriority, number> = { High: 0, Medium: 1, Low: 2 };
const DEADLINE_RANK = Object.fromEntries(CASES.map((c, i) => [c.id, i]));

function PriorityBadge({ p }: { p: CasePriority }) {
  return p === 'High' ? (
    <Badge tone="danger" icon="arrow-up">
      High
    </Badge>
  ) : (
    <Badge tone={p === 'Medium' ? 'warning' : ''}>{p}</Badge>
  );
}

function Owner({ name }: { name: string | null }) {
  if (!name) return <span className="xs t-warning-text strong">Unassigned</span>;
  return (
    <span className="row nowrap gap-2">
      <Avatar name={name} className="ab-av-sm" />
      <span className="ab-cell">
        <span className="strong">{name}</span>
      </span>
    </span>
  );
}

const rowFlag = (c: CaseRow): { cls: string; sr: string } | null =>
  c.next.tone === 'danger' ? { cls: 'is-flagged', sr: 'Urgent: ' } : c.next.tone === 'warning' ? { cls: 'is-warn', sr: 'At risk: ' } : null;

/** Design legend markup (the shared StatusLegend has no "Legend:" sr-only prefix). */
function EdgeLegend({ items }: { items: Array<{ tone: 'danger' | 'warning'; label: ReactNode }> }) {
  if (!items.length) return null;
  return (
    <p className="status-legend status-legend--edge">
      <span className="sr-only">Legend: </span>
      {items.map((it) => (
        <span key={it.tone} className={`sl sl-${it.tone}`}>
          <i aria-hidden="true" />
          {it.label}
        </span>
      ))}
    </p>
  );
}

const plural = (n: number) => `${n} ${n === 1 ? 'case' : 'cases'}`;

export default function Cases() {
  const [view] = useView<'bulk-assign'>();
  const [rows, setRows] = useState<CaseRow[]>(CASES);
  const [tab, setTab] = useState<TabKey>(view === 'bulk-assign' ? 'unassigned' : 'all');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(view === 'bulk-assign' ? CASES.filter((c) => !c.owner).map((c) => c.id) : []));
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [pri, setPri] = useState('');
  const [sort, setSort] = useState<SortKey>('deadline');
  const [page, setPage] = useState(1);
  const [loads, setLoads] = useState(ASSIGNEES);
  const [assignTo, setAssignTo] = useState(ASSIGNEES[0].name);
  const [done, setDone] = useState<{ title: string; body: string } | null>(null);
  const [priOpen, setPriOpen] = useState(false);
  const [newPri, setNewPri] = useState<CasePriority>('High');

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = rows.filter(
      (c) =>
        inTab(tab, c) &&
        (!cat || c.category === cat) &&
        (!pri || c.priority === pri) &&
        (!term || [c.id, c.order ?? '', c.customer, c.seller ?? ''].some((s) => s.toLowerCase().includes(term))),
    );
    const by: Record<SortKey, (a: CaseRow, b: CaseRow) => number> = {
      deadline: (a, b) => DEADLINE_RANK[a.id] - DEADLINE_RANK[b.id],
      newest: (a, b) => b.opened.localeCompare(a.opened),
      priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || DEADLINE_RANK[a.id] - DEADLINE_RANK[b.id],
    };
    return [...list].sort(by[sort]);
  }, [rows, tab, cat, pri, q, sort]);

  // Tab counts are queue totals (all pages); changes made on this page adjust them.
  const count = (t: TabKey) => CASE_TOTALS[t] + rows.filter((c) => inTab(t, c)).length - CASES.filter((c) => inTab(t, c)).length;

  const allOn = visible.length > 0 && visible.every((c) => selected.has(c.id));
  const someOn = visible.some((c) => selected.has(c.id));
  const n = selected.size;
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((s) => {
      const next = new Set(s);
      visible.forEach((c) => (allOn ? next.delete(c.id) : next.add(c.id)));
      return next;
    });
  const clear = () => setSelected(new Set());

  const assign = () => {
    const moved = rows.filter((c) => selected.has(c.id) && c.owner !== assignTo).length;
    setRows((rs) => rs.map((c) => (selected.has(c.id) ? { ...c, owner: assignTo } : c)));
    setLoads((ls) => ls.map((a) => (a.name === assignTo ? { ...a, open: a.open + moved } : a)));
    setDone({ title: `${plural(n)} assigned to ${assignTo}`, body: `${assignTo} gets a notification. Response targets do not change.` });
    clear();
  };
  const applyPriority = () => {
    setRows((rs) => rs.map((c) => (selected.has(c.id) ? { ...c, priority: newPri } : c)));
    setDone({ title: `Priority set to ${newPri} on ${plural(n)}`, body: 'Sort by priority to see the new order.' });
    setPriOpen(false);
    clear();
  };

  const legend = [
    ...(visible.some((c) => c.next.tone === 'danger') ? [{ tone: 'danger' as const, label: 'Red edge = urgent: overdue or past target' }] : []),
    ...(visible.some((c) => c.next.tone === 'warning') ? [{ tone: 'warning' as const, label: 'Amber edge = at risk: due soon or near target' }] : []),
  ];

  return (
    <AdminLayout active="cases">
      <PageHeader
        crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Customers and service' }]}
        title="Cases and disputes"
        sub="Owner Isabel Cruz, Customer Support Manager · backup Mateo Ruiz · escalation to Returns or Finance by case type"
        actions={
          <>
            <Button variant="secondary" size="sm" icon="download">
              Export
            </Button>
            <Button size="sm" icon="plus">
              New case
            </Button>
          </>
        }
      />
      <div className="ab-kpis k5">
        {KPIS.map((k) => (
          <div className="card pad" key={k.label}>
            <Stat icon={k.icon} label={k.label} value={k.value} note={k.note} />
          </div>
        ))}
        {/* Design markup kept verbatim: class "up good" with a ▼ (faster = good). */}
        <div className="card pad">
          <div className="stat">
            <span className="k">
              <Icon name="clock" className="ic-sm" />
              Median first reply
            </span>
            <span className="v">2 h 40 m</span>
            <span className="d up good">
              <span aria-hidden="true">▼ </span>
              <span className="sr-only">down </span>18 min · faster than last week
            </span>
          </div>
        </div>
      </div>
      <p className="ab-note">
        <Icon name="info" className="ic-sm" /> Example targets: first reply within 4 business hours, dispute decision within 5 business days. Business hours Mon–Sat, 8 AM–8 PM PT.
      </p>
      <div className="stack gap-3">
        <Tabs<TabKey>
          items={(Object.keys(TAB_LABEL) as TabKey[]).map((t) => ({ value: t, label: TAB_LABEL[t], count: count(t) }))}
          active={tab}
          onChange={(t) => {
            setTab(t);
            setPage(1);
          }}
        />
        {done && (
          <Alert tone="success" title={done.title}>
            {done.body}
          </Alert>
        )}
        <div className="toolbar">
          <SearchInput id="cs-q" placeholder="Search case, order, customer or seller" value={q} onChange={setQ} />
          <Select id="cs-cat" aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} options={[{ value: '', label: 'All categories' }, ...CASE_CATEGORIES]} />
          <Select id="cs-pri" aria-label="Priority" value={pri} onChange={(e) => setPri(e.target.value)} options={[{ value: '', label: 'Any priority' }, 'High', 'Medium', 'Low']} />
          <Select
            id="cs-sort"
            aria-label="Sort by"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            options={[
              { value: 'deadline', label: 'Sort: next deadline' },
              { value: 'newest', label: 'Sort: newest' },
              { value: 'priority', label: 'Sort: priority' },
            ]}
          />
        </div>
        {n > 0 && (
          <div className="bulk-bar">
            <span>{n} selected</span>
            <span className="grow" />
            <label className="sr-only" htmlFor="cs-assign">
              Assign to
            </label>
            <select className="select" id="cs-assign" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
              {loads.map((a, i) => (
                <option key={a.name} value={a.name}>
                  {`${i === 0 ? 'Assign to… ' : ''}${a.name}${a.team ? `, ${a.team}` : ''} (${a.open} open)`}
                </option>
              ))}
            </select>
            <Button variant="soft" size="sm" icon="user-check" onClick={assign}>
              Assign {plural(n)}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPriOpen(true)}>
              Set priority
            </Button>
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
          </div>
        )}
        <div className="card no-phone">
          <TableWrap label="Cases and disputes table">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allOn}
                      ref={(el) => {
                        if (el) el.indeterminate = someOn && !allOn;
                      }}
                      onChange={toggleAll}
                    />
                  </th>
                  <th scope="col">Case</th>
                  <th scope="col">Order</th>
                  <th scope="col">Category</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Seller</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Status</th>
                  <th className="col-pin" scope="col">
                    Next response
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const flag = rowFlag(c);
                  return (
                    <tr key={c.id} className={flag?.cls}>
                      <td className="col-check">
                        {flag && <span className="sr-only">{flag.sr}</span>}
                        <input type="checkbox" aria-label={`Select ${c.id}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                      </td>
                      <td>
                        <Link className="mono strong nowrap" to={href('admin/case', '', { ref: c.id })} title={c.id}>
                          {c.id}
                        </Link>
                      </td>
                      <td>
                        {c.order ? (
                          <Link className="mono nowrap" to={href('admin/order', '', { ref: c.order })} title={c.order}>
                            {c.order}
                          </Link>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {c.category} · {c.detail}
                      </td>
                      <td>
                        <PriorityBadge p={c.priority} />
                      </td>
                      <td>{c.customer}</td>
                      <td>{c.seller ?? '—'}</td>
                      <td>
                        <Owner name={c.owner} />
                      </td>
                      <td>
                        <StatusBadge status={c.status} />
                      </td>
                      <td className="col-pin">
                        <Deadline tone={c.next.tone}>{c.next.label}</Deadline>
                      </td>
                    </tr>
                  );
                })}
                {!visible.length && (
                  <tr>
                    <td colSpan={10} className="muted">
                      No cases match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
          <EdgeLegend items={legend} />
          <div className="card-foot">
            <span className="ab-note grow">Cases close only after any promised refund or replacement is complete.</span>
            <Pager page={page} total={4} onPage={setPage} />
          </div>
        </div>
        <ul className="ab-mlist only-phone">
          {visible.slice(0, 6).map((c) => (
            <li className="card pad" key={c.id}>
              <div className="row between">
                <Link className="mono strong" to={href('admin/case', '', { ref: c.id })}>
                  {c.id}
                </Link>
                <StatusBadge status={c.status} />
              </div>
              <span className="small">
                {c.category} · {c.detail}
              </span>
              <span className="xs muted">
                {c.customer} · {c.seller ?? '—'} · {c.owner ?? 'Unassigned'}
              </span>
              <div className="row between">
                <PriorityBadge p={c.priority} />
                <Deadline tone={c.next.tone}>{c.next.label}</Deadline>
              </div>
            </li>
          ))}
        </ul>
        <LazyLoad />
      </div>
      <Dialog
        open={priOpen}
        onClose={() => setPriOpen(false)}
        title="Set priority"
        size="sm"
        foot={
          <>
            <Button variant="secondary" onClick={() => setPriOpen(false)}>
              Cancel
            </Button>
            <Button onClick={applyPriority}>Set priority on {plural(n)}</Button>
          </>
        }
      >
        <fieldset className="stack gap-2 fieldset-reset">
          <legend className="label">Priority</legend>
          {(['High', 'Medium', 'Low'] as CasePriority[]).map((p) => (
            <Radio key={p} id={`cs-setpri-${p}`} name="cs-setpri" label={p} checked={newPri === p} onChange={() => setNewPri(p)} />
          ))}
        </fieldset>
      </Dialog>
    </AdminLayout>
  );
}
