// src/components/Editor/ContextMenu.tsx
import { useEffect, useRef } from 'react';
import type { ContextMenuItem } from './extensions/criticmarkup-context-menu';

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className="fixed bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 min-w-[180px]"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
    >
      {items.map((item, index) => (
        <button
          key={index}
          className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 flex justify-between items-center"
          onClick={() => {
            item.action();
            onClose();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && (
            <span className="text-gray-400 text-xs ml-4">{item.shortcut}</span>
          )}
        </button>
      ))}
    </div>
  );
}
