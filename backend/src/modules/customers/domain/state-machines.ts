/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/customers.js';

/** Customer account status: CustomerProfile.accountStatus. Restricted means at least one active scoped restriction (messaging, ordering, reviews or account). Suspended stops new orders, messages and reviews. In every state except closed, existing orders, returns, refunds and cases stay reachable by the customer and staff (plan ch. 17, scenario 7). Close by staff requires reason code and runs the same obligation check as a customer request unless the reason is suspected fraud. */
export const customerAccountStatusMachine = createStateMachine("Customer account status", spec.stateMachines["Customer account status"]);

/** Account restriction: AccountRestriction.state. Lift requires a reason. The expire job runs when endsAt passes. When the last active restriction ends the account returns to active. */
export const accountRestrictionMachine = createStateMachine("Account restriction", spec.stateMachines["Account restriction"]);

/** Data request: DataRequest.state. Exports: requested → processing → ready (link emailed, valid exportLinkValidDays) → expired. Closures: requested stays open for closureCoolingOffDays (customer can cancel), then the job re-checks obligations and completes; if new obligations appeared it keeps waiting and tells the customer. */
export const dataRequestMachine = createStateMachine("Data request", spec.stateMachines["Data request"]);
