import { describe, it, expect } from 'vitest';
import { validateProxyToken, checkProxyAccess, checkProxyAccessWithBody, type ProxyAuthResult } from './relay-proxy-auth.ts';
import { signShareToken } from './share-token.ts';

const FOLDER_A = 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';
const FOLDER_B = 'ea4015da-24af-4d9d-ac49-8c902cb17121';
const ALL_FOLDERS = '00000000-0000-0000-0000-000000000000';
const RELAY_ID = 'cb696037-0f72-4e93-8717-4e433129d789';

function makeAuth(folder: string, role: 'edit' | 'view' = 'edit'): ProxyAuthResult {
  return {
    payload: { purpose: 'share' as const, role, folder, expiry: Math.floor(Date.now() / 1000) + 3600 },
    isAllFolders: folder === ALL_FOLDERS,
  };
}

describe('validateProxyToken', () => {
  it('returns payload for valid token', () => {
    const token = signShareToken({ purpose: 'share', role: 'edit', folder: FOLDER_A, expiry: Math.floor(Date.now() / 1000) + 3600 });
    const result = validateProxyToken(token);
    expect(result).not.toBeNull();
    expect(result!.payload.folder).toBe(FOLDER_A);
    expect(result!.isAllFolders).toBe(false);
  });

  it('returns null for invalid token', () => {
    expect(validateProxyToken('garbage')).toBeNull();
    expect(validateProxyToken(null)).toBeNull();
    expect(validateProxyToken(undefined)).toBeNull();
  });

  it('detects all-folders sentinel', () => {
    const token = signShareToken({ purpose: 'share', role: 'edit', folder: ALL_FOLDERS, expiry: Math.floor(Date.now() / 1000) + 3600 });
    const result = validateProxyToken(token);
    expect(result!.isAllFolders).toBe(true);
  });
});

describe('checkProxyAccess', () => {
  const allFoldersAuth = makeAuth(ALL_FOLDERS);
  const scopedAuth = makeAuth(FOLDER_A);

  it('all-folders token allows everything', () => {
    expect(checkProxyAccess('POST', '/doc/move', '', allFoldersAuth).allowed).toBe(true);
    expect(checkProxyAccess('GET', '/search', '', allFoldersAuth).allowed).toBe(true);
    expect(checkProxyAccess('GET', '/suggestions', `folder_id=${RELAY_ID}-${FOLDER_B}`, allFoldersAuth).allowed).toBe(true);
  });

  it('all-folders view token blocks write endpoints', () => {
    const allFoldersViewAuth = makeAuth(ALL_FOLDERS, 'view');

    expect(checkProxyAccess('POST', '/doc/new', '', allFoldersViewAuth).allowed).toBe(false);
    expect(checkProxyAccessWithBody('POST', '/move', '', allFoldersViewAuth, {
      path: 'Relay Folder 2/Old.md',
      new_path: '/New.md',
    }).allowed).toBe(false);
    expect(checkProxyAccess('GET', '/search', 'q=test', allFoldersViewAuth).allowed).toBe(true);
  });

  it('folder-scoped token blocks /doc/move', () => {
    const result = checkProxyAccess('POST', '/doc/move', '', scopedAuth);
    expect(result.allowed).toBe(false);
  });

  it('folder-scoped edit token allows same-folder /move', () => {
    const result = checkProxyAccessWithBody('POST', '/move', '', scopedAuth, {
      path: 'Relay Folder 1/Old.md',
      new_path: '/New.md',
    }, 'Relay Folder 1');
    expect(result.allowed).toBe(true);
  });

  it('folder-scoped edit token rejects /move target folder mismatch', () => {
    const result = checkProxyAccessWithBody('POST', '/move', '', scopedAuth, {
      path: 'Relay Folder 1/Old.md',
      new_path: '/Old.md',
      target_folder: 'Relay Folder 2',
    }, 'Relay Folder 1');
    expect(result.allowed).toBe(false);
  });

  it('folder-scoped view token rejects /move', () => {
    const result = checkProxyAccessWithBody('POST', '/move', '', makeAuth(FOLDER_A, 'view'), {
      path: 'Relay Folder 1/Old.md',
      new_path: '/New.md',
    }, 'Relay Folder 1');
    expect(result.allowed).toBe(false);
  });

  it('folder-scoped edit token rejects source folder mismatch', () => {
    const result = checkProxyAccessWithBody('POST', '/move', '', scopedAuth, {
      path: 'Relay Folder 2/Syllabus.md',
      new_path: '/Renamed.md',
    }, 'Relay Folder 1');
    expect(result.allowed).toBe(false);
  });

  it('all-folders token allows /move', () => {
    const result = checkProxyAccessWithBody('POST', '/move', '', allFoldersAuth, {
      path: 'Relay Folder 2/Old.md',
      new_path: '/New.md',
      target_folder: 'Lens Edu',
    });
    expect(result.allowed).toBe(true);
  });

  it('folder-scoped token allows /doc/new', () => {
    expect(checkProxyAccess('POST', '/doc/new', '', scopedAuth).allowed).toBe(true);
  });

  it('folder-scoped view token blocks /doc/new', () => {
    expect(checkProxyAccess('POST', '/doc/new', '', makeAuth(FOLDER_A, 'view')).allowed).toBe(false);
  });

  it('folder-scoped token allows /doc/resolve', () => {
    expect(checkProxyAccess('GET', '/doc/resolve/abc123', '', scopedAuth).allowed).toBe(true);
  });

  it('folder-scoped token allows /search', () => {
    expect(checkProxyAccess('GET', '/search', 'q=test', scopedAuth).allowed).toBe(true);
  });

  it('folder-scoped token allows /suggestions for matching folder', () => {
    const result = checkProxyAccess('GET', '/suggestions', `folder_id=${RELAY_ID}-${FOLDER_A}`, scopedAuth);
    expect(result.allowed).toBe(true);
  });

  it('folder-scoped token blocks /suggestions for wrong folder', () => {
    const result = checkProxyAccess('GET', '/suggestions', `folder_id=${RELAY_ID}-${FOLDER_B}`, scopedAuth);
    expect(result.allowed).toBe(false);
  });

  it('folder-scoped token blocks /suggestions without folder_id', () => {
    const result = checkProxyAccess('GET', '/suggestions', '', scopedAuth);
    expect(result.allowed).toBe(false);
  });

  it('folder-scoped token blocks unknown endpoints', () => {
    expect(checkProxyAccess('DELETE', '/doc/abc/something', '', scopedAuth).allowed).toBe(false);
  });
});
