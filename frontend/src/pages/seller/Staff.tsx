import { useState } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@/layouts';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Avatar, Badge, Button, Card, Checkbox, Dialog, Field, Icon, KeyValue, LogoTile, PageHeader, Select, StatusBadge, TableWrap, Tabs, TextInput, type IconName } from '@/ui';

// Design: pages/seller/seller-staff.html · view "invite-staff" = the invite dialog (filled in for Theo Nguyen).

type Role = 'Owner' | 'Products and inventory' | 'Shipping' | 'Customer service' | 'Custom permissions';
type InviteRole = Exclude<Role, 'Owner'>;
type Level = 'full' | 'view' | 'none' | 'lock';
type PermKey = 'customers' | 'returns' | 'orders' | 'products' | 'inventory' | 'finance';
type NoteKey = 'orders' | 'overdue' | 'returns' | 'messages' | 'payouts';
type Channel = 'In-app' | 'In-app and email' | 'Email';

interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: 'Active' | 'Invited';
  lastActive: string;
}

interface NotePrefs {
  id: string;
  on: Record<NoteKey, boolean>;
  channel: Channel;
}

const MEMBERS: Member[] = [
  { id: 'avery', name: 'Avery Stone', email: 'avery@northwindaudio.com', role: 'Owner', status: 'Active', lastActive: 'Now' },
  { id: 'jun', name: 'Jun Park', email: 'jun@northwindaudio.com', role: 'Products and inventory', status: 'Active', lastActive: 'Today, 8:52 AM' },
  { id: 'maya', name: 'Maya Ortiz', email: 'maya@northwindaudio.com', role: 'Shipping', status: 'Active', lastActive: 'Today, 9:31 AM' },
  { id: 'leo', name: 'Leo Grant', email: 'leo@northwindaudio.com', role: 'Customer service', status: 'Active', lastActive: 'Yesterday, 6:10 PM' },
  { id: 'sana', name: 'Sana Ali', email: 'sana.ali@example.com', role: 'Shipping', status: 'Invited', lastActive: 'Invite expires Oct 15' },
];

/** Permission matrix: short role label per column, level per permission row. */
const MATRIX_ROLE: Record<string, string> = { avery: 'Owner', jun: 'Products', maya: 'Shipping', leo: 'Service' };
const MATRIX: Array<{ perm: string; levels: Record<string, Level> }> = [
  { perm: 'Products', levels: { avery: 'full', jun: 'full', maya: 'none', leo: 'view' } },
  { perm: 'Inventory', levels: { avery: 'full', jun: 'full', maya: 'view', leo: 'none' } },
  { perm: 'Orders and shipping', levels: { avery: 'full', jun: 'view', maya: 'full', leo: 'view' } },
  { perm: 'Returns', levels: { avery: 'full', jun: 'none', maya: 'full', leo: 'full' } },
  { perm: 'Customers', levels: { avery: 'full', jun: 'none', maya: 'view', leo: 'full' } },
  { perm: 'Finance (view)', levels: { avery: 'full', jun: 'none', maya: 'none', leo: 'none' } },
  { perm: 'Payout changes', levels: { avery: 'lock', jun: 'none', maya: 'none', leo: 'none' } },
];
const LEVEL: Record<Level, { icon: IconName; text?: string }> = {
  full: { icon: 'check', text: 'Manage' },
  view: { icon: 'eye', text: 'View' },
  none: { icon: 'minus' },
  lock: { icon: 'lock', text: 'Owner only' },
};

const NOTE_COLS: Array<{ key: NoteKey; label: string }> = [
  { key: 'orders', label: 'New orders' },
  { key: 'overdue', label: 'Dispatch overdue' },
  { key: 'returns', label: 'Returns and cases' },
  { key: 'messages', label: 'Customer messages' },
  { key: 'payouts', label: 'Payouts and holds' },
];
const CHANNELS: Channel[] = ['In-app', 'In-app and email', 'Email'];
const NOTE_PREFS: NotePrefs[] = [
  { id: 'avery', on: { orders: true, overdue: true, returns: true, messages: false, payouts: true }, channel: 'In-app and email' },
  { id: 'jun', on: { orders: false, overdue: false, returns: false, messages: false, payouts: false }, channel: 'In-app' },
  { id: 'maya', on: { orders: true, overdue: true, returns: true, messages: false, payouts: false }, channel: 'In-app and email' },
  { id: 'leo', on: { orders: false, overdue: false, returns: true, messages: true, payouts: false }, channel: 'In-app' },
];

const ROLES: InviteRole[] = ['Products and inventory', 'Shipping', 'Customer service', 'Custom permissions'];
const PERMS: Array<{ key: PermKey; label: string }> = [
  { key: 'customers', label: 'Customers: answer messages, questions and feedback' },
  { key: 'returns', label: 'Returns: respond to return requests' },
  { key: 'orders', label: 'Orders and shipping: view only' },
  { key: 'products', label: 'Products: view only' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'finance', label: 'Finance view (owner only today)' },
];
/** Roles are starting points: each one pre-ticks a set of permissions. */
const ROLE_PERMS: Record<InviteRole, PermKey[]> = {
  'Products and inventory': ['products', 'inventory'],
  Shipping: ['orders', 'returns'],
  'Customer service': ['customers', 'returns', 'orders'],
  'Custom permissions': [],
};

const TABS = [
  { label: 'Store profile', value: 'store', to: href('seller/store') },
  { label: 'Staff and permissions', value: 'staff', to: href('seller/staff') },
  { label: 'Notifications', value: 'notifications', to: href('seller/staff') },
  { label: 'Shipping', value: 'shipping', to: href('seller/shipping') },
];

const INVITE_EXPIRES = 'Invite expires Oct 15';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface Invite {
  email: string;
  name: string;
  role: InviteRole;
  perms: PermKey[];
  notify: boolean;
}
const blankInvite = (role: InviteRole = 'Customer service'): Invite => ({ email: '', name: '', role, perms: ROLE_PERMS[role], notify: true });
const DESIGN_INVITE: Invite = { email: 'theo.nguyen@northwindaudio.com', name: 'Theo Nguyen', role: 'Customer service', perms: ROLE_PERMS['Customer service'], notify: true };

type InviteErrors = Partial<Record<'email' | 'name' | 'perms', string>>;

function validateInvite(i: Invite, members: Member[], withPerms: boolean): InviteErrors {
  const e: InviteErrors = {};
  const email = i.email.trim().toLowerCase();
  if (!email) e.email = 'Enter their email address.';
  else if (!EMAIL_RE.test(email)) e.email = 'Enter an email address like name@company.com.';
  else if (members.some((m) => m.email.toLowerCase() === email)) e.email = 'This person is already on your staff list.';
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

export default function Staff() {
  const [view, setView] = useView<'invite-staff'>();
  const [members, setMembers] = useState(MEMBERS);
  const [prefs, setPrefs] = useState(NOTE_PREFS);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; title: string; body?: string } | null>(null);

  // Dialog: opening ?view=invite-staff directly shows the design's filled-in form.
  const [draft, setDraft] = useState<Invite>(() => (view === 'invite-staff' ? DESIGN_INVITE : blankInvite()));
  const [tried, setTried] = useState(false);
  // Sidebar quick invite.
  const [quick, setQuick] = useState<Invite>(() => blankInvite());
  const [quickTried, setQuickTried] = useState(false);

  const errors = tried ? validateInvite(draft, members, true) : {};
  const quickErrors = quickTried ? validateInvite(quick, members, false) : {};
  const active = members.filter((m) => m.status === 'Active');
  const invitedN = members.length - active.length;
  const matrixPeople = active.filter((m) => MATRIX_ROLE[m.id]);
  const firstName = draft.name.trim().split(' ')[0] || 'them';

  const openInvite = () => {
    setDraft(blankInvite());
    setTried(false);
    setView('invite-staff');
  };
  const close = () => setView('');
  const setD = <K extends keyof Invite>(k: K, v: Invite[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const pickRole = (role: InviteRole) => setDraft((d) => ({ ...d, role, perms: ROLE_PERMS[role] }));
  const togglePerm = (k: PermKey, on: boolean) => setDraft((d) => ({ ...d, perms: on ? [...d.perms, k] : d.perms.filter((p) => p !== k) }));

  const addInvite = (i: Invite) => {
    setMembers((l) => [...l, { id: `inv-${Date.now()}`, name: i.name.trim(), email: i.email.trim(), role: i.role, status: 'Invited', lastActive: INVITE_EXPIRES }]);
    setNotice({ tone: 'success', title: `Invite sent to ${i.email.trim()}`, body: `${i.name.trim()} gets an email link valid for 7 days. They appear as Invited until they accept.` });
  };
  const sendInvite = () => {
    setTried(true);
    if (Object.keys(validateInvite(draft, members, true)).length) return;
    addInvite(draft);
    close();
  };
  const sendQuick = () => {
    setQuickTried(true);
    if (Object.keys(validateInvite(quick, members, false)).length) return;
    addInvite(quick);
    setQuick(blankInvite(quick.role));
    setQuickTried(false);
  };
  const resend = (m: Member) => {
    setMembers((l) => l.map((x) => (x.id === m.id ? { ...x, lastActive: INVITE_EXPIRES } : x)));
    setNotice({ tone: 'success', title: `Invite resent to ${m.email}`, body: 'The earlier link no longer works. The new one is valid for 7 days.' });
  };
  const remove = (m: Member) => {
    setMembers((l) => l.filter((x) => x.id !== m.id));
    setPrefs((l) => l.filter((x) => x.id !== m.id));
    setNotice({ tone: 'info', title: m.status === 'Invited' ? `Invite for ${m.name} cancelled` : `${m.name} removed`, body: m.status === 'Invited' ? 'The invite link no longer works.' : 'They lose access to Northwind Audio right away. This change is recorded.' });
  };
  const changeRole = (m: Member, role: InviteRole) => {
    setMembers((l) => l.map((x) => (x.id === m.id ? { ...x, role } : x)));
    setNotice({ tone: 'success', title: `${m.name} is now ${role}`, body: 'Their access changes right away. This change is recorded.' });
  };
  const setPref =(id: string, k: NoteKey, on: boolean) => setPrefs((l) => l.map((p) => (p.id === id ? { ...p, on: { ...p.on, [k]: on } } : p)));
  const setChannel = (id: string, c: Channel) => setPrefs((l) => l.map((p) => (p.id === id ? { ...p, channel: c } : p)));
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? id;

  return (
    <SellerLayout active="store">
      <PageHeader
        crumbs={[{ label: 'Store and settings', to: href('seller/store') }, { label: 'Staff and permissions' }]}
        title="Staff and permissions"
        sub="Give each person only the access they need. Every change is recorded."
        actions={
          <Button size="sm" icon="user-plus" onClick={openInvite}>
            Invite staff
          </Button>
        }
      />
      <div>
        <Tabs items={TABS} active="staff" />
      </div>
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      <div className="sb-main">
        <div className="stack gap-5">
          <Card title="Staff" sub={`${active.length} active · ${invitedN} invited`} flush>
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
                  {members.map((m) => (
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
                        {m.role === 'Owner' ? (
                          <Badge tone="solid">Owner</Badge>
                        ) : editing === m.id ? (
                          <Select id={`sf-role-${m.id}`} ctl="sm" aria-label={`${m.name}: role`} options={ROLES} value={m.role} onChange={(e) => changeRole(m, e.target.value as InviteRole)} />
                        ) : (
                          <span className="small">{m.role}</span>
                        )}
                      </td>
                      <td>
                        <StatusBadge status={m.status} />
                      </td>
                      <td>
                        <span className="xs sub nowrap">{m.lastActive}</span>
                      </td>
                      <td className="col-pin">
                        {m.role !== 'Owner' && (
                          <span className="row gap-1 nowrap">
                            {m.status === 'Invited' ? (
                              <Button variant="ghost" size="sm" onClick={() => resend(m)}>
                                Resend<span className="sr-only"> {m.name}</span>
                              </Button>
                            ) : (
                              <Button variant="ghost" size="sm" aria-expanded={editing === m.id} onClick={() => setEditing(editing === m.id ? null : m.id)}>
                                {editing === m.id ? 'Done' : 'Edit'}
                                <span className="sr-only"> {m.name}</span>
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => remove(m)}>
                              {m.status === 'Invited' ? 'Cancel invite' : 'Remove'}
                              <span className="sr-only"> {m.name}</span>
                            </Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>

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
                        <span className="xs muted">{MATRIX_ROLE[m.id]}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MATRIX.map((r) => (
                    <tr key={r.perm}>
                      <td>
                        <span className="small strong nowrap">{r.perm}</span>
                      </td>
                      {matrixPeople.map((m, i) => (
                        <td key={m.id} className={i === matrixPeople.length - 1 ? 'c col-pin' : 'c'}>
                          <Perm level={r.levels[m.id]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>

          <Card
            title="Notification preferences"
            sub="Who hears about what"
            titleAs="h3"
            flush
            foot={
              <Button variant="secondary" size="sm" onClick={() => setNotice({ tone: 'success', title: 'Notification preferences saved', body: 'Changes apply to new notices from now on.' })}>
                Save preferences
              </Button>
            }
          >
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
                  {prefs.map((p, r) => {
                    const name = nameOf(p.id);
                    const isOwner = p.id === 'avery';
                    return (
                      <tr key={p.id}>
                        <td>
                          <span className="small strong nowrap">{name}</span>
                        </td>
                        {NOTE_COLS.map((c, i) => (
                          <td key={c.key} className="c">
                            {c.key === 'payouts' && !isOwner ? (
                              <span className="sb-perm none" title="Owner only">
                                <Icon name="lock" className="ic-sm" />
                                <span className="sr-only">Owner only</span>
                              </span>
                            ) : (
                              <input type="checkbox" id={`sf-n-${r}-${i}`} aria-label={`${name}: ${c.label}`} checked={p.on[c.key]} onChange={(e) => setPref(p.id, c.key, e.target.checked)} />
                            )}
                          </td>
                        ))}
                        <td className="col-pin">
                          <Select id={`sf-ch-${r}`} aria-label={`${name}: notification channel`} options={CHANNELS} value={p.channel} onChange={(e) => setChannel(p.id, e.target.value as Channel)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </div>

        <div className="stack gap-5">
          <Card title="Account status" titleAs="h3">
            <div className="row gap-3">
              <LogoTile initials="NA" tint="2" />
              <div className="stack gap-0">
                <span className="strong">Northwind Audio</span>
                <span className="xs muted">Seller ID NWA-20714</span>
              </div>
            </div>
            <KeyValue
              pairs={[
                ['Account', <StatusBadge key="a" status="Approved" />],
                ['Seller since', 'Jul 14, 2026'],
                [
                  'Verification',
                  <Badge key="v" tone="info" icon="shield-check">
                    Verified seller
                  </Badge>,
                ],
                ['Product approval', '26 active · 2 hidden'],
                ['Payouts', <StatusBadge key="p" status="Active" />],
                ['Restrictions', <Link key="r" to={href('seller/performance')}>1 active: Cameras</Link>],
              ]}
            />
            <span className="xs muted">Changes to ownership or verification details need Marketly review.</span>
          </Card>

          <Card
            title="Invite staff"
            sub="They get an email link valid for 7 days"
            titleAs="h3"
            foot={
              <Button size="sm" icon="send" onClick={sendQuick}>
                Send invite
              </Button>
            }
          >
            <div className="sb-form-grid">
              <Field label="Email" error={quickErrors.email}>
                <TextInput id="sf-q-email" type="email" value={quick.email} placeholder="name@company.com" error={!!quickErrors.email} onChange={(e) => setQuick((q) => ({ ...q, email: e.target.value }))} />
              </Field>
              <Field label="Name" error={quickErrors.name}>
                <TextInput id="sf-q-name" value={quick.name} placeholder="Full name" error={!!quickErrors.name} onChange={(e) => setQuick((q) => ({ ...q, name: e.target.value }))} />
              </Field>
              <Field label="Role" hint="Roles are starting points. You can change single permissions.">
                <Select id="sf-q-role" options={ROLES} value={quick.role} onChange={(e) => setQuick((q) => ({ ...q, role: e.target.value as InviteRole, perms: ROLE_PERMS[e.target.value as InviteRole] }))} />
              </Field>
            </div>
          </Card>
        </div>
      </div>

      <Dialog
        open={view === 'invite-staff'}
        onClose={close}
        title="Invite staff"
        size="lg"
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button icon="send" onClick={sendInvite}>
              Send invite
            </Button>
          </>
        }
      >
        <div className="sb-form-grid">
          <Field label="Email" error={errors.email}>
            <TextInput id="sf-m-email" type="email" value={draft.email} placeholder="name@company.com" error={!!errors.email} onChange={(e) => setD('email', e.target.value)} />
          </Field>
          <Field label="Name" error={errors.name}>
            <TextInput id="sf-m-name" value={draft.name} placeholder="Full name" error={!!errors.name} onChange={(e) => setD('name', e.target.value)} />
          </Field>
          <Field label="Role" hint="Roles are starting points. You can change single permissions.">
            <Select id="sf-m-role" options={ROLES} value={draft.role} onChange={(e) => pickRole(e.target.value as InviteRole)} />
          </Field>
        </div>
        <div className="stack gap-2">
          <span className="label">Permissions for {draft.role}</span>
          <div className="grid md2 gap-2">
            {PERMS.map((p, i) => (
              <Checkbox key={p.key} id={`sf-m-p${i + 1}`} label={p.label} checked={draft.perms.includes(p.key)} onChange={(e) => togglePerm(p.key, e.target.checked)} />
            ))}
          </div>
          {errors.perms && (
            <span className="error-text" role="alert">
              <Icon name="circle-alert" className="ic-sm" />
              {errors.perms}
            </span>
          )}
          <div className="panel row gap-2 xs sub">
            <Icon name="lock" className="ic-sm" />
            Payout changes: owner only. This can't be given to staff.
          </div>
        </div>
        <Checkbox id="sf-m-notify" label={`Send ${firstName} notifications for returns and customer messages`} checked={draft.notify} onChange={(e) => setD('notify', e.target.checked)} />
      </Dialog>
    </SellerLayout>
  );
}
