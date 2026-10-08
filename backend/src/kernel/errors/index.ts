/**
 * Errors with stable codes: `{ error: { code, message, details } }` (common.json "errors").
 * Module-specific codes and their HTTP status come from each spec's `errorCodes`.
 */
import { commonErrors } from '../../spec/common.js';

const statusByCode = new Map<string, number>(Object.entries(commonErrors).map(([code, e]) => [code, e.status]));
const meaningByCode = new Map<string, string>(Object.entries(commonErrors).map(([code, e]) => [code, e.meaning]));

/** Called by the module loader with every spec's errorCodes. */
export function registerErrorCodes(codes: Readonly<Record<string, { readonly status: number; readonly meaning: string }>>) {
  for (const [code, e] of Object.entries(codes)) {
    statusByCode.set(code, e.status);
    meaningByCode.set(code, e.meaning);
  }
}

export function errorStatus(code: string): number {
  return statusByCode.get(code) ?? 500;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message?: string, details?: unknown, status?: number) {
    super(message ?? meaningByCode.get(code) ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? errorStatus(code);
    this.details = details;
  }

  toBody() {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}

export const fail = (code: string, message?: string, details?: unknown): never => {
  throw new AppError(code, message, details);
};

/**
 * Designed in the spec but not built yet. Uses the spec's NOT_IMPLEMENTED (501) code;
 * `details.reason` tells a not-yet-built endpoint apart from a later launch phase.
 */
export const notImplemented = (what: string, details: Record<string, unknown> = {}) =>
  new AppError('NOT_IMPLEMENTED', `${what} is designed but not built yet.`, { operation: what, reason: 'not_built', ...details });

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
