import { AppError, isNotImplemented } from '../../kernel/errors/index.js';
import { dateInZone } from '../../kernel/lib/clock.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { newId } from '../../kernel/lib/ids.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { toPageRequest } from '../../kernel/lib/pagination.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { NotificationsPublicApi, Recipient, NotifyInput, Notice, InboxSummary, StaffInboxSummary } from '../../spec/notifications.js';
import { Admin } from './app/admin.js';
import { Consumers } from './app/consumers.js';
import { Core } from './app/core.js';
import { Inbox, type Reader } from './app/inbox.js';
import { LiveHub } from './app/live.js';
import { Preferences } from './app/preferences.js';
import { Sender, type Target } from './app/sender.js';
import { Webhooks } from './app/webhooks.js';
import { topicDef } from './domain/catalog.js';
import { effectiveGroups, hashAddress } from './domain/rules.js';
import type { Providers, ScheduledRow } from './ports.js';
import type { NotificationsRepository } from './repository.js';

export interface NotificationsServiceDeps {
  repo: NotificationsRepository;
  ctx: ModuleContext<'notifications'>;
  providers: Providers;
}

/** Recipient (public API) → sending target */
function targetOf(r: Recipient, topic: string): Target {
  switch (r.kind) {
    case 'customer':
      // the customers-module id is preferred (account and email resolved through customers.getCustomer); accountId only when no customerId is known
      if (r.customerId) return { kind: 'customer', customerId: r.customerId };
      if (!r.accountId) throw new AppError('VALIDATION_FAILED', 'Customer recipients need customerId or accountId', { issues: [{ path: 'recipients.customerId', message: 'required for customer' }] });
      return { kind: 'customer', accountId: r.accountId };
    case 'guest_email':
      if (!r.email) throw new AppError('VALIDATION_FAILED', 'Guest recipients need email', { issues: [{ path: 'recipients.email', message: 'required for guest_email' }] });
      return { kind: 'guest', email: r.email };
    case 'seller':
      if (!r.sellerId) throw new AppError('VALIDATION_FAILED', 'Seller recipients need sellerId', { issues: [{ path: 'recipients.sellerId', message: 'required for seller' }] });
      return { kind: 'seller', sellerId: r.sellerId };
    case 'seller_member':
      if (!r.sellerId || !(r.memberId || r.accountId)) throw new AppError('VALIDATION_FAILED', 'Seller member recipients need sellerId and memberId or accountId', { issues: [{ path: 'recipients.memberId', message: 'required for seller_member' }] });
      return { kind: 'seller', sellerId: r.sellerId, memberId: r.memberId ?? null, accountId: r.accountId ?? null };
    case 'staff_role':
      if (!r.roleKey) throw new AppError('VALIDATION_FAILED', 'Staff role recipients need roleKey', { issues: [{ path: 'recipients.roleKey', message: 'required for staff_role' }] });
      return { kind: 'role', roleKey: r.roleKey };
    case 'staff_member':
      if (!r.accountId) throw new AppError('VALIDATION_FAILED', 'Staff recipients need accountId', { issues: [{ path: 'recipients.accountId', message: 'required for staff_member' }] });
      return { kind: 'staff', accountId: r.accountId, reason: topic === 'staff.mention' ? 'mention' : 'direct' };
    case 'external_email':
      if (!r.email) throw new AppError('VALIDATION_FAILED', 'External recipients need email', { issues: [{ path: 'recipients.email', message: 'required for external_email' }] });
      if (topicDef(topic)?.category !== 'essential') throw new AppError('VALIDATION_FAILED', 'External recipients only receive essential topics', { issues: [{ path: 'recipients.kind', message: `${topic} is not an essential topic` }] });
      return { kind: 'external', email: r.email };
  }
}

/**
 * Notifications use cases. Depends only on its repository, the providers, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/notifications.json.
 * The work is done by the collaborators in app/: sender (routing to people, deliveries, retries,
 * suppressions), inbox, preferences, admin (topics, templates, delivery log, broadcasts), consumers
 * (the event routing table) and webhooks.
 */
export class NotificationsService implements NotificationsPublicApi {
  readonly core: Core;
  readonly sender: Sender;
  readonly inbox: Inbox;
  readonly prefs: Preferences;
  readonly admin: Admin;
  readonly consumers: Consumers;
  readonly webhooks: Webhooks;
  /** Open live inbox streams; the sender pushes each saved notice to them */
  readonly live: LiveHub;

  constructor(protected readonly deps: NotificationsServiceDeps) {
    this.core = new Core(deps);
    this.inbox = new Inbox(this.core);
    this.live = new LiveHub({ core: this.core, inbox: this.inbox });
    this.sender = new Sender(this.core, this.live);
    this.prefs = new Preferences(this.core, this.inbox);
    this.admin = new Admin(this.core, this.sender);
    this.consumers = new Consumers(this.core, this.sender, (input, sendAt, by, claimKey) => this.#schedule(input, sendAt, by, claimKey));
    this.webhooks = new Webhooks(this.core, this.sender);
  }

  /** Seeds the topic catalogue and default templates (called at boot; also done lazily on first use) */
  seed(): Promise<void> {
    return this.core.ensureSeeded();
  }

  /* ---------------------------------------------------------------- public API (in-process) */

  /** Send a topic to recipients now (for cases not covered by the event routing rules, e.g. mentions, test notices, guest order links). Essential topics ignore promotional consent; promotional topics check it. */
  async notify(input: NotifyInput): Promise<{ noticeIds: string[]; deliveryIds: string[] }> {
    if (!topicDef(input.topic)) throw new AppError('VALIDATION_FAILED', `Unknown notification topic ${input.topic}`, { issues: [{ path: 'topic', message: 'not in the topic catalogue' }] });
    return this.sender.send({
      topic: input.topic,
      targets: input.recipients.map((r) => targetOf(r, input.topic)),
      link: input.link,
      context: (input.context && typeof input.context === 'object' ? input.context : {}) as Record<string, unknown>,
      dedupeKey: input.dedupeKey ?? null,
      actionRequired: input.actionRequired ?? null,
      deadline: input.deadline ?? null,
      sellerId: input.sellerId ?? null,
    });
  }

  /** Send later (deadline reminders). Requires a dedupeKey so it can be cancelled. */
  async schedule(input: NotifyInput, sendAt: string): Promise<string> {
    return (await this.#schedule(input, sendAt, 'api'))!;
  }

  /** With a claim key (event consumers), the reminder is scheduled once per consumed event */
  async #schedule(input: NotifyInput, sendAt: string, createdBy: string, claimKey?: string | null): Promise<string | null> {
    if (!input.dedupeKey) throw new AppError('VALIDATION_FAILED', 'Scheduled notices need a dedupeKey so they can be cancelled', { issues: [{ path: 'dedupeKey', message: 'required' }] });
    if (!topicDef(input.topic)) throw new AppError('VALIDATION_FAILED', `Unknown notification topic ${input.topic}`, { issues: [{ path: 'topic', message: 'not in the topic catalogue' }] });
    const at = new Date(sendAt);
    if (Number.isNaN(at.getTime())) throw new AppError('VALIDATION_FAILED', 'sendAt is not a date', { issues: [{ path: 'sendAt', message: 'invalid date' }] });
    input.recipients.forEach((r) => targetOf(r, input.topic));
    const id = newId();
    const row: ScheduledRow = { id, dedupe_key: input.dedupeKey, send_at: at, input: input as never, status: 'pending', created_by_module: createdBy, created_at: this.core.now() };
    if (!claimKey) {
      await this.core.repo.insertScheduled(row);
      return id;
    }
    return this.core.repo.transaction(async (tx) => {
      if (!(await tx.claim(claimKey))) return null;
      await tx.insertScheduled(row);
      return id;
    });
  }

  /** Cancel scheduled notices (e.g. order dispatched before the reminder) */
  async cancelScheduled(dedupeKey: string): Promise<number> {
    return this.core.repo.cancelScheduled(dedupeKey);
  }

  /** Mark action-required notices as done for every recipient (the queue item was handled), so inboxes stop showing them as needing action */
  async resolve(dedupeKey: string, note?: string): Promise<number> {
    return this.core.repo.resolveNotices(dedupeKey, note ?? null, this.core.now());
  }

  /** Consent, suppression and account status check before any promotional send */
  async canSendPromotional(recipient: Recipient, channel: 'email' | 'sms' | 'push'): Promise<boolean> {
    const core = this.core;
    if (recipient.kind === 'customer' && (recipient.customerId || recipient.accountId)) {
      const c = recipient.customerId ? await core.customer(recipient.customerId) : await core.customerByAccount(recipient.accountId!);
      if (!c || c.accountStatus === 'closed' || c.accountStatus === 'suspended') return false;
      const consent = await core.consent(c.id);
      if (!consent) return false;
      if (channel === 'email') return consent.emailPromotions && !(await core.repo.activeSuppression('email', hashAddress('email', c.email)));
      if (channel === 'sms') return Boolean(consent.smsPromotions && consent.smsNumber && !(await core.repo.activeSuppression('sms', hashAddress('sms', consent.smsNumber))));
      return consent.pushPromotions && (await core.repo.pushDevices({ accountIds: [c.userId], audience: 'customer', activeOnly: true })).length > 0;
    }
    if ((recipient.kind === 'seller_member' || recipient.kind === 'seller') && recipient.sellerId) {
      const rows = await core.sellerMembers(recipient.sellerId);
      const row = rows.find((r) => (recipient.memberId && r.member_id === recipient.memberId) || (recipient.accountId && r.account_id === recipient.accountId));
      if (!row) return false;
      const access = await core.memberAccess(recipient.sellerId, row.account_id);
      if (!access && core.sellers) return false;
      if (!effectiveGroups(row.groups as Record<string, unknown>, access?.isOwner ?? false).promotions) return false;
      if (channel === 'email') {
        const acct = await core.account(row.account_id);
        return Boolean(acct?.email && acct.status !== 'closed' && !(await core.repo.activeSuppression('email', hashAddress('email', acct.email))));
      }
      if (channel === 'push') return (await core.repo.pushDevices({ accountIds: [row.account_id], audience: 'seller', sellerId: recipient.sellerId, activeOnly: true })).length > 0;
      return false;
    }
    return false;
  }

  /** Tokens in promotional footers are signed here; customers' public unsubscribe endpoint verifies them */
  async verifyUnsubscribeToken(token: string): Promise<{ audience: 'customer' | 'seller'; accountId: string | null; email: string; channel: 'email' | 'sms' | 'push'; topicGroup: string } | null> {
    const p = this.core.verify<{ k?: string; aud?: string; a?: string | null; e?: string; c?: string; g?: string }>(token);
    if (!p || p.k !== 'u' || (p.aud !== 'customer' && p.aud !== 'seller') || !p.e || (p.c !== 'email' && p.c !== 'sms' && p.c !== 'push')) return null;
    return { audience: p.aud, accountId: p.a ?? null, email: p.e, channel: p.c, topicGroup: p.g ?? 'promotions' };
  }

  /** Badge count for navigation responses of other modules */
  async unreadCount(principal: identity.Principal): Promise<number> {
    return this.inbox.unreadCount({ principal });
  }

  /** The caller's own inbox, newest first: customer (store), seller member within the current seller (Seller Center), staff member including notices received as backup (Admin Center). Same rules as GET /inbox in each area. */
  async listInbox(principal: identity.Principal, filter: { group?: string; unreadOnly?: boolean; actionRequired?: boolean; category?: 'essential' | 'optional' | 'promotional'; view?: 'all' | 'needs_my_action' | 'mentions' }, page: common.PageInput): Promise<common.Page<Notice>> {
    return this.inbox.list({ principal }, filter ?? {}, toPageRequest(page));
  }

  /** Unread per group, open action notices (max 10, by deadline) and, for staff, needs-my-action, mentions and routing today. Same data as GET /inbox/summary in each area. */
  async inboxSummary(principal: identity.Principal): Promise<InboxSummary & Partial<StaffInboxSummary>> {
    return this.inbox.summary({ principal });
  }

  /* ---------------------------------------------------------------- HTTP-facing reads (with the request's seller access) */

  listInboxFor(reader: Reader, filter: Parameters<Inbox['list']>[1], page: PageRequest) {
    return this.inbox.list(reader, filter, page);
  }

  /* ---------------------------------------------------------------- events consumed */

  /** identity.verification.code_issued: Email (or text, phase 2) the code: registration, email change, phone, 2-step. 'You already have an account' email when existingAccount. Code never stored in the delivery log. */
  async onVerificationCodeIssuedFromIdentity(event: EventPayload<'identity.verification.code_issued'>, eventId?: string): Promise<void> {
    await this.consumers.handle('identity.verification.code_issued', event, eventId);
  }

  /** identity.password_reset.requested: Email the reset link (customer.account.password_reset / staff variant) */
  async onPasswordResetRequestedFromIdentity(event: EventPayload<'identity.password_reset.requested'>, eventId?: string): Promise<void> {
    await this.consumers.handle('identity.password_reset.requested', event, eventId);
  }

  /** identity.password.changed: Security alert: password changed (email + in-app, account group) */
  async onPasswordChangedFromIdentity(event: EventPayload<'identity.password.changed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('identity.password.changed', event, eventId);
  }

  /** identity.session.new_device: Security alert: new sign-in on a device */
  async onSessionNewDeviceFromIdentity(event: EventPayload<'identity.session.new_device'>, eventId?: string): Promise<void> {
    await this.consumers.handle('identity.session.new_device', event, eventId);
  }

  /** identity.email.changed: Alert to the old and new address */
  async onEmailChangedFromIdentity(event: EventPayload<'identity.email.changed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('identity.email.changed', event, eventId);
  }

  /** identity.two_step.changed: Security alert: 2-step verification turned on/off or reset */
  async onTwoStepChangedFromIdentity(event: EventPayload<'identity.two_step.changed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('identity.two_step.changed', event, eventId);
  }

  /** identity.account.locked: Alert the account owner; staff accounts also notify the Platform Administrator role */
  async onAccountLockedFromIdentity(event: EventPayload<'identity.account.locked'>, eventId?: string): Promise<void> {
    await this.consumers.handle('identity.account.locked', event, eventId);
  }

  /** identity.invitation.created: Email the staff or seller-member invitation link */
  async onInvitationCreatedFromIdentity(event: EventPayload<'identity.invitation.created'>, eventId?: string): Promise<void> {
    await this.consumers.handle('identity.invitation.created', event, eventId);
  }

  /** identity.user.verified: Welcome notice in the new customer's inbox */
  async onUserVerifiedFromIdentity(event: EventPayload<'identity.user.verified'>, eventId?: string): Promise<void> {
    await this.consumers.handle('identity.user.verified', event, eventId);
  }

  /** customers.marketing_preferences.changed: Refresh the consent cache used for promotional sends and broadcasts */
  async onMarketingPreferencesChangedFromCustomers(event: EventPayload<'customers.marketing_preferences.changed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('customers.marketing_preferences.changed', event, eventId);
  }

  /** customers.account.closed: Stop all promotional sends, remove push devices, keep essential notices for open obligations only */
  async onAccountClosedFromCustomers(event: EventPayload<'customers.account.closed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('customers.account.closed', event, eventId);
  }

  /** customers.data_export.ready: Email the customer the export download link */
  async onDataExportReadyFromCustomers(event: EventPayload<'customers.data_export.ready'>, eventId?: string): Promise<void> {
    await this.consumers.handle('customers.data_export.ready', event, eventId);
  }

  /** orders.order.accepted: Customer: order accepted (confirmation only after acceptance). Seller: new order and dispatch reminder per seller-fulfilled group (none for Fulfilled by Marketly groups) */
  async onOrderAcceptedFromOrders(event: EventPayload<'orders.order.accepted'>, eventId?: string): Promise<void> {
    await this.consumers.handle('orders.order.accepted', event, eventId);
  }

  /** orders.cancellation.requested: Seller (seller-fulfilled groups, action required until respondBy); Official Store and Fulfilled by Marketly groups: the Order Manager */
  async onCancellationRequestedFromOrders(event: EventPayload<'orders.cancellation.requested'>, eventId?: string): Promise<void> {
    await this.consumers.handle('orders.cancellation.requested', event, eventId);
  }

  /** orders.item.cancelled: Customer: cancellation update for the item; seller: item cancelled */
  async onItemCancelledFromOrders(event: EventPayload<'orders.item.cancelled'>, eventId?: string): Promise<void> {
    await this.consumers.handle('orders.item.cancelled', event, eventId);
  }

  /** orders.item.delayed: Customer: delay notice with the new estimate and options (wait, cancel, contact support) */
  async onItemDelayedFromOrders(event: EventPayload<'orders.item.delayed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('orders.item.delayed', event, eventId);
  }

  /** orders.cancellation.decided: Customer: result of a cancellation request */
  async onCancellationDecidedFromOrders(event: EventPayload<'orders.cancellation.decided'>, eventId?: string): Promise<void> {
    await this.consumers.handle('orders.cancellation.decided', event, eventId);
  }

  /** payments.payment.captured: Customer: payment accepted (combined with order accepted when simultaneous) */
  async onPaymentCapturedFromPayments(event: EventPayload<'payments.payment.captured'>, eventId?: string): Promise<void> {
    await this.consumers.handle('payments.payment.captured', event, eventId);
  }

  /** payments.payment.failed: Customer: payment failed, retry link */
  async onPaymentFailedFromPayments(event: EventPayload<'payments.payment.failed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('payments.payment.failed', event, eventId);
  }

  /** payments.payment.pending_check: Customer: payment result is being checked; link to order status */
  async onPaymentPendingCheckFromPayments(event: EventPayload<'payments.payment.pending_check'>, eventId?: string): Promise<void> {
    await this.consumers.handle('payments.payment.pending_check', event, eventId);
  }

  /** payments.refund.sent: Customer: refund sent, with destination and expected timing */
  async onRefundSentFromPayments(event: EventPayload<'payments.refund.sent'>, eventId?: string): Promise<void> {
    await this.consumers.handle('payments.refund.sent', event, eventId);
  }

  /** payments.refund.failed: Customer: refund problem and next steps; staff: Finance Manager notice */
  async onRefundFailedFromPayments(event: EventPayload<'payments.refund.failed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('payments.refund.failed', event, eventId);
  }

  /** payments.chargeback.opened: Staff: unusual financial activity notice to Finance Manager; seller: dispute opened on an order */
  async onChargebackOpenedFromPayments(event: EventPayload<'payments.chargeback.opened'>, eventId?: string): Promise<void> {
    await this.consumers.handle('payments.chargeback.opened', event, eventId);
  }

  /** shipping.shipment.dispatched: Customer: package dispatched with contents, carrier and tracking; cancels the seller dispatch reminder */
  async onShipmentDispatchedFromShipping(event: EventPayload<'shipping.shipment.dispatched'>, eventId?: string): Promise<void> {
    await this.consumers.handle('shipping.shipment.dispatched', event, eventId);
  }

  /** shipping.shipment.delivered: Customer: package delivered */
  async onShipmentDeliveredFromShipping(event: EventPayload<'shipping.shipment.delivered'>, eventId?: string): Promise<void> {
    await this.consumers.handle('shipping.shipment.delivered', event, eventId);
  }

  /** shipping.shipment.exception: Customer: delivery problem with next steps; staff: Shipping Manager */
  async onShipmentExceptionFromShipping(event: EventPayload<'shipping.shipment.exception'>, eventId?: string): Promise<void> {
    await this.consumers.handle('shipping.shipment.exception', event, eventId);
  }

  /** shipping.dispatch.overdue: Seller: dispatch overdue (action required); staff: overdue shipping to Shipping Manager (lead or backup) */
  async onDispatchOverdueFromShipping(event: EventPayload<'shipping.dispatch.overdue'>, eventId?: string): Promise<void> {
    await this.consumers.handle('shipping.dispatch.overdue', event, eventId);
  }

  /** returns.return.requested: Seller: new return request with response deadline */
  async onReturnRequestedFromReturns(event: EventPayload<'returns.return.requested'>, eventId?: string): Promise<void> {
    await this.consumers.handle('returns.return.requested', event, eventId);
  }

  /** returns.return.info_requested: Customer: more information needed for the return */
  async onReturnInfoRequestedFromReturns(event: EventPayload<'returns.return.info_requested'>, eventId?: string): Promise<void> {
    await this.consumers.handle('returns.return.info_requested', event, eventId);
  }

  /** returns.return.approved: Customer: return approved with label or drop-off instructions */
  async onReturnApprovedFromReturns(event: EventPayload<'returns.return.approved'>, eventId?: string): Promise<void> {
    await this.consumers.handle('returns.return.approved', event, eventId);
  }

  /** returns.return.rejected: Customer: return declined with the reason and how to ask for help */
  async onReturnRejectedFromReturns(event: EventPayload<'returns.return.rejected'>, eventId?: string): Promise<void> {
    await this.consumers.handle('returns.return.rejected', event, eventId);
  }

  /** returns.label.created: Customer: return label ready; schedules a drop-off reminder */
  async onLabelCreatedFromReturns(event: EventPayload<'returns.label.created'>, eventId?: string): Promise<void> {
    await this.consumers.handle('returns.label.created', event, eventId);
  }

  /** returns.return.received: Customer: return received; seller: inspect by deadline */
  async onReturnReceivedFromReturns(event: EventPayload<'returns.return.received'>, eventId?: string): Promise<void> {
    await this.consumers.handle('returns.return.received', event, eventId);
  }

  /** returns.return.inspected: Customer: inspection outcome */
  async onReturnInspectedFromReturns(event: EventPayload<'returns.return.inspected'>, eventId?: string): Promise<void> {
    await this.consumers.handle('returns.return.inspected', event, eventId);
  }

  /** returns.return.escalated: Staff: Returns Manager; seller: platform support stepped in */
  async onReturnEscalatedFromReturns(event: EventPayload<'returns.return.escalated'>, eventId?: string): Promise<void> {
    await this.consumers.handle('returns.return.escalated', event, eventId);
  }

  /** returns.refund.approved: Customer: refund approved and processing (never says the money has arrived) */
  async onRefundApprovedFromReturns(event: EventPayload<'returns.refund.approved'>, eventId?: string): Promise<void> {
    await this.consumers.handle('returns.refund.approved', event, eventId);
  }

  /** returns.replacement.created: Customer: replacement on its way (its own shipment) */
  async onReplacementCreatedFromReturns(event: EventPayload<'returns.replacement.created'>, eventId?: string): Promise<void> {
    await this.consumers.handle('returns.replacement.created', event, eventId);
  }

  /** support.case.opened: Customer: acknowledgment with expected reply time; seller: case opened on an order */
  async onCaseOpenedFromSupport(event: EventPayload<'support.case.opened'>, eventId?: string): Promise<void> {
    await this.consumers.handle('support.case.opened', event, eventId);
  }

  /** support.case.message_added: Customer or seller: case reply (email carries a reply-to token) */
  async onCaseMessageAddedFromSupport(event: EventPayload<'support.case.message_added'>, eventId?: string): Promise<void> {
    await this.consumers.handle('support.case.message_added', event, eventId);
  }

  /** support.case.escalated: Staff: escalated case to Customer Support Manager (or Returns Manager by category) */
  async onCaseEscalatedFromSupport(event: EventPayload<'support.case.escalated'>, eventId?: string): Promise<void> {
    await this.consumers.handle('support.case.escalated', event, eventId);
  }

  /** support.case.overdue: Staff: case past its response target to the queue lead and backup */
  async onCaseOverdueFromSupport(event: EventPayload<'support.case.overdue'>, eventId?: string): Promise<void> {
    await this.consumers.handle('support.case.overdue', event, eventId);
  }

  /** support.case.decided: Customer and seller: decision and remedy, with the appeal deadline */
  async onCaseDecidedFromSupport(event: EventPayload<'support.case.decided'>, eventId?: string): Promise<void> {
    await this.consumers.handle('support.case.decided', event, eventId);
  }

  /** support.case.resolved: Customer: case resolved */
  async onCaseResolvedFromSupport(event: EventPayload<'support.case.resolved'>, eventId?: string): Promise<void> {
    await this.consumers.handle('support.case.resolved', event, eventId);
  }

  /** messaging.message.sent: Recipient (customer or seller members with customer permission): new message, reply-to token in email */
  async onMessageSentFromMessaging(event: EventPayload<'messaging.message.sent'>, eventId?: string): Promise<void> {
    await this.consumers.handle('messaging.message.sent', event, eventId);
  }

  /** sellers.application.submitted: Staff: new application to Seller Manager */
  async onApplicationSubmittedFromSellers(event: EventPayload<'sellers.application.submitted'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.application.submitted', event, eventId);
  }

  /** sellers.application.information_requested: Applicant: information required, with deadline */
  async onApplicationInformationRequestedFromSellers(event: EventPayload<'sellers.application.information_requested'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.application.information_requested', event, eventId);
  }

  /** sellers.application.decided: Applicant: application result (approved with next steps, or reasons) */
  async onApplicationDecidedFromSellers(event: EventPayload<'sellers.application.decided'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.application.decided', event, eventId);
  }

  /** sellers.seller.restricted: Seller owner: restriction with reason, affected activity and appeal route */
  async onSellerRestrictedFromSellers(event: EventPayload<'sellers.seller.restricted'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.seller.restricted', event, eventId);
  }

  /** sellers.seller.suspended: Seller owner: suspension with reason, what stays open and appeal route */
  async onSellerSuspendedFromSellers(event: EventPayload<'sellers.seller.suspended'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.seller.suspended', event, eventId);
  }

  /** sellers.seller.reinstated: Seller owner: account reinstated */
  async onSellerReinstatedFromSellers(event: EventPayload<'sellers.seller.reinstated'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.seller.reinstated', event, eventId);
  }

  /** sellers.warning.issued: Seller owner: performance or policy warning */
  async onWarningIssuedFromSellers(event: EventPayload<'sellers.warning.issued'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.warning.issued', event, eventId);
  }

  /** sellers.appeal.decided: Seller owner: appeal result */
  async onAppealDecidedFromSellers(event: EventPayload<'sellers.appeal.decided'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.appeal.decided', event, eventId);
  }

  /** sellers.payout_account.changed: Seller owner: security notice that the payout destination changed (always email) */
  async onPayoutAccountChangedFromSellers(event: EventPayload<'sellers.payout_account.changed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.payout_account.changed', event, eventId);
  }

  /** sellers.change_request.decided: Seller owner (essential, account_finance group, topic seller.change_request.decided): the requested change was approved or rejected, with the reason and any impact on selling or payouts */
  async onChangeRequestDecidedFromSellers(event: EventPayload<'sellers.change_request.decided'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.change_request.decided', event, eventId);
  }

  /** sellers.verification.changed: Seller owner (essential, topic seller.verification.changed): the Verified seller label was granted, lapsed or revoked */
  async onVerificationChangedFromSellers(event: EventPayload<'sellers.verification.changed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.verification.changed', event, eventId);
  }

  /** sellers.launch_review.decided: Seller owner (essential, topic seller.launch_review.decided): launch review passed or needs changes */
  async onLaunchReviewDecidedFromSellers(event: EventPayload<'sellers.launch_review.decided'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.launch_review.decided', event, eventId);
  }

  /** sellers.invitation.sent: Email the invited business its invitation code and how to apply (code never stored in the delivery log) */
  async onInvitationSentFromSellers(event: EventPayload<'sellers.invitation.sent'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.invitation.sent', event, eventId);
  }

  /** finance.destination.verified: Seller owner (essential, owner-only, always email, topic seller.payout_destination.verified) */
  async onDestinationVerifiedFromFinance(event: EventPayload<'finance.destination.verified'>, eventId?: string): Promise<void> {
    await this.consumers.handle('finance.destination.verified', event, eventId);
  }

  /** finance.destination.rejected: Seller owner (essential, owner-only, always email, topic seller.payout_destination.rejected) */
  async onDestinationRejectedFromFinance(event: EventPayload<'finance.destination.rejected'>, eventId?: string): Promise<void> {
    await this.consumers.handle('finance.destination.rejected', event, eventId);
  }

  /** catalog.product.changes_requested: Seller: requested corrections with field comments and resubmit deadline */
  async onProductChangesRequestedFromCatalog(event: EventPayload<'catalog.product.changes_requested'>, eventId?: string): Promise<void> {
    await this.consumers.handle('catalog.product.changes_requested', event, eventId);
  }

  /** catalog.product.approved: Seller: product approved */
  async onProductApprovedFromCatalog(event: EventPayload<'catalog.product.approved'>, eventId?: string): Promise<void> {
    await this.consumers.handle('catalog.product.approved', event, eventId);
  }

  /** catalog.product.rejected: Seller: product rejected with reason */
  async onProductRejectedFromCatalog(event: EventPayload<'catalog.product.rejected'>, eventId?: string): Promise<void> {
    await this.consumers.handle('catalog.product.rejected', event, eventId);
  }

  /** catalog.images.recrop_needed: Seller: product images to re-crop after the product image aspect ratio changed */
  async onImagesRecropNeededFromCatalog(event: EventPayload<'catalog.images.recrop_needed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('catalog.images.recrop_needed', event, eventId);
  }

  /** inventory.stock.low: Seller: low stock (own offers); staff: stock shortage to Inventory Manager for the Official Store */
  async onStockLowFromInventory(event: EventPayload<'inventory.stock.low'>, eventId?: string): Promise<void> {
    await this.consumers.handle('inventory.stock.low', event, eventId);
  }

  /** finance.payout.paid: Seller owner: payout paid (after bank confirmation) */
  async onPayoutPaidFromFinance(event: EventPayload<'finance.payout.paid'>, eventId?: string): Promise<void> {
    await this.consumers.handle('finance.payout.paid', event, eventId);
  }

  /** finance.payout.failed: Seller owner: payout failed and what to fix; staff: failed payout to Finance Manager */
  async onPayoutFailedFromFinance(event: EventPayload<'finance.payout.failed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('finance.payout.failed', event, eventId);
  }

  /** finance.hold.placed: Seller owner: hold with amount, reason and review date */
  async onHoldPlacedFromFinance(event: EventPayload<'finance.hold.placed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('finance.hold.placed', event, eventId);
  }

  /** finance.hold.released: Seller owner: hold released */
  async onHoldReleasedFromFinance(event: EventPayload<'finance.hold.released'>, eventId?: string): Promise<void> {
    await this.consumers.handle('finance.hold.released', event, eventId);
  }

  /** finance.balance.negative: Seller owner: amount owed; staff: Finance Manager */
  async onBalanceNegativeFromFinance(event: EventPayload<'finance.balance.negative'>, eventId?: string): Promise<void> {
    await this.consumers.handle('finance.balance.negative', event, eventId);
  }

  /** finance.statement.issued: Seller owner: statement available */
  async onStatementIssuedFromFinance(event: EventPayload<'finance.statement.issued'>, eventId?: string): Promise<void> {
    await this.consumers.handle('finance.statement.issued', event, eventId);
  }

  /** finance.reconciliation.mismatch_found: Staff: unusual financial activity to Finance Manager */
  async onReconciliationMismatchFoundFromFinance(event: EventPayload<'finance.reconciliation.mismatch_found'>, eventId?: string): Promise<void> {
    await this.consumers.handle('finance.reconciliation.mismatch_found', event, eventId);
  }

  /** promotions.participation.invited: Seller: invitation to join a campaign with expected earnings impact */
  async onParticipationInvitedFromPromotions(event: EventPayload<'promotions.participation.invited'>, eventId?: string): Promise<void> {
    await this.consumers.handle('promotions.participation.invited', event, eventId);
  }

  /** advertising.campaign.status_changed: Seller: sponsored campaign approved, rejected, live, paused or finished; staff: waiting approvals to Advertising/Content roles */
  async onCampaignStatusChangedFromAdvertising(event: EventPayload<'advertising.campaign.status_changed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('advertising.campaign.status_changed', event, eventId);
  }

  /** reviews.invite.due: Customer: review invitation (optional category, can be turned off) */
  async onInviteDueFromReviews(event: EventPayload<'reviews.invite.due'>, eventId?: string): Promise<void> {
    await this.consumers.handle('reviews.invite.due', event, eventId);
  }

  /** reviews.report.created: Staff: reported content to the moderation queue role */
  async onReportCreatedFromReviews(event: EventPayload<'reviews.report.created'>, eventId?: string): Promise<void> {
    await this.consumers.handle('reviews.report.created', event, eventId);
  }

  /** trust.report.created: Staff: new risk report to Trust and Risk Manager */
  async onReportCreatedFromTrust(event: EventPayload<'trust.report.created'>, eventId?: string): Promise<void> {
    await this.consumers.handle('trust.report.created', event, eventId);
  }

  /** wishlist.alert.triggered: Customer: price drop or back in stock (promotional, consent required) */
  async onAlertTriggeredFromWishlist(event: EventPayload<'wishlist.alert.triggered'>, eventId?: string): Promise<void> {
    await this.consumers.handle('wishlist.alert.triggered', event, eventId);
  }

  /** access.approval.requested: Staff: waiting approval to eligible approvers (nominated reviewer first), action required with due date */
  async onApprovalRequestedFromAccess(event: EventPayload<'access.approval.requested'>, eventId?: string): Promise<void> {
    await this.consumers.handle('access.approval.requested', event, eventId);
  }

  /** access.approval.partially_approved: Staff: second approval needed, to remaining eligible approvers */
  async onApprovalPartiallyApprovedFromAccess(event: EventPayload<'access.approval.partially_approved'>, eventId?: string): Promise<void> {
    await this.consumers.handle('access.approval.partially_approved', event, eventId);
  }

  /** access.approval.returned: Staff: request sent back to the requester with the comment */
  async onApprovalReturnedFromAccess(event: EventPayload<'access.approval.returned'>, eventId?: string): Promise<void> {
    await this.consumers.handle('access.approval.returned', event, eventId);
  }

  /** access.approval.decided: Staff: outcome to the requester; resolves the approvers' action notices */
  async onApprovalDecidedFromAccess(event: EventPayload<'access.approval.decided'>, eventId?: string): Promise<void> {
    await this.consumers.handle('access.approval.decided', event, eventId);
  }

  /** access.approval.reminder_sent: Staff: reminder to the listed reviewers */
  async onApprovalReminderSentFromAccess(event: EventPayload<'access.approval.reminder_sent'>, eventId?: string): Promise<void> {
    await this.consumers.handle('access.approval.reminder_sent', event, eventId);
  }

  /** access.coverage.changed: Re-route open staff action notices of that role to the new receivers */
  async onCoverageChangedFromAccess(event: EventPayload<'access.coverage.changed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('access.coverage.changed', event, eventId);
  }

  /** access.away.ended: Give the returning lead the notices received by the backup while away */
  async onAwayEndedFromAccess(event: EventPayload<'access.away.ended'>, eventId?: string): Promise<void> {
    await this.consumers.handle('access.away.ended', event, eventId);
  }

  /** workqueues.item.overdue: Staff: overdue work item to the queue lead and backup */
  async onItemOverdueFromWorkqueues(event: EventPayload<'workqueues.item.overdue'>, eventId?: string): Promise<void> {
    await this.consumers.handle('workqueues.item.overdue', event, eventId);
  }

  /** workqueues.item.escalated: Staff: escalated item to the next role on the escalation route */
  async onItemEscalatedFromWorkqueues(event: EventPayload<'workqueues.item.escalated'>, eventId?: string): Promise<void> {
    await this.consumers.handle('workqueues.item.escalated', event, eventId);
  }

  /** workqueues.item.resolved: Resolve the action notices for that work item */
  async onItemResolvedFromWorkqueues(event: EventPayload<'workqueues.item.resolved'>, eventId?: string): Promise<void> {
    await this.consumers.handle('workqueues.item.resolved', event, eventId);
  }

  /** settings.change.scheduled: Sellers (seller-visible changes): upcoming platform change with its effective date */
  async onChangeScheduledFromSettings(event: EventPayload<'settings.change.scheduled'>, eventId?: string): Promise<void> {
    await this.consumers.handle('settings.change.scheduled', event, eventId);
  }

  /** audit.integrity.failed: Staff: urgent notice to Platform Administrator and Business Owner */
  async onIntegrityFailedFromAudit(event: EventPayload<'audit.integrity.failed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('audit.integrity.failed', event, eventId);
  }

  /** reports.export.ready: Export ready to the requester (staff or seller member), including audit, orders and module list exports */
  async onExportReadyFromReports(event: EventPayload<'reports.export.ready'>, eventId?: string): Promise<void> {
    await this.consumers.handle('reports.export.ready', event, eventId);
  }

  async onScheduledReportReadyFromReports(event: EventPayload<'reports.scheduled_report.ready'>, eventId?: string): Promise<void> {
    await this.consumers.handle('reports.scheduled_report.ready', event, eventId);
  }

  async onPurchaseOrderSentFromPurchasing(event: EventPayload<'purchasing.purchase_order.sent'>, eventId?: string): Promise<void> {
    await this.consumers.handle('purchasing.purchase_order.sent', event, eventId);
  }

  async onCreditExpiringFromWallet(event: EventPayload<'wallet.credit.expiring'>, eventId?: string): Promise<void> {
    await this.consumers.handle('wallet.credit.expiring', event, eventId);
  }

  async onDayEndPreparedFromWorkqueues(event: EventPayload<'workqueues.day_end.prepared'>, eventId?: string): Promise<void> {
    await this.consumers.handle('workqueues.day_end.prepared', event, eventId);
  }

  /** sellers.member.invited: remember the invited member (preferences answer 409 MEMBER_NOT_JOINED until they accept) */
  async onMemberInvitedFromSellers(event: EventPayload<'sellers.member.invited'>): Promise<void> {
    await this.prefs.rememberInvited(event.sellerId, event.memberId, event.email);
  }

  /** sellers.member.joined: the invitation was accepted; the member's preferences open */
  async onMemberJoinedFromSellers(event: EventPayload<'sellers.member.joined'>): Promise<void> {
    await this.prefs.forgetInvited(event.sellerId, event.memberId);
  }

  /** sellers.member.removed: a revoked invitation is forgotten */
  async onMemberRemovedFromSellers(event: EventPayload<'sellers.member.removed'>): Promise<void> {
    await this.prefs.forgetInvited(event.sellerId, event.memberId);
  }

  /** workqueues.day_end.completed: Staff (topic staff.day_end.completed, to roleKeys): the day-end summary; resolves the staff.day_end.summary action notices */
  async onDayEndCompletedFromWorkqueues(event: EventPayload<'workqueues.day_end.completed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('workqueues.day_end.completed', event, eventId);
  }

  /** trust.evidence.requested: the asked customer or seller owner: proof needed, action required until trust resolves trust-evidence:<requestId> */
  async onEvidenceRequestedFromTrust(event: EventPayload<'trust.evidence.requested'>, eventId?: string): Promise<void> {
    await this.consumers.handle('trust.evidence.requested', event, eventId);
  }

  /** trust.appeal.decided: the appellant (customer or seller owner): the outcome and what changes */
  async onAppealDecidedFromTrust(event: EventPayload<'trust.appeal.decided'>, eventId?: string): Promise<void> {
    await this.consumers.handle('trust.appeal.decided', event, eventId);
  }

  /** payments.refund.destination_requested: Customer (or the order email): choose where to receive the refund; action required until it is sent */
  async onRefundDestinationRequestedFromPayments(event: EventPayload<'payments.refund.destination_requested'>, eventId?: string): Promise<void> {
    await this.consumers.handle('payments.refund.destination_requested', event, eventId);
  }

  /** customers.closure.delayed: Customer: the closure waits for new obligations, and when it is checked again */
  async onClosureDelayedFromCustomers(event: EventPayload<'customers.closure.delayed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('customers.closure.delayed', event, eventId);
  }

  /** offers.offer.missing_items_stale: Seller members with offers.offers.manage, or the Catalog Manager role for Official Store offers */
  async onOfferMissingItemsStaleFromOffers(event: EventPayload<'offers.offer.missing_items_stale'>, eventId?: string): Promise<void> {
    await this.consumers.handle('offers.offer.missing_items_stale', event, eventId);
  }

  /** offers.offer.missing_items_reviewed: resolves the missing-items review notice of the offer */
  async onOfferMissingItemsReviewedFromOffers(event: EventPayload<'offers.offer.missing_items_reviewed'>, eventId?: string): Promise<void> {
    await this.consumers.handle('offers.offer.missing_items_reviewed', event, eventId);
  }

  /** inventory.stock.low_digest: Official Store items to the Inventory Manager role; a seller's own items to that seller */
  async onStockLowDigestFromInventory(event: EventPayload<'inventory.stock.low_digest'>, eventId?: string): Promise<void> {
    await this.consumers.handle('inventory.stock.low_digest', event, eventId);
  }

  /** sellers.application.information_reminder: Applicant (owner): requested information still missing, with the deadline */
  async onApplicationInformationReminderFromSellers(event: EventPayload<'sellers.application.information_reminder'>, eventId?: string): Promise<void> {
    await this.consumers.handle('sellers.application.information_reminder', event, eventId);
  }

  async onCampaignEndingSoonFromAdvertising(event: EventPayload<'advertising.campaign.ending_soon'>, eventId?: string): Promise<void> {
    await this.consumers.handle('advertising.campaign.ending_soon', event, eventId);
  }

  async onArticleReviewDueFromContent(event: EventPayload<'content.article.review_due'>, eventId?: string): Promise<void> {
    await this.consumers.handle('content.article.review_due', event, eventId);
  }

  async onModerationDecidedFromReviews(event: EventPayload<'reviews.moderation.decided'>, eventId?: string): Promise<void> {
    await this.consumers.handle('reviews.moderation.decided', event, eventId);
  }

  async onReportResolvedFromTrust(event: EventPayload<'trust.report.resolved'>, eventId?: string): Promise<void> {
    await this.consumers.handle('trust.report.resolved', event, eventId);
  }

  async onRightsReportReceivedFromTrust(event: EventPayload<'trust.rights_report.received'>, eventId?: string): Promise<void> {
    await this.consumers.handle('trust.rights_report.received', event, eventId);
  }

  /* ---------------------------------------------------------------- jobs */

  /** Job notifications.dispatch (queue worker): Render and send queued deliveries per channel with provider rate limits; mark sent */
  async dispatch(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const due = await this.core.repo.dueDeliveries(['queued'], this.core.now(), 100);
      if (!due.length) return;
      for (const d of due) await this.#safe(() => this.sender.dispatch(d.id), d.id);
      if (due.length < 100) return;
    }
  }

  /** Job notifications.retry (every minute): Re-send retrying deliveries whose nextAttemptAt passed; give up after maxDeliveryAttempts (notifications.delivery.failed) */
  async retry(): Promise<void> {
    const max = Number(await this.core.setting('maxDeliveryAttempts'));
    const due = await this.core.repo.dueDeliveries(['retrying'], this.core.now(), 200);
    for (const d of due) {
      if (d.attempts >= max) await this.#safe(() => this.sender.giveUp(d), d.id);
      else await this.#safe(() => this.sender.dispatch(d.id), d.id);
    }
  }

  /** Job notifications.send-scheduled (every minute): Send scheduled notices due now (dispatch deadline reminders 4 h before, drop-off reminders, approval due reminders) */
  async sendScheduled(): Promise<void> {
    const due = await this.core.repo.dueScheduled(this.core.now(), 100);
    for (const s of due) {
      if (!(await this.core.repo.markScheduled(s.id, 'sent'))) continue; // cancelled or taken meanwhile
      await this.#safe(() => this.notify(s.input as unknown as NotifyInput), s.id);
    }
  }

  /** Job notifications.send-broadcasts (every minute): Start scheduled broadcasts, resolve consenting recipients, respect quiet hours for SMS and push, publish notifications.broadcast.sent */
  async sendBroadcasts(): Promise<void> {
    await this.admin.sendDueBroadcasts();
  }

  /** Job notifications.staff-digest (daily at the start of business hours): Email the daily digest to staff who chose it */
  async staffDigest(): Promise<void> {
    const now = this.core.now();
    const DAY = 24 * 3_600_000;
    const tz = this.core.timeZone;
    const day = dateInZone(now, tz);
    // 08:00 market time is the start of business hours: on closed days the digest waits for the next open day,
    // which then covers everything since the previous open day's digest
    const calendar = await this.#businessCalendar();
    if (calendar && !calendar.isBusinessDay(day)) return;
    let back = 1;
    while (calendar && back < 14 && !calendar.isBusinessDay(dateInZone(new Date(now.getTime() - back * DAY), tz))) back++;
    const since = new Date(now.getTime() - back * DAY);
    for (const p of await this.core.repo.digestSubscribers()) {
      const notices = (await this.core.repo.unreadSince(p.account_id, since)).filter((n) => !topicDef(n.topic_key)?.urgent);
      if (!notices.length) continue;
      await this.#safe(
        () =>
          this.sender.send({
            topic: 'staff.digest.daily',
            targets: [{ kind: 'staff', accountId: p.account_id }],
            link: { kind: 'inbox', id: p.account_id, screen: 'admin/inbox', label: 'Open inbox' },
            context: { digest: { count: notices.length, lines: notices.slice(0, 10).map((n) => `${n.title}${n.linked_ref ? ` (${n.linked_ref})` : ''}`).join('; ') } },
            dedupeKey: `digest:${p.account_id}:${day}`,
          }),
        p.account_id,
      );
    }
  }

  /** The market's business calendar (settings); null when settings is off or not built (every day counts as open) */
  async #businessCalendar(): Promise<{ isBusinessDay(day: string): boolean } | null> {
    const api = this.core.ctx.tryUse('settings');
    if (!api) return null;
    try {
      return await api.businessCalendar();
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
      return null;
    }
  }

  /** Job notifications.purge (daily): Delete notices older than noticeRetentionMonths and delivery rows older than deliveryLogRetentionDays; unresolved action notices are marked expired (expired_at, never resolved_at) actionNoticeExpiryDays after their deadline, or after they were created when they have no deadline */
  async purge(): Promise<void> {
    const now = this.core.now();
    const days = Number(await this.core.setting('deliveryLogRetentionDays'));
    await this.core.repo.purgeDeliveries(new Date(now.getTime() - days * 86_400_000));
    await this.core.repo.purgeNotices(now);
    // open action notices past their deadline (or, without one, their creation) by actionNoticeExpiryDays belong to
    // records that closed without a resolve: expired, never resolved
    const expiryDays = Number(await this.core.setting('actionNoticeExpiryDays'));
    await this.core.repo.expireActionNotices(new Date(now.getTime() - expiryDays * 86_400_000), now);
  }

  async #safe(fn: () => Promise<unknown>, id: string) {
    try {
      await fn();
    } catch (err) {
      this.core.log.error({ err, id }, 'notifications job item failed');
    }
  }
}
