import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './icons';
import './Dialog.css';

/**
 * Modal dialog: focus trap, Esc and backdrop close, focus restored on unmount.
 *
 * This replaces `window.confirm`, which was synchronous — which is why the
 * store's discard flow carries a continuation instead of a boolean.
 */

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Buttons for the action row; the primary one should come last. */
  footer?: ReactNode;
  width?: number;
}

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, footer, width = 420 }: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;

      // Cycle focus inside the panel.
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // Capture phase: the dialog owns Esc before the app's own shortcuts see it.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        ref={panelRef}
      >
        <header className="dialog-head">
          <h4>{title}</h4>
          <button className="btn-icon" onClick={onClose} aria-label="Close dialog">
            <CloseIcon size={15} />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}
