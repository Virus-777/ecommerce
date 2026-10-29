/**
 * Preferences: what customers get (essential always on; promotional consent lives in customers),
 * seller member topics and channels (set by the owner; essential notices always reach the owner),
 * staff email preferences, and Android push devices (phase 3).
 */
import { createHash } from 'node:crypto';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as identity from '../../../spec/identity.js';
import type { CustomerNotificationPreferences, MemberPreference, MemberPreferenceInput, PushDevice, PushDeviceInput, PushPreference, SellerPreferences, StaffPreferences } from '../../../spec/notifications.js';
import { INBOX_GROUPS, SELLER_GROUPS, TOPICS, sellerGroup, type SellerPrefGroup } from '../domain/catalog.js';
import { effectiveGroups, lockedGroups, type MemberAccessLike } from '../domain/rules.js';
import { pushDeviceOf } from '../mappers.js';
import type { MemberPrefRow, PushDeviceRow } from '../ports.js';
import { actorText, Core } from './core.js';
import type { Inbox } from './inbox.js';
import type { By } from './admin.js';

export interface SellerCaller {
  sellerId: string;
  accountId: string;
  memberId: string;
  access: MemberAccessLike;
  canManage: boolean;
}

const tokenHash = (token: string) => createHash('sha256').update(`push:${token}`).digest('hex');

export class Preferences {
  constructor(
    private readonly core: Core,
    private readonly inbox: Inbox,
  ) {}

  /* ---------------------------------------------------------------- customers */

  async customerPreferences(accountId: string): Promise<CustomerNotificationPreferences> {
    const push = await this.pushPreference(accountId);
    const channels = ['in_app', 'email', ...(push.available && push.orderUpdates && push.devices.length ? ['push'] : [])];
    return {
      essential: {
        channels,
        topics: TOPICS.filter((t) => t.audience === 'customer' && t.category === 'essential' && t.supports.includes('in_app')).map((t) => t.label),
        note: "Order, payment, delivery, return, refund, case and security messages are always sent, in your account and by email. You can't turn them off.",
      },
      promotional: { managedBy: 'customers', path: '/api/store/customers/marketing-preferences' },
      push,
    };
  }

  async pushPreference(accountId: string): Promise<PushPreference> {
    const devices = await this.core.repo.pushDevices({ accountIds: [accountId], audience: 'customer' });
    return {
      available: this.core.launchPhase >= 3,
      orderUpdates: devices.length ? devices.some((d) => d.enabled) : true,
      devices: devices.map((d) => pushDeviceOf(d, this.core.decryptToken(d.token_encrypted))),
    };
  }

  async updateCustomerPush(accountId: string, orderUpdates: boolean): Promise<PushPreference> {
    await this.core.repo.setPushEnabled(accountId, 'customer', orderUpdates);
    return this.pushPreference(accountId);
  }

  /* ---------------------------------------------------------------- push devices */

  /** Upsert by installation; a token moving to another account is reassigned */
  async registerDevice(owner: { accountId: string; audience: 'customer' | 'seller'; sellerId: string | null }, input: PushDeviceInput): Promise<PushDevice> {
    const repo = this.core.repo;
    const now = this.core.now();
    const hash = tokenHash(input.token);
    const encrypted = this.core.encryptToken(input.token);
    const patch: Partial<PushDeviceRow> = {
      account_id: owner.accountId,
      audience: owner.audience,
      seller_id: owner.sellerId,
      platform: input.platform,
      token_encrypted: encrypted,
      token_hash: hash,
      app_version: input.appVersion,
      installation_id: input.installationId ?? null,
      enabled: true,
      last_seen_at: now,
      invalidated_at: null,
    };
    const row = await repo.transaction(async (tx) => {
      // both rows are written below, so both are locked as they are read — by token first and then by
      // installation, always that way round, so two registrations cannot take them in opposite orders
      // (docs/10 §11.2 rules 1 and 3)
      const byToken = await tx.pushDeviceByHash(hash, { forUpdate: true });
      const byInstall = input.installationId ? await tx.pushDeviceByInstallation(owner.accountId, owner.audience, input.installationId, { forUpdate: true }) : undefined;
      if (byInstall && byToken && byInstall.id !== byToken.id) {
        // the installation got a new token that another row holds: keep one row
        await tx.updatePushDevice(byToken.id, { token_hash: `${byToken.token_hash}:replaced:${newId()}`, invalidated_at: now, enabled: false });
        return tx.updatePushDevice(byInstall.id, patch);
      }
      const existing = byInstall ?? byToken;
      if (existing) return tx.updatePushDevice(existing.id, patch);
      return tx.insertPushDevice({ id: newId(), created_at: now, ...patch } as PushDeviceRow);
    });
    return pushDeviceOf(row, input.token);
  }

  async removeDevice(owner: { accountId: string; audience: 'customer' | 'seller'; sellerId: string | null }, id: string): Promise<void> {
    const d = await this.core.repo.getPushDevice(id);
    if (!d || d.account_id !== owner.accountId || d.audience !== owner.audience || (owner.sellerId && d.seller_id !== owner.sellerId) || d.invalidated_at) {
      throw new AppError('NOT_FOUND', 'Device not found');
    }
    await this.core.repo.updatePushDevice(id, { invalidated_at: this.core.now(), enabled: false });
  }

  /* ---------------------------------------------------------------- seller members */

  #memberView(row: MemberPrefRow, access: MemberAccessLike | null, names: Map<string, identity.AccountSummary>): MemberPreference {
    const isOwner = access?.isOwner ?? false;
    return {
      memberId: row.member_id,
      accountId: row.account_id,
      name: names.get(row.account_id)?.displayName ?? 'Team member',
      roleLabel: access?.role ?? (isOwner ? 'Owner' : 'Team member'),
      isOwner,
      groups: effectiveGroups(row.groups as Record<string, unknown>, isOwner),
      channel: row.channel as MemberPreference['channel'],
      lockedGroups: lockedGroups(isOwner),
    };
  }

  async sellerPreferences(caller: SellerCaller): Promise<SellerPreferences> {
    await this.inbox.rememberMember(caller.sellerId, caller.memberId, caller.accountId, caller.access.isOwner);
    const rows = await this.core.sellerMembers(caller.sellerId); // members who never visited show their defaults
    const names = await this.core.accounts(rows.map((r) => r.account_id));
    const members: MemberPreference[] = [];
    for (const r of rows) {
      const access = r.account_id === caller.accountId ? caller.access : await this.core.memberAccess(caller.sellerId, r.account_id);
      if (!access && this.core.sellers && r.account_id !== caller.accountId) continue; // no longer a member
      members.push(this.#memberView(r, access, names));
    }
    members.sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.name.localeCompare(b.name));
    return {
      groups: SELLER_GROUPS.map((g) => ({ key: g.key, label: g.label, ownerOnly: g.ownerOnly, essentialForOwner: g.essentialForOwner, permission: g.permission })),
      members,
      essentialNote: 'Essential notices (new orders, dispatch deadlines, returns and cases, payouts and holds, account health) always reach the owner, in Seller Center and by email.',
    };
  }

  /** G49a: invited members (sellers.member.invited) until they join or the invitation is revoked */
  async rememberInvited(sellerId: string, memberId: string, email: string): Promise<void> {
    await this.core.repo.rememberInvited({ seller_id: sellerId, member_id: memberId, email, invited_at: this.core.now() });
  }

  async forgetInvited(sellerId: string, memberId: string): Promise<void> {
    await this.core.repo.forgetInvited(sellerId, memberId);
  }

  async updateMember(caller: SellerCaller, memberId: string, input: MemberPreferenceInput, by: By): Promise<MemberPreference> {
    const repo = this.core.repo;
    let row = await repo.memberPreference(caller.sellerId, memberId);
    const self = memberId === caller.memberId || row?.account_id === caller.accountId;
    if (!row && self) row = await this.inbox.rememberMember(caller.sellerId, caller.memberId, caller.accountId, caller.access.isOwner);
    row ??= (await this.core.sellerMembers(caller.sellerId)).find((r) => r.member_id === memberId); // a member who never opened Seller Center
    if (!row && (await repo.invitedMember(caller.sellerId, memberId))) {
      // G49a: an invitation not accepted yet has no account to send to
      throw new AppError('MEMBER_NOT_JOINED', 'This person has not accepted the invitation yet; their notification settings open once they join.', { memberId });
    }
    if (!row) throw new AppError('NOT_FOUND', 'Member not found');
    if (!self && !caller.canManage) throw new AppError('FORBIDDEN', "Only the owner can change other members' notifications", { permission: 'notifications.preferences.manage' });
    const access = row.account_id === caller.accountId ? caller.access : await this.core.memberAccess(caller.sellerId, row.account_id);
    if (!access && this.core.sellers && row.account_id !== caller.accountId) throw new AppError('NOT_FOUND', 'Member not found');
    const isOwner = access?.isOwner ?? false;
    const unknown = Object.keys(input.groups).filter((k) => !sellerGroup(k));
    if (unknown.length) throw new AppError('VALIDATION_FAILED', 'Unknown topic groups', { issues: unknown.map((k) => ({ path: `groups.${k}`, message: 'not a topic group' })) });
    const before = effectiveGroups(row.groups as Record<string, unknown>, isOwner);
    const next: Record<SellerPrefGroup, boolean> = { ...before };
    for (const [key, on] of Object.entries(input.groups) as [SellerPrefGroup, boolean][]) {
      const g = sellerGroup(key)!;
      if (on === before[key]) continue;
      if (isOwner && g.essentialForOwner && !on) throw new AppError('GROUP_LOCKED', `${g.label} is essential for the owner and stays on.`, { group: key });
      if (!isOwner && g.ownerOnly && on) throw new AppError('GROUP_LOCKED', `${g.label} only reaches the owner.`, { group: key });
      if (!caller.canManage && g.essentialForOwner) throw new AppError('GROUP_LOCKED', `${g.label} is set by the owner.`, { group: key });
      next[key] = on;
    }
    const after = await repo.upsertMemberPreference({
      seller_id: caller.sellerId,
      member_id: row.member_id,
      account_id: row.account_id,
      groups: next as never,
      channel: input.channel,
      updated_by: actorText(by.actor),
      updated_at: this.core.now(),
    });
    const names = await this.core.accounts([after.account_id]);
    const view = this.#memberView(after, access, names);
    await this.core.audit(
      {
        action: 'notifications.member_preferences.update',
        actionLabel: 'Changed member notification preferences',
        category: 'settings',
        target: { type: 'seller_member', id: row.member_id, label: view.name, sellerId: caller.sellerId } as never,
        before: { groups: before, channel: row.channel },
        after: { groups: view.groups, channel: view.channel },
        visibleToSeller: true,
      },
      by,
    );
    return view;
  }

  /* ---------------------------------------------------------------- staff */

  async staffPreferences(accountId: string): Promise<StaffPreferences> {
    const row = await this.core.repo.staffPreference(accountId);
    const stored = (row?.email_by_area ?? {}) as Record<string, boolean>;
    return {
      accountId,
      emailByArea: { ...Object.fromEntries(INBOX_GROUPS.staff.map((a) => [a, true])), ...stored },
      emailForMentions: row?.email_for_mentions ?? true,
      dailyDigest: row?.daily_digest ?? false,
    };
  }

  async updateStaffPreferences(accountId: string, body: { emailByArea: Record<string, boolean>; emailForMentions: boolean; dailyDigest: boolean }): Promise<StaffPreferences> {
    await this.core.repo.upsertStaffPreference({
      account_id: accountId,
      email_by_area: body.emailByArea as never,
      email_for_mentions: body.emailForMentions,
      daily_digest: body.dailyDigest,
      updated_at: this.core.now(),
    });
    return this.staffPreferences(accountId);
  }
}
