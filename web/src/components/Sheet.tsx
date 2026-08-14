/**
 * Sheet.tsx — the bottom sheet all three modal surfaces share (permission 1d, raw output 1e,
 * session menu 1h).
 *
 * The design's one hard rule about dismissal: a drag past 96px (or a flick over 600px/s)
 * dismisses, and dismissing NEVER counts as approval — the permission sheet passes an
 * onDismiss that answers "deny", not "allow".
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

const DISMISS_PX = 96;
const DISMISS_VELOCITY = 0.6; // px/ms == 600px/s

export function Sheet({ children, onDismiss, height }: { children: ReactNode; onDismiss: () => void; height?: string }) {
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; t: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  // Hardware / gesture back pops the sheet instead of leaving the session (1j).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const down = (y: number) => { start.current = { y, t: Date.now() }; setDragging(true); };
  const move = (y: number) => {
    if (!start.current) return;
    setDy(Math.max(0, y - start.current.y));
  };
  const up = (y: number) => {
    const s = start.current;
    start.current = null;
    setDragging(false);
    if (!s) return;
    const dist = y - s.y;
    const v = dist / Math.max(1, Date.now() - s.t);
    if (dist > DISMISS_PX || v > DISMISS_VELOCITY) onDismiss();
    else setDy(0);
  };

  return (
    <>
      <div className="backdrop" onClick={onDismiss} />
      <div
        ref={ref}
        className={`sheet${dragging ? ' dragging' : ''}`}
        style={{ transform: dy ? `translateY(${dy}px)` : undefined, height }}
        role="dialog"
        aria-modal="true"
      >
        {/* Only the grip drags — the body must stay scrollable (a long command, a long log). */}
        <div
          className="sheet-grab"
          onTouchStart={(e) => down(e.touches[0].clientY)}
          onTouchMove={(e) => move(e.touches[0].clientY)}
          onTouchEnd={(e) => up(e.changedTouches[0].clientY)}
        >
          <div className="sheet-grip" />
        </div>
        {children}
      </div>
    </>
  );
}
