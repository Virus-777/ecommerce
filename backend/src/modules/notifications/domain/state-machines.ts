/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/notifications.js';

/** Template version: TemplateVersion.status. One draft per template at a time. publish is blocked while validation has blocking issues (missing required variable such as the record link, promotional content in an essential topic, unknown variable). Publishing supersedes the previous live version. Restore = start a new draft from an old version. */
export const templateVersionMachine = createStateMachine("Template version", spec.stateMachines["Template version"]);

/** Delivery: Delivery.status. skip: promotional without consent, member preference off, account closed, duplicate dedupeKey. suppress: address on the suppression list (hard bounce, complaint). Retries back off (1, 5, 15, 60, 240 min) up to maxDeliveryAttempts, then failed and notifications.delivery.failed. A hard bounce adds a suppression and publishes notifications.address.suppressed. In-app notices are written in the same transaction as the triggering event handling and never depend on email delivery. */
export const deliveryMachine = createStateMachine("Delivery", spec.stateMachines["Delivery"]);

/** Broadcast: Broadcast.status. Recipients are resolved at start from consent (customers.getMarketingConsent, seller member promotions group) minus suppressions; quiet hours apply to SMS and push. */
export const broadcastMachine = createStateMachine("Broadcast", spec.stateMachines["Broadcast"]);

