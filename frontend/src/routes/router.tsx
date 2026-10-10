import { lazy, Suspense, useEffect } from 'react';
import { createBrowserRouter, Outlet, ScrollRestoration, useLocation, useRouteError, type RouteObject } from 'react-router';
import { SessionProvider } from '@/app/session';
import { SCREENS } from './catalogue';
import { PAGES } from './pages';
import DesignIndex from './DesignIndex';

const DesignCheck = lazy(() => import('./DesignCheck'));

const TITLE_SUFFIX: Record<string, string> = { theme: 'Design system', store: 'Marketly', seller: 'Seller Center', admin: 'Admin Center', ops: 'Operations' };

/** Sets document.title from the matched screen. */
function TitleSync() {
  const { pathname } = useLocation();
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('main h1, h1');
    const h1 = el?.textContent?.trim();
    const area = SCREENS.find((s) => s.path !== '/' && pathname.startsWith(s.path.split('/:')[0]))?.area ?? 'store';
    document.title = h1 ? `${h1} · ${TITLE_SUFFIX[area]}` : 'Marketly';
  });
  return null;
}

function Root() {
  return (
    <SessionProvider>
      <Suspense fallback={<div className="route-loading" role="status" aria-label="Loading" />}>
        <Outlet />
      </Suspense>
      <TitleSync />
      <ScrollRestoration />
    </SessionProvider>
  );
}

function RouteError() {
  const err = useRouteError() as Error | undefined;
  const NotFound = PAGES['store/not-found'];
  if (import.meta.env.DEV) console.error(err);
  return (
    <SessionProvider>
      <Suspense fallback={null}>
        <NotFound />
      </Suspense>
    </SessionProvider>
  );
}

const screenRoutes: RouteObject[] = SCREENS.map((s) => {
  const Page = PAGES[s.id];
  return { path: s.path, element: <Page /> };
});
const NotFound = PAGES['store/not-found'];

export const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteError />,
    children: [...screenRoutes, { path: '/design', element: <DesignIndex /> },
      ...(import.meta.env.DEV ? [{ path: '/design/check', element: <DesignCheck /> }] : []), { path: '*', element: <NotFound /> }],
  },
]);
