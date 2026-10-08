/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/content.js';

/** Content publication: PageSummary.status. Applies to pages, collections, homepage sections and help articles. Review is optional for pages and sections (content.reviewRequired setting) and required for help articles. scheduled → publish runs from the schedule job at publishAt; unpublish also runs at unpublishAt ('Removed Sep 16'). remove is the correction or removal action for content that must come down now: it requires a reason, records who and why, and leaves a correction note where configured. Editing a published item creates a new draft version; the live version stays until the draft is published. */
export const contentPublicationMachine = createStateMachine("Content publication", spec.stateMachines["Content publication"]);

/** Policy version: PolicyVersion.state. approve completes when the policy owner and the Business Owner (final approval, through access) have approved. schedule needs an effective date at least policyNoticeDays after publishing for customer-facing changes; an earlier date needs a second approval. takeEffect runs at effectiveAt and supersedes the previous current version. Approved versions are immutable; corrections need a new version. Orders reference the version that was current when they were placed. */
export const policyVersionMachine = createStateMachine("Policy version", spec.stateMachines["Policy version"]);
