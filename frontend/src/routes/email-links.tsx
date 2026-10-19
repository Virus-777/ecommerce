import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation, useParams, type RouteObject } from 'react-router';
import { useSession } from '@/app/session';
import { StoreLayout } from '@/layouts';
import { errorMessage, useApi } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Button, EmptyState } from '@marketly/web-shared/ui';
import { isMissing, LINK_TARGETS, type LinkTarget } from './email-link-targets';

// Targets of links in the platform's emails, which use their own paths:
//   ${STORE_URL}/reset-password#token=…          password reset   → Reset password, "Set new password" view
//   ${STORE_URL}/orders/open#token=…             guest order link → Guest order lookup, which redeems the token
//   ${STORE_URL}/unsubscribe/unsubscribe?token=… promotional email footer → Email preferences (/unsubscribe)
//   ${STORE_URL}/<screen>/<id>                   any notice without its own url → the record's screen
//                                                (email-link-targets.ts: account/order/<orderId> → /account/orders/MK-…)
// Tokens in a fragment stay in the URL fragment (never sent to a server in a request line or Referer).
//
// These paths don't clash with catalogue routes: the catalogue uses plural segments (/account/orders/:ref,
// /help/cases/:ref), and where both have three segments (/account/reviews/new) react-router ranks the static
// segment above our :id.

function KeepHash({ to }: { to: string }) {
  const { hash } = useLocation();
  return <Navigate replace to={`${to}${hash}`} />;
}

function KeepQuery({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate replace to={`${to}${search}`} />;
}

/** Shown while a link is looked up, and when it can't be opened. */
function LinkFrame({ children }: { children: ReactNode }) {
  return (
    <StoreLayout appbar={{ title: 'Opening link', back: href('store/home') }}>
      <div className="container page">{children}</div>
    </StoreLayout>
  );
}

/**
 * /<screen>/<id> from a notice: looks the record up (uuid → ref) and replaces the URL with the real screen.
 * A visitor whose session can't see the record goes to sign-in and comes back to this link afterwards (the
 * lookup then runs as the customer); a signed-in customer who can't open it is told so and offered the list.
 */
function ResolveLink({ target }: { target: LinkTarget }) {
  const { id = '' } = useParams();
  const { api } = useApi();
  const { ready, signedIn } = useSession();
  const location = useLocation();
  const resolve = target.resolve;
  const q = useQuery({
    queryKey: ['email-link', target.screen, id, signedIn],
    queryFn: () => resolve!(api, id, signedIn),
    enabled: ready && !!resolve,
    retry: false,
    staleTime: Infinity,
  });

  if (!resolve) return <Navigate replace to={target.to ? target.to(id) : href('store/home')} />;
  if (q.data) return <Navigate replace to={q.data} />;
  if (q.isError) {
    if (isMissing(q.error) && !signedIn) return <Navigate replace to={href('auth/sign-in', '', undefined, { next: location.pathname })} />;
    const f = target.fallback;
    return (
      <LinkFrame>
        {isMissing(q.error) && f ? (
          <EmptyState icon={f.icon} as="h1" title={f.title} action={<Button to={f.to}>{f.label}</Button>}>
            {f.body}
          </EmptyState>
        ) : (
          <EmptyState icon="triangle-alert" as="h1" title="We couldn’t open this link" action={<Button onClick={() => void q.refetch()}>Try again</Button>}>
            {errorMessage(q.error)}
          </EmptyState>
        )}
      </LinkFrame>
    );
  }
  return (
    <LinkFrame>
      <div className="route-loading" role="status" aria-label="Opening the link" />
    </LinkFrame>
  );
}

export const EMAIL_LINK_ROUTES: RouteObject[] = [
  { path: '/reset-password', element: <KeepHash to={href('auth/recover', 'set-new-password')} /> },
  { path: '/orders/open', element: <KeepHash to={href('auth/guest-orders')} /> },
  // notifications/app/sender.ts builds the unsubscribe link as screen "unsubscribe" with id "unsubscribe"
  { path: '/unsubscribe/unsubscribe', element: <KeepQuery to={href('info/unsubscribe')} /> },
  ...LINK_TARGETS.map((t): RouteObject => ({ path: `/${t.screen}/:id`, element: <ResolveLink target={t} /> })),
];
