/**
 * A small Server-Sent Events client for the live notification tests: real HTTP (inject() cannot stream), the way
 * the apps read the stream (fetch with a reader, the token in the Authorization header).
 */
export interface SseEvent {
  event: string;
  data: any;
  id?: string;
}

export class SseClient {
  readonly events: SseEvent[] = [];
  readonly comments: string[] = [];
  status = 0;
  headers = new Headers();
  /** The response body when the stream did not open (an error) */
  body: any = null;
  retry: number | undefined;
  /** The server closed the stream (or the client did) */
  ended = false;
  readonly #abort = new AbortController();

  /** Opens the stream; resolves once the response head is in */
  static async open(url: string, headers: Record<string, string>): Promise<SseClient> {
    const c = new SseClient();
    const res = await fetch(url, { headers, signal: c.#abort.signal });
    c.status = res.status;
    c.headers = res.headers;
    if (!res.headers.get('content-type')?.startsWith('text/event-stream') || !res.body) {
      const text = await res.text();
      c.body = text ? JSON.parse(text) : null;
      c.ended = true;
      return c;
    }
    void c.#read(res.body);
    return c;
  }

  async #read(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
          this.#block(buffer.slice(0, i));
          buffer = buffer.slice(i + 2);
        }
      }
    } catch {
      // aborted by close()
    } finally {
      this.ended = true;
    }
  }

  #block(block: string) {
    const e: Partial<SseEvent> = {};
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        this.comments.push(line.slice(1).trim());
        continue;
      }
      const at = line.indexOf(':');
      const field = line.slice(0, at);
      const value = line.slice(at + 1).replace(/^ /, '');
      if (field === 'event') e.event = value;
      else if (field === 'data') e.data = JSON.parse(value);
      else if (field === 'id') e.id = value;
      else if (field === 'retry') this.retry = Number(value);
    }
    if (e.event) this.events.push(e as SseEvent);
  }

  /** The first event that matches, waiting for it */
  async waitFor(match: (e: SseEvent) => boolean, ms = 5000): Promise<SseEvent> {
    const until = Date.now() + ms;
    for (;;) {
      const hit = this.events.find(match);
      if (hit) return hit;
      if (this.ended || Date.now() > until) throw new Error(`no matching event (ended: ${this.ended}); got ${JSON.stringify(this.events)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Waits until the server has closed the stream */
  async waitEnded(ms = 5000) {
    const until = Date.now() + ms;
    while (!this.ended) {
      if (Date.now() > until) throw new Error(`the stream is still open; got ${JSON.stringify(this.events)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  notices() {
    return this.events.filter((e) => e.event === 'notice').map((e) => e.data);
  }

  close() {
    this.#abort.abort();
  }
}

/** Waits a little: long enough for a pushed notice to arrive, to show that none does */
export const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
