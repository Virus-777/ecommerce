/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/shipping.js';

/** Shipment: Shipment.status. A shipment recorded by a seller with tracking is created as label_created and handed over in the same transaction (publishes shipping.shipment.dispatched). Until the first carrier scan the customer sees 'Shipped, tracking pending'. deliver only from a carrier event (or a staff record with evidence for carriers without tracking); never from the seller. Corrections to tracking keep the status and add a correction record. Return parcels (kind=return) use the same model. */
export const shipmentMachine = createStateMachine("Shipment", spec.stateMachines["Shipment"]);

/** Delivery exception: DeliveryException.status. Required responses (plan ch. 12): seller_cannot_fulfill: flag items, notify the customer, apply cancellation and refund policy (closes when the refund is sent). late_dispatch: overdue task, notify the seller, offer the customer support escalation (closes on dispatch or cancellation). missing_tracking: request valid details, never imply delivery (closes on a valid scan). lost_or_damaged: case with item, carrier details and agreed remedy (may file a carrier claim). failed_delivery: show redelivery, pickup or return steps and costs (closes on delivery or return to sender). condition_cleared is automatic; resolve records the resolution and who did it. Escalate to the Seller Manager when a seller misses a second deadline. */
export const deliveryExceptionMachine = createStateMachine("Delivery exception", spec.stateMachines["Delivery exception"]);

/** Carrier claim: CarrierClaim.status. Claims above claimFinanceApprovalAbove need Finance approval (access approval request) before submit. paid records paidAmount; finance books it (shipping.claim.status_changed). The customer remedy does not wait for the claim. */
export const carrierClaimMachine = createStateMachine("Carrier claim", spec.stateMachines["Carrier claim"]);

/** Service notice: ServiceNotice.status. go_live at showFrom (or the from date), end after the to date (job). Live notices adjust estimates (extra transit days, no pickup or dispatch days) and are shown on the chosen surfaces. */
export const serviceNoticeMachine = createStateMachine("Service notice", spec.stateMachines["Service notice"]);

/** Shipping profile version: ShippingProfile.status. Saving creates a new version; the previous active version is superseded when the new one takes effect. Quotes use the version active at quote time and checkout freezes the result on the order. Archive is refused while active offers use the profile (PROFILE_IN_USE). */
export const shippingProfileVersionMachine = createStateMachine("Shipping profile version", spec.stateMachines["Shipping profile version"]);

/** Label: Label.status. Voiding is possible only before the first carrier scan; the carrier refunds the cost and finance reverses the charge (shipping.label.voided). */
export const labelMachine = createStateMachine("Label", spec.stateMachines["Label"]);
