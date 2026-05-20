import { verifyShareToken } from './share-token.ts';
import type { ShareTokenPayload } from './share-token.ts';

const ALL_FOLDERS_SENTINEL = '00000000-0000-0000-0000-000000000000';

export interface ProxyAuthResult {
  payload: ShareTokenPayload;
  isAllFolders: boolean;
}

export function validateProxyToken(token: string | undefined | null): ProxyAuthResult | null {
  if (!token) return null;
  const payload = verifyShareToken(token);
  if (!payload) return null;
  return {
    payload,
    isAllFolders: payload.folder === ALL_FOLDERS_SENTINEL,
  };
}

export function checkProxyAccess(
  method: string,
  path: string,
  query: string,
  auth: ProxyAuthResult,
): { allowed: boolean; reason?: string } {
  if (auth.isAllFolders) return { allowed: true };

  const folder = auth.payload.folder;

  // POST /doc/new — allowed (folder assignment happens via filemeta, not this endpoint)
  if (method === 'POST' && path === '/doc/new') {
    return { allowed: true };
  }

  // POST /doc/move — blocked for folder-scoped tokens (could move cross-folder)
  if (method === 'POST' && path === '/doc/move') {
    return { allowed: false, reason: 'Document move not allowed with folder-scoped token' };
  }

  // GET /doc/resolve/{prefix} — allowed (just UUID resolution, content still gated)
  if (method === 'GET' && path.startsWith('/doc/resolve/')) {
    return { allowed: true };
  }

  // GET /search — allowed (results may include cross-folder docs but content is still gated)
  if (method === 'GET' && path === '/search') {
    return { allowed: true };
  }

  // POST /f/{compoundDocId}/upload-url — allowed for edit role (relay server enforces ACL)
  if (method === 'POST' && /^\/f\/[^/]+\/upload-url$/.test(path)) {
    if (auth.payload.role === 'view') {
      return { allowed: false, reason: 'Upload requires edit access' };
    }
    return { allowed: true };
  }

  // PUT /f/{compoundDocId}/upload — raw blob upload (local dev, no-auth relay)
  if (method === 'PUT' && /^\/f\/[^/]+\/upload$/.test(path)) {
    if (auth.payload.role === 'view') {
      return { allowed: false, reason: 'Upload requires edit access' };
    }
    return { allowed: true };
  }

  // GET /f/{compoundDocId}/download-url — allowed for edit role (relay server enforces ACL)
  if (method === 'GET' && /^\/f\/[^/]+\/download-url$/.test(path)) {
    if (auth.payload.role === 'view') {
      return { allowed: false, reason: 'Download URL requires edit access' };
    }
    return { allowed: true };
  }

  // GET /suggestions — allowed only if folder_id matches token folder
  if (method === 'GET' && path === '/suggestions') {
    const params = new URLSearchParams(query);
    const requestedFolders = params.getAll('folder_id');
    // Must specify at least one folder, and all must match the token's folder
    // (compound folder_id format: "relay_id-folder_uuid")
    if (requestedFolders.length === 0) {
      return { allowed: false, reason: 'Suggestions require folder_id parameter' };
    }
    const allMatch = requestedFolders.every(fid => fid.endsWith('-' + folder));
    if (!allMatch) {
      return { allowed: false, reason: 'Suggestions access denied for this folder' };
    }
    return { allowed: true };
  }

  // Default: block unknown endpoints for folder-scoped tokens
  return { allowed: false, reason: 'Endpoint not allowed with folder-scoped token' };
}

export function checkProxyAccessWithBody(
  method: string,
  path: string,
  query: string,
  auth: ProxyAuthResult,
  body?: unknown,
  allowedFolderName?: string,
): { allowed: boolean; reason?: string } {
  if (auth.isAllFolders) return { allowed: true };

  if (method === 'POST' && path === '/move') {
    if (auth.payload.role === 'view') {
      return { allowed: false, reason: 'Move requires edit access' };
    }
    if (!allowedFolderName) {
      return { allowed: false, reason: 'Unable to verify source folder for move' };
    }
    const moveBody = typeof body === 'object' && body !== null
      ? body as { path?: unknown; target_folder?: unknown }
      : {};
    const sourcePath = moveBody.path;
    if (
      typeof sourcePath !== 'string'
      || (sourcePath !== allowedFolderName && !sourcePath.startsWith(`${allowedFolderName}/`))
    ) {
      return { allowed: false, reason: 'Move source is outside this folder' };
    }
    const targetFolder = moveBody.target_folder;
    if (typeof targetFolder === 'string' && targetFolder && targetFolder !== allowedFolderName) {
      return { allowed: false, reason: 'Cross-folder move not allowed with folder-scoped token' };
    }
    return { allowed: true };
  }

  return checkProxyAccess(method, path, query, auth);
}
