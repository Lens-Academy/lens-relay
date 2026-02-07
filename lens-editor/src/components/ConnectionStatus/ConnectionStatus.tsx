import { useConnectionStatus } from '@y-sweet/react';

const statusConfig: Record<string, { color: string; label: string }> = {
  connected: { color: 'bg-green-500', label: 'Connected' },
  connecting: { color: 'bg-yellow-500', label: 'Connecting...' },
  handshaking: { color: 'bg-yellow-500', label: 'Handshaking...' },
  offline: { color: 'bg-gray-500', label: 'Offline' },
  error: { color: 'bg-red-500', label: 'Error' },
};

export function ConnectionStatus() {
  const status = useConnectionStatus();
  const config = statusConfig[status] ?? statusConfig.offline;

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${config.color}`} />
      <span className="text-sm text-gray-600">{config.label}</span>
    </div>
  );
}
