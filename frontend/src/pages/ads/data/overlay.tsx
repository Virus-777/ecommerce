// Overlay for ad formats whose dialog markup differs from the shared .modal (opening ad, coupon
// pop-up, announcement toast, interstitial). Modal ones trap focus, close on Esc and lock page
// scroll; the announcement toast is non-modal (no lock, no trap: QA m-10).
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@marketly/web-shared/lib/cx';
import { useBodyLock } from '@marketly/web-shared/lib/hooks';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface AdOverlayProps {
  open: boolean;
  onClose: () => void;
  /** Extra classes on .overlay (shop-oa, shop-clear). */
  overlayClassName?: string;
  /** Class of the dialog element (ad, shop-pop, shop-announce, shop-inter). */
  className: string;
  label?: string;
  labelledBy?: string;
  modal?: boolean;
  /** Close when the dimmed backdrop is clicked. */
  backdropCloses?: boolean;
  children: ReactNode;
}

export function AdOverlay({ open, onClose, overlayClassName, className, label, labelledBy, modal = true, backdropCloses = false, children }: AdOverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useBodyLock(open && modal);

  useEffect(() => {
    if (!open) return;
    const box = ref.current;
    const prev = document.activeElement as HTMLElement | null;
    if (modal) box?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (!modal || e.key !== 'Tab' || !box) return;
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
      if (modal) prev?.focus?.({ preventScroll: true });
    };
  }, [open, modal]);

  if (!open) return null;
  return createPortal(
    <div
      className={cx('overlay', overlayClassName)}
      role="presentation"
      // .overlay is position:absolute unless body.is-locked; a non-modal toast never locks the body, so pin it to the viewport here.
      style={modal ? undefined : { position: 'fixed' }}
      onMouseDown={(e) => backdropCloses && e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={className} role="dialog" aria-modal={modal ? 'true' : undefined} aria-label={label} aria-labelledby={labelledBy} data-dialog="" tabIndex={-1}>
        {children}
      </div>
    </div>,
    document.getElementById('root') ?? document.body,
  );
}
