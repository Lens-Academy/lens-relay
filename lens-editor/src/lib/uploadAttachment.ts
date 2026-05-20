import * as Y from 'yjs';
import { RELAY_ID } from '../App';
import type { FileMetadata } from '../hooks/useFolderMetadata';
import { generateUUID, createDocumentOnServer, relayHeaders } from './relay-api';

const LENS_EDITOR_ORIGIN = 'lens-editor';

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
  folderId: string;
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
  folderId,
  currentFilePath,
  file,
  timestamp = Date.now(),
}: UploadAttachmentOptions): Promise<UploadAttachmentResult> {
  const docName = sanitizeDocName(currentFilePath);
  const filename = pickFilename(file, docName, timestamp);
  const attachmentPath = `/attachments/${filename}`;

  const hash = await sha256Hex(file);
  const id = generateUUID();
  const compoundDocId = `${RELAY_ID}-${id}`;

  // Create the blob document on the server before writing filemeta
  console.debug('[uploadAttachment] creating doc', compoundDocId);
  await createDocumentOnServer(compoundDocId);
  console.debug('[uploadAttachment] doc created');

  // Get a pre-signed upload URL for the blob (scoped to the attachment doc, not the folder doc)
  const urlParams = new URLSearchParams({
    hash,
    content_type: file.type,
    content_length: String(file.size),
  });
  const uploadUrlPath = `/api/relay/f/${compoundDocId}/upload-url?${urlParams}`;
  console.debug('[uploadAttachment] requesting upload URL', uploadUrlPath);
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
  const uploadUrlJson = await uploadUrlRes.json() as { uploadUrl: string };
  const uploadUrl = uploadUrlJson.uploadUrl;
  console.debug('[uploadAttachment] upload URL received', uploadUrl);

  // Upload the blob to the pre-signed URL.
  // For local dev the relay returns a relative path (/f/{doc}/upload?hash=...) to avoid
  // mixed-content issues when the Vite dev server runs on https. Route it through the proxy.
  const absoluteUploadUrl = uploadUrl.startsWith('http')
    ? uploadUrl
    : `/api/relay${uploadUrl}`;
  const uploadHeaders: Record<string, string> = { 'Content-Type': file.type };
  if (!uploadUrl.startsWith('http')) {
    Object.assign(uploadHeaders, relayHeaders());
  }

  console.debug('[uploadAttachment] uploading blob to', absoluteUploadUrl.split('?')[0]);
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

  // Register the attachment in the folder doc's Y.Maps
  const filemeta = folderDoc.getMap<FileMetadata>('filemeta_v0');
  const legacyDocs = folderDoc.getMap<string>('docs');

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
    legacyDocs.set(attachmentPath, id);
  }, LENS_EDITOR_ORIGIN);

  return { path: attachmentPath };
}
