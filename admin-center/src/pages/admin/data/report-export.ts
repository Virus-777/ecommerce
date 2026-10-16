// Report exports: POST /api/admin/reports/exports creates a job; GET …/exports/{id} is polled until it is ready
// (or failed) and its signed link is opened. Used by the report library and the report detail.
// useDatasetExport does the same for a registered dataset (the screens' Export buttons, G72), and
// useExportJob for any create/poll pair (audit exports poll GET audit/exports/{id}).
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, useApi } from '@marketly/web-shared/api';
import { localLink, type ExportJob, type ReportQuery } from './reports';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function download(url: string, name?: string | null) {
  const a = document.createElement('a');
  a.href = url;
  if (name) a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function useReportExport() {
  const { api } = useApi();
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const getJob = useCallback((id: string) => call(api.GET('/api/admin/reports/exports/{id}', { params: { path: { id } } })) as Promise<ExportJob>, [api]);

  /** Starts an export; resolves with the finished job (downloaded when `autoDownload`) or the job still running after ~80 s (the export job runs once a minute). */
  const start = useCallback(
    async (reportKey: string, query: ReportQuery, format: 'csv' | 'xlsx' = 'csv', autoDownload = true): Promise<ExportJob | null> => {
      setBusy(true);
      setError(null);
      try {
        let j = (await call(api.POST('/api/admin/reports/exports', { body: { reportKey, query, format } }))) as ExportJob;
        setJob(j);
        for (let i = 0; i < 40 && alive.current && (j.state === 'queued' || j.state === 'running'); i++) {
          await sleep(2000);
          j = await getJob(j.id);
          if (alive.current) setJob(j);
        }
        const link = localLink(j.downloadUrl);
        if (j.state === 'ready' && link && autoDownload) download(link, j.fileName);
        return j;
      } catch (e) {
        if (alive.current) setError(e);
        return null;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [api, getJob],
  );

  /** Downloads a ready job from the list (the list has no link; the detail signs one). */
  const fetchAndDownload = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const j = await getJob(id);
        const link = localLink(j.downloadUrl);
        if (link) download(link, j.fileName);
        return j;
      } catch (e) {
        setError(e);
        return null;
      }
    },
    [getJob],
  );

  return { job, error, busy, start, fetchAndDownload, reset: () => (setJob(null), setError(null)) };
}

/** Polls a job until it is ready, failed or expired (up to ~3 min: export jobs run once a minute), then downloads it. */
export function useExportJob(get: (id: string) => Promise<ExportJob>) {
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const run = useCallback(
    async (create: () => Promise<ExportJob>): Promise<ExportJob | null> => {
      setBusy(true);
      setError(null);
      try {
        let j = await create();
        setJob(j);
        for (let i = 0; i < 90 && alive.current && (j.state === 'queued' || j.state === 'running'); i++) {
          await sleep(2000);
          j = await get(j.id);
          if (alive.current) setJob(j);
        }
        const link = localLink(j.downloadUrl);
        if (j.state === 'ready' && link && alive.current) download(link, j.fileName);
        return j;
      } catch (e) {
        if (alive.current) setError(e);
        return null;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [get],
  );

  /** Signs a fresh link for a finished job and downloads it (links expire). */
  const redownload = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const j = await get(id);
        setJob(j);
        const link = localLink(j.downloadUrl);
        if (link) download(link, j.fileName);
      } catch (e) {
        setError(e);
      }
    },
    [get],
  );

  return { job, error, busy, run, redownload, reset: () => (setJob(null), setError(null)) };
}

/** Export of a registered dataset (GET reports/export-datasets): POST reports/exports { dataset, filters, format }. */
export function useDatasetExport(dataset: string) {
  const { api } = useApi();
  const get = useCallback((id: string) => call(api.GET('/api/admin/reports/exports/{id}', { params: { path: { id } } })) as Promise<ExportJob>, [api]);
  const x = useExportJob(get);
  const start = useCallback(
    (filters: Record<string, unknown> = {}, format: 'csv' | 'xlsx' = 'csv') =>
      x.run(() => call(api.POST('/api/admin/reports/exports', { body: { dataset, filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== '')), format } })) as Promise<ExportJob>),
    [api, dataset, x.run],
  );
  return { ...x, start };
}
