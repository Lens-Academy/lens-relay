import type { RoleCapabilities } from '../contexts/AuthContext';
import { EDU_FOLDER_ID } from './constants';

// Routes that never show a document (the start page is '/'). Everything else is
// a document path (/:docUuid/...), whose view may render EditorArea.
const NON_DOC_ROUTES = /^\/(review|recent|promote|add-source|add-article|concept-map|edu\/|section-editor\/)/;

export function isDocRoute(pathname: string): boolean {
  return pathname !== '/' && !NON_DOC_ROUTES.test(pathname);
}

export interface WorkflowAccess {
  review: boolean;
  recent: boolean;
  /** The creator's concept map: reading it needs Lens Edu only (its creator actions need canEdit). */
  conceptMap: boolean;
  addSource: boolean;
  promote: boolean;
}

/**
 * Which workflow pages a share link may use; the header's workflows menu and
 * the mobile "More options" menu both offer only these. Matches the routes in
 * App.tsx, which fall back to the start page otherwise.
 */
export function workflowAccess(
  { canEdit, canPromote, folderUuid, isAllFolders }:
    Pick<RoleCapabilities, 'canEdit' | 'canPromote'> & { folderUuid: string | null; isAllFolders: boolean },
): WorkflowAccess {
  const hasEdu = isAllFolders || folderUuid === EDU_FOLDER_ID;
  return { review: canEdit, recent: true, conceptMap: hasEdu, addSource: canEdit && hasEdu, promote: canPromote && hasEdu };
}
