// Loading and load-failure states, the same on every screen of the three apps.
import type { ReactNode } from 'react';
import { ApiError, errorMessage } from '../api/errors';
import { Button } from './Button';
import { Alert } from './Structure';

/** A permission refusal (403 FORBIDDEN), not a step-up request */
export const isForbidden = (e: unknown): boolean => e instanceof ApiError && (e.status === 403 || e.code === 'FORBIDDEN') && e.code !== 'STEP_UP_REQUIRED';

/**
 * A failed read: the error and a Try again button (API.md rule 4). A permission refusal is not an error to retry: it
 * says the screen isn't available for the caller's role, with `forbiddenHint` saying who can change that.
 */
export function LoadError({ error, onRetry, title = 'We couldn’t load this', forbiddenHint = 'Your role doesn’t include access to this.' }: { error: unknown; onRetry?: () => void; title?: ReactNode; forbiddenHint?: ReactNode }) {
  if (isForbidden(error)) {
    return (
      <Alert tone="info" title="Not available for your role">
        {forbiddenHint}
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title={title}>
      {errorMessage(error)}{' '}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Alert>
  );
}

/** Skeleton lines for a card body while it loads (hidden from screen readers: the region says it is loading). */
export function SkeletonLines({ rows = 3 }: { rows?: number }) {
  return (
    <div className="sk-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row">
          <span className="sk-lines">
            <span className="sk sk-line" />
            <span className="sk sk-line short" />
          </span>
        </div>
      ))}
    </div>
  );
}
