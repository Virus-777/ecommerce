/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/warehouse.js';

/** Warehouse fulfillment: Fulfillment.status. startPicking when its wave starts. hold on a shortage or damage report: the order stays in the wave and is not packed partly. resume on inventory.discrepancy.resolved (reallocated) or by staff. cancel only when every line is cancelled (orders.item.cancelled); single cancelled lines are removed and picked units go back to their bin. dispatch on shipping.shipment.dispatched. */
export const warehouseFulfillmentMachine = createStateMachine("Warehouse fulfillment", spec.stateMachines["Warehouse fulfillment"]);

/** Package: Package.status. label requires every item scanned, a box (or dimensions) and a weight. pack hands the package to shipping for carrier pickup. voidLabel cancels the carrier label through shipping before reprinting a different service. */
export const packageMachine = createStateMachine("Package", spec.stateMachines["Package"]);

/** Wave: Wave.status. complete when every fulfillment in the wave is packed, on hold or cancelled; on-hold orders move to the next wave. */
export const waveMachine = createStateMachine("Wave", spec.stateMachines["Wave"]);

/** Put-away task: PutawayTask.status. Created from purchasing.receipt.recorded per received line (excluding damaged units, which go to a quarantine bin task). */
export const putAwayTaskMachine = createStateMachine("Put-away task", spec.stateMachines["Put-away task"]);

/** Return parcel: ReturnParcel.status. Expected parcels come from returns.return.approved for Official Store returns. A parcel with no matching return is created directly as received with unexpected = true. Hand-over moves it to the inspection bench; returns owns inspection from there. */
export const returnParcelMachine = createStateMachine("Return parcel", spec.stateMachines["Return parcel"]);
