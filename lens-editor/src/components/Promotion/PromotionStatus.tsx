import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PromotionStatusResponse } from '../../lib/promotion-api';

interface PromotionStatusProps {
  filePath: string;
  canPromote: boolean;
  status: PromotionStatusResponse | null;
  loading?: boolean;
  error?: string | null;
  onRefresh: () => void;
  onPromoteFile?: () => void;
  onPromoteMultiple?: () => void;
}

export function promotionStatusLabel(
  status: PromotionStatusResponse | null,
  loading?: boolean,
  error?: string | null
) {
  if (loading) return 'Checking production...';
  if (error) return 'Unable to check production';
  switch (status?.status) {
    case 'identical':
      return 'Identical to production';
    case 'added':
      return 'Not in production yet';
    case 'deleted':
      return 'Deleted in staging';
    case 'modified':
    case 'renamed':
      return 'Different from production';
    default:
      return 'Check production';
  }
}

export function PromotionStatus({
  filePath,
  canPromote,
  status,
  loading = false,
  error = null,
  onRefresh,
  onPromoteFile,
  onPromoteMultiple,
}: PromotionStatusProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = promotionStatusLabel(status, loading, error);
  const actionable = canPromote && !!status && status.status !== 'identical' && !loading && !error;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuOpen]);

  const handleMenuAction = (callback?: () => void) => {
    setMenuOpen(false);
    callback?.();
  };

  const toggleMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuPosition({
        top: rect.bottom + 4,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
    setMenuOpen(open => !open);
  };

  if (!actionable) {
    return (
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        title={`${label}: ${filePath}`}
        className="max-w-[220px] truncate rounded border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-800 disabled:cursor-default disabled:text-gray-400"
      >
        {label}
      </button>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleMenu}
        className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100"
        aria-expanded={menuOpen}
      >
        Promote to production
      </button>
      {menuOpen && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[1000] w-40 rounded-md border border-gray-200 bg-white p-1 text-sm shadow-lg"
          style={{ top: menuPosition.top, right: menuPosition.right }}
        >
          <button
            type="button"
            onClick={() => handleMenuAction(onPromoteFile)}
            className="block w-full rounded px-2 py-1.5 text-left text-gray-700 hover:bg-gray-100"
          >
            This file
          </button>
          <button
            type="button"
            onClick={() => handleMenuAction(onPromoteMultiple)}
            className="block w-full rounded px-2 py-1.5 text-left text-gray-700 hover:bg-gray-100"
          >
            Multiple files
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
