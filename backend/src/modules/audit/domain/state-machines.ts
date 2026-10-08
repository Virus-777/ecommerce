/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/audit.js';

/** Retention change: RetentionPolicy.pendingChange. Lengthening applies at once. Shortening needs Business Owner approval (action audit.retention.change) and never goes below minimumYears; the next purge uses the new value. */
export const retentionChangeMachine = createStateMachine("Retention change", spec.stateMachines["Retention change"]);
