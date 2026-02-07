import { describe, it, expect } from 'vitest';
import { findPathByUuid } from './uuid-to-path';
import type { FolderMetadata } from '../hooks/useFolderMetadata';

describe('findPathByUuid', () => {
  const metadata: FolderMetadata = {
    '/Notes.md': { id: 'uuid-1', type: 'markdown', version: 0 },
    '/Projects/README.md': { id: 'uuid-2', type: 'markdown', version: 0 },
    '/image.png': { id: 'uuid-3', type: 'image', version: 0 },
  };

  it('returns path for existing UUID', () => {
    expect(findPathByUuid('uuid-1', metadata)).toBe('/Notes.md');
  });

  it('returns path for nested file', () => {
    expect(findPathByUuid('uuid-2', metadata)).toBe('/Projects/README.md');
  });

  it('returns null for non-existent UUID', () => {
    expect(findPathByUuid('missing-uuid', metadata)).toBeNull();
  });

  it('returns null for empty metadata', () => {
    expect(findPathByUuid('uuid-1', {})).toBeNull();
  });
});
