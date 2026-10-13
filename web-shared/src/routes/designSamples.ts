import { useEffect, useState } from 'react';
import { href } from './href';
import type { ScreenId } from './catalogue';

// Design samples (dev only): which live record and which session each screen view is checked against.
// Written by the seed's `design` step to web-shared/.seed/design-samples.json (git-ignored) and served by the
// dev server through /@fs/. Keys are "<screenId>@<view>" ('' for the default view).

export type SampleSession = 'customer' | 'visitor';

export interface DesignSample {
  /** Path params (fall back to the catalogue's `sample`). */
  params?: Record<string, string>;
  query?: Record<string, string>;
  /** The session the view needs; rows without one keep the current session. */
  session?: SampleSession;
  /** Requests made in that session before the page opens (e.g. a visitor's cart, a guest order look-up). */
  before?: Array<{ method: 'POST' | 'PUT' | 'DELETE'; path: string; body?: unknown }>;
  note?: string;
}

export interface DesignSamplesFile {
  generatedAt?: string;
  note?: string;
  /** The customer the `customer` session signs in as (dev Google sign-in). */
  customer?: { email: string; first: string; last: string };
  samples: Record<string, DesignSample>;
}

/** How /design/check puts this app in a sample's session. Only the store has customer and visitor sessions yet. */
export interface DesignCheckSessions {
  /** Signed out: the next request starts a fresh visitor session (empty guest cart). */
  visitor: () => Promise<void>;
  /** Signed in as the samples' customer (dev Google sign-in), with a fresh session. */
  customer: (who: { email: string; first: string; last: string }) => Promise<void>;
}

/** Per-app options of the design check: a hook returning the app's session switches (called inside the app's providers). */
export interface DesignCheckOptions {
  useSessions?: () => DesignCheckSessions;
}

export type SamplesState = { status: 'loading' } | { status: 'missing'; reason: string } | { status: 'ready'; file: DesignSamplesFile };

/**
 * The seed folder from the dev-only define. A dev server started before the define existed (Vite reads its config
 * once) has none: the folder sits next to the design export (web-shared/.design → web-shared/.seed).
 */
function samplesUrl(): string | null {
  const dir = typeof __SEED_DIR__ === 'string' ? __SEED_DIR__ : typeof __DESIGN_DIR__ === 'string' ? __DESIGN_DIR__.replace(/\/\.design$/, '/.seed') : null;
  return dir ? `/@fs/${dir.replace(/^\/+/, '')}/design-samples.json` : null;
}

/** Reads the samples file from the dev server (in production builds: always missing). */
export function useDesignSamples(): SamplesState {
  const [state, setState] = useState<SamplesState>(() => (import.meta.env.DEV ? { status: 'loading' } : { status: 'missing', reason: 'development only' }));
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const url = samplesUrl();
    if (!url) return setState({ status: 'missing', reason: 'the dev server defines no seed folder' });
    let live = true;
    fetch(url, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        const file = (await r.json()) as DesignSamplesFile;
        if (live) setState({ status: 'ready', file: { ...file, samples: file.samples ?? {} } });
      })
      .catch(() => live && setState({ status: 'missing', reason: 'no web-shared/.seed/design-samples.json: run "npm run seed -- --only design"' }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

export const sampleKey = (id: string, view: string) => `${id}@${view}`;

/** The screen view's URL with its sample's params and query (the catalogue example without a sample). */
export function sampleHref(id: ScreenId, view: string, sample?: DesignSample): string {
  return href(id, view, sample?.params, sample?.query);
}
