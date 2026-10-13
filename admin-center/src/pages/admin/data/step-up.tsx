import { useCallback, useRef, useState } from 'react';
import { ApiError } from '@marketly/web-shared/api';
import { Button, Dialog, Field, TextInput } from '@marketly/web-shared/ui';

// Step-up for Admin Center actions marked "step-up: code" (invite staff, change role permissions, give a role):
// the API answers 403 STEP_UP_REQUIRED until the request carries the current 2-step code in X-Step-Up-Code.
// In development, dev-key staff tokens accept 000000; real sessions need the authenticator code.

/** Thrown when the person closes the code prompt; callers ignore it. */
export class StepUpCancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'StepUpCancelled';
  }
}

export const isStepUpCancel = (e: unknown): boolean => e instanceof StepUpCancelled;

/** The step-up header param (empty on the first try, which the API answers with STEP_UP_REQUIRED). */
export const stepUpHeader = (code?: string) => ({ 'X-Step-Up-Code': code ?? '' });

interface Ask {
  resolve: (code: string | null) => void;
  retry: boolean;
}

/**
 * `run(fn)` calls `fn()`; on STEP_UP_REQUIRED it shows the code prompt and calls `fn(code)` again with the code the
 * person enters (until it succeeds or they close the prompt). Render `dialog` once in the page.
 */
export function useStepUp() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const askRef = useRef<Ask | null>(null);

  const run = useCallback(async <T,>(fn: (code?: string) => Promise<T>): Promise<T> => {
    let current: string | undefined;
    for (;;) {
      try {
        const r = await fn(current);
        askRef.current = null;
        setAsk(null);
        return r;
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'STEP_UP_REQUIRED')) {
          askRef.current = null;
          setAsk(null);
          throw e;
        }
        const retry = current !== undefined;
        const next = await new Promise<string | null>((resolve) => {
          const a = { resolve, retry };
          askRef.current = a;
          setCode('');
          setErr(retry ? 'That code didn’t work. Enter the current code from your authenticator app.' : '');
          setAsk(a);
        });
        if (next === null) throw new StepUpCancelled();
        current = next;
      }
    }
  }, []);

  const close = () => {
    askRef.current?.resolve(null);
    askRef.current = null;
    setAsk(null);
  };
  const submit = () => {
    const c = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(c)) {
      setErr('Enter the 6-digit code from your authenticator app.');
      return;
    }
    askRef.current?.resolve(c);
  };

  const dialog = (
    <Dialog
      open={!!ask}
      onClose={close}
      title="Confirm it’s you"
      foot={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button icon="shield-check" onClick={submit}>
            Confirm
          </Button>
        </>
      }
    >
      <span className="small">This action needs a fresh 2-step code. Enter the current code from your authenticator app.</span>
      <Field label="2-step code" error={err}>
        <TextInput
          id="stepup-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          value={code}
          autoFocus
          onChange={(e) => {
            setCode(e.target.value);
            setErr('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </Field>
    </Dialog>
  );

  return { run, dialog, waiting: !!ask };
}
