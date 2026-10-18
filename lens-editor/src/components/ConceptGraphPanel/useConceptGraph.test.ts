import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import * as Y from 'yjs';
import { NavigationContext } from '../../contexts/NavigationContext';
import { __embedDocsTesting } from '../../lib/embed-docs';
import { useConceptGraph } from './useConceptGraph';

afterEach(() => {
  __embedDocsTesting.reset();
});

const md = (id: string) => ({ id, type: 'markdown' as const, version: 0 });
const fm = (...parents: string[]) =>
  `---\nparent-concepts:\n${parents.map((p) => `  - "[[${p}]]"`).join('\n')}\n---\n# x\n`;

describe('useConceptGraph', () => {
  it('reads ancestors level by level, keeps only real children, and walks below', async () => {
    // tm ⊂ low ⊂ protocols ⊂ control, tm ⊂ mon; high links low in its text only;
    // an article links low.
    const texts: Record<string, string> = {
      control: '# AI Control\n',
      protocols: fm('AI Control'),
      mon: '# Monitoring\n',
      tm: fm('Low-stakes control', 'Monitoring'),
      high: `${fm('Control protocols')}Contrast [[Low-stakes control]].\n`,
    };
    __embedDocsTesting.setReader(async (fullId) => {
      const id = Object.keys(texts).find((k) => fullId.endsWith(`-${k}`));
      return id ? texts[id] : '';
    });
    const folder = new Y.Doc();
    const backlinks = folder.getMap<string[]>('backlinks_v0');
    backlinks.set('low', ['tm', 'high', 'article']);
    backlinks.set('protocols', ['low', 'high']);
    backlinks.set('control', ['protocols']);
    backlinks.set('mon', ['tm']);
    const metadata = {
      '/Lens Edu/Concepts/AI Control.md': md('control'),
      '/Lens Edu/Concepts/Control protocols.md': md('protocols'),
      '/Lens Edu/Concepts/Low-stakes control.md': md('low'),
      '/Lens Edu/Concepts/High-stakes control.md': md('high'),
      '/Lens Edu/Concepts/Monitoring.md': md('mon'),
      '/Lens Edu/Concepts/Trusted monitoring.md': md('tm'),
      '/Lens Edu/articles/a.md': md('article'),
    };
    const wrapper = ({ children }: { children: ReactNode }) => createElement(NavigationContext.Provider, {
      value: { metadata, folderDocs: new Map([['Lens Edu', folder]]), folderNames: ['Lens Edu'], errors: new Map(), onNavigate: vi.fn(), justCreatedRef: { current: false } },
    }, children);
    const ytext = new Y.Doc().getText('contents');
    ytext.insert(0, fm('Control protocols'));

    const { result } = renderHook(
      () => useConceptGraph('low', '/Lens Edu/Concepts/Low-stakes control.md', ytext, true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.ancestors.main).toEqual(['control', 'protocols']));
    await waitFor(() => expect(result.current.below.pending).toEqual([]));
    expect(result.current.below.kids.get('low')).toEqual(['tm']); // not high (text link), not the article
    expect(result.current.below.kids.get('tm')).toEqual([]);

    // Typing outside the frontmatter keeps the same parents object (no recompute).
    const before = result.current.own;
    ytext.insert(ytext.length, 'More text.\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.own).toBe(before);

    // The opened file's parents follow its live text.
    ytext.insert(ytext.toString().indexOf('---\n# x'), '  - "[[Monitoring]]"\n');
    await waitFor(() => expect(result.current.own.parents).toEqual(['protocols', 'mon']));
    expect(new Set(result.current.ancestors.nodes)).toEqual(new Set(['protocols', 'control', 'mon']));
  });
});
