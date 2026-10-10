/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/reviews.js';

/** Product review: MyReview.status. Submit runs automatic checks (contact details, links, profanity, payment offers); passing content publishes at once, failing content is held for moderation. Reported reviews stay visible while reviewed unless the report reason is in hideOnReportReasons (e.g. personal information). keep/remove/requestEdit are moderation decisions with a policy reason; 'harms sales' or an unfavourable rating is never a removal reason. reinstate follows an overturned appeal. Edits re-run the checks. */
export const productReviewMachine = createStateMachine("Product review", spec.stateMachines["Product review"]);

/** Seller feedback: MyFeedback.status. Eligible once the seller's package is delivered (or its delivery date has passed), within sellerFeedbackWindowDays. Feedback about the product itself can be reported as off-topic; slow service mentioned in a product review stays (honest experience). */
export const sellerFeedbackMachine = createStateMachine("Seller feedback", spec.stateMachines["Seller feedback"]);

/** Answer: Answer.status. Answers passing the automatic checks publish at once; held ones (links, medical claims, off-platform offers) wait for review. Staff answers can require a second check (setting). */
export const questionMachine = createStateMachine("Question", spec.stateMachines["Question"]);

export const answerMachine =createStateMachine("Answer", spec.stateMachines["Answer"]);

/** Seller response: SellerResponse.status. One response per review or feedback. Rule check blocks names beyond what the customer shows, addresses, order details, offers of refunds or gifts for changing feedback, links, contact details and insults. Editable until editableUntil (responseEditDays). */
export const sellerResponseMachine = createStateMachine("Seller response", spec.stateMachines["Seller response"]);

/** Moderation item: ModerationItem.status. A new report on decided content within reportCooldownDays attaches to the decided item without reopening unless the reason differs; an appeal reopens it in the appeal queue. */
export const moderationItemMachine = createStateMachine("Moderation item", spec.stateMachines["Moderation item"]);

/** Appeal: AppealView.status. Decided by a moderator other than the original one (SAME_MODERATOR). Allowed until appealBy (appealWindowDays). */
export const appealMachine = createStateMachine("Appeal", spec.stateMachines["Appeal"]);
