import { describe, it, expect } from 'vitest';
import { validateProxyToken, checkProxyAccess, checkProxyAccessWithBody, isBodyCheckedRequest, type ProxyAuthResult } from './relay-proxy-auth.ts';
import { signShareToken } from './share-token.ts';

const FOLDER_A = 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';
const FOLDER_B = 'ea4015da-24af-4d9d-ac49-8c902cb17121';
const ALL_FOLDERS = '00000000-0000-0000-0000-000000000000';
const RELAY_ID = 'cb696037-0f72-4e93-8717-4e433129d789';

function makeAuth(folder: string, role: 'admin' | 'edit' | 'suggest' | 'view' = 'edit'): ProxyAuthResult {
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

  describe('POST /doc/trash', () => {
    const body = { path: 'Relay Folder 1/Notes/A.md' };

    it('all-folders edit and admin tokens are allowed', () => {
      expect(checkProxyAccessWithBody('POST', '/doc/trash', '', allFoldersAuth, body).allowed).toBe(true);
      expect(checkProxyAccessWithBody('POST', '/doc/trash', '', makeAuth(ALL_FOLDERS, 'admin'), body).allowed).toBe(true);
    });

    it('suggest tokens are refused even with all-folders scope', () => {
      const result = checkProxyAccessWithBody('POST', '/doc/trash', '', makeAuth(ALL_FOLDERS, 'suggest'), body);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Delete requires edit access');
      expect(checkProxyAccessWithBody('POST', '/doc/trash', '', makeAuth(FOLDER_A, 'suggest'), body, 'Relay Folder 1').allowed).toBe(false);
    });

    it('view tokens are refused', () => {
      expect(checkProxyAccessWithBody('POST', '/doc/trash', '', makeAuth(FOLDER_A, 'view'), body, 'Relay Folder 1').allowed).toBe(false);
    });

    it('folder-scoped edit token may delete inside its folder only', () => {
      expect(checkProxyAccessWithBody('POST', '/doc/trash', '', scopedAuth, body, 'Relay Folder 1').allowed).toBe(true);
      expect(checkProxyAccessWithBody('POST', '/doc/trash', '', scopedAuth, { path: 'Relay Folder 1' }, 'Relay Folder 1').allowed).toBe(true);
      const outside = checkProxyAccessWithBody('POST', '/doc/trash', '', scopedAuth, { path: 'Relay Folder 2/X.md' }, 'Relay Folder 1');
      expect(outside.allowed).toBe(false);
      expect(outside.reason).toBe('Delete target is outside this folder');
      // A folder name that merely shares a prefix does not count.
      expect(checkProxyAccessWithBody('POST', '/doc/trash', '', scopedAuth, { path: 'Relay Folder 10/X.md' }, 'Relay Folder 1').allowed).toBe(false);
    });

    it('folder-scoped token is refused when the folder name cannot be resolved or the body is malformed', () => {
      expect(checkProxyAccessWithBody('POST', '/doc/trash', '', scopedAuth, body).allowed).toBe(false);
      expect(checkProxyAccessWithBody('POST', '/doc/trash', '', scopedAuth, { path: 42 }, 'Relay Folder 1').allowed).toBe(false);
      expect(checkProxyAccessWithBody('POST', '/doc/trash', '', scopedAuth, undefined, 'Relay Folder 1').allowed).toBe(false);
    });

    it('is body-checked so the proxies read the request body', () => {
      expect(isBodyCheckedRequest('POST', '/doc/trash')).toBe(true);
      expect(isBodyCheckedRequest('POST', '/move')).toBe(true);
      expect(isBodyCheckedRequest('GET', '/doc/trash')).toBe(false);
      expect(isBodyCheckedRequest('POST', '/doc/new')).toBe(false);
    });
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

  it('folder-scoped token allows /recent-changes for matching folder only', () => {
    expect(checkProxyAccess('GET', '/recent-changes', `folder_id=${RELAY_ID}-${FOLDER_A}&since_ms=0`, scopedAuth).allowed).toBe(true);
    expect(checkProxyAccess('GET', '/recent-changes', `folder_id=${RELAY_ID}-${FOLDER_B}`, scopedAuth).allowed).toBe(false);
    expect(checkProxyAccess('GET', '/recent-changes', '', scopedAuth).allowed).toBe(false);
    expect(checkProxyAccess('GET', '/recent-changes', `folder_id=${RELAY_ID}-${FOLDER_B}`, allFoldersAuth).allowed).toBe(true);
    expect(checkProxyAccess('GET', '/recent-changes', `folder_id=${RELAY_ID}-${FOLDER_A}`, makeAuth(FOLDER_A, 'view')).allowed).toBe(true);
  });

  it('folder-scoped token blocks unknown endpoints', () => {
    expect(checkProxyAccess('DELETE', '/doc/abc/something', '', scopedAuth).allowed).toBe(false);
  });

  it('all-folders edit token allows POST /suggestions/apply', () => {
    expect(checkProxyAccess('POST', '/suggestions/apply', `folder_id=${RELAY_ID}-${FOLDER_B}`, allFoldersAuth).allowed).toBe(true);
  });

  it('folder-scoped edit token allows POST /suggestions/apply for its own folder', () => {
    expect(checkProxyAccess('POST', '/suggestions/apply', `folder_id=${RELAY_ID}-${FOLDER_A}`, scopedAuth).allowed).toBe(true);
  });

  it('folder-scoped token blocks POST /suggestions/apply for another folder', () => {
    expect(checkProxyAccess('POST', '/suggestions/apply', `folder_id=${RELAY_ID}-${FOLDER_B}`, scopedAuth).allowed).toBe(false);
  });

  it('folder-scoped token blocks POST /suggestions/apply without folder_id', () => {
    expect(checkProxyAccess('POST', '/suggestions/apply', '', scopedAuth).allowed).toBe(false);
  });

  it('view tokens block POST /suggestions/apply', () => {
    expect(checkProxyAccess('POST', '/suggestions/apply', `folder_id=${RELAY_ID}-${FOLDER_A}`, makeAuth(ALL_FOLDERS, 'view')).allowed).toBe(false);
    expect(checkProxyAccess('POST', '/suggestions/apply', `folder_id=${RELAY_ID}-${FOLDER_A}`, makeAuth(FOLDER_A, 'view')).allowed).toBe(false);
  });

  it('checkProxyAccessWithBody delegates POST /suggestions/apply to the query check', () => {
    expect(checkProxyAccessWithBody('POST', '/suggestions/apply', `folder_id=${RELAY_ID}-${FOLDER_A}`, scopedAuth).allowed).toBe(true);
    expect(checkProxyAccessWithBody('POST', '/suggestions/apply', `folder_id=${RELAY_ID}-${FOLDER_B}`, scopedAuth).allowed).toBe(false);
  });
});
