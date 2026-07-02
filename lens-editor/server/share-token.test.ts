import { describe, it, expect, afterEach } from 'vitest';
import { signShareToken, verifyShareToken, decodeShareTokenPayload, roleAtLeast } from './share-token.ts';
import type { ShareTokenPayload } from './share-token.ts';

describe('share-token', () => {
  const validPayload: ShareTokenPayload = {
    purpose: 'share',
    role: 'edit',
    folder: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e',
    expiry: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
  };

  describe('signShareToken + verifyShareToken', () => {
    it('should sign and verify a valid token', () => {
      const token = signShareToken(validPayload);
      const result = verifyShareToken(token);
      expect(result).toEqual(validPayload);
    });

    it('should produce a compact token (~40 chars)', () => {
      const token = signShareToken(validPayload);
      // 30 bytes base64url → ceil(30*4/3) = 40 chars
      expect(token.length).toBeLessThanOrEqual(40);
    });

    it('should return null for tampered token', () => {
      const token = signShareToken(validPayload);
      // Flip a character in the middle of the token
      const mid = Math.floor(token.length / 2);
      const c = token[mid] === 'A' ? 'B' : 'A';
      const tampered = token.slice(0, mid) + c + token.slice(mid + 1);
      expect(verifyShareToken(tampered)).toBeNull();
    });

    it('should return null for truncated token', () => {
      const token = signShareToken(validPayload);
      expect(verifyShareToken(token.slice(0, -4))).toBeNull();
    });

    it('should return null for expired token', () => {
      const expired: ShareTokenPayload = {
        ...validPayload,
        expiry: Math.floor(Date.now() / 1000) - 1, // 1 second ago
      };
      const token = signShareToken(expired);
      expect(verifyShareToken(token)).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(verifyShareToken('')).toBeNull();
    });

    it('should return null for garbage input', () => {
      expect(verifyShareToken('not-a-valid-token')).toBeNull();
    });

    it('should handle all roles', () => {
      for (const role of ['admin', 'edit', 'suggest', 'view'] as const) {
        const payload: ShareTokenPayload = { ...validPayload, role };
        const token = signShareToken(payload);
        const result = verifyShareToken(token);
        expect(result?.role).toBe(role);
      }
    });

    it('should sign and verify an add-video purpose token', () => {
      const payload: ShareTokenPayload = {
        purpose: 'add-video',
        role: 'edit',
        folder: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e',
        expiry: Math.floor(Date.now() / 1000) + 3600,
      };
      const token = signShareToken(payload);
      const result = verifyShareToken(token);
      expect(result).toEqual(payload);
      expect(result?.purpose).toBe('add-video');
    });

    it('should handle both purposes', () => {
      for (const purpose of ['share', 'add-video'] as const) {
        const payload: ShareTokenPayload = { ...validPayload, purpose };
        const token = signShareToken(payload);
        const result = verifyShareToken(token);
        expect(result?.purpose).toBe(purpose);
      }
    });

    it('share and add-video tokens produce different strings', () => {
      const shareToken = signShareToken({ ...validPayload, purpose: 'share' });
      const addVideoToken = signShareToken({ ...validPayload, purpose: 'add-video' });
      expect(shareToken).not.toBe(addVideoToken);
    });

    // Prevents: unmapped role silently minting a signed byte-0 token — since
    // byte 0 decodes as 'admin', a caller passing an unvalidated role string
    // would fail open into a production-promotion token.
    it('should throw when signing an unknown role', () => {
      const payload = { ...validPayload, role: 'editor' as ShareTokenPayload['role'] };
      expect(() => signShareToken(payload)).toThrow('unknown role "editor"');
    });

    // Prevents: unmapped purpose silently minting a byte-0 ('share') token.
    it('should throw when signing an unknown purpose', () => {
      const payload = { ...validPayload, purpose: 'export' as ShareTokenPayload['purpose'] };
      expect(() => signShareToken(payload)).toThrow('unknown purpose "export"');
    });
  });

  describe('roleAtLeast', () => {
    // Prevents: a role gate enumerating roles by hand and silently dropping
    // admin from an edit-level capability (as happened in vite.config.ts).
    it('admin and edit satisfy edit-level gates; suggest and view do not', () => {
      expect(roleAtLeast('admin', 'edit')).toBe(true);
      expect(roleAtLeast('edit', 'edit')).toBe(true);
      expect(roleAtLeast('suggest', 'edit')).toBe(false);
      expect(roleAtLeast('view', 'edit')).toBe(false);
    });

    it('only admin satisfies admin-level gates', () => {
      expect(roleAtLeast('admin', 'admin')).toBe(true);
      expect(roleAtLeast('edit', 'admin')).toBe(false);
      expect(roleAtLeast('suggest', 'admin')).toBe(false);
      expect(roleAtLeast('view', 'admin')).toBe(false);
    });
  });

  describe('decodeShareTokenPayload', () => {
    it('should decode payload without verification', () => {
      const token = signShareToken(validPayload);
      const payload = decodeShareTokenPayload(token);
      expect(payload).toEqual(validPayload);
    });

    it('should decode even with tampered signature', () => {
      const token = signShareToken(validPayload);
      // Tamper last char (in the signature region)
      const c = token[token.length - 1] === 'A' ? 'B' : 'A';
      const tampered = token.slice(0, -1) + c;
      const payload = decodeShareTokenPayload(tampered);
      // Payload should still decode (signature not checked)
      expect(payload?.role).toBe('edit');
      expect(payload?.folder).toBe(validPayload.folder);
    });

    it('should return null for malformed token', () => {
      expect(decodeShareTokenPayload('garbage')).toBeNull();
    });

    it('should return purpose field from decoded payload', () => {
      const token = signShareToken(validPayload);
      const payload = decodeShareTokenPayload(token);
      expect(payload?.purpose).toBe('share');
    });

    it('should return purpose field for add-video token', () => {
      const addVideoPayload: ShareTokenPayload = { ...validPayload, purpose: 'add-video' };
      const token = signShareToken(addVideoPayload);
      const payload = decodeShareTokenPayload(token);
      expect(payload?.purpose).toBe('add-video');
    });
  });

  describe('production secret enforcement', () => {
    const origEnv = process.env.NODE_ENV;
    const origSecret = process.env.SHARE_TOKEN_SECRET;

    afterEach(() => {
      process.env.NODE_ENV = origEnv;
      if (origSecret !== undefined) {
        process.env.SHARE_TOKEN_SECRET = origSecret;
      } else {
        delete process.env.SHARE_TOKEN_SECRET;
      }
    });

    it('should throw in production without SHARE_TOKEN_SECRET', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.SHARE_TOKEN_SECRET;
      expect(() => signShareToken(validPayload)).toThrow('SHARE_TOKEN_SECRET is required in production');
    });
  });
});
