import { useRef, useEffect } from 'react';

interface ResizeHandleProps {
  /** Called on pointer-down. Return the current panel size (px). */
  onDragStart: () => number;
  /** Called on each pointer-move with the desired new size (px). Parent should clamp. */
  onDrag: (size: number) => void;
  /** Called on pointer-up. */
  onDragEnd?: () => void;
  /** When true, renders as invisible zero-width/height element (panel is collapsed). */
  disabled?: boolean;
  /** Drag direction: 'vertical' tracks clientX (default), 'horizontal' tracks clientY. */
  orientation?: 'vertical' | 'horizontal';
  /** When true, dragging right (vertical) or up (horizontal) increases size.
   *  Default for vertical: dragging left increases size (handle on left of panel).
   *  Default for horizontal: dragging down increases size. */
  reverse?: boolean;
}

const KEYBOARD_STEP = 10;

export function ResizeHandle({
  onDragStart,
  onDrag,
  onDragEnd,
  disabled,
  orientation = 'vertical',
  reverse = false,
}: ResizeHandleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Safety: remove listeners if component unmounts mid-drag
  useEffect(() => () => cleanupRef.current?.(), []);

  const isVertical = orientation === 'vertical';
  // Sign determines which mouse direction increases size:
  // vertical default (left-grows): sign = -1  → newSize = start - (current - start)
  // vertical reverse (right-grows): sign = +1 → newSize = start + (current - start)
  // horizontal default (down-grows): sign = +1
  // horizontal reverse (up-grows): sign = -1
  const sign = isVertical ? (reverse ? 1 : -1) : (reverse ? -1 : 1);
  const cursorStyle = isVertical ? 'ew-resize' : 'ns-resize';

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();

    const startPos = isVertical ? e.clientX : e.clientY;
    const startSize = onDragStart();
    ref.current?.setPointerCapture(e.pointerId);

    // Lock cursor globally during drag (overrides all elements)
    const cursorOverride = document.createElement('style');
    cursorOverride.textContent = `* { cursor: ${cursorStyle} !important; }`;
    document.head.appendChild(cursorOverride);

    // Prevent text selection during drag
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    const onMove = (ev: PointerEvent) => {
      const currentPos = isVertical ? ev.clientX : ev.clientY;
      const offset = currentPos - startPos;
      onDrag(startSize + sign * offset);
    };

    const cleanup = () => {
      cursorOverride.remove();
      document.body.style.userSelect = prevUserSelect;
      ref.current?.releasePointerCapture(e.pointerId);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      cleanupRef.current = null;
      onDragEnd?.();
    };
    const onUp = () => cleanup();

    cleanupRef.current = cleanup;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const currentSize = onDragStart();
    if (isVertical) {
      const growKey = reverse ? 'ArrowRight' : 'ArrowLeft';
      const shrinkKey = reverse ? 'ArrowLeft' : 'ArrowRight';
      if (e.key === growKey) {
        e.preventDefault();
        onDrag(currentSize + KEYBOARD_STEP);
      } else if (e.key === shrinkKey) {
        e.preventDefault();
        onDrag(currentSize - KEYBOARD_STEP);
      }
    } else {
      const growKey = reverse ? 'ArrowUp' : 'ArrowDown';
      const shrinkKey = reverse ? 'ArrowDown' : 'ArrowUp';
      if (e.key === growKey) {
        e.preventDefault();
        onDrag(currentSize + KEYBOARD_STEP);
      } else if (e.key === shrinkKey) {
        e.preventDefault();
        onDrag(currentSize - KEYBOARD_STEP);
      }
    }
  };

  if (disabled) {
    return <div className={isVertical ? 'w-0 flex-shrink-0' : 'h-0 flex-shrink-0'} />;
  }

  if (isVertical) {
    return (
      <div
        ref={ref}
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        className="group flex-shrink-0 cursor-ew-resize flex items-center justify-center focus:outline-none"
        style={{ width: 9 }}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
      >
        <div className="w-px h-full bg-gray-200 group-hover:bg-blue-400 transition-colors" />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="horizontal"
      tabIndex={0}
      className="group flex-shrink-0 cursor-ns-resize flex items-center justify-center focus:outline-none"
      style={{ height: 9 }}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    >
      <div className="h-px w-full bg-gray-200 group-hover:bg-blue-400 transition-colors" />
    </div>
  );
}
