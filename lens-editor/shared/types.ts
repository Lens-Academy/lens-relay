/** Token returned by relay server's /doc/:id/auth endpoint */
export interface ClientToken {
  url: string;
  baseUrl: string;
  docId: string;
  token?: string;
  authorization: 'full' | 'read-only';
}

/**
 * Roles for share token auth, ordered highest -> lowest privilege.
 * Only `admin` may push to production; `edit` retains every other power.
 */
export const ROLE_ORDER = ['admin', 'edit', 'suggest', 'view'] as const;

export type UserRole = (typeof ROLE_ORDER)[number];
