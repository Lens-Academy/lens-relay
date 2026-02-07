import { useEffect, useRef, useState } from 'react';
import { useConnectionStatus } from '@y-sweet/react';

export function DisconnectionModal() {
  const status = useConnectionStatus();
  const wasConnectedRef = useRef(false);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    const isConnected = status === 'connected';
    // Track if we've ever been connected
    if (isConnected) {
      wasConnectedRef.current = true;
      setShowModal(false);
    }
    // Show modal if we were connected and now we're not
    // This catches: offline, error, AND reconnection attempts (connecting/handshaking)
    else if (wasConnectedRef.current) {
      setShowModal(true);
    }
  }, [status]);

  if (!showModal) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-white rounded-lg shadow-xl p-8 max-w-md mx-4">
        <div className="flex items-center gap-3 mb-4">
          {/* Animated pulsing red dot */}
          <div className="relative">
            <div className="w-4 h-4 bg-red-500 rounded-full animate-pulse" />
            <div className="absolute inset-0 w-4 h-4 bg-red-400 rounded-full animate-ping" />
          </div>
          <h2 className="text-xl font-bold text-red-600">Connection Lost</h2>
        </div>

        <p className="text-gray-700 mb-4">
          Your connection to the server has been interrupted. Any changes you make
          while offline may not be saved.
        </p>

        <div className="flex items-center gap-2 text-sm text-gray-500">
          <svg
            className="w-4 h-4 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span>Reconnecting automatically...</span>
        </div>
      </div>
    </div>
  );
}
