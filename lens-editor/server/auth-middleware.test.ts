import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAuthHandler, AuthError } from './auth-middleware.ts';
import { signShareToken } from './share-token.ts';
import type { ShareTokenPayload } from './share-token.ts';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('auth-middleware', () => {
  const config = {
    relayServerUrl: 'http://localhost:8190',
    relayServerToken: 'test-server-token',
  };

  const handler = createAuthHandler(config);

  // Must use a valid UUID for binary packing
  const validPayload: ShareTokenPayload = {
    role: 'edit',
    folder: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e',
    expiry: Math.floor(Date.now() / 1000) + 3600,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return clientToken and role for valid edit token', async () => {
    const token = signShareToken(validPayload);
    // Folder lookup mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ folderUuid: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e' }),
    });
    // Relay auth mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: 'ws://localhost:8190/d/doc123/ws',
        baseUrl: 'http://localhost:8190',
        docId: 'doc123',
        token: 'relay-token-abc',
      }),
    });

    const result = await handler({ token, docId: 'doc123' });

    expect(result.role).toBe('edit');
    expect(result.clientToken.authorization).toBe('full');
    expect(result.clientToken.token).toBe('relay-token-abc');
  });

  it('should request read-only relay token for view role', async () => {
    const viewPayload: ShareTokenPayload = { ...validPayload, role: 'view' };
    const token = signShareToken(viewPayload);
    // Folder lookup mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ folderUuid: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e' }),
    });
    // Relay auth mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: 'ws://localhost:8190/d/doc123/ws',
        docId: 'doc123',
        token: 'relay-ro-token',
      }),
    });

    const result = await handler({ token, docId: 'doc123' });

    expect(result.role).toBe('view');
    expect(result.clientToken.authorization).toBe('read-only');

    // Verify relay was called with read-only (second fetch call)
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8190/doc/doc123/auth',
      expect.objectContaining({
        body: JSON.stringify({ authorization: 'read-only' }),
      }),
    );
  });

  it('should request full relay token for suggest role', async () => {
    const suggestPayload: ShareTokenPayload = { ...validPayload, role: 'suggest' };
    const token = signShareToken(suggestPayload);
    // Folder lookup mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ folderUuid: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e' }),
    });
    // Relay auth mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: 'ws://localhost:8190/d/doc123/ws',
        docId: 'doc123',
        token: 'relay-full-token',
      }),
    });

    const result = await handler({ token, docId: 'doc123' });

    expect(result.role).toBe('suggest');
    expect(result.clientToken.authorization).toBe('full');
  });

  it('should throw AuthError 401 for invalid token', async () => {
    await expect(handler({ token: 'invalid-token', docId: 'doc123' }))
      .rejects.toThrow(AuthError);
    await expect(handler({ token: 'invalid-token', docId: 'doc123' }))
      .rejects.toThrow('Invalid or expired share token');
  });

  it('should throw AuthError 502 when relay returns error', async () => {
    const token = signShareToken(validPayload);
    // Folder lookup mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ folderUuid: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e' }),
    });
    // Relay auth mock (error)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    await expect(handler({ token, docId: 'doc123' }))
      .rejects.toThrow('Relay server error: 500');
  });

  it('should include Authorization header when relayServerToken is set', async () => {
    const token = signShareToken(validPayload);
    // Folder lookup mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ folderUuid: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e' }),
    });
    // Relay auth mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: '', docId: '', token: '' }),
    });

    await handler({ token, docId: 'doc123' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-server-token',
        }),
      }),
    );
  });

  it('should call the correct relay URL for the given docId', async () => {
    const token = signShareToken(validPayload);
    // Folder lookup mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ folderUuid: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e' }),
    });
    // Relay auth mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: '', docId: '', token: '' }),
    });

    await handler({ token, docId: 'my-specific-doc-id' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8190/doc/my-specific-doc-id/auth',
      expect.any(Object),
    );
  });

  const ALL_FOLDERS_SENTINEL = '00000000-0000-0000-0000-000000000000';
  const FOLDER_A = 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e';
  const FOLDER_B = 'ea4015da-24af-4d9d-ac49-8c902cb17121';

  describe('folder scope enforcement', () => {
    it('should allow access when doc is in token folder', async () => {
      const token = signShareToken({ role: 'edit', folder: FOLDER_A, expiry: Math.floor(Date.now() / 1000) + 3600 });

      // First call: folder lookup returns matching folder
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ folderUuid: FOLDER_A }),
      });
      // Second call: relay auth proxy
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: 'ws://localhost:8190/d/doc123/ws', docId: 'doc123', token: 'relay-token' }),
      });

      const result = await handler({ token, docId: 'doc123' });
      expect(result.role).toBe('edit');

      // Verify folder lookup was called
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8190/doc/doc123/folder',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-server-token' }),
        }),
      );
    });

    it('should reject access when doc is in different folder', async () => {
      const token = signShareToken({ role: 'suggest', folder: FOLDER_A, expiry: Math.floor(Date.now() / 1000) + 3600 });

      // Folder lookup returns a different folder
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ folderUuid: FOLDER_B }),
      });

      await expect(handler({ token, docId: 'doc-in-folder-b' }))
        .rejects.toThrow(AuthError);
    });

    it('should reject access when folder lookup returns 404', async () => {
      const token = signShareToken({ role: 'edit', folder: FOLDER_A, expiry: Math.floor(Date.now() / 1000) + 3600 });

      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      await expect(handler({ token, docId: 'unknown-doc' }))
        .rejects.toThrow(AuthError);
    });

    it('should bypass folder check for all-folders sentinel token', async () => {
      const token = signShareToken({ role: 'edit', folder: ALL_FOLDERS_SENTINEL, expiry: Math.floor(Date.now() / 1000) + 3600 });

      // Only one fetch call: relay auth proxy (no folder lookup)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: 'ws://localhost:8190/d/doc123/ws', docId: 'doc123', token: 'relay-token' }),
      });

      const result = await handler({ token, docId: 'doc123' });
      expect(result.role).toBe('edit');

      // Verify only ONE fetch was made (relay auth, not folder lookup)
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8190/doc/doc123/auth',
        expect.any(Object),
      );
    });
  });
});
