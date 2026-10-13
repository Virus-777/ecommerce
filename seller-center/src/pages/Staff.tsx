import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { initials } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Checkbox, Dialog, Field, Icon, KeyValue, LogoTile, PageHeader, Select, StatusBadge, TableWrap, Tabs, TextInput } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { fmtDay, fmtTime } from './data/finance';
import { CHANNELS, EMAIL_RE, LEVEL, levelOf, listed, MATRIX_AREAS, MEMBER_STATUS, NOTE_COLS, type Channel, type Level, type Member, type MemberPreference, type PermissionEntry, type StaffRole } from './data/staff';

// Design: pages/seller/seller-staff.html · view "invite-staff" = the invite dialog.
// Members: GET sellers/members; roles and the permission catalogue: GET sellers/roles; invite, resend,
// cancel, role change, suspend, reactivate and remove: sellers/invitations and sellers/members/{id}/*
// (owner only: sellers.staff.manage). Notification preferences: GET notifications/preferences and
// PUT …/preferences/members/{memberId}. Account status: GET sellers/account.

const TABS = [
  { label: 'Store profile', value: 'store', to: href('seller/store') },
  { label: 'Staff and permissions', value: 'staff', to: href('seller/staff') },
  { label: 'Notifications', value: 'notifications', to: href('seller/staff') },
  { label: 'Shipping', value: 'shipping', to: href('seller/shipping') },
];

const STAFF_ROLES: StaffRole[] = ['products_inventory', 'shipping', 'customer_service', 'custom'];

const ACCOUNT_STATUS: Record<string, string> = {
  approved: 'Approved',
  restricted: 'Restricted',
  suspended: 'Suspended',
  under_review: 'Under review',
  information_required: 'Information required',
  applied: 'Applied',
  closed: 'Closed',
};
const PAYOUT_STATE: Record<string, { label: string; tone?: 'success' | 'warning' | 'danger' | 'info' }> = {
  verified: { label: 'Active', tone: 'success' },
  verification_pending: { label: 'Pending', tone: 'warning' },
  change_under_review: { label: 'In review', tone: 'info' },
  blocked: { label: 'On hold', tone: 'warning' },
  not_added: { label: 'Not added', tone: 'danger' },
};

interface Invite {
  email: string;
  name: string;
  role: StaffRole;
  perms: string[];
}
type InviteErrors = Partial<Record<'email' | 'name' | 'perms', string>>;

function validateInvite(i: Invite, members: Member[], withPerms: boolean): InviteErrors {
  const e: InviteErrors = {};
  const email = i.email.trim().toLowerCase();
  if (!email) e.email = 'Enter their email address.';
  else if (!EMAIL_RE.test(email)) e.email = 'Enter an email address like name@company.com.';
  else if (members.some((m) => (m.status === 'active' || m.status === 'invited' || m.status === 'suspended') && m.email.toLowerCase() === email)) e.email = 'This person is already on your staff list.';
  if (!i.name.trim()) e.name = 'Enter their full name.';
  if (withPerms && !i.perms.length) e.perms = 'Choose at least one permission.';
  return e;
}

function Perm({ level }: { level: Level }) {
  const l = LEVEL[level];
  return (
    <span className={`sb-perm ${level}`}>
      <Icon name={l.icon} className="ic-sm" />
      {l.text ?? <span className="sr-only">No access</span>}
    </span>
  );
}

type Notice = { tone: 'success' | 'info' | 'danger'; title: string; body?: string };
type MemberAction = { kind: 'resend' | 'revoke' | 'suspend' | 'reactivate' | 'remove'; m: Member } | { kind: 'role'; m: Member; role: StaffRole };

export default function Staff() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, isOwner, can, storeName } = useSellerSession();
  const canManage = isOwner && can('sellers.staff.manage');
  const canPrefs = can('notifications.preferences.manage');
  const [view, setView] = useView<'invite-staff'>();

  const membersQ = useQuery({ queryKey: ['sellers', 'members', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/members')), enabled: canManage });
  const rolesQ = useQuery({ queryKey: ['sellers', 'roles', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/roles')) });
  const prefsQ = useQuery({ queryKey: ['notifications', 'preferences', sellerId], queryFn: () => call(api.GET('/api/seller/notifications/preferences')) });
  const accountQ = useQuery({ queryKey: ['sellers', 'account', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/account')) });

  const members = useMemo(() => membersQ.data ?? [], [membersQ.data]);
  const catalogue: PermissionEntry[] = rolesQ.data?.permissions ?? [];
  const roleLabel = (role: Member['role']) => rolesQ.data?.roles.find((r) => r.key === role)?.label ?? role.replace(/_/g, ' ');
  const template = (role: StaffRole) => rolesQ.data?.roles.find((r) => r.key === role)?.permissions ?? [];
  // Permissions an owner can give: delegable and not owner-only; payout permissions are never offered.
  const grantable = catalogue.filter((p) => p.delegable && !p.ownerOnly && p.area !== 'payouts');
  const financeView = catalogue.find((p) => p.key === 'finance.balances.view');

  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const blank = (role: StaffRole = 'customer_service'): Invite => ({ email: '', name: '', role, perms: template(role) });
  const [draft, setDraft] = useState<Invite>({ email: '', name: '', role: 'customer_service', perms: [] });
  const [tried, setTried] = useState(false);
  const [quick, setQuick] = useState<Invite>({ email: '', name: '', role: 'customer_service', perms: [] });
  const [quickTried, setQuickTried] = useState(false);
  const [prefEdits, setPrefEdits] = useState<Record<string, { groups: Record<string, boolean>; channel: Channel }>>({});

  const errors = tried ? validateInvite(draft, members, true) : {};
  const quickErrors = quickTried ? validateInvite(quick, members, false) : {};
  const rows = members.filter(listed);
  const activeN = rows.filter((m) => m.status === 'active').length;
  const invitedN = rows.filter((m) => m.status === 'invited' || m.status === 'expired').length;
  const matrixPeople = rows.filter((m) => m.status === 'active');
  const firstName = draft.name.trim().split(' ')[0] || 'them';
  // Draft permissions start from the role template once the catalogue is loaded.
  const draftPerms = draft.perms.length || draft.role === 'custom' ? draft.perms : template(draft.role);

  // One preferences row per person (dev seller tokens can add a second row for the token's member id).
  const prefRows = useMemo(() => {
    const ids = new Set(members.map((m) => m.id));
    const byAccount = new Map<string, MemberPreference>();
    for (const pr of prefsQ.data?.members ?? []) {
      const prev = byAccount.get(pr.accountId);
      if (!prev || (!ids.has(prev.memberId) && ids.has(pr.memberId))) byAccount.set(pr.accountId, pr);
    }
    return [...byAccount.values()];
  }, [prefsQ.data, members]);
  const groupInfo = (key: string) => prefsQ.data?.groups.find((g) => g.key === key);

  const invite = useMutation({
    mutationFn: (i: Invite) =>
      call(api.POST('/api/seller/sellers/invitations', { body: { email: i.email.trim(), name: i.name.trim(), role: i.role, permissions: i.perms.length ? i.perms : template(i.role) } })),
    onSuccess: (m) => {
      setNotice({ tone: 'success', title: `Invite sent to ${m.email}`, body: `${m.name} gets an email link valid until ${fmtDay(m.inviteExpiresAt, { weekday: false })}. They appear as Invited until they accept.` });
      void qc.invalidateQueries({ queryKey: ['sellers', 'members', sellerId] });
    },
  });
  const inviteFieldErrors = (e: unknown): InviteErrors => {
    if (!(e instanceof ApiError)) return {};
    if (e.code === 'MEMBER_EXISTS') return { email: 'This person is already on your staff list.' };
    if (e.code === 'NOT_DELEGABLE') return { perms: e.message };
    const fe = e.fieldErrors;
    return { ...(fe.email ? { email: fe.email } : {}), ...(fe.name ? { name: fe.name } : {}), ...(fe.permissions ? { perms: fe.permissions } : {}) };
  };

  const act = useMutation({
    mutationFn: (a: MemberAction) => {
      const path = { params: { path: { id: a.m.id } } };
      switch (a.kind) {
        case 'resend':
          return call(api.POST('/api/seller/sellers/invitations/{id}/resend', path));
        case 'revoke':
          return call(api.POST('/api/seller/sellers/invitations/{id}/revoke', path));
        case 'suspend':
          return call(api.POST('/api/seller/sellers/members/{id}/suspend', { ...path, body: {} }));
        case 'reactivate':
          return call(api.POST('/api/seller/sellers/members/{id}/reactivate', { ...path, body: {} }));
        case 'remove':
          return call(api.POST('/api/seller/sellers/members/{id}/remove', { ...path, body: {} }));
        case 'role':
          return call(api.PATCH('/api/seller/sellers/members/{id}', { ...path, body: { role: a.role } }));
      }
    },
    onSuccess: (m, a) => {
      const n = a.m.name;
      const msg: Record<MemberAction['kind'], Notice> = {
        resend: { tone: 'success', title: `Invite resent to ${a.m.email}`, body: `The earlier link no longer works. The new one is valid until ${fmtDay(m.inviteExpiresAt, { weekday: false })}.` },
        revoke: { tone: 'info', title: `Invite for ${n} cancelled`, body: 'The invite link no longer works.' },
        suspend: { tone: 'info', title: `${n} suspended`, body: `They can’t sign in to ${storeName} until you reactivate them. This change is recorded.` },
        reactivate: { tone: 'success', title: `${n} reactivated`, body: 'Their access is back right away. This change is recorded.' },
        remove: { tone: 'info', title: `${n} removed`, body: `They lose access to ${storeName} right away. This change is recorded.` },
        role: { tone: 'success', title: `${n} is now ${roleLabel(m.role)}`, body: 'Their access changes right away. This change is recorded.' },
      };
      setNotice(msg[a.kind]);
      if (a.kind === 'role') setEditing(null);
      void qc.invalidateQueries({ queryKey: ['sellers', 'members', sellerId] });
      void qc.invalidateQueries({ queryKey: ['notifications', 'preferences', sellerId] });
    },
    onError: (e) => setNotice({ tone: 'danger', title: 'That change didn’t work', body: errorMessage(e) }),
  });

  const savePrefs = useMutation({
    mutationFn: async () => {
      for (const [memberId, v] of Object.entries(prefEdits)) {
        await call(api.PUT('/api/seller/notifications/preferences/members/{memberId}', { params: { path: { memberId } }, body: v }));
      }
    },
    onSuccess: () => {
      setPrefEdits({});
      setNotice({ tone: 'success', title: 'Notification preferences saved', body: 'Changes apply to new notices from now on.' });
      void qc.invalidateQueries({ queryKey: ['notifications', 'preferences', sellerId] });
    },
    onError: (e) => setNotice({ tone: 'danger', title: 'We couldn’t save the preferences', body: errorMessage(e) }),
  });

  const prefOf = (pr: MemberPreference) => prefEdits[pr.memberId] ?? { groups: pr.groups as Record<string, boolean>, channel: pr.channel };
  const setPref = (pr: MemberPreference, k: string, on: boolean) => setPrefEdits((l) => ({ ...l, [pr.memberId]: { ...prefOf(pr), groups: { ...prefOf(pr).groups, [k]: on } } }));
  const setChannel = (pr: MemberPreference, c: Channel) => setPrefEdits((l) => ({ ...l, [pr.memberId]: { ...prefOf(pr), channel: c } }));

  const openInvite = () => {
    setDraft(blank());
    setTried(false);
    invite.reset();
    setView('invite-staff');
  };
  const close = () => setView('');
  const setD = <K extends keyof Invite>(k: K, v: Invite[K]) => {
    setDraft((d) => ({ ...d, perms: draftPerms, [k]: v }));
    invite.reset();
  };
  const pickRole = (role: StaffRole) => setDraft((d) => ({ ...d, role, perms: template(role) }));
  const togglePerm = (k: string, on: boolean) => setDraft((d) => ({ ...d, perms: on ? [...draftPerms, k] : draftPerms.filter((p) => p !== k) }));

  const sendInvite = () => {
    setTried(true);
    const d = { ...draft, perms: draftPerms };
    if (Object.keys(validateInvite(d, members, true)).length) return;
    invite.mutate(d, { onSuccess: close });
  };
  const sendQuick = () => {
    setQuickTried(true);
    if (Object.keys(validateInvite(quick, members, false)).length) return;
    invite.mutate(
      { ...quick, perms: template(quick.role) },
      {
        onSuccess: () => {
          setQuick(blank(quick.role));
          setQuickTried(false);
        },
      },
    );
  };

  const dialogErrors: InviteErrors = { ...errors, ...(view === 'invite-staff' ? inviteFieldErrors(invite.error) : {}) };
  const quickAllErrors: InviteErrors = { ...quickErrors, ...(view !== 'invite-staff' ? inviteFieldErrors(invite.error) : {}) };
  const otherInviteError = invite.isError && !Object.keys(inviteFieldErrors(invite.error)).length ? errorMessage(invite.error) : '';

  const acc = accountQ.data;
  const lastActive = (m: Member) =>
    m.status === 'invited'
      ? `Invite expires ${fmtDay(m.inviteExpiresAt, { weekday: false, year: false })}`
      : m.status === 'expired'
        ? 'Invite expired'
        : m.lastActiveAt
          ? fmtTime(m.lastActiveAt)
          : m.joinedAt
            ? `Joined ${fmtDay(m.joinedAt, { weekday: false })}`
            : '—';

  const roleOptions = STAFF_ROLES.map((r) => ({ value: r, label: roleLabel(r) }));
  const skRows = (cols: number) =>
    [0, 1, 2].map((i) => (
      <tr key={i}>
        <td colSpan={cols}>
          <span className="sk sk-line" />
        </td>
      </tr>
    ));

  return (
    <SellerLayout active="store">
      <PageHeader
        crumbs={[{ label: 'Store and settings', to: href('seller/store') }, { label: 'Staff and permissions' }]}
        title="Staff and permissions"
        sub="Give each person only the access they need. Every change is recorded."
        actions={
          canManage ? (
            <Button size="sm" icon="user-plus" onClick={openInvite}>
              Invite staff
            </Button>
          ) : undefined
        }
      />
      <div>
        <Tabs items={TABS} active="staff" />
      </div>
      {!canManage && (
        <Alert tone="info" title="Only the store owner manages staff">
          The owner invites people, changes their access and removes them. You can still set your own notifications below.
        </Alert>
      )}
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      <div className="sb-main">
        <div className="stack gap-5">
          {canManage && (
            <Card title="Staff" sub={membersQ.data ? `${activeN} active · ${invitedN} invited` : undefined} flush>
              {membersQ.isError ? (
                <div className="pad">
                  <Alert tone="danger" title="We couldn’t load your staff">
                    {errorMessage(membersQ.error)}{' '}
                    <Button variant="ghost" size="sm" onClick={() => void membersQ.refetch()}>
                      Try again
                    </Button>
                  </Alert>
                </div>
              ) : (
                <TableWrap label="Staff table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Person</th>
                        <th scope="col">Role</th>
                        <th scope="col">Status</th>
                        <th scope="col">Last active</th>
                        <th className="col-pin" scope="col">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {!membersQ.data
                        ? skRows(5)
                        : rows.map((m) => {
                            const busy = act.isPending && act.variables?.m.id === m.id;
                            return (
                              <tr key={m.id}>
                                <td>
                                  <div className="cell-main">
                                    <Avatar name={m.name} />
                                    <span className="stack gap-0">
                                      <span className="small strong">{m.name}</span>
                                      <span className="xs muted">{m.email}</span>
                                    </span>
                                  </div>
                                </td>
                                <td>
                                  {m.isOwner ? (
                                    <Badge tone="solid">Owner</Badge>
                                  ) : editing === m.id ? (
                                    <Select
                                      id={`sf-role-${m.id}`}
                                      ctl="sm"
                                      aria-label={`${m.name}: role`}
                                      options={roleOptions}
                                      value={m.role}
                                      disabled={busy}
                                      onChange={(e) => act.mutate({ kind: 'role', m, role: e.target.value as StaffRole })}
                                    />
                                  ) : (
                                    <span className="small">{roleLabel(m.role)}</span>
                                  )}
                                </td>
                                <td>
                                  <StatusBadge status={MEMBER_STATUS[m.status]} />
                                </td>
                                <td>
                                  <span className="xs sub nowrap">{lastActive(m)}</span>
                                </td>
                                <td className="col-pin">
                                  {!m.isOwner && (
                                    <span className="row gap-1 nowrap">
                                      {m.status === 'invited' || m.status === 'expired' ? (
                                        <>
                                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => act.mutate({ kind: 'resend', m })}>
                                            Resend<span className="sr-only"> {m.name}</span>
                                          </Button>
                                          {m.status === 'invited' && (
                                            <Button variant="ghost" size="sm" disabled={busy} onClick={() => act.mutate({ kind: 'revoke', m })}>
                                              Cancel invite<span className="sr-only"> {m.name}</span>
                                            </Button>
                                          )}
                                        </>
                                      ) : (
                                        <>
                                          {m.status === 'active' && (
                                            <Button variant="ghost" size="sm" aria-expanded={editing === m.id} disabled={busy} onClick={() => setEditing(editing === m.id ? null : m.id)}>
                                              {editing === m.id ? 'Done' : 'Edit'}
                                              <span className="sr-only"> {m.name}</span>
                                            </Button>
                                          )}
                                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => act.mutate({ kind: m.status === 'suspended' ? 'reactivate' : 'suspend', m })}>
                                            {m.status === 'suspended' ? 'Reactivate' : 'Suspend'}
                                            <span className="sr-only"> {m.name}</span>
                                          </Button>
                                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => act.mutate({ kind: 'remove', m })}>
                                            Remove<span className="sr-only"> {m.name}</span>
                                          </Button>
                                        </>
                                      )}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Card>
          )}

          {canManage && (
            <Card
              title="Permission matrix"
              sub="Manage = view and change · View = read only"
              titleAs="h3"
              flush
              foot={<span className="xs muted grow">Finance is visible to the owner only. Payout account changes can never be given to staff and always need verification and Marketly review. Staff never see other sellers’ orders, costs, messages or balances.</span>}
            >
              <TableWrap label="Permission matrix table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Permission</th>
                      {matrixPeople.map((m, i) => (
                        <th key={m.id} className={i === matrixPeople.length - 1 ? 'c col-pin' : 'c'} scope="col">
                          {m.name}
                          <br />
                          <span className="xs muted">{m.isOwner ? 'Owner' : roleLabel(m.role)}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {!membersQ.data || !rolesQ.data
                      ? skRows(2)
                      : MATRIX_AREAS.map((r) => (
                          <tr key={r.area}>
                            <td>
                              <span className="small strong nowrap">{r.label}</span>
                            </td>
                            {matrixPeople.map((m, i) => (
                              <td key={m.id} className={i === matrixPeople.length - 1 ? 'c col-pin' : 'c'}>
                                <Perm level={levelOf(m, r.area, catalogue)} />
                              </td>
                            ))}
                          </tr>
                        ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          )}

          <Card
            title="Notification preferences"
            sub="Who hears about what"
            titleAs="h3"
            flush
            foot={
              <Button variant="secondary" size="sm" onClick={() => savePrefs.mutate()} disabled={!Object.keys(prefEdits).length || savePrefs.isPending}>
                {savePrefs.isPending ? 'Saving…' : 'Save preferences'}
              </Button>
            }
          >
            {prefsQ.isError ? (
              <div className="pad">
                <Alert tone="danger" title="We couldn’t load notification preferences">
                  {errorMessage(prefsQ.error)}{' '}
                  <Button variant="ghost" size="sm" onClick={() => void prefsQ.refetch()}>
                    Try again
                  </Button>
                </Alert>
              </div>
            ) : (
              <TableWrap label="Notification preferences table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      {NOTE_COLS.map((c) => (
                        <th key={c.key} className="c" scope="col">
                          {c.label}
                        </th>
                      ))}
                      <th className="col-pin" scope="col">
                        Channel
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {!prefsQ.data
                      ? skRows(7)
                      : prefRows.map((pr, r) => {
                          const v = prefOf(pr);
                          const meId = (acc?.me as { memberId?: string } | undefined)?.memberId;
                          const editable = canPrefs || (!!meId && (pr.memberId === meId || pr.accountId === meId)) || (pr.isOwner && isOwner);
                          return (
                            <tr key={pr.memberId}>
                              <td>
                                <span className="small strong nowrap">{pr.name}</span>
                              </td>
                              {NOTE_COLS.map((c, i) => {
                                const locked = pr.lockedGroups.includes(c.key);
                                const ownerOnly = !pr.isOwner && groupInfo(c.key)?.ownerOnly;
                                return (
                                  <td key={c.key} className="c">
                                    {ownerOnly ? (
                                      <span className="sb-perm none" title="Owner only">
                                        <Icon name="lock" className="ic-sm" />
                                        <span className="sr-only">Owner only</span>
                                      </span>
                                    ) : (
                                      <input
                                        type="checkbox"
                                        id={`sf-n-${r}-${i}`}
                                        aria-label={`${pr.name}: ${c.label}${locked ? ' (always on)' : ''}`}
                                        title={locked ? 'Always on for the owner' : undefined}
                                        checked={locked || !!v.groups[c.key]}
                                        disabled={locked || !editable}
                                        onChange={(e) => setPref(pr, c.key, e.target.checked)}
                                      />
                                    )}
                                  </td>
                                );
                              })}
                              <td className="col-pin">
                                <Select id={`sf-ch-${r}`} aria-label={`${pr.name}: notification channel`} options={CHANNELS} value={v.channel} disabled={!editable} onChange={(e) => setChannel(pr, e.target.value as Channel)} />
                              </td>
                            </tr>
                          );
                        })}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Card>
        </div>

        <div className="stack gap-5">
          <Card title="Account status" titleAs="h3">
            {!acc ? (
              <div className="stack gap-2">
                <span className="sk sk-line short" />
                <span className="sk sk-line" />
                <span className="sk sk-line" />
              </div>
            ) : (
              <>
                <div className="row gap-3">
                  <LogoTile initials={initials(acc.storeName)} tint="2" />
                  <div className="stack gap-0">
                    <span className="strong">{acc.storeName}</span>
                    <span className="xs muted">Seller ID {acc.ref}</span>
                  </div>
                </div>
                <KeyValue
                  pairs={[
                    ['Account', <StatusBadge key="a" status={ACCOUNT_STATUS[acc.status] ?? acc.status} />],
                    ['Seller since', acc.sellerSince ? fmtDay(acc.sellerSince, { weekday: false }) : '—'],
                    [
                      'Verification',
                      acc.verification.state === 'verified' ? (
                        <Badge key="v" tone="info" icon="shield-check">
                          Verified seller
                        </Badge>
                      ) : (
                        <StatusBadge key="v" status={acc.verification.state === 'lapsed' ? 'Expired' : acc.verification.state === 'revoked' ? 'Revoked' : 'Not verified'} />
                      ),
                    ],
                    ...(acc.productApproval ? ([['Product approval', `${acc.productApproval.activeOffers} active · ${acc.productApproval.hiddenOffers} hidden`]] as Array<[string, string]>) : []),
                    ['Payouts', <StatusBadge key="p" status={PAYOUT_STATE[acc.payoutReadiness.state]?.label ?? acc.payoutReadiness.state} tone={PAYOUT_STATE[acc.payoutReadiness.state]?.tone} />],
                    [
                      'Restrictions',
                      acc.activeRestrictions.length ? (
                        <Link key="r" to={href('seller/performance')}>
                          {acc.activeRestrictions.length} active: {acc.activeRestrictions.map((x) => x.title).join(', ')}
                        </Link>
                      ) : (
                        'None'
                      ),
                    ],
                  ]}
                />
              </>
            )}
            <span className="xs muted">Changes to ownership or verification details need Marketly review.</span>
          </Card>

          {canManage && (
            <Card
              title="Invite staff"
              sub="They get an email link valid for 7 days"
              titleAs="h3"
              foot={
                <Button size="sm" icon="send" onClick={sendQuick} disabled={invite.isPending || !rolesQ.data}>
                  Send invite
                </Button>
              }
            >
              {view !== 'invite-staff' && otherInviteError && (
                <Alert tone="danger" title="The invite wasn’t sent">
                  {otherInviteError}
                </Alert>
              )}
              <div className="sb-form-grid">
                <Field label="Email" error={quickAllErrors.email}>
                  <TextInput
                    id="sf-q-email"
                    type="email"
                    value={quick.email}
                    placeholder="name@company.com"
                    error={!!quickAllErrors.email}
                    onChange={(e) => {
                      setQuick((q) => ({ ...q, email: e.target.value }));
                      invite.reset();
                    }}
                  />
                </Field>
                <Field label="Name" error={quickAllErrors.name}>
                  <TextInput id="sf-q-name" value={quick.name} placeholder="Full name" error={!!quickAllErrors.name} onChange={(e) => setQuick((q) => ({ ...q, name: e.target.value }))} />
                </Field>
                <Field label="Role" hint="Roles are starting points. You can change single permissions.">
                  <Select id="sf-q-role" options={roleOptions.filter((o) => o.value !== 'custom')} value={quick.role} onChange={(e) => setQuick((q) => ({ ...q, role: e.target.value as StaffRole }))} />
                </Field>
              </div>
            </Card>
          )}
        </div>
      </div>

      <Dialog
        open={canManage && view === 'invite-staff'}
        onClose={close}
        title="Invite staff"
        size="lg"
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button icon="send" onClick={sendInvite} disabled={invite.isPending || !rolesQ.data}>
              {invite.isPending ? 'Sending…' : 'Send invite'}
            </Button>
          </>
        }
      >
        {otherInviteError && (
          <Alert tone="danger" title="The invite wasn’t sent">
            {otherInviteError}
          </Alert>
        )}
        <div className="sb-form-grid">
          <Field label="Email" error={dialogErrors.email}>
            <TextInput id="sf-m-email" type="email" value={draft.email} placeholder="name@company.com" error={!!dialogErrors.email} onChange={(e) => setD('email', e.target.value)} />
          </Field>
          <Field label="Name" error={dialogErrors.name}>
            <TextInput id="sf-m-name" value={draft.name} placeholder="Full name" error={!!dialogErrors.name} onChange={(e) => setD('name', e.target.value)} />
          </Field>
          <Field label="Role" hint="Roles are starting points. You can change single permissions.">
            <Select id="sf-m-role" options={roleOptions} value={draft.role} onChange={(e) => pickRole(e.target.value as StaffRole)} />
          </Field>
        </div>
        <div className="stack gap-2">
          <span className="label">Permissions for {roleLabel(draft.role)}</span>
          <div className="grid md2 gap-2">
            {grantable.map((p) => (
              <Checkbox key={p.key} id={`sf-m-p-${p.key}`} label={p.label} checked={draftPerms.includes(p.key)} onChange={(e) => togglePerm(p.key, e.target.checked)} />
            ))}
            {financeView && <Checkbox id="sf-m-p-finance" label="Finance view (owner only today)" checked={false} disabled onChange={() => undefined} />}
          </div>
          {dialogErrors.perms && (
            <span className="error-text" role="alert">
              <Icon name="circle-alert" className="ic-sm" />
              {dialogErrors.perms}
            </span>
          )}
          <div className="panel row gap-2 xs sub">
            <Icon name="lock" className="ic-sm" />
            Payout changes: owner only. This can't be given to staff.
          </div>
        </div>
        <Checkbox id="sf-m-notify" label={`Send ${firstName} notifications for returns and customer messages`} checked={false} disabled onChange={() => undefined} />
        <span className="xs muted">You can choose {firstName === 'them' ? 'their' : `${firstName}’s`} notifications in the table once they accept the invite.</span>
      </Dialog>
    </SellerLayout>
  );
}
