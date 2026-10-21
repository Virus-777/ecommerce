/**
 * Routing rules: platform event → topic, recipients, link, template variables and dedupe key.
 * One table for every event in the spec's events.consumes; the service runs it (consumers.ts).
 *
 * Conventions for keys other modules may also use:
 *   dispatch:<groupId>                    seller/staff overdue dispatch notices (resolved on dispatch)
 *   seller.dispatch.reminder:<groupId>    the seller reminder shipping/orders schedule (cancelled on dispatch)
 *   return:<returnId>:respond|inspect     seller return action notices
 *   case:<caseId>                         case action notices (resolved on decided/resolved)
 *   approval:<requestId>                  approver notices and scheduled due reminders
 *   workitem:<itemId>                     work queue notices (resolved by workqueues.item.resolved)
 *   payout:<payoutId>                     failed payout action notices (resolved when paid)
 *   trust-evidence:<requestId>            trust evidence requests to a customer or seller (trust resolves it when answered)
 *   official-store:<conversationId>       Official Store message notices to staff (resolved when the store replies)
 *   day-end:<reviewId>                    day-end review reminders (resolved by workqueues.day_end.completed)
 *   refund:<refundId>:destination         refund destination requests (resolved when the refund is sent)
 *   offer-missing-items:<offerId>         missing-items review notices (resolved by offers.offer.missing_items_reviewed)
 *   cancellation:<cancellationId>:request cancellation requests to the seller or the Order Manager (resolved by orders.cancellation.decided)
 *
 * Fulfilled by Marketly groups (fulfilledBy marketly_service) never give the seller a shipping or dispatch
 * notice: no new order, dispatch reminder, overdue dispatch or cancellation request (fulfillment-service tells
 * the seller with its seller.fulfillment.* topics through notify).
 */
import { maskEmail } from '../../../kernel/lib/mask.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type { EventName, EventPayload } from '../../../kernel/events/index.js';
import { OFFICIAL_STORE_ID, OFFICIAL_STORE_NAME, type Money } from '../../../spec/common.js';
import type { NoticeLink } from '../../../spec/notifications.js';
import type { spec } from '../../../spec/notifications.js';

export type RecipientReason = 'lead' | 'backup' | 'member' | 'direct' | 'requester' | 'approver' | 'mention';
export type RecipientKind = 'customer' | 'guest_email' | 'seller_member' | 'staff_member' | 'external_email';
export type SubjectKey = 'orderId' | 'returnId' | 'caseId' | 'conversationId' | 'groupId';

export type Target =
  /** A customer by identity account or customers id */
  | { kind: 'customer'; accountId?: string | null; customerId?: string | null }
  /** Guest checkout email: email only */
  | { kind: 'guest'; email: string }
  /** A bare email address (codes, links, invitations): email only, no inbox */
  | { kind: 'email'; email: string; accountId?: string | null; recipientKind?: RecipientKind }
  /** A contact outside Marketly (supplier, rights owner, scheduled-report address): essential topics, email only, never an inbox notice */
  | { kind: 'external'; email: string; name?: string | null }
  /** A bare phone number (SMS codes) */
  | { kind: 'phone'; phone: string; accountId?: string | null }
  /** A seller workspace (members by permission and preference), or one member of it */
  | { kind: 'seller'; sellerId: string; accountId?: string | null; memberId?: string | null }
  /** A staff role: its lead, or the covering backup while the lead is away (the lead keeps a copy) */
  | { kind: 'role'; roleKey: string }
  /** One staff member */
  | { kind: 'staff'; accountId: string; reason?: RecipientReason };

export type RouteTarget =
  | Target
  /** Whoever received earlier notices about this order, return, case or conversation (fallback when the event names no recipient) */
  | { kind: 'subject'; audience: 'customer' | 'seller'; key: SubjectKey; value: string | null | undefined }
  /** An identity account: its customer inbox (member realm) or staff inbox (staff realm) */
  | { kind: 'account'; accountId: string }
  /** The email address of an identity account (no inbox) */
  | { kind: 'account_email'; accountId: string; recipientKind: RecipientKind }
  /** Every active seller workspace */
  | { kind: 'all_sellers' };

export interface RouteSend {
  /** A topic, or one per identity realm (resolved from realmOf) */
  topic: string | { member: string; staff: string; realmOf: string };
  to: (RouteTarget | null | undefined | false)[];
  link: NoticeLink;
  context?: Record<string, unknown>;
  subjects?: Partial<Record<SubjectKey, string | null | undefined>>;
  dedupe: string;
  actionRequired?: boolean;
  deadline?: string | null;
  sellerId?: string | null;
  group?: string;
  replyTo?: { module: 'support' | 'messaging'; refId: string };
  /** Guests get the order link minted by identity (issueOrderLink) */
  guestOrderLink?: { orderId: string; email: string };
  /**
   * Skip when this topic was just sent about the same subject (combined notices): an in-app notice for
   * signed-in customers, the delivery log (dedupe key) for guest addresses, who have no inbox
   */
  skipIfRecent?: { topic: string; key: SubjectKey; value: string; dedupe: string };
  /**
   * Send only the first time: skipped when this topic was ever sent with this dedupe key (a review published again
   * after an edit or a moderation decision is not new)
   */
  once?: boolean;
}

export type Effect = 'refreshConsent' | 'customerClosed' | 'reroute' | 'awayEnded' | 'dropOffReminder' | 'approvalDueReminder' | 'dispatchReminder';

export interface EventRoute<P> {
  /** Done first: action notices resolved (resolve(dedupeKey)) */
  resolve?: (p: P) => (string | null | undefined)[];
  /** Done first: scheduled notices cancelled (cancelScheduled(dedupeKey)) */
  cancel?: (p: P) => (string | null | undefined)[];
  sends?: (p: P, f: Fmt) => (RouteSend | null | undefined | false | '' | 0)[];
  /** Side effects the service performs after the sends */
  effects?: Effect[];
}

export interface Fmt {
  money(m: Money | null | undefined): string;
  date(iso: string | null | undefined): string;
  dateTime(iso: string | null | undefined): string;
  /** snake_case code → words */
  human(code: string | null | undefined): string;
  /** "in 10 minutes" style */
  until(iso: string | null | undefined): string;
}

type Consumed = keyof (typeof spec)['events']['consumes'] & EventName;
export type Routes = { [N in Consumed]: EventRoute<EventPayload<N>> };

/* ------------------------------------------------------------------ links */

const L = (kind: string, id: string, screen: string, label?: string, ref?: string | null, url?: string | null): NoticeLink => ({ kind, id, screen, ...(label ? { label } : {}), ...(ref ? { ref } : {}), ...(url ? { url } : {}) });

/** How a request status reads in a notice: Your request SR-… was confirmed */
const REQUEST_STATUS: Record<string, string> = { confirmed: 'confirmed', in_progress: 'started', completed: 'completed', declined: 'declined', cancelled: 'cancelled' };

const orderLink = (orderId: string, ref?: string | null) => L('order', orderId, 'account/order', 'View order', ref);
const returnLink = (returnId: string, ref?: string | null, label = 'View return') => L('return', returnId, 'account/return', label, ref);
const caseLink = (caseId: string, ref?: string | null) => L('case', caseId, 'help/case', 'View case', ref);
const sellerOrderLink = (groupId: string, ref?: string | null, label = 'Open order') => L('seller_order', groupId, 'seller/order', label, ref);
const sellerReturnLink = (returnId: string, ref?: string | null) => L('return', returnId, 'seller/return', 'Open return', ref);
/** Where a verification code is entered, by identity's code purpose */
const CODE_SCREENS: Record<EventPayload<'identity.verification.code_issued'>['purpose'], string> = {
  email_verification: 'auth/register',
  email_change: 'account/profile',
  phone_verification: 'account/profile',
  sign_in_second_factor: 'auth/sign-in',
};
const accountHealth = (id: string) =>L('restriction', id, 'seller/performance', 'View account health');

const customer = (customerId: string | null | undefined): RouteTarget | null => (customerId ? { kind: 'customer', customerId } : null);
const seller = (sellerId: string | null | undefined): RouteTarget | null => (sellerId ? { kind: 'seller', sellerId } : null);
const role = (roleKey: string): RouteTarget => ({ kind: 'role', roleKey });
/** What a seller change request asks for (sellers.ChangeRequest kind), as staff notices name it */
const CHANGE_WHAT: Record<string, string> = {
  store_name: 'Store name change',
  tagline: 'New tagline',
  public_claim: 'Storefront claim',
  brand_request: 'Brand request',
  legal_name: 'Legal name change',
  business_address: 'Business address change',
  ownership: 'Ownership change',
};
const external = (email: string | null | undefined, name?: string | null): RouteTarget | null => (email ? { kind: 'external', email, name: name ?? null } : null);
const staff = (accountId: string | null | undefined, reason: RecipientReason = 'direct'): RouteTarget | null => (accountId && isUuid(accountId) ? { kind: 'staff', accountId, reason } : null);
const byOrder = (orderId: string | null | undefined): RouteTarget | null => (orderId ? { kind: 'subject', audience: 'customer', key: 'orderId', value: orderId } : null);
const byReturn = (returnId: string | null | undefined): RouteTarget | null => (returnId ? { kind: 'subject', audience: 'customer', key: 'returnId', value: returnId } : null);
const byCase = (caseId: string | null | undefined): RouteTarget | null => (caseId ? { kind: 'subject', audience: 'customer', key: 'caseId', value: caseId } : null);
const sellerByCase = (caseId: string): RouteTarget => ({ kind: 'subject', audience: 'seller', key: 'caseId', value: caseId });

/** Who an order, return or case belongs to, as the event names them */
interface Shopper {
  /** Customers-module id; null for guests */
  customerId?: string | null;
  /** Order contact email (guests) */
  contactEmail?: string | null;
}

/**
 * The shopper of a customer-facing event: the customer (customers id → identity account), else the guest's
 * contact address (email only), else, when the event names neither, whoever received earlier notices.
 */
const shopper = (p: Shopper, ...fallback: (RouteTarget | null)[]): (RouteTarget | null)[] =>
  p.customerId ? [customer(p.customerId)] : p.contactEmail ? [{ kind: 'guest', email: p.contactEmail }] : fallback;

/** Guests get the order link minted by identity (they have no account to open the order in) */
const guestLink = (p: Shopper, orderId: string | null | undefined): Pick<RouteSend, 'guestOrderLink'> =>
  !p.customerId && p.contactEmail && orderId ? { guestOrderLink: { orderId, email: p.contactEmail } } : {};

/** What the customer paid: the card amount, store credit alone ("$15.00 in store credit"), or both */
function paidAmount(p: { amount: Money; creditAmount?: Money | null }, f: Fmt): string {
  const credit = p.creditAmount && p.creditAmount.amount > 0 ? p.creditAmount : null;
  if (!credit) return f.money(p.amount);
  if (p.amount.amount === 0) return `${f.money(credit)} in store credit`;
  return `${f.money(p.amount)} plus ${f.money(credit)} in store credit`;
}

/** A conversation whose seller side is the Official Store (staff answer it; never a seller workspace) */
const officialStoreConversation = (p: { sellerId?: string | null; officialStore?: boolean }) => p.officialStore === true || p.sellerId === OFFICIAL_STORE_ID;

/** Escalation targets of support cases (support's staffEscalate `to`) */
const CASE_TEAMS: Record<string, string> = {
  returns: 'returns_manager',
  finance: 'finance_manager',
  trust: 'trust_and_risk_manager',
  seller_management: 'seller_manager',
  support_lead: 'customer_support_manager',
};

const ROLE_AREA: Record<string, string> = {
  returns_manager: 'Returns',
  finance_manager: 'Finance',
  trust_and_risk_manager: 'Trust',
  seller_manager: 'Sellers',
  customer_support_manager: 'Support',
};

/* Live topics (2026-10-20): Official Store counterparts of seller notices, seller support requests */

/** Staff role of each support team (the lead roles of support's TEAM_ROLES): a seller's request goes to its team */
const TEAM_ROLES: Record<string, string> = {
  customer_support: 'customer_support_manager',
  returns: 'returns_manager',
  finance: 'finance_manager',
  trust: 'trust_and_risk_manager',
  seller_management: 'seller_manager',
  official_store: 'official_store_manager',
};

/** The Official Store has no seller members: its counterparts of seller notices go to the Official Store Manager role */
const officialStore = (): RouteTarget => role('official_store_manager');

/** Review and feedback words for the templates */
const reviewContext = (p: { rating: number; verified: boolean }) => ({ review: { rating: p.rating, kind: p.verified ? 'verified purchase' : 'not a verified purchase' } });
const feedbackContext = (p: { sentiment: string }, f: Fmt) => ({ feedback: { sentiment: f.human(p.sentiment) || 'new' } });
/** Dedupe key of a question notice: one per answering party, resolved when that party answers */
const questionKey = (questionId: string, party: string) => `question:${questionId}:${party}`;

/** Staff work area of a work queue */
export function queueArea(queueKey: string): string {
  const k = queueKey.toLowerCase();
  if (/dispatch|tracking|deliver|ship|carrier/.test(k)) return 'Shipping';
  if (/return|inspection/.test(k)) return 'Returns';
  if (/financ|payout|refund|recon|deposit/.test(k)) return 'Finance';
  if (/case|support|dispute/.test(k)) return 'Support';
  if (/seller|application/.test(k)) return 'Sellers';
  if (/stock|inventory|receiv|purchas/.test(k)) return 'Inventory';
  if (/pick|pack|warehouse/.test(k)) return 'Operations';
  if (/trust|risk|fraud/.test(k)) return 'Trust';
  if (/content|moderation|review/.test(k)) return 'Content';
  return 'Operations';
}

const REVIEW_STATES = new Set(['pending_review', 'submitted', 'in_review', 'pending_approval']);

/**
 * A group the seller ships itself: seller-owned and not Fulfilled by Marketly. Only these give the seller
 * shipping and dispatch notices (new order, dispatch reminder, overdue dispatch, cancellation requests).
 */
export const sellerShips = (g: { ownerType?: string | null; fulfilledBy?: string | null }) => g.ownerType === 'seller' && g.fulfilledBy !== 'marketly_service' && g.fulfilledBy !== 'official_warehouse';

/* ------------------------------------------------------------------ the table */

export const ROUTES: Routes = {
  /* ---------------------------------------------------------------- identity */
  // keyed by the code's expiry too: a resend issues a new code for the same challenge (new expiresAt) and must be
  // sent, while a redelivered event (same expiresAt) is still a duplicate
  'identity.verification.code_issued': {
    sends: (p, f) => [
      p.existingAccount
        ? { topic: 'customer.account.already_registered', to: [{ kind: 'email', email: p.to, accountId: p.accountId }], link: L('account', p.accountId ?? p.challengeId, 'auth/sign-in', 'Sign in'), dedupe: `code:${p.challengeId}:${p.expiresAt}` }
        : {
            topic: 'customer.account.verification_code',
            to: [p.channel === 'sms' ? { kind: 'phone', phone: p.to, accountId: p.accountId } : { kind: 'email', email: p.to, accountId: p.accountId }],
            link: L('account', p.accountId ?? p.challengeId, CODE_SCREENS[p.purpose], 'Enter code'),
            context: { code: { value: p.code, expires: f.until(p.expiresAt) } },
            dedupe: `code:${p.challengeId}:${p.expiresAt}`,
          },
    ],
  },
  'identity.password_reset.requested': {
    sends: (p) => [
      {
        topic: { member: 'customer.account.password_reset', staff: 'staff.account.password_reset', realmOf: p.accountId },
        to: [{ kind: 'email', email: p.email, accountId: p.accountId }],
        link: L('account', p.accountId, 'auth/recover', 'Reset password', null, p.resetUrl),
        context: { reset: { url: p.resetUrl } },
        dedupe: `reset:${p.accountId}:${p.expiresAt}`,
      },
    ],
  },
  'identity.password.changed': {
    sends: (p) => [
      {
        topic: p.realm === 'staff' ? 'staff.account.password_changed' : 'customer.account.password_changed',
        to: [p.realm === 'staff' ? staff(p.accountId) : { kind: 'customer', accountId: p.accountId }],
        link: L('account', p.accountId, p.realm === 'staff' ? 'admin/staff' : 'account/security', 'Review security'),
        dedupe: `password:${p.accountId}:${p.at}`,
      },
    ],
  },
  'identity.session.new_device': {
    sends: (p) => [
      {
        topic: p.realm === 'staff' ? 'staff.account.new_device' : 'customer.account.new_device',
        to: [p.realm === 'staff' ? staff(p.accountId) : { kind: 'customer', accountId: p.accountId }],
        link: L('account', p.accountId, p.realm === 'staff' ? 'admin/staff' : 'account/security', 'Review security'),
        context: { device: { label: p.deviceLabel, location: p.location ?? 'unknown location' } },
        dedupe: `device:${p.accountId}:${p.at}`,
      },
    ],
  },
  'identity.email.changed': {
    sends: (p) => [
      {
        topic: { member: 'customer.account.email_changed', staff: 'staff.account.email_changed', realmOf: p.accountId },
        to: [{ kind: 'account', accountId: p.accountId }, { kind: 'email', email: p.oldEmail, accountId: p.accountId }, { kind: 'email', email: p.newEmail, accountId: p.accountId }],
        link: L('account', p.accountId, 'account/security', 'Review security'),
        context: { email: { old: maskEmail(p.oldEmail), new: maskEmail(p.newEmail) } },
        dedupe: `email:${p.accountId}:${p.newEmail.toLowerCase()}`,
      },
    ],
  },
  'identity.two_step.changed': {
    sends: (p) => [
      {
        topic: { member: 'customer.account.two_step_changed', staff: 'staff.account.two_step_changed', realmOf: p.accountId },
        to: [{ kind: 'account', accountId: p.accountId }],
        link: L('account', p.accountId, 'account/security', 'Review security'),
        context: { twostep: { state: p.enabled ? 'turned on' : 'turned off' } },
        dedupe: `twostep:${p.accountId}:${p.enabled}:${p.method ?? ''}`,
      },
    ],
  },
  'identity.account.locked': {
    sends: (p, f) => [
      {
        topic: p.realm === 'staff' ? 'staff.account.locked' : 'customer.account.locked',
        to: [p.realm === 'staff' ? staff(p.accountId) : { kind: 'customer', accountId: p.accountId }],
        link: L('account', p.accountId, p.realm === 'staff' ? 'admin/staff' : 'account/security', 'Reset password'),
        context: { lock: { until: p.until ? f.dateTime(p.until) : 'you reset your password' } },
        dedupe: `locked:${p.accountId}:${p.until ?? p.cause}`,
      },
      p.realm === 'staff' && {
        topic: 'staff.security.account_locked',
        to: [role('platform_administrator')],
        link: L('account', p.accountId, 'admin/staff', 'Open staff member'),
        context: { lock: { until: p.until ? `until ${f.dateTime(p.until)}` : f.human(p.cause) } },
        dedupe: `locked:${p.accountId}:${p.until ?? p.cause}`,
      },
    ],
  },
  'identity.invitation.created': {
    sends: (p) => [
      {
        topic: p.purpose === 'staff' ? 'staff.account.invitation' : 'seller.member.invitation',
        to: [{ kind: 'email', email: p.email, recipientKind: p.purpose === 'staff' ? 'staff_member' : 'seller_member' }],
        link: L('account', p.invitationId, 'accept-invitation', 'Accept invitation', p.contextRef, p.acceptUrl),
        context: { invite: { url: p.acceptUrl, context: p.contextLabel ?? 'Marketly', by: p.invitedBy.name ?? 'Marketly' }, recipient: { name: p.name } },
        // a resend issues a new link with a new expiry: each send is its own email; a redelivered event is not
        dedupe: `invite:${p.invitationId}:${p.expiresAt}`,
      },
    ],
  },
  'identity.user.verified': {
    sends: (p) => [
      p.channel === 'email' && { topic: 'customer.account.welcome', to: [{ kind: 'customer', accountId: p.accountId }], link: L('account', p.accountId, 'account/overview', 'Go to my account'), dedupe: `welcome:${p.accountId}` },
    ],
  },

  /* ---------------------------------------------------------------- customers */
  'customers.marketing_preferences.changed': { effects: ['refreshConsent'] },
  'customers.account.closed': { effects: ['customerClosed'] },
  'customers.data_export.ready': {
    sends: (p, f) => [
      { topic: 'customer.account.data_export_ready', to: [customer(p.customerId)], link: L('account', p.requestId, 'account/profile', 'Download'), context: { export: { expires: f.date(p.expiresAt) } }, dedupe: `export:${p.requestId}` },
    ],
  },
  'customers.closure.delayed': {
    sends: (p, f) => [
      {
        topic: 'customer.account.closure_delayed',
        to: [customer(p.customerId)],
        link: L('account', p.requestId, 'account/profile', 'See what is open'),
        context: { closure: { blockers: p.blockers.map((b) => b.detail).join(', ') || 'open orders or requests', nextCheck: f.date(p.nextCheckAt) } },
        // customers publishes once per new set of blockers
        dedupe: `closure-delayed:${p.requestId}:${[...new Set(p.blockers.map((b) => b.kind))].sort().join(',')}`,
      },
    ],
  },

  /* ---------------------------------------------------------------- orders */
  'orders.order.accepted': {
    effects: ['dispatchReminder'],
    sends: (p, f) => [
      {
        topic: 'customer.order.accepted',
        to: [p.customerId ? customer(p.customerId) : { kind: 'guest', email: p.contactEmail }],
        link: orderLink(p.orderId, p.ref),
        context: { order: { ref: p.ref, total: f.money(p.total) } },
        subjects: { orderId: p.orderId },
        dedupe: `order:${p.orderId}:accepted`,
        ...(p.customerId ? {} : { guestOrderLink: { orderId: p.orderId, email: p.contactEmail } }),
      },
      // Fulfilled by Marketly groups: Marketly ships them (fulfillment-service sends seller.fulfillment.order_received)
      ...p.groups
        .filter((g) => sellerShips(g) && g.sellerId)
        .map((g) => ({
          topic: 'seller.order.new',
          to: [seller(g.sellerId)],
          link: sellerOrderLink(g.groupId, p.ref),
          context: { order: { ref: p.ref, total: f.money(g.total) }, due: { date: f.dateTime(g.dispatchBy) } },
          subjects: { orderId: p.orderId, groupId: g.groupId },
          sellerId: g.sellerId,
          dedupe: `order:${p.orderId}:${g.groupId}:new`,
        })),
      // live topics: the Official Store's groups go to its staff (it has no seller workspace)
      ...p.groups
        .filter((g) => g.ownerType === 'official')
        .map((g) => ({
          topic: 'staff.official_store.order_new',
          to: [officialStore()],
          link: L('order', p.orderId, 'admin/order', 'Open order', p.ref),
          context: { order: { ref: p.ref, total: f.money(g.total) }, due: { date: f.dateTime(g.dispatchBy) } },
          subjects: { orderId: p.orderId, groupId: g.groupId },
          dedupe: `order:${p.orderId}:${g.groupId}:official`,
        })),
    ],
  },
  'orders.item.cancelled': {
    sends: (p, f) => [
      // staff may cancel without telling the customer (notifyCustomer false); the seller is always told
      p.notifyCustomer !== false && {
        topic: 'customer.order.item_cancelled',
        to: shopper(p, byOrder(p.orderId)),
        link: orderLink(p.orderId, p.ref),
        context: { order: { ref: p.ref }, item: { count: p.quantity }, refund: { amount: f.money(p.refund.total) } },
        subjects: { orderId: p.orderId, groupId: p.groupId },
        dedupe: `cancellation:${p.cancellationId}:${p.itemId}`,
        ...guestLink(p, p.orderId),
      },
      p.ownerType === 'seller' &&
        p.initiatedBy !== 'seller' && {
          topic: 'seller.order.item_cancelled',
          to: [seller(p.sellerId)],
          link: sellerOrderLink(p.groupId, p.ref),
          // Fulfilled by Marketly: Marketly's warehouse holds the units; the seller has nothing to stop. After dispatch
          // (a package returned to sender) there is nothing left to stop either
          context: { order: { ref: p.ref }, item: { count: p.quantity }, cancel: { note: !p.beforeDispatch ? 'The package came back to you and the customer is refunded.' : p.fulfilledBy === 'marketly_service' ? "Marketly's warehouse will not ship them." : 'Do not ship them.' } },
          subjects: { orderId: p.orderId, groupId: p.groupId },
          sellerId: p.sellerId,
          dedupe: `cancellation:${p.cancellationId}:${p.itemId}`,
        },
    ],
  },
  'orders.item.delayed': {
    sends: (p, f) => [
      {
        topic: 'customer.order.delayed',
        to: shopper(p, byOrder(p.orderId)),
        link: L('order', p.orderId, 'account/order', 'See your options'),
        context: { delay: { dispatchBy: p.expectedDispatchBy ? f.date(p.expectedDispatchBy) : 'to be confirmed', reason: p.reason } },
        subjects: { orderId: p.orderId, groupId: p.groupId },
        dedupe: `delay:${p.groupId}:${p.expectedDispatchBy ?? p.source}`,
        ...guestLink(p, p.orderId),
      },
    ],
  },
  'orders.cancellation.requested': {
    sends: (p, f) => {
      const count = p.itemIds.length;
      const subjects = { orderId: p.orderId, groupId: p.groupId };
      return [
        // the seller answers only for the groups it ships itself
        p.fulfilledBy === 'seller' &&
          p.sellerId && {
            topic: 'seller.order.cancellation_requested',
            to: [seller(p.sellerId)],
            link: sellerOrderLink(p.groupId, null, 'Respond'),
            context: { item: { count }, due: { date: f.dateTime(p.respondBy) } },
            subjects,
            sellerId: p.sellerId,
            deadline: p.respondBy,
            dedupe: `cancellation:${p.cancellationId}:request`,
          },
        // Official Store and Fulfilled by Marketly groups already being picked: the Order Manager decides
        p.fulfilledBy !== 'seller' && {
          topic: 'staff.orders.cancellation_requested',
          to: [role('order_manager')],
          link: L('order', p.orderId, 'admin/order', 'Decide cancellation'),
          context: { item: { count }, shipper: { name: p.fulfilledBy === 'marketly_service' ? 'Fulfilled by Marketly' : OFFICIAL_STORE_NAME }, due: { date: f.dateTime(p.respondBy) } },
          subjects,
          deadline: p.respondBy,
          dedupe: `cancellation:${p.cancellationId}:request`,
        },
      ];
    },
  },
  'orders.cancellation.decided': {
    resolve: (p) => [`cancellation:${p.cancellationId}:request`],
    sends: (p) => [
      {
        topic: 'customer.order.cancellation_decided',
        to: shopper(p, byOrder(p.orderId)),
        link: orderLink(p.orderId),
        context: { cancellation: { outcome: p.outcome === 'auto_accepted' ? 'accepted' : p.outcome } },
        subjects: { orderId: p.orderId },
        dedupe: `cancellation:${p.cancellationId}:decided`,
        ...guestLink(p, p.orderId),
      },
    ],
  },

  /* ---------------------------------------------------------------- payments */
  'payments.payment.captured': {
    sends: (p, f) => [
      {
        topic: 'customer.payment.captured',
        to: shopper(p, byOrder(p.orderId)),
        link: orderLink(p.orderId),
        context: { payment: { amount: paidAmount(p, f) } },
        subjects: { orderId: p.orderId },
        dedupe: `payment:${p.captureId}`,
        skipIfRecent: { topic: 'customer.order.accepted', key: 'orderId', value: p.orderId, dedupe: `order:${p.orderId}:accepted` },
        ...guestLink(p, p.orderId),
      },
    ],
  },
  'payments.payment.failed': {
    sends: (p) => [
      p.orderId && { topic: 'customer.payment.failed', to: shopper(p, byOrder(p.orderId)), link: L('order', p.orderId, 'account/order', 'Try again', p.orderRef), context: { order: { ref: p.orderRef } }, subjects: { orderId: p.orderId }, dedupe: `payment-failed:${p.intentId}:${p.at}`, ...guestLink(p, p.orderId) },
    ],
  },
  'payments.payment.pending_check': {
    sends: (p, f) => [
      p.orderId && {
        topic: 'customer.payment.pending_check',
        to: shopper(p, byOrder(p.orderId)),
        link: L('order', p.orderId, 'account/order', 'View order status'),
        context: { payment: { amount: f.money(p.amount) } },
        subjects: { orderId: p.orderId },
        dedupe: `payment-check:${p.intentId}`,
        ...guestLink(p, p.orderId),
      },
    ],
  },
  'payments.refund.destination_requested': {
    sends: (p, f) => [
      {
        topic: 'customer.refund.destination_needed',
        to: shopper(p, byOrder(p.orderId)),
        link: L('order', p.orderId, 'account/order', 'Choose where to receive it', p.orderRef),
        context: {
          order: { ref: p.orderRef },
          refund: { amount: f.money(p.amount), reason: p.failureReason?.trim() || 'the original payment method can no longer receive it' },
          destination: { message: p.message?.trim() ?? '' },
        },
        subjects: { orderId: p.orderId },
        dedupe: `refund:${p.refundId}:destination`,
        actionRequired: true,
        ...guestLink(p, p.orderId),
      },
    ],
  },
  'payments.refund.sent': {
    // the customer chose a destination (or the refund went through another way)
    resolve: (p) => [`refund:${p.refundId}:destination`],
    sends: (p, f) => [
      {
        topic: 'customer.refund.sent',
        to: shopper(p, byOrder(p.orderId)),
        link: L('order', p.orderId, 'account/order', 'Track refund', p.orderRef),
        context: { order: { ref: p.orderRef }, refund: { amount: f.money(p.amount), destination: p.destination } },
        subjects: { orderId: p.orderId },
        dedupe: `refund:${p.refundId}:sent`,
        ...guestLink(p, p.orderId),
      },
    ],
  },
  'payments.refund.failed': {
    sends: (p, f) => [
      p.finalAttempt && {
        topic: 'customer.refund.failed',
        to: shopper(p, byOrder(p.orderId)),
        link: L('order', p.orderId, 'account/order', 'View refund', p.orderRef),
        context: { order: { ref: p.orderRef }, refund: { amount: f.money(p.amount), reason: p.reason } },
        subjects: { orderId: p.orderId },
        dedupe: `refund:${p.refundId}:failed`,
        ...guestLink(p, p.orderId),
      },
      p.finalAttempt && {
        topic: 'staff.finance.refund_failed',
        to: [role('finance_manager')],
        link: L('refund', p.refundId, 'admin/finance', 'Open refund', p.ref),
        context: { refund: { amount: f.money(p.amount), reason: p.reason } },
        subjects: { orderId: p.orderId },
        dedupe: `refund:${p.refundId}`,
      },
    ],
  },
  'payments.chargeback.opened': {
    sends: (p, f) => [
      {
        topic: 'staff.finance.chargeback_opened',
        to: [role('finance_manager')],
        link: L('chargeback', p.disputeId, 'admin/finance', 'Open dispute', p.ref),
        context: { chargeback: { ref: p.ref, amount: f.money(p.amount) } },
        subjects: { orderId: p.orderId },
        dedupe: `chargeback:${p.disputeId}`,
      },
      p.sellerId && {
        topic: 'seller.order.dispute_opened',
        to: [seller(p.sellerId)],
        link: p.groupId ? sellerOrderLink(p.groupId, p.ref, 'Add evidence') : L('chargeback', p.disputeId, 'seller/finance', 'Add evidence', p.ref),
        context: { chargeback: { ref: p.ref, amount: f.money(p.amount) }, due: { date: f.dateTime(p.evidenceDueAt) } },
        subjects: { orderId: p.orderId, groupId: p.groupId },
        sellerId: p.sellerId,
        deadline: p.evidenceDueAt,
        dedupe: `chargeback:${p.disputeId}`,
      },
    ],
  },

  /* ---------------------------------------------------------------- shipping */
  'shipping.shipment.dispatched': {
    resolve: (p) => [`dispatch:${p.groupId}`, `seller.dispatch.reminder:${p.groupId}`],
    cancel: (p) => [`dispatch:${p.groupId}`, `seller.dispatch.reminder:${p.groupId}`],
    sends: (p, f) => [
      p.kind !== 'return' && {
        topic: 'customer.shipment.dispatched',
        to: shopper(p, byOrder(p.orderId)),
        ...guestLink(p, p.orderId),
        link: L('shipment', p.shipmentId, 'account/tracking', 'Track package'),
        context: {
          package: { items: p.lines.map((l) => `${l.title}${l.variantLabel ? ` (${l.variantLabel})` : ''} × ${l.quantity}`).join(', ') },
          delivery: { estimate: p.estimatedArrival ? `${f.date(p.estimatedArrival.from)}–${f.date(p.estimatedArrival.to)}` : 'shown in tracking' },
        },
        subjects: { orderId: p.orderId, groupId: p.groupId, ...(p.returnId ? { returnId: p.returnId } : {}) },
        dedupe: `shipment:${p.shipmentId}:dispatched`,
      },
    ],
  },
  'shipping.shipment.delivered': {
    sends: (p) => [
      p.kind !== 'return' && {
        topic: 'customer.shipment.delivered',
        to: shopper(p, byOrder(p.orderId)),
        ...guestLink(p, p.orderId),
        link: L('order', p.orderId, 'account/order', 'View order'),
        context: { package: { items: p.lines.map((l) => `${l.title} × ${l.quantity}`).join(', ') } },
        subjects: { orderId: p.orderId, groupId: p.groupId },
        dedupe: `shipment:${p.shipmentId}:delivered`,
      },
    ],
  },
  'shipping.shipment.exception': {
    sends: (p, f) => [
      p.kind !== 'missing_tracking' && {
        topic: 'customer.shipment.exception',
        to: shopper(p, byOrder(p.orderId)),
        ...guestLink(p, p.orderId),
        // no package yet (cannot fulfill, late dispatch): the order screen
        link: p.shipmentId ? L('shipment', p.shipmentId, 'account/tracking', 'See next steps') : L('order', p.orderId, 'account/order', 'See next steps'),
        context: { exception: { kind: f.human(p.kind), action: p.customerAction ?? 'we will update you' }, due: { date: f.dateTime(p.dueAt) } },
        subjects: { orderId: p.orderId, groupId: p.groupId },
        actionRequired: Boolean(p.customerAction),
        deadline: p.customerAction ? p.dueAt : null,
        dedupe: `exception:${p.exceptionId}`,
      },
      {
        topic: 'staff.shipping.exception',
        to: [role('shipping_manager')],
        link: L('order', p.orderId, 'ops/dispatch', 'Open exception'),
        context: { exception: { kind: f.human(p.kind) }, due: { date: f.dateTime(p.dueAt) } },
        subjects: { orderId: p.orderId, groupId: p.groupId },
        deadline: p.dueAt,
        dedupe: `exception:${p.exceptionId}`,
      },
    ],
  },
  'shipping.dispatch.overdue': {
    sends: (p, f) => [
      // Fulfilled by Marketly: the Marketly warehouse is late, not the seller (no seller notice; Warehouse Manager)
      sellerShips(p) &&
        p.sellerId && {
          topic: 'seller.dispatch.overdue',
          to: [seller(p.sellerId)],
          link: sellerOrderLink(p.groupId, p.orderRef),
          context: { order: { ref: p.orderRef }, due: { date: f.dateTime(p.dueAt) } },
          subjects: { orderId: p.orderId, groupId: p.groupId },
          sellerId: p.sellerId,
          deadline: p.dueAt,
          dedupe: `dispatch:${p.groupId}`,
        },
      {
        topic: 'staff.shipping.dispatch_overdue',
        to: [role(p.fulfilledBy === 'marketly_service' ? 'warehouse_manager' : 'shipping_manager')],
        link: p.fulfilledBy === 'marketly_service' ? L('order', p.orderId, 'ops/pick-pack', 'Open pick and pack', p.orderRef) : L('order', p.orderId, 'ops/dispatch', 'Open dispatch queue', p.orderRef),
        context: { order: { ref: p.orderRef }, seller: { name: p.fulfilledBy === 'marketly_service' ? 'The Marketly warehouse (Fulfilled by Marketly)' : p.ownerType === 'official' ? OFFICIAL_STORE_NAME : 'The seller' }, due: { date: f.dateTime(p.dueAt) } },
        subjects: { orderId: p.orderId, groupId: p.groupId },
        deadline: p.dueAt,
        dedupe: `dispatch:${p.groupId}`,
      },
    ],
  },

  /* ---------------------------------------------------------------- returns */
  'returns.return.requested': {
    sends: (p, f) => [
      p.ownerType === 'seller' &&
        p.sellerId && {
          topic: 'seller.return.requested',
          to: [seller(p.sellerId)],
          link: sellerReturnLink(p.returnId, p.ref),
          context: { return: { ref: p.ref, reason: f.human(p.reason) }, due: { date: f.dateTime(p.responseDueAt) } },
          subjects: { returnId: p.returnId, orderId: p.orderId },
          sellerId: p.sellerId,
          deadline: p.responseDueAt,
          dedupe: `return:${p.returnId}:respond`,
        },
      // live topics: Official Store returns go to its staff, action required until approved or rejected (same key)
      p.ownerType === 'official' && {
        topic: 'staff.official_store.return_requested',
        to: [officialStore()],
        link: L('return', p.returnId, 'admin/returns', 'Respond', p.ref),
        context: { return: { ref: p.ref, reason: f.human(p.reason) }, order: { ref: p.orderRef }, due: { date: f.dateTime(p.responseDueAt) } },
        subjects: { returnId: p.returnId, orderId: p.orderId },
        deadline: p.responseDueAt,
        dedupe: `return:${p.returnId}:respond`,
      },
    ],
  },
  'returns.return.info_requested': {
    sends: (p, f) => [
      { topic: 'customer.return.info_requested', to: shopper(p, byReturn(p.returnId)), link: returnLink(p.returnId, p.ref, 'Reply'), context: { due: { date: f.dateTime(p.replyDueAt) } }, subjects: { returnId: p.returnId }, deadline: p.replyDueAt, dedupe: `return:${p.returnId}:info:${p.replyDueAt}` },
    ],
  },
  'returns.return.approved': {
    resolve: (p) => [`return:${p.returnId}:respond`],
    sends: (p, f) => [
      {
        topic: 'customer.return.approved',
        to: shopper(p, byReturn(p.returnId), byOrder(p.orderId)),
        link: returnLink(p.returnId, p.ref),
        context: { return: { ref: p.ref, outcome: p.withoutReturn ? "You don't need to send the item back." : p.dropOffBy ? `Drop the package off by ${f.date(p.dropOffBy)}.` : 'We will send your return label or drop-off instructions.' } },
        subjects: { returnId: p.returnId, orderId: p.orderId },
        deadline: p.dropOffBy ?? null,
        dedupe: `return:${p.returnId}:approved`,
        ...guestLink(p, p.orderId),
      },
    ],
  },
  'returns.return.rejected': {
    resolve: (p) => [`return:${p.returnId}:respond`],
    sends: (p, f) => [
      { topic: 'customer.return.rejected', to: shopper(p, byReturn(p.returnId)), link: returnLink(p.returnId, p.ref, 'Get help'), context: { return: { reason: f.human(p.reasonCode) } }, subjects: { returnId: p.returnId }, dedupe: `return:${p.returnId}:rejected` },
    ],
  },
  'returns.label.created': {
    effects: ['dropOffReminder'],
    sends: (p) => [
      {
        topic: 'customer.return.label_ready',
        to: shopper(p, byReturn(p.returnId), byOrder(p.orderId)),
        link: returnLink(p.returnId, p.ref, 'Get label'),
        context: { return: { ref: p.ref }, order: { ref: p.orderRef } },
        subjects: { returnId: p.returnId, orderId: p.orderId },
        dedupe: `return:${p.returnId}:label:${p.labelId}`,
        ...guestLink(p, p.orderId),
      },
    ],
  },
  'returns.return.received': {
    cancel: (p) => [`return-dropoff:${p.returnId}`],
    sends: (p) => [
      { topic: 'customer.return.received', to: shopper(p, byReturn(p.returnId)), link: returnLink(p.returnId, p.ref), subjects: { returnId: p.returnId }, dedupe: `return:${p.returnId}:received` },
      p.ownerType === 'seller' && p.sellerId && { topic: 'seller.return.received', to: [seller(p.sellerId)], link: sellerReturnLink(p.returnId, p.ref), subjects: { returnId: p.returnId }, sellerId: p.sellerId, dedupe: `return:${p.returnId}:inspect` },
    ],
  },
  'returns.return.inspected': {
    resolve: (p) => [`return:${p.returnId}:inspect`],
    sends: (p, f) => [
      { topic: 'customer.return.inspected', to: shopper(p, byReturn(p.returnId)), link: returnLink(p.returnId, p.ref), context: { return: { outcome: f.human(p.conditionOutcome) } }, subjects: { returnId: p.returnId }, dedupe: `return:${p.returnId}:inspected` },
    ],
  },
  'returns.return.escalated': {
    sends: (p, f) => [
      { topic: 'staff.returns.escalated', to: [role('returns_manager')], link: L('return', p.returnId, 'admin/returns', 'Open return', p.ref), context: { return: { reason: f.human(p.reason) } }, subjects: { returnId: p.returnId, orderId: p.orderId }, dedupe: `return:${p.returnId}:escalated` },
      p.ownerType === 'seller' && p.sellerId && { topic: 'seller.return.escalated', to: [seller(p.sellerId)], link: sellerReturnLink(p.returnId, p.ref), context: { return: { reason: f.human(p.reason) } }, subjects: { returnId: p.returnId, orderId: p.orderId }, sellerId: p.sellerId, dedupe: `return:${p.returnId}:escalated` },
    ],
  },
  'returns.refund.approved': {
    sends: (p, f) => [
      {
        topic: 'customer.refund.approved',
        to: shopper(p, p.returnId ? byReturn(p.returnId) : p.caseId ? byCase(p.caseId) : byOrder(p.orderId), byOrder(p.orderId)),
        // the screen that shows the refund: the return, the case, else the order
        link: p.returnId ? returnLink(p.returnId, p.returnRef, 'Track refund') : p.caseId ? L('case', p.caseId, 'help/case', 'Track refund', p.caseRef) : L('order', p.orderId, 'account/order', 'Track refund', p.orderRef),
        context: { order: { ref: p.orderRef }, refund: { amount: f.money(p.total) } },
        subjects: { orderId: p.orderId, returnId: p.returnId, caseId: p.caseId },
        dedupe: `refund-request:${p.refundRequestId}`,
        ...guestLink(p, p.orderId),
      },
      // live topics: the seller hears of refunds on its orders, unless one of its members approved it themselves
      p.ownerType === 'seller' &&
        p.sellerId &&
        p.approvedBy.kind !== 'seller' && {
          topic: 'seller.refund.approved',
          to: [seller(p.sellerId)],
          // the return, the case, else the order list (the event names no seller order group)
          link: p.returnId ? sellerReturnLink(p.returnId, p.returnRef) : p.caseId ? L('case', p.caseId, 'seller/help', 'View case', p.caseRef) : L('order', p.orderId, 'seller/orders', 'View orders', p.orderRef),
          context: { order: { ref: p.orderRef }, refund: { amount: f.money(p.total) } },
          subjects: { orderId: p.orderId, returnId: p.returnId, caseId: p.caseId },
          sellerId: p.sellerId,
          dedupe: `refund-request:${p.refundRequestId}`,
        },
      p.ownerType === 'official' && {
        topic: 'staff.official_store.refund_approved',
        to: [officialStore()],
        link: p.returnId ? L('return', p.returnId, 'admin/returns', 'View refund', p.returnRef) : p.caseId ? L('case', p.caseId, 'admin/case', 'View refund', p.caseRef) : L('order', p.orderId, 'admin/order', 'View refund', p.orderRef),
        context: { order: { ref: p.orderRef }, refund: { amount: f.money(p.total) } },
        subjects: { orderId: p.orderId, returnId: p.returnId, caseId: p.caseId },
        dedupe: `refund-request:${p.refundRequestId}`,
      },
    ],
  },
  'returns.replacement.created': {
    sends: (p) => [
      {
        topic: 'customer.replacement.created',
        to: shopper(p, byReturn(p.returnId), byOrder(p.orderId)),
        link: orderLink(p.orderId, p.orderRef),
        context: { order: { ref: p.orderRef } },
        subjects: { returnId: p.returnId, orderId: p.orderId },
        dedupe: `replacement:${p.replacementId}`,
        ...guestLink(p, p.orderId),
      },
    ],
  },

  /* ---------------------------------------------------------------- support */
  'support.case.opened': {
    sends: (p, f) => [
      (p.customerId || p.contactEmail) && {
        topic: 'customer.case.opened',
        to: shopper(p),
        link: caseLink(p.caseId, p.ref),
        context: { case: { ref: p.ref }, due: { date: p.nextResponseDueAt ? f.dateTime(p.nextResponseDueAt) : 'the next business day' } },
        subjects: { caseId: p.caseId, orderId: p.orderId },
        dedupe: `case:${p.caseId}`,
      },
      p.sellerId &&
        p.kind !== 'seller_request' && {
          topic: 'seller.case.opened',
          to: [seller(p.sellerId)],
          link: L('case', p.caseId, 'seller/help', 'Respond', p.ref),
          context: { case: { ref: p.ref }, due: { date: p.nextResponseDueAt ? f.dateTime(p.nextResponseDueAt) : 'as soon as possible' } },
          subjects: { caseId: p.caseId, orderId: p.orderId },
          sellerId: p.sellerId,
          actionRequired: p.handler === 'seller',
          deadline: p.handler === 'seller' ? p.nextResponseDueAt : null,
          dedupe: `case:${p.caseId}`,
        },
      // live topics: a seller contacted Marketly (Seller Center › Help). Its team's role answers; action required until
      // a staff owner is assigned, or the case is decided or resolved (support.case.assigned / decided / resolved)
      p.kind === 'seller_request' &&
        (() => {
          const roleKey = TEAM_ROLES[p.team ?? ''] ?? 'seller_manager';
          return {
            topic: 'staff.seller.support_request',
            to: [role(roleKey)],
            link: L('case', p.caseId, 'admin/case', 'Open request', p.ref),
            context: { case: { ref: p.ref, topic: f.human(p.category) }, due: { date: p.nextResponseDueAt ? f.dateTime(p.nextResponseDueAt) : 'the next business day' } },
            subjects: { caseId: p.caseId, orderId: p.orderId },
            group: ROLE_AREA[roleKey] ?? 'Sellers',
            // opened with a staff owner already (a staff member opened it for the seller): nothing left to pick up
            actionRequired: !p.ownerStaffId,
            deadline: p.ownerStaffId ? null : (p.nextResponseDueAt ?? null),
            dedupe: `seller-request:${p.caseId}`,
          };
        })(),
    ],
  },
  'support.case.message_added': {
    sends: (p) => [
      p.audience !== 'internal' &&
        p.audience !== 'seller' &&
        p.authorRole !== 'customer' && { topic: 'customer.case.reply', to: shopper(p, byCase(p.caseId)), link: caseLink(p.caseId), subjects: { caseId: p.caseId }, replyTo: { module: 'support', refId: p.caseId }, dedupe: `case-message:${p.messageId}` },
      // the case's seller (Official Store cases have none; an event without the field falls back to earlier seller notices)
      p.audience !== 'internal' &&
        p.audience !== 'customer' &&
        p.authorRole !== 'seller' && {
          topic: 'seller.case.reply',
          to: [p.sellerId ? seller(p.sellerId) : sellerByCase(p.caseId)],
          link: L('case', p.caseId, 'seller/help', 'View reply'),
          subjects: { caseId: p.caseId },
          sellerId: p.sellerId ?? null,
          replyTo: { module: 'support', refId: p.caseId },
          dedupe: `case-message:${p.messageId}`,
        },
    ],
  },
  'support.case.escalated': {
    sends: (p, f) => {
      const roleKey = CASE_TEAMS[p.to] ?? (p.to in ROLE_AREA ? p.to : 'customer_support_manager');
      return [
        {
          topic: 'staff.case.escalated',
          to: [role(roleKey)],
          link: L('case', p.caseId, 'admin/case', 'Open case', p.ref),
          context: { case: { ref: p.ref }, escalation: { reason: f.human(p.reason) } },
          subjects: { caseId: p.caseId, orderId: p.orderId },
          group: ROLE_AREA[roleKey] ?? 'Support',
          dedupe: `case:${p.caseId}:escalated:${p.to}`,
        },
      ];
    },
  },
  'support.case.overdue': {
    sends: (p, f) => [
      { topic: 'staff.case.overdue', to: [role('customer_support_manager')], link: L('case', p.caseId, 'admin/case', 'Open case'), context: { due: { date: f.dateTime(p.dueAt) } }, subjects: { caseId: p.caseId }, deadline: p.dueAt, dedupe: `case:${p.caseId}:overdue:${p.dueAt}` },
    ],
  },
  'support.case.decided': {
    // seller-request: the staff notice of a seller's support request (live topics)
    resolve: (p) => [`case:${p.caseId}`, `seller-request:${p.caseId}`],
    // decided without notifying the parties (notifyParties false): nothing is sent
    sends: (p, f) => [
      p.notified !== false && {
        topic: 'customer.case.decided',
        to: shopper(p, byCase(p.caseId)),
        link: caseLink(p.caseId, p.ref),
        context: { case: { ref: p.ref, outcome: f.human(p.outcome) }, appeal: { deadline: p.appealDeadline ? f.date(p.appealDeadline) : 'the date shown in the case' } },
        subjects: { caseId: p.caseId, orderId: p.orderId, returnId: p.returnId },
        dedupe: `case:${p.caseId}:decided:${p.final}`,
      },
      p.notified !== false &&
      p.sellerId && {
        topic: 'seller.case.decided',
        to: [seller(p.sellerId)],
        link: L('case', p.caseId, 'seller/help', 'View decision', p.ref),
        context: { case: { ref: p.ref, outcome: f.human(p.outcome) }, appeal: { deadline: p.appealDeadline ? f.date(p.appealDeadline) : 'the date shown in the case' } },
        subjects: { caseId: p.caseId, orderId: p.orderId },
        sellerId: p.sellerId,
        dedupe: `case:${p.caseId}:decided:${p.final}`,
      },
    ],
  },
  'support.case.resolved': {
    resolve: (p) => [`case:${p.caseId}`, `seller-request:${p.caseId}`],
    sends: (p) => [{ topic: 'customer.case.resolved', to: shopper(p, byCase(p.caseId)), link: caseLink(p.caseId, p.ref), context: { case: { ref: p.ref } }, subjects: { caseId: p.caseId }, dedupe: `case:${p.caseId}:resolved` }],
  },
  // live topics: a staff owner picked up the seller's support request
  'support.case.assigned': { resolve: (p) => [`seller-request:${p.caseId}`] },

  /* ---------------------------------------------------------------- messaging */
  'messaging.message.sent': {
    // the Official Store team answered: its staff notice for the conversation is done
    resolve: (p) => [officialStoreConversation(p) && (p.authorKind === 'staff' || p.authorKind === 'seller') ? `official-store:${p.conversationId}` : null],
    sends: (p) => {
      const from = p.authorKind === 'seller' ? 'the seller' : p.authorKind === 'customer' ? 'a customer' : 'Marketly';
      const toOfficialStore = officialStoreConversation(p) && (p.recipientKinds.includes('official_store') || p.recipientKinds.includes('seller'));
      return [
        // messages to the Official Store go to its staff (Official Store Manager role), action required until answered
        toOfficialStore && {
          topic: 'staff.official_store.message_received',
          to: [role('official_store_manager')],
          link: L('conversation', p.conversationId, 'admin/official', 'Reply'),
          context: { message: { from: p.authorKind === 'customer' || p.authorKind === 'guest' ? 'A customer' : from } },
          subjects: { conversationId: p.conversationId, orderId: p.orderId },
          dedupe: `official-store:${p.conversationId}`,
          actionRequired: true,
        },
        p.recipientKinds.includes('customer') &&
          p.customerId && {
            topic: 'customer.message.new',
            to: [customer(p.customerId)],
            link: L('conversation', p.conversationId, 'account/messages', 'Read message'),
            context: { message: { from } },
            subjects: { conversationId: p.conversationId, orderId: p.orderId },
            replyTo: { module: 'messaging', refId: p.conversationId },
            dedupe: `message:${p.messageId}`,
          },
        p.recipientKinds.includes('seller') &&
          p.sellerId &&
          !officialStoreConversation(p) && {
            topic: 'seller.message.new',
            to: [seller(p.sellerId)],
            link: L('conversation', p.conversationId, 'seller/customers', 'Reply'),
            context: { message: { from } },
            subjects: { conversationId: p.conversationId, orderId: p.orderId },
            sellerId: p.sellerId,
            replyTo: { module: 'messaging', refId: p.conversationId },
            dedupe: `message:${p.messageId}`,
          },
      ];
    },
  },

  /* ---------------------------------------------------------------- sellers */
  'sellers.application.submitted': {
    sends: (p) => [{ topic: 'staff.seller.application_submitted', to: [role('seller_manager')], link: L('seller', p.sellerId, 'admin/seller-application', 'Review application'), dedupe: `seller-application:${p.applicationId}` }],
  },
  'sellers.application.information_requested': {
    sends: (p, f) => [
      { topic: 'seller.application.information_requested', to: [seller(p.sellerId)], link: L('seller', p.applicationId, 'sell/status', 'Answer now'), context: { due: { date: f.dateTime(p.dueAt) } }, sellerId: p.sellerId, deadline: p.dueAt, dedupe: `seller-application:${p.applicationId}:info` },
    ],
  },
  'sellers.application.information_reminder': {
    // a reminder about the same request: resolved with it when the application is decided
    sends: (p, f) => [
      {
        topic: 'seller.application.information_reminder',
        to: [seller(p.sellerId)],
        link: L('seller', p.applicationId, 'sell/status', 'Answer now', p.ref),
        context: { due: { date: f.dateTime(p.dueAt) }, application: { openItems: p.openItems } },
        sellerId: p.sellerId,
        deadline: p.dueAt,
        dedupe: `seller-application:${p.applicationId}:info`,
      },
    ],
  },
  'sellers.application.decided': {
    resolve: (p) => [`seller-application:${p.applicationId}`, `seller-application:${p.applicationId}:info`],
    sends: (p) => [
      { topic: 'seller.application.decided', to: [seller(p.sellerId)], link: L('seller', p.applicationId, 'sell/status', 'See next steps'), context: { change: { outcome: p.outcome } }, sellerId: p.sellerId, dedupe: `seller-application:${p.applicationId}:decided` },
    ],
  },
  'sellers.seller.restricted': {
    sends: (p, f) => [
      {
        topic: 'seller.account.restricted',
        to: [seller(p.sellerId)],
        link: accountHealth(p.restrictionId),
        context: { restriction: { reason: p.reason, activities: p.affectedActivities.map((a) => f.human(a)).join(', ') }, appeal: { deadline: f.date(p.appealDeadline) } },
        sellerId: p.sellerId,
        dedupe: `restriction:${p.restrictionId}`,
      },
    ],
  },
  'sellers.seller.suspended': {
    sends: (p, f) => [
      { topic: 'seller.account.suspended', to: [seller(p.sellerId)], link: accountHealth(p.suspensionId), context: { restriction: { reason: p.reason }, appeal: { deadline: f.date(p.appealDeadline) } }, sellerId: p.sellerId, dedupe: `suspension:${p.suspensionId}` },
    ],
  },
  'sellers.seller.reinstated': {
    sends: (p) => [
      { topic: 'seller.account.reinstated', to: [seller(p.sellerId)], link: accountHealth(p.liftedRestrictionId ?? p.endedSuspensionId ?? p.sellerId), sellerId: p.sellerId, dedupe: `reinstated:${p.sellerId}:${p.liftedRestrictionId ?? p.endedSuspensionId ?? p.to}` },
    ],
  },
  'sellers.warning.issued': {
    sends: (p) => [{ topic: 'seller.account.warning', to: [seller(p.sellerId)], link: accountHealth(p.warningId), context: { warning: { title: p.title } }, sellerId: p.sellerId, dedupe: `warning:${p.warningId}` }],
  },
  'sellers.appeal.decided': {
    resolve: (p) => [`seller-appeal:${p.appealId}`],
    sends: (p, f) => [{ topic: 'seller.appeal.decided', to: [seller(p.sellerId)], link: L('appeal', p.appealId, 'seller/performance', 'View appeal'), context: { appeal: { outcome: f.human(p.outcome) } }, sellerId: p.sellerId, dedupe: `appeal:${p.appealId}` }],
  },
  'sellers.payout_account.changed': {
    sends: (p) => [
      { topic: 'seller.payout_account.changed', to: [seller(p.sellerId)], link: L('payout_account', p.changeId, 'seller/finance', 'Review payout settings'), context: { destination: { label: p.label } }, sellerId: p.sellerId, dedupe: `payout-account:${p.changeId}` },
      // a change of an existing account waits for the Finance review (the first account is verified by its test deposits)
      !p.isInitial && {
        topic: 'staff.finance.payout_account_review',
        to: [role('finance_manager')],
        link: L('payout_account', p.sellerId, 'admin/payouts', 'Review change'),
        context: { seller: { id: p.sellerId }, payout: { from: p.previousLabel ?? 'the previous account', to: p.label } },
        dedupe: `payout-account-review:${p.sellerId}`,
      },
    ],
  },
  'sellers.change_request.decided': {
    resolve: (p) => [`change-request:${p.changeRequestId}`],
    sends: (p, f) => [
      {
        topic: 'seller.change_request.decided',
        to: [seller(p.sellerId)],
        link: L('change_request', p.changeRequestId, 'seller/store', 'View request'),
        context: { change: { kind: f.human(p.kind), outcome: p.approved ? 'approved' : 'rejected' } },
        sellerId: p.sellerId,
        dedupe: `change-request:${p.changeRequestId}`,
      },
    ],
  },
  'sellers.verification.changed': {
    sends: (p, f) => [
      { topic: 'seller.verification.changed', to: [seller(p.sellerId)], link: L('seller', p.sellerId, 'seller/performance', 'View verification'), context: { verification: { state: f.human(p.state) } }, sellerId: p.sellerId, dedupe: `verification:${p.sellerId}:${p.state}` },
    ],
  },
  'sellers.launch_review.decided': {
    resolve: (p) => [`launch-review:${p.sellerId}`],
    sends: (p) => [
      {
        topic: 'seller.launch_review.decided',
        to: [seller(p.sellerId)],
        link: L('seller', p.sellerId, 'seller/setup', 'View launch checklist'),
        context: { review: { outcome: p.outcome === 'passed' ? 'passed' : 'needs changes' } },
        sellerId: p.sellerId,
        dedupe: `launch-review:${p.sellerId}:${p.decidedAt}`,
      },
    ],
  },
  'sellers.invitation.sent': {
    // sensitive topic: the code is rendered into the email only (no in-app notice; the delivery log keeps a redacted subject)
    sends: (p, f) => [
      {
        topic: 'seller.application.invitation',
        to: [{ kind: 'email', email: p.email, recipientKind: 'guest_email' }],
        link: L('seller_invitation', p.invitationId, 'sell/apply', 'Start your application'),
        context: { invite: { business: p.businessName, code: p.code, expires: f.date(p.expiresAt) } },
        dedupe: `seller-invitation:${p.invitationId}`,
      },
    ],
  },

  /* ---------------------------------------------------------------- finance (destinations), catalog, inventory */
  'finance.destination.verified': {
    resolve: (p) => [`payout-account-review:${p.sellerId}`],
    sends: (p) => [{ topic: 'seller.payout_destination.verified', to: [seller(p.sellerId)], link: L('payout_account', p.reviewId, 'seller/finance', 'View payout settings'), sellerId: p.sellerId, dedupe: `destination:${p.reviewId}` }],
  },
  'finance.destination.rejected': {
    resolve: (p) => [`payout-account-review:${p.sellerId}`],
    sends: (p) => [
      { topic: 'seller.payout_destination.rejected', to: [seller(p.sellerId)], link: L('payout_account', p.reviewId, 'seller/finance', 'Update payout settings'), context: { destination: { reason: p.reason } }, sellerId: p.sellerId, dedupe: `destination:${p.reviewId}` },
    ],
  },
  'catalog.product.changes_requested': {
    resolve: (p) => [`product-review:${p.productId}`],
    sends: (p) => [
      p.ownerSellerId && {
        topic: 'seller.product.changes_requested',
        to: [seller(p.ownerSellerId)],
        link: L('product', p.productId, 'seller/product-new', 'Fix product'),
        context: { product: { reason: [p.reason, ...Object.entries(p.fields ?? {}).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('; ') } },
        sellerId: p.ownerSellerId,
        dedupe: `product:${p.productId}:changes`,
      },
    ],
  },
  'catalog.product.approved': {
    resolve: (p) => [`product:${p.productId}:changes`, `product-review:${p.productId}`],
    sends: (p) => [p.ownerSellerId && { topic: 'seller.product.approved', to: [seller(p.ownerSellerId)], link: L('product', p.productId, 'seller/product-new', 'View product'), sellerId: p.ownerSellerId, dedupe: `product:${p.productId}:approved` }],
  },
  'catalog.product.rejected': {
    resolve: (p) => [`product:${p.productId}:changes`, `product-review:${p.productId}`],
    sends: (p) => [
      p.ownerSellerId && { topic: 'seller.product.rejected', to: [seller(p.ownerSellerId)], link: L('product', p.productId, 'seller/product-new', 'View product'), context: { product: { reason: p.reason } }, sellerId: p.ownerSellerId, dedupe: `product:${p.productId}:rejected` },
    ],
  },
  'catalog.images.recrop_needed': {
    sends: (p) => [
      {
        topic: 'seller.product.recrop_needed',
        to: [seller(p.sellerId)],
        // one product: open it; several: the product list
        link: p.productIds.length === 1 ? L('product', p.productIds[0]!, 'seller/product-new', 'Re-crop images') : L('products', p.sellerId, 'seller/products', 'Review products'),
        context: { recrop: { products: p.productIds.length, images: p.imageCount, ratio: p.aspectRatio } },
        sellerId: p.sellerId,
        dedupe: `recrop:${p.sellerId}:${p.aspectRatio}:${[...p.productIds].sort()[0]}:${p.productIds.length}`,
      },
    ],
  },
  'inventory.stock.low_digest': {
    sends: (p, f) => {
      const shown = p.items.slice(0, 5).map((i) => `${i.label} (${i.state === 'out_of_stock' ? 'out of stock' : `${i.available} left`})`);
      const more = p.items.length > shown.length ? `; and ${p.lowCount + p.outOfStockCount - shown.length} more` : '';
      const context = { digest: { low: p.lowCount, out: p.outOfStockCount, lines: `${shown.join('; ')}${more}`, date: f.date(`${p.date}T12:00:00Z`) } };
      return [
        p.ownerType === 'official' && { topic: 'staff.inventory.low_stock_digest', to: [role('inventory_manager')], link: L('stock', p.date, 'ops/inventory', 'Open stock'), context, dedupe: `stock-digest:official:${p.date}` },
        p.ownerType === 'seller' &&
          p.sellerId && { topic: 'seller.stock.low_digest', to: [seller(p.sellerId)], link: L('stock', p.date, 'seller/inventory', 'Review stock'), context, sellerId: p.sellerId, dedupe: `stock-digest:${p.sellerId}:${p.date}` },
      ];
    },
  },
  'inventory.stock.low': {
    sends: (p) => [
      // Fulfilled by Marketly stock: fulfillment-service sends seller.fulfillment.stock_low instead
      p.ownerType !== 'official' &&
        !p.serviceManaged &&
        p.sellerId && { topic: 'seller.stock.low', to: [seller(p.sellerId)], link: L('stock', p.stockItemId, 'seller/inventory', 'Update stock', p.sku), context: { stock: { label: p.label, available: p.available } }, sellerId: p.sellerId, dedupe: `stock:${p.stockItemId}` },
      p.ownerType === 'official' && { topic: 'staff.inventory.stock_shortage', to: [role('inventory_manager')], link: L('stock', p.stockItemId, 'ops/inventory', 'Open stock', p.sku), context: { stock: { label: p.label, available: p.available } }, dedupe: `stock:${p.stockItemId}` },
    ],
  },

  /* ---------------------------------------------------------------- finance */
  'finance.payout.paid': {
    resolve: (p) => [`payout:${p.payoutId}`],
    sends: (p, f) => [
      { topic: 'seller.payout.paid', to: [seller(p.sellerId)], link: L('payout', p.payoutId, 'seller/finance', 'View payout', p.ref), context: { payout: { ref: p.ref, amount: f.money(p.amount) } }, sellerId: p.sellerId, dedupe: `payout:${p.payoutId}:paid` },
    ],
  },
  'finance.payout.failed': {
    sends: (p, f) => [
      { topic: 'seller.payout.failed', to: [seller(p.sellerId)], link: L('payout', p.payoutId, 'seller/finance', 'Fix payout settings', p.ref), context: { payout: { ref: p.ref, amount: f.money(p.amount), reason: p.failureReason } }, sellerId: p.sellerId, dedupe: `payout:${p.payoutId}` },
      { topic: 'staff.finance.payout_failed', to: [role('finance_manager')], link: L('payout', p.payoutId, 'admin/payouts', 'Open payout', p.ref), context: { payout: { ref: p.ref, amount: f.money(p.amount), reason: p.failureReason } }, dedupe: `payout:${p.payoutId}` },
    ],
  },
  'finance.hold.placed': {
    sends: (p, f) => [
      { topic: 'seller.hold.placed', to: [seller(p.sellerId)], link: L('hold', p.holdId, 'seller/finance', 'View hold'), context: { hold: { amount: f.money(p.amount), reason: p.reason, reviewDate: f.date(p.reviewDate) } }, sellerId: p.sellerId, dedupe: `hold:${p.holdId}:placed` },
    ],
  },
  'finance.hold.released': {
    sends: (p, f) => [{ topic: 'seller.hold.released', to: [seller(p.sellerId)], link: L('hold', p.holdId, 'seller/finance', 'View balance'), context: { hold: { amount: f.money(p.amount) } }, sellerId: p.sellerId, dedupe: `hold:${p.holdId}:released` }],
  },
  'finance.balance.negative': {
    sends: (p, f) => [
      { topic: 'seller.balance.negative', to: [seller(p.sellerId)], link: L('balance', p.sellerId, 'seller/finance', 'View balance', p.cause.ref), context: { balance: { amount: f.money(p.available) } }, sellerId: p.sellerId, dedupe: `balance:${p.sellerId}:${p.cause.id}` },
      { topic: 'staff.finance.balance_negative', to: [role('finance_manager')], link: L('seller', p.sellerId, 'admin/seller', 'Open balance', p.cause.ref), context: { balance: { amount: f.money(p.available) } }, dedupe: `balance:${p.sellerId}:${p.cause.id}` },
    ],
  },
  'finance.statement.issued': {
    sends: (p, f) => [
      { topic: 'seller.statement.issued', to: [seller(p.sellerId)], link: L('statement', p.statementId, 'seller/statement', 'View statement'), context: { statement: { period: `${f.date(p.period.from)}–${f.date(p.period.to)}` } }, sellerId: p.sellerId, dedupe: `statement:${p.statementId}` },
    ],
  },
  'finance.reconciliation.mismatch_found': {
    sends: (p, f) => [
      { topic: 'staff.finance.reconciliation_mismatch', to: [role('finance_manager')], link: L('reconciliation', p.itemId, 'ops/finance-checks', 'Open finance checks'), context: { mismatch: { check: f.human(p.check), difference: f.money(p.difference) } }, dedupe: `reconciliation:${p.itemId}` },
    ],
  },

  /* ---------------------------------------------------------------- promotions, advertising, reviews, trust, wishlist */
  'promotions.participation.invited': {
    sends: (p, f) =>
      p.sellerIds.map((sellerId) => ({
        topic: 'seller.promotion.invited',
        to: [seller(sellerId)],
        link: L('campaign', p.campaignId, 'seller/marketing', 'Review invitation'),
        context: { campaign: { respondBy: f.date(p.respondBy) } },
        sellerId,
        deadline: p.respondBy,
        dedupe: `campaign:${p.campaignId}:invite`,
      })),
  },
  'advertising.campaign.status_changed': {
    resolve: (p) => [REVIEW_STATES.has(p.from) && !REVIEW_STATES.has(p.to) ? `ad-campaign:${p.campaignId}:review` : null],
    sends: (p, f) => [
      p.sellerId &&
        p.advertiserKind === 'seller' &&
        !REVIEW_STATES.has(p.to) && {
          topic: 'seller.advertising.campaign_status',
          to: [seller(p.sellerId)],
          link: L('campaign', p.campaignId, 'seller/marketing', 'View campaign'),
          context: { campaign: { status: f.human(p.to) } },
          sellerId: p.sellerId,
          dedupe: `ad-campaign:${p.campaignId}:${p.to}`,
        },
      REVIEW_STATES.has(p.to) && { topic: 'staff.advertising.approval_waiting', to: [role('advertising_manager'), role('content_manager')], link: L('campaign', p.campaignId, 'admin/ad-campaign', 'Review campaign'), dedupe: `ad-campaign:${p.campaignId}:review` },
    ],
  },
  'reviews.invite.due': {
    sends: (p) => [{ topic: 'customer.review.invite', to: [customer(p.customerId)], link: L('product', p.productId, 'account/review', 'Write a review'), dedupe: `review-invite:${p.orderItemId}` }],
  },
  'reviews.report.created': {
    sends: (p, f) => [
      { topic: 'staff.moderation.report', to: [role('content_manager')], link: L('report', p.reportId, 'admin/reviews', 'Open moderation queue'), context: { report: { type: f.human(p.reason) } }, dedupe: `review-report:${p.reportId}` },
    ],
  },

  /* ---------------------------------------------------------------- live topics: reviews, feedback, questions (2026-10-20)
   * Sellers hear about new reviews, feedback and questions on their products and store; the Official Store's go to
   * its staff. Reviews and feedback are published again after an edit or a moderation decision: `once` sends each
   * only the first time. */
  'reviews.review.published': {
    sends: (p) => {
      const official = p.sellerId === OFFICIAL_STORE_ID;
      const dedupe = `review:${p.reviewId}:new`;
      return [
        !official && { topic: 'seller.review.new', to: [seller(p.sellerId)], link: L('review', p.reviewId, 'seller/customers', 'View review'), context: reviewContext(p), sellerId: p.sellerId, dedupe, once: true },
        official && { topic: 'staff.official_store.review_new', to: [officialStore()], link: L('review', p.reviewId, 'admin/official', 'View review'), context: reviewContext(p), dedupe, once: true },
      ];
    },
  },
  'reviews.feedback.published': {
    sends: (p, f) => {
      const official = p.sellerId === OFFICIAL_STORE_ID;
      const dedupe = `feedback:${p.feedbackId}:new`;
      const subjects = { orderId: p.orderId };
      return [
        !official && { topic: 'seller.feedback.new', to: [seller(p.sellerId)], link: L('feedback', p.feedbackId, 'seller/customers', 'View feedback'), context: feedbackContext(p, f), subjects, sellerId: p.sellerId, dedupe, once: true },
        official && { topic: 'staff.official_store.feedback_new', to: [officialStore()], link: L('feedback', p.feedbackId, 'admin/official', 'View feedback'), context: feedbackContext(p, f), subjects, dedupe, once: true },
      ];
    },
  },
  'reviews.question.asked': {
    // one action notice per answering party (each seller with an offer, the Official Store's staff), resolved when that party answers
    sends: (p) => [
      ...p.sellerIds
        .filter((sellerId) => sellerId !== OFFICIAL_STORE_ID)
        .map((sellerId) => ({ topic: 'seller.question.asked', to: [seller(sellerId)], link: L('question', p.questionId, 'seller/customers', 'Answer'), sellerId, dedupe: questionKey(p.questionId, sellerId) })),
      p.officialStore && { topic: 'staff.official_store.question_asked', to: [officialStore()], link: L('question', p.questionId, 'admin/official', 'Answer'), dedupe: questionKey(p.questionId, 'official-store') },
    ],
  },
  'reviews.answer.published': {
    // a customer's answer helps the shopper but leaves the seller's question open
    resolve: (p) => [
      p.label === 'seller' && p.sellerId ? questionKey(p.questionId, p.sellerId === OFFICIAL_STORE_ID ? 'official-store' : p.sellerId) : null,
      p.label === 'marketly_staff' ? questionKey(p.questionId, 'official-store') : null,
    ],
  },
  'trust.report.created': {
    sends: (p, f) => [
      { topic: 'staff.trust.report', to: [role('trust_and_risk_manager')], link: L('report', p.reportId, 'admin/trust', 'Open report', p.ref), context: { report: { ref: p.ref, type: f.human(p.type) } }, dedupe: `trust-report:${p.reportId}` },
    ],
  },
  'wishlist.alert.triggered': {
    sends: (p, f) => [
      {
        topic: 'customer.wishlist.alert',
        to: [customer(p.customerId)],
        link: L('product', p.productId, 'store/product', 'View product'),
        context: { wishlist: { product: p.kind === 'back_in_stock' ? 'An item on your wishlist is back in stock' : 'An item on your wishlist', price: p.price ? f.money(p.price) : 'available again' } },
        dedupe: `wishlist:${p.alertId}`,
      },
    ],
  },

  /* ---------------------------------------------------------------- services (department pages) */
  'services.request.status_changed': {
    // the customer made the request themselves: they hear about what the provider or staff do with it
    sends: (p) =>
      p.status === 'requested'
        ? []
        : [
            {
              topic: 'customer.services.request',
              // services keeps customers by their account id (the store principal's accountId), not a customers record id
              to: [{ kind: 'customer', accountId: p.customerId }],
              link: L('service_request', p.requestId, 'store/my-request', 'View request', p.ref),
              context: { request: { ref: p.ref, status: REQUEST_STATUS[p.status] ?? p.status.replace('_', ' ') } },
              dedupe: `service-request:${p.requestId}:${p.status}`,
            },
          ],
  },

  /* ---------------------------------------------------------------- access */
  'access.approval.requested': {
    effects: ['approvalDueReminder'],
    sends: (p, f) => {
      const approvers = [p.nominatedReviewerId, ...p.eligibleAccountIds].filter((x): x is string => Boolean(x));
      return [
        {
          topic: 'staff.approval.waiting',
          to: approvers.length ? [...new Set(approvers)].map((id) => staff(id, 'approver')) : p.eligibleRoleKeys.map(role),
          link: L('approval', p.requestId, 'admin/inbox', 'Review request', p.ref),
          context: { approval: { summary: p.summary, by: p.requestedBy.name ?? 'A colleague' }, due: { date: p.dueAt ? f.dateTime(p.dueAt) : 'soon' } },
          deadline: p.dueAt ?? null,
          dedupe: `approval:${p.requestId}`,
        },
      ];
    },
  },
  'access.approval.partially_approved': {
    sends: (p) => [
      {
        topic: 'staff.approval.second_needed',
        to: p.eligibleAccountIds.map((id) => staff(id, 'approver')),
        link: L('approval', p.requestId, 'admin/inbox', 'Review request', p.target.ref),
        context: { approval: { summary: p.target.label ?? p.actionKey, by: p.approvedBy.name ?? 'An approver' } },
        dedupe: `approval:${p.requestId}`,
      },
    ],
  },
  'access.approval.returned': {
    resolve: (p) => [`approval:${p.requestId}`],
    sends: (p) => [
      {
        topic: 'staff.approval.returned',
        to: [staff(p.requestedById, 'requester')],
        link: L('approval', p.requestId, 'admin/inbox', 'Update request', p.target.ref),
        context: { approval: { by: p.by.name ?? 'An approver', comment: p.comment } },
        dedupe: `approval:${p.requestId}`,
      },
    ],
  },
  'access.approval.decided': {
    resolve: (p) => [`approval:${p.requestId}`],
    cancel: (p) => [`approval:${p.requestId}`],
    sends: (p) => [
      {
        topic: 'staff.approval.decided',
        to: [staff(p.requestedById, 'requester')],
        link: L('approval', p.requestId, 'admin/inbox', 'View request', p.ref),
        context: { approval: { outcome: p.outcome } },
        dedupe: `approval:${p.requestId}:decided`,
      },
    ],
  },
  'access.approval.reminder_sent': {
    sends: (p) => [
      { topic: 'staff.approval.reminder', to: p.toAccountIds.map((id) => staff(id, 'approver')), link: L('approval', p.requestId, 'admin/inbox', 'Review request'), context: { approval: { comment: p.message ?? '' } }, dedupe: `approval:${p.requestId}` },
    ],
  },
  'access.coverage.changed': { effects: ['reroute'] },
  'access.away.ended': { effects: ['awayEnded'] },

  /* ---------------------------------------------------------------- workqueues */
  'workqueues.item.overdue': {
    sends: (p, f) => [
      {
        topic: 'staff.queue.item_overdue',
        to: [staff(p.leadId, 'lead'), staff(p.backupId, 'backup'), staff(p.assigneeId, 'direct')],
        link: L('queue', p.itemId, 'ops/queues', 'Open queue', p.subjectRef),
        context: { queue: { item: p.subjectRef ?? f.human(p.kind), name: f.human(p.queueKey) }, due: { date: f.dateTime(p.dueAt) } },
        group: queueArea(p.queueKey),
        deadline: p.dueAt,
        dedupe: `workitem:${p.itemId}`,
      },
    ],
  },
  'workqueues.item.escalated': {
    sends: (p, f) => [
      {
        topic: 'staff.queue.item_escalated',
        to: [p.toKind === 'role' ? role(p.to) : staff(p.to, 'direct')],
        link: L('queue', p.itemId, 'ops/queues', 'Open queue'),
        context: { queue: { name: f.human(p.queueKey) }, escalation: { reason: p.reason } },
        group: queueArea(p.queueKey),
        dedupe: `workitem:${p.itemId}`,
      },
    ],
  },
  'workqueues.item.resolved': { resolve: (p) => [`workitem:${p.itemId}`] },

  /* ---------------------------------------------------------------- settings, audit, reports */
  'settings.change.scheduled': {
    sends: (p, f) => [
      p.sellerVisible && {
        topic: 'seller.platform.change_scheduled',
        to: [{ kind: 'all_sellers' }],
        link: L('setting_change', p.changeId, 'seller/help', 'View change', p.ref),
        context: { change: { summary: p.summary, effective: f.date(p.effectiveAt) } },
        dedupe: `setting-change:${p.changeId}`,
      },
    ],
  },
  'audit.integrity.failed': {
    sends: (p) => [
      { topic: 'staff.audit.integrity_failed', to: [role('platform_administrator'), role('business_owner')], link: L('audit', String(p.brokenAtSeq), 'admin/audit', 'Open action history'), context: { integrity: { seq: p.brokenAtSeq } }, dedupe: `integrity:${p.brokenAtSeq}` },
    ],
  },
  'reports.export.ready': {
    sends: (p, f) => [
      p.requestedBy.kind === 'staff' &&
        p.requestedBy.id && { topic: 'staff.export.ready', to: [staff(p.requestedBy.id)], link: L('export', p.exportId, 'admin/reports', 'Download'), context: { export: { expires: f.date(p.expiresAt) } }, dedupe: `report-export:${p.exportId}` },
      p.requestedBy.kind === 'seller' &&
        p.requestedBy.id && {
          topic: 'seller.export.ready',
          to: [{ kind: 'account_email', accountId: p.requestedBy.id, recipientKind: 'seller_member' }],
          link: L('export', p.exportId, 'seller/reports', 'Download'),
          context: { export: { expires: f.date(p.expiresAt) } },
          dedupe: `report-export:${p.exportId}`,
        },
    ],
  },
  'reports.scheduled_report.ready': {
    // phase 2 topic, staff only: each recipient gets the export requested in their name (only they can download it)
    sends: (p, f) => {
      const context = { report: { title: p.reportTitle, period: p.periodLabel, format: p.format.toUpperCase() }, export: { expires: f.date(p.expiresAt) } };
      const seen = new Set<string>();
      return (p.deliveries as { staffId?: unknown; exportId?: unknown }[]).map((d) => {
        const staffId = typeof d?.staffId === 'string' ? d.staffId : null;
        const exportId = typeof d?.exportId === 'string' ? d.exportId : null;
        if (!staffId || !exportId || seen.has(staffId)) return null;
        seen.add(staffId);
        return { topic: 'staff.report.scheduled', to: [staff(staffId)], link: L('export', exportId, 'admin/reports', 'Download'), context, dedupe: `scheduled-report:${exportId}` };
      });
    },
  },

  /* ---------------------------------------------------------------- purchasing, wallet, workqueues day end */
  'purchasing.purchase_order.sent': {
    sends: (p, f) => {
      // only when the buyer asked for it and the supplier has an address; the Purchasing Manager role gets the in-app copy
      if (!p.emailSupplier || !p.supplierEmail) return [];
      const context = {
        po: {
          ref: p.ref,
          total: f.money(p.total),
          lines: p.lines.map((l) => `${l.label} (${l.sku}) × ${l.quantityOrdered}`).join('; '),
          message: p.message?.trim() ? `Message from your buyer: ${p.message.trim()}` : '',
          shipTo: shipToText(p.shipTo),
        },
        supplier: { name: p.supplierName },
      };
      const dedupe = `purchase-order:${p.purchaseOrderId}:sent`;
      return [
        { topic: 'supplier.purchase_order.sent', to: [external(p.supplierEmail, p.supplierName)], link: L('purchase_order', p.purchaseOrderId, 'admin/purchasing', undefined, p.ref), context, dedupe },
        { topic: 'staff.purchasing.po_sent', to: [role('purchasing_manager')], link: L('purchase_order', p.purchaseOrderId, 'admin/purchasing', 'Open purchase order', p.ref), context, dedupe },
      ];
    },
  },
  'wallet.credit.expiring': {
    sends: (p, f) => [
      {
        topic: 'customer.credit.expiring',
        to: [customer(p.customerId)],
        link: L('store_credit', p.lotId, 'account/coupons', 'Shop now'),
        context: { credit: { amount: f.money(p.amount), expires: f.date(p.expiresAt), days: p.daysLeft } },
        dedupe: `credit-expiring:${p.lotId}:${p.expiresAt}`,
      },
    ],
  },
  'workqueues.day_end.prepared': {
    sends: (p, f) => [
      {
        topic: 'staff.day_end.summary',
        to: [...new Set(p.roleKeys)].map(role),
        link: L('day_end', p.reviewId, 'ops/queues', 'Open day-end review'),
        // a calendar date: read at midday so the market time zone keeps the same day
        context: { dayend: { date: f.date(`${p.date}T12:00:00Z`), open: p.openItems, overdue: p.overdueItems }, due: { date: f.dateTime(p.dueAt) } },
        deadline: p.dueAt,
        dedupe: `day-end:${p.reviewId}`,
      },
    ],
  },
  // invited seller members are kept by app/preferences.ts (G49a); these events send nothing
  'sellers.member.invited': {},
  'sellers.member.joined': {},
  'sellers.member.removed': {},
  'workqueues.day_end.completed': {
    // the review is done: the "day-end review is open" action notices are resolved
    resolve: (p) => [`day-end:${p.reviewId}`],
    sends: (p, f) => {
      const lines = (p.items as { title?: unknown; summary?: unknown; note?: unknown }[])
        .filter((i) => i && typeof i.note === 'string' && i.note.trim())
        .map((i) => `${typeof i.title === 'string' ? i.title : 'Item'}: ${String(i.note).trim()}`);
      return [
        {
          topic: 'staff.day_end.completed',
          to: [...new Set(p.roleKeys)].map(role),
          link: L('day_end', p.reviewId, 'ops/queues', 'Open day-end summary'),
          context: {
            dayend: {
              date: f.date(`${p.date}T12:00:00Z`),
              open: p.openItems,
              overdue: p.overdueItems,
              by: p.completedBy.name ?? (p.completedBy.kind === 'system' ? 'Marketly' : 'a staff member'),
              notes: [p.note?.trim(), ...lines].filter(Boolean).join('; ') || 'No notes.',
            },
          },
          dedupe: `day-end:${p.reviewId}:completed`,
        },
      ];
    },
  },

  /* ---------------------------------------------------------------- advertising, content (daily reminders) */
  'advertising.campaign.ending_soon': {
    sends: (p, f) => {
      const context = { campaign: { name: p.name, ends: f.date(p.endsAt), days: p.daysLeft } };
      const dedupe = `ad-campaign:${p.campaignId}:ending:${p.endsAt}`;
      return [
        p.advertiserKind === 'seller' &&
          p.sellerId && { topic: 'seller.campaign.ending_soon', to: [seller(p.sellerId)], link: L('campaign', p.campaignId, 'seller/ad-request', 'View campaign', p.ref), context, sellerId: p.sellerId, dedupe },
        p.advertiserKind !== 'seller' && {
          topic: 'staff.campaign.ending_soon',
          to: [staff(p.ownerStaffId) ?? role('advertising_manager')],
          link: L('campaign', p.campaignId, 'admin/ad-campaign', 'Open campaign', p.ref),
          context,
          dedupe,
        },
      ];
    },
  },
  'content.article.review_due': {
    sends: (p, f) => [
      {
        topic: 'staff.article.review_due',
        to: [staff(p.ownerStaffId) ?? role('content_manager')],
        link: L('article', p.articleId, 'admin/help-content', 'Review article'),
        context: { article: { title: p.title, lastReviewed: p.lastReviewedAt ? f.date(p.lastReviewedAt) : 'not reviewed since it was published' } },
        dedupe: `article-review:${p.articleId}:${p.dueSince}`,
      },
    ],
  },

  /* ---------------------------------------------------------------- reporters and authors (moderation, trust) */
  'reviews.moderation.decided': {
    sends: (p, f) => {
      const what = CONTENT_WORDS[p.contentType] ?? f.human(p.contentType);
      const outcome = DECISION_WORDS[p.decision] ?? f.human(p.decision);
      const reported = { report: { outcome: p.reporterOutcome?.trim() || `We reviewed the ${what} you reported: it was ${outcome}.` } };
      const authored = {
        content: { type: what },
        moderation: { outcome, reason: f.human(p.reasonCode) },
        appeal: { deadline: p.appealUntil ? f.date(p.appealUntil) : '', text: p.appealUntil ? `You can appeal until ${f.date(p.appealUntil)}.` : '' },
      };
      const key = `review-moderation:${p.moderationItemId}`;
      const customers = p.reporters.filter((r) => r.kind === 'customer');
      const author = p.author ?? null;
      return [
        customers.length > 0 && { topic: 'customer.review_report.decided', to: customers.map((r) => customer(r.id)), link: L('review', p.contentId, 'account/reviews', 'View details'), context: reported, dedupe: `${key}:reporter` },
        ...p.reporters
          .filter((r) => r.kind === 'seller')
          .map((r) => ({ topic: 'seller.review_report.decided', to: [seller(r.id)], link: L('review', p.contentId, 'seller/performance', 'View details'), context: reported, sellerId: r.id, dedupe: `${key}:reporter` })),
        author?.kind === 'customer' && {
          topic: 'customer.review.moderated',
          to: [customer(author.id)],
          link: L('review', p.contentId, 'account/reviews', 'View your reviews'),
          context: authored,
          dedupe: `${key}:author`,
        },
        author?.kind === 'seller' && {
          topic: 'seller.content.moderated',
          to: [seller(author.id)],
          link: L('review', p.contentId, 'seller/performance', 'View reviews'),
          context: authored,
          sellerId: author.id,
          dedupe: `${key}:author`,
        },
      ];
    },
  },
  'trust.report.resolved': {
    // the staff action notice of the report (trust.report.created) is done
    resolve: (p) => [`trust-report:${p.reportId}`],
    sends: (p, f) => {
      const context = { report: { ref: p.ref, outcome: p.reporterOutcome?.trim() || `Outcome: ${f.human(p.outcome)}.` } };
      const dedupe = `trust-report:${p.reportId}:resolved`;
      // customers in-app and email, guests who reported by email, rights owners by external email; sellers get their own topic
      const people = p.reporters
        .filter((r) => r.kind !== 'seller')
        .map((r): RouteTarget | null => (r.kind === 'rights_owner' ? external(r.contactEmail, r.contactName) : r.customerId ? customer(r.customerId) : r.contactEmail ? { kind: 'guest', email: r.contactEmail } : null));
      return [
        people.some(Boolean) && { topic: 'trust.report.resolved', to: people, link: L('report', p.reportId, 'help/case', 'View details', p.ref), context, dedupe },
        ...p.reporters
          .filter((r) => r.kind === 'seller' && r.sellerId)
          .map((r) => ({ topic: 'seller.trust_report.resolved', to: [seller(r.sellerId)], link: L('report', p.reportId, 'seller/performance', 'View details', p.ref), context, sellerId: r.sellerId, dedupe })),
      ];
    },
  },
  'trust.evidence.requested': {
    // action required until trust records the answer: trust resolves `trust-evidence:<requestId>`
    sends: (p, f) => {
      const context = { report: { ref: p.reportRef }, evidence: { question: p.question }, due: { date: f.dateTime(p.dueAt) } };
      const dedupe = `trust-evidence:${p.requestId}`;
      return [
        p.customerId && {
          topic: 'customer.trust.evidence_requested',
          to: [customer(p.customerId)],
          link: L('evidence_request', p.requestId, 'help/case', 'Send what we asked for', p.reportRef),
          context,
          deadline: p.dueAt,
          dedupe,
        },
        !p.customerId &&
          p.sellerId && {
            topic: 'seller.trust.evidence_requested',
            to: [seller(p.sellerId)],
            link: L('evidence_request', p.requestId, 'seller/notifications', 'Send proof', p.reportRef),
            context,
            sellerId: p.sellerId,
            deadline: p.dueAt,
            dedupe,
          },
      ];
    },
  },
  'trust.appeal.decided': {
    resolve: (p) => [`trust-appeal-review:${p.appealId}`],
    sends: (p) => {
      const outcome = p.outcome === 'upheld' ? 'kept' : p.outcome === 'overturned' ? 'overturned' : 'partly overturned';
      const changes = p.outcome === 'upheld' ? 'The action on your account stays in place.' : p.outcome === 'overturned' ? 'We are lifting the action on your account.' : 'We are lifting part of the action on your account.';
      const context = { appeal: { ref: p.ref, outcome, explanation: p.explanation.trim(), changes } };
      const dedupe = `trust-appeal:${p.appealId}`;
      return [
        p.customerId && { topic: 'customer.trust.appeal_decided', to: [customer(p.customerId)], link: L('appeal', p.appealId, 'help/case', 'View appeal', p.ref), context, dedupe },
        !p.customerId && p.sellerId && { topic: 'seller.trust.appeal_decided', to: [seller(p.sellerId)], link: L('appeal', p.appealId, 'seller/performance', 'View appeal', p.ref), context, sellerId: p.sellerId, dedupe },
      ];
    },
  },
  'offers.offer.missing_items_stale': {
    sends: (p) => {
      const parts = [p.staleItems.length ? `no longer in the box: ${p.staleItems.join(', ')}` : '', p.newBoxItems.length ? `new in the box: ${p.newBoxItems.join(', ')}` : ''].filter(Boolean);
      const context = { product: { title: p.title }, offer: { items: parts.join('; ') || 'the box contents changed' } };
      // action notice per offer, resolved by offers.offer.missing_items_reviewed (offers flags an offer once until it is reviewed)
      const dedupe = `offer-missing-items:${p.offerId}`;
      const official = p.ownerType === 'official' || !p.sellerId || p.sellerId === OFFICIAL_STORE_ID;
      return [
        official && { topic: 'staff.offer.missing_items_review', to: [role('catalog_manager')], link: L('offer', p.offerId, 'admin/official', 'Review offer'), context, dedupe },
        !official && { topic: 'seller.offer.missing_items_review', to: [seller(p.sellerId)], link: L('offer', p.offerId, 'seller/offer', 'Review offer'), context, sellerId: p.sellerId, dedupe },
      ];
    },
  },
  'offers.offer.missing_items_reviewed': { resolve: (p) => [`offer-missing-items:${p.offerId}`] },

  /* ---------------------------------------------------------------- reviews sellers (and authors) start */
  // One action notice per review to the role that decides it (the empty-role fallback reaches the escalation role,
  // usually the Business Owner), resolved by the event that decides it. seller: { id } names the store (consumers).
  'catalog.product.submitted': {
    sends: (p, f) => [
      {
        topic: 'staff.catalog.product_submitted',
        to: [role('catalog_manager')],
        link: L('product', p.productId, 'admin/product-review', 'Review product', p.ref),
        context: {
          product: { title: p.title || 'Untitled product' },
          submission: { ref: p.ref, what: p.kind === 'resubmitted' ? 'Resubmitted product' : p.kind === 'content_change' ? 'Product change' : 'New product' },
          seller: p.ownerSellerId ? { id: p.ownerSellerId } : { name: OFFICIAL_STORE_NAME },
          due: { date: f.dateTime(p.reviewDueAt) },
        },
        deadline: p.reviewDueAt,
        dedupe: `product-review:${p.productId}`,
      },
    ],
  },
  'catalog.brand.requested': {
    sends: (p) => [
      { topic: 'staff.catalog.brand_requested', to: [role('catalog_manager')], link: L('brand', p.brandId, 'admin/categories', 'Review brand', p.name), context: { brand: { name: p.name }, seller: { id: p.sellerId } }, dedupe: `brand-request:${p.brandId}` },
    ],
  },
  'catalog.brand.changed': { resolve: (p) => (p.change === 'status' ? [`brand-request:${p.brandId}`] : []) },
  'catalog.correction.suggested': {
    sends: (p) => [{ topic: 'staff.catalog.correction_suggested', to: [role('catalog_manager')], link: L('product', p.productId, 'admin/product-review', 'Review correction'), dedupe: `correction:${p.suggestionId}` }],
  },
  'catalog.correction.decided': { resolve: (p) => [`correction:${p.suggestionId}`] },
  'sellers.change_request.submitted': {
    sends: (p) => {
      const what = CHANGE_WHAT[p.kind] ?? 'Store change';
      // brand requests and storefront claims are decided on the Brands tab; the rest on the seller page
      const brands = p.kind === 'brand_request' || p.kind === 'public_claim';
      return [
        {
          topic: 'staff.seller.change_requested',
          to: [role('seller_manager')],
          link: brands ? L('brand', p.changeRequestId, 'admin/categories', 'Review on the Brands tab') : L('seller', p.sellerId, 'admin/seller', 'Review change'),
          context: { change: { what, what_lower: what.toLowerCase() }, seller: { id: p.sellerId } },
          dedupe: `change-request:${p.changeRequestId}`,
        },
      ];
    },
  },
  'sellers.launch_review.requested': {
    sends: (p) => [{ topic: 'staff.seller.launch_review_requested', to: [role('seller_manager')], link: L('seller', p.sellerId, 'admin/seller', 'Open seller'), context: { seller: { id: p.sellerId } }, dedupe: `launch-review:${p.sellerId}` }],
  },
  'sellers.application.information_provided': {
    // the same action notice as the application (resolved by sellers.application.decided)
    sends: (p) => [{ topic: 'staff.seller.application_information_provided', to: [role('seller_manager')], link: L('seller', p.applicationId, 'admin/seller-application', 'Review application'), context: { seller: { id: p.sellerId } }, dedupe: `seller-application:${p.applicationId}` }],
  },
  'sellers.appeal.submitted': {
    sends: (p, f) => [
      {
        topic: 'staff.seller.appeal_submitted',
        to: [role('seller_manager')],
        link: L('seller', p.sellerId, 'admin/seller', 'Open seller'),
        context: { seller: { id: p.sellerId }, appeal: { subject: f.human(p.subject) }, due: { date: f.dateTime(p.decideBy) } },
        deadline: p.decideBy,
        dedupe: `seller-appeal:${p.appealId}`,
      },
    ],
  },
  'sellers.restriction.evidence_submitted': {
    sends: (p) => [{ topic: 'staff.seller.restriction_evidence', to: [role('seller_manager')], link: L('seller', p.sellerId, 'admin/seller', 'Open seller'), context: { seller: { id: p.sellerId } }, dedupe: `restriction-evidence:${p.restrictionId}` }],
  },
  'sellers.restriction.lifted': { resolve: (p) => [`restriction-evidence:${p.restrictionId}`] },
  'trust.appeal.submitted': {
    sends: (p, f) => [
      { topic: 'staff.trust.appeal_submitted', to: [role('trust_and_risk_manager')], link: L('appeal', p.appealId, 'admin/trust', 'Open appeals'), context: { due: { date: f.dateTime(p.decideBy) } }, deadline: p.decideBy, dedupe: `trust-appeal-review:${p.appealId}` },
    ],
  },
  'reviews.appeal.submitted': {
    sends: (p, f) => [
      { topic: 'staff.moderation.appeal_submitted', to: [role('content_manager')], link: L('appeal', p.appealId, 'admin/reviews', 'Open moderation queue'), context: { appeal: { what: f.human(p.contentType) } }, dedupe: `moderation-appeal:${p.appealId}` },
    ],
  },
  'reviews.appeal.decided': { resolve: (p) => [`moderation-appeal:${p.appealId}`] },
  'trust.rights_report.received': {
    sends: (p) => [
      {
        topic: 'rights_owner.report.received',
        to: [external(p.contactEmail, p.contactName)],
        link: L('help', 'rights-owner-reports', 'help/article', 'How we handle reports', p.ref),
        context: { report: { ref: p.ref }, rights: { brand: p.brandName } },
        dedupe: `rights-report:${p.reportId}`,
      },
    ],
  },
};

/** Moderation decisions (decide endpoint values and stored states) in words */
const DECISION_WORDS: Record<string, string> = {
  keep: 'kept',
  kept: 'kept',
  remove: 'removed',
  removed: 'removed',
  reject_response: 'removed',
  request_edit: 'sent back for an edit',
  edit_requested: 'sent back for an edit',
  publish: 'published',
  published: 'published',
  hidden_pending_review: 'hidden while it is reviewed',
  reinstate: 'reinstated',
  reinstated: 'reinstated',
};

const CONTENT_WORDS: Record<string, string> = {
  product_review: 'review',
  seller_feedback: 'seller feedback',
  question: 'question',
  answer: 'answer',
  seller_response: 'response',
};

/** "Reno, NV warehouse, 100 Industrial Way, Reno, NV 89502, US" (the location name alone when it has no address) */
function shipToText(s: { name: string; code?: string; address?: { name?: string | null; line1?: string; line2?: string | null; city?: string; region?: string | null; postalCode?: string; country?: string } | null } | null | undefined): string {
  if (!s) return 'the delivery address on the purchase order';
  const a = s.address;
  const street = a ? [a.line1, a.line2, a.city, [a.region, a.postalCode].filter(Boolean).join(' '), a.country].filter((x) => x && String(x).trim()).join(', ') : '';
  return street ? `${s.name}, ${street}` : s.name;
}

