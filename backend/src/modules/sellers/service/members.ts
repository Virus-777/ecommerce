/** Seller members, invitations, role templates and the seller permission catalogue; member access for the kernel guard. */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { specs } from '../../../spec/index.js';
import type { InviteMemberInput, PermissionEntry, SellerMember, SellerRoleTemplate } from '../../../spec/sellers.js';
import { permissionCatalogue, ROLE_TEMPLATES, ROLE_TEXT } from '../domain/catalogue.js';
import { sellerMemberMachine } from '../domain/state-machines.js';
import * as map from '../mappers.js';
import type { MemberRec, SellerRec, SellersRepository } from '../ports.js';
import { invalid, notFound, Part, SYSTEM, type By } from './core.js';

const OPEN = ['invited', 'active', 'suspended'];

/** Dedupe key of the seller_owner_missing work item (resolved when the seller has an active owner again) */
export const ownerMissingKey = (sellerId: string) => `seller_owner_missing:${sellerId}`;

export class MembersPart extends Part {
  #catalogue?: PermissionEntry[];

  /** Seller-audience permissions of the modules running in this process */
  catalogue(): PermissionEntry[] {
    if (this.#catalogue) return this.#catalogue;
    const running = new Set<string>(this.ctx.modules);
    const all = Object.values(specs) as unknown as { name: string; permissions: readonly { key: string; audience: string; desc: string; ownerOnly?: boolean; delegable?: boolean }[] }[];
    const perms = all.filter((s) => running.has(s.name)).flatMap((s) => [...s.permissions]);
    return (this.#catalogue = permissionCatalogue(perms));
  }

  allSellerKeys = () => this.catalogue().map((p) => p.key);

  /* ---------------------------------------------------------------- kernel guard */

  /** One indexed lookup: the active membership of this account for this seller */
  async getMemberAccess(sellerId: string, accountId: string) {
    if (!isUuid(sellerId) || !isUuid(accountId)) return null;
    const m = await this.repo.activeMember(sellerId, accountId);
    if (!m) return null;
    return { memberId: m.id, role: m.role, permissions: m.is_owner ? this.allSellerKeys() : map.strings(m.permissions), isOwner: m.is_owner };
  }

  /** Public API: active members with an identity account (notifications fans out to them, owner first) */
  async activeMembers(sellerId: string): Promise<{ memberId: string; accountId: string; role: string; isOwner: boolean }[]> {
    if (!isUuid(sellerId)) return [];
    const rows = await this.repo.find('members', { seller_id: sellerId, status: 'active' }, { orderBy: [['is_owner', 'desc'], ['invited_at', 'asc']] });
    return rows.filter((m) => m.account_id).map((m) => ({ memberId: m.id, accountId: m.account_id!, role: m.role, isOwner: m.is_owner }));
  }

  /** Public API: the owner's identity account (null for an unknown seller) */
  async ownerAccount(sellerId: string): Promise<{ accountId: string; memberId: string } | null> {
    if (!isUuid(sellerId)) return null;
    const owner = await this.ownerOf(sellerId);
    return owner?.account_id ? { accountId: owner.account_id, memberId: owner.id } : null;
  }

  /* ---------------------------------------------------------------- reads */

  async listMembers(sellerId: string): Promise<SellerMember[]> {
    const rows = await this.repo.find('members', { seller_id: sellerId }, { orderBy: [['is_owner', 'desc'], ['invited_at', 'asc']] });
    return rows.map(map.member);
  }

  listRoleTemplates(): { roles: SellerRoleTemplate[]; permissions: PermissionEntry[] } {
    const known = new Set(this.allSellerKeys());
    const roles: SellerRoleTemplate[] = [
      { key: 'owner', ...ROLE_TEXT.owner, permissions: this.allSellerKeys() },
      ...(Object.keys(ROLE_TEMPLATES) as (keyof typeof ROLE_TEMPLATES)[]).map((key) => ({ key, ...ROLE_TEXT[key], permissions: ROLE_TEMPLATES[key].filter((k) => known.has(k)) })),
      { key: 'custom', ...ROLE_TEXT.custom, permissions: [] },
    ];
    return { roles, permissions: this.catalogue() };
  }

  /** Template or chosen permissions; owner-only and non-delegable keys are refused */
  private permissionsFor(role: InviteMemberInput['role'], chosen: string[] | null | undefined): string[] {
    const cat = new Map(this.catalogue().map((p) => [p.key, p]));
    const keys = chosen ?? (role === 'custom' ? [] : ROLE_TEMPLATES[role].filter((k) => cat.has(k)));
    const unknown = keys.filter((k) => !cat.has(k));
    if (unknown.length) throw invalid(unknown.map((k) => ({ path: 'permissions', message: `${k} is not a seller permission` })));
    const refused = keys.filter((k) => cat.get(k)!.ownerOnly || !cat.get(k)!.delegable);
    if (refused.length) throw new AppError('NOT_DELEGABLE', `These permissions can't be given to staff: ${refused.join(', ')}`, { permissions: refused });
    return [...new Set(keys)];
  }

  private async memberOf(sellerId: string, memberId: string, repo: SellersRepository = this.repo, forUpdate = false): Promise<MemberRec> {
    const m = isUuid(memberId) ? await repo.get('members', memberId, { forUpdate }) : undefined;
    if (!m || m.seller_id !== sellerId) throw notFound('Member');
    return m;
  }

  /* ---------------------------------------------------------------- invitations */

  async inviteMember(sellerId: string, input: InviteMemberInput, by: By): Promise<SellerMember> {
    const seller = await this.core.seller(sellerId);
    const permissions = this.permissionsFor(input.role, input.permissions);
    const email = input.email.trim().toLowerCase();
    if (!input.name.trim()) throw invalid([{ path: 'name', message: 'Enter the person’s name' }]);
    if (await this.repo.findOne('members', { seller_id: sellerId, email, status: OPEN })) throw new AppError('MEMBER_EXISTS', 'This email is already a member or invited');
    const inv = await this.ctx.use('identity').inviteSellerMember({ email, name: input.name.trim(), sellerId, sellerName: seller.store_name, invitedBy: by.actor });
    const now = this.now();
    const row = await this.repo.insert('members', {
      id: newId(),
      seller_id: sellerId,
      account_id: inv.accountId ?? null,
      name: input.name.trim(),
      email,
      role: input.role,
      permissions: permissions as never,
      is_owner: false,
      status: sellerMemberMachine.initial,
      invitation_id: inv.id,
      invited_by: map.actorText(by.actor),
      invited_at: now,
      invite_expires_at: new Date(inv.expiresAt),
      joined_at: null,
      last_active_at: null,
      removed_at: null,
    });
    this.core.publish('sellers.member.invited', { sellerId, memberId: row.id, email }, by);
    await this.core.audit(
      { action: 'sellers.member.invite', actionLabel: 'Invited a staff member', category: 'access', target: this.target(seller, row), after: { email, role: input.role, permissions }, visibleToSeller: true },
      by,
    );
    return map.member(row);
  }

  async resendInvitation(sellerId: string, memberId: string, by: By): Promise<SellerMember> {
    const seller = await this.core.seller(sellerId);
    const m = await this.memberOf(sellerId, memberId);
    if (m.status !== 'invited') throw new AppError('ILLEGAL_TRANSITION', 'Only open invitations can be sent again', { from: m.status, event: 'resend' });
    const inv = await this.ctx.use('identity').inviteSellerMember({ email: m.email, name: m.name, sellerId, sellerName: seller.store_name, invitedBy: by.actor });
    const row = await this.repo.update('members', m.id, { invitation_id: inv.id, invited_at: this.now(), invite_expires_at: new Date(inv.expiresAt), account_id: m.account_id ?? inv.accountId ?? null });
    return map.member(row);
  }

  async revokeInvitation(sellerId: string, memberId: string, by: By): Promise<SellerMember> {
    const seller = await this.core.seller(sellerId);
    const m = await this.memberOf(sellerId, memberId);
    const status = this.core.step(sellerMemberMachine, m.status, 'revoke');
    // the accept link stops working at once (identity publishes identity.invitation.revoked); our sellerId scopes it
    if (m.invitation_id) await this.ctx.use('identity').revokeInvitation(m.invitation_id, { reason: 'revoked_by_owner', by: by.actor, contextRef: sellerId });
    const row = await this.repo.update('members', m.id, { status });
    await this.core.audit({ action: 'sellers.member.revoke_invitation', actionLabel: 'Cancelled a staff invitation', category: 'access', target: this.target(seller, row), visibleToSeller: true }, by);
    return map.member(row);
  }

  /* ---------------------------------------------------------------- changes */

  async updateMember(sellerId: string, memberId: string, body: { role?: InviteMemberInput['role'] | null; permissions?: string[] | null }, by: By): Promise<SellerMember> {
    const seller = await this.core.seller(sellerId);
    const m = await this.memberOf(sellerId, memberId);
    if (m.is_owner) throw new AppError('OWNER_ONLY', "The owner's permissions can't be changed");
    if (!OPEN.includes(m.status)) throw new AppError('ILLEGAL_TRANSITION', 'This member is no longer on the account', { from: m.status, event: 'update' });
    const role = body.role ?? (m.role as InviteMemberInput['role']);
    const permissions = this.permissionsFor(role, body.permissions ?? (body.role ? null : map.strings(m.permissions)));
    const row = await this.repo.update('members', m.id, { role, permissions: permissions as never });
    this.core.publish('sellers.member.permissions_changed', { sellerId, memberId: m.id, permissions }, by);
    if (row.status === 'active' && row.account_id) {
      await this.ctx.use('identity').grantSellerContext({ accountId: row.account_id, sellerId, memberId: row.id, sellerName: seller.store_name, roleLabel: ROLE_TEXT[role].label, isOwner: false });
    }
    await this.core.audit(
      {
        action: 'sellers.member.update',
        actionLabel: 'Changed staff permissions',
        category: 'access',
        target: this.target(seller, row),
        before: { role: m.role, permissions: m.permissions },
        after: { role, permissions },
        visibleToSeller: true,
      },
      by,
    );
    return map.member(row);
  }

  async suspendMember(sellerId: string, memberId: string, reason: string | null | undefined, by: By): Promise<SellerMember> {
    const seller = await this.core.seller(sellerId);
    const m = await this.memberOf(sellerId, memberId);
    if (m.is_owner) throw new AppError('LAST_OWNER', 'The owner cannot be removed or suspended');
    const status = this.core.step(sellerMemberMachine, m.status, 'suspend');
    const row = await this.repo.update('members', m.id, { status });
    this.core.publish('sellers.member.removed', { sellerId, memberId: m.id, accountId: m.account_id }, by);
    await this.core.audit({ action: 'sellers.member.suspend', actionLabel: 'Suspended a staff member', category: 'access', target: this.target(seller, row), reason: reason ?? null, visibleToSeller: true }, by);
    return map.member(row);
  }

  /** suspended → active with the role and permissions the member had; the seller context is granted again */
  async reactivateMember(sellerId: string, memberId: string, reason: string | null | undefined, by: By): Promise<SellerMember> {
    const seller = await this.core.seller(sellerId);
    const m = await this.memberOf(sellerId, memberId);
    if (m.is_owner) throw new AppError('OWNER_ONLY', 'The owner is never suspended');
    const status = this.core.step(sellerMemberMachine, m.status, 'reactivate');
    const row = await this.repo.update('members', m.id, { status });
    await this.grant(seller, row);
    const permissions = map.strings(row.permissions);
    this.core.publish('sellers.member.reactivated', { sellerId, memberId: m.id, accountId: m.account_id, permissions }, by);
    await this.core.audit(
      { action: 'sellers.member.reactivate', actionLabel: 'Reactivated a staff member', category: 'access', target: this.target(seller, row), reason: reason?.trim() || null, before: { status: m.status }, after: { status: row.status, permissions }, visibleToSeller: true },
      by,
    );
    return map.member(row);
  }

  async removeMember(sellerId: string, memberId: string, reason: string | null | undefined, by: By): Promise<SellerMember> {
    const seller = await this.core.seller(sellerId);
    const m = await this.memberOf(sellerId, memberId);
    if (m.is_owner) throw new AppError('LAST_OWNER', 'The owner cannot be removed or suspended');
    const status = this.core.step(sellerMemberMachine, m.status, 'remove');
    const row = await this.repo.update('members', m.id, { status, removed_at: this.now() });
    if (m.account_id) await this.ctx.use('identity').revokeSellerContext(m.account_id, sellerId, reason?.trim() || 'removed_by_owner');
    this.core.publish('sellers.member.removed', { sellerId, memberId: m.id, accountId: m.account_id }, by);
    await this.core.audit({ action: 'sellers.member.remove', actionLabel: 'Removed a staff member', category: 'access', target: this.target(seller, row), reason: reason ?? null, visibleToSeller: true }, by);
    return map.member(row);
  }

  private target(seller: SellerRec, m: MemberRec) {
    return { type: 'seller_member', id: m.id, label: `${seller.store_name} · ${m.name}`, sellerId: seller.id, screen: 'seller/staff' };
  }

  /* ---------------------------------------------------------------- owner */

  /** The owner membership, created when the application is approved */
  async createOwner(tx: SellersRepository, seller: SellerRec, owner: { accountId: string; name: string; email: string }): Promise<MemberRec> {
    const existing = await tx.findOne('members', { seller_id: seller.id, is_owner: true, status: 'active' });
    if (existing) return existing;
    const now = this.now();
    return tx.insert('members', {
      id: newId(),
      seller_id: seller.id,
      account_id: owner.accountId,
      name: owner.name,
      email: owner.email.trim().toLowerCase(),
      role: 'owner',
      permissions: [] as never,
      is_owner: true,
      status: 'active',
      invitation_id: null,
      invited_by: null,
      invited_at: null,
      invite_expires_at: null,
      joined_at: now,
      last_active_at: null,
      removed_at: null,
    });
  }

  async grant(seller: SellerRec, m: MemberRec) {
    if (!m.account_id) return;
    await this.ctx.use('identity').grantSellerContext({
      accountId: m.account_id,
      sellerId: seller.id,
      memberId: m.id,
      sellerName: seller.store_name,
      roleLabel: ROLE_TEXT[(m.role as keyof typeof ROLE_TEXT) ?? 'custom']?.label ?? m.role,
      isOwner: m.is_owner,
    });
  }

  async ownerOf(sellerId: string): Promise<MemberRec | undefined> {
    return (
      (await this.repo.findOne('members', { seller_id: sellerId, is_owner: true, status: 'active' })) ??
      (await this.repo.findOne('members', { seller_id: sellerId, is_owner: true }, { orderBy: [['joined_at', 'desc']] }))
    );
  }

  /* ---------------------------------------------------------------- events and jobs */

  /** identity.invitation.accepted: activate the invited member and grant the seller context */
  async onInvitationAccepted(e: EventPayload<'identity.invitation.accepted'>) {
    if (e.purpose !== 'seller_member') return;
    const m = await this.repo.findOne('members', { invitation_id: e.invitationId });
    if (!m) {
      this.ctx.log.info({ invitationId: e.invitationId }, 'sellers: accepted invitation has no member (ignored)');
      return;
    }
    const seller = await this.repo.get('sellers', m.seller_id);
    if (!seller) return;
    if (m.status === 'active' && m.account_id === e.accountId) return this.grant(seller, m); // same event again
    if (m.status !== 'invited') {
      this.ctx.log.info({ memberId: m.id, status: m.status }, 'sellers: invitation accepted after it was revoked or expired (ignored)');
      return;
    }
    const row = await this.repo.update('members', m.id, { status: this.core.step(sellerMemberMachine, m.status, 'accept'), account_id: e.accountId, joined_at: this.now() });
    await this.grant(seller, row);
    this.core.publish('sellers.member.joined', { sellerId: seller.id, memberId: row.id, accountId: e.accountId });
    await this.core.timeline(this.repo, seller.id, { kind: 'member_joined', title: `${row.name} joined the account`, visibility: 'seller' });
  }

  /** identity.account.closed: end the account's memberships; an owner leaving raises seller_owner_missing for the Seller Manager */
  async onAccountClosed(e: EventPayload<'identity.account.closed'>) {
    if (!isUuid(e.accountId)) return;
    const rows = await this.repo.find('members', { account_id: e.accountId, status: OPEN });
    for (const m of rows) {
      await this.repo.update('members', m.id, { status: m.status === 'invited' ? 'revoked' : 'removed', removed_at: this.now() });
      this.core.publish('sellers.member.removed', { sellerId: m.seller_id, memberId: m.id, accountId: m.account_id });
      if (m.is_owner) {
        const seller = await this.repo.get('sellers', m.seller_id);
        await this.core.timeline(this.repo, m.seller_id, { kind: 'owner_account_closed', title: 'The owner’s Marketly account was closed', visibility: 'staff' });
        await this.core.raise({
          queueKey: 'sellers.accounts',
          kind: 'seller_owner_missing',
          title: `Owner account closed: ${seller?.store_name ?? m.seller_id}`,
          summary: 'The seller has no active owner. Contact the business about an ownership change or closure.',
          subject: { type: 'seller', id: m.seller_id, ref: seller?.ref ?? null, label: seller?.store_name ?? null },
          sellerId: m.seller_id,
          sellerName: seller?.store_name ?? null,
          priority: 'high',
          dedupeKey: ownerMissingKey(m.seller_id),
        });
      }
    }
  }

  /** Part of sellers.expire-invitations: member invitations past their expiry */
  async expireInvitations(now: Date) {
    const rows = await this.repo.find('members', { status: 'invited', invite_expires_at: { op: '<', value: now } }, { limit: 500 });
    for (const m of rows) await this.repo.update('members', m.id, { status: this.core.step(sellerMemberMachine, m.status, 'expire') });
    return rows.length;
  }

  /** Close: nobody new can be invited; members keep access to settle open obligations */
  async closeOut(_sellerId: string) {
    const rows = await this.repo.find('members', { seller_id: _sellerId, status: 'invited' });
    for (const m of rows) await this.repo.update('members', m.id, { status: 'revoked' });
  }
}
