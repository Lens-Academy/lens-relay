import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';

const createDocument = vi.fn();
vi.mock('./relay-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./relay-api')>()),
  createDocument: (...args: unknown[]) => createDocument(...args),
}));

import { newDocPathForLink, createLinkedDoc } from './wikilink-create';
import { PathExistsError } from './relay-api';

const folders = ['Lens', 'Lens Edu'];
const current = '/Lens/Projects/Notes/Plan.md';

describe('newDocPathForLink', () => {
  it('puts a short link beside the current file', () => {
    expect(newDocPathForLink('New Idea', current, folders))
      .toEqual({ path: '/Lens/Projects/Notes/New Idea.md', type: 'markdown' });
  });

  it('follows ../ up and into other folders', () => {
    expect(newDocPathForLink('../../Elias/Context accelerator ToC post', current, folders))
      .toEqual({ path: '/Lens/Elias/Context accelerator ToC post.md', type: 'markdown' });
  });

  it('can reach another shared folder', () => {
    expect(newDocPathForLink('../../../Lens Edu/Drafts/X', current, folders))
      .toEqual({ path: '/Lens Edu/Drafts/X.md', type: 'markdown' });
  });

  it('reads a link starting with a shared folder name as absolute', () => {
    expect(newDocPathForLink('Lens Edu/Drafts/X', current, folders))
      .toEqual({ path: '/Lens Edu/Drafts/X.md', type: 'markdown' });
  });

  it('drops a #heading and a trailing .md; keeps .html', () => {
    expect(newDocPathForLink('Topic.md#Intro', current, folders))
      .toEqual({ path: '/Lens/Projects/Notes/Topic.md', type: 'markdown' });
    expect(newDocPathForLink('widgets/quiz.html', current, folders))
      .toEqual({ path: '/Lens/Projects/Notes/widgets/quiz.html', type: 'file' });
  });

  it('creates nothing for attachments or a bare heading', () => {
    expect(newDocPathForLink('photo.png', current, folders)).toBeNull();
    expect(newDocPathForLink('paper.pdf', current, folders)).toBeNull();
    expect(newDocPathForLink('handout.docx', current, folders)).toBeNull();
    expect(newDocPathForLink('#Heading', current, folders)).toBeNull();
  });

  it('refuses names a file cannot have and paths outside the shared folders', () => {
    expect(newDocPathForLink('What?', current, folders)).toHaveProperty('error');
    expect(newDocPathForLink('../../../../Elsewhere', current, folders)).toHaveProperty('error');
    expect(newDocPathForLink('../../..', current, folders)).toHaveProperty('error');
  });
});

describe('createLinkedDoc', () => {
  beforeEach(() => {
    createDocument.mockReset();
    createDocument.mockResolvedValue('new-id');
  });

  it('creates the missing parent folders, then the file in its own folder doc', async () => {
    const lens = new Y.Doc();
    const edu = new Y.Doc();
    const docs = new Map([['Lens', lens], ['Lens Edu', edu]]);
    const id = await createLinkedDoc({ path: '/Lens Edu/Drafts/Sub/X.md', type: 'markdown' }, docs, folders);
    expect(id).toBe('new-id');
    expect(createDocument).toHaveBeenCalledWith(edu, '/Drafts/Sub/X.md', 'markdown');
    const meta = edu.getMap<{ type: string }>('filemeta_v0');
    expect(meta.get('/Drafts')?.type).toBe('folder');
    expect(meta.get('/Drafts/Sub')?.type).toBe('folder');
    expect(lens.getMap('filemeta_v0').size).toBe(0);
  });

  it('makes one file for two clicks in a row', async () => {
    const docs = new Map([['Lens', new Y.Doc()]]);
    const target = { path: '/Lens/X.md', type: 'markdown' as const };
    const [a, b] = await Promise.all([
      createLinkedDoc(target, docs, folders),
      createLinkedDoc(target, docs, folders),
    ]);
    expect(a).toBe(b);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it('opens the file when the path was taken meanwhile', async () => {
    const lens = new Y.Doc();
    lens.getMap('filemeta_v0').set('/X.md', { id: 'theirs', type: 'markdown', version: 0 });
    createDocument.mockRejectedValue(new PathExistsError('/X.md'));
    const id = await createLinkedDoc({ path: '/Lens/X.md', type: 'markdown' }, new Map([['Lens', lens]]), folders);
    expect(id).toBe('theirs');
  });
});
