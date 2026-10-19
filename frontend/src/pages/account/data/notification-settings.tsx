// "What we send" (Account › Profile): the notices a customer always gets and where they arrive, from
// GET /api/store/notifications/preferences. Essential notices (orders, payment, delivery, returns, refunds,
// cases, security) can't be turned off; promotional consent is the Profile's "Promotions and offers" switches
// (customers module, the API's `promotional` pointer). Order-update push notices on the Android app are
// launch phase 3: the switch (PUT …/preferences/push) only shows when the API says push is available.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Button, Card, Icon, Switch } from '@marketly/web-shared/ui';

type Prefs = components['schemas']['notifications.CustomerNotificationPreferences'];

const KEY = ['notifications', 'preferences'];

/** Channel keys the API uses in essential.channels. */
const CHANNEL_LABEL: Record<string, string> = { in_app: 'In your account', email: 'By email', push: 'Android app', sms: 'By text message' };

export function WhatWeSend() {
  const { api } = useApi();
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: KEY, queryFn: () => call(api.GET('/api/store/notifications/preferences')) });
  const setPush = useMutation({
    mutationFn: (orderUpdates: boolean) => call(api.PUT('/api/store/notifications/preferences/push', { body: { orderUpdates } })),
    onSuccess: (push) => {
      qc.setQueryData<Prefs>(KEY, (p) => (p ? { ...p, push } : p));
      announce(push.orderUpdates ? 'Order updates on the app turned on' : 'Order updates on the app turned off');
    },
    // essential.channels lists push only while it is on
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
  const p = prefs.data;
  const push = p?.push;

  return (
    <Card title="What we send" titleAs="h3" sub="Order and account messages are always on: you need them to receive your orders safely.">
      {prefs.isError ? (
        <Alert tone="danger" title="We couldn't load what we send">
          {errorMessage(prefs.error)}{' '}
          <Button variant="ghost" size="sm" onClick={() => void prefs.refetch()}>
            Try again
          </Button>
        </Alert>
      ) : !p ? (
        <div className="stack gap-2" aria-hidden="true">
          <span className="sk sk-line" />
          <span className="sk sk-line short" />
        </div>
      ) : (
        <>
          <div className="row gap-2 small top nowrap">
            <Icon name="lock" className="ic-sm" />
            <span className="sub">{p.essential.note}</span>
          </div>
          <div className="row gap-2 xs">
            <span className="muted">Where they arrive:</span>
            {p.essential.channels.map((c) => (
              <span key={c} className="strong">
                {CHANNEL_LABEL[c] ?? c}
              </span>
            ))}
          </div>
          {p.essential.topics.length > 0 && (
            <details>
              <summary className="small strong">See all {p.essential.topics.length} message types</summary>
              <p className="xs sub" style={{ marginTop: 'var(--sp-2)' }}>
                {p.essential.topics.join(' · ')}
              </p>
            </details>
          )}
          {push?.available && (
            <div className="acct-pref">
              <span className="stack gap-0">
                <span className="small strong">Order updates on the Android app</span>
                <span className="xs muted">
                  {push.devices.length
                    ? `Push notifications on ${push.devices.length === 1 ? 'your phone' : `${push.devices.length} devices`}. Emails and your account still get every update.`
                    : 'Sign in to the Marketly Android app and allow notifications to get these.'}
                </span>
              </span>
              <Switch
                id="pf-push-orders"
                label={<span className="sr-only">Order updates on the Android app</span>}
                checked={push.devices.length > 0 && push.orderUpdates}
                disabled={!push.devices.length || setPush.isPending}
                onChange={(e) => setPush.mutate(e.target.checked)}
              />
            </div>
          )}
          {setPush.isError && <Alert tone="danger" title="We couldn't change that setting">{errorMessage(setPush.error)}</Alert>}
        </>
      )}
      <Link className="small strong" to={href('account/notifications')}>
        See recent notifications
      </Link>
    </Card>
  );
}
