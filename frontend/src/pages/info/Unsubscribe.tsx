import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { errorMessage } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Button, Checkbox, EmptyState, Icon, KeyValue } from '@marketly/web-shared/ui';
import { isBadToken, useUnsubscribe, type MarketingPreferences } from './data/unsubscribe';

// Email preferences (no design; built in React): the landing page of the "Unsubscribe" link in promotional
// emails and texts, ${STORE_URL}/unsubscribe/unsubscribe?token=… (routes/email-links.tsx sends it here).
// API: POST /api/public/customers/unsubscribe { token, channel? } → MarketingPreferences (data/unsubscribe.ts).
//
// The customer confirms with a button instead of the page unsubscribing on load: mail clients, virus
// scanners and link previews open (prefetch) links in emails, and a page that acted on load would unsubscribe
// people who never clicked. The RFC 8058 one-click (List-Unsubscribe-Post) is a POST the mail client sends
// itself, not a page visit. The token works without signing in; changing anything else needs sign-in
// (Account › Profile).

const ROWS: Array<{ key: keyof MarketingPreferences; label: string }> = [
  { key: 'emailPromotions', label: 'Deals and offers by email' },
  { key: 'smsPromotions', label: 'Deals and offers by text' },
  { key: 'pushPromotions', label: 'Deals and offers in the Android app' },
  { key: 'wishlistAlerts', label: 'Price-drop and back-in-stock alerts' },
];

export default function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get('token')?.trim() ?? '';
  const { signedIn } = useSession();
  const [all, setAll] = useState(false);
  const stop = useUnsubscribe();
  // the last answer stays on screen while "Stop all promotions too" runs (a new mutation clears stop.data)
  const [done, setDone] = useState<MarketingPreferences | null>(null);
  const unsubscribe = (everything: boolean) =>
    stop.mutate(
      { token, all: everything },
      {
        onSuccess: (prefs) => {
          setDone(prefs);
          announce(everything ? 'All promotions stopped' : 'You’re unsubscribed');
        },
      },
    );

  // Profile holds the switches; a visitor is sent to sign-in first and comes back there (AccountLayout).
  const manage = (
    <Button variant="secondary" icon="settings" to={href('account/profile')}>
      {signedIn ? 'Manage email preferences' : 'Sign in to manage preferences'}
    </Button>
  );

  return (
    <StoreLayout appbar={{ title: 'Email preferences', back: href('store/home') }}>
      <div className="container page">
        <section className="card pad stack gap-4" style={{ maxWidth: 620, marginInline: 'auto' }}>
          {!token || isBadToken(stop.error) ? (
            <EmptyState icon="mail-x" as="h1" title={token ? 'This unsubscribe link has expired' : 'This unsubscribe link is incomplete'} action={manage}>
              {token
                ? 'This link is no longer valid. You can still turn promotions off in your account.'
                : 'The link is missing the part that tells us who you are. Open it again from the email, or turn promotions off in your account.'}
            </EmptyState>
          ) : done ? (
            <>
              <div className="stack gap-2">
                <h1 className="h2 row gap-2">
                  <Icon name="mail-check" /> You’re unsubscribed
                </h1>
                <p className="small sub">We’ve recorded your choice. This is what we send you now:</p>
              </div>
              {stop.isError && (
                <Alert tone="danger" title="We couldn’t stop the other promotions">
                  {errorMessage(stop.error)}
                </Alert>
              )}
              <KeyValue pairs={ROWS.map((r) => [r.label, done[r.key] ? 'On' : <strong key={r.key}>Off</strong>])} />
              <p className="row gap-2 small sub top">
                <Icon name="lock" className="ic-sm" />
                <span>Order, delivery, return, refund, case and security messages still reach you: you need them to get your orders safely.</span>
              </p>
              <div className="row gap-2">
                {ROWS.some((r) => done[r.key]) && (
                  <Button variant="ghost" onClick={() => unsubscribe(true)} disabled={stop.isPending}>
                    Stop all promotions too
                  </Button>
                )}
                {manage}
              </div>
            </>
          ) : (
            <>
              <div className="stack gap-2">
                <h1 className="h2">Unsubscribe from promotions</h1>
                <p className="small sub">We’ll stop sending deals and offers on the channel this link came from (usually email). Order, delivery, return and account messages are not affected.</p>
              </div>
              <Checkbox id="us-all" label="Also stop texts, app promotions and wishlist alerts" checked={all} onChange={(e) => setAll(e.target.checked)} />
              {stop.isError && (
                <Alert tone="danger" title="We couldn’t unsubscribe you">
                  {errorMessage(stop.error)}
                </Alert>
              )}
              <div className="row gap-2">
                <Button icon="mail-x" onClick={() => unsubscribe(all)} disabled={stop.isPending}>
                  {stop.isPending ? 'Unsubscribing…' : 'Unsubscribe'}
                </Button>
                {manage}
              </div>
            </>
          )}
        </section>
      </div>
    </StoreLayout>
  );
}
