import type { UserRole } from '../contexts/AuthContext';

/**
 * Read the share token from the URL query parameter ?t=
 */
export function getShareTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('t');
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

/**
 * Decode the role from a share token payload (base64url, no verification).
 * Used by frontend to determine UI mode before backend validates.
 */
export function decodeRoleFromToken(token: string): UserRole | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    // base64url decode
    const json = atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    if (['edit', 'suggest', 'view'].includes(payload.r)) {
      return payload.r as UserRole;
    }
    return null;
  } catch {
    return null;
  }
}
