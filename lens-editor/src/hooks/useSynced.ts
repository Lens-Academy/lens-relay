import { useState, useEffect } from 'react';
import { useYjsProvider } from '@y-sweet/react';

/**
 * Hook to track whether the Y.Doc has synced with the server.
 * Returns false initially, true once 'synced' event fires.
 */
export function useSynced(): boolean {
  const provider = useYjsProvider();
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    // Check if already synced (provider might have connected before mount)
    // YSweetProvider has synced property
    if ((provider as any).synced) {
      setSynced(true);
      return;
    }

    const handleSynced = () => {
      setSynced(true);
    };

    provider.on('synced', handleSynced);

    return () => {
      provider.off('synced', handleSynced);
    };
  }, [provider]);

  return synced;
}
