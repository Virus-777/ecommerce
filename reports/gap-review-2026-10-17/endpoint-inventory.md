# Endpoint inventory (backend main openapi.json vs frontend typed calls)
backend ops: 1319; backend paths: 1164; frontend openapi.d.ts paths: 1164

## Drift between frontend openapi.d.ts and backend main
paths in backend main but NOT in frontend openapi.d.ts:
paths in frontend openapi.d.ts but NOT in backend main:

## Frontend calls with no matching backend operation (method+path)
  GET /api/store/cart  <- shared: web-shared/src/api/client.ts, web-shared/src/api/provider.tsx

## Cross-audience calls (app calling another audience prefix)
  [seller] GET /api/store/identity/security <- seller-center/src/app/session.tsx, seller-center/src/pages/Help.tsx

## Backend store operations NOT called by any frontend (91 of 264)
  ### Store API · Cart (6)
    DELETE /api/store/cart/cart/saved/{id}  — Delete a saved item
    GET /api/store/cart/cart/saved  — Saved for later
    POST /api/store/cart/cart/items/{id}/save-for-later  — Move a line to Saved for later
    POST /api/store/cart/cart/items/{id}/switch-offer  — Replace a line's offer with one the customer explicitly chose
    POST /api/store/cart/cart/remove-unavailable  — Remove every unavailable line in one action
    POST /api/store/cart/cart/saved/{id}/move-to-cart  — Move a saved item back into the cart
  ### Store API · Checkout (2)
    POST /api/store/checkout/sessions/{id}/revalidate  — Check price, stock, delivery, coupons and shippability again
    PUT /api/store/checkout/sessions/{id}/preferences  — Gift note and hide prices on packing slips
  ### Store API · Customers (3)
    DELETE /api/store/customers/recently-viewed/{productId}  — Remove one product from the list
    GET /api/store/customers/overview  — Account tab home: tiles, alerts, recent orders, open cases and returns
    POST /api/store/customers/addresses/validate  — Check an address before saving or at guest checkout
  ### Store API · Identity (2)
    GET /api/store/identity/devices  — Where you're signed in
    POST /api/store/identity/two-step/recovery-codes  — Replace recovery codes
  ### Store API · Media (8)
    DELETE /api/store/media/assets/{id}  — Remove my upload before submitting
    GET /api/store/media/assets/{id}  — My upload (poll until ready)
    GET /api/store/media/assets/{id}/download  — Signed link to one of my private files
    GET /api/store/media/image-specs  — The product image spec (aspect ratio and the detail and thumbnail sizes)
    PATCH /api/store/media/assets/{id}  — Describe my photo (alt text)
    POST /api/store/media/uploads  — Start an upload (return photos, case evidence, review photos, message attachments, seller application documents)
    POST /api/store/media/uploads/{id}/complete  — Confirm the bytes are uploaded; processing starts
    PUT /api/store/media/uploads/{id}/content  — Send the file bytes of an upload
  ### Store API · Messaging (1)
    POST /api/store/messaging/messages/{id}/report  — Report an abusive, promotional or off-platform message
  ### Store API · Notifications (4)
    DELETE /api/store/notifications/push-devices/{id}  — Stop push notices on a device (sign-out)
    GET /api/store/notifications/preferences  — What we send and where to change it
    POST /api/store/notifications/push-devices  — Register the Android app for push notices
    PUT /api/store/notifications/preferences/push  — Turn order-update push notices on or off
  ### Store API · Offers (2)
    GET /api/store/offers/featured-offer-rule  — Published featured-offer rule ('How we choose the featured offer')
    GET /api/store/offers/offers/{id}  — One offer as the customer sees it (used by cart and review-changes)
  ### Store API · Orders (3)
    GET /api/store/orders/orders/{id}/cancellations/{cancellationId}  — A cancellation request with seller deadline and refund status
    GET /api/store/orders/orders/{id}/documents  — Receipt and per-seller invoices
    POST /api/store/orders/orders/{id}/cancellations/{cancellationId}/withdraw  — Withdraw a pending cancellation request
  ### Store API · Payments (4)
    GET /api/store/payments/options  — Accepted methods, saved cards, wallet availability and new-card setup
    GET /api/store/payments/refunds  — My refunds with status (Requested, Processing, Sent, Failed)
    GET /api/store/payments/refunds/{id}  — One refund with destination and timing
    POST /api/store/payments/refunds/{id}/destination  — Choose where a failed refund should go instead
  ### Store API · Promotions (6)
    GET /api/store/promotions/deals/clearance  — More clearance products
    GET /api/store/promotions/deals/coupons  — More clippable coupons
    GET /api/store/promotions/flash-sales/{campaignId}  — One flash sale with live claimed meters
    GET /api/store/promotions/offer-prices  — Promotion prices for a set of offers (product cards, collections, wishlist)
    GET /api/store/promotions/products/{productId}  — Promotions for a product page: deal prices per offer, purchase limits, countdowns, seller promos and coupons
    POST /api/store/promotions/codes/check  — Look up a coupon code's terms without applying it
  ### Store API · Reports (1)
    POST /api/store/reports/signals  — Batched anonymous discovery signals from the website and app (product views)
  ### Store API · Returns (6)
    GET /api/store/returns/requests/{id}/label  — Drop-off QR code, printable label, instructions and nearby drop-off points
    GET /api/store/returns/terms  — Effective return terms for a seller and category
    POST /api/store/returns/requests/{id}/escalate  — Ask Marketly to step in
    POST /api/store/returns/requests/{id}/info  — Answer the seller's or Marketly's question
    POST /api/store/returns/requests/{id}/shipment  — Add carrier and tracking for a customer-arranged return
    POST /api/store/returns/requests/{id}/withdraw  — Cancel a return before the item is sent back
  ### Store API · Reviews (3)
    GET /api/store/reviews/rating-summaries  — Ratings for several products (cards)
    PATCH /api/store/reviews/me/answers/{id}  — Edit my answer, or fix and resubmit it after an edit request
    POST /api/store/reviews/questions/{id}/answers  — Answer another shopper's question (labelled Customer)
  ### Store API · Search (2)
    GET /api/store/search/barcodes/{code}  — Resolve a scanned GTIN/UPC/EAN to a listed product and variant
    GET /api/store/search/ranking-policy  — Published 'How results are ranked'
  ### Store API · Sellers (2)
    GET /api/store/sellers/stores/{slug}/collections/{collectionId}  — One featured collection with its offer ids
    POST /api/store/sellers/applications/{id}/withdraw  — Withdraw an application
  ### Store API · Shipping (4)
    GET /api/store/shipping/estimates  — Delivery estimate per offer for a location (product page, offers list)
    GET /api/store/shipping/notices  — Live holiday and service notices for a location
    GET /api/store/shipping/orders/{orderId}/shipments  — Packages of an order with carrier, tracking and status
    GET /api/store/shipping/shipments/{id}/tracking  — Track one package: carrier, tracking number, contents, estimate and events
  ### Store API · Support (1)
    GET /api/store/support/cases/{id}  — Case detail: handler, next action and expected response, linked items, conversation, decision, remedy progress, appeal and reopen rules
  ### Store API · Trust and risk (8)
    GET /api/store/trust/appeals  — My appeals
    GET /api/store/trust/enforcements  — Trust actions that affect my account, with appeal route
    GET /api/store/trust/evidence-requests  — Proof Trust and Risk asked me for (e.g. confirm an order or explain a message)
    GET /api/store/trust/reports/{id}  — One report I made
    POST /api/store/trust/appeals  — Appeal a trust action on my account before the deadline
    POST /api/store/trust/evidence-requests/{id}/answer  — Send the requested proof or explanation
    POST /api/store/trust/reports  — Report a listing, seller, order or message
    POST /api/store/trust/reports/{id}/evidence  — Add photos or details to a report I made
  ### Store API · Wallet (5)
    GET /api/store/wallet/credit  — Store credit balance, lots with expiry and recent history
    GET /api/store/wallet/credit/entries  — Credit history
    GET /api/store/wallet/loyalty  — Loyalty points (experiment; NOT_IMPLEMENTED until a program is defined)
    POST /api/store/wallet/gift-cards/check  — Check a gift card balance
    POST /api/store/wallet/gift-cards/redeem  — Add a gift card to store credit
  ### Store API · Wishlist (18)
    DELETE /api/store/wishlist/alerts/{id}  — Remove an alert
    DELETE /api/store/wishlist/items/{id}  — Remove a saved item (its alerts are removed too)
    DELETE /api/store/wishlist/lists/{id}  — Delete a list (not the default list)
    GET /api/store/wishlist/alerts  — My alerts
    GET /api/store/wishlist/lists  — My lists
    GET /api/store/wishlist/lists/{id}/items  — More items of a list
    GET /api/store/wishlist/saved  — Which products are saved (for heart icons on cards)
    GET /api/store/wishlist/shared/{token}  — View a shared list (read-only, no prices history or alerts)
    GET /api/store/wishlist/wishlist  — Wishlist page: lists, first batch of items with price hints and stock, and alerts
    PATCH /api/store/wishlist/lists/{id}  — Rename a list
    POST /api/store/wishlist/alerts  — Create an alert (also for a product not saved, e.g. from an out-of-stock product page)
    POST /api/store/wishlist/alerts/{id}/transition  — Pause, resume or rearm an alert
    POST /api/store/wishlist/items  — Save a product (optionally with alerts)
    POST /api/store/wishlist/items/{id}/move  — Move an item to another list
    POST /api/store/wishlist/items/{id}/move-to-cart  — Add the item to the cart with an explicit offer
    POST /api/store/wishlist/lists  — Create a named list
    POST /api/store/wishlist/lists/{id}/share  — Create or revoke a share link
    PUT /api/store/wishlist/items/{id}/alerts  — Turn price-drop and back-in-stock alerts on or off for an item

## Backend seller operations NOT called by any frontend (93 of 273)
  ### Seller API · Action history (1)
    GET /api/seller/audit/entries  — Changes made on this seller account
  ### Seller API · Advertising (1)
    GET /api/seller/advertising/charges  — Own ad charges by day (they appear on statements as a separate line)
  ### Seller API · Catalog (2)
    GET /api/seller/catalog/products/{id}  — One own product with review feedback
    POST /api/seller/catalog/products/{id}/corrections  — Suggest a correction to shared product content
  ### Seller API · Finance (2)
    GET /api/seller/finance/payout-destination  — Verification status of the payout account and any change under review
    GET /api/seller/finance/payouts/{id}  — One payout
  ### Seller API · Fulfillment service (22)
    GET /api/seller/fulfillment-service/enrollment  — Own enrollment status, terms, capacity
    GET /api/seller/fulfillment-service/fee-schedule  — Current and upcoming fee schedule
    GET /api/seller/fulfillment-service/fees  — Fees charged (storage, handling, receiving, returns, removal)
    GET /api/seller/fulfillment-service/inbound  — Own inbound shipments
    GET /api/seller/fulfillment-service/inbound/{id}  — Inbound shipment with labels, receiving results and discrepancies
    GET /api/seller/fulfillment-service/overview  — Enrollment, stock held by Marketly, open inbound shipments and fees
    GET /api/seller/fulfillment-service/removals  — Removal and disposal orders
    GET /api/seller/fulfillment-service/returns  — Returns of service offers received at our warehouse with inspection outcome
    GET /api/seller/fulfillment-service/skus  — Enrolled SKUs with stock held by Marketly by group
    GET /api/seller/fulfillment-service/skus/{id}/movements  — Ownership ledger for one SKU (every unit movement with reason)
    PATCH /api/seller/fulfillment-service/inbound/{id}  — Edit a draft or add carrier and tracking
    POST /api/seller/fulfillment-service/enrollment  — Apply for storage and shipping by Marketly and accept the service terms
    POST /api/seller/fulfillment-service/enrollment/offboard  — Stop using the service (stock must be removed)
    POST /api/seller/fulfillment-service/inbound  — Plan an inbound shipment to our warehouse
    POST /api/seller/fulfillment-service/inbound/{id}/cancel  — Cancel before it ships
    POST /api/seller/fulfillment-service/inbound/{id}/discrepancy-response  — Accept a receiving discrepancy or claim it with evidence
    POST /api/seller/fulfillment-service/inbound/{id}/ship  — Mark as shipped with carrier and tracking
    POST /api/seller/fulfillment-service/inbound/{id}/submit  — Submit and get box and unit labels
    POST /api/seller/fulfillment-service/removals  — Ask for stock back or to dispose of it
    POST /api/seller/fulfillment-service/removals/{id}/cancel  — Cancel a removal that has not been approved
    POST /api/seller/fulfillment-service/skus  — Enroll an offer for fulfillment by Marketly
    POST /api/seller/fulfillment-service/skus/{id}/deactivate  — Stop using the service for a SKU
  ### Seller API · Inventory (1)
    GET /api/seller/inventory/stock-items/{id}  — One stock item with reservations and movement history
  ### Seller API · Media (10)
    DELETE /api/seller/media/assets/{id}  — Delete an unused file
    GET /api/seller/media/assets  — Seller media library
    GET /api/seller/media/assets/{id}  — One file with where it is used and whether it can be deleted
    GET /api/seller/media/assets/{id}/download  — Signed link to one of the seller's private files
    GET /api/seller/media/image-specs  — The product image spec the Seller Center crops product photos to
    PATCH /api/seller/media/assets/{id}  — Edit alt text or title
    POST /api/seller/media/assets/{id}/checks  — Check an image against category or placement rules before submitting
    POST /api/seller/media/uploads  — Start an upload (product images and video, store logo and banner, ad creatives, documents, inspection photos, return evidence, case evidence, bulk files)
    POST /api/seller/media/uploads/{id}/complete  — Confirm the upload; processing starts
    PUT /api/seller/media/uploads/{id}/content  — Send the file bytes of an upload
  ### Seller API · Messaging (1)
    PATCH /api/seller/messaging/templates/{id}  — Edit a reply template
  ### Seller API · Notifications (3)
    DELETE /api/seller/notifications/push-devices/{id}  — Stop seller push notices on a device
    POST /api/seller/notifications/inbox/{id}/archive  — Archive one notice (for me)
    POST /api/seller/notifications/push-devices  — Register the Android app for seller push notices
  ### Seller API · Offers (3)
    DELETE /api/seller/offers/offers/{id}  — Delete a draft offer that was never published
    POST /api/seller/offers/offers/{id}/end  — End an offer permanently (Removed, reason ended_by_seller)
    POST /api/seller/offers/offers/{id}/pause  — Hide an offer from customers (stock is kept)
  ### Seller API · Orders (2)
    POST /api/seller/orders/orders/{id}/report-delay  — Report that items will ship late, with a new dispatch date
    POST /api/seller/orders/orders/{id}/start-preparing  — Mark the task as preparing (tells the buyer it is being packed)
  ### Seller API · Promotions (3)
    GET /api/seller/promotions/discounts/{id}  — One own discount with usage
    GET /api/seller/promotions/invitations/{id}  — Invitation with eligibility per offer, funding split and expected earnings per unit
    PATCH /api/seller/promotions/discounts/{id}  — Edit a draft or scheduled discount
  ### Seller API · Reports (2)
    GET /api/seller/reports/catalogue  — Reports available to sellers
    GET /api/seller/reports/exports  — My seller exports
  ### Seller API · Returns (1)
    POST /api/seller/returns/replacements/{id}/cancel  — Cancel a replacement or exchange not shipped yet (e.g. no stock) with a reason
  ### Seller API · Reviews (3)
    GET /api/seller/reviews/product-reviews  — Product reviews of items the seller sold (to respond)
    GET /api/seller/reviews/reports  — Reports the seller made and their outcomes
    POST /api/seller/reviews/appeals  — Appeal a moderation decision on the seller's answer or response
  ### Seller API · Search (1)
    GET /api/seller/search/quick  — Seller Center top-bar search across own orders, offers/SKUs and returns
  ### Seller API · Sellers (14)
    GET /api/seller/sellers/agreements  — Accepted agreement versions and new versions waiting for acceptance
    GET /api/seller/sellers/appeals  — My appeals and their outcomes
    GET /api/seller/sellers/business  — Legal and contact details
    GET /api/seller/sellers/change-requests  — My pending and decided change requests (store name, claims, business)
    GET /api/seller/sellers/restrictions/{id}  — One restriction: reason, affected activity, what still works, how to resolve, appeal route
    PATCH /api/seller/sellers/business/contact  — Update contact person, email, phone and support hours
    POST /api/seller/sellers/account/close  — Owner asks to close the seller account
    POST /api/seller/sellers/agreements/{key}/accept  — Accept a new agreement version (owner)
    POST /api/seller/sellers/appeals/{id}/withdraw  — Withdraw an appeal
    POST /api/seller/sellers/brand-requests  — Ask Marketly to add a brand that is not listed, with evidence
    POST /api/seller/sellers/business/change-requests  — Request a change to legal name, ownership or business address
    POST /api/seller/sellers/change-requests/{id}/withdraw  — Withdraw a pending change request
    POST /api/seller/sellers/store-profile/claims/{id}/withdraw  — Withdraw a pending or approved claim
    PUT /api/seller/sellers/store-profile/collections/order  — Set collection order
  ### Seller API · Shipping (11)
    GET /api/seller/shipping/claims  — Carrier claims on the seller's shipments
    GET /api/seller/shipping/exceptions  — Delivery exceptions on the seller's orders that need the seller's response
    GET /api/seller/shipping/preview  — What customers see for an offer or profile at a location
    GET /api/seller/shipping/shipments  — The seller's shipment records
    GET /api/seller/shipping/shipments/{id}  — One shipment with tracking events and correction history
    GET /api/seller/shipping/shipping-setup  — Carriers, services, label purchase and the default package for recording a shipment
    POST /api/seller/shipping/claims  — Record a claim the seller filed with its own carrier account
    POST /api/seller/shipping/exceptions/{id}/respond  — Respond: provide tracking, promise a ship-by date, report you cannot fulfill, or confirm a replacement
    POST /api/seller/shipping/labels/{id}/void  — Void an unused label (refunded to earnings)
    POST /api/seller/shipping/profiles  — Create a shipping profile (e.g. Large items)
    POST /api/seller/shipping/profiles/{id}/archive  — Archive a profile no offer uses
  ### Seller API · Support (2)
    GET /api/seller/support/cases/{id}  — Case as the seller sees it (no internal notes)
    POST /api/seller/support/cases/{id}/appeal  — Appeal a dispute decision before the deadline
  ### Seller API · Trust and risk (7)
    GET /api/seller/trust/appeals  — This seller's trust appeals
    GET /api/seller/trust/enforcements  — Trust actions on this seller's offers, products or claims, with appeal route
    GET /api/seller/trust/evidence-requests  — Proof Trust and Risk asked this seller for (e.g. proof of supply)
    GET /api/seller/trust/reports  — Reports this seller made
    POST /api/seller/trust/appeals  — Appeal a trust action on an offer, product or claim
    POST /api/seller/trust/evidence-requests/{id}/answer  — Send the requested proof
    POST /api/seller/trust/reports  — Report abuse by a customer, a counterfeit competitor offer or a listing problem
  ### Seller API · Work queues (1)
    GET /api/seller/workqueues/tasks  — Tasks Marketly is tracking for this seller (e.g. overdue dispatch, missing tracking, reply overdue)

## Backend admin operations NOT called by any frontend (434 of 752)
  ### Admin API · Access and approvals (16)
    GET /api/admin/access/approval-requests  — Approval requests (waiting for me, mine, or all)
    GET /api/admin/access/limits  — Approval limits in force
    GET /api/admin/access/members/{accountId}  — One staff member: assignments, effective permissions and limits, away periods
    GET /api/admin/access/permissions  — Permission registry grouped by work area
    PATCH /api/admin/access/roles/{id}  — Rename a role, change its work area or escalation role
    POST /api/admin/access/approval-requests/{id}/cancel  — Requester withdraws a request
    POST /api/admin/access/approval-requests/{id}/resubmit  — Requester resubmits after a return
    POST /api/admin/access/approval-requests/{id}/return  — Send back to the requester with a comment
    POST /api/admin/access/away-periods  — Plan time away and who covers each role
    POST /api/admin/access/away-periods/{id}/cancel  — Cancel a planned away period
    POST /api/admin/access/away-periods/{id}/end  — End an away period early (back at work)
    POST /api/admin/access/limit-changes/{id}/cancel  — Withdraw a pending or scheduled limit change
    POST /api/admin/access/role-assignments  — Give a staff member a role
    POST /api/admin/access/role-assignments/{id}/revoke  — Remove a role from a staff member
    POST /api/admin/access/roles/{id}/archive  — Archive an unused custom role
    PUT /api/admin/access/roles/{id}/coverage  — Set the lead, backups and escalation role
  ### Admin API · Action history (4)
    GET /api/admin/audit/exports  — My exports (all exports with audit.retention.manage)
    GET /api/admin/audit/integrity  — Hash-chain check result
    GET /api/admin/audit/summary  — Counts for the filter chips (pending second review, financial, enforcement, settings)
    PUT /api/admin/audit/retention  — Change how long history is kept
  ### Admin API · Advertising (17)
    GET /api/admin/advertising/campaigns/{id}/report  — Displays, clicks, dismissals, spend and attributed purchases by day
    GET /api/admin/advertising/charges  — Seller ad charges (separate from commission)
    GET /api/admin/advertising/creatives/{id}  — Creative with checks, reviews and where it is used
    GET /api/admin/advertising/reports/performance  — Performance across campaigns by placement, with the attribution period stated
    POST /api/admin/advertising/campaigns/{id}/activate  — Activate an approved campaign now
    POST /api/admin/advertising/campaigns/{id}/approve  — Approve one review step (the campaign is approved when all steps are)
    POST /api/admin/advertising/campaigns/{id}/archive  — Archive a finished or rejected campaign
    POST /api/admin/advertising/campaigns/{id}/finish  — Finish a scheduled, live or paused campaign early
    POST /api/admin/advertising/campaigns/{id}/pause  — Pause immediately (off the site within 1 minute)
    POST /api/admin/advertising/campaigns/{id}/reject  — Reject a request (e.g. promoted offer suspended)
    POST /api/admin/advertising/campaigns/{id}/renew  — Create a new draft from a finished or ending campaign (renew deliberately)
    POST /api/admin/advertising/campaigns/{id}/request-changes  — Send back to the owner with a reason
    POST /api/admin/advertising/campaigns/{id}/resume  — Resume a paused campaign
    POST /api/admin/advertising/campaigns/{id}/schedule  — Schedule an approved campaign for its start time
    POST /api/admin/advertising/charges/{id}/void  — Void an accrued charge or credit a posted one (invalid traffic, cancelled delivery)
    POST /api/admin/advertising/creatives/{id}/check  — Re-run the link, availability and label checks
    PUT /api/admin/advertising/rules  — Change global rules (Business Owner approval)
  ### Admin API · Cart (2)
    GET /api/admin/cart/carts  — Find a customer's or guest's cart (support)
    GET /api/admin/cart/carts/{id}  — One cart with lines, notices and merge history
  ### Admin API · Catalog (9)
    GET /api/admin/catalog/corrections  — Open correction suggestions
    GET /api/admin/catalog/products/{id}  — Product with review history and duplicate candidates
    GET /api/admin/catalog/products/{id}/publication-impact  — What hiding or suspending the product would do
    PATCH /api/admin/catalog/products/{id}  — Edit an Official Store draft
    PATCH /api/admin/catalog/products/{id}/variants/{variantId}  — Set a variant's shipping weight, dimensions and list price
    POST /api/admin/catalog/corrections/{id}/decide  — Accept or decline a correction
    POST /api/admin/catalog/products  — Create an Official Store product draft
    POST /api/admin/catalog/products/bulk  — Bulk edit products (category, brand, publication) with preview
    POST /api/admin/catalog/products/{id}/submit  — Submit an Official Store product (same standard as sellers)
  ### Admin API · Checkout (2)
    GET /api/admin/checkout/sessions  — Checkouts with payment problems or open changes (support view)
    GET /api/admin/checkout/sessions/{id}  — One checkout with place attempts, idempotency keys, change sets and history
  ### Admin API · Content (21)
    GET /api/admin/content/help/articles/{id}/versions  — Article version history
    GET /api/admin/content/pages/{id}  — Page with draft and live versions, checks and linked promotion
    GET /api/admin/content/pages/{id}/versions  — Version history of a page
    GET /api/admin/content/policy-versions/{id}  — A policy version with approvals
    GET /api/admin/content/policy-versions/{id}/diff  — Changes from the previous version
    PATCH /api/admin/content/help/categories/{id}  — Rename, hide or reorder a category
    PATCH /api/admin/content/pages/{id}  — Edit the page draft (creates or updates the draft version)
    POST /api/admin/content/help/articles/{id}/versions/{number}/restore  — Restore an earlier article version as a new draft
    POST /api/admin/content/help/categories  — Create a help category
    POST /api/admin/content/homepage/preview  — Preview the homepage (draft or live) on desktop or phone at a given time
    POST /api/admin/content/pages/{id}/approve  — Approve or request changes
    POST /api/admin/content/pages/{id}/cancel-schedule  — Cancel a scheduled publication
    POST /api/admin/content/pages/{id}/preview  — Preview the draft as customers will see it
    POST /api/admin/content/pages/{id}/remove  — Correction or removal action (reason required, takes effect now)
    POST /api/admin/content/pages/{id}/schedule  — Set publish and removal times
    POST /api/admin/content/pages/{id}/submit  — Send for review
    POST /api/admin/content/pages/{id}/unpublish  — Take a page down (it can be republished)
    POST /api/admin/content/pages/{id}/versions/{number}/restore  — Restore an earlier version as a new draft version
    POST /api/admin/content/policies  — Create a new policy with its business owner
    POST /api/admin/content/policy-versions/{id}/withdraw  — Withdraw a version before it takes effect
    PUT /api/admin/content/navigation  — Replace header and footer links
  ### Admin API · Customers (4)
    GET /api/admin/customers/customers/{id}/actions  — Account action history for one customer
    GET /api/admin/customers/data-requests  — Export and closure requests across customers (privacy queue)
    POST /api/admin/customers/customers/exports  — Export the filtered customer list
    POST /api/admin/customers/customers/{id}/notes  — Add an internal note
  ### Admin API · Finance (25)
    GET /api/admin/finance/adjustments  — Adjustments with reasons and approvals
    GET /api/admin/finance/amounts-owed  — Negative balances that became amounts owed
    GET /api/admin/finance/holds  — Holds with reason and review date
    GET /api/admin/finance/marketplace-income  — Marketplace fee income, ad income and amounts owed to sellers (separate from company trading)
    GET /api/admin/finance/payout-runs/{id}/statements  — Seller statements settled by this payout run
    GET /api/admin/finance/sellers  — Seller balances
    GET /api/admin/finance/sellers/{sellerId}  — One seller's balances, holds, payouts, amounts owed and adjustments
    GET /api/admin/finance/sellers/{sellerId}/ledger  — A seller's ledger
    GET /api/admin/finance/sellers/{sellerId}/statements  — A seller's statements
    GET /api/admin/finance/statements/{id}  — A statement as the seller sees it
    GET /api/admin/finance/trading-targets  — Official Store sales and margin targets by month (plan ch. 2)
    POST /api/admin/finance/adjustments  — Credit or debit a seller with a recorded reason
    POST /api/admin/finance/amounts-owed/{id}/settle  — Record payment received or write off an amount owed
    POST /api/admin/finance/fee-rules  — Propose a new fee rule version with an effective date
    POST /api/admin/finance/fee-rules/calculate  — Example fee and seller earnings for a price
    POST /api/admin/finance/fee-rules/{id}/withdraw  — Withdraw a draft or scheduled fee rule version
    POST /api/admin/finance/holds  — Hold part of a seller's earnings with a reason and review date
    POST /api/admin/finance/holds/{id}/apply  — Turn a held amount into a deduction (e.g. chargeback lost)
    POST /api/admin/finance/holds/{id}/extend  — Move the review date with a reason
    POST /api/admin/finance/holds/{id}/release  — Release all or part of a hold
    POST /api/admin/finance/payout-runs  — Calculate a payout run for a cutoff (normally created by the schedule)
    POST /api/admin/finance/payout-runs/{id}/recalculate  — Refresh a draft run after holds, retries or destination changes
    POST /api/admin/finance/payout-runs/{id}/release  — Release an approved run now (otherwise released at the scheduled time)
    POST /api/admin/finance/reconciliation/items/{id}/assign  — Set the owner of a mismatch
    PUT /api/admin/finance/trading-targets/{period}  — Set the sales and margin target for a month (whole store or one category)
  ### Admin API · Fulfillment service (19)
    GET /api/admin/fulfillment-service/enrollments  — Seller enrollments
    GET /api/admin/fulfillment-service/fee-schedules  — Fee schedule versions
    GET /api/admin/fulfillment-service/fees  — Fee charges across sellers
    GET /api/admin/fulfillment-service/fulfillment-requests  — Orders for service offers and their warehouse progress
    GET /api/admin/fulfillment-service/inbound  — Inbound shipments expected and arriving (receiving queue)
    GET /api/admin/fulfillment-service/removals  — Removal and disposal orders
    GET /api/admin/fulfillment-service/sellers/{sellerId}/stock  — Seller-owned stock held by the company, by SKU and group
    GET /api/admin/fulfillment-service/stock-differences  — Differences between the ownership ledger and inventory found by the daily reconciliation
    POST /api/admin/fulfillment-service/enrollments/{id}/decide  — Approve with capacity, reject or request information
    POST /api/admin/fulfillment-service/enrollments/{id}/status  — Suspend, reinstate, offboard or close an enrollment
    POST /api/admin/fulfillment-service/fee-schedules  — Propose a new fee schedule with an effective date
    POST /api/admin/fulfillment-service/fees/{id}/reverse  — Reverse a fee charge with a reason
    POST /api/admin/fulfillment-service/inbound/{id}/arrive  — Record arrival at the dock
    POST /api/admin/fulfillment-service/inbound/{id}/discrepancy-decision  — Decide a claimed discrepancy (reimburse, adjust or reject)
    POST /api/admin/fulfillment-service/inbound/{id}/receive  — Record received and damaged units (partial or complete)
    POST /api/admin/fulfillment-service/removals/{id}/transition  — Approve, process, ship or complete a removal order
    POST /api/admin/fulfillment-service/returns/{id}/outcome  — Record the inspection outcome of a returned service unit
    POST /api/admin/fulfillment-service/skus/{id}/review  — Approve or reject a SKU for the service
    POST /api/admin/fulfillment-service/stock-differences/{id}/resolve  — Resolve a stock difference: adjust the ledger, reimburse the seller or leave it
  ### Admin API · Identity (13)
    GET /api/admin/identity/accounts  — Find accounts (staff or members)
    GET /api/admin/identity/accounts/{id}  — Account security detail (devices, lockout, recent activity)
    GET /api/admin/identity/accounts/{id}/security-activity  — Security activity of one account
    GET /api/admin/identity/invitations  — Staff invitations
    POST /api/admin/identity/accounts/{id}/disable  — Disable a staff account (offboarding)
    POST /api/admin/identity/accounts/{id}/enable  — Re-enable a disabled staff account
    POST /api/admin/identity/accounts/{id}/force-password-reset  — Require a new password at next sign-in
    POST /api/admin/identity/accounts/{id}/lock  — Lock an account (suspected compromise, offboarding)
    POST /api/admin/identity/accounts/{id}/reset-two-step  — Remove 2-step methods after an identity check (lost phone)
    POST /api/admin/identity/accounts/{id}/sign-out-all  — Sign an account out everywhere
    POST /api/admin/identity/accounts/{id}/unlock  — Unlock an account
    POST /api/admin/identity/invitations/{id}/resend  — Resend a staff invitation (new 7-day link)
    POST /api/admin/identity/invitations/{id}/revoke  — Cancel a staff invitation
  ### Admin API · Inventory (23)
    GET /api/admin/inventory/discrepancies  — Shortages and damage reported by the warehouse
    GET /api/admin/inventory/inbound/{id}  — One counted receipt: received, damaged, shortage and proposed sellable per line
    GET /api/admin/inventory/movements  — Movement ledger (adjustment history with reason, staff and date)
    GET /api/admin/inventory/reservations  — Holds and allocations by order or stock item
    GET /api/admin/inventory/return-outcomes  — Inspected Official Store returns waiting for their stock outcome
    GET /api/admin/inventory/stock-items/{id}  — Stock item with levels per location, reservations, incoming, pending adjustments and history
    GET /api/admin/inventory/transfers  — Transfers
    PATCH /api/admin/inventory/locations/{id}  — Rename, deactivate or change whether a location is sellable
    PATCH /api/admin/inventory/stock-items/{id}  — Change reorder point, reorder quantity or archive a company SKU
    POST /api/admin/inventory/adjustments/{id}/cancel  — Withdraw an adjustment waiting for review
    POST /api/admin/inventory/counts  — Start a stock count for a zone, bin range or SKU list
    POST /api/admin/inventory/counts/{id}/submit  — Submit a count; differences become count-correction adjustments
    POST /api/admin/inventory/discrepancies/{id}/resolve  — Resolve a shortage or damage report (reallocate, adjust or no change)
    POST /api/admin/inventory/locations  — Add a company stock location
    POST /api/admin/inventory/reservations/{id}/release  — Release a stuck hold or allocation (e.g. order closed without a cancel event)
    POST /api/admin/inventory/return-outcomes/{id}/record  — Record the stock outcome of a returned item
    POST /api/admin/inventory/stock-items  — Create a company stock item (SKU) at a location
    POST /api/admin/inventory/stock-items/{id}/merge  — Merge this company SKU into another one (e.g. after a catalog variant merge)
    POST /api/admin/inventory/transfers  — Plan a transfer between warehouses
    POST /api/admin/inventory/transfers/{id}/cancel  — Cancel a draft transfer
    POST /api/admin/inventory/transfers/{id}/receive  — Receive a transfer (received quantities per line)
    POST /api/admin/inventory/transfers/{id}/ship  — Send a transfer (source Available → destination Incoming)
    PUT /api/admin/inventory/counts/{id}/lines  — Record counted quantities
  ### Admin API · Media (12)
    DELETE /api/admin/media/assets/{id}  — Delete an unused platform file
    GET /api/admin/media/assets  — All files with filters
    GET /api/admin/media/assets/{id}  — File detail with usages, checks and history
    GET /api/admin/media/assets/{id}/download  — Signed link to a private file (verification documents, evidence)
    GET /api/admin/media/image-specs  — The product image spec in force
    PATCH /api/admin/media/assets/{id}  — Edit alt text or title of a platform file
    POST /api/admin/media/assets/{id}/checks  — Check an image against rules
    POST /api/admin/media/assets/{id}/remove  — Take a file down (policy, rights, privacy) with a reason
    POST /api/admin/media/assets/{id}/restore  — Restore a removed file
    POST /api/admin/media/uploads  — Start a staff upload (Official Store products, content, ad creatives, inspection photos, evidence)
    POST /api/admin/media/uploads/{id}/complete  — Confirm a staff upload
    PUT /api/admin/media/uploads/{id}/content  — Send the file bytes of a staff upload
  ### Admin API · Messaging (8)
    GET /api/admin/messaging/conversations  — Find conversations by order, customer or seller
    GET /api/admin/messaging/conversations/{id}/messages  — Read a private conversation (reason required, logged)
    GET /api/admin/messaging/reports  — Reported messages
    GET /api/admin/messaging/sellers/{sellerId}/response-stats  — A seller's reply performance
    POST /api/admin/messaging/conversations/{id}/lock  — Lock or unlock a conversation
    POST /api/admin/messaging/conversations/{id}/messages  — Post as Marketly Support (joins the conversation)
    POST /api/admin/messaging/messages/{id}/hide  — Hide a message that breaks the rules
    POST /api/admin/messaging/reports/{id}/decide  — Action or dismiss a report
  ### Admin API · Notifications (14)
    GET /api/admin/notifications/broadcasts  — Promotional broadcasts
    GET /api/admin/notifications/deliveries  — Delivery log
    GET /api/admin/notifications/deliveries/{id}  — One delivery with provider events
    GET /api/admin/notifications/stats  — Delivery rate, bounces, failures, queue size
    GET /api/admin/notifications/suppressions  — Bounced, complained or blocked addresses
    POST /api/admin/notifications/broadcasts  — Draft a broadcast to opted-in customers or sellers
    POST /api/admin/notifications/broadcasts/{id}/cancel  — Cancel a draft or scheduled broadcast
    POST /api/admin/notifications/broadcasts/{id}/schedule  — Schedule a broadcast
    POST /api/admin/notifications/deliveries/{id}/retry  — Retry a failed delivery
    POST /api/admin/notifications/inbox/archive-all  — Archive all (or one area) for me
    POST /api/admin/notifications/inbox/{id}/archive  — Archive one notice (for me)
    POST /api/admin/notifications/suppressions/{id}/remove  — Allow sending again (address fixed or confirmed by the person)
    POST /api/admin/notifications/templates/{id}/versions/{versionId}/discard  — Discard a draft
    POST /api/admin/notifications/templates/{id}/versions/{versionId}/preview  — Render with sample or real data on desktop or phone
  ### Admin API · Offers (20)
    GET /api/admin/offers/featured-rule  — Current, scheduled and past versions of the featured-offer rule
    GET /api/admin/offers/offers/{id}  — Offer with status log, price history and price changes
    GET /api/admin/offers/official/bulk-updates/{id}  — Official Store bulk job state and totals
    GET /api/admin/offers/official/bulk-updates/{id}/rows  — Official Store bulk preview rows
    GET /api/admin/offers/price-changes  — Pending, scheduled and recent price changes
    GET /api/admin/offers/products/{productId}/featured-decision  — Why an offer is (or is not) featured for a variant and location
    PATCH /api/admin/offers/official/offers/{id}  — Edit Official Store offer terms (not price; use price changes)
    POST /api/admin/offers/featured-decisions/recompute  — Recompute featured decisions for a product (or everything)
    POST /api/admin/offers/featured-rule/versions  — Publish a new version of the featured-offer rule with an effective date
    POST /api/admin/offers/offers/{id}/hold  — Hold an offer during an investigation (Ineligible, staff_hold) with a reason and review date
    POST /api/admin/offers/offers/{id}/reinstate  — Reinstate a removed offer as Paused (e.g. after a successful appeal)
    POST /api/admin/offers/offers/{id}/release-hold  — Release a staff hold
    POST /api/admin/offers/offers/{id}/remove  — Remove an offer with a reason (seller is told the reason and appeal route)
    POST /api/admin/offers/official/bulk-updates  — Upload an Official Store price file for preview
    POST /api/admin/offers/official/bulk-updates/{id}/apply  — Apply valid rows; rows above the price-change limit become approval requests
    POST /api/admin/offers/official/offers  — Create an Official Store offer linked to a company stock item
    POST /api/admin/offers/official/offers/{id}/pause  — Hide an Official Store offer
    POST /api/admin/offers/official/offers/{id}/publish  — Publish an Official Store offer
    POST /api/admin/offers/official/offers/{id}/resume  — Show a hidden Official Store offer again
    POST /api/admin/offers/price-changes/{id}/cancel  — Cancel a scheduled or pending price change
  ### Admin API · Orders (6)
    DELETE /api/admin/orders/saved-filters/{id}  — Delete a saved filter (own, or shared with orders.orders.manage)
    GET /api/admin/orders/exports/{id}  — Export status and download link (download is logged)
    GET /api/admin/orders/orders/{id}/history  — Full action history and timeline (customer, seller and staff entries)
    POST /api/admin/orders/orders/{id}/cancellation-requests/{requestId}/decide  — Decide a customer's cancellation request for the seller (or override a decline)
    POST /api/admin/orders/orders/{id}/groups/{groupId}/dispatch-deadline  — Set a final dispatch date for an overdue group
    POST /api/admin/orders/orders/{id}/resend-confirmation  — Send the order confirmation again
  ### Admin API · Payments (13)
    GET /api/admin/payments/disputes/{id}  — One dispute with order, evidence and seller balance effect
    GET /api/admin/payments/orders/{orderId}/summary  — Payment panel of an order (method, authorized, captured, processor ref, refunded, attempts)
    GET /api/admin/payments/payments  — Payments with status and flags (pending check, orphan, capture failed, chargeback)
    GET /api/admin/payments/payments/{id}  — Payment with tenders, allocations, captures, refunds, disputes, provider calls and webhooks
    GET /api/admin/payments/refunds/{id}  — One refund with items, attempts and history
    POST /api/admin/payments/disputes/{id}/accept  — Concede the dispute (the provider keeps the money)
    POST /api/admin/payments/disputes/{id}/assign  — Set the owner
    POST /api/admin/payments/payments/{id}/capture  — Capture an authorization manually (e.g. after a capture failure)
    POST /api/admin/payments/payments/{id}/check  — Ask the provider for the current result
    POST /api/admin/payments/payments/{id}/resolve-orphan  — Refund or link a payment that has no order
    POST /api/admin/payments/payments/{id}/void  — Void an authorization that should not be captured
    POST /api/admin/payments/refunds/{id}/cancel  — Cancel a requested or failed refund with a reason
    POST /api/admin/payments/refunds/{id}/retry  — Retry a failed refund (checks the provider first)
  ### Admin API · Promotions (14)
    GET /api/admin/promotions/campaigns/{id}/codes  — Codes with redemptions
    GET /api/admin/promotions/campaigns/{id}/eligible-offers  — Offers the scope resolves to, with exclusion and ineligibility reasons
    GET /api/admin/promotions/campaigns/{id}/flash-items  — Flash items with claimed and sold-out state
    GET /api/admin/promotions/campaigns/{id}/history  — Submission, decisions, status changes and edits with reasons
    GET /api/admin/promotions/campaigns/{id}/redemptions  — Redemptions with funding split and reversals
    GET /api/admin/promotions/campaigns/{id}/results  — Sales, discount cost by funder, margin impact, redemptions, returns and seller participation
    POST /api/admin/promotions/campaigns/{id}/cancel  — Cancel a campaign that has not started
    POST /api/admin/promotions/campaigns/{id}/codes  — Generate unique single-use codes (e.g. for support or partners)
    POST /api/admin/promotions/campaigns/{id}/end  — End a live or paused campaign early
    POST /api/admin/promotions/campaigns/{id}/invitations  — Invite sellers to join (consent required before their offers are included)
    POST /api/admin/promotions/codes/{id}/deactivate  — Deactivate a leaked or misused code
    POST /api/admin/promotions/participations/{id}/decide-withdrawal  — Approve or reject a seller's request to leave a live campaign
    POST /api/admin/promotions/participations/{id}/remove  — Remove a seller or some of its offers from a campaign
    PUT /api/admin/promotions/campaigns/{id}/flash-items  — Set flash sale offers, deal prices, deal stock and purchase limits
  ### Admin API · Purchasing (12)
    GET /api/admin/purchasing/claims  — Supplier claims for shortages and damage
    GET /api/admin/purchasing/receipts  — Receiving records (in progress, waiting for confirmation, with issues, completed)
    PATCH /api/admin/purchasing/deliveries/{id}  — Reschedule or mark a delivery delayed, with a reason
    PATCH /api/admin/purchasing/suppliers/{id}  — Edit or deactivate a supplier
    POST /api/admin/purchasing/claims/{id}/close  — Close a claim as rejected by the supplier or withdrawn
    POST /api/admin/purchasing/claims/{id}/settle  — Record the supplier's settlement (credit note, refund or replacement)
    POST /api/admin/purchasing/claims/{id}/submit  — Mark a claim as sent to the supplier
    POST /api/admin/purchasing/purchase-orders/from-suggestions  — Create draft POs (one per preferred supplier) from selected suggestions
    POST /api/admin/purchasing/purchase-orders/{id}/close  — Close a partly received PO short (remaining units will not arrive)
    POST /api/admin/purchasing/purchase-orders/{id}/deliveries  — Add an expected delivery (carrier, reference, arrival window)
    POST /api/admin/purchasing/receipts/{id}/cancel  — Discard a receiving record started by mistake
    PUT /api/admin/purchasing/suppliers/{id}/items  — Replace a supplier's price list (buying costs per SKU)
  ### Admin API · Reports (16)
    DELETE /api/admin/reports/saved-views/{id}  — Delete a saved view (owner only)
    DELETE /api/admin/reports/schedules/{id}  — Stop a schedule
    GET /api/admin/reports/export-datasets  — Export dataset registry: what each screen can export, its owner and permission
    GET /api/admin/reports/metrics  — Metric definitions
    GET /api/admin/reports/metrics/{key}  — A metric with its version history
    GET /api/admin/reports/read-models  — Read model health: lag, last event, rebuild state
    GET /api/admin/reports/saved-views  — My saved report views plus shared ones
    GET /api/admin/reports/schedules  — Report email schedules
    PATCH /api/admin/reports/metrics/{key}  — Revise a definition (new draft version)
    POST /api/admin/reports/metric-suggestions/{id}/decide  — Accept or decline a suggestion
    POST /api/admin/reports/metrics  — Create a metric definition (draft)
    POST /api/admin/reports/metrics/{key}/publish  — Publish the draft version with an effective date
    POST /api/admin/reports/metrics/{key}/retire  — Retire a metric
    POST /api/admin/reports/read-models/{key}/rebuild  — Rebuild a read model from source snapshots
    PUT /api/admin/reports/groups/{key}/owner  — Name (or change) the staff member who owns a report group
    PUT /api/admin/reports/metrics/{key}/owner  — Name (or change) the staff member who owns a metric
  ### Admin API · Returns (18)
    GET /api/admin/returns/policies  — Active baseline, scheduled changes and history
    GET /api/admin/returns/refunds  — Refund approval queue for Finance
    GET /api/admin/returns/refunds/{id}  — One refund request with breakdown, funding and earnings impact
    PATCH /api/admin/returns/category-exceptions/{id}  — Change or retire a category exception from a date
    POST /api/admin/returns/category-exceptions  — Add a category exception with an effective date
    POST /api/admin/returns/category-exceptions/preview  — Impact of a category exception change before saving
    POST /api/admin/returns/policies  — Propose a new baseline version with an effective date
    POST /api/admin/returns/policies/{id}/withdraw  — Withdraw a draft or scheduled baseline
    POST /api/admin/returns/refunds/{id}/approve  — Finance approves the refund and hands it to payments
    POST /api/admin/returns/refunds/{id}/decline  — Send a refund request back with a reason
    POST /api/admin/returns/refunds/{id}/revise  — Change a declined refund and resubmit
    POST /api/admin/returns/replacements/{id}/cancel  — Cancel a replacement or exchange not shipped yet with a reason
    POST /api/admin/returns/requests/{id}/approve  — Approve an Official Store return, or decide a seller return as the platform
    POST /api/admin/returns/requests/{id}/assign  — Set the owner of a return
    POST /api/admin/returns/requests/{id}/overturn  — Overturn a seller's rejection
    POST /api/admin/returns/requests/{id}/receive  — Record receipt at a seller's address for a platform-handled return
    POST /api/admin/returns/requests/{id}/reject  — Reject with an explanation
    POST /api/admin/returns/requests/{id}/take-over  — Platform intervention: Marketly takes over a seller return
  ### Admin API · Reviews (8)
    GET /api/admin/reviews/appeals  — Appeals of moderation decisions
    GET /api/admin/reviews/moderation-items/summary  — Open moderation counts for the nav badge and tabs
    GET /api/admin/reviews/official-store/reviews  — Product reviews of Official Store sales and Official Store feedback, to respond as the Official Store
    GET /api/admin/reviews/questions  — Customer questions on products, e.g. unanswered questions on Official Store products (plan ch. 9)
    GET /api/admin/reviews/reviews  — Search all product reviews
    PATCH /api/admin/reviews/official-store/responses/{id}  — Edit an Official Store response within the edit window
    POST /api/admin/reviews/appeals/{id}/decide  — Decide an appeal (not by the original moderator)
    POST /api/admin/reviews/official-store/responses  — Respond publicly as the Official Store
  ### Admin API · Search (11)
    DELETE /api/admin/search/synonyms/{id}  — Delete a synonym set
    GET /api/admin/search/explain  — Why results rank as they do for a query (scores, factors, synonyms, correction)
    GET /api/admin/search/index  — Index size, staleness and lag behind events
    GET /api/admin/search/lookup  — Back-office top-bar quick search across orders, sellers, products and customers
    GET /api/admin/search/reindex-jobs/{id}  — Reindex progress
    GET /api/admin/search/synonyms  — Search synonyms
    GET /api/admin/search/zero-result-queries  — Searches that found nothing (unavailable searches), most frequent first
    PATCH /api/admin/search/synonyms/{id}  — Edit or deactivate a synonym set
    POST /api/admin/search/ranking-policies  — Publish a new ranking policy version (wording and recommended-sort weights)
    POST /api/admin/search/reindex-jobs  — Reindex everything or a scope (products, category, brand, seller)
    POST /api/admin/search/synonyms  — Add a synonym set (takes effect on the next query; no reindex needed)
  ### Admin API · Sellers (19)
    GET /api/admin/sellers/appeals  — Appeals waiting for a decision
    GET /api/admin/sellers/seller-invitations  — Invitations sent and whether they applied
    POST /api/admin/sellers/appeals/{id}/assign  — Assign an appeal reviewer (not the original decider)
    POST /api/admin/sellers/appeals/{id}/decide  — Uphold, overturn or partly overturn
    POST /api/admin/sellers/applications/{id}/checks/{checkId}/rerun  — Run an automated check again (e.g. after a new document)
    POST /api/admin/sellers/applications/{id}/checks/{checkId}/result  — Record a manual check result or accept a 'needs attention' result with a note
    POST /api/admin/sellers/applications/{id}/trust-review  — Refer the application to Trust and Risk
    POST /api/admin/sellers/claims/{id}/revoke  — Remove an approved claim found to be false
    POST /api/admin/sellers/restrictions/{id}/lift  — Lift a restriction with a reason
    POST /api/admin/sellers/seller-invitations/{id}/revoke  — Revoke an unused invitation
    POST /api/admin/sellers/sellers/{id}/account-manager  — Set the seller's account manager
    POST /api/admin/sellers/sellers/{id}/close  — Close a seller account
    POST /api/admin/sellers/sellers/{id}/launch-review/decide  — Pass the launch readiness review or ask for changes
    POST /api/admin/sellers/sellers/{id}/reinstate  — End a suspension (optionally keeping restrictions)
    POST /api/admin/sellers/sellers/{id}/restrictions  — Restrict a seller (reason, affected activity, scope, appeal route, review date)
    POST /api/admin/sellers/sellers/{id}/verification  — Grant or revoke the Verified seller label
    POST /api/admin/sellers/sellers/{id}/warnings  — Send a performance or policy warning
    POST /api/admin/sellers/warnings/{id}/resolve  — Mark a warning resolved
    PUT /api/admin/sellers/performance-targets  — Change targets with an effective date
  ### Admin API · Settings (6)
    GET /api/admin/settings/business-calendar  — Open hours per day for a date range (business hours minus closures)
    GET /api/admin/settings/changes/{id}  — One change with impact, approval and timeline
    GET /api/admin/settings/feature-flags  — Feature flags
    GET /api/admin/settings/values/{key}/history  — All versions of a setting
    POST /api/admin/settings/changes/{id}/preview  — Recalculate the impact preview
    PUT /api/admin/settings/feature-flags/{key}  — Turn a feature flag on or off
  ### Admin API · Shipping (20)
    GET /api/admin/shipping/exceptions/{id}  — One exception with history
    GET /api/admin/shipping/shipments  — All shipments
    GET /api/admin/shipping/shipments/{id}  — Shipment history: events, corrections, label and exceptions
    PATCH /api/admin/shipping/carriers/{id}  — Activate, deactivate or rename a carrier, or update its contacts
    PATCH /api/admin/shipping/notices/{id}  — Edit a draft, scheduled or live notice
    POST /api/admin/shipping/carriers  — Add a carrier account
    POST /api/admin/shipping/claims/{id}/status  — Submit, record the carrier's decision or withdraw a claim
    POST /api/admin/shipping/exceptions  — Open an exception manually (e.g. lost or damaged reported by phone)
    POST /api/admin/shipping/exceptions/{id}/assign  — Set the owner
    POST /api/admin/shipping/free-shipping-rules  — Add a free-shipping rule
    POST /api/admin/shipping/notices/{id}/withdraw  — Withdraw a notice
    POST /api/admin/shipping/profiles  — Create an Official Store shipping profile
    POST /api/admin/shipping/shipments/{id}/correct-tracking  — Correct carrier or tracking as staff
    POST /api/admin/shipping/shipments/{id}/events  — Record a carrier status the integration missed (with evidence)
    POST /api/admin/shipping/zones  — Add a zone or excluded area
    PUT /api/admin/shipping/dispatch-targets  — Change dispatch targets from an effective date
    PUT /api/admin/shipping/free-shipping-rules/{id}  — Change or end a free-shipping rule
    PUT /api/admin/shipping/methods/{id}  — Change a method's name, customer label, transit or services
    PUT /api/admin/shipping/profiles/{id}  — Change Official Store rates (new version with an effective date)
    PUT /api/admin/shipping/zones/{id}  — Change a zone, enable or disable it
  ### Admin API · Support (9)
    DELETE /api/admin/support/cases/{id}/decision-draft  — Discard the decision draft
    PATCH /api/admin/support/cases/{id}  — Change category or priority with a reason
    POST /api/admin/support/cases  — Open a case on behalf of a customer or seller
    POST /api/admin/support/cases/{id}/appeal/decide  — Decide an appeal (reviewer must differ from the original decider)
    POST /api/admin/support/cases/{id}/evidence  — Attach evidence gathered by staff (carrier records, screenshots)
    POST /api/admin/support/cases/{id}/remedies/{remedyId}/settle  — Record that a remedy was completed or cancelled outside the system
    POST /api/admin/support/cases/{id}/reopen  — Reopen a resolved or closed case
    POST /api/admin/support/cases/{id}/request-info  — Ask the customer or the seller for information or evidence by a deadline
    PUT /api/admin/support/categories/{key}  — Create or change a category and its targets
  ### Admin API · Trust and risk (19)
    GET /api/admin/trust/detection-rules  — Automated detection rules with recent hits
    GET /api/admin/trust/enforcements  — Recorded enforcement with execution state
    GET /api/admin/trust/recommendations  — Recommendations waiting for my team
    PATCH /api/admin/trust/detection-rules/{key}  — Turn a rule on or off or change its thresholds
    POST /api/admin/trust/appeals/{id}/assign  — Assign a reviewer who did not make the decision
    POST /api/admin/trust/appeals/{id}/decide  — Uphold, overturn or partly overturn
    POST /api/admin/trust/enforcements/{id}/reverse  — Reverse an enforcement (overturned appeal or error)
    POST /api/admin/trust/recommendations/{id}/decide  — Owner team accepts (records enforcement) or declines with a reason
    POST /api/admin/trust/recommendations/{id}/withdraw  — Withdraw a recommendation
    POST /api/admin/trust/reports  — Open a report as staff
    POST /api/admin/trust/reports/{id}/assessment  — Record the risk assessment for a seller application or account
    POST /api/admin/trust/reports/{id}/escalate  — Escalate to the Trust and Risk Manager or Business Owner
    POST /api/admin/trust/reports/{id}/evidence  — Add evidence (check result, document, photo, note, linked record)
    POST /api/admin/trust/reports/{id}/links  — Link more subjects or a support case
    POST /api/admin/trust/reports/{id}/merge  — Merge a duplicate report into another
    POST /api/admin/trust/reports/{id}/notes  — Internal note
    POST /api/admin/trust/reports/{id}/reopen  — Reopen with a reason (new evidence)
    POST /api/admin/trust/reports/{id}/resolve  — Resolve with an outcome and what the reporter is told
    POST /api/admin/trust/reports/{id}/risk-score  — Override the risk score with a reason
  ### Admin API · Wallet (10)
    GET /api/admin/wallet/customers/{customerId}  — A customer's credit balance, lots, goodwill in the last 30 days and pending grants
    GET /api/admin/wallet/customers/{customerId}/entries  — A customer's credit ledger
    GET /api/admin/wallet/gift-cards  — Gift cards
    GET /api/admin/wallet/gift-cards/batches/{id}/codes  — Download a batch's gift card codes once
    GET /api/admin/wallet/goodwill  — Goodwill grants for review
    POST /api/admin/wallet/customers/{customerId}/corrections  — Correct a balance (positive or negative) with a reason
    POST /api/admin/wallet/gift-cards  — Issue a batch of gift cards
    POST /api/admin/wallet/gift-cards/{id}/void  — Void a gift card (lost, fraud)
    POST /api/admin/wallet/goodwill  — Grant goodwill credit with a reason
    POST /api/admin/wallet/goodwill/{id}/reverse  — Reverse an unused goodwill grant
  ### Admin API · Warehouse (16)
    GET /api/admin/warehouse/bins  — Bins with their kind and assigned items
    GET /api/admin/warehouse/packages/{id}/packing-slip  — Packing slip listing only this seller group's items, package n of N, returns note
    GET /api/admin/warehouse/putaway-tasks  — Received units to put away, with suggested bins
    GET /api/admin/warehouse/putaway-tasks/labels  — Printable item and put-away labels for a receipt's units (SKU barcode, label, suggested bin, quantity)
    GET /api/admin/warehouse/return-parcels  — Return parcels expected, received and handed over
    GET /api/admin/warehouse/scan  — Resolve a scanned barcode (bin, item, order, package or return label)
    GET /api/admin/warehouse/waves/{id}  — Pick list grouped by order with bins in walking order, progress and next bin
    PATCH /api/admin/warehouse/bins/{id}  — Change kind or deactivate a bin
    POST /api/admin/warehouse/bins  — Create bins (one or a list of codes)
    POST /api/admin/warehouse/fulfillments/{id}/resume  — Resume a held fulfillment after the shortage or damage is resolved
    POST /api/admin/warehouse/packages/{id}/void-label  — Void the label (e.g. wrong service) before the package is packed
    POST /api/admin/warehouse/putaway-tasks/{id}/complete  — Confirm put-away by scanning the bin
    POST /api/admin/warehouse/return-parcels  — Receive a return parcel at the warehouse (scan the return label or reference)
    POST /api/admin/warehouse/return-parcels/{id}/hand-over  — Hand a received parcel to returns inspection
    PUT /api/admin/warehouse/box-types  — Replace the list of box and mailer sizes
    PUT /api/admin/warehouse/stock-items/{stockItemId}/bins  — Set the bins a company stock item is stored in (one primary)
  ### Admin API · Wishlist (1)
    GET /api/admin/wishlist/insights  — Most saved products and alert counts (aggregates only, no customer data)
  ### Admin API · Work queues (27)
    DELETE /api/admin/workqueues/saved-filters/{id}  — Delete a saved filter (owner only)
    GET /api/admin/workqueues/coverage-gaps  — Queues without a lead or backup, leads who are away without cover, one backup covering many queues
    GET /api/admin/workqueues/day-end-reviews  — Past day-end reviews
    GET /api/admin/workqueues/day-end-reviews/current  — Today's day-end review
    GET /api/admin/workqueues/intake-rules  — Which events open and close items in which queue
    GET /api/admin/workqueues/items  — Work items with filters (also used by saved filters)
    GET /api/admin/workqueues/items/{id}  — One work item with notes and history
    GET /api/admin/workqueues/queues/{key}  — One queue definition with its intake rules
    GET /api/admin/workqueues/routine-templates  — Daily routine definitions
    GET /api/admin/workqueues/summary  — Dashboard: queues past or near target, overdue dispatch, team on shift
    PATCH /api/admin/workqueues/queues/{key}  — Change lead, backup, escalation route or deadline
    PATCH /api/admin/workqueues/saved-filters/{id}  — Rename, share or change a saved filter (owner only)
    POST /api/admin/workqueues/items  — Create a task by hand (managers assigning daily tasks)
    POST /api/admin/workqueues/items/bulk-assign  — Assign many items at once
    POST /api/admin/workqueues/items/{id}/assign  — Assign to a person (owner and next action)
    POST /api/admin/workqueues/items/{id}/claim  — Assign to myself and start
    POST /api/admin/workqueues/items/{id}/dismiss  — Dismiss with a reason (false alarm, duplicate)
    POST /api/admin/workqueues/items/{id}/escalate  — Escalate now to the next step of the route
    POST /api/admin/workqueues/items/{id}/notes  — Add a note
    POST /api/admin/workqueues/items/{id}/reopen  — Reopen a resolved or dismissed item
    POST /api/admin/workqueues/items/{id}/resolve  — Resolve by hand with a note
    POST /api/admin/workqueues/items/{id}/resume  — Back in progress
    POST /api/admin/workqueues/items/{id}/start  — Mark in progress
    POST /api/admin/workqueues/items/{id}/wait  — Waiting on someone else
    POST /api/admin/workqueues/queues  — Create a queue (lead, backup and escalation route required)
    POST /api/admin/workqueues/routine-checks/{id}/complete  — Mark a routine check done (or check in for a shared one)
    PUT /api/admin/workqueues/routine-templates  — Replace the daily routine

## Backend public operations NOT called by any frontend (6 of 21)
  ### Public API · Customers (1)
    POST /api/public/customers/unsubscribe  — One-click stop of promotional messages from an email or SMS link
  ### Public API · Identity (4)
    POST /api/public/identity/app-sessions  — Start an app session: the visitor token every request needs
    POST /api/public/identity/external-sign-ins  — Continue with Google or Apple
    POST /api/public/identity/sessions/refresh  — Exchange a refresh token for new tokens
    POST /api/public/identity/sessions/sign-out  — Sign out this device
  ### Public API · Trust and risk (1)
    POST /api/public/trust/reports  — Brand or rights owner reports counterfeit listings

## Backend other operations NOT called by any frontend (9 of 9)
  ### Webhooks · Finance (1)
    POST /webhooks/finance/payouts  — Payout provider status (paid, failed, returned)
  ### Webhooks · Media (2)
    POST /webhooks/media/processing-results  — Video transcoding results
    POST /webhooks/media/storage-events  — Object-created notifications from storage
  ### Webhooks · Notifications (3)
    POST /webhooks/notifications/email-events  — Delivery, bounce, complaint and open events from the email provider
    POST /webhooks/notifications/inbound-email  — Replies to case and message emails
    POST /webhooks/notifications/sms-events  — SMS delivery receipts and STOP replies
  ### Webhooks · Payments (1)
    POST /webhooks/payments/providers/{provider}/events  — Payment provider events (authorization, capture, refund, dispute, card updates)
  ### Webhooks · Sellers (1)
    POST /webhooks/sellers/verification-results  — Identity and business verification results from the provider
  ### Webhooks · Shipping (1)
    POST /webhooks/shipping/carriers/{carrier}/events  — Tracking events from a carrier or carrier aggregator

## Per-app usage counts
  store: 186 distinct typed calls
  seller: 183 distinct typed calls
  admin: 323 distinct typed calls
  shared: 2 distinct typed calls

## Raw /api|/graphql|/files string literals (non-typed usage), per app
  [store]
    /api/dev/payments/intents/${encodeURIComponent(intentId)}/settle <- frontend/src/pages/store/data/checkout-api.ts
  [seller]
  [admin]
    /api/admin/advertising/campaigns/{id}/${action} <- admin-center/src/pages/admin/data/ad-actions.tsx
    /files/ <- admin-center/src/pages/admin/data/reports.ts
  [shared]
    /api/${session.audience}/media <- web-shared/src/api/uploads.ts
    /api/${session.audience}/media/image-specs <- web-shared/src/api/imageSpec.ts
    /api/ <- web-shared/src/api/uploads.ts
    /api/public/identity <- web-shared/src/api/session.ts

## Used typed calls per app (for reference)
  [store]
    DELETE /api/store/cart/cart/coupons/{code} <- frontend/src/pages/store/Cart.tsx
    DELETE /api/store/cart/cart/items/{id} <- frontend/src/pages/store/Cart.tsx
    DELETE /api/store/checkout/sessions/{id} <- frontend/src/pages/store/CheckoutReviewChanges.tsx
    DELETE /api/store/checkout/sessions/{id}/coupons/{code} <- frontend/src/pages/store/Checkout.tsx
    DELETE /api/store/customers/addresses/{id} <- frontend/src/pages/account/Addresses.tsx
    DELETE /api/store/customers/recently-viewed <- frontend/src/pages/account/Wishlist.tsx, frontend/src/pages/store/Home.tsx
    DELETE /api/store/payments/methods/{id} <- frontend/src/pages/account/PaymentMethods.tsx
    DELETE /api/store/promotions/coupons/{campaignId}/clip <- frontend/src/pages/store/Deals.tsx
    DELETE /api/store/promotions/events/{campaignId}/reminder <- frontend/src/pages/store/Deals.tsx
    DELETE /api/store/reviews/me/feedback/{id} <- frontend/src/pages/account/Reviews.tsx
    DELETE /api/store/reviews/me/reviews/{id} <- frontend/src/pages/account/Reviews.tsx
    DELETE /api/store/search/recent-searches <- frontend/src/api/suggestions.tsx
    DELETE /api/store/search/recent-searches/{id} <- frontend/src/api/suggestions.tsx
    DELETE /api/store/sellers/applications/{id}/documents/{documentId} <- frontend/src/pages/sell/Apply.tsx, frontend/src/pages/sell/Status.tsx
    GET /api/public/finance/fee-schedule <- frontend/src/pages/sell/Landing.tsx
    GET /api/public/identity/password-policy <- frontend/src/pages/account/Security.tsx, frontend/src/pages/auth/data/parts.tsx
    GET /api/public/settings/app-config <- frontend/src/pages/help/Article.tsx, frontend/src/pages/info/About.tsx, frontend/src/pages/info/Policy.tsx, frontend/src/pages/store/data/checkout-api.ts, frontend/src/pages/store/NotFound.tsx
    GET /api/store/cart/cart <- frontend/src/layouts/StoreLayout.tsx, frontend/src/pages/store/Cart.tsx, frontend/src/pages/store/data/product.ts
    GET /api/store/cart/cart/badge <- frontend/src/app/session.tsx
    GET /api/store/catalog/brands <- frontend/src/pages/store/Categories.tsx
    GET /api/store/catalog/brands/{slug} <- frontend/src/api/catalog.ts
    GET /api/store/catalog/categories <- frontend/src/api/catalog.ts, frontend/src/pages/store/data/product.ts
    GET /api/store/catalog/categories/{slug} <- frontend/src/pages/store/Category.tsx
    GET /api/store/catalog/products/{id} <- frontend/src/pages/store/data/product.ts, frontend/src/pages/store/SearchEmpty.tsx
    GET /api/store/checkout/sessions/{id} <- frontend/src/pages/store/CheckoutReviewChanges.tsx, frontend/src/pages/store/data/checkout-api.ts
    GET /api/store/checkout/sessions/{id}/changes/{changeSetId} <- frontend/src/pages/store/CheckoutReviewChanges.tsx
    GET /api/store/checkout/sessions/{id}/confirmation <- frontend/src/pages/store/Confirmation.tsx
    GET /api/store/content/collections <- frontend/src/pages/store/Brand.tsx, frontend/src/pages/store/Official.tsx
    GET /api/store/content/help <- frontend/src/pages/help/Center.tsx
    GET /api/store/content/help/articles <- frontend/src/pages/help/Center.tsx
    GET /api/store/content/help/articles/{slug} <- frontend/src/pages/help/Article.tsx
    GET /api/store/content/home <- frontend/src/pages/store/Home.tsx
    GET /api/store/content/navigation <- frontend/src/api/content.ts
    GET /api/store/content/official-store <- frontend/src/api/content.ts
    GET /api/store/content/pages/{slug} <- frontend/src/pages/info/About.tsx, frontend/src/pages/store/Collection.tsx
    GET /api/store/content/pages/{slug}/products <- frontend/src/pages/store/Collection.tsx
    GET /api/store/content/policies <- frontend/src/pages/info/Policy.tsx
    GET /api/store/content/policies/{key} <- frontend/src/pages/auth/Register.tsx, frontend/src/pages/info/Policy.tsx
    GET /api/store/content/policies/{key}/versions <- frontend/src/pages/info/Policy.tsx
    GET /api/store/content/policy-versions/{id} <- frontend/src/pages/info/Policy.tsx
    GET /api/store/customers/addresses <- frontend/src/pages/account/Addresses.tsx, frontend/src/pages/account/PaymentMethods.tsx, frontend/src/pages/store/Checkout.tsx, frontend/src/pages/store/data/deliver-to.tsx
    GET /api/store/customers/closure-eligibility <- frontend/src/pages/account/Profile.tsx
    GET /api/store/customers/data-requests <- frontend/src/pages/account/Profile.tsx
    GET /api/store/customers/marketing-preferences <- frontend/src/pages/account/Profile.tsx
    GET /api/store/customers/profile <- frontend/src/app/session.tsx, frontend/src/pages/account/Profile.tsx, frontend/src/pages/account/Security.tsx
    GET /api/store/customers/recently-viewed <- frontend/src/pages/account/Wishlist.tsx, frontend/src/pages/store/Cart.tsx, frontend/src/pages/store/Home.tsx
    GET /api/store/identity/security <- frontend/src/pages/account/Profile.tsx, frontend/src/pages/account/Security.tsx
    GET /api/store/identity/security-activity <- frontend/src/pages/account/Security.tsx
    GET /api/store/messaging/conversations <- frontend/src/pages/account/Messages.tsx
    GET /api/store/messaging/conversations/{id} <- frontend/src/pages/account/Messages.tsx
    GET /api/store/messaging/conversations/{id}/messages <- frontend/src/pages/account/Messages.tsx
    GET /api/store/messaging/unread-count <- frontend/src/layouts/AccountLayout.tsx
    GET /api/store/notifications/inbox <- frontend/src/pages/account/Notifications.tsx
    GET /api/store/notifications/inbox/summary <- frontend/src/app/session.tsx
    GET /api/store/offers/products/{productId}/offers <- frontend/src/pages/store/data/offers.ts, frontend/src/pages/store/SearchEmpty.tsx
    GET /api/store/offers/products/{productId}/purchase-box <- frontend/src/pages/store/data/product.ts, frontend/src/pages/store/SearchEmpty.tsx
    GET /api/store/orders/orders <- frontend/src/pages/account/Addresses.tsx, frontend/src/pages/account/Messages.tsx, frontend/src/pages/help/Center.tsx, frontend/src/pages/help/Contact.tsx, frontend/src/pages/help/OrderProblem.tsx
    GET /api/store/orders/orders/counts <- frontend/src/pages/account/Orders.tsx
    GET /api/store/orders/orders/{id} <- frontend/src/pages/account/Messages.tsx, frontend/src/pages/auth/GuestOrders.tsx
    GET /api/store/orders/orders/{id}/cancellation-options <- frontend/src/pages/account/Cancel.tsx
    GET /api/store/orders/orders/{id}/documents/{documentId} <- frontend/src/pages/account/data/orders.ts, frontend/src/pages/store/Confirmation.tsx
    GET /api/store/payments/intents/{id} <- frontend/src/pages/store/data/checkout-api.ts
    GET /api/store/payments/methods <- frontend/src/pages/account/PaymentMethods.tsx
    GET /api/store/promotions/campaigns/{id}/eligible-products <- frontend/src/pages/store/Deals.tsx
    GET /api/store/promotions/coupons <- frontend/src/pages/account/Coupons.tsx
    GET /api/store/promotions/deals <- frontend/src/pages/store/Deals.tsx
    GET /api/store/returns/orders/{orderId}/returnable-items <- frontend/src/pages/account/ReturnNew.tsx
    GET /api/store/returns/policy <- frontend/src/pages/account/ReturnNew.tsx
    GET /api/store/returns/requests <- frontend/src/pages/account/Returns.tsx
    GET /api/store/returns/requests/overview <- frontend/src/pages/account/Returns.tsx
    GET /api/store/returns/requests/{id} <- frontend/src/pages/account/Return.tsx
    GET /api/store/reviews/me/feedback <- frontend/src/pages/account/Review.tsx, frontend/src/pages/account/Reviews.tsx
    GET /api/store/reviews/me/pending <- frontend/src/pages/account/Review.tsx, frontend/src/pages/account/Reviews.tsx
    GET /api/store/reviews/me/reports <- frontend/src/pages/account/Reviews.tsx
    GET /api/store/reviews/me/review-context/{orderItemId} <- frontend/src/pages/account/Review.tsx
    GET /api/store/reviews/me/reviews <- frontend/src/pages/account/Reviews.tsx
    GET /api/store/reviews/products/{productId}/questions <- frontend/src/pages/store/data/questions.ts
    GET /api/store/reviews/products/{productId}/rating-summary <- frontend/src/pages/store/data/product.ts, frontend/src/pages/store/SearchEmpty.tsx
    GET /api/store/reviews/products/{productId}/reviews <- frontend/src/pages/store/data/reviews.ts
    GET /api/store/reviews/sellers/{sellerId}/feedback <- frontend/src/pages/store/Seller.tsx
    GET /api/store/reviews/sellers/{sellerId}/feedback-summary <- frontend/src/pages/store/Seller.tsx
    GET /api/store/search/cards <- frontend/src/api/search.ts, frontend/src/pages/store/Cart.tsx
    GET /api/store/search/facets <- frontend/src/api/search.ts
    GET /api/store/search/products <- frontend/src/api/search.ts, frontend/src/pages/store/Categories.tsx
    GET /api/store/search/products/{productId}/similar <- frontend/src/pages/store/data/product.ts, frontend/src/pages/store/SearchEmpty.tsx
    GET /api/store/search/recent-searches <- frontend/src/api/suggestions.tsx
    GET /api/store/search/suggestions <- frontend/src/api/suggestions.tsx
    GET /api/store/sellers/applications/current <- frontend/src/pages/sell/Apply.tsx, frontend/src/pages/sell/data/application.ts
    GET /api/store/sellers/program <- frontend/src/pages/sell/data/program.ts
    GET /api/store/sellers/stores/{slug} <- frontend/src/pages/store/Seller.tsx
    GET /api/store/support/cases <- frontend/src/pages/help/Cases.tsx, frontend/src/pages/help/Center.tsx
    GET /api/store/support/contact-options <- frontend/src/pages/help/Center.tsx, frontend/src/pages/help/Contact.tsx
    GET /api/store/support/orders/{orderId}/problem-context <- frontend/src/pages/help/Contact.tsx, frontend/src/pages/help/OrderProblem.tsx
    GET /api/store/trust/reports <- frontend/src/pages/account/Reviews.tsx
    PATCH /api/store/cart/cart/items/{id} <- frontend/src/pages/store/Cart.tsx
    PATCH /api/store/customers/addresses/{id} <- frontend/src/pages/account/Addresses.tsx
    PATCH /api/store/customers/profile <- frontend/src/pages/account/Profile.tsx
    PATCH /api/store/payments/methods/{id} <- frontend/src/pages/account/PaymentMethods.tsx
    PATCH /api/store/reviews/me/feedback/{id} <- frontend/src/pages/account/Review.tsx
    PATCH /api/store/reviews/me/reviews/{id} <- frontend/src/pages/account/Review.tsx
    PATCH /api/store/sellers/applications/{id} <- frontend/src/pages/sell/Apply.tsx, frontend/src/pages/sell/Status.tsx
    POST /api/public/identity/order-links/redeem <- frontend/src/pages/auth/GuestOrders.tsx
    POST /api/public/identity/password-resets <- frontend/src/pages/auth/Recover.tsx
    POST /api/public/identity/password-resets/complete <- frontend/src/pages/auth/Recover.tsx
    POST /api/public/identity/password-resets/lookups <- frontend/src/pages/auth/Recover.tsx
    POST /api/public/identity/registrations <- frontend/src/pages/auth/Register.tsx
    POST /api/public/identity/sessions <- frontend/src/pages/auth/SignIn.tsx
    POST /api/public/identity/sign-in-challenges/{id}/send-sms <- frontend/src/pages/auth/SignIn.tsx
    POST /api/public/identity/sign-in-challenges/{id}/verify <- frontend/src/pages/auth/SignIn.tsx
    POST /api/public/identity/verifications/{id}/confirm <- frontend/src/pages/account/Profile.tsx, frontend/src/pages/auth/Register.tsx
    POST /api/public/identity/verifications/{id}/resend <- frontend/src/pages/account/Profile.tsx, frontend/src/pages/auth/Register.tsx
    POST /api/store/advertising/decisions <- frontend/src/api/ads.tsx
    POST /api/store/advertising/events <- frontend/src/api/ad-events.ts
    POST /api/store/cart/cart/coupons <- frontend/src/pages/store/Cart.tsx
    POST /api/store/cart/cart/items <- frontend/src/pages/account/data/orders.ts, frontend/src/pages/store/data/product.ts, frontend/src/pages/store/SearchEmpty.tsx
    POST /api/store/cart/cart/items/{id}/accept <- frontend/src/pages/store/Cart.tsx
    POST /api/store/cart/cart/merge <- frontend/src/pages/auth/data/parts.tsx
    POST /api/store/checkout/sessions <- frontend/src/pages/store/Cart.tsx, frontend/src/pages/store/Checkout.tsx, frontend/src/pages/store/data/product.ts
    POST /api/store/checkout/sessions/{id}/changes/{changeSetId}/accept <- frontend/src/pages/store/CheckoutReviewChanges.tsx
    POST /api/store/checkout/sessions/{id}/complete-action <- frontend/src/pages/store/PaymentResult.tsx
    POST /api/store/checkout/sessions/{id}/coupons <- frontend/src/pages/store/Checkout.tsx
    POST /api/store/checkout/sessions/{id}/place <- frontend/src/pages/store/Checkout.tsx
    POST /api/store/checkout/sessions/{id}/retry-payment <- frontend/src/pages/store/Checkout.tsx, frontend/src/pages/store/PaymentResult.tsx
    POST /api/store/content/help/articles/{id}/feedback <- frontend/src/pages/help/Article.tsx
    POST /api/store/customers/addresses <- frontend/src/pages/account/Addresses.tsx
    POST /api/store/customers/addresses/{id}/make-default <- frontend/src/pages/account/Addresses.tsx
    POST /api/store/customers/data-requests/closure <- frontend/src/pages/account/Profile.tsx
    POST /api/store/customers/data-requests/exports <- frontend/src/pages/account/Profile.tsx
    POST /api/store/customers/data-requests/{id}/cancel <- frontend/src/pages/account/Profile.tsx
    POST /api/store/customers/guest-orders/links <- frontend/src/pages/auth/GuestOrders.tsx
    POST /api/store/customers/guest-orders/lookup <- frontend/src/pages/auth/GuestOrders.tsx
    POST /api/store/customers/recently-viewed <- frontend/src/pages/store/data/product.ts
    POST /api/store/identity/devices/sign-out-all <- frontend/src/pages/account/Security.tsx
    POST /api/store/identity/devices/{id}/sign-out <- frontend/src/pages/account/Security.tsx
    POST /api/store/identity/email-changes <- frontend/src/pages/account/Profile.tsx
    POST /api/store/identity/reauth <- frontend/src/pages/account/Profile.tsx, frontend/src/pages/account/Security.tsx
    POST /api/store/identity/two-step/methods/{id}/remove <- frontend/src/pages/account/Security.tsx
    POST /api/store/identity/two-step/setups <- frontend/src/pages/account/Security.tsx
    POST /api/store/identity/two-step/setups/{id}/confirm <- frontend/src/pages/account/Security.tsx
    POST /api/store/messaging/conversations <- frontend/src/pages/account/Messages.tsx
    POST /api/store/messaging/conversations/{id}/messages <- frontend/src/pages/account/Messages.tsx
    POST /api/store/messaging/conversations/{id}/read <- frontend/src/pages/account/Messages.tsx
    POST /api/store/messaging/product-conversations <- frontend/src/pages/store/data/ask-seller.tsx
    POST /api/store/notifications/inbox/archive-all <- frontend/src/pages/account/Notifications.tsx
    POST /api/store/notifications/inbox/read-all <- frontend/src/pages/account/Notifications.tsx
    POST /api/store/notifications/inbox/{id}/archive <- frontend/src/pages/account/Notifications.tsx
    POST /api/store/notifications/inbox/{id}/read <- frontend/src/pages/account/Notifications.tsx
    POST /api/store/orders/orders/{id}/cancellation-preview <- frontend/src/pages/account/Cancel.tsx
    POST /api/store/orders/orders/{id}/cancellations <- frontend/src/pages/account/Cancel.tsx
    POST /api/store/payments/intents/{id}/check <- frontend/src/pages/store/PaymentResult.tsx
    POST /api/store/payments/methods <- frontend/src/pages/account/PaymentMethods.tsx
    POST /api/store/payments/methods/setup <- frontend/src/pages/account/PaymentMethods.tsx
    POST /api/store/payments/methods/{id}/make-default <- frontend/src/pages/account/PaymentMethods.tsx
    POST /api/store/promotions/coupons/{campaignId}/clip <- frontend/src/pages/account/Coupons.tsx, frontend/src/pages/store/Deals.tsx
    POST /api/store/promotions/events/{campaignId}/reminder <- frontend/src/pages/store/Deals.tsx
    POST /api/store/returns/eligibility <- frontend/src/pages/account/ReturnNew.tsx
    POST /api/store/returns/requests <- frontend/src/pages/account/ReturnNew.tsx
    POST /api/store/returns/requests/{id}/label/email <- frontend/src/pages/account/Return.tsx
    POST /api/store/reviews/me/appeals <- frontend/src/pages/account/Reviews.tsx
    POST /api/store/reviews/me/feedback <- frontend/src/pages/account/Review.tsx
    POST /api/store/reviews/me/reviews <- frontend/src/pages/account/Review.tsx
    POST /api/store/reviews/products/{productId}/questions <- frontend/src/pages/store/data/questions.ts
    POST /api/store/reviews/reports <- frontend/src/pages/store/data/reviews.ts
    POST /api/store/reviews/votes <- frontend/src/pages/store/data/reviews.ts
    POST /api/store/search/searches/{searchId}/clicks <- frontend/src/api/search.ts
    POST /api/store/sellers/applications <- frontend/src/pages/sell/Apply.tsx
    POST /api/store/sellers/applications/{id}/appeal <- frontend/src/pages/sell/Status.tsx
    POST /api/store/sellers/applications/{id}/documents <- frontend/src/pages/sell/Apply.tsx, frontend/src/pages/sell/Status.tsx
    POST /api/store/sellers/applications/{id}/respond <- frontend/src/pages/sell/Status.tsx
    POST /api/store/sellers/applications/{id}/submit <- frontend/src/pages/sell/Apply.tsx
    POST /api/store/shipping/shipments/{id}/delivery-choice <- frontend/src/pages/account/Tracking.tsx
    POST /api/store/support/cases <- frontend/src/pages/help/Contact.tsx, frontend/src/pages/help/OrderProblem.tsx
    POST /api/store/support/cases/{id}/appeal <- frontend/src/pages/help/Case.tsx
    POST /api/store/support/cases/{id}/escalate <- frontend/src/pages/help/Case.tsx
    POST /api/store/support/cases/{id}/messages <- frontend/src/pages/help/Case.tsx
    POST /api/store/support/cases/{id}/offers/{offerId}/respond <- frontend/src/pages/help/Case.tsx
    POST /api/store/support/cases/{id}/reopen <- frontend/src/pages/help/Case.tsx
    PUT /api/store/cart/cart/destination <- frontend/src/pages/store/data/deliver-to.tsx
    PUT /api/store/checkout/sessions/{id}/address <- frontend/src/pages/store/Checkout.tsx
    PUT /api/store/checkout/sessions/{id}/contact <- frontend/src/pages/store/Checkout.tsx
    PUT /api/store/checkout/sessions/{id}/credit <- frontend/src/pages/store/Checkout.tsx
    PUT /api/store/checkout/sessions/{id}/delivery <- frontend/src/pages/store/Checkout.tsx
    PUT /api/store/checkout/sessions/{id}/payment-method <- frontend/src/pages/store/Checkout.tsx
    PUT /api/store/customers/marketing-preferences <- frontend/src/pages/account/Profile.tsx
    PUT /api/store/identity/password <- frontend/src/pages/account/Security.tsx
    PUT /api/store/sellers/applications/{id}/response-draft <- frontend/src/pages/sell/Status.tsx
  [seller]
    DELETE /api/seller/catalog/products/{id} <- seller-center/src/pages/ProductNew.tsx, seller-center/src/pages/Products.tsx
    DELETE /api/seller/messaging/templates/{id} <- seller-center/src/pages/Customers.tsx
    DELETE /api/seller/reviews/questions/{id}/skip <- seller-center/src/pages/Customers.tsx
    DELETE /api/seller/sellers/store-profile/collections/{id} <- seller-center/src/pages/Store.tsx
    DELETE /api/seller/shipping/closures/{id} <- seller-center/src/pages/Shipping.tsx
    GET /api/seller/advertising/campaigns <- seller-center/src/pages/Marketing.tsx
    GET /api/seller/advertising/campaigns/{id} <- seller-center/src/pages/AdRequest.tsx
    GET /api/seller/advertising/pricing <- seller-center/src/pages/AdRequest.tsx
    GET /api/seller/advertising/promotable-offers <- seller-center/src/pages/AdRequest.tsx
    GET /api/seller/advertising/summary <- seller-center/src/pages/Marketing.tsx
    GET /api/seller/catalog/brands <- seller-center/src/pages/ProductNew.tsx, seller-center/src/pages/Store.tsx
    GET /api/seller/catalog/categories/{id}/attributes <- seller-center/src/pages/ProductNew.tsx
    GET /api/seller/catalog/match <- seller-center/src/pages/CatalogMatch.tsx
    GET /api/seller/catalog/products <- seller-center/src/pages/Products.tsx
    GET /api/seller/content/help <- seller-center/src/pages/data/help-articles.ts
    GET /api/seller/content/help/articles <- seller-center/src/pages/data/help-articles.ts
    GET /api/seller/content/help/articles/{slug} <- seller-center/src/pages/data/help-articles.ts
    GET /api/seller/finance/balances <- seller-center/src/pages/Dashboard.tsx, seller-center/src/pages/Finance.tsx
    GET /api/seller/finance/fee-schedule <- seller-center/src/pages/Help.tsx, seller-center/src/pages/Offer.tsx
    GET /api/seller/finance/ledger <- seller-center/src/pages/Finance.tsx
    GET /api/seller/finance/ledger/exports/{id} <- seller-center/src/pages/Finance.tsx
    GET /api/seller/finance/payouts <- seller-center/src/pages/Finance.tsx
    GET /api/seller/finance/statements <- seller-center/src/pages/Finance.tsx
    GET /api/seller/finance/statements/{id} <- seller-center/src/pages/Statement.tsx
    GET /api/seller/finance/statements/{id}/download <- seller-center/src/pages/Statement.tsx
    GET /api/seller/identity/session/sellers <- seller-center/src/app/session.tsx, seller-center/src/app/SignIn.tsx
    GET /api/seller/inventory/movements <- seller-center/src/pages/Inventory.tsx
    GET /api/seller/inventory/stock-items <- seller-center/src/pages/Inventory.tsx
    GET /api/seller/inventory/stock-items/exports/{id} <- seller-center/src/pages/Inventory.tsx
    GET /api/seller/inventory/summary <- seller-center/src/app/session.tsx, seller-center/src/pages/Inventory.tsx
    GET /api/seller/messaging/conversations <- seller-center/src/pages/Customers.tsx
    GET /api/seller/messaging/conversations/{id} <- seller-center/src/pages/Customers.tsx
    GET /api/seller/messaging/conversations/{id}/messages <- seller-center/src/pages/Customers.tsx
    GET /api/seller/messaging/response-stats <- seller-center/src/app/session.tsx, seller-center/src/pages/Customers.tsx, seller-center/src/pages/Order.tsx
    GET /api/seller/messaging/templates <- seller-center/src/pages/Customers.tsx
    GET /api/seller/notifications/inbox <- seller-center/src/pages/Notifications.tsx
    GET /api/seller/notifications/inbox/summary <- seller-center/src/app/session.tsx, seller-center/src/pages/Notifications.tsx
    GET /api/seller/notifications/preferences <- seller-center/src/pages/Notifications.tsx, seller-center/src/pages/Staff.tsx
    GET /api/seller/offers/bulk-updates <- seller-center/src/pages/BulkUpdate.tsx
    GET /api/seller/offers/bulk-updates/template <- seller-center/src/pages/BulkUpdate.tsx
    GET /api/seller/offers/bulk-updates/{id} <- seller-center/src/pages/BulkUpdate.tsx
    GET /api/seller/offers/bulk-updates/{id}/correction-report <- seller-center/src/pages/BulkUpdate.tsx
    GET /api/seller/offers/bulk-updates/{id}/rows <- seller-center/src/pages/BulkUpdate.tsx
    GET /api/seller/offers/offers <- seller-center/src/pages/Marketing.tsx, seller-center/src/pages/Products.tsx, seller-center/src/pages/Store.tsx
    GET /api/seller/offers/offers/counts <- seller-center/src/pages/BulkUpdate.tsx, seller-center/src/pages/Products.tsx
    GET /api/seller/offers/offers/exports/{id} <- seller-center/src/pages/Products.tsx
    GET /api/seller/offers/offers/{id} <- seller-center/src/pages/Offer.tsx
    GET /api/seller/orders/exports/{id} <- seller-center/src/pages/Orders.tsx
    GET /api/seller/orders/orders <- seller-center/src/pages/Orders.tsx
    GET /api/seller/orders/orders/counts <- seller-center/src/app/session.tsx, seller-center/src/pages/Orders.tsx
    GET /api/seller/orders/orders/{id} <- seller-center/src/pages/Orders.tsx
    GET /api/seller/orders/orders/{id}/packing-slip <- seller-center/src/pages/Order.tsx
    GET /api/seller/promotions/discounts <- seller-center/src/pages/Marketing.tsx
    GET /api/seller/promotions/invitations <- seller-center/src/pages/Marketing.tsx
    GET /api/seller/reports/dashboard <- seller-center/src/pages/Dashboard.tsx
    GET /api/seller/reports/exports/{id} <- seller-center/src/pages/Reports.tsx
    GET /api/seller/returns/requests <- seller-center/src/pages/Returns.tsx
    GET /api/seller/returns/requests/counts <- seller-center/src/app/session.tsx, seller-center/src/pages/Returns.tsx
    GET /api/seller/returns/requests/exports/{id} <- seller-center/src/pages/Returns.tsx
    GET /api/seller/returns/requests/{id} <- seller-center/src/pages/Return.tsx
    GET /api/seller/returns/terms <- seller-center/src/pages/Returns.tsx, seller-center/src/pages/Shipping.tsx, seller-center/src/pages/Store.tsx
    GET /api/seller/reviews/feedback <- seller-center/src/pages/Customers.tsx
    GET /api/seller/reviews/feedback-summary <- seller-center/src/pages/Customers.tsx, seller-center/src/pages/Store.tsx
    GET /api/seller/reviews/questions <- seller-center/src/pages/Customers.tsx
    GET /api/seller/sellers/account <- seller-center/src/app/session.tsx, seller-center/src/pages/Performance.tsx, seller-center/src/pages/Staff.tsx
    GET /api/seller/sellers/members <- seller-center/src/pages/Staff.tsx
    GET /api/seller/sellers/payout-account <- seller-center/src/pages/Finance.tsx
    GET /api/seller/sellers/performance <- seller-center/src/pages/Performance.tsx, seller-center/src/pages/Reports.tsx
    GET /api/seller/sellers/restrictions <- seller-center/src/pages/Performance.tsx
    GET /api/seller/sellers/roles <- seller-center/src/pages/Staff.tsx
    GET /api/seller/sellers/setup <- seller-center/src/pages/Setup.tsx
    GET /api/seller/sellers/store-profile <- seller-center/src/pages/Store.tsx
    GET /api/seller/settings/current <- seller-center/src/pages/data/catalog-parts.tsx
    GET /api/seller/settings/upcoming-changes <- seller-center/src/pages/Dashboard.tsx
    GET /api/seller/shipping/carrier-services <- seller-center/src/pages/Shipping.tsx
    GET /api/seller/shipping/methods <- seller-center/src/pages/Shipping.tsx
    GET /api/seller/shipping/profiles <- seller-center/src/pages/Offer.tsx, seller-center/src/pages/ProductNew.tsx
    GET /api/seller/shipping/settings <- seller-center/src/pages/Shipping.tsx
    GET /api/seller/support/cases <- seller-center/src/pages/Help.tsx
    GET /api/seller/support/categories <- seller-center/src/pages/Help.tsx
    GET /api/store/identity/security <- seller-center/src/app/session.tsx, seller-center/src/pages/Help.tsx
    PATCH /api/seller/advertising/campaigns/{id} <- seller-center/src/pages/AdRequest.tsx
    PATCH /api/seller/catalog/products/{id} <- seller-center/src/pages/ProductNew.tsx
    PATCH /api/seller/inventory/stock-items/{id} <- seller-center/src/pages/Offer.tsx
    PATCH /api/seller/offers/offers/{id} <- seller-center/src/pages/Offer.tsx, seller-center/src/pages/ProductNew.tsx
    PATCH /api/seller/reviews/answers/{id} <- seller-center/src/pages/Customers.tsx
    PATCH /api/seller/reviews/responses/{id} <- seller-center/src/pages/Customers.tsx
    PATCH /api/seller/sellers/members/{id} <- seller-center/src/pages/Staff.tsx
    PATCH /api/seller/sellers/store-profile <- seller-center/src/pages/Store.tsx
    PATCH /api/seller/sellers/store-profile/collections/{id} <- seller-center/src/pages/Store.tsx
    POST /api/public/identity/sessions <- seller-center/src/app/SignIn.tsx
    POST /api/public/identity/sign-in-challenges/{id}/verify <- seller-center/src/app/SignIn.tsx
    POST /api/seller/advertising/campaigns <- seller-center/src/pages/AdRequest.tsx
    POST /api/seller/advertising/campaigns/{id}/pause <- seller-center/src/pages/Marketing.tsx
    POST /api/seller/advertising/campaigns/{id}/resume <- seller-center/src/pages/Marketing.tsx
    POST /api/seller/advertising/campaigns/{id}/submit <- seller-center/src/pages/AdRequest.tsx
    POST /api/seller/advertising/campaigns/{id}/withdraw <- seller-center/src/pages/AdRequest.tsx
    POST /api/seller/advertising/creatives <- seller-center/src/pages/AdRequest.tsx
    POST /api/seller/catalog/products <- seller-center/src/pages/ProductNew.tsx
    POST /api/seller/catalog/products/{id}/submit <- seller-center/src/pages/ProductNew.tsx
    POST /api/seller/catalog/products/{id}/withdraw <- seller-center/src/pages/ProductNew.tsx, seller-center/src/pages/Products.tsx
    POST /api/seller/content/help/articles/{id}/feedback <- seller-center/src/pages/data/help-articles.ts
    POST /api/seller/finance/ledger/exports <- seller-center/src/pages/Finance.tsx
    POST /api/seller/finance/payout-destination/confirm-deposits <- seller-center/src/pages/Finance.tsx
    POST /api/seller/identity/reauth <- seller-center/src/pages/Finance.tsx
    POST /api/seller/identity/session/seller-context <- seller-center/src/app/session.tsx, seller-center/src/app/SignIn.tsx
    POST /api/seller/inventory/adjustments/batch <- seller-center/src/pages/Inventory.tsx, seller-center/src/pages/Products.tsx
    POST /api/seller/inventory/stock-items/exports <- seller-center/src/pages/Inventory.tsx
    POST /api/seller/inventory/stock-items/{id}/adjustments <- seller-center/src/pages/Inventory.tsx
    POST /api/seller/messaging/conversations <- seller-center/src/pages/Order.tsx, seller-center/src/pages/Return.tsx
    POST /api/seller/messaging/conversations/{id}/messages <- seller-center/src/pages/Customers.tsx, seller-center/src/pages/Order.tsx, seller-center/src/pages/Return.tsx
    POST /api/seller/messaging/conversations/{id}/read <- seller-center/src/pages/Customers.tsx
    POST /api/seller/messaging/messages/{id}/report <- seller-center/src/pages/Customers.tsx
    POST /api/seller/messaging/templates <- seller-center/src/pages/Customers.tsx
    POST /api/seller/notifications/inbox/archive-all <- seller-center/src/pages/Notifications.tsx
    POST /api/seller/notifications/inbox/read-all <- seller-center/src/pages/Notifications.tsx
    POST /api/seller/notifications/inbox/{id}/read <- seller-center/src/pages/Notifications.tsx
    POST /api/seller/offers/bulk-updates <- seller-center/src/pages/BulkUpdate.tsx
    POST /api/seller/offers/bulk-updates/{id}/apply <- seller-center/src/pages/BulkUpdate.tsx
    POST /api/seller/offers/offers <- seller-center/src/pages/Offer.tsx, seller-center/src/pages/ProductNew.tsx
    POST /api/seller/offers/offers/bulk-pause <- seller-center/src/pages/Products.tsx
    POST /api/seller/offers/offers/exports <- seller-center/src/pages/Products.tsx
    POST /api/seller/offers/offers/preview <- seller-center/src/pages/Offer.tsx
    POST /api/seller/offers/offers/{id}/publish <- seller-center/src/pages/Offer.tsx
    POST /api/seller/offers/offers/{id}/resume <- seller-center/src/pages/Products.tsx
    POST /api/seller/offers/price-changes <- seller-center/src/pages/Products.tsx
    POST /api/seller/orders/exports <- seller-center/src/pages/Orders.tsx
    POST /api/seller/orders/orders/bulk-start-preparing <- seller-center/src/pages/Orders.tsx
    POST /api/seller/orders/orders/{id}/cancel-items <- seller-center/src/pages/Order.tsx
    POST /api/seller/orders/orders/{id}/cancellation-requests/{requestId}/accept <- seller-center/src/pages/Orders.tsx
    POST /api/seller/orders/orders/{id}/cancellation-requests/{requestId}/decline <- seller-center/src/pages/Orders.tsx
    POST /api/seller/orders/packing-slips <- seller-center/src/pages/Orders.tsx
    POST /api/seller/promotions/discounts <- seller-center/src/pages/Marketing.tsx
    POST /api/seller/promotions/discounts/preview <- seller-center/src/pages/Marketing.tsx
    POST /api/seller/promotions/discounts/{id}/end <- seller-center/src/pages/Marketing.tsx
    POST /api/seller/promotions/discounts/{id}/pause <- seller-center/src/pages/Marketing.tsx
    POST /api/seller/promotions/discounts/{id}/resume <- seller-center/src/pages/Marketing.tsx
    POST /api/seller/promotions/discounts/{id}/schedule <- seller-center/src/pages/Marketing.tsx
    POST /api/seller/promotions/invitations/{id}/accept <- seller-center/src/pages/Marketing.tsx
    POST /api/seller/promotions/invitations/{id}/decline <- seller-center/src/pages/Marketing.tsx
    POST /api/seller/promotions/invitations/{id}/withdraw <- seller-center/src/pages/Marketing.tsx
    POST /api/seller/reports/exports <- seller-center/src/pages/Reports.tsx
    POST /api/seller/reports/reports/{key}/query <- seller-center/src/pages/data/period-dashboard.tsx, seller-center/src/pages/Reports.tsx
    POST /api/seller/returns/requests/exports <- seller-center/src/pages/Returns.tsx
    POST /api/seller/returns/requests/{id}/approve <- seller-center/src/pages/Return.tsx
    POST /api/seller/returns/requests/{id}/approve-without-return <- seller-center/src/pages/Return.tsx
    POST /api/seller/returns/requests/{id}/evidence <- seller-center/src/pages/Return.tsx
    POST /api/seller/returns/requests/{id}/inspection <- seller-center/src/pages/Return.tsx
    POST /api/seller/returns/requests/{id}/receive <- seller-center/src/pages/Return.tsx
    POST /api/seller/returns/requests/{id}/reject <- seller-center/src/pages/Return.tsx
    POST /api/seller/returns/requests/{id}/remedy <- seller-center/src/pages/Return.tsx
    POST /api/seller/returns/requests/{id}/remedy/preview <- seller-center/src/pages/Return.tsx
    POST /api/seller/returns/requests/{id}/request-info <- seller-center/src/pages/Return.tsx
    POST /api/seller/reviews/questions/{id}/answers <- seller-center/src/pages/Customers.tsx
    POST /api/seller/reviews/questions/{id}/skip <- seller-center/src/pages/Customers.tsx
    POST /api/seller/reviews/reports <- seller-center/src/pages/Customers.tsx
    POST /api/seller/reviews/responses <- seller-center/src/pages/Customers.tsx
    POST /api/seller/sellers/invitations <- seller-center/src/pages/Staff.tsx
    POST /api/seller/sellers/invitations/{id}/resend <- seller-center/src/pages/Staff.tsx
    POST /api/seller/sellers/invitations/{id}/revoke <- seller-center/src/pages/Staff.tsx
    POST /api/seller/sellers/members/{id}/reactivate <- seller-center/src/pages/Staff.tsx
    POST /api/seller/sellers/members/{id}/remove <- seller-center/src/pages/Staff.tsx
    POST /api/seller/sellers/members/{id}/suspend <- seller-center/src/pages/Staff.tsx
    POST /api/seller/sellers/payout-account/change <- seller-center/src/pages/Finance.tsx
    POST /api/seller/sellers/restrictions/{id}/appeals <- seller-center/src/pages/Performance.tsx
    POST /api/seller/sellers/restrictions/{id}/evidence <- seller-center/src/pages/Performance.tsx
    POST /api/seller/sellers/setup/launch-review <- seller-center/src/pages/Setup.tsx
    POST /api/seller/sellers/store-profile/claims <- seller-center/src/pages/Store.tsx
    POST /api/seller/sellers/store-profile/collections <- seller-center/src/pages/Store.tsx
    POST /api/seller/shipping/closures <- seller-center/src/pages/Shipping.tsx
    POST /api/seller/shipping/labels <- seller-center/src/pages/Order.tsx
    POST /api/seller/shipping/labels/quotes <- seller-center/src/pages/Order.tsx
    POST /api/seller/shipping/shipments <- seller-center/src/pages/Order.tsx
    POST /api/seller/shipping/shipments/{id}/correct-tracking <- seller-center/src/pages/Order.tsx
    POST /api/seller/shipping/shipments/{id}/hand-over <- seller-center/src/pages/Order.tsx
    POST /api/seller/support/cases/{id}/evidence <- seller-center/src/pages/Return.tsx
    POST /api/seller/support/cases/{id}/messages <- seller-center/src/pages/Return.tsx
    POST /api/seller/support/requests <- seller-center/src/pages/Help.tsx
    PUT /api/seller/notifications/preferences/members/{memberId} <- seller-center/src/pages/Staff.tsx
    PUT /api/seller/returns/requests/{id}/inspection-draft <- seller-center/src/pages/Return.tsx
    PUT /api/seller/returns/terms <- seller-center/src/pages/Shipping.tsx, seller-center/src/pages/Store.tsx
    PUT /api/seller/shipping/profiles/{id} <- seller-center/src/pages/Shipping.tsx
    PUT /api/seller/shipping/settings <- seller-center/src/pages/Shipping.tsx
  [admin]
    DELETE /api/admin/shipping/notices/{id} <- admin-center/src/pages/admin/Shipping.tsx
    GET /api/admin/access/approval-actions <- admin-center/src/pages/admin/Order.tsx
    GET /api/admin/access/approval-requests/{id} <- admin-center/src/pages/admin/Inbox.tsx
    GET /api/admin/access/away-periods <- admin-center/src/pages/admin/Staff.tsx
    GET /api/admin/access/coverage <- admin-center/src/pages/admin/Staff.tsx
    GET /api/admin/access/limit-changes <- admin-center/src/pages/admin/Staff.tsx
    GET /api/admin/access/me <- admin-center/src/app/session.tsx, admin-center/src/pages/admin/Official.tsx, admin-center/src/pages/admin/Order.tsx, admin-center/src/pages/admin/Purchasing.tsx, admin-center/src/pages/ops/FinanceChecks.tsx, admin-center/src/pages/ops/Inventory.tsx
    GET /api/admin/access/members <- admin-center/src/pages/admin/AdCampaign.tsx, admin-center/src/pages/admin/data/audit.ts, admin-center/src/pages/admin/Staff.tsx
    GET /api/admin/access/roles <- admin-center/src/pages/admin/Staff.tsx
    GET /api/admin/access/roles/{id} <- admin-center/src/pages/admin/Staff.tsx
    GET /api/admin/advertising/campaigns <- admin-center/src/pages/admin/Ads.tsx
    GET /api/admin/advertising/campaigns/{id} <- admin-center/src/pages/admin/AdAssets.tsx, admin-center/src/pages/admin/AdCampaign.tsx
    GET /api/admin/advertising/campaigns/{id}/preview <- admin-center/src/pages/admin/AdCampaign.tsx
    GET /api/admin/advertising/creatives <- admin-center/src/pages/admin/AdAssets.tsx
    GET /api/admin/advertising/creatives/summary <- admin-center/src/pages/admin/AdAssets.tsx
    GET /api/admin/advertising/dashboard <- admin-center/src/pages/admin/Ads.tsx
    GET /api/admin/advertising/placements <- admin-center/src/pages/admin/AdAssets.tsx, admin-center/src/pages/admin/AdCampaign.tsx, admin-center/src/pages/admin/AdPlacements.tsx, admin-center/src/pages/admin/Ads.tsx
    GET /api/admin/advertising/rules <- admin-center/src/pages/admin/AdPlacements.tsx
    GET /api/admin/audit/entries <- admin-center/src/pages/admin/Audit.tsx
    GET /api/admin/audit/entries/{id} <- admin-center/src/pages/admin/AuditEntry.tsx
    GET /api/admin/audit/exports/{id} <- admin-center/src/pages/admin/Audit.tsx
    GET /api/admin/audit/retention <- admin-center/src/pages/admin/Audit.tsx, admin-center/src/pages/admin/AuditEntry.tsx
    GET /api/admin/audit/targets/{type}/{id} <- admin-center/src/pages/admin/AuditEntry.tsx
    GET /api/admin/catalog/brands <- admin-center/src/pages/admin/AdCampaign.tsx, admin-center/src/pages/admin/Catalog.tsx, admin-center/src/pages/admin/Categories.tsx
    GET /api/admin/catalog/categories <- admin-center/src/pages/admin/AdCampaign.tsx, admin-center/src/pages/admin/Catalog.tsx, admin-center/src/pages/admin/Categories.tsx, admin-center/src/pages/admin/Official.tsx, admin-center/src/pages/admin/ProductReview.tsx, admin-center/src/pages/admin/PromotionNew.tsx, admin-center/src/pages/admin/Sellers.tsx
    GET /api/admin/catalog/categories/{id}/attributes <- admin-center/src/pages/admin/Categories.tsx
    GET /api/admin/catalog/products <- admin-center/src/pages/admin/Catalog.tsx
    GET /api/admin/catalog/products/stats <- admin-center/src/pages/admin/Catalog.tsx
    GET /api/admin/catalog/review-queue <- admin-center/src/pages/admin/ProductReview.tsx
    GET /api/admin/content/help/articles/{id} <- admin-center/src/pages/admin/HelpContent.tsx
    GET /api/admin/content/help/categories <- admin-center/src/pages/admin/HelpContent.tsx
    GET /api/admin/content/help/items <- admin-center/src/pages/admin/HelpContent.tsx
    GET /api/admin/content/help/summary <- admin-center/src/pages/admin/HelpContent.tsx
    GET /api/admin/content/homepage <- admin-center/src/pages/admin/Content.tsx
    GET /api/admin/content/homepage/sections/{id}/products <- admin-center/src/pages/admin/Content.tsx
    GET /api/admin/content/homepage/versions <- admin-center/src/pages/admin/Content.tsx
    GET /api/admin/content/pages <- admin-center/src/pages/admin/Content.tsx
    GET /api/admin/content/policies <- admin-center/src/pages/admin/HelpContent.tsx
    GET /api/admin/content/policies/{id}/versions <- admin-center/src/pages/admin/HelpContent.tsx
    GET /api/admin/customers/customers <- admin-center/src/pages/admin/Customers.tsx
    GET /api/admin/customers/customers/{id} <- admin-center/src/pages/admin/Customers.tsx
    GET /api/admin/customers/guest-buyers <- admin-center/src/pages/admin/Customers.tsx
    GET /api/admin/finance/destination-reviews <- admin-center/src/pages/admin/Payouts.tsx
    GET /api/admin/finance/fee-rules <- admin-center/src/pages/admin/Finance.tsx
    GET /api/admin/finance/overview <- admin-center/src/pages/admin/Finance.tsx
    GET /api/admin/finance/payout-runs <- admin-center/src/pages/admin/Payouts.tsx
    GET /api/admin/finance/payout-runs/{id} <- admin-center/src/pages/admin/Payouts.tsx
    GET /api/admin/finance/payout-runs/{id}/payouts <- admin-center/src/pages/admin/Payouts.tsx
    GET /api/admin/finance/payouts <- admin-center/src/pages/admin/Payouts.tsx
    GET /api/admin/finance/reconciliation/days/{date} <- admin-center/src/pages/ops/FinanceChecks.tsx
    GET /api/admin/finance/reconciliation/items <- admin-center/src/pages/admin/Finance.tsx, admin-center/src/pages/ops/FinanceChecks.tsx
    GET /api/admin/finance/trading <- admin-center/src/pages/admin/Official.tsx
    GET /api/admin/inventory/adjustments <- admin-center/src/pages/ops/Inventory.tsx
    GET /api/admin/inventory/inbound <- admin-center/src/pages/ops/Receiving.tsx
    GET /api/admin/inventory/locations <- admin-center/src/pages/admin/Purchasing.tsx
    GET /api/admin/inventory/low-stock <- admin-center/src/pages/ops/Inventory.tsx
    GET /api/admin/inventory/stock-items <- admin-center/src/pages/ops/Inventory.tsx
    GET /api/admin/inventory/summary <- admin-center/src/pages/ops/Inventory.tsx
    GET /api/admin/notifications/inbox <- admin-center/src/pages/admin/Inbox.tsx
    GET /api/admin/notifications/inbox/summary <- admin-center/src/app/session.tsx, admin-center/src/pages/admin/Inbox.tsx
    GET /api/admin/notifications/my-preferences <- admin-center/src/pages/admin/Inbox.tsx
    GET /api/admin/notifications/templates <- admin-center/src/pages/admin/Notifications.tsx
    GET /api/admin/notifications/templates/{id} <- admin-center/src/pages/admin/Notifications.tsx
    GET /api/admin/notifications/topics <- admin-center/src/pages/admin/Notifications.tsx
    GET /api/admin/offers/offers <- admin-center/src/pages/admin/Official.tsx
    GET /api/admin/offers/official/offers <- admin-center/src/pages/admin/Official.tsx
    GET /api/admin/orders/orders <- admin-center/src/pages/admin/Orders.tsx
    GET /api/admin/orders/orders/{id} <- admin-center/src/pages/ops/Dispatch.tsx
    GET /api/admin/orders/saved-filters <- admin-center/src/pages/admin/Orders.tsx
    GET /api/admin/payments/disputes <- admin-center/src/pages/admin/Finance.tsx, admin-center/src/pages/ops/FinanceChecks.tsx
    GET /api/admin/payments/orders/{orderId}/refundable <- admin-center/src/pages/admin/Case.tsx
    GET /api/admin/payments/refunds <- admin-center/src/pages/admin/Finance.tsx
    GET /api/admin/promotions/campaigns <- admin-center/src/pages/admin/AdCampaign.tsx, admin-center/src/pages/admin/Promotions.tsx
    GET /api/admin/promotions/campaigns/{id} <- admin-center/src/pages/admin/PromotionNew.tsx
    GET /api/admin/promotions/campaigns/{id}/participations <- admin-center/src/pages/admin/PromotionNew.tsx
    GET /api/admin/promotions/dashboard <- admin-center/src/pages/admin/Promotions.tsx
    GET /api/admin/purchasing/deliveries <- admin-center/src/pages/ops/Receiving.tsx
    GET /api/admin/purchasing/deliveries/stats <- admin-center/src/pages/ops/Receiving.tsx
    GET /api/admin/purchasing/purchase-orders <- admin-center/src/pages/admin/Purchasing.tsx
    GET /api/admin/purchasing/purchase-orders/{id} <- admin-center/src/pages/admin/Purchasing.tsx
    GET /api/admin/purchasing/receipts/{id} <- admin-center/src/pages/ops/Receiving.tsx
    GET /api/admin/purchasing/reorder-suggestions <- admin-center/src/pages/admin/Purchasing.tsx
    GET /api/admin/purchasing/summary <- admin-center/src/pages/admin/Purchasing.tsx
    GET /api/admin/purchasing/suppliers <- admin-center/src/pages/admin/Purchasing.tsx
    GET /api/admin/purchasing/suppliers/{id} <- admin-center/src/pages/admin/Purchasing.tsx
    GET /api/admin/reports/catalogue <- admin-center/src/pages/admin/Report.tsx, admin-center/src/pages/admin/Reports.tsx
    GET /api/admin/reports/dashboard <- admin-center/src/pages/admin/Reports.tsx
    GET /api/admin/reports/exports <- admin-center/src/pages/admin/Report.tsx
    GET /api/admin/reports/exports/{id} <- admin-center/src/pages/admin/data/dataset-export.ts, admin-center/src/pages/admin/data/report-export.ts
    GET /api/admin/reports/reports/{key} <- admin-center/src/pages/admin/Report.tsx
    GET /api/admin/returns/inspections <- admin-center/src/pages/ops/ReturnInspection.tsx
    GET /api/admin/returns/inspections/stats <- admin-center/src/pages/ops/ReturnInspection.tsx
    GET /api/admin/returns/requests <- admin-center/src/pages/admin/Returns.tsx
    GET /api/admin/returns/requests/stats <- admin-center/src/pages/admin/Returns.tsx
    GET /api/admin/returns/requests/{id} <- admin-center/src/pages/admin/Returns.tsx, admin-center/src/pages/ops/ReturnInspection.tsx
    GET /api/admin/reviews/moderation-items <- admin-center/src/pages/admin/Reviews.tsx
    GET /api/admin/reviews/moderation-items/{id} <- admin-center/src/pages/admin/Reviews.tsx
    GET /api/admin/reviews/moderation-reasons <- admin-center/src/pages/admin/Reviews.tsx
    GET /api/admin/sellers/applications <- admin-center/src/pages/admin/SellerApplication.tsx, admin-center/src/pages/admin/Sellers.tsx
    GET /api/admin/sellers/applications/{id} <- admin-center/src/pages/admin/SellerApplication.tsx
    GET /api/admin/sellers/change-requests <- admin-center/src/pages/admin/Categories.tsx
    GET /api/admin/sellers/performance-targets <- admin-center/src/pages/admin/Sellers.tsx, admin-center/src/pages/admin/Shipping.tsx
    GET /api/admin/sellers/sellers <- admin-center/src/pages/admin/AdCampaign.tsx, admin-center/src/pages/admin/Catalog.tsx, admin-center/src/pages/admin/Orders.tsx, admin-center/src/pages/admin/ProductReview.tsx, admin-center/src/pages/admin/Report.tsx, admin-center/src/pages/admin/Returns.tsx, admin-center/src/pages/admin/Sellers.tsx
    GET /api/admin/sellers/sellers/stats <- admin-center/src/pages/admin/Sellers.tsx
    GET /api/admin/sellers/sellers/{id} <- admin-center/src/pages/admin/Seller.tsx
    GET /api/admin/sellers/sellers/{id}/suspension-impact <- admin-center/src/pages/admin/Seller.tsx
    GET /api/admin/settings/changes <- admin-center/src/pages/admin/data/product-image-settings.tsx
    GET /api/admin/settings/definitions <- admin-center/src/pages/admin/Settings.tsx
    GET /api/admin/settings/overview <- admin-center/src/pages/admin/Settings.tsx
    GET /api/admin/settings/values/{key} <- admin-center/src/pages/admin/data/product-image-settings.tsx
    GET /api/admin/shipping/carriers <- admin-center/src/pages/admin/Shipping.tsx, admin-center/src/pages/ops/Dispatch.tsx
    GET /api/admin/shipping/claims <- admin-center/src/pages/ops/Dispatch.tsx
    GET /api/admin/shipping/dispatch-targets <- admin-center/src/pages/admin/Shipping.tsx
    GET /api/admin/shipping/exceptions <- admin-center/src/pages/ops/Dispatch.tsx
    GET /api/admin/shipping/exceptions/counts <- admin-center/src/pages/ops/Dispatch.tsx
    GET /api/admin/shipping/free-shipping-rules <- admin-center/src/pages/admin/Shipping.tsx
    GET /api/admin/shipping/methods <- admin-center/src/pages/admin/Shipping.tsx
    GET /api/admin/shipping/notices <- admin-center/src/pages/admin/Shipping.tsx
    GET /api/admin/shipping/profiles <- admin-center/src/pages/admin/Shipping.tsx
    GET /api/admin/shipping/summary <- admin-center/src/pages/admin/Shipping.tsx
    GET /api/admin/shipping/zones <- admin-center/src/pages/admin/Shipping.tsx
    GET /api/admin/support/assignees <- admin-center/src/pages/admin/Case.tsx, admin-center/src/pages/admin/Cases.tsx
    GET /api/admin/support/cases <- admin-center/src/pages/admin/Cases.tsx
    GET /api/admin/support/cases/stats <- admin-center/src/pages/admin/Cases.tsx
    GET /api/admin/support/cases/{id} <- admin-center/src/pages/admin/Case.tsx
    GET /api/admin/support/categories <- admin-center/src/pages/admin/Cases.tsx
    GET /api/admin/trust/appeals <- admin-center/src/pages/admin/Trust.tsx
    GET /api/admin/trust/overview <- admin-center/src/pages/admin/Trust.tsx
    GET /api/admin/trust/reports <- admin-center/src/pages/admin/Trust.tsx, admin-center/src/pages/admin/TrustReport.tsx
    GET /api/admin/trust/reports/{id} <- admin-center/src/pages/admin/Trust.tsx, admin-center/src/pages/admin/TrustReport.tsx
    GET /api/admin/warehouse/box-types <- admin-center/src/pages/ops/PickPack.tsx
    GET /api/admin/warehouse/fulfillments <- admin-center/src/pages/ops/PickPack.tsx
    GET /api/admin/warehouse/fulfillments/{id} <- admin-center/src/pages/ops/PickPack.tsx
    GET /api/admin/warehouse/packages/{id}/label <- admin-center/src/pages/ops/PickPack.tsx
    GET /api/admin/warehouse/packages/{id}/service-options <- admin-center/src/pages/ops/PickPack.tsx
    GET /api/admin/warehouse/summary <- admin-center/src/pages/ops/PickPack.tsx, admin-center/src/pages/ops/Queues.tsx
    GET /api/admin/warehouse/waves <- admin-center/src/pages/ops/PickPack.tsx
    GET /api/admin/workqueues/me <- admin-center/src/pages/ops/Queues.tsx
    GET /api/admin/workqueues/queues <- admin-center/src/app/session.tsx
    GET /api/admin/workqueues/routines/today <- admin-center/src/pages/ops/Queues.tsx
    GET /api/admin/workqueues/saved-filters <- admin-center/src/pages/ops/Queues.tsx
    PATCH /api/admin/advertising/campaigns/{id} <- admin-center/src/pages/admin/AdCampaign.tsx
    PATCH /api/admin/advertising/creatives/{id} <- admin-center/src/pages/admin/AdCampaign.tsx
    PATCH /api/admin/advertising/placements/{id} <- admin-center/src/pages/admin/AdPlacements.tsx
    PATCH /api/admin/catalog/brands/{id} <- admin-center/src/pages/admin/Categories.tsx
    PATCH /api/admin/catalog/categories/{id} <- admin-center/src/pages/admin/Categories.tsx
    PATCH /api/admin/content/help/articles/{id} <- admin-center/src/pages/admin/HelpContent.tsx
    PATCH /api/admin/content/homepage/sections/{id} <- admin-center/src/pages/admin/Content.tsx
    PATCH /api/admin/content/policy-versions/{id} <- admin-center/src/pages/admin/HelpContent.tsx
    PATCH /api/admin/notifications/templates/{id}/versions/{versionId} <- admin-center/src/pages/admin/Notifications.tsx
    PATCH /api/admin/promotions/campaigns/{id} <- admin-center/src/pages/admin/PromotionNew.tsx
    PATCH /api/admin/purchasing/purchase-orders/{id} <- admin-center/src/pages/admin/Purchasing.tsx
    PATCH /api/admin/purchasing/receipts/{id} <- admin-center/src/pages/ops/Receiving.tsx
    PATCH /api/admin/sellers/restrictions/{id} <- admin-center/src/pages/admin/Seller.tsx
    PATCH /api/admin/settings/changes/{id} <- admin-center/src/pages/admin/Settings.tsx
    PATCH /api/admin/shipping/carriers/{id}/services/{serviceId} <- admin-center/src/pages/admin/Shipping.tsx
    PATCH /api/admin/warehouse/packages/{id} <- admin-center/src/pages/ops/PickPack.tsx
    POST /api/admin/access/approval-requests/{id}/approve <- admin-center/src/pages/admin/Inbox.tsx
    POST /api/admin/access/approval-requests/{id}/reject <- admin-center/src/pages/admin/Inbox.tsx
    POST /api/admin/access/approval-requests/{id}/remind <- admin-center/src/pages/admin/Payouts.tsx
    POST /api/admin/access/authority-checks <- admin-center/src/pages/admin/Case.tsx, admin-center/src/pages/admin/Seller.tsx
    POST /api/admin/access/limit-changes <- admin-center/src/pages/admin/Staff.tsx
    POST /api/admin/access/roles <- admin-center/src/pages/admin/Staff.tsx
    POST /api/admin/access/staff-invitations <- admin-center/src/pages/admin/Staff.tsx
    POST /api/admin/advertising/campaigns <- admin-center/src/pages/admin/AdCampaign.tsx
    POST /api/admin/advertising/campaigns/{id}/check <- admin-center/src/pages/admin/AdCampaign.tsx
    POST /api/admin/advertising/campaigns/{id}/submit <- admin-center/src/pages/admin/AdCampaign.tsx
    POST /api/admin/advertising/creatives <- admin-center/src/pages/admin/AdAssets.tsx, admin-center/src/pages/admin/AdCampaign.tsx
    POST /api/admin/advertising/creatives/{id}/review <- admin-center/src/pages/admin/AdAssets.tsx
    POST /api/admin/audit/exports <- admin-center/src/pages/admin/Audit.tsx
    POST /api/admin/catalog/brands <- admin-center/src/pages/admin/Categories.tsx
    POST /api/admin/catalog/brands/{id}/status <- admin-center/src/pages/admin/Categories.tsx
    POST /api/admin/catalog/categories <- admin-center/src/pages/admin/Categories.tsx
    POST /api/admin/catalog/products/exports <- admin-center/src/pages/admin/Catalog.tsx
    POST /api/admin/catalog/products/merge <- admin-center/src/pages/admin/ProductReview.tsx
    POST /api/admin/catalog/products/merge/preview <- admin-center/src/pages/admin/ProductReview.tsx
    POST /api/admin/catalog/products/{id}/approve <- admin-center/src/pages/admin/ProductReview.tsx
    POST /api/admin/catalog/products/{id}/checks/{kind}/dismiss <- admin-center/src/pages/admin/ProductReview.tsx
    POST /api/admin/catalog/products/{id}/checks/{kind}/restore <- admin-center/src/pages/admin/ProductReview.tsx
    POST /api/admin/catalog/products/{id}/publication <- admin-center/src/pages/admin/Catalog.tsx
    POST /api/admin/catalog/products/{id}/reject <- admin-center/src/pages/admin/ProductReview.tsx
    POST /api/admin/catalog/products/{id}/request-changes <- admin-center/src/pages/admin/Catalog.tsx, admin-center/src/pages/admin/ProductReview.tsx
    POST /api/admin/content/help/articles <- admin-center/src/pages/admin/HelpContent.tsx
    POST /api/admin/content/help/articles/{id}/transition <- admin-center/src/pages/admin/HelpContent.tsx
    POST /api/admin/content/homepage/discard-draft <- admin-center/src/pages/admin/Content.tsx
    POST /api/admin/content/homepage/publish <- admin-center/src/pages/admin/Content.tsx
    POST /api/admin/content/homepage/review <- admin-center/src/pages/admin/Content.tsx
    POST /api/admin/content/homepage/sections <- admin-center/src/pages/admin/Content.tsx
    POST /api/admin/content/homepage/sections/{id}/remove <- admin-center/src/pages/admin/Content.tsx
    POST /api/admin/content/homepage/sections/{id}/schedule <- admin-center/src/pages/admin/Content.tsx
    POST /api/admin/content/homepage/submit <- admin-center/src/pages/admin/Content.tsx
    POST /api/admin/content/homepage/versions/{number}/restore <- admin-center/src/pages/admin/Content.tsx
    POST /api/admin/content/pages <- admin-center/src/pages/admin/Content.tsx
    POST /api/admin/content/pages/{id}/publish <- admin-center/src/pages/admin/Content.tsx
    POST /api/admin/content/policies/{id}/versions <- admin-center/src/pages/admin/HelpContent.tsx
    POST /api/admin/content/policy-versions/{id}/approve <- admin-center/src/pages/admin/HelpContent.tsx
    POST /api/admin/content/policy-versions/{id}/schedule <- admin-center/src/pages/admin/HelpContent.tsx
    POST /api/admin/content/policy-versions/{id}/submit <- admin-center/src/pages/admin/HelpContent.tsx
    POST /api/admin/customers/customers/{id}/actions <- admin-center/src/pages/admin/Customers.tsx
    POST /api/admin/customers/customers/{id}/restrictions/{restrictionId}/lift <- admin-center/src/pages/admin/Customers.tsx
    POST /api/admin/customers/data-requests/{id}/retry <- admin-center/src/pages/admin/Customers.tsx
    POST /api/admin/finance/destination-reviews/{id}/approve <- admin-center/src/pages/admin/Payouts.tsx
    POST /api/admin/finance/destination-reviews/{id}/reject <- admin-center/src/pages/admin/Payouts.tsx
    POST /api/admin/finance/payout-runs/{id}/approve <- admin-center/src/pages/admin/Payouts.tsx
    POST /api/admin/finance/payout-runs/{id}/send-back <- admin-center/src/pages/admin/Payouts.tsx
    POST /api/admin/finance/payout-runs/{id}/submit <- admin-center/src/pages/admin/Payouts.tsx
    POST /api/admin/finance/payouts/{id}/retry <- admin-center/src/pages/admin/Payouts.tsx
    POST /api/admin/finance/reconciliation/days/{date}/complete <- admin-center/src/pages/ops/FinanceChecks.tsx
    POST /api/admin/finance/reconciliation/items/{id}/correct <- admin-center/src/pages/ops/FinanceChecks.tsx
    POST /api/admin/finance/reconciliation/items/{id}/explain <- admin-center/src/pages/admin/Finance.tsx
    POST /api/admin/identity/reauth <- admin-center/src/pages/admin/data/step-up.tsx
    POST /api/admin/inventory/adjustments <- admin-center/src/pages/ops/Inventory.tsx
    POST /api/admin/inventory/inbound/{id}/confirm <- admin-center/src/pages/ops/Receiving.tsx
    POST /api/admin/messaging/conversations <- admin-center/src/pages/admin/data/seller-message.tsx, admin-center/src/pages/admin/Order.tsx
    POST /api/admin/notifications/inbox/read-all <- admin-center/src/pages/admin/Inbox.tsx
    POST /api/admin/notifications/inbox/{id}/read <- admin-center/src/pages/admin/Inbox.tsx
    POST /api/admin/notifications/inbox/{id}/unread <- admin-center/src/pages/admin/Inbox.tsx
    POST /api/admin/notifications/templates/{id}/versions <- admin-center/src/pages/admin/Notifications.tsx
    POST /api/admin/notifications/templates/{id}/versions/{versionId}/publish <- admin-center/src/pages/admin/Notifications.tsx
    POST /api/admin/notifications/templates/{id}/versions/{versionId}/test-send <- admin-center/src/pages/admin/Notifications.tsx
    POST /api/admin/offers/official/offers/{id}/price-changes <- admin-center/src/pages/admin/Official.tsx
    POST /api/admin/orders/exports <- admin-center/src/pages/admin/Orders.tsx
    POST /api/admin/orders/orders/{id}/cancel-items <- admin-center/src/pages/admin/Order.tsx, admin-center/src/pages/ops/Dispatch.tsx
    POST /api/admin/orders/orders/{id}/notes <- admin-center/src/pages/admin/Order.tsx
    POST /api/admin/orders/saved-filters <- admin-center/src/pages/admin/Orders.tsx
    POST /api/admin/payments/disputes/{id}/evidence <- admin-center/src/pages/admin/Finance.tsx
    POST /api/admin/payments/refunds/{id}/check <- admin-center/src/pages/admin/Finance.tsx
    POST /api/admin/payments/refunds/{id}/request-destination <- admin-center/src/pages/admin/Finance.tsx
    POST /api/admin/promotions/campaigns <- admin-center/src/pages/admin/PromotionNew.tsx
    POST /api/admin/promotions/campaigns/{id}/confirm-funding <- admin-center/src/pages/admin/PromotionNew.tsx
    POST /api/admin/promotions/campaigns/{id}/pause <- admin-center/src/pages/admin/Promotions.tsx
    POST /api/admin/promotions/campaigns/{id}/price-preview <- admin-center/src/pages/admin/PromotionNew.tsx
    POST /api/admin/promotions/campaigns/{id}/request-changes <- admin-center/src/pages/admin/PromotionNew.tsx
    POST /api/admin/promotions/campaigns/{id}/resume <- admin-center/src/pages/admin/Promotions.tsx
    POST /api/admin/promotions/campaigns/{id}/schedule <- admin-center/src/pages/admin/PromotionNew.tsx
    POST /api/admin/promotions/campaigns/{id}/submit <- admin-center/src/pages/admin/PromotionNew.tsx
    POST /api/admin/promotions/campaigns/{id}/withdraw <- admin-center/src/pages/admin/PromotionNew.tsx
    POST /api/admin/purchasing/claims <- admin-center/src/pages/admin/Purchasing.tsx
    POST /api/admin/purchasing/deliveries/{id}/arrive <- admin-center/src/pages/ops/Receiving.tsx
    POST /api/admin/purchasing/deliveries/{id}/receipts <- admin-center/src/pages/ops/Receiving.tsx
    POST /api/admin/purchasing/purchase-orders <- admin-center/src/pages/admin/Purchasing.tsx
    POST /api/admin/purchasing/purchase-orders/{id}/cancel <- admin-center/src/pages/admin/Purchasing.tsx
    POST /api/admin/purchasing/purchase-orders/{id}/send <- admin-center/src/pages/admin/Purchasing.tsx
    POST /api/admin/purchasing/receipts/{id}/submit <- admin-center/src/pages/ops/Receiving.tsx
    POST /api/admin/purchasing/suppliers <- admin-center/src/pages/admin/Purchasing.tsx
    POST /api/admin/reports/exports <- admin-center/src/pages/admin/Dashboard.tsx, admin-center/src/pages/admin/data/dataset-export.ts, admin-center/src/pages/admin/data/report-export.ts, admin-center/src/pages/admin/Returns.tsx
    POST /api/admin/reports/metrics/{key}/suggestions <- admin-center/src/pages/admin/Report.tsx
    POST /api/admin/reports/reports/{key}/query <- admin-center/src/pages/admin/Report.tsx, admin-center/src/pages/admin/Reports.tsx
    POST /api/admin/reports/saved-views <- admin-center/src/pages/admin/Reports.tsx
    POST /api/admin/reports/schedules <- admin-center/src/pages/admin/Reports.tsx
    POST /api/admin/returns/refunds <- admin-center/src/pages/admin/Order.tsx
    POST /api/admin/returns/requests/{id}/approve-without-return <- admin-center/src/pages/admin/Returns.tsx
    POST /api/admin/returns/requests/{id}/inspection <- admin-center/src/pages/ops/ReturnInspection.tsx
    POST /api/admin/returns/requests/{id}/remedy <- admin-center/src/pages/ops/ReturnInspection.tsx
    POST /api/admin/returns/requests/{id}/request-info <- admin-center/src/pages/admin/Returns.tsx
    POST /api/admin/returns/requests/{id}/start-inspection <- admin-center/src/pages/ops/ReturnInspection.tsx
    POST /api/admin/reviews/moderation-items/{id}/decide <- admin-center/src/pages/admin/Reviews.tsx
    POST /api/admin/reviews/moderation-items/{id}/refer <- admin-center/src/pages/admin/Reviews.tsx
    POST /api/admin/reviews/questions/{id}/answers <- admin-center/src/pages/admin/Reviews.tsx
    POST /api/admin/sellers/applications/{id}/approve <- admin-center/src/pages/admin/SellerApplication.tsx
    POST /api/admin/sellers/applications/{id}/assign <- admin-center/src/pages/admin/SellerApplication.tsx
    POST /api/admin/sellers/applications/{id}/notes <- admin-center/src/pages/admin/SellerApplication.tsx
    POST /api/admin/sellers/applications/{id}/reject <- admin-center/src/pages/admin/SellerApplication.tsx
    POST /api/admin/sellers/applications/{id}/request-information <- admin-center/src/pages/admin/SellerApplication.tsx
    POST /api/admin/sellers/applications/{id}/start-review <- admin-center/src/pages/admin/SellerApplication.tsx
    POST /api/admin/sellers/change-requests/{id}/decide <- admin-center/src/pages/admin/Categories.tsx
    POST /api/admin/sellers/seller-invitations <- admin-center/src/pages/admin/Sellers.tsx
    POST /api/admin/sellers/sellers/exports <- admin-center/src/pages/admin/Sellers.tsx
    POST /api/admin/sellers/sellers/{id}/notes <- admin-center/src/pages/admin/Seller.tsx
    POST /api/admin/sellers/sellers/{id}/suspend <- admin-center/src/pages/admin/Seller.tsx
    POST /api/admin/settings/changes <- admin-center/src/pages/admin/data/product-image-settings.tsx, admin-center/src/pages/admin/Settings.tsx
    POST /api/admin/settings/changes/{id}/cancel <- admin-center/src/pages/admin/data/product-image-settings.tsx, admin-center/src/pages/admin/Settings.tsx
    POST /api/admin/settings/changes/{id}/submit <- admin-center/src/pages/admin/data/product-image-settings.tsx, admin-center/src/pages/admin/Settings.tsx
    POST /api/admin/shipping/claims <- admin-center/src/pages/ops/Dispatch.tsx
    POST /api/admin/shipping/exceptions/bulk <- admin-center/src/pages/admin/Orders.tsx
    POST /api/admin/shipping/exceptions/{id}/escalate <- admin-center/src/pages/ops/Dispatch.tsx
    POST /api/admin/shipping/exceptions/{id}/notify-customer <- admin-center/src/pages/ops/Dispatch.tsx
    POST /api/admin/shipping/exceptions/{id}/notify-seller <- admin-center/src/pages/admin/Dashboard.tsx, admin-center/src/pages/admin/Orders.tsx, admin-center/src/pages/ops/Dispatch.tsx
    POST /api/admin/shipping/exceptions/{id}/request-tracking <- admin-center/src/pages/ops/Dispatch.tsx
    POST /api/admin/shipping/exceptions/{id}/resolve <- admin-center/src/pages/ops/Dispatch.tsx
    POST /api/admin/shipping/notices <- admin-center/src/pages/admin/Shipping.tsx
    POST /api/admin/shipping/notices/preview <- admin-center/src/pages/admin/Shipping.tsx
    POST /api/admin/shipping/notices/{id}/publish <- admin-center/src/pages/admin/Shipping.tsx
    POST /api/admin/support/cases/assign <- admin-center/src/pages/admin/Cases.tsx
    POST /api/admin/support/cases/priority <- admin-center/src/pages/admin/Cases.tsx
    POST /api/admin/support/cases/{id}/assign <- admin-center/src/pages/admin/Case.tsx
    POST /api/admin/support/cases/{id}/decide <- admin-center/src/pages/admin/Case.tsx
    POST /api/admin/support/cases/{id}/escalate <- admin-center/src/pages/admin/Case.tsx
    POST /api/admin/support/cases/{id}/messages <- admin-center/src/pages/admin/Case.tsx
    POST /api/admin/support/cases/{id}/resolve <- admin-center/src/pages/admin/Case.tsx
    POST /api/admin/trust/evidence-requests/{id}/cancel <- admin-center/src/pages/admin/TrustReport.tsx
    POST /api/admin/trust/recommendations/{id}/route <- admin-center/src/pages/admin/TrustReport.tsx
    POST /api/admin/trust/reports/exports <- admin-center/src/pages/admin/Trust.tsx
    POST /api/admin/trust/reports/{id}/assign <- admin-center/src/pages/admin/TrustReport.tsx
    POST /api/admin/trust/reports/{id}/dismiss <- admin-center/src/pages/admin/Trust.tsx, admin-center/src/pages/admin/TrustReport.tsx
    POST /api/admin/trust/reports/{id}/evidence-requests <- admin-center/src/pages/admin/TrustReport.tsx
    POST /api/admin/trust/reports/{id}/recommendations <- admin-center/src/pages/admin/TrustReport.tsx
    POST /api/admin/warehouse/fulfillments/{id}/packages <- admin-center/src/pages/ops/PickPack.tsx
    POST /api/admin/warehouse/fulfillments/{id}/report-damage <- admin-center/src/pages/ops/PickPack.tsx
    POST /api/admin/warehouse/packages/{id}/label <- admin-center/src/pages/ops/PickPack.tsx
    POST /api/admin/warehouse/packages/{id}/pack <- admin-center/src/pages/ops/PickPack.tsx
    POST /api/admin/warehouse/packages/{id}/scan <- admin-center/src/pages/ops/PickPack.tsx
    POST /api/admin/warehouse/pick-lines/{id}/pick <- admin-center/src/pages/ops/PickPack.tsx
    POST /api/admin/warehouse/pick-lines/{id}/report-shortage <- admin-center/src/pages/ops/PickPack.tsx
    POST /api/admin/warehouse/waves <- admin-center/src/pages/ops/PickPack.tsx
    POST /api/admin/warehouse/waves/{id}/start <- admin-center/src/pages/ops/PickPack.tsx
    POST /api/admin/workqueues/day-end-reviews/{id}/complete <- admin-center/src/pages/ops/Queues.tsx
    POST /api/admin/workqueues/day-end-reviews/{id}/items/{itemKey}/check <- admin-center/src/pages/ops/Queues.tsx
    POST /api/admin/workqueues/items/exports <- admin-center/src/pages/ops/Queues.tsx
    POST /api/admin/workqueues/saved-filters <- admin-center/src/pages/ops/Queues.tsx
    POST /api/public/identity/invitations/accept <- admin-center/src/app/Invitation.tsx
    POST /api/public/identity/invitations/lookups <- admin-center/src/app/Invitation.tsx
    POST /api/public/identity/password-resets/complete <- admin-center/src/app/ResetPassword.tsx
    POST /api/public/identity/password-resets/lookups <- admin-center/src/app/ResetPassword.tsx
    POST /api/public/identity/sessions <- admin-center/src/app/SignIn.tsx
    PUT /api/admin/access/roles/{id}/permissions <- admin-center/src/pages/admin/Staff.tsx
    PUT /api/admin/catalog/categories/{id}/attributes <- admin-center/src/pages/admin/Categories.tsx
    PUT /api/admin/catalog/products/{id}/review-draft <- admin-center/src/pages/admin/ProductReview.tsx
    PUT /api/admin/content/homepage/order <- admin-center/src/pages/admin/Content.tsx
    PUT /api/admin/notifications/my-preferences <- admin-center/src/pages/admin/Inbox.tsx
    PUT /api/admin/notifications/topics/{key}/channels <- admin-center/src/pages/admin/Notifications.tsx
    PUT /api/admin/returns/requests/{id}/inspection-draft <- admin-center/src/pages/ops/ReturnInspection.tsx
    PUT /api/admin/support/cases/{id}/decision-draft <- admin-center/src/pages/admin/Case.tsx
  [shared]
    GET /api/public/settings/app-config <- web-shared/src/api/appConfig.ts
    GET /api/store/cart <- web-shared/src/api/client.ts, web-shared/src/api/provider.tsx