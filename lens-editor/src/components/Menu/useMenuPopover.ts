import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A button's menu: whether it is open, and where, under the button with the
 * right edges in line (kept on screen); a click elsewhere or Escape closes it.
 */
export function useMenuPopover(width: number) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 8 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const toggle = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const menuWidth = Math.min(width, window.innerWidth - 16);
      setPosition({
        top: rect.bottom + 6,
        left: Math.min(Math.max(8, rect.right - menuWidth), window.innerWidth - menuWidth - 8),
      });
    }
    setOpen((current) => !current);
  }, [width]);

  return { open, setOpen, toggle, position, buttonRef, menuRef };
}
