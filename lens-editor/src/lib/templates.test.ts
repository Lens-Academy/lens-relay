import { describe, it, expect } from 'vitest';
import { findTemplates, fillTemplateIds } from './templates';

const md = (id: string) => ({ id, type: 'markdown' });

const metadata = {
  '/Lens Edu': { id: 'f0', type: 'folder' },
  '/Lens Edu/Lenses': { id: 'f1', type: 'folder' },
  '/Lens Edu/Lenses/Lens Template.md': md('t1'),
  '/Lens Edu/Lenses/Lens Template -- No Article.md': md('t2'),
  '/Lens Edu/Lenses/ET W4 - Reading 4 - Appendix Email Outreach Templates.md': md('x1'),
  '/Lens Edu/Lenses/Demo Lens.md': md('x2'),
  '/Lens Edu/Lenses/Drafts': { id: 'f2', type: 'folder' },
  '/Lens Edu/Lenses/Drafts/Old Template.md': md('x3'),
  '/Lens Edu/Root Template.md': md('t3'),
  '/Lens Edu/modules/Module Template.md': md('x4'),
  '/Lens/MOC; Templates, Guides, and How-Tos.md': md('x5'),
  '/Lens/Ops/Weekly Update Template.md': md('t4'),
};

describe('findTemplates', () => {
  it('lists templates in the folder, then in its parents, nearest first', () => {
    expect(findTemplates(metadata, '/Lens Edu/Lenses').map(t => t.path)).toEqual([
      '/Lens Edu/Lenses/Lens Template.md',
      '/Lens Edu/Lenses/Lens Template -- No Article.md',
      '/Lens Edu/Root Template.md',
    ]);
  });

  it('finds parent templates from a subfolder, not sibling or child folders', () => {
    expect(findTemplates(metadata, '/Lens Edu/Lenses/Drafts').map(t => t.docId)).toEqual(['x3', 't1', 't2', 't3']);
    expect(findTemplates(metadata, '/Lens Edu').map(t => t.docId)).toEqual(['t3']);
  });

  it('matches the word "Template", not "Templates"', () => {
    expect(findTemplates(metadata, '/Lens')).toEqual([]);
    expect(findTemplates(metadata, '/Lens/Ops')).toEqual([
      { path: '/Lens/Ops/Weekly Update Template.md', name: 'Weekly Update Template', docId: 't4' },
    ]);
  });
});

describe('fillTemplateIds', () => {
  let n = 0;
  const newId = () => `uuid-${++n}`;

  it('fills empty and <placeholder> ids in frontmatter and id:: fields', () => {
    n = 0;
    const text = [
      '---',
      'id: <add UUID created at https://www.uuidgenerator.net/version4 >',
      'slug:',
      '---',
      '# Lens: Welcome',
      'id::',
      '#### Question',
      'id:: <uuid>',
      'content:: id: stays',
      'id:',
    ].join('\n');
    expect(fillTemplateIds(text, newId)).toBe([
      '---',
      'id: uuid-1',
      'slug:',
      '---',
      '# Lens: Welcome',
      'id:: uuid-2',
      '#### Question',
      'id:: uuid-3',
      'content:: id: stays',
      'id:',
    ].join('\n'));
  });

  it('keeps ids that already have a value', () => {
    const text = '---\nid: 1234\n---\nid:: abcd\n';
    expect(fillTemplateIds(text, newId)).toBe(text);
  });

  it('handles text without frontmatter', () => {
    n = 0;
    expect(fillTemplateIds('#### Roleplay\nid::\n', newId)).toBe('#### Roleplay\nid:: uuid-1\n');
  });
});
