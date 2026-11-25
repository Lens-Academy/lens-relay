import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

export interface MenuItem {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  /** A tick in front: the one of a group that is on. */
  checked?: boolean;
  disabled?: boolean;
  /** A line above this item. */
  divider?: boolean;
}

/**
 * A button that opens a short menu under it. By keyboard: Enter, Space or
 * the down arrow opens it; the arrows, Home and End move; Enter chooses;
 * Escape closes it and gives the focus back to the button.
 */
export function IdeaMenu({ label, name, title, items, className, buttonRef, disabled }: {
  /** What the button shows. */
  label: ReactNode;
  /** What the button and its menu are called (for a screen reader). */
  name: string;
  title?: string;
  items: MenuItem[];
  className: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const own = useRef<HTMLButtonElement>(null);
  const button = buttonRef ?? own;
  const id = useId();
  const usable = items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  // The focus follows the item the arrows are on
  useEffect(() => {
    if (open) wrap.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [open, active]);

  const show = (at: number | undefined) => {
    if (at === undefined) return;
    setActive(at);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const at = usable.indexOf(active);
    const move = (to: number) => {
      e.preventDefault();
      setActive(usable[(to + usable.length) % usable.length]);
    };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(usable.length - 1);
    else if (e.key === 'Tab') setOpen(false);
    else if (e.key === 'Escape') {
      // Only the menu closes: not the form or the selection behind it
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div ref={wrap} className="relative inline-block">
      <button
        ref={button}
        type="button"
        className={className}
        title={title}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show(usable[0]))}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          show(e.key === 'ArrowDown' ? usable[0] : usable[usable.length - 1]);
        }}
      >
        {label}
        <span className="ml-1 text-[10px] text-gray-400" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={name}
          className="absolute left-0 top-full z-30 mt-1 max-h-72 min-w-44 max-w-xs overflow-y-auto rounded border border-gray-200 bg-white py-1 text-sm shadow-lg"
          onKeyDown={onMenuKey}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              data-index={index}
              tabIndex={-1}
              disabled={item.disabled}
              className={`flex w-full items-baseline gap-1.5 px-3 py-1 text-left text-gray-700 hover:bg-gray-100 focus:bg-blue-50 focus:outline-none disabled:text-gray-400 ${item.divider ? 'mt-1 border-t border-gray-100 pt-2' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              {item.checked !== undefined && <span className="w-3 shrink-0 text-blue-600" aria-hidden="true">{item.checked ? '✓' : ''}</span>}
              <span className="min-w-0 break-words">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
