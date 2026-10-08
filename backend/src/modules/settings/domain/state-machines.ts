/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/settings.js';

/** Setting change: SettingChange.status. submit is refused while the impact preview has blocking items (effective date inside minLeadDays, invalid value) or another open change touches the same key (CHANGE_CONFLICT). The strictest approval rule among the items applies (business_owner > second_reviewer > none); approval goes through access (action settings.changes.apply) and finishes on access.approval.decided. apply runs at effectiveAt (job) and writes a new version per key; a change whose effectiveAt is now applies immediately after approval. Applied changes are never edited: a correction is a new change. */
export const settingChangeMachine = createStateMachine("Setting change", spec.stateMachines["Setting change"]);
