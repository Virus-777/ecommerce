import { useState } from 'react';
import { Link } from 'react-router';
import { AccountLayout } from '@/layouts';
import { href } from '@/routes/href';
import { Alert, Badge, Button, Card, Dialog, Field, Icon, OptionCard, StatusBadge, TableWrap, TextInput, type IconName } from '@/ui';

// Design: pages/store/account-security.html (one view): password change, 2-step verification,
// email verification, signed-in devices and recent security activity.

interface Session {
  id: string;
  icon: IconName;
  name: string;
  where: string;
  current?: boolean;
}

const SESSIONS: Session[] = [
  { id: 's1', icon: 'monitor', name: 'Chrome on Windows 11', where: 'Portland, OR · Active now', current: true },
  { id: 's2', icon: 'smartphone', name: 'Marketly app on Pixel 8', where: 'Portland, OR · Today, 8:02 AM' },
  { id: 's3', icon: 'laptop', name: 'Safari on macOS', where: 'Seattle, WA · Sep 29, 4:47 PM' },
];

interface Activity {
  date: string;
  what: string;
  device: string;
  result: 'Completed' | 'Failed';
}

const ACTIVITY: Activity[] = [
  { date: 'Oct 6, 9:12 AM', what: 'Signed in', device: 'Chrome on Windows · Portland, OR', result: 'Completed' },
  { date: 'Oct 2, 7:30 PM', what: 'Password changed', device: 'Marketly app on Pixel 8 · Portland, OR', result: 'Completed' },
  { date: 'Sep 29, 4:47 PM', what: 'Signed in on a new device', device: 'Safari on macOS · Seattle, WA', result: 'Completed' },
  { date: 'Sep 27, 11:03 PM', what: '3 wrong passwords, sign-in blocked for 15 min', device: 'Unknown browser · Phoenix, AZ', result: 'Failed' },
];

type Method = 'app' | 'sms';
const pw0 = { cur: '', next: '', conf: '' };

export default function Security() {
  const [pw, setPw] = useState(pw0);
  const [pwTried, setPwTried] = useState(false);
  const [changedOn, setChangedOn] = useState('Oct 2, 2026');
  const [pwDone, setPwDone] = useState(false);
  const [method, setMethod] = useState<Method>('app');
  const [twoStep, setTwoStep] = useState<Method | null>(null);
  const [setup, setSetup] = useState(false);
  const [code, setCode] = useState('');
  const [codeTried, setCodeTried] = useState(false);
  const [sessions, setSessions] = useState(SESSIONS);
  const [activity, setActivity] = useState(ACTIVITY);

  const pwErr = pwTried
    ? {
        cur: pw.cur ? undefined : 'Enter your current password.',
        next: pw.next.length >= 12 ? (pw.next === pw.cur ? 'Choose a password different from your current one.' : undefined) : 'Use at least 12 characters.',
        conf: pw.conf === pw.next ? undefined : "The passwords don't match.",
      }
    : {};
  const codeErr = codeTried && !/^\d{6}$/.test(code.trim()) ? 'Enter the 6-digit code.' : undefined;

  const log = (what: string) => setActivity((a) => [{ date: 'Oct 10, just now', what, device: 'Chrome on Windows · Portland, OR', result: 'Completed' }, ...a]);

  const changePassword = () => {
    setPwTried(true);
    if (!pw.cur || pw.next.length < 12 || pw.next === pw.cur || pw.conf !== pw.next) return;
    setPw(pw0);
    setPwTried(false);
    setPwDone(true);
    setChangedOn('Oct 10, 2026');
    log('Password changed');
  };
  const confirmCode = () => {
    setCodeTried(true);
    if (!/^\d{6}$/.test(code.trim())) return;
    setTwoStep(method);
    setSetup(false);
    setCode('');
    setCodeTried(false);
    log('2-step verification turned on');
  };
  const signOut = (id: string) => setSessions((s) => s.filter((x) => x.id !== id));
  const signOutAll = () => {
    setSessions((s) => s.filter((x) => x.current));
    log('Signed out on all other devices');
  };

  return (
    <AccountLayout active="security" title="Sign-in and security">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Sign-in and security</h1>
          <p className="small sub">Keep your account and saved payment methods safe.</p>
        </div>
      </div>
      {twoStep ? (
        <Alert tone="success" title="2-step verification is on">
          We'll ask for a code {twoStep === 'app' ? 'from your authenticator app' : 'sent to (503) •••-0148'} when you sign in on a new device.
        </Alert>
      ) : (
        <Alert tone="warning" title="2-step verification is off">
          Turn it on so a stolen password alone can't open your account.
        </Alert>
      )}
      <div className="grid lg2 u-items-start">
        <Card
          title="Password"
          sub={`Last changed ${changedOn}`}
          foot={<Button onClick={changePassword}>Change password</Button>}
        >
          {pwDone && <Alert tone="success" title="Password changed">Other devices stay signed in. Sign them out below if you don't recognize one.</Alert>}
          <Field label="Current password" error={pwErr.cur}>
            <TextInput id="sc-cur" type="password" value={pw.cur} error={!!pwErr.cur} autoComplete="current-password" onChange={(e) => (setPw({ ...pw, cur: e.target.value }), setPwDone(false))} />
          </Field>
          <Field label="New password" hint="At least 12 characters. Avoid passwords you use elsewhere." error={pwErr.next}>
            <TextInput id="sc-new" type="password" value={pw.next} error={!!pwErr.next} autoComplete="new-password" onChange={(e) => (setPw({ ...pw, next: e.target.value }), setPwDone(false))} />
          </Field>
          <Field label="Confirm new password" error={pwErr.conf}>
            <TextInput id="sc-conf" type="password" value={pw.conf} error={!!pwErr.conf} autoComplete="new-password" onChange={(e) => (setPw({ ...pw, conf: e.target.value }), setPwDone(false))} />
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
            actions={<Badge tone={twoStep ? 'success' : 'warning'}>{twoStep ? 'On' : 'Off'}</Badge>}
            foot={
              twoStep ? (
                <Button variant="secondary" onClick={() => (setTwoStep(null), log('2-step verification turned off'))}>
                  Turn off 2-step verification
                </Button>
              ) : (
                <Button icon="shield-check" onClick={() => setSetup(true)}>
                  Turn on 2-step verification
                </Button>
              )
            }
          >
            <div className="stack gap-2" role="radiogroup" aria-label="Verification method">
              <OptionCard
                id="sc-2sv-app"
                name="sc-2sv"
                checked={method === 'app'}
                disabled={!!twoStep}
                onChange={() => setMethod('app')}
                title={
                  <>
                    <span className="strong">Authenticator app</span> <Badge tone="brand">Recommended</Badge>
                  </>
                }
                body="Google Authenticator, 1Password or similar."
              />
              <OptionCard id="sc-2sv-sms" name="sc-2sv" checked={method === 'sms'} disabled={!!twoStep} onChange={() => setMethod('sms')} title={<span className="strong">Text message</span>} body="Codes sent to (503) •••-0148." />
            </div>
          </Card>
          <Card title="Email verification" titleAs="h3">
            <div className="row between">
              <span className="stack gap-0">
                <span className="small strong">jordan.lee@example.com</span>
                <span className="xs muted">Verified Aug 12, 2026. Security alerts go here.</span>
              </span>
              <Badge tone="info">Verified</Badge>
            </div>
          </Card>
        </div>
      </div>
      <Card
        title="Where you're signed in"
        titleAs="h3"
        sub={`${sessions.length} device${sessions.length > 1 ? 's' : ''}`}
        actions={
          <Button variant="danger-soft" size="sm" icon="log-out" onClick={signOutAll} disabled={sessions.length < 2}>
            Sign out everywhere
          </Button>
        }
        flush
      >
        {sessions.map((s) => (
          <div key={s.id} className="acct-row">
            <span className="acct-ic">
              <Icon name={s.icon} className="ic-sm" />
            </span>
            <span className="stack gap-0 grow">
              <span className="small strong">
                {s.name} {s.current && <Badge tone="brand">This device</Badge>}
              </span>
              <span className="xs muted">{s.where}</span>
            </span>
            {!s.current && (
              <Button variant="secondary" size="sm" onClick={() => signOut(s.id)}>
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
              {activity.map((a, i) => (
                <tr key={i}>
                  <td>{a.date}</td>
                  <td>{a.what}</td>
                  <td>{a.device}</td>
                  <td>
                    <StatusBadge status={a.result} tone={a.result === 'Failed' ? 'danger' : 'success'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <Dialog
        open={setup}
        onClose={() => setSetup(false)}
        title={method === 'app' ? 'Set up your authenticator app' : 'Verify your phone'}
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setSetup(false)}>
              Cancel
            </Button>
            <Button icon="shield-check" onClick={confirmCode}>
              Turn on
            </Button>
          </>
        }
      >
        <p className="small sub">
          {method === 'app'
            ? 'Add Marketly in your authenticator app with this setup key, then enter the 6-digit code it shows.'
            : 'We sent a 6-digit code to (503) •••-0148. It expires in 10 minutes.'}
        </p>
        {method === 'app' && <p className="mono strong">MKTL 7Q2D 9XWE 4B8N</p>}
        <Field label="6-digit code" error={codeErr}>
          <TextInput id="sc-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} error={!!codeErr} onChange={(e) => setCode(e.target.value)} />
        </Field>
      </Dialog>
    </AccountLayout>
  );
}
