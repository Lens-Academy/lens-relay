import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { UserRole } from '../../shared/types.ts';

export type { UserRole };

export interface RoleCapabilities {
  canEdit: boolean;
  canSuggest: boolean;
  canWrite: boolean;
  /** Only admin may push content to production. */
  canPromote: boolean;
}

/**
 * Pure role→capability mapping. The single source of truth for what each
 * role may do in the UI; also callable above the provider (App.tsx renders
 * AuthProvider itself, so it can't use useAuth()).
 */
export function deriveCapabilities(role: UserRole): RoleCapabilities {
  const canEdit = role === 'admin' || role === 'edit';
  const canSuggest = role === 'suggest';
  return {
    canEdit,
    canSuggest,
    canWrite: canEdit || canSuggest,
    canPromote: role === 'admin',
  };
}

interface AuthContextValue extends RoleCapabilities {
  role: UserRole;
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
    ...deriveCapabilities(role),
    folderUuid,
    isAllFolders,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    return { role: 'edit', ...deriveCapabilities('edit'), folderUuid: null, isAllFolders: true };
  }
  return context;
}
