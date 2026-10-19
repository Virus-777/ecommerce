import { QrCode } from '@/app/QrCode';
import { NO_PASSWORD_NOTE } from './data/password';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { ApiError, call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Card, Dialog, Field, Icon, OptionCard, StatusBadge, TableWrap, TextInput } from '@marketly/web-shared/ui';
import { dateLong, dateTime, listTime } from './data/when';

// Design: pages/store/account-security.html (one view): password change, 2-step verification,
// email verification, signed-in devices and recent security activity.
// API: identity security page (GET /api/store/identity/security), password change, 2-step setup/removal
// (password, then re-auth for removal), devices sign-out, security activity, password policy.

type Device = components['schemas']['identity.Device'];
type Method = 'app' | 'sms';
type SetupStep = { step: 'password' } | { step: 'code'; setupId: string; key?: string | null; uri?: string | null; phone?: string | null } | { step: 'codes'; codes: string[] };

const pw0 = { cur: '', next: '', conf: '' };
const RULE_COPY: Record<string, string> = {
  min_length: 'is too short',
  number: 'needs a number',
  uppercase: 'needs an uppercase letter',
  personal_info: "can't contain your name or email",
  breached: 'appeared in a data breach; choose another',
};
const groupKey = (k?: string | null) => (k ?? '').replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');

/** Failed 2-step code or password answers, as one sentence. */
function proofError(e: unknown): string | undefined {
  if (!e) return undefined;
  if (e instanceof ApiError) {
    if (e.code === 'CURRENT_PASSWORD_WRONG') return 'The password is incorrect.';
    if (e.code === 'PASSWORD_NOT_SET') return NO_PASSWORD_NOTE;
    if (e.code === 'CODE_INVALID') return `That code is not right.${typeof e.details.attemptsLeft === 'number' ? ` ${e.details.attemptsLeft} tries left.` : ''}`;
    if (e.code === 'CODE_EXPIRED') return 'The code has expired. Start again.';
    if (e.code === 'METHOD_NOT_AVAILABLE') return "Text message codes aren't available yet. Use an authenticator app.";
  }
  return errorMessage(e);
}

export default function Security() {
  const { api } = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['identity'] });

  const sec = useQuery({ queryKey: ['identity', 'security'], queryFn: () => call(api.GET('/api/store/identity/security')) });
  const activity = useQuery({
    queryKey: ['identity', 'security-activity', 30],
    queryFn: () => call(api.GET('/api/store/identity/security-activity', { params: { query: { days: 30, limit: 20 } } })),
  });
  const policy = useQuery({ queryKey: ['identity', 'password-policy'], queryFn: () => call(api.GET('/api/public/identity/password-policy', { params: { query: { realm: 'member' } } })), staleTime: Infinity });
  const profile = useQuery({ queryKey: ['customers', 'profile'], queryFn: () => call(api.GET('/api/store/customers/profile')) });
  const minLen = policy.data?.minLength ?? 10;
  /** SecurityOverview.hasPassword false: password change, 2-step setup and removal can't be confirmed (G28). */
  const noPassword = sec.data?.hasPassword === false;

  // Password
  const [pw, setPw] = useState(pw0);
  const [pwTried, setPwTried] = useState(false);
  const changePw = useMutation({
    mutationFn: () => call(api.PUT('/api/store/identity/password', { body: { currentPassword: pw.cur, newPassword: pw.next, signOutOtherDevices: false } })),
    onSuccess: () => {
      setPw(pw0);
      setPwTried(false);
      announce('Password changed');
      refresh();
    },
  });
  const pwServer: { cur?: string; next?: string } = {};
  if (changePw.error instanceof ApiError) {
    const e = changePw.error;
    if (e.code === 'CURRENT_PASSWORD_WRONG') pwServer.cur = `The current password is incorrect.${typeof e.details.attemptsLeft === 'number' ? ` ${e.details.attemptsLeft} tries left.` : ''}`;
    else if (e.code === 'WEAK_PASSWORD') pwServer.next = `This password ${((e.details.failed as string[] | undefined) ?? []).map((r) => RULE_COPY[r] ?? r).join(', ') || 'breaks a rule'}.`;
    else if (e.code === 'PASSWORD_REUSED') pwServer.next = 'You used this password recently. Choose a new one.';
    else if (e.code === 'VALIDATION_FAILED') Object.assign(pwServer, { cur: e.fieldErrors.currentPassword, next: e.fieldErrors.newPassword });
    else if (e.code === 'PASSWORD_NOT_SET') pwServer.cur = NO_PASSWORD_NOTE;
  }
  const pwLocal = pwTried
    ? {
        cur: pw.cur ? undefined : 'Enter your current password.',
        next: pw.next.length >= minLen ? (pw.next === pw.cur ? 'Choose a password different from your current one.' : undefined) : `Use at least ${minLen} characters.`,
        conf: pw.conf === pw.next ? undefined : "The passwords don't match.",
      }
    : {};
  const pwErr = { cur: pwLocal.cur ?? pwServer.cur, next: pwLocal.next ?? pwServer.next, conf: pwLocal.conf };
  const pwOtherError = changePw.isError && !pwServer.cur && !pwServer.next ? errorMessage(changePw.error) : '';
  const submitPw = () => {
    setPwTried(true);
    if (!pw.cur || pw.next.length < minLen || pw.next === pw.cur || pw.conf !== pw.next) return;
    changePw.mutate();
  };
  const editPw = (k: keyof typeof pw0, v: string) => {
    setPw((x) => ({ ...x, [k]: v }));
    if (changePw.isError || changePw.isSuccess) changePw.reset();
  };

  // 2-step verification
  const twoStep = sec.data?.twoStep;
  const enabledMethod = twoStep?.methods[0];
  const [method, setMethod] = useState<Method>('app');
  const [setup, setSetup] = useState<SetupStep | null>(null);
  const [setupPw, setSetupPw] = useState('');
  const [code, setCode] = useState('');
  const [codeTried, setCodeTried] = useState(false);
  const codeErr = codeTried && !/^\d{6}$/.test(code.trim()) ? 'Enter the 6-digit code.' : undefined;

  const startSetup = useMutation({
    mutationFn: () => call(api.POST('/api/store/identity/two-step/setups', { body: { method: method === 'app' ? 'totp' : 'sms', currentPassword: setupPw, ...(method === 'sms' ? { phone: profile.data?.phone ?? null } : {}) } })),
    onSuccess: (s) => {
      setSetupPw('');
      setSetup({ step: 'code', setupId: s.setupId, key: s.manualEntryKey, uri: s.otpauthUri, phone: s.phoneMasked });
    },
  });
  const confirmSetup = useMutation({
    mutationFn: (setupId: string) => call(api.POST('/api/store/identity/two-step/setups/{id}/confirm', { params: { path: { id: setupId } }, body: { code: code.trim() } })),
    onSuccess: (r) => {
      setCode('');
      setCodeTried(false);
      setSetup({ step: 'codes', codes: r.codes });
      announce('2-step verification turned on');
      refresh();
    },
  });
  const openSetup = () => {
    startSetup.reset();
    confirmSetup.reset();
    setSetupPw('');
    setCode('');
    setCodeTried(false);
    setSetup({ step: 'password' });
  };
  const confirmCode = () => {
    setCodeTried(true);
    if (!/^\d{6}$/.test(code.trim()) || setup?.step !== 'code') return;
    confirmSetup.mutate(setup.setupId);
  };

  const [removing, setRemoving] = useState(false);
  const [offPw, setOffPw] = useState('');
  const [offCode, setOffCode] = useState('');
  const removeTwoStep = useMutation({
    mutationFn: async () => {
      if (!enabledMethod) throw new Error('No method');
      const { reauthToken } = await call(api.POST('/api/store/identity/reauth', { body: { purpose: 'two-step-removal', password: offPw } }));
      return call(api.POST('/api/store/identity/two-step/methods/{id}/remove', { params: { path: { id: enabledMethod.id } }, body: { reauthToken, code: offCode.trim() } }));
    },
    onSuccess: () => {
      setRemoving(false);
      setOffPw('');
      setOffCode('');
      announce('2-step verification turned off');
      refresh();
    },
  });

  // Devices
  const devices = sec.data?.devices ?? [];
  const signOutOne = useMutation({
    mutationFn: (d: Device) => call(api.POST('/api/store/identity/devices/{id}/sign-out', { params: { path: { id: d.id } } })),
    onSuccess: refresh,
  });
  const signOutAll = useMutation({
    mutationFn: () => call(api.POST('/api/store/identity/devices/sign-out-all', { body: { keepThisDevice: true } })),
    onSuccess: (r) => {
      announce(`Signed out of ${r.sessionsRevoked} other session${r.sessionsRevoked === 1 ? '' : 's'}`);
      refresh();
    },
  });
  const deviceError = signOutOne.error ?? signOutAll.error;

  const smsPhone = profile.data?.phone ? `(${profile.data.phone.replace(/\D/g, '').slice(-10, -7)}) •••-${profile.data.phone.slice(-4)}` : null;
  const methodText = enabledMethod?.method === 'sms' ? `sent to ${enabledMethod.phoneMasked ?? 'your phone'}` : 'from your authenticator app';

  return (
    <AccountLayout active="security" title="Sign-in and security">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Sign-in and security</h1>
          <p className="small sub">Keep your account and saved payment methods safe.</p>
        </div>
      </div>
      {sec.isError ? (
        <Alert tone="danger" title="We couldn't load your security settings">
          {errorMessage(sec.error)}{' '}
          <Button variant="ghost" size="sm" onClick={() => void sec.refetch()}>
            Try again
          </Button>
        </Alert>
      ) : !twoStep ? null : twoStep.enabled ? (
        <Alert tone="success" title="2-step verification is on">
          We'll ask for a code {methodText} when you sign in on a new device.
        </Alert>
      ) : (
        <Alert tone="warning" title="2-step verification is off">
          Turn it on so a stolen password alone can't open your account.
        </Alert>
      )}
      <div className="grid lg2 u-items-start">
        <Card
          title="Password"
          sub={noPassword ? 'No password on this account' : sec.data?.passwordChangedAt ? `Last changed ${dateLong(sec.data.passwordChangedAt)}` : 'Set when you created your account'}
          foot={
            <Button onClick={submitPw} disabled={changePw.isPending || noPassword}>
              {changePw.isPending ? 'Changing…' : 'Change password'}
            </Button>
          }
        >
          {changePw.isSuccess && <Alert tone="success" title="Password changed">Other devices stay signed in. Sign them out below if you don't recognize one.</Alert>}
          {pwOtherError && <Alert tone="danger" title="We couldn't change your password">{pwOtherError}</Alert>}
          {noPassword && (
            <Alert tone="info" title="No password on this account">
              {NO_PASSWORD_NOTE}
            </Alert>
          )}
          <Field label="Current password" error={pwErr.cur}>
            <TextInput id="sc-cur" type="password" value={pw.cur} error={!!pwErr.cur} disabled={noPassword} autoComplete="current-password" onChange={(e) => editPw('cur', e.target.value)} />
          </Field>
          <Field label="New password" hint={`At least ${minLen} characters${policy.data?.requireNumber ? ', with a number' : ''}${policy.data?.requireUppercase ? ' and an uppercase letter' : ''}. Avoid passwords you use elsewhere.`} error={pwErr.next}>
            <TextInput id="sc-new" type="password" value={pw.next} error={!!pwErr.next} disabled={noPassword} autoComplete="new-password" onChange={(e) => editPw('next', e.target.value)} />
          </Field>
          <Field label="Confirm new password" error={pwErr.conf}>
            <TextInput id="sc-conf" type="password" value={pw.conf} error={!!pwErr.conf} disabled={noPassword} autoComplete="new-password" onChange={(e) => editPw('conf', e.target.value)} />
          </Field>
          <Link className="xs strong" to={href('auth/recover')}>
            Forgot your current password?
          </Link>
        </Card>
        <div className="stack gap-4">
          <Card
            title="2-step verification"
            titleAs="h3"
            sub="A code at sign-in on new devices"
            actions={twoStep && <Badge tone={twoStep.enabled ? 'success' : 'warning'}>{twoStep.enabled ? 'On' : 'Off'}</Badge>}
            foot={
              twoStep?.enabled ? (
                <Button variant="secondary" onClick={() => (removeTwoStep.reset(), setRemoving(true))} disabled={noPassword}>
                  Turn off 2-step verification
                </Button>
              ) : (
                <Button icon="shield-check" onClick={openSetup} disabled={!twoStep || noPassword}>
                  Turn on 2-step verification
                </Button>
              )
            }
          >
            <div className="stack gap-2" role="radiogroup" aria-label="Verification method">
              <OptionCard
                id="sc-2sv-app"
                name="sc-2sv"
                checked={twoStep?.enabled ? enabledMethod?.method === 'totp' : method === 'app'}
                disabled={!!twoStep?.enabled}
                onChange={() => setMethod('app')}
                title={
                  <>
                    <span className="strong">Authenticator app</span> <Badge tone="brand">Recommended</Badge>
                  </>
                }
                body="Google Authenticator, 1Password or similar."
              />
              <OptionCard
                id="sc-2sv-sms"
                name="sc-2sv"
                checked={twoStep?.enabled ? enabledMethod?.method === 'sms' : method === 'sms'}
                disabled={!!twoStep?.enabled || !smsPhone}
                onChange={() => setMethod('sms')}
                title={<span className="strong">Text message</span>}
                body={smsPhone ? `Codes sent to ${smsPhone}.` : 'Add a mobile phone in your profile to use text messages.'}
              />
            </div>
            {noPassword && <span className="xs muted">2-step verification is confirmed with your password, so it isn’t available for this account.</span>}
            {twoStep?.enabled && <span className="xs muted">{twoStep.recoveryCodesRemaining} recovery code{twoStep.recoveryCodesRemaining === 1 ? '' : 's'} left.</span>}
          </Card>
          <Card title="Email verification" titleAs="h3">
            {sec.data ? (
              <div className="row between">
                <span className="stack gap-0">
                  <span className="small strong">{sec.data.email.address}</span>
                  <span className="xs muted">
                    {sec.data.email.verifiedAt ? `Verified ${dateLong(sec.data.email.verifiedAt)}. Security alerts go here.` : 'Not verified yet. Security alerts go here.'}
                    {sec.data.email.pendingChangeTo && ` Change to ${sec.data.email.pendingChangeTo} waiting for its code.`}
                  </span>
                </span>
                <Badge tone={sec.data.email.verifiedAt ? 'info' : 'warning'}>{sec.data.email.verifiedAt ? 'Verified' : 'Not verified'}</Badge>
              </div>
            ) : (
              <span className="stack gap-2" aria-hidden="true">
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </span>
            )}
          </Card>
        </div>
      </div>
      <Card
        title="Where you're signed in"
        titleAs="h3"
        sub={sec.data ? `${devices.length} device${devices.length === 1 ? '' : 's'}` : undefined}
        actions={
          <Button variant="danger-soft" size="sm" icon="log-out" onClick={() => signOutAll.mutate()} disabled={devices.length < 2 || signOutAll.isPending}>
            Sign out everywhere
          </Button>
        }
        flush
      >
        {deviceError && (
          <div className="card-body">
            <Alert tone="danger" title="That didn't work">{errorMessage(deviceError)}</Alert>
          </div>
        )}
        {!sec.data && !sec.isError && (
          <div className="sk-list" aria-hidden="true">
            {[0, 1].map((i) => (
              <div className="sk-row" key={i}>
                <span className="sk sk-thumb" />
                <span className="sk-lines">
                  <span className="sk sk-line" />
                  <span className="sk sk-line short" />
                </span>
              </div>
            ))}
          </div>
        )}
        {devices.map((s) => (
          <div key={s.id} className="acct-row">
            <span className="acct-ic">
              <Icon name={s.kind === 'android' ? 'smartphone' : 'monitor'} className="ic-sm" />
            </span>
            <span className="stack gap-0 grow">
              <span className="small strong">
                {s.label} {s.current && <Badge tone="brand">This device</Badge>}
              </span>
              <span className="xs muted">
                {s.location ?? 'Location unknown'} · {s.current ? 'Active now' : listTime(s.lastActiveAt)}
              </span>
            </span>
            {!s.current && (
              <Button variant="secondary" size="sm" onClick={() => signOutOne.mutate(s)} disabled={signOutOne.isPending}>
                Sign out
              </Button>
            )}
          </div>
        ))}
      </Card>
      <Card
        title="Recent security activity"
        titleAs="h3"
        sub="Last 30 days · Pacific Time"
        flush
        foot={
          <span className="xs muted grow">
            Don't recognize something? Change your password and sign out everywhere, then{' '}
            <Link to={href('help/contact')} className="link-inline">
              contact support
            </Link>
            .
          </span>
        }
      >
        {activity.isError ? (
          <div className="card-body">
            <Alert tone="danger" title="We couldn't load your activity">
              {errorMessage(activity.error)}{' '}
              <Button variant="ghost" size="sm" onClick={() => void activity.refetch()}>
                Try again
              </Button>
            </Alert>
          </div>
        ) : (
          <TableWrap label="Recent security activity table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Activity</th>
                  <th scope="col">Device and location</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {activity.isPending &&
                  [0, 1, 2].map((i) => (
                    <tr key={i} aria-hidden="true">
                      {[0, 1, 2, 3].map((j) => (
                        <td key={j}>
                          <span className="sk sk-line" />
                        </td>
                      ))}
                    </tr>
                  ))}
                {activity.data?.items.map((a) => (
                  <tr key={a.id}>
                    <td>{dateTime(a.at)}</td>
                    <td>{a.label}</td>
                    <td>{[a.device, a.location].filter(Boolean).join(' · ') || '—'}</td>
                    <td>
                      <StatusBadge status={a.result === 'completed' ? 'Completed' : a.result === 'blocked' ? 'Blocked' : 'Failed'} tone={a.result === 'completed' ? 'success' : 'danger'} />
                    </td>
                  </tr>
                ))}
                {activity.data && !activity.data.items.length && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No security activity in the last 30 days.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Dialog
        open={!!setup}
        onClose={() => setSetup(null)}
        title={setup?.step === 'codes' ? 'Save your recovery codes' : method === 'app' ? 'Set up your authenticator app' : 'Verify your phone'}
        size="sm"
        foot={
          setup?.step === 'codes' ? (
            <Button onClick={() => setSetup(null)}>I saved my codes</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
              {setup?.step === 'password' ? (
                <Button onClick={() => startSetup.mutate()} disabled={!setupPw || startSetup.isPending}>
                  Continue
                </Button>
              ) : (
                <Button icon="shield-check" onClick={confirmCode} disabled={confirmSetup.isPending}>
                  Turn on
                </Button>
              )}
            </>
          )
        }
      >
        {setup?.step === 'password' && (
          <>
            <p className="small sub">Confirm it's you to turn on 2-step verification.</p>
            <Field label="Current password" error={proofError(startSetup.error)}>
              <TextInput id="sc-setup-pw" type="password" autoComplete="current-password" value={setupPw} error={startSetup.isError} onChange={(e) => (setSetupPw(e.target.value), startSetup.reset())} />
            </Field>
          </>
        )}
        {setup?.step === 'code' && (
          <>
            <p className="small sub">
              {method === 'app'
                ? `${setup.uri ? 'Scan this QR code with your authenticator app, or add Marketly with the setup key' : 'Add Marketly in your authenticator app with this setup key'}, then enter the 6-digit code it shows.`
                : `We sent a 6-digit code to ${setup.phone ?? smsPhone ?? 'your phone'}. It expires in 10 minutes.`}
            </p>
            {method === 'app' && setup.uri && <QrCode value={setup.uri} size={168} label="QR code for your authenticator app" />}
            {method === 'app' && setup.key && <p className="mono strong">{groupKey(setup.key)}</p>}
            <Field label="6-digit code" error={codeErr ?? proofError(confirmSetup.error)}>
              <TextInput id="sc-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} error={!!codeErr || confirmSetup.isError} onChange={(e) => (setCode(e.target.value), confirmSetup.reset())} />
            </Field>
          </>
        )}
        {setup?.step === 'codes' && (
          <>
            <p className="small sub">Each code signs you in once if you lose your phone. We show them only now: save them somewhere safe.</p>
            <ul className="ul mono small">
              {setup.codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}
      </Dialog>

      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Turn off 2-step verification?"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Keep it on
            </Button>
            <Button variant="danger" onClick={() => removeTwoStep.mutate()} disabled={!offPw || !/^\d{6}$/.test(offCode.trim()) || removeTwoStep.isPending}>
              Turn off
            </Button>
          </>
        }
      >
        <p className="small sub">A stolen password alone could then open your account. Confirm with your password and a current code {methodText}.</p>
        {removeTwoStep.isError && <Alert tone="danger" title="We couldn't turn it off">{proofError(removeTwoStep.error)}</Alert>}
        <Field label="Current password">
          <TextInput id="sc-off-pw" type="password" autoComplete="current-password" value={offPw} onChange={(e) => (setOffPw(e.target.value), removeTwoStep.reset())} />
        </Field>
        <Field label="6-digit code">
          <TextInput id="sc-off-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={offCode} onChange={(e) => (setOffCode(e.target.value), removeTwoStep.reset())} />
        </Field>
      </Dialog>
    </AccountLayout>
  );
}
