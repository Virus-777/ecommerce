import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx';
import { useBodyLock } from '../lib/hooks';
import { IconButton } from './Button';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Esc to close, Tab kept inside, focus moved in on open and restored on close. */
function useModalBehaviour(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const box = ref.current;
    box?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (!box) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (!box.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.({ preventScroll: true });
    };
  }, [open, ref]);
  useBodyLock(open);
}

const portalRoot = () => document.getElementById('root') ?? document.body;

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Accessible name when the title is not plain text. */
  label?: string;
  /** Footer actions (.modal-foot). */
  foot?: ReactNode;
  size?: 'lg' | 'sm' | '';
  className?: string;
  bodyClassName?: string;
  /** Close when the backdrop is clicked (default true). */
  dismissable?: boolean;
  children: ReactNode;
}

/** Modal dialog; a bottom sheet on the phone layout (design CSS). */
export function Dialog({ open, onClose, title, label, foot, size, className, bodyClassName, dismissable = true, children }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useModalBehaviour(open, onClose, ref);
  if (!open) return null;
  return createPortal(
    <div className="overlay" role="presentation" onMouseDown={(e) => dismissable && e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cx('modal', size, className)} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === 'string' ? title : 'Dialog')} data-dialog="" tabIndex={-1}>
        <div className="grabber" aria-hidden="true" />
        {title && (
          <div className="modal-head">
            <h2 className="h3">{title}</h2>
            <IconButton icon="x" label="Close" onClick={onClose} />
          </div>
        )}
        <div className={cx('modal-body', bodyClassName)}>{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>,
    portalRoot(),
  );
}

/** Side drawer (filters, detail panels). */
export function Drawer({ open, onClose, title, foot, className, children }: { open: boolean; onClose: () => void; title: string; foot?: ReactNode; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useModalBehaviour(open, onClose, ref);
  if (!open) return null;
  return createPortal(
    <div className="overlay is-drawer" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} className={cx('drawer', className)} role="dialog" aria-modal="true" aria-label={title} data-dialog="" tabIndex={-1}>
        <div className="modal-head">
          <h2 className="h3">{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </aside>
    </div>,
    portalRoot(),
  );
}
