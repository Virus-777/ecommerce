import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { isoInText } from '../lib/format';
import { href } from '../routes/href';
import { announce } from '../ui/announce';
import { Switch } from '../ui/Forms';
import { iconFor } from '../ui/Icon';
import { addToast, ToastStack, type ToastItem } from '../ui/ToastStack';
import { endIfUnauthorized } from './client';
import { isTokenProblem } from './errors';
import { startLive, type LiveAuth, type LiveEvent } from './live';
import { chime, desktopPermission, desktopSupported, showDesktopAlert, unlockSound, useLiveAlertPrefs, type LiveAudience } from './liveAlerts';
import type { components } from './openapi';
import { useApi } from './provider';
import type { Session } from './session';

// Live notices in the Seller Center and Admin Center (contract: the live notifications brief, docs/api notifications
// stream): keeps the bell and inbox fresh, shows a toast per notice, and (when the person turned them on) a desktop
// notification while the page is hidden and a chime for notices that need action. Mount it once in the signed-in
// part of the app; unmounting stops the stream.

type Notice = components['schemas']['notifications.Notice'];

export interface LiveNotificationsProps {
  audience: LiveAudience;
  /** Who the stream is for (the seller id, the staff account id): a change (store switch) restarts the stream. */
  scope: string;
  /** Where a notice opens in this app: the inbox's own helper, so toasts and the inbox open the same screen. */
  linkOf: (n: Notice) => string | undefined;
  /** Queries a notice changes besides ['notifications'] (e.g. the sidebar's order or return counts). */
  keysFor?: (n: Notice) => QueryKey[];
}

/** An open notice that asks for action: its toast stays until closed, and it chimes. */
const needsAction = (n: Notice) => n.actionRequired && (!n.state || n.state === 'open');

/**
 * How each app's stream gets its token (contract, client rules):
 * - Seller Center: session.token(), which refreshes when needed (and a 401 token_* refreshes once).
 * - Admin Center: only the current token while it is valid. Never refresh for the stream: a refresh is staff
 *   activity and would keep an idle session alive. When it has expired, the client waits (checking every 30 s, and
 *   on every session change) until the person's own activity has refreshed it.
 */
function authFor(session: Session, audience: LiveAudience): LiveAuth {
  const kind = audience === 'admin' ? 'staff' : 'seller';
  const signedIn = () => session.getSnapshot().kind === kind;
  return {
    token: async () => {
      if (!signedIn()) return null;
      return audience === 'admin' ? session.currentToken() : session.token();
    },
    refused: async (status, body) => {
      if (audience === 'seller' && isTokenProblem(status, body)) {
        await session.refresh().catch(() => undefined);
        return;
      }
      // Refused for a reason a refresh can't fix (e.g. session_idle): the Admin Center ends its session, as for any
      // other request; a token problem there waits for the app's next refresh.
      if (!isTokenProblem(status, body)) endIfUnauthorized(session, status, body);
    },
    subscribe: (fn) => session.subscribe(fn),
  };
}

export function LiveNotifications({ audience, scope, linkOf, keysFor }: LiveNotificationsProps) {
  const { session, api, baseUrl } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [prefs] = useLiveAlertPrefs(audience);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // The notices behind the toasts (a toast only keeps what it shows).
  const notices = useRef(new Map<string, Notice>());
  // The stream lives across renders; it reads the latest props and choices from here.
  const latest = useRef({ linkOf, keysFor, prefs, navigate });
  latest.current = { linkOf, keysFor, prefs, navigate };

  const close = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    notices.current.delete(id);
  }, []);

  /** Opens the notice's record like the inbox row does (and marks it read); the inbox when it has no screen here. */
  const openNotice = useCallback(
    (n: Notice) => {
      close(n.id);
      if (!n.readAt) {
        const read =
          audience === 'admin'
            ? api.POST('/api/admin/notifications/inbox/{id}/read', { params: { path: { id: n.id } } })
            : api.POST('/api/seller/notifications/inbox/{id}/read', { params: { path: { id: n.id } } });
        void read.then(() => qc.invalidateQueries({ queryKey: ['notifications'] })).catch(() => {});
      }
      const to = latest.current.linkOf(n) ?? href(audience === 'admin' ? 'admin/inbox' : 'seller/notifications');
      if (/^https?:/.test(to)) window.location.assign(to);
      else latest.current.navigate(to);
    },
    [audience, api, qc, close],
  );
  const openRef = useRef(openNotice);
  openRef.current = openNotice;

  useEffect(() => {
    const onEvent = (e: LiveEvent<Notice>, own: boolean) => {
      // ready: (re)connected. Anything may have changed while the line was down, so the bell and inbox reload.
      if (e.type === 'ready') return void qc.invalidateQueries({ queryKey: ['notifications'] });
      if (e.type !== 'notice') return; // end: the client reconnects or waits by itself
      const n = e.notice;
      const { keysFor, prefs } = latest.current;
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      for (const key of keysFor?.(n) ?? []) void qc.invalidateQueries({ queryKey: key });

      const action = needsAction(n);
      const title = isoInText(n.title);
      const body = isoInText(n.body);
      notices.current.set(n.id, n);
      setToasts((list) => {
        const next = addToast(list, {
          id: n.id,
          title,
          body,
          icon: iconFor(n.icon),
          tone: n.tone,
          sticky: action,
          label: action ? 'Action required' : undefined,
          kind: action ? (n.deadline?.state === 'overdue' ? 'urgent' : 'action') : undefined,
        });
        // Forget the notices whose toasts the limit pushed out.
        for (const id of notices.current.keys()) if (!next.some((t) => t.id === id)) notices.current.delete(id);
        return next;
      });
      announce(`${action ? 'Action required' : 'New notice'}: ${title}`);

      // Desktop and sound only in the tab that holds the stream (a notice never alerts twice), only for notices that
      // arrive now (catch-up ones came while the line was down: the toasts and the inbox show them), never for
      // promotional ones.
      if (!own || e.catchUp || n.category === 'promotional') return;
      if (prefs.desktop && document.hidden) showDesktopAlert({ id: n.id, title, body }, () => openRef.current(n));
      if (prefs.sound && action) chime();
    };
    return startLive<Notice>({
      url: `${baseUrl}/api/${audience}/notifications/stream`,
      // Scoped by seller or staff account, so two tabs acting for different stores each get their own stream.
      name: `marketly-live:${audience}:${scope}`,
      auth: authFor(session, audience),
      onEvent,
    });
  }, [audience, scope, session, baseUrl, qc]);

  // Browsers block audio until the page had a click or key press: unlock it on the first one while Sound is on.
  useEffect(() => {
    if (!prefs.sound) return;
    const unlock = () => void unlockSound();
    document.addEventListener('pointerdown', unlock, { once: true, capture: true });
    document.addEventListener('keydown', unlock, { once: true, capture: true });
    return () => {
      document.removeEventListener('pointerdown', unlock, { capture: true });
      document.removeEventListener('keydown', unlock, { capture: true });
    };
  }, [prefs.sound]);

  return (
    <ToastStack
      items={toasts}
      onClose={close}
      onOpen={(id) => {
        const n = notices.current.get(id);
        if (n) openNotice(n);
      }}
    />
  );
}

/**
 * "Desktop alerts" and "Sound" switches for the notifications page. Desktop alerts ask the browser's permission
 * when turned on; the switch is hidden where the browser can't show them (no API, or not https/localhost).
 */
export function LiveAlertSettings({ audience }: { audience: LiveAudience }) {
  const [prefs, set] = useLiveAlertPrefs(audience);
  const [permission, setPermission] = useState(desktopPermission);
  const canDesktop = desktopSupported();

  const toggleDesktop = async (on: boolean) => {
    if (!on) return set({ desktop: false });
    let p = Notification.permission;
    if (p === 'default') p = await Notification.requestPermission().catch(() => 'denied' as const);
    setPermission(p);
    set({ desktop: p === 'granted' });
  };
  const toggleSound = (on: boolean) => {
    set({ sound: on });
    // This change is a click: unlock audio now and play the chime once, so the person hears what it sounds like.
    if (on) void unlockSound().then(() => chime(true));
  };

  return (
    <span className="row gap-3 wrap">
      {canDesktop && (
        <Switch
          id={`live-desktop-${audience}`}
          label="Desktop alerts"
          checked={prefs.desktop && permission === 'granted'}
          disabled={permission === 'denied'}
          onChange={(e) => void toggleDesktop(e.target.checked)}
        />
      )}
      {canDesktop && permission === 'denied' && <span className="xs muted">Desktop alerts are blocked in this browser’s site settings.</span>}
      <Switch id={`live-sound-${audience}`} label="Sound" checked={prefs.sound} onChange={(e) => toggleSound(e.target.checked)} />
    </span>
  );
}
