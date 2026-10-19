// Option lists for pages/ops/ReturnInspection.tsx (design: pages/ops/ops-return-inspection*.html), mapped onto the
// returns API (InspectionInput.grade and proposedStockOutcome). The rows come from GET /api/admin/returns/inspections.

export type Grade = 'new_sealed' | 'like_new' | 'good' | 'damaged';
export const CONDITIONS: Array<{ id: Grade; title: string; body: string }> = [
  { id: 'new_sealed', title: 'New, sealed', body: 'Factory seal intact' },
  { id: 'like_new', title: 'Like new, opened', body: 'No marks, works fully' },
  { id: 'good', title: 'Good, light wear', body: 'Small marks, works fully' },
  { id: 'damaged', title: 'Damaged or not working', body: 'Needs repair or write-off' },
];

export type Outcome = 'restock' | 'repair' | 'different_condition' | 'return_to_supplier' | 'write_off' | 'damaged_stock';
export const OUTCOMES: Array<{ id: Outcome; title: string; body: string }> = [
  { id: 'restock', title: 'Restock as new', body: 'Only for sealed, unused items' },
  { id: 'repair', title: 'Repair', body: 'Send to the brand’s service partner' },
  { id: 'different_condition', title: 'Sell as different condition', body: 'A used offer at a lower price' },
  { id: 'return_to_supplier', title: 'Return to supplier', body: 'Supplier return authorization needed' },
  { id: 'write_off', title: 'Write off', body: 'Not sellable. Records the cost as a return loss.' },
];

export const gradeLabel = (g: Grade | '') => (g === 'good' ? 'Used – Good' : 'Used – Like new');

/** Which outcomes a condition allows (restock only when sealed; a different condition only for opened, working items). */
export function outcomeDisabled(o: Outcome, g: Grade | '') {
  if (o === 'restock') return g !== 'new_sealed';
  if (o === 'different_condition') return g === 'damaged' || g === 'new_sealed';
  return false;
}

/** Where the unit goes in stock for an outcome (Inventory records it). */
export function stockMovement(o: Outcome | '', g: Grade | ''): string | null {
  switch (o) {
    case 'restock':
      return 'Available · New';
    case 'different_condition':
      return `Available · ${gradeLabel(g)}`;
    case 'repair':
      return 'Damaged or held · at repair partner';
    case 'return_to_supplier':
      return 'Damaged or held · return to supplier';
    case 'write_off':
      return 'Removed · return loss';
    case 'damaged_stock':
      return 'Damaged or held';
    default:
      return null;
  }
}
