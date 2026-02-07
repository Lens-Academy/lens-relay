import { YDocProvider } from '@y-sweet/react';
import { getClientToken } from '../lib/auth';
import type { ReactNode } from 'react';

interface RelayProviderProps {
  docId: string;
  children: ReactNode;
}

export function RelayProvider({ docId, children }: RelayProviderProps) {
  return (
    <YDocProvider
      docId={docId}
      authEndpoint={() => getClientToken(docId)}
    >
      {children}
    </YDocProvider>
  );
}
