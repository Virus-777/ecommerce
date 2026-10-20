import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useSearchParams } from 'react-router';

/**
 * The screen's current view (the design's "state"): `?view=<slug>`, '' for the default.
 * Every design file `<screen>--<slug>.html` maps to `<path>?view=<slug>`, so tabs, wizard
 * steps and open dialogs are linkable and the back button works.
 */
export function useView<T extends string = string>(): [T | '', (next: T | '', opts?: { replace?: boolean }) => void] {
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') ?? '') as T | '';
  const setView = useCallback(
    (next: T | '', opts?: { replace?: boolean }) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next) p.set('view', next);
          else p.delete('view');
          return p;
        },
        { replace: opts?.replace, preventScrollReset: true },
      );
    },
    [setParams],
  );
  return [view, setView];
}

/** Width of the .app container in the design's breakpoints: phone < 768 <= tablet < 1024 <= desktop. */
export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== 'undefined' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}
export const useIsPhone = () => useMediaQuery('(max-width: 767.98px)');

/**
 * Horizontal scroll region (.table-wrap, .steps): toggles .is-scrollable / .at-start / .at-end,
 * which drive the CSS edge fade and the pinned column's shadow. It is a Tab stop only while it scrolls.
 */
export function useScrollRegion<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const w = ref.current;
    if (!w) return;
    const update = () => {
      const max = w.scrollWidth - w.clientWidth;
      const on = max > 1;
      w.classList.toggle('is-scrollable', on);
      w.classList.toggle('at-start', !on || w.scrollLeft <= 1);
      w.classList.toggle('at-end', !on || w.scrollLeft >= max - 1);
      if (on) w.setAttribute('tabindex', '0');
      else if (w !== document.activeElement) w.removeAttribute('tabindex');
    };
    update();
    w.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(w);
    return () => {
      w.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);
  return ref;
}

/** Locks page scroll while a modal is open (body.is-locked, as in the design). */
let locks = 0;
export function useBodyLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    locks++;
    document.body.classList.add('is-locked');
    return () => {
      locks--;
      if (!locks) document.body.classList.remove('is-locked');
    };
  }, [active]);
}

/** Live countdown from a number of seconds; returns [hh, mm, ss] as zero-padded strings. */
export function useCountdown(totalSeconds: number): [string, string, string] {
  const [left, setLeft] = useState(totalSeconds);
  useEffect(() => {
    setLeft(totalSeconds);
    const t = setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [totalSeconds]);
  const pad = (n: number) => String(n).padStart(2, '0');
  return [pad(Math.floor(left / 3600)), pad(Math.floor((left % 3600) / 60)), pad(left % 60)];
}

/** Pixel width of an element, kept up to date (e.g. to draw a chart at its real size). */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Read it now too: ResizeObserver reports on the next rendered frame, which never comes in a hidden tab.
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** `value` once it has stopped changing for `ms` (search boxes: one request after typing, not one per key). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Calls onVisible when the element comes within 200px of the viewport (the next page of a phone list loads before
 * the reader reaches the end). Does nothing where the browser has no IntersectionObserver.
 */
export function useInView<T extends HTMLElement>(onVisible: () => void, enabled: boolean): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

let capturedToken: { path: string; token: string } | null = null;

/**
 * Reads `#token=…` (emailed links: password reset, invitations) once and removes it from the address bar
 * (history.replaceState), so the token never stays in the URL, history or a shared screenshot; '' when there is
 * none. It is kept in memory for this page, so React's development double render or a remount still has it after
 * the fragment is gone.
 */
export function useHashToken(): string {
  const [token] = useState(() => {
    const t = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    if (t) capturedToken = { path: window.location.pathname, token: t };
    return capturedToken?.path === window.location.pathname ? capturedToken.token : '';
  });
  useEffect(() => {
    if (window.location.hash) history.replaceState(history.state, '', window.location.pathname + window.location.search);
  }, []);
  return token;
}
