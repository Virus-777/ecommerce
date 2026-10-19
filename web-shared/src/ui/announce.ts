let live: HTMLDivElement | null = null;

/** Announces a message in a polite live region (screen readers). */
export function announce(msg: string) {
  if (!live) {
    live = document.createElement('div');
    live.className = 'sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
  }
  const el = live;
  el.textContent = '';
  setTimeout(() => {
    el.textContent = msg;
  }, 40);
}
