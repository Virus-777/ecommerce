/**
 * Bulk price (and seller quantity and unit cost) files: template, upload and parse into a preview, apply the ready
 * rows (seller quantities through inventory, seller unit costs effective the day they are applied; Official Store
 * rows above the caller's limit become approval requests), correction report, expiry. Nothing changes until apply.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as identity from '../../../spec/identity.js';
import type { BulkRowError, BulkUpdateJob, BulkUpdateTotals, FileLink, StockCue } from '../../../spec/offers.js';
import { changePct, formatMoney, parseCsv, parsePrice, toCsv } from '../domain/rules.js';
import { bulkUpdateJobMachine } from '../domain/state-machines.js';
import { actorFromText, actorText, bulkJob, bulkReasonOf, bulkRow, EMPTY_TOTALS, isoReq, money, totalsOf } from '../mappers.js';
import type { BulkJobRec, BulkRowRec, CostRec, OfferRec } from '../ports.js';
import { invalidField, notFound, Part, SYSTEM, type By } from './core.js';
import type { CurrentCost } from './costs.js';

type Owner = { ownerType: 'seller'; sellerId: string } | { ownerType: 'official'; sellerId: null };

export class BulkPart extends Part {
  private media() {
    const m = this.ctx.tryUse('media');
    if (!m) throw new AppError('SERVICE_UNAVAILABLE', 'File storage is unavailable right now');
    return m;
  }

  private principalOf(by: By, owner: Owner): identity.Principal {
    if (by.principal) return by.principal as identity.Principal;
    return owner.ownerType === 'seller' ? { kind: 'seller', accountId: by.actor.id ?? null, sellerId: owner.sellerId } : { kind: 'staff', accountId: by.actor.id ?? null };
  }

  private async fileLink(owner: Owner, fileName: string, csv: string, purpose: 'export' | 'correction_report', by: By): Promise<{ link: FileLink; assetId: string }> {
    const media = this.media();
    const asset = await media.storeGeneratedFile({
      owner: owner.ownerType === 'seller' ? { kind: 'seller', id: owner.sellerId } : { kind: 'platform', id: null },
      fileName,
      contentType: 'text/csv',
      body: new Response(csv).body as never,
      ttlHours: 24,
      purpose,
    });
    const link = await media.signedDownload(asset.id, this.principalOf(by, owner));
    return { link: { url: link.url, fileName: link.fileName || fileName, expiresAt: link.expiresAt }, assetId: asset.id };
  }

  /* ================================================================ template */

  async template(sellerId: string, by: By): Promise<FileLink> {
    const rows = await this.repo.allOffers({ ownerType: 'seller', sellerId, excludeStatuses: ['removed'] }, 10_000);
    const [stock, costs] = await Promise.all([this.parts.views.stock(rows, sellerId), this.parts.costs.current(rows.map((r) => r.id))]);
    // unit_cost: the cost in force today, empty when none is set (an empty cell keeps the cost as it is)
    const cost = (id: string) => {
      const c = costs.get(id);
      return c ? (c.unitCost.amount / 100).toFixed(2) : '';
    };
    const csv = toCsv([['seller_sku', 'price', 'quantity', 'unit_cost'], ...rows.map((r) => [r.seller_sku, (r.price_amount / 100).toFixed(2), stock.get(r.id)?.available ?? 0, cost(r.id)])]);
    return (await this.fileLink({ ownerType: 'seller', sellerId }, `offers-${this.core.today()}.csv`, csv, 'export', by)).link;
  }

  /* ================================================================ upload and preview */

  async create(owner: Owner, fileId: string, by: By, reason?: string): Promise<BulkUpdateJob> {
    if (owner.ownerType === 'official' && !reason?.trim()) throw invalidField('reason', 'Give the reason for the price file');
    if (!isUuid(fileId)) throw this.core.error('BULK_FILE_INVALID', 'Upload the file first', { issues: [{ path: 'fileId', message: 'not an uploaded file' }] });
    this.media();
    const file = await this.ctx.tryUse('media')!.getAsset(fileId);
    if (!file || (owner.ownerType === 'seller' && (file.owner.kind !== 'seller' || file.owner.id !== owner.sellerId))) {
      throw this.core.error('BULK_FILE_INVALID', 'File not found', { issues: [{ path: 'fileId', message: 'unknown file' }] });
    }
    const now = this.now();
    const hours = Number(await this.core.setting('bulkPreviewHours')) || 24;
    const job = await this.repo.insert('bulk_update_jobs', {
      id: newId(),
      owner_type: owner.ownerType,
      seller_id: owner.sellerId,
      file_media_id: fileId,
      file_name: file.fileName,
      state: 'uploaded',
      totals: { ...EMPTY_TOTALS, ...(reason ? { reason: reason.trim() } : {}) } as never,
      report_media_id: null,
      uploaded_by: actorText(by.actor),
      uploaded_at: now,
      applied_by: null,
      applied_at: null,
      expires_at: new Date(now.getTime() + hours * 3_600_000),
      failure: null,
    });
    const parsed = await this.parse(job, by);
    if (parsed.state === 'failed') throw this.core.error('BULK_FILE_INVALID', parsed.failure ?? 'The file could not be read', { jobId: parsed.id, issues: [{ path: 'fileId', message: parsed.failure ?? 'unreadable' }] });
    if (owner.ownerType === 'official') {
      await this.core.audit({ action: 'offers.official.bulk_upload', actionLabel: 'Uploaded an Official Store price file', category: 'catalog', target: { type: 'bulk_update', id: job.id, label: file.fileName }, reason: reason ?? null, after: totalsOf(parsed) }, by);
    }
    return bulkJob(parsed);
  }

  /** uploaded → preview_ready (or failed): validates every row, changes nothing */
  async parse(job: BulkJobRec, by?: By): Promise<BulkJobRec> {
    const owner: Owner = job.owner_type === 'seller' ? { ownerType: 'seller', sellerId: job.seller_id! } : { ownerType: 'official', sellerId: null };
    const actor = actorFromText(job.uploaded_by) ?? SYSTEM;
    const fail = async (failure: string) => this.repo.update('bulk_update_jobs', job.id, { state: bulkUpdateJobMachine.next('uploaded', 'fail'), failure });
    let text: string;
    try {
      const file = await this.core.files.read(job.file_media_id, this.principalOf(by ?? { actor }, owner));
      if (!file) return fail('The file is no longer available');
      text = file.text;
    } catch (err) {
      this.ctx.log.warn({ err, jobId: job.id }, 'offers: bulk file could not be read');
      return fail('The file could not be read');
    }
    const table = parseCsv(text);
    if (!table.length) return fail('The file is empty');
    const header = table[0]!.map((h) => h.trim().toLowerCase());
    const skuCol = header.findIndex((h) => h === 'seller_sku' || h === 'sku');
    const priceCol = header.indexOf('price');
    const qtyCol = header.indexOf('quantity');
    const costCol = header.indexOf('unit_cost');
    if (skuCol < 0) return fail(`The first row must name the columns: ${owner.ownerType === 'seller' ? 'seller_sku, price, quantity' : 'sku, price'}`);
    if (owner.ownerType === 'official' && qtyCol >= 0) return fail('Quantities are not accepted in Official Store price files; company stock changes go through inventory adjustments');
    // unit costs are the seller's own (the Official Store's buying cost comes from inventory)
    if (owner.ownerType === 'official' && costCol >= 0) return fail('Unit costs are not accepted in Official Store price files');
    if (priceCol < 0 && qtyCol < 0 && costCol < 0) return fail('The file needs a price, a quantity or a unit_cost column');
    const max = Number(await this.core.setting('bulkMaxRows')) || 5000;
    const data = table.slice(1);
    if (data.length > max) return fail(`The file has ${data.length} rows; the limit is ${max}`);

    const offers = await this.repo.allOffers({ ownerType: owner.ownerType, ...(owner.sellerId ? { sellerId: owner.sellerId } : {}) }, 50_000);
    const bySku = new Map(offers.map((o) => [o.seller_sku.toLowerCase(), o]));
    // stock and categories only of the offers the file names (not of every offer the owner has)
    const named = [...new Set(data.flatMap((cells) => bySku.get((cells[skuCol] ?? '').trim().toLowerCase()) ?? []))];
    const [stock, products, minSetting, costs] = await Promise.all([
      owner.ownerType === 'seller' ? this.parts.views.stock(named.filter((o) => o.status !== 'removed'), owner.sellerId) : new Map<string, StockCue>(),
      this.core.products(named.map((o) => o.product_id)),
      this.core.setting('minimumPriceByCategory'),
      costCol >= 0 ? this.parts.costs.current(named.map((o) => o.id)) : new Map<string, CurrentCost>(),
    ]);
    const mins = (minSetting ?? {}) as Record<string, number>;
    const seen = new Set<string>();
    const rows: BulkRowRec[] = [];
    const totals: BulkUpdateTotals = { ...EMPTY_TOTALS, rows: data.length };
    data.forEach((cells, i) => {
      const sku = (cells[skuCol] ?? '').trim();
      const offer = bySku.get(sku.toLowerCase());
      const rawPrice = priceCol >= 0 ? (cells[priceCol] ?? '').trim() : '';
      const rawQty = qtyCol >= 0 ? (cells[qtyCol] ?? '').trim() : '';
      const rawCost = costCol >= 0 ? (cells[costCol] ?? '').trim() : '';
      const row: BulkRowRec = {
        job_id: job.id,
        row_no: i + 2,
        seller_sku: sku,
        offer_id: offer?.id ?? null,
        price_from: offer ? Number(offer.price_amount) : null,
        price_to: null,
        qty_from: offer ? (stock.get(offer.id)?.available ?? null) : null,
        qty_to: null,
        cost_from: offer ? (costs.get(offer.id)?.unitCost.amount ?? null) : null,
        cost_to: null,
        result: 'ready',
        error_code: null,
        error_message: null,
      };
      const error = (code: BulkRowError['code'], message: string) => {
        row.result = 'error';
        row.error_code = code;
        row.error_message = message;
      };
      if (!sku || !offer) error('unknown_sku', sku ? `SKU ${sku} is not one of your offers. Check the spelling or create the offer first.` : 'The SKU is empty.');
      else if (seen.has(sku.toLowerCase())) error('duplicate_row', `SKU ${sku} appears more than once; keep one row per SKU.`);
      else if (offer.status === 'removed') error('offer_removed', `The offer for ${sku} was removed; it cannot be updated.`);
      else if (!rawPrice && !rawQty && !rawCost) error('price_missing', costCol >= 0 ? 'Enter a price, a quantity or a unit cost.' : 'Enter a price, a quantity or both.');
      else {
        if (rawPrice) {
          const p = parsePrice(rawPrice);
          const min = Number(mins[products.get(offer.product_id)?.product.categoryId ?? ''] ?? 0);
          if (p === null) error('not_a_number', `Price "${rawPrice}" is not a number, e.g. 24.00.`);
          else if (p <= 0) error('price_missing', 'The price must be above zero.');
          else if (min > 0 && p < min) error('price_below_minimum', `Price ${formatMoney(money(p, offer.currency))} is below the ${formatMoney(money(min, offer.currency))} minimum for this category.${p * 10 >= min ? ` Did you mean ${formatMoney(money(p * 10, offer.currency))}?` : ''}`);
          else row.price_to = p;
        }
        if (row.result === 'ready' && rawQty) {
          if (!/^-?\d+$/.test(rawQty)) error('not_a_number', `Quantity "${rawQty}" is not a whole number.`);
          else if (Number(rawQty) < 0) error('negative_quantity', 'Quantity cannot be negative; enter 0 for out of stock.');
          else row.qty_to = Number(rawQty);
        }
        if (row.result === 'ready' && rawCost) {
          const c = parsePrice(rawCost);
          if (rawCost.startsWith('-')) error('unit_cost_invalid', 'The unit cost cannot be negative; enter 0 for an item that costs you nothing.');
          else if (c === null) error('not_a_number', `Unit cost "${rawCost}" is not a number, e.g. 12.50.`);
          else row.cost_to = c;
        }
      }
      if (sku) seen.add(sku.toLowerCase());
      if (row.result === 'ready') {
        const priceChange = row.price_to !== null && row.price_to !== row.price_from;
        const stockChange = row.qty_to !== null && row.qty_to !== row.qty_from;
        const costChange = row.cost_to !== null && row.cost_to !== row.cost_from;
        if (!priceChange && !stockChange && !costChange) row.result = 'unchanged';
        else {
          if (priceChange) totals.priceChanges++;
          if (stockChange) totals.stockChanges++;
          if (costChange) totals.costChanges++;
          if (!priceChange) row.price_to = null;
          if (!stockChange) row.qty_to = null;
          if (!costChange) row.cost_to = null;
        }
      }
      totals[row.result === 'error' ? 'errors' : row.result === 'unchanged' ? 'unchanged' : 'ready']++;
      rows.push(row);
    });
    await this.repo.insertMany('bulk_update_rows', rows);
    const reason = bulkReasonOf(job);
    return this.repo.update('bulk_update_jobs', job.id, { state: bulkUpdateJobMachine.next('uploaded', 'parse'), totals: { ...totals, ...(reason ? { reason } : {}) } as never });
  }

  /* ================================================================ apply */

  async apply(owner: Owner, id: string, by: By, o: { confirmLargeChanges?: boolean } = {}): Promise<BulkUpdateJob> {
    const job = await this.jobOf(owner, id);
    if (job.state === 'preview_ready' && job.expires_at <= this.now()) {
      await this.repo.update('bulk_update_jobs', job.id, { state: bulkUpdateJobMachine.next('preview_ready', 'expire') });
      throw this.core.error('BULK_JOB_EXPIRED', 'The preview is older than the allowed window; upload the file again', { expiresAt: isoReq(job.expires_at) });
    }
    bulkUpdateJobMachine.next(job.state as never, 'apply'); // ILLEGAL_TRANSITION
    const ready = await this.repo.find('bulk_update_rows', { job_id: job.id, result: 'ready' }, { orderBy: [['row_no', 'asc']] });
    const offers = new Map((await this.repo.getMany('offers', ready.map((r) => r.offer_id).filter((x): x is string => Boolean(x)))).map((r) => [r.id, r]));
    if (owner.ownerType === 'seller' && !o.confirmLargeChanges) {
      const threshold = await this.parts.pricing.largeThreshold();
      const largeNos = await this.largeRows(owner, ready, [...offers.values()]);
      const large = ready.filter((r) => largeNos.has(r.row_no));
      if (large.length) {
        throw this.core.error('LARGE_PRICE_CHANGE_UNCONFIRMED', `${large.length} row${large.length === 1 ? '' : 's'} change the price by more than ${threshold}%. Confirm large changes to apply them.`, {
          offers: large.map((r) => ({ offerId: r.offer_id, row: r.row_no, from: money(r.price_from!, this.core.currency), to: money(r.price_to!, this.core.currency), changePct: changePct(r.price_from!, r.price_to!) })),
        });
      }
    }
    // unit costs need their own permission: updating prices and stock does not let a member set costs
    if (ready.some((r) => r.cost_to != null) && !(by.principal && (await this.ctx.can(by.principal, 'offers.costs.manage')))) {
      throw new AppError('FORBIDDEN', 'This file changes unit costs, which needs the permission to manage unit costs. Remove the unit_cost column or ask the account owner.');
    }
    const started = await this.repo.transaction(async (tx) => {
      const locked = (await tx.get('bulk_update_jobs', job.id, { forUpdate: true }))!;
      const state = bulkUpdateJobMachine.next(locked.state as never, 'apply');
      return tx.update('bulk_update_jobs', job.id, { state });
    });
    const totals = totalsOf(started);
    totals.applied = 0;
    totals.skipped = 0;
    totals.pendingApproval = 0;
    const qtyRows: { row: BulkRowRec; stockItemId: string; newAvailable: number }[] = [];
    const costRows: CostRec[] = [];
    try {
      for (const r of ready) {
        const offer = offers.get(r.offer_id!);
        if (!offer || offer.status === 'removed') {
          await this.repo.updateBulkRow(job.id, r.row_no, { result: 'skipped', error_code: 'offer_removed', error_message: 'The offer was removed after the preview.' });
          totals.skipped++;
          continue;
        }
        let result: 'applied' | 'pending_approval' | 'skipped' = 'applied';
        if (r.price_to !== null) {
          try {
            if (owner.ownerType === 'seller') {
              await this.parts.pricing.changeSellerPrice(offer, { price: money(r.price_to, offer.currency) }, by, { confirmLarge: true, source: 'seller_bulk', bulkJobId: job.id });
            } else {
              const change = await this.parts.pricing.requestOfficial(offer.id, { price: money(r.price_to, offer.currency), reason: bulkReasonOf(job) ?? `Price file ${job.file_name}` }, by, { source: 'official_bulk', bulkJobId: job.id });
              if (change.state === 'pending_approval') result = 'pending_approval';
            }
          } catch (err) {
            if (!isAppError(err) || err.status >= 500) throw err;
            const code: BulkRowError['code'] = err.code === 'PRICE_BELOW_MINIMUM' ? 'price_below_minimum' : err.code === 'FORBIDDEN' ? 'price_change_too_large' : 'price_missing';
            await this.repo.updateBulkRow(job.id, r.row_no, { result: 'skipped', error_code: code, error_message: err.message });
            totals.skipped++;
            continue;
          }
        }
        // effective the day the file is applied; saved together after the loop
        if (r.cost_to != null && owner.ownerType === 'seller') costRows.push(this.parts.costs.bulkRow(offer, r.cost_to, by));
        if (r.qty_to !== null) qtyRows.push({ row: r, stockItemId: offer.stock_item_id, newAvailable: r.qty_to });
        if (r.qty_to === null || r.price_to !== null) {
          await this.repo.updateBulkRow(job.id, r.row_no, { result });
          if (result === 'pending_approval') totals.pendingApproval++;
          else if (r.qty_to === null) totals.applied++;
        }
      }
      await this.parts.costs.save(costRows, by);
      if (qtyRows.length && owner.ownerType === 'seller') {
        const res = await this.ctx.use('inventory').applyBulkQuantities(owner.sellerId, qtyRows.map((q) => ({ stockItemId: q.stockItemId, newAvailable: q.newAvailable })), job.id, by.actor);
        // the first answer per stock item
        const answers = new Map<string, (typeof res)[number]>();
        for (const x of res) if (!answers.has(x.stockItemId)) answers.set(x.stockItemId, x);
        const applied: number[] = [];
        for (const q of qtyRows) {
          const out = answers.get(q.stockItemId);
          if (out?.ok) applied.push(q.row.row_no);
          else {
            await this.repo.updateBulkRow(job.id, q.row.row_no, { result: 'skipped', error_code: 'negative_quantity', error_message: out?.error ?? 'The quantity could not be set' });
            totals.skipped++;
          }
        }
        await this.repo.markBulkRows(job.id, applied, { result: 'applied' });
        totals.applied += applied.length;
      }
    } catch (err) {
      await this.repo.update('bulk_update_jobs', job.id, { state: bulkUpdateJobMachine.next('applying', 'fail'), failure: 'Applying stopped on an unexpected error; rows already applied stay applied', totals: { ...totals, ...(bulkReasonOf(job) ? { reason: bulkReasonOf(job) } : {}) } as never });
      throw err;
    }
    totals.skipped += totals.errors;
    const done = await this.repo.update('bulk_update_jobs', job.id, {
      state: bulkUpdateJobMachine.next('applying', 'complete'),
      totals: { ...totals, ...(bulkReasonOf(job) ? { reason: bulkReasonOf(job) } : {}) } as never,
      applied_by: actorText(by.actor),
      applied_at: this.now(),
    });
    this.core.publish('offers.bulk_update.applied', { jobId: job.id, ownerType: job.owner_type, sellerId: job.seller_id, applied: totals.applied, skipped: totals.skipped, pendingApproval: totals.pendingApproval }, by);
    if (owner.ownerType === 'official') {
      await this.core.audit({ action: 'offers.official.bulk_apply', actionLabel: 'Applied an Official Store price file', category: 'catalog', target: { type: 'bulk_update', id: job.id, label: job.file_name }, reason: bulkReasonOf(job), after: totals }, by);
    }
    return bulkJob(done);
  }

  /* ================================================================ reads */

  async jobOf(owner: Owner, id: string): Promise<BulkJobRec> {
    const job = isUuid(id) ? await this.repo.get('bulk_update_jobs', id) : undefined;
    if (!job || job.owner_type !== owner.ownerType || (owner.ownerType === 'seller' && job.seller_id !== owner.sellerId)) throw notFound('Bulk update');
    return job;
  }

  async get(owner: Owner, id: string): Promise<BulkUpdateJob> {
    return bulkJob(await this.jobOf(owner, id));
  }

  async list(owner: Owner, page: PageRequest) {
    const p = await this.repo.listBulkJobs({ ownerType: owner.ownerType, ...(owner.sellerId ? { sellerId: owner.sellerId } : {}) }, page);
    return { ...p, items: p.items.map(bulkJob) };
  }

  async rows(owner: Owner, id: string, result: string | undefined, page: PageRequest) {
    const job = await this.jobOf(owner, id);
    const p = await this.repo.bulkRows(job.id, result, page);
    const offers = await this.repo.getMany('offers', p.items.map((r) => r.offer_id).filter((x): x is string => Boolean(x)));
    const summaries = await this.parts.views.summaries(offers);
    const large = await this.largeRows(owner, p.items, offers);
    return {
      ...p,
      items: p.items.map((r) => {
        const s = r.offer_id ? summaries.get(r.offer_id) : undefined;
        return bulkRow(r, this.core.currency, s ? `${s.productTitle} · ${s.variantLabel}` : null, large.has(r.row_no));
      }),
    };
  }

  /**
   * Seller rows still to apply that change a published offer's price by more than largeSellerPriceChangePct: apply
   * refuses them without confirmLargeChanges (decision G38: the preview flags them; drafts are exempt). Official
   * Store files have none (their prices go through price-change approval).
   */
  private async largeRows(owner: Owner, rows: readonly BulkRowRec[], offers: readonly OfferRec[]): Promise<Set<number>> {
    const out = new Set<number>();
    if (owner.ownerType !== 'seller') return out;
    const threshold = await this.parts.pricing.largeThreshold();
    const byId = new Map(offers.map((o) => [o.id, o]));
    for (const r of rows) {
      if (r.result !== 'ready' || r.price_from === null || r.price_to === null) continue;
      if (!byId.get(r.offer_id ?? '')?.published_at) continue;
      if (Math.abs(changePct(r.price_from, r.price_to)) > threshold) out.add(r.row_no);
    }
    return out;
  }

  async correctionReport(owner: Owner, id: string, by: By): Promise<FileLink> {
    const job = await this.jobOf(owner, id);
    const media = this.media();
    if (job.report_media_id && job.state === 'applied') {
      const link = await media.signedDownload(job.report_media_id, this.principalOf(by, owner)).catch(() => null);
      if (link) return { url: link.url, fileName: link.fileName, expiresAt: link.expiresAt };
    }
    const rows = (await this.repo.find('bulk_update_rows', { job_id: job.id, result: ['error', 'skipped'] }, { orderBy: [['row_no', 'asc']] })) as BulkRowRec[];
    const csv = toCsv([['row', owner.ownerType === 'seller' ? 'seller_sku' : 'sku', 'error', 'what_to_fix'], ...rows.map((r) => [r.row_no, r.seller_sku, r.error_code ?? '', r.error_message ?? ''])]);
    const { link, assetId } = await this.fileLink(owner, `${job.file_name.replace(/\.csv$/i, '')}-corrections.csv`, csv, 'correction_report', by);
    await this.repo.update('bulk_update_jobs', job.id, { report_media_id: assetId });
    return link;
  }

  /* ================================================================ jobs */

  /** offers.parse-bulk-file: parses any upload still waiting (normally parsed on upload) */
  async parsePending(): Promise<void> {
    for (const job of await this.repo.find('bulk_update_jobs', { state: 'uploaded' }, { orderBy: [['uploaded_at', 'asc']], limit: 20 })) {
      try {
        await this.parse(job);
      } catch (err) {
        this.ctx.log.error({ err, jobId: job.id }, 'offers: bulk file parse failed');
        await this.repo.update('bulk_update_jobs', job.id, { state: 'failed', failure: 'The file could not be processed' });
      }
    }
  }

  /** offers.expire-bulk-previews */
  async expire(): Promise<void> {
    const due = await this.repo.find('bulk_update_jobs', { state: 'preview_ready', expires_at: { op: '<=', value: this.now() } }, { limit: 1000 });
    for (const j of due) await this.repo.update('bulk_update_jobs', j.id, { state: bulkUpdateJobMachine.next('preview_ready', 'expire') });
  }
}
