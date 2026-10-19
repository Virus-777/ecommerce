import { Icon, IconButton, type IconName } from '@marketly/web-shared/ui';
import type { useUploads } from '@marketly/web-shared/api';

// The list under a FileDrop (design: paperclip/image rows with a remove button), with each file's upload state.

export function UploadList({ uploads, icon = 'paperclip' }: { uploads: ReturnType<typeof useUploads>; icon?: IconName }) {
  return (
    <>
      {uploads.error && (
        <span className="error-text">
          <Icon name="circle-alert" className="ic-sm" />
          {uploads.error}
        </span>
      )}
      {uploads.items.length > 0 && (
        <ul className="list">
          {uploads.items.map((f) => (
            <li key={f.key} className="row gap-2">
              <Icon name={icon} className="ic-sm" />
              <span className="small grow">{f.name}</span>
              {f.status === 'uploading' && (
                <span className="xs muted" role="status">
                  Uploading…
                </span>
              )}
              {f.status === 'failed' && (
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {f.error ?? 'Upload failed'}
                </span>
              )}
              <IconButton icon="x" size="sm" label={`Remove ${f.name}`} onClick={() => uploads.remove(f.key)} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
