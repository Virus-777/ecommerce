// Tests of the live notice client (src/api/live.ts): the SSE parser, the reconnect backoff, and the stream loop
// against a fake fetch. Node runs the TypeScript file directly (type stripping, Node 23.6+).
//   npm test -w @marketly/web-shared        (or: node --test web-shared/tools/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, parseSse, startLive } from '../src/api/live.ts';

/** Feeds `chunks` through the parser like the client does and returns every event. */
function parseChunks(chunks) {
  const out = [];
  let buf = '';
  for (const c of chunks) {
    const r = parseSse(buf + c);
    buf = r.rest;
    out.push(...r.events);
  }
  return { events: out, rest: buf };
}

test('parses the contract format: retry, notice with id, ready, ping comment, end', () => {
  const text = 'retry: 5000\n\nid: n1\nevent: notice\ndata: {"id":"n1"}\n\nevent: ready\ndata: {"at":"2026-10-20T10:00:00Z","caughtUp":1}\n\n: ping\n\nevent: end\ndata: {"reason":"restart"}\n\n';
  const { events, rest } = parseSse(text);
  assert.equal(rest, '');
  assert.deepEqual(events, [
    { event: 'message', data: null, retry: 5000 },
    { event: 'notice', data: '{"id":"n1"}', id: 'n1' },
    { event: 'ready', data: '{"at":"2026-10-20T10:00:00Z","caughtUp":1}' },
    { event: 'end', data: '{"reason":"restart"}' },
  ]);
});

test('joins multi-line data with \\n and keeps an unfinished event as the rest', () => {
  const { events, rest } = parseSse('data: a\ndata: b\ndata:c\n\ndata: unfinished\n');
  assert.deepEqual(events, [{ event: 'message', data: 'a\nb\nc' }]);
  assert.equal(rest, 'data: unfinished\n');
});

test('handles \\r\\n, lone \\r and a \\r\\n split across chunks', () => {
  assert.deepEqual(parseSse('event: ready\r\ndata: {}\r\n\r\n').events, [{ event: 'ready', data: '{}' }]);
  // A lone \r ends a line too (a trailing one is held back: it may be the first half of \r\n).
  assert.deepEqual(parseSse('data: x\r\r: ping').events, [{ event: 'message', data: 'x' }]);
  const split = parseChunks(['event: notice\r\ndata: {"id":"a"}\r', '\n\r', '\n']);
  assert.deepEqual(split.events, [{ event: 'notice', data: '{"id":"a"}' }]);
  assert.equal(split.rest, '');
});

test('splits at any byte boundary the same way', () => {
  const text = 'id: 7\nevent: notice\ndata: {"id":"7","title":"Héllo"}\n\n: ping\n\nevent: ready\ndata: {}\n\n';
  const whole = parseSse(text).events;
  for (let i = 1; i < text.length; i++) assert.deepEqual(parseChunks([text.slice(0, i), text.slice(i)]).events, whole, `split at ${i}`);
});

test('ignores comments, unknown fields and a non-numeric retry; strips only one leading space', () => {
  const { events } = parseSse(': hello\nfoo: bar\nretry: soon\n\ndata:  two spaces\n\n:only a comment\n\n');
  assert.deepEqual(events, [{ event: 'message', data: ' two spaces' }]);
});

test('backoff: 1 s, 2 s, 5 s, 10 s, then 30 s, plus up to 1 s jitter', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map((a) => backoffDelay(a, () => 0)), [1000, 2000, 5000, 10000, 30000, 30000, 30000]);
  assert.equal(backoffDelay(0, () => 0.999), 1999);
});

/** A fetch whose responses are scripted: each call takes the next item (a stream text, or a status). */
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const step = script.shift() ?? { hang: true };
    if (step.status) return new Response(JSON.stringify(step.body ?? {}), { status: step.status, headers: { 'Content-Type': 'application/json' } });
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        for (const chunk of step.chunks ?? []) c.enqueue(enc.encode(chunk));
        if (!step.hang) c.close();
        init.signal.addEventListener('abort', () => {
          try {
            c.error(new DOMException('aborted', 'AbortError'));
          } catch {
            /* already closed */
          }
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fn, calls };
}

const waitFor = async (check, ms = 3000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('stream loop: catch-up flag, ready, max_age reconnects at once with Last-Event-ID', async () => {
  const { fn, calls } = fakeFetch([
    { chunks: ['retry: 50\n\nid: a\nevent: notice\ndata: {"id":"a"}\n\nevent: ready\ndata: {"at":"x","caughtUp":1}\n\n', 'id: b\nevent: notice\ndata: {"id":"b"}\n\nevent: end\ndata: {"reason":"max_age"}\n\n'] },
    { chunks: ['event: ready\ndata: {"at":"y","caughtUp":0}\n\n'], hang: true },
  ]);
  const events = [];
  const stop = startLive({ url: '/s', name: 't1', locks: null, fetch: fn, auth: { token: async () => 'tok', refused() {}, subscribe: () => () => {} }, onEvent: (e, own) => events.push({ ...e, own }) });
  await waitFor(() => events.filter((e) => e.type === 'ready').length === 2);
  stop();
  assert.deepEqual(
    events.map((e) => (e.type === 'notice' ? `notice:${e.notice.id}:${e.catchUp}` : e.type === 'end' ? `end:${e.reason}` : 'ready')),
    ['notice:a:true', 'ready', 'notice:b:false', 'end:max_age', 'ready'],
  );
  assert.equal(calls[0].headers['Authorization'], 'Bearer tok');
  assert.equal(calls[0].headers['Last-Event-ID'], undefined);
  assert.equal(calls[1].headers['Last-Event-ID'], 'b');
  assert.ok(events.every((e) => e.own));
});

test('stream loop: signed_out stops until the token changes; a 401 token_* asks auth.refused', async () => {
  const { fn, calls } = fakeFetch([
    { chunks: ['event: end\ndata: {"reason":"signed_out"}\n\n'] },
    { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x', details: { reason: 'token_expired' } } } },
    { chunks: ['event: ready\ndata: {}\n\n'], hang: true },
  ]);
  let token = 'one';
  let wake = () => {};
  const refused = [];
  const events = [];
  const stop = startLive({
    url: '/s',
    name: 't2',
    locks: null,
    fetch: fn,
    auth: { token: async () => token, refused: (s, b) => void refused.push([s, b.error.details.reason]), subscribe: (f) => ((wake = f), () => {}) },
    onEvent: (e) => events.push(e),
  });
  await waitFor(() => events.some((e) => e.type === 'end'));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.length, 1, 'no reconnect with the signed-out token');
  token = 'two';
  wake();
  await waitFor(() => refused.length === 1);
  assert.deepEqual(refused[0], [401, 'token_expired']);
  token = 'three'; // e.g. the app refreshed; the backoff (1 s) passes, then it connects with the new token
  wake();
  await waitFor(() => events.some((e) => e.type === 'ready'), 4000);
  stop();
  assert.deepEqual(calls.map((c) => c.headers.Authorization), ['Bearer one', 'Bearer two', 'Bearer three']);
});

test('one stream per name: the lock holder streams and relays to the other tab', async () => {
  if (!globalThis.navigator?.locks || typeof BroadcastChannel !== 'function') return; // older Node: nothing to test
  const { fn, calls } = fakeFetch([{ chunks: ['id: z\nevent: notice\ndata: {"id":"z"}\n\nevent: ready\ndata: {}\n\n'], hang: true }]);
  const a = [];
  const b = [];
  const auth = { token: async () => 'tok', refused() {}, subscribe: () => () => {} };
  // Two "tabs" start together: the first gets the lock, the second follows over the channel.
  const stopA = startLive({ url: '/s', name: 't3', fetch: fn, auth, onEvent: (e, own) => a.push({ type: e.type, own }) });
  const stopB = startLive({ url: '/s', name: 't3', fetch: fn, auth, onEvent: (e, own) => b.push({ type: e.type, own }) });
  await waitFor(() => a.length === 2 && b.length === 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.length, 1, 'only one stream');
  assert.deepEqual(a, [
    { type: 'notice', own: true },
    { type: 'ready', own: true },
  ]);
  assert.deepEqual(b, [
    { type: 'notice', own: false },
    { type: 'ready', own: false },
  ]);
  // The holder leaves: the follower takes the lock and streams from the last notice it saw.
  stopA();
  await waitFor(() => calls.length === 2);
  assert.equal(calls[1].headers['Last-Event-ID'], 'z');
  stopB();
});
