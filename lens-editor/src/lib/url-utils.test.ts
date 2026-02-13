import { describe, it, expect } from 'vitest';
import { docUuidFromCompoundId, compoundIdFromDocUuid, urlForDoc, docIdFromUrlParam } from './url-utils';

const RELAY_ID = 'cb696037-0f72-4e93-8717-4e433129d789';
const DOC_UUID = '76c3e654-0e77-4538-962f-1b419647206e';
const COMPOUND_ID = `${RELAY_ID}-${DOC_UUID}`;

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

describe('urlForDoc', () => {
  it('builds URL with doc UUID and file path from metadata', () => {
    const metadata = {
      '/Lens/Welcome.md': { id: DOC_UUID, type: 'markdown' as const, version: 0 },
    };
    expect(urlForDoc(COMPOUND_ID, metadata)).toBe(`/${DOC_UUID}/Lens/Welcome.md`);
  });

  it('returns URL with just UUID when metadata has no matching doc', () => {
    expect(urlForDoc(COMPOUND_ID, {})).toBe(`/${DOC_UUID}`);
  });

  it('replaces spaces with dashes in file paths', () => {
    const metadata = {
      '/Lens Edu/My Notes.md': { id: DOC_UUID, type: 'markdown' as const, version: 0 },
    };
    expect(urlForDoc(COMPOUND_ID, metadata)).toBe(`/${DOC_UUID}/Lens-Edu/My-Notes.md`);
  });
});

describe('docIdFromUrlParam', () => {
  it('builds compound ID from URL param UUID', () => {
    expect(docIdFromUrlParam(DOC_UUID, RELAY_ID)).toBe(COMPOUND_ID);
  });
});
