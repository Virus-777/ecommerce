/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/catalog.js';

/** Product review: ProductAdmin.reviewState. Submit is blocked until required information is present (title, brand, category, description of 40+ characters, one image, one variant, required category attributes). Reopen is used after an accepted correction that changes what the product is. */
export const productReviewMachine = createStateMachine("Product review", spec.stateMachines["Product review"]);

/** Publication: ProductAdmin.publication. Independent of review. Every change records a reason. Suspending a product does not remove other sellers' valid offers from past orders. */
export const publicationMachine = createStateMachine("Publication", spec.stateMachines["Publication"]);

/** Brand status: BrandAdmin.status. Staff-created brands start active; seller-requested brands start under_review. Every change records a reason. Blocking stops new submissions and new offers on the brand; existing products are hidden or suspended separately through publication. */
export const brandStatusMachine = createStateMachine("Brand status", spec.stateMachines["Brand status"]);
