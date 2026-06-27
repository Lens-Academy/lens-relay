import { useEffect, useRef, useState } from 'react';
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
  const rootRef = useRef<HTMLDivElement>(null);
  const label = promotionStatusLabel(status, loading, error);
  const actionable = canPromote && !!status && status.status !== 'identical' && !loading && !error;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
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
        type="button"
        onClick={() => setMenuOpen(open => !open)}
        className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100"
        aria-expanded={menuOpen}
      >
        Promote to production
      </button>
      {menuOpen && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-40 rounded-md border border-gray-200 bg-white p-1 text-sm shadow-lg"
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
        </div>
      )}
    </div>
  );
}
