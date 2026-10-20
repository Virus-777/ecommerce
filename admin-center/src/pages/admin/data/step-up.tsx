import { useCallback, useRef, useState } from 'react';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { Alert, Button, Dialog, Field, TextInput } from '@marketly/web-shared/ui';

// Sensitive Admin Center actions are confirmed with the staff member's password (offline server: staff have no
// authenticator). The request is sent as usual first; when it answers 403 STEP_UP_REQUIRED, the person types
// their password, POST /api/admin/identity/reauth { purpose, password } gives a token (one use, 5 minutes, this
// purpose and session), and the request is sent again with `reauthToken` in its JSON body.
// Purposes: role-grant, staff-account, payout-destination, approval, backup-download, backup-restore.

/** Thrown when the person closes the password prompt; callers ignore it. */
export class StepUpCancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'StepUpCancelled';
  }
}

export const isStepUpCancel = (e: unknown): boolean => e instanceof StepUpCancelled;

/** True when the API asks for a fresh password confirmation. */
export const needsReauth = (e: unknown): boolean => e instanceof ApiError && e.code === 'STEP_UP_REQUIRED';

/**
 * The body field for a retried request: `{ reauthToken }`, or nothing on the first try. Typed as required because
 * the OpenAPI marks it so, although the server accepts the first try without it.
 */
export const reauthField = (token?: string) => (token ? { reauthToken: token } : {}) as { reauthToken: string };

const PURPOSE_TEXT: Record<string, string> = {
  'role-grant': 'Changing roles and permissions',
  'staff-account': 'Changing a staff account',
  'payout-destination': 'Deciding a payout account change',
  approval: 'Approving this request',
  'backup-download': 'Downloading a backup (all the data)',
  'backup-restore': 'Asking to restore a backup',
};

/**
 * Tokens handed back by a retry that failed for another reason (a validation error, say): the server returns the
 * token unused, so the next try within its 5 minutes reuses it instead of asking for the password again.
 */
const spare = new Map<string, { token: string; until: number }>();

interface Ask {
  purpose: string;
  resolve: (token: string | null) => void;
}

/**
 * `run(fn)` calls `fn()`; on STEP_UP_REQUIRED it asks for the password, gets a re-auth token for the purpose the
 * server names and calls `fn(token)` again. Render `dialog` once in the page.
 */
export function useStepUp() {
  const { api } = useApi();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const askRef = useRef<Ask | null>(null);

  const run = useCallback(async <T,>(fn: (reauthToken?: string) => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!needsReauth(e)) throw e;
      const purpose = String((e as ApiError).details.purpose ?? 'approval');
      const kept = spare.get(purpose);
      let token: string | null = kept && kept.until > Date.now() + 5_000 ? kept.token : null;
      spare.delete(purpose);
      if (!token) {
        token = await new Promise<string | null>((resolve) => {
          const a = { purpose, resolve };
          askRef.current = a;
          setPassword('');
          setErr('');
          setAsk(a);
        });
        askRef.current = null;
        setAsk(null);
      }
      if (token === null) throw new StepUpCancelled();
      try {
        return await fn(token);
      } catch (again) {
        // Not a proof problem: the token was given back unused, keep it for the next try.
        if (!needsReauth(again)) spare.set(purpose, { token, until: Date.now() + 4.5 * 60_000 });
        throw again;
      }
    }
  }, []);

  const close = () => {
    askRef.current?.resolve(null);
    askRef.current = null;
    setAsk(null);
  };
  const submit = async () => {
    const a = askRef.current;
    if (!a) return;
    if (!password) {
      setErr('Enter your password.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = (await call(api.POST('/api/admin/identity/reauth', { body: { purpose: a.purpose, password } as never }))) as { reauthToken: string };
      setPassword('');
      a.resolve(r.reauthToken);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'CURRENT_PASSWORD_WRONG' || e.code === 'INVALID_CREDENTIALS')) {
        setErr('That password isn’t right. Wrong passwords count toward locking your account.');
      } else if (e instanceof ApiError && e.code === 'ACCOUNT_LOCKED') {
        setErr('Your account is locked after too many wrong passwords. Ask a Platform Administrator to unlock it.');
      } else {
        setErr(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <Dialog
      open={!!ask}
      onClose={close}
      title="Confirm it’s you"
      foot={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button icon="shield-check" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Checking…' : 'Confirm'}
          </Button>
        </>
      }
    >
      <span className="small">{ask ? `${PURPOSE_TEXT[ask.purpose] ?? 'This action'} needs your password again.` : ''}</span>
      {err && <Alert tone="danger">{err}</Alert>}
      <Field label="Your password">
        <TextInput
          id="stepup-password"
          type="password"
          autoComplete="current-password"
          value={password}
          autoFocus
          onChange={(e) => {
            setPassword(e.target.value);
            setErr('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
      </Field>
    </Dialog>
  );

  return { run, dialog, waiting: !!ask };
}
