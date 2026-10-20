// Live notices for the Seller Center and Admin Center: a Server-Sent Events stream of the caller's inbox notices
// (GET /api/seller/notifications/stream, GET /api/admin/notifications/stream; docs/api/modules/notifications.md).
//
// Why fetch and not EventSource: EventSource can't send headers, and the token must ride in Authorization like
// every other call (never in the URL, where proxies log it).
//
// One stream per browser and app: the tab holding the Web Lock `marketly-live:<audience>[:<scope>]` opens the stream
// and relays every event to the other tabs over a BroadcastChannel of the same name. When that tab closes, another
// takes the lock (and reconnects with Last-Event-ID, so nothing is missed). Without Web Locks every tab streams.
//
// This file has no runtime imports (node can load it as is: web-shared/tools/live.test.mjs tests it).

/** One event of a text/event-stream (https://html.spec.whatwg.org/multipage/server-sent-events.html). */
export interface SseEvent {
  /** The `event:` field; 'message' when there is none. */
  event: string;
  /** The `data:` lines joined with \n; null when the block had no data line (e.g. only `retry:`). */
  data: string | null;
  id?: string;
  /** `retry:` in ms (digits only, as the spec says). */
  retry?: number;
}

/**
 * Parses the complete events in `text` (what the stream sent so far, after the last parsed event).
 * Returns them and the unfinished rest to prepend to the next chunk. Pure: no state between calls.
 * Lines end with \n, \r\n or \r; an event ends at a blank line; lines starting with ':' are comments (pings).
 */
export function parseSse(text: string): { events: SseEvent[]; rest: string } {
  // A trailing \r may be the first half of a \r\n split across chunks: keep it for the next call.
  const hold = text.endsWith('\r') ? '\r' : '';
  const body = (hold ? text.slice(0, -1) : text).replace(/\r\n?/g, '\n');
  const events: SseEvent[] = [];
  let start = 0;
  for (;;) {
    const end = body.indexOf('\n\n', start);
    if (end < 0) break;
    const ev = parseBlock(body.slice(start, end));
    if (ev) events.push(ev);
    start = end + 2;
  }
  return { events, rest: body.slice(start) + hold };
}

function parseBlock(block: string): SseEvent | null {
  const ev: SseEvent = { event: 'message', data: null };
  const data: string[] = [];
  let any = false;
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') ev.event = value || 'message';
    else if (field === 'id' && !value.includes('\0')) ev.id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) ev.retry = Number(value);
    else continue;
    any = true;
  }
  if (!any) return null;
  if (data.length) ev.data = data.join('\n');
  return ev;
}

/** Reconnect delays (contract): 1 s, 2 s, 5 s, 10 s, then 30 s, each plus up to 1 s of jitter. */
const BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000];

/** The wait before reconnect attempt `attempt` (0 = first retry). Jitter spreads tabs and PCs after a restart. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  return BACKOFF[Math.min(Math.max(attempt, 0), BACKOFF.length - 1)] + Math.floor(random() * 1_000);
}

/** Why the server closed the stream (event `end`). */
export type LiveEndReason = 'signed_out' | 'session_idle' | 'restart' | 'max_age';

export type LiveEvent<N> =
  /** catchUp: sent before `ready` (missed while the stream was down), not just now. */
  | { type: 'notice'; notice: N; catchUp: boolean }
  | { type: 'ready'; at: string; caughtUp: number }
  | { type: 'end'; reason: LiveEndReason | string };

/** How the stream gets its token; each app decides (seller may refresh, admin must not: see LiveNotifications). */
export interface LiveAuth {
  /** A token to connect with, or null while there is none to use (the client waits and asks again). */
  token(): Promise<string | null>;
  /** The server refused the connect (401/403) with this body: refresh, end the session, or nothing. */
  refused(status: number, body: unknown): Promise<void> | void;
  /** Called on every session change: wakes a waiting client early (e.g. a refresh brought a new token). */
  subscribe(fn: () => void): () => void;
}

export interface LiveOptions<N> {
  /** The stream URL, e.g. `${baseUrl}/api/seller/notifications/stream`. */
  url: string;
  /** Lock and channel name: one stream per name per browser. */
  name: string;
  auth: LiveAuth;
  /** Every event; `own` is true in the tab that holds the stream (desktop alerts and sound only there). */
  onEvent: (e: LiveEvent<N>, own: boolean) => void;
  /** For tests: the lock manager (null = no Web Locks, every caller streams). Default navigator.locks. */
  locks?: LockManager | null;
  /** For tests: fetch. */
  fetch?: typeof fetch;
}

/** Without a token: ask again every 30 s (or sooner when the session changes). */
const TOKEN_POLL = 30_000;
/** The server pings every 25 s; this long without a byte means the line is dead (sleeping PC, dropped LAN). */
const SILENCE = 70_000;
/** The contract's default when the server sent no `retry:` yet. */
const DEFAULT_RETRY = 5_000;

/** Waits ms, or until aborted, or (with `wake`) until the session changes. */
function pause(ms: number, signal: AbortSignal, wake?: (fn: () => void) => () => void): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let unsub: (() => void) | undefined;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      unsub?.();
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
    unsub = wake?.(done);
  });
}

/**
 * Starts the live stream (or follows the tab that has it). Returns stop(): closes the stream, leaves the lock and
 * the channel. Call it on sign-out, on a seller switch (then start again) and on unmount.
 */
export function startLive<N extends { id: string }>(o: LiveOptions<N>): () => void {
  const stop = new AbortController();
  const doFetch = o.fetch ?? fetch;
  // The newest notice id seen, own or relayed: a tab that takes over the stream resumes from it.
  let lastId: string | undefined;

  /** The stream loop of the tab that holds the lock. Returns only when stopped. */
  async function run(signal: AbortSignal, emit: (e: LiveEvent<N>) => void) {
    let attempt = 0;
    let retry = DEFAULT_RETRY;
    // A token the server refused or signed out: wait for a different one (sign-in again, refresh, store switch).
    let blocked: string | null = null;
    while (!signal.aborted) {
      const token = await o.auth.token().catch(() => null);
      if (signal.aborted) break;
      if (!token || token === blocked) {
        await pause(TOKEN_POLL, signal, o.auth.subscribe);
        continue;
      }
      const conn = new AbortController();
      const abortConn = () => conn.abort();
      signal.addEventListener('abort', abortConn);
      let silence: ReturnType<typeof setTimeout> | undefined;
      const alive = () => {
        clearTimeout(silence);
        silence = setTimeout(abortConn, SILENCE);
      };
      let next: 'backoff' | 'now' | 'retry' | 'token' = 'backoff';
      try {
        alive();
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'X-Client': 'web' };
        if (lastId) headers['Last-Event-ID'] = lastId;
        const res = await doFetch(o.url, { headers, signal: conn.signal, cache: 'no-store' });
        if (res.status === 401 || res.status === 403) {
          const body: unknown = await res.json().catch(() => undefined);
          // Don't reconnect with this token (the loop top waits for another), and back off first, so a refresh
          // the server keeps refusing can't spin.
          blocked = token;
          await o.auth.refused(res.status, body);
        } else if (res.ok && res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let ready = false;
          read: for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            alive();
            const parsed = parseSse(buf + decoder.decode(value, { stream: true }));
            buf = parsed.rest;
            for (const ev of parsed.events) {
              if (ev.retry !== undefined) retry = ev.retry;
              if (ev.data === null) continue;
              let data: unknown;
              try {
                data = JSON.parse(ev.data);
              } catch {
                continue; // a broken event must not break the stream
              }
              if (ev.event === 'notice') {
                const notice = data as N;
                lastId = ev.id || notice.id;
                emit({ type: 'notice', notice, catchUp: !ready });
              } else if (ev.event === 'ready') {
                ready = true;
                attempt = 0; // connected and caught up: the next drop starts the backoff again at 1 s
                const d = data as { at?: string; caughtUp?: number };
                emit({ type: 'ready', at: d.at ?? new Date().toISOString(), caughtUp: d.caughtUp ?? 0 });
              } else if (ev.event === 'end') {
                const reason = String((data as { reason?: string }).reason ?? '');
                emit({ type: 'end', reason });
                // signed_out / session_idle: this session's stream is over; a new token (sign-in) starts it again.
                if (reason === 'signed_out' || reason === 'session_idle') {
                  next = 'token';
                  blocked = token;
                } else if (reason === 'max_age') next = 'now';
                else next = 'retry'; // restart, or a reason this client doesn't know yet
                break read;
              }
            }
          }
          void reader.cancel().catch(() => {});
        }
        // Anything else (5xx, 404 while the backend is older than this app, a dropped line): back off.
      } catch {
        // Network error, or the silence timer aborted a dead line: back off. A stop() lands here too.
      } finally {
        clearTimeout(silence);
        signal.removeEventListener('abort', abortConn);
        conn.abort();
      }
      if (signal.aborted) break;
      if (next === 'now') continue;
      if (next === 'retry') await pause(retry + Math.floor(Math.random() * 1_000), signal);
      else if (next === 'backoff') await pause(backoffDelay(attempt++), signal);
      // 'token': the loop top waits for a different token.
    }
  }

  const locks = o.locks === undefined ? (globalThis.navigator?.locks ?? null) : o.locks;
  const channel = locks && typeof BroadcastChannel === 'function' ? new BroadcastChannel(o.name) : null;
  if (locks && channel) {
    let leading = false;
    channel.onmessage = (m: MessageEvent<LiveEvent<N>>) => {
      if (leading) return;
      if (m.data.type === 'notice') lastId = m.data.notice.id;
      o.onEvent(m.data, false);
    };
    locks
      .request(o.name, { signal: stop.signal }, async () => {
        leading = true;
        try {
          await run(stop.signal, (e) => {
            o.onEvent(e, true);
            channel.postMessage(e);
          });
        } finally {
          leading = false;
        }
      })
      .catch(() => {
        /* stopped while waiting for the lock (AbortError) */
      });
  } else {
    void run(stop.signal, (e) => o.onEvent(e, true));
  }

  return () => {
    stop.abort();
    channel?.close();
  };
}
