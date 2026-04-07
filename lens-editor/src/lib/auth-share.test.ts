import { describe, it, expect, afterEach } from 'vitest';
import { getShareTokenFromUrl, stripShareTokenFromUrl, decodeRoleFromToken, decodeFolderFromToken, isAllFoldersToken, decodePurposeFromToken } from './auth-share';

/** Build a fake binary token: base64url(purposeByte + roleByte + 16 uuid bytes + 4 expiry bytes + 8 sig bytes) */
function makeFakeBinaryToken(roleByte: number, purposeByte: number = 0): string {
  const bytes = new Uint8Array(30); // 1 purpose + 1 role + 16 uuid + 4 expiry + 8 sig
  bytes[0] = purposeByte;
  bytes[1] = roleByte;
  for (let i = 2; i < 30; i++) bytes[i] = i;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Build a fake binary token with a specific folder UUID */
function makeFakeTokenWithFolder(roleByte: number, folderUuid: string, purposeByte: number = 0): string {
  const bytes = new Uint8Array(30);
  bytes[0] = purposeByte;
  bytes[1] = roleByte;
  const hex = folderUuid.replace(/-/g, '');
  for (let i = 0; i < 16; i++) {
    bytes[2 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  for (let i = 18; i < 30; i++) bytes[i] = i;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

describe('auth-share', () => {
  afterEach(() => {
    // Reset URL and localStorage after each test
    window.history.replaceState({}, '', '/');
    localStorage.clear();
  });

  describe('getShareTokenFromUrl', () => {
    it('should return token from ?t= parameter', () => {
      window.history.replaceState({}, '', '/?t=test-token-value');
      expect(getShareTokenFromUrl()).toBe('test-token-value');
    });

    it('should persist token in localStorage', () => {
      window.history.replaceState({}, '', '/?t=test-token-value');
      getShareTokenFromUrl();
      expect(localStorage.getItem('lens-share-token')).toBe('test-token-value');
    });

    it('should fall back to localStorage when no URL param', () => {
      localStorage.setItem('lens-share-token', 'stored-token');
      window.history.replaceState({}, '', '/');
      expect(getShareTokenFromUrl()).toBe('stored-token');
    });

    it('should return null when no token in URL or localStorage', () => {
      window.history.replaceState({}, '', '/');
      expect(getShareTokenFromUrl()).toBeNull();
    });

    it('should prefer URL param over localStorage', () => {
      localStorage.setItem('lens-share-token', 'old-token');
      window.history.replaceState({}, '', '/?t=new-token');
      expect(getShareTokenFromUrl()).toBe('new-token');
      expect(localStorage.getItem('lens-share-token')).toBe('new-token');
    });
  });

  describe('stripShareTokenFromUrl', () => {
    it('should remove ?t= from URL', () => {
      window.history.replaceState({}, '', '/?t=secret-token&other=keep');
      stripShareTokenFromUrl();
      expect(window.location.search).toBe('?other=keep');
    });

    it('should do nothing when no token present', () => {
      window.history.replaceState({}, '', '/?other=keep');
      stripShareTokenFromUrl();
      expect(window.location.search).toBe('?other=keep');
    });
  });

  describe('decodePurposeFromToken', () => {
    it('should decode share purpose (byte 0)', () => {
      expect(decodePurposeFromToken(makeFakeBinaryToken(1, 0))).toBe('share');
    });

    it('should decode add-video purpose (byte 1)', () => {
      expect(decodePurposeFromToken(makeFakeBinaryToken(1, 1))).toBe('add-video');
    });

    it('should return null for unknown purpose byte', () => {
      expect(decodePurposeFromToken(makeFakeBinaryToken(1, 99))).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(decodePurposeFromToken('')).toBeNull();
    });
  });

  describe('decodeRoleFromToken', () => {
    it('should decode edit role (byte 1)', () => {
      expect(decodeRoleFromToken(makeFakeBinaryToken(1))).toBe('edit');
    });

    it('should decode suggest role (byte 2)', () => {
      expect(decodeRoleFromToken(makeFakeBinaryToken(2))).toBe('suggest');
    });

    it('should decode view role (byte 3)', () => {
      expect(decodeRoleFromToken(makeFakeBinaryToken(3))).toBe('view');
    });

    it('should return null for unknown role byte', () => {
      expect(decodeRoleFromToken(makeFakeBinaryToken(0, 0))).toBeNull();
      expect(decodeRoleFromToken(makeFakeBinaryToken(4))).toBeNull();
      expect(decodeRoleFromToken(makeFakeBinaryToken(255))).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(decodeRoleFromToken('')).toBeNull();
    });

    it('should return null for garbage input', () => {
      expect(decodeRoleFromToken('not-valid-base64!!')).toBeNull();
    });
  });
});

describe('decodeFolderFromToken', () => {
  it('should decode folder UUID from token', () => {
    const folder = 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';
    const token = makeFakeTokenWithFolder(1, folder);
    expect(decodeFolderFromToken(token)).toBe(folder);
  });

  it('should decode all-folders sentinel', () => {
    const sentinel = '00000000-0000-0000-0000-000000000000';
    const token = makeFakeTokenWithFolder(1, sentinel);
    expect(decodeFolderFromToken(token)).toBe(sentinel);
  });

  it('should return null for empty string', () => {
    expect(decodeFolderFromToken('')).toBeNull();
  });

  it('should return null for too-short token', () => {
    const bytes = new Uint8Array(10);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    expect(decodeFolderFromToken(token)).toBeNull();
  });
});

describe('isAllFoldersToken', () => {
  it('should return true for all-zeros UUID', () => {
    expect(isAllFoldersToken('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('should return false for a real folder UUID', () => {
    expect(isAllFoldersToken('fbd5eb54-73cc-41b0-ac28-2b93d3b4244e')).toBe(false);
  });
});
