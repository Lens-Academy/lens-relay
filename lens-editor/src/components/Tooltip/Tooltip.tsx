import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Notion's tooltip: a small dark label under its content while the pointer
 * is over it or it has focus. Drawn in a portal on the page, so a parent that
 * clips its overflow (the top bar does) can't cut it off.
 */
export function Tooltip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) setAt({ x: rect.left + rect.width / 2, y: rect.bottom + 6 });
  };
  const hide = () => setAt(null);

  return (
    <span
      ref={anchorRef}
      className={className ?? 'inline-flex'}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {at && createPortal(
        <span role="tooltip" className="lens-tooltip" style={{ left: at.x, top: at.y }}>
          {label}
        </span>,
        document.body,
      )}
    </span>
  );
}
