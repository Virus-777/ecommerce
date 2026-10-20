/**
 * Seller statements. A statement takes every ledger entry that reached the seller's available money by the
 * cutoff (non-lot entries, and entries of lots no longer pending) and reconciles exactly:
 *   opening available (entries on earlier statements) + section totals − payout = closing available.
 * Issued at the payout cutoff and immutable afterwards; the current period is an open statement computed live.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import { csvCell } from '../../../kernel/lib/csv.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { FeeLine, Statement, StatementLine, StatementSection, StatementSummary } from '../../../spec/finance.js';
import { renderPdf, type PdfLine } from '../domain/pdf.js';
import { addDays, feeBasisNote, fmt, marketDate, sectionOf, SECTIONS, type EntryType, type SectionKey } from '../domain/rules.js';
import { statementMachine } from '../domain/state-machines.js';
import { reference, toStatementSummary } from '../mappers.js';
import type { AccountRec, EntryRec, LotRec, StatementRec } from '../ports.js';
import type { FinanceRepository } from '../repository.js';
import { notFound, Part } from './core.js';

export interface Prepared {
  id: string;
  ref: string;
  sellerId: string;
  period: common.DateRange;
  entryIds: string[];
  opening: number;
  /** Σ section totals and other lines (what reached available money in the period) */
  net: number;
  sections: StatementSection[];
  otherLines: FeeLine[];
  notices: string[];
  ruleVersion: string;
  existing: boolean;
}

interface StoredReconciliation {
  openingAvailable: common.Money;
  lines: FeeLine[];
  payout: common.Money;
  closingAvailable: common.Money;
  notices?: string[];
}

export class StatementsPart extends Part {
  /* ---------------------------------------------------------------- building */

  /** Sections and lines from ledger entries (held-bucket entries are already withheld: shown, not counted) */
  async build(entries: EntryRec[], repo: FinanceRepository = this.repo): Promise<{ sections: StatementSection[]; net: number; otherLines: FeeLine[]; notices: string[] }> {
    const cur = this.core.currency();
    const tz = this.core.tz();
    const lotIds = [...new Set(entries.map((e) => e.lot_id).filter((x): x is string => Boolean(x)))];
    const lots = lotIds.length ? await repo.getMany('earnings_lots', lotIds) : [];
    const charges = lots.length ? await repo.find('fee_charges', { order_item_id: lots.map((l) => l.order_item_id) }) : [];
    const basisOf = (lotId: string | null) => {
      const lot = lots.find((l) => l.id === lotId);
      const c = lot ? charges.find((x) => x.order_item_id === lot.order_item_id) : undefined;
      return c ? { basis: c.basis_amount, rate: c.rate_bps } : null;
    };
    const skus = await this.skusOf(lots);
    const byKey = new Map<SectionKey, { lines: StatementLine[]; total: number }>(SECTIONS.map((s) => [s.key, { lines: [], total: 0 }]));
    const otherLines: FeeLine[] = [];
    const notices: string[] = [];
    for (const e of entries) {
      const type = e.type as EntryType;
      if (type === 'payout') {
        otherLines.push({ label: `Payout ${e.ref_label ?? ''} sent outside a payout run`.replace('  ', ' '), amount: { amount: e.amount, currency: cur } });
        continue;
      }
      const key = sectionOf(type, e.ref_kind);
      if (!key) continue;
      if (e.bucket === 'held' && (type === 'hold' || type === 'hold_release')) continue; // the available side of the pair is the line
      const counted = e.bucket !== 'held';
      const sec = byKey.get(key)!;
      const fee = type === 'marketplace_fee' ? basisOf(e.lot_id) : null;
      sec.lines.push({
        date: marketDate(e.at, tz),
        reference: reference(e.ref_kind, e.ref_id, e.ref_label),
        sku: e.lot_id ? (skus.get(e.lot_id) ?? null) : null,
        description: e.description,
        detail: counted ? null : `${fmt(e.amount, cur)} taken from held earnings (already withheld)`,
        units: null,
        basis: fee ? { amount: fee.basis, currency: cur } : null,
        amount: { amount: counted ? e.amount : 0, currency: cur },
        reason: type === 'hold' || type === 'hold_release' || type === 'adjustment' ? e.description : null,
      });
      if (counted) sec.total += e.amount;
      if (type === 'refund_after_payout') notices.push(`${e.ref_label ?? 'An order'} was refunded after its earnings were paid out; the net amount was deducted here`);
    }
    const sections = SECTIONS.map((s): StatementSection => ({ key: s.key, title: s.title, subtitle: s.subtitle, lines: byKey.get(s.key)!.lines, total: { amount: byKey.get(s.key)!.total, currency: cur }, totalLabel: s.totalLabel }));
    const net = sections.reduce((x, s) => x + s.total.amount, 0) + otherLines.reduce((x, l) => x + l.amount.amount, 0);
    return { sections, net, otherLines, notices };
  }

  /**
   * Seller SKU per lot (G47a): the order item's offer snapshot, read from orders once per order. Orders that can't be
   * read leave their lines without a SKU.
   */
  async skusOf(lots: readonly LotRec[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const orderIds = [...new Set(lots.map((l) => l.order_id))];
    const skuByItem = new Map<string, string>();
    for (let i = 0; i < orderIds.length; i += 20) {
      const orders = await Promise.all(orderIds.slice(i, i + 20).map((id) => this.parts.ledger.order(id)));
      for (const o of orders) for (const item of o ? this.parts.ledger.itemsOf(o) : []) if (item.offer?.sellerSku) skuByItem.set(item.id, item.offer.sellerSku);
    }
    for (const l of lots) {
      const sku = skuByItem.get(l.order_item_id);
      if (sku) out.set(l.id, sku);
    }
    return out;
  }

  async nextRef(sellerId: string, periodTo: string): Promise<string> {
    const code = (await this.core.sellerInfo([sellerId])).get(sellerId)!.code.replace(/^SL-/, '');
    const prefix = `ST-${periodTo.slice(2, 4)}${periodTo.slice(5, 7)}-${code}-`;
    const n = (await this.repo.find('statements', { seller_id: sellerId, ref: { op: 'like', value: `${prefix}%` } })).length + 1;
    let ref = `${prefix}${String(n).padStart(2, '0')}`;
    for (let k = n + 1; await this.repo.findOne('statements', { ref }); k++) ref = `${prefix}${String(k).padStart(2, '0')}`;
    return ref;
  }

  async periodStart(sellerId: string, entries: EntryRec[], fallback: string): Promise<string> {
    const last = await this.repo.findOne('statements', { seller_id: sellerId, status: 'issued' }, { orderBy: [['period_to', 'desc']] });
    if (last) return addDays(last.period_to, 1);
    const first = entries.reduce<Date | null>((min, e) => (!min || e.at < min ? e.at : min), null);
    return first ? marketDate(first, this.core.tz()) : fallback;
  }

  /** Computes the statement a cutoff issues (outside any transaction); null when there is nothing to state */
  async prepare(sellerId: string, cutoff: Date, o: { final?: boolean } = {}): Promise<Prepared | null> {
    const entries = await this.repo.entriesForStatement(sellerId, cutoff);
    const opening = await this.repo.assignedAvailable(sellerId);
    if (!entries.length && opening <= 0 && !o.final) return null;
    const to = marketDate(cutoff, this.core.tz());
    let from = await this.periodStart(sellerId, entries, to);
    if (from > to) from = to;
    const built = await this.build(entries);
    const open = await this.repo.findOne('statements', { seller_id: sellerId, status: 'open' });
    const rule = await this.core.activeRule();
    return { id: open?.id ?? newId(), ref: open?.ref ?? (await this.nextRef(sellerId, to)), sellerId, period: { from, to }, entryIds: entries.map((e) => e.id), opening, net: built.net, sections: built.sections, otherLines: built.otherLines, notices: built.notices, ruleVersion: rule.version, existing: Boolean(open) };
  }

  /** Issues a prepared statement inside the run's transaction (only `tx` is used here) */
  async write(tx: FinanceRepository, p: Prepared, o: { payoutId: string | null; payout: number; unposted: number }) {
    const cur = this.core.currency();
    const lines: FeeLine[] = [...p.sections.map((s) => ({ label: s.title, amount: s.total })), ...p.otherLines];
    if (o.unposted) lines.push({ label: 'Earlier payouts not sent yet', amount: { amount: -o.unposted, currency: cur } });
    const sum = lines.reduce((x, l) => x + l.amount.amount, 0);
    const reconciliation: StoredReconciliation = { openingAvailable: { amount: p.opening, currency: cur }, lines, payout: { amount: o.payout, currency: cur }, closingAvailable: { amount: p.opening + sum - o.payout, currency: cur }, notices: p.notices };
    const row = { seller_id: p.sellerId, period_from: p.period.from, period_to: p.period.to, status: this.core.step(statementMachine, 'open', 'issue'), issued_at: this.now(), payout_id: o.payoutId, sections: p.sections as never, reconciliation: reconciliation as never, rule_version: p.ruleVersion };
    const existing = await tx.get('statements', p.id, { forUpdate: true });
    if (existing) {
      if (existing.status === 'issued') throw new AppError('CONFLICT', 'The statement was already issued');
      await tx.update('statements', p.id, row);
    } else await tx.insert('statements', { id: p.id, ref: p.ref, pdf_media_id: null, csv_media_id: null, ...row });
    if (p.entryIds.length) await tx.updateWhere('ledger_entries', { id: p.entryIds, statement_id: null }, { statement_id: p.id });
  }

  /** Final statement when a seller account closes (the last payout follows in a normal run) */
  async issueFinal(sellerId: string) {
    const p = await this.prepare(sellerId, this.now(), { final: true });
    if (!p) return;
    await this.repo.transaction((tx) => this.write(tx, p, { payoutId: null, payout: 0, unposted: 0 }));
    this.core.publish('finance.statement.issued', { statementId: p.id, sellerId, period: p.period, payoutId: null });
  }

  /**
   * Opens the current period's statement when the seller has none: at seller approval, after a statement is
   * issued (the next period) and from finance.payout-run.create for accounts that have none. Never on read.
   */
  async openStatement(sellerId: string): Promise<StatementRec | undefined> {
    const open = await this.repo.findOne('statements', { seller_id: sellerId, status: 'open' });
    if (open) return open;
    const today = this.core.today();
    const last = await this.repo.findOne('statements', { seller_id: sellerId, status: 'issued' }, { orderBy: [['period_to', 'desc']] });
    const from = last ? addDays(last.period_to, 1) : today;
    const id = newId();
    const rule = await this.core.activeRule();
    const cur = this.core.currency();
    await this.repo.insertIfAbsent('statements', { id, ref: await this.nextRef(sellerId, today), seller_id: sellerId, period_from: from, period_to: from <= today ? today : from, status: statementMachine.initial, issued_at: null, payout_id: null, sections: [] as never, reconciliation: { openingAvailable: { amount: 0, currency: cur }, lines: [], payout: { amount: 0, currency: cur }, closingAvailable: { amount: 0, currency: cur } } as never, rule_version: rule.version, pdf_media_id: null, csv_media_id: null });
    return this.repo.findOne('statements', { seller_id: sellerId, status: 'open' });
  }

  /** Part of finance.payout-run.create: seller accounts without an open statement get one (bounded batch per run, keyset by seller) */
  async openMissing(limit = 200): Promise<number> {
    let opened = 0;
    let after: string | null = null;
    for (;;) {
      const accounts: AccountRec[] = await this.repo.find('seller_accounts', after ? { seller_id: { op: '>', value: after } } : {}, { orderBy: [['seller_id', 'asc']], limit });
      if (!accounts.length) break;
      const withOpen = new Set((await this.repo.find('statements', { seller_id: accounts.map((a) => a.seller_id), status: 'open' })).map((s) => s.seller_id));
      for (const a of accounts) {
        if (withOpen.has(a.seller_id)) continue;
        try {
          if (await this.openStatement(a.seller_id)) opened++;
        } catch (err) {
          this.ctx.log.warn({ err, sellerId: a.seller_id }, 'finance: could not open a statement');
        }
      }
      if (accounts.length < limit) break;
      after = accounts.at(-1)!.seller_id;
    }
    return opened;
  }

  /* ---------------------------------------------------------------- views */

  async view(row: StatementRec): Promise<Statement> {
    const info = (await this.core.sellerInfo([row.seller_id])).get(row.seller_id)!;
    const cur = this.core.currency();
    let sections: StatementSection[];
    let rec: StoredReconciliation;
    let period = { from: row.period_from, to: row.period_to };
    if (row.status === 'open') {
      const entries = await this.repo.entriesForStatement(row.seller_id, this.now());
      const built = await this.build(entries);
      const opening = await this.repo.assignedAvailable(row.seller_id);
      const lines = [...built.sections.map((s) => ({ label: s.title, amount: s.total })), ...built.otherLines];
      sections = built.sections;
      rec = { openingAvailable: { amount: opening, currency: cur }, lines, payout: { amount: 0, currency: cur }, closingAvailable: { amount: opening + built.net, currency: cur }, notices: built.notices };
      period = { from: row.period_from, to: this.core.today() < row.period_from ? row.period_from : this.core.today() };
    } else {
      sections = (Array.isArray(row.sections) ? row.sections : []) as unknown as StatementSection[];
      rec = row.reconciliation as unknown as StoredReconciliation;
    }
    const payout = row.payout_id ? await this.repo.get('payouts', row.payout_id) : undefined;
    const ruleRow = (await this.repo.findOne('fee_rule_sets', { version: row.rule_version })) ?? (await this.core.activeRule());
    const rule = await this.core.ruleModel(ruleRow);
    const { notices, ...reconciliation } = rec;
    return {
      id: row.id,
      ref: row.ref,
      sellerId: row.seller_id,
      sellerName: info.name,
      sellerCode: info.code,
      period,
      status: row.status as Statement['status'],
      issuedAt: row.issued_at?.toISOString() ?? null,
      payout: payout ? (await this.parts.payouts.payoutViews([payout]))[0]! : null,
      sections,
      feeBasisNote: feeBasisNote(rule),
      reconciliation,
      afterPayoutNotices: notices ?? [],
      ruleVersion: row.rule_version,
    };
  }

  async summaries(rows: StatementRec[]): Promise<StatementSummary[]> {
    const payouts = new Map((await this.repo.getMany('payouts', rows.map((r) => r.payout_id).filter((x): x is string => Boolean(x)))).map((p) => [p.id, p]));
    return rows.map((r) => toStatementSummary(r, r.payout_id ? (payouts.get(r.payout_id) ?? null) : null));
  }

  async list(sellerId: string, page: PageRequest): Promise<common.Page<StatementSummary>> {
    const res = await this.repo.page('statements', { seller_id: sellerId }, page, { column: 'period_to', direction: 'desc' });
    return { ...res, items: await this.summaries(res.items) };
  }

  async listFull(sellerId: string, page: PageRequest): Promise<common.Page<Statement>> {
    const res = await this.repo.page('statements', { seller_id: sellerId }, page, { column: 'period_to', direction: 'desc' });
    return { ...res, items: await Promise.all(res.items.map((r) => this.view(r))) };
  }

  /** A statement by id or ref (ST-…, G46); a seller only reaches its own (others → 404) */
  async rowOf(idOrRef: string, sellerId?: string): Promise<StatementRec> {
    const key = idOrRef.trim();
    const byRef = async () => (await this.repo.findOne('statements', { ref: key })) ?? (await this.repo.findOne('statements', { ref: key.toUpperCase() }));
    const row = isUuid(key) ? await this.repo.get('statements', key) : /^ST-/i.test(key) ? await byRef() : undefined;
    if (!row || (sellerId && row.seller_id !== sellerId)) throw notFound('Statement');
    return row;
  }

  async get(idOrRef: string, sellerId?: string): Promise<Statement> {
    return this.view(await this.rowOf(idOrRef, sellerId));
  }

  async byRef(ref: string, sellerId?: string): Promise<Statement | null> {
    const row = await this.repo.findOne('statements', { ref });
    if (!row || (sellerId && row.seller_id !== sellerId)) return null;
    return this.view(row);
  }

  /* ---------------------------------------------------------------- download */

  async download(sellerId: string, idOrRef: string, format: 'pdf' | 'csv', principal: Principal): Promise<{ url: string; expiresAt: string }> {
    const row = await this.rowOf(idOrRef, sellerId);
    if (row.status !== 'issued') throw this.ctx.error('STATEMENT_NOT_READY', 'The statement period is still open');
    const media = this.ctx.tryUse('media');
    if (!media) throw new AppError('NOT_IMPLEMENTED', 'Statement files need the media module', { reason: 'module_off' });
    let assetId = format === 'pdf' ? row.pdf_media_id : row.csv_media_id;
    if (!assetId) {
      const st = await this.view(row);
      const fileName = `${st.ref}.${format}`;
      const bytes = format === 'pdf' ? renderPdf(this.pdfLines(st)) : new Uint8Array(Buffer.from(this.csv(st), 'utf8'));
      const asset = await media.storeGeneratedFile({ owner: { kind: 'seller', id: sellerId, label: st.sellerName }, fileName, contentType: format === 'pdf' ? 'application/pdf' : 'text/csv', body: new Blob([Buffer.from(bytes)]).stream() as never, purpose: 'statement' });
      assetId = asset.id;
      await this.repo.update('statements', row.id, format === 'pdf' ? { pdf_media_id: assetId } : { csv_media_id: assetId });
    }
    const link = await media.signedDownload(assetId, principal as never, 'Seller statement');
    return { url: link.url, expiresAt: link.expiresAt };
  }

  csv(st: Statement): string {
    // every cell quoted; text a spreadsheet would run as a formula (a seller's SKU…) is guarded (kernel csvCell)
    const q = (v: unknown) => csvCell(v, { quote: true });
    const rows = [['section', 'date', 'reference', 'sku', 'description', 'basis', 'amount'].join(',')];
    for (const s of st.sections) for (const l of s.lines) rows.push([s.key, l.date ?? '', l.reference?.ref ?? l.reference?.id ?? '', l.sku ?? '', l.description, l.basis ? (l.basis.amount / 100).toFixed(2) : '', (l.amount.amount / 100).toFixed(2)].map(q).join(','));
    rows.push(['payout', '', st.payout?.ref ?? '', '', 'Payout', '', (st.reconciliation.payout.amount / 100).toFixed(2)].map(q).join(','));
    return `${rows.join('\n')}\n`;
  }

  pdfLines(st: Statement): PdfLine[] {
    const cur = st.reconciliation.payout.currency;
    const lines: PdfLine[] = [
      { text: `Statement ${st.ref}`, bold: true, size: 14 },
      { text: `${st.sellerName} (${st.sellerCode}) · ${st.period.from} to ${st.period.to}` },
      { text: st.feeBasisNote },
    ];
    for (const s of st.sections) {
      lines.push({ text: `${s.title}: ${fmt(s.total.amount, cur)}`, bold: true, gap: 6 });
      for (const l of s.lines) lines.push({ text: `${l.date ?? ''}  ${l.reference?.ref ?? ''}  ${l.description}  ${fmt(l.amount.amount, cur)}` });
    }
    lines.push({ text: `Opening available ${fmt(st.reconciliation.openingAvailable.amount, cur)} · payout ${fmt(st.reconciliation.payout.amount, cur)} · closing available ${fmt(st.reconciliation.closingAvailable.amount, cur)}`, bold: true, gap: 8 });
    for (const n of st.afterPayoutNotices) lines.push({ text: n });
    return lines;
  }

}
