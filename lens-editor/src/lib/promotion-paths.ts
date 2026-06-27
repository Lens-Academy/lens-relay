import { EDU_FOLDER_ID, FOLDERS } from './constants';

const PROMOTION_FOLDER_NAME = FOLDERS.find(folder => folder.id === EDU_FOLDER_ID)?.name ?? 'Lens Edu';

export function editorPathToPromotionPath(editorPath: string | null | undefined): string | null {
  if (!editorPath) return null;

  const normalizedEditorPath = editorPath.startsWith('/') ? editorPath : `/${editorPath}`;
  const folderRoot = `/${PROMOTION_FOLDER_NAME}`;
  const folderPrefix = `${folderRoot}/`;

  if (!normalizedEditorPath.startsWith(folderPrefix)) return null;

  const repoPath = normalizedEditorPath.slice(folderPrefix.length);
  return repoPath || null;
}

export function promotionPathToEditorPath(repoPath: string): string {
  return `/${PROMOTION_FOLDER_NAME}/${repoPath.replace(/^\/+/, '')}`;
}
