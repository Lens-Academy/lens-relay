import type { FileMetadata } from '../hooks/useFolderMetadata';

export type EditorKind = 'blob' | 'html' | 'markdown';

export function pickEditor(filePath: string | null, entry: FileMetadata | null): EditorKind {
  if (entry?.type === 'file' && entry?.hash) return 'blob';
  if (filePath?.endsWith('.html')) return 'html';
  return 'markdown';
}
