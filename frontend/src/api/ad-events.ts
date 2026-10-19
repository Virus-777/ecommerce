import { useCallback, useEffect, useRef } from 'react';
import { useApi, type components } from '@marketly/web-shared/api';

// Ad event tracking (POST /api/store/advertising/events) for ad positions and sponsored product cards.

type TrackEvent = components['schemas']['advertising.TrackEvent'];

/** Sends ad events (fire and forget). */
export function useAdEvents() {
  const { api } = useApi();
  return useCallback(
    (events: TrackEvent[]) => {
      if (events.length) void api.POST('/api/store/advertising/events', { body: { events } }).catch(() => undefined);
    },
    [api],
  );
}

/** Impression tokens already counted as displayed on this page load. */
const displayed = new Set<string>();

/**
 * Records `display` once when at least half of the element is on screen. Returns a ref for the element
 * (or for a display: contents wrapper, whose first child is observed) and a click recorder.
 */
export function useAdTracking<E extends HTMLElement>(token: string | null | undefined) {
  const ref = useRef<E>(null);
  const send = useAdEvents();
  useEffect(() => {
    const host = ref.current;
    const el = host && getComputedStyle(host).display === 'contents' ? (host.firstElementChild as HTMLElement | null) : host;
    if (!token || !el || displayed.has(token)) return;
    const shownAt = Date.now();
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || displayed.has(token)) return;
        displayed.add(token);
        send([{ impressionToken: token, kind: 'display', at: new Date().toISOString(), visibleMs: Date.now() - shownAt }]);
        io.disconnect();
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [token, send]);
  const click = useCallback(() => token && send([{ impressionToken: token, kind: 'click', at: new Date().toISOString() }]), [token, send]);
  return { ref, click, send };
}

