import type { UserRole } from '../contexts/AuthContext';

const SESSION_KEY = 'lens-share-token';

/**
 * Read the share token from the URL query parameter ?t=,
 * falling back to localStorage (survives page refresh).
 */
export function getShareTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('t');
  if (fromUrl) {
    localStorage.setItem(SESSION_KEY, fromUrl);
    return fromUrl;
  }
  return localStorage.getItem(SESSION_KEY);
}

/**
 * Strip the share token from the URL bar via history.replaceState
 * to prevent leakage via Referer headers, bookmarks, and browser history.
 */
export function stripShareTokenFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('t')) return;
  url.searchParams.delete('t');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

const BYTE_TO_PURPOSE: Record<number, string> = { 0: 'share', 1: 'add-video' };
const BYTE_TO_ROLE: Record<number, UserRole> = { 1: 'edit', 2: 'suggest', 3: 'view' };

/** base64url decode to Uint8Array (browser-compatible, no Buffer) */
function base64urlToBytes(str: string): Uint8Array {
  // base64url → base64
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Decode the purpose from a compact binary share token (no signature verification).
 * Token format: base64url(purpose:1 + role:1 + uuid:16 + expiry:4 + hmac:8)
 * Purpose is byte 0: 0='share', 1='add-video'.
 */
export function decodePurposeFromToken(token: string): string | null {
  try {
    const bytes = base64urlToBytes(token);
    if (bytes.length < 1) return null;
    return BYTE_TO_PURPOSE[bytes[0]] ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a compact binary share token has expired.
 * Token format: base64url(purpose:1 + role:1 + uuid:16 + expiry:4 + hmac:8)
 * Expiry is a big-endian uint32 at byte offset 18.
 */
export function isTokenExpired(token: string): boolean {
  try {
    const bytes = base64urlToBytes(token);
    if (bytes.length < 22) return true; // too short to contain expiry
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const expiry = view.getUint32(18, false); // big-endian
    return expiry < Math.floor(Date.now() / 1000);
  } catch {
    return true; // malformed → treat as expired
  }
}

/**
 * Decode the role from a compact binary share token (no signature verification).
 * Token format: base64url(purpose:1 + role:1 + uuid:16 + expiry:4 + hmac:8)
 * Role is byte 1: 1=edit, 2=suggest, 3=view.
 */
export function decodeRoleFromToken(token: string): UserRole | null {
  try {
    const bytes = base64urlToBytes(token);
    if (bytes.length < 2) return null;
    return BYTE_TO_ROLE[bytes[1]] ?? null;
  } catch {
    return null;
  }
}

const ALL_FOLDERS_SENTINEL = '00000000-0000-0000-0000-000000000000';

/**
 * Decode the folder UUID from a compact binary share token (no signature verification).
 * Token format: base64url(purpose:1 + role:1 + uuid:16 + expiry:4 + hmac:8)
 * UUID is bytes 2-17.
 */
export function decodeFolderFromToken(token: string): string | null {
  try {
    const bytes = base64urlToBytes(token);
    if (bytes.length < 18) return null;
    const hex = Array.from(bytes.slice(2, 18))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

/**
 * Check if a folder UUID is the all-folders sentinel (grants access to all folders).
 */
export function isAllFoldersToken(folderUuid: string): boolean {
  return folderUuid === ALL_FOLDERS_SENTINEL;
}
