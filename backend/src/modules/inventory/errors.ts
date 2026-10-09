/**
 * This module's error codes with the status its spec gives them. Codes such as INSUFFICIENT_STOCK
 * exist in several modules with different statuses, so the status is set here rather than looked
 * up by code alone (which matters for errors thrown to other modules in-process).
 */
import { AppError } from '../../kernel/errors/index.js';
import { spec } from '../../spec/inventory.js';

export type InventoryErrorCode = keyof typeof spec.errorCodes;

export const inventoryError = (code: InventoryErrorCode, message?: string, details?: unknown) => new AppError(code, message ?? spec.errorCodes[code].meaning, details, spec.errorCodes[code].status);
