/** The backend's error envelope: `{ error: { code, message, details? } }` (docs/api/README.md, Errors). */
export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** A refused or failed API request, with the server's code, details and request id. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}, requestId: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** Field errors from VALIDATION_FAILED, keyed by the field name (`body.email` → `email`). */
  get fieldErrors(): Record<string, string> {
    const issues = (this.details.issues as Array<{ path: string; message: string }> | undefined) ?? [];
    return Object.fromEntries(issues.map((i) => [i.path.replace(/^(body|querystring|params)\./, ''), i.message]));
  }
}

/** 401 whose reason starts with `token_`: the only case where the client refreshes and retries. */
export const isTokenProblem = (status: number, body: unknown): boolean =>
  status === 401 && String((body as ErrorBody | undefined)?.error?.details?.reason ?? '').startsWith('token_');

export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    /* not JSON, or the body was already read */
  }
  return apiErrorFrom(res, body);
}

/** An ApiError from a response whose body was already parsed (openapi-fetch reads it into `error`). */
export function apiErrorFrom(res: Response, body: unknown): ApiError {
  const requestId = res.headers.get('x-request-id');
  const e = (body as ErrorBody | undefined)?.error;
  const env = e && typeof e === 'object' ? e : undefined;
  return new ApiError(res.status, env?.code ?? (res.status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_' + res.status), env?.message ?? res.statusText, env?.details ?? {}, requestId);
}

/** A short, user-facing sentence for an error (the server's message, with a fallback for network failures). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'RATE_LIMITED') return `Too many attempts. Try again in ${e.details.retryAfterSeconds ?? 'a few'} seconds.`;
    if (e.status >= 500) return `Something went wrong on our side. Try again in a moment${e.requestId ? ` (reference ${e.requestId})` : ''}.`;
    return e.message;
  }
  return 'We couldn’t reach Marketly. Check your connection and try again.';
}
