import { lazy, Suspense, useEffect, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { createBrowserRouter, isRouteErrorResponse, Outlet, ScrollRestoration, useRouteError, type RouteObject } from 'react-router';
import { Button, EmptyState } from '../ui';
import { APP_NAMES, CURRENT_APP } from './apps';
import { SCREENS, type ScreenId } from './catalogue';
import DesignIndex from './DesignIndex';

const DesignCheck = lazy(() => import('./DesignCheck'));

/** A lazy page's code failed to load: usually stale after a deploy or a dev-server restart. */
const isChunkError = (e: unknown) => /dynamically imported module|Importing a module script failed|Failed to fetch|ChunkLoadError|error loading dynamically/i.test(String((e as Error | undefined)?.message ?? e));
const RELOADED = 'marketly.chunk-reload';

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
}

/**
 * The router every web app uses: one route per screen of this app (catalogue paths), /design (screen
 * index), /design/check (compares routes with the design export) and a catch-all not-found page.
 * The design showcase (the design system pages under /design, the ad format samples under /ads and the screen
 * index) runs on sample data, so production builds leave it out.
 */
/** Design showcase screens (sample data only): the design system pages and the ad format samples. */
const isShowcase = (id: string) => id.startsWith('theme/') || id.startsWith('ads/');

export function createAppRouter({ pages, notFound: NotFound, wrap = (c) => c, extraRoutes = [] }: AppRouterOptions) {
  function Root() {
    // A page rendered: the one-time reload for stale page code (RouteError) may happen again later.
    useEffect(() => {
      try {
        sessionStorage.removeItem(RELOADED);
      } catch {
        /* storage blocked */
      }
    }, []);
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

  /**
   * Route errors: stale page code reloads the page once (it was fetched under an old address); a 404 shows the
   * app's not-found page; anything else says something went wrong, with a reload, instead of claiming the page
   * doesn't exist.
   */
  function RouteError() {
    const err = useRouteError();
    if (import.meta.env.DEV) console.error(err);
    const chunk = isChunkError(err);
    useEffect(() => {
      if (!chunk) return;
      let again = false;
      try {
        again = sessionStorage.getItem(RELOADED) === location.pathname;
        sessionStorage.setItem(RELOADED, location.pathname);
      } catch {
        /* storage blocked: reload anyway, once per render */
      }
      if (!again) location.reload();
    }, [chunk]);
    if (isRouteErrorResponse(err) && err.status === 404) {
      return wrap(
        <Suspense fallback={null}>
          <NotFound />
        </Suspense>,
      );
    }
    return (
      <main className="container page" id="main">
        <EmptyState
          icon="triangle-alert"
          as="h1"
          title={chunk ? 'This page was updated' : 'Something went wrong'}
          action={<Button onClick={() => location.reload()}>Reload the page</Button>}
        >
          {chunk ? 'A newer version is available. Reload to continue.' : 'The page hit an error. Reload to try again; if it keeps happening, tell the Marketly team what you were doing.'}
        </EmptyState>
      </main>
    );
  }

  const screenRoutes: RouteObject[] = SCREENS.filter((s) => s.app === CURRENT_APP && (import.meta.env.DEV || !isShowcase(s.id))).map((s) => {
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
        ...(import.meta.env.DEV
          ? [
              { path: '/design', element: <DesignIndex /> },
              { path: '/design/check', element: <DesignCheck /> },
            ]
          : []),
        { path: '*', element: <NotFound /> },
      ],
    },
  ]);
}
