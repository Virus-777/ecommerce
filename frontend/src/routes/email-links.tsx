import { Navigate, useLocation, type RouteObject } from 'react-router';
import { href } from '@marketly/web-shared/routes';

// Targets of links in the platform's emails (identity module), which use their own paths:
//   ${STORE_URL}/reset-password#token=…   password reset   → Reset password, "Set new password" view
//   ${STORE_URL}/orders/open#token=…      guest order link → Guest order lookup, which redeems the token
// The token stays in the URL fragment (never sent to a server in a request line or Referer).

function KeepHash({ to }: { to: string }) {
  const { hash } = useLocation();
  return <Navigate replace to={`${to}${hash}`} />;
}

export const EMAIL_LINK_ROUTES: RouteObject[] = [
  { path: '/reset-password', element: <KeepHash to={href('auth/recover', 'set-new-password')} /> },
  { path: '/orders/open', element: <KeepHash to={href('auth/guest-orders')} /> },
];
