import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Drawer, EmptyState, Field, KeyValue, PageHeader, Pager, SearchInput, Select, Switch, TableWrap, Tabs, TextInput } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date, dateTime, LoadError, SkeletonLines } from '@/app/parts';
import { codeOf, DeptPage, fieldErrorsOf, PAGE_SIZE, plural, TASK_KIND, TINTS, totalPagesOf, useCouponCampaigns, type CustomerPoints, type Reward, type RewardTask, type RewardTint, type TaskKind } from './data/departments';

// Admin › Departments › Daily rewards (designed in React from the Marketly Departments canvas: DailyRewards; no admin
// artboard, so the DeptServices pattern). Tabs: Check-in | Tasks | Rewards | Redemptions | Customers.
// API: /api/admin/rewards/{program,tasks,rewards,redemptions,customers,adjustments}. Customers check in every day for
// points (a 7-day streak, day 7 is the bonus), earn points for daily tasks and swap points for coupons: each reward is a
// promotions coupon campaign whose single-use codes are issued when a customer redeems it.

type Tab = '' | 'tasks' | 'rewards' | 'redemptions' | 'customers';
type Notify = (title: string, tone?: 'success' | 'danger') => void;
type Ctx = { notify: Notify; canManage: boolean };
type Adding = { adding: boolean; setAdding: (v: boolean) => void };
const DAYS = 7;
const pts = (n: number) => `${num(n)} ${Math.abs(n) === 1 ? 'point' : 'points'}`;
/** A market date (YYYY-MM-DD) as Oct 21, 2026 (noon UTC keeps the day in every US time zone) */
const marketDate = (d: string) => date(`${d}T12:00:00Z`);
const ENTRY_KIND: Record<CustomerPoints['entries'][number]['kind'], string> = { check_in: 'Check-in', task: 'Task', redeem: 'Reward', adjust: 'Adjusted by staff' };

export default function DeptRewards() {
  const { can } = useStaffSession();
  const canView = can('rewards.view');
  const canManage = can('rewards.manage');
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const notify: Notify = (title, tone = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };
  const ctx: Ctx = { notify, canManage };
  const addLabel = view === 'tasks' ? 'Add task' : view === 'rewards' ? 'Add reward' : '';

  return (
    <DeptPage active="dept-rewards" title="Daily rewards" canView={canView} need="See the check-in schedule, tasks, rewards, redemptions and customers’ points in Daily rewards">
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Daily rewards' }]}
        title="Daily rewards"
        sub={`Daily check-ins, tasks and the coupons customers swap their points for · days are market days${canManage ? '' : ' · view only: changes need the Daily rewards permission'}`}
        actions={
          canManage &&
          addLabel && (
            <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
              {addLabel}
            </Button>
          )
        }
      />
      <Tabs
        items={[
          { value: '', label: 'Check-in' },
          { value: 'tasks', label: 'Tasks' },
          { value: 'rewards', label: 'Rewards' },
          { value: 'redemptions', label: 'Redemptions' },
          { value: 'customers', label: 'Customers' },
        ]}
        active={view}
        onChange={(v) => {
          setNotice(null);
          setAdding(false);
          setView(v as Tab);
        }}
        label="Daily rewards sections"
      />
      {notice && <Alert tone={notice.tone} title={notice.title} />}
      {view === 'tasks' ? (
        <TasksTab {...ctx} adding={adding} setAdding={setAdding} />
      ) : view === 'rewards' ? (
        <RewardsTab {...ctx} adding={adding} setAdding={setAdding} />
      ) : view === 'redemptions' ? (
        <RedemptionsTab />
      ) : view === 'customers' ? (
        <CustomersTab {...ctx} />
      ) : (
        <CheckInTab {...ctx} />
      )}
    </DeptPage>
  );
}

/* ---------------- Check-in ---------------- */

function CheckInTab({ notify, canManage }: Ctx) {
  const { api } = useApi();
  const qc = useQueryClient();
  const program = useQuery({ queryKey: ['rewards', 'program'], queryFn: () => call(api.GET('/api/admin/rewards/program')) });
  const saved = { points: (program.data?.checkInPoints ?? []).map(String), enabled: program.data?.enabled ?? true };
  const [draft, setDraft] = useState<typeof saved | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const d = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const points = Array.from({ length: DAYS }, (_, i) => d.points[i] ?? '');
  const bad = points.map((p) => !/^\d+$/.test(p.trim()) || Number(p) > 100_000);
  const week = points.reduce((s, p) => s + (Number(p) || 0), 0);

  const save = useMutation({
    mutationFn: () => call(api.PUT('/api/admin/rewards/program', { body: { checkInPoints: points.map((p) => Number(p)), enabled: d.enabled } })),
    onSuccess: (p) => {
      qc.setQueryData(['rewards', 'program'], p);
      setDraft(null);
      setTried(false);
      setError('');
      notify(p.enabled ? 'Check-in schedule saved: it counts from the next check-in' : 'Daily rewards is turned off: customers can’t check in or redeem until you turn it on');
    },
    onError: (e) => setError(Object.values(fieldErrorsOf(e))[0] ?? errorMessage(e)),
  });

  if (program.isError) return <LoadError error={program.error} onRetry={() => void program.refetch()} />;
  return (
    <section className="card">
      <div className="card-head">
        <div className="stack gap-0">
          <h2 className="h4">Check-in schedule</h2>
          <span className="xs muted">
            Points for each day of a 7-day streak; day 7 is the bonus. A missed day starts the streak again at day 1.
            {program.data?.updatedAt ? ` Saved ${dateTime(program.data.updatedAt)}.` : ''}
          </span>
        </div>
      </div>
      {program.isPending ? (
        <div className="card-body">
          <SkeletonLines rows={3} />
        </div>
      ) : (
        <fieldset className="card-body stack gap-4" disabled={!canManage} style={{ border: 0, margin: 0 }}>
          {error && (
            <Alert tone="danger" title="The schedule wasn’t saved">
              {error}
            </Alert>
          )}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
            {points.map((p, i) => (
              <Field key={i} label={i === DAYS - 1 ? <>Day 7 <Badge tone="deal">Bonus</Badge></> : `Day ${i + 1}`} error={tried && bad[i] ? 'Whole points' : undefined}>
                <TextInput id={`rw-day-${i + 1}`} type="number" min={0} inputMode="numeric" suffix="pts" value={p} error={tried && bad[i]} onChange={(e) => setDraft({ ...d, points: points.map((x, k) => (k === i ? e.target.value : x)) })} />
              </Field>
            ))}
          </div>
          <span className="small muted">A full week of check-ins earns {pts(week)}.</span>
          <Switch id="rw-enabled" label="Daily rewards is on: customers can check in, do tasks and redeem coupons" checked={d.enabled} onChange={(e) => setDraft({ ...d, points, enabled: e.target.checked })} />
          {!d.enabled && <Alert tone="warning" title="Turning it off hides Daily rewards in the app">Points customers already have stay; they can use them again once it is back on.</Alert>}
        </fieldset>
      )}
      {canManage && (
        <div className="card-foot">
          <span className="grow" />
          <Button variant="ghost" size="sm" onClick={() => (setDraft(null), setTried(false), setError(''))} disabled={!dirty || save.isPending}>
            Discard changes
          </Button>
          <Button size="sm" icon="check" onClick={() => (setTried(true), !bad.some(Boolean) && save.mutate())} disabled={!dirty || save.isPending}>
            Save schedule
          </Button>
        </div>
      )}
    </section>
  );
}

/* ---------------- Tasks ---------------- */

type TaskDraft = { key: string; isNew: boolean; kind: TaskKind; title: string; points: string; target: string; path: string; visible: boolean; position: string };
const taskDraftOf = (t?: RewardTask, position = 1): TaskDraft => ({ key: t?.key ?? '', isNew: !t, kind: t?.kind ?? 'visit_store', title: t?.title ?? '', points: t ? String(t.points) : '10', target: t ? String(t.target) : '1', path: t?.path ?? '', visible: t?.visible ?? true, position: String(t?.position ?? position) });
const intIn = (v: string, lo: number, hi: number) => /^\d+$/.test(v.trim()) && Number(v) >= lo && Number(v) <= hi;

function TasksTab({ notify, canManage, adding, setAdding }: Ctx & Adding) {
  const { api } = useApi();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['rewards', 'tasks'], queryFn: () => call(api.GET('/api/admin/rewards/tasks')) });
  const rows = [...(list.data ?? [])].sort((a, b) => a.position - b.position);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const editing = draft ?? (adding ? taskDraftOf(undefined, rows.length + 1) : null);
  const setD = (patch: Partial<TaskDraft>) => editing && setDraft({ ...editing, ...patch });
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''));
  const problems = (t: TaskDraft) => ({
    title: t.title.trim() ? '' : 'Enter the title customers see, e.g. Write a review.',
    points: intIn(t.points, 1, 1000) ? '' : 'Give 1 to 1,000 points.',
    target: intIn(t.target, 1, 20) ? '' : 'Ask for 1 to 20 times.',
    path: t.path.trim() && !t.path.trim().startsWith('/') ? 'Use a path in the store, starting with /, e.g. /account/orders.' : '',
  });
  const errs = tried && editing ? problems(editing) : null;

  const save = useMutation({
    mutationFn: (t: TaskDraft) => {
      const body = { kind: t.kind, key: t.isNew ? t.key.trim() || null : t.key, title: t.title.trim(), points: Number(t.points), target: Number(t.target), path: t.path.trim() || null, visible: t.visible, position: t.position.trim() ? Number(t.position) : null };
      return t.isNew ? call(api.POST('/api/admin/rewards/tasks', { body })) : call(api.PATCH('/api/admin/rewards/tasks/{key}', { params: { path: { key: t.key } }, body }));
    },
    onSuccess: (t, d) => {
      void qc.invalidateQueries({ queryKey: ['rewards'] });
      notify(d.isNew ? `${t.title} added${t.visible ? '' : ' as hidden'}` : `${t.title} saved`);
      close();
    },
    onError: (e) => setError(codeOf(e) === 'SLUG_TAKEN' ? 'Another task already uses this key.' : Object.values(fieldErrorsOf(e)).join(' ') || errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (t: TaskDraft) => call(api.DELETE('/api/admin/rewards/tasks/{key}', { params: { path: { key: t.key } } })),
    onSuccess: (_r, t) => {
      void qc.invalidateQueries({ queryKey: ['rewards'] });
      notify(`${t.title} deleted: points already earned stay`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    if (!editing) return;
    setTried(true);
    if (Object.values(problems(editing)).some(Boolean)) return;
    save.mutate(editing);
  };

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Daily tasks</h2>
            <span className="xs muted">Customers claim the points once a task is done; tasks reset at midnight</span>
          </div>
        </div>
        {list.isError && (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        )}
        <TableWrap label="Tasks table">
          <table className="table">
            <thead>
              <tr>
                <th className="r" scope="col">
                  Order
                </th>
                <th scope="col">Task</th>
                <th scope="col">Counts</th>
                <th className="r" scope="col">
                  Points
                </th>
                <th className="r" scope="col">
                  Times
                </th>
                <th scope="col">Go opens</th>
                <th className="r" scope="col">
                  Claimed today
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isPending && (
                <tr>
                  <td colSpan={9}>
                    <SkeletonLines rows={4} />
                  </td>
                </tr>
              )}
              {rows.map((t) => (
                <tr key={t.key}>
                  <td className="r small">{t.position}</td>
                  <td>
                    <span className="stack gap-0">
                      <span className="small strong">{t.title}</span>
                      <span className="xs muted mono">{t.key}</span>
                    </span>
                  </td>
                  <td className="small">{TASK_KIND[t.kind].label}</td>
                  <td className="r small">{num(t.points)}</td>
                  <td className="r small">{t.target}</td>
                  <td className="small mono">{t.path ?? <span className="muted">—</span>}</td>
                  <td className="r small">{num(t.claimedToday)}</td>
                  <td>{t.visible ? <Badge tone="success">Visible</Badge> : <Badge icon="eye-off">Hidden</Badge>}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setTried(false), setError(''), setDraft(taskDraftOf(t)))}>
                      {canManage ? 'Edit' : 'View'}
                      <span className="sr-only"> {t.title}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <EmptyState icon="list-checks" title="No tasks">
                      Tasks such as Visit a store page or Write a review earn points every day.
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <Drawer
        open={!!editing}
        onClose={close}
        title={editing?.isNew ? 'Add task' : `Edit task: ${editing?.title || 'Untitled'}`}
        foot={
          canManage ? (
            <>
              {editing && !editing.isNew && (
                <Button variant="danger-soft" size="sm" onClick={() => remove.mutate(editing)} disabled={save.isPending || remove.isPending}>
                  Delete
                </Button>
              )}
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button size="sm" onClick={submit} disabled={save.isPending || remove.isPending}>
                {editing?.isNew ? 'Add task' : 'Save task'}
              </Button>
            </>
          ) : undefined
        }
      >
        {editing && (
          <fieldset className="stack gap-4" disabled={!canManage} style={{ border: 0, padding: 0, margin: 0 }}>
            {error && (
              <Alert tone="danger" title="The task wasn’t saved">
                {error}
              </Alert>
            )}
            <Field label="What counts" hint={TASK_KIND[editing.kind].hint}>
              <Select id="rt-kind" value={editing.kind} options={(Object.keys(TASK_KIND) as TaskKind[]).map((k) => ({ value: k, label: TASK_KIND[k].label }))} onChange={(e) => setD({ kind: e.target.value as TaskKind })} />
            </Field>
            <Field label="Title" hint="As customers see it" error={errs?.title}>
              <TextInput id="rt-title" value={editing.title} placeholder={TASK_KIND[editing.kind].label} error={!!errs?.title} onChange={(e) => setD({ title: e.target.value })} />
            </Field>
            {editing.isNew ? (
              <Field label="Key" optional hint="A short id for the app, e.g. write_review; made from the kind when empty">
                <TextInput id="rt-key" value={editing.key} placeholder={editing.kind} onChange={(e) => setD({ key: e.target.value })} />
              </Field>
            ) : (
              <KeyValue pairs={[['Key', <span className="mono">{editing.key}</span>]]} />
            )}
            <div className="grid md2 gap-3">
              <Field label="Points" hint="1 to 1,000" error={errs?.points}>
                <TextInput id="rt-points" type="number" min={1} max={1000} value={editing.points} error={!!errs?.points} onChange={(e) => setD({ points: e.target.value })} />
              </Field>
              <Field label="Times a day" hint="How many to count before the points, 1 to 20" error={errs?.target}>
                <TextInput id="rt-target" type="number" min={1} max={20} value={editing.target} error={!!errs?.target} onChange={(e) => setD({ target: e.target.value })} />
              </Field>
            </div>
            <Field label="Go opens" optional hint="Where the task’s Go button takes the customer, e.g. /stores or /account/orders" error={errs?.path}>
              <TextInput id="rt-path" value={editing.path} placeholder="/" error={!!errs?.path} onChange={(e) => setD({ path: e.target.value })} />
            </Field>
            <Field label="Order" optional hint="Lower numbers show first">
              <TextInput id="rt-pos" type="number" min={1} value={editing.position} onChange={(e) => setD({ position: e.target.value })} />
            </Field>
            <Switch id="rt-visible" label="Show this task in the app" checked={editing.visible} onChange={(e) => setD({ visible: e.target.checked })} />
          </fieldset>
        )}
      </Drawer>
    </>
  );
}

/* ---------------- Rewards ---------------- */

type RewardDraft = { id: string; title: string; condition: string; cost: string; tint: RewardTint; campaignId: string; stock: string; visible: boolean; position: string };
const rewardDraftOf = (r?: Reward, position = 1): RewardDraft => ({ id: r?.id ?? '', title: r?.title ?? '', condition: r?.condition ?? '', cost: r ? String(r.cost) : '', tint: r?.tint ?? 'deal', campaignId: r?.campaignId ?? '', stock: r?.stock != null ? String(r.stock) : '', visible: r?.visible ?? true, position: String(r?.position ?? position) });

function RewardsTab({ notify, canManage, adding, setAdding }: Ctx & Adding) {
  const { api } = useApi();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['rewards', 'rewards'], queryFn: () => call(api.GET('/api/admin/rewards/rewards')) });
  const rows = [...(list.data ?? [])].sort((a, b) => a.position - b.position);
  const [draft, setDraft] = useState<RewardDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const editing = draft ?? (adding ? rewardDraftOf(undefined, rows.length + 1) : null);
  const campaigns = useCouponCampaigns(canManage && !!editing);
  const setD = (patch: Partial<RewardDraft>) => editing && setDraft({ ...editing, ...patch });
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''));
  const problems = (r: RewardDraft) => ({
    title: r.title.trim() ? '' : 'Enter the title, e.g. $5 off.',
    condition: r.condition.trim() ? '' : 'Enter the condition, e.g. On orders over $50.',
    cost: intIn(r.cost, 1, 100_000) ? '' : 'The cost is 1 to 100,000 points.',
    campaignId: r.campaignId ? '' : 'Pick the coupon campaign whose codes it gives.',
    stock: r.stock.trim() && !intIn(r.stock, 0, 1_000_000) ? 'Enter how many are left, or leave it empty for no limit.' : '',
  });
  const errs = tried && editing ? problems(editing) : null;
  const current = editing?.id ? rows.find((r) => r.id === editing.id) : undefined;

  const save = useMutation({
    mutationFn: (r: RewardDraft) => {
      const body = { title: r.title.trim(), condition: r.condition.trim(), cost: Number(r.cost), tint: r.tint, campaignId: r.campaignId, stock: r.stock.trim() ? Number(r.stock) : null, visible: r.visible, position: r.position.trim() ? Number(r.position) : null };
      return r.id ? call(api.PATCH('/api/admin/rewards/rewards/{id}', { params: { path: { id: r.id } }, body })) : call(api.POST('/api/admin/rewards/rewards', { body }));
    },
    onSuccess: (r, d) => {
      void qc.invalidateQueries({ queryKey: ['rewards'] });
      notify(d.id ? `${r.title} saved` : `${r.title} added for ${pts(r.cost)}`);
      close();
    },
    onError: (e) => setError(codeOf(e) === 'CAMPAIGN_NOT_ACTIVE' ? 'That coupon campaign isn’t running. Schedule or resume it in Promotions and coupons first.' : Object.values(fieldErrorsOf(e)).join(' ') || errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (r: RewardDraft) => call(api.DELETE('/api/admin/rewards/rewards/{id}', { params: { path: { id: r.id } } })),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: ['rewards'] });
      notify(`${d.title} deleted`);
      close();
    },
    onError: (e) => setError(codeOf(e) === 'IN_USE' ? 'Customers already redeemed this reward, so it can’t be deleted. Turn off “Show this reward” to hide it instead.' : errorMessage(e)),
  });
  const submit = () => {
    if (!editing) return;
    setTried(true);
    if (Object.values(problems(editing)).some(Boolean)) return;
    save.mutate(editing);
  };
  const options = campaigns.data ?? [];

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Reward catalogue</h2>
            <span className="xs muted">Coupons customers swap their points for, in this order · each gives a single-use code of a coupon campaign</span>
          </div>
        </div>
        {list.isError && (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        )}
        <TableWrap label="Rewards table">
          <table className="table">
            <thead>
              <tr>
                <th className="r" scope="col">
                  Order
                </th>
                <th scope="col">Reward</th>
                <th className="r" scope="col">
                  Cost
                </th>
                <th scope="col">Coupon campaign</th>
                <th className="r" scope="col">
                  Left
                </th>
                <th className="r" scope="col">
                  Redeemed
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isPending && (
                <tr>
                  <td colSpan={8}>
                    <SkeletonLines rows={4} />
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="r small">{r.position}</td>
                  <td>
                    <span className="stack gap-0">
                      <span className="small strong">{r.title}</span>
                      <span className="xs muted">{r.condition}</span>
                    </span>
                  </td>
                  <td className="r small nowrap">{pts(r.cost)}</td>
                  <td>
                    <span className="row gap-2 wrap">
                      <span className="small">{r.campaignName ?? 'Campaign'}</span>
                      {r.campaignActive ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Not running</Badge>}
                    </span>
                  </td>
                  <td className="r small">{r.stock == null ? <span className="muted">No limit</span> : num(r.stock)}</td>
                  <td className="r small">{num(r.redeemed)}</td>
                  <td>{r.visible ? <Badge tone="success">Visible</Badge> : <Badge icon="eye-off">Hidden</Badge>}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setTried(false), setError(''), setDraft(rewardDraftOf(r)))}>
                      {canManage ? 'Edit' : 'View'}
                      <span className="sr-only"> {r.title}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState icon="gift" title="No rewards yet">
                      Make a coupon campaign in Promotions and coupons, then add it here with its cost in points.
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot xs muted">A reward whose campaign isn’t running shows as unavailable in the app.</div>
      </section>

      <Drawer
        open={!!editing}
        onClose={close}
        title={editing?.id ? `Edit reward: ${editing.title || 'Untitled'}` : 'Add reward'}
        foot={
          canManage ? (
            <>
              {editing?.id && (
                <Button variant="danger-soft" size="sm" onClick={() => editing && remove.mutate(editing)} disabled={save.isPending || remove.isPending}>
                  Delete
                </Button>
              )}
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button size="sm" onClick={submit} disabled={save.isPending || remove.isPending}>
                {editing?.id ? 'Save reward' : 'Add reward'}
              </Button>
            </>
          ) : undefined
        }
      >
        {editing && (
          <fieldset className="stack gap-4" disabled={!canManage} style={{ border: 0, padding: 0, margin: 0 }}>
            {error && (
              <Alert tone="danger" title="The reward wasn’t saved">
                {error}
              </Alert>
            )}
            <div className="grid md2 gap-3">
              <Field label="Title" hint="e.g. $5 off" error={errs?.title}>
                <TextInput id="rr-title" value={editing.title} error={!!errs?.title} onChange={(e) => setD({ title: e.target.value })} />
              </Field>
              <Field label="Cost" hint="Points, 1 to 100,000" error={errs?.cost}>
                <TextInput id="rr-cost" type="number" min={1} suffix="pts" value={editing.cost} error={!!errs?.cost} onChange={(e) => setD({ cost: e.target.value })} />
              </Field>
            </div>
            <Field label="Condition" hint="e.g. On orders over $50" error={errs?.condition}>
              <TextInput id="rr-cond" value={editing.condition} error={!!errs?.condition} onChange={(e) => setD({ condition: e.target.value })} />
            </Field>
            {campaigns.isError || !canManage ? (
              <Field label="Coupon campaign id" hint={campaigns.isError ? 'The campaigns couldn’t be listed (it needs the promotions permission): paste the campaign’s id' : current?.campaignName ?? undefined} error={errs?.campaignId}>
                <TextInput id="rr-camp" value={editing.campaignId} error={!!errs?.campaignId} onChange={(e) => setD({ campaignId: e.target.value })} />
              </Field>
            ) : (
              <Field label="Coupon campaign" hint={<>Platform percent or amount-off coupons. <Link to={href('admin/promotions')}>Promotions and coupons</Link> makes and runs them.</>} error={errs?.campaignId}>
                <Select
                  id="rr-camp"
                  value={editing.campaignId}
                  disabled={campaigns.isPending}
                  options={[
                    { value: '', label: campaigns.isPending ? 'Loading campaigns…' : 'Pick a coupon campaign…' },
                    ...(editing.campaignId && !options.some((c) => c.id === editing.campaignId) ? [{ value: editing.campaignId, label: current?.campaignName ?? 'Current campaign' }] : []),
                    ...options.map((c) => ({ value: c.id, label: `${c.name} · ${c.ref}${c.status === 'live' ? '' : ` · ${c.status.replace(/_/g, ' ')}`}` })),
                  ]}
                  onChange={(e) => setD({ campaignId: e.target.value })}
                />
              </Field>
            )}
            <div className="grid md2 gap-3">
              <Field label="Colour" hint="The card’s colour band">
                <Select id="rr-tint" value={editing.tint} options={TINTS} onChange={(e) => setD({ tint: e.target.value as RewardTint })} />
              </Field>
              <Field label="Left" optional hint="Redemptions left; empty for no limit" error={errs?.stock}>
                <TextInput id="rr-stock" type="number" min={0} value={editing.stock} error={!!errs?.stock} onChange={(e) => setD({ stock: e.target.value })} />
              </Field>
            </div>
            <Field label="Order" optional hint="Lower numbers show first">
              <TextInput id="rr-pos" type="number" min={1} value={editing.position} onChange={(e) => setD({ position: e.target.value })} />
            </Field>
            <Switch id="rr-visible" label="Show this reward in the app" checked={editing.visible} onChange={(e) => setD({ visible: e.target.checked })} />
            {current && <KeyValue pairs={[['Redeemed', num(current.redeemed)], ['Last changed', dateTime(current.updatedAt)]]} />}
          </fieldset>
        )}
      </Drawer>
    </>
  );
}

/* ---------------- Redemptions ---------------- */

function RedemptionsTab() {
  const { api } = useApi();
  const rewards = useQuery({ queryKey: ['rewards', 'rewards'], queryFn: () => call(api.GET('/api/admin/rewards/rewards')) });
  const [q, setQ] = useState('');
  const [rewardId, setRewardId] = useState('');
  const [page, setPage] = useState(1);
  const query = { q: q.trim() || undefined, rewardId: rewardId || undefined };
  const list = useQuery({
    queryKey: ['rewards', 'redemptions', query, page],
    queryFn: () => call(api.GET('/api/admin/rewards/redemptions', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <SearchInput id="rd-q" placeholder="Code or customer email" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search redemptions" />
          <select className="select" id="rd-rw" aria-label="Reward" value={rewardId} onChange={(e) => (setRewardId(e.target.value), setPage(1))}>
            <option value="">All rewards</option>
            {(rewards.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
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
      <TableWrap label="Redemptions table">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Redeemed</th>
              <th scope="col">Customer</th>
              <th scope="col">Reward</th>
              <th className="r" scope="col">
                Cost
              </th>
              <th scope="col">Code</th>
            </tr>
          </thead>
          <tbody>
            {list.isPending && (
              <tr>
                <td colSpan={5}>
                  <SkeletonLines rows={5} />
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="small nowrap">{dateTime(r.at)}</td>
                <td>
                  <span className="stack gap-0">
                    <span className="small strong">{r.customer.name ?? 'Customer'}</span>
                    <span className="xs muted">{r.customer.email ?? r.customer.id}</span>
                  </span>
                </td>
                <td className="small">{r.reward.title}</td>
                <td className="r small nowrap">{pts(r.cost)}</td>
                <td className="mono small">{r.code}</td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <EmptyState icon="ticket-percent" title={q || rewardId ? 'No redemptions match' : 'No redemptions yet'}>
                    {q || rewardId ? 'Try another search or reward.' : 'Coupons customers redeem with their points show up here with their codes.'}
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <div className="card-foot between">
        <span className="xs muted">The points come off and the code is issued in one step.</span>
        <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
      </div>
    </section>
  );
}

/* ---------------- Customers ---------------- */

function CustomersTab({ notify, canManage }: Ctx) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adjust, setAdjust] = useState({ points: '', reason: '' });
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const list = useQuery({
    queryKey: ['rewards', 'customers', q.trim(), page],
    queryFn: () => call(api.GET('/api/admin/rewards/customers', { params: { query: { q: q.trim() || undefined, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const detail = useQuery({ queryKey: ['rewards', 'customer', openId], enabled: !!openId, queryFn: () => call(api.GET('/api/admin/rewards/customers/{customerId}', { params: { path: { customerId: openId! } } })) });
  const c = detail.data ?? rows.find((r) => r.customerId === openId);
  const adjErrs = {
    points: /^[-+]?\d+$/.test(adjust.points.trim()) && Number(adjust.points) !== 0 && Math.abs(Number(adjust.points)) <= 100_000 ? '' : 'Enter whole points to add, or with a minus to remove, e.g. 50 or -20.',
    reason: adjust.reason.trim() ? '' : 'Say why, e.g. Missed check-in during the outage.',
  };
  const open = (id: string) => (setOpenId(id), setAdjust({ points: '', reason: '' }), setTried(false), setError(''));

  const save = useMutation({
    mutationFn: () => call(api.POST('/api/admin/rewards/adjustments', { body: { customerId: openId!, points: Number(adjust.points), reason: adjust.reason.trim() } })),
    onSuccess: (r) => {
      qc.setQueryData(['rewards', 'customer', r.customerId], r);
      void qc.invalidateQueries({ queryKey: ['rewards', 'customers'] });
      const n = Number(adjust.points);
      notify(`${n > 0 ? 'Added' : 'Removed'} ${pts(Math.abs(n))} ${n > 0 ? 'to' : 'from'} ${r.name ?? r.email ?? 'the customer'}: the balance is ${pts(r.balance)}`);
      setAdjust({ points: '', reason: '' });
      setTried(false);
      setError('');
    },
    onError: (e) => setError(Object.values(fieldErrorsOf(e)).join(' ') || errorMessage(e)),
  });

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="rc-q" placeholder="Customer email or name" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search customers" />
          </div>
        </div>
        {list.isError && (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        )}
        <TableWrap label="Customers table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th className="r" scope="col">
                  Balance
                </th>
                <th className="r" scope="col">
                  Streak
                </th>
                <th scope="col">Last check-in</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isPending && (
                <tr>
                  <td colSpan={5}>
                    <SkeletonLines rows={5} />
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.customerId}>
                  <td>
                    <span className="stack gap-0">
                      <span className="small strong">{r.name ?? 'Customer'}</span>
                      <span className="xs muted">{r.email ?? r.customerId}</span>
                    </span>
                  </td>
                  <td className="r small nowrap strong">{pts(r.balance)}</td>
                  <td className="r small">{plural(r.streak, 'day')}</td>
                  <td className="small">{r.lastCheckIn ? marketDate(r.lastCheckIn) : <span className="muted">Never</span>}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => open(r.customerId)}>
                      Open<span className="sr-only"> {r.name ?? r.email ?? 'customer'}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState icon="users" title={q ? 'No customers match' : 'No points yet'}>
                      {q ? 'Try another email or name.' : 'Customers show up here once they check in or earn points.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">Highest balance first.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>

      <Drawer open={!!openId} onClose={() => setOpenId(null)} className="wide" title={c ? `${c.name ?? c.email ?? 'Customer'} · points` : 'Customer points'}>
        {detail.isError && <LoadError error={detail.error} onRetry={() => void detail.refetch()} />}
        {c && (
          <>
            <KeyValue
              pairs={[
                ['Customer', c.name ?? 'Customer'],
                ['Email', c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : '—'],
                ['Balance', <span className="strong">{pts(c.balance)}</span>],
                ['Streak', plural(c.streak, 'day')],
                ['Last check-in', c.lastCheckIn ? marketDate(c.lastCheckIn) : 'Never'],
              ]}
            />
            {canManage && (
              <div className="stack gap-3" style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 10 }}>
                <span className="label">Adjust points</span>
                {error && <Alert tone="danger" title={error} />}
                <div className="grid md2 gap-3">
                  <Field label="Points" hint="Plus adds, minus removes; the balance never goes below 0" error={tried ? adjErrs.points : undefined}>
                    <TextInput id="rc-pts" inputMode="numeric" placeholder="e.g. 50 or -20" value={adjust.points} error={tried && !!adjErrs.points} onChange={(e) => setAdjust({ ...adjust, points: e.target.value })} />
                  </Field>
                  <Field label="Reason" hint="Kept in the action history; the customer sees “Points added by Marketly”" error={tried ? adjErrs.reason : undefined}>
                    <TextInput id="rc-reason" value={adjust.reason} error={tried && !!adjErrs.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
                  </Field>
                </div>
                <div>
                  <Button size="sm" onClick={() => (setTried(true), !Object.values(adjErrs).some(Boolean) && save.mutate())} disabled={save.isPending}>
                    {Number(adjust.points) < 0 ? 'Remove points' : 'Add points'}
                  </Button>
                </div>
              </div>
            )}
            <div className="stack gap-2">
              <span className="label">History</span>
              {detail.isPending ? (
                <SkeletonLines rows={4} />
              ) : !c.entries.length ? (
                <span className="small muted">No points yet.</span>
              ) : (
                <TableWrap label="Points history">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">When</th>
                        <th scope="col">What</th>
                        <th className="r" scope="col">
                          Points
                        </th>
                        <th className="r" scope="col">
                          Balance
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.entries.map((e) => (
                        <tr key={e.id}>
                          <td className="small nowrap">{dateTime(e.at)}</td>
                          <td>
                            <span className="stack gap-0">
                              <span className="small">{e.title}</span>
                              <span className="xs muted">{ENTRY_KIND[e.kind]}</span>
                            </span>
                          </td>
                          <td className={`r small nowrap strong ${e.points < 0 ? 't-danger-text' : ''}`}>{e.points > 0 ? `+${num(e.points)}` : `−${num(Math.abs(e.points))}`}</td>
                          <td className="r small">{num(e.balanceAfter)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
              {c.entries.length >= 50 && <span className="xs muted">The newest 50 entries.</span>}
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}
