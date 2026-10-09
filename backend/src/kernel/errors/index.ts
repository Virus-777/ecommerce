/**
 * Errors with stable codes: `{ error: { code, message, details } }` (common.json "errors").
 * Module-specific codes and their HTTP status come from each spec's `errorCodes`.
 */
import { commonErrors } from '../../spec/common.js';

export interface ErrorInfo {
  readonly status: number;
  readonly meaning: string;
}

const common = new Map<string, ErrorInfo>(Object.entries(commonErrors));
/** Module codes are scoped: the same code may mean a different status in another module (e.g. INSUFFICIENT_STOCK) */
const byModule = new Map<string, Map<string, ErrorInfo>>();
/** For an AppError raised without its module: the last module that declared the code */
const anyModule = new Map<string, ErrorInfo>();

/** Called at startup with every spec's errorCodes. */
export function registerErrorCodes(module: string, codes: Readonly<Record<string, ErrorInfo>>) {
  byModule.set(module, new Map(Object.entries(codes)));
  for (const [code, info] of Object.entries(codes)) anyModule.set(code, info);
}

/** Status and meaning of a code: common codes first, then the module's own */
export const errorInfo = (code: string, module?: string): ErrorInfo | undefined =>
  common.get(code) ?? (module ? byModule.get(module)?.get(code) : undefined) ?? anyModule.get(code);

const GENERIC_CODES: Record<number, string> = { 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 429: 'RATE_LIMITED' };

/** The common code for an HTTP status that has no AppError behind it (Fastify's own 4xx errors). */
export const codeForStatus = (status: number): string => GENERIC_CODES[status] ?? 'VALIDATION_FAILED';

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message?: string, details?: unknown, status?: number) {
    super(message ?? errorInfo(code)?.meaning ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? errorInfo(code)?.status ?? 500;
    this.details = details;
  }

  /** Read by Fastify and Mercurius to pick the HTTP status */
  get statusCode() {
    return this.status;
  }

  /** graphql-js copies this onto the GraphQL error, so resolvers can simply throw AppErrors. */
  get extensions() {
    return { code: this.code, ...(this.details === undefined ? {} : { details: this.details }) };
  }

  toBody() {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}

/**
 * An AppError with this module's status for the code: module codes are scoped (INSUFFICIENT_STOCK is 409
 * in one module and 422 in another), and an error thrown to another module in-process must keep the
 * thrower's status. Modules get it bound as `ctx.error`.
 */
export const moduleError =
  (module: string) =>
  (code: string, message?: string, details?: unknown): AppError =>
    new AppError(code, message ?? errorInfo(code, module)?.meaning, details, errorInfo(code, module)?.status);

/**
 * Designed in the spec but not built yet. Uses the spec's NOT_IMPLEMENTED (501) code;
 * `details.reason` tells a not-yet-built endpoint apart from a later launch phase.
 */
export const notImplemented = (what: string, details: Record<string, unknown> = {}) =>
  new AppError('NOT_IMPLEMENTED', `${what} is designed but not built yet.`, { operation: what, reason: 'not_built', ...details });

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

export const isNotImplemented = (e: unknown): boolean => isAppError(e) && e.code === 'NOT_IMPLEMENTED';
