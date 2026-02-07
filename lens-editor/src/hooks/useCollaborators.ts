import { usePresence, useYjsProvider } from '@y-sweet/react';

export interface UserPresence {
  user?: {
    name: string;
    color: string;
  };
  cursor?: unknown;
}

export function useCollaborators() {
  const provider = useYjsProvider();
  const presence = usePresence<UserPresence>();

  // Get self info from local awareness state
  const selfState = provider.awareness.getLocalState() as UserPresence | null;
  const self = selfState?.user ?? { name: 'You', color: '#6B7280' };

  // Convert Map to array, excluding self (usePresence may include self)
  const selfClientId = provider.awareness.clientID;
  const others = Array.from(presence.entries())
    .filter(([clientId]) => clientId !== selfClientId)
    .map(([clientId, data]) => ({
      clientId,
      name: data.user?.name ?? 'Anonymous',
      color: data.user?.color ?? '#6B7280',
    }));

  return { self, others, totalCount: others.length + 1 };
}
