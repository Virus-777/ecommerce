import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Avatar, Badge, Button, Card, Checkbox, Dialog, Field, Icon, PageHeader, SearchInput, SegmentedControl, Select, StatusBadge, Switch, TableWrap, Textarea, TextInput } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, date, dateTime, shortDate } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import {
  areaIcon, AUTHORITY_OPTIONS, effectiveInstant, GAP_STATUS, GAP_TONE, grantedKeys, limitDraft, limitValue, MEMBER_STATUS, sameLimit, todayKey,
  type AwayPeriod, type Coverage, type LimitChange, type LimitDraft, type Role, type RoleDetail, type StaffMember,
} from './data/staff';
import { isStepUpCancel, reauthField, useStepUp } from './data/step-up';
import { StaffInvitations } from './data/staff-invitations';
import { InvitationLinkDialog, type IssuedLink } from './data/invitation-link';
import { StaffMemberDrawer } from './data/staff-member-drawer';

// Design: pages/admin/admin-staff.html · view "edit-role" = full-page role editor (?view=edit-role&role=<role id>;
// without a role it opens the Finance Manager, the design's example).
// Data: access roles, members, coverage, away periods, role detail; invitations and permission changes are confirmed with the password (reauth).
// Sending an invitation opens a dialog with the link and pass code the API returns once (data/invitation-link.tsx).
// A member row opens the member drawer (data/staff-member-drawer.tsx: roles, account status, disable, lock, sign out…);
// Staff members › Invited lists the identity invitations with Resend and Cancel (data/staff-invitations.tsx).

type StaffFilter = 'all' | 'active' | 'invited';
interface Invite { name: string; email: string; roleId: string; managerId: string; reason: string; requestLimits: boolean }
const EMPTY_INVITE: Invite = { name: '', email: '', roleId: '', managerId: '', reason: '', requestLimits: false };

function validateInvite(f: Invite) {
  const e: Partial<Record<keyof Invite | 'role', string>> = {};
  if (!f.name.trim()) e.name = 'Enter the first and last name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = 'Enter a work email.';
  if (!f.roleId) e.role = 'Choose a role.';
  if (!f.reason.trim()) e.reason = 'Enter why this person needs this role.';
  return e;
}

const lastActive = (m: StaffMember) => {
  if (m.status === 'invited') return 'Not signed in';
  const at = m.account.lastActiveAt;
  if (!at) return 'Not signed in';
  const mins = (Date.now() - new Date(at).getTime()) / 60_000;
  if (mins < 5) return 'Active now';
  return mins < 24 * 60 ? `Today ${dateTime(at).split(', ')[1]}` : shortDate(at);
};

function SkeletonRows({ cols, rows = 4 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} aria-hidden="true">
          {Array.from({ length: cols }, (_, j) => (
            <td key={j}>
              <span className="sk sk-line" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export default function Staff() {
  const [view, setView] = useView<'edit-role'>();
  const [params] = useSearchParams();
  const { api } = useApi();
  const qc = useQueryClient();
  const me = useStaffSession();
  const canView = me.can('access.roles.view');
  const canManage = me.can('access.roles.manage');
  const canPropose = me.can('access.limits.propose');
  const stepUp = useStepUp();

  const rolesQ = useQuery({ queryKey: ['access', 'roles'], queryFn: () => call(api.GET('/api/admin/access/roles')), enabled: canView });
  const membersQ = useQuery({ queryKey: ['access', 'members'], queryFn: () => call(api.GET('/api/admin/access/members', { params: { query: { limit: 100 } } })), enabled: canView });
  const coverageQ = useQuery({ queryKey: ['access', 'coverage'], queryFn: () => call(api.GET('/api/admin/access/coverage')) as Promise<Coverage>, enabled: canView });
  const awayQ = useQuery({ queryKey: ['access', 'away-periods'], queryFn: () => call(api.GET('/api/admin/access/away-periods', { params: { query: { limit: 50 } } })), enabled: canView });
  const pendingQ = useQuery({
    queryKey: ['access', 'limit-changes', 'pending_approval'],
    queryFn: () => call(api.GET('/api/admin/access/limit-changes', { params: { query: { status: 'pending_approval', limit: 100 } } })),
    enabled: canView,
  });

  const roles = useMemo(() => (rolesQ.data ?? []).filter((r) => !r.archived), [rolesQ.data]);
  const members = membersQ.data?.items ?? [];
  const owners = roles.find((r) => r.key === 'business_owner')?.people.map((p) => p.name) ?? [];
  const ownerText = owners.length ? owners.join(' or ') : 'the Business Owner';
  const pendingRoles = new Set((pendingQ.data?.items ?? []).map((c) => c.role.id));

  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<StaffFilter>('all');
  /** The member whose drawer is open. */
  const [memberId, setMemberId] = useState<string | null>(null);
  // Invitations come from identity (Resend, Cancel); without that permission "Invited" filters the member list.
  const canInvitations = me.can('identity.staff-accounts.manage');
  const [notice, setNotice] = useState<{ title: string; text: string } | null>(null);
  const flash = (title: string, text: string) => {
    setNotice({ title, text });
    announce(title);
  };

  /* ---------- invite ---------- */

  const [invite, setInvite] = useState<Invite>(EMPTY_INVITE);
  const [inviteTried, setInviteTried] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const inviteErr = inviteTried ? validateInvite(invite) : {};
  const setInv = <K extends keyof Invite>(k: K, v: Invite[K]) => setInvite((f) => ({ ...f, [k]: v }));
  /** The link and pass code of the invitation just sent, shown once */
  const [issued, setIssued] = useState<IssuedLink | null>(null);

  const inviteM = useMutation({
    mutationFn: (f: Invite) =>
      stepUp.run((token) =>
        call(
          api.POST('/api/admin/access/staff-invitations', {
            body: { email: f.email.trim(), name: f.name.trim(), roleIds: [f.roleId], reportsToAccountId: f.managerId || null, reason: f.reason.trim(), requestLimitReview: f.requestLimits, ...reauthField(token) },
          }),
        ),
      ),
    onSuccess: (sent, f) => {
      const m = sent.member;
      void qc.invalidateQueries({ queryKey: ['access'] });
      setInvite(EMPTY_INVITE);
      setInviteTried(false);
      const roleName = roles.find((r) => r.id === f.roleId)?.name ?? 'staff';
      const manager = members.find((x) => x.account.id === f.managerId)?.account.displayName;
      const pendingGrant = m.roles.length === 0;
      // Offline server: no email arrives, so the inviter hands over the link and pass code from the response
      setIssued({ name: m.account.displayName, email: m.account.email, acceptUrl: sent.acceptUrl, passCode: sent.passCode, expiresAt: sent.expiresAt });
      flash(
        `${m.account.displayName} is invited`,
        `Invited as ${roleName}${manager ? `, reporting to ${manager}` : ''}. The invitation expires on ${date(sent.expiresAt)}; if the link or pass code is lost, use Resend under Staff members › Invited.` +
          (pendingGrant ? ' The role carries sensitive permissions, so a second reviewer approves it before it applies.' : '') +
          (f.requestLimits ? ` Approval limits were requested from ${ownerText}.` : ''),
      );
    },
  });
  const sendInvite = () => {
    setInviteTried(true);
    if (Object.keys(validateInvite(invite)).length) return;
    inviteM.mutate(invite);
  };
  const focusInvite = () => {
    nameRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    nameRef.current?.focus({ preventScroll: true });
  };
  const inviteServerErr: unknown = inviteM.error && !isStepUpCancel(inviteM.error) ? inviteM.error : null;
  const inviteFieldErr = inviteServerErr instanceof ApiError ? inviteServerErr.fieldErrors : {};

  /* ---------- add role ---------- */

  const [addOpen, setAddOpen] = useState(false);
  const [newRole, setNewRole] = useState({ name: '', workArea: '', reason: '' });
  const [newRoleTried, setNewRoleTried] = useState(false);
  const addRoleM = useMutation({
    mutationFn: () => call(api.POST('/api/admin/access/roles', { body: { name: newRole.name.trim(), workArea: newRole.workArea.trim(), kind: 'custom', reason: newRole.reason.trim() } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['access', 'roles'] });
      setAddOpen(false);
      setNewRole({ name: '', workArea: '', reason: '' });
      setNewRoleTried(false);
      flash(`Role ${r.name} added`, 'It has no permissions yet. Open Edit role to choose what it can do.');
    },
  });
  const newRoleErr = newRoleTried
    ? { name: newRole.name.trim() ? undefined : 'Enter a role name.', workArea: newRole.workArea.trim() ? undefined : 'Enter the working area.', reason: newRole.reason.trim() ? undefined : 'Enter a reason.' }
    : {};

  /* ---------- list ---------- */

  const term = q.trim().toLowerCase();
  const shownRoles = term ? roles.filter((r) => [r.name, r.workArea, ...r.people.map((p) => p.name), ...r.backups.map((b) => b.name)].some((s) => s.toLowerCase().includes(term))) : roles;
  const shownStaff = members.filter((s) => filter === 'all' || s.status === filter);
  const nActive = members.filter((s) => s.status === 'active').length;
  const nInvited = members.filter((s) => s.status === 'invited').length;
  const away = (awayQ.data?.items ?? []) as AwayPeriod[];

  /* ---------- editor ---------- */

  const roleParam = params.get('role');
  const editingId = roleParam ?? roles.find((r) => r.key === 'finance_manager')?.id ?? roles[0]?.id;
  const detailQ = useQuery({
    queryKey: ['access', 'role', editingId],
    queryFn: () => call(api.GET('/api/admin/access/roles/{id}', { params: { path: { id: editingId! } } })) as Promise<RoleDetail>,
    enabled: view === 'edit-role' && !!editingId && canView,
  });
  const detail = detailQ.data;
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState<LimitDraft[]>([]);
  const [reason, setReason] = useState('');
  const [effective, setEffective] = useState(todayKey());
  const [reasonErr, setReasonErr] = useState('');
  const [editErr, setEditErr] = useState('');
  useEffect(() => {
    if (!detail) return;
    setPerms(new Set(grantedKeys(detail.permissions)));
    setLimits(detail.limits.map(limitDraft));
    setReason('');
    setEffective(todayKey());
    setReasonErr('');
    setEditErr('');
  }, [detail]);

  const original = useMemo(() => new Set(detail ? grantedKeys(detail.permissions) : []), [detail]);
  const originalLimits = useMemo(() => (detail ? detail.limits.map(limitDraft) : []), [detail]);
  const permsChanged = detail ? perms.size !== original.size || [...perms].some((k) => !original.has(k)) : false;
  const changedLimits = limits.filter((l, i) => originalLimits[i] && !sameLimit(l, originalLimits[i]));

  const saveRoleM = useMutation({
    mutationFn: async () => {
      if (!detail) throw new Error('Role not loaded.');
      const id = detail.role.id;
      let permResult: RoleDetail | null = null;
      let limitResult: LimitChange | null = null;
      if (permsChanged) {
        permResult = (await stepUp.run((token) =>
          call(api.PUT('/api/admin/access/roles/{id}/permissions', { params: { path: { id } }, body: { permissionKeys: [...perms], reason: reason.trim(), ...reauthField(token) } })),
        )) as RoleDetail;
      }
      if (changedLimits.length) {
        const changes = changedLimits.map((l) => ({ actionKey: l.actionKey, value: limitValue(l) }));
        limitResult = (await call(api.POST('/api/admin/access/limit-changes', { body: { roleId: id, changes, reason: reason.trim(), effectiveFrom: effectiveInstant(effective) } }))) as LimitChange;
      }
      return { permResult, limitResult, name: detail.role.name };
    },
    onSuccess: ({ permResult, limitResult, name }) => {
      void qc.invalidateQueries({ queryKey: ['access'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
      const parts: string[] = [];
      let waiting = false;
      if (permResult) {
        if (permResult.pendingPermissionApproval) {
          waiting = true;
          parts.push('The new permissions carry sensitive access, so a second reviewer approves them before they apply.');
        } else parts.push('The new permissions apply now.');
      }
      if (limitResult) {
        if (limitResult.status === 'pending_approval') {
          waiting = true;
          parts.push(`${ownerText}, Business Owner, reviews the new limits. If approved, they apply from ${date(limitResult.effectiveFrom)}. Requests already waiting for approval keep the old limit.`);
        } else parts.push(`The new limits are ${limitResult.status === 'applied' ? 'in force' : `scheduled for ${date(limitResult.effectiveFrom)}`}.`);
      }
      setView('');
      flash(waiting ? `${name} changes sent for approval` : `${name} changes saved`, parts.join(' '));
    },
    onError: (e) => {
      if (!isStepUpCancel(e)) setEditErr(e instanceof ApiError ? errorMessage(e) : (e as Error).message);
    },
  });

  const sendForApproval = () => {
    setEditErr('');
    if (!permsChanged && !changedLimits.length) {
      setEditErr('Nothing has changed yet.');
      return;
    }
    if (!reason.trim()) {
      setReasonErr('Enter a reason. It is saved in Action history with the request.');
      document.getElementById('er-reason')?.focus();
      return;
    }
    try {
      changedLimits.forEach((l) => limitValue(l));
    } catch (e) {
      setEditErr((e as Error).message);
      return;
    }
    saveRoleM.mutate();
  };

  const setPerm = (key: string, on: boolean) => setPerms((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; });
  const setArea = (keys: string[], on: boolean) => setPerms((s) => { const n = new Set(s); keys.forEach((k) => (on ? n.add(k) : n.delete(k))); return n; });
  const setLimit = (i: number, patch: Partial<LimitDraft>) => setLimits((l) => l.map((x, xi) => (xi === i ? { ...x, ...patch } : x)));

  if (!canView) {
    return (
      <AdminLayout active="staff">
        <PageHeader crumbs={[{ label: 'Reports and settings' }, { label: 'Staff and roles' }]} title="Staff and roles" />
        <Alert tone="info" title="You don’t have access to staff and roles">
          Viewing roles and staff needs the “View roles” permission. Ask a Platform Administrator.
        </Alert>
      </AdminLayout>
    );
  }

  if (view === 'edit-role') {
    const role = detail?.role ?? roles.find((r) => r.id === editingId);
    const holders = role?.people.length ?? 0;
    const groups = detail?.permissions ?? [];
    const allowed = perms.size;
    const total = groups.reduce((n, g) => n + g.permissions.length, 0);
    const busy = saveRoleM.isPending || stepUp.waiting;
    const pendingLimit = detail?.pendingLimitChange;
    const pendingPerm = detail?.pendingPermissionApproval;
    const sendBtn = (
      <Button size="sm" icon="send" onClick={sendForApproval} disabled={busy || !(canManage || canPropose)}>
        Send for approval
      </Button>
    );
    return (
      <AdminLayout active="staff">
        <PageHeader
          crumbs={[{ label: 'Staff and roles', to: href('admin/staff') }, { label: role?.name ?? 'Role' }]}
          title={`Edit role: ${role?.name ?? ''}`}
          sub={
            role
              ? `Working area: ${role.workArea} · Lead ${role.lead?.name ?? 'not set'} · Backup ${role.backups[0]?.name ?? 'not set'} · ${holders} ${holders === 1 ? 'person holds' : 'people hold'} this role`
              : undefined
          }
          actions={
            <>
              <Button variant="ghost" size="sm" to={href('admin/staff')}>
                Cancel
              </Button>
              {sendBtn}
            </>
          }
        />
        <Alert tone="warning" title="Granting access is not financial authority">
          You can change which screens this role can open. The approval limits below are proposals until {ownerText}, Business Owner, approves them. Platform Administrators cannot approve their own financial limits.
        </Alert>
        {!(canManage || canPropose) && (
          <Alert tone="info" title="View only">
            Changing permissions needs “Manage roles”, and proposing limits needs “Propose limits”. You can see this role but not change it.
          </Alert>
        )}
        {(pendingLimit || pendingPerm) && (
          <Alert tone="info" title="Changes waiting for approval">
            {pendingLimit && `Limit change proposed ${date(pendingLimit.createdAt)}, effective ${date(pendingLimit.effectiveFrom)}. `}
            {pendingPerm && 'A permission change is waiting for a second reviewer.'}
          </Alert>
        )}
        {editErr && (
          <Alert tone="danger" title="The changes weren’t sent">
            {editErr}
          </Alert>
        )}
        {detailQ.isError ? (
          <LoadError error={detailQ.error} onRetry={() => void detailQ.refetch()} />
        ) : (
          <div className="ac-main">
            <div className="stack gap-4">
              <div className="row between">
                <h2 className="h3">Permissions by area</h2>
                <span className="xs muted">
                  {allowed} of {total} actions allowed
                </span>
              </div>
              {!detail && (
                <Card titleAs="h3" title={<span className="sk sk-line" />}>
                  <SkeletonLines rows={4} />
                </Card>
              )}
              {groups.map((area, a) => {
                const keys = area.permissions.map((p) => p.permission.key);
                const n = keys.filter((k) => perms.has(k)).length;
                const all = n === keys.length;
                const unavailable = area.permissions.filter((p) => !p.permission.available).length;
                return (
                  <Card
                    key={area.area}
                    titleAs="h3"
                    title={
                      <span className="row gap-2 nowrap">
                        <Icon name={areaIcon(area.area)} className="ic-sm" />
                        {area.area}
                      </span>
                    }
                    sub={`${n} of ${keys.length} allowed`}
                    actions={<Switch id={`er-all-${a}`} label="All" checked={all} aria-checked={all} data-switch="" disabled={!canManage} onChange={(e) => setArea(keys, e.target.checked)} />}
                  >
                    <div className="ac-perm">
                      {area.permissions.map((p, i) => (
                        <Checkbox
                          key={p.permission.key}
                          id={`er-p-${a}-${i}`}
                          label={p.permission.label}
                          title={p.permission.desc}
                          checked={perms.has(p.permission.key)}
                          disabled={!canManage}
                          onChange={(e) => setPerm(p.permission.key, e.target.checked)}
                        />
                      ))}
                    </div>
                    {area.permissions.some((p) => p.permission.sensitive) && (
                      <span className="xs muted">
                        <Icon name="lock" className="ic-sm" /> Sensitive permissions in this area need a second reviewer before they apply.
                      </span>
                    )}
                    {unavailable > 0 && (
                      <span className="xs muted">
                        <Icon name="info" className="ic-sm" /> {unavailable} {unavailable === 1 ? 'permission belongs' : 'permissions belong'} to a module that is switched off.
                      </span>
                    )}
                  </Card>
                );
              })}
            </div>
            <div className="stack gap-5">
              <Card title="Approval limits" titleAs="h3" sub={`Set by the Business Owner.${detail?.limits.length ? '' : ' This role has no approval limits.'}`}>
                {!detail && <SkeletonLines rows={3} />}
                {limits.map((l, i) => (
                  <div className="ac-limit" key={l.id}>
                    <div className="ac-limit-t stack gap-0">
                      <span className="small strong">{l.title}</span>
                      <span className="xs muted">{l.summary}</span>
                    </div>
                    <Field label="Authority">
                      <Select id={`er-auth-${i}`} options={AUTHORITY_OPTIONS} value={l.authority} disabled={!canPropose} onChange={(e) => setLimit(i, { authority: e.target.value as LimitDraft['authority'] })} />
                    </Field>
                    {l.kind !== 'none' && (
                      <>
                        <Field label={l.kind === 'money' ? 'Limit' : l.kind === 'percent' ? 'Limit (%)' : 'Limit (units)'}>
                          <TextInput id={`er-lim-${i}`} prefix={l.kind === 'money' ? '$' : undefined} value={l.limit} disabled={!canPropose} onChange={(e) => setLimit(i, { limit: e.target.value })} />
                        </Field>
                        <Field label="Second reviewer above">
                          <TextInput id={`er-rev-${i}`} prefix={l.kind === 'money' ? '$' : undefined} value={l.review} disabled={!canPropose} onChange={(e) => setLimit(i, { review: e.target.value })} />
                        </Field>
                      </>
                    )}
                  </div>
                ))}
              </Card>

              <Card title="Reason for change" titleAs="h3" foot={sendBtn}>
                <Field label="Reason (required)" error={reasonErr}>
                  <Textarea
                    id="er-reason"
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                      if (e.target.value.trim()) setReasonErr('');
                    }}
                  />
                </Field>
                <Field label="Effective from" hint="Applies to limit changes. Requests already waiting for approval keep the old limit.">
                  <TextInput id="er-eff" type="date" icon="calendar" min={todayKey()} value={effective} onChange={(e) => setEffective(e.target.value)} />
                </Field>
              </Card>
            </div>
          </div>
        )}
        {stepUp.dialog}
      </AdminLayout>
    );
  }

  const editLink = (r: Role, text: string, className: string) => (
    <Link className={className} to={href('admin/staff', 'edit-role', undefined, { role: r.id })}>
      {text}
    </Link>
  );
  const roleName = (r: Role, className: string) =>
    pendingRoles.has(r.id) ? (
      <span className="row gap-2 nowrap">
        <span className={className}>{r.name}</span>
        <Badge tone="warning">Approval pending</Badge>
      </span>
    ) : (
      <span className={className}>{r.name}</span>
    );
  const noRoles = <span className="small muted">{term ? `No roles match “${q}”.` : 'No roles yet.'}</span>;
  const peopleOf = (r: Role) => {
    const lead = r.lead ? [r.lead] : [];
    return [...lead, ...r.people.filter((p) => p.accountId !== r.lead?.accountId)];
  };
  const memberOptions = [{ value: '', label: 'No one' }, ...members.filter((m) => m.status === 'active').map((m) => ({ value: m.account.id, label: m.account.displayName }))];
  const roleOptions = [{ value: '', label: 'Choose a role' }, ...roles.map((r) => ({ value: r.id, label: r.name }))];

  return (
    <AdminLayout active="staff">
      <PageHeader
        crumbs={[{ label: 'Reports and settings' }, { label: 'Staff and roles' }]}
        title="Staff and roles"
        sub={rolesQ.data && membersQ.data ? `${roles.length} roles · ${nActive} active staff · ${nInvited} ${nInvited === 1 ? 'invitation' : 'invitations'}` : 'Loading…'}
        actions={
          canManage ? (
            <>
              <Button variant="secondary" size="sm" icon="plus" onClick={() => setAddOpen(true)}>
                Add role
              </Button>
              <Button size="sm" icon="user-plus" onClick={focusInvite}>
                Invite staff
              </Button>
            </>
          ) : undefined
        }
      />
      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.text}
        </Alert>
      )}
      <Alert tone="warning" title="Access is not financial authority">
        Assigning a role gives access to its screens. Approval limits for payouts, refunds, holds, restrictions and publication overrides are set by the Business Owner, {ownerText}, and changes to them need Business Owner approval.
      </Alert>
      <div className="ac-main">
        <div className="stack gap-5">
          <Card flush title="Roles" sub="A role is a set of responsibilities, not a person. One person can hold several roles." actions={<SearchInput id="st-q" placeholder="Search roles" value={q} onChange={setQ} />}>
            {rolesQ.isError ? (
              <LoadError error={rolesQ.error} onRetry={() => void rolesQ.refetch()} />
            ) : (
              <>
                <div className="no-phone">
                  <TableWrap label="Roles table">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Role</th>
                          <th scope="col">Working area</th>
                          <th scope="col">People</th>
                          <th scope="col">Backup</th>
                          <th scope="col">Approval limit</th>
                          <th className="col-pin" scope="col">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rolesQ.isPending && <SkeletonRows cols={6} />}
                        {shownRoles.map((r) => (
                          <tr key={r.id}>
                            <td>{roleName(r, 'small strong')}</td>
                            <td>
                              <span className="small">{r.workArea}</span>
                            </td>
                            <td>
                              {peopleOf(r).map((p) => (
                                <span className="ac-who" key={p.accountId}>
                                  <Avatar name={p.name} className="ac-av" />
                                  <span className="stack gap-0">
                                    <span className="small strong nowrap">{p.name}</span>
                                  </span>
                                </span>
                              ))}
                              {!r.people.length && <span className="small muted">No one yet</span>}
                            </td>
                            <td>
                              <span className="small">{r.backups.map((b) => b.name).join(', ') || '—'}</span>
                            </td>
                            <td>
                              <span className="small">{r.limitSummary}</span>
                            </td>
                            <td className="col-pin">{editLink(r, canManage || canPropose ? 'Edit role' : 'View role', 'small strong nowrap')}</td>
                          </tr>
                        ))}
                        {!rolesQ.isPending && !shownRoles.length && (
                          <tr>
                            <td colSpan={6}>{noRoles}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </TableWrap>
                </div>
                <div className="ac-mlist only-phone">
                  {rolesQ.isPending && <SkeletonLines rows={4} />}
                  {shownRoles.map((r) => (
                    <div className="ac-mi" key={r.id}>
                      <div className="row between gap-2 nowrap top">
                        {roleName(r, 'small strong min-w-0')}
                        {editLink(r, canManage || canPropose ? 'Edit' : 'View', 'small strong')}
                      </div>
                      <div className="xs sub">
                        {r.workArea} · {r.people.map((p) => p.name).join(', ') || 'no one yet'} · backup {r.backups[0]?.name ?? 'not set'}
                      </div>
                      <div className="xs sub">Limit: {r.limitSummary}</div>
                    </div>
                  ))}
                  {!rolesQ.isPending && !shownRoles.length && <div className="ac-mi">{noRoles}</div>}
                </div>
              </>
            )}
          </Card>

          <Card
            flush
            titleAs="h3"
            title="Staff members"
            sub="Staff sign in with email and password"
            actions={
              <SegmentedControl<StaffFilter>
                items={[
                  { label: 'All', value: 'all' },
                  { label: 'Active', value: 'active' },
                  { label: 'Invited', value: 'invited' },
                ]}
                active={filter}
                onChange={setFilter}
              />
            }
          >
            {filter === 'invited' && canInvitations ? (
              <StaffInvitations onDone={flash} />
            ) : membersQ.isError ? (
              <LoadError error={membersQ.error} onRetry={() => void membersQ.refetch()} />
            ) : (
              <>
                <div className="no-phone">
                  <TableWrap label="Staff members table">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Name</th>
                          <th scope="col">Roles</th>
                          <th scope="col">Last active</th>
                          <th className="col-pin" scope="col">
                            Status
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {membersQ.isPending && <SkeletonRows cols={4} />}
                        {shownStaff.map((s) => {
                          const invited = s.status === 'invited';
                          const badges = s.roles.map((r) => (
                            <Badge tone="outline" key={r.id}>
                              {r.name}
                            </Badge>
                          ));
                          return (
                            <tr key={s.account.id}>
                              <td>
                                <span className="ac-who">
                                  <Avatar name={s.account.displayName} className="ac-av" />
                                  <span className="stack gap-0">
                                    <button type="button" className="btn btn-link small strong" onClick={() => setMemberId(s.account.id)}>
                                      {s.account.displayName}
                                    </button>
                                    <span className="xs muted">{s.account.email}</span>
                                  </span>
                                </span>
                              </td>
                              <td>{invited ? badges : <span className="row gap-1">{badges}</span>}</td>
                              <td>
                                <span className={invited ? 'small muted' : 'small'}>{lastActive(s)}</span>
                              </td>
                              <td className="col-pin">
                                <span className="row gap-1 nowrap">
                                  <StatusBadge status={MEMBER_STATUS[s.status]} />
                                  {s.away && <Badge tone="warning">Away until {shortDate(s.away.to)}</Badge>}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                        {!membersQ.isPending && !shownStaff.length && (
                          <tr>
                            <td colSpan={4}>
                              <span className="small muted">{filter === 'invited' ? 'No open invitations.' : 'No staff members here.'}</span>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </TableWrap>
                </div>
                <div className="ac-mlist only-phone">
                  {membersQ.isPending && <SkeletonLines rows={4} />}
                  {shownStaff.map((s) => (
                    <div className="ac-mi" key={s.account.id}>
                      <div className="row between gap-2 nowrap top">
                        <button type="button" className="btn btn-link small strong min-w-0" onClick={() => setMemberId(s.account.id)}>
                          {s.account.displayName}
                        </button>
                        <StatusBadge status={MEMBER_STATUS[s.status]} />
                      </div>
                      {s.status === 'invited' ? (
                        <div className="xs sub">{s.roles.map((r) => r.name).join(', ') || 'Role waiting for approval'} · invitation sent</div>
                      ) : (
                        <>
                          <div className="xs sub">{s.roles.map((r) => r.name).join(', ')}</div>
                          <div className="xs sub">
                            Last active: {lastActive(s)}
                            {s.away ? ` · away until ${shortDate(s.away.to)}` : ''}
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                  {!membersQ.isPending && !shownStaff.length && <div className="ac-mi small muted">No staff members here.</div>}
                </div>
              </>
            )}
          </Card>
        </div>

        <div className="stack gap-5">
          {canManage ? (
            <Card
              title="Invite staff"
              titleAs="h3"
              sub="Invitations expire after 7 days"
              foot={
                <Button size="sm" icon="send" onClick={sendInvite} disabled={inviteM.isPending}>
                  Send invitation
                </Button>
              }
            >
              {inviteServerErr != null && (
                <Alert tone="danger" title="The invitation wasn’t sent">
                  {errorMessage(inviteServerErr)}
                </Alert>
              )}
              <Field label="Full name" error={inviteErr.name ?? inviteFieldErr.name}>
                <TextInput id="st-name" ref={nameRef} placeholder="First and last name" value={invite.name} onChange={(e) => setInv('name', e.target.value)} />
              </Field>
              <Field label="Work email" error={inviteErr.email ?? inviteFieldErr.email}>
                <TextInput id="st-email" type="email" placeholder="name@marketly.example" value={invite.email} onChange={(e) => setInv('email', e.target.value)} />
              </Field>
              <Field label="Role" hint="Add more roles from their name under Staff members." error={inviteErr.role}>
                <Select id="st-role" options={roleOptions} value={invite.roleId} onChange={(e) => setInv('roleId', e.target.value)} />
              </Field>
              <Field label="Reports to">
                <Select id="st-mgr" options={memberOptions} value={invite.managerId} onChange={(e) => setInv('managerId', e.target.value)} />
              </Field>
              <Field label="Reason for access" hint="Required. Saved in Action history with the invitation." error={inviteErr.reason ?? inviteFieldErr.reason}>
                <Textarea id="st-reason" placeholder="Why this person needs this role, e.g. new hire for the Reno, NV warehouse" value={invite.reason} onChange={(e) => setInv('reason', e.target.value)} />
              </Field>
              <Checkbox id="st-limit" label="Request approval limits from the Business Owner" checked={invite.requestLimits} onChange={(e) => setInv('requestLimits', e.target.checked)} />
            </Card>
          ) : (
            <Card title="Invite staff" titleAs="h3">
              <span className="small muted">Inviting staff needs the “Manage roles” permission (Platform Administrator).</span>
            </Card>
          )}

          <Card title="Coverage gaps" titleAs="h3" sub="Every work queue needs a lead and a backup">
            {coverageQ.isError ? (
              <LoadError error={coverageQ.error} onRetry={() => void coverageQ.refetch()} />
            ) : coverageQ.isPending ? (
              <SkeletonLines rows={3} />
            ) : coverageQ.data.gaps.length ? (
              <ul className="list">
                {coverageQ.data.gaps.map((g, i) => (
                  <li key={`${g.kind}-${i}`}>
                    <span className="grow stack gap-0">
                      <span className="small strong">{g.message}</span>
                      <span className="xs muted">{[...g.roles.map((r) => r.name), ...g.people.map((p) => p.name)].join(' · ')}</span>
                    </span>
                    <Badge tone={GAP_TONE[g.severity]}>{GAP_STATUS[g.severity]}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="small muted">Every role has a lead and a backup.</span>
            )}
          </Card>

          <Card title="Away periods" titleAs="h3" sub="Current and upcoming time away, and who covers">
            {awayQ.isError ? (
              <LoadError error={awayQ.error} onRetry={() => void awayQ.refetch()} />
            ) : awayQ.isPending ? (
              <SkeletonLines rows={2} />
            ) : away.length ? (
              <ul className="list">
                {away.map((a) => (
                  <li key={a.id}>
                    <span className="grow stack gap-0">
                      <span className="small strong">
                        {a.account.name} · {shortDate(a.from)} – {shortDate(a.to)}
                      </span>
                      <span className="xs muted">{a.coverage.map((c) => `${c.role.name}: ${c.coveredBy.name}`).join(' · ') || 'No cover set'}</span>
                    </span>
                    <Badge tone={a.status === 'active' ? 'warning' : a.status === 'pending_approval' ? 'info' : undefined}>
                      {a.status === 'pending_approval' ? 'Approval pending' : a.status === 'active' ? 'Away now' : 'Planned'}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="small muted">No one is away or planning time away.</span>
            )}
          </Card>
        </div>
      </div>

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add role"
        foot={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              icon="plus"
              disabled={addRoleM.isPending}
              onClick={() => {
                setNewRoleTried(true);
                if (newRole.name.trim() && newRole.workArea.trim() && newRole.reason.trim()) addRoleM.mutate();
              }}
            >
              Add role
            </Button>
          </>
        }
      >
        {addRoleM.isError && (
          <Alert tone="danger" title="The role wasn’t added">
            {errorMessage(addRoleM.error)}
          </Alert>
        )}
        <Field label="Role name" error={newRoleErr.name}>
          <TextInput id="st-nr-name" value={newRole.name} onChange={(e) => setNewRole((r) => ({ ...r, name: e.target.value }))} />
        </Field>
        <Field label="Working area" hint="e.g. Finance, Orders and shipping" error={newRoleErr.workArea}>
          <TextInput id="st-nr-area" value={newRole.workArea} onChange={(e) => setNewRole((r) => ({ ...r, workArea: e.target.value }))} />
        </Field>
        <Field label="Reason (required)" error={newRoleErr.reason}>
          <Textarea id="st-nr-reason" value={newRole.reason} onChange={(e) => setNewRole((r) => ({ ...r, reason: e.target.value }))} />
        </Field>
      </Dialog>
      <StaffMemberDrawer accountId={memberId} member={members.find((x) => x.account.id === memberId)} roles={roles} onClose={() => setMemberId(null)} onDone={flash} />
      <InvitationLinkDialog link={issued} title={issued ? `${issued.name} is invited` : 'Invitation sent'} onClose={() => setIssued(null)} />
      {stepUp.dialog}
    </AdminLayout>
  );
}
