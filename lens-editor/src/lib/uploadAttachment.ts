import * as Y from 'yjs';
import { RELAY_ID } from '../App';
import type { FileMetadata } from '../hooks/useFolderMetadata';
import { generateUUID, createDocumentOnServer, relayHeaders } from './relay-api';

const LENS_EDITOR_ORIGIN = 'lens-editor';

/**
 * Folder path where pasted/dropped attachments are stored.
 *
 * Hardcoded to `/attachments` for now. The Obsidian Relay plugin honors each
 * vault's "Files & Links → Default location for new attachments" setting, but
 * that lives in `obsidian-settings.json` (outside the Y.Doc) and isn't reachable
 * from the web client. All Lens Academy vaults use `attachments/`, so this is
 * safe today; revisit if a user configures a different attachment location.
 */
export const ATTACHMENTS_FOLDER_PATH = '/attachments';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/avif': 'avif',
  'image/heic': 'heic',
};

export async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Strip folder prefix and extension from a doc path to get a bare name. */
export function sanitizeDocName(filePath: string): string {
  const basename = filePath.split('/').filter(Boolean).pop() ?? filePath;
  const withoutExt = basename.replace(/\.[^.]+$/, '');
  return withoutExt.replace(/\//g, '-');
}

/**
 * Pick the attachment filename.
 * - Named file (drop): `{docName}-{originalName}`
 * - Unnamed (clipboard paste): `{docName}-{timestamp}.{ext}`
 */
export function pickFilename(
  file: File,
  docName: string,
  timestamp: number,
): string {
  if (file.name && file.name !== 'image.png' && file.name !== 'blob') {
    // Sanitize the original name — remove path separators
    const safeName = file.name.replace(/[/\\]/g, '-');
    return `${docName}-${safeName}`;
  }
  const ext = MIME_TO_EXT[file.type] ?? 'png';
  return `${docName}-${timestamp}.${ext}`;
}

export interface UploadAttachmentOptions {
  folderDoc: Y.Doc;
  currentFilePath: string;
  file: File;
  timestamp?: number;
}

export interface UploadAttachmentResult {
  /** Full folder-relative path, e.g. `/attachments/MyDoc-1234567890.png` */
  path: string;
}

/**
 * Upload an image blob as an attachment and register it in the folder doc's
 * filemeta_v0 / docs Y.Maps so Obsidian and the relay server both recognize it.
 *
 * Returns the path to embed, e.g. `attachments/MyDoc-1234567890.png`.
 */
export async function uploadAttachment({
  folderDoc,
  currentFilePath,
  file,
  timestamp = Date.now(),
}: UploadAttachmentOptions): Promise<UploadAttachmentResult> {
  const docName = sanitizeDocName(currentFilePath);
  const filename = pickFilename(file, docName, timestamp);
  const attachmentPath = `${ATTACHMENTS_FOLDER_PATH}/${filename}`;

  const hash = await sha256Hex(file);
  const id = generateUUID();
  const compoundDocId = `${RELAY_ID}-${id}`;

  await createDocumentOnServer(compoundDocId);

  // Get a pre-signed upload URL for the blob (scoped to the attachment doc, not the folder doc)
  const urlParams = new URLSearchParams({
    hash,
    content_type: file.type,
    content_length: String(file.size),
  });
  const uploadUrlPath = `/api/relay/f/${compoundDocId}/upload-url?${urlParams}`;
  const uploadUrlRes = await fetch(uploadUrlPath, { method: 'POST', headers: relayHeaders() });
  if (!uploadUrlRes.ok) {
    const body = await uploadUrlRes.text().catch(() => '(could not read body)');
    console.error('[uploadAttachment] upload-url failed', {
      status: uploadUrlRes.status,
      url: uploadUrlPath,
      body,
    });
    throw new Error(
      `Failed to get upload URL: ${uploadUrlRes.status} — ${body || uploadUrlRes.statusText}`,
    );
  }
  const { uploadUrl } = await uploadUrlRes.json() as { uploadUrl: string };

  // For local dev the relay returns a relative path (/f/{doc}/upload?hash=...) to avoid
  // mixed-content issues when the Vite dev server runs on https. Route it through the proxy.
  const absoluteUploadUrl = uploadUrl.startsWith('http')
    ? uploadUrl
    : `/api/relay${uploadUrl}`;
  const uploadHeaders: Record<string, string> = { 'Content-Type': file.type };
  if (!uploadUrl.startsWith('http')) {
    Object.assign(uploadHeaders, relayHeaders());
  }

  const putRes = await fetch(absoluteUploadUrl, {
    method: 'PUT',
    headers: uploadHeaders,
    body: file,
  });
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => '(could not read body)');
    console.error('[uploadAttachment] blob PUT failed', { status: putRes.status, body });
    throw new Error(`Blob upload failed: ${putRes.status} — ${body || putRes.statusText}`);
  }

  // Register the attachment in the folder doc's filemeta_v0 Y.Map.
  // Images must NOT be written to the legacy `docs` map — Obsidian's SyncStore
  // treats that map as authoritative for markdown documents, so an image entry
  // there can be misread as a phantom markdown doc.
  const filemeta = folderDoc.getMap<FileMetadata>('filemeta_v0');

  const meta: FileMetadata = {
    id,
    type: 'image',
    mimetype: file.type,
    hash,
    synctime: timestamp,
    version: 0,
  };

  folderDoc.transact(() => {
    filemeta.set(attachmentPath, meta);
  }, LENS_EDITOR_ORIGIN);

  return { path: attachmentPath };
}
