/**
 * Modal.tsx — the desktop's containers, where the phone has a bottom sheet.
 *
 * The one rule carried over verbatim from Sheet.tsx: **every route out is `onDismiss`**. On a
 * phone that is a drag past 96px; here it is a backdrop click or Escape. For a permission that
 * callback answers DENY, so a dialog can never be closed in a way that leaves the worker blocked
 * on an answer nobody is going to send. A close button that only unmounted the dialog would look
 * fine and hang the session.
 *
 * Focus is moved into the dialog on open and returned on close, and Tab is trapped — with a
 * modal permission prompt, letting focus wander behind the backdrop means the keyboard can reach
 * a Send button for a turn that is still waiting on approval.
 */
import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

function useDialogKeys(onDismiss: () => void, box: { current: HTMLElement | null }, trap: boolean) {
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onDismiss(); return; }
      if (e.key !== 'Tab' || !trap) return;
      const items = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      // Wrap by hand: the backdrop does not stop the browser's own tab order.
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      restore?.focus?.();
    };
  }, [onDismiss, trap]);
}

export function Modal({ children, onDismiss, label, width, tall, align }: {
  children: ReactNode;
  onDismiss: () => void;
  label: string;
  width: number;
  /** Give it most of the viewport height — for a tool output, which is the one long thing. */
  tall?: boolean;
  /**
   * `top` sits it near the top edge instead of centring it. For the ⌘K palette: a list that grows
   * downward as you type would otherwise walk up the screen with every keystroke.
   */
  align?: 'center' | 'top';
}) {
  const box = useRef<HTMLDivElement | null>(null);
  useDialogKeys(onDismiss, box, true);
  return (
    <>
      <div className="backdrop" onClick={onDismiss} />
      <div
        ref={box}
        className={`modal${tall ? ' tall' : ''}${align === 'top' ? ' at-top' : ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </>
  );
}

/**
 * Anchored to the header's ⋯ button rather than centred: a session menu is a list of small
 * choices, and throwing a full modal at "which permission mode" is heavier than the decision.
 * No focus trap — a popover is dismissible by looking away, and Escape still closes it.
 */
export function Popover({ children, onDismiss, label }: {
  children: ReactNode;
  onDismiss: () => void;
  label: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  useDialogKeys(onDismiss, box, false);
  return (
    <>
      {/* Transparent, but present: a click anywhere else closes the popover in one go. */}
      <div className="popover-catch" onClick={onDismiss} />
      <div ref={box} className="popover" role="dialog" aria-label={label}>
        {children}
      </div>
    </>
  );
}
