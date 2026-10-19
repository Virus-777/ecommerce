import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, call, errorMessage, useApi, type components, type SessionTokens } from '@marketly/web-shared/api';
import { Alert, Button, Field, TextInput } from '@marketly/web-shared/ui';
import { AuthFrame, device } from './SignIn';
import { checkPassword, passwordError, PasswordRules, useHashToken } from './passwords';

// /invitation#token=… (designed in React; no design file): the staff registration. The server operator hands over
// the link and an 8-character pass code printed by `bootstrap-owner` or `staff-link`. The person confirms the pass
// code, sets a password and is signed in. Staff have no 2-step on the offline server, so there is no setup step.
// API: POST /api/public/identity/invitations/lookups { token } → InvitationView;
//      POST /api/public/identity/invitations/accept { token, passCode, password, name, device } → signed in.

type InvitationView = components['schemas']['identity.InvitationView'];

export default function Invitation() {
  const { api, session } = useApi();
  const navigate = useNavigate();
  const token = useHashToken();

  const view = useQuery({
    queryKey: ['identity', 'invitation', token],
    queryFn: () => call(api.POST('/api/public/identity/invitations/lookups', { body: { token } })) as Promise<InvitationView>,
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  });
  const inv = view.data;

  const [name, setName] = useState<string | null>(null);
  const [passCode, setPassCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The link was cancelled (5 wrong pass codes) or no longer works: the form is closed. */
  const [closed, setClosed] = useState('');

  const shownName = name ?? inv?.name ?? '';
  const personal = [shownName, ...shownName.split(/\s+/)];
  const problems = {
    name: !shownName.trim() ? 'Enter your name.' : '',
    passCode: !passCode.trim() ? 'Enter the pass code you were given with the link.' : '',
    password: checkPassword(password, inv?.policy, personal).join(' '),
    confirm: confirm !== password ? 'The passwords don’t match.' : '',
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.values(problems).some(Boolean)) return;
    setBusy(true);
    setError('');
    try {
      // The server ignores case, dashes and spaces in the pass code: send what was typed.
      const r = (await call(
        api.POST('/api/public/identity/invitations/accept', {
          body: { token, passCode, password, name: shownName.trim(), device: device() } as never,
          credentials: 'include',
        }),
      )) as { status: string; tokens?: SessionTokens | null };
      if (r.tokens) session.adopt(r.tokens);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PASS_CODE_INVALID') {
        const left = err.details.attemptsLeft as number | undefined;
        if (left === 0) setClosed('That was the last try, so this link is cancelled. Ask the server operator for a new link and pass code.');
        else setError(`That pass code is not right.${left != null ? ` ${left} ${left === 1 ? 'try' : 'tries'} left.` : ''}`);
      } else if (err instanceof ApiError && err.code === 'INVITATION_INVALID') {
        setClosed('This invitation link no longer works (accepted, cancelled or expired). Ask the server operator for a new link and pass code.');
      } else if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        const issues = (err.details.issues as Array<{ path?: string[]; message?: string }> | undefined) ?? [];
        setError(issues.map((i) => i.message).filter(Boolean).join(' ') || errorMessage(err));
      } else {
        setError(passwordError(err, inv?.policy));
      }
    } finally {
      setBusy(false);
    }
  };

  const lookupGone = view.error instanceof ApiError && (view.error.code === 'INVITATION_INVALID' || view.error.status === 410 || view.error.status === 404);

  return (
    <AuthFrame title="Accept your invitation">
      {!token ? (
        <Alert tone="danger" title="This link is incomplete">
          Open the full link you were given. It ends with <code>#token=…</code>.
        </Alert>
      ) : view.isPending ? (
        <div className="sk-list" aria-label="Loading invitation">
          <div className="sk-row">
            <span className="sk-lines">
              <span className="sk sk-line" />
              <span className="sk sk-line short" />
            </span>
          </div>
        </div>
      ) : lookupGone || closed ? (
        <Alert tone="danger" title="This invitation can’t be used">
          {closed || 'This invitation link no longer works (accepted, cancelled or expired). Ask the server operator for a new link and pass code.'}
        </Alert>
      ) : view.isError ? (
        <Alert tone="danger" title="We couldn’t open this invitation">
          {errorMessage(view.error)}
        </Alert>
      ) : inv ? (
        <form className="stack gap-4" onSubmit={(e) => void submit(e)} noValidate>
          <p className="small sub">
            {inv.contextLabel ? `${inv.contextLabel} · ` : ''}Staff account for <span className="strong">{inv.emailMasked}</span>. Enter the pass code you were given with this link and choose a password.
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Your name" error={tried ? problems.name : undefined}>
            <TextInput id="inv-name" autoComplete="name" value={shownName} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Pass code" hint="8 characters, like K7M2-Q9XP" error={tried ? problems.passCode : undefined}>
            <TextInput id="inv-pass" autoComplete="off" spellCheck={false} data-1p-ignore="" data-lpignore="true" value={passCode} maxLength={12} onChange={(e) => setPassCode(e.target.value)} placeholder="XXXX-XXXX" />
          </Field>
          <Field label="New password" error={tried ? problems.password : undefined}>
            <TextInput id="inv-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <PasswordRules policy={inv.policy} password={password} />
          <Field label="Confirm the password" error={tried ? problems.confirm : undefined}>
            <TextInput id="inv-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Button type="submit" block disabled={busy}>
            {busy ? 'Setting up…' : 'Set password and sign in'}
          </Button>
          <p className="xs muted">The link expires {new Date(inv.expiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}. Five wrong pass codes cancel it.</p>
        </form>
      ) : null}
    </AuthFrame>
  );
}
