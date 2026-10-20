import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx';
import { IconButton } from './Button';
import { Icon, type IconName } from './Icon';

// Toasts for live notices (web-shared api/LiveNotifications.tsx): a stack at the bottom right (full width minus
// 16px gutters on a phone), under dialogs so it never covers a dialog's buttons. Screen readers hear new toasts
// through announce() (the caller's job), so the stack itself is not a live region and nothing is read twice.

export interface ToastItem {
  id: string;
  title: string;
  body?: string;
  icon?: IconName;
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'brand' | 'deal' | 'neutral';
  /** Stays until closed (notices that need action); other toasts hide after 8 s. */
  sticky?: boolean;
  /** Short line above the title, e.g. "Action required". */
  label?: string;
  /** Edge colour: 'urgent' (overdue, red) or 'action' (needs action, amber). */
  kind?: 'urgent' | 'action';
}

/** Toasts on screen at once. */
export const MAX_TOASTS = 3;
const HIDE_AFTER = 8_000;

/** Adds a toast (replacing one with the same id); over the limit, the oldest non-sticky toast goes first. */
export function addToast(list: ToastItem[], item: ToastItem, max = MAX_TOASTS): ToastItem[] {
  const next = [...list.filter((t) => t.id !== item.id), item];
  while (next.length > max) {
    const i = next.findIndex((t) => !t.sticky);
    next.splice(i >= 0 && i < next.length - 1 ? i : 0, 1);
  }
  return next;
}

function Toast({ t, onClose, onOpen }: { t: ToastItem; onClose: (id: string) => void; onOpen?: (id: string) => void }) {
  // Hovering or focusing a toast holds its timer, so it doesn't vanish while someone reads or tabs to it.
  const [held, setHeld] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (t.sticky || held) return;
    const timer = setTimeout(() => close.current(t.id), HIDE_AFTER);
    return () => clearTimeout(timer);
  }, [t.id, t.sticky, held]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose(t.id);
    }
  };
  const text = (
    <>
      {t.label && <span className="l">{t.label}</span>}
      <span className="t">{t.title}</span>
      {t.body && <span className="b">{t.body}</span>}
    </>
  );
  return (
    <div
      className={cx('toast-card', `t-${t.tone ?? 'info'}`, t.kind && `is-${t.kind}`)}
      role="group"
      aria-label={t.label ? `${t.label}: ${t.title}` : t.title}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHeld(false)}
      onKeyDown={onKey}
    >
      <span className="ic" aria-hidden="true">
        <Icon name={t.icon ?? 'bell'} />
      </span>
      {onOpen ? (
        <button type="button" className="toast-main" onClick={() => onOpen(t.id)}>
          {text}
        </button>
      ) : (
        <div className="toast-main">{text}</div>
      )}
      <IconButton icon="x" label="Close" size="sm" onClick={() => onClose(t.id)} />
    </div>
  );
}

/**
 * The toast stack. The caller keeps the list (use addToast to add) and removes a toast in onClose; onOpen (when
 * given) makes the toast's text a button, e.g. to open the notice's record.
 */
export function ToastStack({ items, onClose, onOpen, label = 'New notices' }: { items: ToastItem[]; onClose: (id: string) => void; onOpen?: (id: string) => void; label?: string }) {
  if (!items.length) return null;
  return createPortal(
    <section className="toast-stack" aria-label={label}>
      {items.map((t) => (
        <Toast key={t.id} t={t} onClose={onClose} onOpen={onOpen} />
      ))}
    </section>,
    document.getElementById('root') ?? document.body,
  );
}
