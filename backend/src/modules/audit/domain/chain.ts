/**
 * The tamper-evident hash chain (pure: no I/O).
 *
 *   hash = sha256(prev_hash || canonical row)
 *
 * The canonical row is a JSON text with sorted keys built from exactly the values stored in
 * audit.entries (and the entry's related targets in audit.entry_targets), so recomputing it from
 * what the database returns gives the same bytes. `seq` is not part of it: the chain order is the
 * prev_hash links, and seq only orders the walk (a reordered, removed or inserted row breaks a link).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** prev_hash of the first entry ever written */
export const GENESIS_HASH: Uint8Array = new Uint8Array(32);

export interface ChainTarget {
  type: string;
  id: string;
}

/** One entry exactly as stored (camelCase of the audit.entries columns plus its related targets). */
export interface ChainRow {
  id: string;
  seq?: number;
  at: Date;
  actorKind: string;
  actorId: string | null;
  actorName: string | null;
  actorRoles: unknown;
  action: string;
  actionLabel: string;
  module: string;
  category: string;
  targetType: string;
  targetId: string;
  targetRef: string | null;
  targetLabel: string | null;
  targetScreen: string | null;
  sellerId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  beforeText: string | null;
  afterText: string | null;
  evidence: unknown;
  approvalRequestId: string | null;
  approvalNote: string | null;
  requestId: string | null;
  ip: string | null;
  visibleToSeller: boolean;
  relatedTargets: ChainTarget[];
  prevHash: Uint8Array;
  hash: Uint8Array;
}

/** JSON with object keys sorted at every level; undefined becomes null (as it does in jsonb). */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  return JSON.stringify(value);
}

const byTarget = (a: ChainTarget, b: ChainTarget) => (a.type === b.type ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.type < b.type ? -1 : 1);

/** Related targets as stored: unique (type, id) pairs in a stable order (entry_targets has no position column). */
export function normalizeTargets(targets: readonly ChainTarget[]): ChainTarget[] {
  const seen = new Set<string>();
  const out: ChainTarget[] = [];
  for (const t of targets) {
    const key = `${t.type}\u0000${t.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: t.type, id: t.id });
  }
  return out.sort(byTarget);
}

/** The canonical text of a row (version 1). */
export function canonicalRow(r: Omit<ChainRow, 'hash' | 'prevHash' | 'seq'>): string {
  return canonicalJson({
    v: 1,
    id: r.id,
    at: r.at.toISOString(),
    actor: { kind: r.actorKind, id: r.actorId, name: r.actorName },
    actorRoles: r.actorRoles,
    action: r.action,
    actionLabel: r.actionLabel,
    module: r.module,
    category: r.category,
    target: { type: r.targetType, id: r.targetId, ref: r.targetRef, label: r.targetLabel, screen: r.targetScreen },
    sellerId: r.sellerId,
    relatedTargets: normalizeTargets(r.relatedTargets),
    reason: r.reason,
    before: r.before,
    after: r.after,
    beforeText: r.beforeText,
    afterText: r.afterText,
    evidence: r.evidence,
    approvalRequestId: r.approvalRequestId,
    approvalNote: r.approvalNote,
    requestId: r.requestId,
    ip: r.ip,
    visibleToSeller: r.visibleToSeller,
  });
}

export function hashRow(prevHash: Uint8Array, row: Omit<ChainRow, 'hash' | 'prevHash' | 'seq'>): Uint8Array {
  return new Uint8Array(createHash('sha256').update(prevHash).update(canonicalRow(row), 'utf8').digest());
}

export const sameBytes = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean =>
  !!a && !!b && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));

/** Derivation label of the checkpoint key: secretFor(config, CHECKPOINT_PURPOSE) */
export const CHECKPOINT_PURPOSE = 'audit.checkpoint';
/** Stored with each checkpoint so a rotated key can be told apart */
export const CHECKPOINT_KEY_ID = 'audit.checkpoint.v1';

/** hex HMAC-SHA256 over seq (decimal text, then a 0 byte) and the entry hash */
export function checkpointMac(key: string, seq: number, hash: Uint8Array): string {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(`${seq}\u0000`, 'utf8').update(hash).digest('hex');
}

/** Constant-time check of a stored checkpoint's mac */
export function checkpointMacOk(key: string, c: { seq: number; hash: Uint8Array; mac: string }): boolean {
  const want = Buffer.from(checkpointMac(key, c.seq, c.hash), 'hex');
  const got = /^[0-9a-f]+$/i.test(c.mac) ? Buffer.from(c.mac, 'hex') : Buffer.alloc(0);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A purge checkpoint: the last removed entry, so the first kept entry's prev_hash still verifies. */
export interface Checkpoint {
  seq: number;
  hash: string;
}

export type LinkProblem = 'prev_hash' | 'hash';

/**
 * Walks rows in seq order. `expectedPrev` is the hash the first row must link to; `firstLink`
 * decides the link of the very first row of the chain when there is no expected value
 * (genesis, or a purge checkpoint).
 */
export function verifyRows(
  rows: readonly ChainRow[],
  expectedPrev: Uint8Array | undefined,
  firstLink: (row: ChainRow) => boolean,
): { ok: true; lastHash: Uint8Array | undefined; lastSeq: number | undefined } | { ok: false; brokenAtSeq: number; problem: LinkProblem } {
  let prev = expectedPrev;
  let lastSeq: number | undefined;
  for (const row of rows) {
    const linked = prev === undefined ? firstLink(row) : sameBytes(row.prevHash, prev);
    if (!linked) return { ok: false, brokenAtSeq: row.seq!, problem: 'prev_hash' };
    if (!sameBytes(hashRow(row.prevHash, row), row.hash)) return { ok: false, brokenAtSeq: row.seq!, problem: 'hash' };
    prev = row.hash;
    lastSeq = row.seq;
  }
  return { ok: true, lastHash: prev, lastSeq };
}
