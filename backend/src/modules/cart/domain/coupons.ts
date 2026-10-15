/**
 * Coupon coverage wording shared by the cart preview and checkout (checkout imports it through cart/contract.ts),
 * so both screens explain an applied coupon the same way.
 */
import type * as promotions from '../../../spec/promotions.js';

export const NOT_COVERED_ON_SALE = 'Already on sale';
export const NOT_COVERED_EXCLUDED = 'Not included in this coupon';

/**
 * The lines an applied coupon leaves out, with the reason: the line already has a sale price (a markdown or flash
 * price from the evaluation) or the coupon's terms do not include it. A coupon that covers no line (a shipping or
 * order-level discount) leaves nothing out.
 */
export function couponNotCovered(
  coversLineIds: readonly string[],
  lines: readonly { lineId: string; title: string }[],
  evaluation: Pick<promotions.CartEvaluation, 'lines'>,
): { lineId: string; title: string; reason: string }[] {
  if (!coversLineIds.length) return [];
  return lines
    .filter((l) => !coversLineIds.includes(l.lineId))
    .map((l) => {
      const priced = evaluation.lines.find((x) => x.lineId === l.lineId);
      const onSale = priced ? priced.unitPrice.amount < priced.regularUnitPrice.amount : false;
      return { lineId: l.lineId, title: l.title, reason: onSale ? NOT_COVERED_ON_SALE : NOT_COVERED_EXCLUDED };
    });
}
