// Dataset exports (G72): POST /api/admin/reports/exports { dataset, filters, format } starts a background job;
// GET …/exports/{id} is polled until it is ready (or failed) and its signed link is downloaded, as the report
// library does (report-export.ts). Used by the case queue (support.admin.cases), the payout run
// (finance.admin.payout_run), the finance overview (finance.admin.overview) and the customer list
// (customers.admin.accounts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, useApi } from '@marketly/web-shared/api';
import { download } from './report-export';
import { localLink, type ExportJob } from './reports';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ExportDataset = 'support.admin.cases' | 'finance.admin.payout_run' | 'finance.admin.overview' | 'customers.admin.accounts';

export function useDatasetExport(dataset: ExportDataset) {
  const { api } = useApi();
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  /** Starts the export and waits up to ~80 s (the export job runs about once a minute); a ready file downloads. */
  const start = useCallback(
    async (filters: Record<string, unknown> = {}, format: 'csv' | 'xlsx' = 'csv'): Promise<ExportJob | null> => {
      setBusy(true);
      setError(null);
      try {
        let j = (await call(api.POST('/api/admin/reports/exports', { body: { dataset, filters, format } }))) as ExportJob;
        setJob(j);
        for (let i = 0; i < 40 && alive.current && (j.state === 'queued' || j.state === 'running'); i++) {
          await sleep(2000);
          j = (await call(api.GET('/api/admin/reports/exports/{id}', { params: { path: { id: j.id } } }))) as ExportJob;
          if (alive.current) setJob(j);
        }
        const link = localLink(j.downloadUrl);
        if (j.state === 'ready' && link) download(link, j.fileName);
        return j;
      } catch (e) {
        if (alive.current) setError(e);
        return null;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [api, dataset],
  );

  /** Looks at a job still being prepared and downloads it when ready. */
  const check = useCallback(async (): Promise<ExportJob | null> => {
    if (!job) return null;
    setBusy(true);
    setError(null);
    try {
      const j = (await call(api.GET('/api/admin/reports/exports/{id}', { params: { path: { id: job.id } } }))) as ExportJob;
      if (alive.current) setJob(j);
      const link = localLink(j.downloadUrl);
      if (j.state === 'ready' && link) download(link, j.fileName);
      return j;
    } catch (e) {
      if (alive.current) setError(e);
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [api, job]);

  /** The Export button: checks a job still being prepared, else starts a new export. */
  const run = (filters: Record<string, unknown> = {}) => (job && (job.state === 'queued' || job.state === 'running') ? check() : start(filters));

  return { job, error, busy, start, check, run, reset: () => (setJob(null), setError(null)) };
}

/** One line for the job's state, for a notice next to the Export button. */
export function exportNote(j: ExportJob | null): { tone: 'success' | 'info' | 'danger'; text: string } | null {
  if (!j) return null;
  if (j.state === 'ready') return { tone: 'success', text: `${j.rowCount ?? 0} row${j.rowCount === 1 ? '' : 's'} exported as ${j.format.toUpperCase()} (${j.ref}). The export is recorded in Action history.` };
  if (j.state === 'failed') return { tone: 'danger', text: j.error ?? 'The export failed. Try again, or narrow the filters.' };
  if (j.state === 'expired') return { tone: 'info', text: `Export ${j.ref} has expired. Start a new one.` };
  return { tone: 'info', text: `Export ${j.ref} is being prepared. Select Export again in a minute to download it.` };
}
