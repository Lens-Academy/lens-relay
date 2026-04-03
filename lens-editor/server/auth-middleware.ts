import { verifyShareToken } from './share-token.ts';
import type { ClientToken, UserRole } from '../shared/types.ts';

interface AuthHandlerConfig {
  relayServerUrl: string;
  relayServerToken?: string; // Optional — local relay has no auth
}

interface AuthResponse {
  clientToken: ClientToken;
  role: UserRole;
}

/**
 * Creates a request handler for POST /api/auth/token
 *
 * Request body: { token: string, docId: string }
 * Response: { clientToken: ClientToken, role: UserRole }
 */
const ALL_FOLDERS_SENTINEL = '00000000-0000-0000-0000-000000000000';

export function createAuthHandler(config: AuthHandlerConfig) {
  return async (body: { token: string; docId: string }): Promise<AuthResponse> => {
    const { token, docId } = body;

    // 1. Verify share token
    const payload = verifyShareToken(token);
    if (!payload) {
      throw new AuthError(401, 'Invalid or expired share token');
    }

    // 2. Folder scope check (skip for all-folders sentinel)
    if (payload.folder !== ALL_FOLDERS_SENTINEL) {
      const folderHeaders: Record<string, string> = {};
      if (config.relayServerToken) {
        folderHeaders['Authorization'] = `Bearer ${config.relayServerToken}`;
      }

      const folderRes = await fetch(`${config.relayServerUrl}/doc/${docId}/folder`, {
        headers: folderHeaders,
      });

      if (!folderRes.ok) {
        // Allow access to the folder doc itself (format: relay_id-folder_uuid).
        // Folder docs aren't content docs so the lookup returns 404, but a token
        // scoped to this folder should access its own folder doc (for metadata sync).
        if (!docId.endsWith('-' + payload.folder)) {
          throw new AuthError(403, 'Access denied: document not found');
        }
      } else {
        const { folderUuid } = await folderRes.json() as { folderUuid: string };
        if (folderUuid !== payload.folder) {
          throw new AuthError(403, 'Access denied: document is not in your authorized folder');
        }
      }
    }

    // 3. Determine relay authorization level
    const relayAuth = payload.role === 'view' ? 'read-only' : 'full';

    // 4. Mint relay doc token by proxying to relay server
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.relayServerToken) {
      headers['Authorization'] = `Bearer ${config.relayServerToken}`;
    }

    const relayResponse = await fetch(`${config.relayServerUrl}/doc/${docId}/auth`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ authorization: relayAuth }),
    });

    if (!relayResponse.ok) {
      throw new AuthError(502, `Relay server error: ${relayResponse.status}`);
    }

    const relayData = await relayResponse.json() as Record<string, unknown>;

    const clientToken: ClientToken = {
      url: relayData.url as string,
      baseUrl: (relayData.baseUrl as string) || config.relayServerUrl,
      docId: relayData.docId as string,
      token: relayData.token as string | undefined,
      authorization: relayAuth,
    };

    return { clientToken, role: payload.role };
  };
}

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}
