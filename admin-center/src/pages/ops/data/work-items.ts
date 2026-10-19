// Work items, queue setup and routine checks for pages/ops/Queues.tsx (no design: built from the workqueues API,
// docs/api/modules/workqueues.md). Work items never do the work: each links to the owning module's screen, and most
// close by themselves when the source event arrives (resolution outcome fixed_at_source).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, useApi, type Api, type components } from '@marketly/web-shared/api';
import { screenHref } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import { humanize, staffName, type StaffRef } from './shared';

export type WorkItem = components['schemas']['workqueues.WorkItem'];
export type WorkState = WorkItem['state'];
export type WaitingOn = NonNullable<WorkItem['waitingOn']>;
export type Priority = WorkItem['priority'];
export type QueueSummary = components['schemas']['workqueues.QueueSummary'];
export type QueueDefinition = components['schemas']['workqueues.QueueDefinition'];
type Page<T> = { items: T[]; total?: number; totalPages?: number; page?: number; nextCursor: string | null };

/** WorkItem.links entries (typed json[] in the spec). */
export interface ItemLink {
  label: string;
  screen: string;
  state?: string | null;
}
/** WorkItem.resolution (json in the spec). */
export interface Resolution {
  outcome: 'fixed_at_source' | 'resolved' | 'dismissed';
  note?: string | null;
  by?: { name?: string | null } | null;
}

export const STATE_LABEL: Record<WorkState, string> = {
  open: 'Open',
  assigned: 'Assigned',
  in_progress: 'In progress',
  waiting: 'Waiting',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};
export const STATE_TONE: Record<WorkState, '' | 'info' | 'warning' | 'success' | 'brand'> = {
  open: '',
  assigned: 'info',
  in_progress: 'brand',
  waiting: 'warning',
  resolved: 'success',
  dismissed: '',
};
export const WAITING_ON: Array<{ value: WaitingOn; label: string }> = [
  { value: 'seller', label: 'Seller' },
  { value: 'customer', label: 'Customer' },
  { value: 'carrier', label: 'Carrier' },
  { value: 'supplier', label: 'Supplier' },
  { value: 'finance', label: 'Finance' },
  { value: 'other', label: 'Someone else' },
];
export const PRIORITIES: Array<{ value: Priority; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];
/** Dismiss reasons offered as a pick list; the API takes free text (the reason is audited). */
export const DISMISS_REASONS = ['False alarm', 'Duplicate of another item', 'Not for this team', 'Already handled elsewhere', 'Other'];

/** List filter for state: "active" is every state that still needs work (open, assigned, in progress, waiting). */
export type StateFilter = 'active' | WorkState;
export const STATE_FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: 'active', label: 'Still open' },
  { value: 'open', label: 'Open, not started' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];

export const isActive = (s: WorkState) => s !== 'resolved' && s !== 'dismissed';

/** The item's first link (the screen where the work is done), with the subject's ref filling a detail route. */
export function itemLinks(it: WorkItem): Array<{ label: string; to: string }> {
  const ref = it.subject?.ref ?? undefined;
  return (it.links as ItemLink[])
    .map((l) => ({ label: l.label, to: (ref ? screenHref(l.screen, l.state, { ref }) : undefined) ?? screenHref(l.screen, l.state) }))
    .filter((l): l is { label: string; to: string } => !!l.to);
}

/** "MK-261007-10433" or the subject's label, for the What column. */
export const subjectText = (it: WorkItem) => it.subject?.ref ?? it.subject?.label ?? humanize(it.subject?.type);

/** Which actions the item's state allows (workqueues.md status flow). `me` is the signed-in staff id. */
export function allowedActions(it: WorkItem, me: string) {
  const active = isActive(it.state);
  const mine = it.assignee?.staffId === me;
  return {
    // claim = assign to me and start; the API refuses it when someone else already holds started work
    claim: active && !mine && (it.state === 'open' || !it.assignee),
    start: it.state === 'assigned',
    wait: it.state === 'assigned' || it.state === 'in_progress',
    resume: it.state === 'waiting',
    resolve: active,
    dismiss: active,
    escalate: active,
    assign: active,
    reopen: !active,
  };
}
export type ActionKey = keyof ReturnType<typeof allowedActions>;

export type ItemAction =
  | { kind: 'claim' | 'start' | 'resume' }
  | { kind: 'wait'; waitingOn: WaitingOn; note: string; followUpAt?: string | null }
  | { kind: 'resolve'; note: string }
  | { kind: 'dismiss' | 'reopen' | 'escalate'; reason: string }
  | { kind: 'assign'; assigneeId: string; nextAction?: string | null }
  | { kind: 'note'; body: string };

/** One POST per action, each with its own typed path (POST /api/admin/workqueues/items/{id}/…). */
function runAction(api: Api, id: string, a: ItemAction): Promise<unknown> {
  const path = { params: { path: { id } } };
  switch (a.kind) {
    case 'claim':
      return call(api.POST('/api/admin/workqueues/items/{id}/claim', path));
    case 'start':
      return call(api.POST('/api/admin/workqueues/items/{id}/start', path));
    case 'resume':
      return call(api.POST('/api/admin/workqueues/items/{id}/resume', path));
    case 'wait':
      return call(api.POST('/api/admin/workqueues/items/{id}/wait', { ...path, body: { waitingOn: a.waitingOn, note: a.note, followUpAt: a.followUpAt ?? null } }));
    case 'resolve':
      return call(api.POST('/api/admin/workqueues/items/{id}/resolve', { ...path, body: { note: a.note } }));
    case 'dismiss':
      return call(api.POST('/api/admin/workqueues/items/{id}/dismiss', { ...path, body: { reason: a.reason } }));
    case 'reopen':
      return call(api.POST('/api/admin/workqueues/items/{id}/reopen', { ...path, body: { reason: a.reason } }));
    case 'escalate':
      return call(api.POST('/api/admin/workqueues/items/{id}/escalate', { ...path, body: { reason: a.reason } }));
    case 'assign':
      return call(api.POST('/api/admin/workqueues/items/{id}/assign', { ...path, body: { assigneeId: a.assigneeId, nextAction: a.nextAction ?? null } }));
    case 'note':
      return call(api.POST('/api/admin/workqueues/items/{id}/notes', { ...path, body: { body: a.body } }));
  }
}

export const ACTION_DONE: Record<ItemAction['kind'], string> = {
  claim: 'Claimed and started',
  start: 'Marked in progress',
  resume: 'Back in progress',
  wait: 'Marked waiting',
  resolve: 'Resolved',
  dismiss: 'Dismissed',
  reopen: 'Reopened',
  escalate: 'Escalated to the next step',
  assign: 'Assigned',
  note: 'Note added',
};

/** Every work-queue read (me, queues, items, routine) shares the ['workqueues'] prefix, so one invalidation refreshes the screen. */
export function useWorkqueuesRefresh() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['workqueues'] });
}

export interface ItemFilter {
  queueKey?: string;
  assignee?: 'me' | 'unassigned';
  state: StateFilter;
  page: number;
}

export function useWorkItems(f: ItemFilter, enabled = true) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['workqueues', 'items', f],
    queryFn: () =>
      call(
        api.GET('/api/admin/workqueues/items', {
          params: { query: { queueKey: f.queueKey || undefined, assignee: f.assignee, state: f.state, sort: 'deadline', page: f.page, limit: 20 } },
        }),
      ) as Promise<Page<WorkItem>>,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useWorkItem(id: string | null) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['workqueues', 'item', id],
    queryFn: () => call(api.GET('/api/admin/workqueues/items/{id}', { params: { path: { id: id! } } })) as Promise<WorkItem>,
    enabled: !!id,
  });
}

export function useItemAction(id: string) {
  const { api } = useApi();
  const refresh = useWorkqueuesRefresh();
  return useMutation({ mutationFn: (a: ItemAction) => runAction(api, id, a), onSuccess: refresh });
}

/** Queues the caller may see, for the queue filter and the New task picker. */
export function useQueueList() {
  const { api } = useApi();
  return useQuery({ queryKey: ['workqueues', 'queues'], queryFn: () => call(api.GET('/api/admin/workqueues/queues', { params: { query: {} } })) as Promise<QueueSummary[]> });
}

/** A person who can be picked as assignee, lead or backup. */
export interface Person {
  staffId: string;
  name: string;
  roleKeys: string[];
  roleNames: string[];
  away: boolean;
}

/**
 * Active staff from Staff and permissions (GET /api/admin/access/members needs access.roles.view). Without that
 * permission `people` is empty and `available` false; pickers then fall back to the people named on the item.
 */
export function useStaffPeople(enabled = true) {
  const { api } = useApi();
  const staff = useStaffSession();
  const canList = staff.can('access.roles.view');
  const q = useQuery({
    queryKey: ['access', 'members', 'active-people'],
    queryFn: () => call(api.GET('/api/admin/access/members', { params: { query: { status: 'active', limit: 100 } } })),
    enabled: enabled && canList,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const people: Person[] = (q.data?.items ?? []).map((m) => ({ staffId: m.account.id, name: m.account.displayName, roleKeys: m.roles.map((r) => r.key), roleNames: m.roles.map((r) => r.name), away: !!m.away }));
  return { people, available: canList && q.isSuccess, isPending: canList && q.isPending, error: q.error };
}

/**
 * Who an item can go to: the API accepts staff holding the queue's owner role, or the queue's lead or backup
 * (ASSIGNEE_NOT_ELIGIBLE otherwise). Without the staff list, the lead, backup and current assignee.
 */
export function assigneeOptions(it: WorkItem, people: Person[]): Array<{ value: string; label: string }> {
  // The seeded placeholder staff are named "Not set": they can't take work.
  const refs: Array<StaffRef | null | undefined> = [it.lead, it.backup, it.assignee];
  const named = refs.filter((s): s is StaffRef & { staffId: string } => !!s?.staffId && staffName(s) !== 'Not set');
  const ids = new Set(named.map((s) => s.staffId));
  const fromList = people.filter((p) => ids.has(p.staffId) || p.roleKeys.includes(it.ownerRole));
  const out = new Map<string, string>();
  for (const p of fromList) out.set(p.staffId, `${p.name}${p.staffId === it.lead.staffId ? ' (lead)' : p.staffId === it.backup.staffId ? ' (backup)' : ''}${p.away ? ' · away' : ''}`);
  for (const s of named) if (!out.has(s.staffId)) out.set(s.staffId, `${staffName(s)}${s.staffId === it.lead.staffId ? ' (lead)' : s.staffId === it.backup.staffId ? ' (backup)' : ''}`);
  return [...out].map(([value, label]) => ({ value, label }));
}

/** A <input type="datetime-local"> value (the browser's local time) as an ISO instant, or null when empty. */
export const localToIso = (v: string) => (v ? new Date(v).toISOString() : null);
/** The datetime-local value for `hours` from now, on the hour. */
export function localIn(hours: number) {
  const d = new Date(Date.now() + hours * 3_600_000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

/* ---------------------------------------------------------------- routine checks */

/** Mark a routine check done; a shared check (several managers) records this person's check-in. */
export function useCompleteCheck() {
  const { api } = useApi();
  const refresh = useWorkqueuesRefresh();
  return useMutation({
    mutationFn: (v: { id: string; note?: string }) => call(api.POST('/api/admin/workqueues/routine-checks/{id}/complete', { params: { path: { id: v.id } }, body: { note: v.note?.trim() || null } })),
    onSuccess: refresh,
  });
}

/* ---------------------------------------------------------------- queue setup */

export function useQueueDefinition(key: string | null) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['workqueues', 'queue', key],
    queryFn: () => call(api.GET('/api/admin/workqueues/queues/{key}', { params: { path: { key: key! } } })),
    enabled: !!key,
  });
}

/**
 * Change a queue's lead and backup. PATCH takes the whole QueueInput (fields left out fall back to defaults, e.g.
 * visibleToSeller false), so the rest is sent back exactly as GET /queues/{key} returned it.
 */
export function useUpdateQueuePeople() {
  const { api } = useApi();
  const refresh = useWorkqueuesRefresh();
  return useMutation({
    mutationFn: ({ queue: q, leadId, backupId, reason }: { queue: QueueDefinition; leadId: string; backupId: string; reason: string }) =>
      call(
        api.PATCH('/api/admin/workqueues/queues/{key}', {
          params: { path: { key: q.key } },
          body: {
            name: q.name,
            area: q.area,
            ownerRole: q.ownerRole,
            leadId,
            backupId,
            escalationRoute: q.escalationRoute,
            defaultDeadlineMinutes: q.defaultDeadlineMinutes,
            businessHoursOnly: q.businessHoursOnly,
            pauseWhileWaiting: q.pauseWhileWaiting,
            screen: q.screen,
            screenFilter: q.screenFilter ?? null,
            visibleToSeller: q.visibleToSeller,
            active: q.active,
            reason,
          },
        }),
      ),
    onSuccess: refresh,
  });
}

/* ---------------------------------------------------------------- manual tasks and bulk assign */

export function useCreateTask() {
  const { api } = useApi();
  const refresh = useWorkqueuesRefresh();
  return useMutation({
    mutationFn: (body: components['schemas']['workqueues.ManualTaskInput']) => call(api.POST('/api/admin/workqueues/items', { body })) as Promise<WorkItem>,
    onSuccess: refresh,
  });
}

export function useBulkAssign() {
  const { api } = useApi();
  const refresh = useWorkqueuesRefresh();
  return useMutation({
    mutationFn: (body: { itemIds: string[]; assigneeId: string }) => call(api.POST('/api/admin/workqueues/items/bulk-assign', { body })) as Promise<{ assigned: number; skipped: unknown[] }>,
    onSuccess: refresh,
  });
}
