/**
 * Live notifications: the inbox streams open on this server (GET /api/seller/notifications/stream and
 * /api/admin/notifications/stream) and the push of every new notice to exactly the streams whose inbox shows it.
 *
 * The sender calls publish() right after the transaction that saved the notices committed, with the rows it
 * saved: who sees a notice is decided from those rows the way the inbox query decides it (repository.ts
 * #inboxBase), and the notice is shaped by the inbox's own mapper (noticeOf), so a streamed notice is exactly
 * the item GET /inbox returns to that person. publish() reads no notifications collections; only when a staff
 * stream receives a notice routed by role does it ask identity for the recipients' names (routedTo), once.
 *
 * In memory, per process: a notice created in another process (a separate jobs process, a second API
 * instance) reaches only the streams open in that process. Today's deployment is one process.
 */
import type { EventStream } from '../../../kernel/http/event-stream.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as identity from '../../../spec/identity.js';
import type { Notice } from '../../../spec/notifications.js';
import type { InboxOwner, InboxRow, NoticeRow, RecipientRow } from '../ports.js';
import type { Core } from './core.js';
import { noticeOf, type Inbox, type Reader } from './inbox.js';

/** Catch-up after a reconnect (Last-Event-ID): notices of the last 15 minutes, at most 20 */
const CATCH_UP_MS = 15 * 60_000;
const CATCH_UP_MAX = 20;

/** Who listens: a staff member, or a seller member with the topics their inbox shows (Inbox.owner) */
export type LiveOwner = Exclude<InboxOwner, { kind: 'customer' }>;
export type Push = (notice: Notice) => void;

interface Listener {
  owner: LiveOwner;
  push: Push;
}

export interface LiveHubDeps {
  core: Core;
  inbox: Inbox;
}

export class LiveHub {
  /** Staff streams by account id; seller streams by seller id (a workspace notice goes to several members) */
  readonly #staff = new Map<string, Set<Listener>>();
  readonly #sellers = new Map<string, Set<Listener>>();

  constructor(private readonly deps: LiveHubDeps) {}

  /**
   * GET /stream (Seller Center, Admin Center): with Last-Event-ID, first the notices of the reader's inbox created
   * after that one (last 15 minutes, at most 20, oldest first); then `ready`; then every new notice of the inbox
   * as it is saved, until the stream closes.
   */
  async serve(reader: Reader, stream: EventStream, lastEventId: string | undefined): Promise<void> {
    const { core, inbox } = this.deps;
    const owner = await inbox.owner(reader);
    const now = core.now();
    const since = new Date(now.getTime() - CATCH_UP_MS);
    const missed = owner && lastEventId && isUuid(lastEventId) ? await core.repo.inboxAfter(owner, lastEventId, since, CATCH_UP_MAX) : [];
    if (owner) for (const n of await inbox.toNotices(missed, owner)) stream.send('notice', n, n.id);
    stream.send('ready', { at: now.toISOString(), caughtUp: missed.length });
    if (owner && owner.kind !== 'customer') stream.onClose(this.listen(owner, (n) => stream.send('notice', n, n.id)));
  }

  /** Adds a stream; returns the function that removes it (call it when the stream closes) */
  listen(owner: LiveOwner, push: Push): () => void {
    const map = owner.kind === 'staff' ? this.#staff : this.#sellers;
    const key = owner.kind === 'staff' ? owner.accountId : owner.sellerId;
    const listener: Listener = { owner, push };
    const set = map.get(key) ?? new Set<Listener>();
    set.add(listener);
    map.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size && map.get(key) === set) map.delete(key);
    };
  }

  /** Open streams (tests, diagnostics) */
  get size() {
    let n = 0;
    for (const set of [...this.#staff.values(), ...this.#sellers.values()]) n += set.size;
    return n;
  }

  /** Pushes notices that were just saved, with their recipient rows, to every stream whose inbox shows them. Never throws. */
  async publish(notices: NoticeRow[], recipients: RecipientRow[]): Promise<void> {
    if (!this.#staff.size && !this.#sellers.size) return;
    try {
      const matches: { listener: Listener; row: InboxRow; rows: RecipientRow[] }[] = [];
      for (const n of notices) {
        const rows = recipients.filter((r) => r.notice_id === n.id);
        if (n.address_kind === 'role' || n.address_kind === 'staff') {
          // staff inboxes hold the notices they have a recipient row for, with that row's reason and cover
          for (const r of rows) for (const listener of this.#staff.get(r.account_id) ?? []) matches.push({ listener, row: inboxRow(n, r), rows });
        } else if (n.address_kind === 'seller' && n.seller_id) {
          for (const listener of this.#sellers.get(n.seller_id) ?? []) {
            if (sellerSees(listener.owner, n)) matches.push({ listener, row: inboxRow(n, rows.find((r) => r.account_id === listener.owner.accountId)), rows });
          }
        }
      }
      if (!matches.length) return;
      const routed = (m: (typeof matches)[number]) => m.listener.owner.kind === 'staff' && m.row.address_kind === 'role';
      const names = matches.some(routed) ? await this.deps.core.accounts([...new Set(matches.filter(routed).flatMap((m) => m.rows.map((r) => r.account_id)))]) : new Map<string, identity.AccountSummary>();
      const now = this.deps.core.now();
      for (const m of matches) {
        try {
          m.listener.push(noticeOf(m.row, now, routed(m) ? { recipients: m.rows, names } : undefined));
        } catch (err) {
          this.deps.core.log.warn({ err }, 'notifications: a live stream refused a notice');
        }
      }
    } catch (err) {
      // live delivery is a convenience on top of the saved inbox: never fail the send for it
      this.deps.core.log.error({ err }, 'notifications: live notices failed');
    }
  }
}

/** A notice as one person's inbox holds it, freshly created: their recipient row's reason and cover, not read */
const inboxRow = (n: NoticeRow, r: RecipientRow | undefined): InboxRow => ({ ...n, read_at: r?.read_at ?? null, archived_at: r?.archived_at ?? null, reason: r?.reason ?? null, covering_for: r?.covering_for ?? null });

/** The seller inbox rule (repository.ts #inboxBase): workspace notices of a topic the member receives, and notices to the member */
const sellerSees = (owner: LiveOwner, n: NoticeRow) =>
  owner.kind === 'seller' &&
  n.seller_id === owner.sellerId &&
  ((n.address_id === owner.sellerId && owner.topicKeys.includes(n.topic_key)) || n.address_id === `${owner.sellerId}/${owner.accountId}`);

/** Seller streams end with `max_age` after this, so the member's permissions and topics are read again on reconnect */
export const SELLER_STREAM_MAX_AGE_MS = 60 * 60_000;

/** The Last-Event-ID request header: the id of the last notice the client received */
export function lastEventIdOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  const h = headers['last-event-id'];
  return (Array.isArray(h) ? h[0] : h)?.trim() || undefined;
}
