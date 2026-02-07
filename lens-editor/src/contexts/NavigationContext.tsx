import { createContext, useContext } from 'react';
import type { FolderMetadata } from '../hooks/useFolderMetadata';
import type * as Y from 'yjs';

interface NavigationContextValue {
  metadata: FolderMetadata;
  /** Map from folder NAME to Y.Doc */
  folderDocs: Map<string, Y.Doc>;
  folderNames: string[];
  /** Map from folder NAME to Error (for partial sync failures) */
  errors: Map<string, Error>;
  onNavigate: (docId: string) => void;
}

export const NavigationContext = createContext<NavigationContextValue | null>(null);

export function useNavigation() {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used within NavigationProvider');
  return ctx;
}
