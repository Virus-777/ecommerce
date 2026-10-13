import { lazy, Suspense, useEffect, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { createBrowserRouter, Outlet, ScrollRestoration, useRouteError, type RouteObject } from 'react-router';
import { APP_NAMES, CURRENT_APP } from './apps';
import { SCREENS, type ScreenId } from './catalogue';
import DesignIndex from './DesignIndex';
import type { DesignCheckOptions } from './designSamples';

const DesignCheck = lazy(() => import('./DesignCheck'));

type PageMap = Partial<Record<ScreenId, LazyExoticComponent<ComponentType>>>;

/** Keeps document.title in step with the page's h1 (pages load lazily, so it watches for the heading). */
function TitleSync() {
  useEffect(() => {
    const suffix = CURRENT_APP === 'store' ? 'Marketly' : APP_NAMES[CURRENT_APP];
    const update = () => {
      const h1 = document.querySelector<HTMLElement>('main h1, h1')?.textContent?.trim();
      const title = h1 ? `${h1} · ${suffix}` : suffix;
      if (document.title !== title) document.title = title;
    };
    update();
    // Mutation callbacks are batched per task, so this is one cheap query per DOM update.
    const mo = new MutationObserver(update);
    mo.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);
  return null;
}

interface AppRouterOptions {
  /** Lazy page modules of this app, by screen id. */
  pages: PageMap;
  /** Shown for unknown URLs and route errors. */
  notFound: ComponentType;
  /** App-wide providers (session, …) around every route. */
  wrap?: (children: ReactNode) => ReactNode;
  /** Routes outside the screen catalogue (e.g. targets of emailed links that redirect to a screen). */
  extraRoutes?: RouteObject[];
  /** Development only: how /design/check switches this app's session per sample (see DesignCheck). */
  designCheck?: DesignCheckOptions;
}

/**
 * The router every web app uses: one route per screen of this app (catalogue paths), /design (screen
 * index), /design/check (dev only: compares routes with the design export) and a catch-all not-found page.
 */
export function createAppRouter({ pages, notFound: NotFound, wrap = (c) => c, extraRoutes = [], designCheck }: AppRouterOptions) {
  function Root() {
    return wrap(
      <>
        <Suspense fallback={<div className="route-loading" role="status" aria-label="Loading" />}>
          <Outlet />
        </Suspense>
        <TitleSync />
        <ScrollRestoration />
      </>,
    );
  }

  function RouteError() {
    const err = useRouteError();
    if (import.meta.env.DEV) console.error(err);
    return wrap(
      <Suspense fallback={null}>
        <NotFound />
      </Suspense>,
    );
  }

  const screenRoutes: RouteObject[] = SCREENS.filter((s) => s.app === CURRENT_APP).map((s) => {
    const Page = pages[s.id];
    if (!Page) throw new Error(`No page module for ${s.id}`);
    return { path: s.path, element: <Page /> };
  });

  return createBrowserRouter([
    {
      element: <Root />,
      errorElement: <RouteError />,
      children: [
        ...screenRoutes,
        ...extraRoutes,
        { path: '/design', element: <DesignIndex /> },
        ...(import.meta.env.DEV ? [{ path: '/design/check', element: <DesignCheck {...designCheck} /> }] : []),
        { path: '*', element: <NotFound /> },
      ],
    },
  ]);
}
