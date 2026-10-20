/** Address rules every module applies the same way. */

const PO_BOX = /\b(p\s*\.?\s*o\s*\.?\s*box\b|post\s+office\s+box\b|pob\s+\d|pmb\b|box\s+\d+\s*$)/i;

/**
 * An address line that is a mailbox, not a street address: P.O. Box, Post Office Box, POB 12, PMB 12 (private
 * mailbox) or a line ending in "Box 12". Deliveries and seller returns need a street address.
 */
export const isPoBoxLine = (line: string | null | undefined) => Boolean(line && PO_BOX.test(line));
