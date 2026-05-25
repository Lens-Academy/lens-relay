// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { writeFileMeta } from './relay-api';

describe('writeFileMeta', () => {
  it('writes type:"file" and NO legacy docs entry for HTML files', () => {
    const folder = new Y.Doc();
    const filemeta = folder.getMap('filemeta_v0');
    const legacyDocs = folder.getMap<string>('docs');

    writeFileMeta(folder, '/page.html', 'uuid-html-1', 'file');

    const entry = filemeta.get('/page.html') as { type: string; id: string; version: number } | undefined;
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('file');
    expect(entry!.id).toBe('uuid-html-1');
    expect(entry!.version).toBe(0);
    expect(legacyDocs.has('/page.html')).toBe(false);
  });

  it('removes stale legacy docs entry when writing file metadata for an existing markdown path', () => {
    const folder = new Y.Doc();
    const filemeta = folder.getMap('filemeta_v0');
    const legacyDocs = folder.getMap<string>('docs');
    legacyDocs.set('/page.html', 'old-md-id');

    writeFileMeta(folder, '/page.html', 'uuid-html-1', 'file');

    const entry = filemeta.get('/page.html') as { type: string; id: string; version: number } | undefined;
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('file');
    expect(entry!.id).toBe('uuid-html-1');
    expect(legacyDocs.has('/page.html')).toBe(false);
  });

  it('writes type:"markdown" AND legacy docs entry for markdown files', () => {
    const folder = new Y.Doc();
    const filemeta = folder.getMap('filemeta_v0');
    const legacyDocs = folder.getMap<string>('docs');

    writeFileMeta(folder, '/note.md', 'uuid-md-1', 'markdown');

    const entry = filemeta.get('/note.md') as { type: string; id: string; version: number } | undefined;
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('markdown');
    expect(entry!.id).toBe('uuid-md-1');
    expect(legacyDocs.get('/note.md')).toBe('uuid-md-1');
  });

  it('writes type:"canvas" with NO legacy docs entry', () => {
    const folder = new Y.Doc();
    const filemeta = folder.getMap('filemeta_v0');
    const legacyDocs = folder.getMap<string>('docs');

    writeFileMeta(folder, '/board.canvas', 'uuid-canvas-1', 'canvas');

    const entry = filemeta.get('/board.canvas') as { type: string; id: string; version: number } | undefined;
    expect(entry?.type).toBe('canvas');
    expect(legacyDocs.has('/board.canvas')).toBe(false);
  });
});
