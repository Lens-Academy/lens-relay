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
  `---\nparent:\n${parents.map((p) => `  - "[[${p}]]"`).join('\n')}\n---\n# x\n`;

describe('useConceptGraph', () => {
  it('reads ancestors level by level, keeps only real children, and walks descendants on request', async () => {
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

    const { result, rerender } = renderHook(
      ({ below }) => useConceptGraph('low', '/Lens Edu/Concepts/Low-stakes control.md', ytext, true, below),
      { wrapper, initialProps: { below: false } },
    );
    await waitFor(() => expect(result.current.ancestors.main).toEqual(['control', 'protocols']));
    await waitFor(() => expect(result.current.children.pending).toEqual([]));
    expect(result.current.children.ids).toEqual(['tm']); // not high (text link), not the article
    expect(result.current.descendants).toBeNull();

    rerender({ below: true });
    await waitFor(() => expect(result.current.descendants?.count).toBe(1));

    // The opened file's parents follow its live text.
    ytext.insert(ytext.toString().indexOf('---\n# x'), '  - "[[Monitoring]]"\n');
    await waitFor(() => expect(result.current.own.parents).toEqual(['protocols', 'mon']));
    expect(result.current.ancestors.others).toEqual([['mon']]);
  });
});
