/**
 * Development outbox (BACKEND-REQUESTS R1): what the development providers "sent", so a seed script or a
 * developer can finish sign-up, accept an invitation, reset a password or open an emailed order link.
 *
 *   GET    /api/dev/notifications/outbox?to=<address>&channel=email|sms|push&since=<ISO>&limit=<1-200>   newest first
 *   DELETE /api/dev/notifications/outbox                                                                  clears it (204)
 *
 * Served only while DEV_TOKENS is on, outside the API spec and hidden from OpenAPI (kernel/http/dev-routes.ts);
 * any valid token of any app may call them. Staff pass codes are never emailed (use the staff-link tool).
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { DevRoute } from '../../../kernel/http/dev-routes.js';
import { devOutbox, listDevOutbox, type DevChannel, type DevOutboxQuery } from '../providers/dev-outbox.js';

const CHANNELS: DevChannel[] = ['email', 'sms', 'push'];

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', `Invalid query: ${path} ${message}`, { issues: [{ path, message }] });
}

/** Reads and checks the query (every parameter optional; limit 1-200, default 50) */
export function outboxQuery(raw: Record<string, unknown>): DevOutboxQuery {
  const one = (key: string) => {
    const v = raw[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const q: DevOutboxQuery = { limit: 50 };
  const to = one('to');
  if (to) q.to = to;
  const channel = one('channel');
  if (channel) {
    if (!CHANNELS.includes(channel as DevChannel)) throw invalid('channel', `must be one of ${CHANNELS.join(', ')}`);
    q.channel = channel as DevChannel;
  }
  const since = one('since');
  if (since) {
    const at = new Date(since);
    if (Number.isNaN(at.getTime())) throw invalid('since', 'must be an ISO date-time');
    q.since = at;
  }
  const limit = one('limit');
  if (limit) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw invalid('limit', 'must be a whole number from 1 to 200');
    q.limit = n;
  }
  return q;
}

export const devRoutes: DevRoute[] = [
  {
    method: 'GET',
    path: '/outbox',
    summary: 'what the development email, SMS and push providers sent, with template data and links',
    handler: async ({ query }) => ({ items: listDevOutbox(outboxQuery(query ?? {})) }),
  },
  {
    method: 'DELETE',
    path: '/outbox',
    summary: 'clear the development outbox',
    handler: async () => {
      devOutbox.clear();
      return undefined; // 204
    },
  },
];
