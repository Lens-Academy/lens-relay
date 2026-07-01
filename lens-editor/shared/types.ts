/** Token returned by relay server's /doc/:id/auth endpoint */
export interface ClientToken {
  url: string;
  baseUrl: string;
  docId: string;
  token?: string;
  authorization: 'full' | 'read-only';
}

/**
 * User role for share token auth. Ordered highest -> lowest privilege.
 * Only `admin` may push to production; `edit` retains every other power.
 */
export type UserRole = 'admin' | 'edit' | 'suggest' | 'view';
