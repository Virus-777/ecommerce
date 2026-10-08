/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/workqueues.js';

/** Work item: WorkItem.state. Deadline state (on_time, due_soon, overdue) and escalation level are separate from the state: the sweep job moves them, publishes workqueues.item.overdue once per item and escalates along the queue's route. Waiting keeps the deadline unless the queue allows pausing. Most items resolve automatically from their source's resolvesOn events (resolution outcome fixed_at_source); manual resolve needs a note; dismiss needs a reason. A raise with the same dedupeKey reopens a dismissed item only if the source fires again after dismissal. */
export const workItemMachine = createStateMachine("Work item", spec.stateMachines["Work item"]);

/** Day-end review: DayEndReview.state. Built daily before dayEndReviewTime. Complete requires every item checked (a note is required for items with open overdue work) and sends the summary to the shared roles. Missed at midnight market time if not completed; the next day's review lists it. */
export const dayEndReviewMachine = createStateMachine("Day-end review", spec.stateMachines["Day-end review"]);

/** Routine check: RoutineCheck.state. Generated each morning from routine templates for the owner roles on shift. */
export const routineCheckMachine = createStateMachine("Routine check", spec.stateMachines["Routine check"]);
