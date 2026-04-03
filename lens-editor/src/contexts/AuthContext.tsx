import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

export type UserRole = 'edit' | 'suggest' | 'view';

interface AuthContextValue {
  role: UserRole;
  canEdit: boolean;
  canSuggest: boolean;
  canWrite: boolean;
  folderUuid: string | null;
  isAllFolders: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  role: UserRole;
  folderUuid: string | null;
  isAllFolders: boolean;
  children: ReactNode;
}

export function AuthProvider({ role, folderUuid, isAllFolders, children }: AuthProviderProps) {
  const value: AuthContextValue = {
    role,
    canEdit: role === 'edit',
    canSuggest: role === 'suggest',
    canWrite: role === 'edit' || role === 'suggest',
    folderUuid,
    isAllFolders,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    return { role: 'edit', canEdit: true, canSuggest: false, canWrite: true, folderUuid: null, isAllFolders: true };
  }
  return context;
}
