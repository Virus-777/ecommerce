import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Avatar, Badge, Button, Card, Checkbox, Field, Icon, PageHeader, SearchInput, SegmentedControl, Select, StatusBadge, Switch, TableWrap, Textarea, TextInput } from '@marketly/web-shared/ui';
import {
  AUTHORITIES, AUTHORITY_OPTIONS, defaultDraft, FINANCE_DRAFT, GAPS, HOLDERS, LIMITS, MANAGERS, PERM_AREAS, ROLES, SECOND_REVIEWERS, STAFF, STAFF_ROLES,
  type Role, type RoleDraft, type StaffMember,
} from './data/staff';

// Design: pages/admin/admin-staff.html · view "edit-role" = full-page role editor (Finance Manager).

type StaffFilter = 'all' | 'active' | 'invited';
interface Invite { name: string; email: string; role: string; manager: string; reason: string; requestLimits: boolean }
const NO_ROLE = 'Choose a role';
const EMPTY_INVITE: Invite = { name: '', email: '', role: NO_ROLE, manager: 'Ana Silva', reason: '', requestLimits: false };

function validateInvite(f: Invite) {
  const e: Partial<Record<keyof Invite, string>> = {};
  if (!f.name.trim()) e.name = 'Enter the first and last name.';
  if (!/^[^\s@]+@marketly\.example$/i.test(f.email.trim())) e.email = 'Enter a work email ending in @marketly.example.';
  if (f.role === NO_ROLE) e.role = 'Choose a role.';
  if (!f.reason.trim()) e.reason = 'Enter why this person needs this role.';
  return e;
}

const copyDraft = (d: RoleDraft): RoleDraft => ({ ...d, perms: d.perms.map((a) => [...a]), limits: d.limits.map((l) => ({ ...l })), authorities: [...d.authorities] });

export default function Staff() {
  const [view, setView] = useView<'edit-role'>();
  const roles = ROLES;
  const [staff, setStaff] = useState<StaffMember[]>(STAFF);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<StaffFilter>('all');
  const [notice, setNotice] = useState<{ title: string; text: string } | null>(null);

  // Invite form
  const [invite, setInvite] = useState<Invite>(EMPTY_INVITE);
  const [inviteTried, setInviteTried] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const inviteErr = inviteTried ? validateInvite(invite) : {};

  // Role editor: the design's edit-role view is the Finance Manager draft.
  const [editing, setEditing] = useState('Finance Manager');
  const [saved, setSaved] = useState<Record<string, RoleDraft>>({ 'Finance Manager': FINANCE_DRAFT });
  const [pending, setPending] = useState<string[]>([]);
  const [draft, setDraft] = useState<RoleDraft>(() => copyDraft(FINANCE_DRAFT));
  const [reasonErr, setReasonErr] = useState('');

  const flash = (title: string, text: string) => {
    setNotice({ title, text });
    announce(title);
  };

  /* ---------- list ---------- */

  const term = q.trim().toLowerCase();
  const shownRoles = term ? roles.filter((r) => [r.role, r.area, ...r.people, r.backup].some((s) => s.toLowerCase().includes(term))) : roles;
  const shownStaff = staff.filter((s) => filter === 'all' || s.status.toLowerCase() === filter);
  const nActive = staff.filter((s) => s.status === 'Active').length;
  const nInvited = staff.length - nActive;

  const openRole = (name: string) => {
    setEditing(name);
    setDraft(copyDraft(saved[name] ?? defaultDraft()));
    setReasonErr('');
  };

  const setInv = <K extends keyof Invite>(k: K, v: Invite[K]) => setInvite((f) => ({ ...f, [k]: v }));
  const sendInvite = () => {
    setInviteTried(true);
    if (Object.keys(validateInvite(invite)).length) return;
    const member: StaffMember = { name: invite.name.trim(), email: invite.email.trim(), roles: [invite.role], lastActive: 'Not signed in', status: 'Invited', invited: 'Oct 10' };
    setStaff((l) => [...l, member]);
    setInvite(EMPTY_INVITE);
    setInviteTried(false);
    flash(
      `Invitation sent to ${member.email}`,
      `${member.name} is invited as ${invite.role}, reporting to ${invite.manager}. The invitation expires after 7 days.${invite.requestLimits ? ' Approval limits were requested from Morgan Hale.' : ''}`,
    );
  };
  const focusInvite = () => {
    nameRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    nameRef.current?.focus({ preventScroll: true });
  };

  /* ---------- editor ---------- */

  const role = roles.find((r) => r.role === editing) ?? roles[0];
  const holders = HOLDERS[role.role] ?? Math.max(1, staff.filter((s) => s.roles.includes(role.role)).length);
  const allowed = draft.perms.flat().filter(Boolean).length;
  const total = draft.perms.flat().length;

  const setPerm = (a: number, i: number, on: boolean) => setDraft((d) => ({ ...d, perms: d.perms.map((row, ai) => (ai === a ? row.map((v, ii) => (ii === i ? on : v)) : row)) }));
  const setArea = (a: number, on: boolean) => setDraft((d) => ({ ...d, perms: d.perms.map((row, ai) => (ai === a ? row.map(() => on) : row)) }));
  const setLimit = (i: number, k: 'limit' | 'review', v: string) => setDraft((d) => ({ ...d, limits: d.limits.map((l, li) => (li === i ? { ...l, [k]: v } : l)) }));
  const setAuthority = (i: number, v: string) => setDraft((d) => ({ ...d, authorities: d.authorities.map((x, xi) => (xi === i ? v : x)) }));

  const sendForApproval = () => {
    if (!draft.reason.trim()) {
      setReasonErr('Enter a reason. It is saved in Action history with the request.');
      document.getElementById('er-reason')?.focus();
      return;
    }
    setSaved((s) => ({ ...s, [role.role]: copyDraft(draft) }));
    setPending((p) => (p.includes(role.role) ? p : [...p, role.role]));
    setView('');
    flash(
      `${role.role} changes sent for approval`,
      `Morgan Hale, Business Owner, reviews the new access and limits. If approved, they apply from ${draft.effective}. Requests already waiting for approval keep the old limit.`,
    );
  };

  if (view === 'edit-role') {
    return (
      <AdminLayout active="staff">
        <PageHeader
          crumbs={[{ label: 'Staff and roles', to: href('admin/staff') }, { label: role.role }]}
          title={`Edit role: ${role.role}`}
          sub={`Working area: ${role.area} · Lead ${role.people[0]} · Backup ${role.backup} · ${holders} ${holders === 1 ? 'person holds' : 'people hold'} this role`}
          actions={
            <>
              <Button variant="ghost" size="sm" to={href('admin/staff')}>
                Cancel
              </Button>
              <Button size="sm" icon="send" onClick={sendForApproval}>
                Send for approval
              </Button>
            </>
          }
        />
        <Alert tone="warning" title="Granting access is not financial authority">
          You can change which screens this role can open. The approval limits below are proposals until Morgan Hale, Business Owner, approves them. Platform Administrators cannot approve their own financial limits.
        </Alert>
        <div className="ac-main">
          <div className="stack gap-4">
            <div className="row between">
              <h2 className="h3">Permissions by area</h2>
              <span className="xs muted">
                {allowed} of {total} actions allowed
              </span>
            </div>
            {PERM_AREAS.map((area, a) => {
              const row = draft.perms[a];
              const n = row.filter(Boolean).length;
              const all = n === row.length;
              return (
                <Card
                  key={area.title}
                  titleAs="h3"
                  title={
                    <span className="row gap-2 nowrap">
                      <Icon name={area.icon} className="ic-sm" />
                      {area.title}
                    </span>
                  }
                  sub={`${n} of ${row.length} allowed`}
                  actions={<Switch id={`er-all-${a}`} label="All" checked={all} aria-checked={all} data-switch="" onChange={(e) => setArea(a, e.target.checked)} />}
                >
                  <div className="ac-perm">
                    {area.actions.map((action, i) => (
                      <Checkbox key={action} id={`er-p-${a}-${i}`} label={action} checked={row[i]} onChange={(e) => setPerm(a, i, e.target.checked)} />
                    ))}
                  </div>
                  {area.note && (
                    <span className="xs muted">
                      <Icon name={area.note.icon} className="ic-sm" /> {area.note.text}
                    </span>
                  )}
                </Card>
              );
            })}
          </div>
          <div className="stack gap-5">
            <Card title="Approval limits" titleAs="h3" sub="Set by the Business Owner. Example values.">
              {LIMITS.map((l, i) => (
                <div className="ac-limit" key={l.title}>
                  <div className="ac-limit-t stack gap-0">
                    <span className="small strong">{l.title}</span>
                    <span className="xs muted">{l.sub}</span>
                  </div>
                  <Field label={l.limitLabel}>
                    <TextInput id={`er-lim-${i}`} prefix="$" value={draft.limits[i].limit} onChange={(e) => setLimit(i, 'limit', e.target.value)} />
                  </Field>
                  <Field label="Second reviewer above" hint="Morgan Hale, Business Owner">
                    <TextInput id={`er-rev-${i}`} prefix="$" value={draft.limits[i].review} onChange={(e) => setLimit(i, 'review', e.target.value)} />
                  </Field>
                </div>
              ))}
              {AUTHORITIES.map((au, i) => (
                <div className="ac-limit" key={au.id}>
                  <div className="ac-limit-t stack gap-0">
                    <span className="small strong">{au.title}</span>
                    <span className="xs muted">{au.sub}</span>
                  </div>
                  <Field label="Authority" hint={au.hint}>
                    <Select id={au.id} options={AUTHORITY_OPTIONS} value={draft.authorities[i]} onChange={(e) => setAuthority(i, e.target.value)} />
                  </Field>
                </div>
              ))}
            </Card>

            <Card title="Second reviewer" titleAs="h3">
              <Switch
                id="er-2nd"
                label="Require a second reviewer for high-value adjustments"
                checked={draft.second}
                aria-checked={draft.second}
                data-switch=""
                onChange={(e) => setDraft((d) => ({ ...d, second: e.target.checked }))}
              />
              <span className="xs muted">A second Finance person or the Business Owner approves any action above the thresholds. The first person cannot approve their own request.</span>
              <Field label="Default second reviewer">
                <Select id="er-2nd-who" options={SECOND_REVIEWERS} value={draft.secondWho} onChange={(e) => setDraft((d) => ({ ...d, secondWho: e.target.value }))} />
              </Field>
            </Card>

            <Card
              title="Reason for change"
              titleAs="h3"
              foot={
                <Button size="sm" icon="send" onClick={sendForApproval}>
                  Send for approval
                </Button>
              }
            >
              <Field label="Reason (required)" error={reasonErr}>
                <Textarea
                  id="er-reason"
                  value={draft.reason}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, reason: e.target.value }));
                    if (e.target.value.trim()) setReasonErr('');
                  }}
                />
              </Field>
              <Field label="Effective from" hint="Requests already waiting for approval keep the old limit.">
                <TextInput id="er-eff" icon="calendar" value={draft.effective} onChange={(e) => setDraft((d) => ({ ...d, effective: e.target.value }))} />
              </Field>
            </Card>
          </div>
        </div>
      </AdminLayout>
    );
  }

  const editLink = (r: Role, text: string, className: string) => (
    <Link className={className} to={href('admin/staff', 'edit-role')} onClick={() => openRole(r.role)}>
      {text}
    </Link>
  );
  const roleName = (r: Role, className: string) =>
    pending.includes(r.role) ? (
      <span className="row gap-2 nowrap">
        <span className={className}>{r.role}</span>
        <Badge tone="warning">Approval pending</Badge>
      </span>
    ) : (
      <span className={className}>{r.role}</span>
    );
  const noRoles = <span className="small muted">No roles match “{q}”.</span>;

  return (
    <AdminLayout active="staff">
      <PageHeader
        crumbs={[{ label: 'Reports and settings' }, { label: 'Staff and roles' }]}
        title="Staff and roles"
        sub={`${roles.length} roles · ${nActive} active staff · ${nInvited} ${nInvited === 1 ? 'invitation' : 'invitations'}`}
        actions={
          <>
            <Button variant="secondary" size="sm" icon="plus">
              Add role
            </Button>
            <Button size="sm" icon="user-plus" onClick={focusInvite}>
              Invite staff
            </Button>
          </>
        }
      />
      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.text}
        </Alert>
      )}
      <Alert tone="warning" title="Access is not financial authority">
        Assigning a role gives access to its screens. Approval limits for payouts, refunds, holds, restrictions and publication overrides are set by the Business Owner, Morgan Hale, and changes to them need her approval.
      </Alert>
      <div className="ac-main">
        <div className="stack gap-5">
          <Card flush title="Roles" sub="A role is a set of responsibilities, not a person. One person can hold several roles." actions={<SearchInput id="st-q" placeholder="Search roles" value={q} onChange={setQ} />}>
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
                    {shownRoles.map((r) => (
                      <tr key={r.role}>
                        <td>{roleName(r, 'small strong')}</td>
                        <td>
                          <span className="small">{r.area}</span>
                        </td>
                        <td>
                          {r.people.map((p) => (
                            <span className="ac-who" key={p}>
                              <Avatar name={p} className="ac-av" />
                              <span className="stack gap-0">
                                <span className="small strong nowrap">{p}</span>
                              </span>
                            </span>
                          ))}
                        </td>
                        <td>
                          <span className="small">{r.backup}</span>
                        </td>
                        <td>
                          <span className="small">{r.limit}</span>
                        </td>
                        <td className="col-pin">{editLink(r, 'Edit role', 'small strong nowrap')}</td>
                      </tr>
                    ))}
                    {!shownRoles.length && (
                      <tr>
                        <td colSpan={6}>{noRoles}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </TableWrap>
            </div>
            <div className="ac-mlist only-phone">
              {shownRoles.map((r) => (
                <div className="ac-mi" key={r.role}>
                  <div className="row between gap-2 nowrap top">
                    {roleName(r, 'small strong min-w-0')}
                    {editLink(r, 'Edit', 'small strong')}
                  </div>
                  <div className="xs sub">
                    {r.area} · {r.people.join(', ')} · backup {r.backup}
                  </div>
                  <div className="xs sub">Limit: {r.limit}</div>
                </div>
              ))}
              {!shownRoles.length && <div className="ac-mi">{noRoles}</div>}
            </div>
          </Card>

          <Card
            flush
            titleAs="h3"
            title="Staff members"
            sub="Every account uses 2-step sign-in"
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
            <div className="no-phone">
              <TableWrap label="Staff members table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Roles</th>
                      <th scope="col">Last active</th>
                      <th scope="col">Sign-in</th>
                      <th className="col-pin" scope="col">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownStaff.map((s) => {
                      const invited = s.status === 'Invited';
                      const badges = s.roles.map((r) => (
                        <Badge tone="outline" key={r}>
                          {r}
                        </Badge>
                      ));
                      return (
                        <tr key={s.email}>
                          <td>
                            <span className="ac-who">
                              <Avatar name={s.name} className="ac-av" />
                              <span className="stack gap-0">
                                <span className="small strong">{s.name}</span>
                                <span className="xs muted">{s.email}</span>
                              </span>
                            </span>
                          </td>
                          <td>{invited ? badges : <span className="row gap-1">{badges}</span>}</td>
                          <td>
                            <span className={invited ? 'small muted' : 'small'}>{s.lastActive}</span>
                          </td>
                          <td>
                            {invited ? (
                              <Badge>Not set up</Badge>
                            ) : (
                              <Badge tone="success" icon="shield-check">
                                2-step on
                              </Badge>
                            )}
                          </td>
                          <td className="col-pin">
                            <StatusBadge status={s.status} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            </div>
            <div className="ac-mlist only-phone">
              {shownStaff.map((s) => (
                <div className="ac-mi" key={s.email}>
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">{s.name}</span>
                    <StatusBadge status={s.status} />
                  </div>
                  {s.status === 'Invited' ? (
                    <div className="xs sub">
                      {s.roles.join(', ')} · invitation sent {s.invited}
                    </div>
                  ) : (
                    <>
                      <div className="xs sub">{s.roles.join(', ')}</div>
                      <div className="xs sub">Last active: {s.lastActive}</div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="stack gap-5">
          <Card
            title="Invite staff"
            titleAs="h3"
            sub="Invitations expire after 7 days"
            foot={
              <Button size="sm" icon="send" onClick={sendInvite}>
                Send invitation
              </Button>
            }
          >
            <Field label="Full name" error={inviteErr.name}>
              <TextInput id="st-name" ref={nameRef} placeholder="First and last name" value={invite.name} onChange={(e) => setInv('name', e.target.value)} />
            </Field>
            <Field label="Work email" error={inviteErr.email}>
              <TextInput id="st-email" type="email" placeholder="name@marketly.example" value={invite.email} onChange={(e) => setInv('email', e.target.value)} />
            </Field>
            <Field label="Role" hint="You can add more roles after they accept." error={inviteErr.role}>
              <Select id="st-role" options={[NO_ROLE, ...roles.map((r) => r.role), ...STAFF_ROLES]} value={invite.role} onChange={(e) => setInv('role', e.target.value)} />
            </Field>
            <Field label="Reports to">
              <Select id="st-mgr" options={MANAGERS} value={invite.manager} onChange={(e) => setInv('manager', e.target.value)} />
            </Field>
            <Field label="Reason for access" hint="Required. Saved in Action history with the invitation." error={inviteErr.reason}>
              <Textarea id="st-reason" placeholder="Why this person needs this role, e.g. new hire for the Reno, NV warehouse" value={invite.reason} onChange={(e) => setInv('reason', e.target.value)} />
            </Field>
            <Checkbox id="st-limit" label="Request approval limits from the Business Owner" checked={invite.requestLimits} onChange={(e) => setInv('requestLimits', e.target.checked)} />
          </Card>

          <Card title="Coverage gaps" titleAs="h3" sub="Every work queue needs a lead and a backup">
            <ul className="list">
              {GAPS.map((g) => (
                <li key={g.title}>
                  <span className="grow stack gap-0">
                    <span className="small strong">{g.title}</span>
                    <span className="xs muted">{g.sub}</span>
                  </span>
                  <Badge tone={g.tone}>{g.status}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
