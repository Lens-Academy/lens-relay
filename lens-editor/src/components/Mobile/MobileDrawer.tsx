import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useKeyboardInset } from '../../hooks/useKeyboardInset';

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Which edge the drawer slides in from. 'bottom' renders a sheet. */
  side: 'left' | 'right' | 'bottom';
  /** Accessible label for the drawer dialog. */
  label: string;
  children: ReactNode;
}

const SLIDE_MS = 200;

/**
 * Overlay drawer / bottom sheet for mobile. Renders into a portal with a
 * scrim; tap the scrim to dismiss. Content is kept mounted only while open
 * (or animating out) so heavy panels don't run in the background.
 */
export function MobileDrawer({ open, onClose, side, label, children }: MobileDrawerProps) {
  // Keeps the bottom sheet above the on-screen keyboard (e.g. comment form)
  const keyboardInset = useKeyboardInset();
  // Track "visible" separately from `open` so the close animation can play.
  const [mounted, setMounted] = useState(open);
  // `shown` drives the transform; toggled one frame after mount for slide-in.
  const [shown, setShown] = useState(false);
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      if (closeTimer.current != null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      // Two frames: mount hidden, then flip the transform so the slide-in
      // transition actually plays.
      let raf2: number | null = null;
      const raf = requestAnimationFrame(() => {
        setMounted(true);
        raf2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(raf);
        if (raf2 != null) cancelAnimationFrame(raf2);
      };
    }
    const raf = requestAnimationFrame(() => setShown(false));
    closeTimer.current = window.setTimeout(() => setMounted(false), SLIDE_MS);
    return () => {
      cancelAnimationFrame(raf);
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    };
  }, [open]);

  // Escape closes the drawer (parity with the project's Radix dialogs)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Swipe the panel toward its edge to dismiss (left/right drawers only —
  // the bottom sheet scrolls vertically, so it keeps scrim/handle dismissal).
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const onPanelTouchStart = (e: React.TouchEvent) => {
    swipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onPanelTouchMove = (e: React.TouchEvent) => {
    const start = swipeStart.current;
    if (!start || side === 'bottom') return;
    const dx = e.touches[0].clientX - start.x;
    const dy = e.touches[0].clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < 2 * Math.abs(dy)) return;
    if ((side === 'left' && dx < 0) || (side === 'right' && dx > 0)) {
      swipeStart.current = null;
      onClose();
    }
  };
  const onPanelTouchEnd = () => {
    swipeStart.current = null;
  };

  if (!mounted) return null;

  const panelBase = 'fixed z-50 bg-[#f6f6f6] shadow-xl transition-transform duration-200 ease-out flex flex-col';
  const panelBySide = {
    left: `inset-y-0 left-0 w-[85vw] max-w-[320px] ${shown ? 'translate-x-0' : '-translate-x-full'}`,
    right: `inset-y-0 right-0 w-[85vw] max-w-[320px] ${shown ? 'translate-x-0' : 'translate-x-full'}`,
    bottom: `inset-x-0 bottom-0 max-h-[75dvh] rounded-t-xl ${shown ? 'translate-y-0' : 'translate-y-full'}`,
  }[side];

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={label}>
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`}
        style={{ touchAction: 'none' }}
        onClick={onClose}
        data-testid="mobile-drawer-scrim"
      />
      <div
        className={`${panelBase} ${panelBySide}`}
        style={{
          paddingBottom: 'env(safe-area-inset-bottom)',
          // Raise the sheet above the keyboard AND shrink it so its header
          // stays reachable (iOS dvh does not account for the keyboard)
          ...(side === 'bottom' && keyboardInset > 0
            ? { bottom: keyboardInset, maxHeight: `calc(100dvh - ${keyboardInset + 56}px)` }
            : {}),
        }}
        onTouchStart={onPanelTouchStart}
        onTouchMove={onPanelTouchMove}
        onTouchEnd={onPanelTouchEnd}
      >
        {side === 'bottom' && (
          <div className="flex justify-center py-2 flex-shrink-0" onClick={onClose}>
            <div className="w-9 h-1 rounded-full bg-gray-300" />
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
