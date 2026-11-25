import type * as Y from 'yjs';
import type { FileMetadata } from '../hooks/useFolderMetadata';
import { isImageEmbedTarget } from '../../shared/embeds';
import { resolveRelative } from './document-resolver';
import { getFolderNameFromPath, getOriginalPath } from './multi-folder-utils';
import { createDocument, createFolder, PathExistsError } from './relay-api';

/** Where following an unresolved wikilink creates its file. */
export type NewLinkTarget =
  | { path: string; type: 'markdown' | 'file' }
  | { error: string };

// Names Obsidian refuses on some OS: a file the link names must sync everywhere
const FORBIDDEN_NAME_CHARS = /[\\:*?"<>|]/;
// Links to these name an attachment, never a note to create
const ATTACHMENT_EXTENSIONS =
  /\.(pdf|canvas|base|mp3|mp4|m4a|wav|ogg|flac|webm|mov|zip|docx?|xlsx?|pptx?|odt|rtf|csv|tsv|txt|json|epub)$/i;

/**
 * The file an unresolved [[pageName]] creates, as a folder-prefixed path:
 * resolved from the current file's directory like a link (`[[Name]]` beside
 * it, `[[../X/Name]]` up and over), with `.md` unless the link names `.html`.
 * A link that starts with a shared folder's name (`[[Lens/X/Name]]`) is
 * absolute, the resolver's other reading.
 * Null when the link names nothing that can be created (an attachment, a bare
 * #heading); an error when it leaves the shared folders or has a name a file
 * cannot have.
 */
export function newDocPathForLink(
  pageName: string,
  currentFilePath: string,
  folderNames: string[],
): NewLinkTarget | null {
  const anchor = pageName.indexOf('#');
  const page = (anchor === -1 ? pageName : pageName.substring(0, anchor)).trim();
  if (!page || isImageEmbedTarget(page) || ATTACHMENT_EXTENSIONS.test(page)) return null;
  if (FORBIDDEN_NAME_CHARS.test(page)) {
    return { error: `"${page}" cannot be a file name: it has one of \\ : * ? " < > |` };
  }
  const absolute = getFolderNameFromPath(`/${page}`, folderNames) !== null;
  const path = resolveRelative(absolute ? '/' : currentFilePath, page);
  const folder = getFolderNameFromPath(path, folderNames);
  if (!folder || getOriginalPath(path, folder).split('/').filter(Boolean).length === 0) {
    return { error: `[[${page}]] points outside the shared folders` };
  }
  return { path, type: /\.html$/i.test(path) ? 'file' : 'markdown' };
}

// One create per path at a time: a double click must not make two files
const inFlight = new Map<string, Promise<string>>();

/**
 * Create the file at a folder-prefixed path, with any missing parent folders,
 * in the shared folder it names. Returns the document's UUID (the existing
 * one's if the path was taken meanwhile).
 */
export function createLinkedDoc(
  target: { path: string; type: 'markdown' | 'file' },
  folderDocs: Map<string, Y.Doc>,
  folderNames: string[],
): Promise<string> {
  const pending = inFlight.get(target.path);
  if (pending) return pending;
  const run = (async () => {
    const folder = getFolderNameFromPath(target.path, folderNames);
    const folderDoc = folder ? folderDocs.get(folder) : undefined;
    if (!folder || !folderDoc) throw new Error(`The folder of ${target.path} is not loaded`);
    const path = getOriginalPath(target.path, folder);
    const parent = path.substring(0, path.lastIndexOf('/'));
    if (parent && !folderDoc.getMap<FileMetadata>('filemeta_v0').has(parent)) {
      createFolder(folderDoc, parent);
    }
    try {
      return await createDocument(folderDoc, path, target.type);
    } catch (err) {
      // Created meanwhile (another click, another editor): open that file
      const existing = err instanceof PathExistsError && err.existing === path
        ? folderDoc.getMap<FileMetadata>('filemeta_v0').get(path) : undefined;
      if (existing) return existing.id;
      throw err;
    }
  })();
  inFlight.set(target.path, run);
  run.then(
    () => inFlight.delete(target.path),
    () => inFlight.delete(target.path),
  );
  return run;
}
