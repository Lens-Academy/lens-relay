import { useConnectionStatus } from '@y-sweet/react';

type SyncState = 'synced' | 'syncing' | 'offline';

interface StateConfig {
  color: string;
  tooltip: string;
}

const stateConfig: Record<SyncState, StateConfig> = {
  synced: {
    color: 'text-green-500',
    tooltip: 'All changes saved',
  },
  syncing: {
    color: 'text-amber-500',
    tooltip: 'Syncing changes...',
  },
  offline: {
    color: 'text-red-500',
    tooltip: 'Connection lost - changes saved locally',
  },
};

function mapStatus(status: string): SyncState {
  switch (status) {
    case 'connected':
      return 'synced';
    case 'connecting':
    case 'handshaking':
      return 'syncing';
    default:
      return 'offline';
  }
}

// Inline SVG icons
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path
        d="M10 3a7 7 0 100 14 7 7 0 000-14zm0 12a5 5 0 110-10 5 5 0 010 10z"
        opacity="0.25"
      />
      <path d="M10 3a7 7 0 017 7h-2a5 5 0 00-5-5V3z" />
    </svg>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function SyncStatus() {
  const status = useConnectionStatus();
  const state = mapStatus(status);
  const config = stateConfig[state];

  return (
    <div className="relative group">
      {/* Icon */}
      <div className={`w-5 h-5 ${config.color}`}>
        {state === 'synced' && <CheckIcon className="w-5 h-5" />}
        {state === 'syncing' && <SpinnerIcon className="w-5 h-5 animate-spin" />}
        {state === 'offline' && <WarningIcon className="w-5 h-5" />}
      </div>

      {/* Tooltip on hover */}
      <div className="absolute top-full right-0 mt-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
        {config.tooltip}
      </div>
    </div>
  );
}
