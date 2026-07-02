import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

export type UserRole = 'admin' | 'edit' | 'suggest' | 'view';

interface AuthContextValue {
  role: UserRole;
  canEdit: boolean;
  canSuggest: boolean;
  canWrite: boolean;
  /** Only admin may push content to production. */
  canPromote: boolean;
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
  const canEdit = role === 'admin' || role === 'edit';
  const canSuggest = role === 'suggest';
  const value: AuthContextValue = {
    role,
    canEdit,
    canSuggest,
    canWrite: canEdit || canSuggest,
    canPromote: role === 'admin',
    folderUuid,
    isAllFolders,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    return { role: 'edit', canEdit: true, canSuggest: false, canWrite: true, canPromote: false, folderUuid: null, isAllFolders: true };
  }
  return context;
}
