import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type * as identity from '../../spec/identity.js';
import type { NotificationsPublicApi, Recipient, NotifyInput, Notice, InboxSummary, StaffInboxSummary } from '../../spec/notifications.js';
import type { NotificationsRepository } from './ports.js';

export interface NotificationsServiceDeps {
  repo: NotificationsRepository;
  ctx: ModuleContext<'notifications'>;
}

/**
 * Notifications use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/notifications.json.
 */
export class NotificationsService implements NotificationsPublicApi {
  constructor(protected readonly deps: NotificationsServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Send a topic to recipients now (for cases not covered by the event routing rules, e.g. mentions, test notices, guest order links). Essential topics ignore promotional consent; promotional topics check it. */
  async notify(input: NotifyInput): Promise<{ noticeIds: string[], deliveryIds: string[] }> {
    throw notImplemented("notifications.notify");
  }

  /** Send later (deadline reminders). Requires a dedupeKey so it can be cancelled. */
  async schedule(input: NotifyInput, sendAt: string): Promise<string> {
    throw notImplemented("notifications.schedule");
  }

  /** Cancel scheduled notices (e.g. order dispatched before the reminder) */
  async cancelScheduled(dedupeKey: string): Promise<number> {
    throw notImplemented("notifications.cancelScheduled");
  }

  /** Mark action-required notices as done for every recipient (the queue item was handled), so inboxes stop showing them as needing action */
  async resolve(dedupeKey: string, note?: string): Promise<number> {
    throw notImplemented("notifications.resolve");
  }

  /** Consent, suppression and account status check before any promotional send */
  async canSendPromotional(recipient: Recipient, channel: 'email' | 'sms' | 'push'): Promise<boolean> {
    throw notImplemented("notifications.canSendPromotional");
  }

  /** Tokens in promotional footers are signed here; customers' public unsubscribe endpoint verifies them */
  async verifyUnsubscribeToken(token: string): Promise<{ audience: 'customer' | 'seller', accountId: string | null, email: string, channel: 'email' | 'sms' | 'push', topicGroup: string } | null> {
    throw notImplemented("notifications.verifyUnsubscribeToken");
  }

  /** Badge count for navigation responses of other modules */
  async unreadCount(principal: identity.Principal): Promise<number> {
    throw notImplemented("notifications.unreadCount");
  }

  /** The caller's own inbox, newest first: customer (store), seller member within the current seller (Seller Center), staff member including notices received as backup (Admin Center). Same rules as GET /inbox in each area. */
  async listInbox(principal: identity.Principal, filter: { group?: string, unreadOnly?: boolean, actionRequired?: boolean, category?: 'essential' | 'optional' | 'promotional', view?: 'all' | 'needs_my_action' | 'mentions' }, page: common.PageInput): Promise<common.Page<Notice>> {
    throw notImplemented("notifications.listInbox");
  }

  /** Unread per group, open action notices (max 10, by deadline) and, for staff, needs-my-action, mentions and routing today. Same data as GET /inbox/summary in each area. */
  async inboxSummary(principal: identity.Principal): Promise<InboxSummary & Partial<StaffInboxSummary>> {
    throw notImplemented("notifications.inboxSummary");
  }

  /* ---------------- events consumed */

  /** identity.verification.code_issued: Email (or text, phase 2) the code: registration, email change, phone, 2-step. 'You already have an account' email when existingAccount. Code never stored in the delivery log. */
  async onVerificationCodeIssuedFromIdentity(event: EventPayload<"identity.verification.code_issued">): Promise<void> {
    throw notImplemented("notifications consumer of identity.verification.code_issued");
  }

  /** identity.password_reset.requested: Email the reset link (customer.account.password_reset / staff variant) */
  async onPasswordResetRequestedFromIdentity(event: EventPayload<"identity.password_reset.requested">): Promise<void> {
    throw notImplemented("notifications consumer of identity.password_reset.requested");
  }

  /** identity.password.changed: Security alert: password changed (email + in-app, account group) */
  async onPasswordChangedFromIdentity(event: EventPayload<"identity.password.changed">): Promise<void> {
    throw notImplemented("notifications consumer of identity.password.changed");
  }

  /** identity.session.new_device: Security alert: new sign-in on a device */
  async onSessionNewDeviceFromIdentity(event: EventPayload<"identity.session.new_device">): Promise<void> {
    throw notImplemented("notifications consumer of identity.session.new_device");
  }

  /** identity.email.changed: Alert to the old and new address */
  async onEmailChangedFromIdentity(event: EventPayload<"identity.email.changed">): Promise<void> {
    throw notImplemented("notifications consumer of identity.email.changed");
  }

  /** identity.two_step.changed: Security alert: 2-step verification turned on/off or reset */
  async onTwoStepChangedFromIdentity(event: EventPayload<"identity.two_step.changed">): Promise<void> {
    throw notImplemented("notifications consumer of identity.two_step.changed");
  }

  /** identity.account.locked: Alert the account owner; staff accounts also notify the Platform Administrator role */
  async onAccountLockedFromIdentity(event: EventPayload<"identity.account.locked">): Promise<void> {
    throw notImplemented("notifications consumer of identity.account.locked");
  }

  /** identity.invitation.created: Email the staff or seller-member invitation link */
  async onInvitationCreatedFromIdentity(event: EventPayload<"identity.invitation.created">): Promise<void> {
    throw notImplemented("notifications consumer of identity.invitation.created");
  }

  /** identity.user.verified: Welcome notice in the new customer's inbox */
  async onUserVerifiedFromIdentity(event: EventPayload<"identity.user.verified">): Promise<void> {
    throw notImplemented("notifications consumer of identity.user.verified");
  }

  /** customers.marketing_preferences.changed: Refresh the consent cache used for promotional sends and broadcasts */
  async onMarketingPreferencesChangedFromCustomers(event: EventPayload<"customers.marketing_preferences.changed">): Promise<void> {
    throw notImplemented("notifications consumer of customers.marketing_preferences.changed");
  }

  /** customers.account.closed: Stop all promotional sends, remove push devices, keep essential notices for open obligations only */
  async onAccountClosedFromCustomers(event: EventPayload<"customers.account.closed">): Promise<void> {
    throw notImplemented("notifications consumer of customers.account.closed");
  }

  /** customers.data_export.ready: Email the customer the export download link */
  async onDataExportReadyFromCustomers(event: EventPayload<"customers.data_export.ready">): Promise<void> {
    throw notImplemented("notifications consumer of customers.data_export.ready");
  }

  /** orders.order.accepted: Customer: order accepted (confirmation only after acceptance). Seller: new order per seller group (orders group, members with order permission) */
  async onOrderAcceptedFromOrders(event: EventPayload<"orders.order.accepted">): Promise<void> {
    throw notImplemented("notifications consumer of orders.order.accepted");
  }

  /** orders.item.cancelled: Customer: cancellation update for the item; seller: item cancelled */
  async onItemCancelledFromOrders(event: EventPayload<"orders.item.cancelled">): Promise<void> {
    throw notImplemented("notifications consumer of orders.item.cancelled");
  }

  /** orders.item.delayed: Customer: delay notice with the new estimate and options (wait, cancel, contact support) */
  async onItemDelayedFromOrders(event: EventPayload<"orders.item.delayed">): Promise<void> {
    throw notImplemented("notifications consumer of orders.item.delayed");
  }

  /** orders.cancellation.decided: Customer: result of a cancellation request */
  async onCancellationDecidedFromOrders(event: EventPayload<"orders.cancellation.decided">): Promise<void> {
    throw notImplemented("notifications consumer of orders.cancellation.decided");
  }

  /** payments.payment.captured: Customer: payment accepted (combined with order accepted when simultaneous) */
  async onPaymentCapturedFromPayments(event: EventPayload<"payments.payment.captured">): Promise<void> {
    throw notImplemented("notifications consumer of payments.payment.captured");
  }

  /** payments.payment.failed: Customer: payment failed, retry link */
  async onPaymentFailedFromPayments(event: EventPayload<"payments.payment.failed">): Promise<void> {
    throw notImplemented("notifications consumer of payments.payment.failed");
  }

  /** payments.payment.pending_check: Customer: payment result is being checked; link to order status */
  async onPaymentPendingCheckFromPayments(event: EventPayload<"payments.payment.pending_check">): Promise<void> {
    throw notImplemented("notifications consumer of payments.payment.pending_check");
  }

  /** payments.refund.sent: Customer: refund sent, with destination and expected timing */
  async onRefundSentFromPayments(event: EventPayload<"payments.refund.sent">): Promise<void> {
    throw notImplemented("notifications consumer of payments.refund.sent");
  }

  /** payments.refund.failed: Customer: refund problem and next steps; staff: Finance Manager notice */
  async onRefundFailedFromPayments(event: EventPayload<"payments.refund.failed">): Promise<void> {
    throw notImplemented("notifications consumer of payments.refund.failed");
  }

  /** payments.chargeback.opened: Staff: unusual financial activity notice to Finance Manager; seller: dispute opened on an order */
  async onChargebackOpenedFromPayments(event: EventPayload<"payments.chargeback.opened">): Promise<void> {
    throw notImplemented("notifications consumer of payments.chargeback.opened");
  }

  /** shipping.shipment.dispatched: Customer: package dispatched with contents, carrier and tracking; cancels the seller dispatch reminder */
  async onShipmentDispatchedFromShipping(event: EventPayload<"shipping.shipment.dispatched">): Promise<void> {
    throw notImplemented("notifications consumer of shipping.shipment.dispatched");
  }

  /** shipping.shipment.delivered: Customer: package delivered */
  async onShipmentDeliveredFromShipping(event: EventPayload<"shipping.shipment.delivered">): Promise<void> {
    throw notImplemented("notifications consumer of shipping.shipment.delivered");
  }

  /** shipping.shipment.exception: Customer: delivery problem with next steps; staff: Shipping Manager */
  async onShipmentExceptionFromShipping(event: EventPayload<"shipping.shipment.exception">): Promise<void> {
    throw notImplemented("notifications consumer of shipping.shipment.exception");
  }

  /** shipping.dispatch.overdue: Seller: dispatch overdue (action required); staff: overdue shipping to Shipping Manager (lead or backup) */
  async onDispatchOverdueFromShipping(event: EventPayload<"shipping.dispatch.overdue">): Promise<void> {
    throw notImplemented("notifications consumer of shipping.dispatch.overdue");
  }

  /** returns.return.requested: Seller: new return request with response deadline */
  async onReturnRequestedFromReturns(event: EventPayload<"returns.return.requested">): Promise<void> {
    throw notImplemented("notifications consumer of returns.return.requested");
  }

  /** returns.return.info_requested: Customer: more information needed for the return */
  async onReturnInfoRequestedFromReturns(event: EventPayload<"returns.return.info_requested">): Promise<void> {
    throw notImplemented("notifications consumer of returns.return.info_requested");
  }

  /** returns.return.approved: Customer: return approved with label or drop-off instructions */
  async onReturnApprovedFromReturns(event: EventPayload<"returns.return.approved">): Promise<void> {
    throw notImplemented("notifications consumer of returns.return.approved");
  }

  /** returns.return.rejected: Customer: return declined with the reason and how to ask for help */
  async onReturnRejectedFromReturns(event: EventPayload<"returns.return.rejected">): Promise<void> {
    throw notImplemented("notifications consumer of returns.return.rejected");
  }

  /** returns.label.created: Customer: return label ready; schedules a drop-off reminder */
  async onLabelCreatedFromReturns(event: EventPayload<"returns.label.created">): Promise<void> {
    throw notImplemented("notifications consumer of returns.label.created");
  }

  /** returns.return.received: Customer: return received; seller: inspect by deadline */
  async onReturnReceivedFromReturns(event: EventPayload<"returns.return.received">): Promise<void> {
    throw notImplemented("notifications consumer of returns.return.received");
  }

  /** returns.return.inspected: Customer: inspection outcome */
  async onReturnInspectedFromReturns(event: EventPayload<"returns.return.inspected">): Promise<void> {
    throw notImplemented("notifications consumer of returns.return.inspected");
  }

  /** returns.return.escalated: Staff: Returns Manager; seller: platform support stepped in */
  async onReturnEscalatedFromReturns(event: EventPayload<"returns.return.escalated">): Promise<void> {
    throw notImplemented("notifications consumer of returns.return.escalated");
  }

  /** returns.refund.approved: Customer: refund approved and processing (never says the money has arrived) */
  async onRefundApprovedFromReturns(event: EventPayload<"returns.refund.approved">): Promise<void> {
    throw notImplemented("notifications consumer of returns.refund.approved");
  }

  /** returns.replacement.created: Customer: replacement on its way (its own shipment) */
  async onReplacementCreatedFromReturns(event: EventPayload<"returns.replacement.created">): Promise<void> {
    throw notImplemented("notifications consumer of returns.replacement.created");
  }

  /** support.case.opened: Customer: acknowledgment with expected reply time; seller: case opened on an order */
  async onCaseOpenedFromSupport(event: EventPayload<"support.case.opened">): Promise<void> {
    throw notImplemented("notifications consumer of support.case.opened");
  }

  /** support.case.message_added: Customer or seller: case reply (email carries a reply-to token) */
  async onCaseMessageAddedFromSupport(event: EventPayload<"support.case.message_added">): Promise<void> {
    throw notImplemented("notifications consumer of support.case.message_added");
  }

  /** support.case.escalated: Staff: escalated case to Customer Support Manager (or Returns Manager by category) */
  async onCaseEscalatedFromSupport(event: EventPayload<"support.case.escalated">): Promise<void> {
    throw notImplemented("notifications consumer of support.case.escalated");
  }

  /** support.case.overdue: Staff: case past its response target to the queue lead and backup */
  async onCaseOverdueFromSupport(event: EventPayload<"support.case.overdue">): Promise<void> {
    throw notImplemented("notifications consumer of support.case.overdue");
  }

  /** support.case.decided: Customer and seller: decision and remedy, with the appeal deadline */
  async onCaseDecidedFromSupport(event: EventPayload<"support.case.decided">): Promise<void> {
    throw notImplemented("notifications consumer of support.case.decided");
  }

  /** support.case.resolved: Customer: case resolved */
  async onCaseResolvedFromSupport(event: EventPayload<"support.case.resolved">): Promise<void> {
    throw notImplemented("notifications consumer of support.case.resolved");
  }

  /** messaging.message.sent: Recipient (customer or seller members with customer permission): new message, reply-to token in email */
  async onMessageSentFromMessaging(event: EventPayload<"messaging.message.sent">): Promise<void> {
    throw notImplemented("notifications consumer of messaging.message.sent");
  }

  /** sellers.application.submitted: Staff: new application to Seller Manager */
  async onApplicationSubmittedFromSellers(event: EventPayload<"sellers.application.submitted">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.application.submitted");
  }

  /** sellers.application.information_requested: Applicant: information required, with deadline */
  async onApplicationInformationRequestedFromSellers(event: EventPayload<"sellers.application.information_requested">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.application.information_requested");
  }

  /** sellers.application.decided: Applicant: application result (approved with next steps, or reasons) */
  async onApplicationDecidedFromSellers(event: EventPayload<"sellers.application.decided">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.application.decided");
  }

  /** sellers.seller.restricted: Seller owner: restriction with reason, affected activity and appeal route */
  async onSellerRestrictedFromSellers(event: EventPayload<"sellers.seller.restricted">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.seller.restricted");
  }

  /** sellers.seller.suspended: Seller owner: suspension with reason, what stays open and appeal route */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.seller.suspended");
  }

  /** sellers.seller.reinstated: Seller owner: account reinstated */
  async onSellerReinstatedFromSellers(event: EventPayload<"sellers.seller.reinstated">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.seller.reinstated");
  }

  /** sellers.warning.issued: Seller owner: performance or policy warning */
  async onWarningIssuedFromSellers(event: EventPayload<"sellers.warning.issued">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.warning.issued");
  }

  /** sellers.appeal.decided: Seller owner: appeal result */
  async onAppealDecidedFromSellers(event: EventPayload<"sellers.appeal.decided">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.appeal.decided");
  }

  /** sellers.payout_account.changed: Seller owner: security notice that the payout destination changed (always email) */
  async onPayoutAccountChangedFromSellers(event: EventPayload<"sellers.payout_account.changed">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.payout_account.changed");
  }

  /** sellers.change_request.decided: Seller owner (essential, account_finance group, topic seller.change_request.decided): the requested change (legal details, bank, brand, category, return terms) was approved or rejected, with the reason and any impact on selling or payouts (e.g. new legal name shown from today; category opens for listings) */
  async onChangeRequestDecidedFromSellers(event: EventPayload<"sellers.change_request.decided">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.change_request.decided");
  }

  /** sellers.verification.changed: Seller owner (essential, topic seller.verification.changed): the Verified seller label was granted, lapsed or revoked, what it changes on the storefront and what to submit to get it back */
  async onVerificationChangedFromSellers(event: EventPayload<"sellers.verification.changed">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.verification.changed");
  }

  /** sellers.launch_review.decided: Seller owner (essential, topic seller.launch_review.decided): launch review passed (eligible offers are now live) or needs changes (what to fix; offers stay inactive until it passes) */
  async onLaunchReviewDecidedFromSellers(event: EventPayload<"sellers.launch_review.decided">): Promise<void> {
    throw notImplemented("notifications consumer of sellers.launch_review.decided");
  }

  /** finance.destination.verified: Seller owner (essential, owner-only, always email, topic seller.payout_destination.verified): the new payout destination is verified and the next payout goes there */
  async onDestinationVerifiedFromFinance(event: EventPayload<"finance.destination.verified">): Promise<void> {
    throw notImplemented("notifications consumer of finance.destination.verified");
  }

  /** finance.destination.rejected: Seller owner (essential, owner-only, always email, topic seller.payout_destination.rejected): the payout destination was rejected with the reason; payouts continue to the previous verified account or stay held until one is added */
  async onDestinationRejectedFromFinance(event: EventPayload<"finance.destination.rejected">): Promise<void> {
    throw notImplemented("notifications consumer of finance.destination.rejected");
  }

  /** catalog.product.changes_requested: Seller: requested corrections with field comments and resubmit deadline */
  async onProductChangesRequestedFromCatalog(event: EventPayload<"catalog.product.changes_requested">): Promise<void> {
    throw notImplemented("notifications consumer of catalog.product.changes_requested");
  }

  /** catalog.product.approved: Seller: product approved */
  async onProductApprovedFromCatalog(event: EventPayload<"catalog.product.approved">): Promise<void> {
    throw notImplemented("notifications consumer of catalog.product.approved");
  }

  /** catalog.product.rejected: Seller: product rejected with reason */
  async onProductRejectedFromCatalog(event: EventPayload<"catalog.product.rejected">): Promise<void> {
    throw notImplemented("notifications consumer of catalog.product.rejected");
  }

  /** inventory.stock.low: Seller: low stock (own offers); staff: stock shortage to Inventory Manager for the Official Store */
  async onStockLowFromInventory(event: EventPayload<"inventory.stock.low">): Promise<void> {
    throw notImplemented("notifications consumer of inventory.stock.low");
  }

  /** finance.payout.paid: Seller owner: payout paid (after bank confirmation) */
  async onPayoutPaidFromFinance(event: EventPayload<"finance.payout.paid">): Promise<void> {
    throw notImplemented("notifications consumer of finance.payout.paid");
  }

  /** finance.payout.failed: Seller owner: payout failed and what to fix; staff: failed payout to Finance Manager */
  async onPayoutFailedFromFinance(event: EventPayload<"finance.payout.failed">): Promise<void> {
    throw notImplemented("notifications consumer of finance.payout.failed");
  }

  /** finance.hold.placed: Seller owner: hold with amount, reason and review date */
  async onHoldPlacedFromFinance(event: EventPayload<"finance.hold.placed">): Promise<void> {
    throw notImplemented("notifications consumer of finance.hold.placed");
  }

  /** finance.hold.released: Seller owner: hold released */
  async onHoldReleasedFromFinance(event: EventPayload<"finance.hold.released">): Promise<void> {
    throw notImplemented("notifications consumer of finance.hold.released");
  }

  /** finance.balance.negative: Seller owner: amount owed; staff: Finance Manager */
  async onBalanceNegativeFromFinance(event: EventPayload<"finance.balance.negative">): Promise<void> {
    throw notImplemented("notifications consumer of finance.balance.negative");
  }

  /** finance.statement.issued: Seller owner: statement available */
  async onStatementIssuedFromFinance(event: EventPayload<"finance.statement.issued">): Promise<void> {
    throw notImplemented("notifications consumer of finance.statement.issued");
  }

  /** finance.reconciliation.mismatch_found: Staff: unusual financial activity to Finance Manager */
  async onReconciliationMismatchFoundFromFinance(event: EventPayload<"finance.reconciliation.mismatch_found">): Promise<void> {
    throw notImplemented("notifications consumer of finance.reconciliation.mismatch_found");
  }

  /** promotions.participation.invited: Seller: invitation to join a campaign with expected earnings impact */
  async onParticipationInvitedFromPromotions(event: EventPayload<"promotions.participation.invited">): Promise<void> {
    throw notImplemented("notifications consumer of promotions.participation.invited");
  }

  /** advertising.campaign.status_changed: Seller: sponsored campaign approved, rejected, live, paused or finished; staff: waiting approvals to Advertising/Content roles */
  async onCampaignStatusChangedFromAdvertising(event: EventPayload<"advertising.campaign.status_changed">): Promise<void> {
    throw notImplemented("notifications consumer of advertising.campaign.status_changed");
  }

  /** reviews.invite.due: Customer: review invitation (optional category, can be turned off) */
  async onInviteDueFromReviews(event: EventPayload<"reviews.invite.due">): Promise<void> {
    throw notImplemented("notifications consumer of reviews.invite.due");
  }

  /** reviews.report.created: Staff: reported content to the moderation queue role */
  async onReportCreatedFromReviews(event: EventPayload<"reviews.report.created">): Promise<void> {
    throw notImplemented("notifications consumer of reviews.report.created");
  }

  /** trust.report.created: Staff: new risk report to Trust and Risk Manager */
  async onReportCreatedFromTrust(event: EventPayload<"trust.report.created">): Promise<void> {
    throw notImplemented("notifications consumer of trust.report.created");
  }

  /** wishlist.alert.triggered: Customer: price drop or back in stock (promotional, consent required) */
  async onAlertTriggeredFromWishlist(event: EventPayload<"wishlist.alert.triggered">): Promise<void> {
    throw notImplemented("notifications consumer of wishlist.alert.triggered");
  }

  /** access.approval.requested: Staff: waiting approval to eligible approvers (nominated reviewer first), action required with due date */
  async onApprovalRequestedFromAccess(event: EventPayload<"access.approval.requested">): Promise<void> {
    throw notImplemented("notifications consumer of access.approval.requested");
  }

  /** access.approval.partially_approved: Staff: second approval needed, to remaining eligible approvers */
  async onApprovalPartiallyApprovedFromAccess(event: EventPayload<"access.approval.partially_approved">): Promise<void> {
    throw notImplemented("notifications consumer of access.approval.partially_approved");
  }

  /** access.approval.returned: Staff: request sent back to the requester with the comment */
  async onApprovalReturnedFromAccess(event: EventPayload<"access.approval.returned">): Promise<void> {
    throw notImplemented("notifications consumer of access.approval.returned");
  }

  /** access.approval.decided: Staff: outcome to the requester; resolves the approvers' action notices */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    throw notImplemented("notifications consumer of access.approval.decided");
  }

  /** access.approval.reminder_sent: Staff: reminder to the listed reviewers */
  async onApprovalReminderSentFromAccess(event: EventPayload<"access.approval.reminder_sent">): Promise<void> {
    throw notImplemented("notifications consumer of access.approval.reminder_sent");
  }

  /** access.coverage.changed: Re-route open staff action notices of that role to the new receivers */
  async onCoverageChangedFromAccess(event: EventPayload<"access.coverage.changed">): Promise<void> {
    throw notImplemented("notifications consumer of access.coverage.changed");
  }

  /** access.away.ended: Give the returning lead the notices received by the backup while away */
  async onAwayEndedFromAccess(event: EventPayload<"access.away.ended">): Promise<void> {
    throw notImplemented("notifications consumer of access.away.ended");
  }

  /** workqueues.item.overdue: Staff: overdue work item to the queue lead and backup */
  async onItemOverdueFromWorkqueues(event: EventPayload<"workqueues.item.overdue">): Promise<void> {
    throw notImplemented("notifications consumer of workqueues.item.overdue");
  }

  /** workqueues.item.escalated: Staff: escalated item to the next role on the escalation route */
  async onItemEscalatedFromWorkqueues(event: EventPayload<"workqueues.item.escalated">): Promise<void> {
    throw notImplemented("notifications consumer of workqueues.item.escalated");
  }

  /** workqueues.item.resolved: Resolve the action notices for that work item */
  async onItemResolvedFromWorkqueues(event: EventPayload<"workqueues.item.resolved">): Promise<void> {
    throw notImplemented("notifications consumer of workqueues.item.resolved");
  }

  /** settings.change.scheduled: Sellers (seller-visible changes): upcoming platform change with its effective date */
  async onChangeScheduledFromSettings(event: EventPayload<"settings.change.scheduled">): Promise<void> {
    throw notImplemented("notifications consumer of settings.change.scheduled");
  }

  /** audit.integrity.failed: Staff: urgent notice to Platform Administrator and Business Owner */
  async onIntegrityFailedFromAudit(event: EventPayload<"audit.integrity.failed">): Promise<void> {
    throw notImplemented("notifications consumer of audit.integrity.failed");
  }

  /** reports.export.ready: Export ready to the requester (staff or seller member), including audit, orders and module list exports */
  async onExportReadyFromReports(event: EventPayload<"reports.export.ready">): Promise<void> {
    throw notImplemented("notifications consumer of reports.export.ready");
  }

  /* ---------------- jobs */

  /** Job notifications.dispatch (queue worker): Render and send queued deliveries per channel with provider rate limits; mark sent */
  async dispatch(): Promise<void> {
    throw notImplemented("job notifications.dispatch");
  }

  /** Job notifications.retry (every minute): Re-send retrying deliveries whose nextAttemptAt passed; give up after maxDeliveryAttempts (notifications.delivery.failed) */
  async retry(): Promise<void> {
    throw notImplemented("job notifications.retry");
  }

  /** Job notifications.send-scheduled (every minute): Send scheduled notices due now (dispatch deadline reminders 4 h before, drop-off reminders, approval due reminders) */
  async sendScheduled(): Promise<void> {
    throw notImplemented("job notifications.send-scheduled");
  }

  /** Job notifications.send-broadcasts (every minute): Start scheduled broadcasts, resolve consenting recipients, respect quiet hours for SMS and push, publish notifications.broadcast.sent */
  async sendBroadcasts(): Promise<void> {
    throw notImplemented("job notifications.send-broadcasts");
  }

  /** Job notifications.staff-digest (daily at the start of business hours): Email the daily digest to staff who chose it */
  async staffDigest(): Promise<void> {
    throw notImplemented("job notifications.staff-digest");
  }

  /** Job notifications.purge (daily): Delete notices older than noticeRetentionMonths and delivery rows older than deliveryLogRetentionDays; expire unresolved action notices whose records closed */
  async purge(): Promise<void> {
    throw notImplemented("job notifications.purge");
  }
}
