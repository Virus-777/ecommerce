/**
 * What the checkout service needs from the outside world, database-agnostic.
 * The MongoDB adapter is repository.ts.
 */
import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import type { CheckoutDb } from '../../spec/checkout.js';
import type * as common from '../../spec/common.js';

/* ================================================================ sales tax provider */

/** One taxable line: the item amount after discounts, in minor units */
export interface TaxLineInput {
  lineId: string;
  /** Item amount after discounts (shipping is not taxed at launch) */
  amount: number;
  quantity: number;
  offerId: string;
  /** Product category, for providers with category rules */
  categoryId?: string | null;
}

/** Tax of one line with the rate and jurisdiction that produced it */
export interface TaxLineAmount {
  lineId: string;
  amount: number;
  rate: number;
  jurisdiction: string;
}

/** The tax shown at checkout for a destination: one summary line plus the amount per line */
export interface TaxCalculation {
  jurisdiction: string;
  label: string;
  rate: number;
  lines: TaxLineAmount[];
}

/**
 * Sales tax per line for a destination (spec integration "Sales tax rates": a rate table at launch, a tax
 * service later). null when there is no destination yet (the quote then shows "calculated once you enter a
 * delivery address"). Deterministic dev adapter: providers/tax.ts.
 */
export interface TaxProvider {
  calculate(input: { destination: common.Address | null; currency: string; lines: TaxLineInput[] }): Promise<TaxCalculation | null>;
}

export type SessionRow = CheckoutDb['sessions'];
export type LineRow = CheckoutDb['session_lines'];
export type PackageRow = CheckoutDb['session_packages'];
export type ChangeSetRow = CheckoutDb['change_sets'];
export type PlaceRequestRow = CheckoutDb['place_requests'];
export type LogRow = CheckoutDb['session_log'];

/** Whose checkout: a customer (customers' id) or a visitor (guest) session */
export type Owner = { customerId: string; guestSessionId?: undefined } | { guestSessionId: string; customerId?: undefined };

export interface Lock {
  forUpdate?: boolean;
}

export interface AdminSessionFilter {
  statuses?: string[];
  q?: string;
  from?: Date;
  to?: Date;
}

/** Persistence for this module's own tables: checkout.sessions, checkout.session_lines, checkout.session_packages, checkout.change_sets, checkout.place_requests, checkout.session_log. */
export interface CheckoutRepository {
  /** Runs fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: CheckoutRepository) => Promise<T>): Promise<T>;

  /* ---------------------------------------------------------------- sessions */
  insertSession(row: SessionRow): Promise<SessionRow>;
  /** Any session (consumers, jobs, staff) */
  getSession(id: string, lock?: Lock): Promise<SessionRow | undefined>;
  /** The owner's session; another shopper's session is simply not found */
  getOwnSession(owner: Owner, id: string, lock?: Lock): Promise<SessionRow | undefined>;
  updateSession(id: string, patch: Partial<SessionRow>): Promise<SessionRow>;
  findSessionByOrder(orderId: string): Promise<SessionRow | undefined>;
  /** Open guest sessions of a visitor session (claimed at sign-in) */
  listGuestSessions(guestSessionId: string, statuses: string[]): Promise<SessionRow[]>;
  /** Idle open sessions and failed ones past their retry window */
  listExpirable(now: Date, limit: number): Promise<SessionRow[]>;
  listByStatus(statuses: string[], limit: number): Promise<SessionRow[]>;
  listSessionsAdmin(filter: AdminSessionFilter, page: PageRequest): Promise<Page<SessionRow>>;

  /* ---------------------------------------------------------------- lines and packages */
  listLines(sessionId: string): Promise<LineRow[]>;
  listPackages(sessionId: string): Promise<PackageRow[]>;
  /** Replaces every line and package of the session */
  replaceLinesAndPackages(sessionId: string, lines: LineRow[], packages: PackageRow[]): Promise<void>;

  /* ---------------------------------------------------------------- change sets */
  insertChangeSet(row: ChangeSetRow): Promise<ChangeSetRow>;
  getChangeSet(sessionId: string, id: string, lock?: Lock): Promise<ChangeSetRow | undefined>;
  latestChangeSet(sessionId: string): Promise<ChangeSetRow | undefined>;
  openChangeSet(sessionId: string): Promise<ChangeSetRow | undefined>;
  listChangeSets(sessionId: string): Promise<ChangeSetRow[]>;
  updateChangeSet(id: string, patch: Partial<ChangeSetRow>): Promise<ChangeSetRow>;
  /** Marks every open change set of the session superseded */
  supersedeOpenChangeSets(sessionId: string): Promise<void>;

  /* ---------------------------------------------------------------- place requests */
  getPlaceRequest(sessionId: string, key: string): Promise<PlaceRequestRow | undefined>;
  /** undefined when the (session, key) pair already exists */
  insertPlaceRequest(row: PlaceRequestRow): Promise<PlaceRequestRow | undefined>;
  updatePlaceRequest(id: string, patch: Partial<PlaceRequestRow>): Promise<PlaceRequestRow>;
  deletePlaceRequest(id: string): Promise<void>;
  listPlaceRequests(sessionId: string): Promise<PlaceRequestRow[]>;
  latestPlaceRequest(sessionId: string): Promise<PlaceRequestRow | undefined>;
  purgePlaceRequests(before: Date): Promise<number>;

  /* ---------------------------------------------------------------- log */
  log(row: LogRow): Promise<void>;
  listLog(sessionId: string): Promise<LogRow[]>;
  countLog(sessionId: string, label: string, since: Date): Promise<number>;
}
