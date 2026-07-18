import { useYjsProvider, useYDoc } from '@y-sweet/react';
import { useEffect, useRef } from 'react';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { setCurrentAuthor } from '../Editor/extensions/criticmarkup';
import { attachProvenanceRegistration, humanActor } from '../../lib/provenance';

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
  const ydoc = useYDoc();
  const { displayName } = useDisplayName();

  // Provenance: lazily map this doc instance's clientID to the current human
  // actor on the first local edit (read-only viewers never register).
  // The ref keeps the attached listener reading the latest display name.
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;

  useEffect(() => {
    if (!ydoc) return;
    return attachProvenanceRegistration(ydoc, () =>
      humanActor(displayNameRef.current ?? '')
    );
  }, [ydoc]);

  useEffect(() => {
    if (!provider) return;

    const clientId = provider.awareness.clientID;

    // Initialize user presence state
    // Standard Yjs awareness format for compatibility with y-codemirror.next (Phase 2)
    provider.awareness.setLocalStateField('user', {
      name: displayName ?? `User ${clientId % 1000}`,
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

  // Keep awareness and comment authorship in sync with display name changes
  useEffect(() => {
    if (!provider || !displayName) return;

    provider.awareness.setLocalStateField('user', {
      ...provider.awareness.getLocalState()?.user,
      name: displayName,
    });
    setCurrentAuthor(displayName);
  }, [provider, displayName]);

  return null; // This component only handles side effects
}
