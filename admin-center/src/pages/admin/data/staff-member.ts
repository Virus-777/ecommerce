import { useQuery } from '@tanstack/react-query';
import { call, useApi, type components } from '@marketly/web-shared/api';

// One staff member's lifecycle on Admin › Staff and roles (no design file; built from the page's own parts):
// the member detail (access: role assignments, effective permissions and limits, away periods), the account's
// security detail (identity: status, lockout, devices, recent sign-ins) and the staff invitations.
// Offline server: no email is sent, so links and pass codes come from the server CLI (npm run staff-link).

type S = components['schemas'];
export type StaffMemberDetail = S['access.StaffMemberDetail'];
export type RoleAssignment = S['access.RoleAssignment'];
export type AccountAdmin = S['identity.AccountAdmin'];
export type SecurityEvent = S['identity.SecurityEvent'];
export type Invitation = S['identity.Invitation'];
export type AccountStatus = S['identity.AccountSummary']['status'];

/** Query keys: the member detail sits under ['access'] so the page's role and invite changes refresh it too. */
export const memberKey = (accountId: string) => ['access', 'member', accountId] as const;
export const accountKey = (accountId: string) => ['identity', 'account', accountId] as const;
export const INVITATIONS_KEY = ['identity', 'invitations'] as const;

export function useMemberDetail(accountId: string | null, enabled = true) {
  const { api } = useApi();
  return useQuery({
    queryKey: memberKey(accountId ?? ''),
    queryFn: () => call(api.GET('/api/admin/access/members/{accountId}', { params: { path: { accountId: accountId! } } })) as Promise<StaffMemberDetail>,
    enabled: !!accountId && enabled,
  });
}

export function useAccountAdmin(accountId: string | null, enabled = true) {
  const { api } = useApi();
  return useQuery({
    queryKey: accountKey(accountId ?? ''),
    queryFn: () => call(api.GET('/api/admin/identity/accounts/{id}', { params: { path: { id: accountId! } } })) as Promise<AccountAdmin>,
    enabled: !!accountId && enabled,
  });
}

/** The latest security events (sign-ins, failed attempts, locks, staff actions), newest first. */
export function useSecurityActivity(accountId: string | null, enabled = true) {
  const { api } = useApi();
  return useQuery({
    queryKey: [...accountKey(accountId ?? ''), 'activity'],
    queryFn: async () => (await call(api.GET('/api/admin/identity/accounts/{id}/security-activity', { params: { path: { id: accountId! }, query: { limit: 10 } } }))).items as SecurityEvent[],
    enabled: !!accountId && enabled,
  });
}

/** Staff invitations not accepted yet (pending, expired or revoked), newest first. */
export function useInvitations(enabled = true) {
  const { api } = useApi();
  return useQuery({
    queryKey: INVITATIONS_KEY,
    queryFn: async () => {
      const page = await call(api.GET('/api/admin/identity/invitations', { params: { query: { limit: 100 } } }));
      return (page.items as Invitation[]).filter((i) => i.realm === 'staff' && i.status !== 'accepted').sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    },
    enabled,
  });
}

export const ACCOUNT_STATUS: Record<AccountStatus, string> = {
  invited: 'Invited',
  pending_verification: 'Not verified',
  active: 'Active',
  locked: 'Locked',
  disabled: 'Disabled',
  closed: 'Closed',
};

export const ASSIGNMENT_STATUS: Record<RoleAssignment['status'], string> = {
  pending_acceptance: 'Waits for acceptance',
  pending_approval: 'Approval pending',
  active: 'Active',
  revoked: 'Removed',
  expired: 'Expired',
};

export const INVITATION_STATUS: Record<Invitation['status'], string> = { pending: 'Pending', accepted: 'Accepted', expired: 'Expired', revoked: 'Revoked' };

/** The server command that prints a new invitation link and pass code, or a password reset link, for this person. */
export const staffLinkCommand = (email: string) => `npm run staff-link -- --email ${email}`;
