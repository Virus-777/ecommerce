/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/messaging.js';

/** Conversation: Conversation.status. lock is a staff action with a reason (abuse, fraud); the thread stays readable. archive happens archiveAfterDays after the order completes; a new message about the same subject reopens it. A seller restriction never locks customer conversations about existing orders. */
export const conversationMachine = createStateMachine("Conversation", spec.stateMachines["Conversation"]);

/** Seller reply: Conversation.replyState. Only customer–seller conversations have a reply state. reply_due_at = first unanswered customer message + sellerReplyTargetHours. Overdue conversations are highlighted in Seller Center and count in seller performance. */
export const sellerReplyMachine = createStateMachine("Seller reply", spec.stateMachines["Seller reply"]);

/** Message report: MessageReport.status. Actioning hides the message or locks the conversation; serious cases are referred to trust. */
export const messageReportMachine = createStateMachine("Message report", spec.stateMachines["Message report"]);
