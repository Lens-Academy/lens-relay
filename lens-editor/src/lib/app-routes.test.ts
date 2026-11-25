import { describe, it, expect } from 'vitest';
import { isDocRoute, workflowAccess } from './app-routes';
import { EDU_FOLDER_ID } from './constants';

describe('isDocRoute', () => {
  it('is false for the start page and the workflow pages', () => {
    for (const path of ['/', '/review', '/recent', '/promote', '/add-source', '/add-article', '/concept-map', '/edu/abc', '/section-editor/abc']) {
      expect(isDocRoute(path), path).toBe(false);
    }
  });

  it('is true for document paths', () => {
    for (const path of ['/c0000001', '/c0000001/Relay Folder 1/Welcome.md', '/Lens/Some Doc.md']) {
      expect(isDocRoute(path), path).toBe(true);
    }
  });
});

describe('workflowAccess', () => {
  const access = (canEdit: boolean, folderUuid: string | null, isAllFolders: boolean) =>
    workflowAccess({ canEdit, canPromote: false, folderUuid, isAllFolders });

  it('offers the concept map to every role whose link includes Lens Edu', () => {
    expect(access(false, null, true).conceptMap).toBe(true);
    expect(access(false, EDU_FOLDER_ID, false).conceptMap).toBe(true);
    expect(access(true, EDU_FOLDER_ID, false).conceptMap).toBe(true);
  });

  it('does not offer the concept map to a link for another folder', () => {
    expect(access(true, 'some-other-folder', false).conceptMap).toBe(false);
  });
});
