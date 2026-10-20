import { useCallback, useSyncExternalStore } from 'react';

// The extra alerts for live notices besides the toast: desktop notifications (Notification API) and a short chime
// (Web Audio, generated: no sound file to ship). Each person turns them on per app and browser ("Desktop alerts",
// "Sound" on the notifications page); the choice is kept in localStorage.

export type LiveAudience = 'seller' | 'admin';

export interface LiveAlertPrefs {
  desktop: boolean;
  sound: boolean;
}

const OFF: LiveAlertPrefs = { desktop: false, sound: false };
const keyOf = (audience: LiveAudience) => `marketly.liveAlerts.${audience}`;
const cache = new Map<LiveAudience, LiveAlertPrefs>();
const listeners = new Set<() => void>();

/** The saved choice (both off when nothing is saved or storage is blocked). */
export function readLiveAlertPrefs(audience: LiveAudience): LiveAlertPrefs {
  let p = cache.get(audience);
  if (!p) {
    try {
      const raw = JSON.parse(localStorage.getItem(keyOf(audience)) ?? 'null') as Partial<LiveAlertPrefs> | null;
      p = { desktop: raw?.desktop === true, sound: raw?.sound === true };
    } catch {
      p = OFF;
    }
    cache.set(audience, p);
  }
  return p;
}

function writeLiveAlertPrefs(audience: LiveAudience, change: Partial<LiveAlertPrefs>) {
  const p = { ...readLiveAlertPrefs(audience), ...change };
  cache.set(audience, p);
  try {
    localStorage.setItem(keyOf(audience), JSON.stringify(p));
  } catch {
    /* private window or blocked storage: the choice lasts until the page closes */
  }
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  // Another tab changed the choice: read it again (the stream tab is the one that alerts).
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith('marketly.liveAlerts.')) {
      cache.clear();
      fn();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** The choice for this app, re-rendering on change (in this tab or another). */
export function useLiveAlertPrefs(audience: LiveAudience): [LiveAlertPrefs, (change: Partial<LiveAlertPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, () => readLiveAlertPrefs(audience));
  const set = useCallback((change: Partial<LiveAlertPrefs>) => writeLiveAlertPrefs(audience, change), [audience]);
  return [prefs, set];
}

/**
 * Desktop notifications work here: the API exists and the page is a secure context (https, or localhost).
 * The Admin Center opened over plain http on the office LAN is not one, so the toggle is hidden there.
 */
export const desktopSupported = (): boolean => typeof Notification === 'function' && typeof window !== 'undefined' && window.isSecureContext;

/** 'granted' | 'denied' | 'default' (not asked yet); 'denied' when unsupported. */
export const desktopPermission = (): NotificationPermission => (desktopSupported() ? Notification.permission : 'denied');

/** Shows a desktop notification; `tag` = the notice id, so the browser never shows one notice twice. */
export function showDesktopAlert(n: { id: string; title: string; body?: string }, onClick: () => void): void {
  if (!desktopSupported() || Notification.permission !== 'granted') return;
  try {
    const note = new Notification(n.title, { body: n.body, tag: n.id, icon: '/favicon.svg' });
    note.onclick = () => {
      window.focus();
      onClick();
      note.close();
    };
  } catch {
    /* some browsers (Android Chrome) only allow notifications from a service worker */
  }
}

let audio: AudioContext | null = null;
let lastChime = 0;
const CHIME_GAP = 10_000;

/**
 * Creates or resumes the audio context. Browsers keep audio blocked until the page had a click or key press, so
 * call this from one (LiveNotifications does on the first click or key press while Sound is on).
 */
export async function unlockSound(): Promise<void> {
  try {
    // Created before the first await, so it is still inside the click or key press.
    audio ??= new AudioContext();
    if (audio.state === 'suspended') await audio.resume();
  } catch {
    /* no Web Audio, or still blocked: chime() stays silent */
  }
}

/** A short two-tone chime, at most once per 10 s (a burst of notices beeps once). `force` skips that limit. */
export function chime(force = false): void {
  if (!audio || audio.state !== 'running') return;
  const now = Date.now();
  if (!force && now - lastChime < CHIME_GAP) return;
  lastChime = now;
  const t0 = audio.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = audio!.createOscillator();
    const gain = audio!.createGain();
    const start = t0 + i * 0.16;
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Fade in and out: a hard start or stop clicks.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
    osc.connect(gain).connect(audio!.destination);
    osc.start(start);
    osc.stop(start + 0.32);
  });
}
