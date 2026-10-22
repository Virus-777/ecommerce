/**
 * Pure Play center rules: player IDs, server keys, prize weeks in the market time zone, prize tier ranks, the ranking
 * of posted scores and rating summaries. No I/O.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { addCalendarDays } from '../../../kernel/lib/dates.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';

/* ------------------------------------------------------------------ player IDs and keys */

/** Letters and digits a person can't misread (no 0/O, 1/I/L, U) */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A new player ID: MK-XXXX-XXXX */
export function newPlayerCode(): string {
  const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!;
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `MK-${part()}-${part()}`;
}

/** The way a customer may type a player ID: any case, spaces or no dashes ("mk 7f3k92qd" → MK-7F3K-92QD) */
export function normalizePlayerCode(input: string | null | undefined): string | null {
  const raw = String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith('MK') ? raw.slice(2) : raw;
  if (body.length !== 8) return null;
  return `MK-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** A new server key: a prefix that names it plus 32 random bytes (base64url) */
export const newServerKey = (): string => `mkg_${randomBytes(32).toString('base64url')}`;
/** How a server key is kept: its SHA-256 (the key is random, so a fast hash is enough) */
export const hashServerKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');
/** The last characters staff see to tell keys apart */
export const keyHint = (key: string): string => `…${key.slice(-4)}`;

/* ------------------------------------------------------------------ prize weeks */

export interface WeekInfo {
  /** Monday, market time (YYYY-MM-DD) */
  startsOn: string;
  /** Sunday */
  endsOn: string;
  /** Midnight starting Monday, market time */
  startsAt: Date;
  /** Midnight after Sunday, market time */
  endsAt: Date;
  /** "Ends Sun, Oct 25" */
  endsLabel: string;
}

/** Monday of the week a market day falls in */
export function mondayOf(day: string): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 Sunday … 6 Saturday
  return addCalendarDays(day, -((dow + 6) % 7));
}

const LABEL = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
/** "Sun, Oct 25" for a calendar day */
export const dayLabel = (day: string): string => LABEL.format(new Date(`${day}T12:00:00Z`));

/** The prize week (Monday–Sunday) that starts on a Monday */
export function weekStarting(monday: string, timeZone: string): WeekInfo {
  const endsOn = addCalendarDays(monday, 6);
  return { startsOn: monday, endsOn, startsAt: zonedTimeToUtc(monday, '00:00', timeZone), endsAt: zonedTimeToUtc(addCalendarDays(monday, 7), '00:00', timeZone), endsLabel: `Ends ${dayLabel(endsOn)}` };
}

/** The prize week an instant falls in */
export const weekOf = (at: Date, timeZone: string): WeekInfo => weekStarting(mondayOf(dateInZone(at, timeZone)), timeZone);

/* ------------------------------------------------------------------ prize tiers */

export interface PrizeTier {
  ranks: string;
  reward: string;
  fromRank: number | null;
  toRank: number | null;
  campaignId: string | null;
}

/** "#1" → [1, 1], "#2–3" / "#2-3" / "2 to 3" → [2, 3]; null when it names no ranks */
export function parseRanks(label: string | null | undefined): [number, number] | null {
  const nums = String(label ?? '').match(/\d+/g)?.map(Number) ?? [];
  if (!nums.length || nums.length > 2) return null;
  const [a, b = a] = nums as [number, number?];
  return a >= 1 && b! >= a ? [a, b!] : null;
}

/** "#1" or "#4–10" */
export const ranksLabel = (from: number, to: number): string => (from === to ? `#${from}` : `#${from}–${to}`);

/** The tier a rank falls in, if any */
export const tierFor = <T extends { fromRank: number | null; toRank: number | null }>(tiers: readonly T[], rank: number): T | undefined =>
  tiers.find((t) => t.fromRank !== null && t.toRank !== null && rank >= t.fromRank && rank <= t.toRank);

/* ------------------------------------------------------------------ rankings from scores */

/** One player's best in a period, as the scores aggregation answers it */
export interface PlayerBest {
  customerId: string;
  score: number;
  /** when the player first reached that score (ties go to the earlier one) */
  at: Date;
}

/** Best first; equal scores rank by who reached them first. Ranks 1, 2, 3… */
export function rankBests<T extends PlayerBest>(rows: readonly T[]): (T & { rank: number })[] {
  return [...rows].sort((a, b) => b.score - a.score || a.at.getTime() - b.at.getTime() || (a.customerId < b.customerId ? -1 : 1)).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Points a score needs to reach the top N of a ranked table; null when it is already in it (or the table is shorter) */
export function pointsToTop(ranked: readonly { score: number; rank: number; customerId: string }[], customerId: string, top = 100): number | null {
  const me = ranked.find((r) => r.customerId === customerId);
  if (!me || me.rank <= top) return null;
  const last = ranked[top - 1];
  return last ? last.score - me.score + 1 : null;
}

/** "12.4k playing this week" */
export function playersLabel(players: number): string | null {
  if (players <= 0) return null;
  const n = players >= 1000 ? `${(Math.round(players / 100) / 10).toLocaleString('en-US')}k` : String(players);
  return `${n} playing this week`;
}

/* ------------------------------------------------------------------ ratings */

/** Average to one decimal (null without reviews) and counts for 5, 4, 3, 2 and 1 stars */
export function ratingSummary(counts: ReadonlyMap<number, number> | undefined): { average: number | null; count: number; stars: number[] } {
  const stars = [5, 4, 3, 2, 1].map((s) => counts?.get(s) ?? 0);
  const count = stars.reduce((a, b) => a + b, 0);
  const sum = stars.reduce((a, n, i) => a + n * (5 - i), 0);
  return { average: count ? Math.round((sum / count) * 10) / 10 : null, count, stars };
}
