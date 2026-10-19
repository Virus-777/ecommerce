import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { Alert, announce, Avatar, Badge, Button, CopyButton, Dialog, Drawer, Field, KeyValue, Select, StatusBadge, Textarea, TextInput, type IconName } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, date, dateTime, shortDate } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import { effectiveInstant, MEMBER_STATUS, todayKey, type Role, type StaffMember } from './staff';
import { isStepUpCancel, reauthField, useStepUp } from './step-up';
import {
  accountKey, ACCOUNT_STATUS, ASSIGNMENT_STATUS, INVITATIONS_KEY, staffLinkCommand, useAccountAdmin, useMemberDetail, useSecurityActivity,
  type AccountAdmin, type RoleAssignment,
} from './staff-member';

// Admin › Staff and roles › a staff member (opened from a member row). Shows their roles, permissions, limits and
// time away (access), and their account: status, lockout, devices and recent sign-ins (identity). The actions that
// end someone's access when they leave live here: disable / re-enable, lock / unlock, sign out everywhere, require
// a new password, and adding or removing roles. Each asks for a reason (saved in Action history); disabling and
// adding a role also ask for the password again (step-up). The backend refuses lock, disable and password reset on
// your own account (SELF_ACTION_NOT_ALLOWED), so those aren't offered there.
//
// Only one overlay is shown at a time: the drawer hides while its confirm dialog or the password prompt is open,
// and comes back after (the overlays don't stack: each traps focus and Esc on its own).

type Kind = 'disable' | 'enable' | 'lock' | 'unlock' | 'sign-out' | 'force-reset' | 'add-role' | 'revoke-role';

interface Confirm {
  kind: Kind;
  /** revoke-role: the assignment and its role name */
  assignment?: RoleAssignment;
}

interface ActionText {
  title: string;
  button: string;
  icon: IconName;
  danger?: boolean;
  /** What happens, shown in the confirm dialog. */
  text: (name: string, self: boolean) => string;
}

const ACTIONS: Record<Kind, ActionText> = {
  disable: {
    title: 'Disable account',
    button: 'Disable',
    icon: 'user-x',
    danger: true,
    text: (n) => `${n} is signed out everywhere and can’t sign in again. All their roles end now, and any lead or backup duties they had show as coverage gaps. Use this when someone leaves.`,
  },
  enable: {
    title: 'Re-enable account',
    button: 'Re-enable',
    icon: 'user-check',
    text: (n) => `${n} can sign in again with their password. Their roles are not given back: add the roles they need after this.`,
  },
  lock: {
    title: 'Lock account',
    button: 'Lock',
    icon: 'lock',
    danger: true,
    text: (n) => `${n} is signed out everywhere and can’t sign in until the account is unlocked (or the date below passes). Their roles stay. Use this for a suspected compromise.`,
  },
  unlock: { title: 'Unlock account', button: 'Unlock', icon: 'shield-check', text: (n) => `${n} can sign in again. Failed sign-in attempts are reset.` },
  'sign-out': {
    title: 'Sign out everywhere',
    button: 'Sign out everywhere',
    icon: 'log-out',
    text: (n, self) => (self ? 'Every session of your account ends, including this one: you will need to sign in again.' : `Every session of ${n} ends, on every device. They can sign in again with their password.`),
  },
  'force-reset': {
    title: 'Require a new password',
    button: 'Require new password',
    icon: 'key-round',
    text: (n) => `${n} is signed out everywhere and must choose a new password at their next sign-in. No email is sent from this server.`,
  },
  'add-role': { title: 'Add a role', button: 'Add role', icon: 'plus', text: (n) => `Give ${n} another role. Roles with sensitive permissions, and roles for yourself, wait for a second reviewer.` },
  'revoke-role': { title: 'Remove role', button: 'Remove role', icon: 'trash-2', danger: true, text: (n) => `${n} loses this role’s screens and approval limits now.` },
};

/** Roles that are still in force or on their way (not removed or expired). */
const liveAssignment = (a: RoleAssignment) => a.status === 'active' || a.status === 'pending_acceptance' || a.status === 'pending_approval';

export function StaffMemberDrawer({ accountId, member, roles, onClose, onDone }: {
  accountId: string | null;
  /** The list row, shown while the detail loads. */
  member?: StaffMember;
  roles: Role[];
  onClose: () => void;
  /** Success message for the page's notice (it stays after the drawer closes). */
  onDone: (title: string, text: string) => void;
}) {
  const { api } = useApi();
  const qc = useQueryClient();
  const me = useStaffSession();
  const stepUp = useStepUp();
  const self = accountId === me.accountId;

  // Staff accounts need identity.staff-accounts.manage on top of the account permissions (identity's realm rule).
  const canStaffAccounts = me.can('identity.staff-accounts.manage');
  const canAccountView = me.can('identity.accounts.view') && canStaffAccounts;
  const canAccountManage = me.can('identity.accounts.manage') && canStaffAccounts;
  const canRoles = me.can('access.roles.manage');

  const detailQ = useMemberDetail(accountId);
  const accountQ = useAccountAdmin(accountId, canAccountView);
  const activityQ = useSecurityActivity(accountId, canAccountView);
  const d = detailQ.data;
  const acc = accountQ.data;
  const m = d?.member ?? member;
  const name = m?.account.displayName ?? acc?.account.displayName ?? 'Staff member';
  const email = m?.account.email ?? acc?.account.email ?? '';
  // identity's status is the source of truth for sign-in; access's member status is the fallback.
  const status = acc?.account.status ?? m?.status;

  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [roleId, setRoleId] = useState('');
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<{ title: string; text: string } | null>(null);

  const open = (c: Confirm) => {
    setConfirm(c);
    setReason('');
    setUntil('');
    setRoleId('');
    setTried(false);
    act.reset();
  };
  const closeAll = () => {
    setConfirm(null);
    setDone(null);
    onClose();
  };

  const act = useMutation({
    mutationFn: async (c: Confirm): Promise<{ title: string; text: string }> => {
      const id = accountId!;
      const r = reason.trim();
      const path = { params: { path: { id } } };
      switch (c.kind) {
        case 'disable':
          await stepUp.run((t) => call(api.POST('/api/admin/identity/accounts/{id}/disable', { ...path, body: { reason: r, ...reauthField(t) } })));
          return { title: `${name} is disabled`, text: 'Their sessions are signed out and their roles have ended. Check Coverage gaps for duties they led or backed up.' };
        case 'enable':
          await stepUp.run((t) => call(api.POST('/api/admin/identity/accounts/{id}/enable', { ...path, body: { reason: r, ...reauthField(t) } })));
          return { title: `${name} can sign in again`, text: 'Roles are not given back automatically: add the roles they need.' };
        case 'lock': {
          const a = (await call(api.POST('/api/admin/identity/accounts/{id}/lock', { ...path, body: { reason: r, until: until ? effectiveInstant(until) : null } }))) as AccountAdmin;
          return { title: `${name} is locked`, text: `All their sessions are signed out. ${a.lockedUntil ? `The lock ends ${dateTime(a.lockedUntil)}.` : 'The lock stays until someone unlocks the account.'}` };
        }
        case 'unlock':
          await call(api.POST('/api/admin/identity/accounts/{id}/unlock', { ...path, body: { reason: r } }));
          return { title: `${name} is unlocked`, text: 'They can sign in again.' };
        case 'sign-out': {
          const out = await call(api.POST('/api/admin/identity/accounts/{id}/sign-out-all', { ...path, body: { reason: r } }));
          return { title: `${name} is signed out everywhere`, text: `${out.sessionsRevoked} ${out.sessionsRevoked === 1 ? 'session' : 'sessions'} ended.` };
        }
        case 'force-reset':
          // sendLink false: this server has no email. The operator prints a reset link with staff-link instead.
          await call(api.POST('/api/admin/identity/accounts/{id}/force-password-reset', { ...path, body: { reason: r, sendLink: false } }));
          return {
            title: `${name} must choose a new password`,
            text: `All their sessions are signed out. No email is sent from this server: ask the server operator to run ${staffLinkCommand(email)}, which prints a password reset link to hand to them.`,
          };
        case 'add-role': {
          const a = (await stepUp.run((t) => call(api.POST('/api/admin/access/role-assignments', { body: { accountId: id, roleId, reason: r, ...reauthField(t) } })))) as RoleAssignment;
          const when =
            a.status === 'pending_approval'
              ? 'It carries sensitive access (or is for yourself), so a second reviewer approves it before it applies.'
              : a.status === 'pending_acceptance'
                ? 'It applies when they accept their invitation.'
                : 'It applies now.';
          return { title: `${a.role.name} added for ${name}`, text: when };
        }
        case 'revoke-role':
          await call(api.POST('/api/admin/access/role-assignments/{id}/revoke', { params: { path: { id: c.assignment!.id } }, body: { reason: r } }));
          return { title: `${c.assignment!.role.name} removed from ${name}`, text: 'If they led or backed up this role, the gap shows under Coverage gaps.' };
      }
    },
    onSuccess: (msg) => {
      void qc.invalidateQueries({ queryKey: ['access'] });
      void qc.invalidateQueries({ queryKey: accountKey(accountId!) });
      void qc.invalidateQueries({ queryKey: INVITATIONS_KEY });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
      setConfirm(null);
      setDone(msg);
      onDone(msg.title, msg.text);
      announce(msg.title);
    },
  });

  const submit = () => {
    if (!confirm) return;
    setTried(true);
    if (!reason.trim() || (confirm.kind === 'add-role' && !roleId)) return;
    act.mutate(confirm);
  };

  /* ---------- actions offered for the account's state ---------- */

  const buttons: Kind[] = [];
  if (status === 'active' || status === 'locked') {
    if (canAccountManage && status === 'active' && !self) buttons.push('lock');
    if (canAccountManage && status === 'locked') buttons.push('unlock');
    if (canAccountManage) buttons.push('sign-out');
    if (canAccountManage && !self) buttons.push('force-reset');
    if (canStaffAccounts && !self) buttons.push('disable');
  }
  if (status === 'disabled' && canStaffAccounts) buttons.push('enable');

  const assignments = (d?.assignments ?? []).filter(liveAssignment);
  const held = new Set(assignments.map((a) => a.role.id));
  const roleOptions = [{ value: '', label: 'Choose a role' }, ...roles.filter((r) => !held.has(r.id)).map((r) => ({ value: r.id, label: r.name }))];
  const canAddRole = canRoles && status !== 'disabled' && status !== 'closed';

  const c = confirm ? ACTIONS[confirm.kind] : null;
  const actErr = act.error && !isStepUpCancel(act.error) ? act.error : null;

  return (
    <>
      <Drawer
        open={!!accountId && !confirm && !stepUp.waiting}
        onClose={closeAll}
        title={name}
        foot={
          <Button variant="ghost" onClick={closeAll}>
            Close
          </Button>
        }
      >
        {done && (
          <Alert tone="success" title={done.title}>
            {done.text}
          </Alert>
        )}
        <div className="row gap-3">
          <Avatar name={name} size="lg" />
          <div className="stack gap-1 min-w-0">
            <span className="row gap-2">
              <b>{name}</b>
              {status && <StatusBadge status={ACCOUNT_STATUS[status as keyof typeof ACCOUNT_STATUS] ?? MEMBER_STATUS[status as StaffMember['status']] ?? status} />}
              {self && <Badge tone="outline">You</Badge>}
            </span>
            <span className="xs muted">{email}</span>
          </div>
        </div>

        {detailQ.isError && <LoadError error={detailQ.error} onRetry={() => void detailQ.refetch()} />}

        {/* ---------- account (identity) ---------- */}
        {!canAccountView ? (
          <p className="small sub">Sign-in status, devices and account actions need the permissions to view and manage staff accounts (Platform Administrator).</p>
        ) : accountQ.isError ? (
          <LoadError error={accountQ.error} onRetry={() => void accountQ.refetch()} />
        ) : !acc ? (
          <SkeletonLines rows={4} />
        ) : (
          <KeyValue
            pairs={[
              ['Last sign-in', acc.lastSignInAt ? dateTime(acc.lastSignInAt) : 'Never'],
              ['Password changed', acc.passwordChangedAt ? date(acc.passwordChangedAt) : 'Not yet'],
              ...(acc.mustResetPassword ? ([['Next sign-in', 'Must choose a new password']] as Array<[string, string]>) : []),
              ...(acc.account.status === 'locked'
                ? ([['Locked', `${acc.lockedUntil ? `Until ${dateTime(acc.lockedUntil)}` : 'Until unlocked'}${acc.lockReason ? ` · ${acc.lockReason}` : ''}`]] as Array<[string, string]>)
                : []),
              ...(acc.failedSignInsInWindow ? ([['Failed sign-ins', String(acc.failedSignInsInWindow)]] as Array<[string, string]>) : []),
              ['Staff since', date(acc.createdAt)],
            ]}
          />
        )}

        {acc?.invitation && status === 'invited' && (
          <Alert tone="info" title={`Invitation ${acc.invitation.status === 'pending' ? 'sent' : acc.invitation.status}`}>
            Sent {date(acc.invitation.sentAt)} by {acc.invitation.invitedBy.name ?? 'staff'}, valid until {date(acc.invitation.expiresAt)}. Resend or cancel it under Staff members › Invited.
          </Alert>
        )}

        {buttons.length > 0 && (
          <div className="stack gap-2">
            <span className="small strong">Account actions</span>
            <div className="row gap-2 wrap">
              {buttons.map((k) => (
                <Button key={k} size="sm" variant={ACTIONS[k].danger ? 'danger-soft' : 'secondary'} icon={ACTIONS[k].icon} onClick={() => open({ kind: k })}>
                  {ACTIONS[k].button}
                </Button>
              ))}
            </div>
            {self && <span className="xs muted">You can’t lock, disable or reset the password of your own account: ask another Platform Administrator.</span>}
          </div>
        )}
        {canStaffAccounts && (
          <span className="xs muted">
            Offline, the server can do the same: <span className="mono">{staffLinkCommand(email || '…')} --disable "reason"</span>.
          </span>
        )}

        <div className="divider" />

        {/* ---------- roles (access) ---------- */}
        <div className="row between">
          <span className="small strong">Roles</span>
          {canAddRole && (
            <Button size="sm" variant="ghost" icon="plus" onClick={() => open({ kind: 'add-role' })} disabled={!d}>
              Add a role
            </Button>
          )}
        </div>
        {!d ? (
          !detailQ.isError && <SkeletonLines rows={2} />
        ) : assignments.length ? (
          <ul className="list">
            {assignments.map((a) => (
              <li key={a.id}>
                <span className="grow stack gap-0">
                  <span className="small strong">{a.role.name}</span>
                  <span className="xs muted">
                    Given {shortDate(a.grantedAt)}
                    {a.grantedBy.name ? ` by ${a.grantedBy.name}` : ''}
                    {a.expiresAt ? ` · until ${shortDate(a.expiresAt)}` : ''}
                  </span>
                </span>
                {a.status !== 'active' && <Badge tone={a.status === 'pending_approval' ? 'warning' : 'info'}>{ASSIGNMENT_STATUS[a.status]}</Badge>}
                {canRoles && (
                  <Button variant="ghost" size="sm" onClick={() => open({ kind: 'revoke-role', assignment: a })} srLabel={` ${a.role.name}`}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <span className="small muted">{status === 'disabled' ? 'No roles: disabling the account ended them.' : 'No roles.'}</span>
        )}

        {d && (
          <>
            <span className="small strong">What they can do</span>
            <span className="small sub">
              {d.effectivePermissions.includes('*') ? 'Every permission.' : `${d.effectivePermissions.length} ${d.effectivePermissions.length === 1 ? 'permission' : 'permissions'} from their roles.`}
              {d.approvalsWaiting ? ` ${d.approvalsWaiting} ${d.approvalsWaiting === 1 ? 'request is' : 'requests are'} waiting for their decision.` : ''}
            </span>
            {d.effectiveLimits.length > 0 && (
              <ul className="list">
                {d.effectiveLimits.map((l) => (
                  <li key={l.id}>
                    <span className="grow stack gap-0">
                      <span className="small">{l.action.label}</span>
                      <span className="xs muted">{l.summary}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {d.awayPeriods.length > 0 && (
              <>
                <span className="small strong">Time away</span>
                <ul className="list">
                  {d.awayPeriods.map((a) => (
                    <li key={a.id}>
                      <span className="grow stack gap-0">
                        <span className="small">
                          {shortDate(a.from)} – {shortDate(a.to)}
                        </span>
                        <span className="xs muted">{a.coverage.map((x) => `${x.role.name}: ${x.coveredBy.name}`).join(' · ') || 'No cover set'}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {/* ---------- devices and recent activity (identity) ---------- */}
        {acc && (
          <>
            <div className="divider" />
            <span className="small strong">Devices</span>
            {acc.devices.length ? (
              <ul className="list">
                {acc.devices.map((dv) => (
                  <li key={dv.id}>
                    <span className="grow stack gap-0">
                      <span className="small">
                        {dv.label}
                        {dv.current ? ' (this device)' : ''}
                      </span>
                      <span className="xs muted">
                        Last active {dateTime(dv.lastActiveAt)}
                        {dv.location ? ` · ${dv.location}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="small muted">No devices yet.</span>
            )}
            <span className="small strong">Recent sign-ins and account changes</span>
            {activityQ.isError ? (
              <LoadError error={activityQ.error} onRetry={() => void activityQ.refetch()} />
            ) : !activityQ.data ? (
              <SkeletonLines rows={3} />
            ) : activityQ.data.length ? (
              <ul className="list">
                {activityQ.data.map((e) => (
                  <li key={e.id}>
                    <span className="grow stack gap-0">
                      <span className="small">{e.label}</span>
                      <span className="xs muted">
                        {dateTime(e.at)}
                        {e.device ? ` · ${e.device}` : ''}
                        {e.actor?.name ? ` · by ${e.actor.name}` : ''}
                        {e.reason ? ` · ${e.reason}` : ''}
                      </span>
                    </span>
                    {e.result !== 'completed' && <Badge tone="danger">{e.result === 'blocked' ? 'Blocked' : 'Failed'}</Badge>}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="small muted">No activity yet.</span>
            )}
          </>
        )}
      </Drawer>

      <Dialog
        open={!!confirm && !stepUp.waiting}
        onClose={() => setConfirm(null)}
        title={c ? (confirm?.kind === 'revoke-role' ? `Remove ${confirm.assignment?.role.name}` : c.title) : ''}
        foot={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={act.isPending}>
              Cancel
            </Button>
            <Button variant={c?.danger ? 'danger' : 'primary'} icon={c?.icon} onClick={submit} disabled={act.isPending}>
              {act.isPending ? 'Working…' : c?.button}
            </Button>
          </>
        }
      >
        {c && confirm && (
          <>
            <span className="small">{c.text(name, self)}</span>
            {actErr != null && (
              <Alert tone="danger" title="That didn’t work">
                {errorMessage(actErr)}
              </Alert>
            )}
            {confirm.kind === 'add-role' && (
              <Field label="Role" error={tried && !roleId ? 'Choose a role.' : undefined}>
                <Select id="sm-role" options={roleOptions} value={roleId} onChange={(e) => setRoleId(e.target.value)} />
              </Field>
            )}
            {confirm.kind === 'lock' && (
              <Field label="Locked until (optional)" hint="The lock ends at the start of that day. Leave empty to keep it locked until someone unlocks it.">
                <TextInput id="sm-until" type="date" icon="calendar" min={tomorrowKey()} value={until} onChange={(e) => setUntil(e.target.value)} />
              </Field>
            )}
            <Field label="Reason (required)" hint="Saved in Action history." error={tried && !reason.trim() ? 'Enter a reason.' : undefined}>
              <Textarea id="sm-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            {confirm.kind === 'force-reset' && (
              <span className="xs muted">
                After this, ask the server operator to run <span className="mono">{staffLinkCommand(email)}</span> <CopyButton text={staffLinkCommand(email)} label="Copy the command" /> to print a password reset link for them.
              </span>
            )}
          </>
        )}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

/** Tomorrow in Pacific time (a staff lock with an end date must end in the future). */
function tomorrowKey() {
  const [y, mo, da] = todayKey().split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, da + 1)).toISOString().slice(0, 10);
}
