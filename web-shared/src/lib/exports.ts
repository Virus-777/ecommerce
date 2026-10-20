// Export jobs and file downloads, the same in all three apps: exports run as background jobs on the server, the
// screen polls until the file is ready, then the browser downloads the signed link.
import { ApiError } from '../api/errors';

/** What polling needs from an export job (reports ExportJob and the module export jobs alike). */
export interface ExportJobState {
  id: string;
  ref?: string | null;
  state: string;
  downloadUrl?: string | null;
  error?: string | null;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Polls an export job until its file is ready and returns it. A job that fails, or is still running after
 * `timeoutMs` (5 minutes by default), throws an ApiError with a message for people (EXPORT_FAILED, EXPORT_TIMEOUT).
 */
export async function waitForExport<J extends ExportJobState>(first: J, read: (id: string) => Promise<J>, o: { timeoutMs?: number; everyMs?: number } = {}): Promise<J> {
  let job = first;
  const until = Date.now() + (o.timeoutMs ?? 5 * 60_000);
  const name = job.ref ? `Export ${job.ref}` : 'The export';
  while (job.state === 'queued' || job.state === 'running') {
    if (Date.now() > until) throw new ApiError(504, 'EXPORT_TIMEOUT', `${name} is still being prepared. Try again in a few minutes.`);
    await sleep(o.everyMs ?? 2000);
    job = await read(job.id);
  }
  if (job.state !== 'ready' || !job.downloadUrl) throw new ApiError(422, 'EXPORT_FAILED', job.error || `${name} couldn’t be prepared. Try again.`);
  return job;
}

/** Starts the browser download of a signed link (the API serves files as attachments). */
export function download(url: string, fileName?: string | null) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  if (fileName) a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
