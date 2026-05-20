import { EditorView } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import type * as Y from 'yjs';
import { uploadAttachment } from '../../../lib/uploadAttachment';

export interface ImagePasteOptions {
  getFolderDoc: () => Y.Doc | null;
  getFolderId: () => string | null;
  getCurrentFilePath: () => string | null;
}

export function imagePasteExtension(options: ImagePasteOptions): Extension {
  return Prec.high(EditorView.domEventHandlers({
    paste(event, view) {
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter((f): f is File => f !== null);

      if (files.length === 0) return false;

      event.preventDefault();
      files.forEach(file => scheduleUpload(view, file, options));
      return true;
    },

    dragover(event) {
      const hasImages = Array.from(event.dataTransfer?.items ?? [])
        .some(item => item.kind === 'file' && item.type.startsWith('image/'));
      if (hasImages) event.preventDefault();
      return false;
    },

    drop(event, view) {
      const files = Array.from(event.dataTransfer?.files ?? [])
        .filter(f => f.type.startsWith('image/'));

      if (files.length === 0) return false;

      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.doc.length;
      files.forEach(file => scheduleUpload(view, file, options, pos));
      return true;
    },
  }));
}

function scheduleUpload(
  view: EditorView,
  file: File,
  { getFolderDoc, getFolderId, getCurrentFilePath }: ImagePasteOptions,
  insertPos?: number,
): void {
  const folderDoc = getFolderDoc();
  const folderId = getFolderId();
  const currentFilePath = getCurrentFilePath();

  if (!folderDoc || !folderId || !currentFilePath) return;

  const shortId = Math.random().toString(36).slice(2, 8);
  const placeholder = `![[uploading-${shortId}...]]`;
  const pos = insertPos ?? view.state.selection.main.from;

  view.dispatch({
    changes: { from: pos, insert: placeholder + '\n' },
    selection: { anchor: pos + placeholder.length + 1 },
  });

  uploadAttachment({ folderDoc, folderId, currentFilePath, file })
    .then(({ path }) => {
      const embedPath = path.startsWith('/') ? path.slice(1) : path;
      replacePlaceholder(view, placeholder, `![[${embedPath}]]`);
    })
    .catch((err: Error) => {
      replacePlaceholder(view, placeholder, `<!-- upload failed: ${err.message} -->`);
    });
}

function replacePlaceholder(view: EditorView, placeholder: string, replacement: string): void {
  const content = view.state.doc.toString();
  const idx = content.indexOf(placeholder);
  if (idx === -1) return;
  view.dispatch({
    changes: { from: idx, to: idx + placeholder.length, insert: replacement },
  });
}
