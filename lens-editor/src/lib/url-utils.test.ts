import { describe, it, expect, vi } from 'vitest';
import {
  docUuidFromCompoundId,
  compoundIdFromDocUuid,
  urlForDoc,
  docIdFromUrlParam,
  shortUuid,
  openDocInNewTab,
} from './url-utils';

const RELAY_ID = 'cb696037-0f72-4e93-8717-4e433129d789';
const DOC_UUID = '76c3e654-0e77-4538-962f-1b419647206e';
const COMPOUND_ID = `${RELAY_ID}-${DOC_UUID}`;
const SHORT = DOC_UUID.slice(0, 8); // '76c3e654'

describe('docUuidFromCompoundId', () => {
  it('extracts the doc UUID from a compound ID', () => {
    expect(docUuidFromCompoundId(COMPOUND_ID)).toBe(DOC_UUID);
  });
});

describe('compoundIdFromDocUuid', () => {
  it('builds compound ID from relay ID and doc UUID', () => {
    expect(compoundIdFromDocUuid(RELAY_ID, DOC_UUID)).toBe(COMPOUND_ID);
  });
});

describe('shortUuid', () => {
  it('returns first 8 chars of a full UUID', () => {
    expect(shortUuid(DOC_UUID)).toBe('76c3e654');
  });

  it('returns input unchanged if already 8 chars or shorter', () => {
    expect(shortUuid('abcd1234')).toBe('abcd1234');
  });
});

describe('urlForDoc', () => {
  it('builds URL with short UUID and file path from metadata', () => {
    const metadata = {
      '/Lens/Welcome.md': { id: DOC_UUID, type: 'markdown' as const, version: 0 },
    };
    expect(urlForDoc(COMPOUND_ID, metadata)).toBe(`/${SHORT}/Lens/Welcome.md`);
  });

  it('returns URL with just short UUID when metadata has no matching doc', () => {
    expect(urlForDoc(COMPOUND_ID, {})).toBe(`/${SHORT}`);
  });

  it('replaces spaces with dashes in file paths', () => {
    const metadata = {
      '/Lens Edu/My Notes.md': { id: DOC_UUID, type: 'markdown' as const, version: 0 },
    };
    expect(urlForDoc(COMPOUND_ID, metadata)).toBe(`/${SHORT}/Lens-Edu/My-Notes.md`);
  });
});

describe('openDocInNewTab', () => {
  it('opens correct URL in new tab', () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const metadata = {
      '/Lens/Page.md': { id: DOC_UUID, type: 'markdown' as const, version: 0 },
    };
    openDocInNewTab(RELAY_ID, DOC_UUID, metadata);
    expect(windowOpen).toHaveBeenCalledWith(
      expect.stringContaining(`/${SHORT}/Lens/Page.md`),
      '_blank'
    );
    windowOpen.mockRestore();
  });

  it('falls back to short UUID when doc not in metadata', () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    openDocInNewTab(RELAY_ID, DOC_UUID, {});
    expect(windowOpen).toHaveBeenCalledWith(
      expect.stringContaining(`/${SHORT}`),
      '_blank'
    );
    windowOpen.mockRestore();
  });
});

describe('docIdFromUrlParam', () => {
  it('builds compound ID from full URL param UUID', () => {
    expect(docIdFromUrlParam(DOC_UUID, RELAY_ID)).toBe(COMPOUND_ID);
  });

  it('builds short compound ID from short URL param UUID', () => {
    expect(docIdFromUrlParam(SHORT, RELAY_ID)).toBe(`${RELAY_ID}-${SHORT}`);
  });
});
