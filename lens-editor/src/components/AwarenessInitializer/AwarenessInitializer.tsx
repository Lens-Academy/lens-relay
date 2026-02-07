import { useYjsProvider } from '@y-sweet/react';
import { useEffect } from 'react';

// 6-color palette per CONTEXT.md - good contrast on white backgrounds
const USER_COLORS = [
  '#E53935', // Red
  '#1E88E5', // Blue
  '#43A047', // Green
  '#FB8C00', // Orange
  '#8E24AA', // Purple
  '#00ACC1', // Cyan
];

// Generate deterministic color from clientId
function generateUserColor(clientId: number): string {
  return USER_COLORS[clientId % USER_COLORS.length];
}

export function AwarenessInitializer() {
  const provider = useYjsProvider();

  useEffect(() => {
    if (!provider) return;

    const clientId = provider.awareness.clientID;

    // Initialize user presence state
    // Standard Yjs awareness format for compatibility with y-codemirror.next (Phase 2)
    provider.awareness.setLocalStateField('user', {
      name: `User ${clientId % 1000}`, // Temporary name until auth
      color: generateUserColor(clientId),
    });

    console.log('[Awareness] Initialized with clientId:', clientId);

    // Handle reconnection - critical for awareness persistence
    // Without this, presence disappears after disconnect/reconnect
    const handleStatus = ({ status }: { status: string }) => {
      console.log('[Awareness] Provider status:', status);
      if (status === 'connected') {
        // Force awareness state refresh by re-setting the entire local state
        // This re-broadcasts our presence to other clients
        provider.awareness.setLocalState(provider.awareness.getLocalState());
        console.log('[Awareness] Refreshed state on reconnect');
      }
    };

    provider.on('status', handleStatus);
    return () => {
      provider.off('status', handleStatus);
    };
  }, [provider]);

  return null; // This component only handles side effects
}
