// The screens' Export button for a registered dataset (G72): starts the job, shows progress while it is polled,
// downloads the file when ready, and offers the download again if the browser blocked it. Errors and jobs that
// failed or are still running show as an alert under the page header (<ExportNotice>).
import { errorMessage } from '@marketly/web-shared/api';
import { Alert, Button } from '@marketly/web-shared/ui';
import type { useDatasetExport } from './report-export';

type DatasetExport = ReturnType<typeof useDatasetExport>;

export function ExportButton({ exp, filters, label = 'Export' }: { exp: DatasetExport; filters?: Record<string, unknown>; label?: string }) {
  return (
    <Button variant="secondary" size="sm" icon="download" disabled={exp.busy} onClick={() => void exp.start(filters)} aria-busy={exp.busy || undefined}>
      {exp.busy ? 'Preparing export…' : label}
    </Button>
  );
}

export function ExportNotice({ exp }: { exp: DatasetExport }) {
  const j = exp.job;
  if (exp.error) return <Alert tone="danger" title="The export didn’t start">{errorMessage(exp.error)}</Alert>;
  if (!j || exp.busy) return null;
  if (j.state === 'failed') return <Alert tone="danger" title={`Export ${j.ref} failed`}>{j.error ?? 'Try again, or narrow the filters.'}</Alert>;
  if (j.state === 'queued' || j.state === 'running')
    return (
      <Alert tone="info" title={`Export ${j.ref} is still being prepared`}>
        It will appear in your report exports when it’s ready.{' '}
        <Button variant="link" size="sm" onClick={() => void exp.redownload(j.id)}>
          Check again
        </Button>
      </Alert>
    );
  if (j.state === 'ready')
    return (
      <Alert tone="success" title={`Export ${j.ref} is ready`}>
        {j.rowCount != null ? `${j.rowCount.toLocaleString('en-US')} rows` : 'The file downloaded'}
        {j.columnsExcluded.length ? ` · ${j.columnsExcluded.length} columns left out for your role` : ''}.{' '}
        <Button variant="link" size="sm" onClick={() => void exp.redownload(j.id)}>
          Download again
        </Button>
      </Alert>
    );
  return null;
}
