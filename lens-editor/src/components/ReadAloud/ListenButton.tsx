import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { readAloudAvailable } from '../../lib/read-aloud/api';
import type { ReadAloudEngine } from '../../lib/read-aloud/engine';
import { useReadAloudSnapshot } from './useReadAloudSnapshot';

/**
 * Header button that opens read-aloud: a headphones icon, as in the
 * platform's header. Hidden when the server has no Speechify key. `onStart`
 * begins reading; a second press closes the player.
 */
export function ListenButton({ engine, onStart }: {
  engine: ReadAloudEngine | null;
  onStart: () => void;
}) {
  const [available, setAvailable] = useState(false);
  const snap = useReadAloudSnapshot(engine);
  useEffect(() => {
    let cancelled = false;
    readAloudAvailable().then(ok => { if (!cancelled) setAvailable(ok); });
    return () => { cancelled = true; };
  }, []);
  if (!available) return null;
  const open = snap?.open ?? false;

  return (
    <button
      type="button"
      onClick={() => (open ? engine?.close() : onStart())}
      disabled={!engine}
      aria-pressed={open}
      title={open ? 'Close read-aloud' : 'Listen: read this page aloud'}
      aria-label="Listen"
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md border disabled:opacity-40 ${
        open ? 'border-[#e6b988] bg-[#fdf3e3] hover:bg-[#fbe9cf] text-[#8a5410]' : 'border-gray-300 bg-white hover:bg-gray-50 text-gray-600'
      }`}
    >
      <Icon name="headphones" className="w-4 h-4" />
    </button>
  );
}
