import { describe, it, expect, afterEach } from 'vitest';
import { getShareTokenFromUrl, stripShareTokenFromUrl, decodeRoleFromToken } from './auth-share';

describe('auth-share', () => {
  afterEach(() => {
    // Reset URL after each test
    window.history.replaceState({}, '', '/');
  });

  describe('getShareTokenFromUrl', () => {
    it('should return token from ?t= parameter', () => {
      window.history.replaceState({}, '', '/?t=test-token-value');
      expect(getShareTokenFromUrl()).toBe('test-token-value');
    });

    it('should return null when no token present', () => {
      window.history.replaceState({}, '', '/');
      expect(getShareTokenFromUrl()).toBeNull();
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

  describe('decodeRoleFromToken', () => {
    it('should decode edit role from token payload', () => {
      // Create a fake token with base64url-encoded payload
      const payload = btoa(JSON.stringify({ r: 'edit', f: 'folder', x: 9999999999 }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const token = `${payload}.fakesig`;
      expect(decodeRoleFromToken(token)).toBe('edit');
    });

    it('should decode suggest role from token payload', () => {
      const payload = btoa(JSON.stringify({ r: 'suggest', f: 'folder', x: 9999999999 }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const token = `${payload}.fakesig`;
      expect(decodeRoleFromToken(token)).toBe('suggest');
    });

    it('should decode view role from token payload', () => {
      const payload = btoa(JSON.stringify({ r: 'view', f: 'folder', x: 9999999999 }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const token = `${payload}.fakesig`;
      expect(decodeRoleFromToken(token)).toBe('view');
    });

    it('should return null for invalid token', () => {
      expect(decodeRoleFromToken('garbage')).toBeNull();
    });

    it('should return null for token with unknown role', () => {
      const payload = btoa(JSON.stringify({ r: 'admin', f: 'folder', x: 9999999999 }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const token = `${payload}.fakesig`;
      expect(decodeRoleFromToken(token)).toBeNull();
    });

    it('should return null for token with invalid JSON', () => {
      const payload = btoa('not-json')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const token = `${payload}.fakesig`;
      expect(decodeRoleFromToken(token)).toBeNull();
    });
  });
});
